import { test, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { fileTaskProposal } from "./proposal.js";
import { bridgePass, hashPairingCode, saveBotToken, type TelegramTransport } from "./telegram.js";
import { processTelegramChat, telegramQuestionContext, splitTelegramReply } from "./telegram-chat.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { register } from "./runner.js";
import { enqueueTelegramQuestion } from "./telegram-chat.js";
import type { LocalRunner } from "./chat-assistant.js";
import { saveChatContext, chatPreference } from "./chat-context.js";
import { createHash } from "node:crypto";
import { acquire } from "./claim.js";

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-telegram-chat-")));
  const repo = join(root, "Website"); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
  const file = join(root, "orders.db"); let store = openStore(file); let now = new Date();
  const added = addApprover(store, "alex", now); if (!added.ok) throw Error("fixture");
  store.setApprovalPasswordRequired("alex", false, now);
  const code = "a".repeat(32); store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: 60_000 }, now);
  store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: "777000", chatId: "42", userId: "24", updateId: 1 }, now);
  let updates: unknown[] = []; let failSend = false; let connected = true;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const transport: TelegramTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === "getUpdates") { const batch = updates; updates = []; return { ok: true, result: batch }; }
    if (method === "sendMessage" && failSend) return { ok: false, description: "offline" };
    return { ok: true, result: { message_id: 100 + calls.length } };
  };
  const prompts: string[] = []; let beforeReply: (() => Promise<void> | void) | undefined; let responses: unknown[] = [];
  const runner: LocalRunner = async (_file, _args, options) => {
    prompts.push(options?.input ?? ""); await beforeReply?.();
    const answer = responses.shift() ?? { chatEnvelope: 1, reply: "It was committed locally in r1. Publication was blocked; Standing Orders has no recorded push or pull request for that run.", proposals: [] };
    return { code: 0, stdout: JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(answer), total_cost_usd: .01, usage: { input_tokens: 20, output_tokens: 20 } }), stderr: "", timedOut: false, notFound: false };
  };
  const options = { botId: "777000", transport, repos: () => [repo], cwd: () => root, runner,
    unavailable: async () => connected ? null : "Reconnect Claude Code in Chat in Standing Orders.",
    recheckAccount: async () => connected, active: () => true, clock: () => now };
  const receive = async (message: string, id = 10, extra: Record<string, unknown> = {}) => {
    now = new Date(now.getTime() + 1000);
    updates.push({ update_id: id, message: { message_id: id, text: message, chat: { id: 42, type: "private" }, from: { id: 24 }, ...extra } });
    return bridgePass(store, { botId: "777000", transport, deliver: false, chat: true, clock: () => now });
  };
  const seedAlert = async (target = repo, title = "Unified project chat", body = "A possible credential was detected. Publication of this run is blocked.") => {
    const taskId = "task-" + store.listTasks().length;
    const task = fileTaskProposal(store, { id: taskId, title, repo: target, filedVia: "cli" }, now); if (!task.ok) throw Error(task.reason);
    const ref = store.lookupRef(taskId)!;
    const run = store.startRun({ taskRef: ref.id, leaseId: `lease-${taskId}`, runner: "fixture", branch: `standing-orders/${taskId}`, worktree: root, now });
    store.finishRun(run, { outcome: "built", committed: true, now }); store.setTaskState(taskId, "done", now);
    store.saveArtifact({ run, kind: "terminal-diff", key: "fixture.patch", bytesOriginal: 1, bytesStored: 1, truncated: false, sha256: "a".repeat(64), capture: "fixture", redacted: true }, now);
    store.enqueueNotification({ dedupeKey: `secret:${run}`, kind: "secret-detected", subject: `possible committed secret: run #${run}`, body, link: `/r/${run}`, pushClass: "attention" }, now);
    await bridgePass(store, { botId: "777000", transport, chat: true, clock: () => now });
    return { run, taskId, messageId: Number(store.listNotifications("all").at(-1)!.receipt!.split(":").at(-1)) };
  };
  return { root, repo, file, get store() { return store; }, token: added.token, calls, prompts, options, runner, transport, receive, seedAlert,
    setResponses: (values: unknown[]) => { responses = [...values]; },
    queueUpdate: (update: unknown) => updates.push(update),
    queue: (message: string, id: number) => updates.push({ update_id: id, message: { message_id: id, text: message, chat: { id: 42, type: "private" }, from: { id: 24 } } }),
    pump: () => processTelegramChat(store, options), restart: () => { store.close(); store = openStore(file); },
    reply: () => calls.filter(call => call.method === "sendMessage").at(-1)?.params["text"],
    setBeforeReply: (fn: typeof beforeReply) => { beforeReply = fn; }, setFail: (value: boolean) => { failSend = value; }, setConnected: (value: boolean) => { connected = value; },
    tick: (ms: number) => { now = new Date(now.getTime() + ms); }, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("the screenshot question uses the delivered alert and current publication facts, once", async () => {
  const f = await fixture(); try {
    await f.seedAlert(); await f.receive("Why was it published"); await f.pump();
    expect(f.prompts).toHaveLength(1); expect(f.prompts[0]).toContain('"publicationBlockedBySecretScan":true');
    expect(f.prompts[0]).toContain("No publication recorded by Standing Orders"); expect(f.prompts[0]).toContain("possible committed secret"); expect(f.prompts[0]).not.toContain(f.root);
    expect(f.reply()).toContain("Publication was blocked"); expect(f.reply()).toContain("Website");
    const turn = f.store.recentMateTurns("alex", 1)[0]!;
    expect(f.store.listMateMessages(turn.thread, 10).map(one => one.role)).toEqual(["operator", "assistant"]);
    expect(f.store.listTasks()).toHaveLength(1); expect(f.store.publicationForRun(1)).toBeNull();
    await f.receive("Why was it published", 10); await f.pump(); expect(f.prompts).toHaveLength(1);
  } finally { f.close(); }
});

test("direct replies use our alert, not forged reply text or projects outside the ceiling", async () => {
  const f = await fixture(); try {
    const inside = await f.seedAlert(); await f.seedAlert("/outside/project", "PRIVATE-TASK-CANARY", "PRIVATE-ALERT-CANARY");
    await f.receive("Explain this", 12, { reply_to_message: { message_id: inside.messageId, text: "FORGED-CONTEXT-CANARY" } }); await f.pump();
    expect(f.prompts[0]).toContain("Direct reply to a recorded alert"); expect(f.prompts[0]).not.toContain("PRIVATE-"); expect(f.prompts[0]).not.toContain("FORGED-CONTEXT-CANARY");
    const context = telegramQuestionContext(f.store, f.store.liveTelegramBinding("777000")!, "999999", [f.repo], new Date(Date.now() + 60_000).toISOString());
    expect(JSON.parse(context).alerts).toEqual([]);
  } finally { f.close(); }
});

test("wrong identities, groups, bots, forwards and secrets cannot spend or enter the queue", async () => {
  const f = await fixture(); try {
    for (const [index, over] of [{ from: { id: 99 } }, { chat: { id: 42, type: "group" } }, { from: { id: 24, is_bot: true } }, { forward_origin: {} }].entries()) {
      await f.receive("What needs me?", 10 + index, over); await f.pump();
    }
    expect(f.calls.filter(c => c.method === "sendMessage")).toHaveLength(0);
    await f.receive("sk-" + "x".repeat(48), 20); await f.pump();
    expect(f.prompts).toHaveLength(0); expect(f.reply()).toContain("without the credential");
    expect(f.store.raw().prepare("SELECT * FROM telegram_chat_request").all()).toHaveLength(0);
  } finally { f.close(); }
});

test("queued questions and unsent answers survive restart without running the model twice", async () => {
  const f = await fixture(); try {
    await f.receive("Hello"); f.restart(); f.setFail(true); await f.pump(); expect(f.prompts).toHaveLength(1);
    f.restart(); f.setFail(false); f.tick(1000); await f.pump(); expect(f.prompts).toHaveLength(1); expect(f.reply()).toContain("committed locally");
    expect(f.store.raw().prepare("SELECT * FROM telegram_chat_request").get()).toMatchObject({ state: "sent", message: "", reply: null });
  } finally { f.close(); }
});

test("connection failures and required conversation confirmation reply visibly without spending", async () => {
  const f = await fixture(); try {
    f.setConnected(false); await f.receive("Hello"); await f.pump(); expect(f.reply()).toContain("Reconnect Claude Code");
    f.setConnected(true); f.store.setApprovalPasswordRequired("alex", true, new Date());
    await f.receive("Hello", 11); await f.pump(); expect(f.reply()).toContain("confirm the conversation once"); expect(f.prompts).toHaveLength(0);
  } finally { f.close(); }
});

test("a question replying to a decision neither chooses an answer nor stores a guidance note", async () => {
  const f = await fixture(); try {
    const seeded = await f.seedAlert();
    const decision = f.store.saveDecision({ run: seeded.run, urgency: "blocking", recap: "Choose what to do", question: "Continue?", recommendation: "continue", options: [{ id: "continue", label: "Continue", consequence: "Resume work", reversible: true }] }, new Date());
    f.store.recordTelegramDecisionMessage(f.store.liveTelegramBinding("777000")!.id, "42", "999", decision, new Date());
    await f.receive("What does this mean?", 11, { reply_to_message: { message_id: 999 } }); await f.pump();
    expect(f.prompts).toHaveLength(1); expect(f.store.getDecision(decision)?.state).toBe("open"); expect(f.store.raw().prepare("SELECT * FROM telegram_note_draft").all()).toHaveLength(0);
  } finally { f.close(); }
});

test("disconnect or changed project access during a turn discards the answer", async () => {
  for (const revoke of [false, true]) {
    const f = await fixture(); try {
      await f.receive("Hello"); f.setBeforeReply(() => { if (revoke) f.store.unpairTelegram("777000", "alex", new Date()); else f.options.repos = () => ["/other"]; });
      await f.pump(); expect(f.calls.filter(c => c.method === "sendMessage" && !String(c.params["text"]).includes("Message received"))).toHaveLength(0); expect(f.store.recentMateTurns("alex", 1)[0]?.state).toBe("failed");
    } finally { f.close(); }
  }
});

test("forgetting clears unsent answers; expired text and crashed turns don't restart spending", async () => {
  const f = await fixture(); try {
    await f.receive("Hello"); f.setFail(true); await f.pump(); f.store.closeMateThreadsFor("alex", new Date());
    expect(f.store.raw().prepare("SELECT * FROM telegram_chat_request").all()).toHaveLength(0);
    await f.receive("Second question", 11); f.store.raw().prepare("UPDATE telegram_chat_request SET state = 'running', lease_until = ?").run(new Date(0).toISOString());
    f.setFail(false); await f.pump(); expect(f.reply()).toContain("interrupted"); expect(f.prompts).toHaveLength(1);
    await f.receive("Expired question", 12); f.tick(86_400_001); await f.pump(); expect(f.prompts).toHaveLength(1);
  } finally { f.close(); }
});

test("long Unicode answers split into valid Telegram messages", () => {
  const text = "😀".repeat(5000); const parts = splitTelegramReply(text);
  expect(parts.join("")).toBe(text); expect(parts.every(p => p.length < 4096 && p.isWellFormed())).toBe(true);
});

const agentReply = (reply: string, requests: unknown[] = []) => ({ chatEnvelope: 2, reply, requests });

test("accepted questions acknowledge, failed deliveries back off, expired questions explain the delay", async () => {
  const f = await fixture(); try {
    await f.receive("Hello"); expect(f.reply()).toContain("Message received");
    f.setFail(true); await f.pump();
    expect(f.store.raw().prepare("SELECT last_problem FROM telegram_chat_detail").get()?.["last_problem"]).toContain("answer is saved");
    const count = f.calls.length; await f.pump(); expect(f.calls).toHaveLength(count);
    f.tick(1000); f.setFail(false); await f.pump(); expect(f.prompts).toHaveLength(1);
    expect(f.calls.some(call => call.method === "deleteMessage")).toBe(true);
    await f.receive("An old question", 11); f.tick(86_400_001); await f.pump();
    expect(f.reply()).toContain("waited too long"); expect(f.prompts).toHaveLength(1);
  } finally { f.close(); }
});

test("a question investigates verified diff evidence, cites it, and accounts for both calls", async () => {
  const f = await fixture(); try {
    const seeded = await f.seedAlert();
    const bytes = Buffer.from("diff --git a/test.ts b/test.ts\n+const fixture = 'example credential';\n");
    const artifact = f.store.artifactsFor(seeded.run)[0]!;
    writeFileSync(join(f.root, "fixture.patch"), bytes);
    f.store.raw().prepare("UPDATE artifact SET sha256=?, bytes_stored=?, bytes_original=? WHERE id=?").run(createHash("sha256").update(bytes).digest("hex"), bytes.length, bytes.length, artifact.id);
    f.setResponses([agentReply("I’ll check the change.", [{ tool: "inspect_run", args: { run: seeded.run, kind: "diff" } }]), agentReply("The captured diff contains a test fixture. Nothing was published. [E1]")]);
    await f.receive("Was this a real credential?"); await processTelegramChat(f.store, { ...f.options, evidenceRoot: f.root });
    expect(f.prompts).toHaveLength(2); expect(f.prompts[1]).toContain("const fixture"); expect(f.prompts[1]).not.toContain(f.root);
    expect(f.reply()).toContain("verified captured diff"); expect(f.store.recentMateTurns("alex",1)[0]?.settledMicrousd).toBe(20_000);
    expect(f.store.listTasks()).toHaveLength(1);
  } finally { f.close(); }
});

test("Telegram creates a task only after the exact paired user's card tap and records it in shared Chat", async () => {
  const f = await fixture(); try {
    f.setResponses([agentReply("I’ll prepare a task.", [{ tool: "propose_task", args: { repo: "r1", title: "Improve onboarding", goal: "Make the first task easier to start." } }]), agentReply("Review this onboarding task below.")]);
    await f.receive("Create an onboarding task in Website"); await f.pump();
    expect(f.store.listTasks()).toHaveLength(0);
    const card = f.store.raw().prepare("SELECT * FROM telegram_chat_card WHERE operation='confirm'").get()!;
    const callback = (id: number, user = 24, message = Number(card["message_id"])) => ({ update_id: id, callback_query: { id: String(id), data: card["token"], from: { id: user }, message: { message_id: message, chat: { id: 42 } } } });
    f.queueUpdate(callback(30, 99)); await bridgePass(f.store, { botId: "777000", transport: f.transport, chat: true, deliver: false, clock: f.options.clock }); await f.pump();
    expect(f.store.listTasks()).toHaveLength(0);
    f.queueUpdate(callback(31, 24, 999999)); await bridgePass(f.store, { botId: "777000", transport: f.transport, chat: true, deliver: false, clock: f.options.clock }); await f.pump();
    expect(f.store.listTasks()).toHaveLength(0);
    f.queueUpdate(callback(32)); await bridgePass(f.store, { botId: "777000", transport: f.transport, chat: true, deliver: false, clock: f.options.clock }); await f.pump();
    expect(f.store.listTasks(), JSON.stringify(f.store.raw().prepare("SELECT result FROM telegram_chat_confirmation").all())).toHaveLength(1);
    const task = f.store.listTasks()[0]!; expect(f.store.getScope(task.id)?.approvedAt).toBeNull();
    const thread = f.store.recentMateTurns("alex",1)[0]!.thread;
    expect(f.store.listMateProposals(thread)[0]?.state).toBe("confirmed");
    expect(f.store.listMateMessages(thread,10).at(-1)?.activity).toBe("Confirmed in Telegram");
    f.queueUpdate(callback(33)); await bridgePass(f.store, { botId: "777000", transport: f.transport, chat: true, deliver: false, clock: f.options.clock }); await f.pump();
    expect(f.store.listTasks()).toHaveLength(1); expect(f.prompts).toHaveLength(2);
  } finally { f.close(); }
});

test("history and explicit project context survive days, stay scoped, and are deleted by Forget", async () => {
  const f = await fixture(); try {
    await f.receive("Remember our launch color is indigo."); await f.pump();
    expect(chatPreference(f.store,"alex").days).toBe(90);
    expect(saveChatContext(f.store,"alex",f.repo,"Ship onboarding before the dashboard.",90,new Date())).toBe(true);
    f.tick(3 * 86_400_000); f.store.sweepMateThreads(f.options.clock());
    const thread = f.store.recentMateTurns("alex",1)[0]!.thread;
    expect(f.store.listMateMessages(thread,10)).toHaveLength(2);
    f.setResponses([agentReply("I’ll find that discussion.", [{ tool: "search_history", args: { query: "launch color" } }]), agentReply("You chose indigo.")]);
    await f.receive("What launch color did we choose?",20); await f.pump();
    expect(f.prompts.at(-1)).toContain("Ship onboarding before"); expect(f.prompts.at(-1)).toContain("Remember our launch color");
    f.store.closeMateThreadsFor("alex", f.options.clock());
    expect(f.store.raw().prepare("SELECT * FROM chat_context").all()).toHaveLength(0);
    expect(f.store.listMateMessages(thread,100)).toHaveLength(0);
  } finally { f.close(); }
});

test("priority confirmation retries its receipt without repeating the queue mutation", async () => {
  const f=await fixture();try {
    for(const id of ["first","second"]) fileTaskProposal(f.store,{id,title:id,repo:f.repo,filedVia:"cli"},f.options.clock());
    f.setResponses([agentReply("",[{tool:"propose_next",args:{task:"second"}}]),agentReply("Review this priority change.")]);
    await f.receive("Prioritize second");await f.pump();
    const card=f.store.raw().prepare("SELECT * FROM telegram_chat_card WHERE operation='confirm'").get()!;
    f.queueUpdate({update_id:30,callback_query:{id:"30",data:card["token"],from:{id:24},message:{message_id:Number(card["message_id"]),chat:{id:42}}}});
    await bridgePass(f.store,{botId:"777000",transport:f.transport,chat:true,deliver:false,clock:f.options.clock});
    await processTelegramChat(f.store,{...f.options,transport:async(method,params)=>method==="editMessageText"?{ok:false,description:"offline"}:f.transport(method,params)});
    expect(f.store.queuePosition("second")?.position).toBe(1);
    const revision=f.store.queueRevision();
    expect(f.store.raw().prepare("SELECT delivered FROM telegram_chat_confirmation").get()?.["delivered"]).toBe(0);
    f.restart();await f.pump();
    expect(f.store.queueRevision()).toBe(revision);
    expect(f.store.raw().prepare("SELECT delivered FROM telegram_chat_confirmation").get()?.["delivered"]).toBe(1);
    expect(f.prompts).toHaveLength(2);
  }finally{f.close();}
});

test("a proposal too long for Telegram offers a full app review and does not block later questions", async () => {
  const f=await fixture();try {
    f.setResponses([agentReply("",[{tool:"propose_task",args:{repo:"r1",title:"Detailed work",goal:"Goal ".repeat(390),not:"Outside scope ".repeat(140)}}]),agentReply("Please review the full scope.")]);
    await f.receive("Prepare a task");await f.pump();
    expect(f.reply()).toContain("Open Chat in Standing Orders");
    expect(f.store.raw().prepare("SELECT state FROM telegram_chat_request").get()?.["state"]).toBe("sent");
    expect(f.store.listTasks()).toHaveLength(0);
    expect(f.calls.filter(call=>call.method==="sendMessage").at(-1)?.params["reply_markup"]).toEqual({inline_keyboard:[]});
    await f.receive("What needs me?",20);await f.pump();expect(f.prompts).toHaveLength(3);
  }finally{f.close();}
});

test("pause stops the exact live run; resume waits for settlement and then releases only the operator hold", async () => {
  const f=await fixture();try {
    f.store.createTask({id:"work",title:"Onboarding"},f.options.clock());const ref=f.store.refFor("built-in","work");f.store.placeTask(ref.id,f.repo);
    register(f.store,{name:"worker",host:"test",capacity:1,repos:[f.repo],now:f.options.clock(),newToken:()=>"worker-fixture"});
    const claim=acquire(f.store,ref.id,"worker",{token:"worker-fixture",now:f.options.clock()});if(!claim.ok)throw Error(claim.reason);
    f.store.setTaskState("work","running",f.options.clock());
    const run=f.store.startRun({taskRef:ref.id,leaseId:claim.claim.leaseId,runner:"worker",branch:"work",worktree:f.root,now:f.options.clock()});
    const propose=async(tool:string,message:string,id:number)=>{f.setResponses([agentReply("",[{tool,args:{task:"work",...(tool==="propose_pause"?{reason:"Revisit tomorrow"}:{})}}]),agentReply("Please confirm below.")]);await f.receive(message,id);await f.pump();};
    const tap=async(id:number)=>{const card=f.store.raw().prepare("SELECT * FROM telegram_chat_card WHERE operation='confirm' ORDER BY proposal DESC LIMIT 1").get()!;
      f.queueUpdate({update_id:id,callback_query:{id:String(id),data:card["token"],from:{id:24},message:{message_id:Number(card["message_id"]),chat:{id:42}}}});
      await bridgePass(f.store,{botId:"777000",transport:f.transport,chat:true,deliver:false,clock:f.options.clock});await f.pump();};
    await propose("propose_pause","Pause the onboarding build",10);expect(f.store.runStopRequested(run)).toBe(false);
    await tap(11);expect(f.store.runStopRequested(run)).toBe(true);expect(f.store.notesForRun(run)).toHaveLength(1);
    await propose("propose_unhold","Resume onboarding",12);await tap(13);
    expect(f.store.activeHolds(ref.id,f.options.clock()).some(hold=>hold.ownerKind==="operator")).toBe(true);
    expect(f.store.listMateProposals(f.store.recentMateTurns("alex",1)[0]!.thread).at(-1)?.outcome?.["said"]).toContain("still stopping");
    f.store.pauseInterruptedRun(run,"stopped","Work preserved",f.options.clock());
    await propose("propose_unhold","Resume onboarding now",14);await tap(15);
    expect(f.store.activeHolds(ref.id,f.options.clock())).toHaveLength(0);expect(f.store.getTask("work")?.state).toBe("queued");
  }finally{f.close();}
});

test("a task card cannot act after project access changes or expiry", async () => {
  for(const changed of [false,true]){const f=await fixture();try{
    f.setResponses([agentReply("",[{tool:"propose_task",args:{repo:"r1",title:"A task",goal:"An intended outcome"}}]),agentReply("Review the task.")]);
    await f.receive("Create a task in Website");await f.pump();
    const card=f.store.raw().prepare("SELECT * FROM telegram_chat_card WHERE operation='confirm'").get()!;
    if(changed)f.options.repos=()=>["/different"];else f.tick(16*60_000);
    f.queueUpdate({update_id:50,callback_query:{id:"50",data:card["token"],from:{id:24},message:{message_id:Number(card["message_id"]),chat:{id:42}}}});
    await bridgePass(f.store,{botId:"777000",transport:f.transport,chat:true,deliver:false,clock:f.options.clock});await f.pump();
    expect(f.store.listTasks()).toHaveLength(0);
  }finally{f.close();}}
});

test("media is queued only for the paired author and passes through the shared assistant", async () => {
  const f = await fixture(); try {
    await f.receive("",20,{ text: undefined, caption: "Explain the error", photo: [{ file_id: "photo-reference", file_size: 123 }] });
    const media = vi.fn(async () => ({ ok: true as const, text: "A screenshot was attached.", content: [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "aGVsbG8=" } }] }));
    await processTelegramChat(f.store, { ...f.options, readMedia: media });
    expect(media).toHaveBeenCalledOnce(); expect(f.prompts[0]).toContain('"type":"image"');
    expect(f.store.raw().prepare("SELECT attachment_json FROM telegram_chat_detail").get()?.["attachment_json"]).toBeNull();
    expect(f.store.raw().prepare("SELECT text FROM mate_message WHERE role='operator'").get()?.["text"]).toContain("Attachment provided");
  } finally { f.close(); }
});

