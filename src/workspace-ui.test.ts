import { describe, expect, test } from "vitest";
import type { DispatchDiagnosis } from "./dispatch.js";
import {
  compareWorkRows,
  evidenceProblemOf,
  failedCheckExit,
  needsPerson,
  parseWorkView,
  primaryDestinationOf,
  publicationStatusOf,
  receiptHeadingOf,
  receiptPublicationWords,
  resultStatusOf,
  workCounts,
  workStatusOf,
  type ResultFacts,
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
    expect(resultStatusOf(built({ verdict: "refuted", reasons: ["claimed changed path not in the sealed diff: src/x.ts"] })).detail).toContain("no check is recorded as failed");
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

  test("an accepted result stays an exception whatever the verdict was — never 'checks passed'", () => {
    for (const verdict of ["refuted", "short", null, "attested", "verified"] as const) {
      const status = resultStatusOf(built({ verdict, reasons: verdict === "refuted" ? ["the repository's approved verification command exited 1"] : [], accepted: true }));
      expect(status).toMatchObject({ token: "accepted-exception", label: "Accepted with an exception", action: { kind: "open-review" } });
      expect(status.detail).toContain("were not passed by the machine");
      expect(status.detail).not.toMatch(/checks passed/i);
    }
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
    expect(weakButPublished.detail).toContain("PR #12 is open on GitHub");
    // The receipt heading: what the record supports, never "shipped".
    expect(receiptHeadingOf("built", null)).toBe("Changes saved");
    expect(receiptHeadingOf("no-change", null)).toBe("No changes were needed");
    expect(receiptHeadingOf("built", pub({}))).toBe("PR opened");
    expect(receiptHeadingOf("built", pub({ remoteState: "MERGED" }))).toBe("Merge observed");
    expect(receiptHeadingOf("built", pub({ state: "pushed" }))).toBe("Changes saved");
    expect(receiptPublicationWords(null)).toBe("Saved on the build branch — not published, merged, or deployed.");
    expect(receiptPublicationWords(pub({}))).toContain("nothing is merged or deployed yet");
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
