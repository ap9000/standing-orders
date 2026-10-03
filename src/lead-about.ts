/** What your lead knows about you (Settings → Lead): a short list of the owner's own lasting preferences, the same
 * across projects ("keep copy terse", "I test myself"). Stored beside the lead's name and persona; only lines the
 * owner confirmed (a remember about-you card) or wrote themselves are kept, never a guess. */
import type { Store } from "./store.js";
import { scanForSecrets } from "./evidence.js";

export const ABOUT_YOU_MAX_LINES = 20;
/** Each line is under 200 characters. */
export const ABOUT_YOU_LINE_MAX = 199;

/** This person's confirmed lines; an older store reads as none. */
export function aboutYouOf(store: Store, account: string | null | undefined): string[] {
  if (account == null || account === "") return [];
  try { return store.leadAbout(account); } catch { return []; }
}

/** One line as it is saved, or the problem with it. */
export function checkAboutYouLine(value: unknown): { ok: true; line: string } | { ok: false; message: string } {
  const line = typeof value === "string" ? value.replace(/^\s*[-*•]\s*/, "").replace(/\s+/g, " ").trim() : "";
  if (line.length < 2) return { ok: false, message: "Say it in a few words." };
  if (line.length > ABOUT_YOU_LINE_MAX) return { ok: false, message: `Keep each line under ${ABOUT_YOU_LINE_MAX + 1} characters.` };
  if (/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩�]/.test(line) || scanForSecrets(line).length > 0) return { ok: false, message: "Use plain words, with no passwords or keys." };
  return { ok: true, line };
}

/** The Settings form's text, one line each: the saved list, or the problem with it. Blank lines and repeats go. */
export function checkAboutYou(text: string): { ok: true; lines: string[] } | { ok: false; message: string } {
  const lines: string[] = [];
  // A problem names the line as the person sees it in the box, blank lines and repeats counted.
  for (const [index, raw] of text.replace(/\r\n?/g, "\n").split("\n").entries()) {
    if (raw.trim() === "") continue;
    const checked = checkAboutYouLine(raw);
    if (!checked.ok) return { ok: false, message: `Line ${index + 1}: ${checked.message}` };
    if (!lines.some(one => one.toLowerCase() === checked.line.toLowerCase())) lines.push(checked.line);
  }
  if (lines.length > ABOUT_YOU_MAX_LINES) return { ok: false, message: `Keep it to ${ABOUT_YOU_MAX_LINES} lines.` };
  return { ok: true, lines };
}

/** Save the whole list for this person (already checked). Their lead's name and persona are left as they are. */
export function saveAboutYou(store: Store, account: string, lines: readonly string[], now: Date): void {
  store.setLeadAbout(account, lines, now);
}

/** The list once a confirmed line is added, or once it replaces line `replaces` (1-based). */
export function withAboutYouLine(lines: readonly string[], line: string, replaces: number): { ok: true; lines: string[] } | { ok: false; message: string } {
  if (replaces > 0) {
    if (replaces > lines.length) return { ok: false, message: "That line is no longer in what your lead knows about you." };
    const next = [...lines];
    next[replaces - 1] = line;
    return { ok: true, lines: next.filter((one, index) => index === replaces - 1 || one.toLowerCase() !== line.toLowerCase()) };
  }
  if (lines.some(one => one.toLowerCase() === line.toLowerCase())) return { ok: false, message: "Your lead already knows this." };
  if (lines.length >= ABOUT_YOU_MAX_LINES) return { ok: false, message: `What your lead knows about you is full (${ABOUT_YOU_MAX_LINES} lines). Replace a line, or tidy it in Settings → Lead.` };
  return { ok: true, lines: [...lines, line] };
}
