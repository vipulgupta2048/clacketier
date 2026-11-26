// The fallback for Command Code releases without the `keypress` mod event: read the
// terminal's raw input ourselves and turn each chunk into key kinds. Only the kind is
// kept (a letter, space, enter, backspace, a paste, anything else); the characters are
// never stored, logged or sent anywhere.

import type { KeypressKind } from "./mod-api.js";

// Longer than this in one chunk is a paste, not typing: one click, not a burst.
export const MAX_KEYS_PER_CHUNK = 16;

const ESC = "\u001b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

function kindOfCharacter(ch: string): KeypressKind {
	if (ch === " ") return "space";
	if (ch === "\r" || ch === "\n") return "enter";
	if (ch === "\u007f" || ch === "\b") return "backspace";
	if (ch < " ") return "other";
	return "character";
}

export interface ChunkKinds {
	readonly kinds: readonly KeypressKind[];
	// Inside a bracketed paste that hasn't ended yet: the next chunks are still the paste.
	readonly isInPaste: boolean;
}

/** The key kinds in one chunk of raw terminal input, in order. Pure. */
export function classifyChunk(params: {
	readonly chunk: string;
	readonly isInPaste: boolean;
}): ChunkKinds {
	const { chunk } = params;
	if (params.isInPaste) {
		// The rest of a long paste: silent, until its end marker.
		return { kinds: [], isInPaste: !chunk.includes(PASTE_END) };
	}
	if (chunk === "") return { kinds: [], isInPaste: false };
	if (chunk.startsWith(PASTE_START))
		return { kinds: ["paste"], isInPaste: !chunk.includes(PASTE_END) };
	// Characters typed before an escape sequence click; the sequence itself (arrows,
	// function keys, Alt chords, focus reports) is one quiet key.
	const escAt = chunk.indexOf(ESC);
	const typed = [...(escAt === -1 ? chunk : chunk.slice(0, escAt))];
	if (typed.length > MAX_KEYS_PER_CHUNK)
		return { kinds: ["paste"], isInPaste: false };
	const kinds = typed.map(kindOfCharacter);
	return {
		kinds: escAt === -1 ? kinds : [...kinds, "other"],
		isInPaste: false,
	};
}

export interface StdinKeys {
	readonly stop: () => void;
}

/**
 * Listen to the terminal's input next to Command Code. A `data` listener on a stream that
 * is also read through `readable` (as Ink does) receives each chunk as Ink reads it, so
 * nothing is taken away from the app. It is only attached while such a reader exists:
 * a lone `data` listener would put stdin into flowing mode and take the input itself.
 * Undefined when stdin isn't a terminal.
 */
export function listenToStdin(params: {
	readonly stdin: NodeJS.ReadStream;
	readonly onKey: (kind: KeypressKind) => void;
}): StdinKeys | undefined {
	const { stdin } = params;
	if (!stdin.isTTY) return undefined;
	let isInPaste = false;
	let isAttached = false;
	const onData = (data: Buffer | string): void => {
		const result = classifyChunk({ chunk: String(data), isInPaste });
		isInPaste = result.isInPaste;
		for (const kind of result.kinds) params.onKey(kind);
	};
	const hasReader = (): boolean => stdin.listenerCount("readable") > 0;
	const attach = (): void => {
		if (isAttached || !hasReader()) return;
		isAttached = true;
		stdin.on("data", onData);
	};
	const detach = (): void => {
		if (!isAttached) return;
		isAttached = false;
		stdin.off("data", onData);
	};
	// `newListener` fires before the reader is added: attach once it is in place.
	const onNewListener = (event: string | symbol): void => {
		if (event === "readable") queueMicrotask(attach);
	};
	// `removeListener` fires after it is gone: let go before Node would resume the stream.
	const onRemoveListener = (event: string | symbol): void => {
		if (event === "readable" && !hasReader()) detach();
	};
	stdin.on("newListener", onNewListener);
	stdin.on("removeListener", onRemoveListener);
	attach();
	return {
		stop: () => {
			stdin.off("newListener", onNewListener);
			stdin.off("removeListener", onRemoveListener);
			detach();
		},
	};
}
