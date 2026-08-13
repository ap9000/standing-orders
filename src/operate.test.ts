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
    // The database is new each test, so tokens minted against the last one
    // are not credentials any more — cached across tests they authenticate
    // against a runner that no longer exists.
    tokens.clear();
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

  /** Tokens are minted per registration, so they are fetched on demand. */
  const tokens = new Map<string, string>();
  const tokenFor = async (name: string) => {
    const cached = tokens.get(name);
    if (cached !== undefined) return cached;
    await run(["runner", "register", name, "--json"]);
    const minted = payload().token as string;
    tokens.set(name, minted);
    return minted;
  };

  /**
   * `claim`, with the runner registered and its token supplied — which is now
   * the only way to take work. A name alone would make the credential
   * decorative, so the tests go through the same door a runner does.
   */
  const claim = async (argv: string[], now: Date = T0) => {
    const at = argv.indexOf("--runner");
    if (at < 0) return run(argv, now);
    const token = await tokenFor(argv[at + 1] as string);
    return run([...argv, "--token", token], now);
  };

  describe("the contract an agent depends on", () => {
    test("every command answers in one envelope, success or failure", async () => {
      await run(["task", "add", "a thing", "--id", "t-1", "--json"]);
      expect(payload()).toMatchObject({ ok: true, command: "task add" });

      await claim(["claim", "nope", "--runner", "r", "--json"]);
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
      expect(await claim(["claim", "t-1"])).toBe(EXIT.usage);
      expect(await run(["task", "state", "t-1", "sideways"])).toBe(EXIT.usage);
      expect(await run(["task", "nonsense"])).toBe(EXIT.usage);
    });

    test("gives a stable reason token, not just prose", async () => {
      // Messages get reworded; an agent branching on them would break silently.
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await claim(["claim", "t-1", "--runner", "first"]);
      await claim(["claim", "t-1", "--runner", "second", "--json"], later(1_000));

      expect(payload()).toMatchObject({ ok: false, reason: "held", holder: "first" });
    });

    test("tells a fenced runner to stop rather than retry", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await claim(["claim", "t-1", "--runner", "first", "--ttl", "60", "--json"]);
      const stale = payload().lease.leaseId;
      await claim(["claim", "t-1", "--runner", "second"], later(61_000));

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
      await claim(["claim", "t-1", "--runner", "r", "--key", "d-1", "--json"]);
      const first = payload().lease.leaseId;

      await claim(["claim", "t-1", "--runner", "r", "--key", "d-1", "--json"], later(1_000));

      expect(payload().lease.leaseId).toBe(first);
      expect(payload().lease.generation).toBe(1);
    });

    test("does not make a refusal permanent", async () => {
      // A refusal mutated nothing, so replaying it would answer for a task
      // that has since become free.
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await claim(["claim", "t-1", "--runner", "first", "--ttl", "60"]);

      expect(await claim(["claim", "t-1", "--runner", "second", "--key", "d-9"], later(1_000))).toBe(
        EXIT.refused,
      );
      expect(await claim(["claim", "t-1", "--runner", "second", "--key", "d-9"], later(61_000))).toBe(
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
      await claim(["claim", "t-1", "--runner", "r"]);

      expect(await run(["ready"], later(1_000))).toBe(EXIT.refused);
      await run(["task", "show", "t-1", "--json"], later(1_000));
      expect(payload().task.state).toBe("running");
    });

    test("puts unfinished work back rather than assuming it succeeded", async () => {
      // Releasing means "I am done holding this", not "it worked". Marking it
      // done here would quietly close work nobody finished.
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await claim(["claim", "t-1", "--runner", "r", "--json"]);
      const lease = payload().lease.leaseId;

      await run(["release", lease], later(1_000));

      await run(["task", "show", "t-1", "--json"], later(2_000));
      expect(payload().task.state).toBe("queued");
      expect(await run(["ready"], later(2_000))).toBe(EXIT.ok);
    });

    test("keeps a heartbeating runner's task away from everyone else", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await claim(["claim", "t-1", "--runner", "first", "--ttl", "60", "--json"]);
      const lease = payload().lease.leaseId;

      await run(["heartbeat", lease, "--ttl", "60"], later(50_000));

      expect(await claim(["claim", "t-1", "--runner", "second"], later(80_000))).toBe(EXIT.refused);
    });

    test("reaps what ran out, and reports what it released", async () => {
      await run(["task", "add", "a thing", "--id", "t-1"]);
      await claim(["claim", "t-1", "--runner", "r", "--ttl", "60"]);

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
      await claim(["claim", "a", "--runner", "r"]);

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
    // Straight through `run`: this is about argument parsing, and going via
    // the authenticating helper would need a runner name that is not there.
    expect(await run(["claim", "t-1", "--runner"])).toBe(EXIT.usage);
    expect(out()).toContain("--runner");
  });

  test("will not take work on a name alone", async () => {
    // The credential has to be on the execution path or it is decorative:
    // anyone who could reach the queue could mint leases as anybody.
    await run(["task", "add", "a thing", "--id", "t-1"]);
    await run(["runner", "register", "builder-1", "--json"]);

    expect(await run(["claim", "t-1", "--runner", "builder-1"])).toBe(EXIT.usage);
    expect(await run(["claim", "t-1", "--runner", "builder-1", "--token", "guessed"])).toBe(
      EXIT.refused,
    );
  });

  test("prints the surface when asked for `task` alone", async () => {
    expect(await run(["task"])).toBe(EXIT.ok);
    expect(out()).toContain("nightorders claim");
  });
});

