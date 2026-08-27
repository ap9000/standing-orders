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
import { existsSync } from "node:fs";
import { finalizeParkHeld, heartbeat, release } from "./claim.js";
import { parseDecision, repairPrompt } from "./decision.js";
import { captureParkEvidence, readMailbox, storeEvidence } from "./evidence.js";
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
  /** Fields the disposition service needs that the capture does not carry.
   * `policy` distinguishes the continuation road (taskless dispositions,
   * v4 Q7); absent = the ordinary tick policy. */
  dispose: Pick<DisposeContext, "repo" | "origin" | "provider" | "model"> & { policy?: DisposeContext["policy"] };
  clock: () => Date;
  /** Test seams. */
  starter?: typeof startClaudeHeldSession;
  graceMs?: number;
  onDisposed?: (disposition: Disposition | { kind: "interrupted"; reason: string }) => void;
  /** v28: enforced INSIDE the final custody transaction — two watch
   * loops racing a cap of one cannot both insert. */
  maxHeldSessions?: number;
};

type Controller = {
  runId: number;
  fenceStarted: boolean;
  concluded: boolean;
  handle: HeldSessionHandle | null;
  timers: ReturnType<typeof setTimeout>[];
  intervals: ReturnType<typeof setInterval>[];
  /** The per-turn wall deadline — armed at every write, cleared at settle. */
  turnTimer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
  finish: () => void;
};

const dollarsToMicrousd = (dollars: unknown): number | null =>
  typeof dollars === "number" && Number.isFinite(dollars) ? Math.round(dollars * 1_000_000) : null;

