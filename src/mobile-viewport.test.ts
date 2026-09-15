import { Window } from "happy-dom";
import { test, expect } from "vitest";
import { MOBILE_VIEWPORT_SCRIPT } from "./mobile-viewport.js";

test("soft-keyboard spacing follows viewport shrink, not focus or pinch zoom; Space is untouched", async () => {
  const window = new Window({ width: 390, height: 844 });
  try {
    const viewport = new window.EventTarget();
    Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    let update = () => {};
    window.requestAnimationFrame = ((fn: () => void) => { update = fn; return 1; }) as typeof window.requestAnimationFrame;
    window.document.body.innerHTML = '<textarea></textarea><button>Next</button>';
    window.eval(MOBILE_VIEWPORT_SCRIPT);
    const root = window.document.documentElement;
    const box = window.document.querySelector("textarea")!;
    box.focus(); update();
    expect(root.hasAttribute("data-mobile-keyboard")).toBe(false);
    const resize = (height: number, scale = 1) => { Object.assign(viewport, { height, scale }); viewport.dispatchEvent(new window.Event("resize")); update(); };
    resize(490);
    expect(root.hasAttribute("data-mobile-keyboard")).toBe(true);
    expect(root.style.getPropertyValue("--keyboard-inset")).toBe("354px");
    const space = new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    box.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    resize(490, 2);
    expect(root.hasAttribute("data-mobile-keyboard")).toBe(false);
    resize(844);
    expect(root.hasAttribute("data-mobile-keyboard")).toBe(false);
    expect(root.style.getPropertyValue("--keyboard-inset")).toBe("0px");
    resize(490);
    box.blur(); update();
    expect(root.hasAttribute("data-mobile-keyboard")).toBe(false);
  } finally { await window.happyDOM.close(); }
});

test("a reader at the end of the thread follows the composer up when the keyboard opens, and only then", async () => {
  const window = new Window({ width: 390, height: 844 });
  try {
    const viewport = new window.EventTarget();
    Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    let update = () => {};
    window.requestAnimationFrame = ((fn: () => void) => { update = fn; return 1; }) as typeof window.requestAnimationFrame;
    window.document.body.innerHTML = '<div class="composer"><textarea></textarea></div>';
    const root = window.document.documentElement;
    Object.defineProperty(root, "scrollHeight", { value: 1520, configurable: true });
    const scrolls: number[] = [];
    window.scrollTo = ((options: { top: number }) => { scrolls.push(options.top); }) as typeof window.scrollTo;
    window.eval(MOBILE_VIEWPORT_SCRIPT);
    const box = window.document.querySelector("textarea")!;
    const resize = (height: number) => { Object.assign(viewport, { height }); viewport.dispatchEvent(new window.Event("resize")); update(); };
    // Reading the middle of the thread: the keyboard must not move the page.
    Object.defineProperty(window, "scrollY", { value: 100, configurable: true });
    box.focus(); update(); resize(490);
    expect(root.hasAttribute("data-mobile-keyboard")).toBe(true);
    expect(scrolls).toEqual([]);
    resize(844); box.blur(); update();
    // At the end of the thread: one instant scroll keeps the newest message above the raised composer.
    Object.defineProperty(window, "scrollY", { value: 676, configurable: true });
    box.focus(); update(); resize(490);
    expect(scrolls).toEqual([1520]);
    // Further viewport reports while open (panning, height nudges) do not scroll again.
    resize(480);
    expect(scrolls).toEqual([1520]);
  } finally { await window.happyDOM.close(); }
});