describe("write access", () => {
  let dir: string;
  let db: string;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nightorders-grant-"));
    db = join(dir, "orders.db");
    lines = [];
    // The database is new each test, so tokens minted against the last one
    // are not credentials any more — cached across tests they authenticate
    // against a runner that no longer exists.
    tokens.clear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now });
  };
  const out = () => lines.join("\n");
  const payload = () => JSON.parse(out());

  const tokens = new Map<string, string>();
  const tokenFor = async (name: string) => {
    const cached = tokens.get(name);
    if (cached !== undefined) return cached;
    await run(["runner", "register", name, "--json"]);
    const minted = payload().token as string;
    tokens.set(name, minted);
    return minted;
  };

  /** `claim`, registered and authenticated — the only way to take work now. */
  const claim = async (argv: string[], now: Date = T0) => {
    const at = argv.indexOf("--runner");
    if (at < 0) return run(argv, now);
    const token = await tokenFor(argv[at + 1] as string);
    return run([...argv, "--token", token], now);
  };

  test("grants nothing without --yes, and shows the terms first", async () => {
    // Printing the terms after the fact would be a receipt, not consent.
    const code = await run(["enroll", dir, "--backend", "beads", "--paths", ".beads"]);

    expect(code).toBe(EXIT.ok);
    expect(out()).toContain("Nothing has been granted");
    expect(out()).toContain("may do");
    expect(out()).toContain("only those Night Orders created or was given");

    await run(["grants", "--json"]);
    expect(payload().count).toBe(0);
  });

  test("records the grant once it is agreed to", async () => {
    await run(["enroll", dir, "--backend", "beads", "--paths", ".beads", "--yes", "--json"]);

    expect(payload()).toMatchObject({ ok: true, command: "enroll" });
    await run(["grants", "--json"]);
    expect(payload().grants[0]).toMatchObject({ backend: "beads", selector: "ours" });
  });

  test("withholds `close` unless it is asked for", async () => {
    await run(["enroll", dir, "--backend", "beads", "--paths", ".beads", "--yes", "--json"]);
    expect(payload().grant.mutations).not.toContain("close");

    await run([
      "enroll", dir, "--backend", "beads", "--paths", ".beads",
      "--allow", "create,close", "--yes", "--json",
    ]);
    expect(payload().grant.mutations).toEqual(["create", "close"]);
  });

  test("refuses a mutation class it does not have", async () => {
    expect(
      await run(["enroll", dir, "--backend", "beads", "--paths", ".beads", "--allow", "delete-everything"]),
    ).toBe(EXIT.usage);
  });

  test("will not enrol a non-built-in backend without being told what it may write", async () => {
    // Guessing where somebody's tracker keeps its data and then writing there
    // is the exact move this module exists to prevent.
    expect(await run(["enroll", dir, "--backend", "beads"])).toBe(EXIT.usage);
    expect(out()).toContain("--paths");
  });

  test("replaces rather than accumulates on a second enrolment", async () => {
    await run(["enroll", dir, "--backend", "beads", "--paths", ".beads", "--yes"]);
    await run(["enroll", dir, "--backend", "beads", "--paths", ".beads", "--selector", "all", "--yes"]);

    await run(["grants", "--json"]);
    expect(payload().count).toBe(1);
    expect(payload().grants[0].selector).toBe("all");
  });

  test("takes it back without ceremony", async () => {
    // A confirmation prompt on the brakes is how people stop using them.
    await run(["enroll", dir, "--backend", "beads", "--paths", ".beads", "--yes"]);

    expect(await run(["revoke", dir, "--backend", "beads"])).toBe(EXIT.ok);
    await run(["grants", "--json"]);
    expect(payload().count).toBe(0);
  });

  test("says so when there was nothing to revoke", async () => {
    expect(await run(["revoke", dir, "--backend", "beads", "--json"])).toBe(EXIT.refused);
    expect(payload().reason).toBe("no-grant");
  });

  test("says plainly that nothing is enrolled", async () => {
    await run(["grants"]);
    expect(out()).toContain("read-only until something is");
  });

  test("refuses a selector it does not understand", async () => {
    expect(
      await run(["enroll", dir, "--backend", "beads", "--paths", ".beads", "--selector", "everything"]),
    ).toBe(EXIT.usage);
  });
});

