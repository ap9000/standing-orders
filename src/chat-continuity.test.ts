import { Window } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CHAT_CONTINUITY_SCRIPT } from "./chat-continuity.js";

let window: Window;
let scheduled: { fn: () => void; ms: number; id: number }[];
let calls: { url: string; init: RequestInit | undefined }[];
let response: (url: string, init: RequestInit | undefined) => Promise<Response>;
const key = "standing-orders:chat-draft:7:task-a";
const request = "a".repeat(32);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const idle = { session: 7, task: "task-a", version: "v1", pending: false, received: false, approval: "" };
const thread = (messages: string, pending = "") =>
  `<div id="chat-thread" data-chat-region="thread"><div class="thread" data-key="thread" data-chat-list>${messages}</div>${pending}</div>`;
const message = (id: number, role: "op" | "mate", text: string, extra = "") =>
  `<div class="msg ${role}" data-message-role="${role === "op" ? "operator" : "assistant"}" data-key="m${id}"><p>${text}</p>${extra}<div class="chat-message-foot"><time datetime="2026-09-13T00:00:00Z">1m ago</time></div></div>`;
const card = (id: number, state: string) =>
  `<article class="card proposal proposal-hold ${state}" data-card-kind="hold"><details class="proposal-more"><summary>why</summary><p>reason</p></details>` +
  `<form method="post" action="/chat/proposal/${id}/confirm" class="inline"><button type="submit">hold</button></form></article>`;
const html = (options: { live?: string; messages?: string } = {}) =>
  `${options.live ?? ""}${thread(options.messages ?? message(1, "op", "Pause the export") + message(2, "mate", "I can pause it.", card(5, "pending")))}` +
  `<div class="chat-new-update-holder"><button type="button" id="chat-new-update" hidden>New update ↓</button></div>` +
  `<form action="/chat" class="composer" data-chat-session="7" data-chat-task="task-a" data-chat-user="alex" data-chat-version="v1" data-chat-busy="0" data-chat-approval="">` +
  `<input name="csrf" value="c"><input name="request" value="${request}"><input name="request-session" value="7"><input type="hidden" name="task" value="task-a"><textarea name="message"></textarea><button type="submit">send</button></form>` +
  `<p id="chat-connection"></p><p id="chat-reconnect" hidden><button type="button">Reconnect</button></p>` +
  `<div id="chat-after-composer" data-chat-region="after"></div>` +
  `<form action="/chat"><button type="submit" name="message" value="Brief me">brief me</button></form>` +
  `<form action="/chat/mate/end"><button type="submit">end</button></form>`;
const live = (approval: string, form = true) =>
  `<section id="task-chat-live" data-task="task-a" data-approval="${approval}" data-plan="drafted"><section class="card task-journey" data-key="journey"><h2>Planned</h2></section>` +
  (form ? `<section class="card chat-plan" id="task-chat-action" data-approval="${approval}"><details class="chat-approval"><summary>Review plan</summary><form method="post" action="/t/task-a/approve" class="approve-form"><input type="hidden" name="digest" value="${approval}"><input type="password" name="token"><button type="submit">Approve &amp; start</button></form></details></section>` : "") +
  `</section>`;

function mount(body: string): void {
  window.document.body.innerHTML = body;
}
beforeEach(() => {
  window = new Window({ url: "https://standing.test/chat?task=task-a" });
  scheduled = [];
  calls = [];
  let timerId = 0;
  window.setTimeout = ((fn: () => void, ms: number) => { const id = ++timerId; scheduled.push({ fn, ms, id }); return id; }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { scheduled = scheduled.filter(one => one.id !== id); }) as typeof window.clearTimeout;
  window.AbortSignal.timeout = () => new window.AbortController().signal;
  response = async () => json(idle);
  window.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return response(url, init); }) as unknown as typeof window.fetch;
  mount(html());
});
afterEach(async () => { await window.happyDOM.close(); });
const box = () => window.document.querySelector("textarea")!;
const form = () => window.document.querySelector("form.composer")!;
const status = () => window.document.getElementById("chat-connection")!.textContent;
const enter = (text: string) => { box().value = text; box().dispatchEvent(new window.Event("input")); };
const submit = (target: Element = form()) => target.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
const settle = () => new Promise(resolve => setImmediate(resolve));
const check = async () => { scheduled.shift()!.fn(); await settle(); await settle(); };
const posts = () => calls.filter(one => one.init?.method === "POST");
const polls = () => calls.filter(one => one.init?.method !== "POST");
const sendButton = () => form().querySelector("button[type=submit]") as HTMLButtonElement;

test("restores only this conversation/task's unexpired tab draft", () => {
  window.sessionStorage.setItem(key, JSON.stringify({ text: "Make the navigation clearer", request, at: Date.now() }));
  window.sessionStorage.setItem("standing-orders:chat-draft:6:task-a", JSON.stringify({ text: "old account", request, at: Date.now() }));
  window.sessionStorage.setItem("standing-orders:chat-draft:7:task-b", JSON.stringify({ text: "the other task", request, at: Date.now() }));
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(box().value).toBe("Make the navigation clearer");
  expect(window.sessionStorage.getItem("standing-orders:chat-draft:6:task-a")).toBeNull();
  // The other task's draft under the SAME session stays: it belongs to that lens.
  expect(JSON.parse(window.sessionStorage.getItem("standing-orders:chat-draft:7:task-b")!)).toMatchObject({ text: "the other task" });
  enter("Revise the navigation");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: "Revise the navigation", submitted: false });
});

