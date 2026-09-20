import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignmentArgumentProblem, assignmentForCoordinator, runAssignmentCommand } from "./assignment-adapters.js";
import { mintCoordinator, revokeCoordinator } from "./coordinator.js";
import { openStore, type Store } from "./store.js";
import { main } from "./cli.js";
import { serveMcp, MODERN, type McpIo } from "./mcp.js";

const NOW = new Date("2026-09-20T12:00:00Z");
const REPO = "/repo/assignment-adapter";
const META = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {} };

describe("assignment adapters preserve scope and acknowledgment authority", () => {
  let store: Store, directory: string, token: string, cid: string, file: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "standing-orders-assignment-adapters-"));
    file = join(directory, "orders.db");
    store = openStore(file);
    for (const [id, repo] of [["mine", REPO], ["foreign", "/repo/private"]]) {
      store.createTask({ id: id!, title: "Verify the saved result" }, NOW);
      store.placeTask(store.refFor("built-in", id!).id, repo!, {}, NOW);
    }
    const made = mintCoordinator(store, { name: "lead", repos: [REPO], by: "operator", now: NOW });
    if (!made.ok) throw Error("fixture credential refused");
    token = made.token; cid = made.cid;
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  function cli(argv: string[], flags: Record<string, string | true> = {}, env: NodeJS.ProcessEnv = {}) {
    const lines: string[] = [];
    const code = runAssignmentCommand(argv, new Map(Object.entries({ json: true, ...flags })), { store, now: NOW, json: true, write: line => lines.push(line), env });
    expect(lines).toHaveLength(1);
    return { code, body: JSON.parse(lines[0]!), raw: lines[0]! };
  }

  test("explicit coordinator reads hide foreign and absent assignments equally; invalid auth never falls back", () => {
    const own = assignmentForCoordinator(store, token, "show", { ref: "mine" }, NOW);
    expect(own.ok).toBe(true);
    expect(assignmentForCoordinator(store, token, "show", { ref: "foreign" }, NOW))
      .toEqual(assignmentForCoordinator(store, token, "show", { ref: "absent" }, NOW));
    expect(cli(["show", "foreign"]).code).toBe(0); // Local read has existing database authority.
    expect(cli(["show", "foreign"], { "token-env": "LEAD" }, { LEAD: token }).body).toMatchObject({ ok: false, reason: "not-found" });
    expect(cli(["show", "mine"], { "token-env": "LEAD" }).body).toMatchObject({ ok: false, reason: "unauthenticated" });
    expect(cli(["show", "mine"], { "token-env": "LEAD" }, { LEAD: "invalid" }).code).toBe(3);
  });

  test("claim replay is idempotent, does not grant scope or dispatch, and revocation is reread", () => {
    const before = store.getTask("mine"), beforeNotifications = store.listNotifications("all");
    expect(assignmentForCoordinator(store, token, "claim", { ref: "mine" }, NOW).ok).toBe(true);
    const rows = Number(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger").get()?.["n"]);
    expect(assignmentForCoordinator(store, token, "claim", { ref: "mine" }, NOW).ok).toBe(true);
    expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger").get()?.["n"])).toBe(rows);
    expect(store.getTask("mine")).toEqual(before);
    expect(store.getScope("mine")).toBeNull();
    expect(store.runsFor(store.refFor("built-in", "mine").id)).toEqual([]);
    expect(store.listNotifications("all").slice(0, beforeNotifications.length)).toEqual(beforeNotifications);
    const handoffs = store.listNotifications("all").filter(one => one.kind === "assignment-handoff");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ attempts: 0, deliveredAt: null, resolvedAt: null });
    expect(assignmentForCoordinator(store, token, "check", { ref: "mine", digest: "a".repeat(64) }, NOW).ok).toBe(false);
    revokeCoordinator(store, cid, "operator", NOW);
    for (const operation of ["show", "claim", "updates", "check"] as const) {
      const args = operation === "updates" ? {} : { ref: "mine", ...(operation === "check" ? { digest: "a".repeat(64) } : {}) };
      expect(assignmentForCoordinator(store, token, operation, args, NOW)).toMatchObject({ ok: false, reason: "unauthenticated" });
    }
  });

  test("claim/check never borrow operator credentials or discover secret sources", () => {
    for (const operation of ["claim", "check"]) {
      const flags = operation === "check" ? { digest: "a".repeat(64) } : {};
      expect(cli([operation, "mine"], flags, { STANDING_ORDERS_TOKEN: token }).body).toMatchObject({ ok: false, reason: "unauthenticated" });
      expect(cli([operation, "mine"], { ...flags, token }).code).toBe(2);
      expect(cli([operation, "mine"], { ...flags, as: "operator" }).code).toBe(2);
    }
    const tokenFile = join(directory, "lead-token");
    writeFileSync(tokenFile, `${token}\n`);
    const result = cli(["claim", "mine"], { "token-file": tokenFile });
    expect(result.code).toBe(0);
    expect(result.raw).not.toContain(token);
    expect(cli(["show", "mine"], { "token-file": directory }).code).toBe(2);
    expect(cli(["show", "mine"], { "token-env": "LEAD", "token-file": tokenFile }, { LEAD: token }).code).toBe(2);
  });

  test.each([
    ["updates", { after: -1 }], ["updates", { after: Number.MAX_SAFE_INTEGER + 1 }],
    ["updates", { limit: 101 }], ["updates", { after: 1.5 }], ["updates", { ref: "mine" }],
    ["show", { ref: "mine", yes: true }], ["show", { ref: "x\n" }],
    ["check", { ref: "mine", digest: "G".repeat(64) }], ["check", { ref: "mine" }],
  ] as const)("%s rejects malformed identity/cursor without a mutation", (operation, args) => {
    expect(assignmentArgumentProblem(operation, args)).not.toBeNull();
    expect(assignmentForCoordinator(store, token, operation, args, NOW)).toMatchObject({ ok: false, reason: "usage" });
  });

  test("CLI routes the new family with one versioned envelope and rejects foreign flags", async () => {
    const lines: string[] = [];
    expect(await main(["assignment", "show", "mine", "--json"], line => lines.push(line), { operate: { databaseFile: file, now: NOW } })).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ envelopeVersion: 1, ok: true, command: "assignment show" });
    expect(cli(["updates"], { after: "1e2" }).code).toBe(2);
    expect(cli(["updates"], { limit: "1.2" }).code).toBe(2);
    expect(cli(["show", "mine"], { yes: true }).code).toBe(2);
    expect(cli(["updates", "mine"]).code).toBe(2);
    const plain: string[] = [];
    expect(runAssignmentCommand(["show", "mine"], new Map(), { store, now: NOW, json: false, write: line => plain.push(line) })).toBe(0);
    expect(plain.join("\n")).toContain("Current task: mine");
    expect(plain.join("\n")).toContain("Lead: unclaimed");
    expect(plain.join("\n")).toContain("Deployment: not recorded");
  });

  test("admitted update cursors can be replayed and do not mark human notifications delivered", () => {
    assignmentForCoordinator(store, token, "claim", { ref: "mine" }, NOW);
    const first = assignmentForCoordinator(store, token, "updates", { after: 0, limit: 1 }, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok || !("events" in first.body)) throw Error("missing update page");
    expect(first.body.events).toHaveLength(1);
    expect(first.body.events[0]?.rootId).toBe("mine");
    expect(first.body.nextCursor).toBe(first.body.events[0]?.id);
    expect(assignmentForCoordinator(store, token, "updates", { after: 0, limit: 1 }, NOW)).toEqual(first);
    const next = assignmentForCoordinator(store, token, "updates", { after: first.body.nextCursor, limit: 1 }, NOW);
    expect(next).toMatchObject({ ok: true, body: { events: [], nextCursor: first.body.nextCursor } });
    expect(store.listNotifications("all").every(one => one.deliveredAt === null && one.resolvedAt === null)).toBe(true);
  });

  test("MCP exposes exactly the narrow assignment tools and keeps consent verbs absent", () => {
    const lines: string[] = []; let receive: (line: string) => void = () => {};
    const io: McpIo = { onLine: handler => { receive = handler; }, onEof: () => {}, write: line => lines.push(line), log: () => {}, exit: () => {} };
    expect(serveMcp(store, token, io, () => NOW, [REPO]).ok).toBe(true);
    const call = (method: string, params: Record<string, unknown> = {}) => {
      receive(JSON.stringify({ jsonrpc: "2.0", id: lines.length + 1, method, params: { ...params, _meta: META } }));
      return JSON.parse(lines.at(-1)!);
    };
    const names = call("tools/list").result.tools.map((tool: { name: string }) => tool.name);
    expect(names.filter((name: string) => name.includes("assignment"))).toEqual(["get_assignment", "list_assignment_updates", "claim_assignment", "acknowledge_assignment", "get_assignment_brief", "get_assignment_inbox", "acknowledge_assignment_delivery"]);
    expect(names).not.toContain("approve_assignment");
    expect(names).not.toContain("complete_assignment");
    const read = call("tools/call", { name: "get_assignment", arguments: { ref: "mine" } });
    expect(read.result.isError).not.toBe(true);
    expect(call("tools/call", { name: "claim_assignment", arguments: { ref: "foreign" } }).result.isError).toBe(true);
    expect(call("tools/call", { name: "acknowledge_assignment", arguments: { ref: "mine", digest: "a".repeat(64), yes: true } }).error.code).toBe(-32602);
    expect(call("tools/call", { name: "acknowledge_assignment", arguments: { ref: "mine", digest: "G".repeat(64) } }).error.code).toBe(-32602);
    expect(call("tools/call", { name: "get_assignment_brief", arguments: {} }).result.isError).not.toBe(true);
    const inbox = call("tools/call", { name: "get_assignment_inbox", arguments: { consumer: "codex-main" } });
    expect(inbox.result.isError).not.toBe(true);
    expect(call("tools/call", { name: "acknowledge_assignment_delivery", arguments: { consumer: "codex-main", batchId: "invalid" } }).error.code).toBe(-32602);
  });

  test("database brief and durable delivery share CLI admission without executing work", () => {
    const auth = { "token-env": "LEAD" }, env = { LEAD: token };
    expect(cli(["inbox"], { consumer: "codex-main" }).body.reason).toBe("unauthenticated");
    expect(cli(["claim", "mine"], auth, env).code).toBe(0);
    const taskBefore = store.getTask("mine"), notificationsBefore = store.listNotifications("all");
    const brief = cli(["brief"], auth, env);
    expect(brief.code).toBe(0);
    expect(brief.raw).toContain("mine");
    expect(brief.raw).not.toContain("/repo/private");
    const first = cli(["inbox"], { ...auth, consumer: "codex-main" }, env);
    expect(first.code).toBe(0);
    expect(first.body.result.batch.events.length).toBeGreaterThan(0);
    expect(cli(["inbox"], { ...auth, consumer: "codex-main" }, env).body.result.batch).toEqual(first.body.result.batch);
    const acknowledged = cli(["ack"], { ...auth, consumer: "codex-main", batch: first.body.result.batch.id }, env);
    expect(acknowledged.code).toBe(0);
    expect(cli(["inbox"], { ...auth, consumer: "codex-main" }, env).body.result.batch.events).toEqual([]);
    expect(store.getTask("mine")).toEqual(taskBefore);
    expect(store.runsFor(store.refFor("built-in", "mine").id)).toEqual([]);
    expect(store.listNotifications("all")).toEqual(notificationsBefore);
    revokeCoordinator(store, cid, "operator", NOW);
    for (const op of ["inbox", "brief", "ack"]) {
      const flags = op === "brief" ? auth : { ...auth, consumer: "codex-main", ...(op === "ack" ? { batch: first.body.result.batch.id } : {}) };
      expect(cli([op], flags, env).body.reason).toBe("unauthenticated");
    }
  });

  test.each([
    ["brief", { limit: 26 }], ["brief", { repo: "\n" }],
    ["inbox", {}], ["inbox", { consumer: "../escape" }], ["inbox", { consumer: "lead", after: 99 }],
    ["ack", { consumer: "lead" }], ["ack", { consumer: "lead", batchId: "a".repeat(64), yes: true }],
  ] as const)("%s rejects malformed delivery or brief arguments", (operation, args) => {
    expect(assignmentArgumentProblem(operation, args)).not.toBeNull();
  });
});
