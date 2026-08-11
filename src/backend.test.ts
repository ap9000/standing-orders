import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { builtIn, guarded, type GraphBackend, type Runner } from "./backend.js";
import { githubIssues } from "./issues.js";
import { beads } from "./beads.js";
import { proposeGrant, type MutationClass } from "./grant.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-11T22:00:00.000Z");
const REPO = "/code/thing";

/** A runner driven by `binary arg0[ arg1]` keys, so tests read as intentions. */
function runnerFor(replies: Record<string, Partial<typeof OK>>): Runner {
  return async (file, args) => {
    const two = `${file} ${args[0]} ${args[1]}`;
    const one = `${file} ${args[0]}`;
    const reply = replies[two] ?? replies[one];
    return { ...OK, ...(reply ?? { code: 1, stderr: `no stub for ${one}` }) };
  };
}

async function grantEverything(store: Store, backend: string, mutations?: MutationClass[]) {
  const grant = await proposeGrant({
    repo: REPO,
    backend,
    paths: ["anything"],
    ...(mutations === undefined ? {} : { mutations }),
    selector: "all",
    now: T0,
    runner: async () => ({ ...OK, code: 0 }),
  });
  store.saveGrant(grant);
}

describe("the built-in backend behind the shared contract", () => {
  let store: Store;
  let backend: GraphBackend;

  beforeEach(() => {
    store = openStore(":memory:");
    backend = builtIn(store, () => T0);
  });

  afterEach(() => store.close());

  test("creates, reads back, and reports its own id", async () => {
    const created = await backend.create({ title: "Migrate the payouts schema" });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const got = await backend.get(created.value);
    expect(got.ok && got.value?.title).toBe("Migrate the payouts schema");
  });

  test("answers null for a task it does not have, rather than failing", async () => {
    // "Not there" and "could not ask" are different answers and a scheduler
    // has to tell them apart.
    const got = await backend.get("ghost");

    expect(got).toEqual({ ok: true, value: null });
  });

  test("orders the ready set by its own dependency edges", async () => {
    const first = await backend.create({ title: "schema" });
    const second = await backend.create({ title: "api" });
    if (!first.ok || !second.ok) throw new Error("setup failed");

    await backend.addEdge(second.value, first.value);

    const ready = await backend.listReady();
    expect(ready.ok && ready.value.map(task => task.id)).toEqual([first.value]);
  });

  test("refuses a cycle through the contract, not just through the store", async () => {
    const a = await backend.create({ title: "a" });
    const b = await backend.create({ title: "b" });
    if (!a.ok || !b.ok) throw new Error("setup failed");
    await backend.addEdge(b.value, a.value);

    const cycle = await backend.addEdge(a.value, b.value);

    expect(cycle.ok).toBe(false);
  });
});

