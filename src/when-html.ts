/**
 * A time a person reads. A desk shows the full stamp, as before; a phone (760px and narrower) shows the short
 * one — "16:39" today, "Yesterday 16:39", "Sep 28" otherwise — and the full stamp stays in the title. Stamps are
 * UTC to the minute, so the server counts in UTC; in the browser `localizeTimes` rewords every one with the same
 * formatter in the viewer's own zone, as the React views do. The CSS that picks one lives in the shared page
 * stylesheet (`.so-when-*` in serve.ts).
 */
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** A stamp's calendar day, clock and month in a time zone ("UTC" on the server, the viewer's own zone in a browser). */
function partsIn(at: Date, zone: string): { year: number; month: number; day: number; clock: string } {
  const read = (z: string) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: z, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(at).map(part => [part.type, part.value]));
  let parts: Record<string, string>;
  try { parts = read(zone); } catch { parts = read("UTC"); }
  return { year: Number(parts["year"]), month: Number(parts["month"]), day: Number(parts["day"]), clock: `${parts["hour"]}:${parts["minute"]}` };
}
const dayNumber = (p: { year: number; month: number; day: number }) => Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);

/** The viewer's own time zone (a browser's); UTC where there is none to read. */
export function viewerZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** The one formatter for a time a person reads, on every surface: "16:39" today, "Yesterday 16:39" /
 * "Tomorrow 16:39" beside it, "Sep 28" otherwise ("Sep 28 2025" in another year), counted in `zone`. */
export function shortWhen(iso: string, now: Date = new Date(), zone = "UTC"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const then = partsIn(at, zone), today = partsIn(now, zone);
  const days = dayNumber(then) - dayNumber(today);
  if (days === 0) return then.clock;
  if (days === -1) return `Yesterday ${then.clock}`;
  if (days === 1) return `Tomorrow ${then.clock}`;
  const date = `${MONTHS[then.month - 1]} ${then.day}`;
  return then.year === today.year ? date : `${date} ${then.year}`;
}

/** The exact minute in `zone` ("2026-09-30 16:39", with " UTC" when it is UTC): a time's title, one hover away. */
export function fullWhen(iso: string, zone = "UTC"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const p = partsIn(at, zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${p.clock}${zone === "UTC" ? " UTC" : ""}`;
}

/** Every server-rendered `<time datetime>` inside `root`, reworded by the one formatter in the viewer's zone: the
 * same words on a desk and a phone, the exact minute in the title. The server's UTC words stay only without script. */
export function localizeTimes(root: ParentNode, now: Date = new Date(), zone: string = viewerZone()): void {
  root.querySelectorAll<HTMLTimeElement>("time[datetime]").forEach(node => {
    const iso = node.getAttribute("datetime") ?? "";
    if (iso === "" || node.hasAttribute("data-elapsed-since") || Number.isNaN(new Date(iso).getTime())) return;
    const words = shortWhen(iso, now, zone), full = fullWhen(iso, zone);
    if (node.title !== full) node.title = full;
    // A time React already wrote with this formatter keeps its own text node.
    if (node.textContent !== words) node.textContent = words;
  });
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
