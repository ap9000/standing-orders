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
import { ISO_STAMP_RULE, decisionOver, decisionsOver, labelRepos, queueOver, recapOver } from "./mate-tools.js";
import { proposeAsCoordinator } from "./coordinator-proposals.js";
import type { CoordinatorProposalKind } from "./store.js";

export const MODERN = "2026-07-28";
export const LEGACY = "2025-11-25";
/** The modern revision namespaces its per-request metadata. */
export const META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_SERVER = "io.modelcontextprotocol/serverInfo";
export const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
/** The revision's own error code for an unsupported protocol version. */
export const UNSUPPORTED_VERSION = -32022;
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
type ToolContext = {
  store: Store;
  who: VerifiedCoordinator;
  /** The installation's enrolled repos (repos.json), when the launcher
   * knows them — list_repos answers allowlist ∩ enrolled. null = the
   * launcher could not read the registry; the allowlist alone answers. */
  enrolled: readonly string[] | null;
  /** The raw credential, per-SERVER closure state — never module state:
   * two serveMcp instances in one process must not cross credentials
   * (implementation review, finding 5). Filing re-authenticates with it
   * inside its own transaction. */
  token: string;
  now: Date;
  /** Decisions this connection read with get_decision — propose_answer needs one. */
  readDecisions: Set<number>;
};

type Tool = {
  name: string;
  description: string;
  inputSchema: Json;
  handle: (ctx: ToolContext, args: Record<string, unknown>) =>
    | { ok: true; body: Json }
    | { ok: false; message: string };
};

const CONTRACT_GUIDE = [
  "standing-orders MCP contract.",
  "You hold a coordinator credential: you may READ the plane inside your repo allowlist, and FILE proposals — nothing else.",
  "A filed proposal is an ordinary unapproved task: it is quarantined from planning, claiming, and running until the operator signs its scope in a password ceremony that shows them who asked. Modes never auto-admit coordinator filings.",
  "file_proposal requires an idempotency_key (8-64 printable chars, unique per request): replaying the same key+request returns the original task; the same key with a different request refuses.",
  "You are rate-limited per hour and capped on outstanding unapproved filings. Refusals say the limit and the road in words.",
  "recap, list_decisions, get_decision, and queue are the plane's own read queries (shared with the operator's mate). get_decision shows each option's consequence, never the builder's recommendation.",
  "propose_next, propose_reserve, propose_hold, propose_unhold, propose_scope, propose_cancel, and propose_answer write a PROPOSAL row and nothing else: an approver confirms it on the console or the CLI, and a stale one refuses there. Proposals share your hourly filing rate and hold at most 20 pending per credential; they expire after seven days.",
  "Approve, steer, answer, pick, mint, configure, merge: those verbs do not exist on this surface, by construction.",
].join("\n");

/** The descriptor's inputSchema IS the runtime parser (review finding 2):
 * unknown fields, bad types, bad enums, and bound violations are protocol
 * errors (InvalidParams), never tool refusals. Small on purpose — it
 * covers exactly the schema features the descriptors use. */
