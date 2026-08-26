import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.js";
import { acquire, acquireIfReady } from "./claim.js";
import { canonicalProfileJson, profileDigestOf, type ExecutionProfile } from "./scope.js";
import { HeldSessionCoordinator, sweepHeldOrphans } from "./held.js";
import { run as runExec } from "./exec.js";
import type { CapturedBuild } from "./builder.js";
import type { HeldSessionStart, HeldSessionHandle } from "./exec.js";

const T0 = new Date("2026-08-25T22:00:00.000Z");
const later = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

const PROFILE: ExecutionProfile = {
  provider: "claude",
  model: "sonnet",
  permissionArgv: "acceptEdits",
  maxTurns: 40,
  repairMaxTurns: 4,
  timeoutSeconds: 1800,
  repairTimeoutSeconds: 300,
  repairModel: "inherit",
};

/** A task with a FILED (unapproved) scope and a live attended authorization. */
const attendedFixture = (
  store: ReturnType<typeof openStore>,
  options: { beat?: Date; head?: string; repo?: string; expiry?: Date } = {},
) => {
  store.createTask({ id: "t-att", title: "watched" }, T0);
  const ref = store.refFor("built-in", "t-att");
  const filed = store.proposeScope !== undefined ? null : null;
  void filed;
  store
    .raw()
    .prepare(
      `INSERT INTO task_scope (task_id, goal, out_of_scope, touches, proposed_at, digest)
       VALUES ('t-att', 'the goal', NULL, '[]', ?, 'feedface'||substr('00000000000000000000000000000000',1,24))`,
    )
    .run(T0.toISOString());
  const scopeDigest = String(store.raw().prepare("SELECT digest FROM task_scope WHERE task_id = 't-att'").get()!["digest"]);
  const terms = {
    scopeDigest,
    profileDigest: profileDigestOf(PROFILE),
    profileJson: canonicalProfileJson(PROFILE),
    repo: options.repo ?? "/repo",
    head: options.head ?? "h".repeat(40),
  };
  const minted = store.mintAttendedAuthorization({
    id: "auth-att",
    taskRef: ref.id,
    approver: "alex",
    runner: "mac-a",
    runnerGeneration: 1,
    compositeDigest: "d".repeat(32),
    termsJson: JSON.stringify(terms),
    maxSessionTurns: 10,
    budgetMicrousd: 2_000_000,
    absoluteExpiry: (options.expiry ?? later(3600)).toISOString(),
    now: T0,
  });
  expect(minted.ok).toBe(true);
  if (options.beat !== undefined) store.beatAuthorization("auth-att", options.beat);
  return { ref, terms };
};

describe("the attended claim gates (v6 W10/Q4/W1)", () => {
  test("a foreign runner refuses attended-held — its OWN reason, never the reserved contract", () => {
    const store = openStore(":memory:");
    const { ref } = attendedFixture(store, { beat: later(1) });
    const foreign = acquire(store, ref.id, "other-machine", { now: later(2) });
    expect(foreign).toMatchObject({ ok: false, reason: "attended-held", runner: "mac-a" });
    store.close();
  });

  test("attended-only: the named runner without a watching operator refuses; a live beat admits through the authority union", () => {
    const store = openStore(":memory:");
    const { ref } = attendedFixture(store); // no beat — nobody watching
    const dark = acquire(store, ref.id, "mac-a", { now: later(120) });
    expect(dark).toMatchObject({ ok: false, reason: "attended-only" });
    // the operator starts watching: the union admits the NAMED runner
    store.beatAuthorization("auth-att", later(130));
    const admitted = acquireIfReady(store, ref.id, "mac-a", { now: later(131) });
    expect(admitted.ok).toBe(true);
    store.close();
  });

  test("a spent attempt never re-admits — expiry does not convert attended work to unattended", () => {
    const store = openStore(":memory:");
    const { ref } = attendedFixture(store, { beat: later(1) });
    store
      .raw()
      .prepare(
        `INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
         VALUES ('lease-spent', ?, 1, 'mac-a', ?, ?, ?)`,
      )
      .run(ref.id, T0.toISOString(), later(900).toISOString(), T0.toISOString());
    const run = store.startRun({ taskRef: ref.id, leaseId: "lease-spent", runner: "mac-a", branch: "b", worktree: "/w", now: T0 });
    expect(store.consumeAuthorization("auth-att", run, later(2))).toBe(true);
    store.raw().prepare("UPDATE claim SET released_at = ? WHERE lease_id = 'lease-spent'").run(later(3).toISOString());
    const again = acquireIfReady(store, ref.id, "mac-a", { now: later(10) });
    expect(again).toMatchObject({ ok: false, reason: "not-ready" });
    store.close();
  });
});