test("the composer sends ONCE through the existing endpoint with its request key and session binding; a second submit is latched; prompt buttons keep their native submit and value", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Check the proof");
  let release!: (value: Response) => void;
  response = async (url, init) => init?.method === "POST" ? new Promise<Response>(resolve => { release = resolve; }) : json(idle);
  expect(submit()).toBe(false);
  expect(submit()).toBe(false);
  expect(posts()).toHaveLength(1);
  const sent = posts()[0]!;
  expect(sent.url).toBe("/chat");
  expect((sent.init!.headers as Record<string, string>)["accept"]).toBe("application/json");
  const body = new URLSearchParams(String(sent.init!.body));
  expect(body.get("message")).toBe("Check the proof");
  expect(body.get("request")).toBe(request);
  expect(body.get("request-session")).toBe("7");
  expect(body.get("task")).toBe("task-a");
  expect(status()).toBe("Sending…");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ submitted: true, request });
  release(json({ ok: true, session: 7, task: "task-a", request }, 202));
  await settle(); await settle();
  expect(status()).toContain("Waiting for the reply");
  // The draft is NOT cleared by the acceptance: only a receipt clears it.
  expect(box().value).toBe("Check the proof");
  const prompt = window.document.querySelectorAll('form[action="/chat"]')[1]!;
  expect(prompt.querySelector('[name="request"]')).not.toBeNull();
  expect(prompt.querySelector('[name="request-session"]')).not.toBeNull();
  expect(prompt.querySelector("button")!.disabled).toBe(false);
  expect(prompt.dispatchEvent(new window.Event("submit", { cancelable: true }))).toBe(true);
  expect(posts()).toHaveLength(1);
});

test("a lost send response is never retried by itself; the receipt clears the draft, and a newer edit survives the older send's receipt", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Show my tasks");
  response = async (url, init) => { if (init?.method === "POST") throw new Error("connection dropped"); return json(idle); };
  submit(); await settle(); await settle();
  expect(status()).toContain("Message not confirmed"); expect(box().value).toBe("Show my tasks");
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ submitted: true, request });
  // The poll asks after THAT request; still unreceived: the draft stays.
  await check();
  expect(polls().at(-1)!.url).toContain(`request=${request}`);
  expect(box().value).toBe("Show my tasks");
  expect(posts()).toHaveLength(1);
  // The receipt lands: the box clears, storage clears, a fresh request key is minted.
  response = async () => json({ ...idle, received: true });
  await check();
  expect(box().value).toBe(""); expect(window.sessionStorage.getItem(key)).toBeNull();
  expect((form().querySelector('[name="request"]') as HTMLInputElement).value).not.toBe(request);
  expect(polls().at(-1)!.url).toContain("request=");
  // Send again, then edit before the receipt: the edit is a NEW message under its own key.
  enter("Second message");
  response = async (url, init) => { if (init?.method === "POST") throw new Error("connection dropped"); return json(idle); };
  submit(); await settle(); await settle();
  const older = (form().querySelector('[name="request"]') as HTMLInputElement).value;
  enter("Second message, revised");
  const newer = (form().querySelector('[name="request"]') as HTMLInputElement).value;
  expect(newer).not.toBe(older);
  response = async () => json({ ...idle, received: true });
  await check();
  expect(polls().at(-1)!.url).toContain(`request=${older}`);
  expect(box().value).toBe("Second message, revised");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: "Second message, revised", submitted: false, request: newer });
  // Its receipt is settled: the next poll asks for nothing.
  await check();
  expect(polls().at(-1)!.url).not.toContain("request=");
});

test("after a reload the restored submitted draft settles on its receipt, and a refused send keeps the draft resendable", async () => {
  window.sessionStorage.setItem(key, JSON.stringify({ text: "Pause the export", request, submitted: true, at: Date.now() }));
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(box().value).toBe("Pause the export");
  response = async () => json({ ...idle, received: true });
  await check();
  expect(polls()[0]!.url).toContain(`request=${request}`);
  expect(box().value).toBe(""); expect(window.sessionStorage.getItem(key)).toBeNull();
  enter("Refused words");
  response = async (url, init) => init?.method === "POST" ? json({ ok: false, said: "a message is 1 to 2000 characters", session: 7 }, 400) : json(idle);
  submit(); await settle(); await settle();
  expect(status()).toBe("a message is 1 to 2000 characters");
  expect(box().value).toBe("Refused words");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ submitted: false });
  expect(sendButton().disabled).toBe(false);
});

test("a live reply reconciles the thread by key: the composer node, draft, caret, focus, and an open disclosure survive; New update appears only above the latest message and moves the reader by keyboard", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT);
  const composer = form(); const textarea = box();
  enter("While typing this"); textarea.focus(); textarea.setSelectionRange(5, 5);
  const details = window.document.querySelector("details.proposal-more") as HTMLDetailsElement;
  details.open = true;
  const oldMessage = window.document.querySelector('[data-key="m2"]')!;
  // The reader sits above the latest message.
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window.document.documentElement, "scrollHeight", { value: 2400, configurable: true });
  const scrolls: unknown[] = [];
  window.scrollTo = ((arg: unknown) => { scrolls.push(arg); }) as typeof window.scrollTo;
  window.scrollBy = (() => undefined) as typeof window.scrollBy;
  response = async () => json({ ...idle, version: "v2", fragments: {
    thread: thread(message(1, "op", "Pause the export") + message(2, "mate", "I can pause it.", card(5, "pending")) + message(3, "op", "While typing this") + message(4, "mate", "Paused.", card(6, "pending"))),
    after: `<div id="chat-after-composer" data-chat-region="after"></div>`,
    live: null,
  } });
  await check();
  expect(polls()[0]!.url).toContain("version=v1");
  expect(window.document.querySelectorAll(".msg")).toHaveLength(4);
  expect(window.document.querySelector("form.composer")).toBe(composer);
  expect(window.document.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("While typing this");
  expect(textarea.selectionStart).toBe(5);
  expect(window.document.activeElement).toBe(textarea);
  expect(window.document.querySelector('[data-key="m2"]')).toBe(oldMessage);
  expect((window.document.querySelector("details.proposal-more") as HTMLDetailsElement).open).toBe(true);
  const button = window.document.getElementById("chat-new-update") as HTMLButtonElement;
  expect(button.hidden).toBe(false);
  expect(scrolls).toEqual([]);
  button.focus();
  button.dispatchEvent(new window.Event("click", { bubbles: true }));
  expect(button.hidden).toBe(true);
  expect(scrolls).toHaveLength(1);
  expect(window.document.activeElement).toBe(window.document.querySelector('[data-key="m3"]'));
  // The next poll with the same version applies nothing and asks with the new version.
  response = async () => json({ ...idle, version: "v2" });
  await check();
  expect(polls().at(-1)!.url).toContain("version=v2");
  expect(window.document.querySelectorAll(".msg")).toHaveLength(4);
  // The new card's confirm form is actionable once, through the delegated latch.
  const confirm = window.document.querySelector('form[action="/chat/proposal/6/confirm"]')!;
  expect(submit(confirm)).toBe(true);
  expect(confirm.getAttribute("aria-busy")).toBe("true");
  expect(submit(confirm)).toBe(false);
});

