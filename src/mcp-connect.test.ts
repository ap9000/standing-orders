/**
 * One-click connections: Connect finds a service's sign-in, registers
 * this console, and sends the person there with PKCE; the code comes back as
 * tokens in the tool's secrets file (never the database); a tool of the same
 * name set up another way is never overwritten; and the worker renews a
 * sign-in before it runs out, trying a revoked one only now and then.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { addToolTo, catalogTool, projectToolsOf, readToolSecrets } from "./project-tools.js";
import { CONNECT_CALLBACK, connectionsOf, finishConnect, oneClickServices, refreshConnections, startConnect } from "./mcp-connect.js";

const T0 = new Date("2026-09-26T23:00:00.000Z");
let dir: string, repo: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-connect-")));
  repo = join(dir, "shop");
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Stripe's sign-in as its servers answer it, and every request that reaches it. */
function stripe(tokens: () => Record<string, unknown> = () => ({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })) {
  const seen: { url: string; method: string; body: string }[] = [];
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET", body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    seen.push({ url, method, body });
    if (url === "https://mcp.stripe.com/" && method === "POST") return reply(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer resource_metadata="https://mcp.stripe.com/.well-known/oauth-protected-resource"' });
    if (url === "https://mcp.stripe.com/.well-known/oauth-protected-resource") return reply(200, { resource: "https://mcp.stripe.com", authorization_servers: ["https://access.stripe.com/mcp"] });
    if (url === "https://access.stripe.com/.well-known/oauth-authorization-server/mcp") return reply(200, { authorization_endpoint: "https://access.stripe.com/mcp/oauth2/authorize", token_endpoint: "https://access.stripe.com/mcp/oauth2/token",
      registration_endpoint: "https://access.stripe.com/mcp/oauth2/register", code_challenge_methods_supported: ["S256"] });
    if (url === "https://access.stripe.com/mcp/oauth2/register") return reply(201, { client_id: "client-7" });
    if (url === "https://access.stripe.com/mcp/oauth2/token") return reply(200, tokens());
    return reply(404, {});
  }) as typeof fetch;
  return { fetcher, seen };
}

test("Connect registers this console and sends the person to sign in with PKCE, for the resource the server names", async () => {
  const { fetcher, seen } = stripe();
  const started = await startConnect({ service: "stripe", repo, by: "alex", origin: "http://127.0.0.1:4180", kit: "support-desk" }, fetcher, T0.getTime());
  if (!started.ok) throw new Error(started.said);
  const go = new URL(started.go);
  expect(go.origin + go.pathname).toBe("https://access.stripe.com/mcp/oauth2/authorize");
  expect(Object.fromEntries(go.searchParams)).toMatchObject({ response_type: "code", client_id: "client-7", redirect_uri: `http://127.0.0.1:4180${CONNECT_CALLBACK}`, code_challenge_method: "S256", state: started.state, resource: "https://mcp.stripe.com" });
  expect(go.searchParams.get("code_challenge")).toBe(createHash("sha256").update(started.visit.verifier).digest("base64url"));
  expect(JSON.parse(seen.find(one => one.url.endsWith("/register"))!.body)).toMatchObject({ redirect_uris: [`http://127.0.0.1:4180${CONNECT_CALLBACK}`], token_endpoint_auth_method: "none" });
  expect(started.visit).toMatchObject({ service: "stripe", repo, by: "alex", kit: "support-desk", resource: "https://mcp.stripe.com", expires: T0.getTime() + 15 * 60_000 });
});

test("the code becomes tokens in the tool's secrets file, never the database, and the tool joins the project", async () => {
  const { fetcher, seen } = stripe();
  const started = await startConnect({ service: "stripe", repo, by: "alex", origin: "http://127.0.0.1:4180" }, fetcher, T0.getTime());
  if (!started.ok) throw new Error(started.said);
  expect(await finishConnect(store, started.visit, "code-1", T0, { fetcher, home: dir, test: false })).toEqual({ ok: true, said: "Stripe is connected." });
  expect(new URLSearchParams(seen.at(-1)!.body).get("code_verifier")).toBe(started.visit.verifier);
  expect(Object.fromEntries(new URLSearchParams(seen.at(-1)!.body))).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: "client-7", resource: "https://mcp.stripe.com" });
  const [tool] = projectToolsOf(store, repo);
  expect(tool!.spec).toMatchObject({ name: "stripe", transport: "http", url: "https://mcp.stripe.com/", bearer: "OAUTH_ACCESS_TOKEN" });
  expect(readToolSecrets(repo, "stripe", dir)).toMatchObject({ OAUTH_ACCESS_TOKEN: "access-1", OAUTH_REFRESH_TOKEN: "refresh-1", OAUTH_CLIENT_ID: "client-7", OAUTH_EXPIRES_AT: "2026-09-27T00:00:00.000Z" });
  store.close();
  for (const file of ["orders.db", "orders.db-wal"].map(one => join(dir, one)).filter(existsSync)) expect(readFileSync(file).includes("refresh-1")).toBe(false);
  store = openStore(join(dir, "orders.db"));
  expect(connectionsOf(store, repo).find(one => one.id === "stripe")?.state).toBe("connected");
  // Signing in again keeps the one tool and replaces its tokens.
  const again = await startConnect({ service: "stripe", repo, by: "alex", origin: "http://127.0.0.1:4180" }, stripe(() => ({ access_token: "access-2" })).fetcher, T0.getTime());
  if (!again.ok) throw new Error(again.said);
  expect(await finishConnect(store, again.visit, "code-2", T0, { fetcher: stripe(() => ({ access_token: "access-2" })).fetcher, home: dir, test: false })).toMatchObject({ ok: true });
  expect(projectToolsOf(store, repo)).toHaveLength(1);
  expect(readToolSecrets(repo, "stripe", dir)["OAUTH_ACCESS_TOKEN"]).toBe("access-2");
});

