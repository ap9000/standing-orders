import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { addApprover, propose } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import {
  executeSharedAction,
  prepareSharedAction,
  mintSharedActionReview,
  sharedActionNeedsReview,
  type ChatAction,
} from "./chat-actions.js";
import { confirmMateProposal } from "./mate-doors.js";
import { skillsView, importSkill, changeSkills } from "./project-skills.js";
import { knowledgeView, changeKnowledge } from "./project-knowledge.js";
import { executeMateTool } from "./mate-tools.js";
import { createDecisionServer } from "./serve.js";
import { requestTaskStop } from "./task-control.js";
import { register } from "./runner.js";
import { acquire, finalizeInterruptedFenced } from "./claim.js";
import { approve } from "./scope.js";
import { storeEvidence } from "./evidence.js";
const bareLegacy = (
  phase: "build",
  provider: string,
  model: string | null,
) => ({
  route: {
    routeDigest: "legacy",
    phase,
    provider,
    model,
    chosen: "legacy" as const,
  },
});

describe("shared chat action lifecycle", () => {
  let root: string,
    repo: string,
    db: string,
    store: Store,
    who: VerifiedApprover,
    password: string,
    thread: number,
    session: number;
  const now = new Date("2026-09-17T12:00:00Z");
  let serial = 0;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-chat-")));
    repo = join(root, "repo");
    db = join(root, "state.db");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Action tests\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "seed",
    ]);
    store = openStore(db);
    const account = addApprover(store, "operator", now);
    if (!account.ok) throw Error("account");
    password = account.token;
    for (const phase of ["plan", "build", "review"] as const)
      store.setPhaseConfig(
        "installation",
        phase,
        "claude",
        "sonnet",
        "fixture",
        now,
      );
    const verified = verifyApproverStanding(
      store,
      "operator",
      store.accountOf("operator")!.generation,
      [repo],
    );
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintMateSession(
      {
        approver: who.name,
        approverGeneration: who.generation,
        credentialKey: "shared-fixture",
        ceilingMicrousd: 10000000,
        ceilingDigest: who.ceilingDigest,
        termsDigest: "fixture",
      },
      now,
    );
    thread = store.openMateThread(who.name, who.ceilingDigest, now).thread.id;
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  function task() {
    const id = `action-${++serial}`;
    const made = fileTaskProposal(
      store,
      {
        id,
        title: "Make acceptance clearer",
        repo,
        filedVia: "cli",
        planning: "skip",
      },
      now,
    );
    if (!made.ok) throw Error(made.message);
    return id;
  }
  function proposal(operation: ChatAction, input: Record<string, unknown>) {
    const payload = prepareSharedAction(
      store,
      who,
      operation,
      input,
      root,
      now,
    );
    const turn = store.openMateTurn(
      {
        approver: who.name,
        session,
        thread,
        credentialKey: "shared-fixture",
        reservedMicrousd: 0,
        dailyTurns: 100,
        weeklyCeilingMicrousd: 10000000,
        deadlineMs: 60000,
      },
      now,
    );
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startMateTurn(turn.id, now);
    if (!started.ok) throw Error("start");
    const id = store.draftMateProposal(
      {
        thread,
        turn: turn.id,
        kind: "action",
        payload: { ...payload },
        ceilingDigest: who.ceilingDigest,
      },
      now,
    );
    store.finalizeMateTurn(
      turn.id,
      started.generation,
      {
        state: "answered",
        settledMicrousd: 0,
        tokensIn: 0,
        tokensOut: 0,
        message: { text: "Review the proposed action.", activity: "" },
      },
      now,
    );
    return id;
  }
  function confirm(id: number, secure = false, credential = password) {
    const review = secure
      ? mintSharedActionReview(store, who, id, root, now)
      : null;
    return confirmMateProposal(store, who, id, now, {
      via: secure ? "web" : "telegram",
      evidenceRoot: root,
      ...(review
        ? {
            confirm: true,
            actionReview: { nonce: review.nonce, password: credential },
          }
        : {}),
    });
  }
  function skill() {
    return importSkill(
      store,
      repo,
      who.name,
      [
        {
          path: "SKILL.md",
          base64: Buffer.from(
            "---\nname: clear-copy\ndescription: Review short interface labels.\n---\nUse plain English.\n",
          ).toString("base64"),
        },
      ],
      "Test fixture",
      now,
    );
  }
  function result(id: string) {
    const run = store.startRun({
      taskRef: store.lookupRef(id)!.id,
      leaseId: "fixture",
      runner: "fixture",
      branch: "fixture",
      worktree: repo,
      ...bareLegacy("build", "claude", null),
      now,
    });
    store.finishRun(run, {
      outcome: "built",
      headRevision: "a".repeat(40),
      now,
    });
    return run;
  }
  test("chat enables and disables the exact library version; a duplicate confirm changes nothing", () => {
    const saved = skill(),
      id = proposal("skill_enable", { repo, version: saved.sha.slice(0, 20) });
    expect(confirm(id)).toMatchObject({ ok: true });
    expect(
      skillsView(store, repo, who.name).selection[saved.name]?.enabled,
    ).toBe(true);
    expect(confirm(id)).toMatchObject({ ok: false, reason: "not-pending" });
    expect(skillsView(store, repo, who.name).revision).toBe(1);
    expect(
      confirm(proposal("skill_disable", { repo, version: saved.sha })),
    ).toMatchObject({ ok: true });
    expect(
      skillsView(store, repo, who.name).selection[saved.name]?.enabled,
    ).toBe(false);
  });
  test("a skills change made in the console invalidates a pending chat action", () => {
    const saved = skill(),
      id = proposal("skill_enable", { repo, version: saved.sha }),
      view = skillsView(store, repo, who.name);
    changeSkills(
      store,
      {
        repo,
        actor: who.name,
        identity: view.identity,
        revision: view.revision,
        action: "enable",
        sha: saved.sha,
      },
      now,
    );
    expect(confirm(id)).toMatchObject({ ok: false, reason: "stale" });
    expect(skillsView(store, repo, who.name).revision).toBe(1);
  });
  test("imports review complete instructions and do not enable them implicitly", () => {
    const id = proposal("skill_import", {
      repo,
      content:
        "---\nname: careful-review\ndescription: Review acceptance evidence.\n---\nCheck every requirement.\n",
    });
    expect(confirm(id)).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(confirm(id, true)).toMatchObject({ ok: true });
    expect(skillsView(store, repo, who.name).library).toHaveLength(1);
    expect(skillsView(store, repo, who.name).selection).toEqual({});
  });
  test("a skill test creates one real task under the normal approval rules", () => {
    const saved = skill(),
      id = proposal("skill_test", {
        repo,
        version: saved.sha,
        sample: "Review the Save button label.",
        nonce: randomUUID(),
      });
    const outcome = confirm(id);
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) throw Error("confirm");
    expect(store.getTask(outcome.taskId!)?.title).toBe("Test clear-copy");
    expect(confirm(id).ok).toBe(false);
    expect(
      store.handle.prepare("SELECT COUNT(*) AS n FROM skill_test").get()?.["n"],
    ).toBe(1);
  });
  test("knowledge saved through chat is visible in the existing project view and can be removed", () => {
    expect(
      confirm(
        proposal("knowledge_save", {
          repo,
          title: "Acceptance wording",
          content: "Use short labels and show remaining checks.",
        }),
      ),
    ).toMatchObject({ ok: true });
    const reference = knowledgeView(store, repo, who.name).knowledge
      .references[0]!;
    expect(reference.content).toContain("remaining checks");
    expect(
      confirm(proposal("knowledge_remove", { repo, id: reference.id })),
    ).toMatchObject({ ok: true });
    expect(knowledgeView(store, repo, who.name).knowledge.references).toEqual(
      [],
    );
  });
  test("long knowledge requires full review and cannot be confirmed from a shortened chat card", () => {
    const instructions = "Check alignment and readable labels. ".repeat(60),
      id = proposal("knowledge_instructions", { repo, instructions });
    expect(
      sharedActionNeedsReview(
        prepareSharedAction(
          store,
          who,
          "knowledge_instructions",
          { repo, instructions },
          root,
          now,
        ),
      ),
    ).toBe(true);
    expect(confirm(id)).toMatchObject({ ok: false, reason: "needs-confirm" });
    const review = mintSharedActionReview(store, who, id, root, now);
    expect(review.payload.terms.join("\n")).toContain(instructions);
    expect(
      confirmMateProposal(store, who, id, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password: "" },
      }),
    ).toMatchObject({ ok: true });
  });
  test("a knowledge revision prevents overwriting changes made after preview", () => {
    const id = proposal("knowledge_instructions", {
        repo,
        instructions: "First draft",
      }),
      view = knowledgeView(store, repo, who.name);
    changeKnowledge(
      store,
      {
        repo,
        actor: who.name,
        identity: view.identity,
        revision: view.revision,
        action: "instructions",
        draft: { instructions: "Newer saved draft" },
      },
      now,
    );
    expect(confirm(id)).toMatchObject({ ok: false, reason: "stale" });
    expect(knowledgeView(store, repo, who.name).knowledge.instructions).toBe(
      "Newer saved draft",
    );
  });
  test("scope approval requires password and full review, then seals the exact scope", () => {
    const id = task();
    propose(store, {
      now,
      taskId: id,
      goal: "Make result acceptance easier to understand.",
    });
    const action = proposal("scope_approve", { task: id });
    expect(confirm(action)).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(confirm(action, true, "incorrect")).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(store.getScope(id)?.approvedDigest).toBeNull();
    expect(confirm(action, true)).toMatchObject({ ok: true });
    expect(store.getScope(id)?.approvedDigest).toBe(store.getScope(id)?.digest);
  });
  test("editing the scope after review prevents approving a different plan", () => {
    const id = task();
    propose(store, { now, taskId: id, goal: "First scope" });
    const action = proposal("scope_approve", { task: id }),
      review = mintSharedActionReview(store, who, action, root, now);
    propose(store, { now, taskId: id, goal: "Different scope" });
    expect(
      confirmMateProposal(store, who, action, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password },
      }),
    ).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getScope(id)?.approvedDigest).toBeNull();
  });
  test("human acceptance names the exact result, records a note and never changes machine judgement", () => {
    const id = task(),
      run = result(id),
      before = store.proofVerdictFor(run),
      action = proposal("result_accept", {
        task: id,
        run,
        note: "I reviewed the wording and remaining steps.",
      });
    expect(confirm(action)).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(store.proofAcceptance(run)).toBeNull();
    expect(confirm(action, true)).toMatchObject({ ok: true });
    expect(store.proofAcceptance(run)?.note).toContain("reviewed the wording");
    expect(store.proofVerdictFor(run)).toEqual(before);
  });
  test("a successor result invalidates acceptance, without accepting either run", () => {
    const id = task(),
      run = result(id),
      action = proposal("result_accept", { task: id, run }),
      review = mintSharedActionReview(store, who, action, root, now),
      next = result(id);
    expect(
      confirmMateProposal(store, who, action, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password: "" },
      }),
    ).toMatchObject({ ok: false, reason: "stale" });
    expect(store.proofAcceptance(run)).toBeNull();
    expect(store.proofAcceptance(next)).toBeNull();
    expect(store.getMateProposal(action)?.state).toBe("refused");
  });
  test("cancel requires an exact one-use review and preserves the task record", () => {
    const id = task(),
      action = proposal("task_cancel", { task: id });
    expect(confirm(action)).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(confirm(action, true)).toMatchObject({ ok: true });
    expect(store.getTask(id)?.state).toBe("cancelled");
    expect(confirm(action)).toMatchObject({ ok: false, reason: "not-pending" });
  });
  test("review receipts cannot be reused for another proposal", () => {
    const one = proposal("task_cancel", { task: task() }),
      two = proposal("task_cancel", { task: task() }),
      review = mintSharedActionReview(store, who, one, root, now);
    expect(
      confirmMateProposal(store, who, two, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password: "" },
      }),
    ).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(store.getMateProposal(two)?.state).toBe("pending");
  });
  test("review receipts expire and a recreated process retains pending actions", () => {
    const action = proposal("task_cancel", { task: task() }),
      review = mintSharedActionReview(store, who, action, root, now);
    store.close();
    store = openStore(db);
    expect(
      confirmMateProposal(
        store,
        who,
        action,
        new Date(now.getTime() + 11 * 60_000),
        {
          via: "web",
          evidenceRoot: root,
          confirm: true,
          actionReview: { nonce: review.nonce, password: "" },
        },
      ),
    ).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(store.getMateProposal(action)?.state).toBe("pending");
  });
  test("forged principals and changed credential generations cannot change projects", () => {
    expect(() =>
      prepareSharedAction(
        store,
        { ...who } as VerifiedApprover,
        "knowledge_instructions",
        { repo, instructions: "forged" },
        root,
        now,
      ),
    ).toThrow(/access/);
    const action = proposal("knowledge_instructions", {
      repo,
      instructions: "pending",
    });
    store.saveApprover(who.name, "new-credential-hash", now);
    expect(confirm(action)).toMatchObject({ ok: false, reason: "standing" });
    expect(knowledgeView(store, repo, who.name).revision).toBe(0);
  });

  test("restoring skills shows the exact selection and preserves the version history", () => {
    const saved = skill();
    expect(
      confirm(proposal("skill_enable", { repo, version: saved.sha })).ok,
    ).toBe(true);
    expect(
      confirm(proposal("skill_disable", { repo, version: saved.sha })).ok,
    ).toBe(true);
    const action = proposal("skill_restore", { repo, restore: 1 });
    expect(JSON.stringify(store.getMateProposal(action)?.payload)).toContain(
      saved.sha,
    );
    expect(confirm(action)).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(confirm(action, true).ok).toBe(true);
    expect(
      skillsView(store, repo, who.name).selection[saved.name]?.enabled,
    ).toBe(true);
    expect(skillsView(store, repo, who.name).revision).toBe(3);
  });
  test("restoring knowledge shows the saved content and uses the existing history", () => {
    expect(
      confirm(
        proposal("knowledge_instructions", {
          repo,
          instructions: "Short titles first.",
        }),
      ).ok,
    ).toBe(true);
    expect(
      confirm(
        proposal("knowledge_instructions", {
          repo,
          instructions: "Second version.",
        }),
      ).ok,
    ).toBe(true);
    const action = proposal("knowledge_restore", { repo, restore: 1 });
    expect(JSON.stringify(store.getMateProposal(action)?.payload)).toContain(
      "Short titles first.",
    );
    expect(confirm(action).ok).toBe(true);
    expect(knowledgeView(store, repo, who.name).knowledge.instructions).toBe(
      "Short titles first.",
    );
  });
  test("a request for review queues once through the normal review service", () => {
    const id = task();
    propose(store, {
      taskId: id,
      goal: "Test the shared review request.",
      now,
    });
    const scope = store.getScope(id)!;
    expect(approve(store, id, who.name, now, scope.digest, password).ok).toBe(
      true,
    );
    const ref = store.lookupRef(id)!,
      route = store.routeAuthorityFor(ref.id, "builder", null);
    if (!route?.ok) throw Error("route");
    const run = store.startRun({
      taskRef: ref.id,
      leaseId: "review-fixture",
      runner: "fixture",
      branch: "fixture",
      worktree: repo,
      route: route.stamp,
      now,
    });
    store.stampRun(run, { scopeDigest: scope.digest });
    store.finishRun(run, {
      outcome: "built",
      headRevision: "b".repeat(40),
      now,
    });
    storeEvidence(
      store,
      root,
      run,
      "terminal-diff",
      "change.patch",
      Buffer.from("diff --git a/README.md b/README.md\n+clear label\n"),
      "synthetic diff",
      now,
      { captureStatus: "ok" },
    );
    const action = proposal("result_review", { task: id, run });
    expect(confirm(action)).toMatchObject({ ok: true });
    expect(confirm(action)).toMatchObject({ ok: false, reason: "not-pending" });
    expect(
      store.handle
        .prepare("SELECT COUNT(*) AS n FROM review_request WHERE run=?")
        .get(run)?.["n"],
    ).toBe(1);
  });
  test("resume releases only the settled stop and leaves other holds in place", () => {
    const id = task();
    propose(store, { taskId: id, goal: "Resume a preserved draft.", now });
    const scope = store.getScope(id)!;
    expect(approve(store, id, who.name, now, scope.digest, password).ok).toBe(
      true,
    );
    const approvedScope = store.getScope(id);
    register(store, {
      name: "worker",
      host: "test",
      capacity: 1,
      repos: [repo],
      now,
      newToken: () => "test-runner",
    });
    const ref = store.lookupRef(id)!,
      claim = acquire(store, ref.id, "worker", {
        token: "test-runner",
        now,
        newLeaseId: () => "resume-fixture",
      });
    if (!claim.ok) throw Error(claim.reason);
    const route = store.routeAuthorityFor(ref.id, "builder", null);
    if (!route?.ok) throw Error("route");
    const run = store.startRun({
      taskRef: ref.id,
      leaseId: claim.claim.leaseId,
      runner: "worker",
      branch: "fixture",
      worktree: repo,
      route: route.stamp,
      now,
    });
    expect(
      requestTaskStop(
        store,
        { taskId: id, runId: run, by: who.name, via: "web" },
        now,
      ).ok,
    ).toBe(true);
    expect(() => proposal("task_resume", { task: id, run })).toThrow(
      /not ready/,
    );
    finalizeInterruptedFenced(store, {
      leaseId: claim.claim.leaseId,
      runId: run,
      taskId: id,
      stopRun: run,
      now,
    });
    store.hold(ref.id, "Operator is checking the draft.", null, now);
    const action = proposal("task_resume", { task: id, run });
    expect(confirm(action, true)).toMatchObject({
      ok: true,
      said: expect.stringContaining("Other requirements"),
    });
    expect(store.stopOf(run)?.resumedBy).toBe(who.name);
    expect(store.activeHolds(ref.id, now).map((one) => one.ownerKind)).toEqual([
      "operator",
    ]);
    expect(store.getScope(id)).toEqual(approvedScope);
  });
  test("a damaged plan cannot be approved, even after its review was opened", () => {
    const id = task(),
      ref = store.lookupRef(id)!;
    const run = store.startRun({
      taskRef: ref.id,
      leaseId: "plan-fixture",
      runner: "fixture",
      role: "planner",
      branch: "fixture",
      worktree: repo,
      route: {
        routeDigest: "legacy",
        phase: "plan",
        provider: "claude",
        model: null,
        chosen: "legacy",
      },
      now,
    });
    store.finishRun(run, { outcome: "no-change", now });
    propose(store, {
      taskId: id,
      goal: "Review the complete saved plan.",
      now,
    });
    const artifact = storeEvidence(
      store,
      root,
      run,
      "plan",
      "plan.md",
      Buffer.from("Use one clear approval action."),
      "synthetic plan",
      now,
    );
    store.setPlanState(ref.id, "drafted");
    const action = proposal("scope_approve", { task: id }),
      review = mintSharedActionReview(store, who, action, root, now);
    writeFileSync(
      join(root, store.getArtifact(artifact)!.key),
      "Different plan",
    );
    expect(
      confirmMateProposal(store, who, action, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password },
      }),
    ).toMatchObject({ ok: false, reason: "stale" });
    expect(store.getScope(id)?.approvedDigest).toBeNull();
  });
  test("the execution primitive refuses unsaved payloads and an ended conversation", () => {
    const input = { repo, instructions: "Use readable labels." },
      payload = prepareSharedAction(
        store,
        who,
        "knowledge_instructions",
        input,
        root,
        now,
      );
    expect(
      executeSharedAction(store, who, 999, payload, now, { via: "telegram" })
        .ok,
    ).toBe(false);
    const id = proposal("knowledge_instructions", input);
    expect(
      executeSharedAction(store, who, id, payload, now, { via: "telegram" }).ok,
    ).toBe(false);
    store.endMateSessionsFor(who.name, who.name, now);
    expect(confirm(id)).toMatchObject({ ok: false, reason: "session-ended" });
    expect(knowledgeView(store, repo, who.name).revision).toBe(0);
  });
  test("an action cannot silently ignore fields that belong to a different operation", () => {
    const saved = skill();
    expect(() =>
      prepareSharedAction(
        store,
        who,
        "skill_enable",
        { repo, version: saved.sha, restore: 1 },
        root,
        now,
      ),
    ).toThrow(/unsupported/);
    expect(() =>
      prepareSharedAction(
        store,
        who,
        "task_cancel",
        { task: task(), run: 1 },
        root,
        now,
      ),
    ).toThrow(/unsupported/);
  });
  test("secure HTTP review requires the owner, CSRF and one receipt, and shows the saved outcome on reopening", async () => {
    const id = task(),
      action = proposal("task_cancel", { task: id });
    const server = createDecisionServer({
      store,
      evidenceRoot: root,
      repos: [repo],
      clock: () => now,
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (typeof address !== "object" || !address) throw Error("server");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(base + "/login", {
          method: "POST",
          body: new URLSearchParams({ name: who.name, token: password }),
          redirect: "manual",
        }),
        cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      expect(
        (await fetch(base + `/chat/action/${action}`, { redirect: "manual" }))
          .status,
      ).toBe(303);
      const response = await fetch(base + `/chat/action/${action}`, {
          headers: { cookie },
        }),
        html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("I confirm this exact action");
      expect(html).not.toContain('type="password"');
      const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1]!,
        csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
      const post = (fields: Record<string, string>, origin = base) =>
        fetch(base + `/chat/proposal/${action}/confirm`, {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams(fields),
          redirect: "manual",
        });
      expect((await post({ nonce, confirm: "yes" })).status).toBe(403);
      expect(
        (await post({ csrf, nonce, confirm: "yes" }, "https://wrong.example"))
          .status,
      ).toBe(403);
      expect(store.getTask(id)?.state).not.toBe("cancelled");
      const confirmed = await post({ csrf, nonce, confirm: "yes" });
      expect(confirmed.status).toBe(303);
      expect(confirmed.headers.get("location")).toBe(`/chat/action/${action}`);
      const receipt = await (
        await fetch(base + `/chat/action/${action}`, { headers: { cookie } })
      ).text();
      expect(receipt).toContain("Task cancelled.");
      expect(receipt).not.toContain('name="confirm"');
      expect((await post({ csrf, nonce, confirm: "yes" })).status).toBe(303);
      expect(store.getMateProposal(action)?.outcome).toMatchObject({
        ok: true,
        via: "web",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("a redacted short preview must use full secure review, even with a forged direct callback", () => {
    const instructions =
      "Use the reference at /Users/operator/Documents/checklist.md and compare digest " +
      "a".repeat(64) +
      ".";
    const action = proposal("knowledge_instructions", { repo, instructions });
    expect(
      sharedActionNeedsReview(
        prepareSharedAction(
          store,
          who,
          "knowledge_instructions",
          { repo, instructions },
          root,
          now,
        ),
      ),
    ).toBe(true);
    expect(confirm(action)).toMatchObject({
      ok: false,
      reason: "needs-confirm",
    });
    expect(knowledgeView(store, repo, who.name).revision).toBe(0);
    const review = mintSharedActionReview(store, who, action, root, now);
    expect(review.payload.terms.join("\n")).toContain(instructions);
    expect(
      confirmMateProposal(store, who, action, now, {
        via: "web",
        evidenceRoot: root,
        confirm: true,
        actionReview: { nonce: review.nonce, password: "" },
      }),
    ).toMatchObject({ ok: true });
    expect(knowledgeView(store, repo, who.name).knowledge.instructions).toBe(
      instructions,
    );
  });
  test("tool proposals map an admitted project and expose no password or execution authority", () => {
    const draft: Record<string, unknown>[] = [];
    const ctx = {
      store,
      who,
      now,
      step: 1,
      readDecisions: new Map<number, number>(),
      evidenceRoot: root,
      draft: (_kind: unknown, payload: Record<string, unknown>) => {
        draft.push(payload);
        return 1;
      },
    };
    expect(
      executeMateTool(ctx, "propose_action", {
        operation: "knowledge_instructions",
        repo: "r1",
        instructions: "Use clear labels.",
      }),
    ).toMatchObject({ ok: true, body: { executed: false } });
    expect(draft[0]?.["repo"]).toBe(repo);
    expect(
      executeMateTool(ctx, "propose_action", {
        operation: "knowledge_instructions",
        repo: "r1",
        instructions: "bad",
        password: "bad",
      }).ok,
    ).toBe(false);
    expect(
      executeMateTool(ctx, "propose_action", {
        operation: "knowledge_instructions",
        repo: "r2",
        instructions: "bad",
      }).ok,
    ).toBe(false);
    expect(draft).toHaveLength(1);
  });
});
