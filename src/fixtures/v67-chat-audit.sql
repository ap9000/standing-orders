-- Frozen v67 audit tables, copied from verified d1356b2.
CREATE TABLE IF NOT EXISTS decision (
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
  answered_via   TEXT CHECK (answered_via IN ('cli','web','telegram','slack')),
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

CREATE TABLE IF NOT EXISTS run_stop (
  run           INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  requested_by  TEXT NOT NULL,
  requested_via TEXT NOT NULL CHECK (requested_via IN ('cli','web','telegram','slack')),
  requested_at  TEXT NOT NULL,
  settled_at    TEXT,
  settlement    TEXT CHECK (settlement IN ('interrupted','recovered','held','finished')),
  resumed_at    TEXT,
  resumed_by    TEXT,
  resumed_via   TEXT CHECK (resumed_via IN ('cli','web','telegram','slack')),
  CHECK ((settled_at IS NULL) = (settlement IS NULL)),
  CHECK (resumed_at IS NULL OR settled_at IS NOT NULL),
  CHECK ((resumed_at IS NULL) = (resumed_by IS NULL))
);
