/**
 * Project tools: each project's builds get exactly its MCP servers — none
 * of the operator's global ones, a plugin's, or a repository's own — sealed
 * at approval, with secret values kept out of the database, the argv and
 * (for Codex) the agent's environment. Real processes: the probe server
 * fixture, a local web MCP server, and the launcher itself.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { invokeAgent } from "./invoke.js";
import {
  TOOL_CATALOG, addToolTo, carriedCodexSettings, catalogTool, claudeToolArgs, codexToolArgs, discoverTools, prepareRunTools, projectToolsOf,
  readToolSecrets, removeToolFrom, secretsSetFor, setToolSecret, splitCommandLine, testTool, testToolOf, toolDigest, toolLaunchFor,
  toolSecretsDir, validateToolSpec, type ToolSpec,
} from "./project-tools.js";

const T0 = new Date("2026-09-23T12:00:00.000Z");
const PROBE = fileURLToPath(new URL("../scripts/fixtures/mcp-probe-server.mjs", import.meta.url));
const LAUNCHER = fileURLToPath(new URL("./tool-launcher.ts", import.meta.url));
/** The launcher run from source in tests (built, it is dist/tool-launcher.js). */
const launcherArgs = (file: string) => ["--experimental-strip-types", "--no-warnings", LAUNCHER, file];
const probeSpec = (name = "probe"): ToolSpec => validateToolSpec({ name, command: process.execPath, args: [PROBE], secrets: [{ name: "PROBE_SECRET", optional: false }], about: "The test probe." });

/** A local web MCP server that wants `Authorization: Bearer good-token`. */
function webServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.headers["authorization"] !== "Bearer good-token") { response.writeHead(401).end(); return; }
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "web", version: "1" } }
        : message.method === "tools/list" ? { tools: [{ name: "web_lookup", inputSchema: { type: "object" } }] } : {};
      // Answer as an event stream, the way streamable HTTP servers often do.
      response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s-1" });
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise(done => server.close(() => done())) });
  }));
}

