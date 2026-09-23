/** Settings → Tools: one project's MCP servers. Adding anything, and every
 * secret, needs the password; a secret's value is never shown again; Test
 * starts the real server; "Found on this computer" copies a server in. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { projectToolsOf, readToolSecrets } from "./project-tools.js";

const PROBE = fileURLToPath(new URL("../scripts/fixtures/mcp-probe-server.mjs", import.meta.url));
let dir: string, home: string, repo: string, store: Store, password: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-tools-page-")));
  home = join(dir, "home");
  repo = join(dir, "shop");
  mkdirSync(home); mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("alex fixture");
  password = alex.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("a project's tools: add from the list or this computer with the password, set a secret that is never shown, test it, remove it", async () => {
  // This computer already has a server: the repository's own .mcp.json names one that needs a secret.
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [PROBE], env: { PROBE_SECRET: "from-mcp-json" } } } }));
  const server = createDecisionServer({ store, evidenceRoot: dir, repos: [repo], configDir: dir, toolHome: home, codexToolList: async () => "[]" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const page = async () => (await fetch(`${base}/settings/tools?repo=${encodeURIComponent(repo)}`, { headers: { cookie } })).text();
    let html = await page();
    expect(html).toContain("Builds in shop use exactly these tools. MCP servers set up elsewhere on this computer aren't used.");
    expect(html).toContain("No tools yet. Builds in this project get none.");
    expect(html).toContain("Found on this computer (1)");
    expect(html).toContain("Brings PROBE_SECRET");
    expect(html).not.toContain("from-mcp-json");
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const post = async (fields: Record<string, string | string[]>) => {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries({ csrf, repo, ...fields })) for (const one of [value].flat()) body.append(key, one);
      const answer = await fetch(`${base}/settings/tools/change`, { method: "POST", headers: { cookie, origin: base }, body, redirect: "manual" });
      expect(answer.status).toBe(303);
      return decodeURIComponent(new URL(answer.headers.get("location")!, base).search);
    };
    // Adding needs the password.
    expect(await post({ action: "add-catalog", catalog: "github", password: "wrong" })).toContain("Enter your Standing Orders password");
    expect(projectToolsOf(store, repo)).toEqual([]);
    expect(await post({ action: "add-catalog", catalog: "github", password })).toContain("Added GitHub. Set GITHUB_TOKEN below to finish.");
    html = await page();
    expect(html).toContain("Needs GITHUB_TOKEN");
    expect(html).toContain("https://api.githubcopilot.com/mcp/");
    // A secret is saved under the password and never rendered back.
    expect(await post({ action: "secret", name: "github", secret: "GITHUB_TOKEN", value: "ghp_example_value_123", password })).toContain("Saved GITHUB_TOKEN for github. It is never shown again.");
    expect(readToolSecrets(repo, "github", home)).toEqual({ GITHUB_TOKEN: "ghp_example_value_123" });
    html = await page();
    expect(html).not.toContain("ghp_example_value_123");
    expect(html).toContain("Replace GITHUB_TOKEN");
    // Found on this computer: copied in with its secret; Test starts the real server.
    expect(await post({ action: "import", import: "probe", password })).toContain("Added probe.");
    expect(readToolSecrets(repo, "probe", home)).toEqual({ PROBE_SECRET: "from-mcp-json" });
    expect(await post({ action: "test", name: "probe" })).toContain("probe works: 1 tool.");
    html = await page();
    expect(html).toContain("Working · 1 tool");
    expect(html).not.toContain("Found on this computer");
    // Your own: a command line with quotes, and the key it needs named, not typed.
    expect(await post({ action: "add-custom", name: "db", transport: "stdio", target: 'npx -y "some-db-mcp@1.2.3"', secrets: "DATABASE_URL", password })).toContain("Added db. Set DATABASE_URL below to finish.");
    expect(projectToolsOf(store, repo).find(one => one.name === "db")!.spec).toMatchObject({ command: "npx", args: ["-y", "some-db-mcp@1.2.3"] });
    // A token-shaped value, assembled here so this file never holds one.
    const tokenShaped = ["ghp", "x".repeat(36)].join("_");
    expect(await post({ action: "add-custom", name: "leaky", transport: "stdio", target: `npx some-mcp --token=${tokenShaped}`, password })).toContain("looks like a key or token");
    // Removing needs no password and takes it from every build.
    expect(await post({ action: "remove", name: "github" })).toContain("Removed github. No build uses it from now on.");
    expect(readToolSecrets(repo, "github", home)).toEqual({});
    expect(projectToolsOf(store, repo).map(one => one.name)).toEqual(["probe", "db"]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
