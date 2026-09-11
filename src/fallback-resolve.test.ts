/**
 * Layer D: the mode paid-fallback grant, the fallback config, and chain
 * resolution — the static half of fallback chains. Nothing dispatches on
 * any of this yet; these prove the shapes the approval will seal and the
 * runtime will re-derive.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { resolveScopeChain } from "./agentconfig.js";
import { addApprover, approvalOf, approve, chainFromJson, digestOf, propose } from "./scope.js";
import { routeDigestOf, routeFromJson } from "./phase-routing.js";
import { register } from "./runner.js";
import { presetTerms, modeTermsFromJson, modeTermsJson, modeWords, modeDigestOf } from "./modes.js";

const T0 = new Date("2026-08-29T12:00:00.000Z");
const REPO = "/repos/thing";

describe("the paid-fallback mode grant (R8)", () => {
  test("presets default allowPaidFallback FALSE; a legacy mode (no field) reads FALSE", () => {
    expect(presetTerms("standard", T0.toISOString()).allowPaidFallback).toBe(false);
    expect(presetTerms("hands-off", T0.toISOString()).allowPaidFallback).toBe(false);
    // A legacy termsJson with NO allowPaidFallback field rehydrates to false.
    const legacy = JSON.parse(modeTermsJson(presetTerms("standard", T0.toISOString()))) as Record<string, unknown>;
    delete legacy["allowPaidFallback"];
    const back = modeTermsFromJson(JSON.stringify(legacy));
    expect(back).not.toBeNull();
    expect(back?.allowPaidFallback).toBe(false);
  });

  test("a non-boolean allowPaidFallback is a bad envelope (null); true round-trips", () => {
    const bad = JSON.parse(modeTermsJson(presetTerms("standard", T0.toISOString()))) as Record<string, unknown>;
    bad["allowPaidFallback"] = "yes";
    expect(modeTermsFromJson(JSON.stringify(bad))).toBeNull();
    const granted = { ...presetTerms("standard", T0.toISOString()), allowPaidFallback: true };
    expect(modeTermsFromJson(modeTermsJson(granted))?.allowPaidFallback).toBe(true);
  });

  test("the ceremony words state the grant either way", () => {
    expect(modeWords({ ...presetTerms("standard", T0.toISOString()), allowPaidFallback: false }).join(" ")).toContain("never switches to a paid API key on its own");
    expect(modeWords({ ...presetTerms("standard", T0.toISOString()), allowPaidFallback: true }).join(" ")).toContain("spend moves to that account");
  });
});

describe("fallback config + chain resolution", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
  });
  afterEach(() => store.close());

  test("no fallbacks configured => a single-profile approval (kind 'profile'), chain-of-one", () => {
    const res = resolveScopeChain(store, REPO, undefined, {}, "subscription");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("profile");
    expect(res.chain).toHaveLength(1);
    expect(res.chain[0]?.profile.provider).toBe("claude");
    expect(res.chain[0]?.authMode).toBe("subscription");
  });

  test("configured fallbacks build an explicit chain (kind 'chain'), base first", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const res = resolveScopeChain(store, REPO, undefined, {}, "subscription");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("chain");
    expect(res.chain).toHaveLength(2);
    expect(res.chain[0]).toMatchObject({ authMode: "subscription" });
    expect(res.chain[0]?.profile.provider).toBe("claude");
    expect(res.chain[1]).toMatchObject({ authMode: "api-key" });
    expect(res.chain[1]?.profile.provider).toBe("gemini");
    expect(res.chain[1]?.profile.model).toBe("gemini-2.5-pro");
  });

  test("a fallback identical to the base (same profile + auth mode) is rejected as a duplicate", () => {
    // claude/sonnet/subscription is the base; the same as a fallback dupes.
    store.setFallbackConfig(REPO, [{ provider: "claude", model: "sonnet", authMode: "subscription" }], "alex", T0);
    const res = resolveScopeChain(store, REPO, undefined, {}, "subscription");
    expect(res).toMatchObject({ ok: false, reason: "duplicate" });
    // But the SAME provider/model with a DIFFERENT auth mode is legal (the
    // subscription->api-key quota switch).
    store.setFallbackConfig(REPO, [{ provider: "claude", model: "sonnet", authMode: "api-key" }], "alex", T0);
    const ok = resolveScopeChain(store, REPO, undefined, {}, "subscription");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.chain).toHaveLength(2);
  });

  test("a malformed fallback entry refuses", () => {
    store.setFallbackConfig(REPO, [{ provider: "nope" as "claude", model: "x", authMode: "api-key" }], "alex", T0);
    expect(resolveScopeChain(store, REPO, undefined, {}, "subscription")).toMatchObject({ ok: false, reason: "bad-fallback" });
  });

  test("config round-trips and clears", () => {
    store.setFallbackConfig(REPO, [{ provider: "codex", model: "gpt-5-codex", authMode: "subscription" }], "alex", T0);
    expect(store.fallbackConfig(REPO)).toEqual([{ provider: "codex", model: "gpt-5-codex", authMode: "subscription" }]);
    expect(store.clearFallbackConfig(REPO)).toBe(true);
    expect(store.fallbackConfig(REPO)).toEqual([]);
    expect(store.clearFallbackConfig(REPO)).toBe(false);
  });
});

describe("a routed scope under a fallback chain (v47): the route drives the base, the chain stays the only substitution road", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.setPhaseTierConfig("installation", "build", "strong", "claude", "opus", "alex", T0);
    store.setFallbackConfig(REPO, [{ provider: "codex", model: "gpt-5-codex", authMode: "api-key" }], "alex", T0);
    const alex = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    if (!alex.ok) throw new Error("bootstrap");
  });
  afterEach(() => store.close());

  test("the sealed chain's base is the route's strong build leg; the digest binds chain AND route; the seal proves both, and a route edit unseals both", () => {
    store.createTask({ id: "t", title: "t" }, T0);
    const ref = store.refFor("built-in", "t").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "t", goal: "guard", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], riskLevel: "high", now: T0 });
    const scope = store.getScope("t")!;
    const chain = chainFromJson(scope.proposedChainJson ?? null)!;
    expect(chain[0]?.profile).toMatchObject({ provider: "claude", model: "opus" });
    expect(chain[1]?.profile).toMatchObject({ provider: "codex", model: "gpt-5-codex" });
    const route = routeFromJson(scope.proposedRouteJson ?? null)!;
    expect(route.legs.find(one => one.phase === "build")).toMatchObject({ provider: "claude", model: "opus", tier: "strong" });
    // The digest binds the whole chain and the signed route together.
    const fields = { goal: "guard", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: scope.acceptance };
    expect(scope.digest).toBe(digestOf(fields, { chain }, route));
    expect(scope.digest).not.toBe(digestOf(fields, { chain }));
    expect(approve(store, "t", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    expect(store.getScope("t")!.approvalKind).toBe("chain");
    expect(store.approvedChainOf("t")).toHaveLength(2);
    expect(store.approvedRouteOf("t")).not.toBeNull();
    // The explicit approved chain is the ONLY automatic substitution: the
    // route itself never names a second-best. Editing the route unseals
    // the chain authority as well — nothing dispatches on a stale seal.
    expect(route.legs.every(one => one.problem === null)).toBe(true);
    const edited = store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "build", provider: "codex", model: "gpt-5-codex" } }, T0);
    if (!edited.ok) throw new Error(edited.detail);
    const refiled = edited.scope!;
    expect(store.approvedChainOf("t")).toBeNull();
    expect(store.approvedRouteOf("t")).toBeNull();
    // The re-filed chain's base is the overridden leg — the same sealed
    // shape, re-proposed, waiting for a fresh yes.
    const rechained = chainFromJson(refiled.proposedChainJson ?? null)!;
    expect(rechained[0]?.profile).toMatchObject({ provider: "codex", model: "gpt-5-codex" });
    expect(routeFromJson(refiled.proposedRouteJson ?? null)!.legs.find(one => one.phase === "build")).toMatchObject({ provider: "codex", chosen: "override" });
    expect(approvalOf(refiled)).toMatchObject({ approved: false, reason: "changed" });
  });

  test("an unavailable primary moves ONLY to the explicitly approved next entry — and only under a live paid-fallback grant; everything else fails closed", () => {
    store.createTask({ id: "u", title: "u" }, T0);
    const ref = store.refFor("built-in", "u").id;
    store.placeTask(ref, REPO);
    register(store, { name: "mac", host: "h", repos: [REPO], now: T0, newToken: () => "tok-mac" });
    propose(store, { taskId: "u", goal: "guard", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], now: T0 });
    // No approval yet: no chain, nothing substitutes.
    expect(store.skipUnavailablePrimary(ref, "u", REPO, "mac", T0)).toMatchObject({ ok: false, reason: "no-chain" });
    expect(approve(store, "u", "alex", T0, store.getScope("u")!.digest, "tok-alex").ok).toBe(true);
    // The primary is not reported unavailable: nothing moves.
    expect(store.skipUnavailablePrimary(ref, "u", REPO, "mac", T0)).toMatchObject({ ok: false, reason: "primary-available" });
    store.recordProviderReadiness("mac", [{ provider: "claude", state: "unavailable", reason: "not installed", probe: "version" }], T0);
    // Without a live mode granting paid fallback: fail closed, in words.
    const withheld = store.skipUnavailablePrimary(ref, "u", REPO, "mac", T0);
    expect(withheld).toMatchObject({ ok: false, reason: "grant-withheld" });
    if (!withheld.ok) expect(withheld.detail).toContain("codex · gpt-5-codex");
    expect(store.fallbackCycleFor(ref)).toBeNull();
    const terms = { ...presetTerms("hands-off", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), allowPaidFallback: true };
    expect(modeTermsFromJson(modeTermsJson(terms))?.allowPaidFallback).toBe(true);
    store.signMode({ repo: REPO, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, T0);
    // The next entry is unavailable too: nothing substitutes.
    store.recordProviderReadiness("mac", [{ provider: "codex", state: "unavailable", reason: "not logged in", probe: "identity" }], T0);
    expect(store.skipUnavailablePrimary(ref, "u", REPO, "mac", T0)).toMatchObject({ ok: false, reason: "next-unavailable" });
    store.recordProviderReadiness("mac", [{ provider: "codex", state: "ready", reason: "logged in", probe: "identity" }], T0);
    // The transition: a fresh cycle, skipped once to the approved entry at
    // index 1, pending admission — the readiness observation is its evidence.
    const moved = store.skipUnavailablePrimary(ref, "u", REPO, "mac", T0);
    expect(moved).toMatchObject({ ok: true, toIndex: 1, next: { provider: "codex", model: "gpt-5-codex" } });
    const cycle = store.fallbackCycleFor(ref)!;
    expect(cycle).toMatchObject({ state: "pending-admission", cursor: 1, tailRun: null });
    expect(store.pendingChainAdmissions(REPO)).toEqual([{ cycleId: cycle.id, taskRef: ref, taskId: "u", cursor: 1 }]);
    const edge = store.raw().prepare("SELECT kind, from_index, to_index, evidence_provider, evidence_fp FROM fallback_transition WHERE cycle = ?").get(cycle.id);
    expect(edge).toMatchObject({ kind: "quota-skip", from_index: 0, to_index: 1, evidence_provider: "claude" });
    expect(String(edge?.["evidence_fp"])).toContain("readiness:mac:");
    // A live cycle refuses a second transition.
    expect(store.skipUnavailablePrimary(ref, "u", REPO, "mac", T0)).toMatchObject({ ok: false, reason: "cycle-live" });
    // Admission re-checks the entry's readiness INSIDE its transaction: a
    // runner that reports codex unavailable opens no run, and the cycle stays
    // pending for one that can.
    store.recordProviderReadiness("mac", [{ provider: "codex", state: "unavailable", reason: "logged out since", probe: "identity" }], new Date(T0.getTime() + 1_000));
    const refused = store.admitNextChainEntry(cycle.id, { leaseId: "l", runner: "mac", branch: "b", worktree: "/w" }, new Date(T0.getTime() + 1_000));
    expect(refused).toMatchObject({ ok: false, reason: "provider-unavailable" });
    expect(store.fallbackCycleFor(ref)?.state).toBe("pending-admission");
    expect(store.runsFor(ref)).toHaveLength(0);
    store.recordProviderReadiness("mac", [{ provider: "codex", state: "ready", reason: "logged in", probe: "identity" }], new Date(T0.getTime() + 2_000));
    const admitted = store.admitNextChainEntry(cycle.id, { leaseId: "l", runner: "mac", branch: "b", worktree: "/w" }, new Date(T0.getTime() + 2_000));
    expect(admitted).toMatchObject({ ok: true, provider: "codex", model: "gpt-5-codex" });
    if (!admitted.ok) return;
    // Provenance: the fallback run spends as `fallback` under the sealed route.
    expect(store.runRoute(admitted.runId)).toMatchObject({ phase: "build", provider: "codex", model: "gpt-5-codex", chosen: "fallback", routeDigest: routeDigestOf(store.approvedRouteOf("u")!) });
    // Set-once: an identical restamp is idempotent; a conflicting one refuses.
    expect(store.stampRunRoute(admitted.runId, { routeDigest: routeDigestOf(store.approvedRouteOf("u")!), phase: "build", provider: "codex", model: "gpt-5-codex", chosen: "fallback" }, T0)).toEqual({ ok: true, first: false });
    expect(store.stampRunRoute(admitted.runId, { routeDigest: routeDigestOf(store.approvedRouteOf("u")!), phase: "build", provider: "claude", model: "opus", chosen: "recommended" }, T0)).toMatchObject({ ok: false });
    expect(store.runRoute(admitted.runId)?.provider).toBe("codex");
  });
});
