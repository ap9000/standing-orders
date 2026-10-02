/** How chat sounds: a teammate talking. One or two short sentences, outcome
 * first, plain words, one action at most. Every chat (Telegram, Slack,
 * Discord, Teams) takes its titles and its finished-work lines from here, so a
 * task id, a "— revision" suffix or a person's own act never reaches a chat.
 * The console keeps every exact name and fact. */
import type { TelegramTransport } from "./telegram.js";
import { phoneText } from "./telegram-status.js";

/** The bot's display name in every chat app. */
export const BOT_NAME = "Toolroll";
/** Updates for one person landing within this window become one message, edited in place as it grows. */
export const BATCH_MS = 2 * 60_000;
export const SHORT_TITLE_MAX = 60;

/** A token that reads like a machine id: `release-099b`, `fix-checkout-tax-2`, `#123`. */
const SLUG_WITH_DIGIT = /(?<![\p{L}\p{N}.])[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+(?![\p{L}\p{N}])/gu;
/** An id that could be mistaken for nothing else (`release-099b`, `fix_tax`, `t42`). A one-word id such as `tidy`
 * is also a word, and prose keeps its words. */
const idLike = (id: string): boolean => /[-_\d]/.test(id);
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A short human summary of a task's title, at most 60 characters: no "— revision", no ids. */
export function shortTitle(title: string | null | undefined, taskId?: string | null): string {
  let text = phoneText(title ?? "", 400);
  // "— revision", "- revision 2", "(revision)": a revision is the same work to a person.
  text = text.replace(/(?:(?:\s*[—–]+|\s+-+)\s*revision\b(?:\s*#?\d+)?|\s*[([]\s*revision(?:\s*#?\d+)?\s*[)\]])/giu, "");
  if (taskId && idLike(taskId)) text = text.replace(new RegExp(`\\(?(?<![\\p{L}\\p{N}_-])${escape(taskId)}(?![\\p{L}\\p{N}_-])\\)?`, "giu"), " ");
  text = text.replace(/\(\s*[a-z0-9]+(?:[-_][a-z0-9]+)+\s*\)/giu, " ");
  text = text.replace(SLUG_WITH_DIGIT, one => /[-_][a-z0-9]*\d/.test(one) ? " " : one);
  text = text.replace(/(?<![\p{L}\p{N}])#\d+\b/gu, " ");
  text = text.replace(/\s+/g, " ").replace(/^[\s·:,;—–-]+|[\s·:,;—–-]+$/gu, "").trim();
  if (text === "") {
    // A task filed with only its id as a title: the words, never the slug.
    const words = (taskId ?? "").replace(/[-_]+/g, " ").trim();
    return words === "" ? "A task" : shortTitle(words[0]!.toUpperCase() + words.slice(1));
  }
  if (text.length <= SHORT_TITLE_MAX) return text;
  const cut = text.slice(0, SHORT_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s·:,;—–-]+$/u, "")}…`;
}

/** A title inside a sentence or list: "faster tests", but "API keys" and "iOS" keep their capitals. */
export function inSentence(summary: string): string {
  return /^\p{Lu}\p{Ll}/u.test(summary) ? summary[0]!.toLowerCase() + summary.slice(1) : summary;
}

/** The facts a finished-work line is made of, read from the shared task status. */
export type FinishedFact = {
  summary: string;
  headline: string;
  checks: "passed" | "failed" | "not-run" | "off" | null;
  report: boolean;
  completedBy: string | null;
};

/** One finished task, said plainly: what happened, then what happens next. */
export function finishedLine(fact: FinishedFact): string {
  const name = fact.summary;
  switch (fact.headline) {
    case "Ready for review":
      if (fact.report) return `${name}: the report is ready to read.`;
      if (fact.checks === "passed") return `${name} is ready. Your tests passed. Take a look?`;
      if (fact.checks === "off") return `${name} is ready. Checks are off for this project, so look it over first.`;
      return `${name} is ready, but no tests ran. Look it over first.`;
    case "Failed":
      return fact.checks === "failed"
        ? `${name} is built, but its tests failed. It waits for you: retry or ask for changes.`
        : `${name} stopped before it finished. The work so far is kept; retry when you're ready.`;
    case "Complete":
      return fact.completedBy ? `${name} is done. ${fact.completedBy} marked it complete.` : `${name} is done.`;
    case "Needs you":
      return `${name} needs your decision before it can continue.`;
    default:
      return `${name}: ${fact.headline.toLowerCase()}.`;
  }
}

/** Several finished tasks in one message: "4 tasks finished: faster tests, cleanup, …", then any failure. */
export function batchLine(facts: readonly FinishedFact[]): string {
  if (facts.length === 1) return finishedLine(facts[0]!);
  const names = facts.map(one => inSentence(one.summary));
  const shown = names.slice(0, 3).join(", ");
  const first = `${facts.length} tasks finished: ${shown}${names.length > 3 ? ", …" : "."}`;
  // What happens next: anything that broke or needs a decision waits for the person.
  const failed = facts.filter(one => one.headline === "Failed").map(one => inSentence(one.summary));
  const needs = facts.filter(one => one.headline === "Needs you").length;
  const waits = [
    ...(failed.length === 0 ? [] : [failed.length === 1 ? `tests failed on ${failed[0]}` : `${failed.length} had failing tests`]),
    ...(needs === 0 ? [] : [needs === facts.length ? "each needs your decision" : `${needs} need your decision`]),
  ];
  if (waits.length === 0) return first;
  const said = waits.join(", and ");
  return `${first}\n${said[0]!.toUpperCase()}${said.slice(1)}; ${failed.length + needs === 1 ? "it waits" : "they wait"} for you.`;
}

/** The old product name a bot may still wear from before the rename. */
const OLD_NAME = /standing\s*-?\s*orders/i;

/**
 * Name the Telegram bot Toolroll. On pairing it always becomes Toolroll; on upgrade only a bot still called
 * StandingOrders is renamed, so a name a person chose later is kept. Best effort: a refused or failed call
 * leaves the old name and never blocks pairing or delivery. Returns whether a rename was sent and accepted.
 */
export async function nameTelegramBot(transport: TelegramTransport, when: "pairing" | "upgrade"): Promise<boolean> {
  try {
    const current = await transport("getMyName", {});
    const name = current.ok ? (current.result as { name?: unknown } | undefined)?.name : undefined;
    const shown = typeof name === "string" ? name : null;
    if (shown === BOT_NAME) return false;
    if (when === "upgrade" && (shown === null || !OLD_NAME.test(shown))) return false;
    const set = await transport("setMyName", { name: BOT_NAME });
    return set.ok;
  } catch {
    return false;
  }
}

/** The last word on any pushed chat text: a task's own id (bare or in brackets), a "— revision" suffix and a
 * "Replaced by <id>" never reach a chat, whatever words the fact was recorded with. A bare id reads as the
 * task's short title when one is given, else "this task". */
export function chatText(text: string, tasks: readonly (string | null | undefined | { id: string; title?: string })[] = []): string {
  let out = text.replace(/(?:(?:[ \t]*[—–]+|[ \t]+-+)[ \t]*revision\b(?:[ \t]*#?\d+)?|[ \t]*[([][ \t]*revision(?:[ \t]*#?\d+)?[ \t]*[)\]])/giu, "");
  out = out.replace(/\bReplaced by (?!a newer task)[^\s.,;:!?)]+/gu, "Replaced by a newer task");
  for (const task of tasks) {
    const id = typeof task === "string" ? task : task?.id;
    if (!id || !idLike(id)) continue;
    const title = typeof task === "object" && task !== null ? task.title : undefined;
    out = out.replace(new RegExp(`[ \\t]*\\(${escape(id)}\\)|(?<![\\p{L}\\p{N}_/=-])${escape(id)}(?![\\p{L}\\p{N}_-])`, "gu"),
      match => match.trimStart().startsWith("(") ? "" : title ?? "this task");
  }
  return out;
}

/** Whether the words already name this title as a whole phrase (so it need not be said twice). */
export function mentions(text: string, title: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escape(title)}(?![\\p{L}\\p{N}_-])`, "u").test(text);
}
