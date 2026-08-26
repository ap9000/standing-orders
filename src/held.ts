/**
 * The HeldSessionCoordinator (Parity II Phase 2, spec v2 S0 as amended
 * through v6): the ONE owner of held attended sessions in an `up` process.
 *
 * Ownership transfer is the whole design: build() reaches its spawn point,
 * hands this coordinator the captured settlement record and returns `held`
 * WITHOUT settling anything — the watch loop keeps dispatching, and the
 * session's lease heartbeats, exact timers, turn ledger, and eventual
 * settlement all live here. A held run completes through the SAME
 * settleProviderOutcome → disposeBuildOutcome pair every other road uses,
 * or it is fenced to `interrupted` — never a third way.
 *
 * Phase 2D scope note, stated: this coordinator runs the attended
 * authorization road end-to-end — final proof, custody, the brief as turn
 * one, per-turn acceptance and marginal-delta settlement, expiry/lapse/
 * turn-timeout/lease fences, crash custody — and ends the hold at the
 * agent's first settled turn (terminal handoff, park, or silence, each
 * classified by the shared settlement). The multi-turn conversation loop
 * (operator turn box, answer injection, held repair) arrives with its
 * console surfaces in the next slice; nothing here forecloses it.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { connect } from "node:net";
import { attendedLivenessState, BEAT_MS } from "./liveness.js";
import { settleProviderOutcome, type CapturedBuild } from "./builder.js";
import { disposeBuildOutcome, type DisposeContext, type Disposition } from "./dispose.js";
import { heldSocketPathProblem, startClaudeHeldSession, type HeldSessionHandle } from "./exec.js";
import { invokeHeldAgent } from "./invoke.js";
import { claudeHeldArgv } from "./provider.js";
import { heartbeat, release } from "./claim.js";
import { profileDigestOf } from "./scope.js";
import { heartbeat as runnerHeartbeat } from "./runner.js";
import type { AgentOutcome } from "./invoke.js";
import type { AttendedAuthorization, SessionTurn, Store } from "./store.js";

/** What the mint signed, parsed exactly once per proof. */
type SignedTerms = {
  scopeDigest: string;
  profileDigest: string;
  repo: string;
  head: string;
};

export type HeldLaunchArgs = {
  store: Store;
  captured: CapturedBuild;
  authorization: AttendedAuthorization;
  runId: number;
  leaseId: string;
  runner: string;
  runnerToken?: string;
  upIncarnation: string;
  /** The composed brief — injected as turn one, source 'brief'. */
  brief: string;
  cwd: string;
  /** A SHORT directory for control sockets (sun_path is unforgiving). */
  socketDir: string;
  releaseWorktree: (path: string) => Promise<unknown>;
  liveLog: { observe(event: Record<string, unknown>): void; close(): void } | null;
  omitEnv: readonly string[];
  /** Fields the disposition service needs that the capture does not carry. */
  dispose: Pick<DisposeContext, "repo" | "origin" | "provider" | "model">;
  clock: () => Date;
  /** Test seams. */
  starter?: typeof startClaudeHeldSession;
  graceMs?: number;
  onDisposed?: (disposition: Disposition | { kind: "interrupted"; reason: string }) => void;
};

type Controller = {
  runId: number;
  fenceStarted: boolean;
  concluded: boolean;
  handle: HeldSessionHandle | null;
  timers: ReturnType<typeof setTimeout>[];
  intervals: ReturnType<typeof setInterval>[];
  done: Promise<void>;
  finish: () => void;
};

const dollarsToMicrousd = (dollars: unknown): number | null =>
  typeof dollars === "number" && Number.isFinite(dollars) ? Math.round(dollars * 1_000_000) : null;

export class HeldSessionCoordinator {
  private readonly sessions = new Map<number, Controller>();

  count(): number {
    return this.sessions.size;
  }