test("a reader at the bottom follows new content without a New update button; a changed card is replaced while unchanged cards keep their nodes", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT);
  const scrolls: unknown[] = [];
  window.scrollTo = ((arg: unknown) => { scrolls.push(arg); }) as typeof window.scrollTo;
  const first = window.document.querySelector('[data-key="m1"]')!;
  response = async () => json({ ...idle, version: "v2", fragments: {
    thread: thread(message(1, "op", "Pause the export") + message(2, "mate", "I can pause it.", card(5, "confirmed")), `<div class="card chat-thinking" id="latest" data-key="pending"><p>Working</p></div>`),
    after: `<div id="chat-after-composer" data-chat-region="after"></div>`,
    live: null,
  } });
  await check();
  expect(window.document.querySelector('[data-key="m1"]')).toBe(first);
  expect(window.document.querySelector(".proposal.confirmed")).not.toBeNull();
  expect(window.document.querySelector(".proposal.pending")).toBeNull();
  expect(window.document.querySelector('[data-key="pending"]')).not.toBeNull();
  expect((window.document.getElementById("chat-new-update") as HTMLButtonElement).hidden).toBe(true);
  expect(scrolls).toHaveLength(1);
});

test("a changed session never discards the visible draft or sends under the new session: send waits for an explicit reconnection", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Keep this draft");
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  response = async () => json({ session: 8, task: "task-a", version: "v9", pending: false, received: false, approval: "" });
  await check();
  expect(reload).not.toHaveBeenCalled();
  expect(box().value).toBe("Keep this draft");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: "Keep this draft" });
  expect(status()).toContain("changed or ended");
  expect(sendButton().disabled).toBe(true);
  expect(submit()).toBe(false); expect(posts()).toHaveLength(0);
  expect((window.document.getElementById("chat-reconnect") as HTMLElement).hidden).toBe(false);
  expect(scheduled).toEqual([]);
  window.document.querySelector("#chat-reconnect button")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  expect(reload).toHaveBeenCalledOnce();
  // The explicit reconnection carries the words to the new session's page
  // as a NEW unsent draft under a fresh request key; the old key is gone.
  // The record is bound to the account the server named, the task, and
  // the moment it was written.
  expect(JSON.parse(window.sessionStorage.getItem("standing-orders:chat-carry:task-a")!)).toMatchObject({ text: "Keep this draft", owner: "alex", task: "task-a", at: expect.any(Number) });
  // The full journey: the reloaded page has NO composer (the mint card
  // stands where the conversation was), so the script does nothing and
  // the carry survives that page; the conversation minted next, for the
  // same account, restores the words.
  mount(`<form action="/chat/mate/mint"><input name="token"><button type="submit">start</button></form>`);
  scheduled = []; calls = [];
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(calls).toEqual([]);
  expect(JSON.parse(window.sessionStorage.getItem("standing-orders:chat-carry:task-a")!)).toMatchObject({ text: "Keep this draft" });
  mount(html().replace('data-chat-session="7"', 'data-chat-session="8"').replace('name="request-session" value="7"', 'name="request-session" value="8"').replace(`name="request" value="${request}"`, 'name="request" value="' + "d".repeat(32) + '"'));
  scheduled = []; calls = [];
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(box().value).toBe("Keep this draft");
  expect(window.sessionStorage.getItem("standing-orders:chat-carry:task-a")).toBeNull();
  expect(window.sessionStorage.getItem(key)).toBeNull();
  expect(JSON.parse(window.sessionStorage.getItem("standing-orders:chat-draft:8:task-a")!)).toMatchObject({ text: "Keep this draft", submitted: false, request: "d".repeat(32) });
  expect(sendButton().disabled).toBe(false);
  // Nothing was sent: the new page's first poll carries no request key.
  response = async () => json({ ...idle, session: 8 });
  await check();
  expect(polls()[0]!.url).not.toContain("request=");
  expect(posts()).toHaveLength(0);
});

test("a reconnect carry is honoured only for the account the server names, the same task, and within a day; anything else is discarded, never shown", () => {
  const carry = (fields: Record<string, unknown>) => JSON.stringify({ text: "Private draft from user A", at: Date.now(), owner: "alex", task: "task-a", ...fields });
  // Another account signs in on the same tab: user A's words never reach user B's composer, and the record is gone.
  window.sessionStorage.setItem("standing-orders:chat-carry:task-a", carry({ owner: "user-a" }));
  mount(html().replace('data-chat-user="alex"', 'data-chat-user="user-b"'));
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(box().value).toBe("");
  expect(window.sessionStorage.getItem("standing-orders:chat-carry:task-a")).toBeNull();
  expect(window.sessionStorage.getItem(key)).toBeNull();
  // A page the server did not bind to an account restores nothing either.
  window.sessionStorage.setItem("standing-orders:chat-carry:task-a", carry({}));
  mount(html().replace(' data-chat-user="alex"', "")); scheduled = []; calls = [];
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(box().value).toBe("");
  // The wrong task, or a record older than a day, is discarded too.
  window.sessionStorage.setItem("standing-orders:chat-carry:task-a", carry({ task: "task-b" }));
  mount(html()); scheduled = []; calls = [];
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(box().value).toBe("");
  window.sessionStorage.setItem("standing-orders:chat-carry:task-a", carry({ at: Date.now() - 86_400_001 }));
  mount(html()); scheduled = []; calls = [];
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(box().value).toBe("");
  // The same account, task, and day: restored once as a new unsent draft.
  window.sessionStorage.setItem("standing-orders:chat-carry:task-a", carry({}));
  mount(html()); scheduled = []; calls = [];
  window.eval(CHAT_CONTINUITY_SCRIPT);
  expect(box().value).toBe("Private draft from user A");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: "Private draft from user A", submitted: false });
  // A reconnection without a server-named account carries nothing.
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  mount(html().replace(' data-chat-user="alex"', "")); scheduled = []; calls = [];
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Unbound words");
  window.document.querySelector("#chat-reconnect button")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  expect(reload).toHaveBeenCalledOnce();
  expect(window.sessionStorage.getItem("standing-orders:chat-carry:task-a")).toBeNull();
});

