/**
 * `standing-orders mcp` — the MCP stdio server (MCP gateway spec v6).
 *
 * Zero-dep JSON-RPC 2.0 over stdio, newline-delimited; stdout carries
 * protocol bytes ONLY (logs go to stderr); clean EOF is clean shutdown.
 * Two pinned protocol revisions:
 *
 *   - modern `2026-07-28`: stateless; every request carries its version in
 *     `_meta`; `server/discover` describes the server; successful results
 *     are schema-complete (`resultType: "complete"`, and tools/list +
 *     discover carry `ttlMs: 0` with the narrowest `cacheScope`).
 *   - legacy `2025-11-25`: the initialize era — a client asking for an
 *     unsupported version is answered WITH this one (negotiation, not
 *     refusal); `notifications/initialized` is received and ignored. The
 *     eras never cross: initialize never counter-offers the modern one.
 *
 * No JSON-RPC batching in either era (arrays reject). A cancellation is a
 * notification: the server stops work on that id and suppresses its
 * response entirely. Limits: request ≤ 256 KiB, JSON depth ≤ 32.
 *
 * EVERY tool call authenticates the coordinator credential; the schema
 * version is re-read per call (a concurrent migration refuses in words
 * and the server exits). Protocol errors are JSON-RPC errors; tool-level
 * refusals are successful `tools/call` results with `isError: true`.
 */

import type { Store } from "./store.js";
import {
  authenticateCoordinator,
  fileCoordinatorProposal,
  statusFor,
  listTasksFor,
  taskDetailFor,
  type VerifiedCoordinator,
} from "./coordinator.js";

export const MODERN = "2026-07-28";
export const LEGACY = "2025-11-25";
const MAX_REQUEST = 256 * 1024;
const MAX_DEPTH = 32;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_DEPTH) return depth;
  if (Array.isArray(value)) return Math.max(depth, ...value.map(one => depthOf(one, depth + 1)));
  if (value !== null && typeof value === "object") {
    const inner = Object.values(value as Record<string, unknown>);
    return inner.length === 0 ? depth : Math.max(depth, ...inner.map(one => depthOf(one, depth + 1)));
  }
  return depth;
}

/** One typed descriptor per tool — THE source for parsing, inputSchema,
 * and projection. Output is built field-by-field; spreading a database
 * row into a result is forbidden in this module (arch-tested). */
type Tool = {
  name: string;
  description: string;
  inputSchema: Json;
  handle: (store: Store, who: VerifiedCoordinator, args: Record<string, unknown>, now: Date) =>
    | { ok: true; body: Json }
    | { ok: false; message: string };
};

const CONTRACT_GUIDE = [
  "standing-orders MCP contract.",
  "You hold a coordinator credential: you may READ the plane inside your repo allowlist, and FILE proposals — nothing else.",
  "A filed proposal is an ordinary unapproved task: it is quarantined from planning, claiming, and running until the operator signs its scope in a password ceremony that shows them who asked. Modes never auto-admit coordinator filings.",
  "file_proposal requires an idempotency_key (8-64 printable chars, unique per request): replaying the same key+request returns the original task; the same key with a different request refuses.",
  "You are rate-limited per hour and capped on outstanding unapproved filings. Refusals say the limit and the road in words.",
  "Approve, steer, answer, pick, mint, configure, merge: those verbs do not exist on this surface, by construction.",
].join("\n");

function str(args: Record<string, unknown>, name: string, max: number): string | null {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
  return value;
}

