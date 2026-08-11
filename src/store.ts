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
  zones: string[];
  capabilityRequirements: string[];
  parkRate: number;
  /** Recorded, not asserted: what the grant's selector is checked against. */
  origin: TaskOrigin;
};

export type Hold = { taskRef: number; reason: string; until: string | null; heldAt: string };

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
  UNIQUE (task_ref, lease_generation)
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
  run(...params: unknown[]): { changes: number | bigint };
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
    return this.once(mutation, "createTask", () => {
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
    });
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
    zones: readJsonArray(row["zones"]),
    capabilityRequirements: readJsonArray(row["capability_requirements"]),
    parkRate: Number(row["park_rate"]),
    origin: String(row["origin"]) === "ours" ? "ours" : "theirs",
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