test("an ended session ({session:null}), a lost sign-in, and an unavailable task each stop sending with their own words and keep the draft", async () => {
  for (const [answer, words] of [
    [async () => json({ session: null }), "changed or ended"],
    [async () => new Response("", { status: 401 }), "Sign in again"],
    [async () => json({ session: 7, task: "task-a", unavailable: true, received: false }), "no longer available"],
  ] as const) {
    mount(html()); scheduled = []; calls = [];
    window.eval(CHAT_CONTINUITY_SCRIPT); enter("Still here");
    response = answer as typeof response;
    await check();
    expect(status()).toContain(words);
    expect(box().value).toBe("Still here");
    expect(sendButton().disabled).toBe(true);
    expect((window.document.getElementById("chat-reconnect") as HTMLElement).hidden).toBe(false);
    expect(scheduled).toEqual([]);
  }
});

test("a late answer for another lens is ignored, and a bad refresh (503, malformed JSON, fragment without its region) changes nothing and retries", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Draft here");
  const before = window.document.getElementById("chat-thread")!.innerHTML;
  response = async () => json({ ...idle, task: "task-b", version: "other", fragments: { thread: thread(message(9, "op", "other task")), after: `<div id="chat-after-composer" data-chat-region="after"></div>`, live: null } });
  await check();
  expect(window.document.getElementById("chat-thread")!.innerHTML).toBe(before);
  expect(status()).toBe("");
  expect(sendButton().disabled).toBe(false);
  for (const bad of [new Response("bad", { status: 503 }), new Response("<html>", { status: 200 }), json({ session: 7, task: "task-a", version: "v3", pending: false, received: false, fragments: { thread: "<p>no region</p>" } })]) {
    response = async () => bad; await check();
    expect(status()).toContain("Reconnecting"); expect(scheduled.at(-1)!.ms).toBe(10000);
    expect(window.document.getElementById("chat-thread")!.innerHTML).toBe(before);
    expect(box().value).toBe("Draft here");
  }
  response = async () => json(idle); await check();
  expect(status()).toBe(""); expect(scheduled.at(-1)!.ms).toBe(5000);
});

test("an open approval form is never swapped: changed terms mark it stale, disable its submit, keep the typed password, and offer an explicit review", async () => {
  mount(html({ live: live("digest-old") }));
  window.eval(CHAT_CONTINUITY_SCRIPT);
  const password = window.document.querySelector('input[name="token"]') as HTMLInputElement;
  const approveForm = window.document.querySelector("form.approve-form")!;
  password.value = "hunter2"; password.focus();
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  response = async () => json({ ...idle, version: "v2", approval: "digest-new", fragments: {
    thread: thread(message(1, "op", "Pause the export") + message(2, "mate", "I can pause it.", card(5, "pending"))),
    after: `<div id="chat-after-composer" data-chat-region="after"></div>`,
    live: live("digest-new"),
  } });
  await check();
  expect(window.document.querySelector("form.approve-form")).toBe(approveForm);
  expect(password.value).toBe("hunter2");
  expect(window.document.activeElement).toBe(password);
  expect((approveForm.querySelector('[name="digest"]') as HTMLInputElement).value).toBe("digest-old");
  expect(approveForm.getAttribute("data-stale")).toBe("1");
  expect((approveForm.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(true);
  const note = window.document.querySelector(".chat-approval-stale")!;
  expect(note.textContent).toContain("The plan changed since this form opened");
  expect(window.document.getElementById("task-chat-live")!.getAttribute("data-approval")).toBe("digest-old");
  // Another poll adds no second notice; the explicit review reloads.
  await check();
  expect(window.document.querySelectorAll(".chat-approval-stale")).toHaveLength(1);
  note.querySelector("button")!.dispatchEvent(new window.Event("click", { bubbles: true }));
  expect(reload).toHaveBeenCalledOnce();
});

test("a live region WITHOUT an approval form refreshes in place, and one whose terms did not change is left alone with its form", async () => {
  mount(html({ live: live("", false) }));
  window.eval(CHAT_CONTINUITY_SCRIPT);
  response = async () => json({ ...idle, version: "v2", approval: "", fragments: {
    thread: thread(message(1, "op", "Pause the export") + message(2, "mate", "I can pause it.", card(5, "pending"))),
    after: `<div id="chat-after-composer" data-chat-region="after"></div>`,
    live: `<section id="task-chat-live" data-task="task-a" data-approval="" data-plan="requested"><section class="card task-journey" data-key="journey"><h2>Building</h2></section></section>`,
  } });
  await check();
  expect(window.document.querySelector("#task-chat-live h2")!.textContent).toBe("Building");
  expect(window.document.getElementById("task-chat-live")!.getAttribute("data-plan")).toBe("requested");
  mount(html({ live: live("same") })); scheduled = []; calls = [];
  window.eval(CHAT_CONTINUITY_SCRIPT);
  const approveForm = window.document.querySelector("form.approve-form")!;
  response = async () => json({ ...idle, version: "v2", approval: "same", fragments: { thread: thread(message(1, "op", "Pause the export")), after: `<div id="chat-after-composer" data-chat-region="after"></div>`, live: live("same") } });
  await check();
  expect(window.document.querySelector("form.approve-form")).toBe(approveForm);
  expect(approveForm.getAttribute("data-stale")).toBeNull();
  expect(window.document.querySelector(".chat-approval-stale")).toBeNull();
});

test("a pending reply keeps the draft editable but never auto-sends a follow-up", async () => {
  form().setAttribute("data-chat-busy", "1"); sendButton().disabled = true;
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Also check mobile spacing");
  expect(box().disabled).toBe(false); expect(sendButton().disabled).toBe(true);
  expect(submit()).toBe(false); expect(posts()).toHaveLength(0);
  response = async () => json({ ...idle, pending: true });
  await check();
  expect(status()).toContain("draft your next message"); expect(scheduled.at(-1)!.ms).toBe(2500);
  expect(box().value).toBe("Also check mobile spacing");
});

test("offline disables sending with its own words and keeps the draft; online re-enables and checks again", () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Offline draft");
  window.dispatchEvent(new window.Event("offline"));
  expect(status()).toContain("Offline"); expect(sendButton().disabled).toBe(true);
  expect(submit()).toBe(false); expect(posts()).toHaveLength(0);
  expect(box().value).toBe("Offline draft");
  scheduled = [];
  window.dispatchEvent(new window.Event("online"));
  expect(sendButton().disabled).toBe(false); expect(scheduled.at(-1)!.ms).toBe(0);
});

test("back navigation unlatches sending and ending a conversation clears its draft", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Inspect the result");
  response = async (url, init) => init?.method === "POST" ? new Promise<Response>(() => undefined) : json(idle);
  submit();
  expect(sendButton().disabled).toBe(true);
  window.dispatchEvent(new window.Event("pageshow"));
  expect(sendButton().disabled).toBe(false);
  window.document.querySelector('form[action="/chat/mate/end"]')!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  expect(window.sessionStorage.getItem(key)).toBeNull();
});