test("forgetting also discards questions still waiting to start a conversation", async () => {
  const f = await fixture(); try {
    await f.receive("Don't answer after I end Chat");
    f.store.closeMateThreadsFor("alex", new Date()); await f.pump();
    expect(f.prompts).toHaveLength(0); expect(f.store.raw().prepare("SELECT * FROM telegram_chat_request").all()).toHaveLength(0);
  } finally { f.close(); }
});

test("the console keeps polling during an answer and shares history with web Chat", async () => {
  const f = await fixture(); let server: ReturnType<typeof createDecisionServer> | undefined; let release = () => {};
  try {
    saveBotToken(join(f.root, "telegram-token"), "777000:AAExampleExampleExample123");
    writeFileSync(join(f.root, "telegram-connection.json"), JSON.stringify({ botId: "777000", username: "standing_orders_test_bot" }));
    const waiting = new Promise<void>(resolve => { release = resolve; }); f.setBeforeReply(() => waiting); await f.receive("Why was it published");
    server = createDecisionServer({ store: f.store, repos: [f.repo], evidenceRoot: f.root, configDir: f.root,
      telegramTokenFile: join(f.root, "telegram-token"), telegramTransport: () => f.transport, telegramIntervalMs: 10,
      connectionHome: f.root, chatRunner: f.runner, chatEnv: {},
      connectionProbe: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "", notFound: false, timedOut: false }),
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1)); const polls = f.calls.filter(c => c.method === "getUpdates").length;
    await vi.waitFor(() => expect(f.calls.filter(c => c.method === "getUpdates").length).toBeGreaterThan(polls)); release();
    await vi.waitFor(() => expect(f.store.recentMateTurns("alex", 1)[0]?.state).toBe("answered"));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: f.token }), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const html = await (await fetch(base + "/chat", { headers: { cookie } })).text(); expect(html).toContain("Why was it published"); expect(html).toContain("Publication was blocked");
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    await fetch(base + "/chat", { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, message: "What should I do next?" }), redirect: "manual" });
    await vi.waitFor(() => expect(f.prompts).toHaveLength(2)); expect(f.prompts[1]).toContain("Why was it published"); expect(f.prompts[1]).toContain("committed locally");
  } finally { release(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); f.close(); }
});

