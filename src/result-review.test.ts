import { describe, expect, test } from "vitest";
import {
  RESULT_REVIEW_SCRIPT,
  REVIEW_DRAFT_PREFIX,
  RESULT_SCROLL_PREFIX,
  RESULT_FACT_KEYS,
  commentSourceKey,
  evidenceProblemsOf,
  parseResultTab,
  resultFactsAttributes,
  resultFactsFromHtml,
  resultLeadOf,
  resultReturnTarget,
  type SharedResultFacts,
} from "./result-review.js";

describe("result-first review (workspace package 3): the pure presentation rules", () => {
  test("the local view comes from the URL and anything unknown reads as Summary", () => {
    expect(parseResultTab("changes")).toBe("changes");
    expect(parseResultTab("checks")).toBe("checks");
    expect(parseResultTab("summary")).toBe("summary");
    expect(parseResultTab(null)).toBe("summary");
    expect(parseResultTab(undefined)).toBe("summary");
    expect(parseResultTab("<script>")).toBe("summary");
    expect(parseResultTab("CHANGES")).toBe("summary");
  });

  test("the deliverable leads by the records present, never by the outcome word", () => {
    // A scout's report leads even beside a diff and screenshots.
    expect(resultLeadOf({ role: "scout", report: true, screenshots: 2, diff: true })).toBe("report");
    expect(resultLeadOf({ role: "builder", report: true, screenshots: 0, diff: true })).toBe("report");
    // Validated screenshots lead UI work; unverifiable ones were not counted by the caller.
    expect(resultLeadOf({ role: "builder", report: false, screenshots: 1, diff: true })).toBe("screenshots");
    // A sealed diff with files leads code work; nothing captured leaves the handoff.
    expect(resultLeadOf({ role: "builder", report: false, screenshots: 0, diff: true })).toBe("changes");
    expect(resultLeadOf({ role: "builder", report: false, screenshots: 0, diff: false })).toBe("summary");
  });

  test("every evidence problem is named in plain words, in a stable order, and a whole record names none", () => {
    const whole = evidenceProblemsOf({
      proofProblem: null,
      diff: { truncated: false },
      stat: { filesTruncated: false },
      checkLog: { truncated: false },
      screenshots: [{ path: "evidence/a.png", caption: "a", artifactId: 1, problem: null }],
      uncapturedScreenshots: [],
      report: null,
      reportExpected: false,
      handoffPresent: true,
      outcome: "built",
    });
    expect(whole).toEqual([]);
    const damaged = evidenceProblemsOf({
      proofProblem: "the proof did not parse",
      diff: { problem: "stored but unverifiable — sha mismatch" },
      stat: { problem: "capture failed — exit 128" },
      checkLog: { truncated: true },
      screenshots: [
        { path: "evidence/a.png", caption: "a", artifactId: 1, problem: null },
        { path: "evidence/b.png", caption: "b", artifactId: 2, problem: "the file's size no longer matches its record" },
      ],
      uncapturedScreenshots: ["evidence/c.png"],
      report: { problem: "the report does not verify" },
      reportExpected: true,
      handoffPresent: false,
      outcome: "no-change",
    });
    expect(damaged).toEqual([
      "The agent's proof cannot be shown: the proof did not parse.",
      "The sealed diff is unavailable: stored but unverifiable — sha mismatch.",
      "The change summary is unavailable: capture failed — exit 128.",
      "The check output was shortened when it was stored.",
      "Screenshot evidence/b.png no longer verifies (the file's size no longer matches its record) and is not shown.",
      "The proof cites screenshot evidence/c.png, but no validated image was stored.",
      "The report cannot be shown: the report does not verify.",
    ]);
    // Truncation is named as truncation, never as verified.
    expect(evidenceProblemsOf({ proofProblem: null, diff: { truncated: true }, stat: { filesTruncated: true }, checkLog: null, screenshots: [], uncapturedScreenshots: [], report: null, reportExpected: false, handoffPresent: true, outcome: "built" })).toEqual([
      "The sealed diff was shortened when it was stored; review the full download before relying on it.",
      "The changed-file list was cut short; the counts are complete.",
    ]);
    // A no-change conclusion owes its two records — unless it is an investigation, which owes a report instead.
    expect(evidenceProblemsOf({ proofProblem: null, diff: null, stat: null, checkLog: null, screenshots: [], uncapturedScreenshots: [], report: null, reportExpected: false, handoffPresent: false, outcome: "no-change" })).toEqual([
      "No sealed diff was captured, so the no-change conclusion is not verified.",
      "The no-change conclusion has no handoff record.",
    ]);
    expect(evidenceProblemsOf({ proofProblem: null, diff: null, stat: null, checkLog: null, screenshots: [], uncapturedScreenshots: [], report: null, reportExpected: true, handoffPresent: true, outcome: "no-change" })).toEqual([
      "This investigation stored no report.",
    ]);
  });

  test("the shared facts stamp deterministically, escape, and read back; presentation attributes are not facts", () => {
    const facts: SharedResultFacts = {
      runId: 12,
      base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      head: "9e07b4152aa01c9f3d7700e54bf8d69288fbe777",
      headSource: "sealed diff",
      checks: { passed: 2, total: 3 },
      caveats: ["one"],
      evidenceProblems: ["a", "b"],
      publicationState: 'opened"><script>',
      publicationWords: "PR #7 was last seen open.",
    };
    const attributes = resultFactsAttributes(facts);
    expect(attributes).toBe(
      ' data-result-run="12" data-result-head="9e07b4152aa0" data-result-base="4b825dc642cb" data-result-head-source="sealed diff" data-result-checks="2/3" data-result-caveats="1" data-result-evidence="problems:2" data-result-publication="opened&quot;&gt;&lt;script&gt;"',
    );
    expect(attributes).not.toContain("<script>");
    const html = `<section class="card" data-result-panel data-result-place="run" data-result-lead="screenshots" data-result-task="t" data-result-user="alex"${attributes}></section><p data-result-run="12" data-result-head="9e07b4152aa0" data-result-base="4b825dc642cb" data-result-head-source="sealed diff" data-result-checks="2/3" data-result-caveats="1" data-result-evidence="problems:2" data-result-publication="opened&quot;&gt;&lt;script&gt;"></p>`;
    const read = resultFactsFromHtml(html);
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual({ run: "12", head: "9e07b4152aa0", base: "4b825dc642cb", "head-source": "sealed diff", checks: "2/3", caveats: "1", evidence: "problems:2", publication: 'opened"><script>' });
    expect(JSON.stringify(read[0])).toBe(JSON.stringify(read[1]));
    expect(Object.keys(read[0] ?? {})).toEqual([...RESULT_FACT_KEYS]);
    // Absent commits and rubric read as empty and "none", never as a guess.
    const bare = resultFactsAttributes({ ...facts, base: null, head: null, headSource: null, checks: null, caveats: [], evidenceProblems: [], publicationState: "none" });
    expect(bare).toContain('data-result-head="" data-result-base="" data-result-head-source="none" data-result-checks="none" data-result-caveats="0" data-result-evidence="ok" data-result-publication="none"');
  });

  test("a form's way back is one of three exact shapes — never an open redirect, never another run's result view", () => {
    expect(resultReturnTarget("/review?result=t-1", 5)).toBe("/review?result=t-1");
    expect(resultReturnTarget("/chat?task=t-1&result=5", 5)).toBe("/chat?task=t-1&result=5");
    expect(resultReturnTarget("/chat?task=t-1&result=6", 5)).toBe("/r/5");
    expect(resultReturnTarget("/chat?task=t-1&result=5&tab=checks", 5)).toBe("/r/5");
    expect(resultReturnTarget("https://evil.example/review?result=t-1", 5)).toBe("/r/5");
    expect(resultReturnTarget("//evil.example/review?result=t-1", 5)).toBe("/r/5");
    expect(resultReturnTarget("/review?result=t-1\n", 5)).toBe("/r/5");
    expect(resultReturnTarget(null, 5)).toBe("/r/5");
    expect(resultReturnTarget(undefined, 5)).toBe("/r/5");
  });

  test("a note's dedupe key binds the account and the form's request token, and only a real token earns one", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(commentSourceKey("alex", token)).toBe(`review:alex:${token}`);
    expect(commentSourceKey("sam", token)).toBe(`review:sam:${token}`);
    expect(commentSourceKey("alex", "short")).toBeUndefined();
    expect(commentSourceKey("alex", token.toUpperCase())).toBeUndefined();
    expect(commentSourceKey("alex", null)).toBeUndefined();
    expect(commentSourceKey("alex", undefined)).toBeUndefined();
  });

  test("the browser script keeps drafts and positions under the account, task, and run; it never fetches or submits by itself", () => {
    expect(RESULT_REVIEW_SCRIPT).toContain(`'${REVIEW_DRAFT_PREFIX}'`);
    expect(RESULT_REVIEW_SCRIPT).toContain(`'${RESULT_SCROLL_PREFIX}'`);
    expect(RESULT_REVIEW_SCRIPT).toContain("draftPrefix+user+':'+task+':'+run");
    // Other accounts' entries on the same tab are dropped, never restored.
    expect(RESULT_REVIEW_SCRIPT).toContain("(user&&owner!==user))sessionStorage.removeItem(k)");
    // The draft clears only on the receipt for ITS request token.
    expect(RESULT_REVIEW_SCRIPT).toContain("if(saved&&noted&&saved.request===noted){write(draftKey,null);saved=null;}");
    // Tabs switch in place and record the view in the URL.
    expect(RESULT_REVIEW_SCRIPT).toContain("url.searchParams.set('tab',name)");
    // Presentation and bounded drafts only: no network, no programmatic submit.
    expect(RESULT_REVIEW_SCRIPT).not.toMatch(/\bfetch\(/);
    expect(RESULT_REVIEW_SCRIPT).not.toMatch(/XMLHttpRequest|\.submit\(\)|requestSubmit/);
    expect(RESULT_REVIEW_SCRIPT).not.toContain("innerHTML");
  });
});
