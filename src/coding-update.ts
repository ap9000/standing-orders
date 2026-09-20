import { createHash } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteRuntime } from './sqlite-runtime.js';
import type { Database } from './store.js';

const gatePrefix = 'so_coding_update_';
const pausedMessage = 'Standing Orders is updating. Current work can finish; new coding work will resume after the update.';

export function codingCatalogPath(orders: Database): string | null {
  const main = orders.prepare('PRAGMA database_list').all().find(row => row['name'] === 'main')?.['file'];
  return typeof main === 'string' && main !== '' ? `${main}.coding.sqlite` : null;
}

export function codingCatalogExists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function connect(file: string, readOnly: boolean): DatabaseSync {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('The coding catalog is linked or not a regular database. No app was replaced.');
  const db = new (sqliteRuntime().DatabaseSync)(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=1000');
    for (const table of ['coding_owner', 'coding_session', 'coding_item', 'coding_request', 'coding_submission']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw Error('The coding catalog is incomplete. Preserve it and resolve its state before updating.');
    }
    if (!db.prepare('SELECT 1 FROM coding_owner WHERE singleton=1').get()) throw Error('The coding catalog has no process ownership record. Preserve it and resolve its state before updating.');
    return db;
  } catch (error) { db.close(); throw error; }
}

function withCatalog<T>(orders: Database, absent: T, readOnly: boolean, action: (db: DatabaseSync) => T): T {
  const file = codingCatalogPath(orders);
  // A legacy installation has no coding catalog. Never create one in the updater.
  if (file === null || !codingCatalogExists(file)) return absent;
  const db = connect(file, readOnly);
  try { return action(db); } finally { db.close(); }
}

const gateRows = (db: DatabaseSync) => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_coding_update_*' ORDER BY name").all();
function gateStatements(id: string): string[] {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid coding update identity.');
  const refusal = `SELECT RAISE(ABORT, '${pausedMessage} [${id}]');`;
  return [
    // Workspace saves are INSERT ... ON CONFLICT UPDATE, so existing-session
    // events, approvals and Stop must still be allowed to settle during drain.
    `CREATE TRIGGER ${gatePrefix}session BEFORE INSERT ON coding_session WHEN NOT EXISTS (SELECT 1 FROM coding_session WHERE id=NEW.id) BEGIN ${refusal} END`,
    `CREATE TRIGGER ${gatePrefix}submission BEFORE INSERT ON coding_submission BEGIN ${refusal} END`,
  ];
}

function changeGate(db: DatabaseSync, id: string, install: boolean): void {
  const wanted = gateStatements(id);
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = gateRows(db);
    if (rows.some(row => !wanted.includes(String(row['sql']))) || (rows.length > 0 && rows.length !== wanted.length)) throw Error('Another or unrecognized update owns coding admission. Its gate was preserved.');
    if (install && rows.length === 0) for (const statement of wanted) db.exec(statement);
    if (!install) for (const row of rows) db.exec(`DROP TRIGGER "${String(row['name'])}"`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function installCodingUpdateGate(orders: Database, id: string): void { withCatalog(orders, undefined, false, db => changeGate(db, id, true)); }
export function removeCodingUpdateGate(orders: Database, id: string): void { withCatalog(orders, undefined, false, db => changeGate(db, id, false)); }

export function activeCodingUpdateWork(orders: Database): { coding: number; codingDeliveries: number } {
  return withCatalog(orders, { coding: 0, codingDeliveries: 0 }, true, db => ({
    coding: Number(db.prepare("SELECT count(*) n FROM coding_session WHERE json_extract(document,'$.status') IN ('starting','working','needs-input','stopping','uncertain') OR json_extract(document,'$.turnId') IS NOT NULL").get()?.['n']),
    codingDeliveries: Number(db.prepare("SELECT count(*) n FROM coding_submission WHERE status IN ('preparing','pending','uncertain')").get()?.['n']),
  }));
}

/** An idle provider may remain loaded during drain. The normal server stop
 * must close it and establish native/tool exit before either app swap. */
export function assertCodingUpdateStopped(orders: Database): void {
  withCatalog(orders, undefined, true, db => {
    const owner = db.prepare('SELECT token,pid,native_pid,clean FROM coding_owner WHERE singleton=1').get();
    if (!owner || owner['clean'] !== 1 || owner['token'] !== '' || owner['pid'] !== 0 || owner['native_pid'] !== null) throw Error('The coding server has not verified agent and tool shutdown. No app was replaced.');
  });
}

function snapshot(db: DatabaseSync): string {
  const data: Record<string, unknown> = {};
  // Include every catalog table, including current/future custody records.
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const name = String(row['name']);
    data[name] = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all();
  }
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/** Back up through SQLite so committed WAL records are included. This is a
 * retained recovery artifact; updates never restore the live catalog. */
export async function backupCodingCatalog(sourceFile: string, target: string, updateId: string): Promise<void> {
  const reservation = connect(sourceFile, false);
  try {
    reservation.exec('BEGIN IMMEDIATE');
    const source = connect(sourceFile, true);
    let before: string;
    try { before = snapshot(source); await sqliteRuntime().backup(source, target); } finally { source.close(); }
    chmodSync(target, 0o600);
    const copied = connect(target, false);
    try {
      if (copied.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok' || copied.prepare('PRAGMA foreign_key_check').all().length !== 0 || snapshot(copied) !== before) throw Error('Coding catalog backup verification failed. The installed app is unchanged.');
      changeGate(copied, updateId, false);
    } finally { copied.close(); }
    reservation.exec('COMMIT');
    const fd = openSync(target, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  } finally { reservation.close(); }
}
