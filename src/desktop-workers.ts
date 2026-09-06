/** Local supervision, separate from the console window and HTTP server. */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import type { Store } from "./store.js";
import { registerRunnerIfIdle, retireRunnerIfCurrent } from "./runner.js";
import { stopTaskRun } from "./control.js";
import { run } from "./exec.js";

export type WorkerState = { repo: string; runner: string; state: "running" | "stopping" | "stopped" | "error"; detail: string };
export type LocalControl = {
  host: string;
  status: () => WorkerState[];
  check?: () => Promise<string[]>;
  change: (repo: string, action: "start" | "stop", by: string) => { ok: boolean; message: string };
};
export const desktopRunnerName = (repo: string): string => `desktop-${createHash("sha256").update(repo).digest("hex").slice(0, 12)}`;

export class DesktopWorkers implements LocalControl {
  readonly host = hostname();
  private children = new Map<string, { child: ChildProcess; token: string; stopping: boolean }>();
  private errors = new Map<string, string>();
  constructor(private store: Store, private databaseFile: string, private repos: () => string[], private spawnWorker: typeof spawn = spawn, private poolRoot = join(dirname(databaseFile), "worktrees")) {}

  status(): WorkerState[] {
    return this.repos().map(repo => {
      const child = this.children.get(repo);
      return { repo, runner: desktopRunnerName(repo), state: child === undefined ? this.errors.has(repo) ? "error" : "stopped" : child.stopping ? "stopping" : "running",
        detail: this.errors.get(repo) ?? (child?.stopping ? "Stopping admission and preserving active work." : child ? "Watching for approved work." : "Start when this repository is ready.") };
    });
  }

  async check(): Promise<string[]> {
    return Promise.all(["git", "gh", "claude", "codex", "gemini"].map(async binary => {
      const result = await run(binary, ["--version"], { timeoutMs: 5000 });
      return `${binary}: ${result.notFound ? "not installed on the service PATH" : result.code === 0 ? "installed and responds" : "installed, but the version check failed"}`;
    }));
  }

  change(repo: string, action: "start" | "stop", by: string): { ok: boolean; message: string } {
    if (!this.repos().includes(repo)) return { ok: false, message: "Choose a project available on this computer." };
    if (action === "start" && this.store.isDemo()) return { ok: false, message: "This is a demo. Workers can start after you choose your own repository in the regular app." };
    const existing = this.children.get(repo);
    if (action === "stop") {
      if (existing === undefined) return { ok: true, message: "Worker is already stopped." };
      if (existing.stopping) return { ok: true, message: "The worker is already stopping." };
      // Persist each interruption BEFORE signalling the watch. The worker
      // gateway and completion transaction honor these even after a restart.
      for (const run of this.store.liveRuns(new Date())) {
        if (run.runner === desktopRunnerName(repo) && run.role !== "repair") stopTaskRun(this.store, { taskId: run.taskId, runId: run.id, by, now: new Date() });
      }
      existing.stopping = true;
      existing.child.kill("SIGINT");
      return { ok: true, message: `Stopping the worker on ${this.host}. Active tasks will stay paused.` };
    }
    if (existing !== undefined) return { ok: !existing.stopping, message: existing.stopping ? "Wait for the worker to finish stopping." : "Worker is already running." };
    const runner = desktopRunnerName(repo);
    const registration = registerRunnerIfIdle(this.store, { name: runner, host: this.host, repos: [repo], now: new Date() });
    if (!registration.ok) return { ok: false, message: registration.detail };
    let log: number | undefined;
    try {
      const dir = join(dirname(this.databaseFile), "desktop-workers");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tokenFile = join(dir, `${runner}.token`);
      writeFileSync(tokenFile, registration.token, { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
      log = openSync(join(dir, `${runner}.log`), "a", 0o600);
      const child = this.spawnWorker(process.execPath, [fileURLToPath(new URL("bin.js", import.meta.url)), "watch", "--db", this.databaseFile,
        "--runner", runner, "--token-file", tokenFile, "--repo", repo, "--pool", this.poolRoot, "--json"],
      { cwd: repo, stdio: ["ignore", log, log], env: process.env });
      this.children.set(repo, { child, token: registration.token, stopping: false });
      this.errors.delete(repo);
      child.once("error", () => this.errors.set(repo, "The worker could not start. Check the local service log."));
      child.once("close", code => {
        const owned = this.children.get(repo);
        if (owned?.child !== child) return;
        this.children.delete(repo);
        retireRunnerIfCurrent(this.store, runner, registration.token, new Date());
        if (!owned.stopping) this.errors.set(repo, `Worker exited (${code ?? "signal"}). Review the service log and start it again.`);
      });
      return { ok: true, message: `Worker started on ${this.host}. It can take approved tasks in this repository.` };
    } catch {
      retireRunnerIfCurrent(this.store, runner, registration.token, new Date());
      return { ok: false, message: "The local worker could not be launched." };
    } finally { if (log !== undefined) closeSync(log); }
  }

  async close(): Promise<void> {
    const exits = [...this.children.values()].map(one => new Promise<void>(resolve => one.child.once("close", () => resolve())));
    for (const repo of this.children.keys()) this.change(repo, "stop", "local service shutdown");
    await Promise.all(exits);
  }
}
