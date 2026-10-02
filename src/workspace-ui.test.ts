import { describe, expect, test } from "vitest";
import { acceptWordsOf } from "./workspace-ui.js";

describe("the result's Accept words", () => {
  test("Accept only when every requirement is met and the checks passed, and never says it publishes", () => {
    expect(acceptWordsOf({ checks: "passed", unmet: 0, yours: 0, action: "complete", publishing: "pull-request", proof: true }))
      .toEqual({ label: "Accept", ready: true, why: null, effect: "Marks it complete. No pull request opens; you can open one from the task after." });
    expect(acceptWordsOf({ checks: "passed", unmet: 0, yours: 0, action: "complete", publishing: "other", proof: true }).effect).toBe("Marks it complete. Nothing is published.");
  });

  test("a missing or unreadable proof is Accept without checks, and says so", () => {
    expect(acceptWordsOf({ checks: "passed", unmet: 0, yours: 0, action: "complete", publishing: "off", proof: false }))
      .toMatchObject({ label: "Accept without checks", ready: false, why: "The saved proof couldn't be read." });
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, yours: 0, action: "complete", publishing: "off", proof: false }).why).toBe("The saved proof couldn't be read and checks didn't run.");
  });

  test("Accept without checks names what is missing in one line", () => {
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, yours: 0, action: "complete", publishing: "off", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks didn't run.", effect: "Marks it complete. The branch stays; publishing isn't set up." });
    expect(acceptWordsOf({ checks: "passed", unmet: 2, yours: 1, action: "complete", publishing: "other", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "2 requirements aren't met and 1 item still needs your check.", effect: "Marks it complete. Nothing is published." });
    expect(acceptWordsOf({ checks: "off", unmet: 1, yours: 0, action: "complete", publishing: "off", proof: true }).why).toBe("Checks are off for this project and 1 requirement isn't met.");
    expect(acceptWordsOf({ checks: null, unmet: 0, yours: 0, action: "complete", publishing: "off", proof: true }).label).toBe("Accept without checks");
  });

  test("an acceptance that doesn't complete never says it does", () => {
    expect(acceptWordsOf({ checks: "failed", unmet: 0, yours: 0, action: "accept", publishing: "pull-request", proof: true }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks failed.", effect: "Records that you accept it. You mark it complete next." });
  });
});
