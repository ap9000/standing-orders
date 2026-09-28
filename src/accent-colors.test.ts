/** Every accent a person can choose still reads: AA text in light and dark, on its fill and on its wash. */
import { expect, test } from "vitest";
import { ACCENTS, accentCss, accentTokens, contrast, pinnedAccent } from "./accent-colors.js";

test("each colour of the year resolves to readable tokens in both schemes", () => {
  expect(ACCENTS[0]).toMatchObject({ id: "signal", year: null });
  expect(ACCENTS.length).toBeGreaterThan(20);
  for (const one of ACCENTS.slice(1)) {
    const tokens = accentTokens(one.id)!;
    expect(contrast(tokens.light.signal, tokens.light.soft), one.name).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.light.signal, "#ffffff"), one.name).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.light.on, tokens.light.signal), one.name).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.dark.signal, "#161616"), one.name).toBeGreaterThanOrEqual(6);
    expect(contrast(tokens.dark.signal, tokens.dark.soft), one.name).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.dark.on, tokens.dark.signal), one.name).toBeGreaterThanOrEqual(4.5);
  }
  // A colour that already reads keeps its published value; a light one is deepened, not replaced.
  expect(accentTokens("viva-magenta")!.light.signal).toBe("#bb2649");
  expect(accentTokens("peach-fuzz")!.light.signal).not.toBe("#ffbe98");
});

test("a status-coloured accent says so, and the cookie only ever names a known accent", () => {
  expect(ACCENTS.find(one => one.id === "true-red")?.note).toContain("failures");
  expect(ACCENTS.find(one => one.id === "ultra-violet")?.note).toBeNull();
  expect(pinnedAccent("a=1; so-accent=emerald")).toBe("emerald");
  expect(pinnedAccent("so-accent=signal")).toBeNull();
  expect(pinnedAccent("so-accent=%22%3E%3Cscript")).toBeNull();
  expect(pinnedAccent(undefined)).toBeNull();
  expect(accentCss()).toContain(':root[data-accent="emerald"]');
  expect(accentCss()).not.toContain("signal\"]");
});