describe("the grant is actually enforced", () => {
  let dir: string;
  let db: string;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nightorders-enforce-"));
    db = join(dir, "orders.db");
    lines = [];
    // The database is new each test, so tokens minted against the last one
    // are not credentials any more — cached across tests they authenticate
    // against a runner that no longer exists.
    tokens.clear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now });
  };
  const out = () => lines.join("\n");
  const payload = () => JSON.parse(out());

  const tokens = new Map<string, string>();
  const tokenFor = async (name: string) => {
    const cached = tokens.get(name);
    if (cached !== undefined) return cached;
    await run(["runner", "register", name, "--json"]);
    const minted = payload().token as string;
    tokens.set(name, minted);
    return minted;
  };

  /** `claim`, registered and authenticated — the only way to take work now. */
  const claim = async (argv: string[], now: Date = T0) => {
    const at = argv.indexOf("--runner");
    if (at < 0) return run(argv, now);
    const token = await tokenFor(argv[at + 1] as string);
    return run([...argv, "--token", token], now);
  };

  test("refuses to claim a task in an unenrolled tracker", async () => {
    // This is the check that makes the boundary real rather than decorative:
    // taking somebody's issue transitions it, and that is a write.
    const code = await claim([
      "claim", "17", "--backend", "github-issues", "--repo", dir, "--runner", "r", "--json",
    ]);

    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "no-grant" });
    expect(payload().message).toContain("nightorders enroll");
  });

  test("still refuses once enrolled, when the task is not ours", async () => {
    // The default selector is the spec's "never every open task it happened
    // to find" — enrolling a repo full of issues does not volunteer them.
    await run([
      "enroll", dir, "--backend", "github-issues", "--paths", "owner/name", "--yes",
    ]);

    const code = await claim([
      "claim", "17", "--backend", "github-issues", "--repo", dir, "--runner", "r", "--json",
    ]);

    expect(code).toBe(EXIT.refused);
    expect(payload().reason).toBe("selector");
  });

  test("allows it once the grant covers every task", async () => {
    await run([
      "enroll", dir, "--backend", "github-issues", "--paths", "owner/name",
      "--selector", "all", "--yes",
    ]);

    expect(
      await claim(["claim", "17", "--backend", "github-issues", "--repo", dir, "--runner", "r"]),
    ).toBe(EXIT.ok);
  });

  test("refuses when the granted mutation class does not cover a claim", async () => {
    await run([
      "enroll", dir, "--backend", "github-issues", "--paths", "owner/name",
      "--selector", "all", "--allow", "create", "--yes",
    ]);

    const code = await claim([
      "claim", "17", "--backend", "github-issues", "--repo", dir, "--runner", "r", "--json",
    ]);

    expect(code).toBe(EXIT.refused);
    expect(payload().reason).toBe("mutation");
  });

  test("does not accept a grant made for a different repository", async () => {
    await run([
      "enroll", dir, "--backend", "github-issues", "--paths", "owner/name",
      "--selector", "all", "--yes",
    ]);

    const code = await claim([
      "claim", "17", "--backend", "github-issues", "--repo", join(dir, "elsewhere"),
      "--runner", "r", "--json",
    ]);

    expect(code).toBe(EXIT.refused);
    expect(payload().reason).toBe("no-grant");
  });

  test("recognises the same repository written a different way", async () => {
    // enroll resolves its path; if the claim side did not, a grant stored
    // absolute would be missed by a lookup for `.` — denying permission that
    // was genuinely given, in a way that looks exactly like the check working.
    await run([
      "enroll", dir, "--backend", "github-issues", "--paths", "owner/name",
      "--selector", "all", "--yes",
    ]);

    const code = await claim([
      "claim", "17", "--backend", "github-issues", "--repo", join(dir, "sub", ".."),
      "--runner", "r",
    ]);

    expect(code).toBe(EXIT.ok);
  });

  test("leaves the built-in queue alone, since it is ours by construction", async () => {
    await run(["task", "add", "a thing", "--id", "t-1"]);

    expect(await claim(["claim", "t-1", "--runner", "r"])).toBe(EXIT.ok);
  });

  test("records who created a task rather than taking the caller's word", async () => {
    // Merely referring to a task must never be what makes it ours to write.
    await run(["task", "add", "ours", "--id", "mine", "--json"]);
    expect(payload().task.id).toBe("mine");

    await run(["ready", "--json"], later(1_000));
    expect(payload().tasks[0].id).toBe("mine");
  });
});

