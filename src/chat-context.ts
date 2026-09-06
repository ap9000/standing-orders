import type { Store } from "./store.js";
import { encodeProjectMentions } from "./chat-projects.js";
import { scanForSecrets } from "./evidence.js";

export function chatPreference(store: Store, approver: string): { days: number; focus: string | null } {
  const row = store.raw().prepare("SELECT * FROM chat_preferences WHERE approver = ?").get(approver);
  return { days: Number(row?.["retention_days"] ?? 90), focus: row?.["focus_repo"] == null ? null : String(row["focus_repo"]) };
}
export function setChatFocus(store: Store, approver: string, focus: string | null): void {
  store.raw().prepare("INSERT INTO chat_preferences(approver,focus_repo) VALUES (?,?) ON CONFLICT(approver) DO UPDATE SET focus_repo=excluded.focus_repo").run(approver, focus);
}
/** User-authored mentions can select a workstream. Attachments never select one. */
export function focusFromMessage(store: Store, approver: string, message: string, repos: readonly string[]): string | null {
  const existing = chatPreference(store, approver).focus;
  if (/\b(all|every|across) (?:my |the )?projects\b/i.test(message)) { setChatFocus(store, approver, null); return null; }
  const encoded = encodeProjectMentions(message, repos);
  const ids = [...new Set(encoded.match(/\br[1-9][0-9]{0,2}\b/g) ?? [])];
  if (ids.length === 1) {
    const repo = repos[Number(ids[0]!.slice(1)) - 1];
    if (repo) { setChatFocus(store, approver, repo); return repo; }
  }
  return ids.length > 1 ? null : existing !== null && repos.includes(existing) ? existing : null;
}
export function saveChatContext(store: Store, approver: string, repo: string, note: string, days: number, now: Date): boolean {
  if (![1,30,90,365].includes(days) || note.length > 4000 || scanForSecrets(note).length) return false;
  store.transact(() => {
    store.raw().prepare("INSERT INTO chat_preferences(approver,retention_days) VALUES (?,?) ON CONFLICT(approver) DO UPDATE SET retention_days=excluded.retention_days").run(approver, days);
    if (note.trim()) store.raw().prepare("INSERT INTO chat_context(approver,repo,note,updated_at) VALUES (?,?,?,?) ON CONFLICT(approver,repo) DO UPDATE SET note=excluded.note, updated_at=excluded.updated_at").run(approver, repo, note.trim(), now.toISOString());
    else store.raw().prepare("DELETE FROM chat_context WHERE approver=? AND repo=?").run(approver, repo);
    store.sweepMateThreads(now);
  });
  return true;
}
