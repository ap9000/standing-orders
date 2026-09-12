/**
 * Native containment against REAL processes and a REAL cgroup v2 (plan
 * acceptance 2): an immediate setsid/double-fork helper dies with its
 * root's natural exit, an exact-run stop ends one run's whole object while
 * an independent sibling keeps running, the worker's death takes its
 * objects with it through the janitor, the held supervisor road is
 * covered by the same object, and nothing writes after settlement.
 *
 * These tests EXECUTE only where the facility exists — Linux with a
 * delegated cgroup v2 (the CI job delegates one). Anywhere else they
 * report the exact reason and skip; with SO_EXPECT_NATIVE_CONTAINMENT=1
 * an unavailable facility is a failure, so a runner that was meant to
 * exercise them cannot quietly pass by skipping.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { effectiveContainment, pinContainment, probeContainmentCapability, resetContainmentForTests } from "./containment.js";
import { containerEmptiness } from "./container-state.js";
import { run, startClaudeHeldSession, terminateOwnedProcesses } from "./exec.js";

const capability = process.platform === "linux" ? probeContainmentCapability() : null;
const native = capability !== null && capability.available;
const expected = process.env["SO_EXPECT_NATIVE_CONTAINMENT"] === "1";

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/** Alive = exists and is not a zombie: a killed orphan stays a zombie until
 * its reaper collects it (a container without an init never does), and a
 * zombie can neither run nor write — the cgroup already reported it gone. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  try { return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
};
async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (predicate()) return true; await sleep(25); }
  return predicate();
}

/** A root that spawns an immediate setsid'd grandchild (its own session and
 * group, reparented to init the moment the root exits) which writes a tick
 * file forever, records both pids, then behaves as the test asks. */
