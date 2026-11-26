// Drives the mod through a stub of the Command Code mod API: the same calls the host
// makes, with the host's audio player recorded instead of played. The macOS key player
// is turned off (CLACKETIER_PLAYER=host) so no speaker is touched.

import { beforeEach, describe, expect, it, vi } from "vitest";
import clacketier from "./index.js";
import type {
	ModApi,
	ModCommand,
	ModCommandResult,
	ModHooks,
} from "./src/mod-api.js";

interface Stub {
	readonly run: (args: string) => Promise<ModCommandResult | undefined>;
	readonly press: (kind: string) => void;
	readonly played: string[];
	readonly notices: string[];
	readonly stored: Map<string, unknown>;
	readonly hooks: ModHooks;
}

function load(params: {
	readonly stored?: unknown;
	readonly playerAnswer?: "played" | "no-player" | "throws";
	readonly selected?: string;
	readonly isStoreBroken?: boolean;
}): Stub {
	const stored = new Map<string, unknown>();
	if (params.stored) stored.set("prefs", params.stored);
	const played: string[] = [];
	const notices: string[] = [];
	let command: ModCommand | undefined;
	let onKey: ((event: { type: string; kind?: unknown }) => void) | undefined;
	let hooks: ModHooks = {};
	const disposable = { dispose: () => undefined };
	const api: ModApi = {
		ui: {
			notify: (text) => void notices.push(text),
			select: async () => params.selected,
		},
		store: {
			get: <T>(key: string) => stored.get(key) as T | undefined,
			set: async (key, value) => {
				if (params.isStoreBroken) throw new Error("read-only store");
				stored.set(key, value);
			},
		},
		audio: {
			play: async ({ file }) => {
				played.push(file);
				if (params.playerAnswer === "throws") throw new Error("device gone");
				return params.playerAnswer === "no-player"
					? { isPlayed: false, reason: "no-player" }
					: { isPlayed: true };
			},
		},
		hooks: (next) => {
			hooks = next;
			return disposable;
		},
		on: (_event, handler) => {
			onKey = handler;
			return disposable;
		},
		addCommand: (next) => {
			command = next;
			return disposable;
		},
	};
	clacketier(api);
	return {
		run: (args) => {
			if (!command) throw new Error("no command");
			return command.handler({ args });
		},
		press: (kind) => onKey?.({ type: "keypress", kind }),
		played,
		notices,
		stored,
		get hooks() {
			return hooks;
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("CLACKETIER_PLAYER", "host");
	vi.stubEnv("CLACKETIER", "on");
});

describe("clacketier", () => {
	it("clicks Cherry MX Blue on a key, out of the box", async () => {
		const stub = load({});
		stub.press("space");
		await settle();
		expect(stub.played).toHaveLength(1);
		expect(stub.played[0]).toMatch(/mx-blue[/\\]space\.wav$|clacketier/);
	});

	it("makes no sound for keys that are not typing, or when off", async () => {
		const stub = load({ stored: { isOn: false } });
		stub.press("character");
		const on = load({});
		on.press("other");
		on.press("not-a-kind");
		await settle();
		expect(stub.played).toHaveLength(0);
		expect(on.played).toHaveLength(0);
	});

	it("stays quiet when CLACKETIER is off", async () => {
		vi.stubEnv("CLACKETIER", "off");
		const stub = load({});
		stub.press("character");
		await settle();
		expect(stub.played).toHaveLength(0);
		expect((await stub.run(""))?.message).toMatch(/CLACKETIER is off/);
	});

	it("switches keyboard, saves it, and plays a sample", async () => {
		const stub = load({ stored: { volume: 100 } });
		expect((await stub.run("red"))?.message).toBe(
			"Clacketier: Cherry MX Red · volume 100%.",
		);
		await settle();
		expect(stub.stored.get("prefs")).toMatchObject({ keyboard: "mx-red" });
		expect(stub.played[0]).toMatch(/mx-red[/\\]key-\d\.wav$/);
	});

	it("picks a keyboard from a list", async () => {
		const stub = load({ selected: "mx-brown" });
		expect((await stub.run("pick"))?.message).toMatch(/Cherry MX Brown/);
	});

	it("drops keys that come too fast for a process each", async () => {
		const stub = load({ stored: { volume: 100 } });
		for (let index = 0; index < 10; index += 1) stub.press("character");
		await settle();
		expect(stub.played).toHaveLength(1);
	});

	it("says once when there is no audio player, then goes quiet", async () => {
		const stub = load({ playerAnswer: "no-player", stored: { volume: 100 } });
		stub.press("character");
		await settle();
		await new Promise((resolve) => setTimeout(resolve, 30));
		stub.press("character");
		await settle();
		expect(stub.played).toHaveLength(1);
		expect(stub.notices).toHaveLength(1);
	});

	it("warns once when keys already in flight all find no player", async () => {
		const stub = load({ playerAnswer: "no-player", stored: { volume: 100 } });
		for (let index = 0; index < 3; index += 1) {
			stub.press("character");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await settle();
		expect(stub.notices).toHaveLength(1);
	});

	it("survives the host's audio player throwing", async () => {
		const stub = load({ playerAnswer: "throws", stored: { volume: 100 } });
		stub.press("character");
		await settle();
		expect(stub.played).toHaveLength(1);
	});

	it("keeps the setting and says so when it can't be saved", async () => {
		const stub = load({ isStoreBroken: true });
		expect((await stub.run("brown"))?.message).toMatch(/Cherry MX Brown/);
		await settle();
		expect(stub.notices[0]).toMatch(/Couldn't save/);
	});

	it("answers usage and bad arguments", async () => {
		const stub = load({});
		expect((await stub.run("help"))?.message).toMatch(/volume <0-100>/);
		expect((await stub.run("gateron"))?.message).toMatch(/Unknown/);
	});
});
