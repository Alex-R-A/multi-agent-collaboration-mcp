// npm runs the `prepare` script in two very different places: a git-dependency
// install (src/ present: build it) and inside an extracted PUBLISHED tarball
// (src/ and tsconfig.json deliberately not shipped; dist/ already is).
// Running tsc unconditionally made `npm install` fail inside the tarball.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync(new URL("../src", import.meta.url))) {
  process.exit(0); // packaged tarball: dist is prebuilt, nothing to do
}
const r = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  timeout: 120_000,
  killSignal: "SIGKILL",
});
process.exit(r.status ?? 1);
