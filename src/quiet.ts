// When this terminal stays quiet: turned off with CLACKETIER=off, in CI, or over SSH
// (the clicks would play on the remote machine nobody is sitting at).

export type QuietReason = "env-off" | "ci" | "ssh";

const OFF_VALUES: ReadonlySet<string> = new Set([
	"0",
	"off",
	"false",
	"no",
	"mute",
]);

function isSet(value: string | undefined): boolean {
	if (value === undefined || value === "") return false;
	return !OFF_VALUES.has(value.toLowerCase());
}

/** Why the environment should stay quiet, if it should. Pure. */
export function quietReason(
	env: Readonly<Record<string, string | undefined>>,
): QuietReason | undefined {
	const setting = env.CLACKETIER;
	if (setting !== undefined && OFF_VALUES.has(setting.toLowerCase()))
		return "env-off";
	// An explicit on wins over the CI and SSH guesses below.
	if (isSet(setting)) return undefined;
	if (isSet(env.CI)) return "ci";
	if (isSet(env.SSH_CONNECTION) || isSet(env.SSH_TTY)) return "ssh";
	return undefined;
}

export const QUIET_NOTES: Readonly<Record<QuietReason, string>> = {
	"env-off": "Quiet: CLACKETIER is off.",
	ci: "Quiet: running in CI. Set CLACKETIER=on to override.",
	ssh: "Quiet: over SSH the clicks would play on the remote machine. Set CLACKETIER=on to override.",
};
