import { describe, test, expect } from "vitest";
import { openStore } from "./store.js";
import { presetTerms, modeTermsJson, modeDigestOf, modeTermsFromJson, modeWords, type ModeTerms } from "./modes.js";
import { fileAndSealUnderMode, addApprover } from "./scope.js";

const T0 = new Date("2026-08-27T12:00:00.000Z");
const expiry = new Date(T0.getTime() + 24 * 60 * 60_000).toISOString();

describe("mode terms: digest, rehydration, words", () => {
  test("presets round-trip stably; the digest binds every term", () => {
    for (const name of ["standard", "hands-off"] as const) {
      const terms = presetTerms(name, expiry);
      const back = modeTermsFromJson(modeTermsJson(terms));
      expect(back).toEqual(terms);
      expect(modeDigestOf(back as ModeTerms)).toBe(modeDigestOf(terms));
    }
  });

  test("a flipped term moves the digest", () => {
    const base = presetTerms("standard", expiry);
    expect(modeDigestOf({ ...base, autoApproveFiling: true })).not.toBe(modeDigestOf(base));
    expect(modeDigestOf({ ...base, publication: "automerge" })).not.toBe(modeDigestOf(base));
  });

  test("rehydration is strict — a foreign publication or bad budget is null", () => {
    const loose = JSON.parse(modeTermsJson(presetTerms("standard", expiry))) as Record<string, unknown>;
    loose["publication"] = "yolo-merge";
    expect(modeTermsFromJson(JSON.stringify(loose))).toBeNull();
  });

  test("hands-off words carry the reversal sentence verbatim", () => {
    const words = modeWords(presetTerms("hands-off", expiry)).join(" ");
    expect(words).toContain("your signed-in browser session becomes a spend credential for this repository");
    expect(words).toContain("FULL permissions");
  });
});

describe("the mode store roads: sign, active, revoke, renew, rails", () => {
  const seed = () => {
    const store = openStore(":memory:");
    const alex = addApprover(store, "alex", T0);
    if (!alex.ok) throw new Error("bootstrap");
    return { store, alexToken: alex.token };
  };

  const sign = (store: ReturnType<typeof openStore>, repo: string, name: "standard" | "hands-off", by = "alex") => {
    const terms = presetTerms(name, new Date(T0.getTime() + 24 * 60 * 60_000).toISOString());
    return store.signMode(
      { repo, name, termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: by, absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
      T0,
    );
  };

  test("sign then active; revoke falls back to locked", () => {
    const { store } = seed();
    sign(store, "/repo", "hands-off");
    expect(store.activeMode("/repo", T0)?.name).toBe("hands-off");
    expect(store.revokeMode("/repo", "alex", "operator", T0)).toBe(true);
    expect(store.activeMode("/repo", T0)).toBeNull();
    store.close();
  });

  test("renewal closes the predecessor; one live per repo", () => {
    const { store } = seed();
    sign(store, "/repo", "standard");
    sign(store, "/repo", "hands-off");
    expect(store.activeMode("/repo", T0)?.name).toBe("hands-off");
    const rows = store.raw().prepare("SELECT COUNT(*) AS n FROM operating_mode WHERE repo = '/repo' AND revoked_at IS NULL").get();
    expect(Number(rows?.["n"])).toBe(1);
    store.close();
  });

  test("expiry closes the mode durably on the next read", () => {
    const { store } = seed();
    sign(store, "/repo", "standard");
    const past = new Date(T0.getTime() + 2 * 24 * 60 * 60_000);
    expect(store.activeMode("/repo", past)).toBeNull();
    // durably closed — the partial unique is free for a replacement
    expect(store.raw().prepare("SELECT COUNT(*) AS n FROM operating_mode WHERE repo = '/repo' AND revoked_at IS NULL").get()?.["n"]).toBe(0);
    store.close();
  });

  test("a revoked signer's mode is dead even before its own revocation", () => {
    const { store, alexToken } = seed();
    const beth = addApprover(store, "beth", T0, { name: "alex", token: alexToken });
    if (!beth.ok) throw new Error("beth");
    sign(store, "/repo", "hands-off", "beth");
    expect(store.activeMode("/repo", T0)?.signedBy).toBe("beth");
    store.raw().prepare("UPDATE approver SET revoked_at = ? WHERE name = 'beth'").run(T0.toISOString());
    expect(store.activeMode("/repo", T0)).toBeNull(); // D7's belt
    store.close();
  });

  test("the run rail reserves atomically; the cap refuses the excess", () => {
    const { store } = seed();
    const terms: ModeTerms = { ...presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), dailyRunCap: 2 };
    store.signMode(
      { repo: "/repo", name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: "notify" },
      T0,
    );
    expect(store.reserveModeRail("/repo", 1, T0)).toMatchObject({ ok: true });
    expect(store.reserveModeRail("/repo", 1, T0)).toMatchObject({ ok: true });
    expect(store.reserveModeRail("/repo", 1, T0)).toMatchObject({ ok: false, rail: "daily-runs" });
    // a different UTC day is a fresh counter
    expect(store.reserveModeRail("/repo", 1, new Date(T0.getTime() + 24 * 60 * 60_000))).toMatchObject({ ok: true });
    store.close();
  });

  test("no mode = the rail is a no-op", () => {
    const { store } = seed();
    expect(store.reserveModeRail("/repo", 5, T0)).toMatchObject({ ok: true });
    store.close();
  });

  test("fileAndSealUnderMode: signer + hands-off auto-approves atomically; a non-signer refuses", () => {
    const { store, alexToken } = seed();
    const beth = addApprover(store, "beth", T0, { name: "alex", token: alexToken });
    if (!beth.ok) throw new Error("beth");
    store.createTask({ id: "t-auto", title: "auto" }, T0);
    sign(store, "/repo", "hands-off", "alex");
    const sealed = fileAndSealUnderMode(store, {
      taskId: "t-auto", goal: "add a guard", now: T0, repo: "/repo", actor: "alex",
    });
    expect(sealed.ok).toBe(true);
    const scope = store.getScope("t-auto");
    expect(scope?.approvedBy).toBe("alex");
    expect(store.raw().prepare("SELECT approval_basis FROM task_scope WHERE task_id = 't-auto'").get()?.["approval_basis"]).toBe("mode");
    // beth is not the signer — her filing is not auto-approved
    store.createTask({ id: "t-beth", title: "b" }, T0);
    const refused = fileAndSealUnderMode(store, { taskId: "t-beth", goal: "x", now: T0, repo: "/repo", actor: "beth" });
    expect(refused).toMatchObject({ ok: false, reason: "not-signer" });
    store.close();
  });

  test("a standard mode does NOT auto-approve (autoApproveFiling off)", () => {
    const { store } = seed();
    store.createTask({ id: "t-std", title: "s" }, T0);
    sign(store, "/repo", "standard");
    const refused = fileAndSealUnderMode(store, { taskId: "t-std", goal: "x", now: T0, repo: "/repo", actor: "alex" });
    expect(refused).toMatchObject({ ok: false, reason: "not-covered" });
    store.close();
  });
});