  /**
   * The final proof, custody intent, brief recording, spawn, and timer
   * arming — one road, refusals typed. Returns once the session is HELD
   * (or refused); never awaits the hold itself.
   */
  async launch(args: HeldLaunchArgs): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
    const { store, captured, runId, leaseId, runner, clock } = args;
    const socketPath = join(args.socketDir, `so-${randomBytes(6).toString("hex")}.sock`);
    const pathProblem = heldSocketPathProblem(socketPath);
    if (pathProblem !== null) return { ok: false, reason: "attended-unsupported", message: pathProblem };
    const cookie = randomBytes(16).toString("hex");

    // ---- the FINAL transactional proof (v2 S2d, v3 R6): rederived against
    // live state AFTER worktree setup read the actual HEAD, consuming the
    // one attempt and writing the custody intent immediately before spawn.
    const proof = store.transact((): { ok: true } | { ok: false; reason: string; message: string } => {
      const live = store.readAuthorization(args.authorization.id);
      if (live === null || live.closedAt !== null) {
        return { ok: false, reason: "attended-only", message: "the authorization closed before dispatch" };
      }
      if (live.attemptRun !== null) {
        return { ok: false, reason: "attended-only", message: "the authorization's one attempt is already spent" };
      }
      let terms: SignedTerms;
      try {
        terms = JSON.parse(live.termsJson) as SignedTerms;
      } catch {
        return { ok: false, reason: "stale-authorization", message: "the signed terms cannot be parsed" };
      }
      const liveScopeDigest = captured.scope?.digest ?? "";
      if (terms.scopeDigest !== liveScopeDigest) {
        return { ok: false, reason: "stale-authorization", message: "the scope moved since the authorization was signed" };
      }
      const liveProfileDigest = profileDigestOf(captured.effective.profile);
      if (terms.profileDigest !== liveProfileDigest) {
        return { ok: false, reason: "stale-authorization", message: "the execution profile moved since the authorization was signed" };
      }
      if (terms.repo !== args.dispose.repo) {
        return { ok: false, reason: "stale-authorization", message: "the repository moved since the authorization was signed" };
      }
      if (terms.head !== captured.baseRevision) {
        return { ok: false, reason: "stale-authorization", message: `the head moved since the authorization was signed (${terms.head.slice(0, 12)} → ${captured.baseRevision.slice(0, 12)})` };
      }
      if (live.runner !== runner) {
        return { ok: false, reason: "attended-held", message: `the authorization names ${live.runner}` };
      }
      if (!store.consumeAuthorization(live.id, runId, clock())) {
        return { ok: false, reason: "attended-only", message: "another dispatch consumed the attempt first" };
      }
      const custody = store.openHeldSession({
        run: runId,
        authorizationId: live.id,
        runner,
        leaseId,
        upIncarnation: args.upIncarnation,
        cookie,
        socketPath,
        now: clock(),
      });
      if (!custody.ok) {
        return {
          ok: false,
          reason: custody.reason,
          message:
            custody.reason === "runner-holding"
              ? `${runner} is already holding a session — finish or revoke it first`
              : "this run already holds a session",
        };
      }
      return { ok: true };
    });
    if (!proof.ok) return proof;

    // ---- the brief is turn one, recorded before any byte is written.
    const recorded = store.recordSessionTurn({ run: runId, sourceKind: "brief", text: args.brief, now: clock() });
    if (!recorded.ok) {
      store.endHeldSession(runId, `refused:${recorded.reason}`, clock());
      return { ok: false, reason: recorded.reason, message: `the brief could not be recorded (${recorded.reason})` };
    }

    const remainingMicrousd =
      args.authorization.budgetMicrousd - store.authorizationSpendMicrousd(args.authorization.id);
    const argv = claudeHeldArgv({
      phase: "build",
      model: captured.effective.model,
      maxTurns: captured.effective.maxTurns ?? 40,
      permissionMode: "acceptEdits",
      skipPermissions: captured.effective.skipPermissions,
      resumeSession: null,
      maxBudgetUsd: Math.max(0.01, remainingMicrousd / 1_000_000),
    });

