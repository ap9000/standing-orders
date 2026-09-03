import { describe, test, expect } from "vitest";
import { sanitizeHiddenInput } from "./prompt.js";

const ESC = "\u001b";

describe("the hidden prompt's raw input (setup review)", () => {
  test("a bracketed paste compares equal to a typed secret; arrow and function keys vanish; typed text survives", () => {
    const pasted = `${ESC}[200~s3cret-Pa$$${ESC}[201~`;
    expect(sanitizeHiddenInput(pasted)).toBe("s3cret-Pa$$");
    expect(sanitizeHiddenInput(`ab${ESC}[Ac${ESC}OPd`)).toBe("abcd");
    expect(sanitizeHiddenInput("plain text 123 !@#")).toBe("plain text 123 !@#");
    // A bare ESC (a nervous keypress) is dropped, not kept as a character.
    expect(sanitizeHiddenInput(`x${ESC}`)).toBe("x");
    // Enter and backspace still reach the reader untouched.
    expect(sanitizeHiddenInput("ab\r")).toBe("ab\r");
    expect(sanitizeHiddenInput("ab\u007f")).toBe("ab\u007f");
  });
});
