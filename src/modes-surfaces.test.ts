/**
 * Layer 7's surfaces, at the seams that carry authority (C1/C2/C7, M3/M4,
 * P1/P2): the quick-mint basis proved in the mint transaction, the
 * escalated permission matrix sealed where profiles are sealed, the
 * credentialed-CLI auto-approve road, and the plan pins with their
 * mutation cutoff.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover, approvalOf, describeScope, fileAndSealUnderMode, modeFilingCoverage, propose, type AcceptanceCriterion } from "./scope.js";
import { projectRoute, recommendRoute, routeFromJson, routeWords } from "./phase-routing.js";
import { resolveRouteCandidates, routeOfTask } from "./agentconfig.js";

import { presetTerms, modeTermsJson, modeDigestOf, type ModeTerms } from "./modes.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { runOperate } from "./operate.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const RUBRIC: AcceptanceCriterion[] = [{ id: "c1", statement: "the change is reviewed", how: null, evidence: ["manual-review"] }];


const T0 = new Date("2026-08-27T12:00:00.000Z");
const REPO = "/repos/thing";
const later = (hours: number) => new Date(T0.getTime() + hours * 60 * 60_000);

describe("quick mint: the mode signature substitutes for the password, proved in the mint transaction", () => {
  let store: Store;
  let taskRef: number;

  const sign = (terms: ModeTerms, by = "alex") =>
    store.signMode(
      { repo: REPO, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: by, absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );

  const mint = (basis?: { kind: "mode"; digest: string }, approver = "alex") =>
    store.mintAttendedAuthorization({
      id: randomUUID(),
      taskRef,
      approver,
      runner: "runner-1",
      runnerGeneration: 1,
      compositeDigest: "digest",
      termsJson: "{}",
      maxSessionTurns: 10,
      budgetMicrousd: 1_000_000,
      absoluteExpiry: later(1).toISOString(),
      ...(basis === undefined ? {} : { basis }),
      now: T0,
    });

  beforeEach(() => {
    store = openStore(":memory:");
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    store.placeTask(taskRef, REPO);
  });
  afterEach(() => store.close());

  test("the signer quick-mints under a live quickMint mode; the basis is stamped durably", () => {
    const terms = presetTerms("standard", later(24).toISOString());
    sign(terms);
    const minted = mint({ kind: "mode", digest: modeDigestOf(terms) });
    if (!minted.ok) throw new Error(`mint: ${minted.reason}`);
    const row = store
      .raw()
      .prepare("SELECT authority_basis, mode_digest FROM attended_authorization WHERE id = ?")
      .get(minted.authorization.id);
    expect(row).toMatchObject({ authority_basis: "mode", mode_digest: modeDigestOf(terms) });
  });

  test("a password mint stamps basis 'password' — provenance is never ambient", () => {
    const minted = mint();
    if (!minted.ok) throw new Error("mint");
    const row = store
      .raw()
      .prepare("SELECT authority_basis, mode_digest FROM attended_authorization WHERE id = ?")
      .get(minted.authorization.id);
    expect(row).toMatchObject({ authority_basis: "password", mode_digest: null });
  });

  test("quick mint refuses when the digest is stale, the signer differs, or the mode died", () => {
    const terms = presetTerms("standard", later(24).toISOString());
    sign(terms);
    // A different digest (a renewal happened between screens): refused.
    expect(mint({ kind: "mode", digest: "0".repeat(32) })).toEqual({ ok: false, reason: "mode-ended" });
    // Somebody who is not the signer: refused, even with a live mode.
    const casey = store.mintInvite("approver", "alex", T0);
    const made = store.consumeInviteAndCreateAccount({ tokenValue: casey.token, name: "casey", credentialHash: "scrypt$00$00" }, T0);
    if (!made.ok) throw new Error("casey");
    expect(mint({ kind: "mode", digest: modeDigestOf(terms) }, "casey")).toEqual({ ok: false, reason: "mode-ended" });
    // The mode revoked between the screen and the click: refused.
    store.revokeMode(REPO, "alex", "operator", T0);
    expect(mint({ kind: "mode", digest: modeDigestOf(terms) })).toEqual({ ok: false, reason: "mode-ended" });
  });
});

describe("the C7 escalation matrix, sealed where profiles are sealed", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    store.placeTask(store.refFor("built-in", "t-1").id, REPO);
  });
  afterEach(() => store.close());

  const signAndSeal = (name: "standard" | "hands-off", overrides: Partial<ModeTerms> = {}) => {
    const terms = { ...presetTerms(name, later(24).toISOString()), autoApproveFiling: true, ...overrides };
    store.signMode(
      { repo: REPO, name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
    const sealed = fileAndSealUnderMode(store, { taskId: "t-1", goal: "a guard", outOfScope: null, touches: [], acceptance: RUBRIC, now: T0, repo: REPO, actor: "alex" });
    if (!sealed.ok) throw new Error(`seal: ${sealed.reason}`);
    return store.getScope("t-1");
  };

  test("hands-off (escalated) seals claude with bypassPermissions; the digest binds the escalated profile", () => {
    const scope = signAndSeal("hands-off");
    expect(scope?.profile).toMatchObject({ provider: "claude", permissionArgv: "bypassPermissions" });
    expect(approvalOf(scope).approved).toBe(true);
    expect(scope?.approvalBasis ?? "password").toBe("mode");
  });

  test("standard (safe) uses Claude's guarded unattended auto mode", () => {
    const scope = signAndSeal("standard");
    expect(scope?.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });
  });

  test("coverage answers only for the signer with autoApprove, never for anyone else", () => {
    const terms = { ...presetTerms("hands-off", later(24).toISOString()) };
    store.signMode(
      { repo: REPO, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
    expect(modeFilingCoverage(store, REPO, "alex", T0)).toMatchObject({ escalated: true, digest: modeDigestOf(terms) });
    expect(modeFilingCoverage(store, REPO, "casey", T0)).toBeNull();
    expect(modeFilingCoverage(store, "/repos/other", "alex", T0)).toBeNull();
    store.revokeMode(REPO, "alex", "operator", T0);
    expect(modeFilingCoverage(store, REPO, "alex", T0)).toBeNull();
  });
});

describe("the round-1 closures: bearer fencing, revision defaults, sign-time grant proof", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
  });
  afterEach(() => store.close());

  test("signing automerge re-proves the grant INSIDE the transaction (finding 4)", () => {
    const terms = { ...presetTerms("hands-off", later(24).toISOString()), publication: "automerge" as const };
    expect(() =>
      store.signMode(
        { repo: REPO, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: "automerge" },
        T0,
      ),
    ).toThrow(/merge-capable/);
    expect(store.activeMode(REPO, T0)).toBeNull();
  });

  test("revision filing defaults ride the digest: escalated posture and the mode budget bind at creation (finding 2)", () => {
    // The source is a legacy task with no scope: nothing inherits, so the
    // mode's fresh filing defaults are the child's whole spend and posture
    // story (contract handoff task 2: coverage is re-proved by the caller,
    // never carried from the parent).
    const run = seedRun(store);
    const evidenceRoot = mkdtempSync(join(tmpdir(), "so-surfaces-ev-"));
    try {
      const briefBytes = Buffer.from(JSON.stringify({ schema: 1, sourceTask: "t-x", sourceRun: run, comments: [] }), "utf8");
      mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
      writeFileSync(join(evidenceRoot, String(run), "brief.json"), briefBytes);
      const sealed = store.sealRevision(
        {
          source: { task: "t-x", run, scopeDigest: null },
          brief: { evidenceRoot, key: `${run}/brief.json`, sha256: createHash("sha256").update(briefBytes).digest("hex"), bytes: briefBytes.length, capture: "test" },
          child: { title: "revise t-x: 1 comment", repair: "apply the batch" },
          commentIds: null,
          coverage: { defaultBudgetMicrousd: 2_500_000, escalated: true },
        },
        T0,
      );
      if (!sealed.ok) throw new Error(sealed.detail);
      const scope = store.getScope(sealed.id);
      expect(scope?.budgetMicrousd).toBe(2_500_000);
      expect(scope?.profile).toMatchObject({ provider: "claude", permissionArgv: "bypassPermissions" });
      // Nothing to inherit was inherited: the placeholder rubric, and the
      // approval left for the ceremony.
      expect(scope?.acceptance.map(one => one.id)).toEqual(["c1"]);
      expect(scope?.approvedAt).toBeNull();
    } finally {
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

function seedRun(store: Store): number {
  store.createTask({ id: "t-x", title: "source" }, T0);
  const ref = store.refFor("built-in", "t-x").id;
  store.placeTask(ref, REPO);
  const run = store.startRun({ taskRef: ref, leaseId: "l-x", runner: "b-1", branch: "b", worktree: "/w", ...bareLegacy("build", "claude", null), now: T0 });
  return run;
}

describe("the credentialed-CLI auto-approve road and the plan pins", () => {
  let dir: string;
  let db: string;
  let lines: string[];
  let token: string;

  const run = (command: string, rest: string[], now: Date = T0) => {
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now });
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "so-surfaces-"));
    db = join(dir, "orders.db");
    const store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    token = alex.token;
    store.createTask({ id: "t-1", title: "the work" }, T0);
    store.placeTask(store.refFor("built-in", "t-1").id, REPO);
    const terms = { ...presetTerms("hands-off", later(24).toISOString()) };
    store.signMode(
      { repo: REPO, name: "hands-off", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
    store.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("task scope with --as/--token under the signer's mode files AND approves in one act", async () => {
    const code = await run("task", ["scope", "t-1", "--goal", "guard the payout", "--acceptance", "It is fixed and verified.|manual-review", "--as", "alex", "--token", token]);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("approved");
    const store = openStore(db);
    const scope = store.getScope("t-1");
    expect(approvalOf(scope).approved).toBe(true);
    expect(scope?.approvalBasis).toBe("mode");
    // Escalated rode the filing (hands-off).
    expect(scope?.profile).toMatchObject({ permissionArgv: "bypassPermissions" });
    store.close();
  });

  test("the same filing WITHOUT credentials lands unapproved — anonymous roads never auto-seal", async () => {
    const code = await run("task", ["scope", "t-1", "--goal", "guard the payout", "--acceptance", "It is fixed and verified.|manual-review"]);
    expect(code).toBe(0);
    const store = openStore(db);
    expect(approvalOf(store.getScope("t-1")).approved).toBe(false);
    store.close();
  });

  test("a replayed --key returns the FIRST file-and-seal answer whole (finding 3)", async () => {
    const first = await run("task", ["scope", "t-1", "--goal", "guard the payout", "--acceptance", "It is fixed and verified.|manual-review", "--as", "alex", "--token", token, "--key", "file-1"]);
    expect(first).toBe(0);
    const firstWords = lines.join("\n");
    expect(firstWords).toContain("approved");
    // Replay: same key, DIFFERENT goal — the recorded answer comes back;
    // the scope is not rewritten and not re-sealed.
    const second = await run("task", ["scope", "t-1", "--goal", "something else entirely", "--acceptance", "It is fixed and verified.|manual-review", "--as", "alex", "--token", token, "--key", "file-1"]);
    expect(second).toBe(0);
    const store = openStore(db);
    expect(store.getScope("t-1")?.goal).toBe("guard the payout");
    store.close();
  });

  test("plan pins bind the plan phase and refuse while a planner is spending", async () => {
    const pinCode = await run("task", ["plan", "t-1", "--provider", "codex", "--model", "gpt-5-codex", "--as", "alex", "--token", token]);
    expect(pinCode).toBe(0);
    const store = openStore(db);
    const ref = store.refFor("built-in", "t-1");
    expect(ref.planProvider).toBe("codex");
    expect(ref.planModel).toBe("gpt-5-codex");
    // A live claim cuts off pin edits — the claim rides the runner gate
    // (MCP spec v6): registered runner, token, repo binding.
    register(store, { name: "builder-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-builder-1" });
    const taken = acquire(store, ref.id, "builder-1", { token: "tok-builder-1", now: T0 });
    expect(taken.ok).toBe(true);
    expect(store.setPlanPins(ref.id, "claude", null, T0)).toEqual({ ok: false, reason: "live-claim" });
    store.close();
  });
});

describe("the route across surfaces (v47): a live automerge mode is publication authority, and every surface prints one projection", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "alex", T0);
    const alex = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    if (!alex.ok) throw new Error("bootstrap");
    store.createTask({ id: "t", title: "t" }, T0);
    store.placeTask(store.refFor("built-in", "t").id, REPO);
  });
  afterEach(() => store.close());

  test("publication authority is read from the live mode and the grant — automerge strengthens the reviewer; notify does not", () => {
    expect(store.publicationAuthorityOf(REPO, T0)).toBe("none");
    expect(store.publicationAuthorityOf(null, T0)).toBe("none");
    store.savePublicationGrant({ repo: REPO, githubRepo: "o/r", remote: "origin", headPrefix: "standing-orders/", base: "main", capabilities: ["push-branch", "open-pr"], selector: "ours", draft: true, grantedBy: "alex", merge: true, mergeMethod: "squash" }, T0);
    expect(store.publicationAuthorityOf(REPO, T0)).toBe("notify");
    const candidates = resolveRouteCandidates(store, REPO);
    if (!candidates.ok) throw new Error("candidates");
    const notify = recommendRoute({ risk: "routine", qualityMode: "default", evidence: ["check"], publication: store.publicationAuthorityOf(REPO, T0), candidates: candidates.candidates, overrides: [] });
    expect(notify.legs.find(one => one.phase === "review")).toMatchObject({ provider: "claude", tier: "routine" });
    expect(notify.legs.find(one => one.phase === "review")?.reasons[0]).toContain("publication waits for a person");
    const terms: ModeTerms = { ...presetTerms("standard", later(24).toISOString()), publication: "automerge" };
    store.signMode({ repo: REPO, name: terms.name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication }, T0);
    expect(store.publicationAuthorityOf(REPO, T0)).toBe("automerge");
    propose(store, { taskId: "t", goal: "guard", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], now: T0 });
    const route = routeFromJson(store.getScope("t")!.proposedRouteJson ?? null)!;
    expect(route.publication).toBe("automerge");
    expect(route.legs.find(one => one.phase === "review")).toMatchObject({ provider: "codex", model: "gpt-5-codex", tier: "strong" });
    expect(route.demands).toEqual(["a live mode merges by itself — the review is the last gate, so it runs on the strongest configured reviewer"]);
    // Past the mode's expiry the same filing is routine again.
    expect(store.publicationAuthorityOf(REPO, later(25))).toBe("notify");
  });

  test("CLI words, the store projection, and the JSON envelope agree byte for byte on every leg", async () => {
    register(store, { name: "mac-mini", host: "h", repos: [REPO], now: T0, newToken: () => "tok-mini" });
    store.recordProviderReadiness("mac-mini", [{ provider: "codex", state: "ready", reason: "installed; logged in as ops", probe: "identity" }], T0);
    propose(store, { taskId: "t", goal: "guard", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check", "screenshot"] }], riskLevel: "elevated", now: T0 });
    const ref = store.refFor("built-in", "t");
    const routed = routeOfTask(store, "t", ref, T0)!;
    const projection = projectRoute(routed.route, store.readinessLookupFor(REPO, null, T0));
    const words = routeWords(projection);
    // describeScope (task show / task scope / task approve) prints exactly these lines.
    const described = describeScope(store.getScope("t")!, store.readinessLookupFor(REPO, null, T0));
    for (const line of words) expect(described).toContain(line);
    // The CLI's JSON carries the same projection.
    const file = join(mkdtempSync(join(tmpdir(), "so-route-surfaces-")), "db.sqlite");
    const disk = openStore(file);
    disk.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    disk.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    disk.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    disk.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "alex", T0);
    register(disk, { name: "mac-mini", host: "h", repos: [REPO], now: T0, newToken: () => "tok-mini" });
    disk.recordProviderReadiness("mac-mini", [{ provider: "codex", state: "ready", reason: "installed; logged in as ops", probe: "identity" }], T0);
    disk.createTask({ id: "t", title: "t" }, T0);
    disk.placeTask(disk.refFor("built-in", "t").id, REPO);
    propose(disk, { taskId: "t", goal: "guard", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check", "screenshot"] }], riskLevel: "elevated", now: T0 });
    disk.close();
    const lines: string[] = [];
    await runOperate("task", ["route", "t", "--json"], line => lines.push(line), { databaseFile: file, now: T0 });
    const envelope = JSON.parse(lines.join("\n")) as { route: { digest: string; legs: { words: string; reasons: string[]; readiness: string }[] } };
    expect(envelope.route.digest).toBe(projection.digest);
    expect(envelope.route.legs.map(one => one.words)).toEqual(projection.legs.map(one => one.words));
    expect(envelope.route.legs.map(one => one.readiness)).toEqual(["unknown", "unknown", "unknown", "ready"]);
    rmSync(join(file, ".."), { recursive: true, force: true });
  });
});