test("storage denial keeps the draft on the page, says so, and still sends through the endpoint once", async () => {
  vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("denied"); });
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Check status");
  expect(status()).toContain("storage is unavailable");
  response = async (url, init) => init?.method === "POST" ? json({ ok: true, session: 7, task: "task-a", request }, 202) : json(idle);
  expect(submit()).toBe(false); await settle(); await settle();
  expect(posts()).toHaveLength(1);
  expect(box().value).toBe("Check status");
});

test("a poll acknowledges only the request it asked about: a delayed receipt for send A neither clears nor settles a send B submitted meanwhile; each request is dispatched once and B waits for its own receipt", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("First request");
  let finishA!: (value: Response) => void;
  response = async (url, init) => init?.method === "POST" ? json({ ok: true, session: 7, task: "task-a" }, 202) : new Promise<Response>(resolve => { finishA = resolve; });
  submit(); await settle(); await settle();
  // Poll A starts, asking after A's key, and its answer is delayed.
  scheduled.shift()!.fn(); await settle();
  expect(polls().at(-1)!.url).toContain(`request=${request}`);
  expect(typeof finishA).toBe("function");
  // B is edited and SUBMITTED before A's answer lands: its own key, its own dispatch.
  enter("Newer request must survive");
  const keyB = (form().querySelector('[name="request"]') as HTMLInputElement).value;
  expect(keyB).not.toBe(request);
  submit(); await settle(); await settle();
  expect(posts()).toHaveLength(2);
  expect(posts().map(one => new URLSearchParams(String(one.init!.body)).get("request"))).toEqual([request, keyB]);
  // A's receipt arrives late: B's words and submitted draft stay exactly as they were.
  finishA(json({ ...idle, received: true })); await settle(); await settle();
  expect(box().value).toBe("Newer request must survive");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: "Newer request must survive", request: keyB, submitted: true });
  expect(status()).toContain("Message not confirmed");
  // The next poll asks after B's key, not A's; B clears only on B's receipt.
  response = async () => json({ ...idle, received: false });
  await check();
  expect(polls().at(-1)!.url).toContain(`request=${keyB}`);
  expect(box().value).toBe("Newer request must survive");
  response = async () => json({ ...idle, received: true });
  await check();
  expect(polls().at(-1)!.url).toContain(`request=${keyB}`);
  expect(box().value).toBe(""); expect(window.sessionStorage.getItem(key)).toBeNull();
  await check();
  expect(polls().at(-1)!.url).not.toContain("request=");
  expect(posts()).toHaveLength(2);
});

test("a changed version without its fragments is not taken as rendered: the page keeps asking with the version it shows, and a later complete answer lands", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Draft here");
  const before = window.document.getElementById("chat-thread")!.innerHTML;
  response = async () => json({ ...idle, version: "v2" });
  await check(); await check();
  expect(polls().at(-1)!.url).toContain("version=v1");
  expect(polls().at(-1)!.url).not.toContain("version=v2");
  expect(status()).toContain("Reconnecting"); expect(scheduled.at(-1)!.ms).toBe(10000);
  expect(window.document.getElementById("chat-thread")!.innerHTML).toBe(before);
  expect(box().value).toBe("Draft here");
  // Fragments of the wrong shape are the same malformed answer.
  response = async () => json({ ...idle, version: "v2", fragments: { thread: 7 } });
  await check();
  expect(polls().at(-1)!.url).toContain("version=v1");
  expect(window.document.getElementById("chat-thread")!.innerHTML).toBe(before);
  response = async () => json({ ...idle, version: "v2", fragments: { thread: thread(message(1, "op", "Pause the export") + message(2, "mate", "Paused.")), after: `<div id="chat-after-composer" data-chat-region="after"></div>`, live: null } });
  await check();
  expect(window.document.querySelector('[data-key="m2"] p')!.textContent).toBe("Paused.");
  await check();
  expect(polls().at(-1)!.url).toContain("version=v2");
  expect(status()).toBe("");
});

test("a malformed status ({}, a wrong-typed session, a missing task or version) is a bad refresh that retries without touching the draft; only a complete answer with session:null ends the conversation", async () => {
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Keep drafting");
  for (const bad of [{}, { session: { id: 7 } }, { session: true }, { session: 7 }, { session: 7, task: "task-a" }, { session: 7, task: "task-a", version: "v1", pending: "no", received: false }, { session: 7, task: "task-a", version: "v1", pending: false, received: false, approval: 3 }]) {
    response = async () => json(bad); await check();
    expect(status()).toContain("Reconnecting"); expect(scheduled.at(-1)!.ms).toBe(10000);
    expect(box().value).toBe("Keep drafting");
    expect(sendButton().disabled).toBe(false);
    expect((window.document.getElementById("chat-reconnect") as HTMLElement).hidden).toBe(true);
  }
  response = async () => json(idle); await check();
  expect(status()).toBe("");
  response = async () => json({ session: null }); await check();
  expect(status()).toContain("changed or ended");
  expect(sendButton().disabled).toBe(true); expect(box().value).toBe("Keep drafting");
  expect(scheduled).toEqual([]);
});

