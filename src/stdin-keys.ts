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
	// The paste's last few characters, in case its end marker is split across chunks.
	readonly pasteTail: string;
}

// Inside a paste: silent up to its end marker, then whatever was typed after it.
function restOfPaste(text: string): ChunkKinds {
	const endAt = text.indexOf(PASTE_END);
	if (endAt === -1)
		return {
			kinds: [],
			isInPaste: true,
			pasteTail: text.slice(-(PASTE_END.length - 1)),
		};
	return classifyChunk({
		chunk: text.slice(endAt + PASTE_END.length),
		isInPaste: false,
	});
}

// How long the escape sequence at the start of `text` is: a CSI sequence (arrows, function
// keys, focus reports) up to its final byte, SS3 (`ESC O x`), or an Alt chord (`ESC x`).
function escapeLength(text: string): number {
	if (text[1] === "[") {
		const finalAt = text.slice(2).search(/[\u0040-\u007e]/);
		return finalAt === -1 ? text.length : finalAt + 3;
	}
	if (text[1] === "O") return Math.min(3, text.length);
	return Math.min(2, text.length);
}

/** The key kinds in one chunk of raw terminal input, in order. Pure. */
export function classifyChunk(params: {
	readonly chunk: string;
	readonly isInPaste: boolean;
	readonly pasteTail?: string;
}): ChunkKinds {
	if (params.isInPaste)
		return restOfPaste(`${params.pasteTail ?? ""}${params.chunk}`);
	// Typed characters click; an escape sequence is one quiet key, a paste one click.
	const kinds: KeypressKind[] = [];
	let rest = params.chunk;
	while (rest !== "") {
		const escAt = rest.indexOf(ESC);
		const typed = [...(escAt === -1 ? rest : rest.slice(0, escAt))];
		// Longer than a burst of typing: a paste the terminal didn't mark.
		kinds.push(
			...(typed.length > MAX_KEYS_PER_CHUNK
				? (["paste"] as const)
				: typed.map(kindOfCharacter)),
		);
		if (escAt === -1) break;
		rest = rest.slice(escAt);
		if (rest.startsWith(PASTE_START)) {
			const paste = restOfPaste(rest.slice(PASTE_START.length));
			return { ...paste, kinds: [...kinds, "paste", ...paste.kinds] };
		}
		kinds.push("other");
		rest = rest.slice(escapeLength(rest));
	}
	return { kinds, isInPaste: false, pasteTail: "" };
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
	let pasteTail = "";
	let isAttached = false;
	let isStopped = false;
	const onData = (data: Buffer | string): void => {
		const result = classifyChunk({ chunk: String(data), isInPaste, pasteTail });
		isInPaste = result.isInPaste;
		pasteTail = result.pasteTail;
		for (const kind of result.kinds) params.onKey(kind);
	};
	const hasReader = (): boolean => stdin.listenerCount("readable") > 0;
	const attach = (): void => {
		if (isStopped || isAttached || !hasReader()) return;
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
			isStopped = true;
			stdin.off("newListener", onNewListener);
			stdin.off("removeListener", onRemoveListener);
			detach();
		},
	};
}
