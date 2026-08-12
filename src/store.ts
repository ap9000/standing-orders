/**
 * The database: a small task store, and the operational overlay beside it.
 *
 * Two things live here and they are deliberately not the same thing.
 *
 * The **task store** is the fallback backend — what you get when no beads, no
 * Backlog.md, no GitHub Issues. §4 is honest about what that makes us: anything
 * that can create, store, transition, and link tasks is a task store, and
 * pretending otherwise while shipping one would be self-deception. So it owns
 * something deliberately small — authoring, states, dependency edges, a ready
 * query — and declines to grow search, labels, comments, or sync.
 *
 * The **overlay** is backend-independent and outlives any of them. Every
 * operational record hangs off a `TaskRef` keyed by `(backend, external_id)`,
 * so an operator who starts on the built-in store and later adopts beads keeps
 * every claim, hold, and lease they had. That indirection looks like ceremony
 * until the day someone switches, at which point it is the only reason their
 * history survives.
 *
 * SQLite via `node:sqlite`, so there is no runtime dependency and no native
 * build step — `npx nightorders` has to still work on a machine with no
 * compiler, and a task store is not worth breaking that promise for.
 *
 * Deliberately absent: `workspace_id`. §4 lists it, but multiplayer and RBAC
 * are deferred until after M4, and a column that exists to serve a feature
 * nobody has designed yet is a column that will be wrong when they do.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BackendGrant, MutationClass, TaskOrigin } from "./grant.js";
import type { Runner } from "./runner.js";
import type { Scope } from "./scope.js";

export const SCHEMA_VERSION = 1;

/**
 * Every timestamp column holds `Date.prototype.toISOString()` output and
 * nothing else, which is UTC, zero-padded, and always three fractional
 * digits. Expiry is then a string comparison, which is only sound because that
 * format sorts lexicographically the same way it sorts chronologically.
 *
 * The invariant is load-bearing, so it is stated here rather than assumed: a
 * timestamp written with an offset (`-07:00`) or with different fractional
 * precision would compare wrong, and a lease would expire early or never.
 * Anything writing to this database goes through a `Date`.
 */

/** The backend name the built-in store registers itself under. */
export const BUILT_IN = "built-in";

export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled";

/** States from which no further work is dispatched. */
export const TERMINAL_STATES: readonly TaskState[] = ["done", "failed", "cancelled"];

export type Task = {
  id: string;
  title: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
};

export type TaskRef = {
  id: number;
  backend: string;
  externalId: string;
  /** Where the work lives, when known. null dispatches anywhere; no gap claims it. */
  repo: string | null;
  zones: string[];
  capabilityRequirements: string[];
  parkRate: number;
  /** Recorded, not asserted: what the grant's selector is checked against. */
  origin: TaskOrigin;
};

export type Hold = { taskRef: number; reason: string; until: string | null; heldAt: string };

/** Something a repo's work needs. Metadata only; the value lives on the runner. */
export type Capability = {
  repo: string;
  kind: "env" | "cli" | "mcp" | "ci" | "other";
  name: string;
  /** A command whose exit 0 means "present and alive". null: nothing can vouch. */
  probe: string | null;
  status: "unprobed" | "verified" | "failed";
  addedBy: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  /** Whose environment answered the probe. Verification is a claim about one machine. */
  verifiedBy: string | null;
  /** What the probe said when it said no. */
  lastResult: string | null;
  expiresAt: string | null;
};

/** `kind:name`, the unambiguous way a requirement names a capability. */
export function capabilityKey(capability: Pick<Capability, "kind" | "name">): string {
  return `${capability.kind}:${capability.name}`;
}

/** Parse `kind:name`; a bare name is refused rather than guessed at. */
export function parseCapabilityKey(
  key: string,
): { kind: Capability["kind"]; name: string } | null {
  const split = key.indexOf(":");
  if (split <= 0 || split === key.length - 1) return null;
  const kind = key.slice(0, split);
  if (!["env", "cli", "mcp", "ci", "other"].includes(kind)) return null;
  return { kind: kind as Capability["kind"], name: key.slice(split + 1) };
}

/** One build attempt. `outcome` null means it never finished — also an answer. */
export type Run = {
  id: number;
  taskRef: number;
  leaseId: string;
  runner: string;
  branch: string;
  worktree: string;
  model: string | null;
  outcome: "built" | "failed" | "refused" | null;
  reason: string | null;
  committed: boolean | null;
  startedAt: string;
  finishedAt: string | null;
};

/** Every mutation takes one. A repeat returns the first answer, unchanged. */
export type Mutation = {
  idempotencyKey?: string;
  actor?: string;
  /** When it happened. Supplied by callers that hold a clock; see `once`. */
  at?: Date;
};

