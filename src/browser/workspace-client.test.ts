// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserWorkspace } from "../browser-workspace.js";
import { CommandMenu, GuardedHtml, workspaceCommands } from "./app.js";
import {
  carryDraft, DRAFT_TTL, editDraft, emptyDraft, isWorkspace, readWorkspace, receiveDraft,
  restoreDraft, sameConversation, saveDraft, sendMessage, submitDraft, WorkspaceAuthError,
} from "./workspace-client.js";

const a = "a".repeat(32), b = "b".repeat(32), c = "c".repeat(32);
const scope = { user: "alex", session: 7, task: "task-a" };
const now = 1_790_000_000_000;
const fixture = (): BrowserWorkspace => ({
  version: 1, path: "/chat?task=task-a&result=9", title: "Lead", user: "alex", csrf: "csrf", sensitive: true,
  refreshUrl: "/chat?task=task-a&result=9", receipt: null, projects: [], crew: [], crewTruncated: false,
  conversation: { sessionId: 7, user: "alex", version: "v1", messages: [], pendingTurnId: null, requestId: a, maxChars: 2000, taskId: "task-a", resultRunId: 9 },
  focus: null, result: null, catchUpHtml: "", controlsHtml: "", notices: [], pageHtml: null,
  navigation: [{ label: "Chat", href: "/chat", active: true }],
});
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
let root: Root | null = null;

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

test("draft persistence is bounded by account, session, task and expiry", () => {
  const draft = editDraft(emptyDraft(a, now), "Preserve the approval terms", () => b, now);
  expect(saveDraft(sessionStorage, scope, draft)).toBe(true);
  expect(restoreDraft(sessionStorage, scope, c, 2000, now).text).toBe(draft.text);
  expect(restoreDraft(sessionStorage, { ...scope, user: "other" }, c, 2000, now).text).toBe("");
  expect(restoreDraft(sessionStorage, { ...scope, session: 8 }, c, 2000, now).text).toBe("");
  expect(restoreDraft(sessionStorage, { ...scope, task: "other" }, c, 2000, now).text).toBe("");
  expect(restoreDraft(sessionStorage, scope, c, 2000, now + DRAFT_TTL + 1).text).toBe("");
});

test("explicit reconnect carries only words for the same account and task, with a fresh receipt key", () => {
  carryDraft(sessionStorage, scope, "Keep this unsent", now);
  expect(restoreDraft(sessionStorage, { ...scope, user: "other", session: 8 }, b, 2000, now).text).toBe("");
  const recovered = restoreDraft(sessionStorage, { ...scope, session: 8 }, b, 2000, now);
  expect(recovered).toMatchObject({ text: "Keep this unsent", request: b, submitted: false, pending: null });
  expect(restoreDraft(sessionStorage, { ...scope, session: 8 }, c, 2000, now).text).toBe("");
});

test("an interrupted send survives reload and an exact receipt clears only the submitted draft", () => {
  const sent = submitDraft(editDraft(emptyDraft(a, now), "Review the result", () => b, now), now);
  saveDraft(sessionStorage, scope, sent);
  const recovered = restoreDraft(sessionStorage, scope, c, 2000, now);
  expect(recovered.pending).toEqual({ request: a, text: "Review the result" });
  expect(receiveDraft(recovered, a, { request: a, received: true }, () => b, now)).toEqual(emptyDraft(b, now));
});

test("late receipts never erase a new draft or settle a different in-flight request", () => {
  const sent = submitDraft(editDraft(emptyDraft(a, now), "First message", () => b, now), now);
  const edited = editDraft(sent, "Next message", () => b, now);
  expect(edited.pending?.request).toBe(a);
  expect(receiveDraft(edited, null, { request: a, received: true }, () => c, now)).toBe(edited);
  expect(receiveDraft(edited, b, { request: a, received: true }, () => c, now)).toBe(edited);
  expect(receiveDraft(edited, a, { request: a, received: false }, () => c, now)).toBe(edited);
  expect(receiveDraft(edited, a, { request: a, received: true }, () => c, now)).toMatchObject({ text: "Next message", request: b, pending: null, submitted: false });
  expect(submitDraft(edited, now)).toBe(edited);
});

test("send submits once with the exact existing form identity and never retries a lost response", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection closed"));
  await expect(sendMessage(fixture(), { request: a, text: "Check result 9" }, fetcher)).rejects.toThrow("connection closed");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("/chat");
  expect(init?.method).toBe("POST");
  expect(init?.credentials).toBe("same-origin");
  expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({ csrf: "csrf", message: "Check result 9", request: a, "request-session": "7", task: "task-a", result: "9" });
});

test("a normal HTML redirect response is not mistaken for confirmed delivery", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>Chat</html>", { headers: { "content-type": "text/html" } }));
  await expect(sendMessage(fixture(), { request: a, text: "Check result 9" }, fetcher)).resolves.toEqual({ refused: false, message: null });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("snapshot checks use same-origin read transport and reject incomplete data before receipts", async () => {
  const complete = fixture(); complete.receipt = { request: a, received: true };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(complete));
  await expect(readWorkspace(fixture(), a, fetcher)).resolves.toEqual(complete);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toContain("task=task-a&result=9&format=workspace&request=" + a);
  expect(init?.method).toBeUndefined();
  expect(init?.credentials).toBe("same-origin");
  const incomplete = { ...complete, conversation: { ...complete.conversation, messages: [{}] } };
  expect(isWorkspace(incomplete)).toBe(false);
  fetcher.mockResolvedValue(json(incomplete));
  await expect(readWorkspace(fixture(), a, fetcher)).rejects.toThrow("incomplete");
});

