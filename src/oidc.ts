/**
 * Sign-in with an identity provider (v100): OpenID Connect, the protocol
 * Okta, Microsoft Entra, Google Workspace, Auth0, Keycloak and JumpCloud all
 * speak. Discovery finds the provider's endpoints and keys; sign-in is the
 * authorization-code flow with PKCE, a state and a nonce; the ID token's
 * signature is checked against the provider's published keys (RS256, PS256,
 * ES256) along with its issuer, audience, expiry and nonce. Groups from the
 * token decide a person's role and projects, first matching rule wins.
 *
 * Addresses are https, except a provider on this computer (tests and local
 * development), the same loopback exception OAuth makes.
 */
import { createHash, createPublicKey, randomBytes, verify, constants, type webcrypto } from "node:crypto";

type JsonWebKey = webcrypto.JsonWebKey & { kid?: string; use?: string };

export type GroupRule = { group: string; role: "operator" | "viewer"; projects: "all" | string[] };
export type OidcSettings = {
  issuer: string; clientId: string; clientSecret: string | null;
  /** What the sign-in button says: "Okta", "Microsoft", "Google". */
  label: string;
  scopes: string;
  /** The ID token claim that lists a person's groups. */
  groupsClaim: string;
  rules: GroupRule[];
  /** Who may still sign in with a Standing Orders password once sign-in with the provider is on. */
  passwords: "everyone" | "operators";
};
export type OidcProvider = { issuer: string; authorize: string; token: string; jwks: string };
export type OidcClaims = { sub: string; email: string | null; name: string | null; username: string | null; groups: string[]; authTime: number | null };
type Fetch = typeof fetch;

const loopback = (value: string) => { try { const url = new URL(value); return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname); } catch { return false; } };
const secure = (value: unknown, issuer: string): value is string => {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:" || (loopback(issuer) && loopback(value)); } catch { return false; }
};
const trim = (url: string) => url.replace(/\/+$/, "");

/** The provider's endpoints, from its discovery document; its issuer must be the one configured. */
export async function discoverOidc(issuer: string, fetcher: Fetch = fetch): Promise<{ ok: true; provider: OidcProvider } | { ok: false; said: string }> {
  if (!secure(issuer, issuer)) return { ok: false, said: "The issuer must be an https address." };
  let document: Record<string, unknown>;
  try {
    const answer = await fetcher(`${trim(issuer)}/.well-known/openid-configuration`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!answer.ok) return { ok: false, said: `The provider's discovery document answered ${answer.status}.` };
    document = await answer.json() as Record<string, unknown>;
  } catch {
    return { ok: false, said: "The provider couldn't be reached." };
  }
  if (typeof document["issuer"] !== "string" || trim(document["issuer"]) !== trim(issuer)) return { ok: false, said: "The provider names a different issuer than the one set here." };
  const [authorize, token, jwks] = [document["authorization_endpoint"], document["token_endpoint"], document["jwks_uri"]];
  if (!secure(authorize, issuer) || !secure(token, issuer) || !secure(jwks, issuer)) return { ok: false, said: "The provider's discovery document is missing its endpoints." };
  return { ok: true, provider: { issuer: document["issuer"], authorize, token, jwks } };
}

/** The pieces a sign-in needs to come back to: kept by the console, and its state in a cookie on the browser that started it. */
export type OidcVisit = { state: string; nonce: string; verifier: string };
export function newOidcVisit(): OidcVisit {
  return { state: randomBytes(24).toString("base64url"), nonce: randomBytes(24).toString("base64url"), verifier: randomBytes(32).toString("base64url") };
}

/** Where to send the person to sign in. `reauth` asks the provider to check them again now (a step-up). */
export function oidcAuthorizeUrl(provider: OidcProvider, settings: OidcSettings, visit: OidcVisit, redirectUri: string, reauth = false): string {
  const url = new URL(provider.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", settings.scopes);
  url.searchParams.set("state", visit.state);
  url.searchParams.set("nonce", visit.nonce);
  url.searchParams.set("code_challenge", createHash("sha256").update(visit.verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  if (reauth) { url.searchParams.set("prompt", "login"); url.searchParams.set("max_age", "0"); }
  return url.toString();
}

/** The code, traded for the ID token. */
export async function exchangeOidcCode(provider: OidcProvider, settings: OidcSettings, code: string, visit: OidcVisit, redirectUri: string, fetcher: Fetch = fetch): Promise<{ ok: true; idToken: string } | { ok: false; said: string }> {
  try {
    const answer = await fetcher(provider.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, signal: AbortSignal.timeout(15_000),
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: settings.clientId, code_verifier: visit.verifier, ...(settings.clientSecret === null ? {} : { client_secret: settings.clientSecret }) }) });
    const body = await answer.json() as Record<string, unknown>;
    if (!answer.ok || typeof body["id_token"] !== "string") return { ok: false, said: `The provider didn't finish the sign-in (${typeof body["error"] === "string" ? body["error"] : `HTTP ${answer.status}`}).` };
    return { ok: true, idToken: body["id_token"] };
  } catch {
    return { ok: false, said: "The provider couldn't be reached to finish the sign-in." };
  }
}

