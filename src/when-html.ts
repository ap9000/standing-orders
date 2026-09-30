/**
 * A time a person reads. A desk shows the full stamp, as before; a phone (760px and narrower) shows the short
 * one — "16:39" today, "Yesterday 16:39", "Sep 28" otherwise — and the full stamp stays in the title. Stamps are
 * UTC to the minute, so the short form is counted in UTC too. The CSS that picks one lives in the shared page
 * stylesheet (`.so-when-*` in serve.ts).
 */
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** "16:39" today, "Yesterday 16:39" / "Tomorrow 16:39" beside it, "Sep 28" otherwise ("Sep 28 2025" in another year). */
export function shortWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const clock = iso.length >= 16 && iso[10] === "T" ? iso.slice(11, 16) : at.toISOString().slice(11, 16);
  const days = Math.floor(at.getTime() / DAY_MS) - Math.floor(now.getTime() / DAY_MS);
  if (days === 0) return clock;
  if (days === -1) return `Yesterday ${clock}`;
  if (days === 1) return `Tomorrow ${clock}`;
  const date = `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
  return at.getUTCFullYear() === now.getUTCFullYear() ? date : `${date} ${at.getUTCFullYear()}`;
}

/** The `<time>` for a stamp: `full` is the words a desk shows ("2026-09-30 16:39 UTC"). Empty for no stamp. */
export function whenHtml(iso: string | null, full: string, now: Date = new Date()): string {
  if (iso === null || iso === "") return "";
  const words = escape(full);
  return `<time datetime="${escape(iso)}" title="${words}"><span class="so-when-full">${words}</span><span class="so-when-short">${escape(shortWhen(iso, now))}</span></time>`;
}

/** "2026-09-30 16:39 UTC" — the desk's words for a stamp. */
export const utcMinute = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** Both the desk and phone forms of a UTC stamp. */
export const whenUtc = (iso: string | null, now: Date = new Date()) => iso === null || iso === "" ? "" : whenHtml(iso, utcMinute(iso), now);
