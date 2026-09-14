import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";

/**
 * The Work destination's one bounded read (workspace package 1 query):
 * `listWorkTasksAdmitted` binds the viewer's admission and the unplaced
 * flag in SQL BEFORE the ordering and the limit. These tests read the
 * store directly, so the boundary cases hold whatever the page does with
 * the rows afterwards.
 */
describe("the Work page's bounded admitted read", () => {
  let store: Store;
  const base = new Date("2026-09-13T08:00:00.000Z");
  const at = (minutes: number): Date => new Date(base.getTime() + minutes * 60_000);
  const alpha = "/repo/alpha";
  const beta = "/repo/beta";
  const foreign = "/repo/foreign";

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  const seed = (id: string, repo: string | null, minutes: number): void => {
    store.createTask({ id, title: `task ${id}` }, at(minutes));
    const ref = store.refFor("built-in", id);
    if (repo !== null) store.placeTask(ref.id, repo);
  };
  const ids = (rows: { id: string }[]): string[] => rows.map(row => row.id);

  test("700 newer unplaced tasks a project-scoped viewer cannot see never spend its page", () => {
    seed("alpha-assigned", alpha, 0);
    seed("beta-assigned", beta, 1);
    for (let i = 0; i < 700; i++) seed(`unplaced-${String(i).padStart(3, "0")}`, null, 100 + i);
    // Restricted to beta, unplaced rows excluded: the one permitted task
    // is the whole page, whatever is newer and hidden.
    const page = store.listWorkTasksAdmitted([beta], false, 201);
    expect(ids(page)).toEqual(["beta-assigned"]);
    expect(page[0]?.repo).toBe(beta);
    // The legacy project-bound read still carries every unplaced row (and
    // caps one read at 500), which is exactly why Work no longer uses it.
    const legacy = store.listTasksScoped(beta, undefined, 500, null);
    expect(legacy).toHaveLength(500);
    expect(ids(legacy)).not.toContain("beta-assigned");
  });

  test("an unrestricted viewer who may see unplaced rows gets them newest first, bounded by the probe", () => {
    seed("alpha-assigned", alpha, 0);
    for (let i = 0; i < 700; i++) seed(`unplaced-${String(i).padStart(3, "0")}`, null, 100 + i);
    const page = store.listWorkTasksAdmitted(null, true, 201);
    expect(page).toHaveLength(201);
    expect(ids(page)[0]).toBe("unplaced-699");
    expect(ids(page)[200]).toBe("unplaced-499");
    expect(page.every(task => task.repo === null)).toBe(true);
    // Unrestricted (null) is explicit: every placed row belongs, whether
    // or not any admission list would have named its project.
    seed("foreign-newest", foreign, 2_000);
    expect(ids(store.listWorkTasksAdmitted(null, true, 5))).toEqual(["foreign-newest", "unplaced-699", "unplaced-698", "unplaced-697", "unplaced-696"]);
    expect(ids(store.listWorkTasksAdmitted(null, false, 5))).toEqual(["foreign-newest", "alpha-assigned"]);
  });

  test("excluded projects bind before the limit: 501 newer foreign tasks leave the admitted page full", () => {
    for (let i = 0; i < 201; i++) seed(`alpha-${String(i).padStart(3, "0")}`, alpha, i);
    seed("beta-newest", beta, 300);
    for (let i = 0; i < 501; i++) seed(`foreign-${String(i).padStart(3, "0")}`, foreign, 1_000 + i);
    const page = store.listWorkTasksAdmitted([alpha, beta], true, 201);
    expect(page).toHaveLength(201);
    expect(ids(page).filter(id => id.startsWith("foreign-"))).toEqual([]);
    expect(ids(page)[0]).toBe("beta-newest");
    expect(ids(page)[1]).toBe("alpha-200");
    expect(ids(page)[200]).toBe("alpha-001");
    expect(ids(page)).not.toContain("alpha-000");
    // A single admitted project reads exactly that project.
    const only = store.listWorkTasksAdmitted([alpha], true, 201);
    expect(only).toHaveLength(201);
    expect(only.every(task => task.repo === alpha)).toBe(true);
  });

  test("an empty admission never exposes a placed project; unplaced rows follow the flag alone", () => {
    seed("alpha-assigned", alpha, 0);
    seed("foreign-newest", foreign, 1);
    seed("unplaced-only", null, 2);
    expect(store.listWorkTasksAdmitted([], false, 201)).toEqual([]);
    expect(ids(store.listWorkTasksAdmitted([], true, 201))).toEqual(["unplaced-only"]);
    // The flag is a bound value, never a shape change: an admitted viewer
    // without unplaced access sees placed rows only.
    expect(ids(store.listWorkTasksAdmitted([alpha, foreign], false, 201))).toEqual(["foreign-newest", "alpha-assigned"]);
  });

  test("the 201st-row probe: 200 in view returns 200, 201 returns 201, and the limit is clamped", () => {
    for (let i = 0; i < 200; i++) seed(`alpha-${String(i).padStart(3, "0")}`, alpha, i);
    expect(store.listWorkTasksAdmitted([alpha], false, 201)).toHaveLength(200);
    seed("alpha-200", alpha, 200);
    const probe = store.listWorkTasksAdmitted([alpha], false, 201);
    expect(probe).toHaveLength(201);
    expect(ids(probe)[0]).toBe("alpha-200");
    expect(ids(probe)[200]).toBe("alpha-000");
    // Ties on created_at break on id, descending, as the task page orders.
    seed("alpha-tie-b", alpha, 200);
    seed("alpha-tie-a", alpha, 200);
    expect(ids(store.listWorkTasksAdmitted([alpha], false, 3))).toEqual(["alpha-tie-b", "alpha-tie-a", "alpha-200"]);
    // The limit is clamped in the store: never below one, never above 500,
    // never a fraction.
    expect(store.listWorkTasksAdmitted([alpha], false, 0)).toHaveLength(1);
    expect(store.listWorkTasksAdmitted([alpha], false, -7)).toHaveLength(1);
    expect(store.listWorkTasksAdmitted([alpha], false, 2.9)).toHaveLength(2);
    for (let i = 201; i < 520; i++) seed(`alpha-${i}`, alpha, 300 + i);
    expect(store.listWorkTasksAdmitted([alpha], false, 10_000)).toHaveLength(500);
  });

  test("the rows carry the task and its repo, and a bound repo value is matched exactly", () => {
    seed("alpha-assigned", alpha, 0);
    seed("alpha-look-alike", alpha + "-not-served", 1);
    const page = store.listWorkTasksAdmitted([alpha], true, 201);
    expect(page).toEqual([
      expect.objectContaining({ id: "alpha-assigned", title: "task alpha-assigned", state: "queued", repo: alpha, priority: 0, createdAt: at(0).toISOString() }),
    ]);
    // A value that would break a naive string concatenation is only ever a
    // bound parameter.
    expect(store.listWorkTasksAdmitted(["/repo/alpha' OR 1=1 --"], true, 201)).toEqual([]);
  });
});
