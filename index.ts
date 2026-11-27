// Clacketier: real Cherry MX keyboard sounds under every key you type into Command
// Code. Command Code's `keypress` event says what kind of key it was (never which one);
// this picks a recorded key for it and plays it in a few milliseconds.
//
//   /clacketier              status, and every keyboard
//   /clacketier blue         switch to Cherry MX Blue (also brown, red)
//   /clacketier volume 30    how loud
//
// On macOS one long-lived player (players/macos-key-player.js) keeps up with fast
// typing; elsewhere each key goes through the host's audio player. It stays quiet in
// CI, over SSH, and when CLACKETIER=off.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	formatStatus,
	describePrefs,
	parseArgs,
	USAGE,
} from "./src/command.js";
import { type KeyPlayer, startKeyPlayer } from "./src/key-player.js";
import {
	findKeyboard,
	isKeypressKind,
	KEY_SOUNDS,
	KEYBOARDS,
	keySoundFor,
	keySoundPath,
	MAX_KEYS_IN_FLIGHT,
	MIN_BACKSPACE_GAP_MS,
	MIN_KEY_GAP_MS,
} from "./src/keyboards.js";
import type { KeypressKind, ModApi } from "./src/mod-api.js";
import { PREFS_STORE_KEY, parsePrefs, type Prefs } from "./src/prefs.js";
import { QUIET_NOTES, quietReason } from "./src/quiet.js";
import { listenToStdin, type StdinKeys } from "./src/stdin-keys.js";
import { scalePcm16Wav } from "./src/volume.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOUNDS_DIR = join(HERE, "sounds");
const KEY_PLAYER_SCRIPT = join(HERE, "players", "macos-key-player.js");
// Per user, never the shared /tmp: another account could plant sounds or links there.
const VOLUME_CACHE_DIR = join(homedir(), ".cache", "clacketier");
const PLAY_TIMEOUT_MS = 2_000;
// The host reports a key right after the fallback read it: a host keypress of the same
// kind this soon after a fallback click is that key, heard twice.
const STDIN_HANDOVER_MS = 100;

// Off macOS: the file to hand the host's player, a quieter copy of the WAV below full
// volume (cached per file and volume). Undefined when no quieter copy can be made: a
// skipped click, never one louder than the volume asked for.
async function audibleFile(
	file: string,
	volume: number,
): Promise<string | undefined> {
	if (volume >= 100) return file;
	try {
		const { size, mtimeMs } = statSync(file);
		const key = createHash("sha1")
			.update(`${file}\0${size}\0${mtimeMs}`)
			.digest("hex")
			.slice(0, 12);
		const copy = join(VOLUME_CACHE_DIR, `${key}-${volume}.wav`);
		if (existsSync(copy)) return copy;
		const scaled = scalePcm16Wav({ wav: await readFile(file), volume });
		if (!scaled) return undefined;
		await mkdir(VOLUME_CACHE_DIR, { recursive: true, mode: 0o700 });
		// Write then rename, so an interrupted write never leaves a clipped copy behind.
		const partial = `${copy}.${process.pid}.tmp`;
		await writeFile(partial, scaled, { flag: "wx", mode: 0o600 });
		await rename(partial, copy);
		return copy;
	} catch {
		return undefined;
	}
}

