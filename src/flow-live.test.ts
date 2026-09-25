/**
 * The live canvas (v88): a flow open in several browsers hears the moment it
 * changes, and each page learns who else has it open. The rooms are driven
 * with fake streams and a fake fingerprint; then the real server's
 * /flows/:id/live, with two signed-in people and a card that moves.
 */
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { createFlowRooms, flowFingerprint } from "./flow-live.js";
import { flowFromSteps } from "./flows.js";
import type { BrowserFlowView } from "./browser-workspace.js";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A stream that keeps what was written, and says when it ended. */
function stream() {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const response = Object.assign(emitter, {
    writableEnded: false, destroyed: false,
    write(chunk: string) { written.push(chunk); return true; },
    end() { if (!response.writableEnded) { response.writableEnded = true; emitter.emit("close"); } },
  });
  const events = () => written.filter(one => one.startsWith("event: ")).map(one => {
    const [head, data] = one.split("\n");
    return { event: head!.slice("event: ".length), data: JSON.parse(data!.slice("data: ".length)) as Record<string, unknown> };
  });
  return { response: response as unknown as ServerResponse & { writableEnded: boolean }, events, last: (name: string) => events().filter(one => one.event === name).at(-1)?.data };
}

test("rooms: the first events say where the flow stands and who's here; people merge by name; a change reaches everyone; a lapsed viewer is let go", async () => {
  let print = "a";
  const rooms = createFlowRooms(() => print, 5);
  const alex = stream(), sam = stream(), samAgain = stream(), lee = stream();
  let leeValid = true;
  rooms.join(1, { name: "alex", card: null, editing: false, response: alex.response, valid: () => true });
  expect(alex.events()).toEqual([{ event: "change", data: { at: "a" } }, { event: "here", data: { people: [] } }]);
  rooms.join(1, { name: "sam", card: 3, editing: false, response: sam.response, valid: () => true });
  rooms.join(1, { name: "sam", card: 4, editing: true, response: samAgain.response, valid: () => true });
  rooms.join(1, { name: "lee", card: null, editing: false, response: lee.response, valid: () => leeValid });
  await wait(250);
  // One line per person however many pages they have open, and never yourself.
  expect(alex.last("here")).toEqual({ people: [{ name: "lee", cards: [], editing: false }, { name: "sam", cards: [3, 4], editing: true }] });
  expect(sam.last("here")).toEqual({ people: [{ name: "alex", cards: [], editing: false }, { name: "lee", cards: [], editing: false }] });
  print = "b";
  await wait(30);
  for (const one of [alex, sam, samAgain, lee]) expect(one.last("change")).toEqual({ at: "b" });
  // Closing a page tells the others.
  samAgain.response.end();
  await wait(250);
  expect(alex.last("here")).toEqual({ people: [{ name: "lee", cards: [], editing: false }, { name: "sam", cards: [3], editing: false }] });
  // Someone signed out (or whose projects narrowed) hears "gone" and is let go at the next check.
  leeValid = false;
  await wait(150);
  expect(lee.last("gone")).toEqual({});
  expect(lee.response.writableEnded).toBe(true);
  await wait(250);
  expect(alex.last("here")).toEqual({ people: [{ name: "sam", cards: [3], editing: false }] });
  expect(rooms.size()).toBe(2);
  // The flow is gone: everyone hears it and is let go.
  const rooms2 = createFlowRooms(() => null, 5);
  const late = stream();
  rooms2.join(2, { name: "alex", card: null, editing: false, response: late.response, valid: () => true });
  await wait(30);
  expect(late.last("gone")).toEqual({});
  rooms.close();
  expect(alex.response.writableEnded && sam.response.writableEnded).toBe(true);
  expect(rooms.size()).toBe(0);
});

