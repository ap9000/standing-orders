import { describe, expect, test } from "vitest";
import { TASK_TEXT_LIMITS, validateTaskText, validateScopeText } from "./task-text.js";

describe("new task text policy", () => {
  test.each(["goal", "outOfScope"] as const)("%s keeps UTF-16 character, UTF-8 byte and control limits", field => {
    for (const value of ["a".repeat(2000), "界".repeat(2000), "😀".repeat(1000), "e\u0301".repeat(1000), "line\n\ttwo", "existing policy permits \u200b"]) {
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(TASK_TEXT_LIMITS.textBytes);
      expect(validateTaskText({ title: "Task", [field]: value })).toBeNull();
    }
    for (const value of ["a".repeat(2001), "😀".repeat(1001), "界".repeat(3000), "ok\u0000", "ok\r", "ok\u001b", "ok\u202e"]) {
      expect(validateScopeText({ [field]: value })?.reason).toBe(field === "goal" ? "bad-goal" : "bad-out-of-scope");
      expect(validateTaskText({ title: "Task", [field]: value })).toMatchObject({ ok: false, reason: "bad-goal" });
    }
  });
  test("empty optional exclusions are allowed; empty goals are not", () => {
    expect(validateScopeText({ goal: " \t\n" })?.message).toBe("Goal cannot be empty.");
    expect(validateScopeText({ goal: "valid", outOfScope: "" })).toBeNull();
  });
});
