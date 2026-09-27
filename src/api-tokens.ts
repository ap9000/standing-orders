/**
 * API tokens (v101): what scripts and CI use instead of a password on each
 * request. A token belongs to one person, reads or acts (never more than the
 * person may), always expires (a year at most), is shown once, and only its
 * hash is kept. `Authorization: Bearer so_<id>_<secret>`.
 *
 * A token never passes a step-up: approvals and other password ceremonies
 * stay a person's act in the console.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type TokenAccess = "read" | "act";
export const TOKEN_DAYS = [30, 90, 365] as const;
const SHAPE = /^so_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;

export function mintApiToken(): { id: string; secret: string; token: string; hash: string } {
  const id = randomBytes(6).toString("hex"), secret = randomBytes(32).toString("base64url");
  return { id, secret, token: `so_${id}_${secret}`, hash: hashSecret(secret) };
}

export const hashSecret = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");

/** The id and secret of something shaped like a token, or null. */
export function parseApiToken(presented: string): { id: string; secret: string } | null {
  const match = SHAPE.exec(presented);
  return match === null ? null : { id: match[1]!, secret: match[2]! };
}

/** Whether the secret is the one whose hash was kept, in constant time. */
export function secretMatches(secret: string, keptHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex"), b = Buffer.from(keptHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
