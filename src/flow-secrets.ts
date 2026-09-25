/**
 * A project's flow secrets (v87; v90 for scripts too): named values kept in
 * a 0600 file beside the database, one file per project. Web requests use
 * them in headers ({{secret.NAME}}), and code steps get the ones they name as
 * environment variables. Their values never reach a card, a log or a page.
 * Its own module, with nothing but the file system, so triggers and the step
 * runners can read it without an import cycle.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
const secretsFile = (dir: string, repo: string) => join(dir, "flow-secrets", `${createHash("sha256").update(repo).digest("hex").slice(0, 24)}.json`);

/** Any saved secret's value that shows up in output, replaced (a web response, a tool's answer, a script's output). */
export const scrubSecrets = (text: string, secrets: Record<string, string>) => Object.values(secrets).filter(value => value.length >= 6).reduce((out, value) => out.split(value).join("[secret]"), text);

export function readFlowSecrets(dir: string | null, repo: string): Record<string, string> {
  if (dir === null) return {};
  try { return JSON.parse(readFileSync(secretsFile(dir, repo), "utf8")) as Record<string, string>; } catch { return {}; }
}

export function flowSecretNames(dir: string | null, repo: string): string[] {
  return Object.keys(readFlowSecrets(dir, repo)).sort();
}

/** Set (or, with an empty value, remove) one of a project's secrets. Names are CAPITALS_AND_UNDERSCORES. */
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
  return { ok: true, said: trimmed === "" ? `Removed ${name}.` : `Saved ${name}. Only this project's web requests and scripts that name it get it.` };
}