export const DEFAULT_ACTOR = "operator";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- The built-in task store.
CREATE TABLE IF NOT EXISTS task (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Dependency edges, owned natively because this backend is ours. Edges are
-- never emulated on top of a backend that lacks them; see §4.
CREATE TABLE IF NOT EXISTS task_edge (
  blocked TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  blocker TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY (blocked, blocker),
  CHECK (blocked <> blocker)
);

-- The overlay starts here. Nothing below this line knows which backend the
-- work actually lives in.
-- The origin column is what the grant's default selector actually rests on.
-- It records whether Night Orders created this task or merely came across it,
-- and it is written here rather than asserted by whoever is asking to write:
-- a policy that says "only our tasks" while letting the caller declare which
-- those are is not a policy.
CREATE TABLE IF NOT EXISTS task_ref (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  backend                 TEXT NOT NULL,
  external_id             TEXT NOT NULL,
  -- Which repository the work belongs to, when that is known. Capabilities
  -- are repo-scoped, so a gap can only count the tasks it blocks if tasks
  -- say where they live. NULL is honest for a task nobody has placed yet —
  -- it dispatches anywhere, and no gap claims it.
  repo                    TEXT,
  zones                   TEXT NOT NULL DEFAULT '[]',
  capability_requirements TEXT NOT NULL DEFAULT '[]',
  park_rate               REAL NOT NULL DEFAULT 0,
  origin                  TEXT NOT NULL DEFAULT 'theirs',
  UNIQUE (backend, external_id)
);

-- A hold is an operational pause, not a claim about the work's structure,
-- which is why it may live out here while dependency edges may not.
CREATE TABLE IF NOT EXISTS hold (
  task_ref INTEGER PRIMARY KEY REFERENCES task_ref(id) ON DELETE CASCADE,
  reason   TEXT NOT NULL,
  until    TEXT,
  held_at  TEXT NOT NULL
);

-- One row per lease, not per task: the claim log is append-only.
--
-- Overwriting a task's claim on reclaim would erase the superseded lease, and
-- then a runner coming back from the dead to report its work could only be
-- told "I have never heard of that lease" — indistinguishable, from where it
-- is standing, from talking to the wrong database. Keeping the row lets it be
-- told the truth: you were superseded, at this generation, by this runner.
--
-- UNIQUE (task_ref, lease_generation) *is* the compare-and-swap. Two runners
-- racing both compute the same next generation; the database lets exactly one
-- of them insert it.
CREATE TABLE IF NOT EXISTS claim (
  lease_id         TEXT PRIMARY KEY,
  task_ref         INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  lease_generation INTEGER NOT NULL,
  runner           TEXT NOT NULL,
  acquired_at      TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  heartbeat_at     TEXT NOT NULL,
  released_at      TEXT,
  -- Who let go, because "released" alone conflates four different events:
  -- the runner handing it back ('released'), a completion being accepted
  -- ('completed'), expiry reap ('reaped'), and dead-runner recovery
  -- ('recovered'). A retry that finds its lease released must know which:
  -- answering "duplicate" to a runner whose lease was in fact reclaimed
  -- would accept work the reclaim already disowned.
  released_by      TEXT,
  UNIQUE (task_ref, lease_generation)
);

-- A capability: something a repo's work needs that this machine either has
-- or does not — a credential in the environment, a CLI that is logged in, an
-- MCP server that answers. Metadata only, and the absence of a value column
-- is load-bearing (§3): the control plane records "present, verified at T",
-- and the value itself lives on the runner, in a keychain or a gitignored
-- .env, where a database dump cannot leak it.
CREATE TABLE IF NOT EXISTS capability (
  repo             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('env','cli','mcp','ci','other')),
  name             TEXT NOT NULL,
  probe            TEXT,
  status           TEXT NOT NULL DEFAULT 'unprobed' CHECK (status IN ('unprobed','verified','failed')),
  added_by         TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_verified_at TEXT,
  -- Who ran the probe that produced this status. Verification is a claim
  -- about one environment: the machine whose shell answered. Another runner
  -- trusts it only by re-proving it where it stands, which is what tick does.
  verified_by      TEXT,
  -- The probe's own words when it said no — "exit 1", "timed out", "sh not
  -- found". Collapsing those into one bit would discard exactly the detail
  -- that tells an operator whether to paste a key or fix a PATH.
  last_result      TEXT,
  expires_at       TEXT,
  PRIMARY KEY (repo, kind, name)
);

-- One build attempt, durable. The in-memory BuildResult evaporates with the
-- process; the morning briefing, and anybody asking "what happened to t-1
-- overnight", need the answer to survive a crash. A row is written before
-- the agent runs and finalized after — outcome NULL means the attempt was
-- cut down mid-flight, which is itself worth knowing.
CREATE TABLE IF NOT EXISTS run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref    INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  lease_id    TEXT NOT NULL,
  runner      TEXT NOT NULL,
  branch      TEXT NOT NULL,
  worktree    TEXT NOT NULL,
  model       TEXT,
  outcome     TEXT CHECK (outcome IN ('built','failed','refused')),
  reason      TEXT,
  committed   INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

-- Permission to write to a tracker, one row per repository and backend.
-- Absence of a row is denial; there is no wildcard and no inheritance.
CREATE TABLE IF NOT EXISTS backend_grant (
  repo             TEXT NOT NULL,
  backend          TEXT NOT NULL,
  paths            TEXT NOT NULL DEFAULT '[]',
  mutations        TEXT NOT NULL DEFAULT '[]',
  selector         TEXT NOT NULL,
  credential_scope TEXT,
  observed_by_git  INTEGER NOT NULL,
  granted_at       TEXT NOT NULL,
  granted_by       TEXT NOT NULL,
  PRIMARY KEY (repo, backend)
);

-- What a task is allowed to become, and whether a person agreed to it.
--
-- approved_digest is the whole mechanism: approval records the exact scope it
-- saw, so rewriting the scope afterwards does not carry the approval with it.
CREATE TABLE IF NOT EXISTS task_scope (
  task_id         TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  goal            TEXT NOT NULL,
  out_of_scope    TEXT,
  touches         TEXT NOT NULL DEFAULT '[]',
  proposed_at     TEXT NOT NULL,
  digest          TEXT NOT NULL,
  approved_at     TEXT,
  approved_by     TEXT,
  approved_digest TEXT
);

-- Whoever is allowed to say yes to a scope.
--
-- Separate from a runner on purpose: a runner is a machine that does work, and
-- an approver is a person who agrees to it. Sharing one table would mean any
-- credential that can take a task can also approve one, which is the exact
-- collapse this whole gate exists to prevent.
CREATE TABLE IF NOT EXISTS approver (
  name            TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL,
  added_at        TEXT NOT NULL
);

