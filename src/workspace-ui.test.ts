import { describe, expect, test } from "vitest";
import { acceptWordsOf } from "./workspace-ui.js";

describe("the result's Accept words", () => {
  test("Accept only when every requirement is met and the checks passed, and says it opens the pull request", () => {
    expect(acceptWordsOf({ checks: "passed", unmet: 0, yours: 0, action: "complete", publishing: "pull-request" }))
      .toEqual({ label: "Accept", ready: true, why: null, effect: "Marks it complete and opens a pull request." });
  });

  test("Accept without checks names what is missing in one line", () => {
    expect(acceptWordsOf({ checks: "not-run", unmet: 0, yours: 0, action: "complete", publishing: "off" }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks didn't run.", effect: "Marks it complete. The branch stays; publishing isn't set up." });
    expect(acceptWordsOf({ checks: "passed", unmet: 2, yours: 1, action: "complete", publishing: "other" }))
      .toEqual({ label: "Accept without checks", ready: false, why: "2 requirements aren't met and 1 item still needs your check.", effect: "Marks it complete." });
    expect(acceptWordsOf({ checks: "off", unmet: 1, yours: 0, action: "complete", publishing: "off" }).why).toBe("Checks are off for this project and 1 requirement isn't met.");
    expect(acceptWordsOf({ checks: null, unmet: 0, yours: 0, action: "complete", publishing: "off" }).label).toBe("Accept without checks");
  });

  test("an acceptance that doesn't complete never says it does", () => {
    expect(acceptWordsOf({ checks: "failed", unmet: 0, yours: 0, action: "accept", publishing: "pull-request" }))
      .toEqual({ label: "Accept without checks", ready: false, why: "Checks failed.", effect: "Records that you accept it. You mark it complete next." });
  });
});
