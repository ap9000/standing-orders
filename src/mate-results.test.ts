/**
 * The lead reads a result the way a person does: every changed file, one
 * file's diff in pages, and the check log's end or the lines around an
 * error — always for one exact finished result the person may read, from
 * verified bytes. Real store, real evidence files.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Artifact, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { executeMateTool, patchFiles } from "./mate-tools.js";

const T0 = new Date("2026-09-23T09:00:00.000Z");
const PATCH = [
  "diff --git a/src/button.tsx b/src/button.tsx",
  "--- a/src/button.tsx",
  "+++ b/src/button.tsx",
  "@@ -1,3 +1,3 @@",
  "-export const size = 12;",
  "+export const size = 16;",
  " export const tone = 'accent';",
  "diff --git a/src/app.css b/src/app.css",
  "--- a/src/app.css",
  "+++ b/src/app.css",
  "@@ -4,2 +4,4 @@",
  "+.button { padding: 8px; }",
  "+.button:hover { opacity: .9; }",
  "",
].join("\n");

describe("the lead reads diffs and check logs", () => {
  let dir: string;
  let evidenceRoot: string;
  let store: Store;
  let token: string;
  let repo: string;
  let other: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-mate-results-")));
    evidenceRoot = join(dir, "evidence");
    repo = join(dir, "app");
    other = join(dir, "private");
    for (const path of [evidenceRoot, repo, other]) mkdirSync(path);
    store = openStore(join(dir, "orders.db"));
    for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "ops", T0);
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    token = added.token;
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const who = (admitted: string[]): VerifiedApprover => {
    const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, admitted);
    if (!verified.ok) throw new Error(verified.reason);
    return verified.who;
  };
  const finished = (id: string, place: string): number => {
    store.createTask({ id, title: `Work ${id}` }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, place);
    propose(store, { taskId: id, goal: `do ${id}`, touches: ["src/"], acceptance: [{ id: "c1", statement: "It holds", how: null, evidence: ["check"] }], now: T0 });
    if (!approve(store, id, "alex", T0, store.getScope(id)!.digest, token).ok) throw new Error("approval");
    const route = store.routeAuthorityFor(ref, "builder", null);
    if (!route?.ok) throw new Error("route");
    const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "builder-1", branch: `so/${id}`, worktree: `/pool/${id}`, route: route.stamp, now: T0 });
    store.finishRun(run, { outcome: "built", committed: true, now: T0 });
    mkdirSync(join(evidenceRoot, String(run)), { recursive: true });
    return run;
  };
  const artifact = (run: number, kind: Artifact["kind"], name: string, text: string, truncated = false): void => {
    const bytes = Buffer.from(text, "utf8");
    writeFileSync(join(evidenceRoot, String(run), name), bytes);
    store.saveArtifact({ run, kind, key: `${run}/${name}`, bytesOriginal: bytes.length, bytesStored: bytes.length, truncated, sha256: createHash("sha256").update(bytes).digest("hex"), capture: `${kind} capture (exit 0)` }, T0);
  };
  const read = (admitted: string[], tool: string, args: Record<string, unknown>) =>
    executeMateTool({ store, who: who(admitted), now: T0, evidenceRoot, step: 1, readDecisions: new Map<number, number>(), draft: () => null }, tool, args);

  test("a diff reads as its files with lines added and removed, then one file's changes; nothing outside the person's projects", () => {
    expect(patchFiles(PATCH).map(one => [one.path, one.added, one.removed])).toEqual([["src/button.tsx", 1, 1], ["src/app.css", 2, 0]]);
    const run = finished("buttons", repo);
    artifact(run, "terminal-diff", "terminal-diff.patch", PATCH);
    expect(read([repo], "get_diff", { task: "buttons" })).toMatchObject({ ok: true, body: { run, fileCount: 2, files: [{ path: "src/button.tsx", added: 1, removed: 1 }, { path: "src/app.css", added: 2, removed: 0 }], notice: null } });
    const one = read([repo], "get_diff", { task: "buttons", run, file: "button.tsx" });
    expect(one).toMatchObject({ ok: true, body: { file: "src/button.tsx", nextOffset: null } });
    expect(one.ok && (one.body as { diff: string }).diff).toContain("+export const size = 16;");
    expect(read([repo], "get_diff", { task: "buttons", file: "src/missing.ts" })).toMatchObject({ ok: false });
    // Another project's result, or a run of another task, is never read.
    const hidden = finished("secret", other);
    artifact(hidden, "terminal-diff", "terminal-diff.patch", PATCH);
    expect(read([repo], "get_diff", { task: "secret" })).toMatchObject({ ok: false });
    expect(read([repo, other], "get_diff", { task: "buttons", run: hidden })).toMatchObject({ ok: false });
    // Bytes that no longer match the recorded hash are refused, not read.
    writeFileSync(join(evidenceRoot, String(run), "terminal-diff.patch"), "tampered");
    expect(read([repo], "get_diff", { task: "buttons" })).toMatchObject({ ok: false, message: "The saved changes could not be verified." });
  });

  test("a check log reads from its end, in pages from the start, or as the lines around a search", () => {
    const run = finished("checks", repo);
    const lines = Array.from({ length: 4000 }, (_, index) => index === 3500 ? "FAIL src/button.test.tsx > keeps 44px targets" : `ok ${index} passing line`);
    const log = lines.join("\n");
    artifact(run, "check-log", "check-log.txt", log, true);
    const tail = read([repo], "get_check_log", { task: "checks" });
    expect(tail).toMatchObject({ ok: true, body: { totalChars: log.length, notice: expect.stringContaining("shortened") } });
    expect(tail.ok && (tail.body as { log: string }).log.endsWith("ok 3999 passing line")).toBe(true);
    expect(tail.ok && (tail.body as { log: string }).log.length).toBeLessThanOrEqual(8_000);
    const first = read([repo], "get_check_log", { task: "checks", offset: 0 });
    expect(first.ok && (first.body as { log: string; nextOffset: number }).log.startsWith("ok 0 passing line")).toBe(true);
    expect(first.ok && (first.body as { nextOffset: number }).nextOffset).toBe(8_000);
    const found = read([repo], "get_check_log", { task: "checks", search: "fail" });
    expect(found).toMatchObject({ ok: true, body: { matches: 1 } });
    expect(found.ok && (found.body as { log: string }).log).toBe("3499: ok 3498 passing line\n3500: ok 3499 passing line\n3501: FAIL src/button.test.tsx > keeps 44px targets\n3502: ok 3501 passing line\n3503: ok 3502 passing line\n");
    // No log saved: said plainly.
    const bare = finished("bare", repo);
    expect(read([repo], "get_check_log", { task: "bare", run: bare })).toMatchObject({ ok: true, body: { log: "", notice: "No check log was saved for this result." } });
    expect(read([other], "get_check_log", { task: "checks" })).toMatchObject({ ok: false });
  });
});
