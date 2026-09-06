import { test, expect } from "vitest";
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Window } from "happy-dom";
import { openStore } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { fireRoutine, routineDigestOf } from "./routine.js";
import { fileRoutineProposal } from "./proposal.js";

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "so-recurring-compose-")));
  const repo = join(root, "website"), other = join(root, "docs");
  for (const path of [repo, other]) { mkdirSync(path); execFileSync("git", ["init", "-q", path]); }
  const store = openStore(":memory:"); const now = new Date("2026-09-05T22:00:00Z");
  const account = addApprover(store, "alex", now); if (!account.ok) throw Error("fixture account");
  store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", now);
  const server = createDecisionServer({ store, repos: [repo, other], evidenceRoot: root, clock: () => now,
    connectionProbe: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "alex", token: account.token }), redirect: "manual" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!; const window = new Window();
  const parse = (html: string) => {
    window.document.body.innerHTML = html;
    // happy-dom currently selects the second option when parsing later
    // selected options. Match the browser's selected attribute semantics.
    for (const select of window.document.querySelectorAll("select")) {
      const chosen = select.querySelector("option[selected]"); if (chosen) select.value = chosen.getAttribute("value")!;
    }
    return window.document;
  };
  const fields = (html: string, action = "/tasks/add") => {
    const form = parse(html).querySelector(`form[action="${action}"]`); if (!form) throw Error(`Missing ${action}`);
    return Object.fromEntries([...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input[name], select[name], textarea[name]")]
      .filter(field => !field.disabled && (field.type !== "checkbox" || (field as HTMLInputElement).checked)).map(field => [field.name, field.value]));
  };
  const get = async (path: string) => (await fetch(base + path, { headers: { cookie } })).text();
  const post = (path: string, data: Record<string, string>) => fetch(base + path, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(data), redirect: "manual" });
  const close = async () => { await new Promise<void>(resolve => server.close(() => resolve())); window.happyDOM.abort(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { repo, other, store, now, get, post, parse, fields, token: account.token, close };
}

test("one shared composer creates an exact recurring draft, allows edits, and enables only the reviewed schedule", async () => {
  const f = await fixture();
  try {
    const start = await f.get("/routines");
    expect(f.parse(start).querySelector(".composer-options")?.hasAttribute("open")).toBe(false);
    expect(f.parse(start).querySelectorAll("textarea[required]")).toHaveLength(1);
    expect(f.parse(start).querySelector('input[name="schedule"]')).toBeNull();
    expect(f.parse(start).querySelector('input[name="name"]')).toBeNull();
    const form = { ...f.fields(start), repo: f.other, request: "Check the docs\r\nFix outdated examples.", repeat: "weekly", weekday: "1", time: "09:00", timezone: "America/Los_Angeles", not: "Public API\r\nExamples marked historical", touches: "README.md, docs/", ceiling: "12.50" };
    expect((await f.post("/tasks/add", { ...form, csrf: "wrong" })).status).toBe(403);
    const made = await f.post("/tasks/add", form); expect(made.status).toBe(303);
    const path = made.headers.get("location")!; const id = Number(path.split("/").pop());
    const saved = f.store.getRoutine(id)!;
    expect(saved).toMatchObject({ repo: f.other, name: "check-the-docs", goal: "Check the docs\nFix outdated examples.", outOfScope: "Public API\nExamples marked historical", touches: ["README.md", "docs/"], schedule: "weekly:1:09:00@America/Los_Angeles", costCeilingUsd: 12.5, approvedAt: null, nextFireAt: null });
    expect(f.store.listTasks()).toHaveLength(0);
    const review = await f.get(path); expect(review).toContain("every Monday at 09:00 America/Los_Angeles"); expect(review).toContain("$12.50 over the last 7 days"); expect(review).toContain("without asking for approval again");
    const staleApproval = f.fields(review, path + "/approve");
    const editHref = f.parse(review).querySelector('.setup-actions a')!.getAttribute("href")!;
    const edit = f.fields(await f.get(editHref)); expect(edit.request).toBe(saved.goal); expect(edit.timezone).toBe("America/Los_Angeles");
    const revised = await f.post("/tasks/add", { ...edit, request: saved.goal + "\nInclude a brief summary.", weekday: "2" });
    expect(revised.headers.get("location")).toBe(path); expect(f.store.listRoutines(null)).toHaveLength(1);
    expect((await f.post("/tasks/add", edit)).status).toBe(409);
    expect((await f.post(path + "/approve", { ...staleApproval, token: f.token })).status).toBe(409);
    expect(f.store.getRoutine(id)?.approvedAt).toBeNull();
    const approval = f.fields(await f.get(path), path + "/approve");
    expect((await f.post(path + "/approve", { ...approval, token: f.token })).status).toBe(303);
    expect(f.store.getRoutine(id)?.nextFireAt).toBe("2026-09-08T16:00:00.000Z");
    expect((await f.post("/tasks/add", { ...edit, "routine-digest": approval.digest! })).status).toBe(409);
    const fired = fireRoutine(f.store, id, new Date("2026-09-08T16:00:00Z")); expect(fired.ok).toBe(true);
    expect(f.store.listTasks()).toHaveLength(1); expect(f.store.liveRuns(f.now)).toHaveLength(0);
  } finally { await f.close(); }
});

test("validation, stale tabs, and unavailable projects preserve all composer inputs without creating work", async () => {
  const f = await fixture();
  try {
    const form = { ...f.fields(await f.get("/tasks/new")), repo: f.repo, request: "A precise request <keep this>", repeat: "weekly", weekday: "1", time: "09:00", timezone: "America/Los_Angeles", not: "Auth", touches: "docs/", ceiling: "10" };
    for (const [extra, status] of [[{ timezone: "Unknown/Zone" }, 400], [{ ceiling: "-1" }, 400], [{ projectRevision: "999" }, 409], [{ repo: "/unavailable" }, 400]] as const) {
      const invalid = await f.post("/tasks/add", { ...form, ...extra }); expect(invalid.status).toBe(status);
      const kept = f.fields(await invalid.text()); expect(kept.request).toBe(form.request); expect(kept.not).toBe(form.not); expect(kept.touches).toBe(form.touches); expect(kept.repeat, JSON.stringify(extra)).toBe("weekly");
      expect(f.store.listRoutines(null)).toHaveLength(0); expect(f.store.listTasks()).toHaveLength(0);
    }
    const repeated = await f.post("/tasks/add", { ...form, repeat: "custom", interval: "2", "interval-unit": "hours" }); expect(repeated.status).toBe(303);
    expect(f.store.listRoutines(null)[0]?.schedule).toBe("every:120");
    const once = await f.post("/tasks/add", { ...form, repeat: "once", title: "A one-off task" }); expect(once.headers.get("location")).toMatch(/^\/t\//);
    expect(f.store.listTasks()).toHaveLength(1); expect(f.store.listRoutines(null)).toHaveLength(1);
  } finally { await f.close(); }
});

test("template suggestions keep their exact boundaries and schedule; generated routine names cannot collide", async () => {
  const f = await fixture();
  try {
    const template = await f.get("/tasks/new?template=nightly-deps");
    expect(f.parse(template).querySelector(".composer-options")?.hasAttribute("open")).toBe(false);
    const form = { ...f.fields(template), repo: f.repo }; expect(form.timezone).toBe("UTC"); expect(form.time).toBe("03:30"); expect(form.not).toContain("No major version bumps");
    const first = await f.post("/tasks/add", form), second = await f.post("/tasks/add", form);
    expect(first.status).toBe(303); expect(second.status).toBe(303); expect(first.headers.get("location")).not.toBe(second.headers.get("location"));
    expect(new Set(f.store.listRoutines(null).map(r => r.name)).size).toBe(2);
    for (const routine of f.store.listRoutines(null)) { expect(routine.outOfScope).toBe(form.not); expect(routine.approvedAt).toBeNull(); }
    const legacy = f.fields(await f.get("/routines?template=docs-drift")); expect(legacy.repeat).toBe("custom"); expect(legacy.interval).toBe("7"); expect(legacy["interval-unit"]).toBe("days");
  } finally { await f.close(); }
});

test("editing a draft keeps requirements and per-run spending limits that are not composer fields", async () => {
  const f = await fixture();
  try {
    const made = fileRoutineProposal(f.store, { name: "bounded", repo: f.repo, goal: "Check docs", outOfScope: null, touches: [], requirements: ["env:DOCS_TOKEN"], schedule: "daily:09:00", costCeilingUsd: 10, budgetPerRunMicrousd: 2_000_000, filedVia: "cli" }, f.now);
    if (!made.ok) throw Error(made.message);
    const edit = f.fields(await f.get(`/tasks/new?routine=${made.id}`));
    expect((await f.post("/tasks/add", { ...edit, request: "Check docs and examples" })).status).toBe(303);
    const changed = f.store.getRoutine(made.id)!;
    expect(changed).toMatchObject({ requirements: ["env:DOCS_TOKEN"], budgetPerRunMicrousd: 2_000_000, approvedAt: null });
    expect(changed.digest).toBe(routineDigestOf(changed, changed.profile));
    const review = await f.get(`/routines/${made.id}`); expect(review).toContain("$2.00 per run"); expect(review).toContain("env:DOCS_TOKEN");
  } finally { await f.close(); }
});
