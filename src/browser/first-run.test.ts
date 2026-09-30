// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FirstRun, withSuggestion } from "./first-run.js";
import type { BrowserFirstRun } from "../browser-workspace.js";

const signedOut = (): BrowserFirstRun => ({
  steps: [
    { key: "agent", title: "Agent signed in", done: false, action: { kind: "command", command: "claude auth login" } },
    { key: "project", title: "Project added", done: true, action: null },
    { key: "task", title: "Your first task", done: false, action: { kind: "link", label: "New task", href: "/tasks/new" } },
  ],
  suggestions: [
    { source: "issue", label: "#12 Login button does nothing", draft: "Fix GitHub issue #12: Login button does nothing" },
    { source: "generic", label: "Fix a lint warning", draft: "Fix one lint warning without changing behaviour." },
    { source: "generic", label: "Improve the README's setup section", draft: "Improve the setup section of the README." },
  ],
  sandbox: "npx toolroll demo",
});

let root: Root | null = null;
beforeEach(() => { document.body.innerHTML = ""; vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(firstRun: BrowserFirstRun, onDraft?: (text: string) => void) {
  const element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await act(async () => root!.render(createElement(FirstRun, { firstRun, onDraft })));
}

test("three steps, each done or with its one action", async () => {
  await mount(signedOut(), () => {});
  const rows = [...document.querySelectorAll("[data-step]")];
  expect(rows.map(row => [row.getAttribute("data-step"), row.getAttribute("data-done")])).toEqual([["agent", "false"], ["project", "true"], ["task", "false"]]);
  expect(rows[1]!.querySelector("a, button, code")).toBeNull();
  expect(rows[2]!.querySelector("a")!.getAttribute("href")).toBe("/tasks/new");
});

test("with no agent signed in, the sandbox and the sign-in command sit side by side, each said once", async () => {
  await mount(signedOut(), () => {});
  const choices = document.querySelector("[data-first-run-choices]")!;
  expect([...choices.children].map(one => one.querySelector("code")!.textContent)).toEqual(["npx toolroll demo", "claude auth login"]);
  expect([...document.querySelectorAll("code")].filter(one => one.textContent === "claude auth login")).toHaveLength(1);
});

test("before this machine's sign-in check answers, the agent step says Checking and offers nothing", async () => {
  await mount({ ...signedOut(), steps: [{ key: "agent", title: "Agent signed in", done: false, action: null, checking: true }, ...signedOut().steps.slice(1)], sandbox: null }, () => {});
  const agent = document.querySelector('[data-step="agent"]')!;
  expect(agent.textContent).toBe("Agent signed in: checkingChecking…");
  expect(agent.querySelector("code, a, button")).toBeNull();
  expect(document.querySelector("[data-first-run-choices]")).toBeNull();
});

test("a tap drafts the task in the composer and files nothing", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const drafted: string[] = [];
  await mount(signedOut(), text => drafted.push(text));
  const suggestions = [...document.querySelectorAll<HTMLButtonElement>("[data-first-tasks] button")];
  expect(suggestions.map(one => one.textContent)).toEqual(["#12 Login button does nothing", "Fix a lint warning", "Improve the README's setup section"]);
  expect(suggestions.every(one => one.type === "button" && one.closest("form") === null)).toBe(true);
  await act(async () => suggestions[0]!.click());
  expect(drafted).toEqual(["Fix GitHub issue #12: Login button does nothing"]);
  expect(fetcher).not.toHaveBeenCalled();
});

test("without a composer to draft into, no suggestions are offered", async () => {
  await mount(signedOut());
  expect(document.querySelector("[data-first-tasks]")).toBeNull();
});

test("a tapped first task never replaces what the person already typed", () => {
  expect(withSuggestion("", "Fix GitHub issue #12: Login button does nothing")).toBe("Fix GitHub issue #12: Login button does nothing");
  expect(withSuggestion("  \n", "Fix a lint warning")).toBe("Fix a lint warning");
  expect(withSuggestion("Also keep the old API working", "Fix a lint warning")).toBe("Also keep the old API working\nFix a lint warning");
  expect(withSuggestion("Fix a lint warning", "Fix a lint warning")).toBe("Fix a lint warning");
});
