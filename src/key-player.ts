// Where typing clicks are played. On macOS one long-lived player process (players/
// macos-key-player.js under osascript, an AVAudioEngine with a sampler per sound) reads
// a line per key from a queue file: starting afplay for every key costs about a second
// each, far too slow to keep up with typing. Elsewhere each key goes through
// cmd.audio.play (paplay and aplay start fast enough).

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface KeyPlayer {
	// False once the process died; the caller falls back to cmd.audio.play.
	readonly isAlive: () => boolean;
	// Load sounds ahead of their first key, so that key is not the slow one.
	readonly preload: (files: readonly string[]) => void;
	readonly play: (params: {
		readonly file: string;
		readonly volume: number;
	}) => void;
	readonly stop: () => void;
}

// A path can never break a line of the protocol.
function protocolPath(file: string): string {
	return file.replace(/[\t\n]/g, " ");
}

/**
 * One key line of the player protocol: "<volume 0-1>\t<sent at, epoch ms>\t<path>\n".
 * The player drops a key that reaches it too late to sound like the press. Pure.
 */
export function keyPlayerLine(params: {
	readonly file: string;
	readonly volume: number;
	readonly sentAtMs: number;
}): string {
	// Perceived loudness is roughly logarithmic, matching the WAV volume scaling.
	const level = (Math.min(100, Math.max(0, params.volume)) / 100) ** 2;
	return `${level.toFixed(4)}\t${Math.round(params.sentAtMs)}\t${protocolPath(params.file)}\n`;
}

/** The lines that load sounds without playing them. Pure. */
export function preloadLines(files: readonly string[]): string {
	return files.map((file) => `-\t0\t${protocolPath(file)}\n`).join("");
}

/** Start the macOS key player, or undefined anywhere else or if it cannot start. */
export function startKeyPlayer(params: {
	readonly platform: string;
	readonly scriptPath: string;
}): KeyPlayer | undefined {
	if (params.platform !== "darwin") return undefined;
	let dir: string | undefined;
	let fd: number | undefined;
	let child: ChildProcess | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), "cmd-key-player-"));
		const queue = join(dir, "queue");
		fd = openSync(queue, "a");
		// Our pid, so the player can tell if we died before it got going.
		// By absolute path: a project's own `osascript` earlier on PATH must never run.
		child = spawn(
			"/usr/bin/osascript",
			["-l", "JavaScript", params.scriptPath, queue, String(process.pid)],
			// Its own process group: a closed terminal's hangup ends Command Code but not the
			// player, which then sees its parent gone and removes the queue folder.
			{ stdio: "ignore", detached: true },
		);
	} catch {
		if (fd !== undefined) closeSync(fd);
		if (dir) rmSync(dir, { recursive: true, force: true });
		return undefined;
	}
	let isAlive = true;
	const cleanUp = (): void => {
		if (!isAlive) return;
		isAlive = false;
		if (fd !== undefined) closeSync(fd);
		if (dir) rmSync(dir, { recursive: true, force: true });
	};
	child.on("error", cleanUp);
	child.on("exit", cleanUp);
	// Never keep Command Code running for the player: it watches its parent and the queue
	// file, and ends itself when either goes away.
	child.unref();
	const write = (text: string): void => {
		if (!isAlive || fd === undefined) return;
		try {
			writeSync(fd, text);
		} catch {
			cleanUp();
		}
	};
	return {
		isAlive: () => isAlive,
		preload: (files) => write(preloadLines(files)),
		play: (line) => write(keyPlayerLine({ ...line, sentAtMs: Date.now() })),
		stop: () => {
			write("quit\n");
			cleanUp();
		},
	};
}
