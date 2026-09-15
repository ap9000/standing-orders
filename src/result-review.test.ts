import { describe, expect, test } from "vitest";
import { Window } from "happy-dom";
import {
  RESULT_REVIEW_SCRIPT,
  REVIEW_DRAFT_PREFIX,
  RESULT_SCROLL_PREFIX,
  RESULT_FACT_KEYS,
  commentSourceKey,
  evidenceHealthOf,
  evidenceProblemDetailsOf,
  evidenceProblemsOf,
  parseResultTab,
  parseRevisionBatch,
  revisionBatchOf,
  isRevisionFeedback,
  revisionSourceOf,
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
      "The check output was shortened when it was stored; its download holds only the stored part.",
      "Screenshot evidence/b.png no longer verifies (the file's size no longer matches its record) and is not shown.",
      "The proof cites screenshot evidence/c.png, but no validated image was stored.",
      "The report cannot be shown: the report does not verify.",
    ]);
    // Truncation is named as truncation, never as verified — and never as
    // a full download that exists somewhere (repair 2026-09-14).
    const shortened = evidenceProblemDetailsOf({ proofProblem: null, diff: { truncated: true }, stat: { filesTruncated: true }, checkLog: { truncated: true }, screenshots: [], uncapturedScreenshots: [], report: { ok: true, truncated: true }, reportExpected: true, handoffPresent: true, outcome: "no-change" });
    expect(shortened.map(one => one.words)).toEqual([
      "The sealed diff was shortened when it was stored; its download holds only the stored part, not the full change.",
      "The changed-file list was cut short; the counts are complete.",
      "The check output was shortened when it was stored; its download holds only the stored part.",
      "The report was shortened when it was stored; its download holds only the stored part.",
    ]);
    expect(shortened.every(one => one.kind === "shortened")).toBe(true);
    expect(shortened.every(one => !/full download|open the full/i.test(one.words))).toBe(true);
    expect(evidenceHealthOf(shortened)).toEqual({ damaged: 0, shortened: 4, missing: 0 });
    // A check log whose bytes no longer verify is DAMAGED evidence, named
    // in the open, with its output withheld (repair 2026-09-14, finding 3).
    const corrupt = evidenceProblemDetailsOf({ proofProblem: null, diff: { truncated: false }, stat: { filesTruncated: false }, checkLog: { problem: "the file's sha256 no longer matches its record" }, screenshots: [], uncapturedScreenshots: [], report: null, reportExpected: false, handoffPresent: true, outcome: "built" });
    expect(corrupt).toEqual([{ kind: "damaged", words: "The check log no longer verifies (the file's sha256 no longer matches its record); its output is not shown." }]);
    expect(evidenceHealthOf(corrupt)).toEqual({ damaged: 1, shortened: 0, missing: 0 });
    // The kinds behind the full damaged list above: damaged, damaged, damaged, shortened, damaged, missing, damaged.
    expect(evidenceProblemDetailsOf({
      proofProblem: "the proof did not parse",
      diff: { problem: "stored but unverifiable — sha mismatch" },
      stat: { problem: "capture failed — exit 128" },
      checkLog: { truncated: true },
      screenshots: [{ path: "evidence/b.png", caption: "b", artifactId: 2, problem: "altered" }],
      uncapturedScreenshots: ["evidence/c.png"],
      report: { problem: "the report does not verify" },
      reportExpected: true,
      handoffPresent: false,
      outcome: "no-change",
    }).map(one => one.kind)).toEqual(["damaged", "damaged", "damaged", "shortened", "damaged", "missing", "damaged"]);
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
      evidenceHealth: { damaged: 2, shortened: 0, missing: 0 },
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

  test("the revision form's batch names exact note ids and the source terms; anything else fails to parse (repair 2026-09-14)", () => {
    expect(revisionBatchOf([{ id: 3 }, { id: 7 }, { id: 12 }])).toBe("3,7,12");
    expect(revisionBatchOf([])).toBe("");
    expect(parseRevisionBatch("3,7,12")).toEqual([3, 7, 12]);
    expect(parseRevisionBatch(" 3,7 ")).toEqual([3, 7]);
    expect(parseRevisionBatch("3")).toEqual([3]);
    // Absent, empty, malformed, duplicated, zero, or oversized: null — the form is out of date or hand-built.
    expect(parseRevisionBatch(null)).toBeNull();
    expect(parseRevisionBatch(undefined)).toBeNull();
    expect(parseRevisionBatch("")).toBeNull();
    expect(parseRevisionBatch("3,,7")).toBeNull();
    expect(parseRevisionBatch("3,7,")).toBeNull();
    expect(parseRevisionBatch("a,b")).toBeNull();
    expect(parseRevisionBatch("3,3")).toBeNull();
    expect(parseRevisionBatch("0")).toBeNull();
    expect(parseRevisionBatch("-1")).toBeNull();
    expect(parseRevisionBatch(Array.from({ length: 501 }, (_, i) => String(i + 1)).join(","))).toBeNull();
    expect(parseRevisionBatch("9999999999999999")).toBeNull();
    expect(revisionSourceOf(null)).toBe("none");
    expect(revisionSourceOf("57e39dd230be3ddd627944e2d5bfb180")).toBe("57e39dd230be3ddd627944e2d5bfb180");
  });

  test("the browser script binds a request identity to the payload it sent, mints a new one for an edit or a refused conflict, and never rotates an unchanged retry (repair 2026-09-14)", () => {
    // The identity is bound at submit and compared at every input.
    expect(RESULT_REVIEW_SCRIPT).toContain("sent=payload();var draft=read(draftKey);if(draft){draft.sent=sent;write(draftKey,draft);}");
    expect(RESULT_REVIEW_SCRIPT).toContain("if((bound!==null&&current!==bound)||(sent!==null&&current!==sent)){sent=null;if(requestBox)requestBox.value=mint();}");
    // A refusal's way back names the conflicting token; the words stay, the token goes.
    expect(RESULT_REVIEW_SCRIPT).toContain("if(saved&&conflict&&saved.request===conflict){saved.request=mint();saved.sent=null;write(draftKey,saved);}");
    // Minting uses the platform's randomness in the server's own 32-hex shape.
    expect(RESULT_REVIEW_SCRIPT).toContain("crypto.getRandomValues(bytes)");
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

 test("revision batches distinguish requested changes from review information", () => {
  expect(isRevisionFeedback({ reviewerRun: null, severity: null })).toBe(true);
  expect(isRevisionFeedback({ reviewerRun: 9, severity: "problem" })).toBe(true);
  for (const severity of [null, "note", "question"]) expect(isRevisionFeedback({ reviewerRun: 9, severity })).toBe(false);
});

test("selecting a reviewer observation preserves a draft unless its replacement is confirmed", async () => {
  const window = new Window({ url: "http://fixture/chat?task=root&result=1" });
  try {
    window.document.body.innerHTML = `<section data-result-panel data-result-user="alex" data-result-task="root" data-result-run="1"><button class="pick-file" data-path="new.ts" data-line="2" data-review-note="Should the name change?">Request change</button><form id="comment-form"><textarea name="note" maxlength="500">Keep my draft</textarea><input name="path" value="old.ts"><input name="line" value="1"><input name="request" value="${"a".repeat(32)}"></form></section>`;
    window.HTMLElement.prototype.scrollIntoView = () => undefined;
    window.confirm = () => false;
    window.eval(RESULT_REVIEW_SCRIPT);
    const button = window.document.querySelector("button")!;
    const note = window.document.querySelector("textarea")!;
    const path = window.document.querySelector<HTMLInputElement>('input[name="path"]')!;
    button.click();
    expect(note.value).toBe("Keep my draft");
    expect(path.value).toBe("old.ts");
    window.confirm = () => true;
    button.click();
    expect(note.value).toBe("Should the name change?");
    expect(path.value).toBe("new.ts");
    expect(window.sessionStorage.getItem(`${REVIEW_DRAFT_PREFIX}alex:root:1`)).toContain("Should the name change?");
  } finally { await window.happyDOM.close(); }
});
