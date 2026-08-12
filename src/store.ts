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
import { hasForbiddenControls } from "./decision.js";
import { digestOf } from "./scope.js";
import type { BackendGrant, MutationClass, TaskOrigin } from "./grant.js";
import type { Runner } from "./runner.js";
import type { Scope } from "./scope.js";

export const SCHEMA_VERSION = 6;

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
  /** Consecutive concluded failures. Three stalls the task; any success resets. */
  strikes: number;
  /** Recorded, not asserted: what the grant's selector is checked against. */
  origin: TaskOrigin;
};

/** Who placed a hold — and therefore who alone may lift it. */
export type HoldOwner = "operator" | "decision" | "incident" | "backoff";

export type Hold = {
  id: number;
  taskRef: number;
  ownerKind: HoldOwner;
  ownerId: string;
  reason: string;
  until: string | null;
  heldAt: string;
};

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

/** A fact that wants a person, durably. */
export type Notification = {
  id: number;
  dedupeKey: string;
  kind: string;
  subject: string;
  body: string;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  receipt: string | null;
  /**
   * When the fact stopped wanting a person — a decision answered, an incident
   * resolved. Distinct from delivery, and it never deletes the row: receipts
   * are the audit trail of what was actually sent.
   */
  resolvedAt: string | null;
};

/** One build attempt. `outcome` null means it never finished — also an answer. */
export type Run = {
  id: number;
  taskRef: number;
  leaseId: string;
  runner: string;
  /** 'repair' = a resumed session mending its own park payload. Never 'driver'; see the DDL. */
  role: "builder" | "repair";
  parentRun: number | null;
  sessionId: string | null;
  baseRevision: string | null;
  branch: string;
  worktree: string;
  model: string | null;
  outcome: "built" | "failed" | "refused" | "parked" | "no-change" | null;
  reason: string | null;
  committed: boolean | null;
  startedAt: string;
  finishedAt: string | null;
  /** Stamped by the invocation gateway just before the provider spawns. */
  providerStartedAt: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** HEAD after the agent, as accepted — what a publication may push. */
  headRevision: string | null;
  /** The validated terminal handoff's conclusion. */
  handoff: string | null;
};

/** One option of a decision. `reversible` is a field so a scheduler can refuse to auto-apply. */
export type DecisionOption = {
  id: string;
  label: string;
  consequence: string;
  reversible: boolean;
};

/** The judgement call an agent refused to guess at (§7). Identity = its run. */
export type Decision = {
  id: number;
  run: number;
  urgency: "blocking";
  state: "open" | "expired" | "answered";
  recap: string;
  question: string;
  options: DecisionOption[];
  /** An option id. */
  recommendation: string;
  assignee: string | null;
  /** Attention metadata only — never a hold expiry. */
  deadline: string | null;
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  answeredVia: "cli" | "web" | "telegram" | null;
  choice: string | null;
  note: string | null;
};

/** Evidence, by reference. `key` is relative to the evidence root, never absolute. */
export type Artifact = {
  id: number;
  run: number;
  kind: "diff" | "status" | "park-payload";
  key: string;
  bytesOriginal: number;
  bytesStored: number;
  truncated: boolean;
  sha256: string;
  /** The command that produced it, and how that command exited. */
  capture: string;
  createdAt: string;
  redacted: boolean;
};

/** One Telegram chat allowed to answer as one approver. Revoked, never deleted. */
export type TelegramBinding = {
  id: number;
  botId: string;
  chatId: string;
  userId: string;
  approver: string;
  approverGeneration: number;
  pairedAt: string;
  pairedBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
};

/** What one opaque callback token means. The token is all Telegram ever sees. */
export type TelegramAction = {
  token: string;
  binding: number;
  decision: number;
  optionId: string;
  phase: "choose" | "confirm" | "cancel";
  chatId: string;
  messageId: string | null;
  createdAt: string;
  expiresAt: string | null;
  consumedAt: string | null;
};

