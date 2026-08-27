/**
 * Layer 4 (modes chain E1/F1/F2): the merge-intent machine's transition
 * table, the firing CAS as the one-winner linearization point, terminal
 * monotonicity, and stale-firing recovery. These are the concurrency and
 * crash-recovery tests the review named first-class.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { mergeTermsHash } from "./publish.js";
import { addApprover } from "./scope.js";
import { presetTerms, modeTermsJson, modeDigestOf, type ModeTerms } from "./modes.js";

const T0 = new Date("2026-08-27T06:00:00.000Z");
const REPO = "/repo/main";
const HEAD = "abc123def4567890";
const GRACE = 10 * 60_000;

describe("the merge machine (v29, layer 4)", () => {
  let store: Store;
  let publicationId: number;
  let termsHash: string;

  const grantIt = () =>
    store.savePublicationGrant(
      {
        repo: REPO,
        githubRepo: "alex/thing",
        remote: "origin",
        headPrefix: "standing-orders/",
        base: "main",
        capabilities: ["push-branch", "open-pr"],
        selector: "ours",
        draft: false,
        grantedBy: "alex",
        merge: true,
        mergeMethod: "squash",
        mergeDeleteBranch: false,
      } as Parameters<Store["savePublicationGrant"]>[0],
      T0,
    );

  const signMode = (publication: "notify" | "automerge", by = "alex") => {
    const terms: ModeTerms = { ...presetTerms("hands-off", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), publication };
    return store.signMode(
      { repo: REPO, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: by, absoluteExpiry: terms.absoluteExpiry, publication },
      T0,
    );
  };

  const writeIntent = () => {
    store.createMergeIntent(
      { publication: publicationId, repo: REPO, grantTermsHash: termsHash, headSha: HEAD, method: "squash", deleteBranch: false },
      T0,
    );
    const intent = store.mergeIntentFor(publicationId);
    if (intent === null) throw new Error("intent");
    return intent;
  };

  const rowOf = (id: number) =>
    store.raw().prepare("SELECT state, authority_basis, mode_digest, generation, firing_at, firing_deadline FROM merge_intent WHERE id = ?").get(id) as Record<string, unknown>;

  beforeEach(() => {
    store = openStore(":memory:");
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    grantIt();
    const grant = store.publicationGrantFor(REPO);
    if (grant === null) throw new Error("grant");
    termsHash = mergeTermsHash(grant);
    store.createTask({ id: "t-1", title: "wire the payout guard" }, T0);
    const taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
    const runId = store.startRun({
      taskRef,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
    });
    publicationId = store.createPublicationIntent(
      { run: runId, taskRef, githubRepo: "alex/thing", remote: "origin", base: "main", head: "standing-orders/t-1", headSha: HEAD, bodyHash: "x", draft: false },
      T0,
    );
    store.markPublicationPushed(publicationId, T0);
    store.markPublicationOpened(publicationId, 7, "https://github.com/alex/thing/pull/7", T0);
  });

  afterEach(() => store.close());

  test("creation postures: no mode = grant basis; notify = waiting-human; automerge = mode basis with the bound digest", () => {
    const plain = writeIntent();
    expect(rowOf(plain.id)).toMatchObject({ state: "pending", authority_basis: "grant", mode_digest: null });
    store.raw().prepare("DELETE FROM merge_intent").run();

    signMode("notify");
    const waiting = writeIntent();
    expect(rowOf(waiting.id)).toMatchObject({ state: "waiting-human", authority_basis: "human" });
    store.raw().prepare("DELETE FROM merge_intent").run();

    const modeId = signMode("automerge");
    const auto = writeIntent();
    const digest = String(store.raw().prepare("SELECT digest FROM operating_mode WHERE id = ?").get(modeId)?.["digest"]);
    expect(rowOf(auto.id)).toMatchObject({ state: "pending", authority_basis: "mode", mode_digest: digest });
  });

  test("signing NOTIFY demotes even grant-basis pending intents (D1); revocation demotes only mode-basis (running grants revert)", () => {
    const intent = writeIntent(); // pending, basis grant
    signMode("notify");
    expect(rowOf(intent.id)).toMatchObject({ state: "waiting-human", authority_basis: "human" });
    // release by ceremony, then sign automerge: rebinds to the new digest
    expect(store.authorizeMergeIntent(intent.id, HEAD, "alex", T0)).toMatchObject({ ok: true });
    const autoId = signMode("automerge");
    const digest = String(store.raw().prepare("SELECT digest FROM operating_mode WHERE id = ?").get(autoId)?.["digest"]);
    expect(rowOf(intent.id)).toMatchObject({ state: "pending", authority_basis: "mode", mode_digest: digest });
    // revoking the mode demotes the mode-basis row to waiting-human
    store.revokeMode(REPO, "alex", "operator", T0);
    expect(rowOf(intent.id)).toMatchObject({ state: "waiting-human", authority_basis: "human", mode_digest: null });
  });

  test("the per-merge yes is EXACT-INTENT: it authorizes one head, refuses a moved one, and only a waiting row", () => {
    signMode("notify");
    const intent = writeIntent();
    expect(store.authorizeMergeIntent(intent.id, "other-sha", "alex", T0)).toMatchObject({ ok: false, reason: "head-moved" });
    expect(store.authorizeMergeIntent(intent.id, HEAD, "alex", T0)).toMatchObject({ ok: true });
    expect(rowOf(intent.id)).toMatchObject({ state: "pending", authority_basis: "human" });
    expect(store.authorizeMergeIntent(intent.id, HEAD, "alex", T0)).toMatchObject({ ok: false, reason: "not-waiting" });
  });

  test("the firing CAS is the one-winner linearization point: revocation-first wins waiting-human; firing-first is undemotable", () => {
    signMode("automerge");
    const intent = writeIntent();
    const claim = store.claimMergeIntent(intent.id, "watch", 5 * 60_000, T0);
    if (claim === null) throw new Error("claim");

    // REVOCATION FIRST: the reconciler moved the row; the CAS must fail.
    store.revokeMode(REPO, "alex", "operator", T0);
    const lost = store.fireMergeIntent(intent.id, claim.generation, { repo: REPO, headSha: HEAD, liveGrantTermsHash: termsHash, graceMs: GRACE }, T0);
    expect(lost).toMatchObject({ ok: false, outcome: "raced" });
    expect(rowOf(intent.id)).toMatchObject({ state: "waiting-human" });

    // FIRING FIRST: re-arm, re-sign, claim, fire — then revoke. The row stays firing.
    expect(store.authorizeMergeIntent(intent.id, HEAD, "alex", T0)).toMatchObject({ ok: true });
    const claim2 = store.claimMergeIntent(intent.id, "watch", 5 * 60_000, T0);
    if (claim2 === null) throw new Error("claim2");
    const fired = store.fireMergeIntent(intent.id, claim2.generation, { repo: REPO, headSha: HEAD, liveGrantTermsHash: termsHash, graceMs: GRACE }, T0);
    expect(fired).toMatchObject({ ok: true });
    store.revokeMode(REPO, "alex", "operator", T0);
    expect(rowOf(intent.id)).toMatchObject({ state: "firing" });
    // and the firing owner settles it from 'firing'
    expect(store.settleMergeIntent(intent.id, claim2.generation, "merged", T0, { from: "firing", receipt: "done" })).toBe(true);
  });

  test("the firing CAS re-proves in-transaction: moved head and drifted grant terms supersede; a dead mode fences to waiting-human", () => {
    signMode("automerge");
    const a = writeIntent();
    const claimA = store.claimMergeIntent(a.id, "w", 5 * 60_000, T0);
    if (claimA === null) throw new Error("a");
    expect(store.fireMergeIntent(a.id, claimA.generation, { repo: REPO, headSha: "moved-sha", liveGrantTermsHash: termsHash, graceMs: GRACE }, T0)).toMatchObject({ ok: false, outcome: "superseded" });
    expect(rowOf(a.id)).toMatchObject({ state: "superseded" });

    store.raw().prepare("DELETE FROM merge_intent").run();
    const b = writeIntent();
    const claimB = store.claimMergeIntent(b.id, "w", 5 * 60_000, T0);
    if (claimB === null) throw new Error("b");
    expect(store.fireMergeIntent(b.id, claimB.generation, { repo: REPO, headSha: HEAD, liveGrantTermsHash: "drifted", graceMs: GRACE }, T0)).toMatchObject({ ok: false, outcome: "superseded" });

    // dead mode between claim and fire, reconciliation missed: the CAS's own belt fences
    store.raw().prepare("DELETE FROM merge_intent").run();
    signMode("automerge");
    const c = writeIntent();
    const claimC = store.claimMergeIntent(c.id, "w", 5 * 60_000, T0);
    if (claimC === null) throw new Error("c");
    // kill the mode WITHOUT the reconciler seeing this row (simulate a raced write-back)
    store.raw().prepare("UPDATE operating_mode SET revoked_at = ? WHERE revoked_at IS NULL").run(T0.toISOString());
    const fenced = store.fireMergeIntent(c.id, claimC.generation, { repo: REPO, headSha: HEAD, liveGrantTermsHash: termsHash, graceMs: GRACE }, T0);
    expect(fenced).toMatchObject({ ok: false, outcome: "waiting-human" });
    expect(rowOf(c.id)).toMatchObject({ state: "waiting-human" });
  });

  test("a grant-basis fire under a live NOTIFY mode fences to waiting-human (the stricter posture wins races too)", () => {
    const intent = writeIntent(); // basis grant, no mode yet
    const claim = store.claimMergeIntent(intent.id, "w", 5 * 60_000, T0);
    if (claim === null) throw new Error("claim");
    // notify mode signed between claim and fire; its reconciler bumped the row —
    // but even a hand-rolled miss is caught by the CAS belt:
    store.raw().prepare("INSERT INTO operating_mode (repo, name, terms_json, digest, signed_by, signed_at, absolute_expiry) VALUES (?, 'standard', ?, 'd1', 'alex', ?, ?)")
      .run(REPO, modeTermsJson(presetTerms("standard", new Date(T0.getTime() + 60 * 60_000).toISOString())), T0.toISOString(), new Date(T0.getTime() + 60 * 60_000).toISOString());
    const fenced = store.fireMergeIntent(intent.id, claim.generation, { repo: REPO, headSha: HEAD, liveGrantTermsHash: termsHash, graceMs: GRACE }, T0);
    expect(fenced).toMatchObject({ ok: false, outcome: "waiting-human" });
  });

  test("terminals are monotonic: a stale claim owner cannot overwrite what the observer settled", () => {
    const intent = writeIntent();
    const claim = store.claimMergeIntent(intent.id, "w", 5 * 60_000, T0);
    if (claim === null) throw new Error("claim");
    // the observer sees MERGED remotely and settles with a generation bump
    expect(store.settleMergeIntent(intent.id, claim.generation, "merged", T0, { receipt: "observed merged remotely", bumpGeneration: true })).toBe(true);
    // the stale claim owner comes back with its old generation — and loses
    expect(store.settleMergeIntent(intent.id, claim.generation, "pending", T0, { from: "claimed" })).toBe(false);
    // even a same-generation writer cannot un-merge a terminal
    const gen = Number(rowOf(intent.id)["generation"]);
    expect(store.settleMergeIntent(intent.id, gen, "pending", T0)).toBe(false);
    expect(rowOf(intent.id)).toMatchObject({ state: "merged" });
  });

  test("stale-firing recovery is a ceremony, never automatic: refire refuses a live deadline and re-arms a passed one", () => {
    signMode("automerge");
    const intent = writeIntent();
    const claim = store.claimMergeIntent(intent.id, "w", 5 * 60_000, T0);
    if (claim === null) throw new Error("claim");
    expect(store.fireMergeIntent(intent.id, claim.generation, { repo: REPO, headSha: HEAD, liveGrantTermsHash: termsHash, graceMs: GRACE }, T0)).toMatchObject({ ok: true });

    // deadline not passed: the owner may still finish
    expect(store.refireMergeIntent(intent.id, "alex", new Date(T0.getTime() + 60_000))).toMatchObject({ ok: false, reason: "not-stale" });
    // passed: the ceremony re-arms with a generation bump
    const late = new Date(T0.getTime() + GRACE + 60_000);
    const before = Number(rowOf(intent.id)["generation"]);
    expect(store.refireMergeIntent(intent.id, "alex", late)).toMatchObject({ ok: true });
    const row = rowOf(intent.id);
    expect(row).toMatchObject({ state: "pending", authority_basis: "human", firing_at: null, firing_deadline: null });
    expect(Number(row["generation"])).toBe(before + 1);
    // and the dead owner's late settle (old generation) loses
    expect(store.settleMergeIntent(intent.id, claim.generation, "merged", late, { from: "firing" })).toBe(false);
  });

  test("expiry closure reconciles too: an automerge mode expiring drops its intents to waiting-human on the next read", () => {
    signMode("automerge");
    const intent = writeIntent();
    expect(rowOf(intent.id)).toMatchObject({ state: "pending", authority_basis: "mode" });
    const later = new Date(T0.getTime() + 2 * 24 * 60 * 60_000);
    expect(store.activeMode(REPO, later)).toBeNull(); // closes + reconciles
    expect(rowOf(intent.id)).toMatchObject({ state: "waiting-human", authority_basis: "human" });
  });
});
