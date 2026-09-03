#!/usr/bin/env node
/**
 * The execute bit tsc does not set.
 *
 * This was `chmod +x dist/cli.js` in the build script, which does not exist on
 * Windows — so a build that had entirely succeeded exited 1 and reported
 * itself as a failure. The bit still matters on POSIX, where `nightorders
 * link` makes a symlink to this file and the shell refuses to run it without.
 */

import { chmod, copyFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Owner, group, and other execute — the same bits npm sets on a package bin. */
const EXECUTABLE_BITS = 0o111;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The held-session supervisor ships as plain .mjs — tsc ignores it, and
// exec.ts resolves it as a sibling, so dist needs its own copy.
await copyFile(resolve(root, "src", "supervisor.mjs"), resolve(root, "dist", "supervisor.mjs"));

if (process.platform !== "win32") {
  for (const name of ["bin.js", "cli.js"]) {
    const file = resolve(root, "dist", name);
    const stats = await stat(file);
    const wanted = stats.mode | EXECUTABLE_BITS;
    if (wanted !== stats.mode) await chmod(file, wanted);
  }
}
