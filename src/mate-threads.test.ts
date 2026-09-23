import { afterEach, describe, expect, test } from "vitest";
import { openStore, type Store } from "./store.js";

// v77: the lead conversation, each project and each task keep their own
// thread per person; the chat list shows the ones that have messages.
describe("scoped lead threads (v77)", () => {
  let store: Store | null = null;
  afterEach(() => { store?.close(); store = null; });
  const T0 = new Date("2026-09-23T12:00:00.000Z");
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

  test("lead, project and task threads are separate, reopen as themselves, and list newest first", () => {
    store = openStore(":memory:");
    const lead = store.openMateThread("alex", "c1", T0).thread;
    const project = store.openMateThread("alex", "c1", T0, { kind: "project", key: "/repo/app" }).thread;
    const task = store.openMateThread("alex", "c1", T0, { kind: "task", key: "t-1" }).thread;
    expect(new Set([lead.id, project.id, task.id]).size).toBe(3);
    expect(lead.scope).toEqual({ kind: "lead" });
    expect(project.scope).toEqual({ kind: "project", key: "/repo/app" });
    expect(task.scope).toEqual({ kind: "task", key: "t-1" });
    // Reopening a scope finds its own thread; the lead is still the default.
    expect(store.openMateThread("alex", "c1", at(1), { kind: "task", key: "t-1" }).thread.id).toBe(task.id);
    expect(store.openMateThread("alex", "c1", at(1)).thread.id).toBe(lead.id);
    expect(store.liveMateThreadFor("alex")?.id).toBe(lead.id);
    expect(store.liveMateThreadFor("alex", { kind: "project", key: "/repo/app" })?.id).toBe(project.id);
    expect(store.liveMateThreadFor("alex", { kind: "task", key: "t-2" })).toBeNull();
    // Another person's task thread is theirs alone.
    expect(store.openMateThread("sam", "c1", T0, { kind: "task", key: "t-1" }).thread.id).not.toBe(task.id);

    // Only threads with messages are listed, newest message first.
    expect(store.listMateThreads("alex")).toEqual([]);
    store.appendMateMessage({ thread: task.id, turn: null, role: "operator", text: "Where is this?" }, at(2));
    store.appendMateMessage({ thread: project.id, turn: null, role: "operator", text: "What next?" }, at(3));
    const listed = store.listMateThreads("alex");
    expect(listed.map(one => one.scope)).toEqual([{ kind: "project", key: "/repo/app" }, { kind: "task", key: "t-1" }]);
    expect(listed[0]).toMatchObject({ lastMessage: "What next?", messages: 1, lastMessageAt: at(3).toISOString() });
  });

  test("a new ceiling closes only the reopened scope's thread, and ending the conversation closes every scope", () => {
    store = openStore(":memory:");
    const task = store.openMateThread("alex", "c1", T0, { kind: "task", key: "t-1" }).thread;
    const lead = store.openMateThread("alex", "c1", T0).thread;
    const moved = store.openMateThread("alex", "c2", at(1), { kind: "task", key: "t-1" });
    expect(moved.ceilingChanged).toBe(true);
    expect(moved.thread.id).not.toBe(task.id);
    expect(store.getMateThread(lead.id)?.closedAt).toBeNull();
    expect(store.closeMateThreadsFor("alex", at(2))).toBe(2);
    expect(store.liveMateThreadFor("alex")).toBeNull();
    expect(store.liveMateThreadFor("alex", { kind: "task", key: "t-1" })).toBeNull();
  });
});
