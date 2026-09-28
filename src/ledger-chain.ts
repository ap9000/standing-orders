/**
 * v103: the action ledger as a hash chain. Every entry is sealed, in id
 * order, with a fingerprint of its own fields and the previous entry's
 * fingerprint; changing, removing or slipping in an entry breaks the chain
 * from that point, and `verifyLedgerChain` names the first place it breaks.
 *
 * The ledger itself is append-only (its triggers refuse UPDATE and DELETE);
 * the chain is what still proves it when someone with the database file
 * drops those triggers. Someone who can rewrite the file could also rebuild
 * the whole chain, which is what checkpoints are for: a checkpoint's head
 * copied off the machine (and, from sprint 6, streamed to the customer's
 * log system) pins everything up to it.
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

/** An entry's fingerprint: the previous one and the entry's own fields, in a fixed order. */
export function entryHash(prev: string, row: Record<string, unknown>): string {
  const fields = FIELDS.map(name => { const value = row[name]; return value === undefined ? null : typeof value === "bigint" ? Number(value) : value; });
  return createHash("sha256").update(`${prev}\n${JSON.stringify(fields)}`, "utf8").digest("hex");
}

/** Seal every entry written since the last seal, in id order. Returns how many were sealed. Call inside a write transaction. */
export function sealLedger(db: Database): number {
  const last = db.prepare("SELECT id, hash FROM ledger_seal ORDER BY id DESC LIMIT 1").get();
  let prevId = last === undefined ? 0 : Number(last["id"]);
  let prev = last === undefined ? LEDGER_GENESIS : String(last["hash"]);
  let sealed = 0;
  const insert = db.prepare("INSERT INTO ledger_seal (id, prev, hash) VALUES (?, ?, ?)");
  for (;;) {
    const rows = db.prepare(`SELECT ${FIELDS.join(", ")} FROM action_ledger WHERE id > ? ORDER BY id LIMIT 1000`).all(prevId);
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
};

const PAGE = 1000;
/** Rows of a keyset query (`WHERE id > ? ORDER BY id LIMIT n`), a page at a time. */
function* pages(db: Database, sql: string): Generator<Record<string, unknown>, void, undefined> {
  const statement = db.prepare(sql);
  let after = 0;
  for (;;) {
    const page = statement.all(after);
    yield* page;
    if (page.length < PAGE) return;
    after = Number(page[page.length - 1]!["id"]);
  }
}

/** Walk the whole chain: every entry sealed, every seal an entry, each fingerprint right and linked to the
 * one before, and every checkpoint still matching. Reads only. */
export function verifyLedgerChain(db: Database): LedgerChainReport {
  const checkpoints = db.prepare("SELECT through, hash FROM ledger_checkpoint ORDER BY id").all();
  const wanted = new Map<number, string>(checkpoints.map(one => [Number(one["through"]), String(one["hash"])]));
  // Walked in step, a page at a time, so a long ledger never sits in memory whole.
  const rows = pages(db, `SELECT ${FIELDS.join(", ")} FROM action_ledger WHERE id > ? ORDER BY id LIMIT ${PAGE}`);
  const seals = pages(db, `SELECT id, prev, hash FROM ledger_seal WHERE id > ? ORDER BY id LIMIT ${PAGE}`);
  let prev = LEDGER_GENESIS, entries = 0, through: number | null = null;
  const reached = new Map<number, string>();
  const report = (problem: LedgerChainReport["problem"], unsealed = 0): LedgerChainReport =>
    ({ ok: problem === null, entries, through, head: prev, unsealed, checkpoints: checkpoints.length, problem });
  // Entries are numbered from 1; one numbered below that was put there by hand, outside what sealing reaches.
  const below = db.prepare("SELECT MIN(id) AS id FROM action_ledger WHERE id <= 0").get();
  if (below !== undefined && below["id"] !== null) return report({ id: Number(below["id"]), what: `entry #${Number(below["id"])} was added outside the sealed history` });
  let row = rows.next();
  for (let next = seals.next(); !next.done; next = seals.next()) {
    const seal = next.value;
    const id = Number(seal["id"]);
    const entry = row.done ? undefined : row.value;
    if (entry === undefined || Number(entry["id"]) > id) return report({ id, what: `entry #${id} was removed after it was sealed` });
    if (Number(entry["id"]) < id) return report({ id: Number(entry["id"]), what: `entry #${Number(entry["id"])} was added inside the sealed history` });
    if (String(seal["prev"]) !== prev) return report({ id, what: `entry #${id} doesn't follow the entry before it` });
    const hash = entryHash(prev, entry);
    if (hash !== String(seal["hash"])) return report({ id, what: `entry #${id} was changed after it was sealed` });
    prev = hash;
    through = id;
    if (wanted.has(id)) reached.set(id, hash);
    entries++;
    row = rows.next();
  }
  for (const [at, hash] of wanted) {
    if (reached.get(at) !== hash) return report({ id: at, what: `the chain no longer matches the checkpoint at entry #${at}` });
  }
  let unsealed = 0;
  for (; !row.done; row = rows.next()) unsealed++;
  return report(null, unsealed);
}

/** Whether the chain still ends at a head someone copied off the machine (`<through>:<hash>`). */
export function matchesOutsideCheckpoint(db: Database, checkpoint: string): { ok: boolean; what: string } {
  const match = /^(\d+):([a-f0-9]{64})$/.exec(checkpoint.trim());
  if (match === null) return { ok: false, what: "A checkpoint looks like 1234:<64 hex characters>." };
  const seal = db.prepare("SELECT hash FROM ledger_seal WHERE id = ?").get(Number(match[1]));
  if (seal === undefined) return { ok: false, what: `The chain has no sealed entry #${match[1]}.` };
  return String(seal["hash"]) === match[2]
    ? { ok: true, what: `The chain still matches the checkpoint at entry #${match[1]}.` }
    : { ok: false, what: `The chain does NOT match the checkpoint at entry #${match[1]}: history up to it was rewritten.` };
}
