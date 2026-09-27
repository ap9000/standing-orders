/**
 * Sign-in with an identity provider (v100): only a token the provider
 * signed, for this app, for this sign-in, still in date, names a person; their
 * groups pick their role and projects; new names fit the account rules.
 */
import { expect, test } from "vitest";
import { createHash, generateKeyPairSync, sign, constants, type KeyObject } from "node:crypto";
import { accessFromGroups, accountNameFor, discoverOidc, exchangeOidcCode, newOidcVisit, oidcAuthorizeUrl, verifyIdToken, type OidcProvider, type OidcSettings } from "./oidc.js";

const ISSUER = "https://sso.example.com/oauth2/default";
const settings: OidcSettings = { issuer: ISSUER, clientId: "standing-orders", clientSecret: "shh", label: "Okta", scopes: "openid email profile groups", groupsClaim: "groups",
  rules: [{ group: "eng-leads", role: "operator", projects: "all" }, { group: "eng", role: "viewer", projects: ["/repo/a"] }], passwords: "operators" };
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }), ec = generateKeyPairSync("ec", { namedCurve: "P-256" }), stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = (key: KeyObject, kid: string) => ({ ...key.export({ format: "jwk" }), kid, use: "sig" });
const NOW = new Date("2026-09-27T20:00:00.000Z"), T = Math.floor(NOW.getTime() / 1000);