let dir: string, repo: string, store: Store, password: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-live-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", new Date());
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("fixture");
  password = alex.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("the fingerprint moves when a card is added, moved or commented on, and not otherwise", () => {
  const now = new Date("2026-09-25T10:00:00Z");
  const flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }, { title: "Done", kind: "done" }], null)) }, now);
  const first = flowFingerprint(store, flow);
  expect(first).toMatch(/^[a-f0-9]{16}$/);
  expect(flowFingerprint(store, flow)).toBe(first);
  const card = store.addFlowCard({ flow, title: "One", description: null, stage: "inbox", by: "alex" }, now);
  const added = flowFingerprint(store, flow);
  expect(added).not.toBe(first);
  store.addFlowComment({ card, author: "alex", body: "Looks fine", mentions: [] }, now);
  expect(flowFingerprint(store, flow)).not.toBe(added);
  expect(flowFingerprint(store, 999)).toBeNull();
});

test("/flows/:id/live: signed-in people only, the view carries where it stands, a teammate arriving is seen, and a moved card nudges the page", async () => {
  const sam = addApprover(store, "sam", new Date(), { name: "alex", token: password });
  if (!sam.ok) throw new Error("fixture");
  const flow = store.createFlow({ repo, name: "Support", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }, { title: "Done", kind: "done" }], null)) }, new Date());
  const card = store.addFlowCard({ flow, title: "Refund for order 42?", description: null, stage: "inbox", by: "alex" }, new Date());
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], configDir: dir });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
    const alexCookie = await signIn("alex", password), samCookie = await signIn("sam", sam.token);
    // Signed out: sent to sign in, never a stream.
    const stranger = await fetch(`${base}/flows/${flow}/live`, { redirect: "manual" });
    expect(stranger.status).not.toBe(200);
    expect(stranger.headers.get("content-type")).not.toBe("text/event-stream");
    expect((await fetch(`${base}/flows/999/live`, { headers: { cookie: alexCookie } })).status).toBe(404);
    const view = await (await fetch(`${base}/flows/${flow}?format=json`, { headers: { cookie: alexCookie } })).json() as BrowserFlowView;
    expect(view.live).toMatch(/^[a-f0-9]{16}$/);
    /** An open stream, read as it arrives. */
    const open = async (cookie: string, query = "") => {
      const response = await fetch(`${base}/flows/${flow}/live${query}`, { headers: { cookie } });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const reader = response.body!.getReader();
      readers.push(reader);
      let text = "";
      // One read in flight at a time: a read that loses the race keeps its chunk for the next turn.
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
      const until = async (seen: (text: string) => boolean) => {
        const deadline = Date.now() + 5000;
        while (!seen(text)) {
          if (Date.now() > deadline) throw new Error(`timed out; had: ${text}`);
          pending ??= reader.read();
          const chunk = await Promise.race([pending, wait(200).then(() => null)]);
          if (chunk === null) continue;
          pending = null;
          if (chunk.value !== undefined) text += new TextDecoder().decode(chunk.value);
        }
        return text;
      };
      return { until, text: () => text };
    };
    const alex = await open(alexCookie);
    // The page already shows where the flow stands: the first nudge names the same place.
    expect(await alex.until(text => text.includes("event: here"))).toContain(`event: change\ndata: {"at":"${view.live}"}`);
    await open(samCookie, `?card=${card}`);
    expect(await alex.until(text => text.includes('"name":"sam"'))).toContain(`event: here\ndata: {"people":[{"name":"sam","cards":[${card}],"editing":false}]}`);
    // A card moved anywhere (here, the store directly, as the worker would): the page hears it within a second or so.
    const before = alex.text().length;
    expect(store.moveFlowCard(card, { to: "done", outcome: "moved", actor: "sam" }, new Date())).toBe(true);
    await alex.until(text => text.slice(before).includes("event: change"));
    const moved = await (await fetch(`${base}/flows/${flow}?format=json`, { headers: { cookie: alexCookie } })).json() as BrowserFlowView;
    expect(alex.text().slice(before)).toContain(`"at":"${moved.live}"`);
  } finally {
    for (const reader of readers) await reader.cancel().catch(() => undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
