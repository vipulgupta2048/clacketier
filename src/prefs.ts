// What the person chose, kept in the mod's store across sessions.

import { DEFAULT_KEYBOARD_ID, findKeyboard } from "./keyboards.js";

export const PREFS_STORE_KEY = "prefs";

export interface Prefs {
	readonly isOn: boolean;
	readonly keyboard: string;
	// 0-100.
	readonly volume: number;
}

// On from the start: installing a typing-sounds mod is asking for typing sounds.
export const DEFAULT_PREFS: Prefs = {
	isOn: true,
	keyboard: DEFAULT_KEYBOARD_ID,
	volume: 50,
};

export function clampVolume(value: number): number {
	return Math.round(Math.min(100, Math.max(0, value)));
}

/** Stored prefs, any shape (an older version, a hand edit), as valid prefs. Pure. */
export function parsePrefs(value: unknown): Prefs {
	if (typeof value !== "object" || value === null) return DEFAULT_PREFS;
	const stored = value as Record<string, unknown>;
	return {
		isOn: typeof stored.isOn === "boolean" ? stored.isOn : DEFAULT_PREFS.isOn,
		// The keyboard's id, also when a colour alone ("blue") was stored by hand.
		keyboard:
			typeof stored.keyboard === "string"
				? (findKeyboard(stored.keyboard)?.id ?? DEFAULT_PREFS.keyboard)
				: DEFAULT_PREFS.keyboard,
		volume:
			typeof stored.volume === "number" && Number.isFinite(stored.volume)
				? clampVolume(stored.volume)
				: DEFAULT_PREFS.volume,
	};
}
