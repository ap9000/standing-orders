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
