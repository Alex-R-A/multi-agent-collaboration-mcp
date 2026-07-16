#!/usr/bin/env node
// Stamp the deployed build's identity into dist/build-info.json after tsc, so the
// server_info tool can report the exact commit that produced the running binary.
// Done at build time, not runtime: a runtime `git rev-parse` would report the
// source HEAD, which masks the "edited source, forgot to rebuild" skew this exists
// to surface. dist/build-info.json is gitignored (dist/ is not tracked).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
// when the deployed behavior actually differs. Keep the timestamp for human
// diagnostics and as a compatibility fallback for stamps made by old builds.
const dist = join(root, "dist");
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".js")) files.push(path);
  }
};
walk(dist);
files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
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
