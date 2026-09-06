import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { openStore } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { register } from "./runner.js";
import { runOperate } from "./operate.js";
import { run } from "./exec.js";
import { createDecisionServer as createServer } from "./serve.js";
// Account checks in HTTP fixtures never inspect the user's CLI sign-in.
const createDecisionServer = (options: Parameters<typeof createServer>[0]) => createServer({
  connectionProbe: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }), ...options,
});
import { type PublishExec } from "./publish.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
test("console journey: configure, approve, stop, resume preserved files, review a real diff, and open one fake PR", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-control-journey-")));
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (args: string[]) => run("git", args, { cwd: repo });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.name", "Test"]); await git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "README.md"), "Initial\n"); await git(["add", "."]); await git(["commit", "-qm", "Initial"]);
  const databaseFile = join(root, "orders.db"); const store = openStore(databaseFile); const now = new Date();
  const actor = addApprover(store, "alex", now); if (!actor.ok) throw new Error("fixture");
  const token = actor.token;
  register(store, { name: "worker", host: "test", repos: [repo], now, newToken: () => "worker-token" });
  let publishCalls: string[][] = [];
  const publishExec: PublishExec = async (file, args) => {
    publishCalls.push([file, ...args]);
    if (file === "git" && args[0] === "push") return OK;
    if (file === "gh" && args[1] === "list") return { ...OK, stdout: "[]" };
    if (file === "gh" && args[1] === "create") return { ...OK, stdout: "https://github.com/test/project/pull/7\n" };
    throw new Error(`Unexpected publisher call: ${file} ${args.join(" ")}`);
  };
  const server = createDecisionServer({ store, repos: [repo], evidenceRoot: join(root, "evidence"), clock: () => now, publishExec,
    localControl: { host: "test-mac", status: () => [{ repo, runner: "worker", state: "stopped", detail: "Ready" }], change: () => ({ ok: true, message: "Started" }) } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (typeof address !== "object" || address === null) throw new Error("port");
  const base = `http://127.0.0.1:${address.port}`;
  const document = new Window().document;
  const formValues = (html: string, action: string): Record<string, string> => {
    document.body.innerHTML = html;
    const form = document.querySelector(`form[action="${action}"]`);
    if (form === null) throw new Error(`Missing ${action}`);
    return Object.fromEntries([...form.querySelectorAll("input")].map(input => [input.name, input.value]));
  };
  let releaseAgent: (() => void) | undefined;
  let running: Promise<number> | undefined;
  try {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = async (path: string) => (await fetch(base + path, { headers: { cookie } })).text();
    const post = (path: string, fields: Record<string, string>) => fetch(base + path, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });
    const setupForm = formValues(await get("/control"), "/control/setup-preview");
    const csrf = setupForm.csrf!;
    const setup = await post("/control/setup-preview", { ...setupForm, repo, provider: "claude", model: "sonnet", command: "", seconds: "300" });
    expect(setup.status).toBe(200);
    const reviewedSetup = formValues(await setup.text(), "/control/setup-approve");
    expect((await post("/control/setup-approve", { ...reviewedSetup, token })).status).toBe(303);
    expect(store.phaseConfig(repo, "build")?.model).toBe("sonnet");
    store.createTask({ id: "fix", title: "Ship the fix" }, now);
    const ref = store.refFor("built-in", "fix").id; store.placeTask(ref, repo);
    const scope = propose(store, { taskId: "fix", goal: "Update the readme and add a module", now });
    const approval = formValues(await get("/t/fix"), "/t/fix/approve");
    expect((await post("/t/fix/approve", { ...approval, token })).status).toBe(303);
    expect(store.getScope("fix")?.approvedDigest).toBe(scope.digest);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waitForStop = new Promise<void>(resolve => { releaseAgent = resolve; });
    let attempts = 0;
    const tick = () => runOperate("tick", ["--db", databaseFile, "--runner", "worker", "--token", "worker-token", "--repo", repo, "--pool", join(root, "pool"), "--json"], () => {}, {
      now, agentRunner: async (_file, args, options) => {
        attempts++;
        const cwd = options!.cwd!;
        if (attempts === 1) {
          writeFileSync(join(cwd, "README.md"), "Useful unfinished work\n");
          writeFileSync(join(cwd, "module.ts"), "export const useful = true;\n");
          entered(); await waitForStop; return { ...OK, code: 143 };
        }
        expect(readFileSync(join(cwd, "README.md"), "utf8")).toContain("Useful unfinished work");
        expect(readFileSync(join(cwd, "module.ts"), "utf8")).toContain("useful = true");
        const brief = args[args.indexOf("-p") + 1] ?? "";
        const done = /STANDING-ORDERS-DONE-[a-f0-9]{16}\.json/.exec(brief)![0];
        writeFileSync(join(cwd, done), JSON.stringify({ version: 1, status: "completed", conclusion: "Finished the preserved work." }));
        return { ...OK, stdout: JSON.stringify({ result: "Finished" }) };
      },
    });
    running = tick(); await started;
    const stop = formValues(await get("/t/fix"), "/t/fix/stop");
    expect((await post("/t/fix/stop", { ...stop, csrf: "forged" })).status).toBe(403);
    expect((await post("/t/fix/stop", stop)).status).toBe(303);
    expect((await post("/t/fix/resume", { csrf })).status).toBe(409);
    releaseAgent!(); await running; running = undefined;
    expect(store.getTask("fix")?.state).toBe("queued"); expect(store.refForId(ref)?.strikes).toBe(0);
    expect(await get("/t/fix")).toContain("Resume work");
    expect((await post("/t/fix/resume", { csrf })).status).toBe(303);
    await tick();
    const built = store.runsFor(ref).find(one => one.outcome === "built")!;
    expect(built).toBeDefined(); expect(store.getTask("fix")?.state).toBe("done");
    expect(await get("/t/fix")).toContain("Built locally");
    expect(await get(`/r/${built.id}`)).toContain("useful = true");
    const terms = { csrf, run: String(built.id), github: "test/project", remote: "origin", base: "main", prefix: "standing-orders/" };
    const delivery = await post("/t/fix/publish-preview", terms);
    expect(delivery.status).toBe(200);
    const confirm = formValues(await delivery.text(), "/t/fix/publish-confirm");
    expect(publishCalls).toHaveLength(0);
    expect((await post("/t/fix/publish-confirm", { ...confirm, token })).status).toBe(200);
    expect(store.publicationForRun(built.id)).toMatchObject({ state: "opened", prNumber: 7 });
    expect(publishCalls.filter(args => args[0] === "git")).toEqual([["git", "push", "origin", `${built.headRevision}:refs/heads/${built.branch}`]]);
    expect((await post("/t/fix/publish-confirm", { ...confirm, token })).status).toBe(409);
    expect(publishCalls.filter(args => args[2] === "create")).toHaveLength(1);
  } finally {
    releaseAgent?.(); if (running !== undefined) await running;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); rmSync(root, { recursive: true, force: true });
  }
}, 20000);