let keys = [jwk(rsa.publicKey, "r1"), jwk(ec.publicKey, "e1")];
let fetched = 0;
const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/v1/authorize`, token_endpoint: `${ISSUER}/v1/token`, jwks_uri: `${ISSUER}/v1/keys` });
  if (url === `${ISSUER}/v1/keys`) { fetched++; return json({ keys }); }
  if (url === `${ISSUER}/v1/token`) {
    const form = new URLSearchParams(String(init?.body));
    return form.get("code") === "good-code" ? json({ id_token: "the.id.token", access_token: "at" }) : json({ error: "invalid_grant" }, 400);
  }
  return json({}, 404);
}) as typeof fetch;

function token(claims: Record<string, unknown>, options: { alg?: string; kid?: string; key?: KeyObject } = {}): string {
  const alg = options.alg ?? "RS256";
  const header = Buffer.from(JSON.stringify({ alg, kid: options.kid ?? (alg === "ES256" ? "e1" : "r1"), typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: ISSUER, aud: "standing-orders", sub: "00u1", exp: T + 3600, iat: T, nonce: "n-1", email: "Priya.Shah@acme.com", groups: ["eng"], ...claims })).toString("base64url");
  const data = Buffer.from(`${header}.${body}`);
  const signature = alg === "none" ? Buffer.alloc(0)
    : alg === "ES256" ? sign("sha256", data, { key: options.key ?? ec.privateKey, dsaEncoding: "ieee-p1363" })
    : alg === "PS256" ? sign("sha256", data, { key: options.key ?? rsa.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
    : sign("sha256", data, options.key ?? rsa.privateKey);
  return `${header}.${body}.${signature.toString("base64url")}`;
}

const provider: OidcProvider = { issuer: ISSUER, authorize: `${ISSUER}/v1/authorize`, token: `${ISSUER}/v1/token`, jwks: `${ISSUER}/v1/keys` };

test("discovery finds the endpoints, and refuses a document for another issuer or an address that isn't https", async () => {
  expect(await discoverOidc(ISSUER, fetcher)).toEqual({ ok: true, provider });
  expect(await discoverOidc(`${ISSUER}/`, fetcher)).toMatchObject({ ok: true });
  const other = (async () => new Response(JSON.stringify({ issuer: "https://evil.example.com", authorization_endpoint: "https://evil.example.com/a", token_endpoint: "https://evil.example.com/t", jwks_uri: "https://evil.example.com/k" }))) as typeof fetch;
  expect(await discoverOidc(ISSUER, other)).toEqual({ ok: false, said: "The provider names a different issuer than the one set here." });
  expect(await discoverOidc("http://sso.example.com", fetcher)).toEqual({ ok: false, said: "The issuer must be an https address." });
});

test("the sign-in address carries PKCE, state and nonce; a step-up asks the provider to check again", () => {
  const visit = newOidcVisit();
  const url = new URL(oidcAuthorizeUrl(provider, settings, visit, "https://so.acme.com/login/sso/callback"));
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: "code", client_id: "standing-orders", redirect_uri: "https://so.acme.com/login/sso/callback", scope: "openid email profile groups",
    state: visit.state, nonce: visit.nonce, code_challenge: createHash("sha256").update(visit.verifier).digest("base64url"), code_challenge_method: "S256" });
  expect(url.searchParams.has("prompt")).toBe(false);
  const again = new URL(oidcAuthorizeUrl(provider, settings, visit, "https://so.acme.com/login/sso/callback", true));
  expect([again.searchParams.get("prompt"), again.searchParams.get("max_age")]).toEqual(["login", "0"]);
});

test("the code is traded with the verifier; a refused code says why", async () => {
  const visit = newOidcVisit();
  expect(await exchangeOidcCode(provider, settings, "good-code", visit, "https://so.acme.com/cb", fetcher)).toEqual({ ok: true, idToken: "the.id.token" });
  expect(await exchangeOidcCode(provider, settings, "old-code", visit, "https://so.acme.com/cb", fetcher)).toEqual({ ok: false, said: "The provider didn't finish the sign-in (invalid_grant)." });
});

test("only a token the provider signed, for this app and this sign-in, still in date, names a person", async () => {
  for (const alg of ["RS256", "PS256", "ES256"]) {
    expect(await verifyIdToken(token({}, { alg }), provider, settings, "n-1", NOW, fetcher), alg).toEqual({ ok: true, claims: { sub: "00u1", email: "Priya.Shah@acme.com", name: null, username: null, groups: ["eng"], authTime: null } });
  }
  const refused = async (id: string) => ((await verifyIdToken(id, provider, settings, "n-1", NOW, fetcher)) as { said: string }).said;
  expect(await refused(token({}, { key: stranger.privateKey }))).toBe("The provider's token isn't signed by the provider.");
  expect(await refused(token({}, { alg: "none" }))).toBe("The provider signs with none, which isn't accepted.");
  expect(await refused(token({}, { alg: "HS256" }))).toBe("The provider signs with HS256, which isn't accepted.");
  expect(await refused(token({ iss: "https://evil.example.com" }))).toBe("The token comes from a different issuer.");
  expect(await refused(token({ aud: "another-app" }))).toBe("The token is for a different app.");
  expect(await refused(token({ exp: T - 120 }))).toBe("The sign-in expired. Try again.");
  expect(await refused(token({ nonce: "n-2" }))).toBe("The sign-in didn't match. Try again.");
  expect(await refused("not-a-token")).toBe("The provider's token isn't a signed token.");
  // An address the provider hasn't checked names no one; a single group claim is a list of one.
  expect(await verifyIdToken(token({ email_verified: false, groups: "eng-leads" }), provider, settings, "n-1", NOW, fetcher)).toMatchObject({ ok: true, claims: { email: null, groups: ["eng-leads"] } });
});

test("a key the provider rotated in is fetched again, once", async () => {
  const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keys = [...keys, jwk(rotated.publicKey, "r2")];
  const before = fetched;
  expect(await verifyIdToken(token({}, { kid: "r2", key: rotated.privateKey }), provider, settings, "n-1", NOW, fetcher)).toMatchObject({ ok: true });
  expect(fetched).toBe(before + 1);
});

test("groups pick the role and projects, first rule wins; a new name fits the account rules and doesn't collide", () => {
  expect(accessFromGroups(["eng", "eng-leads"], settings.rules)).toEqual({ group: "eng-leads", role: "operator", projects: "all" });
  expect(accessFromGroups(["eng"], settings.rules)).toEqual({ group: "eng", role: "viewer", projects: ["/repo/a"] });
  expect(accessFromGroups(["sales"], settings.rules)).toBeNull();
  expect(accessFromGroups(["sales"], [...settings.rules, { group: "*", role: "viewer", projects: [] }])).toMatchObject({ group: "*" });
  const claims = { sub: "1", email: "Priya.Shah+so@acme.com", name: "Priya Shah", username: null, groups: [], authTime: null };
  expect(accountNameFor(claims, () => false)).toBe("Priya.Shah-so");
  expect(accountNameFor({ ...claims, username: "priya" }, name => name === "priya")).toBe("priya-2");
  expect(accountNameFor({ ...claims, email: null, name: "Zoë Ångström" }, () => false)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
});
