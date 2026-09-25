/**
 * Steps that reach outside (v87): a web request, an email, and a call to one
 * of the project's tools (its MCP servers). Each runs in the worker's step
 * pass (flow-steps.ts), once per visit of a card.
 *
 * - Web request: the address's scheme and host are written out in the
 *   zone (flows.ts refuses fill-ins there); fill-ins in its path and query
 *   are encoded, so a card can never change where a request goes. Secrets
 *   ({{secret.NAME}}) are filled into headers only, from a 0600 file per
 *   project beside the database, and never reach a log, a card or a chat.
 * - Email: through the operator's own mail server (Settings → Email), with
 *   the password in a 0600 file beside the database. Recipients are checked
 *   addresses; the subject can't carry a line break.
 * - Tool: the project's own MCP server, started like its Test button starts
 *   it, with the project's tool secrets and nothing else of ours.
 *
 * A refusal (a 4xx, a rejected recipient, a tool that says it failed) is an
 * answer: the card takes its failure path. Trouble reaching a service is
 * tried again, like every step.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { redactSecretAssignments } from "./builder.js";
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import { fillFlowText, type FlowStage } from "./flows.js";
import { callProjectTool, projectToolsOf, readToolSecrets, type ToolCall, type ToolSpec } from "./project-tools.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import type { FlowCardRow, Store } from "./store.js";

export type ActionOutcome = { state: "passed" | "failed" | "retry"; said: string; log?: string; output?: string };
const OUTPUT_CHARS = 8000;
const clip = (text: string, cap: number) => text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
const blank = (text: string) => redactSecretAssignments(redactSecretLines(text, scanForSecrets(text)));

/** Blank any of these secret values wherever an answer echoes them back. */
const scrub = (text: string, secrets: Record<string, string>) => Object.values(secrets).filter(value => value.length >= 6).reduce((out, value) => out.split(value).join("[secret]"), text);

/** Fill every string inside a JSON value, leaving its shape alone: a card's text can never break out of a string. */
function fillJson(value: unknown, fill: (text: string) => string): unknown {
  if (typeof value === "string") return fill(value);
  if (Array.isArray(value)) return value.map(one => fillJson(one, fill));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fillJson(one, fill)]));
  return value;
}

// ---- secrets for web requests ---------------------------------------------------

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
const secretsFile = (dir: string, repo: string) => join(dir, "flow-secrets", `${createHash("sha256").update(repo).digest("hex").slice(0, 24)}.json`);

export function readFlowSecrets(dir: string | null, repo: string): Record<string, string> {
  if (dir === null) return {};
  try { return JSON.parse(readFileSync(secretsFile(dir, repo), "utf8")) as Record<string, string>; } catch { return {}; }
}

export function flowSecretNames(dir: string | null, repo: string): string[] {
  return Object.keys(readFlowSecrets(dir, repo)).sort();
}