    const controller = this.makeController(args, recorded.turn, socketPath, cookie);

    const start = await invokeHeldAgent(
      store,
      runId,
      { provider: "claude", model: captured.effective.model },
      argv,
      {
        cwd: args.cwd,
        omitEnv: args.omitEnv,
        socketPath,
        cookie,
        ...(args.graceMs === undefined ? {} : { graceMs: args.graceMs }),
        ...(args.starter === undefined ? {} : { starter: args.starter }),
        events: {
          onTurnInit: seq => this.onTurnInit(args, seq),
          onTurnResult: (seq, event) => void this.onTurnResult(args, seq, event),
          onStreamEvent: event => args.liveLog?.observe(event),
          onExit: info => void this.onExit(args, info.code),
        },
        clock,
      },
    );

    if (!start.ok) {
      // Spawn failure with no pid ever stamped (v5's adopted F7 edge):
      // close custody and settle explicitly — no permanent orphan.
      store.settleTurnTerminal(recorded.turn.id, "cancelled", clock());
      store.endHeldSession(runId, "spawn-failed", clock());
      store.closeAuthorization(args.authorization.id, "spawn-failed", clock());
      store.finishRun(runId, { outcome: "failed", reason: "spawn-failed", now: clock() });
      release(store, leaseId, clock());
      await args.releaseWorktree(args.cwd);
      args.liveLog?.close();
      this.drop(runId);
      return { ok: false, reason: "spawn-failed", message: start.message };
    }

    controller.handle = start.handle;
    if (
      !store.stampHeldSession(runId, start.handle.supervisorPid ?? -1, start.handle.agentPgid ?? -1)
    ) {
      // The custody row closed underneath the spawn: kill synchronously,
      // never leave an unrecorded provider alive (v2 S1e).
      start.handle.killHard();
      this.drop(runId);
      return { ok: false, reason: "fenced", message: "custody closed underneath the spawn" };
    }

