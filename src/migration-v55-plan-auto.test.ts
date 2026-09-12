import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION } from "./store.js";
import { hashPassword } from "./scope.js";
import { modeTermsFromJson, presetTerms } from "./modes.js";

test("v54 keeps scopes, access grants and signed mode bytes; it grants no planner authority", () => {
  const root = mkdtempSync(join(tmpdir(), "so-v55-migration-"));
  const file = join(root, "state.sqlite");
  try {
    const store = openStore(file);
    const now = new Date("2026-09-12T10:00:00Z");
    store.saveApprover("owner", hashPassword("fixture-password"), now);
    const invited = store.mintInvite("viewer", "owner", now, undefined, [root]);
    store.consumeInviteAndCreateAccount({ tokenValue: invited.token, name: "member", credentialHash: hashPassword("fixture-password") }, now);
    const legacy = { ...presetTerms("hands-off", "2026-09-13T10:00:00Z"), reviewAuto: false } as Record<string, unknown>;
    delete legacy.planAuto;
    store.signMode({ repo: root, name: "hands-off", termsJson: JSON.stringify(legacy), digest: "legacy-digest", signedBy: "owner", absoluteExpiry: String(legacy.absoluteExpiry), publication: "notify" }, now);
    store.close();
    const old = new DatabaseSync(file);
    old.exec("DROP TABLE plan_authorization; UPDATE schema_version SET version=54;");
    const accounts = old.prepare("SELECT * FROM approver").all();
    const modes = old.prepare("SELECT * FROM operating_mode").all();
    const ledger = old.prepare("SELECT * FROM action_ledger").all();
    old.close();
    const upgraded = openStore(file);
    expect(upgraded.raw().prepare("SELECT version FROM schema_version").get()?.version).toBe(SCHEMA_VERSION);
    expect(upgraded.raw().prepare("SELECT * FROM approver").all()).toEqual(accounts);
    expect(upgraded.raw().prepare("SELECT * FROM operating_mode").all()).toEqual(modes);
    expect(upgraded.raw().prepare("SELECT * FROM action_ledger").all()).toEqual(ledger);
    expect(upgraded.raw().prepare("SELECT * FROM plan_authorization").all()).toEqual([]);
    expect(modeTermsFromJson(String(modes[0]!.terms_json))).toMatchObject({ planAuto: false, reviewAuto: false });
    upgraded.close();
    const before = readFileSync(file); openStore(file).close(); expect(readFileSync(file)).toEqual(before);
    const damaged = new DatabaseSync(file);
    damaged.exec("UPDATE schema_version SET version=54; ALTER TABLE approver DROP COLUMN projects_json");
    damaged.close();
    const broken = readFileSync(file);
    expect(() => openStore(file)).toThrow("refusing to widen access");
    expect(readFileSync(file)).toEqual(broken);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
