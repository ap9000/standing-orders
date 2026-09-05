/**
 * `standing-orders up` — one command to a working cockpit, proven over the
 * real machinery: real git, a real bind, real watch loops bounded by --for.
 * The ordering guarantees (nothing mints before the port), the credential
 * file's discipline, and the runner lifecycle are each their own proof.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo, hostname } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { runOperate, parseOperateArgs } from "./operate.js";
import { openStore } from "./store.js";
import { register, normalizeRunnerName } from "./runner.js";
import { authenticateApprover } from "./scope.js";

const PORT = 41000 + (process.pid % 2000);

let base: string;
let repo: string;
let db: string;
let lines: string[];

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, env: { ...gitEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "so-up-"));
  repo = join(base, "project");
  db = join(base, "orders.db");
  execFileSync("mkdir", ["-p", repo]);
  git(["init", "-q"], repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-qm", "first"], repo);
  lines = [];
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const up = (extra: string[] = [], port = PORT) =>
  runOperate("up", ["--repo", repo, "--port", String(port), "--for", "1200", "--json", ...extra], line => lines.push(line), {
    databaseFile: db,
  });

const envelope = (): Record<string, unknown> => JSON.parse(lines.join("\n")) as Record<string, unknown>;

describe("standing-orders up", () => {
  test("cold start: mints the login durably, registers a worker, watches, retires cleanly", async () => {
    const code = await up();
    expect(code).toBe(0);
    const answer = envelope();
    expect(answer).toMatchObject({ ok: true, command: "up" });
    expect(String(answer["url"])).toContain(`:${PORT}`);
    expect((answer["repos"] as string[])[0]).toBeTruthy();

    // The login: minted, durable, 0600, and it authenticates.
    const loginFile = String(answer["passwordFile"]);
    expect(loginFile.endsWith("up-login.txt")).toBe(true);
    expect(statSync(loginFile).mode & 0o777).toBe(0o600);
    const [name = "", password = ""] = readFileSync(loginFile, "utf8").trim().split(" ");
    expect(answer["approver"]).toBe(name);
    const store = openStore(db);
    try {
      expect(authenticateApprover(store, name, password).ok).toBe(true);
      // The worker retired on the way out — the next `up` reuses the name.
      const runner = store.getRunner(String(answer["runner"]));
      expect(runner?.runner.retiredAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test("second start: adopts the existing login and reuses the retired worker name", async () => {
    await up();
    const firstRunner = String(envelope()["runner"]);
    lines = [];
    const code = await up();
    expect(code).toBe(0);
    const again = envelope();
    expect(again).toMatchObject({ ok: true, approverVerified: true });
    expect(again["runner"]).toBe(firstRunner);
    expect(String(again["passwordFile"]).endsWith("up-login.txt")).toBe(true);
  });

  test("a busy port refuses BEFORE anything mints — the world stays untouched", async () => {
    const squatter = createServer();
    await new Promise<void>(ready => squatter.listen(PORT + 1, "127.0.0.1", ready));
    try {
      const code = await up([], PORT + 1);
      expect(code).toBe(3);
      expect(envelope()).toMatchObject({ ok: false, reason: "port-busy" });
      const store = openStore(db);
      try {
        expect(store.listApprovers()).toEqual([]);
        expect(store.listRunners()).toEqual([]);
      } finally {
        store.close();
      }
      expect(existsSync(join(base, "up-login.txt"))).toBe(false);
    } finally {
      await new Promise<void>(done => squatter.close(() => done()));
    }
  });

  test("a directory outside git refuses with both roads", async () => {
    const code = await runOperate("up", ["--repo", base, "--port", String(PORT + 2), "--json"], line => lines.push(line), {
      databaseFile: db,
    });
    expect(code).toBe(3);
    const answer = envelope();
    expect(answer).toMatchObject({ ok: false, reason: "not-a-repository" });
    expect(String(answer["message"])).toContain("demo");
  });

  test("an explicitly named live worker refuses instead of taking its work", async () => {
    const store = openStore(db);
    try {
      register(store, { name: "busy-worker", host: "elsewhere", now: new Date() });
    } finally {
      store.close();
    }
    const code = await up(["--runner", "busy-worker"], PORT + 3);
    expect(code).toBe(3);
    expect(envelope()).toMatchObject({ ok: false, reason: "runner-alive" });
  });

  test("the generated worker name comes from this machine's hostname, normalized", async () => {
    await up([], PORT + 4);
    const named = String(envelope()["runner"]);
    expect(named.startsWith(normalizeRunnerName(hostname()).slice(0, 8))).toBe(true);
  });

  test("the remembered login answers for every operator verb: after one up, register and approve ask for nothing", async () => {
    expect(await up()).toBe(0);
    const tokenFile = join(base, "w2-token");
    lines = [];
    const registered = await runOperate("runner", ["register", "w2", "--repo", repo, "--token-file", tokenFile, "--json"], line => lines.push(line), { databaseFile: db });
    expect(registered).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, command: "runner register" });
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    // The scripted approval (--yes --digest) is answered by the file too.
    lines = [];
    expect(await runOperate("task", ["add", "remembered work", "--id", "t-remembered", "--repo", repo, "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    const configured = openStore(db);
    configured.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date());
    configured.close();
    lines = [];
    expect(await runOperate("task", ["scope", "t-remembered", "--goal", "a goal", "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    const digest = String((envelope()["scope"] as Record<string, unknown>)["digest"]);
    lines = [];
    expect(await runOperate("task", ["approve", "t-remembered", "--yes", "--digest", digest, "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, command: "task approve" });
    // Under a signed hands-off mode, the remembered login is the mode's
    // signer for the CLI's scope filing too: the scope seals escalated
    // permissions and auto-approves, exactly as the console's form does.
    lines = [];
    expect(await runOperate("mode", ["set", "--repo", repo, "--name", "hands-off", "--days", "1", "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    lines = [];
    expect(await runOperate("task", ["add", "hands-off work", "--id", "t-hands-off", "--repo", repo, "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    lines = [];
    expect(await runOperate("task", ["scope", "t-hands-off", "--goal", "a goal", "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    const sealed = envelope()["scope"] as Record<string, unknown>;
    expect((sealed["profile"] as Record<string, unknown>)["permissionArgv"]).toBe("bypassPermissions");
    expect(envelope()["approvedUnderMode"]).toBe(true);
    // A different --as than the remembered name is not answered by the file.
    lines = [];
    const other = await runOperate("runner", ["register", "w3", "--repo", repo, "--as", "somebody-else", "--json"], line => lines.push(line), { databaseFile: db });
    expect(other).not.toBe(0);
    expect(envelope()).toMatchObject({ ok: false });
  });

  test("the minted approver defaults to the operating-system user", async () => {
    await up([], PORT + 5);
    const expected = process.env["USER"] ?? process.env["USERNAME"] ?? "operator";
    expect(envelope()["approver"]).toBe(expected === "" ? "operator" : expected);
    expect(String(envelope()["approver"]).length).toBeGreaterThan(0);
    expect(userInfo().username.length).toBeGreaterThan(0);
  });
});

describe("parser compatibility (finding 22)", () => {
  test("repeated --repo: the Map keeps last-wins for existing verbs; the list keeps every one", () => {
    const parsed = parseOperateArgs(["--repo", "/a", "--repo", "/b,/c"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.flags.get("repo")).toBe("/b,/c");
    expect(parsed.repoList).toEqual(["/a", "/b", "/c"]);
  });

  test("--no-open is a recognized boolean", () => {
    const parsed = parseOperateArgs(["--no-open"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.flags.get("no-open")).toBe(true);
  });
});
