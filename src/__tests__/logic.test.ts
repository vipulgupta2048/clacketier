import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describePrefs, formatStatus, parseArgs } from "../command.js";
import { keyPlayerLine, preloadLines, startKeyPlayer } from "../key-player.js";
import {
	findKeyboard,
	KEY_SOUNDS,
	KEYBOARDS,
	keySoundFor,
	keySoundPath,
} from "../keyboards.js";
import { DEFAULT_PREFS, parsePrefs } from "../prefs.js";
import { quietReason } from "../quiet.js";
import { classifyChunk, listenToStdin, MAX_KEYS_PER_CHUNK } from "../stdin-keys.js";
import { readPcm16Layout, scalePcm16Wav } from "../volume.js";

const SOUNDS_DIR = join(import.meta.dirname, "..", "..", "sounds");

describe("keys", () => {
	it.each([
		["character", 0, "key-1"],
		["character", 0.99, "key-8"],
		["paste", 0.5, "key-5"],
		["space", 0.5, "space"],
		["enter", 0.5, "enter"],
		["backspace", 0.5, "backspace"],
		["other", 0.5, undefined],
	] as const)("%s (roll %s) plays %s", (kind, roll, sound) => {
		expect(keySoundFor({ kind, random: () => roll })).toBe(sound);
	});

	it("finds a keyboard by id or colour", () => {
		expect(findKeyboard("mx-red")?.name).toBe("Cherry MX Red");
		expect(findKeyboard("Brown")?.id).toBe("mx-brown");
		expect(findKeyboard("gateron")).toBe(undefined);
	});

	it.each(
		KEYBOARDS.flatMap((keyboard) =>
			KEY_SOUNDS.map((sound) => [keyboard.id, sound] as const),
		),
	)("ships %s/%s.wav: a short 16-bit WAV", (keyboard, sound) => {
		const path = keySoundPath({ soundsDir: SOUNDS_DIR, keyboard, sound });
		expect(statSync(path).size).toBeLessThan(20_000);
		const wav = readFileSync(path);
		const layout = readPcm16Layout(wav);
		expect(layout).toBeDefined();
		expect(
			(layout?.dataBytes ?? 0) / 2 / wav.readUInt32LE(24),
		).toBeLessThanOrEqual(0.15);
	});
});

describe("/clacketier", () => {
	it.each([
		["", { kind: "status" }],
		["help", { kind: "help" }],
		["pick", { kind: "pick" }],
		["on", { kind: "set", change: { isOn: true } }],
		["mute", { kind: "set", change: { isOn: false } }],
		["volume 30", { kind: "set", change: { volume: 30 } }],
		["vol 250", { kind: "set", change: { volume: 100 } }],
		["brown", { kind: "set", change: { isOn: true, keyboard: "mx-brown" } }],
		["MX-RED", { kind: "set", change: { isOn: true, keyboard: "mx-red" } }],
	] as const)('parses "%s"', (args, action) => {
		expect(parseArgs(args)).toEqual(action);
	});

	it.each([
		"volume",
		"volume loud",
		"volume 3 4",
		"gateron",
	])('rejects "%s"', (args) => {
		expect(parseArgs(args).kind).toBe("invalid");
	});

	it("describes the prefs and marks the active keyboard", () => {
		expect(describePrefs(DEFAULT_PREFS)).toBe(
			"Clacketier: Cherry MX Blue · volume 50%.",
		);
		expect(describePrefs({ ...DEFAULT_PREFS, isOn: false })).toMatch(/off/);
		const status = formatStatus({
			prefs: { ...DEFAULT_PREFS, keyboard: "mx-red" },
			quietNote: "Quiet: CI.",
		});
		expect(status).toMatch(/● Cherry MX Red/);
		expect(status).toMatch(/○ Cherry MX Blue/);
		expect(status).toMatch(/Quiet: CI\./);
	});
});

