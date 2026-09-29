/**
 * Where Toolroll's disk goes (`toolroll storage`): the folder
 * beside the database, by kind, and what storage retention takes care of.
 * Build checkouts and staged releases are the big ones; the worker removes a
 * finished task's clean checkout two days after it was let go, and a deploy
 * keeps its last few releases.
 */
import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Store } from "./store.js";

export type StorageLine = { what: string; bytes: number; count?: number; note?: string };

/** Bytes a tree holds on disk (allocated blocks; links not followed). */
export function treeBytes(path: string): number {
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const at = pending.pop()!;
    let stat;
    try { stat = lstatSync(at); } catch { continue; }
    total += typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
    if (!stat.isDirectory()) continue;
    let names: string[] = [];
    try { names = readdirSync(at); } catch { names = []; }
    for (const name of names) pending.push(join(at, name));
  }
  return total;
}

export function storageReport(store: Store, databaseFile: string, now: Date, keepMs: number): { folder: string; total: number; lines: StorageLine[] } {
  const folder = dirname(databaseFile);
  const base = basename(databaseFile);
  let names: string[] = [];
  try { names = readdirSync(folder); } catch { names = []; }
  const sizes = new Map(names.map(name => [name, treeBytes(join(folder, name))]));
  const take = (match: (name: string) => boolean) => {
    let bytes = 0;
    for (const [name, size] of sizes) if (match(name)) { bytes += size; sizes.delete(name); }
    return bytes;
  };
  const checkouts = store.listWorktrees();
  const due = checkouts.filter(row => row.releasedAt !== null && row.runner === null && now.getTime() - Date.parse(row.releasedAt) >= keepMs).length;
  let staged = 0;
  try { staged = readdirSync(join(folder, "staged-upgrades")).length; } catch { staged = 0; }
  const lines: StorageLine[] = [
    { what: "Database", bytes: take(name => name.startsWith(base)) },
    { what: "Build checkouts", bytes: take(name => name === "worktrees"), count: checkouts.length,
      note: due === 0 ? "none due for removal" : `${due} let go over ${Math.round(keepMs / 86_400_000)} days ago: removed on the next pass if their task is finished and they're clean` },
    { what: "Staged releases", bytes: take(name => name === "staged-upgrades"), count: staged, note: "a deploy keeps the release it installed, the one before and the newest few" },
    { what: "Evidence", bytes: take(name => name === "evidence"), note: "the audit record of every run; kept" },
    { what: "Backups", bytes: take(name => name === "backups") },
  ];
  lines.push({ what: "Everything else", bytes: [...sizes.values()].reduce((sum, one) => sum + one, 0) });
  return { folder, total: lines.reduce((sum, one) => sum + one.bytes, 0), lines };
}

export function bytesWords(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
