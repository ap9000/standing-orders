import { describe, test, expect } from "vitest";
import { parseDecision, repairPrompt, LIMITS } from "./decision.js";

const sound = {
  urgency: "blocking",
  recap: "Tightening the onboarding form. The migration drops signup_source, which analytics reads.",
  question: "Drop the column, or keep it and backfill?",
  options: [
    { id: "keep", label: "Keep + backfill", consequence: "Analytics unaffected. +1 migration.", reversible: true },
    { id: "drop", label: "Drop it", consequence: "3 dashboards break silently.", reversible: false },
  ],
  recommendation: "keep",
};

const parse = (payload: unknown) => parseDecision(JSON.stringify(payload));

const problemsOf = (payload: unknown): string[] => {
  const result = parse(payload);
  return result.ok ? [] : result.problems.map(problem => problem.reason);
};

describe("parseDecision", () => {
  test("accepts the design's own example, normalized", () => {
    const result = parse({ ...sound, deadline: "2026-08-12T09:00:00Z", assignee: "  alex  " });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.options).toHaveLength(2);
    expect(result.decision.recommendation).toBe("keep");
    // Deadlines are normalized to the store's one timestamp format,
    // and single-line fields are trimmed.
    expect(result.decision.deadline).toBe("2026-08-12T09:00:00.000Z");
    expect(result.decision.assignee).toBe("alex");
  });

  test("assignee and deadline are optional; nothing else is", () => {
    expect(parse(sound).ok).toBe(true);
  });

  test("refuses what is not JSON, and what is JSON but not an object", () => {
    expect(parseDecision("not json {")).toMatchObject({ ok: false });
    expect(problemsOf([sound])).toContain("not-an-object");
    expect(parseDecision(JSON.stringify("a string"))).toMatchObject({ ok: false });
  });

  test("urgency is required and only 'blocking' exists in M3", () => {
    expect(problemsOf({ ...sound, urgency: undefined })).toContain("bad-urgency");
    // Advisory needs a commit-and-complete lifecycle the park path does not
    // have; accepting the word now would promise the semantics.
    expect(problemsOf({ ...sound, urgency: "advisory" })).toContain("bad-urgency");
  });

  test("a recap, a question, and a recommendation are the 422 rule, enforced", () => {
    expect(problemsOf({ ...sound, recap: "" })).toContain("missing-recap");
    expect(problemsOf({ ...sound, question: undefined })).toContain("missing-question");
    expect(problemsOf({ ...sound, recommendation: undefined })).toContain("missing-recommendation");
  });

  test("the recommendation must name an option that exists", () => {
    expect(problemsOf({ ...sound, recommendation: "ship-it" })).toContain("bad-recommendation");
  });

  test("one option is not a decision, and seven do not fit on a screen", () => {
    expect(problemsOf({ ...sound, options: [sound.options[0]] })).toContain("too-few-options");
    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: `o${i}`, label: `o${i}`, consequence: "c", reversible: true,
    }));
    expect(problemsOf({ ...sound, options: seven, recommendation: "o0" })).toContain("too-many-options");
  });

  test("reversibility must be stated, never defaulted", () => {
    const unstated = [
      { id: "keep", label: "Keep", consequence: "fine", reversible: true },
      { id: "drop", label: "Drop", consequence: "gone" },
    ];
    expect(problemsOf({ ...sound, options: unstated })).toContain("missing-reversible");
    // "reversible": "yes" is an assertion, not a boolean.
    const stringly = [
      { id: "keep", label: "Keep", consequence: "fine", reversible: true },
      { id: "drop", label: "Drop", consequence: "gone", reversible: "yes" },
    ];
    expect(problemsOf({ ...sound, options: stringly })).toContain("missing-reversible");
  });

  test("option ids are identifiers — unique, short, URL-safe", () => {
    const dupes = [
      { id: "same", label: "a", consequence: "c", reversible: true },
      { id: "same", label: "b", consequence: "c", reversible: true },
    ];
    expect(problemsOf({ ...sound, options: dupes, recommendation: "same" })).toContain("duplicate-option-id");

    const hostile = [
      { id: "../evil", label: "a", consequence: "c", reversible: true },
      { id: "ok", label: "b", consequence: "c", reversible: true },
    ];
    expect(problemsOf({ ...sound, options: hostile, recommendation: "ok" })).toContain("bad-option-id");
  });

  test("control characters are rejected everywhere they could become an escape", () => {
    // OSC sequences rewrite terminals; recap reaches terminals.
    expect(problemsOf({ ...sound, recap: "look\u001b]0;pwned\u0007" })).toContain("recap-control-characters");
    // Labels are single-line: a newline is how one option becomes two.
    const split = [
      { id: "a", label: "one\ntwo", consequence: "c", reversible: true },
      { id: "b", label: "b", consequence: "c", reversible: true },
    ];
    expect(problemsOf({ ...sound, options: split, recommendation: "b" })).toContain(
      "option-0-label-control-characters",
    );
    // Newlines in prose are prose.
    expect(parse({ ...sound, recap: "line one\nline two" }).ok).toBe(true);
  });

  test("caps are enforced, including the whole payload", () => {
    expect(problemsOf({ ...sound, recap: "x".repeat(LIMITS.recap + 1) })).toContain("recap-too-long");
    const bloated = { ...sound, recap: "x".repeat(LIMITS.payload) };
    expect(parseDecision(JSON.stringify(bloated))).toMatchObject({ ok: false });
  });

  test("a bad deadline is a problem, not a silent null", () => {
    expect(problemsOf({ ...sound, deadline: "next tuesday-ish" })).toContain("bad-deadline");
  });

  test("every problem is reported at once, so one repair turn can fix them all", () => {
    const wreck = problemsOf({ ...sound, recap: "", recommendation: "ghost", urgency: "advisory" });
    expect(wreck).toEqual(expect.arrayContaining(["missing-recap", "bad-recommendation", "bad-urgency"]));
    expect(wreck.length).toBeGreaterThanOrEqual(3);
  });
});

describe("repairPrompt", () => {
  test("names every failure and the one file to rewrite", () => {
    const result = parseDecision(JSON.stringify({ ...sound, recommendation: "ghost" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const prompt = repairPrompt(result.problems, "STANDING-ORDERS-PARK-abc.json");
    expect(prompt).toContain('"ghost" does not match any option id');
    expect(prompt).toContain("Rewrite STANDING-ORDERS-PARK-abc.json only");
  });
});