test("a task fragment held back while the reader is inside the live region lands after they leave it, with no further server change; an open approval form still holds the fragment back and keeps its stale notice", async () => {
  mount(html({ live: `<section id="task-chat-live" data-task="task-a" data-approval="" data-plan="drafted"><p data-key="state">Old task status</p><input name="guidance" value="Keep this guidance"></section>` }));
  window.eval(CHAT_CONTINUITY_SCRIPT);
  const input = window.document.querySelector('#task-chat-live input') as HTMLInputElement;
  input.focus();
  const composer = form();
  const fragments = (state: string) => ({
    thread: thread(message(1, "op", "Pause the export") + message(2, "mate", "I can pause it.", card(5, "pending"))),
    after: `<div id="chat-after-composer" data-chat-region="after"></div>`,
    live: `<section id="task-chat-live" data-task="task-a" data-approval="" data-plan="requested"><p data-key="state">${state}</p><input name="guidance" value="Keep this guidance"></section>`,
  });
  response = async () => json({ ...idle, version: "v2", fragments: fragments("New task status") });
  await check();
  expect(window.document.activeElement).toBe(input);
  expect(window.document.querySelector('#task-chat-live [data-key="state"]')!.textContent).toBe("Old task status");
  expect(window.document.getElementById("task-chat-live")!.getAttribute("data-plan")).toBe("drafted");
  expect(polls().at(-1)!.url).toContain("version=v1");
  // The version advanced (the thread rendered); the server has nothing new.
  response = async () => json({ ...idle, version: "v2" });
  await check();
  expect(polls().at(-1)!.url).toContain("version=v2");
  expect(window.document.querySelector('#task-chat-live [data-key="state"]')!.textContent).toBe("Old task status");
  // Leaving the field is enough: the held fragment lands on the next unchanged poll.
  input.blur();
  await check();
  expect(window.document.querySelector('#task-chat-live [data-key="state"]')!.textContent).toBe("New task status");
  expect(window.document.getElementById("task-chat-live")!.getAttribute("data-plan")).toBe("requested");
  expect(window.document.querySelector("form.composer")).toBe(composer);
  // It landed once: the next unchanged poll changes nothing more.
  const state = window.document.querySelector('#task-chat-live [data-key="state"]')!;
  await check();
  expect(window.document.querySelector('#task-chat-live [data-key="state"]')).toBe(state);
  // With an approval form open, changed terms are held back for the whole
  // life of that form: the stale notice speaks, the password stays.
  mount(html({ live: live("digest-old") })); scheduled = []; calls = [];
  window.eval(CHAT_CONTINUITY_SCRIPT);
  const password = window.document.querySelector('input[name="token"]') as HTMLInputElement;
  password.value = "hunter2"; password.focus();
  response = async () => json({ ...idle, version: "v2", approval: "digest-new", fragments: { thread: thread(message(1, "op", "Pause the export")), after: `<div id="chat-after-composer" data-chat-region="after"></div>`, live: live("digest-new") } });
  await check();
  password.blur();
  response = async () => json({ ...idle, version: "v2", approval: "digest-new" });
  await check(); await check();
  expect(window.document.querySelector("form.approve-form")!.getAttribute("data-stale")).toBe("1");
  expect(window.document.querySelectorAll(".chat-approval-stale")).toHaveLength(1);
  expect(password.value).toBe("hunter2");
  expect((window.document.querySelector('form.approve-form [name="digest"]') as HTMLInputElement).value).toBe("digest-old");
  expect(window.document.getElementById("task-chat-live")!.getAttribute("data-approval")).toBe("digest-old");
});

test("a fragment set that lacks a region this page has — after the composer, or the focused task's live region — is malformed whole: nothing renders and the version does not advance", async () => {
  mount(html({ live: live("", false) }));
  window.eval(CHAT_CONTINUITY_SCRIPT); enter("Draft here");
  const regions = () => ["chat-thread", "chat-after-composer", "task-chat-live"].map(id => window.document.getElementById(id)!.outerHTML).join("");
  const before = regions();
  const threadNow = thread(message(1, "op", "Pause the export") + message(2, "mate", "Paused."));
  for (const fragments of [
    { thread: threadNow, after: "<p>missing the after region</p>", live: `<section id="task-chat-live" data-task="task-a" data-approval="" data-plan="requested"></section>` },
    { thread: threadNow, after: `<div id="chat-after-composer" data-chat-region="after"></div>`, live: null },
    { thread: threadNow, after: `<div id="chat-after-composer" data-chat-region="after"></div>`, live: "<p>no live region</p>" },
  ]) {
    response = async () => json({ ...idle, version: "v2", fragments }); await check();
    expect(polls().at(-1)!.url).toContain("version=v1");
    expect(status()).toContain("Reconnecting");
    expect(regions()).toBe(before);
    expect(box().value).toBe("Draft here");
  }
  response = async () => json({ ...idle, version: "v2", fragments: { thread: threadNow, after: `<div id="chat-after-composer" data-chat-region="after"></div>`, live: `<section id="task-chat-live" data-task="task-a" data-approval="" data-plan="requested"><section class="card task-journey" data-key="journey"><h2>Building</h2></section></section>` } });
  await check(); await check();
  expect(polls().at(-1)!.url).toContain("version=v2");
  expect(window.document.querySelector("#task-chat-live h2")!.textContent).toBe("Building");
  expect(window.document.querySelector('[data-key="m2"] p')!.textContent).toBe("Paused.");
});

// ---- workspace package 3 (2026-09-13): the result detail beside the chat --
import { RESULT_REVIEW_SCRIPT } from "./result-review.js";

const panel = (run = "9") =>
  `<div class="chat-workspace task-chat-workspace result-open"><section class="chat-main">${html({ live: live("", false) })}</section>` +
  `<aside class="chat-result"><section class="card result-panel" id="result" data-result-panel data-result-place="chat" data-result-task="task-a" data-result-user="alex" data-result-run="${run}">` +
  `<nav class="result-tabs" role="tablist"><a role="tab" href="/chat?task=task-a&result=${run}" data-result-tab="summary" aria-selected="true">Summary</a><a role="tab" href="/chat?task=task-a&result=${run}&tab=changes" data-result-tab="changes" aria-selected="false" tabindex="-1">Changes</a><a role="tab" href="/chat?task=task-a&result=${run}&tab=checks" data-result-tab="checks" aria-selected="false" tabindex="-1">Checks</a></nav>` +
  `<div class="result-view" data-result-view="summary">summary</div><div class="result-view" data-result-view="changes" hidden><div class="diff-review" data-review-diff><button type="button" data-diff-mode="view" aria-pressed="true">View</button><button type="button" data-diff-mode="annotate" aria-pressed="false">Annotate</button><button type="button" class="pick-line" data-path="src/a.ts" data-line="2" data-side="new">pin</button></div></div><div class="result-view" data-result-view="checks" hidden>checks</div>` +
  `<section class="result-request" id="request-changes"><form method="post" action="/r/${run}/comment" class="diff-comment-form" id="comment-form"><input type="hidden" name="csrf" value="c"><input type="hidden" name="return" value="/chat?task=task-a&result=${run}"><input type="hidden" name="request" value="${"b".repeat(32)}">` +
  `<textarea name="note" maxlength="500"></textarea><span id="comment-note-limit"></span><details class="result-pin"><summary>Pin</summary><input type="text" name="path"><input type="text" name="line"></details><button type="submit">Add note</button></form></section></section></aside></div>`;
