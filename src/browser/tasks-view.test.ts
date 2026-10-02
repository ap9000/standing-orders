/** The Tasks list (views/tasks-view.tsx): a visible title with what needs you,
 * Needs you grouped by its ask first, waiting rows in a solid ink chip naming
 * the ask, every other row quiet, and usage out of the list's way. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { BrowserTasksView } from "../browser-workspace.js";
import { TasksView, usageSummary } from "./views/tasks-view.js";

type Row = BrowserTasksView["rows"][number];
const row = (id: string, ask: Row["ask"], group: Row["group"], label: string, tone: Row["status"]["tone"]): Row => ({
  id, title: `Task ${id}`, href: `/t/${id}`, project: null, age: "4h ago", status: { label, tone, token: "assignment-working" },
  ask, group, action: { label: "Open", href: `/t/${id}` }, detail: null, problem: null, notes: [],
});
const tile = (key: string, name: string, window: string, percent: number, tone: "neutral" | "warning" | "danger" = "neutral") =>
  ({ key, name, window, value: String(percent), unit: "%", percent, detail: "Resets soon", tone, marks: [], title: null, href: null });
const view = (over: Partial<BrowserTasksView> = {}): BrowserTasksView => ({
  kind: "tasks", tabs: [{ label: "All", href: "/work", count: 5, active: true }, { label: "Needs you", href: "/work?view=needs-you", count: 3, active: false }],
  needsYou: 3,
  groups: [{ key: "decide", label: "Decide", count: 1 }, { key: "review", label: "Review", count: 1 }, { key: "unblock", label: "Unblock", count: 1 }, { key: "building", label: "Building", count: 1 }, { key: "rest", label: "Recent", count: 1 }],
  rows: [row("plan", "decide", "decide", "Needs you", "attention"), row("result", "review", "review", "Ready", "ready"), row("offline", "unblock", "unblock", "Needs you", "attention"),
    row("live", null, "building", "Building", "live"), row("old", null, "rest", "Stopped", "attention")],
  empty: null, pages: { first: null, next: null }, tools: [], newTask: { label: "New task", href: "/tasks/new" },
  limits: { tiles: [tile("claude:5h", "Claude", "5-hour", 48), tile("claude:week", "Claude", "Weekly", 83, "warning"), tile("codex:week", "Codex", "Weekly", 12)] },
  ...over,
});
const html = (one: BrowserTasksView) => renderToStaticMarkup(createElement(TasksView, { view: one }));

describe("the Tasks list", () => {
  test("a visible title says how many need you, and Needs you comes first, grouped by the ask", () => {
    const page = html(view());
    expect(page).toMatch(/<h1 class="[^"]*">Tasks<\/h1>/);
    expect(page).not.toContain("sr-only\">Tasks");
    expect(page).toMatch(/data-needs-you-count[^>]*><span[^>]*>3<\/span> need you/);
    const groups = [...page.matchAll(/data-task-group="([a-z]+)"/g)].map(match => match[1]);
    expect(groups).toEqual(["decide", "review", "unblock", "building", "rest"]);
    expect(page).toMatch(/<h2[^>]*>Decide<span[^>]*>1<\/span><\/h2>/);
    // One plain list where the view isn't grouped.
    expect(html(view({ groups: null }))).not.toContain("data-task-group");
  });

  test("a waiting row wears a solid ink chip naming the ask and a heavier title; other rows stay quiet", () => {
    const page = html(view());
    for (const [id, word] of [["plan", "Decide"], ["result", "Review"], ["offline", "Unblock"]]) {
      const one = page.match(new RegExp(`<li data-task="${id}"[^]*?</li>`))![0];
      expect(one).toMatch(new RegExp(`data-ask="[a-z]+"[^>]*class="[^"]*bg-attention[^"]*text-on-attention[^"]*">${word}</span>`));
      expect(one).toMatch(/<a href="\/t\/[a-z]+" class="[^"]*font-semibold/);
      expect(one).not.toContain(">Needs you<");
    }
    for (const id of ["live", "old"]) {
      const one = page.match(new RegExp(`<li data-task="${id}"[^]*?</li>`))![0];
      expect(one).not.toContain("data-ask");
      expect(one).not.toContain("bg-attention");
      expect(one).toContain("bg-neutral-soft");
      expect(one).toMatch(/<a href="\/t\/[a-z]+" class="[^"]*font-medium/);
    }
    // No coloured border announces a wait.
    expect(page).not.toMatch(/border-l-/);
  });

  test("usage folds to one line on a desk and sits below the list on a phone", () => {
    expect(usageSummary(view().limits!).map(one => one.text)).toEqual(["Claude 48%", "Weekly 83%", "Codex 12%"]);
    const page = html(view());
    expect(page).toMatch(/data-usage-summary[^>]*>[^]*Claude 48%[^]*Weekly 83%[^]*Codex 12%/);
    // Folded on a desk until clicked; the phone's tiles follow the last task.
    expect(page.indexOf('data-limit="claude:5h"')).toBeGreaterThan(page.lastIndexOf("data-task="));
    expect(page.match(/<section aria-label="Usage"[^>]*class="([^"]*)"/)?.[1]).toBe("desk:hidden");
    expect(html(view({ limits: null }))).not.toContain("data-usage-summary");
  });
});
