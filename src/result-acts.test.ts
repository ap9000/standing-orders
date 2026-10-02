import { describe, expect, it } from "vitest";
import { resultActsOf, type ResultActFacts } from "./result-acts.js";
import { cantAcceptYetOf } from "./workspace-ui.js";

const base: ResultActFacts = { accept: null, runChecks: false, checksRunning: false, blocked: null, canRequest: true, need: null, next: null };
const MISMATCH = "Can't accept yet: what the agent reported doesn't match the changes it saved.";

describe("the result page's one ink act", () => {
  it("everything met: Accept, with Request changes beside it", () => {
    expect(resultActsOf({ ...base, accept: { ready: true } })).toEqual({ primary: "accept", secondary: "request-changes", line: null });
  });

  it("checks didn't run and the project has one: Run checks, then Accept without checks", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, runChecks: true })).toEqual({ primary: "run-checks", secondary: "accept", line: null });
  });

  it("report and saved changes disagree: Request changes after one line saying why, then Accept as allowed", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, blocked: MISMATCH, runChecks: true })).toEqual({ primary: "request-changes", secondary: "accept", line: MISMATCH });
    expect(resultActsOf({ ...base, blocked: MISMATCH })).toEqual({ primary: "request-changes", secondary: null, line: MISMATCH });
  });

  it("a result that can't be accepted never gets Accept as ink, even without the feedback form", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, blocked: MISMATCH, canRequest: false })).toEqual({ primary: null, secondary: "accept", line: MISMATCH });
  });

  it("while checks are queued or running: a disabled Checks running leads, Accept without checks in outline", () => {
    expect(resultActsOf({ ...base, accept: { ready: false }, checksRunning: true })).toEqual({ primary: "checks-running", secondary: "accept", line: null });
    expect(resultActsOf({ ...base, accept: { ready: true }, checksRunning: true })).toEqual({ primary: "checks-running", secondary: "accept", line: null });
    expect(resultActsOf({ ...base, checksRunning: true })).toEqual({ primary: "checks-running", secondary: "request-changes", line: null });
  });

  it("a form that resolves a Needs you leads; saved notes become a revision", () => {
    expect(resultActsOf({ ...base, need: "rebuild", accept: { ready: true } })).toEqual({ primary: "rebuild", secondary: "request-changes", line: null });
    expect(resultActsOf({ ...base, next: "revise", accept: { ready: false } })).toEqual({ primary: "revise", secondary: "accept", line: null });
  });

  it("nothing waits: no ink act, never a link", () => {
    expect(resultActsOf(base)).toEqual({ primary: null, secondary: "request-changes", line: null });
    expect(resultActsOf({ ...base, canRequest: false })).toEqual({ primary: null, secondary: null, line: null });
  });

  it("every state has at most one ink act and it is never navigation", () => {
    const acts = new Set(["accept", "checks-running", "run-checks", "request-changes", "rebuild", "confirm-stopped", "revise", "draft-repair"]);
    for (const accept of [null, { ready: true }, { ready: false }]) for (const runChecks of [false, true]) for (const checksRunning of [false, true]) for (const blocked of [null, MISMATCH])
      for (const canRequest of [false, true]) for (const need of [null, "rebuild", "confirm-stopped"] as const) for (const next of [null, "revise"] as const) {
        const chosen = resultActsOf({ accept, runChecks, checksRunning, blocked, canRequest, need, next });
        if (chosen.primary !== null) expect(acts.has(chosen.primary)).toBe(true);
        expect(chosen.secondary === null || chosen.secondary !== chosen.primary).toBe(true);
        // A result that can't be accepted is never offered Accept as its ink act while Request changes is possible.
        if (blocked !== null && need === null && next === null && canRequest) expect(chosen).toMatchObject({ primary: "request-changes", line: MISMATCH });
        // ...and never Accept as its ink act, form or not; nor while checks run.
        if (blocked !== null || (checksRunning && need === null && next === null)) expect(chosen.primary).not.toBe("accept");
      }
  });

  it("says why a refuted result can't be accepted yet, once, until a person accepts it", () => {
    expect(cantAcceptYetOf("refuted", ['claimed changed path "src/ledger.ts" is not in the sealed diff'], false)).toBe(MISMATCH);
    expect(cantAcceptYetOf("refuted", ["the repository's approved verification command exited 1"], false)).toBe("Can't accept yet: the project's check failed on these changes.");
    expect(cantAcceptYetOf("refuted", [], true)).toBeNull();
    expect(cantAcceptYetOf("verified", [], false)).toBeNull();
    expect(cantAcceptYetOf("short", [], false)).toBeNull();
  });
});