/** A park that never became a decision. Stays in every brief until resolved. */
export type Incident = {
  id: number;
  run: number;
  kind: "malformed-decision" | "attempts-exhausted" | "commit-failure";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

/** What a publication grant permits — two external writes, named separately. */
export type PublicationCapability = "push-branch" | "open-pr";

export type PublicationGrant = {
  id: number;
  repo: string;
  /** owner/name on GitHub — exact, never inferred from a remote at publish time. */
  githubRepo: string;
  remote: string;
  /** Only branches under this prefix may be pushed. */
  headPrefix: string;
  base: string;
  capabilities: PublicationCapability[];
  selector: "ours" | "all";
  draft: boolean;
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
};

/** One run's road to a PR, durable at every phase. */
export type Publication = {
  id: number;
  run: number;
  taskRef: number;
  githubRepo: string;
  remote: string;
  base: string;
  head: string;
  /** The exact commit completion accepted — what gets pushed, byte for byte. */
  headSha: string;
  bodyHash: string;
  draft: boolean;
  state: "intended" | "pushed" | "opened" | "failed";
  prNumber: number | null;
  prUrl: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
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
--
-- Every hold has an owner, because "lift the hold" is only safe when the
-- lifter and the placer are the same authority. One row per task let a
-- decision's answer delete an operator's unrelated pause — or a later manual
-- hold silently replace the one keeping a parked task off the ready set.
-- UNIQUE (owner_kind, owner_id) keeps each owner to one hold; readiness
-- rejects on ANY active row, so two owners holding one task both count.
CREATE TABLE IF NOT EXISTS hold (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff')),
  owner_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  until      TEXT,
  held_at    TEXT NOT NULL,
  UNIQUE (owner_kind, owner_id)
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
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  lease_id      TEXT NOT NULL,
  runner        TEXT NOT NULL,
  -- 'repair' is a resumed session mending its own malformed park payload.
  -- Deliberately NOT 'driver': the design's driver is the event-woken gate
  -- role that first exists at M4, and recording repair under that name now
  -- would make the two indistinguishable in every cost report afterwards.
  role          TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair')),
  parent_run    INTEGER REFERENCES run(id),
  -- The agent session, kept so a malformed park can be repaired by resuming
  -- the conversation that produced it instead of paying for a fresh one.
  session_id    TEXT,
  -- HEAD before the agent spent anything. Evidence is a diff against this,
  -- not against whatever the index looked like when the agent stopped: an
  -- agent that staged or committed before parking would otherwise show a
  -- clean diff over material changes.
  base_revision TEXT,
  branch        TEXT NOT NULL,
  worktree      TEXT NOT NULL,
  model         TEXT,
  outcome       TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change')),
  reason        TEXT,
  committed     INTEGER,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  -- Stamped by the invocation gateway the instant before the provider
  -- process spawns. A run without it never paid anything; the zero-token
  -- invariant is "provider spawns == runs carrying this stamp".
  provider_started_at TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  -- The provider's own usage object, bounded, for when the parsed columns
  -- above turn out to have missed something. NULL = unmeasured, and the
  -- brief says so rather than summing a lie.
  usage_json    TEXT,
  -- HEAD after the agent, as accepted. The builder owns commits; an agent
  -- that moved HEAD itself is refused, so this names the exact commit any
  -- publication may push.
  head_revision TEXT,
  -- The validated terminal handoff's conclusion — bounded, typed at
  -- ingestion, and the only agent prose a PR body may quote.
  handoff       TEXT
);

-- The decision record (§7): the judgement call an agent refused to guess at,
-- typed so it renders identically every time and fits on a phone. "run" is
-- UNIQUE and is the decision's whole identity — task, repo, branch, and lease
-- are reached by joining through it, never stored again here, because two
-- copies of an identity is how a decision ends up holding one task while
-- showing another task's evidence.
CREATE TABLE IF NOT EXISTS decision (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run            INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  urgency        TEXT NOT NULL CHECK (urgency IN ('blocking')),
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','expired','answered')),
  recap          TEXT NOT NULL,
  question       TEXT NOT NULL,
  options        TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  assignee       TEXT,
  -- Attention metadata only. A deadline is never a hold expiry: a blocking
  -- decision that goes overdue becomes 'expired' and MORE visible, not a
  -- task that quietly dispatches itself unanswered.
  deadline       TEXT,
  created_at     TEXT NOT NULL,
  answered_at    TEXT,
  answered_by    TEXT,
  answered_via   TEXT CHECK (answered_via IN ('cli','web','telegram')),
  choice         TEXT,
  note           TEXT
);

-- Evidence, by reference (§4): the file lives on the runner under the
-- evidence root, and "key" is relative to that root — never an absolute path
-- a row could point anywhere with. The capture columns record how the file
-- was made and whether it is complete, because a truncated diff presented as
-- the whole story is worse than no diff.
CREATE TABLE IF NOT EXISTS artifact (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload')),
  key            TEXT NOT NULL,
  bytes_original INTEGER NOT NULL,
  bytes_stored   INTEGER NOT NULL,
  truncated      INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT NOT NULL,
  capture        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  redacted       INTEGER NOT NULL DEFAULT 0
);

-- Which artifacts a decision shows. A relation rather than JSON ids in the
-- decision row, so "artifact.run = decision.run" can be enforced at insert —
-- the agent's own payload never chooses what counts as evidence.
CREATE TABLE IF NOT EXISTS decision_artifact (
  decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  artifact INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  PRIMARY KEY (decision, artifact)
);

-- Which answers a resume run was actually given, snapshot included — causal
-- provenance, not timestamps. "The run after the answer" stops being true the
-- moment a resume fails and a second decision is answered in between.
CREATE TABLE IF NOT EXISTS run_decision (
  run      INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  choice   TEXT NOT NULL,
  note     TEXT,
  PRIMARY KEY (run, decision)
);

-- A durable attention record for the parks that never became decisions: the
-- agent tried to park, repair ran out, and the task is now held with nothing
-- in DECIDE to show for it. Unlike a failed run, an incident cannot age out
-- of a briefing window — it stays in every brief until somebody resolves it.
CREATE TABLE IF NOT EXISTS incident (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);

-- The durable outbox (§6). A notification is a fact that something wants a
-- person, recorded next to the record that made it true — because one that
-- lives only in a process's memory dies with the process, at exactly the
-- moment it was most worth sending. dedupe_key is an episode identity: a
-- gap nags once per occurrence, not once per cron firing and not forever.
CREATE TABLE IF NOT EXISTS notification (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key      TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error      TEXT,
  delivered_at    TEXT,
  -- What the delivery command said on success — the closest thing to a
  -- provider receipt a shell command can hand back.
  receipt         TEXT
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
  added_at        TEXT NOT NULL,
  -- Bumped whenever the credential is replaced. Anything that derives
  -- authority from an approver — a paired Telegram chat, an outstanding
  -- pairing code — records the generation it was granted under, and a
  -- rotation strands every grant from the old one.
  generation      INTEGER NOT NULL DEFAULT 1
);

-- One Telegram chat speaking as one approver. Bindings are never deleted:
-- revocation is a stamp, because "who could answer as whom, when" is an
-- audit question a DELETE cannot answer. The partial unique index is the
-- v1 rule that exactly one binding is live per bot at a time.
CREATE TABLE IF NOT EXISTS telegram_binding (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id              TEXT NOT NULL,
  chat_id             TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  approver            TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  approver_generation INTEGER NOT NULL,
  paired_at           TEXT NOT NULL,
  paired_by           TEXT NOT NULL,
  pair_update_id      INTEGER,
  revoked_at          TEXT,
  revoked_by          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_binding_live
  ON telegram_binding (bot_id) WHERE revoked_at IS NULL;

-- One-time pairing codes, hashed like every other credential, consumed in
-- one transaction with the binding they create.
CREATE TABLE IF NOT EXISTS telegram_pairing (
  code_hash       TEXT PRIMARY KEY,
  approver        TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  approver_generation INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_chat   TEXT,
  consumed_user   TEXT,
  consumed_update INTEGER
);

-- Every Telegram update this installation has applied, exactly once. The
-- PRIMARY KEY is the idempotency: a replayed batch re-applies nothing.
CREATE TABLE IF NOT EXISTS telegram_update (
  update_id  INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  result     TEXT NOT NULL
);

-- Opaque one-tap actions. callback_data carries only the random token; what
-- the tap MEANS — which binding, decision, option, and phase — lives here,
-- where a stolen bot token cannot read or forge it. Confirm challenges are
-- short-lived rows in the same table, consumed exactly once.
CREATE TABLE IF NOT EXISTS telegram_action (
  token       TEXT PRIMARY KEY,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  decision    INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  option_id   TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('choose','confirm','cancel')),
  chat_id     TEXT NOT NULL,
  message_id  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS telegram_action_by_decision ON telegram_action (decision);

-- The bridge's poll lease and cursor, per bot. One live poller at a time;
-- the cursor only ever moves forward, and only under a live generation.
CREATE TABLE IF NOT EXISTS bridge_lease (
  bot_id       TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  cursor       INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

-- Provider quota, keyed to what actually exhausts: one runner's credential
-- against one provider and scope — never the whole runner (§8 gate 3). A
-- free CPU slot against an exhausted quota is not capacity. 'half-open'
-- admits exactly one real dispatch after the reset; its success clears the
-- row, the same structured signal re-stamps it. Nothing stamps this from
-- stderr prose — only structured signals or an operator.
-- The scheduler's durable wake signal. Every readiness-changing write bumps
-- the sequence; watch records what it saw before a pass and runs again
-- immediately if the world moved while it worked. A boolean dirty flag
-- loses the wake that lands mid-pass; a monotonic sequence cannot.
CREATE TABLE IF NOT EXISTS wake (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO wake (id, seq) VALUES (1, 0);

-- One watch per (runner, repo), with an incarnation the claims it dispatches
-- carry. A restarted watch that heartbeats before its dead predecessor is
-- noticed would otherwise mask the crash forever (finding 8): recovery is
-- keyed to the superseded incarnation, not to runner liveness.
CREATE TABLE IF NOT EXISTS watch_lease (
  runner       TEXT NOT NULL,
  repo         TEXT NOT NULL,
  owner        TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (runner, repo)
);

CREATE TABLE IF NOT EXISTS quota (
  runner      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL CHECK (state IN ('exhausted','half-open')),
  reason      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reset_at    TEXT,
  PRIMARY KEY (runner, provider, scope)
);

-- One watch, as an episode with edges (§6): the night is a row, not "the
-- last 24 hours", so the morning briefing can bound itself to exactly what
-- one watch did — runs and publications attribute by runner and window.
-- ended_at NULL means it is still running, or died and never said. v5.
CREATE TABLE IF NOT EXISTS watch_episode (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  runner      TEXT NOT NULL,
  incarnation TEXT NOT NULL UNIQUE,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  ticks       INTEGER NOT NULL DEFAULT 0,
  built       INTEGER NOT NULL DEFAULT 0,
  broke       INTEGER NOT NULL DEFAULT 0
);

-- A project the console has opened: identity is the canonical repo path.
-- Registry only — a row here NEVER authorizes access (the ceiling is server
-- configuration); it remembers names and recency for the opener page. v6.
CREATE TABLE IF NOT EXISTS project (
  path           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_recent ON project (last_opened_at);

-- Standing permission to publish built work: git push and PR creation are
-- two different external writes, so they are two named capabilities under
-- one grant whose every term — exact GitHub repository, remote, allowed
-- head prefix, base branch — was shown to the approver before the yes.
-- Absence is denial; revocation is immediate. v5.
CREATE TABLE IF NOT EXISTS publication_grant (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo         TEXT NOT NULL,
  github_repo  TEXT NOT NULL,
  remote       TEXT NOT NULL,
  head_prefix  TEXT NOT NULL,
  base         TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  selector     TEXT NOT NULL CHECK (selector IN ('ours','all')),
  draft        INTEGER NOT NULL DEFAULT 1,
  granted_by   TEXT NOT NULL,
  granted_at   TEXT NOT NULL,
  revoked_by   TEXT,
  revoked_at   TEXT
);

-- One live grant per repo: proposing again replaces, revoking ends it.
CREATE UNIQUE INDEX IF NOT EXISTS publication_grant_live
  ON publication_grant (repo) WHERE revoked_at IS NULL;

-- The durable publication intent (§M4): completion and "this must reach a
-- PR" are one fenced write, and everything the worker needs afterwards —
-- the exact SHA to push, the exact refs, the body's identity — lives here,
-- so every phase is retryable after a crash and a retry can adopt the PR
-- it already opened instead of minting a twin. v5.
CREATE TABLE IF NOT EXISTS publication (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  task_ref    INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  github_repo TEXT NOT NULL,
  remote      TEXT NOT NULL,
  base        TEXT NOT NULL,
  head        TEXT NOT NULL,
  head_sha    TEXT NOT NULL,
  body_hash   TEXT NOT NULL,
  draft       INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('intended','pushed','opened','failed')),
  pr_number   INTEGER,
  pr_url      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS hold_by_task ON hold (task_ref);
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
  } else if (Number(version["version"]) < SCHEMA_VERSION) {
    // migrate() has already done the work by the time this runs; the row is
    // bookkeeping about it, not the trigger for it.
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
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
  addColumn(db, "notification", "resolved_at", "TEXT");
  // Delivery claiming: two deliverers (the bridge, `outbox deliver`) must
  // not both send one row. A claim is a short lease on the act of sending.
  addColumn(db, "notification", "claim_owner", "TEXT");
  addColumn(db, "notification", "claim_expires_at", "TEXT");
  addColumn(db, "approver", "generation", "INTEGER NOT NULL DEFAULT 1");
  // v4 additive: failure strikes and the watch incarnation a claim was
  // dispatched under.
  addColumn(db, "task_ref", "strikes", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "claim", "incarnation", "TEXT");
  rebuild(db);
  rebuildDecisionVia(db);
  // v4 CHECK widenings, each a copy-rename against an exactly recognized
  // predecessor. Order matters only in that they follow the older rebuilds:
  // an M2 database reaches the v4 shapes through rebuild() directly.
  rebuildForV4(
    db,
    "run",
    "'built','failed','refused','parked'",
    "'no-change'",
    V4_RUN_DDL("run_next"),
    V4_RUN_COLUMNS,
  );
  rebuildForV4(
    db,
    "hold",
    "'operator','decision','incident'",
    "'backoff'",
    `CREATE TABLE hold_next (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
       owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff')),
       owner_id   TEXT NOT NULL,
       reason     TEXT NOT NULL,
       until      TEXT,
       held_at    TEXT NOT NULL,
       UNIQUE (owner_kind, owner_id)
     )`,
    ["id", "task_ref", "owner_kind", "owner_id", "reason", "until", "held_at"],
  );
  rebuildForV4(
    db,
    "incident",
    "'malformed-decision'",
    "'attempts-exhausted'",
    `CREATE TABLE incident_next (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
       kind        TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure')),
       created_at  TEXT NOT NULL,
       resolved_at TEXT,
       resolved_by TEXT
     )`,
    ["id", "run", "kind", "created_at", "resolved_at", "resolved_by"],
  );
  // Columns the v4 run shape carries; idempotent for any table that arrived
  // here by a path that already has them.
  addColumn(db, "run", "provider_started_at", "TEXT");
  addColumn(db, "run", "tokens_in", "INTEGER");
  addColumn(db, "run", "tokens_out", "INTEGER");
  addColumn(db, "run", "cost_usd", "REAL");
  addColumn(db, "run", "usage_json", "TEXT");
  addColumn(db, "run", "head_revision", "TEXT");
  addColumn(db, "run", "handoff", "TEXT");
}

/** The v4 run shape, shared by the fresh SCHEMA, the M2 rebuild, and the v3→v4 rebuild. */
function V4_RUN_DDL(name: string): string {
  return `CREATE TABLE ${name} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
    lease_id      TEXT NOT NULL,
    runner        TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair')),
    parent_run    INTEGER REFERENCES run(id),
    session_id    TEXT,
    base_revision TEXT,
    branch        TEXT NOT NULL,
    worktree      TEXT NOT NULL,
    model         TEXT,
    outcome       TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change')),
    reason        TEXT,
    committed     INTEGER,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    provider_started_at TEXT,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    cost_usd      REAL,
    usage_json    TEXT,
    head_revision TEXT,
    handoff       TEXT
  )`;
}

const V4_RUN_COLUMNS = [
  "id", "task_ref", "lease_id", "runner", "role", "parent_run", "session_id",
  "base_revision", "branch", "worktree", "model", "outcome", "reason",
  "committed", "started_at", "finished_at", "provider_started_at", "tokens_in",
  "tokens_out", "cost_usd", "usage_json", "head_revision", "handoff",
];

/**
 * One v4 CHECK widening: recognized exactly, refused otherwise. The copy
 * moves the intersection of the target's columns and the columns actually
 * present, so an interrupted earlier migration cannot lose data.
 */
function rebuildForV4(
  db: Database,
  table: string,
  oldFragment: string,
  newFragment: string,
  targetDDL: string,
  targetColumns: readonly string[],
): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (row === undefined) return;
  const ddl = String(row["sql"]);
  if (ddl.includes(newFragment)) return;
  if (!ddl.includes(oldFragment)) {
    throw new Error(`the ${table} table's DDL is not a shape this migration knows — refusing to rebuild it`);
  }

  const present = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(one => String(one["name"])),
  );
  const carried = targetColumns.filter(column => present.has(column));
  const names = carried.join(", ");

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(targetDDL);
      db.exec(`INSERT INTO ${table}_next (${names}) SELECT ${names} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_next RENAME TO ${table}`);
      if (table === "hold") db.exec("CREATE INDEX IF NOT EXISTS hold_by_task ON hold (task_ref)");
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`${table} rebuild left ${broken.length} dangling foreign key(s)`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * v3: decision.answered_via admits 'telegram'. Same copy-rename recipe as
 * rebuild(), but the detection is exact: only the two DDL shapes this
 * project has ever written are recognized, and anything else refuses loudly
 * — a substring guess against somebody's hand-edited schema is how a
 * migration eats a database.
 */
function rebuildDecisionVia(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'decision'")
    .get();
  if (row === undefined) return;
  const ddl = String(row["sql"]);
  if (ddl.includes("'cli','web','telegram'")) return;
  if (!ddl.includes("'cli','web'")) {
    throw new Error(
      "the decision table's DDL is not a shape this migration knows — refusing to rebuild it",
    );
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        `CREATE TABLE decision_next (
           id             INTEGER PRIMARY KEY AUTOINCREMENT,
           run            INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
           urgency        TEXT NOT NULL CHECK (urgency IN ('blocking')),
           state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','expired','answered')),
           recap          TEXT NOT NULL,
           question       TEXT NOT NULL,
           options        TEXT NOT NULL,
           recommendation TEXT NOT NULL,
           assignee       TEXT,
           deadline       TEXT,
           created_at     TEXT NOT NULL,
           answered_at    TEXT,
           answered_by    TEXT,
           answered_via   TEXT CHECK (answered_via IN ('cli','web','telegram')),
           choice         TEXT,
           note           TEXT
         )`,
      );
      db.exec(
        `INSERT INTO decision_next (id, run, urgency, state, recap, question, options,
                                    recommendation, assignee, deadline, created_at,
                                    answered_at, answered_by, answered_via, choice, note)
         SELECT id, run, urgency, state, recap, question, options,
                recommendation, assignee, deadline, created_at,
                answered_at, answered_by, answered_via, choice, note FROM decision`,
      );
      db.exec("DROP TABLE decision");
      db.exec("ALTER TABLE decision_next RENAME TO decision");
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`decision rebuild left ${broken.length} dangling foreign key(s)`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * The tables whose shape changed, not merely grew.
 *
 * `run`'s outcome CHECK had to admit 'parked' and `hold` had to move its
 * primary key, and SQLite's ALTER can do neither — so this is the manual's
 * copy-rename recipe: build the new table, move the rows, drop the old, take
 * its name. Detected by column presence, like `addColumn`, so it runs once
 * per database ever and is a no-op on a fresh file whose SCHEMA already has
 * the new shape.
 *
 * Every fresh-`:memory:` test passes without this function existing; the
 * first park against a real M2 database is what it exists for.
 */
function rebuild(db: Database): void {
  const oldHold = tableExists(db, "hold") && !hasColumn(db, "hold", "owner_kind");
  const oldRun = tableExists(db, "run") && !hasColumn(db, "run", "role");
  if (!oldHold && !oldRun) return;

  // Foreign keys off so `run` can be dropped while decision/artifact rows
  // name it — and a PRAGMA is a no-op inside a transaction, so it brackets
  // one rather than living in it. The check at the end proves the swap left
  // every reference intact before anything commits.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (oldHold) {
        db.exec(
          `CREATE TABLE hold_next (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
             owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff')),
             owner_id   TEXT NOT NULL,
             reason     TEXT NOT NULL,
             until      TEXT,
             held_at    TEXT NOT NULL,
             UNIQUE (owner_kind, owner_id)
           )`,
        );
        // Every pre-M3 hold was placed by a person; ownership records that.
        db.exec(
          `INSERT INTO hold_next (task_ref, owner_kind, owner_id, reason, until, held_at)
           SELECT task_ref, 'operator', CAST(task_ref AS TEXT), reason, until, held_at FROM hold`,
        );
        db.exec("DROP TABLE hold");
        db.exec("ALTER TABLE hold_next RENAME TO hold");
        db.exec("CREATE INDEX IF NOT EXISTS hold_by_task ON hold (task_ref)");
      }
      if (oldRun) {
        // Straight to the newest shape: an M2 database does not stop at v3
        // on its way here.
        db.exec(V4_RUN_DDL("run_next"));
        db.exec(
          `INSERT INTO run_next (id, task_ref, lease_id, runner, branch, worktree, model,
                                 outcome, reason, committed, started_at, finished_at)
           SELECT id, task_ref, lease_id, runner, branch, worktree, model,
                  outcome, reason, committed, started_at, finished_at FROM run`,
        );
        db.exec("DROP TABLE run");
        db.exec("ALTER TABLE run_next RENAME TO run");
      }
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`schema rebuild left ${broken.length} dangling foreign key(s)`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function tableExists(db: Database, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some(row => String(row["name"]) === column);
}

function addColumn(db: Database, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
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
      this.bumpWake();
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

  /** The whole reference by its id — the overlay's view of one task. */
  refForId(taskRef: number): TaskRef | null {
    const row = this.db.prepare("SELECT * FROM task_ref WHERE id = ?").get(taskRef);
    return row === undefined ? null : readTaskRef(row);
  }

  setTaskState(id: string, state: TaskState, now: Date, mutation: Mutation = {}): boolean {
    return this.once(
      mutation,
      "setTaskState",
      () => {
        const { changes } = this.db
          .prepare("UPDATE task SET state = ?, updated_at = ? WHERE id = ?")
          .run(state, now.toISOString(), id);
        if (Number(changes) > 0) this.bumpWake();
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

  /** Whether this connection is already inside transact(); see below. */
  private transacting = false;

  /**
   * IMMEDIATE, so two writers queue rather than both deciding they may write.
   *
   * Reentrant: a body that calls another transact()-wrapped method joins the
   * outer transaction instead of throwing "within a transaction". The outer
   * caller owns commit and rollback — which is the point: the Telegram
   * bridge composes pairing, action consumption, and the answer CAS into
   * one atomic unit precisely by nesting the methods that each guard
   * themselves when called alone.
   */
  transact<T>(body: () => T): T {
    if (this.transacting) return body();
    this.db.exec("BEGIN IMMEDIATE");
    this.transacting = true;
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transacting = false;
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

  /** The reference if it exists — a read that never creates, for surfaces that only look. */
  lookupRef(taskId: string): TaskRef | null {
    const row = this.db
      .prepare("SELECT * FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(BUILT_IN, taskId);
    return row === undefined ? null : readTaskRef(row);
  }

  /** Whether this task is one we created, as recorded — not as asserted. */
  originOf(backend: string, externalId: string): TaskOrigin {
    const row = this.db
      .prepare("SELECT origin FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(backend, externalId);
    return row !== undefined && String(row["origin"]) === "ours" ? "ours" : "theirs";
  }

  /**
   * The operator's hold — the CLI's pause button. One per task, replaced on
   * repeat. Decision and incident holds go through `holdOwned`, and lifting
   * this one never touches theirs.
   */
  hold(taskRef: number, reason: string, until: Date | null, now: Date, mutation: Mutation = {}): void {
    this.once(mutation, "hold", () => {
      this.holdOwned(
        { taskRef, ownerKind: "operator", ownerId: String(taskRef), reason, until },
        now,
      );
      return null;
    });
  }

  /** Place a hold on behalf of its owner. One hold per owner, replaced on repeat. */
  holdOwned(
    hold: {
      taskRef: number;
      ownerKind: HoldOwner;
      ownerId: string;
      reason: string;
      until: Date | null;
    },
    now: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO hold (task_ref, owner_kind, owner_id, reason, until, held_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_kind, owner_id) DO UPDATE SET task_ref = excluded.task_ref,
                                                          reason = excluded.reason,
                                                          until = excluded.until,
                                                          held_at = excluded.held_at`,
      )
      .run(
        hold.taskRef,
        hold.ownerKind,
        hold.ownerId,
        hold.reason,
        hold.until === null ? null : hold.until.toISOString(),
        now.toISOString(),
      );
  }

  /**
   * The CLI's unhold lifts only the operator's own hold. A task still held by
   * an open decision stays held — the way out of that hold is answering it.
   */
  unhold(taskRef: number, mutation: Mutation = {}): boolean {
    return this.once(
      mutation,
      "unhold",
      () => {
        const { changes } = this.db
          .prepare("DELETE FROM hold WHERE task_ref = ? AND owner_kind = 'operator'")
          .run(taskRef);
        if (Number(changes) > 0) this.bumpWake();
        return Number(changes) > 0;
      },
      lifted => lifted,
    );
  }

  /** Lift exactly one owner's hold, whoever else may still be holding. */
  releaseOwnedHold(ownerKind: HoldOwner, ownerId: string): boolean {
    const { changes } = this.db
      .prepare("DELETE FROM hold WHERE owner_kind = ? AND owner_id = ?")
      .run(ownerKind, ownerId);
    return Number(changes) > 0;
  }

  /** The hold in force right now, if any. An elapsed `until` is not one. */
  activeHold(taskRef: number, now: Date): Hold | null {
    const [first = null] = this.activeHolds(taskRef, now);
    return first;
  }

  /** Every hold in force — a task can be held by more than one owner at once. */
  activeHolds(taskRef: number, now: Date): Hold[] {
    return this.db
      .prepare(
        `SELECT * FROM hold WHERE task_ref = ? AND (until IS NULL OR until > ?)
         ORDER BY held_at, id`,
      )
      .all(taskRef, now.toISOString())
      .map(readHold);
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
      // Replacing a credential is a rotation: the generation moves, and
      // everything that derived authority from the old one — a paired chat,
      // an outstanding pairing code — is stranded by the comparison, then
      // swept by revokeDerivedAuthority in the same transaction.
      this.transact(() => {
        this.db
          .prepare(
            `INSERT INTO approver (name, credential_hash, added_at, generation) VALUES (?, ?, ?, 1)
             ON CONFLICT (name) DO UPDATE SET credential_hash = excluded.credential_hash,
                                              added_at = excluded.added_at,
                                              generation = approver.generation + 1`,
          )
          .run(name, credentialHash, now.toISOString());
        this.revokeDerivedAuthority(name, "credential-rotation", now);
      });
      return null;
    });
  }

  approverHash(name: string): string | null {
    const row = this.db.prepare("SELECT credential_hash FROM approver WHERE name = ?").get(name);
    return row === undefined ? null : String(row["credential_hash"]);
  }

  approverGeneration(name: string): number | null {
    const row = this.db.prepare("SELECT generation FROM approver WHERE name = ?").get(name);
    return row === undefined ? null : Number(row["generation"]);
  }

  /**
   * Strand everything that speaks for an approver at one remove: live
   * Telegram bindings are revoked (softly — the audit trail stays), unspent
   * pairing codes and unconsumed action tokens die with them. Called on
   * credential rotation and on explicit unpair.
   */
  revokeDerivedAuthority(approver: string, by: string, now: Date): void {
    const stamp = now.toISOString();
    const bindings = this.db
      .prepare("SELECT id FROM telegram_binding WHERE approver = ? AND revoked_at IS NULL")
      .all(approver)
      .map(row => Number(row["id"]));
    this.db
      .prepare(
        "UPDATE telegram_binding SET revoked_at = ?, revoked_by = ? WHERE approver = ? AND revoked_at IS NULL",
      )
      .run(stamp, by, approver);
    for (const binding of bindings) {
      this.db
        .prepare("UPDATE telegram_action SET consumed_at = ? WHERE binding = ? AND consumed_at IS NULL")
        .run(stamp, binding);
    }
    this.db
      .prepare("DELETE FROM telegram_pairing WHERE approver = ? AND consumed_at IS NULL")
      .run(approver);
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
    // A gap that just filled ends its notification episode: the next failure
    // is a new fact, and must be allowed to say so.
    if (Number(changes) > 0 && outcome.status === "verified") {
      this.clearGapEpisode(repo, kind, name);
      this.bumpWake();
    }
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

  /**
   * The operator's answer to a stall: one transaction that resolves the
   * task's open incidents (lifting their holds), clears strikes and any
   * backoff, and returns the task to the queue. The authenticated act that
   * un-decides "this stopped being worth retrying".
   *
   * Requeueability is re-proved HERE, not by whoever rendered the button: a
   * task is requeueable when it is failed or carries an unresolved
   * incident, and nothing holds a live claim on it. A stale form submitted
   * after the world moved gets a refusal, never a silent erase of somebody
   * else's incident and backoff state.
   */
  /**
   * Whether a still-current, unexpired claim holds this task right now — the
   * one predicate cancel, requeue, and scope edits all defer to, because a
   * console act that ignored a live runner would be overwritten by that
   * runner's completion minutes later.
   */
  hasLiveClaim(taskRef: number, now: Date): boolean {
    const live = this.db
      .prepare(
        `SELECT 1 AS hit FROM claim
          WHERE task_ref = ? AND released_at IS NULL AND expires_at > ?
            AND lease_generation = (
              SELECT MAX(newest.lease_generation) FROM claim AS newest
              WHERE newest.task_ref = claim.task_ref
            )`,
      )
      .get(taskRef, now.toISOString());
    return live !== undefined;
  }

  requeueTask(
    taskId: string,
    by: string,
    now: Date,
  ):
    | { ok: true; resolvedIncidents: number }
    | { ok: false; reason: "unknown-task" | "not-stalled" | "claimed" } {
    return this.transact(() => {
      const ref = this.db
        .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
        .get(BUILT_IN, taskId);
      if (ref === undefined) return { ok: false as const, reason: "unknown-task" as const };
      const taskRef = Number(ref["id"]);

      const stamp = now.toISOString();
      if (this.hasLiveClaim(taskRef, now)) return { ok: false as const, reason: "claimed" as const };

      const incidents = this.db
        .prepare(
          `SELECT incident.id FROM incident
           JOIN run ON run.id = incident.run
           WHERE run.task_ref = ? AND incident.resolved_at IS NULL`,
        )
        .all(taskRef)
        .map(row => Number(row["id"]));
      const state = this.db.prepare("SELECT state FROM task WHERE id = ?").get(taskId);
      if (incidents.length === 0 && String(state?.["state"]) !== "failed") {
        return { ok: false as const, reason: "not-stalled" as const };
      }

      for (const incident of incidents) this.resolveIncidentLocked(incident, by, now);

      this.resetStrikes(taskRef);
      this.db
        .prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state IN ('failed','queued')")
        .run(stamp, taskId);
      // The stall's page is answered by the act itself.
      this.resolveEpisode(`stalled:${taskRef}`, now);
      this.bumpWake();
      return { ok: true as const, resolvedIncidents: incidents.length };
    });
  }

  /**
   * Cancel, aware of who might be building right now. A live claim wins:
   * cancelling under a runner would let its completion overwrite the
   * cancellation minutes later, so the answer is a refusal that names the
   * holder — stop the claim first (or let it lapse), then cancel.
   */
  cancelTask(
    taskId: string,
    now: Date,
  ): { ok: true } | { ok: false; reason: "unknown-task" | "claimed" | "already-terminal" } {
    return this.transact(() => {
      const ref = this.db
        .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
        .get(BUILT_IN, taskId);
      if (ref === undefined) return { ok: false as const, reason: "unknown-task" as const };

      const stamp = now.toISOString();
      if (this.hasLiveClaim(Number(ref["id"]), now)) return { ok: false as const, reason: "claimed" as const };

      const { changes } = this.db
        .prepare(
          "UPDATE task SET state = 'cancelled', updated_at = ? WHERE id = ? AND state IN ('queued','failed','running')",
        )
        .run(stamp, taskId);
      if (Number(changes) === 0) return { ok: false as const, reason: "already-terminal" as const };
      this.bumpWake();
      return { ok: true as const };
    });
  }

  /**
   * The console's task creation: admission control and atomicity the CLI's
   * local-trust path does not need. One transaction checks the active
   * backlog (queued + running below the cap), validates the writable
   * fields' caps and control rules — these strings will be rendered to
   * every surface — and creates the task, its placement, and its optional
   * scope together or not at all.
   */
  createConsoleTask(
    spec: { id?: string; title: string; repo?: string; goal?: string },
    now: Date,
    cap = 500,
  ):
    | { ok: true; id: string }
    | { ok: false; reason: "backlog-full" | "bad-id" | "bad-title" | "bad-goal" | "duplicate" } {
    if (spec.id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(spec.id)) {
      return { ok: false, reason: "bad-id" };
    }
    if (spec.title.trim() === "" || spec.title.length > 200 || hasForbiddenControls(spec.title)) {
      return { ok: false, reason: "bad-title" };
    }
    if (spec.goal !== undefined && (spec.goal.trim() === "" || spec.goal.length > 2_000 || hasForbiddenControls(spec.goal))) {
      return { ok: false, reason: "bad-goal" };
    }
    return this.transact(() => {
      const backlog = this.db
        .prepare("SELECT COUNT(*) AS n FROM task WHERE state IN ('queued','running')")
        .get();
      if (Number(backlog?.["n"] ?? 0) >= cap) return { ok: false as const, reason: "backlog-full" as const };

      // No id given: slug the title, uniquified inside this same transaction
      // so two concurrent creates cannot mint the same one.
      let id = spec.id;
      if (id === undefined) {
        const base =
          spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "task";
        id = base;
        for (let n = 2; this.db.prepare("SELECT 1 AS hit FROM task WHERE id = ?").get(id) !== undefined; n++) {
          id = `${base}-${n}`;
        }
      } else if (this.db.prepare("SELECT 1 AS hit FROM task WHERE id = ?").get(id) !== undefined) {
        return { ok: false as const, reason: "duplicate" as const };
      }

      this.createTask({ id, title: spec.title.trim() }, now);
      const ref = this.refFor(BUILT_IN, id, "ours");
      // Placement happens BEFORE the scope exists, so the immutability guard
      // in placeTask never fires here — atomic create, place, then scope.
      if (spec.repo !== undefined && spec.repo !== "") this.placeTask(ref.id, spec.repo);
      if (spec.goal !== undefined) {
        const draft = { goal: spec.goal.trim(), outOfScope: null, touches: [] as string[] };
        this.saveScope({
          taskId: id,
          ...draft,
          proposedAt: now.toISOString(),
          digest: digestOf(draft),
          approvedAt: null,
          approvedBy: null,
          approvedDigest: null,
        });
      }
      return { ok: true as const, id };
    });
  }

  /**
   * Tasks stranded behind a terminally failed or cancelled blocker — work
   * that will never become ready, silently, unless somebody looks. Derived,
   * never stored; edges are preserved, and `task requeue <blocker>` is the
   * way out.
   */
  strandedTasks(repo: string | null = null): { id: string; blockedBy: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT task_edge.blocked AS id, task_edge.blocker AS blocker FROM task_edge
         JOIN task AS dependent ON dependent.id = task_edge.blocked AND dependent.state = 'queued'
         JOIN task AS blocker ON blocker.id = task_edge.blocker AND blocker.state IN ('failed','cancelled')
         JOIN task_ref ON task_ref.backend = '${'built-in'}' AND task_ref.external_id = task_edge.blocked
         WHERE (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY task_edge.blocked, task_edge.blocker`,
      )
      .all(repo, repo);
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const id = String(row["id"]);
      grouped.set(id, [...(grouped.get(id) ?? []), String(row["blocker"])]);
    }
    return [...grouped.entries()].map(([id, blockedBy]) => ({ id, blockedBy }));
  }

  /** One more consecutive failure. Returns the new count. */
  addStrike(taskRef: number): number {
    this.db.prepare("UPDATE task_ref SET strikes = strikes + 1 WHERE id = ?").run(taskRef);
    const row = this.db.prepare("SELECT strikes FROM task_ref WHERE id = ?").get(taskRef);
    return Number(row?.["strikes"] ?? 0);
  }

  /**
   * A concluded success — built, no-change, or parked — ends the streak and
   * lifts any backoff still standing from it.
   */
  resetStrikes(taskRef: number): void {
    this.db.prepare("UPDATE task_ref SET strikes = 0 WHERE id = ?").run(taskRef);
    this.releaseOwnedHold("backoff", String(taskRef));
  }

  /** Say which repository a task's work lives in. */
  /**
   * Placement is immutable once a scope exists: an approval restates a goal
   * *for a project*, and moving the task afterwards would re-aim the yes at
   * a repo nobody agreed to. Place first, then scope — or requeue a fresh
   * task. (Console v2 review, finding 3.)
   */
  placeTask(
    taskRef: number,
    repo: string,
    mutation: Mutation = {},
  ): boolean | { ok: false; reason: "scoped" } {
    return this.once(mutation, "placeTask", () => {
      return this.transact(() => {
        const external = this.db
          .prepare("SELECT external_id FROM task_ref WHERE id = ?")
          .get(taskRef);
        if (external !== undefined) {
          const scoped = this.db
            .prepare("SELECT 1 AS hit FROM task_scope WHERE task_id = ?")
            .get(String(external["external_id"]));
          const current = this.db.prepare("SELECT repo FROM task_ref WHERE id = ?").get(taskRef);
          const already = current?.["repo"] === null ? null : String(current?.["repo"]);
          if (scoped !== undefined && already !== repo) {
            return { ok: false as const, reason: "scoped" as const };
          }
        }
        const { changes } = this.db
          .prepare("UPDATE task_ref SET repo = ? WHERE id = ?")
          .run(repo, taskRef);
        return Number(changes) > 0;
      });
    });
  }

  // ---- the outbox ---------------------------------------------------------

  /** True if this is a new fact; false if the episode already knows. */
  enqueueNotification(
    notification: { dedupeKey: string; kind: string; subject: string; body: string },
    now: Date,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO notification (dedupe_key, kind, subject, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        notification.dedupeKey,
        notification.kind,
        notification.subject,
        notification.body,
        now.toISOString(),
      );
    return Number(changes) > 0;
  }

  listNotifications(only: "pending" | "all" = "pending"): Notification[] {
    // Resolved-but-undelivered is not pending: a decision answered before the
    // outbox ran is a fact that stopped wanting a person, and paging someone
    // about it anyway would teach them to ignore the pager.
    const where = only === "pending" ? "WHERE delivered_at IS NULL AND resolved_at IS NULL" : "";
    return this.db
      .prepare(`SELECT * FROM notification ${where} ORDER BY id`)
      .all()
      .map(readNotification);
  }

  recordDelivery(
    id: number,
    outcome: { ok: true; receipt: string | null } | { ok: false; error: string },
    now: Date,
  ): void {
    if (outcome.ok) {
      this.db
        .prepare(
          `UPDATE notification SET delivered_at = ?, receipt = ?, attempts = attempts + 1, last_attempt_at = ?, last_error = NULL
            WHERE id = ?`,
        )
        .run(now.toISOString(), outcome.receipt, now.toISOString(), id);
      return;
    }
    this.db
      .prepare(
        `UPDATE notification SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
          WHERE id = ?`,
      )
      .run(now.toISOString(), outcome.error, id);
  }

  /**
   * Close a gap's notification episode. Called when its capability verifies:
   * the next failure is a *new* fact, and a dedupe key that suppressed it
   * forever would be a gap the operator hears about exactly once per lifetime.
   */
  clearGapEpisode(repo: string, kind: string, name: string): void {
    this.db
      .prepare("DELETE FROM notification WHERE dedupe_key = ?")
      .run(`gap:${repo}:${kind}:${name}`);
  }

  /**
   * The other way an episode ends: the fact stopped wanting a person. Unlike
   * a gap — which is deleted so a recurrence can speak again — a resolved
   * decision or incident never recurs under the same key, so the row stays,
   * receipts and all.
   */
  resolveEpisode(dedupeKey: string, now: Date): void {
    this.db
      .prepare("UPDATE notification SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL")
      .run(now.toISOString(), dedupeKey);
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
    role?: "builder" | "repair";
    parentRun?: number;
    sessionId?: string;
    now: Date;
  }): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO run (task_ref, lease_id, runner, branch, worktree, model, role, parent_run, session_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.taskRef,
        run.leaseId,
        run.runner,
        run.branch,
        run.worktree,
        run.model ?? null,
        run.role ?? "builder",
        run.parentRun ?? null,
        run.sessionId ?? null,
        run.now.toISOString(),
      );
    return Number(inserted.lastInsertRowid);
  }

  /**
   * Facts learned after the row was opened: the base revision is read just
   * before the agent spends, and the session id only exists once the agent's
   * envelope comes back. COALESCE, never overwrite — the first stamp is the
   * true one.
   */
  stampRun(id: number, facts: { baseRevision?: string; sessionId?: string }): void {
    this.db
      .prepare(
        `UPDATE run SET base_revision = COALESCE(base_revision, ?),
                        session_id = COALESCE(session_id, ?)
          WHERE id = ?`,
      )
      .run(facts.baseRevision ?? null, facts.sessionId ?? null, id);
  }

  finishRun(
    id: number,
    result: {
      outcome: "built" | "failed" | "refused" | "parked" | "no-change";
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
    // The park rate is *measured* — parked over concluded builder attempts —
    // and maintained where attempts conclude, because the attention budget's
    // gate reads it inside a claim transaction and must never trust a number
    // something else remembered to update.
    if (result.outcome === "parked" || result.outcome === "built" || result.outcome === "no-change") {
      this.db
        .prepare(
          `UPDATE task_ref SET park_rate = COALESCE((
             SELECT CAST(SUM(CASE WHEN outcome = 'parked' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
               FROM run
              WHERE run.task_ref = task_ref.id
                AND run.role = 'builder'
                AND run.outcome IN ('built', 'parked', 'no-change')
           ), 0)
           WHERE id = (SELECT task_ref FROM run
                        WHERE run.id = ? AND run.role = 'builder')`,
        )
        .run(id);
    }
  }

  getRun(id: number): Run | null {
    const row = this.db.prepare("SELECT * FROM run WHERE id = ?").get(id);
    return row === undefined ? null : readRun(row);
  }

  /**
   * The instant before the provider process spawns, stamped by the gateway
   * and nothing else. First stamp wins: a run either paid once or it did
   * not, and "provider spawns == runs carrying this stamp" is the
   * zero-token invariant's testable half.
   */
  stampProviderStart(id: number, now: Date): void {
    this.db
      .prepare("UPDATE run SET provider_started_at = COALESCE(provider_started_at, ?) WHERE id = ?")
      .run(now.toISOString(), id);
  }

  /** What the provider said it cost. NULL columns stay NULL — unmeasured, and said so. */
  recordUsage(
    id: number,
    usage: { tokensIn?: number; tokensOut?: number; costUsd?: number; usageJson?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE run SET tokens_in = COALESCE(?, tokens_in),
                        tokens_out = COALESCE(?, tokens_out),
                        cost_usd = COALESCE(?, cost_usd),
                        usage_json = COALESCE(?, usage_json)
          WHERE id = ?`,
      )
      .run(
        usage.tokensIn ?? null,
        usage.tokensOut ?? null,
        usage.costUsd ?? null,
        usage.usageJson ?? null,
        id,
      );
  }

  /** The accepted head and the validated conclusion, once known. */
  recordOutcomeFacts(id: number, facts: { headRevision?: string; handoff?: string }): void {
    this.db
      .prepare(
        `UPDATE run SET head_revision = COALESCE(?, head_revision),
                        handoff = COALESCE(?, handoff)
          WHERE id = ?`,
      )
      .run(facts.headRevision ?? null, facts.handoff ?? null, id);
  }

  /** Every attempt since a moment, task ids attached — the overnight, as data. */
  runsSince(since: string): (Run & { taskId: string })[] {
    return this.db
      .prepare(
        `SELECT run.*, task_ref.external_id AS task_id FROM run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE run.started_at >= ? ORDER BY run.id`,
      )
      .all(since)
      .map(row => ({ ...readRun(row), taskId: String(row["task_id"]) }));
  }

  /**
   * The scoped read family: every list the console shows can be filtered to
   * one project. NULL repo rows (unplaced work) are always included — they
   * belong to every view — and a NULL filter means "no filter". Bounding
   * happens in the SQL, never by slicing a global read afterwards.
   */
  runsSinceScoped(since: string, repo: string | null): (Run & { taskId: string })[] {
    return this.db
      .prepare(
        `SELECT run.*, task_ref.external_id AS task_id FROM run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE run.started_at >= ? AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY run.id`,
      )
      .all(since, repo, repo)
      .map(row => ({ ...readRun(row), taskId: String(row["task_id"]) }));
  }

  /**
   * One bounded page of tasks for the list pane, newest first, with the
   * selected task injected even when it falls outside the page — a detail
   * view whose own row is missing from its list reads as a bug.
   */
  listTasksScoped(
    repo: string | null,
    state: TaskState | undefined,
    limit: number,
    selectedId: string | null,
  ): (Task & { repo: string | null })[] {
    const page = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT task.*, task_ref.repo AS task_repo FROM task
           JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
           WHERE (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
             AND (? IS NULL OR task.state = ?)
           ORDER BY task.created_at DESC, task.id DESC LIMIT ?
         )
         UNION
         SELECT task.*, task_ref.repo AS task_repo FROM task
         JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
         WHERE task.id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(BUILT_IN, repo, repo, state ?? null, state ?? null, page, BUILT_IN, selectedId);
    return rows.map(row => ({
      id: String(row["id"]),
      title: String(row["title"]),
      state: String(row["state"]) as TaskState,
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      repo: row["task_repo"] === null ? null : String(row["task_repo"]),
    }));
  }

  /** Newest first, because the question is almost always "what just happened". */
  runsFor(taskRef: number): Run[] {
    return this.db
      .prepare("SELECT * FROM run WHERE task_ref = ? ORDER BY id DESC")
      .all(taskRef)
      .map(readRun);
  }

  /**
   * One page of runs, newest first, strictly before the cursor — id order,
   * because ids are the one monotonic thing a page can key on without a row
   * ever repeating or vanishing between requests. `null` means "from the
   * top". The limit is clamped here, not trusted from the caller: a page is
   * bounded by construction or it is not a page.
   */
  listRunsBefore(
    cursor: number | null,
    limit: number,
    repo: string | null = null,
  ): (Run & { taskId: string })[] {
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor <= 0)) return [];
    const page = Math.max(1, Math.min(Math.floor(limit), 200));
    return this.db
      .prepare(
        `SELECT run.*, task_ref.external_id AS task_id FROM run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE (? IS NULL OR run.id < ?)
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY run.id DESC LIMIT ?`,
      )
      .all(cursor, cursor, repo, repo, page)
      .map(row => ({ ...readRun(row), taskId: String(row["task_id"]) }));
  }

  // ---- decisions -----------------------------------------------------------

  /**
   * Insert a decision. Callers hand this a payload `parseDecision` already
   * validated and run it inside the park's fenced transaction — this method
   * is the write, not the policy.
   */
  saveDecision(
    decision: {
      run: number;
      urgency: "blocking";
      recap: string;
      question: string;
      options: DecisionOption[];
      recommendation: string;
      assignee?: string;
      deadline?: string;
    },
    now: Date,
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO decision (run, urgency, recap, question, options, recommendation, assignee, deadline, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.run,
        decision.urgency,
        decision.recap,
        decision.question,
        JSON.stringify(decision.options),
        decision.recommendation,
        decision.assignee ?? null,
        decision.deadline ?? null,
        now.toISOString(),
      );
    return Number(inserted.lastInsertRowid);
  }

  getDecision(id: number): Decision | null {
    const row = this.db.prepare("SELECT * FROM decision WHERE id = ?").get(id);
    return row === undefined ? null : readDecision(row);
  }

  decisionForRun(run: number): Decision | null {
    const row = this.db.prepare("SELECT * FROM decision WHERE run = ?").get(run);
    return row === undefined ? null : readDecision(row);
  }

  /**
   * Decisions with their task attached, oldest first — the attention surface
   * reads in the order the questions arrived. "unanswered" is open + expired:
   * expiry makes a decision louder, never gone.
   */
  listDecisions(only: "open" | "unanswered" | "all" = "unanswered"): (Decision & { taskId: string })[] {
    const where =
      only === "open"
        ? "WHERE decision.state = 'open'"
        : only === "unanswered"
          ? "WHERE decision.state IN ('open','expired')"
          : "";
    return this.db
      .prepare(
        `SELECT decision.*, task_ref.external_id AS task_id FROM decision
         JOIN run ON run.id = decision.run
         JOIN task_ref ON task_ref.id = run.task_ref
         ${where} ORDER BY decision.id`,
      )
      .all()
      .map(row => ({ ...readDecision(row), taskId: String(row["task_id"]) }));
  }

  /**
   * The lazy deadline sweep, run at every entry point that shows or answers
   * decisions. Expiry changes what a decision looks like, never what happens
   * to its task: the hold stays, and nothing chooses.
   */
  expireOverdueDecisions(now: Date): number {
    const { changes } = this.db
      .prepare(
        `UPDATE decision SET state = 'expired'
          WHERE state = 'open' AND deadline IS NOT NULL AND deadline <= ?`,
      )
      .run(now.toISOString());
    return Number(changes);
  }

  /** Every decision this task's runs ever raised, newest first — one task page's worth. */
  decisionsForTask(taskRef: number): Decision[] {
    return this.db
      .prepare(
        `SELECT decision.* FROM decision
         JOIN run ON run.id = decision.run
         WHERE run.task_ref = ? ORDER BY decision.id DESC`,
      )
      .all(taskRef)
      .map(readDecision);
  }

  /** Unanswered decisions whose task belongs to this project (or is unplaced). */
  listDecisionsScoped(repo: string | null): (Decision & { taskId: string })[] {
    return this.db
      .prepare(
        `SELECT decision.*, task_ref.external_id AS task_id FROM decision
         JOIN run ON run.id = decision.run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE decision.state IN ('open','expired')
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY decision.id`,
      )
      .all(repo, repo)
      .map(row => ({ ...readDecision(row), taskId: String(row["task_id"]) }));
  }

  countUnansweredScoped(repo: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM decision
         JOIN run ON run.id = decision.run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE decision.state IN ('open','expired')
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)`,
      )
      .get(repo, repo);
    return Number(row?.["n"] ?? 0);
  }

  countUnanswered(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM decision WHERE state IN ('open','expired')")
      .get();
    return Number(row?.["n"] ?? 0);
  }

  /**
   * Attach every answered-but-undelivered decision of this task to a run,
   * snapshot included — the causal record of which answers this attempt was
   * actually given (§4's parent_run provenance, as a relation).
   *
   * "Undelivered" means: not yet attached to any run that finished `built`.
   * A resume that failed may be handed the same answers again; the accepted
   * build is the durable terminus. Selection is causal, never temporal —
   * "newer than the last built run" stops being true the moment a resume
   * fails and a second decision is answered in between.
   */
  attachAnswers(runId: number, taskRef: number): (Decision & { taskId: string })[] {
    const rows = this.db
      .prepare(
        `SELECT decision.*, task_ref.external_id AS task_id FROM decision
         JOIN run ON run.id = decision.run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE run.task_ref = ? AND decision.state = 'answered'
           AND NOT EXISTS (
             SELECT 1 FROM run_decision
             JOIN run AS delivered ON delivered.id = run_decision.run
             WHERE run_decision.decision = decision.id AND delivered.outcome = 'built'
           )
         ORDER BY decision.id`,
      )
      .all(taskRef);
    for (const row of rows) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO run_decision (run, decision, choice, note) VALUES (?, ?, ?, ?)`,
        )
        .run(runId, Number(row["id"]), row["choice"], row["note"]);
    }
    return rows.map(row => ({ ...readDecision(row), taskId: String(row["task_id"]) }));
  }

  /** The answers a run was given, exactly as it was given them. */
  answersFor(runId: number): { decision: Decision; choice: string; note: string | null }[] {
    return this.db
      .prepare(
        `SELECT decision.*, run_decision.choice AS given_choice, run_decision.note AS given_note
           FROM run_decision
           JOIN decision ON decision.id = run_decision.decision
          WHERE run_decision.run = ? ORDER BY decision.id`,
      )
      .all(runId)
      .map(row => ({
        decision: readDecision(row),
        choice: String(row["given_choice"]),
        note: row["given_note"] === null ? null : String(row["given_note"]),
      }));
  }

  /**
   * Answer a decision: one transaction for the CAS, the hold, and the outbox
   * episode, because a crash between any two of them leaves a lie — answered
   * but still held, or free but still paging.
   *
   * `by` is an identity the CALLER authenticated; this method records, it
   * does not vouch. A decision is answered once: the same choice replayed is
   * the stored answer handed back, a different choice is refused — "done"
   * is not negotiable, and neither is "decided".
   */
  answerDecision(
    answer: { id: number; choice: string; by: string; via: "cli" | "web" | "telegram"; note?: string },
    now: Date,
    mutation: Mutation = {},
  ):
    | { ok: true; decision: Decision; duplicate?: boolean }
    | { ok: false; reason: "unknown-decision" | "bad-option" | "already-answered" | "bad-note" } {
    return this.once(
      mutation,
      "answerDecision",
      () => this.transact(() => this.answerDecisionLocked(answer, now)),
      result => result.ok,
    );
  }

  /**
   * The answer's body, for callers already holding the transaction — the
   * Telegram bridge re-proves its binding and consumes its action token in
   * the same transaction as this CAS, because "the chat was bound when we
   * looked" and "the chat is bound as this answer lands" are different
   * claims and only the second one authorizes anything.
   */
  answerDecisionLocked(
    answer: { id: number; choice: string; by: string; via: "cli" | "web" | "telegram"; note?: string },
    now: Date,
  ):
    | { ok: true; decision: Decision; duplicate?: boolean }
    | { ok: false; reason: "unknown-decision" | "bad-option" | "already-answered" | "bad-note" } {
    const existing = this.getDecision(answer.id);
    if (existing === null) return { ok: false as const, reason: "unknown-decision" as const };
    if (!existing.options.some(option => option.id === answer.choice)) {
      return { ok: false as const, reason: "bad-option" as const };
    }
    // The note reaches web pages, terminals, and — quoted — a later
    // agent's brief. Same discipline as everything else that travels.
    if (answer.note !== undefined && (answer.note.length > 500 || hasForbiddenControls(answer.note))) {
      return { ok: false as const, reason: "bad-note" as const };
    }

    const { changes } = this.db
      .prepare(
        `UPDATE decision SET state = 'answered', answered_at = ?, answered_by = ?,
                             answered_via = ?, choice = ?, note = ?
          WHERE id = ? AND state IN ('open','expired')`,
      )
      .run(now.toISOString(), answer.by, answer.via, answer.choice, answer.note ?? null, answer.id);
    if (Number(changes) === 0) {
      const settled = this.getDecision(answer.id) as Decision;
      return settled.choice === answer.choice
        ? { ok: true as const, decision: settled, duplicate: true }
        : { ok: false as const, reason: "already-answered" as const };
    }

    this.releaseOwnedHold("decision", String(answer.id));
    this.resolveEpisode(`decision:${answer.id}`, now);
    this.bumpWake();
    return { ok: true as const, decision: this.getDecision(answer.id) as Decision };
  }

  // ---- evidence ------------------------------------------------------------

  saveArtifact(
    artifact: {
      run: number;
      kind: Artifact["kind"];
      key: string;
      bytesOriginal: number;
      bytesStored: number;
      truncated: boolean;
      sha256: string;
      capture: string;
    },
    now: Date,
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, truncated, sha256, capture, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.run,
        artifact.kind,
        artifact.key,
        artifact.bytesOriginal,
        artifact.bytesStored,
        artifact.truncated ? 1 : 0,
        artifact.sha256,
        artifact.capture,
        now.toISOString(),
      );
    return Number(inserted.lastInsertRowid);
  }

  getArtifact(id: number): Artifact | null {
    const row = this.db.prepare("SELECT * FROM artifact WHERE id = ?").get(id);
    return row === undefined ? null : readArtifact(row);
  }

  /**
   * The artifact only if it belongs to this run — membership enforced by
   * the lookup itself, never by route choreography around two lookups. A
   * mismatched pair is simply not found, whatever the URL claimed.
   */
  artifactForRun(runId: number, artifactId: number): Artifact | null {
    const row = this.db
      .prepare("SELECT * FROM artifact WHERE run = ? AND id = ?")
      .get(runId, artifactId);
    return row === undefined ? null : readArtifact(row);
  }

  artifactsFor(run: number): Artifact[] {
    return this.db
      .prepare("SELECT * FROM artifact WHERE run = ? ORDER BY id")
      .all(run)
      .map(readArtifact);
  }

  /**
   * Attach evidence to a decision — refused unless both belong to the same
   * run. The guard is in the INSERT itself rather than checked first, so
   * nothing can slip between the check and the write.
   */
  linkEvidence(decision: number, artifact: number): void {
    const { changes } = this.db
      .prepare(
        `INSERT INTO decision_artifact (decision, artifact)
         SELECT d.id, a.id FROM decision AS d JOIN artifact AS a
          WHERE d.id = ? AND a.id = ? AND a.run = d.run`,
      )
      .run(decision, artifact);
    if (Number(changes) === 0) {
      throw new Error(
        `artifact ${artifact} does not belong to decision ${decision}'s run — evidence never crosses runs`,
      );
    }
  }

  evidenceFor(decision: number): Artifact[] {
    return this.db
      .prepare(
        `SELECT artifact.* FROM artifact
         JOIN decision_artifact ON decision_artifact.artifact = artifact.id
         WHERE decision_artifact.decision = ? ORDER BY artifact.id`,
      )
      .all(decision)
      .map(readArtifact);
  }

  // ---- incidents -----------------------------------------------------------

  createIncident(incident: { run: number; kind: Incident["kind"] }, now: Date): number {
    const inserted = this.db
      .prepare("INSERT INTO incident (run, kind, created_at) VALUES (?, ?, ?)")
      .run(incident.run, incident.kind, now.toISOString());
    return Number(inserted.lastInsertRowid);
  }

  incidentForRun(run: number): Incident | null {
    const row = this.db.prepare("SELECT * FROM incident WHERE run = ?").get(run);
    return row === undefined ? null : readIncident(row);
  }

  /** Unresolved, task attached, oldest first. No time window: these do not age out. */
  openIncidents(repo: string | null = null): (Incident & { taskId: string })[] {
    return this.db
      .prepare(
        `SELECT incident.*, task_ref.external_id AS task_id FROM incident
         JOIN run ON run.id = incident.run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE incident.resolved_at IS NULL
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY incident.id`,
      )
      .all(repo, repo)
      .map(row => ({ ...readIncident(row), taskId: String(row["task_id"]) }));
  }

  /** Every incident this task's runs ever raised, newest first, resolved or not. */
  incidentsForTask(taskRef: number): Incident[] {
    return this.db
      .prepare(
        `SELECT incident.* FROM incident
         JOIN run ON run.id = incident.run
         WHERE run.task_ref = ? ORDER BY incident.id DESC`,
      )
      .all(taskRef)
      .map(readIncident);
  }

  /** Resolving also lifts the incident's hold — one act, one transaction, owned here. */
  resolveIncident(id: number, by: string, now: Date): boolean {
    return this.transact(() => this.resolveIncidentLocked(id, by, now));
  }

  /** The body, for callers already holding the transaction (requeueTask). */
  private resolveIncidentLocked(id: number, by: string, now: Date): boolean {
    const { changes } = this.db
      .prepare("UPDATE incident SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL")
      .run(now.toISOString(), by, id);
    if (Number(changes) === 0) return false;
    this.releaseOwnedHold("incident", String(id));
    this.bumpWake();
    return true;
  }

  // ---- telegram ------------------------------------------------------------

  /** Mint a pairing code's record. The code itself was shown once; this is its hash. */
  createTelegramPairing(
    pairing: { codeHash: string; approver: string; by: string; ttlMs: number },
    now: Date,
  ): void {
    const generation = this.approverGeneration(pairing.approver);
    if (generation === null) throw new Error(`no approver named ${pairing.approver}`);
    this.db
      .prepare(
        `INSERT INTO telegram_pairing (code_hash, approver, approver_generation, created_at, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pairing.codeHash,
        pairing.approver,
        generation,
        now.toISOString(),
        pairing.by,
        new Date(now.getTime() + pairing.ttlMs).toISOString(),
      );
  }

  /**
   * Consume a pairing code and create the binding, as one transaction.
   *
   * The conditional UPDATE is the consumption: exactly one caller ever sees
   * `changes = 1`, however many pollers race. A replay of the very update
   * that paired (Telegram redelivers) recognizes the finished binding
   * instead of failing. Success invalidates every other outstanding code —
   * a code that was minted and superseded must not still open a door — and
   * the partial unique index enforces one live binding per bot.
   */
  consumeTelegramPairing(
    attempt: {
      codeHash: string;
      botId: string;
      chatId: string;
      userId: string;
      updateId: number;
    },
    now: Date,
  ):
    | { ok: true; binding: TelegramBinding; replay: boolean }
    | { ok: false; reason: "unknown-code" | "already-bound" } {
    return this.transact(() => {
      const stamp = now.toISOString();
      const { changes } = this.db
        .prepare(
          `UPDATE telegram_pairing
              SET consumed_at = ?, consumed_chat = ?, consumed_user = ?, consumed_update = ?
            WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(stamp, attempt.chatId, attempt.userId, attempt.updateId, attempt.codeHash, stamp);

      if (Number(changes) === 0) {
        // The same update replayed after a crash-between-apply-and-ack:
        // the code is consumed by exactly this chat and user, and the
        // binding it made is live. That is a completed pairing, not a foe.
        const consumed = this.db
          .prepare(
            `SELECT 1 AS hit FROM telegram_pairing
              WHERE code_hash = ? AND consumed_chat = ? AND consumed_user = ? AND consumed_update = ?`,
          )
          .get(attempt.codeHash, attempt.chatId, attempt.userId, attempt.updateId);
        if (consumed !== undefined) {
          const live = this.liveTelegramBinding(attempt.botId);
          if (live !== null && live.chatId === attempt.chatId && live.userId === attempt.userId) {
            return { ok: true as const, binding: live, replay: true };
          }
        }
        return { ok: false as const, reason: "unknown-code" as const };
      }

      const pairing = this.db
        .prepare("SELECT approver, approver_generation FROM telegram_pairing WHERE code_hash = ?")
        .get(attempt.codeHash) as Record<string, unknown>;

      // The code was minted under a generation; the binding is only valid
      // if that generation still stands — a rotation between mint and
      // consumption strands the code.
      const current = this.approverGeneration(String(pairing["approver"]));
      if (current === null || current !== Number(pairing["approver_generation"])) {
        return { ok: false as const, reason: "unknown-code" as const };
      }

      try {
        this.db
          .prepare(
            `INSERT INTO telegram_binding (bot_id, chat_id, user_id, approver, approver_generation, paired_at, paired_by, pair_update_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            attempt.botId,
            attempt.chatId,
            attempt.userId,
            String(pairing["approver"]),
            Number(pairing["approver_generation"]),
            stamp,
            String(pairing["approver"]),
            attempt.updateId,
          );
      } catch {
        // The partial unique index said no: a live binding already exists.
        return { ok: false as const, reason: "already-bound" as const };
      }
      // Every other outstanding code dies with this success.
      this.db.prepare("DELETE FROM telegram_pairing WHERE consumed_at IS NULL").run();

      const binding = this.liveTelegramBinding(attempt.botId);
      if (binding === null) throw new Error("the binding vanished inside its own transaction");
      return { ok: true as const, binding, replay: false };
    });
  }

  /**
   * The one live binding for a bot — and only while its approver's
   * credential generation still matches. A rotation that somehow missed the
   * sweep reads as no binding at all, which is the failure direction that
   * fails closed.
   */
  liveTelegramBinding(botId: string): TelegramBinding | null {
    const row = this.db
      .prepare(
        `SELECT telegram_binding.* FROM telegram_binding
         JOIN approver ON approver.name = telegram_binding.approver
          AND approver.generation = telegram_binding.approver_generation
         WHERE bot_id = ? AND revoked_at IS NULL`,
      )
      .get(botId);
    return row === undefined ? null : readTelegramBinding(row);
  }

  /** Revoke a bot's live binding and everything it could still do. */
  unpairTelegram(botId: string, by: string, now: Date): boolean {
    return this.transact(() => {
      const live = this.liveTelegramBinding(botId);
      if (live === null) return false;
      const stamp = now.toISOString();
      this.db
        .prepare("UPDATE telegram_binding SET revoked_at = ?, revoked_by = ? WHERE id = ?")
        .run(stamp, by, live.id);
      this.db
        .prepare("UPDATE telegram_action SET consumed_at = ? WHERE binding = ? AND consumed_at IS NULL")
        .run(stamp, live.id);
      return true;
    });
  }

  createTelegramAction(
    action: {
      token: string;
      binding: number;
      decision: number;
      optionId: string;
      phase: "choose" | "confirm" | "cancel";
      chatId: string;
      messageId?: string;
      ttlMs?: number;
    },
    now: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO telegram_action (token, binding, decision, option_id, phase, chat_id, message_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.token,
        action.binding,
        action.decision,
        action.optionId,
        action.phase,
        action.chatId,
        action.messageId ?? null,
        now.toISOString(),
        action.ttlMs === undefined ? null : new Date(now.getTime() + action.ttlMs).toISOString(),
      );
  }

  getTelegramAction(token: string): TelegramAction | null {
    const row = this.db.prepare("SELECT * FROM telegram_action WHERE token = ?").get(token);
    return row === undefined ? null : readTelegramAction(row);
  }

  /**
   * Kill every live confirm/cancel challenge on a decision. Cancel means
   * cancelled: a confirm that survived its own cancellation would be an
   * irreversible choice still armed after the person said stop.
   */
  consumeTelegramChallenges(decision: number, now: Date): void {
    this.db
      .prepare(
        `UPDATE telegram_action SET consumed_at = ?
          WHERE decision = ? AND phase IN ('confirm','cancel') AND consumed_at IS NULL`,
      )
      .run(now.toISOString(), decision);
  }

  /** Consume once. False means somebody already did, or it expired — either way, no. */
  consumeTelegramAction(token: string, now: Date): boolean {
    const stamp = now.toISOString();
    const { changes } = this.db
      .prepare(
        `UPDATE telegram_action SET consumed_at = ?
          WHERE token = ? AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(stamp, token, stamp);
    return Number(changes) > 0;
  }

  /** Stamp the message a choose-action's keyboard actually landed on. */
  placeTelegramActions(tokens: readonly string[], messageId: string): void {
    for (const token of tokens) {
      this.db
        .prepare("UPDATE telegram_action SET message_id = ? WHERE token = ?")
        .run(messageId, token);
    }
  }

  /**
   * Take or renew the bridge's poll lease. One live poller per bot: cron
   * overlapping a follower gets `bridge-busy`, an expired holder is taken
   * over at the next generation, and the cursor rides the lease so a stale
   * generation can neither poll nor move it.
   */
  acquireBridgeLease(
    botId: string,
    owner: string,
    ttlMs: number,
    now: Date,
  ):
    | { ok: true; generation: number; cursor: number }
    | { ok: false; reason: "bridge-busy"; holder: string; until: string } {
    return this.transact(() => {
      const stamp = now.toISOString();
      const expires = new Date(now.getTime() + ttlMs).toISOString();
      const row = this.db.prepare("SELECT * FROM bridge_lease WHERE bot_id = ?").get(botId);
      if (row === undefined) {
        this.db
          .prepare(
            `INSERT INTO bridge_lease (bot_id, owner, generation, cursor, expires_at, heartbeat_at)
             VALUES (?, ?, 1, 0, ?, ?)`,
          )
          .run(botId, owner, expires, stamp);
        return { ok: true as const, generation: 1, cursor: 0 };
      }
      const holder = String(row["owner"]);
      const live = String(row["expires_at"]) > stamp;
      if (live && holder !== owner) {
        return {
          ok: false as const,
          reason: "bridge-busy" as const,
          holder,
          until: String(row["expires_at"]),
        };
      }
      const generation = live && holder === owner ? Number(row["generation"]) : Number(row["generation"]) + 1;
      this.db
        .prepare(
          "UPDATE bridge_lease SET owner = ?, generation = ?, expires_at = ?, heartbeat_at = ? WHERE bot_id = ?",
        )
        .run(owner, generation, expires, stamp, botId);
      return { ok: true as const, generation, cursor: Number(row["cursor"]) };
    });
  }

  /** Hand the poll back at the end of a pass, so the next cron firing is not told busy. */
  releaseBridgeLease(botId: string, owner: string, now: Date): void {
    this.db
      .prepare("UPDATE bridge_lease SET expires_at = ? WHERE bot_id = ? AND owner = ?")
      .run(now.toISOString(), botId, owner);
  }

  // ---- publication ---------------------------------------------------------

  /** Grant publication for a repo. Replaces any live grant — one at a time, the newest word wins. */
  savePublicationGrant(
    grant: {
      repo: string;
      githubRepo: string;
      remote: string;
      headPrefix: string;
      base: string;
      capabilities: PublicationCapability[];
      selector: "ours" | "all";
      draft: boolean;
      grantedBy: string;
    },
    now: Date,
  ): void {
    this.transact(() => {
      this.db
        .prepare("UPDATE publication_grant SET revoked_at = ?, revoked_by = ? WHERE repo = ? AND revoked_at IS NULL")
        .run(now.toISOString(), grant.grantedBy, grant.repo);
      this.db
        .prepare(
          `INSERT INTO publication_grant
             (repo, github_repo, remote, head_prefix, base, capabilities, selector, draft, granted_by, granted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grant.repo,
          grant.githubRepo,
          grant.remote,
          grant.headPrefix,
          grant.base,
          JSON.stringify(grant.capabilities),
          grant.selector,
          grant.draft ? 1 : 0,
          grant.grantedBy,
          now.toISOString(),
        );
    });
  }

  /** Revocation is immediate: intents not yet pushed die with the grant. */
  revokePublicationGrant(repo: string, by: string, now: Date): boolean {
    const { changes } = this.db
      .prepare("UPDATE publication_grant SET revoked_at = ?, revoked_by = ? WHERE repo = ? AND revoked_at IS NULL")
      .run(now.toISOString(), by, repo);
    return Number(changes) > 0;
  }

  publicationGrantFor(repo: string): PublicationGrant | null {
    const row = this.db
      .prepare("SELECT * FROM publication_grant WHERE repo = ? AND revoked_at IS NULL")
      .get(repo);
    return row === undefined ? null : readPublicationGrant(row);
  }

  /**
   * The intent, written wherever completion was proved — callers run this
   * inside the fenced completion transaction, so "done" and "this must
   * reach a PR" are one write or neither.
   */
  createPublicationIntent(
    intent: {
      run: number;
      taskRef: number;
      githubRepo: string;
      remote: string;
      base: string;
      head: string;
      headSha: string;
      bodyHash: string;
      draft: boolean;
    },
    now: Date,
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO publication
           (run, task_ref, github_repo, remote, base, head, head_sha, body_hash, draft, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intended', ?, ?)`,
      )
      .run(
        intent.run,
        intent.taskRef,
        intent.githubRepo,
        intent.remote,
        intent.base,
        intent.head,
        intent.headSha,
        intent.bodyHash,
        intent.draft ? 1 : 0,
        now.toISOString(),
        now.toISOString(),
      );
    return Number(inserted.lastInsertRowid);
  }

  /** Work the publisher still owes, oldest first — crash-retryable by construction. */
  pendingPublications(): Publication[] {
    return this.db
      .prepare("SELECT * FROM publication WHERE state IN ('intended','pushed') ORDER BY id")
      .all()
      .map(readPublication);
  }

  publicationForRun(run: number): Publication | null {
    const row = this.db.prepare("SELECT * FROM publication WHERE run = ?").get(run);
    return row === undefined ? null : readPublication(row);
  }

  markPublicationPushed(id: number, now: Date): void {
    this.db
      .prepare("UPDATE publication SET state = 'pushed', updated_at = ? WHERE id = ? AND state = 'intended'")
      .run(now.toISOString(), id);
  }

  markPublicationOpened(id: number, prNumber: number, prUrl: string, now: Date): void {
    this.db
      .prepare(
        "UPDATE publication SET state = 'opened', pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ? AND state = 'pushed'",
      )
      .run(prNumber, prUrl, now.toISOString(), id);
  }

  /** One more failed attempt, error kept. Returns the new count; the caller decides when enough is enough. */
  recordPublicationError(id: number, error: string, now: Date): number {
    this.db
      .prepare("UPDATE publication SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?")
      .run(error.slice(0, 2_000), now.toISOString(), id);
    const row = this.db.prepare("SELECT attempts FROM publication WHERE id = ?").get(id);
    return Number(row?.["attempts"] ?? 0);
  }

  failPublication(id: number, now: Date): void {
    this.db
      .prepare("UPDATE publication SET state = 'failed', updated_at = ? WHERE id = ? AND state IN ('intended','pushed')")
      .run(now.toISOString(), id);
  }

  /** PRs this control plane opened and should keep watching. */
  openedPublications(): Publication[] {
    return this.db
      .prepare("SELECT * FROM publication WHERE state = 'opened' ORDER BY id")
      .all()
      .map(readPublication);
  }

  /**
   * Resolve CI episodes for a PR whose failing head is gone — a new commit
   * superseded it, or the same head turned green. Episodes are keyed
   * `ci:<pr>:<headOid>`; only the surviving key (if any) stays open.
   */
  resolveCiEpisodes(prNumber: number, exceptKey: string | null, now: Date): number {
    const { changes } = this.db
      .prepare(
        `UPDATE notification SET resolved_at = ?
          WHERE dedupe_key LIKE ? AND resolved_at IS NULL AND dedupe_key != COALESCE(?, '')`,
      )
      .run(now.toISOString(), `ci:${prNumber}:%`, exceptKey);
    return Number(changes);
  }

  // ---- projects ------------------------------------------------------------

  /** Remember a project was opened. Upsert keeps added_at; recency always moves. */
  upsertProject(path: string, name: string, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO project (path, name, added_at, last_opened_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET name = excluded.name, last_opened_at = excluded.last_opened_at`,
      )
      .run(path, name, now.toISOString(), now.toISOString());
  }

  /** Most recently opened first — the opener page's order. */
  listProjects(): { path: string; name: string; addedAt: string; lastOpenedAt: string }[] {
    return this.db
      .prepare("SELECT * FROM project ORDER BY last_opened_at DESC")
      .all()
      .map(row => ({
        path: String(row["path"]),
        name: String(row["name"]),
        addedAt: String(row["added_at"]),
        lastOpenedAt: String(row["last_opened_at"]),
      }));
  }

  /** Every repo the queue has ever seen — candidates for the opener, never authorization. */
  knownRepos(): string[] {
    return this.db
      .prepare(
        `SELECT DISTINCT repo AS path FROM task_ref WHERE repo IS NOT NULL
         UNION SELECT DISTINCT repo FROM capability
         UNION SELECT DISTINCT repo FROM publication_grant`,
      )
      .all()
      .map(row => String(row["path"]));
  }

  // ---- the watch episode ---------------------------------------------------

  /** The night begins: one row per watch, keyed by its incarnation. */
  startWatchEpisode(episode: { repo: string; runner: string; incarnation: string }, now: Date): number {
    const inserted = this.db
      .prepare(
        "INSERT INTO watch_episode (repo, runner, incarnation, started_at) VALUES (?, ?, ?, ?)",
      )
      .run(episode.repo, episode.runner, episode.incarnation, now.toISOString());
    return Number(inserted.lastInsertRowid);
  }

  /** The night ends, with its own numbers. A crash never writes this — and that absence is data. */
  endWatchEpisode(
    incarnation: string,
    totals: { ticks: number; built: number; broke: number },
    now: Date,
  ): void {
    this.db
      .prepare(
        "UPDATE watch_episode SET ended_at = ?, ticks = ?, built = ?, broke = ? WHERE incarnation = ?",
      )
      .run(now.toISOString(), totals.ticks, totals.built, totals.broke, incarnation);
  }

  latestWatchEpisode(repo: string): {
    id: number;
    repo: string;
    runner: string;
    incarnation: string;
    startedAt: string;
    endedAt: string | null;
    ticks: number;
    built: number;
    broke: number;
  } | null {
    const row = this.db
      .prepare("SELECT * FROM watch_episode WHERE repo = ? ORDER BY id DESC LIMIT 1")
      .get(repo);
    if (row === undefined) return null;
    return {
      id: Number(row["id"]),
      repo: String(row["repo"]),
      runner: String(row["runner"]),
      incarnation: String(row["incarnation"]),
      startedAt: String(row["started_at"]),
      endedAt: row["ended_at"] === null ? null : String(row["ended_at"]),
      ticks: Number(row["ticks"]),
      built: Number(row["built"]),
      broke: Number(row["broke"]),
    };
  }

  // ---- the wake sequence ---------------------------------------------------

  /** Something changed that could make work dispatchable. Cheap, and safe anywhere. */
  bumpWake(): void {
    this.db.prepare("UPDATE wake SET seq = seq + 1 WHERE id = 1").run();
  }

  wakeSeq(): number {
    const row = this.db.prepare("SELECT seq FROM wake WHERE id = 1").get();
    return Number(row?.["seq"] ?? 0);
  }

  // ---- the watch lease -----------------------------------------------------

  /**
   * One watch per (runner, repo). Same shape as the bridge's poll lease:
   * takeover on expiry bumps the generation, and the superseded owner's
   * name comes back so its claims can be recovered before anything new
   * dispatches. `watch + cron tick` deliberately does NOT contend here —
   * ordinary claims make that race safe; only watch+watch is an error.
   */
  acquireWatchLease(
    runner: string,
    repo: string,
    owner: string,
    ttlMs: number,
    now: Date,
  ):
    | { ok: true; generation: number; superseded: string | null }
    | { ok: false; reason: "watch-busy"; holder: string; until: string } {
    return this.transact(() => {
      const stamp = now.toISOString();
      const expires = new Date(now.getTime() + ttlMs).toISOString();
      const row = this.db
        .prepare("SELECT * FROM watch_lease WHERE runner = ? AND repo = ?")
        .get(runner, repo);
      if (row === undefined) {
        this.db
          .prepare(
            `INSERT INTO watch_lease (runner, repo, owner, generation, started_at, expires_at, heartbeat_at)
             VALUES (?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(runner, repo, owner, stamp, expires, stamp);
        return { ok: true as const, generation: 1, superseded: null };
      }
      const holder = String(row["owner"]);
      const live = String(row["expires_at"]) > stamp;
      if (live && holder !== owner) {
        return {
          ok: false as const,
          reason: "watch-busy" as const,
          holder,
          until: String(row["expires_at"]),
        };
      }
      const generation = live && holder === owner ? Number(row["generation"]) : Number(row["generation"]) + 1;
      this.db
        .prepare(
          `UPDATE watch_lease SET owner = ?, generation = ?, expires_at = ?, heartbeat_at = ?
            WHERE runner = ? AND repo = ?`,
        )
        .run(owner, generation, expires, stamp, runner, repo);
      return {
        ok: true as const,
        generation,
        superseded: holder === owner ? null : holder,
      };
    });
  }

  heartbeatWatchLease(runner: string, repo: string, owner: string, ttlMs: number, now: Date): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE watch_lease SET expires_at = ?, heartbeat_at = ?
          WHERE runner = ? AND repo = ? AND owner = ? AND expires_at > ?`,
      )
      .run(
        new Date(now.getTime() + ttlMs).toISOString(),
        now.toISOString(),
        runner,
        repo,
        owner,
        now.toISOString(),
      );
    return Number(changes) > 0;
  }

  releaseWatchLease(runner: string, repo: string, owner: string, now: Date): void {
    this.db
      .prepare("UPDATE watch_lease SET expires_at = ? WHERE runner = ? AND repo = ? AND owner = ?")
      .run(now.toISOString(), runner, repo, owner);
  }

  /**
   * Recover everything a dead incarnation still holds, atomically, before
   * its successor dispatches anything: its live claims released as
   * 'recovered', their running tasks requeued, their open runs finished as
   * interrupted, their worktrees released unverified. Keyed to the
   * incarnation, never to runner liveness — the successor IS the runner,
   * alive and heartbeating, which is exactly how the crash would otherwise
   * hide.
   */
  recoverIncarnation(runner: string, incarnation: string, now: Date): number {
    return this.transact(() => {
      const stamp = now.toISOString();
      const claims = this.db
        .prepare(
          `SELECT lease_id, task_ref FROM claim
            WHERE runner = ? AND incarnation = ? AND released_at IS NULL
              AND lease_generation = (
                SELECT MAX(newest.lease_generation) FROM claim AS newest
                WHERE newest.task_ref = claim.task_ref
              )`,
        )
        .all(runner, incarnation);

      for (const row of claims) {
        const leaseId = String(row["lease_id"]);
        const taskRef = Number(row["task_ref"]);
        this.db
          .prepare("UPDATE claim SET released_at = ?, released_by = 'recovered' WHERE lease_id = ?")
          .run(stamp, leaseId);
        this.db
          .prepare(
            `UPDATE task SET state = 'queued', updated_at = ?
              WHERE state = 'running' AND id = (
                SELECT external_id FROM task_ref WHERE id = ? AND backend = ?
              )`,
          )
          .run(stamp, taskRef, BUILT_IN);
        this.db
          .prepare(
            `UPDATE run SET outcome = 'failed', reason = 'interrupted', finished_at = ?
              WHERE lease_id = ? AND outcome IS NULL`,
          )
          .run(stamp, leaseId);
        this.db
          .prepare(
            `UPDATE worktree SET released_at = ?, verified = 0
              WHERE runner = ? AND task_ref = ? AND released_at IS NULL`,
          )
          .run(stamp, runner, taskRef);
      }
      if (claims.length > 0) this.bumpWake();
      return claims.length;
    });
  }

  // ---- quota ---------------------------------------------------------------

  /** Record that a credential ran dry — from a structured signal or an operator, never prose. */
  stampQuota(
    quota: { runner: string; provider: string; scope?: string; reason: string; resetAt?: Date },
    now: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO quota (runner, provider, scope, state, reason, observed_at, reset_at)
         VALUES (?, ?, ?, 'exhausted', ?, ?, ?)
         ON CONFLICT (runner, provider, scope) DO UPDATE SET
           state = 'exhausted', reason = excluded.reason,
           observed_at = excluded.observed_at, reset_at = excluded.reset_at`,
      )
      .run(
        quota.runner,
        quota.provider,
        quota.scope ?? "",
        quota.reason,
        now.toISOString(),
        quota.resetAt === undefined ? null : quota.resetAt.toISOString(),
      );
  }

  /**
   * The quota gate's answer, with the lazy exhausted→half-open transition at
   * the known reset. Null means no recorded constraint.
   */
  quotaState(
    runner: string,
    provider: string,
    scope: string,
    now: Date,
  ): { state: "exhausted" | "half-open"; reason: string; resetAt: string | null } | null {
    const stamp = now.toISOString();
    this.db
      .prepare(
        `UPDATE quota SET state = 'half-open'
          WHERE runner = ? AND provider = ? AND scope = ? AND state = 'exhausted'
            AND reset_at IS NOT NULL AND reset_at <= ?`,
      )
      .run(runner, provider, scope, stamp);
    const row = this.db
      .prepare("SELECT state, reason, reset_at FROM quota WHERE runner = ? AND provider = ? AND scope = ?")
      .get(runner, provider, scope);
    if (row === undefined) return null;
    return {
      state: String(row["state"]) as "exhausted" | "half-open",
      reason: String(row["reason"]),
      resetAt: row["reset_at"] === null ? null : String(row["reset_at"]),
    };
  }

  /**
   * Take the half-open slot: exactly one dispatch probes a recovered quota.
   * The conditional update is what makes it exactly one — and it re-arms
   * the exhausted state for a short window so racing passes stay refused
   * while the probe flies. The probe's success clears the row; the same
   * structured signal that stamped it re-stamps on failure.
   */
  consumeHalfOpen(runner: string, provider: string, scope: string, now: Date): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE quota SET state = 'exhausted', reset_at = ?
          WHERE runner = ? AND provider = ? AND scope = ? AND state = 'half-open'`,
      )
      .run(new Date(now.getTime() + 5 * 60_000).toISOString(), runner, provider, scope);
    return Number(changes) > 0;
  }

  /** A structured all-clear (or an operator's), by name. */
  clearQuota(runner: string, provider: string, scope: string): boolean {
    const { changes } = this.db
      .prepare("DELETE FROM quota WHERE runner = ? AND provider = ? AND scope = ?")
      .run(runner, provider, scope);
    return Number(changes) > 0;
  }

  /** Live claims this runner holds right now — the occupied slots of §8's capacity gate. */
  liveClaimCount(runner: string, now: Date): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM claim
          WHERE runner = ? AND released_at IS NULL AND expires_at > ?
            AND lease_generation = (
              SELECT MAX(newest.lease_generation) FROM claim AS newest
              WHERE newest.task_ref = claim.task_ref
            )`,
      )
      .get(runner, now.toISOString());
    return Number(row?.["n"] ?? 0);
  }

  /** Forward only, and only under the live generation. A stale poller moves nothing. */
  advanceBridgeCursor(
    botId: string,
    owner: string,
    generation: number,
    cursor: number,
    now: Date,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE bridge_lease SET cursor = ?, heartbeat_at = ?
          WHERE bot_id = ? AND owner = ? AND generation = ? AND cursor < ?`,
      )
      .run(cursor, now.toISOString(), botId, owner, generation, cursor);
    return Number(changes) > 0;
  }

  /** True if this update has not been applied before. The PRIMARY KEY is the idempotency. */
  markTelegramUpdateApplied(updateId: number, result: string, now: Date): boolean {
    const { changes } = this.db
      .prepare(
        "INSERT OR IGNORE INTO telegram_update (update_id, applied_at, result) VALUES (?, ?, ?)",
      )
      .run(updateId, now.toISOString(), result);
    return Number(changes) > 0;
  }

  // ---- delivery claiming ---------------------------------------------------

  /**
   * Claim pending notifications for one deliverer. Two deliverers — the
   * bridge and `outbox deliver` — select-then-send-then-record, and without
   * a claim both can send the same row in the gap. The claim is a short
   * lease on the act of sending; a deliverer that dies mid-send leaves rows
   * that unclaim themselves by expiry.
   */
  claimDeliveries(owner: string, ttlMs: number, now: Date): Notification[] {
    return this.transact(() => {
      const stamp = now.toISOString();
      const rows = this.db
        .prepare(
          `SELECT id FROM notification
            WHERE delivered_at IS NULL AND resolved_at IS NULL
              AND (claim_owner IS NULL OR claim_expires_at <= ?)
            ORDER BY id`,
        )
        .all(stamp)
        .map(row => Number(row["id"]));
      const expires = new Date(now.getTime() + ttlMs).toISOString();
      for (const id of rows) {
        this.db
          .prepare("UPDATE notification SET claim_owner = ?, claim_expires_at = ? WHERE id = ?")
          .run(owner, expires, id);
      }
      return rows
        .map(id => this.db.prepare("SELECT * FROM notification WHERE id = ?").get(id))
        .filter((row): row is Record<string, unknown> => row !== undefined)
        .map(readNotification);
    });
  }

  /** Finalize only what this owner still holds. A lapsed claim writes nothing. */
  finalizeDelivery(
    id: number,
    owner: string,
    outcome: { ok: true; receipt: string | null } | { ok: false; error: string },
    now: Date,
  ): boolean {
    const stamp = now.toISOString();
    if (outcome.ok) {
      const { changes } = this.db
        .prepare(
          `UPDATE notification SET delivered_at = ?, receipt = ?, attempts = attempts + 1,
                                   last_attempt_at = ?, last_error = NULL,
                                   claim_owner = NULL, claim_expires_at = NULL
            WHERE id = ? AND claim_owner = ? AND delivered_at IS NULL`,
        )
        .run(stamp, outcome.receipt, stamp, id, owner);
      return Number(changes) > 0;
    }
    const { changes } = this.db
      .prepare(
        `UPDATE notification SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?,
                                 claim_owner = NULL, claim_expires_at = NULL
          WHERE id = ? AND claim_owner = ?`,
      )
      .run(stamp, outcome.error, id, owner);
    return Number(changes) > 0;
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

function readRun(row: Record<string, unknown>): Run {
  return {
    id: Number(row["id"]),
    taskRef: Number(row["task_ref"]),
    leaseId: String(row["lease_id"]),
    runner: String(row["runner"]),
    role: String(row["role"] ?? "builder") as Run["role"],
    parentRun: row["parent_run"] === null || row["parent_run"] === undefined ? null : Number(row["parent_run"]),
    sessionId: row["session_id"] === null || row["session_id"] === undefined ? null : String(row["session_id"]),
    baseRevision:
      row["base_revision"] === null || row["base_revision"] === undefined
        ? null
        : String(row["base_revision"]),
    branch: String(row["branch"]),
    worktree: String(row["worktree"]),
    model: row["model"] === null ? null : String(row["model"]),
    outcome: row["outcome"] === null ? null : (String(row["outcome"]) as Run["outcome"]),
    reason: row["reason"] === null ? null : String(row["reason"]),
    committed: row["committed"] === null ? null : Number(row["committed"]) === 1,
    startedAt: String(row["started_at"]),
    finishedAt: row["finished_at"] === null ? null : String(row["finished_at"]),
    providerStartedAt:
      row["provider_started_at"] === null || row["provider_started_at"] === undefined
        ? null
        : String(row["provider_started_at"]),
    tokensIn: row["tokens_in"] === null || row["tokens_in"] === undefined ? null : Number(row["tokens_in"]),
    tokensOut: row["tokens_out"] === null || row["tokens_out"] === undefined ? null : Number(row["tokens_out"]),
    costUsd: row["cost_usd"] === null || row["cost_usd"] === undefined ? null : Number(row["cost_usd"]),
    headRevision:
      row["head_revision"] === null || row["head_revision"] === undefined
        ? null
        : String(row["head_revision"]),
    handoff: row["handoff"] === null || row["handoff"] === undefined ? null : String(row["handoff"]),
  };
}

function readHold(row: Record<string, unknown>): Hold {
  return {
    id: Number(row["id"]),
    taskRef: Number(row["task_ref"]),
    ownerKind: String(row["owner_kind"]) as HoldOwner,
    ownerId: String(row["owner_id"]),
    reason: String(row["reason"]),
    until: row["until"] === null ? null : String(row["until"]),
    heldAt: String(row["held_at"]),
  };
}

function readNotification(row: Record<string, unknown>): Notification {
  return {
    id: Number(row["id"]),
    dedupeKey: String(row["dedupe_key"]),
    kind: String(row["kind"]),
    subject: String(row["subject"]),
    body: String(row["body"]),
    createdAt: String(row["created_at"]),
    attempts: Number(row["attempts"]),
    lastAttemptAt: row["last_attempt_at"] === null ? null : String(row["last_attempt_at"]),
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    deliveredAt: row["delivered_at"] === null ? null : String(row["delivered_at"]),
    receipt: row["receipt"] === null ? null : String(row["receipt"]),
    resolvedAt:
      row["resolved_at"] === null || row["resolved_at"] === undefined
        ? null
        : String(row["resolved_at"]),
  };
}

function readDecision(row: Record<string, unknown>): Decision {
  return {
    id: Number(row["id"]),
    run: Number(row["run"]),
    urgency: String(row["urgency"]) as Decision["urgency"],
    state: String(row["state"]) as Decision["state"],
    recap: String(row["recap"]),
    question: String(row["question"]),
    options: JSON.parse(String(row["options"])) as DecisionOption[],
    recommendation: String(row["recommendation"]),
    assignee: row["assignee"] === null ? null : String(row["assignee"]),
    deadline: row["deadline"] === null ? null : String(row["deadline"]),
    createdAt: String(row["created_at"]),
    answeredAt: row["answered_at"] === null ? null : String(row["answered_at"]),
    answeredBy: row["answered_by"] === null ? null : String(row["answered_by"]),
    answeredVia:
      row["answered_via"] === null ? null : (String(row["answered_via"]) as Decision["answeredVia"]),
    choice: row["choice"] === null ? null : String(row["choice"]),
    note: row["note"] === null ? null : String(row["note"]),
  };
}

function readArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: Number(row["id"]),
    run: Number(row["run"]),
    kind: String(row["kind"]) as Artifact["kind"],
    key: String(row["key"]),
    bytesOriginal: Number(row["bytes_original"]),
    bytesStored: Number(row["bytes_stored"]),
    truncated: Number(row["truncated"]) === 1,
    sha256: String(row["sha256"]),
    capture: String(row["capture"]),
    createdAt: String(row["created_at"]),
    redacted: Number(row["redacted"]) === 1,
  };
}

function readTelegramBinding(row: Record<string, unknown>): TelegramBinding {
  return {
    id: Number(row["id"]),
    botId: String(row["bot_id"]),
    chatId: String(row["chat_id"]),
    userId: String(row["user_id"]),
    approver: String(row["approver"]),
    approverGeneration: Number(row["approver_generation"]),
    pairedAt: String(row["paired_at"]),
    pairedBy: String(row["paired_by"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
    revokedBy: row["revoked_by"] === null ? null : String(row["revoked_by"]),
  };
}

function readTelegramAction(row: Record<string, unknown>): TelegramAction {
  return {
    token: String(row["token"]),
    binding: Number(row["binding"]),
    decision: Number(row["decision"]),
    optionId: String(row["option_id"]),
    phase: String(row["phase"]) as TelegramAction["phase"],
    chatId: String(row["chat_id"]),
    messageId: row["message_id"] === null ? null : String(row["message_id"]),
    createdAt: String(row["created_at"]),
    expiresAt: row["expires_at"] === null ? null : String(row["expires_at"]),
    consumedAt: row["consumed_at"] === null ? null : String(row["consumed_at"]),
  };
}

function readIncident(row: Record<string, unknown>): Incident {
  return {
    id: Number(row["id"]),
    run: Number(row["run"]),
    kind: String(row["kind"]) as Incident["kind"],
    createdAt: String(row["created_at"]),
    resolvedAt: row["resolved_at"] === null ? null : String(row["resolved_at"]),
    resolvedBy: row["resolved_by"] === null ? null : String(row["resolved_by"]),
  };
}

function readPublicationGrant(row: Record<string, unknown>): PublicationGrant {
  return {
    id: Number(row["id"]),
    repo: String(row["repo"]),
    githubRepo: String(row["github_repo"]),
    remote: String(row["remote"]),
    headPrefix: String(row["head_prefix"]),
    base: String(row["base"]),
    capabilities: JSON.parse(String(row["capabilities"])) as PublicationCapability[],
    selector: String(row["selector"]) as "ours" | "all",
    draft: Number(row["draft"]) === 1,
    grantedBy: String(row["granted_by"]),
    grantedAt: String(row["granted_at"]),
    revokedBy: row["revoked_by"] === null ? null : String(row["revoked_by"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
  };
}

function readPublication(row: Record<string, unknown>): Publication {
  return {
    id: Number(row["id"]),
    run: Number(row["run"]),
    taskRef: Number(row["task_ref"]),
    githubRepo: String(row["github_repo"]),
    remote: String(row["remote"]),
    base: String(row["base"]),
    head: String(row["head"]),
    headSha: String(row["head_sha"]),
    bodyHash: String(row["body_hash"]),
    draft: Number(row["draft"]) === 1,
    state: String(row["state"]) as Publication["state"],
    prNumber: row["pr_number"] === null ? null : Number(row["pr_number"]),
    prUrl: row["pr_url"] === null ? null : String(row["pr_url"]),
    attempts: Number(row["attempts"]),
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
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
    strikes: Number(row["strikes"] ?? 0),
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