test("a running worker queues the question for the console, including connection enabled during its long poll", async () => {
  const f = await fixture(); let server: ReturnType<typeof createDecisionServer> | undefined;
  let worker: Promise<number> | undefined; let release = () => {};
  try {
    const tokenFile = join(f.root, "telegram-token"); saveBotToken(tokenFile, "777000:AAExampleExampleExample123");
    const registration = register(f.store, { name: "desktop-fixture", host: "here", repos: [f.repo], now: new Date() });
    let waiting = false; const gate = new Promise<void>(resolve => { release = resolve; });
    const workerTransport: TelegramTransport = async (method, params, signal) => {
      if (method === "getUpdates" && !waiting) { waiting = true; await gate; }
      return f.transport(method, params, signal);
    };
    worker = runOperate("watch", ["--runner", "desktop-fixture", "--token", registration.token, "--repo", f.repo,
      "--pool", join(f.root, "pool"), "--for", "2000", "--json"], () => {}, { databaseFile: f.file, telegramTransport: workerTransport });
    await vi.waitFor(() => expect(waiting).toBe(true));
    writeFileSync(join(f.root, "telegram-connection.json"), JSON.stringify({ botId: "777000", username: "standing_orders_test_bot" }));
    server = createDecisionServer({ store: f.store, repos: [f.repo], evidenceRoot: f.root, configDir: f.root,
      telegramTokenFile: tokenFile, telegramTransport: () => f.transport, telegramIntervalMs: 10, chatRunner: f.runner, connectionHome: f.root,
      connectionProbe: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "", notFound: false, timedOut: false }) });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const lease = f.store.raw().prepare("SELECT owner FROM bridge_lease").get(); expect(lease?.["owner"]).toMatch(/^follow-/);
    f.queue("Why was it published", 40); release();
    await vi.waitFor(() => expect(f.store.raw().prepare("SELECT state FROM telegram_chat_request WHERE update_id = 40").get()?.["state"]).toBe("sent"));
    expect(f.prompts).toHaveLength(1); expect(f.reply()).toContain("Publication was blocked");
    expect(f.store.raw().prepare("SELECT result FROM telegram_update WHERE update_id = 40").get()?.["result"]).toBe("chat-queued");
    // The worker still owns polling when the console delivers the answer.
    expect(f.store.raw().prepare("SELECT owner FROM bridge_lease").get()?.["owner"]).toMatch(/^follow-/);
  } finally { release(); await worker; if (server) await new Promise<void>(resolve => server!.close(() => resolve())); f.close(); }
});

