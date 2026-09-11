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
import { routeFromJson } from "./phase-routing.js";
import { presetTerms, modeTermsFromJson, modeTermsJson, modeWords } from "./modes.js";

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
    store.setRouteOverride(ref, { phase: "build", provider: "codex", model: "gpt-5-codex", by: "alex" }, T0);
    const refiled = store.refileScope("t", T0)!;
    expect(store.approvedChainOf("t")).toBeNull();
    expect(store.approvedRouteOf("t")).toBeNull();
    // The re-filed chain's base is the overridden leg — the same sealed
    // shape, re-proposed, waiting for a fresh yes.
    const rechained = chainFromJson(refiled.proposedChainJson ?? null)!;
    expect(rechained[0]?.profile).toMatchObject({ provider: "codex", model: "gpt-5-codex" });
    expect(routeFromJson(refiled.proposedRouteJson ?? null)!.legs.find(one => one.phase === "build")).toMatchObject({ provider: "codex", chosen: "override" });
    expect(approvalOf(refiled)).toMatchObject({ approved: false, reason: "changed" });
  });
});
