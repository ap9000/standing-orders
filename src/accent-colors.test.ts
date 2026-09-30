/** Any accent a person picks still reads: AA text in light and dark, on its fill and on its wash. */
import { expect, test } from "vitest";
import { ACCENT_PRESETS, DEFAULT_ACCENT, accentNote, accentStyle, accentTokens, contrast, normalHex, pinnedAccent } from "./accent-colors.js";

const reads = (hex: string) => {
  const { light, dark } = accentTokens(hex);
  expect(contrast(light.signal, light.soft), hex).toBeGreaterThanOrEqual(4.5);
  expect(contrast(light.on, light.signal), hex).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark.signal, "#161616"), hex).toBeGreaterThanOrEqual(6);
  expect(contrast(dark.signal, dark.soft), hex).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark.on, dark.signal), hex).toBeGreaterThanOrEqual(4.5);
};

test("every preset, and any colour off the picker, resolves to readable tokens in both schemes", () => {
  expect(ACCENT_PRESETS[0]).toMatchObject({ id: "ink", year: null, hex: DEFAULT_ACCENT });
  expect(ACCENT_PRESETS.slice(1, 3).map(one => one.id)).toEqual(["violet", "chart-magenta"]);
  for (const one of ACCENT_PRESETS) reads(one.hex);
  // Corners of the picker: white, black, pure primaries, a mid grey.
  for (const hex of ["#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#808080"]) reads(hex);
  // A colour that already reads keeps its value; a light one is deepened, not replaced.
  expect(accentTokens("#bb2649").light.signal).toBe("#bb2649");
  expect(accentTokens("#ffbe98").light.signal).not.toBe("#ffbe98");
});

test("the page says when a colour can be mistaken, and only six hex digits ever reach the cookie or the page", () => {
  expect(accentNote("#bf1932")).toContain("failures");
  expect(accentNote("#5f4b8b")).toBeNull();
  expect(accentNote("#808080")).toContain("grey");
  expect(normalHex("#ABC")).toBe("#aabbcc");
  expect(normalHex("009473")).toBe("#009473");
  expect(normalHex("red")).toBeNull();
  expect(pinnedAccent("a=1; so-accent=009473")).toBe("#009473");
  expect(pinnedAccent(`so-accent=${DEFAULT_ACCENT.slice(1)}`)).toBeNull();
  expect(pinnedAccent("so-accent=%22%3E%3Cstyle")).toBeNull();
  expect(pinnedAccent(undefined)).toBeNull();
  expect(accentStyle("#009473")).toMatch(/^:root\{--so-signal:#[0-9a-f]{6};.*:root\[data-theme="dark"\]\{--so-signal:#[0-9a-f]{6};/);
});
