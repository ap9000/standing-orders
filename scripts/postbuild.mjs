#!/usr/bin/env node
/**
 * The execute bit tsc does not set.
 *
 * This was `chmod +x dist/cli.js` in the build script, which does not exist on
 * Windows — so a build that had entirely succeeded exited 1 and reported
 * itself as a failure. The bit still matters on POSIX, where `nightorders
 * link` makes a symlink to this file and the shell refuses to run it without.
 */

import { chmod, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Owner, group, and other execute — the same bits npm sets on a package bin. */
const EXECUTABLE_BITS = 0o111;

if (process.platform !== "win32") {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const stats = await stat(cli);
  const wanted = stats.mode | EXECUTABLE_BITS;
  if (wanted !== stats.mode) await chmod(cli, wanted);
}
