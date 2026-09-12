/**
 * Native containment on Windows (plan acceptance 2): the Job Object helper
 * creates the target suspended, assigns it to a kill-on-close / no-breakaway
 * job, resumes it, and reports the job empty only after every member is
 * gone — so a detached grandchild dies with its root's natural exit and
 * with an exact-run stop, and the object's emptiness is the helper's word,
 * not a transport exit. Runs on win32 only; with
 * SO_EXPECT_NATIVE_CONTAINMENT=1 an unavailable backend fails instead of
 * skipping (the CI windows job sets it).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveContainment, pinContainment, probeContainmentCapability, resetContainmentForTests } from "./containment.js";
import { run, terminateOwnedProcesses } from "./exec.js";

const capability = process.platform === "win32" ? probeContainmentCapability() : null;
const native = capability !== null && capability.available;
const expected = process.env["SO_EXPECT_NATIVE_CONTAINMENT"] === "1";
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (predicate()) return true; await sleep(50); }
  return predicate();
}

/** A root that spawns a detached grandchild writing a tick file forever, records both pids, then exits or lingers. */
const ESCAPING_ROOT = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const dir = process.env.SO_DIR;
const child = spawn(process.execPath, ["-e", "setInterval(() => require('node:fs').appendFileSync(process.env.SO_DIR + '/ticks.log', 'tick\\\\n'), 20)"], { stdio: "ignore", detached: true, windowsHide: true, env: process.env });
child.unref();
writeFileSync(dir + "/pids.json", JSON.stringify({ root: process.pid, escaped: child.pid }));
if (process.env.SO_MODE === "exit") { setTimeout(() => process.exit(0), 300); }
else { setInterval(() => {}, 1000); }
`;

describe("native containment (Windows Job Object)", () => {
  test("the facility is reported truthfully — and expected where CI runs Windows", () => {
    if (capability === null) console.log(`native containment (job object): not win32 (${process.platform}) — skipped here`);
    else console.log(`native containment (job object): ${capability.available ? "available" : "unavailable"} — ${capability.detail}`);
    if (expected && process.platform === "win32") expect(native, capability?.detail ?? "").toBe(true);
  });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-native-win-"));
    writeFileSync(join(dir, "root.mjs"), ESCAPING_ROOT);
    if (native && capability !== null) pinContainment(effectiveContainment("required", capability));
  });
  afterEach(() => { resetContainmentForTests(); rmSync(dir, { recursive: true, force: true }); });

  const stableAfterSettlement = async (file: string): Promise<boolean> => {
    const before = existsSync(file) ? statSync(file).size : 0;
    await sleep(500);
    const after = existsSync(file) ? statSync(file).size : 0;
    return before === after;
  };

  test.skipIf(!native)("c2: a detached grandchild dies with the root's natural exit; the job is reported empty; no writes after settlement", async () => {
    let id = "";
    const result = await run(process.execPath, [join(dir, "root.mjs")], { processGroup: true, timeoutMs: 60_000, env: { SO_DIR: dir, SO_MODE: "exit" }, onContainer: info => { id = info.id; } });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.containment).toEqual({ backend: "job-object", id, empty: true });
    const pids = JSON.parse(readFileSync(join(dir, "pids.json"), "utf8")) as { root: number; escaped: number };
    expect(await waitFor(() => !alive(pids.escaped), 5_000)).toBe(true);
    expect(await stableAfterSettlement(join(dir, "ticks.log"))).toBe(true);
  });

  test.skipIf(!native)("c2: an exact-run stop terminates the whole job while an independent sibling keeps running", async () => {
    const { mkdirSync } = await import("node:fs");
    const a = join(dir, "a"); const b = join(dir, "b");
    mkdirSync(a); mkdirSync(b);
    const runA = run(process.execPath, [join(dir, "root.mjs")], { processGroup: true, owner: "run:A", timeoutMs: 60_000, env: { SO_DIR: a, SO_MODE: "linger" } });
    const runB = run(process.execPath, [join(dir, "root.mjs")], { processGroup: true, owner: "run:B", timeoutMs: 60_000, env: { SO_DIR: b, SO_MODE: "linger" } });
    expect(await waitFor(() => existsSync(join(a, "pids.json")) && existsSync(join(b, "pids.json")) && existsSync(join(a, "ticks.log")) && existsSync(join(b, "ticks.log")), 30_000)).toBe(true);
    const pidsA = JSON.parse(readFileSync(join(a, "pids.json"), "utf8")) as { root: number; escaped: number };
    const pidsB = JSON.parse(readFileSync(join(b, "pids.json"), "utf8")) as { root: number; escaped: number };
    expect(terminateOwnedProcesses("run:A")).toBe(1);
    const stopped = await runA;
    expect(stopped.containment).toMatchObject({ backend: "job-object", empty: true });
    expect(await waitFor(() => !alive(pidsA.root) && !alive(pidsA.escaped), 5_000)).toBe(true);
    expect(await stableAfterSettlement(join(a, "ticks.log"))).toBe(true);
    expect(alive(pidsB.root)).toBe(true);
    expect(alive(pidsB.escaped)).toBe(true);
    expect(await stableAfterSettlement(join(b, "ticks.log"))).toBe(false);
    expect(terminateOwnedProcesses("run:B")).toBe(1);
    const stoppedB = await runB;
    expect(stoppedB.containment).toMatchObject({ empty: true });
    expect(await waitFor(() => !alive(pidsB.escaped), 5_000)).toBe(true);
  });

  test.skipIf(!native)("c1: argv, environment and cwd reach the target verbatim through the helper", async () => {
    const script = join(dir, "echo.mjs");
    writeFileSync(script, `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env.SO_PROBE, cwd: process.cwd() }));`);
    const args = ["--flag", "a value with spaces", 'quotes "inside"', "trailing\\", "", "%PATH%", "unicode ✓"];
    const result = await run(process.execPath, [script, ...args], { processGroup: true, cwd: dir, timeoutMs: 60_000, env: { SO_PROBE: "probe-value" } });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ argv: args, env: "probe-value", cwd: dir });
  });
});
