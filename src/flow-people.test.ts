/**
 * People on flow cards: an owner, followers, comments with @mentions — and
 * each notification reaching only the person it concerns, on their own
 * phone, while "Tell the team" still reaches everyone.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { FLOW_TEMPLATES, type FlowDefinition } from "./flows.js";
import { addCardToFlow, advanceFlows, decideFlowCard, moveCardInFlow } from "./flow-engine.js";
import { assignFlowCard, commentOnFlowCard, mentionsIn, watchFlowCard } from "./flow-people.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { createDecisionServer } from "./serve.js";
import { flowView } from "./flows-ui.js";

const REPO = "/test/shop";
const BOT = "777000";
const ALEX = { chat: 4242, user: 4242 }, SAM = { chat: 8800, user: 8800 };
const T0 = new Date("2026-09-24T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let dir: string, store: Store, alexToken: string, samToken: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-people-")));
  store = openStore(join(dir, "orders.db"));
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("bootstrap");
  alexToken = alex.token;
  const sam = addApprover(store, "sam", T0, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("second");
  samToken = sam.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const flowWith = (change: (definition: FlowDefinition) => void = () => undefined) => {
  const definition = structuredClone(FLOW_TEMPLATES[0]!.definition);
  change(definition);
  return store.createFlow({ repo: REPO, name: "Bug fixes", definitionJson: JSON.stringify(definition), by: "alex" }, T0);
};
const newCard = (flow: number, title = "Checkout rounding", by = "alex", now = T0) => {
  const added = addCardToFlow(store, store.getFlow(flow)!, { title, description: null, stage: null }, by, now);
  if (!added.ok) throw new Error(added.message);
  return added.card;
};
const card = (id: number) => store.getFlowCard(id)!;
/** Who each pending notification is for, and what it says. */
const pings = () => store.listNotifications("all").filter(one => one.kind.startsWith("flow-")).map(one => [one.recipient, one.subject]);

describe("owners, followers and comments", () => {
  test("@mentions name real people; the author and whoever is mentioned follow; each ping goes to one person, never the one acting", () => {
    expect(mentionsIn("@sam can you look? cc @ALEX, @nobody and bob@example.com, @sam again.", ["alex", "sam"])).toEqual(["sam", "alex"]);
    const flow = flowWith();
    const id = newCard(flow);
    expect(store.flowCardWatchers(id)).toEqual(["alex"]);
    expect(commentOnFlowCard(store, card(id), "alex", "@sam can you take this one?", at(1))).toMatchObject({ ok: true, said: "Comment added. sam will hear about it.", mentions: ["sam"] });
    expect(store.flowCardWatchers(id)).toEqual(["alex", "sam"]);
    expect(pings()).toEqual([["sam", "Bug fixes: alex mentioned you on “Checkout rounding”"]]);
    expect(store.listNotifications("all").at(-1)).toMatchObject({ pushClass: "attention", link: `/flows/${flow}?card=${id}` });

    expect(assignFlowCard(store, card(id), "sam", "alex", at(2))).toMatchObject({ ok: true, said: "sam owns it now." });
    expect(assignFlowCard(store, card(id), "nobody-here", "alex", at(2))).toEqual({ ok: false, message: "nobody-here can't work on this project." });
    expect(pings().at(-1)).toEqual(["sam", "Bug fixes: You now own “Checkout rounding”"]);
    // sam answers: alex follows, so alex hears; sam, who wrote it, does not.
    commentOnFlowCard(store, card(id), "sam", "On it — looks like float maths.", at(3));
    expect(pings().at(-1)).toEqual(["alex", "Bug fixes: sam commented on “Checkout rounding”"]);
    expect(commentOnFlowCard(store, card(id), "sam", `the key is ${["ghp", "k".repeat(36)].join("_")}`, at(4))).toEqual({ ok: false, message: "That looks like a key or password. Keep secrets out of comments." });
    expect(commentOnFlowCard(store, card(id), "sam", "   ", at(4))).toEqual({ ok: false, message: "Write something first." });

    // alex stops following: sam's next comment reaches no one.
    watchFlowCard(store, card(id), "alex", false, at(5));
    const before = pings().length;
    commentOnFlowCard(store, card(id), "sam", "Fixed locally.", at(6));
    expect(pings()).toHaveLength(before);

    // The canvas shows who owns it, who follows, the discussion, and ownership in the history.
    const alexView = flowView(store, store.getFlow(flow)!, { name: "alex", approver: true }, null).cards[0]!;
    expect(alexView).toMatchObject({ owner: "sam", watchers: ["sam"], watching: false, mine: false });
    expect(alexView.comments.map(one => [one.author, one.body, one.mentions])).toEqual([["alex", "@sam can you take this one?", ["sam"]], ["sam", "On it — looks like float maths.", []], ["sam", "Fixed locally.", []]]);
    expect(alexView.history.map(one => one.text)).toContain("alex made sam the owner");
    expect(flowView(store, store.getFlow(flow)!, { name: "sam", approver: true }, null).cards[0]).toMatchObject({ mine: true, watching: true });
  });

  test("the flow tells the right person: a named decider alone, the owner when it's sent back, moved, stuck or approved, and followers when it's done", () => {
    const flow = flowWith(definition => { definition.stages.find(one => one.id === "go-ahead")!.approver = "sam"; });
    const id = newCard(flow);
    assignFlowCard(store, card(id), "alex", "alex", T0);
    // sam moves alex's card: alex hears.
    moveCardInFlow(store, card(id), "go-ahead", "sam", at(1));
    expect(pings().at(-1)).toEqual(["alex", "Bug fixes: sam moved “Checkout rounding” to Go ahead?"]);
    // The decision goes to sam alone.
    advanceFlows(store, REPO, at(2));
    expect(store.listNotifications("all").filter(one => one.kind === "flow-decision").map(one => [one.recipient, one.pushClass])).toEqual([["sam", "attention"]]);
    // Sent back: its owner hears why.
    expect(decideFlowCard(store, { card: id, decision: "send-back", note: "Needs steps to reproduce", actor: "sam", repos: [REPO] }, at(3))).toMatchObject({ ok: true });
    expect(pings().at(-1)).toEqual(["alex", "Bug fixes: sam sent “Checkout rounding” back"]);
    expect(store.listNotifications("all").at(-1)!.body).toBe("Sent back to Inbox:\n\nNeeds steps to reproduce");
    // Approved, then done: the owner and every follower hear it finished; "anyone who approves" still pages everyone.
    moveCardInFlow(store, card(id), "go-ahead", "alex", at(4));
    advanceFlows(store, REPO, at(5));
    decideFlowCard(store, { card: id, decision: "approve", note: null, actor: "sam", repos: [REPO] }, at(6));
    expect(pings().at(-1)).toEqual(["alex", "Bug fixes: sam approved “Checkout rounding”"]);
    watchFlowCard(store, card(id), "sam", true, at(7));
    store.moveFlowCard(id, { to: "done", outcome: "moved", actor: "alex" }, at(8));
    advanceFlows(store, REPO, at(9));
    expect(pings().filter(one => String(one[1]).includes("Done:")).sort()).toEqual([["alex", "Bug fixes: Done: “Checkout rounding”"], ["sam", "Bug fixes: Done: “Checkout rounding”"]]);
    // A card with no owner and anyone deciding: the decision pages everyone, as before.
    const open = flowWith();
    const other = newCard(open, "Open question");
    store.moveFlowCard(other, { to: "go-ahead", outcome: "moved", actor: "alex" }, at(10));
    advanceFlows(store, REPO, at(11));
    expect(store.listNotifications("all").filter(one => one.kind === "flow-decision").at(-1)!.recipient).toBeNull();
  });
});

