/**
 * UI-only chat mirrors: Slack and Discord as NOTIFICATION surfaces.
 *
 * Deliberately one-way. No bot, no pairing, no inbound events — each page
 * is a message with a deep link into the console, and the ACTING happens
 * there, behind the console's own authentication and step-ups. That makes
 * this integration cheap on purpose: an outbound webhook is not an
 * authentication surface, so the whole Telegram answering apparatus
 * (bindings, opaque tokens, idempotent updates, note drafts) simply does
 * not apply. The day acting-from-Slack is wanted, it gets the Telegram
 * treatment: its own review, its own identity model — never a shortcut
 * through this module.
 *
 * The webhook URL is a CREDENTIAL (anyone holding it can post to the
 * channel): it lives in a 0600 file beside the database or in the
 * environment, is never a database column, and never appears in logs or
 * errors — the same rules as the bot token, for the same reasons.
 */

import { readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Notification, Store } from "./store.js";

export const SLACK_ENV = "STANDING_ORDERS_SLACK_WEBHOOK";
export const DISCORD_ENV = "STANDING_ORDERS_DISCORD_WEBHOOK";
export const CONSOLE_URL_ENV = "STANDING_ORDERS_CONSOLE_URL";
export const PRIMARY_ENV = "STANDING_ORDERS_MESSAGING_PRIMARY";

export type WebhookKind = "slack" | "discord";

export type WebhookTarget = { kind: WebhookKind; url: string };

/** How long one delivery claim protects a row from a second sender. */
const DELIVERY_CLAIM_MS = 60_000;
const POST_TIMEOUT_MS = 10_000;

const FILE_OF: Record<WebhookKind, string> = {
  slack: "slack-webhook",
  discord: "discord-webhook",
};
const CONSOLE_FILE = "console-url";
const PRIMARY_FILE = "messaging-primary";

export type MessagingChannel = "telegram" | "slack" | "discord";
export const MESSAGING_CHANNELS: readonly MessagingChannel[] = ["telegram", "slack", "discord"];

export function isMessagingChannel(value: string): value is MessagingChannel {
  return (MESSAGING_CHANNELS as readonly string[]).includes(value);
}

/** The shapes each platform hands out; anything else is probably a paste error. */
const URL_SHAPE: Record<WebhookKind, RegExp> = {
  slack: /^https:\/\/hooks\.slack\.com\/\S+$/,
  discord: /^https:\/\/(canary\.|ptb\.)?discord\.com\/api\/webhooks\/\S+$/,
};

