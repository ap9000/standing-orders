import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { rebuildChatProvidersForV35 } from "./store.js";

const V34_CHAT_CONFIG = `CREATE TABLE chat_config (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  provider                TEXT NOT NULL CHECK (provider IN ('anthropic-api','openrouter-api')),
  model                   TEXT NOT NULL,
  daily_turns             INTEGER NOT NULL DEFAULT 50,
  weekly_ceiling_microusd INTEGER NOT NULL,
  price_in_microusd       INTEGER,
  price_out_microusd      INTEGER,
  updated_at              TEXT NOT NULL,
  updated_by              TEXT NOT NULL
)`;

const V34_CHAT_CONFIG_APPENDED = `CREATE TABLE chat_config (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  provider                TEXT NOT NULL CHECK (provider IN ('anthropic-api','openrouter-api')),
  model                   TEXT NOT NULL,
  daily_turns             INTEGER NOT NULL DEFAULT 50,
  weekly_ceiling_microusd INTEGER NOT NULL,
  updated_at              TEXT NOT NULL,
  updated_by              TEXT NOT NULL,
  price_in_microusd INTEGER,
  price_out_microusd INTEGER
)`;

// v32 added the final two columns with ALTER TABLE, which is the authentic
// shape carried by every v34 database.
const V34_CHAT_TURN = `CREATE TABLE chat_turn (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  approver          TEXT NOT NULL,
  credential_key    TEXT NOT NULL,
  provider          TEXT NOT NULL CHECK (provider IN ('anthropic-api','openrouter-api')),
  model             TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued','running','answered','failed')),
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
  kind TEXT NOT NULL DEFAULT 'chat',
  mate_turn INTEGER
)`;

describe("schema v35: membership providers join chat's exact CHECKs", () => {
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec(V34_CHAT_CONFIG);
    db.exec(V34_CHAT_TURN);
    db.exec("CREATE INDEX chat_turn_credential ON chat_turn (credential_key, created_at)");
    db.exec("CREATE INDEX chat_turn_approver ON chat_turn (approver, created_at)");
    return db;
  };

  test("rows and ids survive; both membership providers are admitted; indexes and idempotence survive", () => {
    const db = fresh();
    db.exec("INSERT INTO chat_config VALUES (1, 'anthropic-api', 'claude-sonnet-5', 50, 5000000, 3, 15, 'now', 'alex')");
    db.exec("INSERT INTO chat_turn (id, approver, credential_key, provider, model, state, created_at, reserved_microusd, settled_microusd) VALUES (9, 'alex', 'cred', 'anthropic-api', 'claude-sonnet-5', 'answered', 'now', 10, 7)");
    expect(() => db.exec("UPDATE chat_config SET provider = 'codex-subscription'")).toThrow();

    rebuildChatProvidersForV35(db);

    expect(db.prepare("SELECT id, provider, weekly_ceiling_microusd FROM chat_config").get()).toEqual({ id: 1, provider: "anthropic-api", weekly_ceiling_microusd: 5_000_000 });
    expect(db.prepare("SELECT id, provider, settled_microusd FROM chat_turn").get()).toEqual({ id: 9, provider: "anthropic-api", settled_microusd: 7 });
    db.exec("UPDATE chat_config SET provider = 'codex-subscription', model = 'default', weekly_ceiling_microusd = 0, price_in_microusd = 0, price_out_microusd = 0");
    db.exec("INSERT INTO chat_turn (approver, credential_key, provider, model, state, created_at, reserved_microusd, settled_microusd) VALUES ('alex', 'membership', 'claude-subscription', 'default', 'answered', 'later', 0, 0)");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'chat_turn_%' ORDER BY name").all().map(row => row["name"])).toEqual(["chat_turn_approver", "chat_turn_credential"]);
    const configDdl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_config'").get()?.["sql"]);
    const turnDdl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_turn'").get()?.["sql"]);
    rebuildChatProvidersForV35(db);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_config'").get()?.["sql"])).toBe(configDdl);
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_turn'").get()?.["sql"])).toBe(turnDdl);
  });

  test("the authentic additive-column config shape upgrades without losing its row", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(V34_CHAT_CONFIG_APPENDED);
    db.exec(V34_CHAT_TURN);
    db.exec("INSERT INTO chat_config (id, provider, model, daily_turns, weekly_ceiling_microusd, updated_at, updated_by, price_in_microusd, price_out_microusd) VALUES (1, 'anthropic-api', 'claude-sonnet-5', 50, 5000000, 'now', 'alex', 3, 15)");

    rebuildChatProvidersForV35(db);

    expect(db.prepare("SELECT id, provider, model, price_in_microusd, price_out_microusd, updated_by FROM chat_config").get()).toEqual({
      id: 1,
      provider: "anthropic-api",
      model: "claude-sonnet-5",
      price_in_microusd: 3,
      price_out_microusd: 15,
      updated_by: "alex",
    });
    db.exec("UPDATE chat_config SET provider = 'codex-subscription'");
  });

  test("a lookalike table is refused rather than copied", () => {
    const db = fresh();
    db.exec("ALTER TABLE chat_config ADD COLUMN surprise TEXT");
    expect(() => rebuildChatProvidersForV35(db)).toThrow(/not a shape this migration knows/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_config'").get()).toBeDefined();
  });
});