const reviewKey = "standing-orders:review-draft:alex:task-a:9";
const noteBox = () => window.document.querySelector('#comment-form [name="note"]') as HTMLTextAreaElement;
const noteForm = () => window.document.getElementById("comment-form")!;
const type = (text: string) => { noteBox().value = text; noteBox().dispatchEvent(new window.Event("input", { bubbles: true })); };

test("package 3: beside the chat, the note form posts natively ONCE (the conversation's latch owns it), the review draft is kept under account/task/run beside the chat draft, and a pin fills the form", () => {
  mount(panel());
  window.eval(CHAT_CONTINUITY_SCRIPT); window.eval(RESULT_REVIEW_SCRIPT);
  enter("Unsent chat words");
  type("Round the footer too.");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: "Unsent chat words" });
  expect(JSON.parse(window.sessionStorage.getItem(reviewKey)!)).toMatchObject({ note: "Round the footer too.", path: "", line: "", request: "b".repeat(32) });
  expect(window.document.getElementById("comment-note-limit")!.textContent).toBe("21 of 500 characters");
  // A pin from Annotate mode fills the target and opens the disclosure; the draft follows.
  (window.document.querySelector('button[data-diff-mode="annotate"]') as HTMLButtonElement).click();
  expect(window.document.querySelector("[data-review-diff]")!.getAttribute("data-mode")).toBe("annotate");
  (window.document.querySelector("button.pick-line") as HTMLButtonElement).click();
  expect((noteForm().querySelector('[name="path"]') as HTMLInputElement).value).toBe("src/a.ts");
  expect((noteForm().querySelector('[name="line"]') as HTMLInputElement).value).toBe("2");
  expect((noteForm().querySelector("details.result-pin") as HTMLDetailsElement).open).toBe(true);
  expect(JSON.parse(window.sessionStorage.getItem(reviewKey)!)).toMatchObject({ note: "Round the footer too.", path: "src/a.ts", line: "2" });
  // The native POST goes through once; a second submit is latched — by the conversation's handler, not refused by the panel's.
  expect(submit(noteForm())).toBe(true);
  expect(noteForm().getAttribute("aria-busy")).toBe("true");
  expect(submit(noteForm())).toBe(false);
  expect(posts()).toHaveLength(0);
  // Nothing was cleared by submitting: a refused post finds the draft waiting.
  expect(JSON.parse(window.sessionStorage.getItem(reviewKey)!)).toMatchObject({ note: "Round the footer too." });
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({ text: "Unsent chat words" });
});

test("package 3: the review draft is restored on return and cleared only by the receipt for ITS request token; another account's draft on the same tab is dropped, never shown", async () => {
  window.sessionStorage.setItem(reviewKey, JSON.stringify({ note: "Kept across Back", path: "src/a.ts", line: "2", request: "b".repeat(32), at: Date.now() }));
  window.sessionStorage.setItem("standing-orders:review-draft:sam:task-a:9", JSON.stringify({ note: "Sam's words", path: "", line: "", request: "c".repeat(32), at: Date.now() }));
  window.sessionStorage.setItem("standing-orders:review-draft:alex:task-a:9", JSON.stringify({ note: "Kept across Back", path: "src/a.ts", line: "2", request: "b".repeat(32), at: Date.now() }));
  mount(panel());
  window.eval(CHAT_CONTINUITY_SCRIPT); window.eval(RESULT_REVIEW_SCRIPT);
  expect(noteBox().value).toBe("Kept across Back");
  expect((noteForm().querySelector('[name="path"]') as HTMLInputElement).value).toBe("src/a.ts");
  expect((noteForm().querySelector("details.result-pin") as HTMLDetailsElement).open).toBe(true);
  expect((noteForm().querySelector('[name="request"]') as HTMLInputElement).value).toBe("b".repeat(32));
  expect(window.sessionStorage.getItem("standing-orders:review-draft:sam:task-a:9")).toBeNull();
  // A receipt for a DIFFERENT token leaves the draft; the receipt for this token clears it.
  await window.happyDOM.close();
  window = new Window({ url: `https://standing.test/chat?task=task-a&result=9&noted=${"d".repeat(32)}` });
  window.sessionStorage.setItem(reviewKey, JSON.stringify({ note: "Kept across Back", path: "", line: "", request: "b".repeat(32), at: Date.now() }));
  mount(panel());
  window.eval(RESULT_REVIEW_SCRIPT);
  expect(noteBox().value).toBe("Kept across Back");
  await window.happyDOM.close();
  window = new Window({ url: `https://standing.test/chat?task=task-a&result=9&noted=${"b".repeat(32)}` });
  window.sessionStorage.setItem(reviewKey, JSON.stringify({ note: "Kept across Back", path: "", line: "", request: "b".repeat(32), at: Date.now() }));
  mount(panel());
  window.eval(RESULT_REVIEW_SCRIPT);
  expect(noteBox().value).toBe("");
  expect(window.sessionStorage.getItem(reviewKey)).toBeNull();
  // Another run of the same task keeps its own draft key.
  await window.happyDOM.close();
  window = new Window({ url: "https://standing.test/chat?task=task-a&result=10" });
  window.sessionStorage.setItem(reviewKey, JSON.stringify({ note: "For run 9", path: "", line: "", request: "b".repeat(32), at: Date.now() }));
  mount(panel("10"));
  window.eval(RESULT_REVIEW_SCRIPT);
  expect(noteBox().value).toBe("");
  expect(JSON.parse(window.sessionStorage.getItem(reviewKey)!)).toMatchObject({ note: "For run 9" });
});

