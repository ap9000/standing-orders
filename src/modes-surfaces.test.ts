/**
 * Layer 7's surfaces, at the seams that carry authority (C1/C2/C7, M3/M4,
 * P1/P2): the quick-mint basis proved in the mint transaction, the
 * escalated permission matrix sealed where profiles are sealed, the
 * credentialed-CLI auto-approve road, and the plan pins with their
 * mutation cutoff.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover, approvalOf, fileAndSealUnderMode, modeFilingCoverage } from "./scope.js";
import { presetTerms, modeTermsJson, modeDigestOf, type ModeTerms } from "./modes.js";
import { acquire } from "./claim.js";
import { register } from "./runner.js";
import { runOperate } from "./operate.js";

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
    const sealed = fileAndSealUnderMode(store, { taskId: "t-1", goal: "a guard", outOfScope: null, touches: [], now: T0, repo: REPO, actor: "alex" });
    if (!sealed.ok) throw new Error(`seal: ${sealed.reason}`);
    return store.getScope("t-1");
  };

  test("hands-off (escalated) seals claude with bypassPermissions; the digest binds the escalated profile", () => {
    const scope = signAndSeal("hands-off");
    expect(scope?.profile).toMatchObject({ provider: "claude", permissionArgv: "bypassPermissions" });
    expect(approvalOf(scope).approved).toBe(true);
    expect(scope?.approvalBasis ?? "password").toBe("mode");
  });

  test("standard (safe) keeps acceptEdits", () => {
    const scope = signAndSeal("standard");
    expect(scope?.profile).toMatchObject({ provider: "claude", permissionArgv: "acceptEdits" });
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
    const sealed = store.sealRevision(
      {
        task: { title: "revise t-x: 1 comment", repo: REPO, goal: "apply the batch", budgetMicrousd: 2_500_000, posture: "escalated" },
        artifact: { run: seedRun(store), kind: "revision-brief", key: "1/brief.json", bytesOriginal: 2, bytesStored: 2, truncated: false, sha256: "0".repeat(64), capture: "test" },
        revisionOf: "t-x",
        commentIds: null,
        sourceRun: 1,
      },
      T0,
    );
    if (!sealed.ok) throw new Error(sealed.reason);
    const scope = store.getScope(sealed.id);
    expect(scope?.budgetMicrousd).toBe(2_500_000);
    expect(scope?.profile).toMatchObject({ provider: "claude", permissionArgv: "bypassPermissions" });
  });
});

function seedRun(store: Store): number {
  store.createTask({ id: "t-x", title: "source" }, T0);
  const ref = store.refFor("built-in", "t-x").id;
  store.placeTask(ref, REPO);
  const run = store.startRun({ taskRef: ref, leaseId: "l-x", runner: "b-1", branch: "b", worktree: "/w", now: T0 });
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
    const code = await run("task", ["scope", "t-1", "--goal", "guard the payout", "--as", "alex", "--token", token]);
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
    const code = await run("task", ["scope", "t-1", "--goal", "guard the payout"]);
    expect(code).toBe(0);
    const store = openStore(db);
    expect(approvalOf(store.getScope("t-1")).approved).toBe(false);
    store.close();
  });

  test("a replayed --key returns the FIRST file-and-seal answer whole (finding 3)", async () => {
    const first = await run("task", ["scope", "t-1", "--goal", "guard the payout", "--as", "alex", "--token", token, "--key", "file-1"]);
    expect(first).toBe(0);
    const firstWords = lines.join("\n");
    expect(firstWords).toContain("approved");
    // Replay: same key, DIFFERENT goal — the recorded answer comes back;
    // the scope is not rewritten and not re-sealed.
    const second = await run("task", ["scope", "t-1", "--goal", "something else entirely", "--as", "alex", "--token", token, "--key", "file-1"]);
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
