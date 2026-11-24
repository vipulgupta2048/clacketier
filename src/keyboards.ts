// The keyboards and which recorded key answers each keypress.

import { join } from "node:path";
import type { KeypressKind } from "./mod-api.js";

export interface Keyboard {
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

// Real recordings of the three classic Cherry MX switches with ABS keycaps, from the
// Mechvibes project (MIT, see sounds/LICENSE).
export const KEYBOARDS: readonly Keyboard[] = [
	{
		id: "mx-blue",
		name: "Cherry MX Blue",
		description: "Clicky: a loud, crisp click on every key.",
	},
	{
		id: "mx-brown",
		name: "Cherry MX Brown",
		description: "Tactile: a quiet bump, no click.",
	},
	{
		id: "mx-red",
		name: "Cherry MX Red",
		description: "Linear: smooth, deeper and softer.",
	},
];

export const DEFAULT_KEYBOARD_ID = "mx-blue";

// Ordinary keys rotate through eight recorded keys so a typed run never sounds like a loop.
const KEY_VARIANTS = [
	"key-1",
	"key-2",
	"key-3",
	"key-4",
	"key-5",
	"key-6",
	"key-7",
	"key-8",
] as const;

// Every sound a keyboard ships, for loading ahead of the first key.
export const KEY_SOUNDS: readonly string[] = [
	...KEY_VARIANTS,
	"space",
	"enter",
	"backspace",
];

// When every key starts its own player process (off macOS): players running at once, and
// the shortest gap between two clicks. Past either, a key is dropped: a missed click is
// better than a backlog that clicks after you stop typing.
export const MAX_KEYS_IN_FLIGHT = 4;
export const MIN_KEY_GAP_MS = 18;

/** A keyboard by id, or by its colour alone (`blue` for `mx-blue`). Pure. */
export function findKeyboard(id: string): Keyboard | undefined {
	const wanted = id.toLowerCase();
	return KEYBOARDS.find(
		(keyboard) => keyboard.id === wanted || keyboard.id === `mx-${wanted}`,
	);
}

export function isKeypressKind(value: unknown): value is KeypressKind {
	return (
		value === "character" ||
		value === "space" ||
		value === "enter" ||
		value === "backspace" ||
		value === "paste" ||
		value === "other"
	);
}

/** The sound (file name without extension) for a key, or undefined for keys that stay quiet. Pure. */
export function keySoundFor(params: {
	readonly kind: KeypressKind;
	readonly random: () => number;
}): string | undefined {
	if (params.kind === "other") return undefined;
	if (params.kind === "space") return "space";
	if (params.kind === "enter") return "enter";
	if (params.kind === "backspace") return "backspace";
	const index = Math.floor(params.random() * KEY_VARIANTS.length);
	return KEY_VARIANTS[Math.min(index, KEY_VARIANTS.length - 1)];
}

export function keySoundPath(params: {
	readonly soundsDir: string;
	readonly keyboard: string;
	readonly sound: string;
}): string {
	return join(params.soundsDir, params.keyboard, `${params.sound}.wav`);
}