describe("the coordinator: final proof, custody, settlement through the shared machinery", () => {
  /** A real git repo to be the worktree — the settlement runs real git. */
  const gitWorktree = async (): Promise<{ dir: string; head: string }> => {
    const dir = mkdtempSync(join(tmpdir(), "so-held-wt-"));
    const git = async (...args: string[]) => {
      const answer = await runExec("git", args, { cwd: dir, timeoutMs: 15_000 });
      if (answer.code !== 0) throw new Error(`git ${args[0]}: ${answer.stderr}`);
      return answer.stdout.trim();
    };
    await git("init", "-b", "so/t-att");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "test");
    writeFileSync(join(dir, "README.md"), "hello\n");
    await git("add", "-A");
    await git("commit", "-m", "base");
    const head = await git("rev-parse", "HEAD");
    return { dir, head };
  };

  /** A fake transport: acts like the supervisor+agent, driven by the test. */
  const fakeStarter = (script: {
    onWrite: (json: string, emit: (event: Record<string, unknown>) => void, done: () => void) => void;
  }) => {
    const state: { events?: { onTurnInit?: (seq: number) => void; onTurnResult?: (seq: number, event: Record<string, unknown>) => void; onExit?: (info: { code: number | null }) => void } } = {};
    let inits = 0;
    let results = 0;
    let exitResolve: (info: { code: number | null }) => void = () => {};
    const exited = new Promise<{ code: number | null }>(pass => (exitResolve = pass));
    const handle: HeldSessionHandle = {
      supervisorPid: 4242,
      agentPgid: 4243,
      writeTurn(json: string): boolean {
        script.onWrite(
          json,
          event => {
            const type = String(event["type"] ?? "");
            if (type === "system" && event["subtype"] === "init") state.events?.onTurnInit?.((inits += 1));
            if (type === "result") state.events?.onTurnResult?.((results += 1), event);
          },
          () => {
            exitResolve({ code: 0 });
            state.events?.onExit?.({ code: 0 });
          },
        );
        return true;
      },
      endInput(): void {
        exitResolve({ code: 0 });
      },
      terminate(): void {
        exitResolve({ code: 143 });
      },
      killHard(): void {
        exitResolve({ code: null });
      },
      exited,
    };
    const starter = ((_file: string, _args: readonly string[], options: { events?: typeof state.events }) => {
      state.events = options.events;
      return Promise.resolve({ ok: true, handle } as HeldSessionStart);
    }) as typeof import("./exec.js").startClaudeHeldSession;
    return starter;
  };

  const launchArgsFor = async (
    store: ReturnType<typeof openStore>,
    coordinator: HeldSessionCoordinator,
    worktree: { dir: string; head: string },
    starter: typeof import("./exec.js").startClaudeHeldSession,
    onDisposed: (d: unknown) => void,
  ) => {
    const { ref } = attendedFixture(store, {
      beat: new Date(),
      head: worktree.head,
      repo: "/repo",
      expiry: new Date(Date.now() + 3_600_000),
    });
    store
      .raw()
      .prepare(
        `INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
         VALUES ('lease-att', ?, 1, 'mac-a', ?, ?, ?)`,
      )
      .run(ref.id, T0.toISOString(), new Date(Date.now() + 900_000).toISOString(), T0.toISOString());
    const runId = store.startRun({
      taskRef: ref.id,
      leaseId: "lease-att",
      runner: "mac-a",
      branch: "so/t-att",
      worktree: worktree.dir,
      now: T0,
    });
    const scope = store.getScope("t-att");
    const captured: CapturedBuild = {
      store,
      request: { taskId: "t-att", taskRef: ref.id, runner: "mac-a", runId, worktree: worktree.dir, branch: "so/t-att", leaseId: "lease-att", now: T0 } as never,
      agent: undefined,
      git: runExec as never,
      worktree: worktree.dir,
      branch: "so/t-att",
      baseRevision: worktree.head,
      taskId: "t-att",
      taskRef: ref.id,
      runner: "mac-a",
      provider: "claude",
      scope,
      effective: { model: "sonnet", maxTurns: 40, timeoutMs: 60_000, skipPermissions: false, profile: PROFILE },
      answers: [],
      timeoutMs: 60_000,
      root: mkdtempSync(join(tmpdir(), "so-held-root-")),
      mailbox: "SO-MAILBOX-test.json",
      done: "SO-DONE-test.json",
      clock: () => new Date(),
      fenced: () => false,
    };
    const authorization = store.readAuthorization("auth-att")!;
    return {
      store,
      captured,
      authorization,
      runId,
      leaseId: "lease-att",
      runner: "mac-a",
      upIncarnation: "inc-test",
      brief: "the brief",
      cwd: worktree.dir,
      socketDir: tmpdir(),
      releaseWorktree: async () => {},
      liveLog: null,
      omitEnv: [],
      dispose: { repo: "/repo", origin: "theirs", provider: "claude", model: "sonnet" },
      clock: () => new Date(),
      starter,
      onDisposed,
    };
  };

  test("the happy path: proof consumes the attempt, the brief settles, the handoff builds the run through settle+dispose, custody closes", async () => {
    const store = openStore(":memory:");
    const coordinator = new HeldSessionCoordinator();
    const worktree = await gitWorktree();
    let disposed: unknown = null;
    const disposedAt = new Promise<void>(pass => {
      var seen = false;
      void seen;
      poll();
      function poll() {
        if (disposed !== null) return pass();
        setTimeout(poll, 25);
      }
    });

    const starter = fakeStarter({
      onWrite: (json, emit, done) => {
        // The "agent": accept the turn, do the work (a no-change handoff),
        // and answer with a settled result carrying cumulative usage.
        expect(json).toContain("the brief");
        writeFileSync(
          join(worktree.dir, "SO-DONE-test.json"),
          JSON.stringify({ version: 1, status: "no-change", conclusion: "nothing needed doing — the tree already agrees" }),
        );
        setTimeout(() => {
          emit({ type: "system", subtype: "init", session_id: "sess-att" });
          emit({ type: "result", subtype: "success", total_cost_usd: 0.03, usage: { output_tokens: 9 }, result: "did it" });
          setTimeout(done, 50);
        }, 20);
      },
    });

    const args = await launchArgsFor(store, coordinator, worktree, starter, d => (disposed = d));
    const launched = await coordinator.launch(args as never);
    expect(launched).toMatchObject({ ok: true });
    // the one attempt is consumed, custody open
    expect(store.readAuthorization("auth-att")?.attemptRun).toBe(args.runId);
    expect(store.heldSessionOf(args.runId)?.state).toBe("open");

    await disposedAt;
    // settled through the SHARED machinery: a no-change run, ledger charged
    const run = store.getRun(args.runId)!;
    expect(run.outcome).toBe("no-change");
    const turns = store.sessionTurnsOf(args.runId);
    expect(turns.length).toBe(1);
    expect(turns[0]?.state).toBe("settled");
    expect(turns[0]?.measuredMicrousd).toBe(30_000);
    expect(run.costUsd).toBeCloseTo(0.03, 6);
    // custody + authorization both closed
    expect(store.heldSessionOf(args.runId)?.endedAt).not.toBeNull();
    expect(store.readAuthorization("auth-att")?.closedAt).not.toBeNull();
    expect(store.readAuthorization("auth-att")?.endReason).toBe("finished");
    rmSync(worktree.dir, { recursive: true, force: true });
    store.close();
  }, 20_000);

  test("the final proof refuses a moved head, typed, consuming NOTHING", async () => {
    const store = openStore(":memory:");
    const coordinator = new HeldSessionCoordinator();
    const worktree = await gitWorktree();
    const starter = fakeStarter({ onWrite: () => {} });
    const args = await launchArgsFor(store, coordinator, worktree, starter, () => {});
    // the world moved: the worktree HEAD no longer matches the signed head
    (args.captured as { baseRevision: string }).baseRevision = "e".repeat(40);
    const launched = await coordinator.launch(args as never);
    expect(launched).toMatchObject({ ok: false, reason: "stale-authorization" });
    expect(store.readAuthorization("auth-att")?.attemptRun).toBeNull();
    expect(store.heldSessionOf(args.runId)).toBeNull();
    rmSync(worktree.dir, { recursive: true, force: true });
    store.close();
  });
});