function invalidArgs(schema: Json, args: Record<string, unknown>): string | null {
  const shape = schema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  const properties = shape.properties ?? {};
  for (const key of Object.keys(args)) {
    if (properties[key] === undefined) return "unknown argument `" + key + "`";
  }
  for (const key of shape.required ?? []) {
    if (args[key] === undefined) return "missing required argument `" + key + "`";
  }
  for (const [key, rule] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) continue;
    // A union type (`["string","null"]`) admits null or its other member;
    // an array checks its items and its cap (v3 review, finding 8).
    if (Array.isArray(rule["type"])) {
      const types = rule["type"] as string[];
      if (value === null) {
        if (!types.includes("null")) return "`" + key + "` must not be null";
        continue;
      }
      const member = types.find(one => one !== "null");
      const problem = invalidArgs({ type: "object", properties: { [key]: { ...rule, type: member ?? "string" } } } as unknown as Json, { [key]: value });
      if (problem !== null) return problem;
      continue;
    }
    if (rule["type"] === "array") {
      if (!Array.isArray(value)) return "`" + key + "` must be an array";
      const maxItems = rule["maxItems"];
      if (typeof maxItems === "number" && value.length > maxItems) return "`" + key + "` has more than " + String(maxItems) + " items";
      const items = rule["items"] as Record<string, unknown> | undefined;
      if (items !== undefined) {
        for (const one of value) {
          const problem = invalidArgs({ type: "object", properties: { item: items } } as unknown as Json, { item: one });
          if (problem !== null) return "`" + key + "`: " + problem.replace("`item`", "an item");
        }
      }
      continue;
    }
    if (rule["type"] === "boolean" && typeof value !== "boolean") return "`" + key + "` must be a boolean";
    if (rule["type"] === "string") {
      if (typeof value !== "string") return "`" + key + "` must be a string";
      const min = rule["minLength"];
      const max = rule["maxLength"];
      if (typeof min === "number" && value.length < min) return "`" + key + "` is shorter than " + String(min);
      if (typeof max === "number" && value.length > max) return "`" + key + "` is longer than " + String(max);
      const allowed = rule["enum"];
      if (Array.isArray(allowed) && !allowed.includes(value)) return "`" + key + "` must be one of " + allowed.join(", ");
    }
    if (rule["type"] === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) return "`" + key + "` must be an integer";
      const min = rule["minimum"];
      const max = rule["maximum"];
      if (typeof min === "number" && value < min) return "`" + key + "` is below " + String(min);
      if (typeof max === "number" && value > max) return "`" + key + "` is above " + String(max);
    }
  }
  return null;
}

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
    handle: ctx => ({ ok: true, body: statusFor(ctx.store, ctx.who, ctx.now) as unknown as Json }),
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
    handle: (ctx, args) => {
      const filter: { state?: string; repo?: string; cursor?: number; limit?: number } = {};
      if (typeof args["state"] === "string") filter.state = args["state"];
      if (typeof args["repo"] === "string") filter.repo = args["repo"];
      if (typeof args["cursor"] === "number") filter.cursor = args["cursor"];
      if (typeof args["limit"] === "number") filter.limit = args["limit"];
      return { ok: true, body: listTasksFor(ctx.store, ctx.who, filter, ctx.now) as unknown as Json };
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
    handle: (ctx, args) => {
      const ref = str(args, "ref", 64);
      if (ref === null) return { ok: false, message: "ref is a task id, 1-64 characters" };
      const detail = taskDetailFor(ctx.store, ctx.who, ref);
      if (detail === null) return { ok: false, message: `not-found: no task \`${ref}\` in your repositories` };
      return { ok: true, body: detail as unknown as Json };
    },
  },
  {
    name: "list_repos",
    description: "The repositories your credential may see and file into, with their operating-mode standing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handle: ctx => {
      // FAIL CLOSED when the project registry cannot be read (round-2
      // finding 4): answering the full allowlist would claim enrollment
      // nobody proved.
      if (ctx.enrolled === null) {
        return { ok: false, message: "the project registry could not be read — the enrolled set is unknown, so nothing lists" };
      }
      return {
      ok: true,
      body: {
        repos: ctx.who.repos
          .filter(repo => ctx.enrolled !== null && ctx.enrolled.includes(repo))
          .map(repo => {
            const mode = ctx.store.activeMode(repo, ctx.now);
            return { repo, mode: mode === null ? "no operating mode — every act is a ceremony" : `mode ${mode.name} signed until ${mode.absoluteExpiry}` };
          }),
      },
      };
    },
  },
  {
    name: "recap",
    description: "How things stand per repository in your allowlist, counts and ids: what waits on the operator (decisions, incidents, scopes awaiting approval), what runs, what is queued, finished, failed. Pass `since` (an ISO timestamp) to count only decisions, incidents, and attempts newer than it, to the hour; queued work and scopes awaiting approval always count.",
    inputSchema: { type: "object", properties: { since: { type: "string", maxLength: 30 } }, additionalProperties: false },
    handle: (ctx, args) => {
      const since = args["since"];
      if (since !== undefined && (typeof since !== "string" || !ISO_STAMP_RULE.test(since) || Number.isNaN(Date.parse(since)))) {
        return { ok: false, message: "since is an ISO timestamp like 2026-09-02T12:00:00Z" };
      }
      return { ok: true, body: labelRepos(recapOver(ctx.store, ctx.who.repos, ctx.now, typeof since === "string" ? since : null), index => ctx.who.repos[index] ?? "") as unknown as Json };
    },
  },
  {
    name: "list_decisions",
    description: "Open decisions in your allowlist: id, task, question, options (id, label, reversible), age in hours. Never consequences or recommendations; the operator answers them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handle: ctx => ({ ok: true, body: labelRepos(decisionsOver(ctx.store, ctx.who.repos, ctx.now), index => ctx.who.repos[index] ?? "") as unknown as Json }),
  },
  {
    name: "queue",
    description: "One repository's queue by column — the shared column, then each worker's reserved column — each in dispatch order.",
    inputSchema: { type: "object", properties: { repo: { type: "string", minLength: 1, maxLength: 800 } }, required: ["repo"], additionalProperties: false },
    handle: (ctx, args) => {
      const repo = str(args, "repo", 800);
      if (repo === null || !ctx.who.repos.includes(repo)) return { ok: false, message: "not-found: that repository is not in your allowlist" };
      // The installation-wide revision stays home (slice-2 review, finding
      // 12): a coordinator cannot move queues, and the counter would tell it
      // about repos it may not see.
      const { queueRevision: _revision, ...columns } = queueOver(ctx.store, repo, ctx.now);
      return { ok: true, body: { repo, ...columns } as unknown as Json };
    },
  },
  {
    name: "get_decision",
    description: "One open decision in your allowlist in full: question, options with id, label, reversible, and consequence. Never the builder's recommendation.",
    inputSchema: { type: "object", properties: { decision: { type: "integer", minimum: 1 } }, required: ["decision"], additionalProperties: false },
    handle: (ctx, args) => {
      const found = decisionOver(ctx.store, ctx.who.repos, Number(args["decision"]), ctx.now);
      if (found === null) return { ok: false, message: "not-found: no such decision in your repositories" };
      ctx.readDecisions.add(Number(args["decision"]));
      return { ok: true, body: labelRepos(found, index => ctx.who.repos[index] ?? "") as unknown as Json };
    },
  },
  ...proposeTools(),
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
    handle: (ctx, args) => {
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
        ctx.store,
        ctx.token,
        { repo, title, ...(intent === undefined ? {} : { intent }), idempotencyKey: key },
        ctx.now,
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

/** The propose_* tools: each writes one proposal row through the coordinator door. */
function proposeTools(): Tool[] {
  const ref = { type: "string", minLength: 1, maxLength: 64 };
  const make = (kind: CoordinatorProposalKind, description: string, properties: Record<string, unknown>, required: string[]): Tool => ({
    name: `propose_${kind}`,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false } as unknown as Json,
    handle: (ctx, args) => {
      const outcome = proposeAsCoordinator(ctx.store, ctx.token, kind, args, ctx.now, { readDecisions: ctx.readDecisions });
      if (!outcome.ok) return { ok: false, message: outcome.message };
      return { ok: true, body: { proposal: outcome.id, kind: outcome.kind, awaiting: outcome.awaiting } };
    },
  });
  return [
    make("next", "Propose moving a queued task to the front of its column. An approver confirms; a queue that moved meanwhile refuses.", { ref }, ["ref"]),
    make("reserve", "Propose reserving a queued task for one worker, or releasing it to the shared queue with worker null.", { ref, worker: { type: ["string", "null"], maxLength: 60 } }, ["ref", "worker"]),
    make("hold", "Propose holding a task's next attempt, with a reason. A running attempt is never interrupted.", { ref, reason: { type: "string", maxLength: 200 } }, ["ref", "reason"]),
    make("unhold", "Propose lifting the operator's own hold on a task.", { ref }, ["ref"]),
    make("scope", "Propose rewriting a task's scope. An approver confirms the rewrite, then approves it with a password — a scope you wrote never seals under a mode.", { ref, goal: { type: "string", maxLength: 2000 }, not: { type: "string", maxLength: 2000 }, touches: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 50 } }, ["ref", "goal"]),
    make("cancel", "Propose cancelling a task, with a reason. The approver arms and confirms it on the task itself.", { ref, reason: { type: "string", maxLength: 200 } }, ["ref", "reason"]),
    make("answer", "Propose an answer to an open decision you read with get_decision, with a rationale. The approver confirms where every consequence and the builder's recommendation are shown; an irreversible option needs their explicit confirmation.", { decision: { type: "integer", minimum: 1 }, option: { type: "string", minLength: 1, maxLength: 64 }, rationale: { type: "string", maxLength: 400 } }, ["decision", "option", "rationale"]),
  ];
}

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
  enrolled: readonly string[] | null = null,
): McpOutcome {
  /** Per connection: which decisions this credential read in full (v3). */
  const readDecisions = new Set<number>();
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
  // Cancellation semantics on a SERIAL server (round-2 finding 2, stated
  // rather than pretended): every request completes before the next line
  // is read, so no cancellation can arrive while its target is genuinely
  // in flight — and the revision permits ignoring cancellations for
  // completed requests. The registry exists so any future asynchronous
  // tool inherits correct suppression, and so a pre-cancelled FUTURE id
  // can never be blacklisted (the in-flight check).
  const cancelled = new Set<string>();
  const inFlight = new Set<string>();
  // Legacy lifecycle state (review finding 2): initialize must come first
  // in the handshake era; the modern era is stateless by design.
  let initializeSeen = false;
  let legacyReady = false;
  // Stdio pins ONE era per connection (round-2 finding 2): the first
  // era-classified request decides, and the other era's metadata refuses.
  let pinnedEra: "modern" | "legacy" | null = null;

  const error = (id: Json, code: number, message: string): void =>
    io.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));

  const respond = (id: Json, era: "modern" | "legacy", result: Record<string, Json>, cacheable: boolean): void => {
    if (id !== null && cancelled.has(JSON.stringify(id))) return; // suppressed entirely
    const complete: Record<string, Json> =
      era === "modern"
        ? { ...result, resultType: "complete", ...(cacheable ? { ttlMs: 0, cacheScope: "private" } : {}) }
        : result;
    io.write(JSON.stringify({ jsonrpc: "2.0", id, result: complete }));
  };

  const toolsPayload = (): Json => ({
    // No outputSchema: MCP output schemas describe structuredContent, and
    // these tools return text content only (round-2 finding 1).
    tools: TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  });

  const callTool = (id: Json, era: "modern" | "legacy", params: Record<string, unknown>): void => {
    // ONE snapshot per call (review finding 3): the version check, the
    // credential re-read, and every data read share a transaction, so a
    // concurrent migration cannot slip between them; filing's own
    // BEGIN IMMEDIATE reenters this one. A moved schema refuses in words
    // and the server exits clean.
    store.transact(() => {
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
    // Only an ABSENT `arguments` defaults to empty (round-3 finding 2): an
    // explicit null is not the optional-object shape MCP defines.
    const rawArgs = params["arguments"] === undefined ? {} : params["arguments"];
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      // The root of `arguments` is an object BEFORE any schema applies
      // (round-2 finding 2): 42 or false never passes an empty schema.
      error(id, -32602, "arguments must be an object");
      return;
    }
    const args = rawArgs as Record<string, unknown>;
    const invalid = invalidArgs(tool.inputSchema, args);
    if (invalid !== null) {
      error(id, -32602, invalid);
      return;
    }
    const answered = tool.handle({ store, who: session.who, token, enrolled, now: clock(), readDecisions }, args);
    if (!answered.ok) {
      respond(id, era, { content: [{ type: "text", text: answered.message }], isError: true }, false);
      return;
    }
    respond(id, era, { content: [{ type: "text", text: JSON.stringify(answered.body) }] }, false);
    });
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
    if (request["jsonrpc"] !== "2.0") {
      error(null, -32600, 'jsonrpc must be "2.0"');
      return;
    }
    // A notification is the message that carries NO id — the method name
    // never decides (round-3 finding 3): notifications/initialized WITH an
    // id is a malformed message, not a quiet notification. MCP RequestId is
    // a string or an INTEGER (round-2 finding 2): floats, null, and object
    // shapes refuse wherever an id appears.
    const hasId = "id" in request;
    const rawId = request["id"];
    if (hasId && (rawId === null || (typeof rawId !== "string" && !(typeof rawId === "number" && Number.isInteger(rawId))))) {
      error(null, -32600, "id must be a string or an integer");
      return;
    }
    const method = typeof request["method"] === "string" ? request["method"] : "";
    if (method.startsWith("notifications/")) {
      if (hasId) {
        error(rawId as Json, -32600, "a notification carries no id");
        return;
      }
    } else if (!hasId) {
      error(null, -32600, "a request carries an id — a string or an integer");
      return;
    }
    const id = (rawId ?? null) as Json;
    const params = (request["params"] ?? {}) as Record<string, unknown>;
    const meta = (params["_meta"] ?? {}) as Record<string, unknown>;

    // Every method — lifecycle included — refuses on a moved schema
    // (review finding 3): a server that answers discover from one world
    // and tools from another is lying to somebody.
    if (!store.schemaCurrent()) {
      error(id, -32000, "the database schema moved underneath this server — restart it");
      io.exit(0);
      return;
    }

    if (method === "notifications/cancelled") {
      // Cancellation touches IN-FLIGHT work only (review finding 2): an id
      // never seen, already answered, or yet to arrive is not cancellable —
      // pre-cancelling the future would let a peer suppress request ids
      // forever.
      const target = params["requestId"];
      if (target !== undefined && inFlight.has(JSON.stringify(target as Json))) {
        cancelled.add(JSON.stringify(target as Json));
      }
      return; // a notification — no reply of any kind
    }
    if (method === "notifications/initialized") {
      // Only a handshake that actually happened completes (round-2 f2).
      if (initializeSeen) legacyReady = true;
      return;
    }
    if (method.startsWith("notifications/")) return; // unknown notification: silence, never an error

    // An unsupported protocol version refuses -32022 with the revision's
    // OWN shape for EVERY request — server/discover included (round-3
    // finding 4): the ask precedes any per-method branch.
    const declared = typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : null;
    if (declared !== null && declared !== MODERN && declared !== LEGACY) {
      io.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: UNSUPPORTED_VERSION,
            message: `unsupported protocol version \`${declared}\``,
            data: { supported: [MODERN, LEGACY], requested: declared },
          },
        }),
      );
      return;
    }
    // ClientCapabilities is an OBJECT shape (round-3 finding 5): an array
    // is not a capabilities declaration.
    const capabilitiesShape = (value: unknown): boolean =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    if (method === "initialize") {
      if (pinnedEra === "modern") {
        error(id, -32600, "this connection speaks the modern era — initialize belongs to the handshake era");
        return;
      }
      pinnedEra = "legacy";
      initializeSeen = true;
      // The handshake era can only negotiate ITSELF: an unsupported ask is
      // answered WITH the legacy version, never the modern one.
      respond(id, "legacy", {
        protocolVersion: LEGACY,
        capabilities: { tools: {} },
        serverInfo: { name: "standing-orders", version: "0.4.0" },
      }, false);
      return;
    }
    if (method === "server/discover") {
      if (pinnedEra === "legacy") {
        error(id, -32600, "this connection speaks the handshake era — server/discover belongs to the modern one");
        return;
      }
      if (declared !== MODERN || !capabilitiesShape(meta[META_CAPABILITIES])) {
        // The modern era's requests carry BOTH namespaced keys (round-2
        // finding 1) — a bare discover is not a modern request.
        error(id, -32600, `server/discover requires _meta["${META_VERSION}"] = "${MODERN}" and _meta["${META_CAPABILITIES}"]`);
        return;
      }
      pinnedEra = "modern";
      respond(id, "modern", {
        protocolVersion: MODERN,
        supportedVersions: [MODERN, LEGACY],
        capabilities: { tools: {} },
        _meta: { [META_SERVER]: { name: "standing-orders", version: "0.4.0" } },
        ...(toolsPayload() as Record<string, Json>),
      }, true);
      return;
    }

    // Era classification precedes every remaining method — ping and unknown
    // methods included (round-3 finding 1): a refused modern ping still pins
    // the modern era, and a cross-era unknown method refuses on the pin
    // instead of slipping past it.
    const era: "modern" | "legacy" = declared === MODERN ? "modern" : "legacy";
    if (era === "modern" && !capabilitiesShape(meta[META_CAPABILITIES])) {
      error(id, -32600, `a ${MODERN} request carries _meta["${META_CAPABILITIES}"]`);
      return;
    }
    if (pinnedEra !== null && era !== pinnedEra) {
      error(id, -32600, `this connection is pinned to the ${pinnedEra} era`);
      return;
    }
    pinnedEra = era;

    if (method === "ping") {
      // ping left the protocol in 2026-07-28 — only the handshake era has it.
      if (era === "modern") {
        error(id, -32601, "ping is not part of the modern revision");
        return;
      }
      respond(id, "legacy", {}, false);
      return;
    }

    // The handshake era operates only after its lifecycle completed; the
    // modern era is stateless and needs no handshake.
    if (era === "legacy" && !legacyReady && (method === "tools/list" || method === "tools/call")) {
      error(id, -32002, "not initialized — the handshake era requires initialize and notifications/initialized first");
      return;
    }
    if (method === "tools/list") {
      respond(id, era, toolsPayload() as Record<string, Json>, true);
      return;
    }
    if (method === "tools/call") {
      const key = JSON.stringify(id);
      inFlight.add(key);
      try {
        callTool(id, era, params);
      } finally {
        inFlight.delete(key);
        cancelled.delete(key);
      }
      return;
    }
    error(id, -32601, `unknown method \`${method}\``);
  });

  io.onEof(() => io.exit(0));
  return { ok: true };
}
