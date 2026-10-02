/**
 * Tests leave no temp folders: each test run's workers write into one temp root the global teardown removes, and
 * `toolroll storage clean` knows every prefix the tests, journeys and scripts use, removing what nothing touched for a day.
 */
import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import tempRoot from "../test/temp-root.js";
import { isTestTemp, removeStaleTestTemp, testTempFolders } from "./test-temp.js";

const DAY = 86_400_000;
const made: string[] = [];
afterEach(() => { for (const one of made.splice(0)) rmSync(one, { recursive: true, force: true }); });

test("this run's workers write into the run's own temp root", () => {
  expect(basename(tmpdir())).toMatch(/^so-t/);
  expect(process.env.TMPDIR).toBe(tmpdir());
});

test("the global teardown removes the run's temp root and everything a test left in it, and puts TMPDIR back", () => {
  const before = process.env.TMPDIR;
  const teardown = tempRoot();
  try {
    const root = tmpdir();
    expect(dirname(root)).toBe(before);
    const left = mkdtempSync(join(tmpdir(), "so-route-cli-"));
    writeFileSync(join(left, "db.sqlite"), "x");
    teardown();
    expect(existsSync(left)).toBe(false);
    expect(existsSync(root)).toBe(false);
  } finally {
    expect(process.env.TMPDIR).toBe(before);
  }
});

/** Every prefix the tests, journeys and scripts give the temp folder. */
function prefixesInSources(): Map<string, string> {
  const found = new Map<string, string>();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (!["node_modules", "dist", "output"].includes(name)) walk(path); }
      else if (/\.(?:[cm]?[jt]s|sh)$/.test(name)) files.push(path);
    }
  };
  for (const dir of ["src", "scripts", "test"]) walk(resolve(dir));
  const pattern = /(?:tmpdir\w*\(\)|TMPDIR|os\.tmpdir\(\))\s*\)?\s*(?:,|\+\s*["'`]\/|\/)\s*["'`]([^"'`$/]+)/g;
  for (const file of files) for (const match of readFileSync(file, "utf8").matchAll(pattern)) if (!found.has(match[1]!)) found.set(match[1]!, file);
  return found;
}

test("every temp folder prefix the tests, journeys and scripts use is one storage clean knows", () => {
  const found = prefixesInSources();
  // The reader works: the prefixes the owner's Mac collected most are among them.
  for (const one of ["so-route-cli-", "so-viewer-ev-", "so-held-root-", "no-wt-", "epoch-", "cancel-floor-", "standing-orders-stub-", "standing-orders-switcher-repos-"]) expect(found.has(one), one).toBe(true);
  const missing = [...found].filter(([prefix]) => !isTestTemp(prefix)).map(([prefix, file]) => `${prefix} (${file})`);
  expect(missing, "add these to TEST_TEMP_PREFIXES in src/test-temp.ts").toEqual([]);
  expect(isTestTemp("playwright_chromiumdev_profile-AbC123")).toBe(true);
  expect(isTestTemp("com.apple.launchd.x")).toBe(false);
});

test("leftovers: test folders nothing touched for a day, judged by the folder and what is directly in it", () => {
  const root = mkdtempSync(join(tmpdir(), "so-temp-scan-"));
  made.push(root);
  const now = new Date();
  const old = new Date(now.getTime() - 2 * DAY);
  const folder = (name: string, touched: Date, child: Date = touched) => {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "file"), "x");
    utimesSync(join(root, name, "file"), child, child);
    utimesSync(join(root, name), touched, touched);
    return join(root, name);
  };
  const stale = folder("standing-orders-stub-abc", old);
  const busy = folder("toolroll-agent-db-abc", old, now); // a live run's database written just now
  const fresh = folder("epoch-123", now);
  const other = folder("not-a-test-folder", old);
  symlinkSync(stale, join(root, "so-link-to-it"));
  const found = testTempFolders([root], now);
  expect(found.all.map(one => one.path).sort()).toEqual([busy, fresh, stale].sort());
  expect(found.stale.map(one => one.path)).toEqual([stale]);
  expect(removeStaleTestTemp([root], now)).toEqual({ removed: [stale], failed: [] });
  expect([stale, busy, fresh, other].map(existsSync)).toEqual([false, true, true, true]);
});
