import { describe, expect, test } from "vitest";
import type { DispatchAction, DispatchDiagnosis } from "./dispatch.js";
import {
  compareWorkRows,
  dispatchActionLabel,
  evidenceProblemOf,
  failedCheckExit,
  needsPerson,
  parseWorkView,
  primaryDestinationOf,
  publicationStatusOf,
  receiptHeadingOf,
  receiptPublicationWords,
  resultStatusOf,
  reviewFactsOf,
  reviewStatusOf,
  workCounts,
  workStatusOf,
  type ResultFacts,
  type ReviewFacts,
  type WorkFacts,
} from "./workspace-ui.js";

const built = (over: Partial<ResultFacts> = {}): ResultFacts => ({ runId: 7, role: "builder", outcome: "built", verdict: "verified", reasons: ["the approved verification command passed"], accepted: false, ...over });
const diagnosis = (over: Partial<DispatchDiagnosis>): DispatchDiagnosis => ({ condition: "waiting", code: "needs-approval", summary: "Needs your approval", detail: "Review and sign the current scope before a worker can claim it.", action: "approve-scope", nextAt: null, role: "builder", blockerTaskId: null, review: null, ...over });
const facts = (over: Partial<WorkFacts>): WorkFacts => ({ id: "t", title: "t", repo: "/repo", state: "queued", updatedAt: "2026-09-13T12:00:00.000Z", dispatch: null, result: null, publication: null, liveRunId: null, ...over });

