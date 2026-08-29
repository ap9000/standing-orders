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