describe("agreeing to a scope from the command line", () => {
  let dir: string;
  let db: string;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nightorders-scope-"));
    db = join(dir, "orders.db");
    lines = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now });
  };
  const out = () => lines.join("\n");
  const payload = () => JSON.parse(out());

  /** Registering somebody who may say yes, and writing a scope to say it about. */
  const scopeIt = async () => {
    await run(["approver", "add", "alex", "--json"]);
    approverToken = payload().token as string;
    await run(["task", "add", "fix the payouts flow", "--id", "pay"]);
    await run(["task", "scope", "pay", "--goal", "add a guard", "--json"]);
    return payload().scope.digest as string;
  };
  let approverToken = "";

  test("approving without --yes shows the terms and changes nothing", async () => {
    await scopeIt();

    const code = await run(["task", "approve", "pay"]);

    expect(code).toBe(EXIT.ok);
    expect(out()).toContain("Nothing has been approved");
    await run(["task", "show", "pay", "--json"]);
    expect(payload().approval.approved).toBe(false);
  });

  test("--yes alone is not enough: the exact scope has to be named", async () => {
    // An operator reads scope A, somebody rewrites it to B, and an approval
    // that did not name what it saw would agree to B in silence.
    await scopeIt();

    const code = await run(["task", "approve", "pay", "--yes"]);

    expect(code).toBe(EXIT.ok);
    expect(out()).toContain("--digest");
    await run(["task", "show", "pay", "--json"]);
    expect(payload().approval.approved).toBe(false);
  });

  test("naming the scope you read approves it", async () => {
    const digest = await scopeIt();

    expect(
      await run(["task", "approve", "pay", "--yes", "--digest", digest, "--as", "alex", "--token", approverToken]),
    ).toBe(EXIT.ok);

    await run(["task", "show", "pay", "--json"]);
    expect(payload().approval).toMatchObject({ approved: true });
  });

  test("naming a scope that has since been rewritten is refused", async () => {
    const stale = await scopeIt();
    await run(["task", "scope", "pay", "--goal", "rewrite the billing model"]);

    const code = await run([
      "task", "approve", "pay", "--yes", "--digest", stale,
      "--as", "alex", "--token", approverToken, "--json",
    ]);

    expect(code).toBe(EXIT.refused);
    expect(payload().reason).toBe("changed");
  });

  test("a task with no scope says so rather than approving nothing", async () => {
    await run(["task", "add", "a thing", "--id", "t-1"]);

    expect(
      await run(["task", "approve", "t-1", "--yes", "--digest", "x", "--as", "alex", "--token", "t"]),
    ).toBe(EXIT.refused);
  });
});

