/** Flows in the console: create from a template, the canvas's data, cards
 * added, moved and decided through the same endpoints the canvas uses, a
 * stale save refused, and followers who can look but not change. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import type { BrowserFlowView } from "./browser-workspace.js";

let dir: string, repo: string, store: Store, password: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flows-page-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", new Date());
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("fixture");
  password = alex.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("create a flow, add a card, move it, decide it, and a stale save is refused — through the canvas's own endpoints", async () => {
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], configDir: dir });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    let html = await (await fetch(`${base}/flows`, { headers: { cookie } })).text();
    expect(html).toContain("A flow is your process drawn as zones.");
    expect(html).toContain("Coding flow: Triage, plan, build, review by a person, then tell the team.");
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    // No flows yet: one click makes a working example with a sample question in it.
    expect(html).toContain('action="/flows/example"');
    expect(html).toContain("Try an example");
    const example = await fetch(`${base}/flows/example`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, repo }), redirect: "manual" });
    expect(example.status).toBe(303);
    const exampleView = await (await fetch(`${base}${example.headers.get("location")}?format=json`, { headers: { cookie } })).json() as BrowserFlowView;
    expect(exampleView).toMatchObject({ flow: { name: "Customer replies (example)", owner: "alex" }, start: "write" });
    expect(exampleView.cards.map(one => [one.title, one.stage])).toEqual([["Do you ship to Canada?", "write"]]);
    expect(await (await fetch(`${base}/flows`, { headers: { cookie } })).text()).not.toContain("Try an example");
    const created = await fetch(`${base}/flows/new`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, name: "Bug fixes", repo, template: "coding" }), redirect: "manual" });
    expect(created.status).toBe(303);
    const href = created.headers.get("location")!;
    expect(href).toMatch(/^\/flows\/\d+$/);
    // The canvas page carries its view; the JSON form is what it refreshes from.
    html = await (await fetch(`${base}${href}`, { headers: { cookie } })).text();
    expect(html).toContain("Bug fixes");
    expect(html).toContain("<strong>Triage</strong> · Research");
    const view = await (await fetch(`${base}${href}?format=json`, { headers: { cookie } })).json() as BrowserFlowView;
    expect(view).toMatchObject({ kind: "flow", flow: { name: "Bug fixes", project: "shop", revision: 1 }, start: "inbox", canEdit: true, approvers: ["alex"] });
    expect(view.stages.map(one => [one.id, one.kind])).toEqual([["inbox", "inbox"], ["triage", "report"], ["go-ahead", "approval"], ["build", "task"], ["review", "approval"], ["announce", "notify"], ["done", "done"]]);
    const post = async (path: string, fields: Record<string, string>) => {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf, ...fields }) });
      return { status: response.status, body: await response.json() as { ok: boolean; said: string; view?: BrowserFlowView } };
    };
    expect(await post(`${href}/cards`, { title: "" })).toMatchObject({ status: 400, body: { said: "Give the card a title." } });
    const added = await post(`${href}/cards`, { title: "Checkout rounding", description: "Totals are off by a cent" });
    expect(added).toMatchObject({ status: 200, body: { ok: true, said: "Card added." } });
    const card = added.body.view!.cards[0]!;
    expect(card).toMatchObject({ title: "Checkout rounding", stage: "inbox", history: [{ text: "Added to Inbox by alex" }] });
    // Moved to the go-ahead: the approver sees the decision on the card and decides it here.
    const moved = await post(`${href}/cards/${card.id}/move`, { stage: "go-ahead" });
    expect(moved.body).toMatchObject({ ok: true, said: "Moved to Go ahead?" });
    expect(moved.body.view!.cards[0]).toMatchObject({ stage: "go-ahead", canDecide: true, waiting: "Waiting for alex to approve or send it back" });
    expect(await post(`${href}/cards/${card.id}/decide`, { decision: "send-back", note: "" })).toMatchObject({ status: 409, body: { said: "Say what should change." } });
    const decided = await post(`${href}/cards/${card.id}/decide`, { decision: "approve" });
    expect(decided.body).toMatchObject({ ok: true, said: "Approved. Moved to Build." });
    // Build filed the work as an ordinary task the card links to.
    expect(decided.body.view!.cards[0]!.task?.href).toMatch(/^\/t\//);
    // Saving over an older drawing is refused; the current one saves.
    const drawing = { version: 1, start: "inbox", stages: view.stages };
    expect(await post(`${href}/save`, { name: "Bug fixes", revision: "1", definition: JSON.stringify({ ...drawing, stages: drawing.stages.map(one => one.id === "inbox" ? { ...one, title: "New requests" } : one) }) })).toMatchObject({ status: 200, body: { said: "Saved." } });
    expect(await post(`${href}/save`, { name: "Bug fixes", revision: "1", definition: JSON.stringify(drawing) })).toMatchObject({ status: 409 });
    expect(await post(`${href}/save`, { name: "Bug fixes", revision: "2", definition: JSON.stringify({ ...drawing, stages: [{ ...drawing.stages[0]!, next: "nowhere" }] }) })).toMatchObject({ status: 400, body: { said: "Zone Inbox points at a zone that no longer exists." } });
    // A card can't carry a key into an agent's instructions.
    expect(await post(`${href}/cards`, { title: "Use key", description: `token ${["ghp", "x".repeat(36)].join("_")}` })).toMatchObject({ status: 400 });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
