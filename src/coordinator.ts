/**
 * The coordinator principal (MCP gateway spec v6; DESIGN.md §9b).
 *
 * A coordinator is the ONE credential the MCP surface accepts: minted by
 * an operator password ceremony, hashed at rest, repo-scoped at the mint,
 * rate-limited, revocable — and able to do exactly one thing: file a
 * proposal through the canonical door. What it files is an ordinary
 * UNAPPROVED task; admission is the operator's existing scope ceremony,
 * and the quarantine (sealScopeApproval's mode-kind refusal + the claim
 * primitive's exclusion) keeps every pre-seal road shut.
 *
 * The brand: `VerifiedCoordinator` is disjoint from the operator's
 * `VerifiedAuthor` by construction, and its maker is module-private —
 * the exported-cast mistake is named in the spec and not repeated here.
 * Steering and every operator-speech surface cannot accept this type.
 */

import { createHash, randomBytes } from "node:crypto";
import { canonicalRepos } from "./runner.js";
import { fileTaskProposal } from "./proposal.js";
import type { Store } from "./store.js";

declare const verifiedCoordinatorBrand: unique symbol;
export type VerifiedCoordinator = {
  readonly [verifiedCoordinatorBrand]: true;
  readonly cid: string;
  readonly name: string;
  readonly repos: readonly string[];
  readonly perHour: number;
};

/** Module-private: the ONLY maker, reachable only through the token
 * verification below. Never exported, never a cast at a call site. */
function verified(row: { cid: string; name: string; repos: string[]; perHour: number }): VerifiedCoordinator {
  return row as unknown as VerifiedCoordinator;
}

const NAME = /^[a-z0-9-]{1,32}$/;
const CID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEY = /^[\x21-\x7e]{8,64}$/;