export function saveWebhook(dir: string, kind: WebhookKind, url: string): { ok: true } | { ok: false; message: string } {
  if (!URL_SHAPE[kind].test(url.trim())) {
    return { ok: false, message: `that does not look like a ${kind} webhook URL — paste it exactly as the platform issued it` };
  }
  const file = join(dir, FILE_OF[kind]);
  writeFileSync(file, `${url.trim()}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { ok: true };
}

export function clearWebhook(dir: string, kind: WebhookKind): void {
  try {
    rmSync(join(dir, FILE_OF[kind]));
  } catch {
    // Already absent is cleared.
  }
}

export function saveConsoleUrl(dir: string, url: string): { ok: true } | { ok: false; message: string } {
  // Parsed, not pattern-matched (attended review, finding 11): the stored
  // value becomes every deep link's base, so userinfo, queries, and
  // fragments are refused rather than smuggled into each link.
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, message: "the console URL is the address the links open — http(s)://host[:port]" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "the console URL must be http or https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, message: "the console URL must not carry credentials — they would ride every link" };
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return { ok: false, message: "the console URL is a base address — no query or fragment" };
  }
  const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  const file = join(dir, CONSOLE_FILE);
  writeFileSync(file, `${normalized}\n`, { mode: 0o600 });
  return { ok: true };
}

function readTrimmed(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** Every configured mirror. Environment wins over files, like the bot token. */
export function loadWebhookTargets(env: Record<string, string | undefined>, dir: string): WebhookTarget[] {
  const targets: WebhookTarget[] = [];
  const slack = env[SLACK_ENV] ?? readTrimmed(join(dir, FILE_OF.slack));
  const discord = env[DISCORD_ENV] ?? readTrimmed(join(dir, FILE_OF.discord));
  if (slack !== null && slack !== undefined && slack !== "") targets.push({ kind: "slack", url: slack });
  if (discord !== null && discord !== undefined && discord !== "") targets.push({ kind: "discord", url: discord });
  return targets;
}

/** The operator's explicit choice of which service carries the pages. */
export function savePrimary(dir: string, channel: MessagingChannel): void {
  writeFileSync(join(dir, PRIMARY_FILE), `${channel}\n`, { mode: 0o600 });
}

export function loadPrimary(env: Record<string, string | undefined>, dir: string): MessagingChannel | null {
  const configured = env[PRIMARY_ENV] ?? readTrimmed(join(dir, PRIMARY_FILE));
  return configured !== undefined && configured !== null && isMessagingChannel(configured) ? configured : null;
}

/**
 * Which service actually carries the pages, and whether that was chosen or
 * merely fell out of what happens to be configured. Explicit choice wins
 * WHEN its channel is actually configured (a primary pointing at nothing
 * falls through rather than silencing every page); otherwise Telegram if
 * present (it can hold buttons), else the mirrors. `implicit` is the flag
 * every status surface uses to say "you have several — pick one".
 */
export function effectivePrimary(
  env: Record<string, string | undefined>,
  dir: string,
  telegramConfigured: boolean,
): { channel: MessagingChannel | null; implicit: boolean; configured: MessagingChannel[] } {
  const targets = loadWebhookTargets(env, dir);
  const configured: MessagingChannel[] = [
    ...(telegramConfigured ? (["telegram"] as const) : []),
    ...targets.map(one => one.kind),
  ];
  const chosen = loadPrimary(env, dir);
  if (chosen !== null && configured.includes(chosen)) {
    return { channel: chosen, implicit: false, configured };
  }
  if (telegramConfigured) return { channel: "telegram", implicit: configured.length > 1, configured };
  const fallback = configured[0] ?? null;
  return { channel: fallback, implicit: configured.length > 1, configured };
}

export function loadConsoleUrl(env: Record<string, string | undefined>, dir: string): string | null {
  const configured = env[CONSOLE_URL_ENV] ?? readTrimmed(join(dir, CONSOLE_FILE));
  return configured === undefined || configured === null || configured === "" ? null : configured.replace(/\/+$/, "");
}

/** Where in the console this notification wants a person. */
export function linkFor(consoleUrl: string | null, notification: Notification): string | null {
  if (consoleUrl === null) return null;
  const decision = /^decision:(\d+)$/.exec(notification.dedupeKey);
  if (decision !== null) return `${consoleUrl}/d/${decision[1]}`;
  // Everything else that wants a person is triaged where acting lives.
  return `${consoleUrl}/next`;
}

/**
 * One notification, one platform. The payloads are the simplest thing each
 * platform documents; the console link is the call to action, because the
 * message is a mirror and the UI is the instrument.
 */
export async function postWebhook(
  target: WebhookTarget,
  notification: Notification,
  link: string | null,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lines = [notification.subject, "", notification.body];
  const body =
    target.kind === "slack"
      ? {
          text: [
            `*${notification.subject}*`,
            notification.body,
            ...(link === null ? [] : [`<${link}|open in standing-orders>`]),
          ].join("\n"),
        }
      : {
          content: [
            `**${notification.subject}**`,
            notification.body,
            ...(link === null ? [] : [link]),
          ].join("\n").slice(0, 1900),
        };
  void lines;
  try {
    const response = await fetcher(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Status only — the URL is a credential and never rides an error.
      return { ok: false, error: `${target.kind} answered ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    const said = error instanceof Error ? error.name : "failed";
    return { ok: false, error: `${target.kind} delivery ${said}` };
  }
}

export type WebhookReport = { sent: number; problems: string[] };

/**
 * Deliver every pending notification to every configured mirror, through
 * the SAME claim/finalize discipline as every other deliverer — so a
 * webhook pass and a Telegram bridge can never both own one row. This
 * pass runs when Telegram is NOT configured; with a paired Telegram chat,
 * Telegram remains the delivery channel (it can carry buttons) and these
 * mirrors stay silent rather than double-paging every phone.
 */
export async function webhookPass(
  store: Store,
  options: {
    targets: WebhookTarget[];
    consoleUrl: string | null;
    owner?: string;
    clock?: () => Date;
    fetcher?: typeof fetch;
  },
): Promise<WebhookReport> {
  const clock = options.clock ?? (() => new Date());
  const owner = options.owner ?? `webhooks-${Math.floor(clock().getTime() / 1000)}`;
  const report: WebhookReport = { sent: 0, problems: [] };
  if (options.targets.length === 0) return report;

  const claimed = store.claimDeliveries(owner, DELIVERY_CLAIM_MS, clock());
  for (const row of claimed) {
    const link = linkFor(options.consoleUrl, row);
    const outcomes = await Promise.all(
      options.targets.map(target => postWebhook(target, row, link, options.fetcher ?? fetch)),
    );
    const failed = outcomes.filter(one => !one.ok);
    const outcome =
      failed.length === 0
        ? { ok: true as const, receipt: options.targets.map(one => one.kind).join("+") }
        : { ok: false as const, error: failed.map(one => (one.ok ? "" : one.error)).join("; ") };
    const finalized = store.finalizeDelivery(row.id, owner, outcome, clock());
    if (outcome.ok && finalized) report.sent++;
    if (!outcome.ok) report.problems.push(`notification ${row.id}: ${outcome.error}`);
  }
  return report;
}
