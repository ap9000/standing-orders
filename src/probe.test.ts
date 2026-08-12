import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Capability, type Store } from "./store.js";
import { probeOne, probeRepo, isVerified, PROBE_TIMEOUT_MS } from "./probe.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-11T22:00:00.000Z");

describe("probes", () => {
  let store: Store;

  const cap = (over: Partial<Capability> = {}): Capability => ({
    repo: "/code/thing",
    kind: "env",
    name: "SUPABASE_KEY",
    probe: 'test -n "$SUPABASE_KEY"',
    status: "unprobed",
    addedBy: "alex",
    createdAt: T0.toISOString(),
    lastVerifiedAt: null,
    verifiedBy: null,
    lastResult: null,
    expiresAt: null,
    ...over,
  });

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("a probe that exits 0 verifies, stamped with when and by whom", async () => {
    store.saveCapability(cap());

    const outcome = await probeOne(store, cap(), "builder-1", T0, async () => ({ ...OK }));

    expect(outcome).toEqual({ kind: "env", name: "SUPABASE_KEY", status: "verified" });
    expect(store.capabilityNamed("/code/thing", "SUPABASE_KEY")).toMatchObject({
      status: "verified",
      lastVerifiedAt: T0.toISOString(),
      verifiedBy: "builder-1",
    });
  });

  test("runs the probe through a real shell, in the repo", async () => {
    store.saveCapability(cap());
    let asked: { file: string; args: readonly string[]; cwd?: string } | undefined;

    await probeOne(store, cap(), "builder-1", T0, async (file, args, options) => {
      asked = { file, args, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) };
      return { ...OK };
    });

    expect(asked).toEqual({
      file: "sh",
      args: ["-lc", 'test -n "$SUPABASE_KEY"'],
      cwd: "/code/thing",
    });
  });

  test("failure keeps the probe's own words, not just a bit", async () => {
    store.saveCapability(cap());

    const outcome = await probeOne(store, cap(), "builder-1", T0, async () => ({
      ...OK,
      code: 1,
      stderr: "not logged in\nrun gh auth login",
    }));

    expect(outcome).toMatchObject({ status: "failed", detail: "exit 1 — not logged in" });
    expect(store.capabilityNamed("/code/thing", "SUPABASE_KEY")).toMatchObject({
      status: "failed",
      lastResult: "exit 1 — not logged in",
    });
  });

  test("a timeout is named as one", async () => {
    store.saveCapability(cap());

    const outcome = await probeOne(store, cap(), "builder-1", T0, async () => ({
      ...OK,
      code: 124,
      timedOut: true,
    }));

    expect(outcome).toMatchObject({
      status: "failed",
      detail: `timed out after ${PROBE_TIMEOUT_MS / 1000}s`,
    });
  });

  test("a probe-less capability stays unprobed — nobody may vouch by hand", async () => {
    const voiceless = cap({ probe: null, kind: "mcp", name: "supabase" });
    store.saveCapability(voiceless);

    const outcome = await probeOne(store, voiceless, "builder-1", T0, async () => {
      throw new Error("must not run anything");
    });

    expect(outcome).toMatchObject({ status: "unprobed" });
    expect(store.capabilityNamed("/code/thing", "supabase")?.status).toBe("unprobed");
  });

  test("probeRepo asks every capability of the repo, or only the named ones", async () => {
    store.saveCapability(cap());
    store.saveCapability(cap({ kind: "cli", name: "gh", probe: "gh auth status" }));

    const all = await probeRepo(store, "/code/thing", "builder-1", T0, {
      runner: async () => ({ ...OK }),
    });
    expect(all).toHaveLength(2);

    const some = await probeRepo(store, "/code/thing", "builder-1", T0, {
      runner: async () => ({ ...OK }),
      only: new Set(["cli:gh"]),
    });
    expect(some).toEqual([{ kind: "cli", name: "gh", status: "verified" }]);
  });

  test("a verification that expired is not a verification", () => {
    const fresh = cap({ status: "verified", expiresAt: new Date(T0.getTime() + 60_000).toISOString() });
    const stale = cap({ status: "verified", expiresAt: new Date(T0.getTime() - 60_000).toISOString() });
    const forever = cap({ status: "verified", expiresAt: null });

    expect(isVerified(fresh, T0)).toBe(true);
    expect(isVerified(stale, T0)).toBe(false);
    expect(isVerified(forever, T0)).toBe(true);
  });
});
