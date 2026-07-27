#!/usr/bin/env node
// Stamp the deployed build's identity into dist/build-info.json after tsc, so the
// server_info tool can report the exact commit that produced the running binary.
// Done at build time, not runtime: a runtime `git rev-parse` would report the
// source HEAD, which masks the "edited source, forgot to rebuild" skew this exists
// to surface. dist/build-info.json is gitignored (dist/ is not tracked).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    }).trim().length > 0;
  if (dirty) commit += "-dirty"; // built from an uncommitted tree
} catch {
  // Not a git checkout (e.g. dist copied without .git); leave "unknown".
}

// A timestamp alone makes every no-change rebuild tell already-running MCP
// processes they are stale. Hash the executable JS instead: reconnect only
// when the deployed behavior actually differs. built_at is kept for human
// diagnostics and ordering ONLY -- it is never compared to decide staleness,
// and there is no fallback for a stamp without a hash: every stamp this script
// writes carries one.
const dist = join(root, "dist");
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    // dist is generated output. Never follow a stray symlink during a build:
    // a loop or a link to a large tree could turn stamping into an unbounded
    // traversal, and the linked bytes are not part of the packaged artifact.
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(path);
    else if (name.endsWith(".js")) files.push(path);
  }
};
walk(dist);
// Code-unit comparison is deterministic across LANG/LC_ALL. localeCompare
// made identical artifacts hash differently under locales such as cs_CZ.
files.sort((a, b) => {
  const ar = relative(root, a);
  const br = relative(root, b);
  return ar < br ? -1 : ar > br ? 1 : 0;
});
const hash = createHash("sha256");
const runtimeDependencies = Object.keys(pkg.dependencies ?? {})
  .sort()
  .map((name) => {
    try {
      const installed = JSON.parse(
        readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
      );
      return [name, installed.version];
    } catch {
      // A normal build has dependencies installed. Keep the declared range in
      // the identity if a nonstandard packager compiles without node_modules.
      return [name, pkg.dependencies[name]];
    }
  });
hash.update(
  JSON.stringify({ version: pkg.version, dependencies: runtimeDependencies }),
);
hash.update("\0");
for (const path of files) {
  hash.update(relative(root, path));
  hash.update("\0");
  hash.update(readFileSync(path));
  hash.update("\0");
}

const info = {
  version: pkg.version,
  commit,
  built_at: new Date().toISOString(),
  artifact_hash: hash.digest("hex"),
};
writeFileSync(join(root, "dist", "build-info.json"), JSON.stringify(info) + "\n");
console.log("stamped dist/build-info.json:", JSON.stringify(info));