describe("the shared status projection (workspace package 1)", () => {
  test("a refuted verdict is a failed check only when the verify command's own reason says so; otherwise it is mismatched evidence", () => {
    expect(evidenceProblemOf("refuted", ["the repository's approved verification command exited 1"])).toBe("checks-failed");
    expect(evidenceProblemOf("refuted", ["the repository's approved verification command exited 2 after the approved setup command was replayed"])).toBe("checks-failed");
    expect(evidenceProblemOf("refuted", ["claimed changed path not in the sealed diff: src/x.ts"])).toBe("mismatched");
    expect(evidenceProblemOf("refuted", ['criterion "c1" was signed as "a" and the proof restates it as "b"'])).toBe("mismatched");
    expect(evidenceProblemOf("refuted", [])).toBe("mismatched");
    expect(evidenceProblemOf("short", ["no proof was written"])).toBe("missing");
    expect(evidenceProblemOf(null, [])).toBe("missing");
    expect(evidenceProblemOf("attested", [])).toBe("none");
    expect(evidenceProblemOf("verified", [])).toBe("none");
    expect(failedCheckExit(["the repository's approved verification command exited 3"])).toBe(3);
    expect(failedCheckExit(["claimed changed path not in the sealed diff: src/x.ts"])).toBeNull();
  });

  test("each finished-evidence state has its own words, and none of the weak ones reads as verified", () => {
    expect(resultStatusOf(built({ verdict: "refuted", reasons: ["the repository's approved verification command exited 1"] }))).toMatchObject({ token: "checks-failed", label: "Changes saved, but checks failed", tone: "problem", action: { kind: "open-review" } });
    expect(resultStatusOf(built({ verdict: "refuted", reasons: ["the repository's approved verification command exited 1"] })).detail).toContain("(exit 1)");
    expect(resultStatusOf(built({ verdict: "refuted", reasons: ["claimed changed path not in the sealed diff: src/x.ts"] }))).toMatchObject({ token: "evidence-mismatch", label: "Result saved, but its evidence does not match", tone: "problem" });
    // A structural refutation is settled before the approved check is
    // weighed, so it neither claims a failed check nor denies one.
    const mismatch = resultStatusOf(built({ verdict: "refuted", reasons: ["claimed changed path not in the sealed diff: src/x.ts"] })).detail;
    expect(mismatch).toContain("Whether the approved check passed is not settled by this verdict.");
    expect(mismatch).not.toMatch(/no check (is recorded as|has) failed|checks failed/i);
    expect(resultStatusOf(built({ verdict: "short", reasons: ["no proof was written"] }))).toMatchObject({ token: "verification-needed", label: "Result saved — verification needed", tone: "problem" });
    expect(resultStatusOf(built({ verdict: null, reasons: [] }))).toMatchObject({ token: "verification-needed", label: "Result saved — verification needed" });
    expect(resultStatusOf(built({ verdict: "attested", reasons: [] }))).toMatchObject({ token: "agent-attested", label: "Result saved — checks reported by the agent", tone: "neutral" });
    expect(resultStatusOf(built())).toMatchObject({ token: "ready-to-review", label: "Ready to review", tone: "ready", action: { kind: "open-result" } });
    expect(resultStatusOf(null)).toMatchObject({ token: "no-build-record", label: "Marked done without a build record", tone: "problem" });
    expect(resultStatusOf(built({ role: "scout" }))).toMatchObject({ token: "report-ready", label: "Report ready" });
    for (const weak of [
      built({ verdict: "refuted", reasons: ["the repository's approved verification command exited 1"] }),
      built({ verdict: "short", reasons: [] }),
      built({ verdict: null, reasons: [] }),
      built({ verdict: "attested", reasons: [] }),
    ]) {
      const status = resultStatusOf(weak);
      expect(status.label).not.toMatch(/verified|ready to review|checks passed/i);
    }
  });

  test("an accepted result stays an exception whatever the verdict was — never 'checks passed', and never a claim the checks failed", () => {
    // Acceptance is a person's decision on record; it neither proves nor
    // disproves the checks. The machine's own verdict is restated exactly.
    const machine: Record<string, string> = {
      refuted: "the approved check failed against it (exit 1)",
      short: "its required evidence was missing",
      none: "its required evidence was missing",
      attested: "the checks on record are the agent's own report",
      verified: "it verified the result before the acceptance",
    };
    for (const verdict of ["refuted", "short", null, "attested", "verified"] as const) {
      const status = resultStatusOf(built({ verdict, reasons: verdict === "refuted" ? ["the repository's approved verification command exited 1"] : [], accepted: true }));
      expect(status).toMatchObject({ token: "accepted-exception", label: "Accepted with an exception", action: { kind: "open-review" } });
      expect(status.detail).toContain(`The machine's verdict is unchanged: ${machine[verdict ?? "none"]}.`);
      expect(status.detail).not.toMatch(/checks passed|not passed by the machine/i);
    }
    const mismatchAccepted = resultStatusOf(built({ verdict: "refuted", reasons: ["claimed changed path not in the sealed diff: src/x.ts"], accepted: true }));
    expect(mismatchAccepted.detail).toContain("its evidence did not match the sealed record");
    expect(mismatchAccepted.detail).not.toMatch(/check failed|checks failed/i);
  });

  test("a review in flight leads on every surface, keeps the earlier verdict as history, and never masks an accepted, scout, or older result", () => {
    const review = (over: Partial<ReviewFacts>): ReviewFacts => ({ state: "queued", attempt: 1, cap: 3, attempts: 0, retriesRemaining: 2, latestReason: null, interrupted: false, queuedBy: "operator", reviewerAlive: false, ...over });
    expect(reviewStatusOf(null)).toBeNull();
    expect(reviewStatusOf(review({ state: "unrequested" }))).toBeNull();
    expect(reviewStatusOf(review({ state: "succeeded", attempt: 2, attempts: 2 }))).toBeNull();
    expect(reviewStatusOf(review({}))).toMatchObject({ token: "review-pending", label: "Waiting for review", tone: "attention", action: { kind: "open-result" } });
    expect(reviewStatusOf(review({ attempt: 2, attempts: 1, retriesRemaining: 1 }))).toMatchObject({ token: "review-pending", label: "Review retry queued (attempt 2 of 3)" });
    expect(reviewStatusOf(review({ attempt: 2, attempts: 1, retriesRemaining: 1 }))?.detail).toContain("asked by operator");
    expect(reviewStatusOf(review({ state: "running", attempts: 1, reviewerAlive: true }))).toMatchObject({ token: "reviewing", label: "Reviewing", tone: "live" });
    expect(reviewStatusOf(review({ state: "running", attempt: 2, attempts: 2, reviewerAlive: true }))).toMatchObject({ token: "reviewing", label: "Reviewing (retry 1 of 2)" });
    expect(reviewStatusOf(review({ state: "running", attempts: 1, reviewerAlive: false }))).toMatchObject({ token: "review-failed", label: "Review interrupted", tone: "attention" });
    const failed = reviewStatusOf(review({ state: "retryable", attempts: 1, latestReason: "reviewer-ingestion: database busy" }));
    expect(failed).toMatchObject({ token: "review-failed", label: "Review failed — retry available", action: { kind: "open-review" } });
    expect(failed?.detail).toContain("Review attempt 1 of 3 failed (reviewer-ingestion: database busy)");
    expect(reviewStatusOf(review({ state: "retryable", attempts: 1, interrupted: true }))).toMatchObject({ label: "Review interrupted — retry available" });
    const exhausted = reviewStatusOf(review({ state: "exhausted", attempt: 3, attempts: 3, retriesRemaining: 0, latestReason: "reviewer-agent" }));
    expect(exhausted).toMatchObject({ token: "review-exhausted", label: "Review retries exhausted" });
    expect(exhausted?.detail).toContain("All 3 review attempts ended without a review (latest: reviewer-agent)");

    // Inside the result projection: the review is primary, the stored
    // verdict is the secondary history — for a verified AND a refuted result.
    const pendingVerified = resultStatusOf(built({ review: review({}) }));
    expect(pendingVerified).toMatchObject({ token: "review-pending", label: "Waiting for review", tone: "attention" });
    expect(pendingVerified.detail).toContain('Until the review settles, the earlier verdict — "Ready to review" — stays on record as history.');
    const runningRefuted = resultStatusOf(built({ verdict: "refuted", reasons: ["the repository's approved verification command exited 1"], review: review({ state: "running", attempts: 1, reviewerAlive: true }) }));
    expect(runningRefuted).toMatchObject({ token: "reviewing", label: "Reviewing" });
    expect(runningRefuted.detail).toContain('the earlier verdict — "Changes saved, but checks failed" — stays on record');
    // A review that never was, or already succeeded, changes nothing.
    expect(resultStatusOf(built({ review: null })).token).toBe("ready-to-review");
    expect(resultStatusOf(built({ review: review({ state: "succeeded", attempt: 1, attempts: 1 }) })).token).toBe("ready-to-review");
    // Acceptance closes the matter; a scout is never reviewed.
    expect(resultStatusOf(built({ accepted: true, review: review({}) })).token).toBe("accepted-exception");
    expect(resultStatusOf(built({ role: "scout", review: review({}) })).token).toBe("report-ready");
    // A published result under review still leads with the review.
    expect(resultStatusOf(built({ review: review({}) }), { state: "opened", prNumber: 12, prUrl: "https://github.com/o/r/pull/12", remoteState: null, lastCheckState: null }).token).toBe("review-pending");

    // The facts come from the store's retry projection, read per run.
    const attempt = { runId: 30, attempt: 1, outcome: null, reason: null, runner: "reviewer-1", provider: "claude", model: null, startedAt: "2026-09-13T12:00:00.000Z", finishedAt: null, requestId: 5 };
    const running = reviewFactsOf({ cap: 3, attempts: [attempt], openRequest: null, live: attempt, latest: attempt, succeeded: null, state: "running", retriesUsed: 0, retriesRemaining: 2, nextAttempt: null }, runner => runner === "reviewer-1");
    expect(running).toMatchObject({ state: "running", attempt: 1, attempts: 1, reviewerAlive: true, queuedBy: null });
    const queued = reviewFactsOf({ cap: 3, attempts: [], openRequest: { id: 5, requestedBy: "alex", basis: "human", origin: "operator", requestedAt: "2026-09-13T12:00:00.000Z" }, live: null, latest: null, succeeded: null, state: "queued", retriesUsed: 0, retriesRemaining: 2, nextAttempt: 1 }, () => true);
    expect(queued).toMatchObject({ state: "queued", attempt: 1, queuedBy: "alex", reviewerAlive: false });
    expect(reviewFactsOf(null, () => true)).toBeNull();
    expect(reviewFactsOf({ cap: 3, attempts: [], openRequest: null, live: null, latest: null, succeeded: null, state: "unrequested", retriesUsed: 0, retriesRemaining: 2, nextAttempt: 1 }, () => true)).toBeNull();

    // Work rows: the review's own token, running only while a reviewer is
    // live; the dispatch fallback stays for callers that read no review facts.
    const pendingRow = workStatusOf(facts({ state: "done", result: built({ review: review({}) }), dispatch: diagnosis({ condition: "waiting", code: "review-pending", summary: "Waiting for review", action: "open-result" }) }));
    expect(pendingRow).toMatchObject({ token: "review-pending", label: "Waiting for review", views: ["all", "needs-you", "completed"] });
    const reviewingRow = workStatusOf(facts({ state: "done", result: built({ review: review({ state: "running", attempts: 1, reviewerAlive: true }) }), dispatch: diagnosis({ condition: "running", code: "reviewing", summary: "Reviewing", action: "open-result" }) }));
    expect(reviewingRow).toMatchObject({ token: "reviewing", tone: "live", views: ["all", "running", "completed"], rank: 1 });
    const olderRow = workStatusOf(facts({ state: "done", result: built({ review: null }), dispatch: diagnosis({ condition: "terminal", code: "complete", action: "open-result" }) }));
    expect(olderRow.token).toBe("ready-to-review");
  });

  test("a no-change conclusion never masks a refuted or short proof, and reads its two records only without a verdict", () => {
    expect(resultStatusOf(built({ outcome: "no-change", verdict: "refuted", reasons: ["a criterion cites a file that did not change"] })).token).toBe("evidence-mismatch");
    expect(resultStatusOf(built({ outcome: "no-change", verdict: "short", reasons: [] })).token).toBe("verification-needed");
    expect(resultStatusOf(built({ outcome: "no-change", verdict: "attested", reasons: [], recordComplete: false }))).toMatchObject({ token: "no-change", label: "No changes were needed", tone: "done" });
    expect(resultStatusOf(built({ outcome: "no-change", verdict: null, reasons: [], recordComplete: true }))).toMatchObject({ token: "no-change" });
    expect(resultStatusOf(built({ outcome: "no-change", verdict: null, reasons: [] }))).toMatchObject({ token: "no-change" });
    expect(resultStatusOf(built({ outcome: "no-change", verdict: null, reasons: [], recordComplete: false }))).toMatchObject({ token: "record-incomplete", label: "No-change result, record incomplete", tone: "problem" });
  });

  test("publication facts are distinct: pushed, PR opened, merge observed, closed — and no record ever says deployed", () => {
    const pub = (over: Record<string, unknown>) => ({ state: "opened", prNumber: 12, prUrl: "https://github.com/o/r/pull/12", remoteState: null, lastCheckState: null, ...over });
    expect(publicationStatusOf(null)).toBeNull();
    expect(publicationStatusOf(pub({ state: "intended" }))).toMatchObject({ token: "publication-pending", label: "Publication requested" });
    expect(publicationStatusOf(pub({ state: "pushed" }))).toMatchObject({ token: "branch-pushed", label: "Branch pushed" });
    expect(publicationStatusOf(pub({}))).toMatchObject({ token: "pr-opened", label: "PR opened" });
    expect(publicationStatusOf(pub({ lastCheckState: "failing" }))?.detail).toContain("CI was last seen failing");
    expect(publicationStatusOf(pub({ remoteState: "MERGED" }))).toMatchObject({ token: "merge-observed", label: "Merge observed" });
    expect(publicationStatusOf(pub({ remoteState: "MERGED" }))?.detail).toContain("Deployment is not confirmed");
    expect(publicationStatusOf(pub({ remoteState: "CLOSED" }))).toMatchObject({ token: "pr-closed", label: "PR closed without merging" });
    expect(publicationStatusOf(pub({ state: "failed" }))).toMatchObject({ token: "publication-failed" });
    for (const one of [pub({}), pub({ state: "pushed" }), pub({ remoteState: "MERGED" }), pub({ state: "failed" })]) {
      expect(publicationStatusOf(one)?.label).not.toMatch(/deployed|shipped/i);
    }
    // Only a VERIFIED result lets the publication name the main wording;
    // a published weak result keeps its problem as the headline and the
    // publication in the detail.
    expect(resultStatusOf(built(), pub({}))).toMatchObject({ token: "pr-opened", label: "PR opened", action: { kind: "open-pr" } });
    expect(resultStatusOf(built(), pub({ remoteState: "MERGED" }))).toMatchObject({ token: "merge-observed", label: "Merge observed" });
    const weakButPublished = resultStatusOf(built({ verdict: "short", reasons: [] }), pub({}));
    expect(weakButPublished).toMatchObject({ token: "verification-needed" });
    expect(weakButPublished.detail).toContain("PR #12 was last seen open on GitHub. No merge or deployment is recorded here.");
    // Publication words claim only what was recorded or last observed:
    // no "nothing merged", no "manual-only merge" — an authorized mode may
    // merge on green, and a stale observation proves nothing either way.
    for (const one of [null, pub({}), pub({ state: "pushed" }), pub({ state: "intended" }), pub({ state: "failed" }), pub({ remoteState: "CLOSED" }), pub({ remoteState: "MERGED" })]) {
      const words = one === null ? receiptPublicationWords(null) : publicationStatusOf(one)?.detail ?? "";
      expect(words).not.toMatch(/nothing (is|was) merged|person's act|not published, merged, or deployed|stays a person/i);
      expect(words).toMatch(/recorded|reports|reached the remote|not confirmed/);
    }
    // The receipt heading: what the record supports, never "shipped".
    expect(receiptHeadingOf("built", null)).toBe("Changes saved");
    expect(receiptHeadingOf("no-change", null)).toBe("No changes were needed");
    expect(receiptHeadingOf("built", pub({}))).toBe("PR opened");
    expect(receiptHeadingOf("built", pub({ remoteState: "MERGED" }))).toBe("Merge observed");
    expect(receiptHeadingOf("built", pub({ state: "pushed" }))).toBe("Changes saved");
    expect(receiptPublicationWords(null)).toBe("Saved on the build branch. No publication, merge, or deployment is recorded here.");
    expect(receiptPublicationWords(pub({}))).toContain("No merge or deployment is recorded here.");
    expect(publicationStatusOf(pub({ remoteState: "CLOSED" }))?.detail).toBe("GitHub last reported PR #12 closed without a merge. No merge or deployment is recorded here.");
  });

  test("navigation CTAs name the available help for each diagnosis without claiming to resume work", () => {
    const labels: Record<DispatchAction, string> = {
      "open-result": "Review the result", "retry-task": "Review and retry",
      "place-task": "Choose a project", "write-scope": "Define the task",
      "select-agent": "Choose an agent", "approve-scope": "Review and approve",
      "answer-decision": "Answer the question", unhold: "Review hold",
      "inspect-hold": "Review hold", "repair-dependency": "Review required task",
      "repair-capability": "Review missing requirement", "start-worker": "Check connection",
      "retry-review": "Review retry options", "resume-run": "Review pause",
    };
    for (const [action, label] of Object.entries(labels)) {
      const dispatch = diagnosis({ action: action as DispatchAction });
      expect(dispatchActionLabel(dispatch), action).toBe(label);
      expect(workStatusOf(facts({ dispatch })).action, action).toEqual({ label, kind: "open-task" });
    }
    expect(dispatchActionLabel(null)).toBe("View task details");
    expect(dispatchActionLabel(diagnosis({ action: null }))).toBe("View task details");
  });

  test("Work views are shortcuts over the same rows: needs-you follows the diagnosis's action semantics, running the live claim, completed the done state", () => {
    expect(needsPerson(null)).toBe(false);
    expect(needsPerson(diagnosis({}))).toBe(true);
    expect(needsPerson(diagnosis({ condition: "waiting", code: "waiting-dependency", action: null }))).toBe(false);
    expect(needsPerson(diagnosis({ condition: "retrying", code: "ready", action: null }))).toBe(false);
    expect(needsPerson(diagnosis({ condition: "terminal", code: "failed", action: "retry-task" }))).toBe(true);
    expect(needsPerson(diagnosis({ condition: "terminal", code: "complete", action: "open-result" }))).toBe(false);
    expect(needsPerson(diagnosis({ condition: "terminal", code: "cancelled", action: null }))).toBe(false);

    const approval = workStatusOf(facts({ dispatch: diagnosis({}) }));
    expect(approval).toMatchObject({ token: "needs-approval", label: "Needs your approval", tone: "attention", views: ["all", "needs-you"], action: { label: "Review and approve", kind: "open-task" } });
    const queued = workStatusOf(facts({ dispatch: diagnosis({ condition: "retrying", code: "ready", summary: "Ready to run", action: null }) }));
    expect(queued).toMatchObject({ token: "ready", views: ["all"], action: null });
    const waiting = workStatusOf(facts({ dispatch: diagnosis({ condition: "waiting", code: "waiting-dependency", summary: "Waiting for another task", action: null }) }));
    expect(waiting.views).toEqual(["all"]);
    const paused = workStatusOf(facts({ dispatch: diagnosis({ code: "stopped", summary: "Paused", action: "resume-run" }) }));
    expect(paused).toMatchObject({ token: "stopped", label: "Paused", views: ["all", "needs-you"] });
    const running = workStatusOf(facts({ state: "running", liveRunId: 9, dispatch: diagnosis({ condition: "running", code: "running", summary: "Running now", action: null }) }));
    expect(running).toMatchObject({ token: "running", tone: "live", views: ["all", "running"], action: { kind: "open-run" } });
    const failed = workStatusOf(facts({ state: "failed", dispatch: diagnosis({ condition: "terminal", code: "failed", summary: "Needs a retry", action: "retry-task" }) }));
    expect(failed).toMatchObject({ token: "failed", tone: "problem", views: ["all", "needs-you"] });
    const cancelled = workStatusOf(facts({ state: "cancelled", dispatch: diagnosis({ condition: "terminal", code: "cancelled", summary: "Cancelled", action: null }) }));
    expect(cancelled).toMatchObject({ token: "cancelled", tone: "muted", views: ["all"], action: null });

    // Done rows take the result projection; a problem is also needs-you
    // exactly when the diagnosis says a person must act.
    const checksFailed = workStatusOf(facts({ state: "done", result: built({ verdict: "refuted", reasons: ["the repository's approved verification command exited 1"] }), dispatch: diagnosis({ condition: "waiting", code: "proof-refuted", action: "open-result" }) }));
    expect(checksFailed).toMatchObject({ token: "checks-failed", views: ["all", "needs-you", "completed"] });
    const accepted = workStatusOf(facts({ state: "done", result: built({ verdict: "short", reasons: [], accepted: true }), dispatch: diagnosis({ condition: "terminal", code: "complete", action: "open-result" }) }));
    expect(accepted).toMatchObject({ token: "accepted-exception", views: ["all", "completed"] });
    const verified = workStatusOf(facts({ state: "done", result: built(), dispatch: diagnosis({ condition: "terminal", code: "complete", action: "open-result" }) }));
    expect(verified).toMatchObject({ token: "ready-to-review", views: ["all", "completed"] });
    // A review in flight outranks the stored verdict and is running.
    const reviewing = workStatusOf(facts({ state: "done", result: built(), dispatch: diagnosis({ condition: "running", code: "reviewing", summary: "Reviewing", action: "open-result" }) }));
    expect(reviewing).toMatchObject({ token: "reviewing", label: "Reviewing", tone: "live", views: ["all", "running", "completed"] });
    // Unknown dispatch never crashes a row.
    expect(workStatusOf(facts({}))).toMatchObject({ token: "unknown", label: "Status unknown", views: ["all"] });

    expect(workCounts([approval, queued, running, failed, cancelled, checksFailed, accepted, verified, reviewing])).toEqual({ all: 9, "needs-you": 3, running: 2, completed: 4 });
    // All's order: what needs a person, then live, then queued, then done, then cancelled; ties newest first.
    const sorted = [cancelled, verified, queued, running, approval].map(status => ({ rank: status.rank, updatedAt: "2026-09-13T12:00:00.000Z", token: status.token })).sort(compareWorkRows).map(one => one.token);
    expect(sorted).toEqual(["needs-approval", "running", "ready", "ready-to-review", "cancelled"]);
    expect([{ rank: 0, updatedAt: "2026-09-13T11:00:00.000Z" }, { rank: 0, updatedAt: "2026-09-13T12:00:00.000Z" }].sort(compareWorkRows)[0]?.updatedAt).toBe("2026-09-13T12:00:00.000Z");
  });

  test("the shell maps every page key onto chat, work, projects, or settings; unknown views fall back to All", () => {
    for (const key of ["inbox", "board", "queue", "work", "done", "activity", "review", "tasks", "runs", "workbench", "routines", "recipes", "ledger"]) expect(primaryDestinationOf(key), key).toBe("work");
    for (const key of ["fleet", "caps", "people", "mode", "system", "settings"]) expect(primaryDestinationOf(key), key).toBe("settings");
    expect(primaryDestinationOf("chat")).toBe("chat");
    expect(primaryDestinationOf("projects")).toBe("projects");
    expect(primaryDestinationOf("menu")).toBeNull();
    expect(primaryDestinationOf("none")).toBeNull();
    expect(parseWorkView(null)).toBe("all");
    expect(parseWorkView("bogus")).toBe("all");
    expect(parseWorkView("needs-you")).toBe("needs-you");
    expect(parseWorkView("running")).toBe("running");
    expect(parseWorkView("completed")).toBe("completed");
  });
});