    // The turn reaches stdin only after custody is stamped.
    const turnJson = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: args.brief }] },
    });
    if (start.handle.writeTurn(turnJson)) {
      store.markTurnWritten(recorded.turn.id, clock());
      this.armTurnTimer(args, controller);
    } else {
      void this.fence(args, "write-failed");
    }
    return { ok: true };
  }

  /** Shutdown: fence every controller, bounded (v2 S0f). */
  async close(): Promise<void> {
    const all = [...this.sessions.keys()];
    await Promise.race([
      Promise.all(all.map(runId => this.fenceByRun(runId, "shutdown"))),
      new Promise(pass => setTimeout(pass, 30_000)),
    ]);
  }

  /** The beat endpoint and revocation poke this directly (v2 S1d). */
  poke(runId: number): void {
    // Lapse is re-checked on its own interval; the poke exists so a
    // revocation acts within a beat, not a pulse.
    const controller = this.sessions.get(runId);
    if (controller === undefined) return;
  }

  // ---- internals -----------------------------------------------------------

  private launches = new Map<number, HeldLaunchArgs>();

  private makeController(args: HeldLaunchArgs, brief: SessionTurn, socketPath: string, cookie: string): Controller {
    let finish: () => void = () => {};
    const done = new Promise<void>(pass => {
      finish = pass;
    });
    const controller: Controller = {
      runId: args.runId,
      fenceStarted: false,
      concluded: false,
      handle: null,
      timers: [],
      intervals: [],
      done,
      finish,
    };
    this.sessions.set(args.runId, controller);
    this.launches.set(args.runId, args);

    // Exact timers (v2 S1d): absolute expiry, liveness lapse, lease pulse.
    const now = args.clock().getTime();
    const untilExpiry = Math.max(0, Date.parse(args.authorization.absoluteExpiry) - now);
    const expiry = setTimeout(() => void this.fence(args, "expired"), untilExpiry);
    expiry.unref?.();
    controller.timers.push(expiry);

    const lapse = setInterval(() => {
      const live = args.store.readAuthorization(args.authorization.id);
      if (live === null || live.closedAt !== null) {
        void this.fence(args, live?.endReason === "revoked" ? "revoked" : "lapsed");
        return;
      }
      const state = attendedLivenessState(
        live.lastBeatAt === null ? null : Date.parse(live.lastBeatAt),
        args.clock().getTime(),
        Date.parse(live.absoluteExpiry),
      );
      if (state === "lapsed" || state === "expired") void this.fence(args, state);
    }, 5_000);
    lapse.unref?.();
    controller.intervals.push(lapse);

    const lease = setInterval(() => {
      try {
        const answer = heartbeat(args.store, args.leaseId, args.clock());
        if (!answer.ok) {
          void this.fence(args, "lease-lost");
          return;
        }
        if (args.runnerToken !== undefined) {
          const alive = runnerHeartbeat(args.store, args.runner, args.runnerToken, args.clock());
          if (!alive.ok) void this.fence(args, "lease-lost");
        }
      } catch {
        void this.fence(args, "lease-lost");
      }
    }, BEAT_MS);
    lease.unref?.();
    controller.intervals.push(lease);

    return controller;
  }

  private armTurnTimer(args: HeldLaunchArgs, controller: Controller): void {
    const timer = setTimeout(() => void this.fence(args, "turn-timeout"), args.captured.effective.timeoutMs);
    timer.unref?.();
    controller.timers.push(timer);
  }

  private onTurnInit(args: HeldLaunchArgs, seq: number): void {
    const turn = args.store.sessionTurnsOf(args.runId).find(one => one.seq === seq);
    if (turn !== undefined) args.store.markTurnAccepted(turn.id, args.clock());
  }

  private async onTurnResult(args: HeldLaunchArgs, seq: number, event: Record<string, unknown>): Promise<void> {
    const controller = this.sessions.get(args.runId);
    if (controller === undefined || controller.fenceStarted || controller.concluded) return;
    const turn = args.store.sessionTurnsOf(args.runId).find(one => one.seq === seq);
    if (turn === undefined) return;
    const usage = event["usage"] as { output_tokens?: unknown } | undefined;
    const settled = args.store.settleTurn(turn.id, {
      cumulativeMicrousd: dollarsToMicrousd(event["total_cost_usd"]),
      outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
      now: args.clock(),
    });
    if (!settled.ok && settled.reason === "telemetry") {
      await this.fence(args, "telemetry");
      return;
    }
    // Phase 2D: the first settled turn concludes the hold — the shared
    // settlement classifies whatever the agent left (handoff, park, or
    // nothing). The conversation loop lands with its console surfaces.
    await this.conclude(args, event);
  }

  private async onExit(args: HeldLaunchArgs, code: number | null): Promise<void> {
    const controller = this.sessions.get(args.runId);
    if (controller === undefined || controller.fenceStarted || controller.concluded) return;
    // The process died with no settled result: conservative settlement.
    await this.fence(args, code === null ? "exited" : `exited:${code}`);
  }

  private async conclude(args: HeldLaunchArgs, lastResult: Record<string, unknown>): Promise<void> {
    const controller = this.sessions.get(args.runId);
    if (controller === undefined || controller.concluded || controller.fenceStarted) return;
    controller.concluded = true;
    this.clearClocks(controller);

    // End the hold: EOF, let the supervisor fence its own child, bounded.
    controller.handle?.endInput();
    const exited = await Promise.race([
      controller.handle?.exited ?? Promise.resolve({ code: 0 }),
      new Promise<{ code: number | null }>(pass =>
        setTimeout(() => {
          controller.handle?.killHard();
          pass({ code: null });
        }, (args.graceMs ?? 10_000) + 20_000),
      ),
    ]);

    const isError = lastResult["is_error"] === true || String(lastResult["subtype"] ?? "") !== "success";
    const outcome: AgentOutcome = {
      code: isError ? 1 : (exited.code ?? 0),
      stderr: isError ? String(lastResult["result"] ?? lastResult["subtype"] ?? "error result") : "",
      timedOut: false,
      notFound: false,
      sessionId: args.store.getRun(args.runId)?.sessionId ?? null,
      finalMessage: typeof lastResult["result"] === "string" ? lastResult["result"] : null,
      usage: { tokensIn: null, tokensOut: null, costUsd: null },
      initFailed: false,
    };

    const result = await settleProviderOutcome(args.captured, outcome);
    const disposition = disposeBuildOutcome(
      {
        store: args.store,
        policy: "tick",
        leaseId: args.leaseId,
        runId: args.runId,
        taskId: args.captured.taskId,
        taskRef: args.captured.taskRef,
        runner: args.runner,
        repo: args.dispose.repo,
        branch: args.captured.branch,
        origin: args.dispose.origin,
        provider: args.dispose.provider,
        model: args.dispose.model,
        worktreePath: args.cwd,
        clock: args.clock,
      },
      result,
    );
    await args.releaseWorktree(args.cwd);
    args.store.endHeldSession(args.runId, "finished", args.clock());
    args.store.closeAuthorization(args.authorization.id, "finished", args.clock());
    args.liveLog?.close();
    args.onDisposed?.(disposition);
    this.drop(args.runId);
  }

  private fenceByRun(runId: number, reason: string): Promise<void> {
    const args = this.launches.get(runId);
    if (args === undefined) return Promise.resolve();
    return this.fence(args, reason);
  }

  /**
   * The interruption road (v2 S2e): stop admission, EOF → grace → kill via
   * the supervisor, conservative settlement, `interrupted`, worktree
   * preserved, authorization closed with the reason. Idempotent.
   */
  private async fence(args: HeldLaunchArgs, reason: string): Promise<void> {
    const controller = this.sessions.get(args.runId);
    if (controller === undefined || controller.fenceStarted || controller.concluded) return;
    controller.fenceStarted = true;
    this.clearClocks(controller);

    controller.handle?.terminate();
    await Promise.race([
      controller.handle?.exited ?? Promise.resolve({ code: null }),
      new Promise<{ code: number | null }>(pass =>
        setTimeout(() => {
          controller.handle?.killHard();
          pass({ code: null });
        }, (args.graceMs ?? 10_000) + 10_000),
      ),
    ]);

    const store = args.store;
    for (const turn of store.sessionTurnsOf(args.runId)) {
      if (turn.state === "recorded") store.settleTurnTerminal(turn.id, "cancelled", args.clock());
      else if (turn.state === "written" || turn.state === "accepted") {
        store.settleTurnTerminal(turn.id, "uncertain", args.clock());
      }
    }
    store.finishRun(args.runId, { outcome: "interrupted", reason, now: args.clock() });
    store.endHeldSession(args.runId, reason, args.clock());
    store.closeAuthorization(args.authorization.id, reason, args.clock());
    release(store, args.leaseId, args.clock());
    // The worktree is PRESERVED on interruption (released to the pool
    // unverified — same as every failure road; the work stays on disk).
    await args.releaseWorktree(args.cwd);
    args.liveLog?.close();
    args.onDisposed?.({ kind: "interrupted", reason });
    this.drop(args.runId);
  }

  private clearClocks(controller: Controller): void {
    for (const timer of controller.timers) clearTimeout(timer);
    for (const interval of controller.intervals) clearInterval(interval);
    controller.timers = [];
    controller.intervals = [];
  }

  private drop(runId: number): void {
    const controller = this.sessions.get(runId);
    controller?.finish();
    this.sessions.delete(runId);
    this.launches.delete(runId);
  }
}

