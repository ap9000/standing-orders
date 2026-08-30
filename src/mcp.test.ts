import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { mintCoordinator, fileCoordinatorProposal, revokeCoordinator } from "./coordinator.js";
import { serveMcp, MODERN, LEGACY, type McpIo } from "./mcp.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";

const T0 = new Date("2026-08-30T12:00:00.000Z");
const REPO = "/repo/mcp-server";

/** A wired loopback: push lines in, collect protocol lines out. */
function harness(store: Store, token: string): {
  send: (message: unknown) => void;
  sendRaw: (line: string) => void;
  out: () => Record<string, unknown>[];
  last: () => Record<string, unknown>;
  exitCode: () => number | null;
  outcome: ReturnType<typeof serveMcp>;
} {
  const lines: string[] = [];
  let lineHandler: (line: string) => void = () => {};
  let exited: number | null = null;
  const io: McpIo = {
    onLine: handler => { lineHandler = handler; },
    onEof: () => {},
    write: line => lines.push(line),
    log: () => {},
    exit: code => { exited = code; },
  };
  const outcome = serveMcp(store, token, io, () => T0);
  return {
    send: message => lineHandler(JSON.stringify(message)),
    sendRaw: line => lineHandler(line),
    out: () => lines.map(one => JSON.parse(one) as Record<string, unknown>),
    last: () => JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>,
    exitCode: () => exited,
    outcome,
  };
}