describe("routine — standing orders from the command line", () => {
  let dir: string;
  let db: string;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nightorders-routine-cli-"));
    db = join(dir, "orders.db");
    lines = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (argv: string[], now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now });
  };
  const out = () => lines.join("\n");
  const payload = () => JSON.parse(out());

  test("file, refuse to fire unapproved, approve with the credential, run now", async () => {
    await run(["approver", "add", "alex", "--json"]);
    const token = payload().token as string;

    const filed = await run([
      "routine", "add", "nightly-deps",
      "--repo", dir, "--goal", "Refresh the lockfile",
      "--schedule", "daily:03:30", "--ceiling", "5",
    ]);
    expect(filed).toBe(EXIT.ok);
    expect(out()).toContain("Nothing fires until somebody approves");
    expect(out()).toContain("BUILDS WITHOUT ASKING");

    // Unarmed approve prints the order and the exact command — approves nothing.
    const unarmed = await run(["routine", "approve", "nightly-deps", "--json"]);
    expect(unarmed).toBe(EXIT.refused);
    expect(payload().reason).toBe("unconfirmed");
    const digest = payload().routine.digest as string;

    // run-now before approval refuses: there is no standing order yet.
    const early = await run(["routine", "run-now", "nightly-deps", "--as", "alex", "--token", token, "--json"]);
    expect(early).toBe(EXIT.refused);
    expect(payload().reason).toBe("not-approved");

    const approved = await run([
      "routine", "approve", "nightly-deps", "--yes", "--digest", digest, "--as", "alex", "--token", token, "--json",
    ]);
    expect(approved).toBe(EXIT.ok);
    expect(payload().routine.approvedBy).toBe("alex");

    const fired = await run(["routine", "run-now", "nightly-deps", "--as", "alex", "--token", token, "--json"]);
    expect(fired).toBe(EXIT.ok);
    expect(payload().taskId).toContain("nightly-deps-");

    const shown = await run(["routine", "show", "nightly-deps"]);
    expect(shown).toBe(EXIT.ok);
    expect(out()).toContain("live");
    expect(out()).toContain("$5.00 per rolling 7 days");
    expect(out()).toContain("recent firings");

    await run(["routine", "pause", "nightly-deps"]);
    const listed = await run(["routine", "list"]);
    expect(listed).toBe(EXIT.ok);
    expect(out()).toContain("paused");
  });

  test("a bad definition names every problem at once and stores nothing", async () => {
    const bad = await run([
      "routine", "add", "bad-one",
      "--repo", dir, "--goal", "", "--schedule", "hourly", "--ceiling", "-3",
    ]);
    expect(bad).toBe(EXIT.usage);
    expect(out()).toContain("goal");
    expect(out()).toContain("schedule");
    expect(out()).toContain("costCeilingUsd");
    const listed = await run(["routine", "list", "--json"]);
    expect(payload().routines).toEqual([]);
    expect(listed).toBe(EXIT.ok);
  });
});
