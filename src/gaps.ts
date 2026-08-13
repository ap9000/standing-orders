/**
 * Gaps: what the machine lacks, ranked by what filling it would free (§6).
 *
 * One computation, shared — the CLI brief, `standing-orders gaps`, and the web
 * console all show the same ranking because they call the same function.
 * A second copy would only learn to disagree with this one.
 */

import { isVerified } from "./probe.js";
import { approvalOf } from "./scope.js";
import { parseCapabilityKey, type Capability, type Store } from "./store.js";

/** One thing the machine lacks, and what filling it would actually free. */
export type Gap = {
  key: string;
  repo: string;
  /** Why it is a gap, in the capability's own words. */
  state: string;
  /** Tasks this gap alone is holding back — fill it and they start. */
  unblocks: string[];
  /** Tasks waiting on this *and* something else — filling this is not enough. */
  alsoBlocks: string[];
  /** How to prove it filled. */
  verify: string;
  instructions: string;
};

/**
 * What is missing, ranked by how many tasks it unblocks — never
 * alphabetically (§6). The count is honest in the way that matters at 9am:
 * a task waiting on two gaps starts when *both* fill, so it counts toward
 * neither gap's `unblocks` and both gaps' `alsoBlocks`. A ranking that
 * counted it twice would send the operator to fill the wrong gap first.
 *
 * Derived, not stored: every field here is a join over capabilities and the
 * ready set, and a stored copy would only learn to disagree with them.
 */
export function computeGaps(store: Store, repo: string, now: Date): Gap[] {
  const gaps = new Map<string, Gap>();

  const claim = (key: string, state: string, verify: string, kind: string): Gap => {
    const existing = gaps.get(key);
    if (existing !== undefined) return existing;
    const made: Gap = {
      key,
      repo,
      state,
      unblocks: [],
      alsoBlocks: [],
      verify,
      instructions: adviceFor(kind),
    };
    gaps.set(key, made);
    return made;
  };

  // Unverified capabilities are gaps even before anything requires them —
  // visible early is the point. Requirements referencing capabilities nobody
  // recorded become gaps the moment a task names them.
  for (const capability of store.listCapabilities(repo)) {
    if (isVerified(capability, now)) continue;
    claim(
      `${capability.kind}:${capability.name}`,
      describeCapability(capability, now),
      capability.probe ?? "no probe recorded — nothing can verify it",
      capability.kind,
    );
  }

  for (const ref of store.listReady(now)) {
    if (ref.repo !== null && ref.repo !== repo) continue;
    if (!approvalOf(store.getScope(ref.externalId)).approved) continue;
    if (ref.capabilityRequirements.length === 0) continue;

    const unmet: string[] = [];
    for (const key of ref.capabilityRequirements) {
      const parsed = parseCapabilityKey(key);
      if (parsed === null) continue;
      const taskRepo = ref.repo ?? repo;
      const capability = store.getCapability(taskRepo, parsed.kind, parsed.name);
      if (capability === null) {
        unmet.push(key);
        claim(key, `unrecorded for ${taskRepo}`, "standing-orders cap add, then cap probe", parsed.kind);
      } else if (!isVerified(capability, now)) {
        unmet.push(key);
      }
    }

    for (const key of unmet) {
      const gap = gaps.get(key);
      if (gap === undefined) continue;
      (unmet.length === 1 ? gap.unblocks : gap.alsoBlocks).push(ref.externalId);
    }
  }

  return [...gaps.values()].sort(
    (a, b) => b.unblocks.length - a.unblocks.length || a.key.localeCompare(b.key),
  );
}

export function adviceFor(kind: string): string {
  switch (kind) {
    case "env":
      return "supply the value in the runner's environment — shell profile or keychain; values never enter the control plane";
    case "cli":
      return "install it or log it in, then re-probe";
    case "mcp":
      return "start or configure the server, then re-probe";
    case "ci":
      return "this lives in CI; supply a local equivalent only if local tasks need it";
    default:
      return "supply it where the runner can see it, then re-probe";
  }
}

export function describeCapability(capability: Capability, now: Date): string {
  if (isVerified(capability, now)) {
    return `verified ${capability.lastVerifiedAt} by ${capability.verifiedBy ?? "unknown"}`;
  }
  if (capability.status === "verified") return `verified, but expired ${capability.expiresAt}`;
  if (capability.status === "failed") return `failed ${capability.lastResult ?? ""}`.trimEnd();
  return capability.probe === null ? "unprobed — no probe, nothing can vouch" : "unprobed";
}
