/**
 * The agent fence: Standing Orders' own secrets (the state folder beside the
 * database, except the build's worktree, and ~/.standing-orders) are out of
 * every agent's reach. What it covers, how each provider receives it, and —
 * on macOS — that the sandbox really refuses a read from a child process.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFence, claudeFenceSettings, codexFenceArgv, linuxFenceAvailable, linuxFenced, macosFenceAvailable, macosFenced, macosFenceProfile } from "./agent-fence.js";
import { adapterFor } from "./provider.js";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { invokeAgent } from "./invoke.js";
import { run, runStreamJsonl } from "./exec.js";

const T0 = new Date("2026-09-23T12:00:00.000Z");

describe("the agent fence", () => {
  let dir: string, state: string, home: string, worktree: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-fence-")));
    state = join(dir, "standing-orders");
    home = join(dir, "home");
    worktree = join(state, "worktrees", "app", "task-1");
    for (const path of [state, home, worktree, join(state, "evidence", "12"), join(state, "backups"), join(home, ".standing-orders", "keys")]) mkdirSync(path, { recursive: true });
    for (const [file, text] of [["orders.db", "db"], ["orders.db-wal", "wal"], ["up-login.txt", "name: alex\npassword: canary-login"], ["runner-token", "t"], ["repos.json", "[]"]] as const) writeFileSync(join(state, file), text);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("covers everything in the state folder but the worktree's own folder, the database with its journal, and ~/.standing-orders; never the worktree", () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home });
    expect(fence).toEqual([
      join(home, ".standing-orders"),
      join(state, "backups"), join(state, "evidence"), join(state, "orders.db"), join(state, "orders.db-wal"),
      join(state, "repos.json"), join(state, "runner-token"), join(state, "up-login.txt"),
    ].sort());
    expect(fence.some(path => worktree.startsWith(path))).toBe(false);
    // A repository in the folder — the build's own, named by its worktree's git metadata, or any other — is work, never fenced.
    mkdirSync(join(state, "repo", ".git", "worktrees", "task-1"), { recursive: true });
    mkdirSync(join(state, "other-project", ".git"), { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(state, "repo", ".git", "worktrees", "task-1")}\n`);
    const withRepos = agentFence({ databaseFile: join(state, "orders.db"), worktree, home });
    expect(withRepos).toEqual(fence);
    // A database in a shared folder (a repository): only it and secret-looking entries.
    const shared = join(dir, "repo");
    mkdirSync(join(shared, ".git"), { recursive: true });
    for (const file of ["orders.db", "up-login.txt", "package.json", "deploy.token"]) writeFileSync(join(shared, file), "x");
    expect(agentFence({ databaseFile: join(shared, "orders.db"), worktree: null, home })).toEqual([join(home, ".standing-orders"), join(shared, "deploy.token"), join(shared, "orders.db"), join(shared, "up-login.txt")].sort());
    // No database file: only ~/.standing-orders.
    expect(agentFence({ databaseFile: null, worktree: null, home })).toEqual([join(home, ".standing-orders")]);
  });

  test("Codex gets its own sandbox with the fence denied (Auto keeps the workspace profile; Full access widens it, never unsandboxed); Claude's file tools get deny rules", () => {
    const fence = ["/s/up-login.txt", "/h/.standing-orders"];
    expect(codexFenceArgv(fence, false)).toEqual(["-c", 'default_permissions="standing-orders"', "-c", 'permissions.standing-orders.extends=":workspace"', "-c", 'permissions.standing-orders.filesystem={"/s/up-login.txt"="deny","/h/.standing-orders"="deny"}']);
    expect(codexFenceArgv(fence, true)).toEqual(["-c", 'default_permissions="standing-orders"', "-c", 'permissions.standing-orders.extends=":workspace"', "-c", 'permissions.standing-orders.filesystem={"/"="write","/s/up-login.txt"="deny","/h/.standing-orders"="deny"}', "-c", "permissions.standing-orders.network.enabled=true", "-c", 'approval_policy="never"']);
    const base = { phase: "build" as const, brief: "go", model: null, maxTurns: 5, permissionMode: "auto", resumeSession: null, fence };
    for (const skipPermissions of [false, true]) {
      const argv = adapterFor("codex").argv({ ...base, skipPermissions });
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).not.toContain("--sandbox");
      expect(argv).toContain('default_permissions="standing-orders"');
    }
    // A resumed Codex turn keeps the same fence.
    expect(adapterFor("codex").argv({ ...base, skipPermissions: false, resumeSession: "thread-1" })).toContain('default_permissions="standing-orders"');
    // A review keeps its own isolation, fence or not.
    expect(adapterFor("codex").argv({ ...base, phase: "review", skipPermissions: false })).toContain("--ignore-user-config");
    const claude = adapterFor("claude").argv({ ...base, skipPermissions: true });
    const settings = JSON.parse(claude[claude.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toEqual(["Read(//s/up-login.txt)", "Read(//s/up-login.txt/**)", "Edit(//s/up-login.txt)", "Edit(//s/up-login.txt/**)", "Read(//h/.standing-orders)", "Read(//h/.standing-orders/**)", "Edit(//h/.standing-orders)", "Edit(//h/.standing-orders/**)"]);
    expect(JSON.parse(claudeFenceSettings([]))).toEqual({ permissions: { deny: [] } });
    expect(macosFenceProfile(['/a "quoted"/x'])).toContain('(subpath "/a \\"quoted\\"/x")');
  });

  test.skipIf(!macosFenceAvailable())("on macOS the sandbox refuses a fenced read from any child process, while the worktree, other writes and the network stay open", () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home });
    const script = `const fs=require("fs");const out=[];for(const f of process.argv.slice(1)){try{out.push(fs.readFileSync(f,"utf8").trim())}catch(e){out.push(e.code)}}try{fs.writeFileSync(${JSON.stringify(join(worktree, "made.txt"))},"ok");out.push("wrote-worktree")}catch(e){out.push(e.code)}try{fs.writeFileSync(${JSON.stringify(join(dir, "elsewhere.txt"))},"ok");out.push("wrote-elsewhere")}catch(e){out.push(e.code)}console.log(out.join(" "))`;
    const { file, args } = macosFenced(process.execPath, ["-e", script, join(state, "up-login.txt"), join(home, ".standing-orders", "keys"), join(state, "evidence", "12")], fence);
    const result = spawnSync(file, args, { encoding: "utf8" });
    expect(result.stdout.trim()).toBe("EPERM EPERM EPERM wrote-worktree wrote-elsewhere");
    expect(readFileSync(join(worktree, "made.txt"), "utf8")).toBe("ok");
  });

  test.skipIf(!macosFenceAvailable())("the spawn road every provider transport uses applies the fence to the real process: buffered and streaming", async () => {
    const fence = agentFence({ databaseFile: join(state, "orders.db"), worktree, home });
    // The child writes what it could read into the worktree (always reachable).
    const outcome = join(worktree, "outcome.txt");
    const script = `const fs=require("fs");let r;try{r=fs.readFileSync(${JSON.stringify(join(state, "up-login.txt"))},"utf8")}catch(e){r=e.code}fs.writeFileSync(${JSON.stringify(outcome)},r)`;
    await run(process.execPath, ["-e", script], { processGroup: true, fence });
    expect(readFileSync(outcome, "utf8")).toBe("EPERM");
    await runStreamJsonl(process.execPath, ["-e", script], { processGroup: true, fence });
    expect(readFileSync(outcome, "utf8")).toBe("EPERM");
    // Without a fence the same spawn reads it: the test would catch a no-op fence.
    await run(process.execPath, ["-e", script], { processGroup: true });
    expect(readFileSync(outcome, "utf8")).toContain("canary-login");
  });

  describe("through the gateway", () => {
    let store: Store;
    beforeEach(() => {
      store = openStore(join(state, "orders.db.live"));
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [dir], now: T0, newToken: () => "tok" });
    });
    afterEach(() => store.close());
    const open = (id: string, provider: "claude" | "codex"): number => {
      store.createTask({ id, title: id }, T0);
      const ref = store.refFor("built-in", id).id;
      store.placeTask(ref, dir);
      const took = acquire(store, ref, "builder-1", { now: T0, token: "tok", newLeaseId: () => `lease-${id}`, ttlMs: 10 * 365 * 24 * 3600 * 1000 });
      if (!took.ok) throw new Error("claim");
      return store.startRun({ taskRef: ref, leaseId: `lease-${id}`, runner: "builder-1", branch: "b", worktree, route: { routeDigest: "legacy", phase: "build", provider, model: null, chosen: "legacy" }, now: T0 });
    };
    const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

    test("every build is launched fenced and the run says how", async () => {
      const seen: { file: string; args: readonly string[] }[] = [];
      const ask = { phase: "build" as const, brief: "go", maxTurns: 5, permissionMode: "auto", skipPermissions: true, resumeSession: null };
      const codexRun = open("t-codex", "codex");
      await invokeAgent(store, codexRun, { provider: "codex", model: null }, ask, { keyHome: home, clock: () => T0, runner: async (file, args) => { seen.push({ file, args }); return OK; } });
      const codex = seen.at(-1)!;
      expect(codex.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      const filesystem = codex.args.find(one => one.startsWith("permissions.standing-orders.filesystem="))!;
      expect(filesystem).toContain(`"${join(state, "up-login.txt")}"="deny"`);
      expect(filesystem).toContain(`"${join(home, ".standing-orders")}"="deny"`);
      expect(filesystem).not.toContain(`"${join(state, "worktrees")}"`);
      expect(store.runFence(codexRun)).toEqual({ method: "codex-profile", paths: expect.any(Number) });
      const claudeRun = open("t-claude", "claude");
      let wrap: readonly string[] | undefined;
      await invokeAgent(store, claudeRun, { provider: "claude", model: null }, ask, { keyHome: home, clock: () => T0, runner: async (file, args, options) => { seen.push({ file, args }); wrap = options?.fence; return OK; } });
      const claude = seen.at(-1)!;
      // The provider's own argv is unchanged; the spawn road applies the sandbox.
      expect(claude.file).toBe("claude");
      expect(claude.args).toContain("--settings");
      if (macosFenceAvailable()) {
        expect(wrap).toContain(join(state, "up-login.txt"));
        expect(store.runFence(claudeRun)).toEqual({ method: "macos-sandbox", paths: expect.any(Number) });
      } else {
        expect(store.runFence(claudeRun)).toEqual({ method: "claude-rules", paths: expect.any(Number) });
      }
    });
  });
});

describe("the Linux fence (v88)", () => {
  test("bubblewrap masks each fenced folder with an empty one and each fenced file with /dev/null, around the agent itself", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "so-linux-fence-")));
    try {
      const folder = join(root, "keys"), file = join(root, "up-login.txt");
      mkdirSync(folder);
      writeFileSync(file, "alex secret");
      expect(linuxFenced("claude", ["-p", "hi"], [folder, file])).toEqual({ file: "bwrap", args: ["--dev-bind", "/", "/", "--tmpfs", folder, "--ro-bind", "/dev/null", file, "--die-with-parent", "--", "claude", "-p", "hi"] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("it is used only on Linux, and only where bubblewrap actually runs", () => {
    expect(linuxFenceAvailable("darwin", () => true)).toBe(false);
    expect(linuxFenceAvailable("win32", () => true)).toBe(false);
  });
});
