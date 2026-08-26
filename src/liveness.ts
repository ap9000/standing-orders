/**
 * Attended-liveness semantics (Parity II Phase 1, S3) — the ONE definition
 * every attended feature consumes. A browser proves presence only by
 * RENEWING a heartbeat; absence is inferred only from renewal ceasing,
 * never from observing a tab close (which is not reliably observable).
 * Renewal can extend nothing past an absolute expiry and can never mint
 * or broaden authority — it only keeps an already-signed authorization
 * usable (strategy rulings 1c/12).
 *
 * The state contract, exact (spec finding 11/18):
 * - "expired" iff now >= absoluteExpiryAt — checked FIRST; renewal is
 *   irrelevant past the absolute wall.
 * - a null beat (never renewed) is "lapsed".
 * - a FUTURE beat is "lapsed": strict means strict — a clock that claims
 *   tomorrow proves nothing about presence now.
 * - "live"  iff now - lastBeatAt <= 20s (one 15s beat + 5s jitter).
 * - "grace" iff now - lastBeatAt <= 45s (one missed beat, forgiven —
 *   background-tab throttling survives grace, not live).
 * - otherwise "lapsed".
 *
 * Session COOKIE lifetimes (12h idle / 7d absolute in serve.ts) are a
 * different thing and are untouched by all of this.
 */

export const BEAT_MS = 15_000;
/** live = one beat plus jitter. */
export const LIVE_MS = 20_000;
/** grace = one whole missed beat beyond live, forgiven. */
export const GRACE_MS = 45_000;

export type AttendedLiveness = "live" | "grace" | "lapsed" | "expired";

export function attendedLivenessState(
  lastBeatAt: number | null,
  now: number,
  absoluteExpiryAt: number,
): AttendedLiveness {
  if (now >= absoluteExpiryAt) return "expired";
  if (lastBeatAt === null) return "lapsed";
  if (lastBeatAt > now) return "lapsed";
  const age = now - lastBeatAt;
  if (age <= LIVE_MS) return "live";
  if (age <= GRACE_MS) return "grace";
  return "lapsed";
}
