/**
 * The attended-liveness contract, boundary-exact (foundations S3): the
 * equalities at 20s, 45s, and the absolute expiry are the contract, not
 * an accident of implementation.
 */

import { describe, test, expect } from "vitest";
import { attendedLivenessState, BEAT_MS, LIVE_MS, GRACE_MS } from "./liveness.js";

describe("attended liveness", () => {
  const T = 1_000_000_000;
  const EXPIRY = T + 3_600_000;

  test("the constants are the documented contract", () => {
    expect(BEAT_MS).toBe(15_000);
    expect(LIVE_MS).toBe(20_000);
    expect(GRACE_MS).toBe(45_000);
  });

  test("expiry is checked FIRST — a fresh beat past the wall is still expired", () => {
    expect(attendedLivenessState(EXPIRY - 1, EXPIRY, EXPIRY)).toBe("expired");
    expect(attendedLivenessState(EXPIRY, EXPIRY + 1, EXPIRY)).toBe("expired");
    // one millisecond before the wall, a fresh beat is live
    expect(attendedLivenessState(EXPIRY - 2, EXPIRY - 1, EXPIRY)).toBe("live");
  });

  test("never-beaten is lapsed; a FUTURE beat is lapsed, not clamped", () => {
    expect(attendedLivenessState(null, T, EXPIRY)).toBe("lapsed");
    expect(attendedLivenessState(T + 1, T, EXPIRY)).toBe("lapsed");
  });

  test("the 20s and 45s boundaries are inclusive exactly as written", () => {
    expect(attendedLivenessState(T, T + LIVE_MS, EXPIRY)).toBe("live");
    expect(attendedLivenessState(T, T + LIVE_MS + 1, EXPIRY)).toBe("grace");
    expect(attendedLivenessState(T, T + GRACE_MS, EXPIRY)).toBe("grace");
    expect(attendedLivenessState(T, T + GRACE_MS + 1, EXPIRY)).toBe("lapsed");
  });

  test("a beat at now exactly is live", () => {
    expect(attendedLivenessState(T, T, EXPIRY)).toBe("live");
  });
});
