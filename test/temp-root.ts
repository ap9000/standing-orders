import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests leave no temp folders. Every test run gets one temp root of its own, before any worker starts: the workers
 * and everything they spawn inherit it as TMPDIR, so whatever a test makes in tmpdir() (so-*, standing-orders-*,
 * no-wt*, a socket, a browser profile) lands there, and the global teardown removes it all, whether or not each test
 * cleaned up after itself. A short name keeps the socket paths tests make under it within the OS limit.
 */
export default function tempRoot(): () => void {
  const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const root = mkdtempSync(join(tmpdir(), "so-t"));
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
}