test("package 3: a tab switches in place and records ?tab= in the URL; the diff hides its pins until Annotate", async () => {
  await window.happyDOM.close();
  window = new Window({ url: "https://standing.test/chat?task=task-a&result=9" });
  mount(panel());
  window.eval(RESULT_REVIEW_SCRIPT);
  const changes = window.document.querySelector('[data-result-tab="changes"]') as HTMLAnchorElement;
  changes.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  expect((window.document.querySelector('[data-result-view="changes"]') as HTMLElement).hidden).toBe(false);
  expect((window.document.querySelector('[data-result-view="summary"]') as HTMLElement).hidden).toBe(true);
  expect(changes.getAttribute("aria-selected")).toBe("true");
  expect(window.location.href).toBe("https://standing.test/chat?task=task-a&result=9&tab=changes");
  expect(window.document.querySelector("[data-review-diff]")!.getAttribute("data-mode")).toBe("view");
});

// ---- repair 2026-09-14: a request identity is bound to what it sent ------
const requestOf = () => (noteForm().querySelector('[name="request"]') as HTMLInputElement).value;

test("repair c7: after a missed response, an unchanged retry keeps its request identity; editing the note or the file mints a new immutable one, so the earlier receipt cannot swallow the edited words", async () => {
  await window.happyDOM.close();
  window = new Window({ url: "https://standing.test/r/9" });
  mount(panel());
  window.eval(RESULT_REVIEW_SCRIPT);
  const first = requestOf();
  expect(first).toBe("b".repeat(32));
  type("Note A");
  // Submitted — the server records A under this token, but suppose the
  // response never reaches the document (the reviewer's fetch scenario).
  expect(submit(noteForm())).toBe(true);
  expect(JSON.parse(window.sessionStorage.getItem(reviewKey)!)).toMatchObject({ note: "Note A", request: first, sent: JSON.stringify(["Note A", "", ""]) });
  // An unchanged retry (the page came back, same words): same identity.
  noteBox().dispatchEvent(new window.Event("input", { bubbles: true }));
  expect(requestOf()).toBe(first);
  // Edited to B: a new identity, immediately, before any submit.
  type("Note B");
  const second = requestOf();
  expect(second).toMatch(/^[a-f0-9]{32}$/);
  expect(second).not.toBe(first);
  expect(JSON.parse(window.sessionStorage.getItem(reviewKey)!)).toMatchObject({ note: "Note B", request: second, sent: null });
  // The receipt for A's token no longer names this draft: B survives that receipt.
  await window.happyDOM.close();
  window = new Window({ url: `https://standing.test/r/9?noted=${first}#request-changes` });
  window.sessionStorage.setItem(reviewKey, JSON.stringify({ note: "Note B", path: "", line: "", request: second, sent: null, at: Date.now() }));
  mount(panel());
  window.eval(RESULT_REVIEW_SCRIPT);
  expect(noteBox().value).toBe("Note B");
  expect(requestOf()).toBe(second);
  // Changing only the pinned file after a submission rotates the identity too.
  window.document.querySelector("form")!.removeAttribute("aria-busy");
  expect(submit(noteForm())).toBe(true);
  expect(requestOf()).toBe(second);
  const pathBox = noteForm().querySelector('[name="path"]') as HTMLInputElement;
  pathBox.value = "src/a.ts"; pathBox.dispatchEvent(new window.Event("input", { bubbles: true }));
  const third = requestOf();
  expect(third).not.toBe(second);
  expect(JSON.parse(window.sessionStorage.getItem(reviewKey)!)).toMatchObject({ note: "Note B", path: "src/a.ts", request: third, sent: null });
});

test("repair c7: a refusal that names the conflicting token (?conflict=) keeps the words and mints a new identity, so the next submission is a new note rather than the same refusal", async () => {
  await window.happyDOM.close();
  window = new Window({ url: `https://standing.test/r/9?conflict=${"b".repeat(32)}#request-changes` });
  window.sessionStorage.setItem(reviewKey, JSON.stringify({ note: "Edited words the server refused under an old identity", path: "src/a.ts", line: "2", request: "b".repeat(32), sent: JSON.stringify(["Original words", "", ""]), at: Date.now() }));
  mount(panel());
  window.eval(RESULT_REVIEW_SCRIPT);
  expect(noteBox().value).toBe("Edited words the server refused under an old identity");
  expect((noteForm().querySelector('[name="path"]') as HTMLInputElement).value).toBe("src/a.ts");
  const fresh = requestOf();
  expect(fresh).toMatch(/^[a-f0-9]{32}$/);
  expect(fresh).not.toBe("b".repeat(32));
  expect(JSON.parse(window.sessionStorage.getItem(reviewKey)!)).toMatchObject({ request: fresh, sent: null });
  // A conflict for SOME OTHER token leaves this draft's identity alone.
  await window.happyDOM.close();
  window = new Window({ url: `https://standing.test/r/9?conflict=${"e".repeat(32)}` });
  window.sessionStorage.setItem(reviewKey, JSON.stringify({ note: "Mine", path: "", line: "", request: "b".repeat(32), sent: null, at: Date.now() }));
  mount(panel());
  window.eval(RESULT_REVIEW_SCRIPT);
  expect(requestOf()).toBe("b".repeat(32));
});


test("repair c7: FormData sent without a submit event still binds the payload; note, path, line and clearing the form rotate identity without losing edits", () => {
  mount(panel());
  window.eval(RESULT_REVIEW_SCRIPT);
  type("Direct fetch A");
  const original = requestOf();
  // The independent reproduction sends FormData with fetch: no submit event.
  const body = new window.FormData(noteForm());
  expect(body.get("request")).toBe(original);
  type("Direct fetch B");
  const edited = requestOf();
  expect(edited).not.toBe(original);
  noteBox().dispatchEvent(new window.Event("input", { bubbles: true }));
  expect(requestOf()).toBe(edited);
  for (const [name, value] of [["path", "src/export.ts"], ["line", "3"]]) {
    const before = requestOf();
    const input = noteForm().querySelector(`[name="${name}"]`) as HTMLInputElement;
    input.value = value!;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(requestOf()).not.toBe(before);
    expect(JSON.parse(window.sessionStorage.getItem(reviewKey)!)).toMatchObject({ note: "Direct fetch B", [name!]: value });
  }
  const beforeClear = requestOf();
  type("");
  expect(requestOf()).not.toBe(beforeClear);
});
