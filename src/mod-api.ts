// The slice of Command Code's `ModApi` this mod uses, declared locally so the
// project typechecks on its own. Command Code passes the full API at load
// time; these members match the documented signatures.

export interface Disposable {
	dispose(): void;
}

export interface ModCommandResult {
	readonly prompt?: string;
	readonly message?: string;
}

export interface ModCommand {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
	readonly handler: (ctx: {
		readonly args: string;
	}) => Promise<ModCommandResult | undefined>;
}

export interface ModHooks {
	readonly onSessionStart?: () => void;
	readonly onSessionEnd?: () => void;
}

export type ModAudioResult =
	| { readonly isPlayed: true }
	| { readonly isPlayed: false; readonly reason: string };

// What kind of key was pressed, never which one: a mod can't read what you type.
export type KeypressKind =
	| "character"
	| "space"
	| "enter"
	| "backspace"
	| "paste"
	| "other";

export interface ModApi {
	readonly ui: {
		notify(
			text: string,
			level?: "info" | "success" | "warning" | "error",
		): void;
		select(params: {
			title: string;
			options: readonly { label: string; description?: string }[];
		}): Promise<string | undefined>;
	};
	readonly store: {
		get<T = unknown>(key: string): T | undefined;
		set(key: string, value: unknown): Promise<void>;
	};
	readonly audio: {
		play(params: {
			readonly file: string;
			readonly timeoutMs?: number;
		}): Promise<ModAudioResult>;
	};
	hooks(hooks: ModHooks): Disposable;
	// `keypress` arrived after Command Code 1.93; older hosts never emit it.
	on(
		event: "keypress",
		handler: (event: {
			readonly type: string;
			readonly kind?: unknown;
		}) => void,
	): Disposable;
	addCommand(command: ModCommand): Disposable;
}