test("auth and changed conversation identities require explicit reconnection", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("Sign in", { status: 401 }));
  await expect(readWorkspace(fixture(), null, fetcher)).rejects.toBeInstanceOf(WorkspaceAuthError);
  const changed = fixture(); changed.conversation!.sessionId = 8;
  expect(sameConversation(fixture(), changed)).toBe(false);
  const otherRun = fixture(); otherRun.conversation!.resultRunId = 10;
  expect(sameConversation(fixture(), otherRun)).toBe(false);
});

async function renderHtml(html: string, immutable = false) {
  if (!root) { const node = document.createElement("div"); document.body.append(node); root = createRoot(node); }
  await act(async () => root!.render(createElement(GuardedHtml, { html, immutable })));
}

test("same result run retains its exact native form, feedback and listeners on refresh", async () => {
  await renderHtml('<form id="comment-form"><input name="request" value="old"><textarea name="note"></textarea></form>', true);
  const original = document.getElementById("comment-form");
  const note = document.querySelector("textarea")!; note.value = "Keep the error recovery visible";
  await renderHtml('<form id="comment-form"><input name="request" value="new"><textarea name="note"></textarea></form>', true);
  expect(document.getElementById("comment-form")).toBe(original);
  expect(document.querySelector("textarea")?.value).toBe("Keep the error recovery visible");
  expect(document.querySelector<HTMLInputElement>('[name="request"]')?.value).toBe("old");
});

test("native initialization is delivered to window after all guarded fragments are inserted", async () => {
  const observations: boolean[] = [];
  const initialized = () => observations.push(document.querySelector("#native-result") !== null && document.querySelector("#native-plan") !== null);
  window.addEventListener("standing-orders:workspace-rendered", initialized);
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(createElement("div", {},
    createElement(GuardedHtml, { html: '<section id="native-plan">Plan</section>' }),
    createElement(GuardedHtml, { html: '<section id="native-result">Result</section>', immutable: true }),
  )));
  window.removeEventListener("standing-orders:workspace-rendered", initialized);
  expect(observations).toEqual([true]);
});

test("a changed approval preserves entered credentials but blocks stale consent", async () => {
  const form = (digest: string) => `<section data-approval="${digest}"><form class="approve-form"><input type="password" name="token"><button type="submit">Approve and start</button></form></section>`;
  await renderHtml(form("first"));
  const password = document.querySelector("input")!; password.value = "entered-password"; password.focus();
  await renderHtml(form("changed"));
  expect(document.querySelector("input")).toBe(password);
  expect(password.value).toBe("entered-password");
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(document.body.textContent).toContain("The plan changed.");
});

test("focused native drafts are preserved and deferred non-form updates apply after focus leaves", async () => {
  await renderHtml('<label>Decision note<input name="note" value="old"></label>');
  const field = document.querySelector("input")!; field.focus();
  await renderHtml('<p>Decision recorded</p>');
  expect(document.querySelector("input")).toBe(field);
  await act(async () => field.blur());
  expect(document.querySelector("input")).toBeNull();
  expect(document.body.textContent).toContain("Decision recorded");
});

test("command search keeps exact admitted destinations and filters task state", () => {
  const workspace = fixture();
  workspace.projects = [{ name: "Docs", path: "/repo/docs", href: "/work?project=%2Frepo%2Fdocs", knowledgeHref: "/settings/knowledge?repo=%2Frepo%2Fdocs" }];
  workspace.crew = [{ id: "task-a", title: "Improve recovery", project: "/repo/docs", state: "ready-to-check", label: "Ready to check", tone: "ready", href: "/chat?task=task-a", resultHref: "/chat?task=task-a&result=9", action: null }];
  expect(workspaceCommands(workspace, " DOCS ")).toEqual([{ label: "Docs", detail: "Project", href: "/work?project=%2Frepo%2Fdocs" }]);
  expect(workspaceCommands(workspace, "ready")).toEqual([{ label: "Improve recovery", detail: "Ready to check", href: "/chat?task=task-a&result=9" }]);
  expect(workspaceCommands(workspace, "missing")).toEqual([]);
});

test("command shortcut opens outside editors and stays absent on sensitive pages", async () => {
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  const workspace = fixture(); workspace.sensitive = false;
  await act(async () => root!.render(createElement(CommandMenu, { workspace })));
  const editor = document.createElement("textarea"); document.body.append(editor); editor.focus();
  await act(async () => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); });
  expect(document.querySelector("[data-workspace-command]")).toBeNull();
  editor.blur();
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => root!.render(createElement(CommandMenu, { workspace: { ...workspace, sensitive: true } })));
  expect(document.querySelector("[data-workspace-command]")).toBeNull();
  expect(node.textContent).toBe("");
});
