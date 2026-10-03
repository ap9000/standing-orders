/** The lead checks a capability before it claims it: get_capabilities reads agents, workers, tools and skills,
 * integrations and checks in one call, each with its next step and settings link; a proposal or promise that needs an
 * agent, a worker or an integration is refused unless that read ran in an earlier step; the contract says so, and says
 * to investigate a limitation before reporting it. */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { executeMateTool, type MateToolContext } from "./mate-tools.js";
import { MATE_CONTRACT } from "./mate-contract.js";
import { CHAT_CONTROLS } from "./chat-controls.js";
import { register } from "./runner.js";
import { addToolTo } from "./project-tools.js";
import { changeSkills, importSkill, skillsView } from "./project-skills.js";
import { setProjectCheckLevel } from "./check-levels.js";
import { CAPABILITIES_UNREAD } from "./lead-capabilities.js";
import type { Integration } from "./integrations.js";

const T0 = new Date("2026-10-02T12:00:00.000Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const TASK_ARGS = { title: "Add a refund page", goal: "People can ask for a refund.", acceptance: [{ id: "c1", statement: "A refund can be requested.", evidence: ["manual-review"] }] };
const INTEGRATIONS: Integration[] = [
  { key: "telegram", group: "chat", name: "Telegram", state: "connected", account: "@toolroll_bot", detail: null, checked: true, checkedAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, usedBy: ["Chat"], action: { kind: "test", label: "Send test" } },
  { key: "slack", group: "chat", name: "Slack", state: "not-set-up", account: null, detail: null, checked: true, checkedAt: null, lastSuccessAt: null, lastError: null, lastErrorAt: null, usedBy: [], action: { kind: "setup", label: "Set up", href: "/settings/slack", command: null } },
];

type Entry = { name: string; state: string; ok: boolean; lets: string; next: string | null; link: string | null };
type Read = { projects: { repo: string; agents: (Entry & { provider: string; model: string; roles: string[] })[]; agentsProblem: Entry | null; tools: Entry[]; skills: Entry[]; checks: Entry & { level: string; quickCheck: boolean; releaseCheck: boolean } }[]; workers: (Entry & { online: boolean; capacity: number; running: string[] })[]; integrations: (Entry & { kind: string })[] };

describe("the lead checks a capability before it claims it", () => {
  let store: Store;
  let who: VerifiedApprover;
  let drafted: number;
  let dir: string, REPO: string, OTHER: string;
  const ctx = (step: number, extra: Partial<MateToolContext> = {}, now = T0): MateToolContext => ({ store, who, now, step, readDecisions: new Map(), draft: () => ++drafted, integrations: () => INTEGRATIONS, ...extra });
  const read = (now = T0, repo = "r1"): Read => {
    const result = executeMateTool(ctx(1, {}, now), "get_capabilities", { repo });
    if (!result.ok) throw new Error(result.message);
    return result.body as Read;
  };
  /** Every entry that can't do its job names one next step and a real settings control. */
  const linked = (entry: Entry) => {
    expect(entry.lets.length, entry.name).toBeGreaterThan(3);
    if (entry.ok && entry.next === null) return;
    expect(entry.next, entry.name).toMatch(/\S/);
    expect(Object.keys(CHAT_CONTROLS), entry.name).toContain(entry.link);
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-capabilities-")));
    REPO = join(dir, "shop"); OTHER = join(dir, "blog");
    for (const repo of [REPO, OTHER]) { mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); }
    store = openStore(":memory:");
    store.saveApprover("alex", "h".repeat(64), T0);
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", T0);
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [REPO, OTHER]);
    if (!verified.ok) throw new Error(verified.reason);
    who = verified.who;
    drafted = 0;
    const filed = fileTaskProposal(store, { id: "t1", title: "task t1", repo: REPO, filedVia: "cli" }, T0);
    if (!filed.ok) throw new Error(filed.reason);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("c1: get_capabilities reports agents, workers, tools and skills, integrations and checks, each with its next step and link", () => {
    // Nothing set up yet: no worker, the agent unreported, no release check — each says what to do and where.
    let found = read();
    const project = found.projects[0]!;
    expect(project.repo).toBe("r1");
    expect(project.agents).toEqual([expect.objectContaining({ provider: "claude", model: "sonnet", state: "Not checked yet", ok: false, link: "workers", roles: expect.arrayContaining(["plan", "build"]) })]);
    expect(found.workers).toEqual([expect.objectContaining({ state: "None for your projects", ok: false, link: "workers", next: expect.stringContaining("toolroll daemon install") })]);
    expect(project.checks).toMatchObject({ level: "Full", releaseCheck: false, ok: false, link: "projects" });
    expect(found.integrations).toEqual([
      expect.objectContaining({ name: "Telegram", state: "Connected", ok: true, next: null, link: null }),
      expect.objectContaining({ name: "Slack", state: "Not set up", ok: false, link: "slack", next: expect.stringContaining("set up Slack") }),
    ]);
    for (const entry of [...project.agents, ...found.workers, project.checks, ...found.integrations]) linked(entry);

    // A worker online and one gone quiet; the agent signed in; a working tool, one that needs a secret and one whose
    // last test failed; an enabled skill; a release check.
    register(store, { name: "laptop", host: "mac", capacity: 2, repos: [REPO], now: T0 });
    register(store, { name: "old-box", host: "linux", capacity: 1, repos: [REPO], now: later(-60) });
    store.recordProviderReadiness("laptop", [{ provider: "claude", state: "ready", reason: "logged in", probe: "identity" }], T0);
    const tool = (name: string, secrets: { name: string; optional: boolean }[] = []) => {
      const added = addToolTo(store, REPO, { name, transport: "stdio", command: "npx", args: [`${name}-mcp`], url: null, secrets, bearer: null, headerSecrets: {}, about: `the ${name} server` }, "test", "alex", T0);
      if (!added.ok) throw new Error(added.message);
    };
    tool("docs"); tool("payments", [{ name: "CAPABILITY_FIXTURE_KEY", optional: false }]); tool("tickets");
    store.recordProjectToolTest(REPO, "docs", JSON.stringify({ at: T0.toISOString(), ok: true, tools: ["search"], problem: null }));
    store.recordProjectToolTest(REPO, "tickets", JSON.stringify({ at: T0.toISOString(), ok: false, tools: [], problem: "it exited at once" }));
    const skill = importSkill(store, REPO, "alex", [{ path: "SKILL.md", base64: Buffer.from("---\nname: copy-review\ndescription: |\n  Review interface copy.\n---\nUse short labels.\n").toString("base64") }], "Uploaded local folder", T0);
    const view = skillsView(store, REPO, "alex");
    changeSkills(store, { repo: REPO, actor: "alex", identity: view.identity, revision: view.revision, sha: skill.sha, action: "enable" }, T0);
    store.setVerifyCommand({ repo: REPO, command: "npm test", timeoutMs: 60_000, approvedBy: "alex" }, T0);

    found = read();
    const ready = found.projects[0]!;
    expect(ready.agents).toEqual([expect.objectContaining({ state: "Signed in", ok: true, next: null, link: null })]);
    expect(found.workers).toEqual([
      expect.objectContaining({ name: "laptop", online: true, capacity: 2, running: [], state: "Online · 0 of 2 busy", ok: true }),
      expect.objectContaining({ name: "old-box", online: false, ok: false, link: "workers", next: expect.stringContaining("toolroll daemon install --runner old-box") }),
    ]);
    expect(ready.tools).toEqual([
      expect.objectContaining({ name: "docs", state: "Working", ok: true, next: null }),
      expect.objectContaining({ name: "payments", state: "Needs CAPABILITY_FIXTURE_KEY", ok: false, link: "tools", next: expect.stringContaining("never in chat") }),
      expect.objectContaining({ name: "tickets", state: "Last test failed", ok: false, link: "tools", next: expect.stringContaining("it exited at once") }),
    ]);
    expect(ready.skills).toEqual([expect.objectContaining({ name: "copy-review", state: "Working", ok: true })]);
    expect(ready.checks).toMatchObject({ level: "Full", releaseCheck: true, state: "Full · release check set", ok: true });
    for (const entry of [...ready.agents, ...found.workers, ...ready.tools, ...ready.skills, ready.checks]) linked(entry);

    // The plan runs out: out of plan budget until it resets. Then the sign-in stops working: signed out, with the command.
    store.recordProviderLimits({ provider: "claude", plan: "max", windows: [{ window: "five_hour", usedPercent: 100, windowMinutes: 300, resetsAt: later(90).toISOString(), reached: true }] }, T0);
    expect(read().projects[0]!.agents[0]).toMatchObject({ state: "Out of plan budget", ok: false, link: "providers", next: expect.stringContaining(later(90).toISOString()) });
    store.recordProviderReadiness("laptop", [{ provider: "claude", state: "unavailable", reason: "not logged in", probe: "identity" }], T0);
    expect(read().projects[0]!.agents[0]).toMatchObject({ state: "Signed out", ok: false, link: "providers", next: expect.stringContaining("claude auth login") });

    // Checks off: said, with where to turn them on.
    setProjectCheckLevel(store, REPO, "off", "alex", T0);
    expect(read().projects[0]!.checks).toMatchObject({ level: "Off", state: "Off", ok: false, link: "projects" });

    // Without a project it reads every project; the other project's workers and tasks are its own.
    const all = executeMateTool(ctx(1), "get_capabilities", {});
    expect(all.ok && (all.body as Read).projects.map(one => one.repo)).toEqual(["r1", "r2"]);
    expect(executeMateTool(ctx(1), "get_capabilities", { repo: "r9" })).toMatchObject({ ok: false });
  });

  test("c2: a proposal or promise needing a provider, worker or integration is refused unless get_capabilities ran earlier that turn", () => {
    const checked = new Map<string, number>();
    const turn = (step: number, extra: Partial<MateToolContext> = {}) => ctx(step, { checkedCapabilities: checked, ...extra });
    // Nothing read: the task, a flow that starts work and a promise to watch crew work are refused before anything is drafted.
    expect(executeMateTool(turn(1), "propose_task", { repo: "r1", ...TASK_ARGS })).toEqual({ ok: false, message: CAPABILITIES_UNREAD });
    expect(executeMateTool(turn(1), "propose_flow", { operation: "create", repo: "r1", name: "Triage", template: "triage" })).toEqual({ ok: false, message: CAPABILITIES_UNREAD });
    expect(executeMateTool(turn(1), "commit_to", { what: "Tell you when it is ready", when: "task", task: "t1" })).toEqual({ ok: false, message: CAPABILITIES_UNREAD });
    // A timed promise on a chat app needs that chat app to work; one in the console conversation needs nothing.
    expect(executeMateTool(turn(1, { channel: "telegram" }), "commit_to", { what: "Ping you at noon", when: "time", at: later(60).toISOString() })).toEqual({ ok: false, message: CAPABILITIES_UNREAD });
    expect(executeMateTool(turn(1, { channel: "chat" }), "commit_to", { what: "Ping you at noon", when: "time", at: later(60).toISOString() })).not.toEqual({ ok: false, message: CAPABILITIES_UNREAD });
    // A flow change that starts no work (a comment) is not held up.
    expect(executeMateTool(turn(1), "propose_flow", { operation: "comment", flow: 1, card: 1, note: "Looks right." })).not.toEqual({ ok: false, message: CAPABILITIES_UNREAD });
    expect(drafted).toBe(0);

    // Reading the other project covers only that project.
    expect(executeMateTool(turn(1), "get_capabilities", { repo: "r2" })).toMatchObject({ ok: true });
    expect(executeMateTool(turn(2), "propose_task", { repo: "r1", ...TASK_ARGS })).toEqual({ ok: false, message: CAPABILITIES_UNREAD });
    // Read in the same step as the proposal: still refused; a later step: drafted.
    expect(executeMateTool(turn(2), "get_capabilities", { repo: "r1" })).toMatchObject({ ok: true });
    expect(executeMateTool(turn(2), "propose_task", { repo: "r1", ...TASK_ARGS })).toEqual({ ok: false, message: CAPABILITIES_UNREAD });
    expect(executeMateTool(turn(3), "propose_task", { repo: "r1", ...TASK_ARGS })).toMatchObject({ ok: true });
    expect(executeMateTool(turn(3), "commit_to", { what: "Tell you when it is ready", when: "task", task: "t1" })).not.toEqual({ ok: false, message: CAPABILITIES_UNREAD });

    // One read over every project covers each of them.
    const everywhere = new Map<string, number>();
    executeMateTool(ctx(1, { checkedCapabilities: everywhere }), "get_capabilities", {});
    expect(executeMateTool(ctx(2, { checkedCapabilities: everywhere }), "propose_task", { repo: "r2", ...TASK_ARGS })).toMatchObject({ ok: true });
  });

  test("c3: the contract says to check capabilities before promising, and to investigate a limitation before reporting it", () => {
    for (const rule of [
      "Before promising work that depends on an agent, a worker, a tool, a skill or an integration, call get_capabilities this turn",
      "the plane refuses propose_task",
      "say so plainly with its next step and open its link with show_control",
      "never pretend it works",
      "Investigate before reporting a limitation: when a tool refuses or something looks unsupported, read get_capabilities and the relevant skill (get_skills",
      "before telling the owner it can't be done",
    ]) expect(MATE_CONTRACT).toContain(rule);
    // The integrations-only rule is replaced, not kept beside it.
    expect(MATE_CONTRACT).not.toContain("Before promising work that depends on an integration");
  });
});