const TOOLS: Tool[] = [
  {
    name: "status",
    description: "The plane's liveness facts over your repo allowlist: what waits on the operator, what runs, what finished in the last 24h.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handle: (store, who, _args, now) => ({ ok: true, body: statusFor(store, who, now) as unknown as Json }),
  },
  {
    name: "list_tasks",
    description: "Tasks in your repo allowlist. Filter by state and repo; cursor-paginated, stable order.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled"] },
        repo: { type: "string", maxLength: 800 },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    handle: (store, who, args) => {
      const filter: { state?: string; repo?: string; cursor?: number; limit?: number } = {};
      if (typeof args["state"] === "string") filter.state = args["state"];
      if (typeof args["repo"] === "string") filter.repo = args["repo"];
      if (typeof args["cursor"] === "number") filter.cursor = args["cursor"];
      if (typeof args["limit"] === "number") filter.limit = args["limit"];
      return { ok: true, body: listTasksFor(store, who, filter) as unknown as Json };
    },
  },
  {
    name: "get_task",
    description: "One task's scope standing, filer provenance, and attempt ledger. A ref outside your allowlist answers not-found.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["ref"],
      additionalProperties: false,
    },
    handle: (store, who, args) => {
      const ref = str(args, "ref", 64);
      if (ref === null) return { ok: false, message: "ref is a task id, 1-64 characters" };
      const detail = taskDetailFor(store, who, ref);
      if (detail === null) return { ok: false, message: `not-found: no task \`${ref}\` in your repositories` };
      return { ok: true, body: detail as unknown as Json };
    },
  },
  {
    name: "list_repos",
    description: "The repositories your credential may see and file into.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handle: (_store, who) => ({ ok: true, body: { repos: [...who.repos] } }),
  },
  {
    name: "get_contract",
    description: "This surface's contract: what a coordinator may do, the proposal lifecycle, and the admission promise.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handle: () => ({ ok: true, body: { contract: CONTRACT_GUIDE } }),
  },
  {
    name: "file_proposal",
    description: "File a task proposal into one of your repositories. It stays quarantined until the operator signs its scope.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", minLength: 1, maxLength: 800 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        intent: { type: "string", maxLength: 2000 },
        idempotency_key: { type: "string", minLength: 8, maxLength: 64 },
      },
      required: ["repo", "title", "idempotency_key"],
      additionalProperties: false,
    },
    handle: (store, _who, args, now) => {
      const repo = str(args, "repo", 800);
      const title = str(args, "title", 200);
      const key = str(args, "idempotency_key", 64);
      const intent = typeof args["intent"] === "string" ? args["intent"] : undefined;
      if (repo === null || title === null || key === null) {
        return { ok: false, message: "file_proposal needs repo, title, and idempotency_key (8-64 chars)" };
      }
      // The token, not the pre-verified identity: filing re-authenticates
      // INSIDE its own transaction (the session's `who` is a courtesy).
      const outcome = fileCoordinatorProposal(
        store,
        currentToken,
        { repo, title, ...(intent === undefined ? {} : { intent }), idempotencyKey: key },
        now,
      );
      if (!outcome.ok) return { ok: false, message: outcome.message };
      return {
        ok: true,
        body: {
          ref: outcome.id,
          replayed: outcome.replayed,
          admission: "quarantined until the operator signs its scope — the ceremony shows them your name",
        },
      };
    },
  },
];

/** The filing tool needs the raw token for its in-transaction re-auth;
 * it is process state, set once at serve() start, never in tool output. */
let currentToken = "";

export type McpIo = {
  onLine: (handler: (line: string) => void) => void;
  onEof: (handler: () => void) => void;
  write: (line: string) => void;
  log: (line: string) => void;
  exit: (code: number) => void;
};

export type McpOutcome =
  | { ok: true }
  | { ok: false; reason: "unauthenticated" | "revoked" | "schema"; message: string };

/** Serve until EOF. The store is already open through the non-migrating
 * door; the token was startup-verified by the caller (and dies here again
 * if it does not hold). */