function hashSecret(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintCid(): string {
  const bytes = randomBytes(12);
  let cid = "";
  for (const b of bytes) cid += CID_ALPHABET[b % CID_ALPHABET.length];
  return cid;
}

export type MintResult =
  | { ok: true; cid: string; token: string; repos: string[] }
  | { ok: false; reason: "bad-name" | "name-taken" | "bad-rate" | "no-repos" };

export function mintCoordinator(
  store: Store,
  input: {
    name: string;
    repos: readonly string[];
    perHour?: number;
    by: string;
    now: Date;
    /** Injected in tests. */
    newToken?: () => string;
    newCid?: () => string;
  },
): MintResult {
  const name = input.name.normalize("NFC");
  if (!NAME.test(name)) return { ok: false, reason: "bad-name" };
  const perHour = input.perHour ?? 6;
  if (!Number.isInteger(perHour) || perHour < 1 || perHour > 60) return { ok: false, reason: "bad-rate" };
  if (input.repos.length === 0) return { ok: false, reason: "no-repos" };
  const repos = canonicalRepos(input.repos);
  const token = (input.newToken ?? (() => randomBytes(32).toString("base64url")))();

  return store.transact(() => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cid = (input.newCid ?? mintCid)();
      try {
        store.handle
          .prepare(
            `INSERT INTO coordinator_credential (cid, name, credential_hash, repos, per_hour, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(cid, name, hashSecret(token), JSON.stringify(repos), perHour, input.by, input.now.toISOString());
        return { ok: true as const, cid, token, repos };
      } catch (error) {
        const said = String(error);
        // The live-name unique index answers "taken"; a cid collision
        // (astronomically rare) retries with a fresh one.
        if (said.includes("coordinator_live_name")) return { ok: false as const, reason: "name-taken" as const };
        if (!said.includes("PRIMARY KEY") && !said.includes("UNIQUE")) throw error;
      }
    }
    return { ok: false as const, reason: "name-taken" as const };
  });
}

export type CoordinatorAuth =
  | { ok: true; who: VerifiedCoordinator }
  | { ok: false; reason: "unknown" | "revoked" };

/** The token IS the identity — no name travels with it. Verified against
 * the stored hash; the caller re-runs this INSIDE any mutating
 * transaction (the startup check is a courtesy; the txn check is law). */
export function authenticateCoordinator(store: Store, token: string): CoordinatorAuth {
  const row = store.handle
    .prepare("SELECT * FROM coordinator_credential WHERE credential_hash = ?")
    .get(hashSecret(token));
  if (row === undefined) return { ok: false, reason: "unknown" };
  if (row["revoked_at"] !== null) return { ok: false, reason: "revoked" };
  return {
    ok: true,
    who: verified({
      cid: String(row["cid"]),
      name: String(row["name"]),
      repos: JSON.parse(String(row["repos"])) as string[],
      perHour: Number(row["per_hour"]),
    }),
  };
}

export function revokeCoordinator(
  store: Store,
  cid: string,
  by: string,
  now: Date,
): { ok: true } | { ok: false; reason: "unknown" | "already-revoked" } {
  return store.transact(() => {
    const row = store.handle.prepare("SELECT revoked_at FROM coordinator_credential WHERE cid = ?").get(cid);
    if (row === undefined) return { ok: false as const, reason: "unknown" as const };
    if (row["revoked_at"] !== null) return { ok: false as const, reason: "already-revoked" as const };
    store.handle
      .prepare("UPDATE coordinator_credential SET revoked_at = ? WHERE cid = ?")
      .run(now.toISOString(), cid);
    // The revocation event rides the SAME transaction as the state change.
    store.handle
      .prepare("INSERT INTO coordinator_event (cid, kind, detail, created_at) VALUES (?, 'revoked', ?, ?)")
      .run(cid, `by ${by}`, now.toISOString());
    return { ok: true as const };
  });
}

export type CoordinatorRow = {
  cid: string;
  name: string;
  repos: string[];
  perHour: number;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  lastFiledAt: string | null;
};

export function listCoordinators(store: Store): CoordinatorRow[] {
  return store.handle
    .prepare(
      `SELECT c.*, (SELECT MAX(e.created_at) FROM coordinator_event e WHERE e.cid = c.cid AND e.kind = 'filed') AS last_filed
         FROM coordinator_credential c ORDER BY c.created_at, c.cid`,
    )
    .all()
    .map(row => ({
      cid: String(row["cid"]),
      name: String(row["name"]),
      repos: JSON.parse(String(row["repos"])) as string[],
      perHour: Number(row["per_hour"]),
      createdBy: String(row["created_by"]),
      createdAt: String(row["created_at"]),
      revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
      lastFiledAt: row["last_filed"] === null ? null : String(row["last_filed"]),
    }));
}

/** Outstanding = filed by this cid, scope UNSEALED (missing seal or a
 * stale digest both count), task not done/cancelled — `failed` COUNTS:
 * dead unsealed filings pressure cleanup, not silence. */
const OUTSTANDING_SQL = `
  SELECT COUNT(*) AS n FROM task_ref
    JOIN task ON task.id = task_ref.external_id
    LEFT JOIN task_scope ON task_scope.task_id = task_ref.external_id
   WHERE task_ref.coordinator_cid IS NOT NULL
     AND task.state NOT IN ('done','cancelled')
     AND (task_scope.task_id IS NULL
          OR task_scope.approved_at IS NULL
          OR task_scope.approved_digest IS NOT task_scope.digest)`;

export const PER_CID_OUTSTANDING = 10;
export const GLOBAL_OUTSTANDING = 50;

export type FileOutcome =
  | { ok: true; id: string; replayed: boolean }
  | {
      ok: false;
      reason:
        | "unauthenticated"
        | "revoked"
        | "bad-key"
        | "idempotency-conflict"
        | "rate-limited"
        | "outstanding-cap"
        | "global-cap"
        | string;
      message: string;
    };

/**
 * The one write the MCP surface owns, as ONE transaction: authenticate →
 * revocation re-check → replay lookup → rate window → caps → the
 * canonical door → the cid stamp → idempotency + event rows. The rate
 * window reads the event ledger (filings are events, so the window and
 * the audit cannot disagree), and a replay charges no slot.
 */
export function fileCoordinatorProposal(
  store: Store,
  token: string,
  input: { repo: string; title: string; intent?: string; idempotencyKey: string },
  now: Date,
): FileOutcome {
  if (!KEY.test(input.idempotencyKey)) {
    return { ok: false, reason: "bad-key", message: "idempotency_key is 8–64 printable ASCII characters" };
  }
  const digest = createHash("sha256")
    .update(JSON.stringify({ repo: input.repo, title: input.title, intent: input.intent ?? null }), "utf8")
    .digest("hex");

  return store.transact(() => {
    // The law lives here: the token re-verifies INSIDE the transaction.
    const auth = authenticateCoordinator(store, token);
    if (!auth.ok) {
      return auth.reason === "revoked"
        ? { ok: false as const, reason: "revoked" as const, message: "this credential was revoked — ask the operator for a new one" }
        : { ok: false as const, reason: "unauthenticated" as const, message: "no live coordinator credential matches this token" };
    }
    const { who } = auth;

    const replay = store.handle
      .prepare("SELECT request_digest, task_id FROM mcp_idempotency WHERE cid = ? AND key = ?")
      .get(who.cid, input.idempotencyKey);
    if (replay !== undefined) {
      if (String(replay["request_digest"]) !== digest) {
        return {
          ok: false as const,
          reason: "idempotency-conflict" as const,
          message: "this idempotency_key was already used for a DIFFERENT request — mint a new key",
        };
      }
      return { ok: true as const, id: String(replay["task_id"]), replayed: true };
    }

    const windowStart = new Date(now.getTime() - 3_600_000).toISOString();
    const filedRow = store.handle
      .prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM coordinator_event WHERE cid = ? AND kind = 'filed' AND created_at > ?")
      .get(who.cid, windowStart);
    const filed = Number(filedRow?.["n"] ?? 0);
    if (filed >= who.perHour) {
      const oldest = String(filedRow?.["oldest"] ?? now.toISOString());
      const slotMs = new Date(oldest).getTime() + 3_600_000 - now.getTime();
      const minutes = Math.max(1, Math.ceil(slotMs / 60_000));
      return {
        ok: false as const,
        reason: "rate-limited" as const,
        message: `rate-limited: ${filed} filed in the last hour — next slot in ${minutes}m`,
      };
    }

    const mine = Number(store.handle.prepare(`${OUTSTANDING_SQL} AND task_ref.coordinator_cid = ?`).get(who.cid)?.["n"] ?? 0);
    if (mine >= PER_CID_OUTSTANDING) {
      return {
        ok: false as const,
        reason: "outstanding-cap" as const,
        message: `${mine} of your filings are still waiting on approval or dismissal — the operator resolves them before more file`,
      };
    }
    const everyone = Number(store.handle.prepare(OUTSTANDING_SQL).get()?.["n"] ?? 0);
    if (everyone >= GLOBAL_OUTSTANDING) {
      return {
        ok: false as const,
        reason: "global-cap" as const,
        message: `${everyone} coordinator filings are unresolved across the installation — the backlog resolves before more file`,
      };
    }

    // The canonical door: the credential's repo allowlist IS the ceiling,
    // and (since the empty-repo fix) a repo must be named inside it.
    const made = fileTaskProposal(
      store,
      {
        title: input.title,
        repo: input.repo,
        ...(input.intent === undefined ? {} : { goal: input.intent }),
        filedVia: `mcp:${who.name}`,
        admittedRepos: who.repos,
      },
      now,
    );
    if (!made.ok) return { ok: false as const, reason: made.reason, message: made.message };

    // The branded door's OWN write: the authoritative linkage column. No
    // other filer sets it; provenance is a join, never string parsing.
    store.handle
      .prepare("UPDATE task_ref SET coordinator_cid = ? WHERE backend = 'built-in' AND external_id = ? AND coordinator_cid IS NULL")
      .run(who.cid, made.id);
    store.handle
      .prepare("INSERT INTO mcp_idempotency (cid, key, request_digest, task_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(who.cid, input.idempotencyKey, digest, made.id, now.toISOString());
    store.handle
      .prepare("INSERT INTO coordinator_event (cid, kind, task_id, created_at) VALUES (?, 'filed', ?, ?)")
      .run(who.cid, made.id, now.toISOString());
    return { ok: true as const, id: made.id, replayed: false };
  });
}