describe("GitHub Issues", () => {
  const backend = (replies: Record<string, Partial<typeof OK>>, deps = "unverified" as const) =>
    githubIssues({ repo: REPO, runner: runnerFor(replies), deps });

  test("reads open issues", async () => {
    const ready = await backend({
      "gh issue list": {
        stdout: JSON.stringify([{ number: 12, title: "a thing", state: "OPEN" }]),
      },
    }).listReady();

    expect(ready.ok && ready.value).toEqual([{ id: "12", title: "a thing", state: "queued" }]);
  });

  test("treats a missing issue as absent and a broken call as a fault", async () => {
    const absent = await backend({
      "gh issue view": { code: 1, stderr: "could not resolve to an Issue" },
    }).get("99");
    expect(absent).toEqual({ ok: true, value: null });

    const broken = await backend({
      "gh issue view": { code: 1, stderr: "API rate limit exceeded" },
    }).get("99");
    expect(broken).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("reads the new number back off the URL gh prints", async () => {
    const created = await backend({
      "gh issue create": { stdout: "https://github.com/o/r/issues/431\n" },
    }).create({ title: "a thing" });

    expect(created).toEqual({ ok: true, value: "431" });
  });

  test("will not invent a number it could not read", async () => {
    // Handing back a made-up id would attach claims and leases to a task that
    // does not exist.
    const created = await backend({
      "gh issue create": { stdout: "created something, somewhere\n" },
    }).create({ title: "a thing" });

    expect(created).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("closes for every terminal state and reopens for the rest", async () => {
    const asked: string[] = [];
    const runner: Runner = async (_file, args) => {
      asked.push(String(args[1]));
      return { ...OK };
    };
    const gh = githubIssues({ repo: REPO, runner });

    for (const state of ["done", "failed", "cancelled", "queued"] as const) {
      await gh.setState("1", state);
    }

    expect(asked).toEqual(["close", "close", "close", "reopen"]);
  });

  test("refuses to write a dependency edge rather than emulate one", async () => {
    // A graph only we can see reads as ready to every human on the repo.
    const edge = await backend({}).addEdge("2", "1");

    expect(edge).toMatchObject({ ok: false, reason: "unsupported" });
    if (!edge.ok) expect(edge.message).toContain("does not invent them");
  });
});

describe("beads", () => {
  const backend = (replies: Record<string, Partial<typeof OK>>) =>
    beads({ repo: REPO, runner: runnerFor(replies) });

  test("reads the ready set", async () => {
    const ready = await backend({
      "bd ready": { stdout: JSON.stringify([{ id: "bd-a1b2", title: "a thing", status: "open" }]) },
    }).listReady();

    expect(ready.ok && ready.value).toEqual([{ id: "bd-a1b2", title: "a thing", state: "queued" }]);
  });

  test("writes a dependency edge, because these are native and confirmed", async () => {
    const asked: string[][] = [];
    const bd = beads({
      repo: REPO,
      runner: async (_file, args) => {
        asked.push([...args]);
        return { ...OK };
      },
    });

    const edge = await bd.addEdge("bd-child", "bd-parent");

    expect(edge.ok).toBe(true);
    expect(asked[0]).toEqual(["dep", "add", "bd-child", "bd-parent"]);
  });

  test("refuses a state change whose flag was never established", async () => {
    // Only `close` is confirmed in beads' documentation. Guessing at an update
    // flag is how a queue fills with tasks in a state nobody meant.
    const moved = await backend({}).setState("bd-a1b2", "running");

    expect(moved).toMatchObject({ ok: false, reason: "unsupported" });
    if (!moved.ok) expect(moved.message).toContain("has not been established");
  });

  test("closes for a terminal state", async () => {
    const closed = await backend({ "bd close": { stdout: "" } }).setState("bd-a1b2", "done");

    expect(closed.ok).toBe(true);
  });

  test("says so when it cannot tell what id was created", async () => {
    const created = await backend({ "bd create": { stdout: "ok\n" } }).create({ title: "a thing" });

    expect(created).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("reads an unfamiliar status as still-to-do rather than done", async () => {
    // Being wrong toward "still to do" leaves work visible; being wrong toward
    // "done" loses it.
    const ready = await backend({
      "bd ready": { stdout: JSON.stringify([{ id: "x", title: "t", status: "marinating" }]) },
    }).listReady();

    expect(ready.ok && ready.value[0]?.state).toBe("queued");
  });
});

describe("the guard around every backend", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  const gh = (replies: Record<string, Partial<typeof OK>> = {}) =>
    guarded(githubIssues({ repo: REPO, runner: runnerFor(replies) }), { store, repo: REPO });

  test("lets reads through without any grant at all", async () => {
    // Discovery has always been read-only and needs no permission.
    const ready = await gh({ "gh issue list": { stdout: "[]" } }).listReady();

    expect(ready.ok).toBe(true);
  });

  test("refuses every write without a grant", async () => {
    const backend = gh();

    expect(await backend.create({ title: "x" })).toMatchObject({ ok: false, reason: "denied" });
    expect(await backend.setState("1", "done")).toMatchObject({ ok: false, reason: "denied" });
    expect(await backend.addEdge("2", "1")).toMatchObject({ ok: false, reason: "denied" });
  });

  test("allows the write once it has been granted", async () => {
    await grantEverything(store, "github-issues");

    const created = await gh({
      "gh issue create": { stdout: "https://github.com/o/r/issues/7\n" },
    }).create({ title: "x" });

    expect(created).toEqual({ ok: true, value: "7" });
  });

  test("separates closing somebody's issue from moving a task along", async () => {
    // `transition` is granted, `close` is not — the design's default, and the
    // distinction a database cannot see but a person can.
    await grantEverything(store, "github-issues", ["create", "transition", "edge", "hold"]);
    const backend = gh({ "gh issue reopen": {}, "gh issue close": {} });

    expect((await backend.setState("1", "queued")).ok).toBe(true);
    expect(await backend.setState("1", "done")).toMatchObject({ ok: false, reason: "denied" });
  });

  test("checks the grant before spending a network call", async () => {
    // A denial that still made the request would burn rate limit to be told no.
    let called = false;
    const backend = guarded(
      githubIssues({
        repo: REPO,
        runner: async () => {
          called = true;
          return { ...OK };
        },
      }),
      { store, repo: REPO },
    );

    await backend.create({ title: "x" });

    expect(called).toBe(false);
  });

  test("a new backend inherits the check by construction", async () => {
    // The guard wraps rather than being called from inside each adapter,
    // because an authorization every implementation must remember to invoke is
    // one that a future adapter forgets, silently.
    const naive: GraphBackend = {
      name: "invented-later",
      deps: "none",
      listReady: async () => ({ ok: true, value: [] }),
      get: async () => ({ ok: true, value: null }),
      create: async () => ({ ok: true, value: "written-anyway" }),
      setState: async () => ({ ok: true, value: undefined }),
      addEdge: async () => ({ ok: true, value: undefined }),
    };

    const wrapped = guarded(naive, { store, repo: REPO });

    expect(await wrapped.create({ title: "x" })).toMatchObject({ ok: false, reason: "denied" });
  });
});
