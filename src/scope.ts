/**
 * What a task is allowed to become, agreed before anything builds it.
 *
 * The gap this closes is the one an operator notices immediately and a
 * scheduler never does: a task called "fix the payouts flow" is a sentence, and
 * an agent handed it at 3am will decide for itself what that means. It might
 * mean a two-line guard. It might mean rewriting the billing model. Nobody
 * agreed to the second one, and by morning it is a diff.
 *
 * So a scope is written down, and a human opts in to it, and the builder will
 * not run on a task where that has not happened. Not a code review after the
 * fact — an agreement about the goal, before the work.
 *
 * **Approval binds to the words that were approved.** The record keeps a digest
 * of the scope text, and approval stores the digest it saw. Rewriting the scope
 * afterwards does not carry the approval with it; the digests stop matching and
 * the task is unapproved again. Without that, "approved" would mean "was
 * approved once, in some form" — which is exactly the loophole an agent editing
 * its own brief would walk through.
 *
 * The scope is deliberately three plain fields rather than a template. What is
 * the goal, what is explicitly not in it, and which paths it expects to touch.
 * An operator reading that at a glance can tell whether they agree, and that
 * glance is the whole safety property.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { hasForbiddenControls } from "./decision.js";
import type { Store, Mutation } from "./store.js";
import type { QualityMode } from "./quality.js";
import {
  NO_READINESS,
  isRiskLevel,
  projectRoute,
  routeDigestOf,
  routeFromJson,
  routeWords,
  type PhaseRoute,
  type ReadinessLookup,
  type RiskLevel,
} from "./phase-routing.js";

/** Same shape as a runner's credential, for the same reasons. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A person's chosen password gets a real KDF. Bare sha256 is fine for the
 * minted 256-bit tokens — nothing brute-forces that space — but a password a
 * human picked lives in a much smaller one, so it is salted and stretched
 * (scrypt), and the stored string names its own scheme so both generations
 * of credential verify side by side.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/** Verify a presented secret against a stored hash of either scheme. */
