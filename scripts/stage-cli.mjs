// Copies what the `clacketier` CLI package shares with the Command Code mod (the sounds,
// the macOS player, the README and license) into cli/ before `npm pack` or `npm publish`
// there. The copies are gitignored: the repo keeps one of each.
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "cli");
for (const item of ["players", "sounds", "README.md", "LICENSE"]) {
	rmSync(join(cli, item), { recursive: true, force: true });
	cpSync(join(root, item), join(cli, item), { recursive: true });
}
