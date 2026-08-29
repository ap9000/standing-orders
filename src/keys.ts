/**
 * Provider API keys, managed instead of ambient (the gap the gemini
 * live-auth work exposed): one 0600 file per provider under
 * ~/.standing-orders/keys/, written from the settings card or piped into
 * the CLI — never typed into an argv, never rendered back, never stored
 * in the database a backup might carry.
 *
 * The injection contract lives in the invocation gateway: a stored key is
 * added to EXACTLY its own provider's child environment at spawn, where
 * the adapter's foreign-credential strip has already shed everybody
 * else's. The plane's own process never needs the key in its environment
 * at all — a restart or a rotation is a file write, not a relaunch — and
 * an ambient env var still works as the fallback it always was (the file,
 * being deliberate, wins).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "./provider.js";

/** The ONE env name each provider's own harness reads its key from. */
export const PROVIDER_KEY_ENV: Record<ProviderId, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function keysDir(home: string = homedir()): string {
  return join(home, ".standing-orders", "keys");
}

export function keyFileFor(provider: ProviderId, home: string = homedir()): string {
  return join(keysDir(home), provider);
}

/** Shape check only — never a validity claim. A key is printable ASCII
 * without whitespace, bounded; anything else is a paste accident. */
export function plausibleKey(value: string): boolean {
  return value.length >= 8 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

export function saveProviderKey(
  provider: ProviderId,
  value: string,
  home: string = homedir(),
): { ok: true } | { ok: false; reason: "implausible" } {
  const trimmed = value.trim();
  if (!plausibleKey(trimmed)) return { ok: false, reason: "implausible" };
  mkdirSync(keysDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(keyFileFor(provider, home), trimmed, { mode: 0o600 });
  // An existing file keeps its old mode through writeFileSync — restate it.
  chmodSync(keyFileFor(provider, home), 0o600);
  return { ok: true };
}

export function readProviderKey(provider: ProviderId, home: string = homedir()): string | null {
  try {
    const value = readFileSync(keyFileFor(provider, home), "utf8").trim();
    return plausibleKey(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearProviderKey(provider: ProviderId, home: string = homedir()): boolean {
  const file = keyFileFor(provider, home);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * A live credential check that spends NO tokens: each provider exposes a
 * cheap authenticated GET (its model list, or a key-info route) whose only
 * job here is to make the provider's own auth boundary answer yes or no.
 * Injectable fetcher (the converse.ts precedent) so tests never touch the
 * network. Distinguishes a REJECTED key (bad/expired/wrong provider) from
 * an UNREACHABLE provider (offline, blocked) — the operator needs to know
 * which, because only one of them means "fix the key".
 */
export type KeyVerdict =
  | { ok: true }
  | { ok: false; reason: "rejected"; status: number }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "unexpected"; status: number };

const VERIFY_ENDPOINT: Record<ProviderId, { url: string; headers: (key: string) => Record<string, string> }> = {
  gemini: {
    // The key rides a query param on Google's endpoint — never logged here,
    // and the request is HTTPS to Google's own host.
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    headers: () => ({}),
  },
  codex: {
    url: "https://api.openai.com/v1/models",
    headers: key => ({ authorization: `Bearer ${key}` }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/key",
    headers: key => ({ authorization: `Bearer ${key}` }),
  },
  claude: {
    url: "https://api.anthropic.com/v1/models",
    headers: key => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
};

export async function verifyProviderKey(
  provider: ProviderId,
  value: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<KeyVerdict> {
  const key = value.trim();
  if (!plausibleKey(key)) return { ok: false, reason: "rejected", status: 0 };
  const endpoint = VERIFY_ENDPOINT[provider];
  const url = provider === "gemini" ? `${endpoint.url}?key=${encodeURIComponent(key)}` : endpoint.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetcher(url, { headers: endpoint.headers(key), redirect: "error", signal: controller.signal });
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 200) return { ok: true };
  // 401/403 (and Google's 400 on a bad key) are the auth boundary saying no.
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return { ok: false, reason: "rejected", status: response.status };
  }
  return { ok: false, reason: "unexpected", status: response.status };
}

/** Words for a verdict, safe to render on any surface (never the key). */
export function verdictWords(provider: ProviderId, verdict: KeyVerdict): string {
  if (verdict.ok) return `the ${provider} key works`;
  if (verdict.reason === "rejected") return `${provider} rejected this key — check the paste, or whether it is the right provider`;
  if (verdict.reason === "unreachable") return `couldn't reach ${provider} to check the key — it is stored; verify later`;
  return `${provider} gave an unexpected response (${verdict.status}) — the key is stored, but unverified`;
}

/** What a surface may say about a key: that it exists and when it last
 * changed — NEVER the value, never a prefix, never a length. */
export function keyStatus(provider: ProviderId, home: string = homedir()): { set: boolean; updatedAt: string | null } {
  try {
    const stat = statSync(keyFileFor(provider, home));
    return { set: true, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { set: false, updatedAt: null };
  }
}