export function verifyCredential(stored: string, presented: string): boolean {
  if (stored.startsWith("scrypt$")) {
    const [, salt, hex] = stored.split("$");
    if (salt === undefined || hex === undefined) return false;
    const known = Buffer.from(hex, "hex");
    const candidate = scryptSync(presented, salt, 32);
    return known.length === candidate.length && timingSafeEqual(known, candidate);
  }
  return sameDigest(stored, hashToken(presented));
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The execution profile (Parity II foundations, findings 1/2/13/14/22):
 * WHAT RUNS, bound into what the operator signs. A discriminated union —
 * each variant asserts only what its provider actually supports, with the
 * EFFECTIVE constants the argv will carry, never aspirations. The model
 * is always an exact string and always emitted on the argv: nothing in an
 * approved profile is left for later resolution to decide (ruling 10).
 * providerVersion and resolvedFrom are PROVENANCE and live outside these
 * shapes (finding 20) — they never enter a digest.
 */
export const CLAUDE_LIMITS = {
  // The activity watchdog is the real safety rail. Keep a very high turn
  // breaker only for a pathological loop; ordinary long-horizon work should
  // finish, checkpoint, or park long before it can reach this number.
  maxTurns: 1_000,
  repairMaxTurns: 4,
  timeoutSeconds: 1_200,
  repairTimeoutSeconds: 300,
} as const;
export const CODEX_SHAPED_LIMITS = {
  timeoutSeconds: 1200,
  repairTimeoutSeconds: 300,
} as const;
export const GEMINI_LIMITS = {
  timeoutSeconds: 1200,
  repairTimeoutSeconds: 300,
} as const;

export type ClaudeProfile = {
  provider: "claude";
  /** The exact model string the argv carries. Never empty, never "default". */
  model: string;
  /** Claude's real argv semantic. `auto` is the safe unattended posture:
   * Claude's classifier allows routine project work and stops risky acts.
   * `acceptEdits` remains readable for approvals created before auto mode;
   * bypass is still a separate, explicitly signed escalation. */
  permissionArgv: "auto" | "acceptEdits" | "bypassPermissions";
  maxTurns: number;
  repairMaxTurns: number;
  timeoutSeconds: number;
  /** Absent on legacy approvals, where timeoutSeconds remains an absolute
   * wall clock. New approvals bind an activity watchdog instead. */
  timeoutKind?: "idle";
  repairTimeoutSeconds: number;
  /** Exact model for repairs, or the stable literal "inherit" (= the
   * build model, which is itself exact). */
  repairModel: string;
};

export type CodexShapedProfile = {
  provider: "codex" | "openrouter";
  model: string;
  /** Codex's real constraint surface. Full access is rendered with the
   * CLI's combined --dangerously-bypass-approvals-and-sandbox switch; the
   * value here records the resulting sandbox posture in the signed profile. */
  sandboxMode: "workspace-write" | "danger-full-access";
  /** The tool has no argv turn limit. New approvals use an inactivity
   * watchdog; legacy approvals retain their signed wall-clock bound. */
  maxTurns: "unsupported";
  repairMaxTurns: "unsupported";
  timeoutSeconds: number;
  timeoutKind?: "idle";
  repairTimeoutSeconds: number;
  repairModel: string;
};

export type GeminiProfile = {
  provider: "gemini";
  model: string;
  /** Gemini's real dial (`--approval-mode`): auto_edit auto-approves edit
   * tools only (the acceptEdits parallel); yolo auto-approves everything
   * and files only where claude files bypassPermissions. `default` and
   * `plan` are not profile values — headless `default` just fails tools,
   * and `plan` is read-only while the protocol requires workspace writes. */
  approvalArgv: "auto_edit" | "yolo";
  /** No argv turn bound exists (v0.57.0 audit); new approvals use an
   * inactivity watchdog, while legacy approvals keep their signed clock. */
  maxTurns: "unsupported";
  repairMaxTurns: "unsupported";
  timeoutSeconds: number;
  timeoutKind?: "idle";
  repairTimeoutSeconds: number;
  repairModel: string;
};

export type ExecutionProfile = ClaudeProfile | CodexShapedProfile | GeminiProfile;

/** The durable unattended permission choices exposed by the console. The
 * provider-specific argv is still what gets sealed into an approval; this
 * small cross-provider type is only the operator-facing policy. */
export type UnattendedPermissionMode = "auto" | "bypassPermissions";

export const PROFILE_DIGEST_VERSION = 2;

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The stored snapshot bytes: version embedded IN the snapshot (finding 17). */
export function canonicalProfileJson(profile: ExecutionProfile): string {
  return canonicalJson({ digestVersion: PROFILE_DIGEST_VERSION, profile });
}

/** sha256 over a domain-separated canonical encoding, truncated to the
 * same 128 bits every other safety digest here uses (finding 21). */
export function profileDigestOf(profile: ExecutionProfile): string {
  return createHash("sha256")
    .update(`standing-orders:profile:${canonicalProfileJson(profile)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

// ---- fallback chains (v30) ------------------------------------------------
// The version this build stamps into a chain snapshot AND folds into the
// chain digest. Bumping it is a re-attestation, never a silent change.
export const CHAIN_DIGEST_VERSION = 1;

/** One entry of an approved fallback chain: the WHOLE execution profile
 * (so a claude->codex switch cannot inherit one provider's repair config)
 * and the auth mode it runs under. Order is authority. */
export type ChainEntry = {
  profile: ExecutionProfile;
  authMode: "subscription" | "api-key";
};

/** The stored snapshot bytes for a chain: the version rides IN the
 * snapshot, exactly like a single profile's. */
export function canonicalChainJson(entries: readonly ChainEntry[]): string {
  return canonicalJson({ digestVersion: CHAIN_DIGEST_VERSION, chain: entries });
}

/** sha256 over a domain-separated canonical chain encoding — a DIFFERENT
 * domain from a single profile ("standing-orders:chain:" vs
 * ":profile:"), so a chain digest can never collide with a profile
 * digest, truncated to the same 128 bits. */
export function chainDigestOf(entries: readonly ChainEntry[]): string {
  return createHash("sha256")
    .update(`standing-orders:chain:v${CHAIN_DIGEST_VERSION}:${canonicalChainJson(entries)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * One chain entry's BINDING digest (E3d): the profile digest + auth mode
 * under their own domain. A run row pins this at admission (or base-cycle
 * open), and the dispatch proof re-derives it from the approved chain at
 * the run's index — so nothing downstream can swap WHICH entry a run
 * spends as, in model or in credential.
 */
export function entryDigestOf(entry: ChainEntry): string {
  return createHash("sha256")
    .update(
      `standing-orders:chain-entry:v${CHAIN_DIGEST_VERSION}:${profileDigestOf(entry.profile)}:${entry.authMode}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

/** Strict re-hydration of a stored chain — every entry proved through the
 * single-profile rehydrator; anything unexpected is null. */
export function chainFromJson(json: string | null): ChainEntry[] | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const wrapper = parsed as { digestVersion?: unknown; chain?: unknown };
  if (wrapper.digestVersion !== CHAIN_DIGEST_VERSION) return null;
  if (!Array.isArray(wrapper.chain) || wrapper.chain.length === 0 || wrapper.chain.length > 4) return null;
  const entries: ChainEntry[] = [];
  const seen = new Set<string>();
  for (const raw of wrapper.chain) {
    if (raw === null || typeof raw !== "object") return null;
    const e = raw as { profile?: unknown; authMode?: unknown };
    if (e.authMode !== "subscription" && e.authMode !== "api-key") return null;
    // The profile rehydrates through the SAME strict path, wrapped as its
    // own canonical snapshot so profileFromJson can prove it.
    const profile = profileFromJson(canonicalProfileJson(e.profile as ExecutionProfile));
    if (profile === null) return null;
    // Duplicate exact entries are rejected (open q i): the key is the
    // profile digest + auth mode.
    const key = `${profileDigestOf(profile)}:${e.authMode}`;
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({ profile, authMode: e.authMode });
  }
  return entries;
}

/** Strict re-hydration of a stored snapshot — every field type-proved;
 * anything unexpected is null, never a guess. */
export function profileFromJson(json: string | null): ExecutionProfile | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const wrapper = parsed as { digestVersion?: unknown; profile?: unknown };
  if (wrapper.digestVersion !== PROFILE_DIGEST_VERSION) return null;
  const p = wrapper.profile as Record<string, unknown> | null | undefined;
  if (p === null || p === undefined || typeof p !== "object") return null;
  const str = (v: unknown): v is string => typeof v === "string" && v !== "";
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (p["provider"] === "claude") {
    if (
      str(p["model"]) &&
      (p["permissionArgv"] === "auto" || p["permissionArgv"] === "acceptEdits" || p["permissionArgv"] === "bypassPermissions") &&
      num(p["maxTurns"]) && num(p["repairMaxTurns"]) &&
      num(p["timeoutSeconds"]) && (p["timeoutKind"] === undefined || p["timeoutKind"] === "idle") && num(p["repairTimeoutSeconds"]) &&
      str(p["repairModel"])
    ) {
      return {
        provider: "claude",
        model: p["model"],
        permissionArgv: p["permissionArgv"],
        maxTurns: p["maxTurns"],
        repairMaxTurns: p["repairMaxTurns"],
        timeoutSeconds: p["timeoutSeconds"],
        ...(p["timeoutKind"] === "idle" ? { timeoutKind: "idle" as const } : {}),
        repairTimeoutSeconds: p["repairTimeoutSeconds"],
        repairModel: p["repairModel"],
      };
    }
    return null;
  }
  if (p["provider"] === "codex" || p["provider"] === "openrouter") {
    if (
      str(p["model"]) &&
      (p["sandboxMode"] === "workspace-write" || p["sandboxMode"] === "danger-full-access") &&
      p["maxTurns"] === "unsupported" && p["repairMaxTurns"] === "unsupported" &&
      num(p["timeoutSeconds"]) && (p["timeoutKind"] === undefined || p["timeoutKind"] === "idle") && num(p["repairTimeoutSeconds"]) &&
      str(p["repairModel"])
    ) {
      return {
        provider: p["provider"],
        model: p["model"],
        sandboxMode: p["sandboxMode"],
        maxTurns: "unsupported",
        repairMaxTurns: "unsupported",
        timeoutSeconds: p["timeoutSeconds"],
        ...(p["timeoutKind"] === "idle" ? { timeoutKind: "idle" as const } : {}),
        repairTimeoutSeconds: p["repairTimeoutSeconds"],
        repairModel: p["repairModel"],
      };
    }
    return null;
  }
  if (p["provider"] === "gemini") {
    if (
      str(p["model"]) &&
      (p["approvalArgv"] === "auto_edit" || p["approvalArgv"] === "yolo") &&
      p["maxTurns"] === "unsupported" && p["repairMaxTurns"] === "unsupported" &&
      num(p["timeoutSeconds"]) && (p["timeoutKind"] === undefined || p["timeoutKind"] === "idle") && num(p["repairTimeoutSeconds"]) &&
      str(p["repairModel"])
    ) {
      return {
        provider: "gemini",
        model: p["model"],
        approvalArgv: p["approvalArgv"],
        maxTurns: "unsupported",
        repairMaxTurns: "unsupported",
        timeoutSeconds: p["timeoutSeconds"],
        ...(p["timeoutKind"] === "idle" ? { timeoutKind: "idle" as const } : {}),
        repairTimeoutSeconds: p["repairTimeoutSeconds"],
        repairModel: p["repairModel"],
      };
    }
    return null;
  }
  return null;
}

// ---- acceptance rubric (v39, Acceptance Contract v2) -----------------------
//
// The rubric an operator signs alongside the goal: what a finished build has
// to answer, by exact id, with typed references to evidence the plane itself
// captured. Every prior digest-bound field (budgetMicrousd, profile, chain)
// is additive and digests identically when absent — the rubric follows the
// same rule, so grandfathering an approval sealed before this migration is
// structural, not a special case. What makes the rubric MANDATORY is not the
// digest (which stays permissive, exactly like every field before it) — it is
// every authoring road refusing to save an empty one going forward
// (`proposeGuarded` and its siblings in routines, templates, the demo, mate
// proposals, and the planner). `propose` itself, the primitive every one of
// those calls, stays permissive so a scope already on file — approved or not,
// written before this code existed — is never retroactively invalidated.
export type EvidenceKind = "check" | "screenshot" | "changed-path" | "manual-review";

export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["check", "screenshot", "changed-path", "manual-review"];

export type AcceptanceCriterion = {
  id: string;
  /** The signed outcome statement. Restating it differently in a proof is
   * refuted, not short — the same severity as any other altered term. */
  statement: string;
  /** Advisory guidance for HOW to satisfy the statement. Never enters the
   * digest and is never a term the approval binds — an operator can leave
   * it, change it, or ignore it without touching what was signed. */
  how: string | null;
  /** SIGNED: the evidence kinds a proof must reference, by exact id, to
   * answer this criterion. Never empty. */
  evidence: EvidenceKind[];
};

export const ACCEPTANCE_LIMITS = {
  criteria: 12,
  id: 40,
  statement: 300,
  how: 500,
  evidenceKinds: EVIDENCE_KINDS.length,
} as const;

export type AcceptanceProblem = { reason: string; message: string };

function acceptanceDescribe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return `a ${value.length}-char string`;
  return `a ${Array.isArray(value) ? "array" : typeof value}`;
}

function acceptanceProse(
  value: unknown,
  field: string,
  cap: number,
  required: boolean,
  problems: AcceptanceProblem[],
): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) problems.push({ reason: `missing-${field}`, message: `${field} is required` });
    return null;
  }
  if (typeof value !== "string") {
    problems.push({ reason: `bad-${field}`, message: `${field} must be a string (got ${acceptanceDescribe(value)})` });
    return null;
  }
  if (Buffer.byteLength(value, "utf8") > cap) {
    problems.push({ reason: `${field}-too-long`, message: `${field} is over ${cap} bytes` });
    return null;
  }
  if (hasForbiddenControls(value)) {
    problems.push({ reason: `${field}-controls`, message: `${field} carries control characters that could become terminal escapes` });
    return null;
  }
  return value;
}

/**
 * Parse a rubric from already-JSON-parsed input (the planner's handoff, a
 * console form, a routine or template definition): fail closed, every
 * problem reported at once, stable reasons — the same discipline as every
 * other quoted-data parser in this codebase (`plan.ts`, `proof.ts`). An
 * absent or empty `value` parses to `[]` with no problems: whether that is
 * ALLOWED is a question for the caller (`propose` says yes; every authoring
 * road says no), never for this parser.
 */
export function parseAcceptanceCriteria(value: unknown): { criteria: AcceptanceCriterion[]; problems: AcceptanceProblem[] } {
  const problems: AcceptanceProblem[] = [];
  if (value === undefined || value === null) return { criteria: [], problems };
  if (!Array.isArray(value)) {
    problems.push({ reason: "bad-acceptance", message: `acceptance must be an array (got ${acceptanceDescribe(value)})` });
    return { criteria: [], problems };
  }
  if (value.length > ACCEPTANCE_LIMITS.criteria) {
    problems.push({ reason: "acceptance-too-many", message: `acceptance lists ${value.length} — cap is ${ACCEPTANCE_LIMITS.criteria}` });
    return { criteria: [], problems };
  }
  const criteria: AcceptanceCriterion[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push({ reason: `acceptance[${index}]-shape`, message: `acceptance[${index}] must be an object` });
      continue;
    }
    const one = entry as Record<string, unknown>;
    const id = acceptanceProse(one["id"], `acceptance[${index}].id`, ACCEPTANCE_LIMITS.id, true, problems);
    if (id !== null && seen.has(id)) {
      problems.push({ reason: `acceptance[${index}]-duplicate-id`, message: `criterion id "${id}" appears twice` });
    } else if (id !== null) {
      seen.add(id);
    }
    const statement = acceptanceProse(one["statement"], `acceptance[${index}].statement`, ACCEPTANCE_LIMITS.statement, true, problems);
    const how = acceptanceProse(one["how"], `acceptance[${index}].how`, ACCEPTANCE_LIMITS.how, false, problems);

    const rawEvidence = one["evidence"];
    let evidence: EvidenceKind[] | null = null;
    if (!Array.isArray(rawEvidence)) {
      problems.push({
        reason: `acceptance[${index}]-bad-evidence`,
        message: `acceptance[${index}].evidence must be a non-empty array of evidence kinds (got ${acceptanceDescribe(rawEvidence)})`,
      });
    } else if (rawEvidence.length === 0 || rawEvidence.length > ACCEPTANCE_LIMITS.evidenceKinds) {
      problems.push({
        reason: `acceptance[${index}]-evidence-count`,
        message: `acceptance[${index}].evidence must name 1-${ACCEPTANCE_LIMITS.evidenceKinds} evidence kinds`,
      });
    } else {
      const kinds: EvidenceKind[] = [];
      const seenKinds = new Set<string>();
      let bad = false;
      for (const k of rawEvidence) {
        if (typeof k !== "string" || !EVIDENCE_KINDS.includes(k as EvidenceKind)) {
          problems.push({
            reason: `acceptance[${index}]-bad-evidence-kind`,
            message: `acceptance[${index}].evidence must draw from ${EVIDENCE_KINDS.join(", ")} (got ${acceptanceDescribe(k)})`,
          });
          bad = true;
          continue;
        }
        if (seenKinds.has(k)) {
          problems.push({ reason: `acceptance[${index}]-duplicate-evidence-kind`, message: `evidence kind "${k}" appears twice` });
          bad = true;
          continue;
        }
        seenKinds.add(k);
        kinds.push(k as EvidenceKind);
      }
      if (!bad) evidence = kinds;
    }

    if (id === null || statement === null || evidence === null) continue;
    criteria.push({ id, statement, how, evidence });
  }
  return { criteria, problems };
}

/** The exact bytes a rubric's SIGNED terms reduce to for the digest: sorted
 * by id, `how` dropped (advisory, never signed), evidence kinds sorted so
 * two equivalent lists never digest differently. */
/**
 * The plain-text rubric encoding shared by every non-JSON authoring
 * surface — the console's rubric textarea (one line each) and the CLI's
 * `--acceptance` flag (one line per `;`-separated entry): one criterion
 * per line, shaped
 *
 *   [id:] statement | evidence,kinds [| how]
 *
 * `id` is optional — auto-numbered `c1`, `c2`, ... in encounter order when
 * every line omits it, so a person can write the rubric without inventing
 * ids by hand. This function never validates; it only turns text into the
 * same plain-object shape `parseAcceptanceCriteria` already validates, so
 * both entry points can never drift on what counts as a valid criterion.
 */
export function acceptanceLinesToInput(lines: readonly string[]): unknown[] {
  const out: unknown[] = [];
  let auto = 1;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    const idMatch = /^([A-Za-z0-9_-]{1,40}):\s*(.*)$/.exec(line);
    const id = idMatch?.[1];
    const rest = idMatch ? (idMatch[2] ?? "") : line;
    const parts = rest.split("|").map(p => p.trim());
    const statement = parts[0] ?? "";
    const evidence = (parts[1] ?? "").split(",").map(k => k.trim()).filter(k => k !== "");
    const how = parts[2] !== undefined && parts[2] !== "" ? parts[2] : null;
    out.push({ id: id ?? `c${auto++}`, statement, evidence, how });
  }
  return out;
}

/** The inverse of `acceptanceLinesToInput`, for pre-filling an editor from
 * a stored rubric — round-trips through `parseAcceptanceCriteria` exactly. */
export function acceptanceToLines(criteria: readonly AcceptanceCriterion[]): string[] {
  return criteria.map(c => `${c.id}: ${c.statement} | ${c.evidence.join(",")}${c.how === null ? "" : ` | ${c.how}`}`);
}

export function canonicalAcceptance(criteria: readonly AcceptanceCriterion[]): { id: string; statement: string; evidence: EvidenceKind[] }[] {
  return [...criteria]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(c => ({ id: c.id, statement: c.statement.trim(), evidence: [...c.evidence].sort() }));
}

export type Scope = {
  taskId: string;
  /** What success looks like, in the operator's words. */
  goal: string;
  /** What this task is explicitly not allowed to turn into. */
  outOfScope: string | null;
  /** Paths the work is expected to touch. Advisory, and worth stating. */
  touches: string[];
  /** v39: the signed acceptance rubric. `[]` on every scope proposed before
   * this migration and on any legacy road that still calls `propose`
   * directly — a scope-producing ROAD enforces non-emptiness, never this
   * type, never `propose`, never the digest. */
  acceptance: AcceptanceCriterion[];
  /** v41: evidence policy, signed with the scope. Default is omitted from
   * the digest so every pre-v41 approval remains byte-for-byte valid. */
  qualityMode?: QualityMode;
  /** The dollar cap per build attempt, integer micro-dollars (v15) —
   * approved spend, restated at the yes, enforced by the provider's own
   * stop. NULL = no per-attempt cap was asked for. */
  budgetMicrousd: number | null;
  proposedAt: string;
  /** Of the scope as written. Approval is bound to this exact value. */
  digest: string;
  approvedAt: string | null;
  approvedBy: string | null;
  /** The digest that was actually agreed to, which may now be stale. */
  approvedDigest: string | null;
  /** How the approval happened (v29): 'password' = the ceremony;
   * 'mode' = sealed by the signer's live mode (modeDigest names it). */
  approvalBasis?: "password" | "mode" | null;
  modeDigest?: string | null;
  /** v24 (optional so hand-built scopes in tests stay valid): the working
   * execution profile, its resolution state, and the immutable snapshot
   * the approval act sealed. */
  profile?: ExecutionProfile | null;
  profileState?: "resolved" | "unresolved";
  unresolvedReason?: string | null;
  approvedProfile?: ExecutionProfile | null;
  digestVersion?: number;
  /** v30 fallback chains. `proposedChainJson` is the WORKING chain snapshot
   * the digest bound (present only when the repo has configured fallbacks);
   * `approvedChainJson` is the immutable snapshot the seal COPIED from it;
   * `approvalKind` names which the approval sealed. All undefined/null on a
   * legacy single-profile scope — every scope until an operator configures a
   * fallback chain. The runtime re-derives the active entry from
   * `approvedChainJson`, never from mutable config. */
  proposedChainJson?: string | null;
  approvedChainJson?: string | null;
  approvalKind?: "profile" | "chain";
  /** v47 phase routing: the signed risk level, the WORKING canonical route
   * the digest bound, and the immutable snapshot the seal COPIED from it.
   * `routeEra` is the durable marker: null on a row PROVEN to predate v47
   * (legacy — its sealed profile alone governs), the route version on every
   * row filed since — for those, a missing or unreadable route is corrupt
   * and fails closed everywhere. */
  riskLevel?: RiskLevel;
  proposedRouteJson?: string | null;
  approvedRouteJson?: string | null;
  routeEra?: number | null;
};

export type Approval =
  | { approved: true; at: string; by: string }
  | { approved: false; reason: "none" | "changed" | "never-proposed" };

export type ScopeInput = {
  taskId: string;
  goal: string;
  outOfScope?: string | null;
  touches?: readonly string[];
  /** v24: an EXPLICIT profile skips resolution in the store (routine
   * firings and the demo's illustrative scopes use this road). */
  profile?: ExecutionProfile;
  /** A task-level permission choice. When absent, the task's stored choice
   * (if any), then the installation default, decides the concrete profile. */
  permissionMode?: UnattendedPermissionMode;
  /** Concrete task quality choice. When absent, the task override and then
   * the installation default are resolved by the store. */
  qualityMode?: QualityMode;
  /** v47: the task's declared risk. When absent, the task's stored choice
   * (if any), else routine. A durable TASK choice, like qualityMode. */
  riskLevel?: RiskLevel;
  /** Integer micro-dollars per build attempt; digest-bound when present. */
  budgetMicrousd?: number | null;
  /** The mode road's escalated filing default (C7): the resolved profile
   * seals claude bypassPermissions / gemini yolo; codex-shaped unchanged. */
  posture?: "escalated";
  /** Who wrote this text (mate arc, ruling 2): `mate` for a confirmed mate
   * proposal — mode coverage then never seals it; a human rewrite clears it. */
  proposedVia?: "mate" | "coordinator" | null;
  /** v39: the signed acceptance rubric. Absent digests exactly like `[]` —
   * see `Scope.acceptance`. `propose` itself never requires this to be
   * non-empty; the roads that call it do. */
  acceptance?: readonly AcceptanceCriterion[];
  now: Date;
  mutation?: Mutation;
};

/**
 * The exact bytes an operator agreed to.
 *
 * Every field that constrains the work goes in. If a change to a field would
 * change what an operator would have said, it has to move the digest, or the
 * approval it invalidates would be an approval of something else.
 */
export function digestOf(
  scope: Pick<Scope, "goal" | "outOfScope" | "touches"> & {
    budgetMicrousd?: number | null;
    /** v39: the rubric, folded in ONLY when non-empty — the same absent/`[]`
     * equivalence budgetMicrousd has always used, so a scope proposed before
     * this migration, or by a road that never sends one, digests to exactly
     * what it digested to before this field existed. `how` never enters
     * here (advisory, never signed); evidence kinds do. */
    acceptance?: readonly AcceptanceCriterion[];
    qualityMode?: QualityMode;
  },
  // The execution target: a single profile (legacy v24), OR an explicit
  // fallback chain (v30). BOTH fold through the SAME outer `profileDigest`
  // key — the discriminator lives INSIDE the digest value (a chain digest
  // is domain-separated from a profile digest), NEVER as an outer field
  // (an outer field would change the legacy bytes; C1). A chain-of-one is
  // still an EXPLICIT chain and uses the chain digest, distinct from the
  // single-profile digest by design.
  target?: ExecutionProfile | null | { chain: readonly ChainEntry[] },
  // v47: the phase route. EVERY route filed since v47 folds in — routine
  // shaped ones included — so the approval binds exactly which agent runs
  // each phase. Absent (null) only for a row proven to predate v47, whose
  // digest bytes are therefore untouched.
  route?: PhaseRoute | null,
): string {
  const innerDigest =
    target == null
      ? null
      : "chain" in target
        ? chainDigestOf(target.chain)
        : profileDigestOf(target);
  return createHash("sha256")
    .update(
      JSON.stringify({
        goal: scope.goal.trim(),
        outOfScope: scope.outOfScope?.trim() ?? null,
        touches: [...scope.touches].sort(),
        // Absent and null digest identically, so every pre-v15 approval
        // stays exactly as approved.
        ...(scope.budgetMicrousd == null ? {} : { budget: scope.budgetMicrousd }),
        // Same absent/[] equivalence as budget, one key up: a rubric-less
        // scope (every scope before v39, and any road that sends none)
        // digests identically to today.
        ...(scope.acceptance === undefined || scope.acceptance.length === 0
          ? {}
          : { acceptance: canonicalAcceptance(scope.acceptance) }),
        // Default is the historical behavior and therefore hashes exactly
        // like an absent v41 field. Strict is an explicit signed promise.
        ...(scope.qualityMode === "strict" ? { qualityMode: "strict" } : {}),
        // The single outer key, whichever target produced its inner value:
        // absent => the golden and every profileless approval are untouched;
        // a legacy profile => its exact profileDigestOf; an explicit chain
        // => its chainDigestOf. Same key, discriminated value.
        ...(innerDigest == null ? {} : { profileDigest: innerDigest }),
        // The route's own domain-separated digest, under its own key —
        // absent only for a pre-v47 row.
        ...(route == null ? {} : { route: routeDigestOf(route) }),
      }),
      "utf8",
    )
    .digest("hex")
    // 128 bits. This is a safety token binding an approval to exact content,
    // so it has to be well past the reach of a deliberate collision search —
    // 64 bits is not, and the only cost of the longer one is a longer thing to
    // paste back.
    .slice(0, 32);
}

export function propose(store: Store, input: ScopeInput): Scope {
  const { taskId, goal, outOfScope = null, touches = [], budgetMicrousd = null, acceptance = [], qualityMode = "default", now, mutation = {}, profile, permissionMode, posture, proposedVia = null, riskLevel } = input;

  const draft = { goal, outOfScope, touches: [...touches], budgetMicrousd, acceptance: [...acceptance], qualityMode };
  const previous = store.getScope(taskId);

  const scope: Scope = {
    taskId,
    ...draft,
    proposedAt: now.toISOString(),
    digest: digestOf(draft),
    // The previous approval is kept rather than cleared, and is invalidated by
    // the digest no longer matching. Same safety — `approvalOf` requires them
    // equal — but it preserves the fact that somebody once agreed to
    // something, so the refusal can say "this was approved and then rewritten"
    // instead of the much less useful "this was never approved".
    approvedAt: previous?.approvedAt ?? null,
    approvedBy: previous?.approvedBy ?? null,
    approvedDigest: previous?.approvedDigest ?? null,
  };

  store.saveScope(scope, mutation, {
    ...(profile === undefined ? {} : { profile }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(input.qualityMode === undefined ? {} : { qualityMode: input.qualityMode }),
    ...(riskLevel === undefined || !isRiskLevel(riskLevel) ? {} : { riskLevel }),
    ...(posture === undefined ? {} : { posture }),
    proposedVia,
  });
  // The store may have RECOMPUTED the digest to bind the resolved profile
  // (v24 filing invariant) — what callers display must be what is stored.
  return store.getScope(taskId) ?? scope;
}

export type GuardedProposeResult =
  | { ok: true; scope: Scope }
  | {
      ok: false;
      reason: "changed" | "claimed" | "bad-goal" | "bad-out-of-scope" | "bad-touches" | "bad-acceptance" | "acceptance-required";
    };

/**
 * A scope edit from a surface where the editor might be stale — two browser
 * tabs, a form submitted after the world moved. `sawDigest` names the version
 * the editor was looking at (null: they saw no scope at all); a mismatch is a
 * refusal, never a silent overwrite of somebody else's words. Edits are also
 * refused while a live claim holds the task: the running build read its scope
 * at start, and rewording the agreement under it would make the digest lie
 * about what the work was agreed to. Field caps and control-character rules
 * live here because every one of these strings will later be rendered.
 *
 * v39: this is a scope-producing ROAD, not the `propose` primitive, so it is
 * where the rubric becomes mandatory — every edit through here (a fresh
 * proposal or a rewrite of an already-approved one) must carry at least one
 * criterion, or it is refused with a clear `acceptance-required` reason
 * rather than silently filing without one. A scope that already carries a
 * live, unrewritten approval from before this code existed never reaches
 * this function again unless somebody edits it — which is exactly when the
 * requirement should start applying.
 */
export function proposeGuarded(
  store: Store,
  input: Omit<ScopeInput, "acceptance"> & { sawDigest: string | null; taskRef: number | null; acceptance?: unknown },
): GuardedProposeResult {
  const goal = input.goal.trim();
  if (goal === "" || goal.length > 2_000 || hasForbiddenControls(goal)) {
    return { ok: false, reason: "bad-goal" };
  }
  const outOfScope = input.outOfScope?.trim() || null;
  if (outOfScope !== null && (outOfScope.length > 2_000 || hasForbiddenControls(outOfScope))) {
    return { ok: false, reason: "bad-out-of-scope" };
  }
  const touches = [...(input.touches ?? [])].map(one => one.trim()).filter(one => one !== "");
  if (touches.length > 50 || touches.some(one => one.length > 200 || hasForbiddenControls(one))) {
    return { ok: false, reason: "bad-touches" };
  }
  const acceptanceParse = parseAcceptanceCriteria(input.acceptance);
  if (acceptanceParse.problems.length > 0) {
    return { ok: false, reason: "bad-acceptance" };
  }
  if (acceptanceParse.criteria.length === 0) {
    return { ok: false, reason: "acceptance-required" };
  }

  return store.transact(() => {
    if (input.taskRef !== null && store.hasLiveClaim(input.taskRef, input.now)) {
      return { ok: false as const, reason: "claimed" as const };
    }
    const previous = store.getScope(input.taskId);
    if ((previous?.digest ?? null) !== input.sawDigest) {
      return { ok: false as const, reason: "changed" as const };
    }
    const scope = propose(store, { ...input, goal, outOfScope, touches, acceptance: acceptanceParse.criteria });
    return { ok: true as const, scope };
  });
}

/**
 * A person says yes.
 *
 * Takes the digest they were shown, so agreeing to a scope that changed while
 * they were reading it fails rather than silently approving the new one.
 */
/**
 * Register somebody who is allowed to agree to scopes.
 *
 * The token is shown once and stored only as a hash, exactly like a runner's.
 * It exists because an approval nobody has to authenticate is not a gate: an
 * agent that can run these commands can read a scope's digest out of `task
 * show` and approve its own brief with it. Requiring a credential the agent
 * was never given is what keeps "a person agreed to this" true.
 */
export type AddApproverResult =
  | { ok: true; name: string; token: string; bootstrap: boolean; chosen: boolean }
  | { ok: false; reason: "not-an-approver" | "weak-password" };

export function addApprover(
  store: Store,
  name: string,
  now: Date,
  by?: { name: string; token: string },
  newToken: () => string = mintToken,
  mutation: Mutation = {},
  /** A password the person chose. Absent, a token is minted and shown once. */
  password?: string,
): AddApproverResult {
  if (password !== undefined && password.length < 8) {
    return { ok: false, reason: "weak-password" };
  }
  // The first one bootstraps, because somebody has to be able to create the
  // first one and there is nobody to ask yet. Every one after it has to be
  // vouched for by an existing approver.
  //
  // Without that second rule the credential is worth nothing: an agent that
  // can run these commands would simply mint an approver for itself and
  // approve its own scope with it. The bootstrap window is real and is why
  // this is the first thing an operator should do, before anything else can
  // reach the queue.
  // ONE transaction around detection, vouching, and the write (Codex
  // people round 2, finding 1): a voucher revoked between the check and
  // the save must lose — BEGIN IMMEDIATE serializes against the
  // revocation cascade, so there is no between.
  return store.transact(() => {
  const existing = store.listApprovers();
  const bootstrap = existing.length === 0;

  if (!bootstrap) {
    // ACTIVE approver standing, not a bare hash match (Codex people round
    // 1, finding 1): a viewer's or a revoked person's credential is real
    // and still vouches for nothing — the CLI is a ceremony site like any
    // other, and this was the one road that forgot.
    const vouching = by === undefined ? { ok: false as const } : authenticateApprover(store, by.name, by.token);
    if (!vouching.ok) {
      return { ok: false, reason: "not-an-approver" };
    }
  }

  if (password !== undefined) {
    store.saveApprover(name, hashPassword(password), now, mutation);
    return { ok: true, name, token: password, bootstrap, chosen: true };
  }
  const token = newToken();
  store.saveApprover(name, hashToken(token), now, mutation);
  return { ok: true, name, token, bootstrap, chosen: false };
  });
}

export type ApproveResult =
  | { ok: true; scope: Scope }
  | { ok: false; reason: "no-scope" | "changed" | "no-approvers" | "not-an-approver" | "profile-unresolved" };

/**
 * Whether this name-and-token pair is a person the store knows. Shared by
 * every act that requires a human's authority — approving a scope, answering
 * a decision — because "who said yes" must never be a string the caller
 * typed. Fails closed: with no approver registered there is nobody who can
 * agree to anything, and treating that as "authority is not required here"
 * would make the gate optional — which is the same as not having one.
 */
/**
 * IDENTITY, split from authority (modes chain, D2/E2): who this credential
 * belongs to and what standing they hold. Viewers authenticate here and
 * read; every consequential act goes through authenticateApprover below,
 * which additionally demands ACTIVE approver standing — so the forty
 * ceremony sites enforce the role without one of them changing.
 */
export function authenticateAccount(
  store: Store,
  by: string,
  secret: string,
): { ok: true; role: "approver" | "viewer"; generation: number } | { ok: false; reason: "no-approvers" | "unknown" | "revoked" } {
  if (store.listApprovers().length === 0) return { ok: false, reason: "no-approvers" };
  const account = store.accountOf(by);
  if (account === null || !verifyCredential(account.credentialHash, secret)) {
    return { ok: false, reason: "unknown" };
  }
  if (account.revokedAt !== null) return { ok: false, reason: "revoked" };
  return { ok: true, role: account.role, generation: account.generation };
}

export function authenticateApprover(
  store: Store,
  by: string,
  token: string,
): { ok: true } | { ok: false; reason: "no-approvers" | "not-an-approver" } {
  const account = authenticateAccount(store, by, token);
  if (!account.ok) {
    return { ok: false, reason: account.reason === "no-approvers" ? "no-approvers" : "not-an-approver" };
  }
  // A viewer's credential is real and still cannot agree to anything —
  // the words every refused ceremony shows are the viewer words.
  if (account.role !== "approver") return { ok: false, reason: "not-an-approver" };
  return { ok: true };
}

/**
 * C1's atomic road: file the scope AND seal its approval in ONE
 * transaction, under a mode the SAME transaction re-proves. The caller
 * has already authenticated the actor and matched channel rules; this
 * function owns the predicate's transactional half — mode active, actor
 * IS the signer, repo matches, and the sealed digest is the filed one
 * (trivially true here: they are the same transaction). Never
 * sealScopeApproval after a filing — that was the TOCTOU.
 */
/**
 * C1's coverage question, answerable from ANY filing road: does a live
 * mode make THIS actor's credentialed filing auto-approve here, and with
 * which defaults? Callers re-ask INSIDE their filing transaction — an
 * answer carried across transactions would be the TOCTOU again.
 */
export function modeFilingCoverage(
  store: Store,
  repo: string | null,
  actor: string,
  now: Date,
): { digest: string; escalated: boolean; defaultBudgetMicrousd: number | null } | null {
  const mode = repo === null ? null : store.activeMode(repo, now);
  if (mode === null || mode.signedBy !== actor) return null;
  try {
    const terms = JSON.parse(mode.termsJson) as {
      autoApproveFiling?: unknown;
      permissionDefault?: unknown;
      perAttemptBudgetMicrousd?: unknown;
    };
    if (terms.autoApproveFiling !== true) return null;
    return {
      digest: mode.digest,
      escalated: terms.permissionDefault === "escalated",
      defaultBudgetMicrousd:
        typeof terms.perAttemptBudgetMicrousd === "number" ? terms.perAttemptBudgetMicrousd : null,
    };
  } catch {
    return null;
  }
}

export function fileAndSealUnderMode(
  store: Store,
  input: ScopeInput & { repo: string | null; actor: string },
): { ok: true; scope: Scope; basis: "mode" } | { ok: false; reason: "no-mode" | "not-signer" | "not-covered" | "coordinator-filed" | "acceptance-required" | "profile-unresolved"; detail?: string } {
  return store.transact(() => {
    const mode = input.repo === null ? null : store.activeMode(input.repo, input.now);
    if (mode === null) return { ok: false as const, reason: "no-mode" as const };
    if (mode.signedBy !== input.actor) return { ok: false as const, reason: "not-signer" as const };
    let autoApprove = false;
    let defaultBudget: number | null = null;
    let escalated = false;
    try {
      const terms = JSON.parse(mode.termsJson) as { autoApproveFiling?: unknown; perAttemptBudgetMicrousd?: unknown; permissionDefault?: unknown };
      autoApprove = terms.autoApproveFiling === true;
      defaultBudget = typeof terms.perAttemptBudgetMicrousd === "number" ? terms.perAttemptBudgetMicrousd : null;
      escalated = terms.permissionDefault === "escalated";
    } catch {
      autoApprove = false;
    }
    if (!autoApprove) return { ok: false as const, reason: "not-covered" as const };
    // v39: a mode auto-approves a filing with NOBODY reading it at that
    // instant — of every road, this one can least afford to seal a scope
    // with no rubric to answer.
    if (parseAcceptanceCriteria(input.acceptance).criteria.length === 0) {
      return { ok: false as const, reason: "acceptance-required" as const };
    }
    const scope = propose(store, {
      ...input,
      ...(input.budgetMicrousd == null && defaultBudget !== null ? { budgetMicrousd: defaultBudget } : {}),
      ...(escalated ? { posture: "escalated" as const } : {}),
    });
    // A scope that cannot say exactly which agents run (v47: every phase
    // exact, the route readable) is never auto-sealed — the words say why.
    if (scope.profileState === "unresolved") {
      return { ok: false as const, reason: "profile-unresolved" as const, ...(scope.unresolvedReason == null ? {} : { detail: scope.unresolvedReason }) };
    }
    const sealed = store.sealScopeApproval(input.taskId, input.actor, input.now, input.mutation ?? {}, { kind: "mode", modeDigest: mode.digest });
    // The quarantine speaks through every caller (review finding 7): a
    // coordinator-filed task is never mode-admitted, and pretending the
    // seal landed would hide exactly the refusal the operator must see.
    if (!sealed) return { ok: false as const, reason: "coordinator-filed" as const };
    return { ok: true as const, scope: store.getScope(input.taskId) as Scope, basis: "mode" as const };
  });
}

export function approve(
  store: Store,
  taskId: string,
  by: string,
  now: Date,
  sawDigest: string,
  token: string,
  mutation: Mutation = {},
): ApproveResult {
  // Read and write in one transaction, re-reading inside it — the credential
  // check included, so a token rotated between authentication and the write
  // cannot leave an approval signed by an authority that no longer exists.
  // Apart, a scope rewritten between the read and the write is overwritten by
  // this approval — which would resurrect the old wording *and* mark it
  // agreed, the precise opposite of what the digest is for.
  return store.transact(() => {
    const authenticated = authenticateApprover(store, by, token);
    if (!authenticated.ok) return authenticated;

    const scope = store.getScope(taskId);
    if (scope === null) return { ok: false as const, reason: "no-scope" as const };

    // The digest is required, not optional. An operator reads a scope, somebody
    // rewrites it, and an approval that did not name what it saw would agree to
    // the new one in silence — which is the whole failure this guards.
    if (sawDigest !== scope.digest) return { ok: false as const, reason: "changed" as const };

    // An unresolved scope cannot say exactly what would run, so nobody can
    // agree to it (foundations finding 16) — restatement is the road.
    if (scope.profileState === "unresolved") {
      return { ok: false as const, reason: "profile-unresolved" as const };
    }

    // SEAL, never re-resolve: the approval snapshots the stored working
    // profile — the exact bytes the digest the approver signed was bound
    // to. Routing saveScope here would re-run resolution and could sign a
    // profile nobody saw.
    const sealed = store.sealScopeApproval(taskId, by, now, mutation);
    if (!sealed) return { ok: false as const, reason: "changed" as const };
    const approved = store.getScope(taskId);
    if (approved === null) return { ok: false as const, reason: "no-scope" as const };
    return { ok: true as const, scope: approved };
  });
}

/**
 * Whether this task may be built.
 *
 * `changed` is the interesting answer and the reason the digest exists: the
 * scope was approved, and then somebody — possibly an agent, possibly the
 * operator, possibly a different session — rewrote it. The old yes does not
 * transfer.
 */
export function approvalOf(scope: Scope | null): Approval {
  if (scope === null) return { approved: false, reason: "never-proposed" };
  if (scope.approvedAt === null || scope.approvedBy === null) {
    return { approved: false, reason: "none" };
  }
  if (scope.approvedDigest !== scope.digest) return { approved: false, reason: "changed" };
  return { approved: true, at: scope.approvedAt, by: scope.approvedBy };
}

/** The rubric's approval-card lines (v39): one per criterion, the id in
 * front (the exact string a proof must answer by) and its required
 * evidence kinds after it — `how` is deliberately absent here, the same way
 * it is absent from the digest: it is guidance, never a signed term. */
export function acceptanceWords(criteria: readonly AcceptanceCriterion[]): string[] {
  if (criteria.length === 0) return [];
  return [
    `  acceptance   ${criteria[0]!.id}: ${criteria[0]!.statement} [requires: ${criteria[0]!.evidence.join(", ")}]`,
    ...criteria.slice(1).map(c => `               ${c.id}: ${c.statement} [requires: ${c.evidence.join(", ")}]`),
  ];
}

/** The route's approval-card lines (v47): the WORKING route the digest
 * bound, projected with whatever readiness the caller can see — the same
 * bytes the task page and chat render. Empty on a scope with no route. */
export function scopeRouteWords(scope: Pick<Scope, "proposedRouteJson">, readiness: ReadinessLookup = NO_READINESS): string[] {
  const route = routeFromJson(scope.proposedRouteJson ?? null);
  return route === null ? [] : routeWords(projectRoute(route, readiness));
}

/** The scope, in the words an operator has to be able to agree or disagree with. */
export function describeScope(scope: Scope, readiness: ReadinessLookup = NO_READINESS): string[] {
  const approval = approvalOf(scope);
  return [
    `  goal         ${scope.goal}`,
    ...(scope.outOfScope === null ? [] : [`  not this     ${scope.outOfScope}`]),
    ...(scope.touches.length === 0 ? [] : [`  touches      ${scope.touches.join(", ")}`]),
    ...acceptanceWords(scope.acceptance),
    ...(scope.budgetMicrousd === null
      ? []
      : [`  budget       $${(scope.budgetMicrousd / 1_000_000).toFixed(2)} per build attempt — the agent is stopped at this figure`]),
    // The FALLBACK CHAIN, in the words the yes agrees to (Layer F): when
    // this scope files under configured fallbacks, the digest above binds
    // the WHOLE ordered chain — so the card says every entry, credential
    // included, before anyone signs.
    ...chainWords(chainFromJson(scope.proposedChainJson ?? null)),
    // The ROUTE, in the words the yes agrees to (v47): risk, posture, and
    // every leg with its reason and readiness — before anyone signs.
    ...(scope.riskLevel === undefined || scope.riskLevel === "routine" ? [] : [`  risk         ${scope.riskLevel}`]),
    ...scopeRouteWords(scope, readiness),
    `  reference    ${scope.digest}`,
    `  approved     ${describeApproval(approval)}`,
  ];
}

/** The chain's approval-card lines; empty for a single-profile scope. */
export function chainWords(chain: ChainEntry[] | null): string[] {
  if (chain === null || chain.length < 2) return [];
  const credential = (mode: ChainEntry["authMode"]): string =>
    mode === "subscription" ? "your subscription" : "your API key";
  const lines: string[] = [];
  const base = chain[0] as ChainEntry;
  lines.push(`  runs on      ${base.profile.provider} (${base.profile.model}) — ${credential(base.authMode)}`);
  for (const entry of chain.slice(1)) {
    lines.push(
      `  if that runs out  falls back to ${entry.profile.provider} (${entry.profile.model}) — ${credential(entry.authMode)}${
        entry.authMode === "api-key" ? "; spend moves to that account" : ""
      }`,
    );
  }
  return lines;
}

function describeApproval(approval: Approval): string {
  if (approval.approved) return `yes, by ${approval.by} at ${approval.at}`;
  if (approval.reason === "changed") {
    return "no — it was approved, then the scope was rewritten; approve it again";
  }
  return "no — nothing will build this until somebody agrees to it";
}

// ---- attended authorization terms (Parity II Phase 2E, ruling 12) ----------

/**
 * EVERY rendered term of one watched attempt — what the form shows is what
 * the password signs, byte for byte. The subset the dispatch proof
 * re-derives (scopeDigest, profileDigest, profileJson, repo, head) is read
 * back by the builder and the coordinator; the rest are the product terms
 * the ceremony renders in words: the budget as a STOP THRESHOLD, the turn
 * cap, the per-turn clock whose expiry is SESSION-FATAL, and the absolute
 * expiry. Continuation carries the parent attempt and the follow-up text
 * INSIDE the signed terms (v3 R7).
 */
export type AttendedTerms = {
  taskId: string;
  /** v28: HOW liveness is renewed — a SIGNED term, because liveness is an
   * admission predicate, not decoration. "console-visible" = any open
   * console page of this server renews use. Legacy terms lack the field
   * and beat-all refuses them (they were signed as page-bound). */
  attentionMode: "console-visible";
  scopeDigest: string;
  profileDigest: string;
  profileJson: string;
  repo: string;
  runner: string;
  runnerGeneration: number;
  head: string;
  maxSessionTurns: number;
  budgetMicrousd: number;
  turnTimeoutSeconds: number;
  absoluteExpiry: string;
  parentRun?: number | null;
  followup?: string | null;
};

/** Deterministic bytes: sorted keys, undefined dropped — the signed text. */
export function attendedTermsJson(terms: AttendedTerms): string {
  return canonicalJson(terms);
}

/** The composite digest one password signs (ruling 12), domain-separated. */
export function attendedDigestOf(terms: AttendedTerms): string {
  return createHash("sha256")
    .update(`standing-orders:attended:${attendedTermsJson(terms)}`)
    .digest("hex")
    .slice(0, 32);
}
