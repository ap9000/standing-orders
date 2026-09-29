/**
 * One line per event on stderr (v99), where the service manager keeps the
 * log. Plain by default ("2026-09-27T17:00:00.000Z error serve.error path=/x
 * error=…"); with TOOLROLL_LOG_FORMAT=json, one JSON object per line
 * for a log shipper. Fields are facts about the event, never a request body,
 * a password or a token; values are cut to 500 characters and key-shaped text
 * is blanked.
 */
import { scanForSecrets } from "./evidence.js";
import { envValue } from "./names.js";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, string | number | boolean | null | undefined>;

const clean = (value: string): string => {
  const cut = value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500);
  return scanForSecrets(cut).length > 0 ? "[redacted: key-shaped text]" : cut;
};

export function formatLogLine(level: LogLevel, event: string, fields: LogFields, now: Date, json: boolean): string {
  const facts = Object.entries(fields).filter((entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined)
    .map(([key, value]) => [key, typeof value === "string" ? clean(value) : value] as const);
  if (json) return JSON.stringify({ at: now.toISOString(), level, event, ...Object.fromEntries(facts) });
  return [now.toISOString(), level, event, ...facts.map(([key, value]) => `${key}=${typeof value === "string" && /\s/.test(value) ? JSON.stringify(value) : String(value)}`)].join(" ");
}

export function logEvent(level: LogLevel, event: string, fields: LogFields = {}, options: { now?: Date; write?: (line: string) => void } = {}): void {
  const line = formatLogLine(level, event, fields, options.now ?? new Date(), envValue(process.env, "LOG_FORMAT") === "json");
  (options.write ?? (text => process.stderr.write(text)))(`${line}\n`);
}
