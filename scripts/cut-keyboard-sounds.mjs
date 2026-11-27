// Cuts sounds/<keyboard>/*.wav out of the Mechvibes Cherry MX sound packs (MIT,
// https://github.com/hainguyents13/mechvibes, soundpacks/keyboard/cherrymx-<colour>-abs).
// Download each pack's sound.ogg and config.json into <packs-dir>/<colour>/ first, then:
//
//   node scripts/cut-keyboard-sounds.mjs <packs-dir>
//
// Each key keeps only its PRESS (a terminal never reports key releases, so a baked-in
// release would sound like a double hit), starts 1 ms before its attack (any lead-in
// silence is heard as lag), and is matched in loudness so no key is near-silent. Needs
// ffmpeg on PATH.

import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const SAMPLE_RATE = 44_100;
const KEYBOARDS = ['blue', 'brown', 'red'];
// Eight letter keys rotate for ordinary typing, so a run never sounds like a loop.
const KEYS = {
	'key-1': 'KeyA',
	'key-2': 'KeyS',
	'key-3': 'KeyD',
	'key-4': 'KeyF',
	'key-5': 'KeyJ',
	'key-6': 'KeyK',
	'key-7': 'KeyL',
	'key-8': 'KeyE',
	space: 'Space',
	enter: 'Enter',
	backspace: 'Backspace',
};
const LEAD_IN_MS = 1;
const FADE_MS = 10;
const MAX_LENGTH_MS = 120;
// Every key lands at the same loudness (its loudest 5 ms window at this level), unless
// that would clip: no sample goes past MAX_PEAK.
const TARGET_PEAK_RMS = 0.2;
const MAX_PEAK = 0.9;
// Backspace is half as loud (-6 dB): it repeats while held, and at full level it jars.
const SOUND_GAIN = {backspace: 0.5};

function decode(path) {
	const raw = execFileSync(
		'ffmpeg',
		[
			'-nostdin',
			'-loglevel',
			'error',
			'-i',
			path,
			'-ac',
			'1',
			'-ar',
			String(SAMPLE_RATE),
			'-f',
			'f32le',
			'-',
		],
		{maxBuffer: 256 * 1024 * 1024},
	);
	return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

function msToFrames(ms) {
	return Math.round((ms / 1000) * SAMPLE_RATE);
}

function peakRms(samples) {
	const window = msToFrames(5);
	let best = 0;
	const step = Math.max(1, Math.floor(window / 5));
	for (let start = 0; start + window <= samples.length; start += step) {
		let sum = 0;
		for (let index = start; index < start + window; index += 1)
			sum += samples[index] ** 2;
		best = Math.max(best, Math.sqrt(sum / window));
	}
	return best;
}

// The press: from just before its attack to the end of the press window.
function cutPress(sprite, timing) {
	const [pressStartMs, pressEndMs] = timing[0];
	const window = sprite.subarray(
		msToFrames(pressStartMs),
		msToFrames(pressEndMs),
	);
	const peak = window.reduce(
		(max, value) => Math.max(max, Math.abs(value)),
		0,
	);
	const attack = Math.max(
		0,
		window.findIndex(value => Math.abs(value) >= peak * 0.15),
	);
	const start = Math.max(0, attack - msToFrames(LEAD_IN_MS));
	const end = Math.min(window.length, start + msToFrames(MAX_LENGTH_MS));
	return Float32Array.from(window.subarray(start, end));
}

function finish(samples, soundGain = 1) {
	const peak = samples.reduce(
		(max, value) => Math.max(max, Math.abs(value)),
		0,
	);
	const gain =
		soundGain *
		Math.min(TARGET_PEAK_RMS / (peakRms(samples) || 1), MAX_PEAK / (peak || 1));
	const fade = msToFrames(FADE_MS);
	return samples.map((value, index) => {
		const tail = Math.min(1, (samples.length - 1 - index) / fade);
		return Math.max(-1, Math.min(1, value * gain * tail));
	});
}

function encodeWav(samples) {
	const buffer = Buffer.alloc(44 + samples.length * 2);
	buffer.write('RIFF', 0, 'ascii');
	buffer.writeUInt32LE(36 + samples.length * 2, 4);
	buffer.write('WAVEfmt ', 8, 'ascii');
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(SAMPLE_RATE, 24);
	buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write('data', 36, 'ascii');
	buffer.writeUInt32LE(samples.length * 2, 40);
	for (const [index, value] of samples.entries())
		buffer.writeInt16LE(Math.round(value * 32_767), 44 + index * 2);
	return buffer;
}

const packsDir = process.argv[2];
if (!packsDir) {
	console.error('Usage: node scripts/cut-keyboard-sounds.mjs <packs-dir>');
	process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
for (const colour of KEYBOARDS) {
	const sprite = decode(join(packsDir, colour, 'sound.ogg'));
	const {definitions} = JSON.parse(
		readFileSync(join(packsDir, colour, 'config.json'), 'utf8'),
	);
	const outDir = join(here, '..', 'sounds', `mx-${colour}`);
	mkdirSync(outDir, {recursive: true});
	for (const [file, key] of Object.entries(KEYS)) {
		const samples = finish(
			cutPress(sprite, definitions[key].timing),
			SOUND_GAIN[file],
		);
		writeFileSync(join(outDir, `${file}.wav`), encodeWav(samples));
	}
	console.log(`wrote ${outDir}`);
}
