/**
 * v103: the action ledger as a hash chain. Every entry is sealed, in id
 * order, with a fingerprint of its own fields and the previous entry's
 * fingerprint; changing, removing or slipping in an entry breaks the chain
 * from that point, and `verifyLedgerChain` names the first place it breaks.
 *
 * The ledger itself is append-only (its triggers refuse UPDATE and DELETE);
 * the chain is what still shows it when someone with the database file drops
 * those triggers. It has no secret key: someone who can rewrite the file can
 * also drop seals and let the next pass reseal, so what proves history is a
 * checkpoint's head copied off the machine (and, from sprint 6, streamed to
 * the customer's log system), plus a running console noticing that a head it
 * already walked to has changed.
 *
 * Entries are sealed shortly after they're written (by the worker, and
 * before anything reads, verifies or exports the chain), so the triggers
 * that write the ledger stay plain SQL any build can run.
 */
import { createHash } from "node:crypto";
import type { Database } from "./store.js";

export const LEDGER_CHAIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_seal (
  id   INTEGER PRIMARY KEY,
  prev TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ledger_seal_no_update BEFORE UPDATE ON ledger_seal
BEGIN SELECT RAISE(ABORT, 'the ledger chain is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_seal_no_delete BEFORE DELETE ON ledger_seal
BEGIN SELECT RAISE(ABORT, 'the ledger chain is append-only'); END;
CREATE TABLE IF NOT EXISTS ledger_checkpoint (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  through INTEGER NOT NULL,
  hash    TEXT NOT NULL,
  at      TEXT NOT NULL,
  by      TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ledger_checkpoint_no_update BEFORE UPDATE ON ledger_checkpoint
BEGIN SELECT RAISE(ABORT, 'ledger checkpoints are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_checkpoint_no_delete BEFORE DELETE ON ledger_checkpoint
BEGIN SELECT RAISE(ABORT, 'ledger checkpoints are append-only'); END;
`;

/** Where the chain starts: the previous fingerprint of the first entry. */
export const LEDGER_GENESIS = createHash("sha256").update("standing-orders/action-ledger/v103", "utf8").digest("hex");

const FIELDS = ["id", "at", "actor", "repo", "task_id", "run_id", "action", "outcome", "source", "detail"] as const;
/** A whole number column as JavaScript can hold it: one past 2^53 (only a hand edit puts one there) reads as its text,
 * which `rowProblem` names, instead of failing the read. */
export const safeWhole = (column: string, as = column) =>
  `CASE WHEN typeof(${column}) = 'integer' AND ${column} NOT BETWEEN -9007199254740991 AND 9007199254740991 THEN CAST(${column} AS TEXT) ELSE ${column} END AS ${as}`;
/** The fields a seal covers, read safely. */
const SEALED = FIELDS.map(name => name === "id" || name === "run_id" ? safeWhole(name) : name).join(", ");

/** An entry's fingerprint: the previous one and the entry's own fields, in a fixed order. */
export function entryHash(prev: string, row: Record<string, unknown>): string {
  const fields = FIELDS.map(name => { const value = row[name]; return value === undefined ? null : typeof value === "bigint" ? Number(value) : value; });
  return createHash("sha256").update(`${prev}\n${JSON.stringify(fields)}`, "utf8").digest("hex");
}

/** The largest entry number a seal can name (JavaScript's safe integers); anything outside 1..LARGEST was put there by hand. */
const LARGEST = Number.MAX_SAFE_INTEGER;
export const IN_RANGE = `BETWEEN 1 AND ${LARGEST}`;
/** Outside it, written so SQLite finds such rows by key rather than reading every row. */
const OUTSIDE = (column: string) => `${column} < 1 OR ${column} > ${LARGEST}`;

/** Why a row can't be an entry the ledger wrote: each field is exactly the kind of value its writers store. */
export function rowProblem(row: Record<string, unknown>): string | null {
  const whole = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value);
  const text = (value: unknown) => typeof value === "string";
  if (!whole(row["id"])) return "a number the ledger never writes";
  if (row["run_id"] !== null && !whole(row["run_id"])) return "a run number the ledger never writes";
  for (const name of ["at", "actor", "action", "outcome", "source"] as const) if (!text(row[name])) return `a ${name} the ledger never writes`;
  for (const name of ["repo", "task_id", "detail"] as const) if (row[name] !== null && !text(row[name])) return `a ${name} the ledger never writes`;
  return null;
}

/** Seal every entry written since the last seal, in id order. Returns how many were sealed. Call inside a write transaction. */
export function sealLedger(db: Database): number {
  const last = db.prepare(`SELECT id, hash FROM ledger_seal WHERE id ${IN_RANGE} ORDER BY id DESC LIMIT 1`).get();
  let prevId = last === undefined ? 0 : Number(last["id"]);
  let prev = last === undefined ? LEDGER_GENESIS : String(last["hash"]);
  let sealed = 0;
  const insert = db.prepare("INSERT INTO ledger_seal (id, prev, hash) VALUES (?, ?, ?)");
  const next = db.prepare(`SELECT ${SEALED} FROM action_ledger WHERE id > ? AND id <= ${LARGEST} ORDER BY id LIMIT 1000`);
  for (;;) {
    const rows = next.all(prevId);
    if (rows.length === 0) return sealed;
    for (const row of rows) {
      const hash = entryHash(prev, row);
      insert.run(Number(row["id"]), prev, hash);
      prev = hash;
      prevId = Number(row["id"]);
      sealed++;
    }
  }
}

export type LedgerChainReport = {
  ok: boolean;
  /** Entries checked, and the last sealed entry's id and fingerprint (the head). */
  entries: number;
  through: number | null;
  head: string;
  /** Entries written after the last seal (sealed on the next pass; not yet part of the proof). */
  unsealed: number;
  checkpoints: number;
  /** The first place the chain breaks, in words. */
  problem: { id: number | null; what: string } | null;
  /** When the whole chain was last walked from its first entry (later entries were checked as they were added). */
  checkedAt: string | null;
};

const PAGE = 1000;
/** Rows of a keyset query (`WHERE id > ? ... ORDER BY id LIMIT n`), a page at a time. */
function* pages(db: Database, sql: string, from: number): Generator<Record<string, unknown>, void, undefined> {
  const statement = db.prepare(sql);
  let after = from;
  for (;;) {
    const page = statement.all(after);
    yield* page;
    if (page.length < PAGE) return;
    after = Number(page[page.length - 1]!["id"]);
  }
}

/** Where a walk may start instead of the first entry: a head this process walked to before. */
export type VerifiedHead = { through: number; head: string; entries: number };

/** Walk the chain: every entry sealed, every seal an entry, each fingerprint right and linked to the one before,
 * and every checkpoint still matching. With `from`, the walk starts at a head verified earlier, after checking that
 * the head is still there (a chain rebuilt since doesn't match it). Reads only; call inside one read transaction. */
export function verifyLedgerChain(db: Database, from?: VerifiedHead, checkedAt: string | null = null): LedgerChainReport {
  let prev = from?.head ?? LEDGER_GENESIS, entries = from?.entries ?? 0, through: number | null = from?.through ?? null, kept = 0;
  const report = (problem: LedgerChainReport["problem"], unsealed = 0): LedgerChainReport =>
    ({ ok: problem === null, entries, through, head: prev, unsealed, checkpoints: kept, problem, checkedAt });
  // Entries, seals and checkpoints are numbered from 1 up to what a seal can name; anything outside was put there by hand.
  const outside = db.prepare(`SELECT CAST(id AS TEXT) AS id FROM action_ledger WHERE ${OUTSIDE("id")} LIMIT 1`).get();
  if (outside !== undefined) return report({ id: null, what: `entry #${String(outside["id"])} was added outside the sealed history` });
  const strayed = db.prepare(`SELECT CAST(id AS TEXT) AS id FROM ledger_seal WHERE ${OUTSIDE("id")} LIMIT 1`).get();
  if (strayed !== undefined) return report({ id: null, what: `a seal for entry #${String(strayed["id"])} was added outside the chain` });
  const astray = db.prepare(`SELECT CAST(through AS TEXT) AS through FROM ledger_checkpoint WHERE typeof(through) <> 'integer' OR ${OUTSIDE("through")} LIMIT 1`).get();
  if (astray !== undefined) return report({ id: null, what: `a checkpoint names entry #${String(astray["through"])}, outside the chain` });
  const checkpoints = db.prepare("SELECT through, hash FROM ledger_checkpoint ORDER BY id").all()
    .map(one => ({ through: Number(one["through"]), hash: String(one["hash"]) }));
  kept = checkpoints.length;
  if (from !== undefined) {
    const still = db.prepare("SELECT hash FROM ledger_seal WHERE id = ?").get(from.through);
    if (still === undefined || String(still["hash"]) !== from.head) return report({ id: from.through, what: `the chain was rewritten since it was last checked (entry #${from.through} changed)` });
  }
  const rows = pages(db, `SELECT ${SEALED} FROM action_ledger WHERE id > ? AND id <= ${LARGEST} ORDER BY id LIMIT ${PAGE}`, from?.through ?? 0);
  const seals = pages(db, `SELECT id, prev, hash FROM ledger_seal WHERE id > ? AND id <= ${LARGEST} ORDER BY id LIMIT ${PAGE}`, from?.through ?? 0);
  const wanted = new Set(checkpoints.map(one => one.through));
  const reached = new Map<number, string>();
  let row = rows.next();
  for (let next = seals.next(); !next.done; next = seals.next()) {
    const seal = next.value;
    const id = Number(seal["id"]);
    const entry = row.done ? undefined : row.value;
    if (entry === undefined || Number(entry["id"]) > id) return report({ id, what: `entry #${id} was removed after it was sealed` });
    if (Number(entry["id"]) < id) return report({ id: Number(entry["id"]), what: `entry #${Number(entry["id"])} was added inside the sealed history` });
    const odd = rowProblem(entry);
    if (odd !== null) return report({ id, what: `entry #${id} holds ${odd}` });
    if (String(seal["prev"]) !== prev) return report({ id, what: `entry #${id} doesn't follow the entry before it` });
    const hash = entryHash(prev, entry);
    if (hash !== String(seal["hash"])) return report({ id, what: `entry #${id} was changed after it was sealed` });
    prev = hash;
    through = id;
    if (wanted.has(id)) reached.set(id, hash);
    entries++;
    row = rows.next();
  }
  // Every checkpoint row, each on its own: a later row for the same entry can't cover for an earlier one.
  const sealedAt = db.prepare("SELECT hash FROM ledger_seal WHERE id = ?");
  for (const checkpoint of checkpoints) {
    const walked = reached.get(checkpoint.through) ?? (from !== undefined && checkpoint.through <= from.through ? sealedAt.get(checkpoint.through)?.["hash"] : undefined);
    if (walked !== checkpoint.hash) return report({ id: checkpoint.through, what: `the chain no longer matches the checkpoint at entry #${checkpoint.through}` });
  }
  let unsealed = 0;
  for (; !row.done; row = rows.next()) unsealed++;
  return report(null, unsealed);
}

/** Whether the chain still ends at a head someone copied off the machine (`<through>:<hash>`). */
export function matchesOutsideCheckpoint(db: Database, checkpoint: string): { ok: boolean; what: string } {
  const match = /^(\d+):([a-f0-9]{64})$/.exec(checkpoint.trim());
  if (match === null) return { ok: false, what: "A checkpoint looks like 1234:<64 hex characters>." };
  if (!Number.isSafeInteger(Number(match[1]))) return { ok: false, what: "A checkpoint looks like 1234:<64 hex characters>." };
  const seal = db.prepare("SELECT hash FROM ledger_seal WHERE id = ?").get(Number(match[1]));
  if (seal === undefined) return { ok: false, what: `The chain has no sealed entry #${match[1]}.` };
  return String(seal["hash"]) === match[2]
    ? { ok: true, what: `The chain still matches the checkpoint at entry #${match[1]}.` }
    : { ok: false, what: `The chain does NOT match the checkpoint at entry #${match[1]}: history up to it was rewritten.` };
}