describe("the orphan fence sweep (fence-first, page-not-guess)", () => {
  test("a dead owner's session is seized and settled; an unreachable supervisor pages and keeps custody", async () => {
    const store = openStore(":memory:");
    store.createTask({ id: "t-orph", title: "orphaned" }, T0);
    const ref = store.refFor("built-in", "t-orph");
    // an EXPIRED lease = a dead owner (currentLiveLease returns null)
    store
      .raw()
      .prepare(
        `INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
         VALUES ('lease-dead', ?, 1, 'mac-a', ?, ?, ?)`,
      )
      .run(ref.id, T0.toISOString(), later(60).toISOString(), T0.toISOString());
    const runId = store.startRun({ taskRef: ref.id, leaseId: "lease-dead", runner: "mac-a", branch: "b", worktree: "/w", now: T0 });
    store
      .raw()
      .prepare(
        `INSERT INTO attended_authorization
           (id, task_ref, approver, runner, runner_generation, composite_digest, terms_json,
            max_session_turns, budget_microusd, created_at, absolute_expiry, attempt_run, consumed_at)
         VALUES ('auth-orph', ?, 'alex', 'mac-a', 1, 'x', '{}', 10, 1000000, ?, ?, ?, ?)`,
      )
      .run(ref.id, T0.toISOString(), later(3600).toISOString(), runId, T0.toISOString());
    store.raw().prepare("UPDATE run SET attended_authorization = 'auth-orph' WHERE id = ?").run(runId);
    const custody = store.openHeldSession({
      run: runId,
      authorizationId: "auth-orph",
      runner: "mac-a",
      leaseId: "lease-dead",
      upIncarnation: "inc-dead",
      cookie: "c".repeat(32),
      socketPath: join(tmpdir(), "so-no-such-supervisor.sock"),
      now: T0,
    });
    expect(custody.ok).toBe(true);
    const turn = store.recordSessionTurn({ run: runId, sourceKind: "brief", text: "b", now: later(1) });
    expect(turn.ok).toBe(true);
    if (turn.ok) store.markTurnWritten(turn.turn.id, later(2));

    // Sweep at a time PAST the lease: the socket is unreachable → PAGE,
    // custody kept, state fencing.
    const swept = await sweepHeldOrphans(store, "fencer-test", () => new Date(T0.getTime() + 120_000));
    expect(swept).toMatchObject({ fenced: 0, paged: 1 });
    expect(store.heldSessionOf(runId)?.state).toBe("fencing");
    expect(store.heldSessionOf(runId)?.endedAt).toBeNull();
    // the run is NOT reclassified — the fence owns it, recovery must skip it
    expect(store.getRun(runId)?.outcome).toBeNull();
    expect(store.recoverRunnerWork("mac-a", new Date(T0.getTime() + 130_000))).toBe(0);
    store.close();
  }, 15_000);
});

