/** Non-spending account checks. Only normalized facts leave this module. */
import { homedir } from "node:os";
import { run, type ExecResult } from "./exec.js";
import { ALL_CREDENTIAL_ENV, inspectionOf, type ProviderId } from "./provider.js";
import { keyStatus, PROVIDER_KEY_ENV, readAuthMode, type AuthMode } from "./keys.js";

export type ProviderConnection = {
  state: "connected" | "signed-out" | "not-installed" | "unverified" | "key-present" | "missing-key";
  mode: AuthMode;
  email?: string;
  plan?: string;
  method?: string;
  checkedAt: string;
};
export type ConnectionChecker = (provider: ProviderId, fresh?: boolean) => Promise<ProviderConnection>;

export function signInFacts(provider: ProviderId, result: ExecResult, now = new Date()): ProviderConnection {
  const base = { mode: "subscription" as const, checkedAt: now.toISOString() };
  if (result.notFound) return { ...base, state: "not-installed" };
  if (result.timedOut) return { ...base, state: "unverified" };
  if (provider === "claude") {
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown> | null;
      if (value?.loggedIn === false && (result.code === 0 || result.code === 1)) return { ...base, state: "signed-out" };
      if (value?.loggedIn !== true || result.code !== 0) return { ...base, state: "unverified" };
      const email = typeof value.email === "string" && value.email.length <= 254 && /^[\x21-\x7e]+$/.test(value.email) && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(value.email) ? value.email : undefined;
      const plans: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };
      const methods: Record<string, string> = { "claude.ai": "Claude account", api_key: "API key", bedrock: "Amazon Bedrock", vertex: "Google Vertex AI" };
      const plan = typeof value.subscriptionType === "string" && Object.hasOwn(plans, value.subscriptionType) ? plans[value.subscriptionType] : undefined;
      const method = typeof value.authMethod === "string" && Object.hasOwn(methods, value.authMethod) ? methods[value.authMethod] : undefined;
      return { ...base, state: "connected", ...(email ? { email } : {}), ...(plan ? { plan } : {}), ...(method ? { method } : {}) };
    } catch { return { ...base, state: "unverified" }; }
  }
  if (provider === "codex") {
    const text = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0 && /^Logged in using ChatGPT\s*$/m.test(text)) return { ...base, state: "connected", method: "ChatGPT account" };
    if (result.code === 0 && /^Logged in using an? API key\b/m.test(text)) return { ...base, state: "connected", method: "API key" };
    if (result.code === 1 && /^Not logged in\s*$/m.test(text)) return { ...base, state: "signed-out" };
  }
  return { ...base, state: "unverified" };
}

export function createConnectionChecker(options: { probe?: typeof run; home?: string; clock?: () => Date; env?: NodeJS.ProcessEnv } = {}): ConnectionChecker {
  const probe = options.probe ?? run;
  const home = options.home ?? homedir();
  const clock = options.clock ?? (() => new Date());
  const cache = new Map<ProviderId, { key: string; until: number; value: ProviderConnection }>();
  const pending = new Map<string, Promise<ProviderConnection>>();
  return async (provider, fresh = false) => {
    const mode = readAuthMode(provider, home);
    const keyFacts = keyStatus(provider, home);
    const ambient = !!(options.env ?? process.env)[PROVIDER_KEY_ENV[provider]];
    const key = JSON.stringify([provider, mode, keyFacts.set, keyFacts.updatedAt, ambient]);
    const now = clock();
    const existing = cache.get(provider);
    if (!fresh && existing?.key === key && existing.until > now.getTime()) return existing.value;
    const inFlight = pending.get(key); if (inFlight) return inFlight;
    const check = (async (): Promise<ProviderConnection> => {
      if (mode === "api-key") return { state: keyFacts.set || ambient ? "key-present" : "missing-key", mode, checkedAt: now.toISOString() };
      const facts = inspectionOf(provider);
      if (facts.identityProbe === null) return { state: "unverified", mode, checkedAt: now.toISOString() };
      try {
        // Same subscription credential stripping as provider invocations.
        // No model prompt, repository scripts, or stored API keys are used.
        const result = await probe(facts.binary, [...facts.identityProbe], { cwd: home, timeoutMs: 5000, maxBuffer: 32 * 1024, omitEnv: ALL_CREDENTIAL_ENV });
        return signInFacts(provider, result, clock());
      } catch { return { state: "unverified", mode, checkedAt: clock().toISOString() }; }
    })();
    pending.set(key, check);
    try { const value = await check; cache.set(provider, { key, until: clock().getTime() + 30_000, value }); return value; }
    finally { pending.delete(key); }
  };
}
