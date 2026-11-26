// The fallback for Command Code releases without the `keypress` mod event: read the
// terminal's raw input ourselves and turn each chunk into key kinds. Only the kind is
// kept (a letter, space, enter, backspace, a paste, anything else); the characters are
// never stored, logged or sent anywhere.

import type { KeypressKind } from "./mod-api.js";

// Longer than this in one chunk is a paste, not typing: one click, not a burst.
export const MAX_KEYS_PER_CHUNK = 16;

const ESC = "\u001b";
const PASTE_START = `${ESC}[200~`;

function kindOfCharacter(ch: string): KeypressKind {
	if (ch === " ") return "space";
	if (ch === "\r" || ch === "\n") return "enter";
	if (ch === "\u007f" || ch === "\b") return "backspace";
	if (ch < " ") return "other";
	return "character";
}

/** The key kinds in one chunk of raw terminal input, in order. Pure. */
export function classifyChunk(chunk: string): readonly KeypressKind[] {
	if (chunk === "") return [];
	if (chunk.startsWith(PASTE_START)) return ["paste"];
	// An escape sequence (arrows, function keys, Alt chords, focus reports) is one key.
	if (chunk.startsWith(ESC)) return ["other"];
	const chars = [...chunk];
	if (chars.length > MAX_KEYS_PER_CHUNK) return ["paste"];
	return chars.map(kindOfCharacter);
}

export interface StdinKeys {
	readonly stop: () => void;
}

/**
 * Listen to the terminal's input next to Command Code. A `data` listener on a stream that
 * is also read through `readable` (as Ink does) receives each chunk as Ink reads it, so
 * nothing is taken away from the app. Undefined when stdin isn't a terminal.
 */
export function listenToStdin(params: {
	readonly stdin: NodeJS.ReadStream;
	readonly onKey: (kind: KeypressKind) => void;
}): StdinKeys | undefined {
	if (!params.stdin.isTTY) return undefined;
	const onData = (data: Buffer | string): void => {
		for (const kind of classifyChunk(String(data))) params.onKey(kind);
	};
	params.stdin.on("data", onData);
	return { stop: () => params.stdin.off("data", onData) };
}
