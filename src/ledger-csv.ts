import type { LedgerEntry } from "./action-ledger.js";

// Quotes and CR/LF survive a CSV round trip. Prefix spreadsheet formulas
// with an apostrophe, including formulas hidden behind whitespace.
export function csvCell(value: string | number | null): string {
  const raw = value === null ? "" : String(value);
  const safe = /^[\s\uFEFF]*[=+@-]/u.test(raw) || /^[\t\r\n]/u.test(raw) ? "'" + raw : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
export const LEDGER_CSV_HEADER = "\uFEFF" + ["ID", "Time (UTC)", "Actor", "Project", "Task", "Run", "Action", "Outcome", "Source"].map(csvCell).join(",") + "\r\n";
export function ledgerCsvRows(rows: readonly LedgerEntry[]): string {
  return rows.map(row => [row.id, row.at, row.actor, row.repo, row.taskId, row.runId, row.action, row.outcome, row.source].map(csvCell).join(",") + "\r\n").join("");
}
