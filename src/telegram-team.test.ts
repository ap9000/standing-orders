/** Telegram in the shared team conversations (v72): a group follows one
 * conversation, a private chat can select one, messages enter the same
 * queue the browser uses, and replies come back through per-chat cursors. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { TeamLeads } from "./team-leads.js";
import { ceilingDigestOf } from "./principal.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { teamCommand, teamRequestId, PAIR_FIRST } from "./telegram-team.js";

const BOT = "777000";
const REPO = "/test/project";
const ALEX = { chat: 4242, user: 4242 };
const SAM = { chat: 8800, user: 8800 };
const GROUP = -100777;
const T0 = new Date("2026-09-21T18:00:00Z");

type Call = { method: string; params: Record<string, unknown> };
function scripted() {
  const calls: Call[] = [];
  const updates: unknown[][] = [];
  let next = 100;
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> });
    if (method === "getUpdates") return { ok: true, result: updates.shift() ?? [] };
    if (method === "sendMessage") return { ok: true, result: { message_id: next++ } };
    return { ok: true, result: true };
  };
  const sends = () => calls.filter(call => call.method === "sendMessage");
  const texts = (chat: number) => sends().filter(call => String(call.params["chat_id"]) === String(chat)).map(call => String(call.params["text"]));
  return { transport, calls, updates, sends, texts };
}
const textUpdate = (id: number, chat: { id: number; type: string }, from: number, text: string) => ({ update_id: id, message: { message_id: id, text, chat, from: { id: from } } });
const group = { id: GROUP, type: "supergroup" };
const priv = (id: number) => ({ id, type: "private" });

describe("Telegram team chats", () => {
  let dir: string, store: Store, alexToken: string, samToken: string, domain: TeamLeads, conversation: string, thread: number;
  const pairAs = (who: string, ids: { chat: number; user: number }) => {
    const code = mintPairingCode();
    store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: who, by: who, ttlMs: PAIRING_TTL_MS }, T0);
    expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(ids.chat), userId: String(ids.user), updateId: ids.user }, T0).ok).toBe(true);
  };
  const actor = (name: string) => ({ name, generation: store.accountOf(name)!.generation });
  const consent = (name: string) => store.mintTeamMateSession({ approver: name, approverGeneration: actor(name).generation, thread, credentialKey: "fixture", ceilingMicrousd: 0, ceilingDigest: ceilingDigestOf([REPO]), termsDigest: "t".repeat(64) }, T0);
  const pass = (script: ReturnType<typeof scripted>) => bridgePass(store, { botId: BOT, transport: script.transport, clock: () => T0, readProjects: async () => [REPO], conversation: { evidenceRoot: dir, phoneOrigin: () => "https://console.example" } });
  const queued = () => store.handle.prepare("SELECT q.author, q.request_id, q.status, m.text FROM team_message q JOIN mate_message m ON m.id = q.message WHERE q.conversation = ? ORDER BY q.message").all(conversation);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "so-telegram-team-"));
    store = openStore(join(dir, "orders.db"));
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("alex");
    alexToken = alex.token;
    const sam = addApprover(store, "sam", T0, { name: "alex", token: alexToken });
    if (!sam.ok) throw new Error("sam");
    samToken = sam.token;
    void samToken;
    store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", T0);
    domain = new TeamLeads(store, () => [REPO]);
    const lead = domain.execute(actor("alex"), { operation: "create-lead", args: { name: "Engineering", instructions: "Keep it simple.", projects: [REPO] } }, T0);
    if (!lead.ok) throw new Error(lead.message);
    const leadId = String((lead.result as { leadId: string }).leadId);
    const made = domain.execute(actor("alex"), { operation: "create-conversation", args: { leadId, title: "Website launch", visibility: "team", projects: [REPO] } }, T0);
    if (!made.ok) throw new Error(made.message);
    conversation = String((made.result as { conversationId: string }).conversationId);
    thread = Number((made.result as { threadId: number }).threadId);
    const joined = domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: true, expectedRevision: 1, joinLead: true, expectedLeadRevision: 1 } }, T0);
    if (!joined.ok) throw new Error(joined.message);
    pairAs("alex", ALEX);
    pairAs("sam", SAM);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("the /team command shapes", () => {
    expect(teamCommand("/team")).toEqual({ kind: "list" });
    expect(teamCommand("/team@so_bot 2")).toEqual({ kind: "select", index: 2 });
    expect(teamCommand("/team off")).toEqual({ kind: "off" });
    expect(teamCommand("/team private")).toEqual({ kind: "off" });
    expect(teamCommand("/teamwork")).toBeNull();
    expect(teamCommand("hello /team")).toBeNull();
  });

  test("a manager binds the group, paired members' messages enter the shared queue, unpaired chatter is silent, and consent is checked before saving", async () => {
    const script = scripted();
    // A group the bot merely sits in: silence, even for a paired member.
    script.updates.push([textUpdate(1, group, ALEX.user, "hello?")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { ignored: 1 } });
    expect(script.sends()).toHaveLength(0);
    // sam (contributor) lists nothing to bind; alex (manager) binds.
    script.updates.push([textUpdate(2, group, SAM.user, "/team")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toContain("No team conversation you manage");
    script.updates.push([textUpdate(3, group, ALEX.user, "/team")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toContain("1. Website launch — lead Engineering");
    script.updates.push([textUpdate(4, group, ALEX.user, "/team 1")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toContain("This group now follows Website launch (lead Engineering)");
    expect(store.telegramTeamChat(BOT, String(GROUP))).toMatchObject({ kind: "group", conversation, boundBy: "alex" });
    // An unpaired member's text is nobody's message; a slash attempt gets the one hint.
    script.updates.push([textUpdate(5, group, 9999, "ship it")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { ignored: 1 } });
    script.updates.push([textUpdate(6, group, 9999, "/help")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toBe(PAIR_FIRST);
    // sam has not enabled chat for this conversation: told, with the link, and nothing is saved.
    script.updates.push([textUpdate(7, group, SAM.user, "Add a criterion for the footer")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts(GROUP).at(-1)).toContain("enable chat for yourself in Standing Orders first");
    expect(script.sends().at(-1)!.params["reply_markup"]).toEqual({ inline_keyboard: [[{ text: "Enable chat", url: `https://console.example/chat?conversation=${conversation}` }]] });
    expect(queued()).toEqual([]);
    // With consent the message is saved once under its update identity, as sam.
    consent("sam");
    script.updates.push([textUpdate(8, group, SAM.user, "Add a criterion for the footer")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    expect(queued()).toEqual([{ author: "sam", request_id: teamRequestId(String(GROUP), 8), status: "queued", text: "Add a criterion for the footer" }]);
    // Nothing chatty was sent back for a saved message.
    expect(script.texts(GROUP).at(-1)).toContain("enable chat");
    // The lead answers (the runtime's job, simulated here); the next cycle carries the reply to the group.
    const claim = domain.claimNext("fixture-runner", T0)!;
    expect(claim).toMatchObject({ conversationId: conversation, actor: { name: "sam" } });
    expect(domain.finish(claim, { status: "answered", text: "Added: the footer must show the current year." }, T0)).toBe(true);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1, problems: [] } });
    expect(script.texts(GROUP).at(-1)).toBe("Added: the footer must show the current year.");
    // sam's own message is not echoed; alex's message from the browser is, with the author.
    expect(script.texts(GROUP).some(text => text.startsWith("sam:"))).toBe(false);
    consent("alex");
    expect(domain.execute(actor("alex"), { operation: "send", args: { conversationId: conversation, requestId: "web-1", text: "Also check the phone layout." } }, T0).ok).toBe(true);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(script.texts(GROUP).at(-1)).toBe("alex: Also check the phone layout.");
    // A second cycle with nothing new sends nothing: the cursor moved.
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 0 } });
    // A second group cannot follow the same conversation; /team off frees it.
    script.updates.push([textUpdate(9, { id: -100999, type: "supergroup" }, ALEX.user, "/team 1")]);
    await pass(script);
    expect(script.texts(-100999).at(-1)).toContain("Another group already follows that conversation");
    script.updates.push([textUpdate(10, group, SAM.user, "/team off")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toBe("This group follows nothing you can change.");
    script.updates.push([textUpdate(11, group, ALEX.user, "/team off")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toBe("This group no longer follows a conversation.");
    expect(store.telegramTeamChat(BOT, String(GROUP))).toBeNull();
  });

  test("lifecycle: a replayed update saves nothing twice, a removed member is refused, and a rotated credential ends a phone's voice while history stays", async () => {
    const script = scripted();
    consent("alex"); consent("sam");
    script.updates.push([textUpdate(1, group, ALEX.user, "/team 1")]);
    await pass(script);
    script.updates.push([textUpdate(2, group, SAM.user, "First point.")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    // Telegram redelivers the same update: applied once, saved once.
    script.updates.push([textUpdate(2, group, SAM.user, "First point.")]);
    const replay = await pass(script);
    expect(replay.ok && (replay.report.chatQueued ?? 0)).toBe(0);
    expect(queued()).toHaveLength(1);
    // Membership removal: sam's next message is refused in words; the saved one stays.
    const removed = domain.execute(actor("alex"), { operation: "member", args: { conversationId: conversation, account: "sam", role: "contributor", active: false, expectedRevision: 2 } }, T0);
    expect(removed.ok).toBe(true);
    script.updates.push([textUpdate(3, group, SAM.user, "Second point.")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatRefused: 1 } });
    expect(script.texts(GROUP).at(-1)).toMatch(/access|member|conversation/i);
    expect(queued()).toHaveLength(1);
    // Credential rotation: alex's binding no longer speaks; the group's history and binding remain.
    const rotated = addApprover(store, "alex", T0, { name: "alex", token: alexToken });
    expect(rotated.ok).toBe(true);
    expect(store.liveTelegramBindingFor(BOT, String(ALEX.user))).toBeNull();
    script.updates.push([textUpdate(4, group, ALEX.user, "/team")]);
    await pass(script);
    expect(script.texts(GROUP).at(-1)).toBe(PAIR_FIRST);
    expect(store.telegramTeamChat(BOT, String(GROUP))).toMatchObject({ conversation });
    expect(queued()).toHaveLength(1);
  });

  test("a private chat selects a conversation, talks there as itself, hears the reply once, and returns to its private assistant", async () => {
    const script = scripted();
    consent("alex");
    script.updates.push([textUpdate(1, priv(ALEX.chat), ALEX.user, "/team")]);
    await pass(script);
    expect(script.texts(ALEX.chat).at(-1)).toContain("1. Website launch — Team · lead Engineering");
    expect(script.texts(ALEX.chat).at(-1)).toContain("This chat talks to your private assistant.");
    script.updates.push([textUpdate(2, priv(ALEX.chat), ALEX.user, "/team 1")]);
    await pass(script);
    expect(script.texts(ALEX.chat).at(-1)).toContain("This chat now talks in Website launch");
    script.updates.push([textUpdate(3, priv(ALEX.chat), ALEX.user, "What is left before launch?")]);
    expect(await pass(script)).toMatchObject({ ok: true, report: { chatQueued: 1 } });
    expect(queued()).toEqual([{ author: "alex", request_id: teamRequestId(String(ALEX.chat), 3), status: "queued", text: "What is left before launch?" }]);
    // Nothing landed in the personal Telegram queue.
    expect(store.listTelegramConversations(BOT)).toEqual([]);
    const claim = domain.claimNext("fixture-runner", T0)!;
    expect(domain.finish(claim, { status: "answered", text: "Two tasks: the footer and the phone layout." }, T0)).toBe(true);
    expect(await pass(script)).toMatchObject({ ok: true, report: { sent: 1 } });
    expect(script.texts(ALEX.chat).at(-1)).toBe("Two tasks: the footer and the phone layout.");
    expect(script.texts(ALEX.chat).filter(text => text.startsWith("alex:"))).toEqual([]);
    script.updates.push([textUpdate(4, priv(ALEX.chat), ALEX.user, "/team off")]);
    await pass(script);
    expect(script.texts(ALEX.chat).at(-1)).toBe("Back to your private assistant.");
    expect(store.telegramTeamChat(BOT, String(ALEX.chat))).toBeNull();
    // An unpaired private chat asking for /team is told to pair.
    script.updates.push([textUpdate(5, priv(31337), 31337, "/team")]);
    await pass(script);
    expect(script.texts(31337).at(-1)).toBe(PAIR_FIRST);
  });
});