describe("the MCP stdio server", () => {
  let store: Store;
  let token: string;

  beforeEach(() => {
    store = openStore(":memory:");
    const made = mintCoordinator(store, { name: "planner-bot", repos: [REPO], by: "alex", now: T0 });
    if (!made.ok) throw new Error("mint failed");
    token = made.token;
  });
  afterEach(() => store.close());

  test("startup dies on an unknown or revoked credential — never a read-only fallback", () => {
    const bad = harness(store, "not-a-token");
    expect(bad.outcome).toMatchObject({ ok: false, reason: "unauthenticated" });
  });

  test("legacy era: initialize negotiates ITSELF (never the modern era), initialized is silent, ping answers", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2019-01-01" } });
    const init = h.last();
    expect((init["result"] as Record<string, unknown>)["protocolVersion"]).toBe(LEGACY);
    expect((init["result"] as Record<string, unknown>)["resultType"]).toBeUndefined();
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(h.out()).toHaveLength(1); // a notification gets NO reply
    h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(h.last()["id"]).toBe(2);
  });

  test("modern era: discover and tools/list are schema-complete (resultType, ttlMs, cacheScope)", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    const discover = h.last()["result"] as Record<string, unknown>;
    expect(discover["protocolVersion"]).toBe(MODERN);
    expect(discover["resultType"]).toBe("complete");
    expect(discover["ttlMs"]).toBe(0);
    expect(discover["cacheScope"]).toBe("session");
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { protocolVersion: MODERN } } });
    const listed = h.last()["result"] as Record<string, unknown>;
    expect(listed["resultType"]).toBe("complete");
    expect((listed["tools"] as unknown[]).length).toBe(6);
    // An unsupported per-request version is the spec's error, not a guess.
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { protocolVersion: "2030-01-01" } } });
    expect(h.last()["error"]).toMatchObject({ code: -32602 });
  });

  test("malformed input answers in-protocol and never crashes: parse error, batch, depth, oversize, unknown method", () => {
    const h = harness(store, token);
    h.sendRaw("{not json");
    expect(h.last()["error"]).toMatchObject({ code: -32700 });
    h.send([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(String((h.last()["error"] as Record<string, unknown>)["message"])).toContain("batching");
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) deep = { inner: deep };
    h.send({ jsonrpc: "2.0", id: 2, method: "ping", params: deep });
    expect(h.last()["error"]).toMatchObject({ code: -32600 });
    h.sendRaw(`{"jsonrpc":"2.0","id":3,"method":"ping","params":{"pad":"${"x".repeat(300 * 1024)}"}}`);
    expect(String((h.last()["error"] as Record<string, unknown>)["message"])).toContain("256");
    h.send({ jsonrpc: "2.0", id: 4, method: "no/such" });
    expect(h.last()["error"]).toMatchObject({ code: -32601 });
  });

  test("a cancellation is a notification: no ack, and the cancelled id's response is suppressed entirely", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
    expect(h.out()).toHaveLength(0);
    h.send({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
    expect(h.out()).toHaveLength(0); // suppressed — not even an error
    h.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    expect(h.out()).toHaveLength(1);
  });

  test("file_proposal files through the door; the task is quarantined; a tool refusal is isError, not a protocol error", () => {
    const h = harness(store, token);
    h.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "file_proposal", arguments: { repo: REPO, title: "Fix the flaky test", idempotency_key: "key-mcp-0001" } },
    });
    const result = h.last()["result"] as Record<string, unknown>;
    expect(result["isError"]).toBeUndefined();
    const body = JSON.parse(String((result["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect(body["replayed"]).toBe(false);
    expect(store.refFor("built-in", String(body["ref"])).coordinatorCid).not.toBeNull();

    // Outside the allowlist: a refusal in words, still a RESULT.
    h.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "file_proposal", arguments: { repo: "/foreign", title: "nope", idempotency_key: "key-mcp-0002" } },
    });
    const refused = h.last()["result"] as Record<string, unknown>;
    expect(refused["isError"]).toBe(true);
    expect(h.last()["error"]).toBeUndefined();
  });

  test("reads are allowlist-scoped: a foreign task answers not-found; status counts only this credential's repos", () => {
    // A task in a repo OUTSIDE the allowlist, via a second coordinator.
    const other = mintCoordinator(store, { name: "other-bot", repos: ["/repo/other"], by: "alex", now: T0 });
    if (!other.ok) throw new Error("mint failed");
    const foreign = fileCoordinatorProposal(store, other.token, { repo: "/repo/other", title: "foreign", idempotencyKey: "key-for-0001" }, T0);
    if (!foreign.ok) throw new Error("filing failed");

    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_task", arguments: { ref: foreign.id } } });
    const answer = h.last()["result"] as Record<string, unknown>;
    expect(answer["isError"]).toBe(true);
    expect(String((answer["content"] as { text: string }[])[0]?.text)).toContain("not-found");

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } });
    const status = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect((status["repos"] as unknown[]).length).toBe(0); // nothing filed in OUR repo yet
  });

  test("revocation mid-session: the next call refuses and the server exits — tools/list visibility was never authorization", () => {
    const h = harness(store, token);
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_repos", arguments: {} } });
    expect((h.last()["result"] as Record<string, unknown>)["isError"]).toBeUndefined();
    const rows = store.handle.prepare("SELECT cid FROM coordinator_credential").all();
    revokeCoordinator(store, String(rows[0]?.["cid"]), "alex", T0);
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_repos", arguments: {} } });
    expect(h.last()["error"]).toMatchObject({ code: -32000 });
    expect(h.exitCode()).toBe(0);
  });

  test("e2e: file through the gateway, seal with the password, dispatch ordinarily, status reflects", () => {
    const h = harness(store, token);
    h.send({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "file_proposal", arguments: { repo: REPO, title: "e2e work", idempotency_key: "key-e2e-0001" } },
    });
    const body = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    const taskId = String(body["ref"]);
    const taskRef = store.refFor("built-in", taskId).id;
    register(store, { name: "b-1", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-b-1" });

    // Quarantined until the password seal — then ordinary.
    expect(acquire(store, taskRef, "b-1", { now: T0, token: "tok-b-1" })).toMatchObject({ ok: false, reason: "coordinator-filed" });
    store.saveScope({
      taskId, goal: "e2e work", outOfScope: null, touches: [],
      proposedAt: T0.toISOString(), digest: `dg-${taskId}`,
      approvedAt: null, approvedBy: null, approvedDigest: null,
    });
    expect(store.sealScopeApproval(taskId, "alex", T0)).toBe(true);
    expect(acquire(store, taskRef, "b-1", { now: T0, token: "tok-b-1" })).toMatchObject({ ok: true });

    // The gateway's own view reflects it: the task is visible in OUR
    // repo, sealed and claimed (the raw claim primitive leaves the state
    // transition to its callers, so no state filter here).
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_tasks", arguments: {} } });
    const listed = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect((listed["tasks"] as { ref: string }[]).map(one => one.ref)).toEqual([taskId]);
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_task", arguments: { ref: taskId } } });
    const detail = JSON.parse(String(((h.last()["result"] as Record<string, unknown>)["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect((detail["scope"] as Record<string, unknown>)["sealed"]).toBe(true);
  });

  test("ARCH: no raw row spread leaves this module", () => {
    // The typed-projection rule (spec v6): reading the source proves no
    // `...row` reaches a tool result.
    const source = require("node:fs").readFileSync(new URL("./mcp.ts", import.meta.url), "utf8") as string;
    expect(source.includes("...row")).toBe(false);
  });
});
