#!/usr/bin/env node
// Stamp the deployed build's identity into dist/build-info.json after tsc, so the
// server_info tool can report the exact commit that produced the running binary.
// Done at build time, not runtime: a runtime `git rev-parse` would report the
// source HEAD, which masks the "edited source, forgot to rebuild" skew this exists
// to surface. dist/build-info.json is gitignored (dist/ is not tracked).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  if (dirty) commit += "-dirty"; // built from an uncommitted tree
} catch {
  // Not a git checkout (e.g. dist copied without .git); leave "unknown".
}

const info = { version: pkg.version, commit, built_at: new Date().toISOString() };
writeFileSync(join(root, "dist", "build-info.json"), JSON.stringify(info) + "\n");
console.log("stamped dist/build-info.json:", JSON.stringify(info));