describe("prefs", () => {
	it("is on by default and repairs anything stored", () => {
		expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
		expect(DEFAULT_PREFS.isOn).toBe(true);
		expect(
			parsePrefs({ isOn: false, keyboard: "gateron", volume: -5 }),
		).toEqual({ isOn: false, keyboard: "mx-blue", volume: 0 });
		expect(parsePrefs({ volume: Number.NaN }).volume).toBe(50);
	});
});

describe("quiet", () => {
	it("is quiet in CI, over SSH, and when turned off; on wins", () => {
		expect(quietReason({})).toBe(undefined);
		expect(quietReason({ CLACKETIER: "off" })).toBe("env-off");
		expect(quietReason({ CI: "true" })).toBe("ci");
		expect(quietReason({ SSH_TTY: "/dev/ttys001" })).toBe("ssh");
		expect(quietReason({ CI: "1", CLACKETIER: "on" })).toBe(undefined);
		expect(quietReason({ CI: "false" })).toBe(undefined);
	});
});

describe("key player protocol", () => {
	it("writes the squared volume and a path with no tabs or newlines", () => {
		expect(
			keyPlayerLine({ file: "/k/a.wav", volume: 50, sentAtMs: 12.4 }),
		).toBe("0.250\t12\t/k/a.wav\n");
		expect(
			keyPlayerLine({ file: "/k/x\ty\n.wav", volume: 200, sentAtMs: 5 }),
		).toBe("1.000\t5\t/k/x y .wav\n");
	});

	it("writes preload lines the player loads without playing", () => {
		expect(preloadLines(["/k/a.wav", "/k/b\tc.wav"])).toBe(
			"-\t0\t/k/a.wav\n-\t0\t/k/b c.wav\n",
		);
	});

	it("only starts on macOS", () => {
		expect(startKeyPlayer({ platform: "linux", scriptPath: "/x.js" })).toBe(
			undefined,
		);
	});
});

describe("volume", () => {
	const file = keySoundPath({
		soundsDir: SOUNDS_DIR,
		keyboard: "mx-blue",
		sound: "key-1",
	});
	const wav = readFileSync(file);

	it("scales samples without touching the input", () => {
		const layout = readPcm16Layout(wav);
		if (!layout) throw new Error("not a wav");
		const peak = (buffer: Buffer): number => {
			let max = 0;
			for (let at = layout.dataOffset; at < buffer.length; at += 2)
				max = Math.max(max, Math.abs(buffer.readInt16LE(at)));
			return max;
		};
		expect(peak(scalePcm16Wav({ wav, volume: 50 }) ?? wav)).toBeCloseTo(
			peak(wav) * 0.25,
			-1,
		);
		expect(peak(scalePcm16Wav({ wav, volume: 0 }) ?? wav)).toBe(0);
		expect(wav.equals(readFileSync(file))).toBe(true);
	});

	it("answers undefined for anything that is not 16-bit PCM WAV", () => {
		expect(scalePcm16Wav({ wav: Buffer.from("ID3"), volume: 50 })).toBe(
			undefined,
		);
	});
});

describe("stdin fallback", () => {
	it.each([
		["a", ["character"]],
		["hi", ["character", "character"]],
		[" ", ["space"]],
		["\r", ["enter"]],
		["\u007f", ["backspace"]],
		["a b\r", ["character", "space", "character", "enter"]],
		["\u001b[A", ["other"]],
		["\u001b", ["other"]],
		["\u0003", ["other"]],
		["\u001b[200~pasted text\u001b[201~", ["paste"]],
		["x".repeat(MAX_KEYS_PER_CHUNK + 1), ["paste"]],
		["", []],
	] as const)("classifies %j", (chunk, kinds) => {
		expect(classifyChunk(chunk)).toEqual(kinds);
	});

	it("only listens to a terminal", () => {
		const notTty = { isTTY: false } as NodeJS.ReadStream;
		expect(listenToStdin({ stdin: notTty, onKey: () => {} })).toBe(undefined);
	});
});
