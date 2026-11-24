// `/clacketier`: parse the arguments and turn them into new prefs and a reply.

import { findKeyboard, KEYBOARDS } from "./keyboards.js";
import { clampVolume, type Prefs } from "./prefs.js";

export type Action =
	| { readonly kind: "status" }
	| { readonly kind: "help" }
	| { readonly kind: "pick" }
	| { readonly kind: "set"; readonly change: Partial<Prefs> }
	| { readonly kind: "invalid"; readonly message: string };

export const USAGE = [
	"/clacketier                 status, and every keyboard",
	"/clacketier pick            choose a keyboard from a list",
	"/clacketier blue|brown|red  switch keyboard (and turn on)",
	"/clacketier on|off          start or stop the clicks",
	"/clacketier volume <0-100>  how loud",
].join("\n");

const ON_WORDS: ReadonlySet<string> = new Set(["on", "start", "unmute"]);
const OFF_WORDS: ReadonlySet<string> = new Set(["off", "stop", "mute"]);

/** `/clacketier` arguments as an action. Pure. */
export function parseArgs(args: string): Action {
	const [verb = "", value, ...rest] = args.trim().toLowerCase().split(/\s+/);
	if (verb === "" || verb === "status") return { kind: "status" };
	if (verb === "help") return { kind: "help" };
	if (verb === "pick" || verb === "keyboard") return { kind: "pick" };
	if (ON_WORDS.has(verb)) return { kind: "set", change: { isOn: true } };
	if (OFF_WORDS.has(verb)) return { kind: "set", change: { isOn: false } };
	if (verb === "volume" || verb === "vol") {
		const volume = Number(value);
		if (value === undefined || rest.length > 0 || !Number.isFinite(volume))
			return { kind: "invalid", message: "Use /clacketier volume <0-100>." };
		return { kind: "set", change: { volume: clampVolume(volume) } };
	}
	const keyboard = findKeyboard(verb);
	if (keyboard)
		return { kind: "set", change: { isOn: true, keyboard: keyboard.id } };
	const ids = KEYBOARDS.map((item) => item.id.replace(/^mx-/, "")).join(", ");
	return {
		kind: "invalid",
		message: `Unknown "${verb}". Keyboards: ${ids}. /clacketier help for more.`,
	};
}

/** One line on what is playing. Pure. */
export function describePrefs(prefs: Prefs): string {
	if (!prefs.isOn) return "Clacketier: off. /clacketier on to start.";
	const name = findKeyboard(prefs.keyboard)?.name ?? prefs.keyboard;
	return `Clacketier: ${name} · volume ${prefs.volume}%.`;
}

/** The status block: every keyboard, the active one marked. Pure. */
export function formatStatus(params: {
	readonly prefs: Prefs;
	readonly quietNote?: string;
}): string {
	const { prefs } = params;
	const rows = KEYBOARDS.map((keyboard) => {
		const mark = prefs.isOn && keyboard.id === prefs.keyboard ? "●" : "○";
		return `  ${mark} ${keyboard.name.padEnd(16)} ${keyboard.description}`;
	});
	return [
		describePrefs(prefs),
		...rows,
		...(params.quietNote ? [params.quietNote] : []),
		"/clacketier blue|brown|red to switch, /clacketier help for more.",
	].join("\n");
}
