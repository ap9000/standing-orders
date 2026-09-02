/**
 * The branded approver principal (mate arc, ruling 3).
 *
 * Every act the mate proposes and every confirmation an operator taps
 * runs under a principal that PROVES it was authenticated — a password
 * ceremony, or a cookie session the edge already proved (csrf, role) and
 * this module re-proves against the approver row. The maker is
 * module-private: no caller can build one from a name string, the way no
 * caller can build a VerifiedCoordinator. The ceiling rides on it — the
 * admitted repos and their digest — so a principal minted on one surface
 * can never read or confirm on another's wider or narrower view.
 */
import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { authenticateAccount } from "./scope.js";

declare const verifiedApproverBrand: unique symbol;

export type VerifiedApprover = {
  readonly [verifiedApproverBrand]: true;
  readonly name: string;
  /** The approver row's credential generation at mint; re-proved on every use. */
  readonly generation: number;
  /** The admitted repos, in the surface's own order — `r1..rN` maps by index. */
  readonly repos: readonly string[];
  readonly ceilingDigest: string;
};

/** The chat ceiling digest (fleet chat v13): sorted admitted repos, hashed. */
export function ceilingDigestOf(repos: readonly string[]): string {
  return createHash("sha256").update([...repos].sort().join("\n")).digest("hex");
}

function verified(row: { name: string; generation: number; repos: readonly string[] }): VerifiedApprover {
  return {
    name: row.name,
    generation: row.generation,
    repos: [...row.repos],
    ceilingDigest: ceilingDigestOf(row.repos),
  } as unknown as VerifiedApprover;
}

export type PrincipalRefusal = { ok: false; reason: "no-approvers" | "unknown" | "revoked" | "not-an-approver" | "generation" };

/** The password road: the CLI, and any ceremony that retypes it. */
export function verifyApproverByPassword(
  store: Store,
  name: string,
  token: string,
  repos: readonly string[],
): { ok: true; who: VerifiedApprover } | PrincipalRefusal {
  const account = authenticateAccount(store, name, token);
  if (!account.ok) return { ok: false, reason: account.reason };
  if (account.role !== "approver") return { ok: false, reason: "not-an-approver" };
  return { ok: true, who: verified({ name, generation: account.generation, repos }) };
}

/**
 * The session road: the edge has already proved the cookie, csrf, and the
 * origin; this re-proves the ROW — present, an approver, not revoked — and
 * binds the generation so a later credential rotation ends the principal.
 */
export function verifyApproverStanding(
  store: Store,
  name: string,
  repos: readonly string[],
): { ok: true; who: VerifiedApprover } | PrincipalRefusal {
  const account = store.accountOf(name);
  if (account === null) return { ok: false, reason: "unknown" };
  if (account.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (account.role !== "approver") return { ok: false, reason: "not-an-approver" };
  return { ok: true, who: verified({ name, generation: account.generation, repos }) };
}

/** Re-prove a principal minted earlier: same row, same generation, still an approver. */
export function reproveApprover(store: Store, who: VerifiedApprover): { ok: true } | PrincipalRefusal {
  const account = store.accountOf(who.name);
  if (account === null) return { ok: false, reason: "unknown" };
  if (account.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (account.role !== "approver") return { ok: false, reason: "not-an-approver" };
  if (account.generation !== who.generation) return { ok: false, reason: "generation" };
  return { ok: true };
}