describe("delivery", () => {
  const scripted = () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let next = 100;
    const transport: TelegramTransport = async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "getUpdates") return { ok: true, result: [] };
      if (method === "sendMessage") return { ok: true, result: { message_id: next++ } };
      return { ok: true, result: true };
    };
    const texts = (chat: number) => calls.filter(call => call.method === "sendMessage" && String(call.params["chat_id"]) === String(chat)).map(call => String(call.params["text"]));
    return { transport, texts };
  };
  const pairAs = (who: string, ids: { chat: number; user: number }) => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: who, by: who, ttlMs: PAIRING_TTL_MS }, T0);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(ids.chat), userId: String(ids.user), updateId: ids.user }, T0).ok).toBe(true);
  };

  test("each paired phone gets its own person's pings; a team message reaches both; channel webhooks and the pending count leave personal ones alone", async () => {
    pairAs("alex", ALEX);
    pairAs("sam", SAM);
    const flow = flowWith();
    const id = newCard(flow, "Checkout rounding", "alex", at(1));
    commentOnFlowCard(store, card(id), "alex", "@sam please look at this one", at(2));
    store.enqueueNotification({ dedupeKey: "flow:team:1", kind: "flow-message", subject: "Bug fixes: Shipped: Search", body: "Shipped: Search", source: { project: REPO }, pushClass: "attention" }, at(3));
    const script = scripted();
    await bridgePass(store, { botId: BOT, transport: script.transport, clock: () => at(4), readProjects: async () => [REPO] });
    expect(script.texts(SAM.chat).join("\n")).toContain("alex mentioned you on “Checkout rounding”");
    expect(script.texts(ALEX.chat).join("\n")).not.toContain("mentioned you");
    expect(script.texts(ALEX.chat).join("\n")).toContain("Shipped: Search");
    expect(script.texts(SAM.chat).join("\n")).toContain("Shipped: Search");
    // Channel-wide webhooks never take a personal notification, and it never sits in the console's pending count.
    expect(store.claimDeliveries("webhook", 60_000, at(5)).map(one => one.kind)).toEqual(["flow-message"]);
    expect(store.pendingForAttention().some(one => one.recipient !== null)).toBe(false);
  });

  test("the canvas's own endpoints: comment, take it on, follow — for the person signed in", async () => {
    const flow = flowWith();
    const id = newCard(flow);
    const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [REPO], configDir: dir });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const signIn = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
      const cookie = await signIn("sam", samToken);
      const csrf = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${base}/flows`, { headers: { cookie } })).text())![1]!;
      const post = async (verb: string, fields: Record<string, string>) => {
        const response = await fetch(`${base}/flows/${flow}/cards/${id}/${verb}`, { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf, ...fields }) });
        return { status: response.status, body: await response.json() as { ok: boolean; said: string; view?: { me: string; cards: { owner: string | null; watching: boolean; mine: boolean; comments: { author: string }[] }[] } } };
      };
      expect(await post("assign", { owner: "sam" })).toMatchObject({ status: 200, body: { said: "You own it now." } });
      const commented = await post("comment", { body: "Taking this, @alex" });
      expect(commented).toMatchObject({ status: 200, body: { said: "Comment added. alex will hear about it." } });
      expect(commented.body.view).toMatchObject({ me: "sam", cards: [{ owner: "sam", watching: true, mine: true, comments: [{ author: "sam" }] }] });
      expect(await post("watch", { watching: "no" })).toMatchObject({ status: 200 });
      expect(await post("comment", { body: "" })).toMatchObject({ status: 400, body: { said: "Write something first." } });
      expect(pings().at(-1)).toEqual(["alex", "Bug fixes: sam mentioned you on “Checkout rounding”"]);
      expect(alexToken).toBeTruthy();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
