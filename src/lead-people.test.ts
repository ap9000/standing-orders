/**
 * The lead knows you and the people you work with: what it knows about its owner (confirmed about-you lines, from
 * remember cards or Settings → Lead), the people index in each turn's bundle (people, AI teammates, team chats; within
 * 8 KB, people dropping before decisions), and get_person.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { confirmMateProposal } from "./mate-doors.js";
import { executeMateTool, MATE_TOOL_SCHEMAS, type MateToolContext } from "./mate-tools.js";
import { leadContext, LEAD_CONTEXT_MAX_BYTES } from "./lead-context.js";
import { ABOUT_YOU_MAX_LINES, checkAboutYou, overlappingLine, saveAboutYou, withAboutYouLine } from "./lead-about.js";
import { MATE_CONTRACT } from "./mate-contract.js";
import { TeamLeads } from "./team-leads.js";
import { withActor } from "./actor.js";

describe("the lead knows you and the people you work with", () => {
  let root: string, web: string, api: string, store: Store, who: VerifiedApprover, session: number, thread: number;
  const t0 = new Date("2026-10-02T12:00:00.000Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
  const names = (path: string) => path.split("/").pop()!;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lead-people-")));
    web = join(root, "web-shop"); api = join(root, "payments-api");
    mkdirSync(web); mkdirSync(api);
    store = openStore(join(root, "state.db"));
    if (!addApprover(store, "alex.pelletier", t0).ok) throw Error("account");
    const verified = verifyApproverStanding(store, "alex.pelletier", store.accountOf("alex.pelletier")!.generation, [web, api]);
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintMateSession({ approver: who.name, approverGeneration: who.generation, credentialKey: "fixture", ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "fixture" }, t0);
    thread = store.openMateThread(who.name, who.ceilingDigest, t0).thread.id;
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  function turn(now: Date, calls: (ctx: MateToolContext) => void) {
    const opened = store.openMateTurn({ approver: who.name, session, thread, credentialKey: "fixture", reservedMicrousd: 0, dailyTurns: 100, weeklyCeilingMicrousd: 10_000_000, deadlineMs: 60_000 }, now);
    if (!opened.ok) throw Error(opened.reason);
    const started = store.startMateTurn(opened.id, now);
    if (!started.ok) throw Error("start");
    const ctx: MateToolContext = { store, who, now, step: 1, readDecisions: new Map(), thread, turn: opened.id, evidenceRoot: root,
      draft: (kind, payload) => store.draftMateProposal({ thread, turn: opened.id, kind, payload, ceilingDigest: who.ceilingDigest }, now) };
    calls(ctx);
    store.finalizeMateTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: "Noted.", activity: "" } }, now);
  }
  const call = (ctx: MateToolContext, name: string, args: Record<string, unknown>) => {
    const result = executeMateTool(ctx, name, args);
    if (!result.ok) throw Error(result.message);
    return result.body as Record<string, unknown>;
  };
  const bundle = (now: Date, options: Parameters<typeof leadContext>[3] = {}) =>
    JSON.parse(leadContext(store, who.repos, now, { owner: who.name, thread, projectName: names, ...options }));

  test("c1: remember about-you proposes a card; only once confirmed is the line stored, and it is in the next bundle", () => {
    let card = 0;
    turn(t0, ctx => {
      const body = call(ctx, "remember", { kind: "about-you", text: "Keep copy terse." });
      expect(body).toMatchObject({ awaiting: "confirmation", executed: false });
      card = Number(body["proposal"]);
      // The same line twice is one card.
      expect(executeMateTool(ctx, "remember", { kind: "about-you", text: "keep copy terse." })).toMatchObject({ ok: false, message: expect.stringContaining(`Card ${card}`) });
    });
    expect(store.getMateProposal(card)).toMatchObject({ kind: "action", state: "pending", payload: { operation: "lead_about_you", repo: "", title: "Remember about you",
      terms: ["Keep copy terse.", expect.stringContaining("Settings → Lead")] } });
    // A proposal is not a memory: nothing is stored and the bundle knows nothing yet.
    expect(store.leadAbout(who.name)).toEqual([]);
    expect(bundle(at(1)).aboutYou).toEqual([]);

    expect(confirmMateProposal(store, who, card, at(2), { via: "web", evidenceRoot: root })).toMatchObject({ ok: true, said: "Your lead will remember this." });
    expect(store.leadAbout(who.name)).toEqual(["Keep copy terse."]);
    // Stored beside the lead's name and persona (the defaults, when never named).
    expect(store.leadConfig(who.name)).toMatchObject({ name: "Lead" });
    const data = bundle(at(3));
    expect(data.aboutYou).toEqual(["Keep copy terse."]);
    expect(data.corrections).toEqual([{ proposal: card, change: "About you: Keep copy terse." }]);
  });

  test("c1: a line that changes an old one shows both on the card and replaces it by default; keepBoth adds it instead", () => {
    saveAboutYou(store, who.name, ["Keep copy terse.", "I test changes myself."], t0);
    let replacing = 0, both = 0, named = 0;
    turn(t0, ctx => {
      const body = call(ctx, "remember", { kind: "about-you", text: "Write copy in full sentences, not terse notes." });
      replacing = Number(body["proposal"]);
      expect(body["replaces"]).toEqual({ line: 1, was: "Keep copy terse." });
      both = Number(call(ctx, "remember", { kind: "about-you", text: "Copy for the store can be playful.", keepBoth: true })["proposal"]);
      named = Number(call(ctx, "remember", { kind: "about-you", text: "Run the full checks for me.", replaces: 2 })["proposal"]);
      expect(executeMateTool(ctx, "remember", { kind: "about-you", text: "Something", replaces: 9 })).toMatchObject({ ok: false });
    });
    expect(store.getMateProposal(replacing)!.payload).toMatchObject({ title: "Update what your lead knows about you",
      terms: ["Was: Keep copy terse.", "Now: Write copy in full sentences, not terse notes.", expect.any(String)] });
    expect(store.getMateProposal(both)!.payload).toMatchObject({ title: "Remember about you" });
    expect(confirmMateProposal(store, who, replacing, at(1), { via: "web", evidenceRoot: root })).toMatchObject({ ok: true });
    expect(store.leadAbout(who.name)).toEqual(["Write copy in full sentences, not terse notes.", "I test changes myself."]);
    // Cards drafted against the note before it changed are refused, not applied to the wrong line.
    expect(confirmMateProposal(store, who, named, at(2), { via: "web", evidenceRoot: root })).toMatchObject({ ok: false, reason: "stale" });
    expect(store.leadAbout(who.name)).toHaveLength(2);
  });

  test("c1: an older lead_config gains the note on open; its name and persona carry over", () => {
    store.setLeadConfig(who.name, "Maya", "Short.", t0);
    store.handle.exec("ALTER TABLE lead_config DROP COLUMN about_json");
    store.close();
    store = openStore(join(root, "state.db"));
    expect(store.leadAbout(who.name)).toEqual([]);
    saveAboutYou(store, who.name, ["Keep copy terse."], t0);
    expect(store.leadConfig(who.name)).toEqual({ name: "Maya", persona: "Short." });
    expect(store.leadAbout(who.name)).toEqual(["Keep copy terse."]);
  });

  test("c1: the note is short — at most 20 lines, each under 200 characters — and a guess-free plain text", () => {
    expect(checkAboutYou("- Keep copy terse.\n\n* I test myself.\nkeep copy terse.")).toEqual({ ok: true, lines: ["Keep copy terse.", "I test myself."] });
    expect(checkAboutYou("x".repeat(200))).toMatchObject({ ok: false, message: expect.stringContaining("under 200") });
    expect(checkAboutYou(Array.from({ length: 21 }, (_, index) => `Line ${index}`).join("\n"))).toMatchObject({ ok: false, message: "Keep it to 20 lines." });
    const full = Array.from({ length: ABOUT_YOU_MAX_LINES }, (_, index) => `Preference number ${index}`);
    expect(withAboutYouLine(full, "One more thing", 0)).toMatchObject({ ok: false, message: expect.stringContaining("full") });
    expect(withAboutYouLine(full, "One more thing", 3)).toMatchObject({ ok: true });
    expect(overlappingLine(["Don't ping me for releases."], "Ping me for every release.")).toBe(1);
    expect(overlappingLine(["Don't ping me for releases."], "Keep copy terse.")).toBe(0);
  });

  test("c2: the bundle carries about-you lines right after who you are, then the people index, one line each", () => {
    saveAboutYou(store, who.name, ["Keep copy terse."], t0);
    store.saveApprover("sam.k", "h".repeat(64), t0);
    store.saveApprover("jo", "h".repeat(64), t0);
    store.saveApprover("pat", "h".repeat(64), t0);
    store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'pat'").run(JSON.stringify(["/elsewhere"]));
    store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'jo'").run(JSON.stringify([api]));
    store.createTeammate({ repo: web, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: who.name, by: who.name }, t0);
    const domain = new TeamLeads(store, () => [web, api]);
    const actor = { name: who.name, generation: who.generation };
    const leadId = (domain.execute(actor, { operation: "create-lead", args: { name: "Launch lead", projects: [web], instructions: "Get the spring launch out the door.\nMore detail." } }, t0).result as { leadId: string }).leadId;
    const conversationId = (domain.execute(actor, { operation: "create-conversation", args: { leadId, title: "Spring launch", visibility: "team", projects: [web] } }, t0).result as { conversationId: string }).conversationId;
    expect(domain.execute(actor, { operation: "member", args: { leadId, expectedRevision: 1, account: "sam.k", role: "contributor" } }, t0)).toMatchObject({ ok: true });
    expect(domain.execute(actor, { operation: "member", args: { conversationId, expectedRevision: 1, account: "sam.k", role: "contributor" } }, t0)).toMatchObject({ ok: true });

    const data = bundle(at(1), { redact: text => text.replace(/sam\.k|\bjo\b|alex\.pelletier/gi, "[approver]") });
    expect(Object.keys(data).slice(2, 7)).toEqual(["me", "you", "aboutYou", "people", "channel"]);
    expect(data.aboutYou).toEqual(["Keep copy terse."]);
    // Only people who share a project; their first names are shown on purpose, projects by the ids the bundle names.
    expect(data.people).toEqual({
      people: ["p1 Jo: approves work; r2", "p2 Sam: approves work; r1, r2"],
      teammates: [expect.stringMatching(/^t\d+ Maya: Support \(r1\)$/)],
      teams: ["c1 Spring launch: you, Sam; Get the spring launch out the door."],
    });
    // A team chat's own lead speaks for the room: the owner's own note stays out of it.
    expect(bundle(at(1), { leadName: "Launch lead" }).aboutYou).toEqual([]);
  });

  test("c2: over 8 KB, people drop before projects' decisions; who you are and what the lead knows about you stay", () => {
    saveAboutYou(store, who.name, Array.from({ length: 5 }, (_, index) => `Preference ${index}: ${"keep it short ".repeat(8)}`.slice(0, 199)), t0);
    for (let index = 0; index < 40; index++) store.saveApprover(`person${String(index).padStart(2, "0")}`, "h".repeat(64), t0);
    const decide = (claim: string, minute: number) => store.handle.prepare(`INSERT INTO project_decision(repo,identity,revision,claim,why,status,decided_by,decided_at,source_kind,recorded_by,sha)
      VALUES (?,'i',1,?,?,'active','alex.pelletier',?,'manual','alex.pelletier','s')`).run(web, claim, "Because.", at(minute).toISOString());
    for (let index = 0; index < 6; index++) decide(`Decision ${index} ${"about checkout ".repeat(4)}`, index);
    const sized = (padding: number) => {
      const document = leadContext(store, who.repos, at(10), { owner: who.name, projectName: names, redact: text => text.replace(/^Decision /, one => `${one}${"padding ".repeat(padding)}`) });
      expect(Buffer.byteLength(document)).toBeLessThanOrEqual(LEAD_CONTEXT_MAX_BYTES);
      return JSON.parse(document);
    };
    const roomy = sized(0);
    expect(roomy.people.people.length).toBeGreaterThan(0);
    expect(roomy.projects[0].decisions).toHaveLength(6);
    let peopleWent = false, decisionsWent = false;
    for (let padding = 0; padding <= 120; padding += 4) {
      const data = sized(padding);
      expect(data.aboutYou).toHaveLength(5);
      expect(data.you.firstName).toBe("Alex");
      if (data.projects[0].decisions.length < 6) {
        decisionsWent = true;
        // A decision only goes once every person has gone.
        expect(data.people.people).toEqual([]);
      }
      if (data.people.people.length < roomy.people.people.length) { peopleWent = true; expect(data.omissions.people).toBeGreaterThan(0); }
    }
    expect(peopleWent).toBe(true);
    expect(decisionsWent).toBe(true);
  });

  test("c3: get_person returns one entry with its open tasks, by id or name; the contract says to read it first", () => {
    store.saveApprover("sam.k", "h".repeat(64), t0);
    for (const [id, title] of [["login-page", "Fix the login page"], ["old-thing", "An old thing"]] as const) {
      const filed = withActor({ account: "sam.k", lead: false }, () => fileTaskProposal(store, { id, title, repo: web, filedVia: "cli" }, t0));
      if (!filed.ok) throw Error(filed.reason);
    }
    expect(store.cancelTask("old-thing", t0, "Not needed")).toEqual({ ok: true });
    const mate = store.createTeammate({ repo: web, handle: "maya", soul: "---\nname: Maya\nrole: Support\n---\n## Who you are\nHelpful.\n", model: null, manager: who.name, by: who.name }, t0);
    turn(at(1), ctx => {
      const sam = call(ctx, "get_person", { id: "p1" })["person"] as Record<string, unknown>;
      expect(sam).toMatchObject({ id: "p1", kind: "person", name: "Sam", role: "approves work", projects: ["r1", "r2"] });
      // Open work only: the cancelled task is not listed.
      expect(sam["openTasks"]).toEqual([{ task: "login-page", title: "Fix the login page", state: "queued", repo: "r1" }]);
      expect(call(ctx, "get_person", { name: "sam" })["person"]).toMatchObject({ id: "p1" });
      expect(call(ctx, "get_person", { name: "Maya" })["person"]).toMatchObject({ id: `t${mate}`, kind: "AI teammate", name: "Maya", role: "Support", project: "r1", openTasks: [] });
      expect(executeMateTool(ctx, "get_person", { name: "Nobody" })).toMatchObject({ ok: false });
      expect(executeMateTool(ctx, "get_person", {})).toMatchObject({ ok: false });
    });
    expect(MATE_TOOL_SCHEMAS.map(one => one.name)).toContain("get_person");
    expect(MATE_CONTRACT).toContain("Before answering a question about a person, an AI teammate or a team chat, read get_person for them first");
  });
});