export function serveMcp(
  store: Store,
  token: string,
  io: McpIo,
  clock: () => Date = () => new Date(),
): McpOutcome {
  const auth = authenticateCoordinator(store, token);
  if (!auth.ok) {
    return {
      ok: false,
      reason: auth.reason === "revoked" ? "revoked" : "unauthenticated",
      message:
        auth.reason === "revoked"
          ? "this coordinator credential was revoked — mint a new one"
          : "no live coordinator credential matches this token",
    };
  }
  currentToken = token;
  const cancelled = new Set<string>();

  const error = (id: Json, code: number, message: string): void =>
    io.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));

  const respond = (id: Json, era: "modern" | "legacy", result: Record<string, Json>, cacheable: boolean): void => {
    if (id !== null && cancelled.has(JSON.stringify(id))) return; // suppressed entirely
    const complete: Record<string, Json> =
      era === "modern"
        ? { ...result, resultType: "complete", ...(cacheable ? { ttlMs: 0, cacheScope: "session" } : {}) }
        : result;
    io.write(JSON.stringify({ jsonrpc: "2.0", id, result: complete }));
  };

  const toolsPayload = (): Json => ({
    tools: TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  });

  const callTool = (id: Json, era: "modern" | "legacy", params: Record<string, unknown>): void => {
    // A concurrent migration refuses in words and the server exits clean —
    // a long-lived reader never blesses a moved or mid-flight schema.
    if (!store.schemaCurrent()) {
      error(id, -32000, "the database schema moved underneath this server — restart it");
      io.exit(0);
      return;
    }
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const tool = TOOLS.find(one => one.name === name);
    if (tool === undefined) {
      error(id, -32602, `no tool \`${name}\``);
      return;
    }
    // tools/list visibility is presentation — authorization happens HERE,
    // on every call, against the live credential row.
    const session = authenticateCoordinator(store, token);
    if (!session.ok) {
      error(id, -32000, "this credential no longer stands — the server exits");
      io.exit(0);
      return;
    }
    const args = (params["arguments"] ?? {}) as Record<string, unknown>;
    const answered = tool.handle(store, session.who, args, clock());
    if (!answered.ok) {
      respond(id, era, { content: [{ type: "text", text: answered.message }], isError: true }, false);
      return;
    }
    respond(id, era, { content: [{ type: "text", text: JSON.stringify(answered.body) }] }, false);
  };

  io.onLine(line => {
    if (line.trim() === "") return;
    if (Buffer.byteLength(line, "utf8") > MAX_REQUEST) {
      error(null, -32600, "request over 256 KiB");
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      error(null, -32700, "parse error");
      return;
    }
    if (Array.isArray(message)) {
      // Batching left MCP in 2025-06-18 — neither pinned era accepts it.
      error(null, -32600, "JSON-RPC batching is not part of MCP — send one request per line");
      return;
    }
    if (message === null || typeof message !== "object" || depthOf(message) > MAX_DEPTH) {
      error(null, -32600, "invalid request");
      return;
    }
    const request = message as Record<string, unknown>;
    const id = (request["id"] ?? null) as Json;
    const method = typeof request["method"] === "string" ? request["method"] : "";
    const params = (request["params"] ?? {}) as Record<string, unknown>;
    const meta = (params["_meta"] ?? {}) as Record<string, unknown>;

    if (method === "notifications/cancelled") {
      const target = params["requestId"];
      if (target !== undefined) cancelled.add(JSON.stringify(target as Json));
      return; // a notification — no reply of any kind
    }
    if (method === "notifications/initialized") return; // legacy lifecycle — received, ignored

    if (method === "initialize") {
      // The handshake era can only negotiate ITSELF: an unsupported ask is
      // answered WITH the legacy version, never the modern one.
      respond(id, "legacy", {
        protocolVersion: LEGACY,
        capabilities: { tools: {} },
        serverInfo: { name: "standing-orders", version: "0.4.0" },
      }, false);
      return;
    }
    if (method === "ping") {
      respond(id, "legacy", {}, false);
      return;
    }
    if (method === "server/discover") {
      respond(id, "modern", {
        protocolVersion: MODERN,
        capabilities: { tools: {} },
        serverInfo: { name: "standing-orders", version: "0.4.0" },
        ...(toolsPayload() as Record<string, Json>),
      }, true);
      return;
    }

    const declared = typeof meta["protocolVersion"] === "string" ? meta["protocolVersion"] : null;
    const era: "modern" | "legacy" = declared === MODERN ? "modern" : "legacy";
    if (declared !== null && declared !== MODERN && declared !== LEGACY) {
      error(id, -32602, `unsupported protocol version \`${declared}\` — this server speaks ${MODERN} and ${LEGACY}`);
      return;
    }

    if (method === "tools/list") {
      respond(id, era, toolsPayload() as Record<string, Json>, true);
      return;
    }
    if (method === "tools/call") {
      callTool(id, era, params);
      return;
    }
    error(id, -32601, `unknown method \`${method}\``);
  });

  io.onEof(() => io.exit(0));
  return { ok: true };
}