/** Set (or, with an empty value, remove) one of a project's request secrets. Names are CAPITALS_AND_UNDERSCORES. */
export function setFlowSecret(dir: string, repo: string, name: string, value: string): { ok: true; said: string } | { ok: false; message: string } {
  if (!SECRET_NAME.test(name)) return { ok: false, message: "Name the secret in capitals, like API_TOKEN." };
  const secrets = readFlowSecrets(dir, repo);
  const trimmed = value.trim();
  if (trimmed === "") delete secrets[name];
  else if (trimmed.length > 4000 || /[\r\n]/.test(trimmed)) return { ok: false, message: "That doesn't look like a secret: keep it to one line." };
  else secrets[name] = trimmed;
  mkdirSync(join(dir, "flow-secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(secretsFile(dir, repo), JSON.stringify(secrets), { mode: 0o600 });
  chmodSync(secretsFile(dir, repo), 0o600);
  return { ok: true, said: trimmed === "" ? `Removed ${name}.` : `Saved ${name}. It's used only in the headers of this project's web requests.` };
}

// ---- web requests ---------------------------------------------------------------

export type Fetcher = typeof fetch;

export async function runRequest(stage: FlowStage, card: FlowCardRow, repo: string, io: { fetch: Fetcher; dir: string | null }): Promise<ActionOutcome> {
  const request = stage.request!;
  const secrets = readFlowSecrets(io.dir, repo);
  const text = { title: card.title, description: card.description, note: card.note, outputs: card.outputs };
  const url = fillFlowText(request.url, text, encodeURIComponent);
  const missing: string[] = [];
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(request.headers)) {
    const withSecrets = template.replace(/\{\{\s*secret\.([A-Z][A-Z0-9_]*)\s*\}\}/g, (_match, secret: string) => {
      if (secrets[secret] === undefined) missing.push(secret);
      return secrets[secret] ?? "";
    });
    headers[name] = fillFlowText(withSecrets, text).replace(/[\r\n]+/g, " ");
  }
  if (missing.length > 0) return { state: "failed", said: `Set the secret${missing.length === 1 ? "" : "s"} ${[...new Set(missing)].join(", ")} on the step first.` };
  let body: string | undefined;
  if (request.body !== null && request.method !== "GET" && request.method !== "DELETE") {
    let parsed: unknown = undefined;
    try { parsed = JSON.parse(request.body); } catch { parsed = undefined; }
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
      body = JSON.stringify(fillJson(parsed, one => fillFlowText(one, text)));
      if (!Object.keys(headers).some(one => one.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    } else {
      body = fillFlowText(request.body, text);
      if (!Object.keys(headers).some(one => one.toLowerCase() === "content-type")) headers["content-type"] = "text/plain; charset=utf-8";
    }
  }
  const where = (() => { try { const parsed = new URL(url); return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`; } catch { return "the address"; } })();
  const shown = (() => { try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}${parsed.search === "" ? "" : "?…"}`; } catch { return url; } })();
  let response: Response;
  try {
    response = await io.fetch(url, { method: request.method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    return { state: "retry", said: `Couldn't reach ${where}${error instanceof Error && error.name === "TimeoutError" ? " within 30 seconds" : ""}.` };
  }
  const answered = blank(scrub(clip(await response.text().catch(() => ""), 64_000), secrets));
  const log = `${request.method} ${shown}\n→ ${response.status} ${response.statusText}\n\n${clip(answered, 16_000)}`;
  const first = answered.trim().split("\n")[0]?.slice(0, 160) ?? "";
  if (response.ok) return { state: "passed", said: `${where} answered ${response.status}.`, log, output: clip(answered, OUTPUT_CHARS) };
  if (response.status === 429 || response.status >= 500) return { state: "retry", said: `${where} answered ${response.status}${first === "" ? "" : `: ${first}`}.`, log };
  return { state: "failed", said: `${where} refused it (${response.status})${first === "" ? "" : `: ${first}`}.`, log, output: clip(answered, OUTPUT_CHARS) };
}

// ---- email ----------------------------------------------------------------------

/** The operator's mail server: everything but the password is shown back. */
export type EmailSettings = { host: string; port: number; secure: boolean; user: string; from: string };
const EMAIL_FILE = "email.json";
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export function readEmailSettings(dir: string | null): (EmailSettings & { password: string }) | null {
  if (dir === null || !existsSync(join(dir, EMAIL_FILE))) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dir, EMAIL_FILE), "utf8")) as Record<string, unknown>;
    if (typeof raw["host"] !== "string" || typeof raw["from"] !== "string") return null;
    return { host: raw["host"], port: Number(raw["port"]) || 587, secure: raw["secure"] === true, user: typeof raw["user"] === "string" ? raw["user"] : "", from: raw["from"], password: typeof raw["password"] === "string" ? raw["password"] : "" };
  } catch { return null; }
}

/** Save the mail server from Settings; an empty password keeps the saved one. */
export function saveEmailSettings(dir: string, input: { host: unknown; port: unknown; secure: unknown; user: unknown; from: unknown; password: unknown }): { ok: true; said: string } | { ok: false; message: string } {
  const host = typeof input.host === "string" ? input.host.trim() : "";
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return { ok: false, message: "Give the mail server's name, like smtp.gmail.com." };
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: "The port is a number, usually 587 or 465." };
  const from = typeof input.from === "string" ? input.from.trim() : "";
  if (!ADDRESS.test(from)) return { ok: false, message: "Give the address emails come from." };
  const user = typeof input.user === "string" ? input.user.trim().slice(0, 254) : "";
  const password = typeof input.password === "string" && input.password !== "" ? input.password : readEmailSettings(dir)?.password ?? "";
  writeFileSync(join(dir, EMAIL_FILE), JSON.stringify({ host, port, secure: input.secure === true || input.secure === "on" || input.secure === "true" || port === 465, user, from, password }), { mode: 0o600 });
  chmodSync(join(dir, EMAIL_FILE), 0o600);
  return { ok: true, said: `Email is set up: it comes from ${from}.` };
}

export type Mail = { from: string; to: string[]; subject: string; text: string };
export type MailSender = (settings: EmailSettings & { password: string }, mail: Mail) => Promise<{ ok: true; id: string } | { ok: false; said: string; permanent: boolean }>;