const ESCAPING_ROOT = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const dir = process.env.SO_DIR;
const child = spawn("/bin/sh", ["-c", 'while true; do echo tick >> "' + dir + '/ticks.log"; sleep 0.02; done'], { stdio: "ignore", detached: true });
child.unref();
writeFileSync(dir + "/pids.json", JSON.stringify({ root: process.pid, escaped: child.pid }));
if (process.env.SO_MODE === "exit") { setTimeout(() => process.exit(0), 200); }
else { setInterval(() => {}, 1000); }
`;

describe("native containment (Linux, delegated cgroup v2)", () => {
  test("the facility is reported truthfully — and expected where CI delegated one", () => {
    if (capability === null) {
      console.log(`native containment: not linux (${process.platform}) — the native tests skip here`);
    } else {
      console.log(`native containment: ${capability.available ? "available" : "unavailable"} — ${capability.detail}`);
    }
    if (expected) expect(native, `SO_EXPECT_NATIVE_CONTAINMENT=1 but ${capability?.detail ?? process.platform}`).toBe(true);
  });

  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-native-")));
    writeFileSync(join(dir, "root.mjs"), ESCAPING_ROOT);
    if (native && capability !== null) pinContainment(effectiveContainment("required", capability));
  });
  afterEach(() => { resetContainmentForTests(); rmSync(dir, { recursive: true, force: true }); });

  const stableAfterSettlement = async (file: string): Promise<boolean> => {
    const before = existsSync(file) ? statSync(file).size : 0;
    await sleep(400);
    const after = existsSync(file) ? statSync(file).size : 0;
    return before === after;
  };

  test.skipIf(!native)("c2: a setsid'd double-fork helper dies with the root's NATURAL exit; the object is proven empty; no writes after settlement", async () => {
    let id = "";
    const result = await run(process.execPath, [join(dir, "root.mjs")], { processGroup: true, timeoutMs: 20_000, env: { SO_DIR: dir, SO_MODE: "exit" }, onContainer: info => { id = info.id; } });
    expect(result.code).toBe(0);
    expect(result.containment).toEqual({ backend: "cgroup2", id, empty: true });
    const pids = JSON.parse(readFileSync(join(dir, "pids.json"), "utf8")) as { root: number; escaped: number };
    expect(await waitFor(() => !alive(pids.escaped), 5_000)).toBe(true);
    expect(await stableAfterSettlement(join(dir, "ticks.log"))).toBe(true);
    // The object itself is gone (only an empty cgroup can be removed).
    expect(existsSync(id)).toBe(false);
    expect(containerEmptiness("cgroup2", id)).toBe("empty");
  });

  test.skipIf(!native)("c2: an exact-run stop ends one run's whole object — escaped helper included — while an independent sibling keeps running", async () => {
    const a = join(dir, "a"); const b = join(dir, "b");
    for (const one of [a, b]) { rmSync(one, { recursive: true, force: true }); }
    const { mkdirSync } = await import("node:fs");
    mkdirSync(a); mkdirSync(b);
    const ids: Record<string, string> = {};
    const runA = run(process.execPath, [join(dir, "root.mjs")], { processGroup: true, owner: "run:A", timeoutMs: 30_000, env: { SO_DIR: a, SO_MODE: "linger" }, onContainer: info => { ids["a"] = info.id; } });
    const runB = run(process.execPath, [join(dir, "root.mjs")], { processGroup: true, owner: "run:B", timeoutMs: 30_000, env: { SO_DIR: b, SO_MODE: "linger" }, onContainer: info => { ids["b"] = info.id; } });
    expect(await waitFor(() => existsSync(join(a, "pids.json")) && existsSync(join(b, "pids.json")) && existsSync(join(a, "ticks.log")) && existsSync(join(b, "ticks.log")), 10_000)).toBe(true);
    const pidsA = JSON.parse(readFileSync(join(a, "pids.json"), "utf8")) as { root: number; escaped: number };
    const pidsB = JSON.parse(readFileSync(join(b, "pids.json"), "utf8")) as { root: number; escaped: number };
    expect(readFileSync(join(ids["a"]!, "cgroup.events"), "utf8")).toContain("populated 1");

    expect(terminateOwnedProcesses("run:A")).toBe(1);
    const stopped = await runA;
    expect(stopped.containment).toEqual({ backend: "cgroup2", id: ids["a"], empty: true });
    expect(await waitFor(() => !alive(pidsA.root) && !alive(pidsA.escaped), 5_000)).toBe(true);
    expect(await stableAfterSettlement(join(a, "ticks.log"))).toBe(true);

    // The sibling is untouched: root and escaped helper alive, still writing.
    expect(alive(pidsB.root)).toBe(true);
    expect(alive(pidsB.escaped)).toBe(true);
    expect(await stableAfterSettlement(join(b, "ticks.log"))).toBe(false);
    expect(readFileSync(join(ids["b"]!, "cgroup.events"), "utf8")).toContain("populated 1");

    expect(terminateOwnedProcesses("run:B")).toBe(1);
    const stoppedB = await runB;
    expect(stoppedB.containment).toMatchObject({ empty: true });
    expect(await waitFor(() => !alive(pidsB.escaped), 5_000)).toBe(true);
  });

  test.skipIf(!native)("c2: the WORKER's death takes its objects with it — the janitor kills and removes the cgroup", async () => {
    // A worker process that pins required containment and runs the
    // escaping root; the test SIGKILLs the worker mid-run.
    const worker = join(dir, "worker.mjs");
    writeFileSync(worker, `
      const { pinContainment, effectiveContainment, probeContainmentCapability } = await import(${JSON.stringify(pathToFileURL(resolve("dist/containment.js")).href)});
      const { run } = await import(${JSON.stringify(pathToFileURL(resolve("dist/exec.js")).href)});
      import { writeFileSync } from "node:fs";
      pinContainment(effectiveContainment("required", probeContainmentCapability()));
      void run(process.execPath, [${JSON.stringify(join(dir, "root.mjs"))}], { processGroup: true, timeoutMs: 60_000, env: { ...process.env, SO_DIR: ${JSON.stringify(dir)}, SO_MODE: "linger" }, onContainer: info => writeFileSync(${JSON.stringify(join(dir, "object.txt"))}, info.id) });
      setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, [worker], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    try {
      expect(await waitFor(() => existsSync(join(dir, "pids.json")) && existsSync(join(dir, "object.txt")), 15_000), output).toBe(true);
      const pids = JSON.parse(readFileSync(join(dir, "pids.json"), "utf8")) as { root: number; escaped: number };
      const id = readFileSync(join(dir, "object.txt"), "utf8");
      expect(containerEmptiness("cgroup2", id)).toBe("populated");
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
      expect(await waitFor(() => !alive(pids.root) && !alive(pids.escaped), 10_000)).toBe(true);
      expect(await waitFor(() => !existsSync(id), 10_000)).toBe(true);
      expect(containerEmptiness("cgroup2", id)).toBe("empty");
      expect(await stableAfterSettlement(join(dir, "ticks.log"))).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  test.skipIf(!native)("c2: the held supervisor road runs inside the object: killHard ends the agent's escaped helper and proves the object empty", async () => {
    const agent = join(dir, "agent.mjs");
    writeFileSync(agent, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      const dir = ${JSON.stringify(dir)};
      const child = spawn("/bin/sh", ["-c", 'while true; do echo tick >> "' + dir + '/held-ticks.log"; sleep 0.02; done'], { stdio: "ignore", detached: true });
      child.unref();
      writeFileSync(dir + "/held-pids.json", JSON.stringify({ agent: process.pid, escaped: child.pid }));
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `);
    let id = "";
    let empties = 0;
    const started = await startClaudeHeldSession(process.execPath, [agent], {
      socketPath: join(dir, "h.sock"),
      cookie: "cookie",
      graceMs: 1000,
      readyTimeoutMs: 10_000,
      onContainer: info => { id = info.id; },
      onContainerEmpty: () => { empties += 1; },
    });
    expect(started.ok, started.ok ? "" : started.message).toBe(true);
    if (!started.ok) return;
    expect(await waitFor(() => existsSync(join(dir, "held-pids.json")), 10_000)).toBe(true);
    const pids = JSON.parse(readFileSync(join(dir, "held-pids.json"), "utf8")) as { agent: number; escaped: number };
    expect(containerEmptiness("cgroup2", id)).toBe("populated");
    started.handle.killHard();
    await started.handle.exited;
    expect(await waitFor(() => !alive(pids.agent) && !alive(pids.escaped), 10_000)).toBe(true);
    expect(empties).toBe(1);
    expect(containerEmptiness("cgroup2", id)).toBe("empty");
    expect(await stableAfterSettlement(join(dir, "held-ticks.log"))).toBe(true);
  });

  test.skipIf(!native)("c2: a required policy on a machine whose delegated cgroup vanished refuses per spawn, before any target runs", async () => {
    pinContainment(effectiveContainment("required", { ...capability!, cgroupRoot: join(dir, "not-a-cgroup") }));
    const mark = join(dir, "ran.txt");
    const result = await run(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran")`], { processGroup: true, timeoutMs: 10_000 });
    expect(result.code).toBe(126);
    expect(result.containment).toEqual({ refused: expect.stringContaining("could not be established for this spawn") });
    expect(existsSync(mark)).toBe(false);
  });
});
