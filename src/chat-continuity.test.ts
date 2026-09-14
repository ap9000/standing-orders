import { Window } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CHAT_CONTINUITY_SCRIPT } from "./chat-continuity.js";

let window: Window;
let scheduled: { fn: () => void; ms: number; id: number }[];
let response: () => Promise<Response>;
const key = "standing-orders:chat-draft:7:task-a";
const request = "a".repeat(32);
const html = `<form action="/chat" class="composer" data-chat-session="7" data-chat-task="task-a" data-chat-version="" data-chat-busy="0">
<input name="request" value="${request}"><input name="request-session" value="7"><textarea name="message"></textarea><button type="submit">send</button></form>
<form action="/chat"><button type="submit" name="message" value="Brief me">brief me</button></form>
<form action="/chat/mate/end"><button type="submit">end</button></form><p id="chat-connection"></p>`;
beforeEach(() => {
  window = new Window({ url: "https://standing.test/chat?task=task-a" });
  window.document.body.innerHTML = html;
  scheduled = [];
  let timerId = 0;
  window.setTimeout = ((fn: () => void, ms: number) => { const id = ++timerId; scheduled.push({ fn, ms, id }); return id; }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { scheduled = scheduled.filter(one => one.id !== id); }) as typeof window.clearTimeout;
  window.AbortSignal.timeout = () => new window.AbortController().signal;
  response = async () => new Response(JSON.stringify({ session: 7, version: "", pending: false, received: false }));
  window.fetch = (async () => response()) as typeof window.fetch;
});
afterEach(async () => { await window.happyDOM.close(); });
const box = () => window.document.querySelector("textarea")!;
const form = () => window.document.querySelector("form")!;
const status = () => window.document.getElementById("chat-connection")!.textContent;
const enter = (text: string) => { box().value = text; box().dispatchEvent(new window.Event("input")); };
const submit = () => form().dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
const check = async () => { scheduled.shift()!.fn(); await new Promise(resolve => setImmediate(resolve)); };

test("restores only this conversation/task's unexpired tab draft", () => {
  window.sessionStorage.setItem(key, JSON.stringify({ text: "Make the navigation clearer", request, at: Date.now() }));
  window.sessionStorage.setItem("standing-orders:chat-draft:6:task-a", JSON.stringify({ text: "old account", request, at: Date.now() }));
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(box().value).toBe("Make the navigation clearer");
  expect(window.sessionStorage.getItem("standing-orders:chat-draft:6:task-a")).toBeNull();
  enter("Revise the navigation");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: "Revise the navigation", submitted: false });
});

test("double send is latched without dropping a prompt button's submitted value", () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Check the proof");
  expect(submit()).toBe(true); expect(submit()).toBe(false);
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ submitted: true, request });
  const prompt = window.document.querySelectorAll('form[action="/chat"]')[1]!;
  expect(prompt.querySelector('[name="request"]')).not.toBeNull();
  expect(prompt.querySelector("button")!.disabled).toBe(false);
  expect(prompt.dispatchEvent(new window.Event("submit", { cancelable: true }))).toBe(false);
});

test("clears a submitted draft only on a server receipt, never on a network failure", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Show my tasks"); submit();
  response = async () => { throw new Error("offline"); };
  await check();
  expect(status()).toContain("Connection lost"); expect(box().value).toBe("Show my tasks");
  expect(scheduled.at(-1)!.ms).toBe(10000);
  response = async () => new Response(JSON.stringify({ session: 7, version: "", pending: false, received: true }));
  await check();
  expect(status()).toBe('Connected.');
  expect(box().value).toBe(""); expect(window.sessionStorage.getItem(key)).toBeNull();
});

test("server errors and malformed responses retry instead of silently stopping", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT);
  for (const bad of [new Response("bad", { status: 503 }), new Response("bad json"), new Response(JSON.stringify({ session: 7 }))]) {
    response = async () => bad; await check();
    expect(status()).toContain("Reconnecting"); expect(scheduled.at(-1)!.ms).toBe(10000);
  }
});

test("a pending reply keeps the draft editable but never auto-sends a follow-up", async () => {
  form().dataset.chatBusy = "1";
  response = async () => new Response(JSON.stringify({ session: 7, version: "", pending: true }));
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Also check mobile spacing"); await check();
  expect(box().disabled).toBe(false); expect(form().querySelector("button")!.disabled).toBe(true);
  expect(submit()).toBe(false); expect(status()).toContain("draft your next message");
});

test("a completed reply reloads once for server-rendered cards with the next draft preserved", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Follow up on mobile");
  response = async () => new Response(JSON.stringify({ session: 7, version: "2:answered", pending: false }));
  await check();
  expect(reload).toHaveBeenCalledOnce();
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: "Follow up on mobile", submitted: false });
});

test("new replies do not reload a focused draft or password ceremony", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  window.eval(CHAT_CONTINUITY_SCRIPT);
  const password = window.document.createElement("input"); password.type = "password"; window.document.body.appendChild(password);
  response = async () => new Response(JSON.stringify({ session: 7, version: "2:answered", pending: false }));
  for (const field of [box(), password]) {
    field.focus(); await check();
    expect(reload).not.toHaveBeenCalled(); expect(status()).toContain("Finish editing");
  }
  password.blur(); await check(); expect(reload).toHaveBeenCalledOnce();
});

test("back navigation unlatches sending and ending a conversation clears its draft", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Inspect the result"); submit();
  window.dispatchEvent(new window.Event("pageshow"));
  expect(submit()).toBe(true);
  window.document.querySelector('form[action="/chat/mate/end"]')!.dispatchEvent(new window.Event("submit"));
  expect(window.sessionStorage.getItem(key)).toBeNull();
});

test("storage denial leaves native form submission working", () => {
  vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("denied"); });
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Check status");
  expect(status()).toContain("storage is unavailable"); expect(submit()).toBe(true);
});