/** Thrown INSIDE the final proof to roll the whole transaction back. */
class ConsumeRaced extends Error {}

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
    let proof: { ok: true } | { ok: false; reason: string; message: string };
    try {
      proof = store.transact((): { ok: true } | { ok: false; reason: string; message: string } => {
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
      // Custody FIRST, consumption LAST (parallel-sessions round 1,
      // finding 4): a refusal returned from inside transact() COMMITS —
      // only a throw rolls back — so the old consume-then-custody order
      // left a run-held refusal with the one attempt already spent.
      // Every refusal below this line must leave attempt_run null.
      if (args.maxHeldSessions !== undefined && store.openHeldSessionCount(runner) >= args.maxHeldSessions) {
        return {
          ok: false,
          reason: "session-cap",
          message: `this machine holds ${store.openHeldSessionCount(runner)} of ${args.maxHeldSessions} attended sessions — end one, or raise --max-held-sessions`,
        };
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
        return { ok: false, reason: custody.reason, message: "this run already holds a session" };
      }
      if (!store.consumeAuthorization(live.id, runId, clock())) {
        // Roll the custody insert back with the transaction — a raced
        // consume must leave NOTHING, not an orphan custody row.
        throw new ConsumeRaced();
      }
      return { ok: true };
      });
    } catch (error) {
      if (error instanceof ConsumeRaced) {
        proof = { ok: false, reason: "attended-only", message: "another dispatch consumed the attempt first" };
      } else {
        throw error;
      }
    }
    if (!proof.ok) return proof;

    // ---- the brief is turn one, recorded before any byte is written.
    const recorded = store.recordSessionTurn({ run: runId, sourceKind: "brief", text: args.brief, now: clock() });
    if (!recorded.ok) {
      store.endHeldSession(runId, `refused:${recorded.reason}`, clock());
      return { ok: false, reason: recorded.reason, message: `the brief could not be recorded (${recorded.reason})` };
    }
    // Answers riding the brief (round-6 finding 2): the builder's ordinary
    // pre-spawn attach claimed delivery the agent has not proven — withdraw
    // it, CAS each decision's delivery to the brief turn, and let
    // acceptance re-attach exactly like an answer turn.
    store.bindBriefDeliveries(
      runId,
      recorded.turn.id,
      captured.answers.map(one => one.decision.id),
    );

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

  /** Shutdown: fence every controller under ONE absolute deadline (v2 S0f
   * + parallel-sessions round 1, finding 7): the deadline timer is cleared
   * when the fences win so it cannot hold the process open, and the runs
   * that did NOT settle in time are RETURNED for the caller to page —
   * silence here contradicted up's "settled or paged" promise. */
  async close(): Promise<number[]> {
    const all = [...this.sessions.keys()];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"deadline">(pass => {
      deadline = setTimeout(() => pass("deadline"), 30_000);
      deadline.unref?.();
    });
    const winner = await Promise.race([
      Promise.all(all.map(runId => this.fenceByRun(runId, "shutdown"))).then(() => "fenced" as const),
      timedOut,
    ]);
    if (deadline !== undefined) clearTimeout(deadline);
    return winner === "fenced" ? [] : [...this.sessions.keys()];
  }

  /** The beat endpoint, answers, and revocation poke this directly (v2 S1d). */
  poke(runId: number): void {
    const controller = this.sessions.get(runId);
    if (controller === undefined) return;
    const args = this.launches.get(runId);
    if (args !== undefined) void this.injectPendingAnswers(args);
  }

  /**
   * The operator's own turn (v2 S1g, ruling 12-as-accepted): session-grade
   * speech, recorded through the SAME gated transaction every injection
   * takes — cap, single-flight, budget, open-decision, lease — so every
   * refusal is typed and atomic.
   */
  injectOperatorTurn(
    runId: number,
    author: string,
    text: string,
  ): { ok: true } | { ok: false; reason: string } {
    const args = this.launches.get(runId);
    const controller = this.sessions.get(runId);
    if (args === undefined || controller === undefined || controller.fenceStarted || controller.concluded) {
      return { ok: false, reason: "no-held-session" };
    }
    return this.injectTurn(args, controller, { sourceKind: "operator", sourceId: null, author, text });
  }

  private injectTurn(
    args: HeldLaunchArgs,
    controller: Controller,
    turn: { sourceKind: "answer" | "operator" | "repair"; sourceId: number | null; author: string | null; text: string },
  ): { ok: true } | { ok: false; reason: string } {
    const recorded = args.store.recordSessionTurn({
      run: args.runId,
      sourceKind: turn.sourceKind,
      sourceId: turn.sourceId,
      author: turn.author,
      text: turn.text,
      repairLimit: 2,
      now: args.clock(),
    });
    if (!recorded.ok) return { ok: false, reason: recorded.reason };
    const json = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: turn.text }] },
    });
    if (controller.handle === null || !controller.handle.writeTurn(json)) {
      args.store.settleTurnTerminal(recorded.turn.id, "cancelled", args.clock());
      return { ok: false, reason: "write-failed" };
    }
    args.store.markTurnWritten(recorded.turn.id, args.clock());
    this.armTurnTimer(args, controller);
    return { ok: true };
  }

  private async injectPendingAnswers(args: HeldLaunchArgs): Promise<void> {
    const controller = this.sessions.get(args.runId);
    if (controller === undefined || controller.fenceStarted || controller.concluded) return;
    for (const decision of args.store.undeliveredDecisionsOf(args.runId)) {
      const text = [
        `The operator answered your question (decision ${decision.id}):`,
        `chose "${decision.choice ?? decision.recommendation}"${decision.note === null || decision.note === "" ? "" : ` — ${decision.note}`}.`,
        "Continue the work within the approved scope. When you finish, write your handoff exactly as the brief instructed.",
      ].join(" ");
      const injected = this.injectTurn(args, controller, {
        sourceKind: "answer",
        sourceId: decision.id,
        author: null,
        text,
      });
      // One at a time: single-flight means a second undelivered answer
      // waits for the next scan after this turn settles.
      if (injected.ok) break;
    }
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
      turnTimer: null,
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
          if (!alive.ok) {
            void this.fence(args, "lease-lost");
            return;
          }
        }
        // Answers persisted by ANY surface reach the live session here
        // (v3 R3): the delivery-CAS inside recordSessionTurn makes the
        // injection exactly-once whatever raced.
        void this.injectPendingAnswers(args);
      } catch {
        void this.fence(args, "lease-lost");
      }
    }, BEAT_MS);
    lease.unref?.();
    controller.intervals.push(lease);

    return controller;
  }

  private armTurnTimer(args: HeldLaunchArgs, controller: Controller): void {
    if (controller.turnTimer !== null) clearTimeout(controller.turnTimer);
    const timer = setTimeout(() => void this.fence(args, "turn-timeout"), args.captured.effective.timeoutMs);
    timer.unref?.();
    controller.turnTimer = timer;
  }

  private onTurnInit(args: HeldLaunchArgs, seq: number): void {
    const turn = args.store.sessionTurnsOf(args.runId).find(one => one.seq === seq);
    if (turn !== undefined) args.store.markTurnAccepted(turn.id, args.clock());
    // The brief's acceptance is the held road's receipt (round-6 finding
    // 6): attached steering settles delivered on the same proof the
    // one-shot transport's onReceipt carried.
    if (seq === 1) void args.store.settleSteerDelivered(args.runId, args.clock());
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
    if (controller.turnTimer !== null) {
      clearTimeout(controller.turnTimer);
      controller.turnTimer = null;
    }
    // CLASSIFY (v2 S1f, v6 W4): a terminal handoff concludes through the
    // shared settlement; a park records the decision and the session STAYS
    // HELD for the answer; a budget-exhausted result ends the hold; and a
    // settled turn that left neither file is a conversation pause — the
    // session waits for the operator.
    const donePath = join(args.cwd, args.captured.done);
    const mailboxPath = join(args.cwd, args.captured.mailbox);
    if (String(event["subtype"] ?? "") === "error_max_budget_usd") {
      await this.fence(args, "budget-exhausted");
      return;
    }
    if (existsSync(donePath)) {
      await this.conclude(args, event);
      return;
    }
    if (existsSync(mailboxPath)) {
      await this.heldPark(args, turn.id, event);
      return;
    }
    // Idle: held, watching, awaiting the next turn.
  }

  /**
   * A park inside a held session (v2 S1f + round-6 finding 3): payload
   * preserved as evidence and unlinked exactly like the ordinary road,
   * the decision recorded WITHOUT ending anything, causally linked to the
   * turn that produced it. A malformed payload takes the held repair road
   * — a machine-authored ledger turn in the SAME session, correlated to
   * the producing turn (a malformed mailbox has no decision id), bounded;
   * exhaustion disposes through the shared malformed machinery.
   */
  private async heldPark(args: HeldLaunchArgs, producingTurn: number, lastResult: Record<string, unknown>): Promise<void> {
    const controller = this.sessions.get(args.runId);
    if (controller === undefined || controller.fenceStarted || controller.concluded) return;
    const store = args.store;
    const path = join(args.cwd, args.captured.mailbox);
    const read = readMailbox(path);
    if (!read.ok) {
      if (!read.missing) {
        try {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(path);
        } catch {
          // Unremovable is survivable; the commit path excludes the name.
        }
      }
      return;
    }
    storeEvidence(store, args.captured.root, args.runId, "park-payload", "park.json", read.raw, `mailbox ${args.captured.mailbox}`, args.clock());
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(path);
    } catch {
      // The bytes are already in evidence.
    }
    const parsed = parseDecision(read.raw.toString("utf8"));
    if (parsed.ok) {
      const evidence = await captureParkEvidence(store, args.captured.git, args.cwd, args.captured.baseRevision, args.captured.root, args.runId, args.clock());
      const payload = store.artifactsFor(args.runId).find(artifact => artifact.kind === "park-payload");
      const sealed = finalizeParkHeld(store, {
        runId: args.runId,
        taskId: args.captured.taskId,
        decision: parsed.decision,
        artifactIds: [...(payload === undefined ? [] : [payload.id]), ...evidence],
        sessionTurn: producingTurn,
        now: args.clock(),
      });
      if (!sealed.ok) await this.fence(args, sealed.reason);
      return; // held: the answer arrives as the next turn
    }
    // Malformed: the held repair road (round-6 finding 3).
    const repair = this.injectTurn(args, controller, {
      sourceKind: "repair",
      sourceId: producingTurn,
      author: null,
      text: repairPrompt(parsed.problems, args.captured.mailbox),
    });
    if (!repair.ok && repair.reason === "repair-exhausted") {
      controller.concluded = true;
      this.clearClocks(controller);
      args.store.endHeldSession(args.runId, "malformed-decision", args.clock());
      controller.handle?.endInput();
      await Promise.race([
        controller.handle?.exited ?? Promise.resolve({ code: null }),
        new Promise<{ code: number | null }>(pass =>
          setTimeout(() => {
            controller.handle?.killHard();
            pass({ code: null });
          }, (args.graceMs ?? 10_000) + 10_000),
        ),
      ]);
      const disposition = disposeBuildOutcome(
        {
          store: args.store,
          policy: args.dispose.policy ?? "tick",
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
        { ok: false, reason: "malformed-decision", message: "the agent parked, but the payload is not a decision — twice over", problems: parsed.problems },
      );
      await args.releaseWorktree(args.cwd);
      args.store.closeAuthorization(args.authorization.id, "malformed-decision", args.clock());
      args.liveLog?.close();
      args.onDisposed?.(disposition);
      this.drop(args.runId);
    }
    void lastResult;
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

    // The admission door closes BEFORE anything awaits (round-6 finding
    // 1): with ended_at stamped, a late external turn recording refuses
    // inside ITS transaction, and a late result cannot re-open settlement
    // (its turn is already settled or terminal).
    args.store.endHeldSession(args.runId, "finished", args.clock());

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
        policy: args.dispose.policy ?? "tick",
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

    // TERMINAL SEIZURE before any waiting (round-6 finding 1): the CAS to
    // 'fencing' + the lease fence make every late admission and every
    // stale write refuse in ITS OWN transaction during the grace window —
    // in-memory flags guard only this process. Losing the CAS means an
    // external fencer owns settlement: kill our handle and step aside.
    const fencer = `coordinator:${process.pid}`;
    const seized = args.store.seizeHeldSession(args.runId, fencer, new Date(args.clock().getTime() + 120_000), args.clock());
    if (!seized.ok) {
      controller.handle?.terminate();
      args.liveLog?.close();
      this.drop(args.runId);
      return;
    }

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
    store.closeHeldFencing(args.runId, fencer, reason, args.clock());
    store.closeAuthorization(args.authorization.id, reason, args.clock());
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
  // TWO PHASES (parallel-sessions round 1, finding 6): seize everything
  // first — fast, transactional, per-run CAS — then run the kill orders
  // CONCURRENTLY. The old serial loop paid up to eight seconds per
  // unreachable socket BEFORE up could register its runner; thirty
  // orphans meant four minutes of startup. Now the wall clock is one
  // socket timeout, not their sum.
  const owned: { session: ReturnType<Store["openHeldSessions"]>[number]; run: NonNullable<ReturnType<Store["getRun"]>> }[] = [];
  for (const session of store.openHeldSessions()) {
    const run = store.getRun(session.run);
    if (run === null) continue;
    const currentLease = store.currentLiveLease(run.taskRef, now());
    if (currentLease === session.leaseId) continue; // a live owner — leave it be

    if (session.state === "open") {
      const seized = store.seizeHeldSession(session.run, fencer, new Date(now().getTime() + 120_000), now());
      if (!seized.ok) continue; // another fencer took it between reads
      owned.push({ session: seized.session, run });
    } else {
      // 'fencing' already: help only when the prior fencer's deadline is gone.
      if (!store.takeoverHeldFencing(session.run, fencer, new Date(now().getTime() + 120_000), now())) continue;
      owned.push({ session, run });
    }
  }

  let fenced = 0;
  let paged = 0;
  await Promise.all(
    owned.map(async ({ session, run }) => {
      const killed = await orderKill(session.socketPath, session.cookie);
      if (!killed.settled) {
        // Page, keep custody, leave 'fencing' for a later helper (v5 P4).
        store.enqueueNotification(
          {
            dedupeKey: `held:${session.run}:unkillable`,
            kind: "attention",
            subject: `run ${session.run}: a held agent process could not be stopped`,
            body: `The supervisor at ${session.socketPath} is unreachable. Stop the recorded processes by hand (supervisor pid ${session.supervisorPid ?? "?"}, agent group ${session.agentPgid ?? "?"}), then reconcile.`,
          },
          now(),
        );
        paged += 1;
        return;
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
    }),
  );
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
