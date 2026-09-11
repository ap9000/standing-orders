-- AUTHENTIC schema v47 database, derived by scripts/derive-v47-fixture.mjs from
-- commit 1d0fc9002048333c43b19b9284867bd053050232 (the v47 build's own store, scope, and routine code).
-- Regenerate with `node scripts/derive-v47-fixture.mjs`; never edit by hand.
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE schema_version (
  version INTEGER NOT NULL
);
INSERT INTO "schema_version" ("version") VALUES (47);
CREATE TABLE task (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "task" ("id", "title", "state", "created_at", "updated_at", "priority") VALUES ('t-routed', 't-routed', 'queued', '2026-09-11T02:00:00.000Z', '2026-09-11T02:00:00.000Z', 0);
INSERT INTO "task" ("id", "title", "state", "created_at", "updated_at", "priority") VALUES ('t-pending', 't-pending', 'queued', '2026-09-11T02:00:00.000Z', '2026-09-11T02:00:00.000Z', 0);
INSERT INTO "task" ("id", "title", "state", "created_at", "updated_at", "priority") VALUES ('t-legacy', 't-legacy', 'queued', '2026-09-11T02:00:00.000Z', '2026-09-11T02:00:00.000Z', 0);
INSERT INTO "task" ("id", "title", "state", "created_at", "updated_at", "priority") VALUES ('t-chain', 't-chain', 'queued', '2026-09-11T02:00:00.000Z', '2026-09-11T02:00:00.000Z', 0);
CREATE TABLE queue_state (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "queue_state" ("id", "revision") VALUES (1, 0);
CREATE TABLE task_edge (
  blocked TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  blocker TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY (blocked, blocker),
  CHECK (blocked <> blocker)
);
CREATE TABLE task_ref (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  backend                 TEXT NOT NULL,
  external_id             TEXT NOT NULL,
  -- Which repository the work belongs to, when that is known. Capabilities
  -- are repo-scoped, so a gap can only count the tasks it blocks if tasks
  -- say where they live. NULL is honest for a task nobody has placed yet —
  -- it dispatches anywhere, and no gap claims it.
  repo                    TEXT,
  -- The worker this task is reserved for (v19); NULL = any free worker.
  assigned_runner         TEXT,
  zones                   TEXT NOT NULL DEFAULT '[]',
  capability_requirements TEXT NOT NULL DEFAULT '[]',
  park_rate               REAL NOT NULL DEFAULT 0,
  origin                  TEXT NOT NULL DEFAULT 'theirs',
  -- Planning mode (v7): 'requested' dispatches a planner before any scope
  -- is approved; 'drafted' means a proposed scope + plan document await the
  -- operator. NULL is the ordinary task that never asked for a plan.
  plan                    TEXT CHECK (plan IN ('requested','drafted')),
  -- Planning failures count separately from build strikes: a planner that
  -- cannot finish must never spend the builder's three attempts.
  plan_strikes            INTEGER NOT NULL DEFAULT 0,
  -- The standing order this task is an instance of, when it is one (v8).
  -- Ordinary one-off work carries NULL; the board uses this to keep
  -- instances in their track row instead of the main lanes.
  routine_id              INTEGER REFERENCES routine(id),
  -- The pinned agent (v9): which provider/model this task's builds run on,
  -- stamped by the routine fire transaction (digest-authoritative) — a
  -- runtime flag never overrides a pin. NULL = resolve from config.
  agent_provider          TEXT,
  agent_model             TEXT,
  -- Per-task unattended permission override (v37). NULL inherits the
  -- installation default when a scope is next filed; approvals bind the
  -- resulting concrete profile, never this mutable preference.
  permission_mode         TEXT CHECK (permission_mode IN ('auto','bypassPermissions')),
  -- Per-task quality override (v41). NULL inherits the installation
  -- default when the next scope is filed; the scope stores the concrete
  -- signed choice.
  quality_mode            TEXT CHECK (quality_mode IN ('default','strict')),
  -- Per-task declared risk (v47, phase routing). NULL reads as routine
  -- when the next scope is filed; the scope stores the signed level.
  risk_level              TEXT CHECK (risk_level IN ('routine','elevated','high')),
  -- An approver's explicit per-phase route overrides (v47): a JSON list of
  -- {phase, provider, model, by, at}, at most one per phase. Read when the
  -- next scope is filed; the sealed route records what applied.
  route_overrides_json    TEXT,
  -- A revision task (M6.8): which task's reviewed run it revises, and the
  -- immutable brief artifact carrying the exact comment batch. Every
  -- revision requires its own approval; nothing is inherited.
  revision_of             TEXT,
  revision_brief_artifact INTEGER REFERENCES artifact(id),
  -- Immutable provenance (v12): which door filed this work — 'cli',
  -- 'console', 'intake', 'template:<name>', 'revision'. Stamped once at
  -- filing, never updated; NULL is history from before the column existed.
  filed_via               TEXT,
  -- The coordinator that filed this task (v31, MCP gateway): the
  -- AUTHORITATIVE linkage — written only by the branded coordinator door,
  -- joined by exact cid, never parsed out of filed_via (which stays
  -- display-only). NULL is every other filer.
  coordinator_cid         TEXT REFERENCES coordinator_credential(cid),
  -- The deliverable (v34, scout tasks): 'branch' is every task until now;
  -- 'report' dispatches a scout — a read-only session whose whole output
  -- is one report artifact. Stamped at filing, never rewritten.
  deliverable             TEXT NOT NULL DEFAULT 'branch' CHECK (deliverable IN ('branch','report')), strikes INTEGER NOT NULL DEFAULT 0, plan_provider TEXT, plan_model TEXT,
  UNIQUE (backend, external_id)
);
INSERT INTO "task_ref" ("id", "backend", "external_id", "repo", "assigned_runner", "zones", "capability_requirements", "park_rate", "origin", "plan", "plan_strikes", "routine_id", "agent_provider", "agent_model", "permission_mode", "quality_mode", "risk_level", "route_overrides_json", "revision_of", "revision_brief_artifact", "filed_via", "coordinator_cid", "deliverable", "strikes", "plan_provider", "plan_model") VALUES (1, 'built-in', 't-routed', '/repo/app', NULL, '[]', '[]', 0, 'ours', NULL, 0, NULL, NULL, NULL, NULL, NULL, 'elevated', NULL, NULL, NULL, NULL, NULL, 'branch', 0, NULL, NULL);
INSERT INTO "task_ref" ("id", "backend", "external_id", "repo", "assigned_runner", "zones", "capability_requirements", "park_rate", "origin", "plan", "plan_strikes", "routine_id", "agent_provider", "agent_model", "permission_mode", "quality_mode", "risk_level", "route_overrides_json", "revision_of", "revision_brief_artifact", "filed_via", "coordinator_cid", "deliverable", "strikes", "plan_provider", "plan_model") VALUES (2, 'built-in', 't-pending', '/repo/app', NULL, '[]', '[]', 0, 'ours', NULL, 0, NULL, NULL, NULL, NULL, NULL, 'routine', NULL, NULL, NULL, NULL, NULL, 'branch', 0, NULL, NULL);
INSERT INTO "task_ref" ("id", "backend", "external_id", "repo", "assigned_runner", "zones", "capability_requirements", "park_rate", "origin", "plan", "plan_strikes", "routine_id", "agent_provider", "agent_model", "permission_mode", "quality_mode", "risk_level", "route_overrides_json", "revision_of", "revision_brief_artifact", "filed_via", "coordinator_cid", "deliverable", "strikes", "plan_provider", "plan_model") VALUES (3, 'built-in', 't-legacy', '/repo/app', NULL, '[]', '[]', 0, 'ours', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'branch', 0, NULL, NULL);
INSERT INTO "task_ref" ("id", "backend", "external_id", "repo", "assigned_runner", "zones", "capability_requirements", "park_rate", "origin", "plan", "plan_strikes", "routine_id", "agent_provider", "agent_model", "permission_mode", "quality_mode", "risk_level", "route_overrides_json", "revision_of", "revision_brief_artifact", "filed_via", "coordinator_cid", "deliverable", "strikes", "plan_provider", "plan_model") VALUES (4, 'built-in', 't-chain', '/repo/app', NULL, '[]', '[]', 0, 'ours', NULL, 0, NULL, NULL, NULL, NULL, NULL, 'routine', NULL, NULL, NULL, NULL, NULL, 'branch', 0, NULL, NULL);
CREATE TABLE coordinator_credential (
  cid             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  repos           TEXT NOT NULL,
  per_hour        INTEGER NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
);
CREATE TABLE coordinator_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cid        TEXT NOT NULL REFERENCES coordinator_credential(cid),
  kind       TEXT NOT NULL CHECK (kind IN ('filed','dismissed','revoked')),
  task_id    TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE mcp_idempotency (
  cid            TEXT NOT NULL REFERENCES coordinator_credential(cid),
  key            TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (cid, key)
);
CREATE TABLE phase_config (
  scope      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('plan','build','repair','review')),
  provider   TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')),
  model      TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
);
INSERT INTO "phase_config" ("scope", "phase", "provider", "model", "updated_at", "updated_by") VALUES ('installation', 'plan', 'claude', 'sonnet', '2026-09-11T02:00:00.000Z', 'alex');
INSERT INTO "phase_config" ("scope", "phase", "provider", "model", "updated_at", "updated_by") VALUES ('installation', 'build', 'claude', 'sonnet', '2026-09-11T02:00:00.000Z', 'alex');
INSERT INTO "phase_config" ("scope", "phase", "provider", "model", "updated_at", "updated_by") VALUES ('installation', 'review', 'claude', 'opus', '2026-09-11T02:00:00.000Z', 'alex');
CREATE TABLE fallback_config (
  scope       TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('build')),
  entries_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
);
INSERT INTO "fallback_config" ("scope", "phase", "entries_json", "updated_at", "updated_by") VALUES ('/repo/app', 'build', '[{"provider":"codex","model":"gpt-5-codex","authMode":"subscription"}]', '2026-09-11T02:00:00.000Z', 'alex');
CREATE TABLE phase_tier_config (
  scope      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('plan','build','repair','review')),
  tier       TEXT NOT NULL CHECK (tier IN ('strong')),
  provider   TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')),
  model      TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, phase, tier)
);
CREATE TABLE provider_readiness (
  runner      TEXT NOT NULL REFERENCES runner(name) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')),
  state       TEXT NOT NULL CHECK (state IN ('ready','unavailable','unknown')),
  reason      TEXT NOT NULL,
  probe       TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (runner, provider)
);
CREATE TABLE run_route (
  run          INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  route_digest TEXT NOT NULL,
  phase        TEXT NOT NULL CHECK (phase IN ('plan','build','repair','review')),
  provider     TEXT NOT NULL,
  model        TEXT,
  chosen       TEXT NOT NULL CHECK (chosen IN ('recommended','override','pinned','legacy','fallback')),
  stamped_at   TEXT NOT NULL
);
INSERT INTO "run_route" ("run", "route_digest", "phase", "provider", "model", "chosen", "stamped_at") VALUES (1, '1dd7dc965a38cc657258aa4ea20765c3', 'build', 'claude', 'sonnet', 'recommended', '2026-09-11T02:00:00.000Z');
CREATE TABLE routine (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  repo             TEXT NOT NULL,
  goal             TEXT NOT NULL,
  out_of_scope     TEXT,
  touches          TEXT NOT NULL DEFAULT '[]',
  requirements     TEXT NOT NULL DEFAULT '[]',
  -- 'every:<minutes>' or 'daily:<HH:MM>' (UTC). Parsed, never guessed at.
  schedule         TEXT NOT NULL,
  single_flight    INTEGER NOT NULL DEFAULT 1,
  -- Rolling 7-day ceiling in dollars. NULL is honestly "no ceiling";
  -- enforcement FAILS CLOSED on unmeasured paid runs (finding 5).
  cost_ceiling_usd REAL,
  -- Per-INSTANCE dollar cap (v16): copied into each instance's scope as
  -- its digest-bound budget term, enforced by the same native-cap
  -- plumbing as any scope budget. NULL = only the global backstop.
  budget_per_run_microusd INTEGER,
  paused           INTEGER NOT NULL DEFAULT 0,
  digest           TEXT NOT NULL,
  approved_at      TEXT,
  approved_by      TEXT,
  approved_digest  TEXT,
  -- v24: the routine's execution profile; firings stamp instances FROM
  -- the APPROVED snapshot, never from fresh resolution.
  profile_json          TEXT,
  approved_profile_json TEXT,
  digest_version        INTEGER NOT NULL DEFAULT 1,
  profile_provenance    TEXT,
  -- The next scheduled occurrence. NULL until approved; advanced by the
  -- fire transaction and nothing else, aligned to cadence (finding 10).
  next_fire_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- Immutable provenance (v12), same contract as task_ref.filed_via.
  filed_via        TEXT,
  -- v39: the signed rubric every instance's scope copies forward. A
  -- routine is validated mandatory-non-empty at creation/edit time
  -- (validateRoutineTerms) -- by the time a firing reads this column it
  -- is guaranteed present, so fireRoutine never re-checks it.
  acceptance_json  TEXT
);
INSERT INTO "routine" ("id", "name", "repo", "goal", "out_of_scope", "touches", "requirements", "schedule", "single_flight", "cost_ceiling_usd", "budget_per_run_microusd", "paused", "digest", "approved_at", "approved_by", "approved_digest", "profile_json", "approved_profile_json", "digest_version", "profile_provenance", "next_fire_at", "created_at", "updated_at", "filed_via", "acceptance_json") VALUES (1, 'nightly-deps', '/repo/app', 'refresh the lockfile', NULL, '["package-lock.json"]', '[]', 'every:60', 1, NULL, NULL, 0, '3e8204133dfa9b42cef04eba98a8848a', '2026-09-11T02:00:00.000Z', 'alex', '3e8204133dfa9b42cef04eba98a8848a', '{"digestVersion":2,"profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}}', '{"digestVersion":2,"profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}}', 2, NULL, '2026-09-11T03:00:00.000Z', '2026-09-11T02:00:00.000Z', '2026-09-11T02:00:00.000Z', 'cli', '[{"id":"c1","statement":"it ships","how":null,"evidence":["check"]}]');
CREATE TABLE installation_fact (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tournament_terms (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref                  INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  generation                INTEGER NOT NULL,
  active                    INTEGER NOT NULL DEFAULT 1,
  -- v27: 'race' = dollar-capped tournament (money contract required);
  -- 'comparison' = labeled cross-runtime comparison (no dollar terms
  -- exist; each lane's sealed clock is its bound). The money CHECK is
  -- kind-aware: races keep their positive budgets, comparisons pin 0.
  kind                      TEXT NOT NULL DEFAULT 'race' CHECK (kind IN ('race','comparison')),
  race_digest               TEXT NOT NULL,
  -- The ordered agents, JSON: [{provider, model, repairModel}] — exact
  -- model ids, resolved at filing, priced at price_version.
  agents                    TEXT NOT NULL,
  n                         INTEGER NOT NULL CHECK (n BETWEEN 2 AND 4),
  per_agent_budget_microusd INTEGER NOT NULL,
  overrun_reserve_microusd  INTEGER NOT NULL,
  total_budget_microusd     INTEGER NOT NULL,
  price_version             INTEGER NOT NULL,
  retries                   INTEGER NOT NULL CHECK (retries = 0),
  -- 'none', or the JSON of the publication grant constraints in force.
  publication_policy        TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  approved_at               TEXT,
  approved_by               TEXT,
  approved_digest           TEXT,
  CHECK ((kind = 'race' AND per_agent_budget_microusd > 0 AND overrun_reserve_microusd > 0 AND total_budget_microusd > 0)
      OR (kind = 'comparison' AND per_agent_budget_microusd = 0 AND overrun_reserve_microusd = 0 AND total_budget_microusd = 0))
);
CREATE TABLE contest (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref           INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  terms              INTEGER NOT NULL REFERENCES tournament_terms(id),
  generation         INTEGER NOT NULL DEFAULT 1,
  state              TEXT NOT NULL CHECK (state IN
    ('dispatching','racing','pick-wait','decision-wait','picked','abandoned','interrupted','exhausted')),
  scope_digest       TEXT NOT NULL,
  race_digest        TEXT NOT NULL,
  base_sha           TEXT,
  setup_digest       TEXT,
  current_lease_id   TEXT,
  runner             TEXT,
  incarnation        TEXT,
  created_at         TEXT NOT NULL,
  picked_at          TEXT,
  picked_by          TEXT,
  winner_contestant  INTEGER,
  overdue_paged      INTEGER NOT NULL DEFAULT 0,
  -- v24: 1 = legacy race digest (provider/model/repair only) — admission
  -- keeps byte-comparing the stored fingerprint; 2 = full-profile terms.
  race_semantics     INTEGER NOT NULL DEFAULT 1,
  -- v27: denormalized from the terms at admission, so screens, holds,
  -- and recovery speak the right words without a join.
  kind               TEXT NOT NULL DEFAULT 'race'
);
CREATE TABLE contestant (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  contest             INTEGER NOT NULL REFERENCES contest(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  repair_model        TEXT NOT NULL,
  -- v24: the contestant's full execution-profile snapshot (canonical JSON).
  profile_json        TEXT,
  branch              TEXT NOT NULL,
  worktree            TEXT,
  generation          INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','ready','building','parked','built','failed','stopped')),
  active_run          INTEGER REFERENCES run(id),
  budget_microusd     INTEGER NOT NULL,
  reserve_microusd    INTEGER NOT NULL,
  measured_microusd   INTEGER NOT NULL DEFAULT 0,
  accounted_microusd  INTEGER NOT NULL DEFAULT 0,
  unknown_spend       INTEGER NOT NULL DEFAULT 0,
  cleanup             TEXT CHECK (cleanup IN ('pending','done','attention')),
  custody             TEXT,
  UNIQUE (contest, ordinal)
);
CREATE TABLE execution_slot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  runner        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','running','released')),
  run           INTEGER REFERENCES run(id),
  contestant    INTEGER REFERENCES contestant(id),
  incarnation   TEXT,
  process_group INTEGER,
  reserved_at   TEXT NOT NULL,
  running_at    TEXT,
  released_at   TEXT
);
CREATE TABLE ceremony_nonce (
  hash        TEXT PRIMARY KEY,
  approver    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  subject_id  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE spend_defaults (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  build_per_run_microusd   INTEGER,
  race_per_agent_microusd  INTEGER,
  race_total_microusd      INTEGER,
  -- How many agents compete by default (v16, operator request). Applies
  -- only where a filing names ONE agent and no explicit count — an
  -- explicit list or count always wins, and the race digest binds the
  -- actual lineup either way.
  race_agents              INTEGER CHECK (race_agents BETWEEN 2 AND 4),
  updated_at               TEXT NOT NULL,
  updated_by               TEXT NOT NULL
);
CREATE TABLE permission_default (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  mode       TEXT NOT NULL CHECK (mode IN ('auto','bypassPermissions')),
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO "permission_default" ("id", "mode", "updated_at", "updated_by") VALUES (1, 'auto', NULL, NULL);
CREATE TABLE quality_default (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  mode       TEXT NOT NULL CHECK (mode IN ('default','strict')),
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO "quality_default" ("id", "mode", "updated_at", "updated_by") VALUES (1, 'default', NULL, NULL);
CREATE TABLE chat_config (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  provider                TEXT NOT NULL CHECK (provider IN ('anthropic-api','openrouter-api','claude-subscription','codex-subscription')),
  model                   TEXT NOT NULL,
  daily_turns             INTEGER NOT NULL DEFAULT 50,
  -- The rolling 7-day spend ceiling, integer micro-dollars (change 4):
  -- reservations count against it transactionally. Subscription-backed
  -- chat stores zero: there is no truthful dollar meter on plan usage.
  weekly_ceiling_microusd INTEGER NOT NULL,
  -- The PINNED price (v13b): snapshotted from the provider's own catalog
  -- (or the compiled table) at the authenticated save, integer
  -- micro-dollars per token. Reservations and settlement use THESE, so an
  -- upstream price change never silently moves the ledger math —
  -- re-saving re-pins. NULL only on rows written before the columns
  -- existed; readers fall back to the compiled table then.
  price_in_microusd       INTEGER,
  price_out_microusd      INTEGER,
  updated_at              TEXT NOT NULL,
  updated_by              TEXT NOT NULL
);
CREATE TABLE chat_turn (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  approver          TEXT NOT NULL,
  -- Domain-separated sha256 over provider+key, full hex — a stable,
  -- non-secret accounting identity (128+ bits per change 6).
  credential_key    TEXT NOT NULL,
  provider          TEXT NOT NULL CHECK (provider IN ('anthropic-api','openrouter-api','claude-subscription','codex-subscription')),
  model             TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued','running','answered','failed')),
  -- Terminal transitions are generation-checked CAS: a late response
  -- cannot resurrect a swept row (change 5).
  generation        INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  deadline_at       TEXT,
  finished_at       TEXT,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  reserved_microusd INTEGER NOT NULL,
  settled_microusd  INTEGER,
  failure_reason    TEXT CHECK (failure_reason IN
    ('provider-error','timeout','over-budget','malformed-reply','secret-refused','crashed','over-cap','unknown-spend')),
  unknown_spend     INTEGER NOT NULL DEFAULT 0,
  acknowledged_at   TEXT,
  acknowledged_by   TEXT,
  reply_bytes       INTEGER,
  candidate_count   INTEGER,
  kind              TEXT NOT NULL DEFAULT 'chat',
  mate_turn         INTEGER
);
CREATE TABLE mate_session (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  approver            TEXT NOT NULL,
  approver_generation INTEGER NOT NULL,
  credential_key      TEXT NOT NULL,
  ceiling_microusd    INTEGER NOT NULL,
  spent_microusd      INTEGER NOT NULL DEFAULT 0,
  ceiling_digest      TEXT NOT NULL,
  terms_digest        TEXT NOT NULL,
  minted_at           TEXT NOT NULL,
  ended_at            TEXT,
  ended_by            TEXT
);
CREATE TABLE mate_thread (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  approver       TEXT NOT NULL,
  ceiling_digest TEXT NOT NULL,
  opened_at      TEXT NOT NULL,
  last_turn_at   TEXT,
  closed_at      TEXT
);
INSERT INTO "mate_thread" ("id", "approver", "ceiling_digest", "opened_at", "last_turn_at", "closed_at") VALUES (1, 'alex', 'cccccccccccccccccccccccccccccccc', '2026-09-11T02:00:00.000Z', NULL, NULL);
CREATE TABLE mate_message (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread     INTEGER NOT NULL REFERENCES mate_thread(id) ON DELETE CASCADE,
  turn       INTEGER,
  role       TEXT NOT NULL CHECK (role IN ('operator','assistant')),
  text       TEXT NOT NULL,
  activity   TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE mate_proposal (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  thread         INTEGER NOT NULL REFERENCES mate_thread(id) ON DELETE CASCADE,
  turn           INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('task','next','reserve','hold','unhold','steer','scope','cancel','answer','repair')),
  payload_json   TEXT NOT NULL,
  ceiling_digest TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('drafting','pending','confirming','confirmed','refused','dismissed','expired')),
  created_at     TEXT NOT NULL,
  resolved_at    TEXT,
  resolved_by    TEXT,
  outcome_json   TEXT
);
INSERT INTO "mate_proposal" ("id", "thread", "turn", "kind", "payload_json", "ceiling_digest", "state", "created_at", "resolved_at", "resolved_by", "outcome_json") VALUES (1, 1, 1, 'steer', '{"taskId":"t-pending","note":"keep it small"}', 'cccccccccccccccccccccccccccccccc', 'pending', '2026-09-11T02:00:00.000Z', NULL, NULL, NULL);
CREATE TABLE coordinator_proposal (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cid          TEXT NOT NULL REFERENCES coordinator_credential(cid),
  name         TEXT NOT NULL,
  repo         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('next','reserve','hold','unhold','scope','cancel','answer')),
  payload_json TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','confirming','confirmed','refused','dismissed','expired')),
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  TEXT,
  outcome_json TEXT
);
CREATE TABLE mate_turn (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  approver          TEXT NOT NULL,
  session           INTEGER NOT NULL REFERENCES mate_session(id),
  thread            INTEGER NOT NULL REFERENCES mate_thread(id),
  credential_key    TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued','running','answered','failed')),
  generation        INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  deadline_at       TEXT NOT NULL,
  finished_at       TEXT,
  reserved_microusd INTEGER NOT NULL,
  settled_microusd  INTEGER,
  steps             INTEGER NOT NULL DEFAULT 0,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  failure_reason    TEXT
);
CREATE TABLE routine_fire (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id        INTEGER NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
  scheduled_for     TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('fired','skipped')),
  reason            TEXT,
  instance_task_ref INTEGER REFERENCES task_ref(id),
  created_at        TEXT NOT NULL,
  UNIQUE (routine_id, scheduled_for)
);
CREATE TABLE hold (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff','contest','revision')),
  owner_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  until      TEXT,
  held_at    TEXT NOT NULL,
  UNIQUE (owner_kind, owner_id)
);
CREATE TABLE claim (
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
  released_by      TEXT, incarnation TEXT,
  UNIQUE (task_ref, lease_generation)
);
CREATE TABLE capability (
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
CREATE TABLE run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  lease_id      TEXT NOT NULL,
  runner        TEXT NOT NULL,
  -- v24 dispatch stamps: the digests this invocation was PROVED against
  -- (warm resume matches on both), and the provider CLI version as
  -- provenance — never authority.
  scope_digest     TEXT,
  profile_digest   TEXT,
  provider_version TEXT,
  -- 'repair' is a resumed session mending its own malformed park payload.
  -- Deliberately NOT 'driver': the design's driver is the event-woken gate
  -- role that first exists at M4, and recording repair under that name now
  -- would make the two indistinguishable in every cost report afterwards.
  -- 'scout' (v34) reads a repository and delivers a report — its own word
  -- so scouting spend never hides under planning or building.
  role          TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair','planner','reviewer','scout')),
  -- Which provider harness this attempt ran on (v9). The default is a
  -- truthful backfill for history: every run before v9 passed through the
  -- fixed claude gateway. New dispatches always supply it explicitly.
  provider      TEXT NOT NULL DEFAULT 'claude',
  parent_run    INTEGER REFERENCES run(id),
  -- The agent session, kept so a malformed park can be repaired by resuming
  -- the conversation that produced it instead of paying for a fresh one.
  session_id    TEXT,
  -- HEAD before the agent spent anything. Evidence is a diff against this,
  -- not against whatever the index looked like when the agent stopped: an
  -- agent that staged or committed before parking would otherwise show a
  -- clean diff over material changes.
  base_revision TEXT,
  branch        TEXT,
  worktree      TEXT,
  model         TEXT,
  phase         TEXT,
  contestant    INTEGER REFERENCES contestant(id),
  -- 'interrupted' (v25) is a held attended session cut down mid-flight —
  -- fence, expiry, crash custody, or shutdown. A real word, never a
  -- synthesized park; the one-shot road keeps writing failed/interrupted
  -- as outcome+reason exactly as before.
  outcome       TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change','interrupted')),
  reason        TEXT,
  committed     INTEGER,
  -- The attended authorization this run consumed (v25) — the ruling-12
  -- attempt identity, stamped in the same transaction that consumes the
  -- one attempt. NULL = ordinary approved/tournament dispatch.
  attended_authorization TEXT REFERENCES attended_authorization(id),
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
  handoff       TEXT,
  -- The fallback-chain and credential stamps (v30), inline since v34 —
  -- the same columns ALTER appended on older files; the v34 rebuild
  -- recognizes both placements as one shape.
  chain_cycle INTEGER REFERENCES fallback_cycle(id), chain_index INTEGER, entry_digest TEXT, auth_mode TEXT, terminal_class TEXT, quality_mode TEXT NOT NULL DEFAULT 'default' CHECK (quality_mode IN ('default','strict')), plan_revision INTEGER REFERENCES plan_revision(id), authority_digest TEXT,
  -- v29 (the reviewer role): artifact-only runs carry NO workspace,
  -- honestly — every other role requires both (exclusive, no sentinels).
  CHECK ((role = 'reviewer' AND branch IS NULL AND worktree IS NULL)
      OR (role <> 'reviewer' AND branch IS NOT NULL AND worktree IS NOT NULL))
);
INSERT INTO "run" ("id", "task_ref", "lease_id", "runner", "scope_digest", "profile_digest", "provider_version", "role", "provider", "parent_run", "session_id", "base_revision", "branch", "worktree", "model", "phase", "contestant", "outcome", "reason", "committed", "attended_authorization", "started_at", "finished_at", "provider_started_at", "tokens_in", "tokens_out", "cost_usd", "usage_json", "head_revision", "handoff", "chain_cycle", "chain_index", "entry_digest", "auth_mode", "terminal_class", "quality_mode", "plan_revision", "authority_digest") VALUES (1, 1, 'lease-1', 'mac-1', 'fd1c4c93025a3b47fcaa2d52c4b2b55c', 'x', NULL, 'builder', 'claude', NULL, 'sess-routed', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'standing-orders/t-routed', '/w/t-routed', 'sonnet', NULL, NULL, 'built', NULL, 1, NULL, '2026-09-11T02:00:00.000Z', '2026-09-11T02:01:00.000Z', NULL, NULL, NULL, NULL, NULL, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', NULL, NULL, NULL, NULL, NULL, NULL, 'default', NULL, NULL);
CREATE TABLE decision (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
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
  -- Which racing agent asked (v14); lets one-open-question-per-agent be a
  -- real database rule instead of a hope (finding 28). NULL = ordinary.
  contestant     INTEGER REFERENCES contestant(id),
  -- Typed closure (v14): 'excluded' = the operator stopped the asking
  -- agent instead of answering. Never a fake option.
  closed_reason  TEXT CHECK (closed_reason IN ('excluded')),
  answered_via   TEXT CHECK (answered_via IN ('cli','web','telegram')),
  choice         TEXT,
  note           TEXT,
  -- v25 held-session linkage. session_turn = the turn whose settlement
  -- produced this park (causal, held runs only). delivered_turn = the
  -- answer turn that claimed delivery into the live session — the
  -- delivery-CAS target: set once (WHERE delivered_turn IS NULL), reverted
  -- only when that turn terminally never reached acceptance.
  session_turn   INTEGER REFERENCES session_turn(id),
  delivered_turn INTEGER REFERENCES session_turn(id)
);
CREATE TABLE artifact (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree','report','proof','check-log','screenshot','structured-output')),
  key            TEXT NOT NULL,
  bytes_original INTEGER NOT NULL,
  bytes_stored   INTEGER NOT NULL,
  truncated      INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT NOT NULL,
  capture        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  redacted       INTEGER NOT NULL DEFAULT 0,
  -- Typed capture verdict (v14, finding 20): authority never parses the
  -- prose capture description again. NULL = recorded before v14.
  capture_status TEXT CHECK (capture_status IN ('ok','failed'))
);
INSERT INTO "artifact" ("id", "run", "kind", "key", "bytes_original", "bytes_stored", "truncated", "sha256", "capture", "created_at", "redacted", "capture_status") VALUES (1, 1, 'terminal-diff', 'terminal-diff.patch', 120, 120, 0, 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'git diff', '2026-09-11T02:01:00.000Z', 0, 'ok');
CREATE TABLE decision_artifact (
  decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  artifact INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  PRIMARY KEY (decision, artifact)
);
CREATE TABLE run_decision (
  run      INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  choice   TEXT NOT NULL,
  note     TEXT,
  PRIMARY KEY (run, decision)
);
CREATE TABLE incident (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure','malformed-plan','plan-attempts-exhausted','malformed-report','malformed-proof')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE TABLE notification (
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
  receipt         TEXT,
  -- The push surface (arc 3, v23): a CLOSED attention class and a
  -- machine-minted console link, stamped by producers at enqueue.
  -- Unstamped kinds never reach a phone; subject/body never do either.
  push_class      TEXT CHECK (push_class IN ('decision','pick','merge','attention')),
  link            TEXT
, resolved_at TEXT, claim_owner TEXT, claim_expires_at TEXT);
CREATE TABLE telegram_digest (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  every_ms     INTEGER,
  set_by       TEXT,
  set_at       TEXT,
  last_sent_at TEXT
);
INSERT INTO "telegram_digest" ("id", "every_ms", "set_by", "set_at", "last_sent_at") VALUES (1, NULL, NULL, NULL, NULL);
CREATE TABLE backend_grant (
  repo             TEXT NOT NULL,
  backend          TEXT NOT NULL,
  paths            TEXT NOT NULL DEFAULT '[]',
  mutations        TEXT NOT NULL DEFAULT '[]',
  selector         TEXT NOT NULL,
  credential_scope TEXT,
  observed_by_git  INTEGER NOT NULL,
  granted_at       TEXT NOT NULL,
  granted_by       TEXT NOT NULL,
  -- External dispatch (v20): a SEPARATE authority from tracker writes —
  -- "this plane will BUILD what this tracker nominates". Never granted
  -- by default; dispatch=1 requires remote_repo and plane_id (enforced
  -- in saveGrant — ALTER ADD COLUMN cannot carry cross-column CHECKs).
  dispatch                INTEGER NOT NULL DEFAULT 0 CHECK (dispatch IN (0, 1)),
  remote_repo             TEXT,
  plane_id                TEXT,
  dispatch_blocked        TEXT CHECK (dispatch_blocked IN ('pending-marker','unreachable','foreign','missing','multiple-or-malformed')),
  dispatch_blocked_at     TEXT,
  dispatch_blocked_detail TEXT,
  PRIMARY KEY (repo, backend)
);
CREATE TABLE external_mirror (
  local_task_id   TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  backend         TEXT NOT NULL,
  remote_repo     TEXT NOT NULL,
  remote_id       TEXT NOT NULL,
  provenance      TEXT NOT NULL CHECK (provenance IN ('local-create','intake','granted-all')),
  intake_grant    INTEGER,
  established_by  TEXT NOT NULL,
  established_at  TEXT NOT NULL,
  remote_state    TEXT NOT NULL CHECK (remote_state IN ('open','closed','missing')),
  close_generation INTEGER,
  sync_generation INTEGER NOT NULL DEFAULT 0,
  dispatch_ok     INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_ok IN (0, 1)),
  reopened_by     TEXT,
  reopened_at     TEXT,
  CHECK ((provenance = 'intake') = (intake_grant IS NOT NULL)),
  UNIQUE (backend, remote_repo, remote_id)
);
CREATE TABLE sync_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  backend     TEXT NOT NULL,
  remote_repo TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT CHECK (outcome IN ('complete','capped','failed')),
  candidates  INTEGER NOT NULL DEFAULT 0,
  mirrored    INTEGER NOT NULL DEFAULT 0,
  detail      TEXT,
  UNIQUE (backend, remote_repo, generation)
);
CREATE TABLE external_intent (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mirror       TEXT NOT NULL REFERENCES external_mirror(local_task_id),
  kind         TEXT NOT NULL CHECK (kind IN ('comment','transition','close')),
  body         TEXT,
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','refused')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
CREATE TABLE ci_observation (
  github_repo TEXT NOT NULL,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('passing','failing','running','none')),
  generation  INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (github_repo, pr_number)
);
CREATE TABLE merge_intent (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  publication   INTEGER NOT NULL UNIQUE REFERENCES publication(id),
  grant_terms_hash TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('squash','merge','rebase')),
  delete_branch INTEGER NOT NULL DEFAULT 0 CHECK (delete_branch IN (0, 1)),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','waiting-human','firing','merged','refused','superseded')),
  claimed_by    TEXT,
  claimed_until TEXT,
  -- v29 (modes): WHOSE signature this intent fires under, bound at
  -- creation and re-proved in the firing CAS — 'grant' = the grant
  -- ceremony's own unattended-merge signature; 'mode' = a live automerge
  -- mode; 'human' = the per-merge password ceremony.
  authority_basis TEXT NOT NULL DEFAULT 'grant' CHECK (authority_basis IN ('grant','mode','human')),
  mode_digest   TEXT,
  -- v29: the durable one-winner linearization point — the CAS into
  -- 'firing' stamps both; staleness is firing_deadline passing, never a
  -- guess.
  firing_at     TEXT,
  firing_deadline TEXT,
  generation    INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  receipt       TEXT,
  created_at    TEXT NOT NULL,
  settled_at    TEXT,
  CHECK (state <> 'claimed' OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL)),
  CHECK (state <> 'firing' OR (firing_at IS NOT NULL AND firing_deadline IS NOT NULL))
);
CREATE TABLE merge_blocker (
  publication INTEGER NOT NULL REFERENCES publication(id),
  reason      TEXT NOT NULL CHECK (reason IN ('repair-open')),
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  -- v29: lifting is a stamp, not a DELETE — who unblocked, and when, is
  -- an audit answer the People screen promises. One LIVE blocker per
  -- publication (partial unique in the post-migration block); lifted
  -- rows are history and never block a new block.
  lifted_at   TEXT,
  lifted_by   TEXT
);
CREATE TABLE operating_mode (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo            TEXT NOT NULL,
  name            TEXT NOT NULL CHECK (name IN ('standard','hands-off')),
  terms_json      TEXT NOT NULL,
  digest          TEXT NOT NULL,
  signed_by       TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  signed_at       TEXT NOT NULL,
  absolute_expiry TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_by      TEXT,
  revoke_reason   TEXT
);
CREATE TABLE operating_mode_event (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  mode     INTEGER NOT NULL REFERENCES operating_mode(id),
  kind     TEXT NOT NULL CHECK (kind IN ('signed','renewed','revoked','expired-closed','signer-revoked')),
  actor    TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE TABLE invite (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('approver','viewer')),
  minted_by   TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  minted_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_by TEXT,
  consumed_at TEXT,
  revoked_at  TEXT
);
CREATE TABLE mode_rail (
  repo            TEXT NOT NULL,
  utc_day         TEXT NOT NULL,
  reserved_starts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, utc_day)
);
CREATE TABLE task_scope (
  task_id         TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  goal            TEXT NOT NULL,
  out_of_scope    TEXT,
  touches         TEXT NOT NULL DEFAULT '[]',
  proposed_at     TEXT NOT NULL,
  digest          TEXT NOT NULL,
  -- The dollar cap per build attempt, integer micro-dollars (v15):
  -- approved spend, digest-bound, enforced by the provider's own stop.
  budget_microusd INTEGER,
  approved_at     TEXT,
  approved_by     TEXT,
  approved_digest TEXT,
  -- The execution profile (v24, Parity II foundations): WHAT RUNS, bound
  -- into what the operator signs. profile_json = the working profile;
  -- approved_profile_json = the immutable snapshot the approval act took;
  -- digest_version 1 = legacy fields-only digest (grandfathered), 2 =
  -- profile-bearing. profile_state 'unresolved' blocks dispatch AND
  -- approval, with its reason in words. Provenance (resolvedFrom,
  -- grandfathered, provider version) lives in profile_provenance and
  -- NEVER enters a digest.
  profile_json          TEXT,
  profile_state         TEXT NOT NULL DEFAULT 'resolved' CHECK (profile_state IN ('resolved','unresolved')),
  unresolved_reason     TEXT,
  approved_profile_json TEXT,
  digest_version        INTEGER NOT NULL DEFAULT 1,
  profile_provenance    TEXT,
  -- The EXPLICIT fallback chain (v30, fallback chains). proposed_chain_json
  -- is the WORKING snapshot saveScope binds the digest to when the repo has
  -- configured fallbacks (mirrors profile_json); approved_chain_json is the
  -- immutable snapshot the approval COPIED from it (mirrors
  -- approved_profile_json = profile_json), so what is sealed is exactly what
  -- the signed digest bound — never re-resolved. Both NULL = a legacy
  -- single-profile (or no-profile) scope, untouched. approval_kind names
  -- which the approval sealed: 'profile' (legacy) or 'chain'.
  proposed_chain_json   TEXT,
  approved_chain_json   TEXT,
  -- The signed acceptance rubric (v39, Acceptance Contract v2): the SAME
  -- additive shape as every digest-bound field before it. NULL/absent
  -- reads back as [] and digests exactly as a rubric-less scope always
  -- has -- grandfathering is this column simply not existing on a row
  -- nobody has rewritten since. What makes a rubric MANDATORY going
  -- forward is enforced by the authoring roads (proposeGuarded,
  -- createConsoleTask, routine firing, the planner), never by this
  -- schema or by saveScope itself.
  acceptance_json       TEXT,
  -- The concrete quality policy (v41), folded into digest only when strict
  -- so every historical/default approval remains byte-identical.
  quality_mode          TEXT NOT NULL DEFAULT 'default' CHECK (quality_mode IN ('default','strict')),
  approval_kind         TEXT NOT NULL DEFAULT 'profile' CHECK (approval_kind IN ('profile','chain')),
  -- The phase route (v47, explainable risk-aware routing). risk_level is
  -- the signed risk; proposed_route_json is the WORKING canonical route
  -- saveScope computed from risk, quality, evidence, publication, the
  -- configured candidate tiers, and the task's overrides; EVERY route
  -- filed since v47 folds its digest into the scope digest, routine-shaped
  -- ones included. approved_route_json is the immutable snapshot the seal
  -- COPIED, exactly as approved_profile_json mirrors profile_json —
  -- dispatch re-proves against it and mutable configuration can never
  -- rewrite it. route_era is the DURABLE marker: NULL only on a row proven
  -- to predate v47 (legacy — its sealed profile alone governs the build);
  -- the route version on every row saveScope has written since. A row with
  -- an era and a missing or unreadable route is corrupt and FAILS CLOSED
  -- at approval, dispatch, review, and repair alike.
  risk_level            TEXT NOT NULL DEFAULT 'routine' CHECK (risk_level IN ('routine','elevated','high')),
  proposed_route_json   TEXT,
  approved_route_json   TEXT,
  route_era             INTEGER
, proposed_via TEXT, approval_basis TEXT, mode_digest TEXT);
INSERT INTO "task_scope" ("task_id", "goal", "out_of_scope", "touches", "proposed_at", "digest", "budget_microusd", "approved_at", "approved_by", "approved_digest", "profile_json", "profile_state", "unresolved_reason", "approved_profile_json", "digest_version", "profile_provenance", "proposed_chain_json", "approved_chain_json", "acceptance_json", "quality_mode", "approval_kind", "risk_level", "proposed_route_json", "approved_route_json", "route_era", "proposed_via", "approval_basis", "mode_digest") VALUES ('t-routed', 'ship t-routed', 'nothing else', '["src/t-routed.ts"]', '2026-09-11T02:00:00.000Z', 'fd1c4c93025a3b47fcaa2d52c4b2b55c', NULL, '2026-09-11T02:00:00.000Z', 'alex', 'fd1c4c93025a3b47fcaa2d52c4b2b55c', '{"digestVersion":2,"profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}}', 'resolved', NULL, '{"digestVersion":2,"profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}}', 2, '{"resolvedFrom":"route","routineFrom":"installation","repairFrom":"route","routeDigest":"1dd7dc965a38cc657258aa4ea20765c3"}', NULL, NULL, '[{"id":"c1","statement":"it ships","how":null,"evidence":["check"]}]', 'default', 'profile', 'elevated', '{"demands":["risk is elevated — the review runs on the strongest configured reviewer"],"evidence":["check"],"legs":[{"chosen":"recommended","model":"sonnet","phase":"plan","problem":null,"provider":"claude","reasons":["risk is elevated, quality is default — the configured planner is economical enough","configured planner from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"build","problem":null,"provider":"claude","reasons":["risk is elevated, quality is default — the configured builder is economical enough","configured builder from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"repair","problem":null,"provider":"claude","reasons":["risk is elevated, quality is default — the configured repair is economical enough","no repair model is configured — repairs resume the builder''s session on claude with the build model (sonnet)","same provider as the build (claude) — repairs resume the builder''s session"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"opus","phase":"review","problem":null,"provider":"claude","reasons":["risk is elevated — the review runs on the strongest configured reviewer","no stronger reviewer is configured — `config set review --tier strong --provider … --model …` names one; using the configured default from installation"],"recommended":{"model":"opus","provider":"claude","tier":"routine"},"tier":"routine"}],"overrides":[],"posture":"economy","publication":"none","qualityMode":"default","risk":"elevated","version":1}', '{"demands":["risk is elevated — the review runs on the strongest configured reviewer"],"evidence":["check"],"legs":[{"chosen":"recommended","model":"sonnet","phase":"plan","problem":null,"provider":"claude","reasons":["risk is elevated, quality is default — the configured planner is economical enough","configured planner from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"build","problem":null,"provider":"claude","reasons":["risk is elevated, quality is default — the configured builder is economical enough","configured builder from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"repair","problem":null,"provider":"claude","reasons":["risk is elevated, quality is default — the configured repair is economical enough","no repair model is configured — repairs resume the builder''s session on claude with the build model (sonnet)","same provider as the build (claude) — repairs resume the builder''s session"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"opus","phase":"review","problem":null,"provider":"claude","reasons":["risk is elevated — the review runs on the strongest configured reviewer","no stronger reviewer is configured — `config set review --tier strong --provider … --model …` names one; using the configured default from installation"],"recommended":{"model":"opus","provider":"claude","tier":"routine"},"tier":"routine"}],"overrides":[],"posture":"economy","publication":"none","qualityMode":"default","risk":"elevated","version":1}', 1, NULL, 'password', NULL);
INSERT INTO "task_scope" ("task_id", "goal", "out_of_scope", "touches", "proposed_at", "digest", "budget_microusd", "approved_at", "approved_by", "approved_digest", "profile_json", "profile_state", "unresolved_reason", "approved_profile_json", "digest_version", "profile_provenance", "proposed_chain_json", "approved_chain_json", "acceptance_json", "quality_mode", "approval_kind", "risk_level", "proposed_route_json", "approved_route_json", "route_era", "proposed_via", "approval_basis", "mode_digest") VALUES ('t-pending', 'ship t-pending', 'nothing else', '["src/t-pending.ts"]', '2026-09-11T02:00:00.000Z', '43c59f49e21e7c9f0b3d0659f2abc3cf', NULL, NULL, NULL, NULL, '{"digestVersion":2,"profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}}', 'resolved', NULL, NULL, 2, '{"resolvedFrom":"route","routineFrom":"installation","repairFrom":"route","routeDigest":"d88f5157f4da14536371c5b3fc88c3f6"}', NULL, NULL, '[{"id":"c1","statement":"it ships","how":null,"evidence":["check"]}]', 'default', 'profile', 'routine', '{"demands":[],"evidence":["check"],"legs":[{"chosen":"recommended","model":"sonnet","phase":"plan","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured planner is economical enough","configured planner from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"build","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured builder is economical enough","configured builder from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"repair","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured repair is economical enough","no repair model is configured — repairs resume the builder''s session on claude with the build model (sonnet)","same provider as the build (claude) — repairs resume the builder''s session"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"opus","phase":"review","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured reviewer is economical enough","configured reviewer from installation"],"recommended":{"model":"opus","provider":"claude","tier":"routine"},"tier":"routine"}],"overrides":[],"posture":"economy","publication":"none","qualityMode":"default","risk":"routine","version":1}', NULL, 1, NULL, NULL, NULL);
INSERT INTO "task_scope" ("task_id", "goal", "out_of_scope", "touches", "proposed_at", "digest", "budget_microusd", "approved_at", "approved_by", "approved_digest", "profile_json", "profile_state", "unresolved_reason", "approved_profile_json", "digest_version", "profile_provenance", "proposed_chain_json", "approved_chain_json", "acceptance_json", "quality_mode", "approval_kind", "risk_level", "proposed_route_json", "approved_route_json", "route_era", "proposed_via", "approval_basis", "mode_digest") VALUES ('t-legacy', 'ship t-legacy', 'nothing else', '["src/t-legacy.ts"]', '2026-09-11T02:00:00.000Z', '4f18b704c5bc5d1e559ea96252780153', NULL, '2026-09-11T02:00:00.000Z', 'alex', '4f18b704c5bc5d1e559ea96252780153', '{"digestVersion":2,"profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}}', 'resolved', NULL, '{"digestVersion":2,"profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}}', 2, '{"resolvedFrom":"route","routineFrom":"installation","repairFrom":"route","routeDigest":"d88f5157f4da14536371c5b3fc88c3f6"}', NULL, NULL, '[{"id":"c1","statement":"it ships","how":null,"evidence":["check"]}]', 'default', 'profile', 'routine', NULL, NULL, NULL, NULL, 'password', NULL);
INSERT INTO "task_scope" ("task_id", "goal", "out_of_scope", "touches", "proposed_at", "digest", "budget_microusd", "approved_at", "approved_by", "approved_digest", "profile_json", "profile_state", "unresolved_reason", "approved_profile_json", "digest_version", "profile_provenance", "proposed_chain_json", "approved_chain_json", "acceptance_json", "quality_mode", "approval_kind", "risk_level", "proposed_route_json", "approved_route_json", "route_era", "proposed_via", "approval_basis", "mode_digest") VALUES ('t-chain', 'ship t-chain', 'nothing else', '["src/t-chain.ts"]', '2026-09-11T02:00:00.000Z', '640f20c6b23834d1d95e5d276be9bf5e', NULL, '2026-09-11T02:00:00.000Z', 'alex', '640f20c6b23834d1d95e5d276be9bf5e', '{"digestVersion":2,"profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}}', 'resolved', NULL, '{"digestVersion":2,"profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}}', 2, '{"resolvedFrom":"route","routineFrom":"installation","repairFrom":"route","routeDigest":"d88f5157f4da14536371c5b3fc88c3f6"}', '{"chain":[{"authMode":"subscription","profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}},{"authMode":"subscription","profile":{"maxTurns":"unsupported","model":"gpt-5-codex","provider":"codex","repairMaxTurns":"unsupported","repairModel":"inherit","repairTimeoutSeconds":300,"sandboxMode":"workspace-write","timeoutKind":"idle","timeoutSeconds":1200}}],"digestVersion":1}', '{"chain":[{"authMode":"subscription","profile":{"maxTurns":1000,"model":"sonnet","permissionArgv":"auto","provider":"claude","repairMaxTurns":4,"repairModel":"inherit","repairTimeoutSeconds":300,"timeoutKind":"idle","timeoutSeconds":1200}},{"authMode":"subscription","profile":{"maxTurns":"unsupported","model":"gpt-5-codex","provider":"codex","repairMaxTurns":"unsupported","repairModel":"inherit","repairTimeoutSeconds":300,"sandboxMode":"workspace-write","timeoutKind":"idle","timeoutSeconds":1200}}],"digestVersion":1}', '[{"id":"c1","statement":"it ships","how":null,"evidence":["check"]}]', 'default', 'chain', 'routine', '{"demands":[],"evidence":["check"],"legs":[{"chosen":"recommended","model":"sonnet","phase":"plan","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured planner is economical enough","configured planner from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"build","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured builder is economical enough","configured builder from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"repair","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured repair is economical enough","no repair model is configured — repairs resume the builder''s session on claude with the build model (sonnet)","same provider as the build (claude) — repairs resume the builder''s session"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"opus","phase":"review","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured reviewer is economical enough","configured reviewer from installation"],"recommended":{"model":"opus","provider":"claude","tier":"routine"},"tier":"routine"}],"overrides":[],"posture":"economy","publication":"none","qualityMode":"default","risk":"routine","version":1}', '{"demands":[],"evidence":["check"],"legs":[{"chosen":"recommended","model":"sonnet","phase":"plan","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured planner is economical enough","configured planner from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"build","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured builder is economical enough","configured builder from installation"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"repair","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured repair is economical enough","no repair model is configured — repairs resume the builder''s session on claude with the build model (sonnet)","same provider as the build (claude) — repairs resume the builder''s session"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"opus","phase":"review","problem":null,"provider":"claude","reasons":["risk is routine, quality is default — the configured reviewer is economical enough","configured reviewer from installation"],"recommended":{"model":"opus","provider":"claude","tier":"routine"},"tier":"routine"}],"overrides":[],"posture":"economy","publication":"none","qualityMode":"default","risk":"routine","version":1}', 1, NULL, 'password', NULL);
CREATE TABLE approver (
  name            TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL,
  added_at        TEXT NOT NULL,
  -- v29 (multi-user): 'viewer' authenticates and reads; every
  -- consequential act requires ACTIVE role 'approver'. Revocation is a
  -- stamp — history stays attributable forever.
  role            TEXT NOT NULL DEFAULT 'approver' CHECK (role IN ('approver','viewer')),
  revoked_at      TEXT,
  revoked_by      TEXT,
  -- Bumped whenever the credential is replaced. Anything that derives
  -- authority from an approver — a paired Telegram chat, an outstanding
  -- pairing code — records the generation it was granted under, and a
  -- rotation strands every grant from the old one.
  generation      INTEGER NOT NULL DEFAULT 1
);
INSERT INTO "approver" ("name", "credential_hash", "added_at", "role", "revoked_at", "revoked_by", "generation") VALUES ('alex', 'd01a7b732cc3c5f32f6f3b52e85a04287b78328211250ecaf123373205262891', '2026-09-11T02:00:00.000Z', 'approver', NULL, NULL, 1);
CREATE TABLE telegram_binding (
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
CREATE TABLE telegram_pairing (
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
CREATE TABLE telegram_update (
  update_id  INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  result     TEXT NOT NULL
);
CREATE TABLE telegram_action (
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
, note_digest TEXT);
CREATE TABLE telegram_decision_message (
  binding    INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE CASCADE,
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  decision   INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding, chat_id, message_id)
);
CREATE TABLE telegram_note_draft (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  binding    INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE CASCADE,
  decision   INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  update_id  INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  reply_to   TEXT NOT NULL,
  note       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','armed','superseded','consumed','discarded')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE bridge_lease (
  bot_id       TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  cursor       INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
CREATE TABLE wake (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "wake" ("id", "seq") VALUES (1, 6);
CREATE TABLE watch_lease (
  runner       TEXT NOT NULL,
  repo         TEXT NOT NULL,
  owner        TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (runner, repo)
);
CREATE TABLE quota (
  runner      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  -- v30 (fallback chains): quota identity must distinguish a subscription
  -- from an API key, else exhausting a claude subscription would wrongly
  -- block a claude api-key fallback. auth_mode + a stable NON-SECRET
  -- credential fingerprint join the key. Defaults keep every pre-v30 row
  -- identical (mode 'subscription', empty fp) since that is what they were.
  auth_mode   TEXT NOT NULL DEFAULT 'subscription' CHECK (auth_mode IN ('subscription','api-key')),
  credential_fp TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL CHECK (state IN ('exhausted','half-open')),
  reason      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reset_at    TEXT,
  PRIMARY KEY (runner, provider, scope, auth_mode, credential_fp)
);
CREATE TABLE fallback_cycle (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  -- The approved chain this cycle walks; the cycle is void if the approval
  -- moves (the CAS re-proves it).
  chain_digest  TEXT NOT NULL,
  cursor        INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL CHECK (state IN ('open','sanitizing','awaiting-release','pending-admission','incident','closed')),
  transition_generation INTEGER NOT NULL DEFAULT 0,
  -- The current tail run (the entry running, or the predecessor being
  -- sanitized). NULL only transiently at pending-admission before the next
  -- run opens.
  tail_run      INTEGER REFERENCES run(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_reason TEXT
);
CREATE TABLE fallback_transition (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle         INTEGER NOT NULL REFERENCES fallback_cycle(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('exhaustion','quota-skip')),
  from_index    INTEGER NOT NULL,
  to_index      INTEGER NOT NULL,
  -- The predecessor run whose exhaustion (or whose skip evidence) earned
  -- this step; NULL for a fresh cycle's index-0 (there is no transition
  -- into index 0 — a cycle starts there).
  predecessor_run INTEGER REFERENCES run(id),
  -- The gateway-stamped terminal class + proven evidence identity that
  -- authorized an 'exhaustion' step (NULL for quota-skip, which cites
  -- durable quota evidence instead).
  terminal_class  TEXT,
  evidence_provider TEXT,
  evidence_version  TEXT,
  evidence_auth_mode TEXT,
  evidence_fp     TEXT,
  created_at    TEXT NOT NULL,
  -- The run that consumed this transition's authority (single-use). NULL
  -- until admission; set once, in the same txn that opens the next run.
  consumed_by   INTEGER REFERENCES run(id)
);
CREATE TABLE watch_episode (
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
CREATE TABLE project (
  path           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);
CREATE TABLE publication_grant (
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
, merge INTEGER NOT NULL DEFAULT 0 CHECK (merge IN (0, 1)), merge_method TEXT CHECK (merge_method IN ('squash','merge','rebase')), merge_delete_branch INTEGER NOT NULL DEFAULT 0 CHECK (merge_delete_branch IN (0, 1)));
CREATE TABLE publication (
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
  updated_at  TEXT NOT NULL,
  -- The remote's own verdict, observed (M8 audit C-6): MERGED/CLOSED ends
  -- the watch without widening the local state CHECK.
  remote_state TEXT,
  -- What CI was last SEEN doing, and when (audit SD-4): the review queue
  -- ranks observed-passing first and never upgrades silence to green.
  last_check_state TEXT,
  last_check_at    TEXT
);
CREATE TABLE runner (
  name            TEXT PRIMARY KEY,
  host            TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  capacity        INTEGER NOT NULL,
  -- What capacity bounds (v14, finding 26): 'tasks' is the original
  -- contract (live claims) and stays the default; 'processes' counts
  -- worker processes via execution_slot and is an explicit opt-in —
  -- an upgrade never silently changes what an operator's number means.
  capacity_mode   TEXT NOT NULL DEFAULT 'tasks' CHECK (capacity_mode IN ('tasks','processes')),
  repos           TEXT NOT NULL DEFAULT '[]',
  agents          TEXT NOT NULL DEFAULT '[]',
  registered_at   TEXT NOT NULL,
  heartbeat_at    TEXT NOT NULL,
  retired_at      TEXT,
  -- The queue column's theme note (v19) — operator prose, display only.
  queue_note      TEXT
);
INSERT INTO "runner" ("name", "host", "credential_hash", "capacity", "capacity_mode", "repos", "agents", "registered_at", "heartbeat_at", "retired_at", "queue_note") VALUES ('mac-1', 'mac', 'fc93806ab6ae6e6170fefc8359b33066beb1d0ffd92f180dd146538589952069', 2, 'tasks', '["/repo/app"]', '[]', '2026-09-11T02:00:00.000Z', '2026-09-11T02:00:00.000Z', NULL, NULL);
CREATE TABLE worktree (
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
  verified      INTEGER NOT NULL DEFAULT 0,
  -- Per-occupancy epoch (live-peek findings 16/28): a fresh random value
  -- written ATOMICALLY with every lease and rotated on release, so it can
  -- never repeat across release/forget/adopt/recreation. An observation
  -- proved against one epoch is DISCARDED if the epoch moved before it
  -- rendered — the fence that keeps a successor occupant's files out of a
  -- predecessor's page.
  lease_epoch   TEXT,
  -- The approved setup this checkout last ran to completion (M5.7):
  -- matching the live setup's digest is the cache hit; anything else runs
  -- it again before an agent may spawn here.
  setup_digest  TEXT
);
CREATE TABLE worktree_setup (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  command     TEXT NOT NULL,
  timeout_ms  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
);
CREATE TABLE verify_command (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  command     TEXT NOT NULL,
  timeout_ms  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  -- v45: opt-in authority for exactly one post-commit replay of this
  -- setup digest when the verification command cannot start because a
  -- required project executable is unavailable. NULL preserves every older grant.
  recovery_setup_digest TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
);
CREATE TABLE proof_verdict (
  run         INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  verdict     TEXT NOT NULL CHECK (verdict IN ('verified','attested','short','refuted')),
  reasons_json TEXT NOT NULL,
  decided_at  TEXT NOT NULL,
  -- v39: the criterion-to-evidence matrix adjudicate() computed alongside
  -- the verdict -- one shared render, never re-derived. NULL for every
  -- verdict decided before this migration, and for any run whose scope
  -- signed no rubric (adjudicate returns [] and this column stores NULL,
  -- not "[]", so a surface can tell "no matrix" from "an empty one" --
  -- not that the two currently read any differently).
  matrix_json TEXT,
  -- v40 (evidence-review-v1): the verdict adjudicate() computed, BEFORE an
  -- independent reviewer's judgements were folded in — NULL means "no
  -- review folded", reading back exactly as today. Never overwritten once
  -- set: one review per source run, ever (one_review_per_source), so this
  -- is written at most once, by the same transaction that folds it.
  machine_verdict TEXT CHECK (machine_verdict IS NULL OR machine_verdict IN ('verified','attested','short','refuted'))
);
CREATE TABLE criterion_review (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reviewer_run  INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  source_run    INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  criterion_id  TEXT NOT NULL,
  judgement     TEXT NOT NULL CHECK (judgement IN ('upholds','contradicts','cannot-tell')),
  note          TEXT NOT NULL,
  artifact      INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  artifact_sha  TEXT NOT NULL,
  author        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  -- Audit hardening (still evidence-review-v1, unreleased): every input the
  -- reviewer was actually shown, hash-bound and RE-VALIDATED against the
  -- live store at ingest time by ingestReview() -- never trusted from the
  -- caller's say-so. NULL exactly when that input never existed for this
  -- run (no verify command configured, no screenshots claimed): an
  -- omission, recorded as one, never confused with a mismatch.
  scope_digest       TEXT,
  head_sha           TEXT,
  proof_artifact     INTEGER,
  proof_sha          TEXT,
  check_log_artifact INTEGER,
  check_log_sha      TEXT,
  screenshots_json   TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE repair_chain (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  root_task       TEXT NOT NULL,
  source_run      INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  attempt         INTEGER NOT NULL,
  draft_task      TEXT,
  basis           TEXT NOT NULL CHECK (basis IN ('human','mode')),
  mode_digest     TEXT,
  unresolved_json TEXT NOT NULL,
  outcome         TEXT NOT NULL DEFAULT 'drafted'
                    CHECK (outcome IN ('drafted','attempts-spent','no-progress','integrity-refused','resolved')),
  created_at      TEXT NOT NULL,
  settled_at      TEXT
);
CREATE TABLE proof_acceptance (
  run         INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  approver    TEXT NOT NULL,
  note        TEXT,
  accepted_at TEXT NOT NULL
);
CREATE TABLE run_note (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run        INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  note       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE intake_grant (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  github      TEXT NOT NULL,
  label       TEXT NOT NULL,
  reviewers   TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
);
CREATE TABLE diff_comment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact      INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  artifact_sha  TEXT NOT NULL,
  run           INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  path          TEXT,
  line          INTEGER,
  note          TEXT NOT NULL,
  author        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  superseded_by INTEGER REFERENCES diff_comment(id),
  consumed_by   TEXT,
  -- Where an ingested comment came from (M8.17): gh:<owner/name>:<id>.
  -- The GitHub comment id is the idempotency key — one ingest, ever.
  -- Its unique index is created AFTER migration (see openStore): a
  -- database whose diff_comment predates the column would die on an
  -- index statement inside this schema block before addColumn could run.
  source_key    TEXT
, reviewer_run INTEGER REFERENCES run(id), severity TEXT CHECK (severity IN ('note','question','problem')));
CREATE TABLE review_request (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run             INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  -- Who asked, as words for the page. AUTHORITY lives in basis/mode_digest
  -- below, never in this string (Codex reviewer round 1, finding 4: an
  -- operator who NAMES themselves 'mode:…' must not be misclassified).
  requested_by    TEXT NOT NULL,
  -- 'human' = an operator's credentialed ask, always dispatchable.
  -- 'mode' = a reviewAuto mode queued it; dispatch re-proves the EXACT
  -- digest below is still the active mode — a renewal is a new signature
  -- and does not inherit its predecessor's queued asks.
  basis           TEXT NOT NULL DEFAULT 'human' CHECK (basis IN ('human','mode')),
  mode_digest     TEXT,
  -- v47: the approved route digest the request was queued under. Admission
  -- re-proves the task's sealed route still carries it — a re-approved
  -- task with a different route spends the request unrun, in words.
  route_digest    TEXT,
  requested_at    TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_reason TEXT
);
INSERT INTO "review_request" ("id", "run", "requested_by", "basis", "mode_digest", "route_digest", "requested_at", "consumed_at", "consumed_reason") VALUES (1, 1, 'alex', 'human', NULL, '1dd7dc965a38cc657258aa4ea20765c3', '2026-09-11T02:01:01.000Z', NULL, NULL);
CREATE TABLE task_steer (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  author        TEXT NOT NULL,
  note          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  attached_run  INTEGER REFERENCES run(id),
  attached_at   TEXT,
  delivered_at  TEXT,
  superseded_at TEXT,
  -- v24 (ruling 11): authorship is a VERIFIED principal or it is history.
  -- The default is the legacy label so any road that forgets to say
  -- otherwise fails closed into "unverified".
  authorship_state  TEXT NOT NULL DEFAULT 'unverified-legacy' CHECK (authorship_state IN ('verified','unverified-legacy')),
  superseded_reason TEXT,
  CHECK ((attached_run IS NULL) = (attached_at IS NULL)),
  CHECK (delivered_at IS NULL OR attached_run IS NOT NULL)
);
INSERT INTO "task_steer" ("id", "task_ref", "author", "note", "created_at", "attached_run", "attached_at", "delivered_at", "superseded_at", "authorship_state", "superseded_reason") VALUES (1, 2, 'alex', 'prefer the existing formatter', '2026-09-11T02:00:00.000Z', NULL, NULL, NULL, NULL, 'verified', NULL);
CREATE TABLE plan_revision (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref         INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  revision         INTEGER NOT NULL,
  artifact         INTEGER NOT NULL REFERENCES artifact(id),
  parent_hash      TEXT,
  reason           TEXT NOT NULL,
  evidence_link    TEXT,
  author           TEXT NOT NULL,
  origin_run       INTEGER REFERENCES run(id),
  kind             TEXT NOT NULL CHECK (kind IN ('initial', 'operator-edit', 'builder-proposal')),
  authority_kind   TEXT NOT NULL CHECK (authority_kind IN ('plan-only', 'authority-change')),
  authority_digest TEXT NOT NULL,
  changed_fields   TEXT,
  status           TEXT NOT NULL CHECK (status IN ('applied', 'blocked', 'rejected')),
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  resolved_by      TEXT,
  UNIQUE (task_ref, revision)
);
CREATE TABLE run_checkpoint (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run           INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  plan_revision INTEGER NOT NULL REFERENCES plan_revision(id),
  snapshot_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE push_subscription (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint                  TEXT NOT NULL,
  p256dh                    TEXT NOT NULL,
  auth                      TEXT NOT NULL,
  approver                  TEXT NOT NULL,
  approver_generation       INTEGER NOT NULL,
  ua_words                  TEXT NOT NULL,
  vapid_fingerprint         TEXT NOT NULL,
  starts_after_notification INTEGER NOT NULL,
  created_at                TEXT NOT NULL,
  last_ok_at                TEXT,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  retired_at                TEXT,
  retired_reason            TEXT
);
CREATE TABLE push_delivery (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  notification     INTEGER NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
  subscription     INTEGER NOT NULL REFERENCES push_subscription(id) ON DELETE CASCADE,
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','claimed','accepted','rejected','undeliverable','retired')),
  claim_owner      TEXT,
  claim_expires_at TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  accepted_at      TEXT,
  UNIQUE (notification, subscription),
  CHECK (state <> 'claimed' OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL))
);
CREATE TABLE mutation (
  idempotency_key TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,
  result          TEXT NOT NULL,
  actor           TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE TABLE attended_authorization (
  id                TEXT PRIMARY KEY,
  task_ref          INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  approver          TEXT NOT NULL,
  runner            TEXT NOT NULL,
  runner_generation INTEGER NOT NULL,
  composite_digest  TEXT NOT NULL,
  terms_json        TEXT NOT NULL,
  max_session_turns INTEGER NOT NULL,
  budget_microusd   INTEGER NOT NULL,
  -- Continuation (A4): the finished parent attempt this authorization
  -- continues, and the follow-up text — BOTH also inside the signed
  -- terms_json; these columns exist so admission can join without parsing.
  parent_run        INTEGER REFERENCES run(id),
  followup          TEXT,
  created_at        TEXT NOT NULL,
  absolute_expiry   TEXT NOT NULL,
  last_beat_at      TEXT,
  attempt_run       INTEGER UNIQUE REFERENCES run(id),
  consumed_at       TEXT,
  closed_at         TEXT,
  end_reason        TEXT
, authority_basis TEXT NOT NULL DEFAULT 'password' CHECK (authority_basis IN ('password','mode')), mode_digest TEXT);
CREATE TABLE session_turn (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run                INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('brief','answer','operator','repair')),
  source_id          INTEGER,
  -- Verified operator name for source_kind 'operator' ONLY; brief and
  -- repair turns are machine-authored and say so with NULL.
  author             TEXT,
  text               TEXT NOT NULL,
  reserved_microusd  INTEGER NOT NULL,
  accounted_microusd INTEGER,
  accounted_at       TEXT,
  recorded_at        TEXT NOT NULL,
  written_at         TEXT,
  accepted_at        TEXT,
  settled_at         TEXT,
  measured_microusd  INTEGER,
  output_tokens      INTEGER,
  state              TEXT NOT NULL DEFAULT 'recorded'
                       CHECK (state IN ('recorded','written','accepted','settled','uncertain','cancelled')),
  UNIQUE (run, seq)
);
CREATE TABLE held_session (
  run                   INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  authorization_id      TEXT NOT NULL REFERENCES attended_authorization(id),
  runner                TEXT NOT NULL,
  lease_id              TEXT NOT NULL,
  up_incarnation        TEXT NOT NULL,
  cookie                TEXT NOT NULL,
  socket_path           TEXT NOT NULL,
  supervisor_pid        INTEGER,
  agent_pgid            INTEGER,
  cumulative_microusd   INTEGER NOT NULL DEFAULT 0,
  cumulative_tokens_out INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','fencing')),
  fencer                TEXT,
  fencing_deadline      TEXT,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  end_reason            TEXT
);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('task_ref', 4);
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('run', 1);
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('artifact', 1);
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('review_request', 1);
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('task_steer', 1);
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('routine', 1);
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('mate_thread', 1);
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('mate_proposal', 1);
CREATE UNIQUE INDEX coordinator_live_name
  ON coordinator_credential (name) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX tournament_terms_one_active
  ON tournament_terms (task_ref) WHERE active = 1;
CREATE INDEX contest_by_task ON contest (task_ref, id DESC);
CREATE INDEX execution_slot_live ON execution_slot (runner, state);
CREATE INDEX ceremony_nonce_expiry ON ceremony_nonce (expires_at);
CREATE INDEX chat_turn_credential ON chat_turn (credential_key, created_at);
CREATE INDEX chat_turn_approver ON chat_turn (approver, created_at);
CREATE INDEX mate_session_live ON mate_session (approver, ended_at);
CREATE INDEX mate_thread_live ON mate_thread (approver, closed_at);
CREATE INDEX mate_message_thread ON mate_message (thread, id);
CREATE INDEX mate_proposal_thread ON mate_proposal (thread, state);
CREATE INDEX coordinator_proposal_state ON coordinator_proposal (state, repo);
CREATE INDEX mate_turn_live ON mate_turn (approver, state);
CREATE INDEX routine_fire_recent ON routine_fire (routine_id, id DESC);
CREATE TRIGGER external_mirror_immutable
BEFORE UPDATE ON external_mirror
WHEN OLD.backend IS NOT NEW.backend OR OLD.remote_repo IS NOT NEW.remote_repo
  OR OLD.remote_id IS NOT NEW.remote_id OR OLD.provenance IS NOT NEW.provenance
  OR OLD.intake_grant IS NOT NEW.intake_grant
  OR OLD.established_by IS NOT NEW.established_by OR OLD.established_at IS NOT NEW.established_at
BEGIN
  SELECT RAISE(ABORT, 'external mirror identity is immutable');
END;
CREATE UNIQUE INDEX one_live_mode_per_repo
  ON operating_mode (repo) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX telegram_binding_live
  ON telegram_binding (bot_id) WHERE revoked_at IS NULL;
CREATE INDEX telegram_action_by_decision ON telegram_action (decision);
CREATE UNIQUE INDEX telegram_note_draft_live
  ON telegram_note_draft (binding, decision) WHERE state IN ('pending','armed');
CREATE INDEX project_recent ON project (last_opened_at);
CREATE UNIQUE INDEX publication_grant_live
  ON publication_grant (repo) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX worktree_setup_live
  ON worktree_setup (repo) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX verify_command_live
  ON verify_command (repo) WHERE revoked_at IS NULL;
CREATE INDEX repair_chain_root ON repair_chain (root_task, attempt);
CREATE UNIQUE INDEX intake_grant_live
  ON intake_grant (repo) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX push_subscription_live
  ON push_subscription (endpoint) WHERE retired_at IS NULL;
CREATE INDEX push_delivery_due
  ON push_delivery (state, next_attempt_at) WHERE state IN ('pending','claimed');
CREATE INDEX task_by_state ON task (state);
CREATE INDEX edge_by_blocker ON task_edge (blocker);
CREATE INDEX claim_by_task ON claim (task_ref, lease_generation DESC);
CREATE INDEX hold_by_task ON hold (task_ref);
CREATE INDEX decision_attention ON decision (run, id) WHERE state IN ('open','expired');
CREATE INDEX incident_attention ON incident (run, id) WHERE resolved_at IS NULL;
CREATE INDEX task_ref_repo ON task_ref (repo, id);
CREATE INDEX run_task_outcome ON run (task_ref, outcome, id DESC);
CREATE INDEX task_done_recent ON task (updated_at DESC, id DESC) WHERE state = 'done';
CREATE INDEX run_started ON run (started_at, id);
CREATE UNIQUE INDEX diff_comment_source ON diff_comment (source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX one_open_decision_per_contestant
  ON decision (contestant) WHERE contestant IS NOT NULL AND state IN ('open','expired');
CREATE INDEX task_steer_pending
  ON task_steer (task_ref, id) WHERE delivered_at IS NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX one_open_authorization_per_task
  ON attended_authorization (task_ref) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX one_live_merge_blocker
  ON merge_blocker (publication) WHERE lifted_at IS NULL;
CREATE UNIQUE INDEX session_turn_answer_once
  ON session_turn (source_kind, source_id)
  WHERE source_kind = 'answer' AND state NOT IN ('uncertain','cancelled');
CREATE UNIQUE INDEX one_open_decision_per_run
  ON decision (run) WHERE state IN ('open','expired');
CREATE INDEX decision_undelivered
  ON decision (run, id) WHERE state = 'answered' AND delivered_turn IS NULL;
CREATE UNIQUE INDEX one_review_per_source
  ON run (parent_run) WHERE role = 'reviewer';
CREATE UNIQUE INDEX one_open_review_request
  ON review_request (run) WHERE consumed_at IS NULL;
CREATE UNIQUE INDEX fallback_transition_step
  ON fallback_transition (cycle, from_index);
CREATE UNIQUE INDEX one_live_fallback_cycle_per_task
  ON fallback_cycle (task_ref) WHERE state NOT IN ('closed','incident');
CREATE UNIQUE INDEX one_blocked_revision_per_task
  ON plan_revision (task_ref) WHERE status = 'blocked';
CREATE INDEX run_checkpoint_by_run ON run_checkpoint (run, id);
CREATE INDEX run_checkpoint_by_task ON run_checkpoint (task_ref, id);
COMMIT;