export default function clacketier(cmd: ModApi): void {
	let prefs: Prefs = parsePrefs(cmd.store.get(PREFS_STORE_KEY));
	let isPlayerMissing = false;

	const isAudible = (): boolean =>
		prefs.isOn &&
		prefs.volume > 0 &&
		!isPlayerMissing &&
		quietReason(process.env) === undefined;

	// Started on the first click (or at session start), so a session with the clicks off
	// never spawns it. CLACKETIER_PLAYER=host plays every key through cmd.audio.play.
	let keyPlayer: KeyPlayer | undefined;
	let isKeyPlayerTried = false;
	let preloadedKeyboard: string | undefined;
	const preloaded = (player: KeyPlayer): KeyPlayer => {
		if (preloadedKeyboard === prefs.keyboard) return player;
		preloadedKeyboard = prefs.keyboard;
		player.preload(
			KEY_SOUNDS.map((sound) =>
				keySoundPath({
					soundsDir: SOUNDS_DIR,
					keyboard: prefs.keyboard,
					sound,
				}),
			),
		);
		return player;
	};
	// Each session gets one try at starting the player: a session switch stops it, and a
	// crashed player is replaced on the next session rather than on every key.
	const resetKeyPlayer = (): void => {
		keyPlayer?.stop();
		keyPlayer = undefined;
		isKeyPlayerTried = false;
		preloadedKeyboard = undefined;
	};
	const keyPlayerFor = (): KeyPlayer | undefined => {
		if (keyPlayer?.isAlive()) return preloaded(keyPlayer);
		if (isKeyPlayerTried) return undefined;
		isKeyPlayerTried = true;
		if (process.env.CLACKETIER_PLAYER === "host") return undefined;
		keyPlayer = startKeyPlayer({
			platform: process.platform,
			scriptPath: KEY_PLAYER_SCRIPT,
		});
		return keyPlayer ? preloaded(keyPlayer) : undefined;
	};
	// Start the player before the first key, so keys typed while it loads its audio engine
	// are not lost. Only a terminal (TTY) host sends keypress events.
	const warmUp = (): void => {
		if (isAudible() && process.stdin.isTTY && process.stdout.isTTY)
			keyPlayerFor();
	};

	// Off macOS each key starts a process: capped, so a fast typist never builds a backlog.
	let keysInFlight = 0;
	let lastKeyAtMs: number | undefined;
	const playThroughHost = async (file: string): Promise<void> => {
		const nowMs = Date.now();
		if (keysInFlight >= MAX_KEYS_IN_FLIGHT) return;
		if (lastKeyAtMs !== undefined && nowMs - lastKeyAtMs < MIN_KEY_GAP_MS)
			return;
		lastKeyAtMs = nowMs;
		keysInFlight += 1;
		try {
			const audible = await audibleFile(file, prefs.volume);
			if (!audible) return;
			const result = await cmd.audio
				.play({ file: audible, timeoutMs: PLAY_TIMEOUT_MS })
				.catch(() => undefined);
			if (!result) return;
			if (result.isPlayed || result.reason !== "no-player") return;
			// Keys already in flight find the same missing player: warn once.
			if (isPlayerMissing) return;
			isPlayerMissing = true;
			cmd.ui.notify(
				"[clacketier] No audio player found (paplay or aplay on Linux, PowerShell on Windows).",
				"warning",
			);
		} finally {
			keysInFlight -= 1;
		}
	};

	let lastBackspaceAtMs: number | undefined;
	// A held Backspace clicks at a calm pace, not with every key repeat.
	const isBackspaceRepeat = (kind: string): boolean => {
		if (kind !== "backspace") return false;
		const nowMs = Date.now();
		const isRepeat =
			lastBackspaceAtMs !== undefined &&
			nowMs - lastBackspaceAtMs < MIN_BACKSPACE_GAP_MS;
		if (!isRepeat) lastBackspaceAtMs = nowMs;
		return isRepeat;
	};

	const click = (kind: unknown): void => {
		if (!isKeypressKind(kind) || !isAudible()) return;
		if (isBackspaceRepeat(kind)) return;
		const sound = keySoundFor({ kind, random: Math.random });
		if (!sound) return;
		const file = keySoundPath({
			soundsDir: SOUNDS_DIR,
			keyboard: prefs.keyboard,
			sound,
		});
		// Straight to the player, never through a timer: Command Code's event loop is busy
		// while it draws, and the player spaces out keys that arrive together.
		const player = keyPlayerFor();
		if (!player) {
			void playThroughHost(file);
			return;
		}
		player.play({ file, volume: prefs.volume });
	};

	// Where keys come from. Command Code releases with the `keypress` mod event tell the mod
	// each key's kind; on older releases the mod reads the terminal's input itself
	// (src/stdin-keys.ts). The first host event switches the fallback off for good, and the
	// keys the fallback already clicked in that moment aren't clicked twice: each host
	// event matching the next of those keys, in order, is skipped.
	let stdinKeys: StdinKeys | undefined;
	let hasHostKeys = false;
	let stdinClicks: { kind: KeypressKind; atMs: number }[] = [];
	const startStdinFallback = (): void => {
		// Only while clicks can be heard: muted, the terminal's input is never read.
		if (hasHostKeys || stdinKeys || !isAudible()) return;
		if (process.env.CLACKETIER_STDIN === "off") return;
		stdinKeys = listenToStdin({
			stdin: process.stdin,
			onKey: (kind) => {
				stdinClicks.push({ kind, atMs: Date.now() });
				click(kind);
			},
		});
	};
	const stopStdinFallback = (): void => {
		stdinKeys?.stop();
		stdinKeys = undefined;
	};
	const save = (next: Prefs): void => {
		prefs = next;
		cmd.store.set(PREFS_STORE_KEY, next).catch(() => {
			cmd.ui.notify(
				"[clacketier] Couldn't save this setting; it lasts until Command Code closes.",
				"warning",
			);
		});
		warmUp();
		// Muted, the player ends and the terminal's input is left alone; unmuted, both return.
		if (!isAudible()) {
			stopStdinFallback();
			resetKeyPlayer();
		}
		startStdinFallback();
		// A sample of the new setting, so the change is heard.
		click("character");
	};

	cmd.on("keypress", (event) => {
		if (!hasHostKeys) {
			hasHostKeys = true;
			stopStdinFallback();
		}
		const nowMs = Date.now();
		stdinClicks = stdinClicks.filter(
			(stdinClick) => nowMs - stdinClick.atMs < STDIN_HANDOVER_MS,
		);
		const isHeard = stdinClicks[0]?.kind === event.kind;
		stdinClicks = isHeard ? stdinClicks.slice(1) : [];
		if (isHeard) return;
		click(event.kind);
	});

	cmd.hooks({
		onSessionStart: () => {
			// A player installed since the last session gets another chance.
			isPlayerMissing = false;
			resetKeyPlayer();
			warmUp();
			startStdinFallback();
		},
		onSessionEnd: () => {
			stopStdinFallback();
			resetKeyPlayer();
		},
	});

	cmd.addCommand({
		name: "clacketier",
		description: "Mechanical keyboard sounds as you type",
		argumentHint: "[blue|brown|red|pick|on|off|volume <0-100>]",
		handler: async ({ args }) => {
			const action = parseArgs(args);
			if (action.kind === "invalid") return { message: action.message };
			if (action.kind === "help") return { message: USAGE };
			if (action.kind === "pick") {
				const chosen = await cmd.ui.select({
					title: "Keyboard",
					options: KEYBOARDS.map((keyboard) => ({
						label: keyboard.id,
						description: `${keyboard.name}: ${keyboard.description}`,
					})),
				});
				const keyboard = chosen ? findKeyboard(chosen) : undefined;
				if (!keyboard) return { message: describePrefs(prefs) };
				save({ ...prefs, isOn: true, keyboard: keyboard.id });
				return { message: describePrefs(prefs) };
			}
			if (action.kind === "set") {
				save({ ...prefs, ...action.change });
				return { message: describePrefs(prefs) };
			}
			const quiet = quietReason(process.env);
			return {
				message: formatStatus({
					prefs,
					quietNote: quiet ? QUIET_NOTES[quiet] : undefined,
				}),
			};
		},
	});
}