describe("the round-6 cross-check fixes", () => {
  test("an EXPIRED authorization gates nothing: other runners claim an approved task again", () => {
    const store = openStore(":memory:");
    const { ref } = attendedFixture(store, { beat: later(1), expiry: later(60) });
    // approve the scope so the task has real authority of its own
    store
      .raw()
      .prepare("UPDATE task_scope SET approved_at = ?, approved_by = 'alex', approved_digest = digest WHERE task_id = 't-att'")
      .run(later(2).toISOString());
    // while live, the foreign runner is refused
    expect(acquire(store, ref.id, "other-machine", { now: later(10) })).toMatchObject({ ok: false, reason: "attended-held" });
    // past expiry the corpse gates nothing — and the sweep closes it durably
    const late = acquire(store, ref.id, "other-machine", { now: later(120) });
    expect(late.ok).toBe(true);
    expect(store.sweepExpiredAuthorizations(later(121))).toBe(1);
    expect(store.readAuthorization("auth-att")?.endReason).toBe("expired");
    store.close();
  });

  test("attended admission skips the capacity gate: a full unattended ledger does not refuse the watching operator", async () => {
    const store = openStore(":memory:");
    const { ref } = attendedFixture(store, { beat: later(1) });
    const { register } = await import("./runner.js");
    register(store, { name: "mac-a", host: "h", now: later(0) });
    // an unrelated unattended claim occupies the ONLY slot (capacity 1)
    store.createTask({ id: "t-busy", title: "busy" }, T0);
    const busy = store.refFor("built-in", "t-busy");
    store
      .raw()
      .prepare(
        `INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
         VALUES ('lease-busy', ?, 1, 'mac-a', ?, ?, ?)`,
      )
      .run(busy.id, T0.toISOString(), later(900).toISOString(), T0.toISOString());
    const admitted = acquireIfReady(store, ref.id, "mac-a", { now: later(5) });
    expect(admitted.ok).toBe(true);
    store.close();
  });

  test("answers riding the brief attach only at ITS acceptance, and revert when the brief never got there", () => {
    const store = openStore(":memory:");
    store.createTask({ id: "t-brf", title: "brief answers" }, T0);
    const ref = store.refFor("built-in", "t-brf");
    store
      .raw()
      .prepare(
        `INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at)
         VALUES ('lease-brf', ?, 1, 'mac-a', ?, ?, ?)`,
      )
      .run(ref.id, T0.toISOString(), later(900).toISOString(), T0.toISOString());
    store
      .raw()
      .prepare(
        `INSERT INTO attended_authorization
           (id, task_ref, approver, runner, runner_generation, composite_digest, terms_json,
            max_session_turns, budget_microusd, created_at, absolute_expiry)
         VALUES ('auth-brf', ?, 'alex', 'mac-a', 1, 'x', '{}', 10, 1000000, ?, ?)`,
      )
      .run(ref.id, T0.toISOString(), later(3600).toISOString());
    const runId = store.startRun({ taskRef: ref.id, leaseId: "lease-brf", runner: "mac-a", branch: "b", worktree: "/w", now: T0 });
    store.consumeAuthorization("auth-brf", runId, later(1));
    expect(
      store.openHeldSession({
        run: runId,
        authorizationId: "auth-brf",
        runner: "mac-a",
        leaseId: "lease-brf",
        upIncarnation: "i",
        cookie: "c".repeat(32),
        socketPath: "/tmp/so-brf.sock",
        now: later(1),
      }).ok,
    ).toBe(true);
    // an answered decision, pre-attached by the builder's ordinary road
    store
      .raw()
      .prepare(
        `INSERT INTO decision (run, urgency, state, recap, question, options, recommendation, created_at, answered_at, answered_by, choice)
         VALUES (?, 'blocking', 'answered', 'r', 'q', '[]', 'rec', ?, ?, 'alex', 'go')`,
      )
      .run(runId, later(2).toISOString(), later(3).toISOString());
    const decision = Number(store.raw().prepare("SELECT id FROM decision WHERE run = ?").get(runId)!["id"]);
    store.raw().prepare("INSERT INTO run_decision (run, decision, choice, note) VALUES (?, ?, 'go', NULL)").run(runId, decision);

    const brief = store.recordSessionTurn({ run: runId, sourceKind: "brief", text: "the brief with answers", now: later(4) });
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    store.bindBriefDeliveries(runId, brief.turn.id, [decision]);
    // withdrawn until proof
    expect(store.raw().prepare("SELECT COUNT(*) AS n FROM run_decision WHERE run = ?").get(runId)!["n"]).toBe(0);
    // the brief dies unaccepted: the delivery claim reverts entirely
    store.markTurnWritten(brief.turn.id, later(5));
    store.settleTurnTerminal(brief.turn.id, "uncertain", later(6));
    expect(store.raw().prepare("SELECT delivered_turn FROM decision WHERE id = ?").get(decision)!["delivered_turn"]).toBeNull();
    expect(store.raw().prepare("SELECT COUNT(*) AS n FROM run_decision WHERE run = ?").get(runId)!["n"]).toBe(0);
    store.close();
  });
});