describe("project tools", () => {
  let dir: string;
  let home: string;
  let repo: string;
  let store: Store;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-tools-")));
    home = join(dir, "home");
    repo = join(dir, "app");
    mkdirSync(home); mkdirSync(repo);
    store = openStore(join(dir, "orders.db"));
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  test("a tool definition is checked whole: names, safe addresses, no key typed into a command, no reserved names", () => {
    for (const one of TOOL_CATALOG) {
      const { label: _label, ...spec } = one;
      expect(validateToolSpec(spec as unknown as Record<string, unknown>)).toEqual(spec);
    }
    expect(catalogTool("playwright")?.args).toContain("@playwright/mcp@0.0.82");
    expect(() => validateToolSpec({ name: "Bad Name", command: "npx" })).toThrow(/lowercase/);
    // A key-shaped value, assembled here so this file never holds one.
    const keyShaped = ["sk", "ant", "api03", "x".repeat(40)].join("-");
    expect(() => validateToolSpec({ name: "leaky", command: "npx", args: ["-y", "some-mcp", `--api-key=${keyShaped}`] })).toThrow(/key or token/);
    expect(() => validateToolSpec({ name: "plain", transport: "http", url: "http://example.com/mcp" })).toThrow(/https/);
    expect(validateToolSpec({ name: "local", transport: "http", url: "http://localhost:3000/mcp" }).url).toBe("http://localhost:3000/mcp");
    expect(() => validateToolSpec({ name: "sneaky", command: "npx", secrets: ["PATH"] })).toThrow(/reserved/);
    expect(() => validateToolSpec({ name: "creds", transport: "http", url: "https://user:pw@example.com/mcp" })).toThrow(/credentials/);
    // The digest is what a build is held to: how it starts and which secrets it names, not its description.
    const spec = probeSpec();
    expect(toolDigest({ ...spec, about: "different words" })).toBe(toolDigest(spec));
    expect(toolDigest({ ...spec, args: [...spec.args, "--extra"] })).not.toBe(toolDigest(spec));
    expect(splitCommandLine(`npx -y "@scope/pkg@1.0.0" --flag 'two words'`)).toEqual(["npx", "-y", "@scope/pkg@1.0.0", "--flag", "two words"]);
  });

  test("secrets live in one private file per tool, never in the database; removing a tool deletes them", () => {
    const added = addToolTo(store, repo, probeSpec(), "test", "alex", T0, { home });
    expect(added.ok).toBe(true);
    setToolSecret(repo, "probe", "PROBE_SECRET", "value-one", home);
    expect(readToolSecrets(repo, "probe", home)).toEqual({ PROBE_SECRET: "value-one" });
    expect(secretsSetFor(repo, probeSpec(), home)).toEqual(["PROBE_SECRET"]);
    const dirStat = statSync(toolSecretsDir(home));
    expect(dirStat.mode & 0o777).toBe(0o700);
    const file = join(toolSecretsDir(home), readdirOnly(toolSecretsDir(home)), "probe.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const dump = JSON.stringify(store.raw().prepare("SELECT * FROM project_tool").all());
    expect(dump).not.toContain("value-one");
    expect(() => setToolSecret(repo, "probe", "PATH", "x", home)).toThrow();
    expect(() => setToolSecret(repo, "probe", "PROBE_SECRET", "two\nlines", home)).toThrow(/one line/);
    expect(addToolTo(store, repo, probeSpec(), "test", "alex", T0, { home })).toMatchObject({ ok: false, message: expect.stringContaining("already has a tool called probe") });
    expect(removeToolFrom(store, repo, "probe", "alex", T0, home)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(projectToolsOf(store, repo)).toEqual([]);
  });

  test("Test starts the server and lists its tools: a local program, a web address, and plain reasons when either fails", async () => {
    expect(await testTool(probeSpec(), {})).toEqual({ ok: false, problem: "Set PROBE_SECRET first." });
    expect(await testTool(probeSpec(), { PROBE_SECRET: "x" })).toEqual({ ok: true, tools: ["probe_status"] });
    expect(await testTool(validateToolSpec({ name: "missing", command: join(dir, "no-such-program") }), {}, { timeoutMs: 5_000 })).toMatchObject({ ok: false, problem: expect.stringMatching(/could not start|stopped/) });
    const web = await webServer();
    try {
      const spec = validateToolSpec({ name: "web", transport: "http", url: web.url, secrets: ["WEB_TOKEN"], bearer: "WEB_TOKEN" });
      expect(await testTool(spec, { WEB_TOKEN: "good-token" })).toEqual({ ok: true, tools: ["web_lookup"] });
      expect(await testTool(spec, { WEB_TOKEN: "bad-token" })).toEqual({ ok: false, problem: "It refused the sign-in. Check the secret's value." });
      // The answer is kept on the tool.
      addToolTo(store, repo, spec, "test", "alex", T0, { home, values: { WEB_TOKEN: "good-token" } });
      expect(await testToolOf(store, repo, "web", T0, { home })).toMatchObject({ ok: true, tools: ["web_lookup"] });
      expect(projectToolsOf(store, repo)[0]!.lastTest).toMatchObject({ ok: true, tools: ["web_lookup"] });
    } finally {
      await web.close();
    }
  });

  test("found on this computer: the repository's .mcp.json, Claude's global and per-project servers, and Codex's, with their values carried", () => {
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { shadcn: { command: "npx", args: ["shadcn@latest", "mcp"] } } }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: { mobbin: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer mob-token" } }, broken: { type: "sse" } },
      projects: { [repo]: { mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { CONTEXT7_API_KEY: "ctx-key" } } } } },
    }));
    const codex = [
      { name: "node_repl", transport: { type: "stdio", command: "./bin/repl", args: [], cwd: "/Applications/Some.app/tools", env: { REPL_HOME: "/tmp/repl" }, env_vars: ["REPL_TOKEN"] } },
      { name: "docs", transport: { type: "streamable_http", url: "https://docs.example.com/mcp", bearer_token_env_var: null, http_headers: null, env_http_headers: null } },
      { name: "shadcn", transport: { type: "stdio", command: "npx", args: ["other"] } },
    ];
    const found = discoverTools(repo, codex, home, { REPL_TOKEN: "repl-token" });
    expect(found.map(one => [one.spec.name, one.source])).toEqual([
      ["shadcn", "this project's .mcp.json"], ["context7", "Claude for this project"], ["mobbin", "Claude on this computer"],
      ["node_repl", "Codex on this computer"], ["docs", "Codex on this computer"],
    ]);
    const mobbin = found.find(one => one.spec.name === "mobbin")!;
    expect(mobbin.spec.bearer).toBe("MOBBIN_TOKEN");
    expect(mobbin.values).toEqual({ MOBBIN_TOKEN: "mob-token" });
    expect(found.find(one => one.spec.name === "context7")!.values).toEqual({ CONTEXT7_API_KEY: "ctx-key" });
    const repl = found.find(one => one.spec.name === "node_repl")!;
    expect(repl.spec.command).toBe("/Applications/Some.app/tools/bin/repl");
    expect(repl.values).toEqual({ REPL_HOME: "/tmp/repl", REPL_TOKEN: "repl-token" });
  });

  test("Claude gets only the listed servers from a private file removed after the run; Codex ignores the operator's config and starts each tool through the launcher, with no secret in its argv or environment", () => {
    const launch = { tools: [{ spec: probeSpec(), digest: toolDigest(probeSpec()), values: { PROBE_SECRET: "the-value" } }], skipped: [] };
    const claude = claudeToolArgs(launch);
    expect(claude.argv.slice(0, 2)).toEqual(["--strict-mcp-config", "--mcp-config"]);
    const file = claude.argv[2]!;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { probe: { type: "stdio", command: process.execPath, args: [PROBE], env: { PROBE_SECRET: "the-value" } } } });
    expect(claude.argv.join(" ")).not.toContain("the-value");
    claude.cleanup();
    expect(existsSync(file)).toBe(false);

    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\nnotify = ["say"]\npersonality = "pragmatic" # comment\n[mcp_servers.global]\ncommand = "should-not-load"\n');
    expect(carriedCodexSettings(false, codexHome)).toEqual(["-c", 'model_reasoning_effort="xhigh"', "-c", 'personality="pragmatic"']);
    expect(carriedCodexSettings(true, codexHome)).toEqual(["-c", 'model="gpt-6-astra"', "-c", 'model_reasoning_effort="xhigh"', "-c", 'personality="pragmatic"']);
    const codex = codexToolArgs(launch, { includeModel: false, codexHome, launcher: "/opt/so/tool-launcher.js", node: "/usr/bin/node" });
    expect(codex.argv.slice(0, 1)).toEqual(["--ignore-user-config"]);
    expect(codex.argv).toEqual(expect.arrayContaining(["apps._default.enabled=false", "features.plugins=false", 'mcp_servers.probe.command="/usr/bin/node"', 'mcp_servers.probe.default_tools_approval_mode="approve"']));
    const args = codex.argv.find(one => one.startsWith("mcp_servers.probe.args="))!;
    const launchFile = JSON.parse(args.slice("mcp_servers.probe.args=".length)) as string[];
    expect(launchFile[0]).toBe("/opt/so/tool-launcher.js");
    expect(JSON.parse(readFileSync(launchFile[1]!, "utf8"))).toMatchObject({ spec: { name: "probe" }, values: { PROBE_SECRET: "the-value" } });
    expect(codex.argv.join(" ")).not.toContain("the-value");
    expect(codex.env).toEqual({});
    codex.cleanup();
    expect(existsSync(launchFile[1]!)).toBe(false);
    // No tools still means none of the operator's.
    expect(codexToolArgs({ tools: [], skipped: [] }, { includeModel: false, codexHome }).argv).toEqual(["--ignore-user-config", "-c", 'model_reasoning_effort="xhigh"', "-c", 'personality="pragmatic"', "-c", "apps._default.enabled=false", "-c", "features.plugins=false"]);
  });

  test("the launcher gives a local tool its secrets and relays a web tool with its sign-in, over stdio", async () => {
    const local = join(dir, "local.json");
    writeFileSync(local, JSON.stringify({ spec: probeSpec(), values: { PROBE_SECRET: "abc" } }), { mode: 0o600 });
    expect(await testTool(validateToolSpec({ name: "via-launcher", command: process.execPath, args: launcherArgs(local) }), {})).toEqual({ ok: true, tools: ["probe_status"] });
    const web = await webServer();
    try {
      const remote = join(dir, "remote.json");
      writeFileSync(remote, JSON.stringify({ spec: validateToolSpec({ name: "web", transport: "http", url: web.url, secrets: ["WEB_TOKEN"], bearer: "WEB_TOKEN" }), values: { WEB_TOKEN: "good-token" } }), { mode: 0o600 });
      expect(await testTool(validateToolSpec({ name: "relay", command: process.execPath, args: launcherArgs(remote) }), {})).toEqual({ ok: true, tools: ["web_lookup"] });
    } finally {
      await web.close();
    }
  });

  describe("sealed at approval", () => {
    let token: string;
    beforeEach(() => {
      for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", T0);
      const added = addApprover(store, "alex", T0);
      if (!added.ok) throw new Error("bootstrap");
      token = added.token;
    });
    const approvedRun = (id: string): number => {
      store.createTask({ id, title: `Work ${id}` }, T0);
      const ref = store.refFor("built-in", id).id;
      store.placeTask(ref, repo);
      propose(store, { taskId: id, goal: `do ${id}`, touches: ["src/"], acceptance: [{ id: "c1", statement: "It holds", how: null, evidence: ["check"] }], now: T0 });
      if (!approve(store, id, "alex", T0, store.getScope(id)!.digest, token).ok) throw new Error("approval");
      const route = store.routeAuthorityFor(ref, "builder", null);
      if (!route?.ok) throw new Error("route");
      return store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `so/${id}`, worktree: `/pool/${id}`, route: route.stamp, now: T0 });
    };

    test("a tool reaches work approved after it was added; earlier approvals need approving again; a removed tool leaves every build; a missing secret leaves it out with the reason", () => {
      addToolTo(store, repo, probeSpec("early"), "test", "alex", T0, { home, values: { PROBE_SECRET: "one" } });
      const before = approvedRun("before");
      addToolTo(store, repo, probeSpec("late"), "test", "alex", T0, { home, values: { PROBE_SECRET: "one" } });
      expect(toolLaunchFor(store, before, home)).toMatchObject({
        tools: [{ spec: { name: "early" }, values: { PROBE_SECRET: "one" } }],
        skipped: [{ name: "late", reason: expect.stringContaining("approve it again") }],
      });
      // Approving the same work again seals today's list.
      expect(approve(store, "before", "alex", T0, store.getScope("before")!.digest, token).ok).toBe(true);
      expect(toolLaunchFor(store, before, home).tools.map(one => one.spec.name)).toEqual(["early", "late"]);
      const after = approvedRun("after");
      removeToolFrom(store, repo, "early", "alex", T0, home);
      expect(toolLaunchFor(store, after, home).tools.map(one => one.spec.name)).toEqual(["late"]);
      setToolSecret(repo, "late", "PROBE_SECRET", "", home);
      expect(toolLaunchFor(store, after, home)).toEqual({ tools: [], skipped: [{ name: "late", reason: "needs PROBE_SECRET set on the Tools page" }] });
      // Each launch records what it had and what was left out.
      prepareRunTools(store, after, "gemini", { home, now: T0, includeModel: false }).cleanup();
      expect(store.runTools(after)).toEqual({ tools: [], skipped: [{ name: "late", reason: "needs PROBE_SECRET set on the Tools page" }] });
    });

    test("the gateway launches a Claude build with only the project's servers and a review with none; the file is gone after the run", async () => {
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => "tok-builder-1" });
      store.createTask({ id: "t-1", title: "w" }, T0);
      const ref = store.refFor("built-in", "t-1").id;
      store.placeTask(ref, repo);
      const took = acquire(store, ref, "builder-1", { now: T0, token: "tok-builder-1", newLeaseId: () => "lease-1", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
      if (!took.ok) throw new Error("claim");
      addToolTo(store, repo, probeSpec(), "test", "alex", T0, { home, values: { PROBE_SECRET: "secret-value" } });
      const legacy = (phase: "build" | "review") => ({ route: { routeDigest: "legacy", phase, provider: "claude", model: null, chosen: "legacy" as const } });
      const build = store.startRun({ taskRef: ref, leaseId: "lease-1", runner: "builder-1", branch: "b", worktree: "/w", ...legacy("build"), now: T0 });
      let seen: { args: readonly string[]; config: unknown; env: NodeJS.ProcessEnv | undefined } | null = null;
      const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
      await invokeAgent(store, build, { provider: "claude", model: null }, { phase: "build", brief: "hi", maxTurns: 5, permissionMode: "acceptEdits", skipPermissions: false, resumeSession: null }, {
        keyHome: home, clock: () => T0,
        runner: async (_file, args, options) => {
          const at = args.indexOf("--mcp-config");
          seen = { args, config: JSON.parse(readFileSync(args[at + 1]!, "utf8")), env: options?.env };
          return OK;
        },
      });
      expect(seen!.args).toContain("--strict-mcp-config");
      expect(seen!.config).toEqual({ mcpServers: { probe: { type: "stdio", command: process.execPath, args: [PROBE], env: { PROBE_SECRET: "secret-value" } } } });
      expect(JSON.stringify(seen!.env)).not.toContain("secret-value");
      expect(existsSync(seen!.args[seen!.args.indexOf("--mcp-config") + 1]!)).toBe(false);
      expect(store.runTools(build)).toMatchObject({ tools: [{ name: "probe" }], skipped: [] });
    });
  });

});

function readdirOnly(path: string): string {
  const entries = readdirSync(path);
  if (entries.length !== 1) throw new Error(`expected one project folder, found ${entries.length}`);
  return entries[0]!;
}
