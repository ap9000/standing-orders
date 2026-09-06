import { test, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopWorkers, desktopRunnerName } from "./desktop-workers.js";
import { openStore } from "./store.js";
import { acquire } from "./claim.js";

class FakeChild extends EventEmitter {
  signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); return true; }
}
test("local worker control starts an owned process, keeps its token out of argv, and stops only its own work", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-workers-"));
  const store = openStore(join(root, "orders.db"));
  const children: FakeChild[] = [];
  const calls: { file: string; args: string[] }[] = [];
  const fakeSpawn = ((file: string, args: string[]) => { calls.push({ file, args }); const child = new FakeChild(); children.push(child); return child; }) as unknown as typeof spawn;
  const workers = new DesktopWorkers(store, join(root, "orders.db"), () => ["/repo-a", "/repo-b"], fakeSpawn);
  try {
    expect(workers.status().map(one => one.state)).toEqual(["stopped", "stopped"]);
    expect(workers.change("/elsewhere", "start", "alex").ok).toBe(false);
    expect(workers.change("/repo-a", "start", "alex").ok).toBe(true);
    expect(workers.change("/repo-b", "start", "alex").ok).toBe(true);
    expect(workers.change("/repo-a", "start", "alex").ok).toBe(true);
    expect(children).toHaveLength(2);
    const a = calls[0]!;
    const tokenFile = a.args[a.args.indexOf("--token-file") + 1]!;
    const token = readFileSync(tokenFile, "utf8");
    expect(a.args).not.toContain(token);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const now = new Date();
    store.createTask({ id: "a", title: "Pause me" }, now);
    const ref = store.refFor("built-in", "a").id; store.placeTask(ref, "/repo-a");
    const claim = acquire(store, ref, desktopRunnerName("/repo-a"), { token, now });
    if (!claim.ok) throw new Error(claim.reason);
    store.setTaskState("a", "running", now);
    const run = store.startRun({ taskRef: ref, runner: desktopRunnerName("/repo-a"), leaseId: claim.claim.leaseId, worktree: "/work", branch: "work/a", now });
    expect(workers.change("/repo-a", "stop", "alex").ok).toBe(true);
    expect(workers.change("/repo-a", "stop", "alex").ok).toBe(true);
    expect(store.runStopRequested(run)).toBe(true);
    expect(children[0]!.signals).toEqual(["SIGINT"]);
    expect(children[1]!.signals).toEqual([]);
    expect(workers.status()[0]!.state).toBe("stopping");
    children[0]!.emit("close", 0);
    expect(workers.status()[0]!.state).toBe("stopped");
    expect(workers.status()[1]!.state).toBe("running");
    children[1]!.emit("close", 1);
    expect(workers.status()[1]!.state).toBe("error");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a local filesystem failure retires the worker registration before reporting failure", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-workers-"));
  const store = openStore(join(root, "orders.db"));
  try {
    writeFileSync(join(root, "desktop-workers"), "This fixture blocks directory creation.");
    const workers = new DesktopWorkers(store, join(root, "orders.db"), () => [root]);
    expect(workers.change(root, "start", "alex").ok).toBe(false);
    expect(store.getRunner(desktopRunnerName(root))?.runner.retiredAt).not.toBeNull();
    expect(workers.status()[0]?.state).toBe("stopped");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
