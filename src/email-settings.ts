/**
 * The mail server (v87) and where Inbox triggers read it (v89), saved from
 * Settings → Email in a 0600 file beside the database. Its own module, with
 * nothing but the file system, so the mailbox and triggers can read it
 * without pulling in the step runners.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The mail server (v87), and where Inbox triggers read it (v89: its IMAP address; same sign-in). */
export type EmailSettings = { host: string; port: number; secure: boolean; user: string; from: string; imap: { host: string; port: number; secure: boolean } | null };
const EMAIL_FILE = "email.json";
export const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export function readEmailSettings(dir: string | null): (EmailSettings & { password: string }) | null {
  if (dir === null || !existsSync(join(dir, EMAIL_FILE))) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dir, EMAIL_FILE), "utf8")) as Record<string, unknown>;
    if (typeof raw["host"] !== "string" || typeof raw["from"] !== "string") return null;
    const imap = raw["imap"] !== null && typeof raw["imap"] === "object" ? raw["imap"] as Record<string, unknown> : null;
    return { host: raw["host"], port: Number(raw["port"]) || 587, secure: raw["secure"] === true, user: typeof raw["user"] === "string" ? raw["user"] : "", from: raw["from"], password: typeof raw["password"] === "string" ? raw["password"] : "",
      imap: imap !== null && typeof imap["host"] === "string" ? { host: imap["host"], port: Number(imap["port"]) || 993, secure: imap["secure"] !== false } : null };
  } catch { return null; }
}

/** Save the mail server from Settings; an empty password keeps the saved one. An IMAP address lets Inbox triggers read it. */
export function saveEmailSettings(dir: string, input: { host: unknown; port: unknown; secure: unknown; user: unknown; from: unknown; password: unknown; imapHost?: unknown; imapPort?: unknown }): { ok: true; said: string } | { ok: false; message: string } {
  const host = typeof input.host === "string" ? input.host.trim() : "";
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return { ok: false, message: "Give the mail server's name, like smtp.gmail.com." };
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: "The port is a number, usually 587 or 465." };
  const from = typeof input.from === "string" ? input.from.trim() : "";
  if (!ADDRESS.test(from)) return { ok: false, message: "Give the address emails come from." };
  const user = typeof input.user === "string" ? input.user.trim().slice(0, 254) : "";
  const imapHost = typeof input.imapHost === "string" ? input.imapHost.trim() : "";
  if (imapHost !== "" && !/^[A-Za-z0-9.-]{1,253}$/.test(imapHost)) return { ok: false, message: "Give the server Inbox triggers read from, like imap.gmail.com, or leave it empty." };
  const imapPort = input.imapPort === undefined || input.imapPort === "" || input.imapPort === null ? 993 : Number(input.imapPort);
  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) return { ok: false, message: "The reading port is a number, usually 993." };
  const password = typeof input.password === "string" && input.password !== "" ? input.password : readEmailSettings(dir)?.password ?? "";
  writeFileSync(join(dir, EMAIL_FILE), JSON.stringify({ host, port, secure: input.secure === true || input.secure === "on" || input.secure === "true" || port === 465, user, from, password,
    // 993 is TLS from the start; any other port must upgrade with STARTTLS before the password is sent.
    imap: imapHost === "" ? null : { host: imapHost, port: imapPort, secure: imapPort === 993 } }), { mode: 0o600 });
  chmodSync(join(dir, EMAIL_FILE), 0o600);
  return { ok: true, said: imapHost === "" ? `Email is set up: it comes from ${from}.` : `Email is set up: it comes from ${from}, and Inbox triggers read ${imapHost}.` };
}