/**
 * The DB-side orphan fence (v4 Q5 + v5 P3/P4 + v6 W6): sweep every open
 * custody row whose recorded lease is NO LONGER the task's current live
 * lease, seize it (CAS open→fencing + lease fence in one transaction),
 * order the kill through the supervisor's socket — the kernel-stable
 * road — and settle. A supervisor that cannot be reached keeps custody
 * and PAGES (never a guessed PID kill); a later sweep resumes from
 * wherever the CASes stand. Runs BEFORE generic recovery at every entry
 * point; recovery excludes fenced-open held rows.
 */
export async function sweepHeldOrphans(
  store: Store,
  fencer: string,
  now: () => Date,
): Promise<{ fenced: number; paged: number }> {
  let fenced = 0;
  let paged = 0;
  for (const session of store.openHeldSessions()) {
    const run = store.getRun(session.run);
    if (run === null) continue;
    const currentLease = store.currentLiveLease(run.taskRef, now());
    if (currentLease === session.leaseId) continue; // a live owner — leave it be

    let owned = session;
    if (session.state === "open") {
      const seized = store.seizeHeldSession(session.run, fencer, new Date(now().getTime() + 120_000), now());
      if (!seized.ok) continue; // another fencer took it between reads
      owned = seized.session;
    } else {
      // 'fencing' already: help only when the prior fencer's deadline is gone.
      if (!store.takeoverHeldFencing(session.run, fencer, new Date(now().getTime() + 120_000), now())) continue;
    }

    const killed = await orderKill(owned.socketPath, owned.cookie);
    if (!killed.settled) {
      // Page, keep custody, leave 'fencing' for a later helper (v5 P4).
      store.enqueueNotification(
        {
          dedupeKey: `held:${session.run}:unkillable`,
          kind: "attention",
          subject: `run ${session.run}: a held agent process could not be stopped`,
          body: `The supervisor at ${owned.socketPath} is unreachable. Stop the recorded processes by hand (supervisor pid ${owned.supervisorPid ?? "?"}, agent group ${owned.agentPgid ?? "?"}), then reconcile.`,
        },
        now(),
      );
      paged += 1;
      continue;
    }

    for (const turn of store.sessionTurnsOf(session.run)) {
      if (turn.state === "recorded") store.settleTurnTerminal(turn.id, "cancelled", now());
      else if (turn.state === "written" || turn.state === "accepted") {
        store.settleTurnTerminal(turn.id, "uncertain", now());
      }
    }
    if (run.outcome === null) {
      store.finishRun(session.run, { outcome: "interrupted", reason: "orphaned", now: now() });
    }
    store.closeHeldFencing(session.run, fencer, "orphaned", now());
    store.closeAuthorization(session.authorizationId, "orphaned", now());
    fenced += 1;
  }
  return { fenced, paged };
}

/** One cookie-authenticated kill order; unreachable = not settled. */
function orderKill(socketPath: string, cookie: string): Promise<{ settled: boolean }> {
  return new Promise(pass => {
    let answered = false;
    const settle = (settled: boolean) => {
      if (answered) return;
      answered = true;
      pass({ settled });
    };
    let wire: ReturnType<typeof connect>;
    try {
      wire = connect(socketPath, () => {
        wire.write(`${JSON.stringify({ cookie, verb: "kill" })}\n`);
      });
    } catch {
      settle(false);
      return;
    }
    let answer = "";
    wire.setTimeout(8_000, () => {
      wire.destroy();
      settle(false);
    });
    wire.on("data", chunk => {
      answer += String(chunk);
    });
    wire.on("end", () => {
      try {
        const parsed = JSON.parse(answer) as { ok?: unknown; settled?: unknown };
        settle(parsed.ok === true && parsed.settled === true);
      } catch {
        settle(false);
      }
    });
    wire.on("error", () => settle(false));
  });
}
