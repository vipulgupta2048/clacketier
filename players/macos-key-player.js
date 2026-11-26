// A long-lived key-click player for macOS, run as
//   osascript -l JavaScript macos-key-player.js <queue file>
// The mod appends a line per key to the queue file:
//   "<volume 0-1>\t<sent at, epoch ms>\t<absolute .wav path>"
// A line with volume "-" only loads the sound, and "quit" ends the player.
//
// Why it is built this way (measured on macOS 26, see the package README):
// - afplay takes about a second to start, AVAudioPlayer.play() costs 10-90 ms and stalls
//   for seconds the first time. An AVAudioEngine with one AVAudioUnitSampler per sound
//   starts a click in ~0.3 ms (worst ~2 ms) with ~10 ms of engine output latency, and
//   overlapping clicks mix as separate voices.
// - Waiting on stdin (or any run-loop turn) slows the next call about 20 ms, so the
//   player never blocks: it polls the queue file (a regular file never blocks) and
//   sleeps the thread between polls.
// - Keys can arrive in bunches (Command Code was busy drawing, fast typing came in one
//   chunk, or the player was still starting). The player spaces a bunch KEY_STAGGER_MS
//   apart on its own thread, so they sound like the separate presses they were, and
//   drops a key that would sound more than MAX_KEY_DELAY_MS after it was sent: never a
//   backlog that clicks after you stop.
// It exits on "quit", when the queue file goes away, or when its parent process dies.
ObjC.import('Foundation');
ObjC.import('AVFoundation');
ObjC.import('unistd');

const POLL_SECONDS = 0.002;
// After this long without a key, poll more slowly so an idle session costs no CPU.
const BUSY_FOR_MS = 1500;
const IDLE_POLL_SECONDS = 0.015;
// The queue file is emptied this long after the last key.
const EMPTY_AFTER_MS = 300;
const KEY_STAGGER_MS = 15;
const MAX_KEY_DELAY_MS = 120;
// How often the player checks that Command Code and the queue file are still there.
const LIVENESS_MS = 300;
// The sampler plays a full-scale clip about 11 dB quieter than the file; this puts
// volume 1 back at the clip's own level.
const GAIN_AT_FULL_DB = 11;
const MIDI_NOTE = 60;

function gainDb(level) {
	if (level <= 0) return -90;
	return Math.max(
		-90,
		Math.min(12, GAIN_AT_FULL_DB + 20 * Math.log10(level)),
	);
}

function samplerFor(state, path) {
	const existing = state.samplers[path];
	if (existing !== undefined) return existing;
	const sampler = $.AVAudioUnitSampler.alloc.init;
	state.engine.attachNode(sampler);
	state.engine.connectToFormat(sampler, state.engine.mainMixerNode, $());
	const isLoaded = sampler.loadAudioFilesAtURLsError(
		$([$.NSURL.fileURLWithPath(path)]),
		null,
	);
	state.samplers[path] = isLoaded ? sampler : null;
	if (isLoaded && state.gain !== undefined) sampler.overallGain = state.gain;
	return state.samplers[path];
}

function setVolume(state, level) {
	const gain = gainDb(level);
	if (state.gain === gain) return;
	state.gain = gain;
	for (const sampler of Object.values(state.samplers))
		if (sampler) sampler.overallGain = gain;
}

function nowMs() {
	return $.NSDate.date.timeIntervalSince1970 * 1000;
}

// Queue a line: a load happens now; a key gets its moment, KEY_STAGGER_MS after the key
// before it if that one is still close, or is dropped when that moment is too late.
function enqueue(state, line, now) {
	const fields = line.split('\t');
	if (fields.length < 3) return;
	const [volume, sentAt] = fields;
	const sampler = samplerFor(state, fields.slice(2).join('\t'));
	if (volume === '-' || !sampler) return;
	const at = Math.max(now, state.lastAt + KEY_STAGGER_MS);
	if (at - Number(sentAt) > MAX_KEY_DELAY_MS) return;
	state.lastAt = at;
	state.due.push({
		at,
		sampler,
		level: Math.max(0, Math.min(1, Number(volume) || 0)),
	});
}

function playDue(state, now) {
	while (state.due.length > 0 && state.due[0].at <= now) {
		const key = state.due.shift();
		setVolume(state, key.level);
		key.sampler.startNoteWithVelocityOnChannel(MIDI_NOTE, 127, 0);
	}
}

// Remove the queue's folder when the player ends for any reason, so a killed Command Code
// leaves nothing behind. Only a folder the mod made (cmd-key-player-*) is ever removed.
function removeQueueDir(manager, queue) {
	const dir = queue.slice(0, queue.lastIndexOf('/'));
	if (!dir.slice(dir.lastIndexOf('/') + 1).startsWith('cmd-key-player-')) return;
	manager.removeItemAtPathError(dir, null);
}

// biome-ignore lint/correctness/noUnusedVariables: osascript calls run() itself.
function run(argv) {
	const queue = argv[0];
	const manager = $.NSFileManager.defaultManager;
	const file = $.NSFileHandle.fileHandleForUpdatingAtPath(queue);
	if (!file || file.isNil()) return removeQueueDir(manager, queue);
	const engine = $.AVAudioEngine.alloc.init;
	// Touching the mixer before start gives the engine a graph it can start with.
	engine.mainMixerNode;
	if (!engine.startAndReturnError(null)) return removeQueueDir(manager, queue);
	const state = {engine, samplers: {}, gain: undefined, due: [], lastAt: 0};
	const parent = $.getppid();
	let pending = '';
	let lastDataAt = nowMs();
	let lastLivenessAt = nowMs();
	let isEmptied = true;
	for (;;) {
		const data = file.availableData;
		const now = nowMs();
		if (Number(data.length) > 0) {
			lastDataAt = now;
			isEmptied = false;
			pending += $.NSString.alloc.initWithDataEncoding(
				data,
				$.NSUTF8StringEncoding,
			).js;
			const end = pending.lastIndexOf('\n');
			const lines = pending.slice(0, end + 1).split('\n');
			pending = pending.slice(end + 1);
			if (lines.includes('quit')) return removeQueueDir(manager, queue);
			for (const line of lines)
				if (line !== '') enqueue(state, line, now);
		}
		playDue(state, nowMs());
		const idleMs = now - lastDataAt;
		// Once typing pauses, empty the queue file: it never holds more than the last burst.
		if (!isEmptied && pending === '' && state.due.length === 0 && idleMs > EMPTY_AFTER_MS) {
			file.truncateFileAtOffset(0);
			isEmptied = true;
		}
		if (state.due.length === 0 && now - lastLivenessAt > LIVENESS_MS) {
			lastLivenessAt = now;
			if ($.getppid() !== parent || !manager.fileExistsAtPath(queue))
				return removeQueueDir(manager, queue);
		}
		// Fast polling while someone types, a slower idle poll otherwise.
		$.NSThread.sleepForTimeInterval(idleMs < BUSY_FOR_MS ? POLL_SECONDS : IDLE_POLL_SECONDS);
	}
}