-- A machine that may be given work.
--
-- credential_hash, never the credential: the token is shown to the operator
-- once at registration and then exists only as a hash here. A control plane
-- that can hand back a runner's token is one whose database is worth stealing.
CREATE TABLE IF NOT EXISTS runner (
  name            TEXT PRIMARY KEY,
  host            TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  capacity        INTEGER NOT NULL,
  repos           TEXT NOT NULL DEFAULT '[]',
  agents          TEXT NOT NULL DEFAULT '[]',
  registered_at   TEXT NOT NULL,
  heartbeat_at    TEXT NOT NULL,
  retired_at      TEXT
);

-- A checked-out working copy, leased to one runner at a time.
--
-- Its lease is deliberately the same shape as a task claim: a runner that dies
-- holding a worktree has to be recoverable the same way, and two mechanisms
-- for one idea is how the second one ends up subtly wrong.
CREATE TABLE IF NOT EXISTS worktree (
  path          TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  branch        TEXT NOT NULL,
  runner        TEXT REFERENCES runner(name) ON DELETE SET NULL,
  task_ref      INTEGER REFERENCES task_ref(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  leased_at     TEXT,
  released_at   TEXT,
  -- Reconstructed state is trusted only after it has been checked; see
  -- treehouse's rule about state you did not watch being created.
  verified      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mutation (
  idempotency_key TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,
  result          TEXT NOT NULL,
  actor           TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_by_state ON task (state);
CREATE INDEX IF NOT EXISTS edge_by_blocker ON task_edge (blocker);
CREATE INDEX IF NOT EXISTS claim_by_task ON claim (task_ref, lease_generation DESC);
`;

/**
 * The subset of `node:sqlite` this module uses, named so the rest of the file
 * is not written against an `any` and so a test can substitute a handle.
 */
export type Statement = {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
};

export type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};

/**
 * Beside `repos.json`, for the same reason it is there: someone will want to
 * back it up, sync it, or delete it, and a database hidden somewhere clever is
 * a database nobody can find when it matters.
 */
export function databasePath(env: Record<string, string | undefined>, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg !== "" ? xdg : join(home, ".config");
  return join(base, "nightorders", "orders.db");
}

export type OpenOptions = {
  /** Substituted in tests; production opens node:sqlite itself. */
  connect?: (file: string) => Database;
};

/**
 * Open the database, creating it and its directory if needed. The import is
 * inside the function rather than at the top of the file so that a command
 * which never touches the store — every command that exists today — neither
 * loads SQLite nor pays its warning.
 */
export function openStore(file: string, options: OpenOptions = {}): Store {
  const connect = options.connect ?? defaultConnect;
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });

  const db = connect(file);
  db.exec(SCHEMA);
  migrate(db);

  const version = db.prepare("SELECT version FROM schema_version").get();
  if (version === undefined) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  }

  return new Store(db);
}

/**
 * Loaded through `createRequire` rather than a top-level import so that the
 * cost — and the experimental warning — falls only on a command that actually
 * opens the database. `import()` would work too, but it would make opening the
 * store async for every caller in order to save nothing.
 *
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` to
 * stderr the first time this runs. It is left alone: an earlier version
 * filtered it by swapping the process-wide `warning` listeners, which turned
 * every `process.once("warning")` anyone else had registered into a permanent
 * one and re-emitted the rest in a format Node does not use. Hiding one line
 * of stderr is not worth breaking a global for. The right fix belongs in the
 * launcher — `--disable-warning=ExperimentalWarning` — not in a library.
 */
/**
 * Columns added after somebody's database already existed.
 *
 * `CREATE TABLE IF NOT EXISTS` does exactly nothing to a table that is already
 * there, so a column added to the schema later never reaches an existing file
 * — and every test opening `:memory:` or a fresh path passes while the first
 * real database fails on the next query. This one was found by opening one.
 *
 * Additive only, and idempotent: each column is added if it is missing and
 * skipped if it is not. Nothing here rewrites or drops anything.
 */
function migrate(db: Database): void {
  addColumn(db, "task_ref", "origin", "TEXT NOT NULL DEFAULT 'theirs'");
  addColumn(db, "task_ref", "repo", "TEXT");
  addColumn(db, "claim", "released_by", "TEXT");
}

function addColumn(db: Database, table: string, column: string, definition: string): void {
  const present = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some(row => String(row["name"]) === column);
  if (present) return;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function defaultConnect(file: string): Database {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => Database;
  };
  return new DatabaseSync(file);
}

export class Store {
  constructor(private readonly db: Database) {}

  /** Exposed so `claim.ts` can run its compare-and-swap in one transaction. */
  get handle(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // ---- the built-in task store -------------------------------------------

  /**
   * Creating a task also creates its overlay reference, because a task with no
   * `TaskRef` cannot be claimed, held, or scheduled — it would be work the
   * control plane can see and never act on.
   */
  createTask(spec: { id: string; title: string }, now: Date, mutation: Mutation = {}): Task {
    return this.once(mutation, "createTask", () =>
      // Both rows or neither, and the comment above is why: this used to be
      // two unwrapped statements, and the first real database caught it. A
      // schema change made the second one fail, the first had already
      // committed, and the result was a task with no reference — invisible to
      // the ready query, unclaimable, and silently given a reference later by
      // something else, with the wrong origin. Exactly the state this
      // invariant exists to rule out, arrived at by the invariant not being
      // enforced.
      this.transact(() => {
      const stamp = now.toISOString();
      this.db
        .prepare(
          "INSERT INTO task (id, title, state, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)",
        )
        .run(spec.id, spec.title, stamp, stamp);
      // Created here, so it is ours — the one place that is true by construction.
      this.refFor(BUILT_IN, spec.id, "ours");
      return {
        id: spec.id,
        title: spec.title,
        state: "queued" as TaskState,
        createdAt: stamp,
        updatedAt: stamp,
      };
      }),
    );
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM task WHERE id = ?").get(id);
    return row === undefined ? null : readTask(row);
  }

  /** Oldest first, so a list reads in the order the work was thought of. */
  listTasks(state?: TaskState): Task[] {
    const rows =
      state === undefined
        ? this.db.prepare("SELECT * FROM task ORDER BY created_at, id").all()
        : this.db.prepare("SELECT * FROM task WHERE state = ? ORDER BY created_at, id").all(state);
    return rows.map(readTask);
  }

  /** What this task is waiting for, whether or not those are finished. */
  blockers(id: string): string[] {
    return this.db
      .prepare("SELECT blocker FROM task_edge WHERE blocked = ? ORDER BY blocker")
      .all(id)
      .map(row => String(row["blocker"]));
  }

  /** The external id behind a reference, for reporting a claim back in words. */
  externalIdFor(taskRef: number): string | null {
    const row = this.db.prepare("SELECT external_id FROM task_ref WHERE id = ?").get(taskRef);
    return row === undefined ? null : String(row["external_id"]);
  }

  setTaskState(id: string, state: TaskState, now: Date, mutation: Mutation = {}): boolean {
    return this.once(
      mutation,
      "setTaskState",
      () => {
        const { changes } = this.db
          .prepare("UPDATE task SET state = ?, updated_at = ? WHERE id = ?")
          .run(state, now.toISOString(), id);
        return Number(changes) > 0;
      },
      // A state change that matched no task mutated nothing, so there is
      // nothing to replay — and recording it would answer "no such task"
      // forever, including after somebody creates it.
      moved => moved,
    );
  }

  /**
   * `blocked` waits for `blocker`.
   *
   * A cycle is refused rather than stored. Stored, it would be invisible: every
   * task in the ring stays un-ready forever and the ready set simply comes back
   * one task shorter each night, with nothing anywhere saying why.
   */
  addEdge(blocked: string, blocker: string, mutation: Mutation = {}): { ok: true } | { ok: false; reason: string } {
    return this.once(mutation, "addEdge", () =>
      // The reachability check and the insert have to be one atomic step.
      // Apart, two callers adding `a waits on b` and `b waits on a` at the
      // same moment each see no cycle, and between them store one.
      this.transact(() => {
        if (blocked === blocker) return { ok: false as const, reason: "a task cannot block itself" };
        if (this.reaches(blocker, blocked)) {
          return { ok: false as const, reason: `${blocker} already waits on ${blocked} — that is a cycle` };
        }
        this.db
          .prepare("INSERT OR IGNORE INTO task_edge (blocked, blocker) VALUES (?, ?)")
          .run(blocked, blocker);
        return { ok: true as const };
      }),
      result => result.ok,
    );
  }

  /** IMMEDIATE, so two writers queue rather than both deciding they may write. */
  transact<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Whether `to` is reachable from `from` by following what it waits on. */
  private reaches(from: string, to: string): boolean {
    const row = this.db
      .prepare(
        `WITH RECURSIVE waits(id) AS (
           SELECT ?
           UNION
           SELECT task_edge.blocker FROM task_edge JOIN waits ON task_edge.blocked = waits.id
         )
         SELECT 1 AS hit FROM waits WHERE id = ? LIMIT 1`,
      )
      .get(from, to);
    return row !== undefined;
  }

  /**
   * The ready set: queued, every blocker finished, no active hold, and not
   * already claimed by somebody else.
   *
   * A hold whose `until` has passed is not a hold. Reading it as one would
   * strand work at exactly the moment it was supposed to resume.
   */
  listReady(now: Date): TaskRef[] {
    const stamp = now.toISOString();
    const rows = this.db
      .prepare(
        `SELECT task_ref.* FROM task
         JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
         WHERE task.state = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM hold
             WHERE hold.task_ref = task_ref.id
               AND (hold.until IS NULL OR hold.until > ?)
           )
           -- Only the newest lease can be holding the task. The claim log is
           -- append-only, so asking "does any unreleased row exist" would let
           -- a long-superseded lease keep work off the ready set forever.
           AND NOT EXISTS (
             SELECT 1 FROM claim
             WHERE claim.task_ref = task_ref.id
               AND claim.released_at IS NULL
               AND claim.expires_at > ?
               AND claim.lease_generation = (
                 SELECT MAX(newest.lease_generation) FROM claim AS newest
                 WHERE newest.task_ref = task_ref.id
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_edge
             JOIN task AS blocker ON blocker.id = task_edge.blocker
             WHERE task_edge.blocked = task.id AND blocker.state <> 'done'
           )
         ORDER BY task.created_at`,
      )
      .all(BUILT_IN, stamp, stamp);

    return rows.map(readTaskRef);
  }

  // ---- the overlay --------------------------------------------------------

  /**
   * Get or create the reference.
   *
   * Creating one grants nothing on its own, and defaults to `theirs`: merely
   * referring to a task — which happens whenever anything is looked up — must
   * never be what makes it ours to write.
   */
  refFor(backend: string, externalId: string, origin: TaskOrigin = "theirs"): TaskRef {
    const existing = this.db
      .prepare("SELECT * FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(backend, externalId);
    if (existing !== undefined) {
      // Ownership only ever widens by an explicit act, never by being looked
      // up again with a more generous argument.
      if (origin === "ours" && String(existing["origin"]) !== "ours") {
        this.db.prepare("UPDATE task_ref SET origin = 'ours' WHERE id = ?").run(existing["id"]);
        return readTaskRef({ ...existing, origin: "ours" });
      }
      return readTaskRef(existing);
    }

    this.db
      .prepare("INSERT INTO task_ref (backend, external_id, origin) VALUES (?, ?, ?)")
      .run(backend, externalId, origin);
    const created = this.db
      .prepare("SELECT * FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(backend, externalId);
    return readTaskRef(created as Record<string, unknown>);
  }

  /** Whether this task is one we created, as recorded — not as asserted. */
  originOf(backend: string, externalId: string): TaskOrigin {
    const row = this.db
      .prepare("SELECT origin FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(backend, externalId);
    return row !== undefined && String(row["origin"]) === "ours" ? "ours" : "theirs";
  }

  hold(taskRef: number, reason: string, until: Date | null, now: Date, mutation: Mutation = {}): void {
    this.once(mutation, "hold", () => {
      this.db
        .prepare(
          `INSERT INTO hold (task_ref, reason, until, held_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (task_ref) DO UPDATE SET reason = excluded.reason,
                                                until = excluded.until,
                                                held_at = excluded.held_at`,
        )
        .run(taskRef, reason, until === null ? null : until.toISOString(), now.toISOString());
      return null;
    });
  }

  unhold(taskRef: number, mutation: Mutation = {}): boolean {
    return this.once(
      mutation,
      "unhold",
      () => {
        const { changes } = this.db.prepare("DELETE FROM hold WHERE task_ref = ?").run(taskRef);
        return Number(changes) > 0;
      },
      lifted => lifted,
    );
  }

  /** The hold in force right now, if any. An elapsed `until` is not one. */
  activeHold(taskRef: number, now: Date): Hold | null {
    const row = this.db
      .prepare("SELECT * FROM hold WHERE task_ref = ? AND (until IS NULL OR until > ?)")
      .get(taskRef, now.toISOString());
    if (row === undefined) return null;
    return {
      taskRef: Number(row["task_ref"]),
      reason: String(row["reason"]),
      until: row["until"] === null ? null : String(row["until"]),
      heldAt: String(row["held_at"]),
    };
  }

  // ---- grants -------------------------------------------------------------

  /**
   * Enrolling twice replaces rather than accumulates. Two grants over one
   * backend would mean the effective permission is whichever row a query
   * happened to reach first, and a permission you cannot read off the page is
   * not a permission anyone can reason about.
   */
  saveGrant(grant: BackendGrant, mutation: Mutation = {}): void {
    this.once(mutation, "saveGrant", () => {
      this.db
        .prepare(
          `INSERT INTO backend_grant
             (repo, backend, paths, mutations, selector, credential_scope, observed_by_git, granted_at, granted_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, backend) DO UPDATE SET
             paths = excluded.paths, mutations = excluded.mutations,
             selector = excluded.selector, credential_scope = excluded.credential_scope,
             observed_by_git = excluded.observed_by_git,
             granted_at = excluded.granted_at, granted_by = excluded.granted_by`,
        )
        .run(
          grant.repo,
          grant.backend,
          JSON.stringify(grant.paths),
          JSON.stringify(grant.mutations),
          grant.selector,
          grant.credentialScope,
          grant.observedByGit ? 1 : 0,
          grant.grantedAt,
          grant.grantedBy,
        );
      return null;
    });
  }

  /** null is denial, and is the answer for anything never enrolled. */
  grantFor(repo: string, backend: string): BackendGrant | null {
    const row = this.db
      .prepare("SELECT * FROM backend_grant WHERE repo = ? AND backend = ?")
      .get(repo, backend);
    return row === undefined ? null : readGrant(row);
  }

  listGrants(): BackendGrant[] {
    return this.db
      .prepare("SELECT * FROM backend_grant ORDER BY repo, backend")
      .all()
      .map(readGrant);
  }

  revokeGrant(repo: string, backend: string, mutation: Mutation = {}): boolean {
    return this.once(
      mutation,
      "revokeGrant",
      () => {
        const { changes } = this.db
          .prepare("DELETE FROM backend_grant WHERE repo = ? AND backend = ?")
          .run(repo, backend);
        return Number(changes) > 0;
      },
      revoked => revoked,
    );
  }

  // ---- scope --------------------------------------------------------------

  saveScope(scope: Scope, mutation: Mutation = {}): void {
    this.once(mutation, "saveScope", () => {
      this.db
        .prepare(
          `INSERT INTO task_scope
             (task_id, goal, out_of_scope, touches, proposed_at, digest, approved_at, approved_by, approved_digest)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (task_id) DO UPDATE SET
             goal = excluded.goal, out_of_scope = excluded.out_of_scope,
             touches = excluded.touches, proposed_at = excluded.proposed_at,
             digest = excluded.digest, approved_at = excluded.approved_at,
             approved_by = excluded.approved_by, approved_digest = excluded.approved_digest`,
        )
        .run(
          scope.taskId,
          scope.goal,
          scope.outOfScope,
          JSON.stringify(scope.touches),
          scope.proposedAt,
          scope.digest,
          scope.approvedAt,
          scope.approvedBy,
          scope.approvedDigest,
        );
      return null;
    });
  }

  getScope(taskId: string): Scope | null {
    const row = this.db.prepare("SELECT * FROM task_scope WHERE task_id = ?").get(taskId);
    return row === undefined ? null : readScope(row);
  }

  // ---- approvers ----------------------------------------------------------

  saveApprover(name: string, credentialHash: string, now: Date, mutation: Mutation = {}): void {
    this.once(mutation, "saveApprover", () => {
      this.db
        .prepare(
          `INSERT INTO approver (name, credential_hash, added_at) VALUES (?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET credential_hash = excluded.credential_hash,
                                            added_at = excluded.added_at`,
        )
        .run(name, credentialHash, now.toISOString());
      return null;
    });
  }

  approverHash(name: string): string | null {
    const row = this.db.prepare("SELECT credential_hash FROM approver WHERE name = ?").get(name);
    return row === undefined ? null : String(row["credential_hash"]);
  }

  listApprovers(): { name: string; addedAt: string }[] {
    return this.db
      .prepare("SELECT name, added_at FROM approver ORDER BY name")
      .all()
      .map(row => ({ name: String(row["name"]), addedAt: String(row["added_at"]) }));
  }

  // ---- runners ------------------------------------------------------------

  saveRunner(runner: Runner, credentialHash: string, mutation: Mutation = {}): void {
    this.once(mutation, "saveRunner", () => {
      this.db
        .prepare(
          `INSERT INTO runner
             (name, host, credential_hash, capacity, repos, agents, registered_at, heartbeat_at, retired_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (name) DO UPDATE SET
             host = excluded.host, credential_hash = excluded.credential_hash,
             capacity = excluded.capacity, repos = excluded.repos, agents = excluded.agents,
             registered_at = excluded.registered_at, heartbeat_at = excluded.heartbeat_at,
             retired_at = NULL`,
        )
        .run(
          runner.name,
          runner.host,
          credentialHash,
          runner.capacity,
          JSON.stringify(runner.repos),
          JSON.stringify(runner.agents),
          runner.registeredAt,
          runner.heartbeatAt,
        );
      return null;
    });
  }

  /** The hash comes back with it; the token it was made from does not exist here. */
  getRunner(name: string): { runner: Runner; credentialHash: string } | null {
    const row = this.db.prepare("SELECT * FROM runner WHERE name = ?").get(name);
    if (row === undefined) return null;
    return { runner: readRunner(row), credentialHash: String(row["credential_hash"]) };
  }

  listRunners(): Runner[] {
    return this.db.prepare("SELECT * FROM runner ORDER BY name").all().map(readRunner);
  }

  touchRunner(name: string, now: Date): void {
    this.db
      .prepare("UPDATE runner SET heartbeat_at = ? WHERE name = ? AND retired_at IS NULL")
      .run(now.toISOString(), name);
  }

  retireRunner(name: string, now: Date, mutation: Mutation = {}): boolean {
    return this.once(
      mutation,
      "retireRunner",
      () => {
        const { changes } = this.db
          .prepare("UPDATE runner SET retired_at = ? WHERE name = ? AND retired_at IS NULL")
          .run(now.toISOString(), name);
        return Number(changes) > 0;
      },
      retired => retired,
    );
  }

  /**
   * Release every live claim a runner holds, and say which.
   *
   * Not a fenced release: this is the control plane taking a lease back from a
   * machine that is gone, not that machine handing it in. The generation is
   * untouched, so if the runner ever wakes up its completion is still fenced
   * out by the next acquire — which is exactly the behaviour that made the
   * fence worth having.
   */
  releaseClaimsOf(runner: string, now: Date): string[] {
    const held = this.db
      .prepare("SELECT lease_id, task_ref FROM claim WHERE runner = ? AND released_at IS NULL")
      .all(runner);
    if (held.length === 0) return [];

    this.db
      .prepare(
        "UPDATE claim SET released_at = ?, released_by = 'recovered' WHERE runner = ? AND released_at IS NULL",
      )
      .run(now.toISOString(), runner);

    // Releasing the lease is only half of it. Claiming a task moves it to
    // `running`, and the ready query asks for `queued` — so a lease taken back
    // from a dead machine without this leaves the task stranded in `running`
    // forever: not claimed by anybody, and never offered to anybody either.
    // The most expensive kind of bug, because nothing anywhere reports it.
    //
    // Matched on backend as well as id. Claims are backend-agnostic and ids
    // are only unique within a backend, so requeuing by id alone would let a
    // dead runner's GitHub issue #17 reset a built-in task that happens to be
    // called `17`. Somebody else's work, moved by a coincidence of naming.
    for (const row of held) {
      const ref = this.db
        .prepare("SELECT backend, external_id FROM task_ref WHERE id = ?")
        .get(Number(row["task_ref"]));
      if (ref === undefined || String(ref["backend"]) !== BUILT_IN) continue;

      this.db
        .prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'")
        .run(now.toISOString(), String(ref["external_id"]));
    }

    return held.map(row => String(row["lease_id"]));
  }

  // ---- worktrees ----------------------------------------------------------

  saveWorktree(worktree: WorktreeRow, mutation: Mutation = {}): void {
    this.once(mutation, "saveWorktree", () => {
      this.db
        .prepare(
          `INSERT INTO worktree (path, repo, branch, runner, task_ref, created_at, leased_at, released_at, verified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (path) DO UPDATE SET
             repo = excluded.repo, branch = excluded.branch, runner = excluded.runner,
             task_ref = excluded.task_ref, leased_at = excluded.leased_at,
             released_at = excluded.released_at, verified = excluded.verified`,
        )
        .run(
          worktree.path,
          worktree.repo,
          worktree.branch,
          worktree.runner,
          worktree.taskRef,
          worktree.createdAt,
          worktree.leasedAt,
          worktree.releasedAt,
          worktree.verified ? 1 : 0,
        );
      return null;
    });
  }

  getWorktree(path: string): WorktreeRow | null {
    const row = this.db.prepare("SELECT * FROM worktree WHERE path = ?").get(path);
    return row === undefined ? null : readWorktree(row);
  }

  /** Drop a row whose directory is gone; a lease over nothing only refuses work. */
  forgetWorktree(path: string): void {
    this.db.prepare("DELETE FROM worktree WHERE path = ?").run(path);
  }

  listWorktrees(): WorktreeRow[] {
    return this.db.prepare("SELECT * FROM worktree ORDER BY path").all().map(readWorktree);
  }

  /**
   * Hand back every worktree a dead runner held, unverified.
   *
   * Nobody watched what its process was doing when it stopped, so what is on
   * disk describes the past rather than the present. Marking these verified
   * would be asserting something we did not check.
   */
  releaseWorktreesOf(runner: string, now: Date): string[] {
    const held = this.db
      .prepare("SELECT path FROM worktree WHERE runner = ? AND released_at IS NULL")
      .all(runner)
      .map(row => String(row["path"]));
    if (held.length === 0) return [];

    this.db
      .prepare(
        "UPDATE worktree SET released_at = ?, verified = 0 WHERE runner = ? AND released_at IS NULL",
      )
      .run(now.toISOString(), runner);
    return held;
  }

  // ---- capabilities -------------------------------------------------------

  saveCapability(capability: Capability, mutation: Mutation = {}): void {
    this.once(mutation, "saveCapability", () => {
      this.db
        .prepare(
          `INSERT INTO capability (repo, kind, name, probe, status, added_by, created_at, last_verified_at, verified_by, last_result, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, kind, name) DO UPDATE SET
             probe = excluded.probe, status = excluded.status,
             last_verified_at = excluded.last_verified_at,
             verified_by = excluded.verified_by, last_result = excluded.last_result,
             expires_at = excluded.expires_at`,
        )
        .run(
          capability.repo,
          capability.kind,
          capability.name,
          capability.probe,
          capability.status,
          capability.addedBy,
          capability.createdAt,
          capability.lastVerifiedAt,
          capability.verifiedBy,
          capability.lastResult,
          capability.expiresAt,
        );
      return null;
    });
  }

  getCapability(repo: string, kind: string, name: string): Capability | null {
    const row = this.db
      .prepare("SELECT * FROM capability WHERE repo = ? AND kind = ? AND name = ?")
      .get(repo, kind, name);
    return row === undefined ? null : readCapability(row);
  }

  /** By name alone, any kind — how a task requirement refers to one. */
  capabilityNamed(repo: string, name: string): Capability | null {
    const row = this.db
      .prepare("SELECT * FROM capability WHERE repo = ? AND name = ? ORDER BY kind LIMIT 1")
      .get(repo, name);
    return row === undefined ? null : readCapability(row);
  }

  listCapabilities(repo: string): Capability[] {
    return this.db
      .prepare("SELECT * FROM capability WHERE repo = ? ORDER BY kind, name")
      .all(repo)
      .map(readCapability);
  }

  /**
   * Record a probe's answer. Verification carries the moment it happened,
   * because "verified" is always a claim about a time (§3: presence is not
   * enough, and neither is a stale yes).
   */
  markCapability(
    repo: string,
    kind: string,
    name: string,
    outcome: { status: "verified" | "failed"; by: string; detail?: string },
    now: Date,
    expiresAt: string | null = null,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE capability SET status = ?, last_verified_at = ?, verified_by = ?, last_result = ?, expires_at = COALESCE(?, expires_at)
          WHERE repo = ? AND kind = ? AND name = ?`,
      )
      .run(
        outcome.status,
        outcome.status === "verified" ? now.toISOString() : null,
        outcome.by,
        outcome.detail ?? null,
        expiresAt,
        repo,
        kind,
        name,
      );
    return Number(changes) > 0;
  }

  /** Set what a task needs, as `kind:name` keys, replacing what it needed before. */
  setRequirements(taskRef: number, keys: readonly string[], mutation: Mutation = {}): boolean {
    return this.once(mutation, "setRequirements", () => {
      const { changes } = this.db
        .prepare("UPDATE task_ref SET capability_requirements = ? WHERE id = ?")
        .run(JSON.stringify([...keys]), taskRef);
      return Number(changes) > 0;
    });
  }

  /** Say which repository a task's work lives in. */
  placeTask(taskRef: number, repo: string, mutation: Mutation = {}): boolean {
    return this.once(mutation, "placeTask", () => {
      const { changes } = this.db
        .prepare("UPDATE task_ref SET repo = ? WHERE id = ?")
        .run(repo, taskRef);
      return Number(changes) > 0;
    });
  }

  // ---- runs ---------------------------------------------------------------

  /**
   * Open the record before the money is spent. If the process dies with the
   * agent, the row survives with outcome NULL — an attempt that was cut down
   * mid-flight, visible the next morning instead of vanished.
   */
  startRun(run: {
    taskRef: number;
    leaseId: string;
    runner: string;
    branch: string;
    worktree: string;
    model?: string;
    now: Date;
  }): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO run (task_ref, lease_id, runner, branch, worktree, model, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.taskRef,
        run.leaseId,
        run.runner,
        run.branch,
        run.worktree,
        run.model ?? null,
        run.now.toISOString(),
      );
    return Number(inserted.lastInsertRowid);
  }

  finishRun(
    id: number,
    result: {
      outcome: "built" | "failed" | "refused";
      reason?: string;
      committed?: boolean;
      now: Date;
    },
  ): void {
    this.db
      .prepare("UPDATE run SET outcome = ?, reason = ?, committed = ?, finished_at = ? WHERE id = ?")
      .run(
        result.outcome,
        result.reason ?? null,
        result.committed === undefined ? null : result.committed ? 1 : 0,
        result.now.toISOString(),
        id,
      );
  }

  /** Newest first, because the question is almost always "what just happened". */
  runsFor(taskRef: number): Run[] {
    return this.db
      .prepare("SELECT * FROM run WHERE task_ref = ? ORDER BY id DESC")
      .all(taskRef)
      .map(row => ({
        id: Number(row["id"]),
        taskRef: Number(row["task_ref"]),
        leaseId: String(row["lease_id"]),
        runner: String(row["runner"]),
        branch: String(row["branch"]),
        worktree: String(row["worktree"]),
        model: row["model"] === null ? null : String(row["model"]),
        outcome: row["outcome"] === null ? null : (String(row["outcome"]) as Run["outcome"]),
        reason: row["reason"] === null ? null : String(row["reason"]),
        committed: row["committed"] === null ? null : Number(row["committed"]) === 1,
        startedAt: String(row["started_at"]),
        finishedAt: row["finished_at"] === null ? null : String(row["finished_at"]),
      }));
  }

  // ---- idempotency --------------------------------------------------------

  /**
   * Run `body` once per key, ever.
   *
   * The case this exists for is a runner that completes its work, has its
   * acknowledgement lost to a dropped connection, and retries. Without a key
   * the retry is a second, different mutation; with one it is the same answer
   * handed back. Callers that pass no key are not protected, which is why the
   * dispatch path always passes one.
   */
  /**
   * `worthRecording` exists for one case, and it is not a nicety.
   *
   * Idempotency protects against a mutation happening twice. A refusal is not
   * a mutation — nothing happened — so recording it turns the key into a
   * permanent "no". A dispatcher that asked for a busy task, was told no, and
   * retried the same key an hour later would be handed that hour-old refusal
   * about a task that has been free for fifty minutes.
   */
  replay<T>(
    mutation: Mutation,
    operation: string,
    body: () => T,
    worthRecording: (result: T) => boolean = () => true,
  ): T {
    return this.once(mutation, operation, body, worthRecording);
  }

  private once<T>(
    mutation: Mutation,
    operation: string,
    body: () => T,
    worthRecording: (result: T) => boolean = () => true,
  ): T {
    const { idempotencyKey, actor = DEFAULT_ACTOR, at = new Date() } = mutation;
    if (idempotencyKey === undefined) return body();

    const seen = this.db
      .prepare("SELECT result FROM mutation WHERE idempotency_key = ?")
      .get(idempotencyKey);
    if (seen !== undefined) return JSON.parse(String(seen["result"])) as T;

    const result = body();
    if (!worthRecording(result)) return result;

    this.db
      .prepare(
        "INSERT INTO mutation (idempotency_key, operation, result, actor, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(idempotencyKey, operation, JSON.stringify(result ?? null), actor, at.toISOString());
    return result;
  }
}

function readCapability(row: Record<string, unknown>): Capability {
  return {
    repo: String(row["repo"]),
    kind: String(row["kind"]) as Capability["kind"],
    name: String(row["name"]),
    probe: row["probe"] === null ? null : String(row["probe"]),
    status: String(row["status"]) as Capability["status"],
    addedBy: String(row["added_by"]),
    createdAt: String(row["created_at"]),
    lastVerifiedAt: row["last_verified_at"] === null ? null : String(row["last_verified_at"]),
    verifiedBy: row["verified_by"] === null ? null : String(row["verified_by"]),
    lastResult: row["last_result"] === null ? null : String(row["last_result"]),
    expiresAt: row["expires_at"] === null ? null : String(row["expires_at"]),
  };
}

function readTask(row: Record<string, unknown>): Task {
  return {
    id: String(row["id"]),
    title: String(row["title"]),
    state: String(row["state"]) as TaskState,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function readTaskRef(row: Record<string, unknown>): TaskRef {
  return {
    id: Number(row["id"]),
    backend: String(row["backend"]),
    externalId: String(row["external_id"]),
    repo: row["repo"] === null || row["repo"] === undefined ? null : String(row["repo"]),
    zones: readJsonArray(row["zones"]),
    capabilityRequirements: readJsonArray(row["capability_requirements"]),
    parkRate: Number(row["park_rate"]),
    origin: String(row["origin"]) === "ours" ? "ours" : "theirs",
  };
}

export type WorktreeRow = {
  path: string;
  repo: string;
  branch: string;
  runner: string | null;
  taskRef: number | null;
  createdAt: string;
  leasedAt: string | null;
  releasedAt: string | null;
  /** Whether the state on disk has been checked since it was last let go. */
  verified: boolean;
};

function readScope(row: Record<string, unknown>): Scope {
  return {
    taskId: String(row["task_id"]),
    goal: String(row["goal"]),
    outOfScope: row["out_of_scope"] === null ? null : String(row["out_of_scope"]),
    touches: readJsonArray(row["touches"]),
    proposedAt: String(row["proposed_at"]),
    digest: String(row["digest"]),
    approvedAt: row["approved_at"] === null ? null : String(row["approved_at"]),
    approvedBy: row["approved_by"] === null ? null : String(row["approved_by"]),
    approvedDigest: row["approved_digest"] === null ? null : String(row["approved_digest"]),
  };
}

function readRunner(row: Record<string, unknown>): Runner {
  return {
    name: String(row["name"]),
    host: String(row["host"]),
    capacity: Number(row["capacity"]),
    repos: readJsonArray(row["repos"]),
    agents: readJsonArray(row["agents"]),
    registeredAt: String(row["registered_at"]),
    heartbeatAt: String(row["heartbeat_at"]),
    retiredAt: row["retired_at"] === null ? null : String(row["retired_at"]),
  };
}

function readWorktree(row: Record<string, unknown>): WorktreeRow {
  return {
    path: String(row["path"]),
    repo: String(row["repo"]),
    branch: String(row["branch"]),
    runner: row["runner"] === null ? null : String(row["runner"]),
    taskRef: row["task_ref"] === null ? null : Number(row["task_ref"]),
    createdAt: String(row["created_at"]),
    leasedAt: row["leased_at"] === null ? null : String(row["leased_at"]),
    releasedAt: row["released_at"] === null ? null : String(row["released_at"]),
    verified: Number(row["verified"]) === 1,
  };
}

function readGrant(row: Record<string, unknown>): BackendGrant {
  return {
    repo: String(row["repo"]),
    backend: String(row["backend"]),
    paths: readJsonArray(row["paths"]),
    mutations: readJsonArray(row["mutations"]) as MutationClass[],
    selector: String(row["selector"]) === "all" ? "all" : "ours",
    credentialScope: row["credential_scope"] === null ? null : String(row["credential_scope"]),
    observedByGit: Number(row["observed_by_git"]) === 1,
    grantedAt: String(row["granted_at"]),
    grantedBy: String(row["granted_by"]),
  };
}

function readJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === "string") : [];
  } catch {
    return [];
  }
}
