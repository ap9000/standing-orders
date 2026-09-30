import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/* The console's overlays arrive and leave on Radix data-state keyframes, and
 * reduce to a plain fade under prefers-reduced-motion. These read the shipped
 * stylesheet, so a changed value fails here rather than only on screen. */
const css = readFileSync(join(import.meta.dirname, "workspace.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const reduceAt = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .so-workspace *");
const reduce = css.slice(reduceAt, css.indexOf("\n}\n", reduceAt));
const base = css.slice(0, reduceAt);
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
function rule(source: string, selector: string): string {
  const at = source.indexOf(`${selector} {`);
  expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return squash(source.slice(at + selector.length + 2, source.indexOf("}", at)));
}
function keyframes(name: string): string {
  const at = css.indexOf(`@keyframes ${name} {`);
  expect(at, `@keyframes ${name}`).toBeGreaterThanOrEqual(0);
  return squash(css.slice(at, css.indexOf("} }", at) + 3));
}
const popovers = ':is([data-slot="dropdown-menu-content"], [data-slot="select-content"])';
const overlays = ':is(.ui-dialog-overlay, .ui-dialog-content, .so-navigation-dialog, [data-slot="dropdown-menu-content"], [data-slot="select-content"])';

describe("overlay motion", () => {
  test("the phone drawer slides in and back out along the same path, over a fading overlay", () => {
    expect(rule(base, '.so-navigation-dialog[data-state="open"]')).toBe("animation: so-drawer-in 220ms cubic-bezier(.32, .72, 0, 1) both;");
    expect(rule(base, '.so-navigation-dialog[data-state="closed"]')).toBe("animation: so-drawer-out 180ms cubic-bezier(.32, .72, 0, 1) both;");
    expect(keyframes("so-drawer-in")).toBe("@keyframes so-drawer-in { from { transform: translateX(-100%); } to { transform: translateX(0); } }");
    expect(keyframes("so-drawer-out")).toBe("@keyframes so-drawer-out { from { transform: translateX(0); } to { transform: translateX(-100%); } }");
    expect(rule(base, '.ui-dialog-overlay[data-state="open"]')).toBe("animation: so-fade-in 200ms ease-out both;");
    expect(rule(base, '.ui-dialog-overlay[data-state="closed"]')).toBe("animation: so-fade-out 160ms ease-out both;");
    // The drawer is also a .ui-dialog-content, so its rules must come after the centered dialog's.
    expect(base.indexOf('.so-navigation-dialog[data-state="open"]')).toBeGreaterThan(base.indexOf('.ui-dialog-content[data-state="closed"]'));
  });

  test("centered dialogs scale from .96 about their center and keep their centering translate", () => {
    expect(rule(base, ".ui-dialog-content")).toContain("transform: translate(-50%, -50%);");
    expect(base).toContain(".ui-dialog-content { transform-origin: center; }");
    expect(rule(base, '.ui-dialog-content[data-state="open"]')).toBe("animation: so-dialog-in 200ms cubic-bezier(.23, 1, .32, 1) both;");
    expect(rule(base, '.ui-dialog-content[data-state="closed"]')).toBe("animation: so-dialog-out 150ms cubic-bezier(.23, 1, .32, 1) both;");
    expect(keyframes("so-dialog-in")).toBe("@keyframes so-dialog-in { from { opacity: 0; transform: translate(-50%, -50%) scale(.96); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }");
    expect(keyframes("so-dialog-out")).toBe("@keyframes so-dialog-out { from { opacity: 1; transform: translate(-50%, -50%) scale(1); } to { opacity: 0; transform: translate(-50%, -50%) scale(.98); } }");
    expect(css).not.toMatch(/scale\(0\)/);
  });

  test("dropdown menus and select content grow from their trigger and leave as a fade", () => {
    expect(rule(base, '[data-slot="dropdown-menu-content"]')).toBe("transform-origin: var(--radix-dropdown-menu-content-transform-origin);");
    expect(rule(base, '[data-slot="select-content"]')).toBe("transform-origin: var(--radix-select-content-transform-origin);");
    expect(rule(base, `${popovers}[data-state="open"]`)).toBe("animation: so-popover-in 150ms cubic-bezier(.23, 1, .32, 1) both;");
    expect(rule(base, `${popovers}[data-state="closed"]`)).toBe("animation: so-fade-out 100ms cubic-bezier(.23, 1, .32, 1) both;");
    expect(keyframes("so-popover-in")).toBe("@keyframes so-popover-in { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: scale(1); } }");
    expect(keyframes("so-fade-out")).toBe("@keyframes so-fade-out { from { opacity: 1; } to { opacity: 0; } }");
  });

  test("under reduced motion every overlay, the drawer itself included, is a 120 ms fade with no transform", () => {
    expect(reduceAt).toBeGreaterThan(0);
    expect(rule(reduce, `${overlays}[data-state="open"]`)).toBe("animation: so-fade-in 120ms ease-out both !important;");
    expect(rule(reduce, `${overlays}[data-state="closed"]`)).toBe("animation: so-fade-out 120ms ease-out both !important;");
    for (const name of ["so-fade-in", "so-fade-out"]) expect(keyframes(name)).not.toContain("transform");
    // The blanket zero-duration rule covers descendants only, so it cannot cancel the fade.
    expect(rule(reduce, ".so-workspace *, .so-navigation-dialog *")).toContain("animation-duration: 0s !important;");
    expect(reduce).toContain("\n  .so-workspace *, .so-navigation-dialog * {");
  });
});