test.each([false, true])("a standalone bridge queues for an enabled console (follow=%s)", async follow => {
  const f = await fixture(); try {
    saveBotToken(join(f.root, "telegram-token"), "777000:AAExampleExampleExample123");
    writeFileSync(join(f.root, "telegram-connection.json"), JSON.stringify({ botId: "777000", username: "standing_orders_test_bot" }));
    f.queue("Explain the alert", 50);
    await runOperate("bridge", ["telegram", "--json", ...(follow ? ["--follow", "--for", "50"] : [])], () => {}, { databaseFile: f.file, telegramTransport: f.transport });
    expect(f.store.raw().prepare("SELECT state FROM telegram_chat_request WHERE update_id = 50").get()?.["state"]).toBe("queued");
    await f.pump(); expect(f.prompts).toHaveLength(1); expect(f.reply()).toContain("Publication was blocked");
  } finally { f.close(); }
});

test("a recovered operator question is sent without inventing its missing Telegram message id", async () => {
  const f = await fixture(); try {
    enqueueTelegramQuestion(f.store, f.store.liveTelegramBinding("777000")!, { updateId: 60, messageId: null, replyTo: null, message: "Why was it published" }, new Date());
    await f.pump(); const sent = f.calls.filter(c => c.method === "sendMessage").at(-1)!;
    expect(sent.params["reply_parameters"]).toBeUndefined(); expect(f.reply()).toContain("Publication was blocked");
  } finally { f.close(); }
});