const keyCache = new Map<string, { at: number; keys: JsonWebKey[] }>();
async function providerKeys(jwks: string, fetcher: Fetch, fresh: boolean): Promise<JsonWebKey[]> {
  const held = keyCache.get(jwks);
  if (!fresh && held !== undefined && Date.now() - held.at < 10 * 60_000) return held.keys;
  const answer = await fetcher(jwks, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  const body = await answer.json() as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? body.keys.filter((one): one is JsonWebKey => one !== null && typeof one === "object") : [];
  keyCache.set(jwks, { at: Date.now(), keys });
  return keys;
}

const ALGORITHMS: Record<string, { hash: string; padding?: number; saltLength?: number; dsaEncoding?: "ieee-p1363"; kty: string }> = {
  RS256: { hash: "sha256", kty: "RSA" },
  PS256: { hash: "sha256", padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32, kty: "RSA" },
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363", kty: "EC" },
};
const decode = (part: string): Record<string, unknown> | null => {
  try { const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown; return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
};

/** Check the ID token: its signature by one of the provider's keys, then who issued it, for whom, until when, and for which sign-in. */
export async function verifyIdToken(idToken: string, provider: OidcProvider, settings: OidcSettings, nonce: string, now: Date, fetcher: Fetch = fetch): Promise<{ ok: true; claims: OidcClaims } | { ok: false; said: string }> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, said: "The provider's token isn't a signed token." };
  const header = decode(parts[0]!), claims = decode(parts[1]!);
  if (header === null || claims === null) return { ok: false, said: "The provider's token couldn't be read." };
  const algorithm = typeof header["alg"] === "string" ? ALGORITHMS[header["alg"]] : undefined;
  if (algorithm === undefined) return { ok: false, said: `The provider signs with ${String(header["alg"])}, which isn't accepted.` };
  const kid = typeof header["kid"] === "string" ? header["kid"] : null;
  const pick = (keys: JsonWebKey[]) => keys.filter(key => key.kty === algorithm.kty && (kid === null || key.kid === kid) && (key.use === undefined || key.use === "sig"));
  let candidates: JsonWebKey[];
  try {
    candidates = pick(await providerKeys(provider.jwks, fetcher, false));
    if (candidates.length === 0) candidates = pick(await providerKeys(provider.jwks, fetcher, true)); // the provider may have rotated its keys
  } catch {
    return { ok: false, said: "The provider's keys couldn't be read." };
  }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`), signature = Buffer.from(parts[2]!, "base64url");
  const good = candidates.some(jwk => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return verify(algorithm.hash, signed, { key, ...(algorithm.padding === undefined ? {} : { padding: algorithm.padding, saltLength: algorithm.saltLength }), ...(algorithm.dsaEncoding === undefined ? {} : { dsaEncoding: algorithm.dsaEncoding }) }, signature);
    } catch { return false; }
  });
  if (!good) return { ok: false, said: "The provider's token isn't signed by the provider." };
  const seconds = Math.floor(now.getTime() / 1000);
  const audience = Array.isArray(claims["aud"]) ? claims["aud"] : [claims["aud"]];
  if (typeof claims["iss"] !== "string" || trim(claims["iss"]) !== trim(provider.issuer)) return { ok: false, said: "The token comes from a different issuer." };
  if (!audience.includes(settings.clientId) || (audience.length > 1 && claims["azp"] !== undefined && claims["azp"] !== settings.clientId)) return { ok: false, said: "The token is for a different app." };
  if (typeof claims["exp"] !== "number" || claims["exp"] < seconds - 60) return { ok: false, said: "The sign-in expired. Try again." };
  if (typeof claims["iat"] === "number" && claims["iat"] > seconds + 300) return { ok: false, said: "The token's time is in the future. Check this computer's clock." };
  if (claims["nonce"] !== nonce) return { ok: false, said: "The sign-in didn't match. Try again." };
  if (typeof claims["sub"] !== "string" || claims["sub"] === "") return { ok: false, said: "The token doesn't say who signed in." };
  const text = (key: string) => typeof claims[key] === "string" && claims[key] !== "" ? claims[key] as string : null;
  const rawGroups = claims[settings.groupsClaim];
  const groups = Array.isArray(rawGroups) ? rawGroups.filter((one): one is string => typeof one === "string") : typeof rawGroups === "string" ? [rawGroups] : [];
  // An address the provider hasn't checked names no one.
  const email = claims["email_verified"] === false ? null : text("email");
  return { ok: true, claims: { sub: claims["sub"], email, name: text("name"), username: text("preferred_username"), groups: groups.slice(0, 200), authTime: typeof claims["auth_time"] === "number" ? claims["auth_time"] : null } };
}

/** A person's role and projects from their groups: the first rule that matches ("*" matches everyone), or none. */
export function accessFromGroups(groups: readonly string[], rules: readonly GroupRule[]): GroupRule | null {
  return rules.find(rule => rule.group === "*" || groups.includes(rule.group)) ?? null;
}

/** An account name for someone new: from their username or email, in the characters names allow, made unique. */
export function accountNameFor(claims: OidcClaims, taken: (name: string) => boolean): string {
  const source = claims.username ?? claims.email ?? claims.name ?? "person";
  const local = source.includes("@") ? source.slice(0, source.indexOf("@")) : source;
  const base = local.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/-+$/, "").slice(0, 36) || "person";
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  return `${base.slice(0, 27)}-${randomBytes(4).toString("hex")}`;
}
