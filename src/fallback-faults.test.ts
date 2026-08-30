/**
 * Layer G: the fault-injection matrix. Each test manufactures one of the
 * crash or race windows the fallback runtime claims to survive — a daemon
 * dying between disposition and resolution, a stale observer racing a
 * resolved cycle, authority revoked or corrupted mid-flight, replayed
 * admissions, a task the strikes already ended — and proves the machine
 * re-derives the same safe answer from durable state alone. The recognizer
 * mock stands where a fixtured build would; production ships none.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { propose, approve, addApprover } from "./scope.js";
import { acquireFallback, release } from "./claim.js";
import { runOperate, EXIT } from "./operate.js";
import { modeTermsFromJson, presetTerms, modeTermsJson, modeDigestOf, type ModeTerms } from "./modes.js";

const rec = vi.hoisted(() => ({ eligible: new Set<string>() }));
vi.mock("./exhaustion.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./exhaustion.js")>();
  return {
    ...actual,
    recognizesEligible: (provider: string, version: string | null, authMode: string) =>
      version !== null && rec.eligible.has(`${provider}:${version}:${authMode}`),
  };
});

const T0 = new Date("2026-08-29T12:00:00.000Z");
const REPO = "/repos/chain";
const VERSION = "1.0.0";
const EXPIRY = new Date(T0.getTime() + 24 * 60 * 60_000).toISOString();

describe("the fault matrix (G)", () => {
  let store: Store;
  let alexToken: string;

  const grant = () => {
    const terms: ModeTerms = { ...presetTerms("standard", EXPIRY), allowPaidFallback: true };
    store.signMode(
      { repo: REPO, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
  };

  /** A chain-approved task, its base cycle open, its base run bound. */
  const setup = (id: string) => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    store.createTask({ id, title: "w" }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: id, goal: "a guard", now: T0 });
    expect(approve(store, id, "alex", T0, store.getScope(id)!.digest, alexToken).ok).toBe(true);
    const run = store.startRun({ taskRef: ref, leaseId: "l", runner: "b-1", branch: "b", worktree: "/w", provider: "claude", now: T0 });
    store.openChainCycleForDispatch(ref, id, run, T0);
    return { ref, run };
  };

  const concludeExhausted = (run: number) => {
    store.stampProviderStart(run, T0, VERSION);
    store.stampTerminalClass(run, "subscription", "usage-exhausted");
    store.finishRun(run, { outcome: "failed", reason: "exhausted", now: T0 });
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    alexToken = added.token;
    rec.eligible.add(`claude:${VERSION}:subscription`);
  });
  afterEach(() => {
    rec.eligible.clear();
    store.close();
  });

  test("CRASH between disposition and resolution: the reconciler re-derives the SAME advance from durable state", () => {
    grant();
    const { ref, run } = setup("t-crash-adv");
    // The daemon died right after finishRun — the resolver never ran.
    concludeExhausted(run);
    expect(store.fallbackCycleFor(ref)!.state).toBe("open"); // stranded
    // Next pass: the SHARED reconciler — the exact call the tick makes —
    // re-derives the same advance from durable state alone.
    expect(store.reconcileStrandedChains(REPO, T0)).toBe(1);
    expect(store.fallbackCycleFor(ref)!.state).toBe("pending-admission");
    expect(store.fallbackCycleFor(ref)!.cursor).toBe(1);
  });

  test("CRASH after a success's disposition: the reconciler closes 'succeeded' — no cycle lingers", () => {
    const { ref, run } = setup("t-crash-win");
    store.stampProviderStart(run, T0, VERSION);
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    expect(store.reconcileStrandedChains(REPO, T0)).toBe(1);
    expect(store.fallbackCycleFor(ref)).toBeNull();
    expect(store.raw().prepare("SELECT closed_reason FROM fallback_cycle").get()).toMatchObject({ closed_reason: "succeeded" });
  });

  test("a RACING second resolver loses cleanly: one advance, one transition, no double state", () => {
    grant();
    const { ref, run } = setup("t-race");
    concludeExhausted(run);
    expect(store.resolveChainOnRunEnd(ref, "t-race", REPO, run, T0)).toEqual({ kind: "advanced", toIndex: 1 });
    // The stale observer (a second tick that read before the first resolved).
    expect(store.resolveChainOnRunEnd(ref, "t-race", REPO, run, T0)).toEqual({ kind: "no-cycle" });
    const transitions = store.raw().prepare("SELECT COUNT(*) AS n FROM fallback_transition").get() as { n: number };
    expect(Number(transitions.n)).toBe(1);
    expect(store.fallbackCycleFor(ref)!.cursor).toBe(1);
  });

  test("the grant REVOKED between advance and admission: the money moment refuses and the cycle ends clean", () => {
    grant();
    const { ref, run } = setup("t-revoke");
    concludeExhausted(run);
    expect(store.resolveChainOnRunEnd(ref, "t-revoke", REPO, run, T0).kind).toBe("advanced");
    store.revokeMode(REPO, "alex", "changed my mind", T0);
    const cycle = store.fallbackCycleFor(ref)!;
    const admitted = store.admitNextChainEntry(cycle.id, { leaseId: "l2", runner: "b-1", branch: "b", worktree: "/w2" }, T0);
    expect(admitted).toEqual({ ok: false, reason: "grant-withheld" });
    expect(store.fallbackCycleFor(ref)).toBeNull(); // closed, not incident
    // NOTHING was created: no second run exists.
    const runs = store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE task_ref = ?").get(ref) as { n: number };
    expect(Number(runs.n)).toBe(1);
  });

  test("the approved chain CORRUPTED after advance: admission severs to incident, creates nothing", () => {
    grant();
    const { ref, run } = setup("t-corrupt");
    concludeExhausted(run);
    expect(store.resolveChainOnRunEnd(ref, "t-corrupt", REPO, run, T0).kind).toBe("advanced");
    store.raw().prepare("UPDATE task_scope SET approved_chain_json = 'not json' WHERE task_id = 't-corrupt'").run();
    const cycle = store.fallbackCycleFor(ref)!;
    const admitted = store.admitNextChainEntry(cycle.id, { leaseId: "l2", runner: "b-1", branch: "b", worktree: "/w2" }, T0);
    expect(admitted).toEqual({ ok: false, reason: "stale-approval" });
    expect(store.fallbackCycleFor(ref)).toBeNull(); // incident is not live
    const runs = store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE task_ref = ?").get(ref) as { n: number };
    expect(Number(runs.n)).toBe(1);
  });

  test("a REPLAYED admission after the first succeeded: the edge is consumed, nothing else is created", () => {
    grant();
    const { ref, run } = setup("t-replay");
    concludeExhausted(run);
    expect(store.resolveChainOnRunEnd(ref, "t-replay", REPO, run, T0).kind).toBe("advanced");
    const cycle = store.fallbackCycleFor(ref)!;
    const first = store.admitNextChainEntry(cycle.id, { leaseId: "l2", runner: "b-1", branch: "b", worktree: "/w2" }, T0);
    expect(first.ok).toBe(true);
    const replay = store.admitNextChainEntry(cycle.id, { leaseId: "l3", runner: "b-1", branch: "b", worktree: "/w3" }, T0);
    expect(replay).toEqual({ ok: false, reason: "not-pending" });
    const runs = store.raw().prepare("SELECT COUNT(*) AS n FROM run WHERE task_ref = ?").get(ref) as { n: number };
    expect(Number(runs.n)).toBe(2); // base + exactly one fallback
  });

  test("a task the strikes already ENDED never dispatches a fallback: the claim refuses on state", () => {
    grant();
    const { ref, run } = setup("t-struck");
    concludeExhausted(run);
    expect(store.resolveChainOnRunEnd(ref, "t-struck", REPO, run, T0).kind).toBe("advanced");
    // The third strike marked the task failed (terminal) before admission.
    store.raw().prepare("UPDATE task SET state = 'failed' WHERE id = 't-struck'").run();
    const claim = acquireFallback(store, ref, "b-1", {
      now: T0,
      provider: "gemini",
      model: "gemini-2.5-pro",
      authMode: "api-key",
    });
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.reason).toBe("not-ready");
  });

  test("quota is keyed to the PINNED credential: the other auth mode never blocks, the pinned one refuses, nothing is created", () => {
    grant();
    const { ref, run } = setup("t-quota");
    concludeExhausted(run);
    expect(store.resolveChainOnRunEnd(ref, "t-quota", REPO, run, T0).kind).toBe("advanced");
    // An exhausted SUBSCRIPTION row for the same provider/model must NOT
    // block the api-key entry — the credentials are different accounts.
    store.stampQuota(
      { runner: "b-1", provider: "gemini", scope: "gemini-2.5-pro", reason: "plan spent", authMode: "subscription" },
      T0,
    );
    const other = acquireFallback(store, ref, "b-1", { now: T0, provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" });
    expect(other.ok).toBe(true);
    if (other.ok) release(store, other.claim.leaseId, T0);
    // The PINNED credential's own exhaustion refuses — and creates nothing.
    store.stampQuota(
      { runner: "b-1", provider: "gemini", scope: "gemini-2.5-pro", reason: "credits gone", authMode: "api-key" },
      T0,
    );
    const before = Number((store.raw().prepare("SELECT COUNT(*) AS n FROM claim WHERE released_at IS NULL").get() as { n: number }).n);
    const claim = acquireFallback(store, ref, "b-1", { now: T0, provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" });
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.reason).toBe("quota");
    const after = Number((store.raw().prepare("SELECT COUNT(*) AS n FROM claim WHERE released_at IS NULL").get() as { n: number }).n);
    expect(after).toBe(before);
  });

  test("the INCARNATION crash window: a daemon dying after admission is recovered by its successor and the cycle resolves (F+G finding 3)", () => {
    grant();
    const { ref, run } = setup("t-incarnation");
    concludeExhausted(run);
    expect(store.resolveChainOnRunEnd(ref, "t-incarnation", REPO, run, T0).kind).toBe("advanced");
    // The doomed watch claims WITH its incarnation and admits the fallback.
    const claim = acquireFallback(store, ref, "b-1", {
      now: T0, provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key", incarnation: "watch-1",
    });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const cycle = store.fallbackCycleFor(ref)!;
    const admitted = store.admitNextChainEntry(cycle.id, { leaseId: claim.claim.leaseId, runner: "b-1", branch: "b", worktree: "/w2" }, T0);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    // CRASH before the provider ever spawns. The successor watch recovers
    // the dead incarnation: claim released, the admitted run interrupted.
    expect(store.recoverIncarnation("b-1", "watch-1", T0)).toBe(1);
    expect(store.getRun(admitted.runId)).toMatchObject({ outcome: "failed", reason: "interrupted" });
    // The SAME reconciler then resolves the cycle — an interrupted entry is
    // an ordinary end: closed, and the ordinary road is free again.
    expect(store.reconcileStrandedChains(REPO, T0)).toBe(1);
    expect(store.fallbackCycleFor(ref)).toBeNull();
  });
});

describe("the operator surfaces (Layer F): configuring and granting in words", () => {
  let base: string;
  let db: string;
  let lines: string[] = [];

  const run = (argv: string[]) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: T0 });
  };
  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "standing-orders-fbcli-"));
    db = join(base, "queue.db");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("config set/show/clear fallback: 3-part entries, credentialed, per-repo, refusing what cannot authenticate", async () => {
    await run(["approver", "add", "alex", "--json"]);
    const token = payload().token as string;
    // Set: two entries, words restating each credential.
    expect(
      await run(["config", "set", "fallback", "--repo", REPO, "--entries", "codex:gpt-5-codex:subscription,gemini:gemini-2.5-pro:api-key", "--as", "alex", "--token", token, "--json"]),
    ).toBe(EXIT.ok);
    expect(payload().fallback).toEqual([
      { provider: "codex", model: "gpt-5-codex", authMode: "subscription" },
      { provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" },
    ]);
    // Show renders it.
    expect(await run(["config", "show", "--repo", REPO, "--json"])).toBe(EXIT.ok);
    expect(payload().fallback).toHaveLength(2);
    // Malformed shapes refuse in words: 2-part, unknown provider, bad auth,
    // subscription on a login-less provider, missing --repo.
    expect(await run(["config", "set", "fallback", "--repo", REPO, "--entries", "gemini:api-key", "--as", "alex", "--token", token])).toBe(EXIT.usage);
    expect(await run(["config", "set", "fallback", "--repo", REPO, "--entries", "grok:g-1:api-key", "--as", "alex", "--token", token])).toBe(EXIT.usage);
    expect(await run(["config", "set", "fallback", "--repo", REPO, "--entries", "gemini:gemini-2.5-pro:password", "--as", "alex", "--token", token])).toBe(EXIT.usage);
    expect(await run(["config", "set", "fallback", "--repo", REPO, "--entries", "openrouter:gpt-5:subscription", "--as", "alex", "--token", token])).toBe(EXIT.usage);
    expect(await run(["config", "set", "fallback", "--entries", "gemini:gemini-2.5-pro:api-key", "--as", "alex", "--token", token])).toBe(EXIT.usage);
    // A chain the CURRENT base cannot file refuses AT SET TIME (finding 4):
    // with claude/sonnet configured, the same entry as a fallback dupes.
    expect(await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", token, "--json"])).toBe(EXIT.ok);
    expect(await run(["config", "set", "fallback", "--repo", REPO, "--entries", "claude:sonnet:subscription", "--as", "alex", "--token", token])).toBe(EXIT.usage);
    // The refusal RESTORED the previous (valid) config.
    expect(await run(["config", "show", "--repo", REPO, "--json"])).toBe(EXIT.ok);
    expect(payload().fallback).toHaveLength(2);
    // A model with a leading dash never seals (argv safety, finding 1) —
    // and a colon-suffixed openrouter model DOES (first/last-colon parse).
    expect(await run(["config", "set", "fallback", "--repo", REPO, "--entries", "claude:--dangerously-skip-permissions:api-key", "--as", "alex", "--token", token])).toBe(EXIT.usage);
    expect(await run(["config", "set", "fallback", "--repo", REPO, "--entries", "openrouter:qwen/qwq-32b:free:api-key", "--as", "alex", "--token", token, "--json"])).toBe(EXIT.ok);
    expect(payload().fallback).toEqual([{ provider: "openrouter", model: "qwen/qwq-32b:free", authMode: "api-key" }]);
    // Clear.
    expect(await run(["config", "clear", "fallback", "--repo", REPO, "--as", "alex", "--token", token, "--json"])).toBe(EXIT.ok);
    expect(await run(["config", "show", "--repo", REPO, "--json"])).toBe(EXIT.ok);
    expect(payload().fallback).toEqual([]);
  });

  test("mode set --allow-paid-fallback: the grant is NEVER a preset default and rides only the explicit flag", async () => {
    await run(["approver", "add", "alex", "--json"]);
    const token = payload().token as string;
    // Without the flag: no grant, on either preset.
    expect(await run(["mode", "set", "--repo", REPO, "--name", "hands-off", "--as", "alex", "--token", token, "--json"])).toBe(EXIT.ok);
    expect(payload().terms.allowPaidFallback).toBe(false);
    // With it: granted, and the ceremony words say what moves.
    expect(await run(["mode", "set", "--repo", REPO, "--name", "standard", "--allow-paid-fallback", "--as", "alex", "--token", token, "--json"])).toBe(EXIT.ok);
    expect(payload().terms.allowPaidFallback).toBe(true);
    const store = openStore(db);
    const live = store.activeMode(REPO, T0);
    expect(modeTermsFromJson(live?.termsJson ?? null)?.allowPaidFallback).toBe(true);
    store.close();
  });
});
