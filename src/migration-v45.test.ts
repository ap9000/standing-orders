/**
 * Schema v45 adds one nullable recovery binding to verification authority.
 * Existing approvals must keep both their digest and their one-shot meaning;
 * only a newly approved row may opt into replaying one exact setup digest.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";

const T0 = new Date("2026-09-10T12:00:00.000Z");

describe("schema v45: verification self-healing is explicit authority", () => {
  let dir: string | undefined;
  let store: Store | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("ordinary rows default to no recovery, while a setup binding changes the digest", () => {
    store = openStore(":memory:");
    const ordinary = store.setVerifyCommand(
      { repo: "/repo/app", command: "npm test", timeoutMs: 120_000, approvedBy: "alex" },
      T0,
    );
    expect(ordinary.recoverySetupDigest).toBeNull();

    const setup = store.setWorktreeSetup(
      { repo: "/repo/app", command: "npm ci", timeoutMs: 300_000, approvedBy: "alex" },
      T0,
    );
    const recovery = store.setVerifyCommand(
      {
        repo: "/repo/app",
        command: "npm test",
        timeoutMs: 120_000,
        approvedBy: "alex",
        recoverySetupDigest: setup.digest,
      },
      T0,
    );

    expect(recovery.recoverySetupDigest).toBe(setup.digest);
    expect(recovery.digest).not.toBe(ordinary.digest);
    expect(store.liveVerifyCommand("/repo/app")).toMatchObject({
      digest: recovery.digest,
      recoverySetupDigest: setup.digest,
    });
  });

  test("a v44 verification approval migrates with its digest unchanged and recovery disabled", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v45-"));
    const file = join(dir, "orders.db");
    store = openStore(file);
    const legacy = store.setVerifyCommand(
      { repo: "/repo/legacy", command: "npm test", timeoutMs: 120_000, approvedBy: "alex" },
      T0,
    );
    store.raw().exec("ALTER TABLE verify_command DROP COLUMN recovery_setup_digest");
    store.raw().prepare("UPDATE schema_version SET version = 44").run();
    store.close();
    store = null;

    store = openStore(file);

    expect(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(store.liveVerifyCommand("/repo/legacy")).toMatchObject({
      digest: legacy.digest,
      recoverySetupDigest: null,
    });
  });
});
