/** Isolated fixtures only: production databases are never opened here. */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { hashPairingCode, mintPairingCode, PAIRING_TTL_MS } from "./telegram.js";

const NOW = new Date("2026-09-21T18:00:00Z");
const BOT = "777000";

describe("v72 one Telegram binding per person", () => {
  let dir: string | undefined;
  let store: Store | undefined;
  afterEach(() => { store?.close(); store = undefined; if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

  const pairAs = (who: string, chat: string) => {
    const code = mintPairingCode();
    store!.createTelegramPairing({ codeHash: hashPairingCode(code), approver: who, by: who, ttlMs: PAIRING_TTL_MS }, NOW);
    return store!.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: chat, userId: chat, updateId: Number(chat) }, NOW);
  };

  test.each([71, -71])("v%s drops the one-per-bot rule, keeps the existing binding, and then admits a teammate", version => {
    dir = mkdtempSync(join(tmpdir(), "so-v72-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    const alex = addApprover(store, "alex", NOW);
    if (!alex.ok) throw new Error("alex fixture");
    expect(addApprover(store, "sam", NOW, { name: "alex", token: alex.token }).ok).toBe(true);
    expect(pairAs("alex", "4242")).toMatchObject({ ok: true });
    store.close(); store = undefined;
    const old = new DatabaseSync(file);
    old.exec("DROP INDEX IF EXISTS telegram_binding_live_user");
    old.exec("CREATE UNIQUE INDEX telegram_binding_live ON telegram_binding (bot_id) WHERE revoked_at IS NULL");
    old.prepare("UPDATE schema_version SET version = ?").run(version);
    const before = old.prepare("SELECT * FROM telegram_binding ORDER BY id").all();
    old.close();
    store = openStore(file);
    expect(SCHEMA_VERSION).toBe(72);
    expect(store.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    const indexes = store.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'telegram_binding'").all().map(row => String(row["name"]));
    expect(indexes).toContain("telegram_binding_live_user");
    expect(indexes).not.toContain("telegram_binding_live");
    expect(store.handle.prepare("SELECT * FROM telegram_binding ORDER BY id").all()).toEqual(before);
    expect(store.liveTelegramBindings(BOT).map(one => one.approver)).toEqual(["alex"]);
    // The rule the index now enforces: a second person pairs; the same person cannot pair twice.
    expect(pairAs("sam", "8800").ok).toBe(true);
    expect(pairAs("alex", "4242")).toMatchObject({ ok: false, reason: "already-bound" });
    expect(store.liveTelegramBindings(BOT).map(one => one.approver)).toEqual(["alex", "sam"]);
    store.close(); store = openStore(file);
    expect(store.liveTelegramBindings(BOT)).toHaveLength(2);
  });
});