/** The production sender: the operator's mail server through nodemailer. */
export const sendThroughServer: MailSender = async (settings, mail) => {
  const transport = nodemailer.createTransport({
    // A password never travels unencrypted: with a sign-in, the connection must be (or become) TLS.
    host: settings.host, port: settings.port, secure: settings.secure, requireTLS: !settings.secure && settings.user !== "",
    ...(settings.user === "" ? {} : { auth: { user: settings.user, pass: settings.password } }),
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  try {
    const sent = await transport.sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text });
    return { ok: true, id: String(sent.messageId ?? "") };
  } catch (error) {
    const code = (error as { responseCode?: unknown }).responseCode;
    const said = typeof code === "number" && code === 535 ? "The mail server refused the sign-in. Check it in Settings → Email."
      : typeof code === "number" && code >= 500 ? `The mail server refused it (${code}).`
      : "Couldn't reach the mail server.";
    return { ok: false, said, permanent: typeof code === "number" && code >= 500 && code !== 535 };
  } finally {
    transport.close();
  }
};

export async function sendEmail(stage: FlowStage, card: FlowCardRow, io: { dir: string | null; mail?: MailSender }): Promise<ActionOutcome> {
  const settings = readEmailSettings(io.dir);
  if (settings === null) return { state: "retry", said: "Email isn't set up yet. Add your mail server in Settings → Email." };
  const text = { title: card.title, description: card.description, note: card.note, outputs: card.outputs };
  const email = stage.email!;
  const to = [...new Set(fillFlowText(email.to, text).split(/[\s,;]+/).map(one => one.trim()).filter(one => ADDRESS.test(one)))].slice(0, 10);
  if (to.length === 0) return { state: "failed", said: "There's no one to send it to: the card has no email address." };
  const subject = clip(fillFlowText(email.subject, text).replace(/[\r\n]+/g, " "), 200);
  const body = clip(fillFlowText(email.body, text), 20_000);
  if (body.trim() === "") return { state: "failed", said: "The email would be empty." };
  const sent = await (io.mail ?? sendThroughServer)(settings, { from: settings.from, to, subject, text: body });
  const log = `From ${settings.from} to ${to.join(", ")}\nSubject: ${subject}\n\n${blank(body)}`;
  if (!sent.ok) return { state: sent.permanent ? "failed" : "retry", said: sent.said, log };
  return { state: "passed", said: `Emailed ${to.join(", ")}.`, log, output: `Sent to ${to.join(", ")}: “${subject}”` };
}

// ---- tools ----------------------------------------------------------------------

export type ToolCaller = (spec: ToolSpec, values: Record<string, string>, name: string, args: Record<string, unknown>) => Promise<ToolCall>;

/** Whether the zone's tool is one of the project's, or what to say while it waits. */
export function toolWaiting(store: Store, stage: FlowStage, repo: string): string | null {
  const wanted = stage.tool?.server ?? "";
  return projectToolsOf(store, repo).some(one => one.name === wanted) ? null : `There's no tool called ${wanted || "(none)"} in this project. Add it on the Tools page.`;
}

export async function useTool(store: Store, stage: FlowStage, card: FlowCardRow, repo: string, io: { callTool?: ToolCaller; toolHome?: string }): Promise<ActionOutcome> {
  const call = stage.tool!;
  const tool = projectToolsOf(store, repo).find(one => one.name === call.server);
  if (tool === undefined) return { state: "retry", said: `There's no tool called ${call.server} in this project.` };
  const text = { title: card.title, description: card.description, note: card.note, outputs: card.outputs };
  const args = fillJson(JSON.parse(call.args), one => fillFlowText(one, text)) as Record<string, unknown>;
  const values = readToolSecrets(repo, tool.name, io.toolHome);
  const answer = await (io.callTool ?? ((spec, secrets, name, given) => callProjectTool(spec, secrets, name, given, { timeoutMs: 120_000, omitEnv: ALL_CREDENTIAL_ENV })))(tool.spec, values, call.name, args);
  if (!answer.ok) return { state: "retry", said: `${call.server}: ${answer.problem}` };
  const said = blank(scrub(clip(answer.text, 64_000), values));
  const log = `${call.server} → ${call.name}\n${blank(JSON.stringify(args, null, 2)).slice(0, 4000)}\n\n${clip(said, 16_000)}`;
  if (answer.isError) return { state: "failed", said: `${call.server} → ${call.name} said it failed${said.trim() === "" ? "" : `: ${said.trim().split("\n")[0]!.slice(0, 160)}`}.`, log, output: clip(said, OUTPUT_CHARS) };
  return { state: "passed", said: `${call.server} → ${call.name} done.`, log, output: clip(said, OUTPUT_CHARS) };
}