test("a tool of the same name set up another way is never overwritten", async () => {
  const { label: _label, ...sentry } = catalogTool("sentry")!;
  expect(addToolTo(store, repo, sentry, "the common tools list", "alex", T0, { home: dir })).toMatchObject({ ok: true });
  expect(connectionsOf(store, repo).find(one => one.id === "sentry")?.state).toBe("taken");
  const visit = { service: "sentry", repo, by: "alex", kit: null, verifier: "v", clientId: "c", clientSecret: null, token: "https://mcp.sentry.dev/oauth/token", resource: "https://mcp.sentry.dev/mcp", redirect: "http://127.0.0.1:4180/x", expires: T0.getTime() + 60_000 };
  let asked = 0;
  const said = await finishConnect(store, visit, "code", T0, { fetcher: (async () => { asked++; return new Response("{}"); }) as typeof fetch, home: dir, test: false });
  expect(said).toEqual({ ok: false, said: "This project already has a tool called sentry, set up another way. Remove it on this page to connect Sentry by signing in." });
  expect(asked).toBe(0);
  expect(projectToolsOf(store, repo)[0]!.spec.transport).toBe("stdio");
});

test("the worker renews a sign-in that runs out within ten minutes, and tries a revoked one only every five", async () => {
  const { fetcher } = stripe(() => ({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 300 }));
  const started = await startConnect({ service: "stripe", repo, by: "alex", origin: "http://127.0.0.1:4180" }, fetcher, T0.getTime());
  if (!started.ok) throw new Error(started.said);
  await finishConnect(store, started.visit, "code-1", T0, { fetcher, home: dir, test: false });
  // Five minutes left: renewed, with its refresh token, for the same resource.
  const renewing = stripe(() => ({ access_token: "access-2", expires_in: 3600 }));
  expect(await refreshConnections(store, [repo], T0, { fetcher: renewing.fetcher, home: dir })).toEqual({ refreshed: 1, problems: [] });
  expect(Object.fromEntries(new URLSearchParams(renewing.seen[0]!.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "client-7", resource: "https://mcp.stripe.com" });
  expect(readToolSecrets(repo, "stripe", dir)).toMatchObject({ OAUTH_ACCESS_TOKEN: "access-2", OAUTH_REFRESH_TOKEN: "refresh-1", OAUTH_EXPIRES_AT: "2026-09-27T00:00:00.000Z" });
  // An hour left: nothing to do.
  const idle = stripe();
  expect(await refreshConnections(store, [repo], T0, { fetcher: idle.fetcher, home: dir })).toEqual({ refreshed: 0, problems: [] });
  expect(idle.seen).toHaveLength(0);
  // Revoked: said once, then left alone for five minutes.
  const late = new Date(T0.getTime() + 55 * 60_000);
  const revoked = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
  expect(await refreshConnections(store, [repo], late, { fetcher: revoked, home: dir })).toEqual({ refreshed: 0, problems: ["stripe: its sign-in ran out; connect it again on the Tools page"] });
  expect(await refreshConnections(store, [repo], new Date(late.getTime() + 60_000), { fetcher: revoked, home: dir })).toEqual({ refreshed: 0, problems: [] });
  expect((await refreshConnections(store, [repo], new Date(late.getTime() + 6 * 60_000), { fetcher: revoked, home: dir })).problems).toHaveLength(1);
});

test("a stand-in takes a service's place only at a loopback address", () => {
  expect(oneClickServices({ STANDING_ORDERS_TEST_CONNECT: "stripe|Stripe|http://127.0.0.1:5123/mcp" }).find(one => one.id === "stripe")?.url).toBe("http://127.0.0.1:5123/mcp");
  expect(oneClickServices({ STANDING_ORDERS_TEST_CONNECT: "stripe|Stripe|http://evil.example/mcp" }).find(one => one.id === "stripe")?.url).toBe("https://mcp.stripe.com/");
  expect(oneClickServices({ STANDING_ORDERS_TEST_CONNECT: "stripe|Stripe|https://127.0.0.1/mcp" }).find(one => one.id === "stripe")?.url).toBe("https://mcp.stripe.com/");
});
