import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperate, EXIT } from "./operate.js";

const T0 = new Date("2026-08-11T22:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("operating the queue from the command line", () => {
  let dir: string;
  let db: string;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nightorders-operate-"));
    db = join(dir, "orders.db");
    lines = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Run a command against the scratch queue and keep what it printed. */
  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now });
  };

  const out = () => lines.join("\n");
  const payload = () => JSON.parse(out());

  describe("the contract an agent depends on", () => {
    test("every command answers in one envelope, success or failure", async () => {
      await run(["task", "add", "a thing", "--id", "t-1", "--json"]);
      expect(payload()).toMatchObject({ ok: true, command: "task add" });

      await run(["claim", "nope", "--runner", "r", "--json"]);
      expect(payload()).toMatchObject({ ok: false, command: "claim", reason: "unknown-task" });
    });

    test("separates a refusal from a breakage in the exit code", async () => {
      // The distinction the whole loop rests on: "there is nothing to do" and
      // "the queue is broken" must not look alike to a caller.
      expect(await run(["ready"])).toBe(EXIT.refused);

      await run(["task", "add", "a thing", "--id", "t-1"]);
      expect(await run(["ready"])).toBe(EXIT.ok);
    });

    test("says bad usage with its own code, not as a refusal", async () => {
      expect(await run(["claim", "t-1"])).toBe(EXIT.usage);
      expect(await run(["task", "state", "t-1", "sideways"])).toBe(EXIT.usage);
      expect(await run(["task", "nonsense"])).toBe(EXIT.usage);
    });

    test("gives a stable reason token, not just prose", async () => {
      // Messages get reworded; an agent branching on them would break silently.
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await run(["claim", "t-1", "--runner", "first"]);
      await run(["claim", "t-1", "--runner", "second", "--json"], later(1_000));

      expect(payload()).toMatchObject({ ok: false, reason: "held", holder: "first" });
    });

    test("tells a fenced runner to stop rather than retry", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await run(["claim", "t-1", "--runner", "first", "--ttl", "60", "--json"]);
      const stale = payload().lease.leaseId;
      await run(["claim", "t-1", "--runner", "second"], later(61_000));

      const code = await run(["release", stale, "--json"], later(62_000));

      expect(code).toBe(EXIT.refused);
      expect(payload()).toMatchObject({ ok: false, reason: "fenced" });
      expect(payload().message).toContain("stop rather than retry");
    });
  });

  describe("retries", () => {
    test("a repeated add with the same key queues one task, and says so twice", async () => {
      // The case: the command succeeded, the answer was lost, the agent
      // retried. Reporting "already exists" the second time would tell it a
      // task it created does not belong to it.
      await run(["task", "add", "only once", "--id", "t-1", "--key", "k-1", "--json"]);
      const first = payload();

      const code = await run(["task", "add", "only once", "--id", "t-1", "--key", "k-1", "--json"]);

      expect(code).toBe(EXIT.ok);
      expect(payload()).toEqual(first);

      await run(["task", "list", "--json"]);
      expect(payload().count).toBe(1);
    });

    test("a repeated claim with the same key holds one lease, not two", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await run(["claim", "t-1", "--runner", "r", "--key", "d-1", "--json"]);
      const first = payload().lease.leaseId;

      await run(["claim", "t-1", "--runner", "r", "--key", "d-1", "--json"], later(1_000));

      expect(payload().lease.leaseId).toBe(first);
      expect(payload().lease.generation).toBe(1);
    });

    test("does not make a refusal permanent", async () => {
      // A refusal mutated nothing, so replaying it would answer for a task
      // that has since become free.
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await run(["claim", "t-1", "--runner", "first", "--ttl", "60"]);

      expect(await run(["claim", "t-1", "--runner", "second", "--key", "d-9"], later(1_000))).toBe(
        EXIT.refused,
      );
      expect(await run(["claim", "t-1", "--runner", "second", "--key", "d-9"], later(61_000))).toBe(
        EXIT.ok,
      );
    });

    test("does not make a missing task permanent either", async () => {
      expect(await run(["task", "state", "later", "done", "--key", "s-1"])).toBe(EXIT.refused);
      await run(["task", "add", "arrived late", "--id", "later"]);

      expect(await run(["task", "state", "later", "done", "--key", "s-1"])).toBe(EXIT.ok);
    });
  });

  describe("the dispatch loop", () => {
    test("holds a task back until what it waits for is done", async () => {
      await run(["task", "add", "schema", "--id", "schema"]);
      await run(["task", "add", "api", "--id", "api"]);
      await run(["task", "block", "api", "--on", "schema"]);

      await run(["ready", "--json"]);
      expect(payload().tasks.map((task: { id: string }) => task.id)).toEqual(["schema"]);

      await run(["task", "state", "schema", "done"], later(1_000));
      await run(["ready", "--json"], later(2_000));
      expect(payload().tasks.map((task: { id: string }) => task.id)).toEqual(["api"]);
    });

    test("takes a claimed task out of the ready set and marks it running", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await run(["claim", "t-1", "--runner", "r"]);

      expect(await run(["ready"], later(1_000))).toBe(EXIT.refused);
      await run(["task", "show", "t-1", "--json"], later(1_000));
      expect(payload().task.state).toBe("running");
    });

    test("puts unfinished work back rather than assuming it succeeded", async () => {
      // Releasing means "I am done holding this", not "it worked". Marking it
      // done here would quietly close work nobody finished.
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await run(["claim", "t-1", "--runner", "r", "--json"]);
      const lease = payload().lease.leaseId;

      await run(["release", lease], later(1_000));

      await run(["task", "show", "t-1", "--json"], later(2_000));
      expect(payload().task.state).toBe("queued");
      expect(await run(["ready"], later(2_000))).toBe(EXIT.ok);
    });

    test("keeps a heartbeating runner's task away from everyone else", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await run(["claim", "t-1", "--runner", "first", "--ttl", "60", "--json"]);
      const lease = payload().lease.leaseId;

      await run(["heartbeat", lease, "--ttl", "60"], later(50_000));

      expect(await run(["claim", "t-1", "--runner", "second"], later(80_000))).toBe(EXIT.refused);
    });

    test("reaps what ran out, and reports what it released", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await run(["claim", "t-1", "--runner", "r", "--ttl", "60"]);

      const code = await run(["reap", "--json"], later(120_000));

      expect(code).toBe(EXIT.ok);
      expect(payload().count).toBe(1);
      expect(payload().released[0].runner).toBe("r");
    });

    test("leaves a held task out of the ready set until the hold lifts", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await run(["task", "hold", "t-1", "--reason", "waiting on the design call"]);

      expect(await run(["ready"], later(1_000))).toBe(EXIT.refused);

      await run(["task", "unhold", "t-1"], later(2_000));
      expect(await run(["ready"], later(3_000))).toBe(EXIT.ok);
    });

    test("refuses a hold that would outlive an unreadable date", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);

      expect(await run(["task", "hold", "t-1", "--reason", "x", "--until", "next tuesday"])).toBe(
        EXIT.usage,
      );
    });
  });

  describe("authoring", () => {
    test("refuses a dependency cycle and says why", async () => {
      await run(["task", "add", "a", "--id", "a"]);
      await run(["task", "add", "b", "--id", "b"]);
      await run(["task", "block", "b", "--on", "a"]);

      const code = await run(["task", "block", "a", "--on", "b", "--json"]);

      expect(code).toBe(EXIT.refused);
      expect(payload().message).toContain("cycle");
    });

    test("will not block on a task that does not exist", async () => {
      await run(["task", "add", "a", "--id", "a"]);

      expect(await run(["task", "block", "a", "--on", "ghost"])).toBe(EXIT.refused);
    });

    test("makes an id from the title when none is given", async () => {
      await run(["task", "add", "Migrate the payouts schema", "--json"]);

      expect(payload().task.id).toMatch(/^migrate-the-payouts-schema-\d{6}$/);
    });

    test("shows what a task waits for and who holds it", async () => {
      await run(["task", "add", "a", "--id", "a"]);
      await run(["task", "add", "b", "--id", "b"]);
      await run(["task", "block", "b", "--on", "a"]);
      await run(["claim", "a", "--runner", "r"]);

      await run(["task", "show", "b", "--json"], later(1_000));
      expect(payload().blockedBy).toEqual(["a"]);

      await run(["task", "show", "a", "--json"], later(1_000));
      expect(payload().claim.runner).toBe("r");
    });

    test("lists nothing without inventing an error", async () => {
      expect(await run(["task", "list"])).toBe(EXIT.ok);
      expect(out()).toContain("empty");
    });
  });

  test("names an unreadable flag rather than guessing", async () => {
    expect(await run(["claim", "t-1", "--runner"])).toBe(EXIT.usage);
    expect(out()).toContain("--runner");
  });

  test("prints the surface when asked for `task` alone", async () => {
    expect(await run(["task"])).toBe(EXIT.ok);
    expect(out()).toContain("nightorders claim");
  });
});
