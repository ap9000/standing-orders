/**
 * The lead's per-turn bundle (lead-context.ts): who it is, who it is talking to, the channel, what needs them, then
 * projects by name with their active decisions, then the rest, within 8 KB with the least important dropped first.
 * The flow detail lives in the flow tools' descriptions, not the contract.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { firstNameOf, leadContext, LEAD_CONTEXT_MAX_BYTES } from "./lead-context.js";
import { checkLeadIdentity, DEFAULT_LEAD_NAME, DEFAULT_LEAD_PERSONA, leadIdentityOf } from "./lead-identity.js";
import { MATE_CONTRACT, MATE_CONTRACT_VERSION } from "./mate-contract.js";
import { MATE_TOOL_SCHEMAS } from "./mate-tools.js";

const T0 = new Date("2026-10-02T13:05:00.000Z");
const WEB = "/repo/web-shop", API = "/repo/payments-api";

describe("the lead's bundle", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(":memory:");
    store.saveApprover("alex.pelletier", "h".repeat(64), T0);
  });
  afterEach(() => store.close());

  const file = (id: string, repo: string, title: string) => {
    const filed = fileTaskProposal(store, { id, title, repo, filedVia: "cli" }, T0);
    if (!filed.ok) throw new Error(filed.reason);
  };
  // A saved active decision as project memory stores it (recording one needs a real repository).
  const decide = (repo: string, claim: string, why: string, at: Date) => store.handle.prepare(`INSERT INTO project_decision(repo,identity,revision,claim,why,status,decided_by,decided_at,source_kind,recorded_by,sha)
    VALUES (?,'i',1,?,?,'active','alex.pelletier',?,'manual','alex.pelletier','s')`).run(repo, claim, why, at.toISOString());
  const names = (path: string) => path.split("/").pop()!;
  const bundle = (options: Parameters<typeof leadContext>[3] = {}) =>
    JSON.parse(leadContext(store, [WEB, API], T0, { owner: "alex.pelletier", channel: "telegram", timeZone: "Europe/London", projectName: names, ...options }));

  test("c2: ordered who I am, who you are, the channel, what needs you, projects by name with active decisions, then the rest", () => {
    file("checkout-fix", WEB, "Fix the checkout button");
    decide(WEB, "Use Stripe Checkout", "Hosted pages keep card data off our servers.\nWe looked at Adyen too.", T0);
    decide(WEB, "Ship on Tuesdays", "Support is fully staffed then. Fridays are quiet.", new Date(T0.getTime() + 60_000));
    const data = bundle();
    expect(Object.keys(data).slice(2, 8)).toEqual(["me", "you", "channel", "needsYou", "projects", "rest"]);
    expect(data.me).toEqual({ name: DEFAULT_LEAD_NAME, persona: DEFAULT_LEAD_PERSONA });
    expect(data.you).toEqual({ firstName: "Alex", timeZone: "Europe/London", today: "Friday 2026-10-02 14:05" });
    expect(data.channel).toMatchObject({ id: "telegram", fit: expect.stringContaining("Telegram") });
    expect(data.needsYou.map((one: { title: string }) => one.title)).toEqual(["Fix the checkout button"]);
    // Projects by name, never r1..rN alone; decisions newest first, each a title and its reason in one line.
    expect(data.projects).toEqual([
      { repo: "r1", name: "web-shop", decisions: [
        { id: 2, title: "Ship on Tuesdays", why: "Support is fully staffed then." },
        { id: 1, title: "Use Stripe Checkout", why: "Hosted pages keep card data off our servers." },
      ] },
      { repo: "r2", name: "payments-api", decisions: [] },
    ]);
    expect(data.rest).toMatchObject({ tasks: [] });
  });

  test("c2: over 8 KB, the rest goes first, then the oldest decisions, then Needs you; who I am, who you are and the channel stay", () => {
    for (let index = 0; index < 5; index++) file(`task-${index}`, index % 2 ? WEB : API, `Task ${index}`);
    // Finished work is the rest: it goes before anything else.
    for (let index = 0; index < 3; index++) { file(`old-${index}`, WEB, `Task old ${index}`); expect(store.cancelTask(`old-${index}`, T0, "Not needed")).toEqual({ ok: true }); }
    for (let index = 0; index < 8; index++) decide(WEB, `Decision ${index + 1} ${"about the checkout ".repeat(6)}`, "Because the reason is long.", new Date(T0.getTime() + index * 1000));
    const sized = (padding: number) => {
      const document = leadContext(store, [WEB, API], T0, { owner: "alex.pelletier", channel: "slack", projectName: names,
        redact: text => text.replace(/^(Task|Decision) /, one => `${one}${"padding ".repeat(padding)}`) });
      expect(Buffer.byteLength(document)).toBeLessThanOrEqual(LEAD_CONTEXT_MAX_BYTES);
      const data = JSON.parse(document);
      expect(data.me.name).toBe("Lead");
      expect(data.you.firstName).toBe("Alex");
      expect(data.channel.id).toBe("slack");
      return data;
    };
    // Growing past the cap: the oldest decisions go first (the newest stay), and Needs you is trimmed only once
    // no decision is left, from its least pressing end, and counted.
    let rest = false, partial = false, trimmed = false;
    for (let padding = 0; padding <= 200; padding += 5) {
      const data = sized(padding);
      if (data.rest.tasks.length > 0) { expect(data.projects[0].decisions).toHaveLength(8); expect(data.needsYou).toHaveLength(5); rest = true; continue; }
      const kept = data.projects[0].decisions.map((one: { id: number }) => one.id);
      expect(kept).toEqual([8, 7, 6, 5, 4, 3, 2, 1].slice(0, kept.length));
      if (data.needsYou.length < 5) {
        expect(data.projects.every((one: { decisions: unknown[] }) => one.decisions.length === 0)).toBe(true);
        expect(data.omissions.assignments).toBeGreaterThanOrEqual(5 - data.needsYou.length);
        trimmed = true;
      } else if (kept.length > 0 && kept.length < 8) partial = true;
    }
    expect([rest, partial, trimmed]).toEqual([true, true, true]);
  });

  test("c1: the name and persona the owner saved are who the lead is; a shared team conversation keeps its own lead's name", () => {
    store.setLeadConfig("alex.pelletier", "Maya", "Dry humour. Keep it short.", T0);
    expect(bundle().me).toEqual({ name: "Maya", persona: "Dry humour. Keep it short." });
    expect(leadIdentityOf(store, "someone-else")).toEqual({ name: DEFAULT_LEAD_NAME, persona: DEFAULT_LEAD_PERSONA });
    expect(bundle({ leadName: "Ops lead" }).me.name).toBe("Ops lead");
    // The owner's settings are checked: blank means the default, and the name is plain words.
    expect(checkLeadIdentity("  ", "")).toEqual({ ok: true, identity: { name: DEFAULT_LEAD_NAME, persona: DEFAULT_LEAD_PERSONA } });
    expect(checkLeadIdentity("<b>Maya</b>", "x")).toMatchObject({ ok: false });
    expect(checkLeadIdentity("M".repeat(41), "x")).toMatchObject({ ok: false });
    expect(checkLeadIdentity("Maya", "p".repeat(601))).toMatchObject({ ok: false });
    expect(firstNameOf("sam@example.com")).toBe("Sam");
  });

  test("c3: the lead is told the channel, and the flow detail lives in the flow tools' descriptions", () => {
    expect(bundle({ channel: "console" }).channel.id).toBe("console");
    expect(MATE_CONTRACT_VERSION).toBe(44);
    expect(MATE_CONTRACT).toContain("channel: where this conversation is; fit your replies to it");
    // The contract names the flow tools and no longer carries their detail.
    expect(MATE_CONTRACT).toContain("Read get_flows");
    for (const detail of ["Jev", "soul file", "goto: <answer>", "Issues to PRs", "Holding, Build and Research"]) expect(MATE_CONTRACT).not.toContain(detail);
    const description = (name: string) => MATE_TOOL_SCHEMAS.find(one => one.name === name)!.description;
    expect(description("get_flows")).toContain("Holding, Build and Research (each files an ordinary task), Person decides, Message, Done");
    expect(description("get_flows")).toContain("soul file");
    expect(description("get_flows")).toContain("'flow <the flow's number>'");
    expect(description("propose_flow")).toContain("use decider 'me' when they decide");
    expect(description("propose_flow")).toContain("The Issues to PRs template");
    expect(description("propose_flow")).toContain("propose_teammate use_tool, stop_tool and tool_rule");
  });
});
