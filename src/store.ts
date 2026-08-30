/**
 * The database: a small task store, and the operational overlay beside it.
 *
 * Two things live here and they are deliberately not the same thing.
 *
 * The **task store** is the fallback backend — what you get when no beads, no
 * Backlog.md, no GitHub Issues. §4 is honest about what that makes us: anything
 * that can create, store, transition, and link tasks is a task store, and
 * pretending otherwise while shipping one would be self-deception. So it owns
 * something deliberately small — authoring, states, dependency edges, a ready
 * query — and declines to grow search, labels, comments, or sync.
 *
 * The **overlay** is backend-independent and outlives any of them. Every
 * operational record hangs off a `TaskRef` keyed by `(backend, external_id)`,
 * so an operator who starts on the built-in store and later adopts beads keeps
 * every claim, hold, and lease they had. That indirection looks like ceremony
 * until the day someone switches, at which point it is the only reason their
 * history survives.
 *
 * SQLite via `node:sqlite`, so there is no runtime dependency and no native
 * build step — `npx standing-orders` has to still work on a machine with no
 * compiler, and a task store is not worth breaking that promise for.
 *
 * Deliberately absent: `workspace_id`. §4 lists it, but multiplayer and RBAC
 * are deferred until after M4, and a column that exists to serve a feature
 * nobody has designed yet is a column that will be wrong when they do.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { hasForbiddenControls, validateNote } from "./decision.js";
import { digestOf, canonicalProfileJson, canonicalChainJson, chainFromJson, chainDigestOf, entryDigestOf, profileFromJson, CLAUDE_LIMITS, CODEX_SHAPED_LIMITS, GEMINI_LIMITS, type ExecutionProfile, type ChainEntry } from "./scope.js";
import { resolveScopeProfile, resolveScopeChain } from "./agentconfig.js";
import { readAuthMode } from "./keys.js";
import { isFallbackEligible, recognizesEligible, classMatchesAuthMode, type TerminalClass } from "./exhaustion.js";
import { modeTermsFromJson } from "./modes.js";
import type { ProviderId } from "./provider.js";
import type { BoardFacts } from "./board.js";
import type { BackendGrant, MutationClass, TaskOrigin } from "./grant.js";
import type { Runner } from "./runner.js";
import type { Scope } from "./scope.js";

export const SCHEMA_VERSION = 30;

/**
 * Every timestamp column holds `Date.prototype.toISOString()` output and
 * nothing else, which is UTC, zero-padded, and always three fractional
 * digits. Expiry is then a string comparison, which is only sound because that
 * format sorts lexicographically the same way it sorts chronologically.
 *
 * The invariant is load-bearing, so it is stated here rather than assumed: a
 * timestamp written with an offset (`-07:00`) or with different fractional
 * precision would compare wrong, and a lease would expire early or never.
 * Anything writing to this database goes through a `Date`.
 */

/** The backend name the built-in store registers itself under. */
export const BUILT_IN = "built-in";

export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled";

/** States from which no further work is dispatched. */
export const TERMINAL_STATES: readonly TaskState[] = ["done", "failed", "cancelled"];

export type Task = {
  id: string;
  title: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  /** Queue rank — 0 is filing order; higher is picked sooner. Scheduling
   * only, never authority: approval gates are untouched by it. */
  priority: number;
};

export type TaskRef = {
  id: number;
  backend: string;
  externalId: string;
  /** Where the work lives, when known. null dispatches anywhere; no gap claims it. */
  repo: string | null;
  /** The worker this task is reserved for; null = any free worker.
   * Scheduling only — enforced in the claim primitive, never authority. */
  assignedRunner: string | null;
  zones: string[];
  capabilityRequirements: string[];
  parkRate: number;
  /** Consecutive concluded failures. Three stalls the task; any success resets. */
  strikes: number;
  /** Planning mode: 'requested' dispatches a planner; 'drafted' awaits review. */
  plan: "requested" | "drafted" | null;
  /** Planning failures, counted apart from build strikes by design. */
  planStrikes: number;
  /** The standing order this task is an instance of; null for one-off work. */
  routineId: number | null;
  /** The pinned agent, when a fire transaction stamped one. Authoritative. */
  agentProvider: string | null;
  agentModel: string | null;
  /** Plan pins (P2/C7): read ONLY by the plan phase; precedence plan pin
   * > plan flags > plan config > installation > default. */
  planProvider: string | null;
  planModel: string | null;
  /** The task whose reviewed run this one revises (M6.8); null ordinarily. */
  revisionOf: string | null;
  /** The immutable brief artifact carrying the exact comment batch. */
  revisionBriefArtifact: number | null;
  /** Recorded, not asserted: what the grant's selector is checked against. */
  origin: TaskOrigin;
};

/** A standing order: a pre-approved template whose instances build unattended. */

// ---- tournaments (v14) ----------------------------------------------------

export type TournamentTerms = {
  id: number;
  taskRef: number;
  generation: number;
  active: boolean;
  /** v27: 'race' = dollar-capped tournament; 'comparison' = labeled
   * cross-runtime comparison with no dollar terms. */
  kind: "race" | "comparison";
  raceDigest: string;
  /** Ordered agents: exact model ids, resolved at filing. */
  agents: { provider: string; model: string; repairModel: string }[];
  n: number;
  perAgentBudgetMicrousd: number;
  overrunReserveMicrousd: number;
  totalBudgetMicrousd: number;
  priceVersion: number;
  retries: number;
  publicationPolicy: string;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  approvedDigest: string | null;
};

export type ContestState =
  | "dispatching"
  | "racing"
  | "pick-wait"
  | "decision-wait"
  | "picked"
  | "abandoned"
  | "interrupted"
  | "exhausted";

export type Contest = {
  id: number;
  taskRef: number;
  terms: number;
  generation: number;
  state: ContestState;
  scopeDigest: string;
  raceDigest: string;
  baseSha: string | null;
  setupDigest: string | null;
  currentLeaseId: string | null;
  runner: string | null;
  incarnation: string | null;
  createdAt: string;
  pickedAt: string | null;
  pickedBy: string | null;
  winnerContestant: number | null;
  /** One escalation page per tournament, ever — set with the page. */
  overduePaged: boolean;
  /** v27: denormalized from the terms at admission. */
  kind: "race" | "comparison";
};

export type ContestantState = "pending" | "ready" | "building" | "parked" | "built" | "failed" | "stopped";

export type Contestant = {
  /** v24: the contestant's own sealed execution profile. */
  profile?: ExecutionProfile | null;
  id: number;
  contest: number;
  ordinal: number;
  provider: string;
  model: string;
  repairModel: string;
  branch: string;
  worktree: string | null;
  generation: number;
  state: ContestantState;
  activeRun: number | null;
  budgetMicrousd: number;
  reserveMicrousd: number;
  /** What the provider reported — monotonic, never guessed. */
  measuredMicrousd: number;
  /** What the ledger charges — the full reservation when unknowable. */
  accountedMicrousd: number;
  unknownSpend: boolean;
  cleanup: "pending" | "done" | "attention" | null;
  custody: string | null;
};

export type ExecutionSlot = {
  id: number;
  runner: string;
  state: "reserved" | "running" | "released";
  run: number | null;
  contestant: number | null;
  incarnation: string | null;
  processGroup: number | null;
  reservedAt: string;
  runningAt: string | null;
  releasedAt: string | null;
};

/** Chat providers are direct API adapters — a DISJOINT type from the build
 * harness providers, by design (Codex v3 review, change 1). */
export type ChatProviderId = "anthropic-api" | "openrouter-api";

/** What chat may know (v3 change 9): repo-indexed, path-free items. The
 * repos list itself stays server-side; only indexes leave as opaque ids. */
export type ChatSnapshot = {
  repos: string[];
  tasks: { repoIndex: number; id: string; title: string; state: string; ageHours: number; strikes: number }[];
  tasksSaturated: boolean;
  decisions: { repoIndex: number; id: number; question: string; optionLabels: string[] }[];
  decisionsSaturated: boolean;
  incidents: { repoIndex: number; kind: string; ageHours: number }[];
  incidentsSaturated: boolean;
  routines: { repoIndex: number; name: string; schedule: string; status: string; lastFire: string | null }[];
  routinesSaturated: boolean;
  publications: { repoIndex: number; pr: number | null; checkState: string | null }[];
  publicationsSaturated: boolean;
};

export type ChatConfig = {
  provider: ChatProviderId;
  model: string;
  dailyTurns: number;
  weeklyCeilingMicrousd: number;
  /** Pinned at the authenticated save; null only on pre-v13b rows. */
  priceInMicrousd: number | null;
  priceOutMicrousd: number | null;
  updatedAt: string;
  updatedBy: string;
};

export type ChatFailureReason =
  | "provider-error"
  | "timeout"
  | "over-budget"
  | "malformed-reply"
  | "secret-refused"
  | "crashed"
  | "over-cap"
  | "unknown-spend";

export type ChatTurn = {
  id: number;
  approver: string;
  credentialKey: string;
  provider: ChatProviderId;
  model: string;
  state: "queued" | "running" | "answered" | "failed";
  generation: number;
  createdAt: string;
  startedAt: string | null;
  deadlineAt: string | null;
  finishedAt: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  reservedMicrousd: number;
  settledMicrousd: number | null;
  failureReason: ChatFailureReason | null;
  unknownSpend: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  replyBytes: number | null;
  candidateCount: number | null;
};

export type Routine = {
  id: number;
  name: string;
  repo: string;
  goal: string;
  outOfScope: string | null;
  touches: string[];
  requirements: string[];
  /** 'every:<minutes>' or 'daily:<HH:MM>' (UTC). */
  schedule: string;
  singleFlight: boolean;
  /** Rolling 7-day dollar ceiling; null = none. Enforcement fails closed. */
  costCeilingUsd: number | null;
  /** Per-instance dollar cap (v16); copied into each instance's scope. */
  budgetPerRunMicrousd: number | null;
  paused: boolean;
  /** Of every term above. Approval binds to this exact value. */
  digest: string;
  approvedAt: string | null;
  approvedBy: string | null;
  approvedDigest: string | null;
  /** The next scheduled occurrence; null until approved. */
  nextFireAt: string | null;
  /** Immutable filing provenance (v12); null on rows from before it existed. */
  filedVia: string | null;
  createdAt: string;
  updatedAt: string;
  /** v24: the working execution profile and the approval's sealed snapshot. */
  profile?: ExecutionProfile | null;
  approvedProfile?: ExecutionProfile | null;
};

/** One scheduled slot's outcome, fired or skipped — never silent. */
export type RoutineFire = {
  id: number;
  routineId: number;
  scheduledFor: string;
  outcome: "fired" | "skipped";
  reason: string | null;
  instanceTaskRef: number | null;
  createdAt: string;
};

/** Who placed a hold — and therefore who alone may lift it. */
export type HoldOwner = "operator" | "decision" | "incident" | "backoff" | "contest";

export type Hold = {
  id: number;
  taskRef: number;
  ownerKind: HoldOwner;
  ownerId: string;
  reason: string;
  until: string | null;
  heldAt: string;
};

/** Something a repo's work needs. Metadata only; the value lives on the runner. */
export type Capability = {
  repo: string;
  kind: "env" | "cli" | "mcp" | "ci" | "other";
  name: string;
  /** A command whose exit 0 means "present and alive". null: nothing can vouch. */
  probe: string | null;
  status: "unprobed" | "verified" | "failed";
  addedBy: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  /** Whose environment answered the probe. Verification is a claim about one machine. */
  verifiedBy: string | null;
  /** What the probe said when it said no. */
  lastResult: string | null;
  expiresAt: string | null;
};

/** `kind:name`, the unambiguous way a requirement names a capability. */
export function capabilityKey(capability: Pick<Capability, "kind" | "name">): string {
  return `${capability.kind}:${capability.name}`;
}

/** Parse `kind:name`; a bare name is refused rather than guessed at. */
export function parseCapabilityKey(
  key: string,
): { kind: Capability["kind"]; name: string } | null {
  const split = key.indexOf(":");
  if (split <= 0 || split === key.length - 1) return null;
  const kind = key.slice(0, split);
  if (!["env", "cli", "mcp", "ci", "other"].includes(kind)) return null;
  return { kind: kind as Capability["kind"], name: key.slice(split + 1) };
}

/** A fact that wants a person, durably. */
export type Notification = {
  id: number;
  dedupeKey: string;
  kind: string;
  subject: string;
  body: string;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  receipt: string | null;
  /** The closed push attention class, or null = this fact never pushes. */
  pushClass: "decision" | "pick" | "merge" | "attention" | null;
  /** The machine-minted console path a push may deep-link — never free text. */
  link: string | null;
  /**
   * When the fact stopped wanting a person — a decision answered, an incident
   * resolved. Distinct from delivery, and it never deletes the row: receipts
   * are the audit trail of what was actually sent.
   */
  resolvedAt: string | null;
};

/** One build attempt. `outcome` null means it never finished — also an answer. */
export type Run = {
  id: number;
  taskRef: number;
  leaseId: string;
  runner: string;
  /** 'repair' = a resumed session mending its own park payload. Never
   * 'driver'; see the DDL. 'reviewer' (v29) = an artifact-only pass. */
  role: "builder" | "repair" | "planner" | "reviewer";
  /** Which harness ran it. History is 'claude' truthfully: nothing else ever spawned. */
  provider: string;
  parentRun: number | null;
  sessionId: string | null;
  baseRevision: string | null;
  /** v24 dispatch stamps; null on runs from before them. */
  scopeDigest?: string | null;
  profileDigest?: string | null;
  /** NULL on exactly the reviewer role (v29 exclusive CHECK): an
   * artifact-only run never had a workspace, and every consumer must say
   * so rather than dereference one that does not exist. */
  branch: string | null;
  worktree: string | null;
  model: string | null;
  /** 'interrupted' (v25) = a held attended session cut down mid-flight. */
  outcome: "built" | "failed" | "refused" | "parked" | "no-change" | "interrupted" | null;
  reason: string | null;
  /** The attended authorization this run consumed (v25); null = ordinary dispatch. */
  attendedAuthorization?: string | null;
  committed: boolean | null;
  startedAt: string;
  finishedAt: string | null;
  /** Stamped by the invocation gateway just before the provider spawns. */
  providerStartedAt: string | null;
  /** The provider binary's probed version — attested authoritatively for
   * tier-2 providers, best-effort provenance for tier-1 (Phase 3 B2). */
  providerVersion: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** HEAD after the agent, as accepted — what a publication may push. */
  headRevision: string | null;
  /** The validated terminal handoff's conclusion. */
  handoff: string | null;
  /** When racing: which tournament agent this run belongs to. */
  contestant: number | null;
  /**
   * Where the machine is in ITS OWN state machine — stamped by the control
   * plane at boundaries it owns, never parsed from a provider stream (M5.4).
   * Meaningful while the run is open; the last value simply remains after.
   */
  phase: RunPhase | null;
  /**
   * The fallback-chain metadata (v30), NULL on every run outside a chain.
   * `chainCycle`/`chainIndex`/`entryDigest` are stamped at admission (or at
   * base-cycle open) and bind the run to exactly one entry of an immutable
   * approved chain — the runtime re-derives authority from the snapshot,
   * never from these, but reads them to know which entry ran.
   */
  chainCycle?: number | null;
  chainIndex?: number | null;
  entryDigest?: string | null;
  /**
   * How this attempt authenticated (v30) — 'subscription' or 'api-key' —
   * stamped by the gateway. Decides which exhaustion class a match yields.
   */
  authMode?: "subscription" | "api-key" | null;
  /**
   * The gateway's honest classification of how this attempt ENDED (v30),
   * computed at disposal from the structural terminal + the authoritative
   * version + auth mode (exhaustion.ts). Fail-closed: 'unknown' until a
   * fixture-backed recognizer exists. NEVER an authority by itself — the
   * dispatch's C8 gate re-checks hasRecognizer before any advance.
   */
  terminalClass?: TerminalClass | null;
};

/** The bounded activity vocabulary. Machine-authored — a model's prose never becomes one of these. */
export const RUN_PHASES = [
  "agent-running",
  "validating-handoff",
  "capturing-evidence",
  "committing",
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

// ---- attended core (v25, Parity II Phase 2) --------------------------------

/**
 * One person's signed authority for ONE watched attempt (ruling 12). The id
 * is a pre-minted UUID — it IS the attempt identity the dispatch proof
 * consumes. Consumed (attemptRun set) is NOT closed: the authorization
 * stays active across its held session; closure is explicit and terminal.
 */
export type AttendedAuthorization = {
  id: string;
  taskRef: number;
  approver: string;
  runner: string;
  runnerGeneration: number;
  compositeDigest: string;
  termsJson: string;
  maxSessionTurns: number;
  /** A STOP THRESHOLD, not a ceiling: the agent halts when its total crosses it. */
  budgetMicrousd: number;
  /** Continuation: the finished parent attempt, also inside the signed terms. */
  parentRun: number | null;
  followup: string | null;
  createdAt: string;
  absoluteExpiry: string;
  lastBeatAt: string | null;
  attemptRun: number | null;
  consumedAt: string | null;
  closedAt: string | null;
  endReason: string | null;
};

/**
 * One stdin injection into a held session (ruling 15). Author is a verified
 * operator name for 'operator' turns ONLY — brief and repair turns are
 * machine-authored and say so with null. 'uncertain' is TERMINAL: written
 * (or accepted) but never proven settled; charged at its reservation and
 * NEVER reinjected.
 */
export type SessionTurn = {
  id: number;
  run: number;
  seq: number;
  sourceKind: "brief" | "answer" | "operator" | "repair";
  /** The decision id for 'answer' turns, the triggering decision for 'repair'. */
  sourceId: number | null;
  author: string | null;
  text: string;
  reservedMicrousd: number;
  accountedMicrousd: number | null;
  accountedAt: string | null;
  recordedAt: string;
  writtenAt: string | null;
  acceptedAt: string | null;
  settledAt: string | null;
  /** Marginal delta from the held session's durable cumulative baseline. */
  measuredMicrousd: number | null;
  outputTokens: number | null;
  state: "recorded" | "written" | "accepted" | "settled" | "uncertain" | "cancelled";
};

/**
 * Durable crash custody for one held session (ruling 15). The orphan
 * predicate is lease-based; 'fencing' is a helpable, leased state with
 * deadline takeover. cumulativeMicrousd is the settlement baseline the
 * provider's cumulative totals are diffed against.
 */
export type HeldSession = {
  run: number;
  authorizationId: string;
  runner: string;
  leaseId: string;
  upIncarnation: string;
  cookie: string;
  socketPath: string;
  supervisorPid: number | null;
  agentPgid: number | null;
  cumulativeMicrousd: number;
  cumulativeTokensOut: number;
  state: "open" | "fencing";
  fencer: string | null;
  fencingDeadline: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
};

export type RecordTurnRefusal =
  | "no-held-session"
  | "fenced"
  | "turn-cap"
  | "turn-open"
  | "budget-exhausted"
  | "decision-open"
  | "repair-exhausted"
  | "answer-delivered";

/**
 * One operator steering note (arc 1, v22). Attached ≠ delivered: attachment
 * says which build the note rode toward; delivery settles only on the
 * stream's own receipt. Superseded = the task ended with it still pending.
 */
export type SteerNote = {
  /** v24 (ruling 11): "verified" = credentialed authorship; anything else is history, never brief-bound. */
  authorshipState: "verified" | "unverified-legacy";
  supersededReason: string | null;
  id: number;
  taskRef: number;
  author: string;
  note: string;
  createdAt: string;
  attachedRun: number | null;
  attachedAt: string | null;
  deliveredAt: string | null;
  supersededAt: string | null;
};

/** One phone enrollment for web push (arc 3, v23). A row per ACTIVATION —
 * retirement is history, never deletion. */
export type PushSubscription = {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  approver: string;
  approverGeneration: number;
  uaWords: string;
  vapidFingerprint: string;
  startsAfterNotification: number;
  createdAt: string;
  lastOkAt: string | null;
  consecutiveFailures: number;
  retiredAt: string | null;
  retiredReason: string | null;
};

/** One (notification, subscription) push delivery. `accepted` = the push
 * SERVICE took it (RFC 8030) — nothing claims a phone displayed it. */
export type PushPair = {
  id: number;
  notification: number;
  subscription: number;
  state: "pending" | "claimed" | "accepted" | "rejected" | "undeliverable" | "retired";
  claimOwner: string | null;
  claimGeneration: number;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  acceptedAt: string | null;
};

/** One option of a decision. `reversible` is a field so a scheduler can refuse to auto-apply. */
export type DecisionOption = {
  id: string;
  label: string;
  consequence: string;
  reversible: boolean;
};

/** The judgement call an agent refused to guess at (§7). Identity = its run. */
export type Decision = {
  id: number;
  run: number;
  urgency: "blocking";
  state: "open" | "expired" | "answered";
  recap: string;
  question: string;
  options: DecisionOption[];
  /** An option id. */
  recommendation: string;
  assignee: string | null;
  /** Attention metadata only — never a hold expiry. */
  deadline: string | null;
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  answeredVia: "cli" | "web" | "telegram" | null;
  choice: string | null;
  note: string | null;
};

/** Evidence, by reference. `key` is relative to the evidence root, never absolute. */
export type Artifact = {
  id: number;
  run: number;
  kind: "diff" | "status" | "park-payload" | "plan" | "terminal-diff" | "diff-stat" | "handoff" | "revision-brief" | "base-tree";
  key: string;
  bytesOriginal: number;
  bytesStored: number;
  truncated: boolean;
  sha256: string;
  /** The command that produced it, and how that command exited. */
  capture: string;
  createdAt: string;
  redacted: boolean;
  /** Typed verdict of the capture itself (v14); null on rows from before. */
  captureStatus: "ok" | "failed" | null;
};

/** One Telegram chat allowed to answer as one approver. Revoked, never deleted. */
export type TelegramBinding = {
  id: number;
  botId: string;
  chatId: string;
  userId: string;
  approver: string;
  approverGeneration: number;
  pairedAt: string;
  pairedBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
};

/** What one opaque callback token means. The token is all Telegram ever sees. */
export type TelegramAction = {
  token: string;
  binding: number;
  decision: number;
  optionId: string;
  phase: "choose" | "confirm" | "cancel";
  chatId: string;
  messageId: string | null;
  createdAt: string;
  expiresAt: string | null;
  consumedAt: string | null;
  /** Binds a confirm to the exact note it displayed; null = no note armed. */
  noteDigest: string | null;
};

/** A park that never became a decision. Stays in every brief until resolved. */
export type Incident = {
  id: number;
  run: number;
  kind: "malformed-decision" | "attempts-exhausted" | "commit-failure" | "malformed-plan" | "plan-attempts-exhausted";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

/** What a publication grant permits — two external writes, named separately. */
export type PublicationCapability = "push-branch" | "open-pr";

export type PublicationGrant = {
  id: number;
  repo: string;
  /** owner/name on GitHub — exact, never inferred from a remote at publish time. */
  githubRepo: string;
  remote: string;
  /** Only branches under this prefix may be pushed. */
  headPrefix: string;
  base: string;
  capabilities: PublicationCapability[];
  selector: "ours" | "all";
  draft: boolean;
  grantedBy: string;
  grantedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
  /** Merge authority (v21): explicit, default off — its own yes. */
  merge?: boolean;
  mergeMethod?: "squash" | "merge" | "rebase" | null;
  mergeDeleteBranch?: boolean;
};

/** One run's road to a PR, durable at every phase. */
export type Publication = {
  id: number;
  run: number;
  taskRef: number;
  githubRepo: string;
  remote: string;
  base: string;
  head: string;
  /** The exact commit completion accepted — what gets pushed, byte for byte. */
  headSha: string;
  bodyHash: string;
  draft: boolean;
  state: "intended" | "pushed" | "opened" | "failed";
  prNumber: number | null;
  prUrl: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** GitHub's observed verdict — MERGED/CLOSED means done, whatever local state says. */
  remoteState: string | null;
  /** What CI was last SEEN doing (passing/failing/running/none) — never inferred. */
  lastCheckState: string | null;
  lastCheckAt: string | null;
};

/** Every mutation takes one. A repeat returns the first answer, unchanged. */
export type Mutation = {
  idempotencyKey?: string;
  actor?: string;
  /** When it happened. Supplied by callers that hold a clock; see `once`. */
  at?: Date;
};

export const DEFAULT_ACTOR = "operator";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

-- The built-in task store.
CREATE TABLE IF NOT EXISTS task (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0
);

-- Dependency edges, owned natively because this backend is ours. Edges are
-- never emulated on top of a backend that lacks them; see §4.
-- The queue revision (v19): bumped by every EXPLICIT queue edit (drag,
-- assign, next, undo) and CAS-checked by the console's moves, so a second
-- tab's stale drag refuses whole. Scheduler claims deliberately do not
-- bump it — the revision detects competing operators, not dispatch.
CREATE TABLE IF NOT EXISTS queue_state (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO queue_state (id, revision) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS task_edge (
  blocked TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  blocker TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY (blocked, blocker),
  CHECK (blocked <> blocker)
);

-- The overlay starts here. Nothing below this line knows which backend the
-- work actually lives in.
-- The origin column is what the grant's default selector actually rests on.
-- It records whether Standing Orders created this task or merely came across it,
-- and it is written here rather than asserted by whoever is asking to write:
-- a policy that says "only our tasks" while letting the caller declare which
-- those are is not a policy.
CREATE TABLE IF NOT EXISTS task_ref (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  backend                 TEXT NOT NULL,
  external_id             TEXT NOT NULL,
  -- Which repository the work belongs to, when that is known. Capabilities
  -- are repo-scoped, so a gap can only count the tasks it blocks if tasks
  -- say where they live. NULL is honest for a task nobody has placed yet —
  -- it dispatches anywhere, and no gap claims it.
  repo                    TEXT,
  -- The worker this task is reserved for (v19); NULL = any free worker.
  assigned_runner         TEXT,
  zones                   TEXT NOT NULL DEFAULT '[]',
  capability_requirements TEXT NOT NULL DEFAULT '[]',
  park_rate               REAL NOT NULL DEFAULT 0,
  origin                  TEXT NOT NULL DEFAULT 'theirs',
  -- Planning mode (v7): 'requested' dispatches a planner before any scope
  -- is approved; 'drafted' means a proposed scope + plan document await the
  -- operator. NULL is the ordinary task that never asked for a plan.
  plan                    TEXT CHECK (plan IN ('requested','drafted')),
  -- Planning failures count separately from build strikes: a planner that
  -- cannot finish must never spend the builder's three attempts.
  plan_strikes            INTEGER NOT NULL DEFAULT 0,
  -- The standing order this task is an instance of, when it is one (v8).
  -- Ordinary one-off work carries NULL; the board uses this to keep
  -- instances in their track row instead of the main lanes.
  routine_id              INTEGER REFERENCES routine(id),
  -- The pinned agent (v9): which provider/model this task's builds run on,
  -- stamped by the routine fire transaction (digest-authoritative) — a
  -- runtime flag never overrides a pin. NULL = resolve from config.
  agent_provider          TEXT,
  agent_model             TEXT,
  -- A revision task (M6.8): which task's reviewed run it revises, and the
  -- immutable brief artifact carrying the exact comment batch. Every
  -- revision requires its own approval; nothing is inherited.
  revision_of             TEXT,
  revision_brief_artifact INTEGER REFERENCES artifact(id),
  -- Immutable provenance (v12): which door filed this work — 'cli',
  -- 'console', 'intake', 'template:<name>', 'revision'. Stamped once at
  -- filing, never updated; NULL is history from before the column existed.
  filed_via               TEXT,
  UNIQUE (backend, external_id)
);

-- Phase configuration (v9): which provider/model each phase runs on.
-- scope 'installation' is the plane-wide answer; a canonical repo path is
-- that project's override. Rows are COMPLETE pairs (provider required,
-- model optional = harness default), written only through authenticated,
-- audited verbs — spend routing is authority, not preference.
CREATE TABLE IF NOT EXISTS phase_config (
  scope      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('plan','build','repair','review')),
  provider   TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')),
  model      TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
);

-- The fallback chain configuration (v30): the ORDERED fallback entries
-- AFTER the base (which the ordinary phase resolution supplies). Stored as
-- JSON per (scope, phase) — each entry names a provider, model, auth mode,
-- and optional repair model. Resolution folds base + these into the
-- ChainEntry[] the approval seals; nothing dispatches on it until an
-- approval binds it. A new table: it arrives by IF NOT EXISTS on fresh AND
-- upgraded databases alike.
CREATE TABLE IF NOT EXISTS fallback_config (
  scope       TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('build')),
  entries_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
);

-- A standing order (v8): a pre-approved template whose instances build
-- without asking, because the operator agreed to the TEMPLATE — schedule,
-- budget, and "each firing builds unattended" restated at the yes. The
-- digest covers every term that constrains the order, and approval binds to
-- it exactly as a scope approval does: editing any term strands the yes.
CREATE TABLE IF NOT EXISTS routine (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  repo             TEXT NOT NULL,
  goal             TEXT NOT NULL,
  out_of_scope     TEXT,
  touches          TEXT NOT NULL DEFAULT '[]',
  requirements     TEXT NOT NULL DEFAULT '[]',
  -- 'every:<minutes>' or 'daily:<HH:MM>' (UTC). Parsed, never guessed at.
  schedule         TEXT NOT NULL,
  single_flight    INTEGER NOT NULL DEFAULT 1,
  -- Rolling 7-day ceiling in dollars. NULL is honestly "no ceiling";
  -- enforcement FAILS CLOSED on unmeasured paid runs (finding 5).
  cost_ceiling_usd REAL,
  -- Per-INSTANCE dollar cap (v16): copied into each instance's scope as
  -- its digest-bound budget term, enforced by the same native-cap
  -- plumbing as any scope budget. NULL = only the global backstop.
  budget_per_run_microusd INTEGER,
  paused           INTEGER NOT NULL DEFAULT 0,
  digest           TEXT NOT NULL,
  approved_at      TEXT,
  approved_by      TEXT,
  approved_digest  TEXT,
  -- v24: the routine's execution profile; firings stamp instances FROM
  -- the APPROVED snapshot, never from fresh resolution.
  profile_json          TEXT,
  approved_profile_json TEXT,
  digest_version        INTEGER NOT NULL DEFAULT 1,
  profile_provenance    TEXT,
  -- The next scheduled occurrence. NULL until approved; advanced by the
  -- fire transaction and nothing else, aligned to cadence (finding 10).
  next_fire_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- Immutable provenance (v12), same contract as task_ref.filed_via.
  filed_via        TEXT
);

-- Append-only installation facts (v12): set-once markers about THIS
-- database file — 'demo' stamps a sandbox no worker may spend against;
-- 'first-success-at' retires the first-run checklist permanently. Writes
-- go through recordInstallationFact (INSERT OR IGNORE); nothing updates
-- or deletes a fact, so a marker can never be quietly unset.
CREATE TABLE IF NOT EXISTS installation_fact (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL
);


-- Tournament builds (v14). Internal names stay technical; every screen
-- says "tournament", "agents", and "worker processes" in plain words.
--
-- The approved terms are a durable row of their own (round-3 finding 31):
-- immutable once written, one ACTIVE row per task, approved by the same
-- ceremony that approves the scope — the approval binds a joint digest
-- over both. Money is integer micro-dollars; the overrun reserve is the
-- worst one API call the pinned envelope permits, held apart from the
-- spendable budget and never granted to a later invocation.
CREATE TABLE IF NOT EXISTS tournament_terms (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref                  INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  generation                INTEGER NOT NULL,
  active                    INTEGER NOT NULL DEFAULT 1,
  -- v27: 'race' = dollar-capped tournament (money contract required);
  -- 'comparison' = labeled cross-runtime comparison (no dollar terms
  -- exist; each lane's sealed clock is its bound). The money CHECK is
  -- kind-aware: races keep their positive budgets, comparisons pin 0.
  kind                      TEXT NOT NULL DEFAULT 'race' CHECK (kind IN ('race','comparison')),
  race_digest               TEXT NOT NULL,
  -- The ordered agents, JSON: [{provider, model, repairModel}] — exact
  -- model ids, resolved at filing, priced at price_version.
  agents                    TEXT NOT NULL,
  n                         INTEGER NOT NULL CHECK (n BETWEEN 2 AND 4),
  per_agent_budget_microusd INTEGER NOT NULL,
  overrun_reserve_microusd  INTEGER NOT NULL,
  total_budget_microusd     INTEGER NOT NULL,
  price_version             INTEGER NOT NULL,
  retries                   INTEGER NOT NULL CHECK (retries = 0),
  -- 'none', or the JSON of the publication grant constraints in force.
  publication_policy        TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  approved_at               TEXT,
  approved_by               TEXT,
  approved_digest           TEXT,
  CHECK ((kind = 'race' AND per_agent_budget_microusd > 0 AND overrun_reserve_microusd > 0 AND total_budget_microusd > 0)
      OR (kind = 'comparison' AND per_agent_budget_microusd = 0 AND overrun_reserve_microusd = 0 AND total_budget_microusd = 0))
);

-- One active terms row per task (the whole table is new, so this partial
-- index may live here — the v11c trap only bites indexes over columns
-- that older files gain later by addColumn).
CREATE UNIQUE INDEX IF NOT EXISTS tournament_terms_one_active
  ON tournament_terms (task_ref) WHERE active = 1;

-- A running tournament. States are stable machine tokens (envelopes need
-- them); screens translate to plain words at render. The current lease
-- identity lives HERE so aggregation, reaping, and crash recovery all
-- fence on the same facts (finding 17/27).
CREATE TABLE IF NOT EXISTS contest (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref           INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  terms              INTEGER NOT NULL REFERENCES tournament_terms(id),
  generation         INTEGER NOT NULL DEFAULT 1,
  state              TEXT NOT NULL CHECK (state IN
    ('dispatching','racing','pick-wait','decision-wait','picked','abandoned','interrupted','exhausted')),
  scope_digest       TEXT NOT NULL,
  race_digest        TEXT NOT NULL,
  base_sha           TEXT,
  setup_digest       TEXT,
  current_lease_id   TEXT,
  runner             TEXT,
  incarnation        TEXT,
  created_at         TEXT NOT NULL,
  picked_at          TEXT,
  picked_by          TEXT,
  winner_contestant  INTEGER,
  overdue_paged      INTEGER NOT NULL DEFAULT 0,
  -- v24: 1 = legacy race digest (provider/model/repair only) — admission
  -- keeps byte-comparing the stored fingerprint; 2 = full-profile terms.
  race_semantics     INTEGER NOT NULL DEFAULT 1,
  -- v27: denormalized from the terms at admission, so screens, holds,
  -- and recovery speak the right words without a join.
  kind               TEXT NOT NULL DEFAULT 'race'
);

CREATE INDEX IF NOT EXISTS contest_by_task ON contest (task_ref, id DESC);

-- One racing agent. Money is three columns kept deliberately apart
-- (finding 25): measured = what the provider reported, monotonic;
-- accounted = what the ledger charges (the full reservation when the
-- real figure is unknowable); unknown_spend = the honest flag that the
-- two differ. Custody (finding 29) records who owns the checkout while
-- a parked agent waits on an answer.
CREATE TABLE IF NOT EXISTS contestant (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  contest             INTEGER NOT NULL REFERENCES contest(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  repair_model        TEXT NOT NULL,
  -- v24: the contestant's full execution-profile snapshot (canonical JSON).
  profile_json        TEXT,
  branch              TEXT NOT NULL,
  worktree            TEXT,
  generation          INTEGER NOT NULL DEFAULT 1,
  state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','ready','building','parked','built','failed','stopped')),
  active_run          INTEGER REFERENCES run(id),
  budget_microusd     INTEGER NOT NULL,
  reserve_microusd    INTEGER NOT NULL,
  measured_microusd   INTEGER NOT NULL DEFAULT 0,
  accounted_microusd  INTEGER NOT NULL DEFAULT 0,
  unknown_spend       INTEGER NOT NULL DEFAULT 0,
  cleanup             TEXT CHECK (cleanup IN ('pending','done','attention')),
  custody             TEXT,
  UNIQUE (contest, ordinal)
);

-- One row per worker process, ordinary builds and tournaments alike
-- (finding 26): reserved before anything spawns, running once the
-- process exists (with its group id, so recovery can check the OS
-- before calling the capacity back), released on observed exit. The
-- capacity a runner enforces in 'processes' mode counts these rows.
CREATE TABLE IF NOT EXISTS execution_slot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  runner        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','running','released')),
  run           INTEGER REFERENCES run(id),
  contestant    INTEGER REFERENCES contestant(id),
  incarnation   TEXT,
  process_group INTEGER,
  reserved_at   TEXT NOT NULL,
  running_at    TEXT,
  released_at   TEXT
);

CREATE INDEX IF NOT EXISTS execution_slot_live ON execution_slot (runner, state);

-- Durable ceremony nonces (finding 21/30): minted by a POST (never a
-- GET), stored hashed, consumed CONDITIONALLY inside the same
-- transaction as the act they authorize — which the in-memory map could
-- never promise. Scope-approval nonces stay in memory this release, by
-- ruling.
CREATE TABLE IF NOT EXISTS ceremony_nonce (
  hash        TEXT PRIMARY KEY,
  approver    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  subject_id  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS ceremony_nonce_expiry ON ceremony_nonce (expires_at);

-- Spend defaults (v15, operator request): global dollar thresholds, set by
-- the authenticated config verb. Defaults PREFILL filings and act as an
-- installation-wide backstop; the digest-bound scope term stays the
-- per-task authority — a default never silently edits an approval.
CREATE TABLE IF NOT EXISTS spend_defaults (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  build_per_run_microusd   INTEGER,
  race_per_agent_microusd  INTEGER,
  race_total_microusd      INTEGER,
  -- How many agents compete by default (v16, operator request). Applies
  -- only where a filing names ONE agent and no explicit count — an
  -- explicit list or count always wins, and the race digest binds the
  -- actual lineup either way.
  race_agents              INTEGER CHECK (race_agents BETWEEN 2 AND 4),
  updated_at               TEXT NOT NULL,
  updated_by               TEXT NOT NULL
);

-- Fleet chat (v13). Chat providers are DIRECT API adapters, deliberately a
-- separate type from the build harnesses (Codex v3 review, change 1): a
-- shared table would admit invalid pairs like build+anthropic-api. One
-- installation-scoped row; written only by the authenticated config verb.
CREATE TABLE IF NOT EXISTS chat_config (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  provider                TEXT NOT NULL CHECK (provider IN ('anthropic-api','openrouter-api')),
  model                   TEXT NOT NULL,
  daily_turns             INTEGER NOT NULL DEFAULT 50,
  -- The rolling 7-day spend ceiling, integer micro-dollars (change 4):
  -- reservations count against it transactionally; NOT NULL because a
  -- chat without a ceiling is not configured, it is unbounded.
  weekly_ceiling_microusd INTEGER NOT NULL,
  -- The PINNED price (v13b): snapshotted from the provider's own catalog
  -- (or the compiled table) at the authenticated save, integer
  -- micro-dollars per token. Reservations and settlement use THESE, so an
  -- upstream price change never silently moves the ledger math —
  -- re-saving re-pins. NULL only on rows written before the columns
  -- existed; readers fall back to the compiled table then.
  price_in_microusd       INTEGER,
  price_out_microusd      INTEGER,
  updated_at              TEXT NOT NULL,
  updated_by              TEXT NOT NULL
);

-- One chat turn = one possible API request. METADATA ONLY — no prompt, no
-- reply, no free text (v2 finding 12); failure_reason is a CLOSED enum.
-- Spend is accounted in integer micro-dollars: reserved worst-case at
-- insert (input estimate + max_tokens at the pinned price), settled from
-- the provider's usage block. A turn that MAY have started but whose cost
-- is unknown latches unknown_spend=1 and blocks its credential until the
-- acknowledgement ceremony records who accepted the worst case (change 5/6).
CREATE TABLE IF NOT EXISTS chat_turn (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  approver          TEXT NOT NULL,
  -- Domain-separated sha256 over provider+key, full hex — a stable,
  -- non-secret accounting identity (128+ bits per change 6).
  credential_key    TEXT NOT NULL,
  provider          TEXT NOT NULL CHECK (provider IN ('anthropic-api','openrouter-api')),
  model             TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('queued','running','answered','failed')),
  -- Terminal transitions are generation-checked CAS: a late response
  -- cannot resurrect a swept row (change 5).
  generation        INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  deadline_at       TEXT,
  finished_at       TEXT,
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  reserved_microusd INTEGER NOT NULL,
  settled_microusd  INTEGER,
  failure_reason    TEXT CHECK (failure_reason IN
    ('provider-error','timeout','over-budget','malformed-reply','secret-refused','crashed','over-cap','unknown-spend')),
  unknown_spend     INTEGER NOT NULL DEFAULT 0,
  acknowledged_at   TEXT,
  acknowledged_by   TEXT,
  reply_bytes       INTEGER,
  candidate_count   INTEGER
);

CREATE INDEX IF NOT EXISTS chat_turn_credential ON chat_turn (credential_key, created_at);
CREATE INDEX IF NOT EXISTS chat_turn_approver ON chat_turn (approver, created_at);

-- The firing ledger (v8): one row per scheduled slot, fired or skipped.
-- UNIQUE (routine_id, scheduled_for) is the idempotency — two passes both
-- finding the same due slot insert once, and the second learns it lost.
-- Skips are recorded, not silent: a budget block or a single-flight block
-- must render as a hollow dot, not read as "covered" (finding 10).
CREATE TABLE IF NOT EXISTS routine_fire (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id        INTEGER NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
  scheduled_for     TEXT NOT NULL,
  outcome           TEXT NOT NULL CHECK (outcome IN ('fired','skipped')),
  reason            TEXT,
  instance_task_ref INTEGER REFERENCES task_ref(id),
  created_at        TEXT NOT NULL,
  UNIQUE (routine_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS routine_fire_recent ON routine_fire (routine_id, id DESC);

-- A hold is an operational pause, not a claim about the work's structure,
-- which is why it may live out here while dependency edges may not.
--
-- Every hold has an owner, because "lift the hold" is only safe when the
-- lifter and the placer are the same authority. One row per task let a
-- decision's answer delete an operator's unrelated pause — or a later manual
-- hold silently replace the one keeping a parked task off the ready set.
-- UNIQUE (owner_kind, owner_id) keeps each owner to one hold; readiness
-- rejects on ANY active row, so two owners holding one task both count.
CREATE TABLE IF NOT EXISTS hold (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff','contest')),
  owner_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  until      TEXT,
  held_at    TEXT NOT NULL,
  UNIQUE (owner_kind, owner_id)
);

-- One row per lease, not per task: the claim log is append-only.
--
-- Overwriting a task's claim on reclaim would erase the superseded lease, and
-- then a runner coming back from the dead to report its work could only be
-- told "I have never heard of that lease" — indistinguishable, from where it
-- is standing, from talking to the wrong database. Keeping the row lets it be
-- told the truth: you were superseded, at this generation, by this runner.
--
-- UNIQUE (task_ref, lease_generation) *is* the compare-and-swap. Two runners
-- racing both compute the same next generation; the database lets exactly one
-- of them insert it.
CREATE TABLE IF NOT EXISTS claim (
  lease_id         TEXT PRIMARY KEY,
  task_ref         INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  lease_generation INTEGER NOT NULL,
  runner           TEXT NOT NULL,
  acquired_at      TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  heartbeat_at     TEXT NOT NULL,
  released_at      TEXT,
  -- Who let go, because "released" alone conflates four different events:
  -- the runner handing it back ('released'), a completion being accepted
  -- ('completed'), expiry reap ('reaped'), and dead-runner recovery
  -- ('recovered'). A retry that finds its lease released must know which:
  -- answering "duplicate" to a runner whose lease was in fact reclaimed
  -- would accept work the reclaim already disowned.
  released_by      TEXT,
  UNIQUE (task_ref, lease_generation)
);

-- A capability: something a repo's work needs that this machine either has
-- or does not — a credential in the environment, a CLI that is logged in, an
-- MCP server that answers. Metadata only, and the absence of a value column
-- is load-bearing (§3): the control plane records "present, verified at T",
-- and the value itself lives on the runner, in a keychain or a gitignored
-- .env, where a database dump cannot leak it.
CREATE TABLE IF NOT EXISTS capability (
  repo             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('env','cli','mcp','ci','other')),
  name             TEXT NOT NULL,
  probe            TEXT,
  status           TEXT NOT NULL DEFAULT 'unprobed' CHECK (status IN ('unprobed','verified','failed')),
  added_by         TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_verified_at TEXT,
  -- Who ran the probe that produced this status. Verification is a claim
  -- about one environment: the machine whose shell answered. Another runner
  -- trusts it only by re-proving it where it stands, which is what tick does.
  verified_by      TEXT,
  -- The probe's own words when it said no — "exit 1", "timed out", "sh not
  -- found". Collapsing those into one bit would discard exactly the detail
  -- that tells an operator whether to paste a key or fix a PATH.
  last_result      TEXT,
  expires_at       TEXT,
  PRIMARY KEY (repo, kind, name)
);

-- One build attempt, durable. The in-memory BuildResult evaporates with the
-- process; the morning briefing, and anybody asking "what happened to t-1
-- overnight", need the answer to survive a crash. A row is written before
-- the agent runs and finalized after — outcome NULL means the attempt was
-- cut down mid-flight, which is itself worth knowing.
CREATE TABLE IF NOT EXISTS run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  lease_id      TEXT NOT NULL,
  runner        TEXT NOT NULL,
  -- v24 dispatch stamps: the digests this invocation was PROVED against
  -- (warm resume matches on both), and the provider CLI version as
  -- provenance — never authority.
  scope_digest     TEXT,
  profile_digest   TEXT,
  provider_version TEXT,
  -- 'repair' is a resumed session mending its own malformed park payload.
  -- Deliberately NOT 'driver': the design's driver is the event-woken gate
  -- role that first exists at M4, and recording repair under that name now
  -- would make the two indistinguishable in every cost report afterwards.
  role          TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair','planner','reviewer')),
  -- Which provider harness this attempt ran on (v9). The default is a
  -- truthful backfill for history: every run before v9 passed through the
  -- fixed claude gateway. New dispatches always supply it explicitly.
  provider      TEXT NOT NULL DEFAULT 'claude',
  parent_run    INTEGER REFERENCES run(id),
  -- The agent session, kept so a malformed park can be repaired by resuming
  -- the conversation that produced it instead of paying for a fresh one.
  session_id    TEXT,
  -- HEAD before the agent spent anything. Evidence is a diff against this,
  -- not against whatever the index looked like when the agent stopped: an
  -- agent that staged or committed before parking would otherwise show a
  -- clean diff over material changes.
  base_revision TEXT,
  branch        TEXT,
  worktree      TEXT,
  model         TEXT,
  phase         TEXT,
  contestant    INTEGER REFERENCES contestant(id),
  -- 'interrupted' (v25) is a held attended session cut down mid-flight —
  -- fence, expiry, crash custody, or shutdown. A real word, never a
  -- synthesized park; the one-shot road keeps writing failed/interrupted
  -- as outcome+reason exactly as before.
  outcome       TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change','interrupted')),
  reason        TEXT,
  committed     INTEGER,
  -- The attended authorization this run consumed (v25) — the ruling-12
  -- attempt identity, stamped in the same transaction that consumes the
  -- one attempt. NULL = ordinary approved/tournament dispatch.
  attended_authorization TEXT REFERENCES attended_authorization(id),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  -- Stamped by the invocation gateway the instant before the provider
  -- process spawns. A run without it never paid anything; the zero-token
  -- invariant is "provider spawns == runs carrying this stamp".
  provider_started_at TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  -- The provider's own usage object, bounded, for when the parsed columns
  -- above turn out to have missed something. NULL = unmeasured, and the
  -- brief says so rather than summing a lie.
  usage_json    TEXT,
  -- HEAD after the agent, as accepted. The builder owns commits; an agent
  -- that moved HEAD itself is refused, so this names the exact commit any
  -- publication may push.
  head_revision TEXT,
  -- The validated terminal handoff's conclusion — bounded, typed at
  -- ingestion, and the only agent prose a PR body may quote.
  handoff       TEXT,
  -- v29 (the reviewer role): artifact-only runs carry NO workspace,
  -- honestly — every other role requires both (exclusive, no sentinels).
  CHECK ((role = 'reviewer' AND branch IS NULL AND worktree IS NULL)
      OR (role <> 'reviewer' AND branch IS NOT NULL AND worktree IS NOT NULL))
);

-- The decision record (§7): the judgement call an agent refused to guess at,
-- typed so it renders identically every time and fits on a phone. "run" is
-- the decision's whole identity — task, repo, branch, and lease are reached
-- by joining through it, never stored again here, because two copies of an
-- identity is how a decision ends up holding one task while showing another
-- task's evidence. v25 dropped the one-decision-per-run UNIQUE: a held
-- attended session parks, is answered, continues, and parks again — many
-- decisions, one run. At most ONE unresolved decision per run (partial
-- unique, post-migration block).
CREATE TABLE IF NOT EXISTS decision (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  urgency        TEXT NOT NULL CHECK (urgency IN ('blocking')),
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','expired','answered')),
  recap          TEXT NOT NULL,
  question       TEXT NOT NULL,
  options        TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  assignee       TEXT,
  -- Attention metadata only. A deadline is never a hold expiry: a blocking
  -- decision that goes overdue becomes 'expired' and MORE visible, not a
  -- task that quietly dispatches itself unanswered.
  deadline       TEXT,
  created_at     TEXT NOT NULL,
  answered_at    TEXT,
  answered_by    TEXT,
  -- Which racing agent asked (v14); lets one-open-question-per-agent be a
  -- real database rule instead of a hope (finding 28). NULL = ordinary.
  contestant     INTEGER REFERENCES contestant(id),
  -- Typed closure (v14): 'excluded' = the operator stopped the asking
  -- agent instead of answering. Never a fake option.
  closed_reason  TEXT CHECK (closed_reason IN ('excluded')),
  answered_via   TEXT CHECK (answered_via IN ('cli','web','telegram')),
  choice         TEXT,
  note           TEXT,
  -- v25 held-session linkage. session_turn = the turn whose settlement
  -- produced this park (causal, held runs only). delivered_turn = the
  -- answer turn that claimed delivery into the live session — the
  -- delivery-CAS target: set once (WHERE delivered_turn IS NULL), reverted
  -- only when that turn terminally never reached acceptance.
  session_turn   INTEGER REFERENCES session_turn(id),
  delivered_turn INTEGER REFERENCES session_turn(id)
);

-- Evidence, by reference (§4): the file lives on the runner under the
-- evidence root, and "key" is relative to that root — never an absolute path
-- a row could point anywhere with. The capture columns record how the file
-- was made and whether it is complete, because a truncated diff presented as
-- the whole story is worse than no diff.
CREATE TABLE IF NOT EXISTS artifact (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree')),
  key            TEXT NOT NULL,
  bytes_original INTEGER NOT NULL,
  bytes_stored   INTEGER NOT NULL,
  truncated      INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT NOT NULL,
  capture        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  redacted       INTEGER NOT NULL DEFAULT 0,
  -- Typed capture verdict (v14, finding 20): authority never parses the
  -- prose capture description again. NULL = recorded before v14.
  capture_status TEXT CHECK (capture_status IN ('ok','failed'))
);

-- Which artifacts a decision shows. A relation rather than JSON ids in the
-- decision row, so "artifact.run = decision.run" can be enforced at insert —
-- the agent's own payload never chooses what counts as evidence.
CREATE TABLE IF NOT EXISTS decision_artifact (
  decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  artifact INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  PRIMARY KEY (decision, artifact)
);

-- Which answers a resume run was actually given, snapshot included — causal
-- provenance, not timestamps. "The run after the answer" stops being true the
-- moment a resume fails and a second decision is answered in between.
CREATE TABLE IF NOT EXISTS run_decision (
  run      INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  decision INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  choice   TEXT NOT NULL,
  note     TEXT,
  PRIMARY KEY (run, decision)
);

-- A durable attention record for the parks that never became decisions: the
-- agent tried to park, repair ran out, and the task is now held with nothing
-- in DECIDE to show for it. Unlike a failed run, an incident cannot age out
-- of a briefing window — it stays in every brief until somebody resolves it.
CREATE TABLE IF NOT EXISTS incident (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure','malformed-plan','plan-attempts-exhausted')),
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);

-- The durable outbox (§6). A notification is a fact that something wants a
-- person, recorded next to the record that made it true — because one that
-- lives only in a process's memory dies with the process, at exactly the
-- moment it was most worth sending. dedupe_key is an episode identity: a
-- gap nags once per occurrence, not once per cron firing and not forever.
CREATE TABLE IF NOT EXISTS notification (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key      TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error      TEXT,
  delivered_at    TEXT,
  -- What the delivery command said on success — the closest thing to a
  -- provider receipt a shell command can hand back.
  receipt         TEXT,
  -- The push surface (arc 3, v23): a CLOSED attention class and a
  -- machine-minted console link, stamped by producers at enqueue.
  -- Unstamped kinds never reach a phone; subject/body never do either.
  push_class      TEXT CHECK (push_class IN ('decision','pick','merge','attention')),
  link            TEXT
);

-- Permission to write to a tracker, one row per repository and backend.
-- Absence of a row is denial; there is no wildcard and no inheritance.
CREATE TABLE IF NOT EXISTS backend_grant (
  repo             TEXT NOT NULL,
  backend          TEXT NOT NULL,
  paths            TEXT NOT NULL DEFAULT '[]',
  mutations        TEXT NOT NULL DEFAULT '[]',
  selector         TEXT NOT NULL,
  credential_scope TEXT,
  observed_by_git  INTEGER NOT NULL,
  granted_at       TEXT NOT NULL,
  granted_by       TEXT NOT NULL,
  -- External dispatch (v20): a SEPARATE authority from tracker writes —
  -- "this plane will BUILD what this tracker nominates". Never granted
  -- by default; dispatch=1 requires remote_repo and plane_id (enforced
  -- in saveGrant — ALTER ADD COLUMN cannot carry cross-column CHECKs).
  dispatch                INTEGER NOT NULL DEFAULT 0 CHECK (dispatch IN (0, 1)),
  remote_repo             TEXT,
  plane_id                TEXT,
  dispatch_blocked        TEXT CHECK (dispatch_blocked IN ('pending-marker','unreachable','foreign','missing','multiple-or-malformed')),
  dispatch_blocked_at     TEXT,
  dispatch_blocked_detail TEXT,
  PRIMARY KEY (repo, backend)
);

-- The external mirror (v20): a synced tracker item, dispatchable as an
-- ORDINARY local task. Identity and provenance are immutable — labels
-- and titles may nominate work; only this row establishes whose it is.
CREATE TABLE IF NOT EXISTS external_mirror (
  local_task_id   TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  backend         TEXT NOT NULL,
  remote_repo     TEXT NOT NULL,
  remote_id       TEXT NOT NULL,
  provenance      TEXT NOT NULL CHECK (provenance IN ('local-create','intake','granted-all')),
  intake_grant    INTEGER,
  established_by  TEXT NOT NULL,
  established_at  TEXT NOT NULL,
  remote_state    TEXT NOT NULL CHECK (remote_state IN ('open','closed','missing')),
  close_generation INTEGER,
  sync_generation INTEGER NOT NULL DEFAULT 0,
  dispatch_ok     INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_ok IN (0, 1)),
  reopened_by     TEXT,
  reopened_at     TEXT,
  CHECK ((provenance = 'intake') = (intake_grant IS NOT NULL)),
  UNIQUE (backend, remote_repo, remote_id)
);

-- Immutability guard: identity/provenance columns refuse CHANGES; an
-- upsert rewriting identical values passes.
CREATE TRIGGER IF NOT EXISTS external_mirror_immutable
BEFORE UPDATE ON external_mirror
WHEN OLD.backend IS NOT NEW.backend OR OLD.remote_repo IS NOT NEW.remote_repo
  OR OLD.remote_id IS NOT NEW.remote_id OR OLD.provenance IS NOT NEW.provenance
  OR OLD.intake_grant IS NOT NEW.intake_grant
  OR OLD.established_by IS NOT NEW.established_by OR OLD.established_at IS NOT NEW.established_at
BEGIN
  SELECT RAISE(ABORT, 'external mirror identity is immutable');
END;

-- One row per sync pass; only a COMPLETE pass advances mirror
-- generations (a capped or failed scan proves nothing about absence).
CREATE TABLE IF NOT EXISTS sync_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  backend     TEXT NOT NULL,
  remote_repo TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT CHECK (outcome IN ('complete','capped','failed')),
  candidates  INTEGER NOT NULL DEFAULT 0,
  mirrored    INTEGER NOT NULL DEFAULT 0,
  detail      TEXT,
  UNIQUE (backend, remote_repo, generation)
);

-- Durable write-back intents: delivery has its own ledger; a run's
-- outcome is never rewritten by a tracker write failing.
CREATE TABLE IF NOT EXISTS external_intent (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mirror       TEXT NOT NULL REFERENCES external_mirror(local_task_id),
  kind         TEXT NOT NULL CHECK (kind IN ('comment','transition','close')),
  body         TEXT,
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','refused')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);

-- The merge grant's evidence (v21): the LATEST CI observation per PR,
-- generation-ordered so a stalled older response can never overwrite —
-- or authorize past — a newer one. Only a WINNING settle has effects.
CREATE TABLE IF NOT EXISTS ci_observation (
  github_repo TEXT NOT NULL,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('passing','failing','running','none')),
  generation  INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (github_repo, pr_number)
);

-- Durable merge intents (v21): one per publication, claim-leased with a
-- generation fence so overlapping passes cannot double-fire and a crash
-- can never strand a claim or leave "did it merge?" ambiguous.
CREATE TABLE IF NOT EXISTS merge_intent (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  publication   INTEGER NOT NULL UNIQUE REFERENCES publication(id),
  grant_terms_hash TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('squash','merge','rebase')),
  delete_branch INTEGER NOT NULL DEFAULT 0 CHECK (delete_branch IN (0, 1)),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','waiting-human','firing','merged','refused','superseded')),
  claimed_by    TEXT,
  claimed_until TEXT,
  -- v29 (modes): WHOSE signature this intent fires under, bound at
  -- creation and re-proved in the firing CAS — 'grant' = the grant
  -- ceremony's own unattended-merge signature; 'mode' = a live automerge
  -- mode; 'human' = the per-merge password ceremony.
  authority_basis TEXT NOT NULL DEFAULT 'grant' CHECK (authority_basis IN ('grant','mode','human')),
  mode_digest   TEXT,
  -- v29: the durable one-winner linearization point — the CAS into
  -- 'firing' stamps both; staleness is firing_deadline passing, never a
  -- guess.
  firing_at     TEXT,
  firing_deadline TEXT,
  generation    INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  receipt       TEXT,
  created_at    TEXT NOT NULL,
  settled_at    TEXT,
  CHECK (state <> 'claimed' OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL)),
  CHECK (state <> 'firing' OR (firing_at IS NOT NULL AND firing_deadline IS NOT NULL))
);

-- A CI repair in flight durably blocks its source PR's merge (v21).
-- STICKY by design: no task-lifecycle path touches it — it lifts only
-- by the authenticated unblock act or the PR itself closing remotely.
CREATE TABLE IF NOT EXISTS merge_blocker (
  publication INTEGER NOT NULL REFERENCES publication(id),
  reason      TEXT NOT NULL CHECK (reason IN ('repair-open')),
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  -- v29: lifting is a stamp, not a DELETE — who unblocked, and when, is
  -- an audit answer the People screen promises. One LIVE blocker per
  -- publication (partial unique in the post-migration block); lifted
  -- rows are history and never block a new block.
  lifted_at   TEXT,
  lifted_by   TEXT
);

-- An OPERATING MODE (v29): a per-repository, password-signed, expiring
-- envelope that pre-authorizes the SIGNER'S OWN future acts — filing
-- approvals, quick mints, escalated permission defaults, automerge —
-- through the exact predicates the design chain binds. The absence of a
-- row is 'locked': today's ceremony-per-act world, the default forever.
-- Raising authority is a password ceremony; revoking is one click; every
-- transition is an event row.
CREATE TABLE IF NOT EXISTS operating_mode (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo            TEXT NOT NULL,
  name            TEXT NOT NULL CHECK (name IN ('standard','hands-off')),
  terms_json      TEXT NOT NULL,
  digest          TEXT NOT NULL,
  signed_by       TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  signed_at       TEXT NOT NULL,
  absolute_expiry TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_by      TEXT,
  revoke_reason   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_mode_per_repo
  ON operating_mode (repo) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS operating_mode_event (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  mode     INTEGER NOT NULL REFERENCES operating_mode(id),
  kind     TEXT NOT NULL CHECK (kind IN ('signed','renewed','revoked','expired-closed','signer-revoked')),
  actor    TEXT NOT NULL,
  at       TEXT NOT NULL
);

-- A single-use invite (v29): 128-bit token, sha256 stored, role pinned at
-- mint. attempts meters ADMITTED submissions — the slot is spent
-- atomically BEFORE the KDF runs, and never refunded.
CREATE TABLE IF NOT EXISTS invite (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('approver','viewer')),
  minted_by   TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  minted_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_by TEXT,
  consumed_at TEXT,
  revoked_at  TEXT
);

-- The daily rails' reservation counter (v29): one row per repo per UTC
-- day, incremented atomically at admission — never a query-then-hope.
CREATE TABLE IF NOT EXISTS mode_rail (
  repo            TEXT NOT NULL,
  utc_day         TEXT NOT NULL,
  reserved_starts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, utc_day)
);

-- What a task is allowed to become, and whether a person agreed to it.
--
-- approved_digest is the whole mechanism: approval records the exact scope it
-- saw, so rewriting the scope afterwards does not carry the approval with it.
CREATE TABLE IF NOT EXISTS task_scope (
  task_id         TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  goal            TEXT NOT NULL,
  out_of_scope    TEXT,
  touches         TEXT NOT NULL DEFAULT '[]',
  proposed_at     TEXT NOT NULL,
  digest          TEXT NOT NULL,
  -- The dollar cap per build attempt, integer micro-dollars (v15):
  -- approved spend, digest-bound, enforced by the provider's own stop.
  budget_microusd INTEGER,
  approved_at     TEXT,
  approved_by     TEXT,
  approved_digest TEXT,
  -- The execution profile (v24, Parity II foundations): WHAT RUNS, bound
  -- into what the operator signs. profile_json = the working profile;
  -- approved_profile_json = the immutable snapshot the approval act took;
  -- digest_version 1 = legacy fields-only digest (grandfathered), 2 =
  -- profile-bearing. profile_state 'unresolved' blocks dispatch AND
  -- approval, with its reason in words. Provenance (resolvedFrom,
  -- grandfathered, provider version) lives in profile_provenance and
  -- NEVER enters a digest.
  profile_json          TEXT,
  profile_state         TEXT NOT NULL DEFAULT 'resolved' CHECK (profile_state IN ('resolved','unresolved')),
  unresolved_reason     TEXT,
  approved_profile_json TEXT,
  digest_version        INTEGER NOT NULL DEFAULT 1,
  profile_provenance    TEXT,
  -- The EXPLICIT fallback chain (v30, fallback chains). proposed_chain_json
  -- is the WORKING snapshot saveScope binds the digest to when the repo has
  -- configured fallbacks (mirrors profile_json); approved_chain_json is the
  -- immutable snapshot the approval COPIED from it (mirrors
  -- approved_profile_json = profile_json), so what is sealed is exactly what
  -- the signed digest bound — never re-resolved. Both NULL = a legacy
  -- single-profile (or no-profile) scope, untouched. approval_kind names
  -- which the approval sealed: 'profile' (legacy) or 'chain'.
  proposed_chain_json   TEXT,
  approved_chain_json   TEXT,
  approval_kind         TEXT NOT NULL DEFAULT 'profile' CHECK (approval_kind IN ('profile','chain'))
);

-- Whoever is allowed to say yes to a scope.
--
-- Separate from a runner on purpose: a runner is a machine that does work, and
-- an approver is a person who agrees to it. Sharing one table would mean any
-- credential that can take a task can also approve one, which is the exact
-- collapse this whole gate exists to prevent.
CREATE TABLE IF NOT EXISTS approver (
  name            TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL,
  added_at        TEXT NOT NULL,
  -- v29 (multi-user): 'viewer' authenticates and reads; every
  -- consequential act requires ACTIVE role 'approver'. Revocation is a
  -- stamp — history stays attributable forever.
  role            TEXT NOT NULL DEFAULT 'approver' CHECK (role IN ('approver','viewer')),
  revoked_at      TEXT,
  revoked_by      TEXT,
  -- Bumped whenever the credential is replaced. Anything that derives
  -- authority from an approver — a paired Telegram chat, an outstanding
  -- pairing code — records the generation it was granted under, and a
  -- rotation strands every grant from the old one.
  generation      INTEGER NOT NULL DEFAULT 1
);

-- One Telegram chat speaking as one approver. Bindings are never deleted:
-- revocation is a stamp, because "who could answer as whom, when" is an
-- audit question a DELETE cannot answer. The partial unique index is the
-- v1 rule that exactly one binding is live per bot at a time.
CREATE TABLE IF NOT EXISTS telegram_binding (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id              TEXT NOT NULL,
  chat_id             TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  approver            TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  approver_generation INTEGER NOT NULL,
  paired_at           TEXT NOT NULL,
  paired_by           TEXT NOT NULL,
  pair_update_id      INTEGER,
  revoked_at          TEXT,
  revoked_by          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_binding_live
  ON telegram_binding (bot_id) WHERE revoked_at IS NULL;

-- One-time pairing codes, hashed like every other credential, consumed in
-- one transaction with the binding they create.
CREATE TABLE IF NOT EXISTS telegram_pairing (
  code_hash       TEXT PRIMARY KEY,
  approver        TEXT NOT NULL REFERENCES approver(name) ON DELETE RESTRICT,
  approver_generation INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_chat   TEXT,
  consumed_user   TEXT,
  consumed_update INTEGER
);

-- Every Telegram update this installation has applied, exactly once. The
-- PRIMARY KEY is the idempotency: a replayed batch re-applies nothing.
CREATE TABLE IF NOT EXISTS telegram_update (
  update_id  INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  result     TEXT NOT NULL
);

-- Opaque one-tap actions. callback_data carries only the random token; what
-- the tap MEANS — which binding, decision, option, and phase — lives here,
-- where a stolen bot token cannot read or forge it. Confirm challenges are
-- short-lived rows in the same table, consumed exactly once.
CREATE TABLE IF NOT EXISTS telegram_action (
  token       TEXT PRIMARY KEY,
  binding     INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE RESTRICT,
  decision    INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  option_id   TEXT NOT NULL,
  phase       TEXT NOT NULL CHECK (phase IN ('choose','confirm','cancel')),
  chat_id     TEXT NOT NULL,
  message_id  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS telegram_action_by_decision ON telegram_action (decision);

-- Which outbound Telegram message carries which decision (v10). A free-text
-- reply is routed through the EXACT message it replies to — never "the
-- latest decision", never "the only open one" (Codex free-text review,
-- finding 1). Losing the send/record race fails closed: an unrecorded
-- message routes nothing.
CREATE TABLE IF NOT EXISTS telegram_decision_message (
  binding    INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE CASCADE,
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  decision   INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding, chat_id, message_id)
);

-- The free-text draft (v10): an operator's note, held immutable and
-- expiring until a TAP commits it with the choice. One live draft per
-- (binding, decision); a newer valid reply SUPERSEDES, never edits.
CREATE TABLE IF NOT EXISTS telegram_note_draft (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  binding    INTEGER NOT NULL REFERENCES telegram_binding(id) ON DELETE CASCADE,
  decision   INTEGER NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  update_id  INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  reply_to   TEXT NOT NULL,
  note       TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','armed','superseded','consumed','discarded')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_note_draft_live
  ON telegram_note_draft (binding, decision) WHERE state IN ('pending','armed');

-- The bridge's poll lease and cursor, per bot. One live poller at a time;
-- the cursor only ever moves forward, and only under a live generation.
CREATE TABLE IF NOT EXISTS bridge_lease (
  bot_id       TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  cursor       INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

-- Provider quota, keyed to what actually exhausts: one runner's credential
-- against one provider and scope — never the whole runner (§8 gate 3). A
-- free CPU slot against an exhausted quota is not capacity. 'half-open'
-- admits exactly one real dispatch after the reset; its success clears the
-- row, the same structured signal re-stamps it. Nothing stamps this from
-- stderr prose — only structured signals or an operator.
-- The scheduler's durable wake signal. Every readiness-changing write bumps
-- the sequence; watch records what it saw before a pass and runs again
-- immediately if the world moved while it worked. A boolean dirty flag
-- loses the wake that lands mid-pass; a monotonic sequence cannot.
CREATE TABLE IF NOT EXISTS wake (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO wake (id, seq) VALUES (1, 0);

-- One watch per (runner, repo), with an incarnation the claims it dispatches
-- carry. A restarted watch that heartbeats before its dead predecessor is
-- noticed would otherwise mask the crash forever (finding 8): recovery is
-- keyed to the superseded incarnation, not to runner liveness.
CREATE TABLE IF NOT EXISTS watch_lease (
  runner       TEXT NOT NULL,
  repo         TEXT NOT NULL,
  owner        TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (runner, repo)
);

CREATE TABLE IF NOT EXISTS quota (
  runner      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  -- v30 (fallback chains): quota identity must distinguish a subscription
  -- from an API key, else exhausting a claude subscription would wrongly
  -- block a claude api-key fallback. auth_mode + a stable NON-SECRET
  -- credential fingerprint join the key. Defaults keep every pre-v30 row
  -- identical (mode 'subscription', empty fp) since that is what they were.
  auth_mode   TEXT NOT NULL DEFAULT 'subscription' CHECK (auth_mode IN ('subscription','api-key')),
  credential_fp TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL CHECK (state IN ('exhausted','half-open')),
  reason      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reset_at    TEXT,
  PRIMARY KEY (runner, provider, scope, auth_mode, credential_fp)
);

-- A fallback CYCLE (v30): one durable attempt to walk an approved chain
-- for one task. The STATE MACHINE (design C7) lives here; every move is a
-- fenced CAS proving the exact from-state. transition_generation is
-- monotonic — a stale writer cannot re-move a state it already left.
CREATE TABLE IF NOT EXISTS fallback_cycle (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  -- The approved chain this cycle walks; the cycle is void if the approval
  -- moves (the CAS re-proves it).
  chain_digest  TEXT NOT NULL,
  cursor        INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL CHECK (state IN ('open','sanitizing','awaiting-release','pending-admission','incident','closed')),
  transition_generation INTEGER NOT NULL DEFAULT 0,
  -- The current tail run (the entry running, or the predecessor being
  -- sanitized). NULL only transiently at pending-admission before the next
  -- run opens.
  tail_run      INTEGER REFERENCES run(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_reason TEXT
);

-- One immutable fallback TRANSITION (v30): the audit + the single-use
-- authority for the next entry. Inserted inside advanceFallbackFenced /
-- quota-skip; consumed once at admission. Uniqueness on (cycle, from_index)
-- makes a transition one-per-step; consumed_by makes the authority one-shot.
CREATE TABLE IF NOT EXISTS fallback_transition (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle         INTEGER NOT NULL REFERENCES fallback_cycle(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('exhaustion','quota-skip')),
  from_index    INTEGER NOT NULL,
  to_index      INTEGER NOT NULL,
  -- The predecessor run whose exhaustion (or whose skip evidence) earned
  -- this step; NULL for a fresh cycle's index-0 (there is no transition
  -- into index 0 — a cycle starts there).
  predecessor_run INTEGER REFERENCES run(id),
  -- The gateway-stamped terminal class + proven evidence identity that
  -- authorized an 'exhaustion' step (NULL for quota-skip, which cites
  -- durable quota evidence instead).
  terminal_class  TEXT,
  evidence_provider TEXT,
  evidence_version  TEXT,
  evidence_auth_mode TEXT,
  evidence_fp     TEXT,
  created_at    TEXT NOT NULL,
  -- The run that consumed this transition's authority (single-use). NULL
  -- until admission; set once, in the same txn that opens the next run.
  consumed_by   INTEGER REFERENCES run(id)
);

-- One watch, as an episode with edges (§6): the night is a row, not "the
-- last 24 hours", so the morning briefing can bound itself to exactly what
-- one watch did — runs and publications attribute by runner and window.
-- ended_at NULL means it is still running, or died and never said. v5.
CREATE TABLE IF NOT EXISTS watch_episode (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  runner      TEXT NOT NULL,
  incarnation TEXT NOT NULL UNIQUE,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  ticks       INTEGER NOT NULL DEFAULT 0,
  built       INTEGER NOT NULL DEFAULT 0,
  broke       INTEGER NOT NULL DEFAULT 0
);

-- A project the console has opened: identity is the canonical repo path.
-- Registry only — a row here NEVER authorizes access (the ceiling is server
-- configuration); it remembers names and recency for the opener page. v6.
CREATE TABLE IF NOT EXISTS project (
  path           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS project_recent ON project (last_opened_at);

-- Standing permission to publish built work: git push and PR creation are
-- two different external writes, so they are two named capabilities under
-- one grant whose every term — exact GitHub repository, remote, allowed
-- head prefix, base branch — was shown to the approver before the yes.
-- Absence is denial; revocation is immediate. v5.
CREATE TABLE IF NOT EXISTS publication_grant (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo         TEXT NOT NULL,
  github_repo  TEXT NOT NULL,
  remote       TEXT NOT NULL,
  head_prefix  TEXT NOT NULL,
  base         TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  selector     TEXT NOT NULL CHECK (selector IN ('ours','all')),
  draft        INTEGER NOT NULL DEFAULT 1,
  granted_by   TEXT NOT NULL,
  granted_at   TEXT NOT NULL,
  revoked_by   TEXT,
  revoked_at   TEXT
);

-- One live grant per repo: proposing again replaces, revoking ends it.
CREATE UNIQUE INDEX IF NOT EXISTS publication_grant_live
  ON publication_grant (repo) WHERE revoked_at IS NULL;

-- The durable publication intent (§M4): completion and "this must reach a
-- PR" are one fenced write, and everything the worker needs afterwards —
-- the exact SHA to push, the exact refs, the body's identity — lives here,
-- so every phase is retryable after a crash and a retry can adopt the PR
-- it already opened instead of minting a twin. v5.
CREATE TABLE IF NOT EXISTS publication (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  task_ref    INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  github_repo TEXT NOT NULL,
  remote      TEXT NOT NULL,
  base        TEXT NOT NULL,
  head        TEXT NOT NULL,
  head_sha    TEXT NOT NULL,
  body_hash   TEXT NOT NULL,
  draft       INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('intended','pushed','opened','failed')),
  pr_number   INTEGER,
  pr_url      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- The remote's own verdict, observed (M8 audit C-6): MERGED/CLOSED ends
  -- the watch without widening the local state CHECK.
  remote_state TEXT,
  -- What CI was last SEEN doing, and when (audit SD-4): the review queue
  -- ranks observed-passing first and never upgrades silence to green.
  last_check_state TEXT,
  last_check_at    TEXT
);

-- A machine that may be given work.
--
-- credential_hash, never the credential: the token is shown to the operator
-- once at registration and then exists only as a hash here. A control plane
-- that can hand back a runner's token is one whose database is worth stealing.
CREATE TABLE IF NOT EXISTS runner (
  name            TEXT PRIMARY KEY,
  host            TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  capacity        INTEGER NOT NULL,
  -- What capacity bounds (v14, finding 26): 'tasks' is the original
  -- contract (live claims) and stays the default; 'processes' counts
  -- worker processes via execution_slot and is an explicit opt-in —
  -- an upgrade never silently changes what an operator's number means.
  capacity_mode   TEXT NOT NULL DEFAULT 'tasks' CHECK (capacity_mode IN ('tasks','processes')),
  repos           TEXT NOT NULL DEFAULT '[]',
  agents          TEXT NOT NULL DEFAULT '[]',
  registered_at   TEXT NOT NULL,
  heartbeat_at    TEXT NOT NULL,
  retired_at      TEXT,
  -- The queue column's theme note (v19) — operator prose, display only.
  queue_note      TEXT
);

-- A checked-out working copy, leased to one runner at a time.
--
-- Its lease is deliberately the same shape as a task claim: a runner that dies
-- holding a worktree has to be recoverable the same way, and two mechanisms
-- for one idea is how the second one ends up subtly wrong.
CREATE TABLE IF NOT EXISTS worktree (
  path          TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  branch        TEXT NOT NULL,
  runner        TEXT REFERENCES runner(name) ON DELETE SET NULL,
  task_ref      INTEGER REFERENCES task_ref(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  leased_at     TEXT,
  released_at   TEXT,
  -- Reconstructed state is trusted only after it has been checked; see
  -- treehouse's rule about state you did not watch being created.
  verified      INTEGER NOT NULL DEFAULT 0,
  -- Per-occupancy epoch (live-peek findings 16/28): a fresh random value
  -- written ATOMICALLY with every lease and rotated on release, so it can
  -- never repeat across release/forget/adopt/recreation. An observation
  -- proved against one epoch is DISCARDED if the epoch moved before it
  -- rendered — the fence that keeps a successor occupant's files out of a
  -- predecessor's page.
  lease_epoch   TEXT,
  -- The approved setup this checkout last ran to completion (M5.7):
  -- matching the live setup's digest is the cache hit; anything else runs
  -- it again before an agent may spawn here.
  setup_digest  TEXT
);

-- The per-repo worktree setup (M5.7): the command every fresh checkout runs
-- before any agent spawns in it — dependencies, .env copies, generated
-- code. Digest-bound and operator-approved like every other authority: the
-- command TEXT is stored, secret VALUES never are. One live row per repo;
-- clearing revokes rather than deletes, because who approved what remains
-- a fact.
CREATE TABLE IF NOT EXISTS worktree_setup (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  command     TEXT NOT NULL,
  timeout_ms  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS worktree_setup_live
  ON worktree_setup (repo) WHERE revoked_at IS NULL;

-- An operator's note on a run (M6): immutable, bounded, append-only — the
-- human's verdict next to the machine's record. Never a mutation of the
-- run itself; runs and evidence are audit history.
CREATE TABLE IF NOT EXISTS run_note (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run        INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  note       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The intake grant (M8.16): permission to turn labeled GitHub issues into
-- LOCAL UNAPPROVED task proposals — and nothing else. Detection is not
-- authorization; a grant names the exact repository, the exact label, and
-- (for PR-comment intake) which reviewer logins may steer. No mutation of
-- the remote in v1: reads make proposals, people approve them.
CREATE TABLE IF NOT EXISTS intake_grant (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT NOT NULL,
  github      TEXT NOT NULL,
  label       TEXT NOT NULL,
  reviewers   TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS intake_grant_live
  ON intake_grant (repo) WHERE revoked_at IS NULL;

-- A review comment on an IMMUTABLE terminal diff (M6.8). Bound to the exact
-- artifact and its hash — a comment on bytes that can never change — plus
-- the file and line it speaks to. Immutable themselves: an edit supersedes,
-- and consumption by a revision task is recorded, never deletion.
CREATE TABLE IF NOT EXISTS diff_comment (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact      INTEGER NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  artifact_sha  TEXT NOT NULL,
  run           INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  path          TEXT,
  line          INTEGER,
  note          TEXT NOT NULL,
  author        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  superseded_by INTEGER REFERENCES diff_comment(id),
  consumed_by   TEXT,
  -- Where an ingested comment came from (M8.17): gh:<owner/name>:<id>.
  -- The GitHub comment id is the idempotency key — one ingest, ever.
  -- Its unique index is created AFTER migration (see openStore): a
  -- database whose diff_comment predates the column would die on an
  -- index statement inside this schema block before addColumn could run.
  source_key    TEXT
);

-- A standing ask for an agent review of one finished run's sealed diff
-- (v29, the reviewer role). Manual (task review) and automatic (a mode
-- whose terms say reviewAuto) requests land here identically; the tick's
-- review pass consumes them. One OPEN request per run (index after
-- migration), and the run itself may only ever gain one reviewer child
-- (one_review_per_source) — review is additive, never a loop.
CREATE TABLE IF NOT EXISTS review_request (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run             INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  -- Who asked, as words for the page. AUTHORITY lives in basis/mode_digest
  -- below, never in this string (Codex reviewer round 1, finding 4: an
  -- operator who NAMES themselves 'mode:…' must not be misclassified).
  requested_by    TEXT NOT NULL,
  -- 'human' = an operator's credentialed ask, always dispatchable.
  -- 'mode' = a reviewAuto mode queued it; dispatch re-proves the EXACT
  -- digest below is still the active mode — a renewal is a new signature
  -- and does not inherit its predecessor's queued asks.
  basis           TEXT NOT NULL DEFAULT 'human' CHECK (basis IN ('human','mode')),
  mode_digest     TEXT,
  requested_at    TEXT NOT NULL,
  consumed_at     TEXT,
  consumed_reason TEXT
);

-- Operator steering (arc 1, v22): a note that lands at the next safe
-- boundary — the next brief the builder composes for this task. Attachment
-- and delivery are SEPARATE facts: attached_at says which build the note
-- rode toward; delivered_at settles only on the stream's own receipt (the
-- agent's first words, or a successful completion). At-least-once, honestly
-- labeled. Superseded means the task ended with the note still pending.
CREATE TABLE IF NOT EXISTS task_steer (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  author        TEXT NOT NULL,
  note          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  attached_run  INTEGER REFERENCES run(id),
  attached_at   TEXT,
  delivered_at  TEXT,
  superseded_at TEXT,
  -- v24 (ruling 11): authorship is a VERIFIED principal or it is history.
  -- The default is the legacy label so any road that forgets to say
  -- otherwise fails closed into "unverified".
  authorship_state  TEXT NOT NULL DEFAULT 'unverified-legacy' CHECK (authorship_state IN ('verified','unverified-legacy')),
  superseded_reason TEXT,
  CHECK ((attached_run IS NULL) = (attached_at IS NULL)),
  CHECK (delivered_at IS NULL OR attached_run IS NOT NULL)
);

-- A phone enrolled for web push (arc 3, v23). One row PER ACTIVATION —
-- re-enrolling a retired endpoint is a new row with its own binding and
-- audit trail; the partial unique index below keeps one LIVE row per
-- endpoint. starts_after_notification is the transactional high-water
-- mark: only notifications newer than the enrollment are ever paged.
CREATE TABLE IF NOT EXISTS push_subscription (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint                  TEXT NOT NULL,
  p256dh                    TEXT NOT NULL,
  auth                      TEXT NOT NULL,
  approver                  TEXT NOT NULL,
  approver_generation       INTEGER NOT NULL,
  ua_words                  TEXT NOT NULL,
  vapid_fingerprint         TEXT NOT NULL,
  starts_after_notification INTEGER NOT NULL,
  created_at                TEXT NOT NULL,
  last_ok_at                TEXT,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  retired_at                TEXT,
  retired_reason            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS push_subscription_live
  ON push_subscription (endpoint) WHERE retired_at IS NULL;

-- One (notification, subscription) delivery pair (arc 3): push's OWN
-- ledger — the outbox's delivered_at/claim columns are never consulted
-- and never written, so push stays additive to every other channel.
-- 'accepted' means the PUSH SERVICE took it (RFC 8030); nothing here
-- claims a phone displayed anything. At-least-once: a crash between
-- acceptance and settlement re-sends after the lease expires.
CREATE TABLE IF NOT EXISTS push_delivery (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  notification     INTEGER NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
  subscription     INTEGER NOT NULL REFERENCES push_subscription(id) ON DELETE CASCADE,
  state            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending','claimed','accepted','rejected','undeliverable','retired')),
  claim_owner      TEXT,
  claim_expires_at TEXT,
  claim_generation INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  accepted_at      TEXT,
  UNIQUE (notification, subscription),
  CHECK (state <> 'claimed' OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS push_delivery_due
  ON push_delivery (state, next_attempt_at) WHERE state IN ('pending','claimed');

CREATE TABLE IF NOT EXISTS mutation (
  idempotency_key TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,
  result          TEXT NOT NULL,
  actor           TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- The attended authorization (v25, Parity II Phase 2 ruling 12): one person,
-- one password, signing EVERY rendered term of one watched attempt — repo,
-- task, runner + its generation, scope digest, execution profile, budget as
-- a STOP THRESHOLD (the agent halts when its total crosses it; the final
-- step may run a little past), a per-session turn cap, per-turn clock, the
-- exact head it builds from, and an absolute expiry. The id is a pre-minted
-- UUID: it IS the attempt identity the dispatch proof consumes. "Live" is a
-- liveness.ts computation over last_beat_at/absolute_expiry — never an
-- index predicate. A CONSUMED authorization (attempt_run set) stays OPEN
-- across its held session; closure is explicit (run end, expiry,
-- revocation), and minting closes an expired predecessor transactionally.
CREATE TABLE IF NOT EXISTS attended_authorization (
  id                TEXT PRIMARY KEY,
  task_ref          INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  approver          TEXT NOT NULL,
  runner            TEXT NOT NULL,
  runner_generation INTEGER NOT NULL,
  composite_digest  TEXT NOT NULL,
  terms_json        TEXT NOT NULL,
  max_session_turns INTEGER NOT NULL,
  budget_microusd   INTEGER NOT NULL,
  -- Continuation (A4): the finished parent attempt this authorization
  -- continues, and the follow-up text — BOTH also inside the signed
  -- terms_json; these columns exist so admission can join without parsing.
  parent_run        INTEGER REFERENCES run(id),
  followup          TEXT,
  created_at        TEXT NOT NULL,
  absolute_expiry   TEXT NOT NULL,
  last_beat_at      TEXT,
  attempt_run       INTEGER UNIQUE REFERENCES run(id),
  consumed_at       TEXT,
  closed_at         TEXT,
  end_reason        TEXT
);

-- The turn ledger (v25, ruling 15): every stdin injection into a held
-- session is a row — the initial brief, every decision answer, every
-- operator turn, every machine repair turn. Recorded DURABLY before any
-- write; the recording transaction is where the turn cap, the single-flight
-- rule, the budget reservation, and the lease re-proof all gate. The
-- input-acceptance boundary (spike fact 5): stdin-write success is NOT
-- acceptance — acceptance is THIS turn's system/init (or its result,
-- retroactively). A written turn whose acceptance never arrives settles
-- terminal 'uncertain': charged at its reservation, NEVER reinjected.
-- measured_microusd is the MARGINAL delta from held_session's durable
-- cumulative baseline (the provider's totals are cumulative per process).
CREATE TABLE IF NOT EXISTS session_turn (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run                INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('brief','answer','operator','repair')),
  source_id          INTEGER,
  -- Verified operator name for source_kind 'operator' ONLY; brief and
  -- repair turns are machine-authored and say so with NULL.
  author             TEXT,
  text               TEXT NOT NULL,
  reserved_microusd  INTEGER NOT NULL,
  accounted_microusd INTEGER,
  accounted_at       TEXT,
  recorded_at        TEXT NOT NULL,
  written_at         TEXT,
  accepted_at        TEXT,
  settled_at         TEXT,
  measured_microusd  INTEGER,
  output_tokens      INTEGER,
  state              TEXT NOT NULL DEFAULT 'recorded'
                       CHECK (state IN ('recorded','written','accepted','settled','uncertain','cancelled')),
  UNIQUE (run, seq)
);

-- Crash custody for held sessions (v25, ruling 15): written as a custody
-- INTENT in the same transaction as the dispatch proof, stamped with the
-- supervisor pid + agent process group immediately after spawn. The orphan
-- predicate is LEASE-BASED (the recorded lease is no longer the task's
-- current live lease) — never mere incarnation difference, because two live
-- up processes may share this database. 'fencing' is a helpable, leased
-- state: a fencer that dies is taken over at its deadline, and every step
-- is CAS-protected so a loser stops only while a live fencer owns the work.
CREATE TABLE IF NOT EXISTS held_session (
  run                   INTEGER PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  authorization_id      TEXT NOT NULL REFERENCES attended_authorization(id),
  runner                TEXT NOT NULL,
  lease_id              TEXT NOT NULL,
  up_incarnation        TEXT NOT NULL,
  cookie                TEXT NOT NULL,
  socket_path           TEXT NOT NULL,
  supervisor_pid        INTEGER,
  agent_pgid            INTEGER,
  cumulative_microusd   INTEGER NOT NULL DEFAULT 0,
  cumulative_tokens_out INTEGER NOT NULL DEFAULT 0,
  state                 TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','fencing')),
  fencer                TEXT,
  fencing_deadline      TEXT,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  end_reason            TEXT
);

CREATE INDEX IF NOT EXISTS task_by_state ON task (state);
CREATE INDEX IF NOT EXISTS edge_by_blocker ON task_edge (blocker);
CREATE INDEX IF NOT EXISTS claim_by_task ON claim (task_ref, lease_generation DESC);
CREATE INDEX IF NOT EXISTS hold_by_task ON hold (task_ref);
`;

/**
 * The subset of `node:sqlite` this module uses, named so the rest of the file
 * is not written against an `any` and so a test can substitute a handle.
 */
export type Statement = {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
};

export type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};

/**
 * Beside `repos.json`, for the same reason it is there: someone will want to
 * back it up, sync it, or delete it, and a database hidden somewhere clever is
 * a database nobody can find when it matters.
 */
export function databasePath(env: Record<string, string | undefined>, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg !== "" ? xdg : join(home, ".config");
  const renamed = join(base, "standing-orders", "orders.db");
  // The rename (nightorders → standing-orders, 2026-08-13) must not orphan
  // an installation: a database that already lives under the old name keeps
  // being found there until one exists under the new one.
  const legacy = join(base, "nightorders", "orders.db");
  if (!existsSync(renamed) && existsSync(legacy)) return legacy;
  return renamed;
}

export type OpenOptions = {
  /** Substituted in tests; production opens node:sqlite itself. */
  connect?: (file: string) => Database;
};

/**
 * Open the database, creating it and its directory if needed. The import is
 * inside the function rather than at the top of the file so that a command
 * which never touches the store — every command that exists today — neither
 * loads SQLite nor pays its warning.
 */
export function openStore(file: string, options: OpenOptions = {}): Store {
  const connect = options.connect ?? defaultConnect;
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });

  const db = connect(file);
  db.exec(SCHEMA);
  migrate(db);
  // Attention/history indexes come AFTER migration: on a database whose
  // constrained tables still carry a pre-rebuild shape, creating a partial
  // index first would fail with a raw SQL error instead of the migration's
  // articulate refusal.
  db.exec(`-- Attention and history predicates the inbox/done tabs saturate on. v6.
CREATE INDEX IF NOT EXISTS decision_attention ON decision (run, id) WHERE state IN ('open','expired');
CREATE INDEX IF NOT EXISTS incident_attention ON incident (run, id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS task_ref_repo ON task_ref (repo, id);
CREATE INDEX IF NOT EXISTS run_task_outcome ON run (task_ref, outcome, id DESC);
CREATE INDEX IF NOT EXISTS task_done_recent ON task (updated_at DESC, id DESC) WHERE state = 'done';
CREATE INDEX IF NOT EXISTS run_started ON run (started_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS diff_comment_source ON diff_comment (source_key) WHERE source_key IS NOT NULL;
-- One open question per racing agent (v14, finding 28) — lives here, after
-- the migration, because decision.contestant arrives by addColumn on
-- existing files (the v11c lesson).
CREATE UNIQUE INDEX IF NOT EXISTS one_open_decision_per_contestant
  ON decision (contestant) WHERE contestant IS NOT NULL AND state IN ('open','expired');
-- Pending steering, in filing order (arc 1, v22) — after migration because
-- task_steer arrives by CREATE TABLE IF NOT EXISTS on existing files.
CREATE INDEX IF NOT EXISTS task_steer_pending
  ON task_steer (task_ref, id) WHERE delivered_at IS NULL AND superseded_at IS NULL;
-- v25 attended-core uniqueness rules — after migration because decision is
-- rebuilt there and the new tables arrive by IF NOT EXISTS on existing files.
-- One OPEN authorization per task (closure is explicit, so this is a plain
-- column predicate, never a time computation).
CREATE UNIQUE INDEX IF NOT EXISTS one_open_authorization_per_task
  ON attended_authorization (task_ref) WHERE closed_at IS NULL;
-- Answer exactly-once: a retried answer cannot inject twice while a prior
-- injection is live or proven. Terminal failures (uncertain never-accepted,
-- cancelled) release the slot — the delivery-CAS on decision.delivered_turn
-- is the live gate, this index the backstop (v6 W5).
CREATE UNIQUE INDEX IF NOT EXISTS one_live_merge_blocker
  ON merge_blocker (publication) WHERE lifted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS session_turn_answer_once
  ON session_turn (source_kind, source_id)
  WHERE source_kind = 'answer' AND state NOT IN ('uncertain','cancelled');
-- Many decisions per run (v25 rebuild dropped the UNIQUE), but at most one
-- UNRESOLVED at a time.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_decision_per_run
  ON decision (run) WHERE state IN ('open','expired');
-- The coordinator's per-pulse scan: resolved decisions on held runs whose
-- answer has not yet been injected.
CREATE INDEX IF NOT EXISTS decision_undelivered
  ON decision (run, id) WHERE state = 'answered' AND delivered_turn IS NULL;
-- v29 (the reviewer role) — after migration because run is rebuilt there
-- and review_request arrives by IF NOT EXISTS on existing files. One
-- review per source run, ever; one OPEN request per run at a time.
CREATE UNIQUE INDEX IF NOT EXISTS one_review_per_source
  ON run (parent_run) WHERE role = 'reviewer';
CREATE UNIQUE INDEX IF NOT EXISTS one_open_review_request
  ON review_request (run) WHERE consumed_at IS NULL;
-- v30 (fallback chains): one transition per (cycle, from_index) — the
-- durable backstop the fenced advance/skip CAS relies on (Codex foundation
-- review, finding 1). After migration, since fallback_transition arrives by
-- IF NOT EXISTS on existing files.
CREATE UNIQUE INDEX IF NOT EXISTS fallback_transition_step
  ON fallback_transition (cycle, from_index);
-- One LIVE cycle per task (Codex E1 review, finding 5): the DB backstop
-- behind openFallbackCycle's transact guard.
CREATE UNIQUE INDEX IF NOT EXISTS one_live_fallback_cycle_per_task
  ON fallback_cycle (task_ref) WHERE state NOT IN ('closed','incident');`);

  const version = db.prepare("SELECT version FROM schema_version").get();
  if (version === undefined) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (Number(version["version"]) < SCHEMA_VERSION) {
    // migrate() has already done the work by the time this runs; the row is
    // bookkeeping about it, not the trigger for it.
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  }

  return new Store(db);
}

/**
 * Loaded through `createRequire` rather than a top-level import so that the
 * cost — and the experimental warning — falls only on a command that actually
 * opens the database. `import()` would work too, but it would make opening the
 * store async for every caller in order to save nothing.
 *
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` to
 * stderr the first time this runs. It is left alone: an earlier version
 * filtered it by swapping the process-wide `warning` listeners, which turned
 * every `process.once("warning")` anyone else had registered into a permanent
 * one and re-emitted the rest in a format Node does not use. Hiding one line
 * of stderr is not worth breaking a global for. The right fix belongs in the
 * launcher — `--disable-warning=ExperimentalWarning` — not in a library.
 */
/**
 * Columns added after somebody's database already existed.
 *
 * `CREATE TABLE IF NOT EXISTS` does exactly nothing to a table that is already
 * there, so a column added to the schema later never reaches an existing file
 * — and every test opening `:memory:` or a fresh path passes while the first
 * real database fails on the next query. This one was found by opening one.
 *
 * Additive only, and idempotent: each column is added if it is missing and
 * skipped if it is not. Nothing here rewrites or drops anything.
 */
function migrate(db: Database): void {
  addColumn(db, "task_ref", "origin", "TEXT NOT NULL DEFAULT 'theirs'");
  addColumn(db, "task_ref", "repo", "TEXT");
  addColumn(db, "claim", "released_by", "TEXT");
  addColumn(db, "notification", "resolved_at", "TEXT");
  // Delivery claiming: two deliverers (the bridge, `outbox deliver`) must
  // not both send one row. A claim is a short lease on the act of sending.
  addColumn(db, "notification", "claim_owner", "TEXT");
  addColumn(db, "notification", "claim_expires_at", "TEXT");
  addColumn(db, "approver", "generation", "INTEGER NOT NULL DEFAULT 1");
  // v4 additive: failure strikes and the watch incarnation a claim was
  // dispatched under.
  addColumn(db, "task_ref", "strikes", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "claim", "incarnation", "TEXT");
  rebuild(db);
  rebuildDecisionVia(db);
  // v4 CHECK widenings, each a copy-rename against an exactly recognized
  // predecessor. Order matters only in that they follow the older rebuilds:
  // an M2 database reaches the v4 shapes through rebuild() directly.
  rebuildForV4(
    db,
    "run",
    "'built','failed','refused','parked'",
    "'no-change'",
    V4_RUN_DDL("run_next"),
    V4_RUN_COLUMNS,
  );
  rebuildForV4(
    db,
    "hold",
    "'operator','decision','incident'",
    "'backoff'",
    `CREATE TABLE hold_next (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
       owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff')),
       owner_id   TEXT NOT NULL,
       reason     TEXT NOT NULL,
       until      TEXT,
       held_at    TEXT NOT NULL,
       UNIQUE (owner_kind, owner_id)
     )`,
    ["id", "task_ref", "owner_kind", "owner_id", "reason", "until", "held_at"],
  );
  rebuildForV4(
    db,
    "incident",
    "'malformed-decision'",
    "'attempts-exhausted'",
    `CREATE TABLE incident_next (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
       kind        TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure','malformed-plan','plan-attempts-exhausted')),
       created_at  TEXT NOT NULL,
       resolved_at TEXT,
       resolved_by TEXT
     )`,
    ["id", "run", "kind", "created_at", "resolved_at", "resolved_by"],
  );
  // Columns the v4 run shape carries; idempotent for any table that arrived
  // here by a path that already has them.
  addColumn(db, "run", "provider_started_at", "TEXT");
  addColumn(db, "run", "tokens_in", "INTEGER");
  addColumn(db, "run", "tokens_out", "INTEGER");
  addColumn(db, "run", "cost_usd", "REAL");
  addColumn(db, "run", "usage_json", "TEXT");
  addColumn(db, "run", "head_revision", "TEXT");
  addColumn(db, "run", "handoff", "TEXT");
  // v7 (planning): additive task_ref columns, then three CHECK widenings —
  // each a copy-rename against an exactly recognized predecessor, run AFTER
  // every older normalizer so a v6 database is the only shape they see
  // (Codex planning review, finding 8: editing the fresh DDL alone would
  // skip existing files, recording v7 over a table that still refuses
  // planner rows).
  addColumn(db, "task_ref", "plan", "TEXT CHECK (plan IN ('requested','drafted'))");
  addColumn(db, "task_ref", "plan_strikes", "INTEGER NOT NULL DEFAULT 0");
  rebuildForV4(
    db,
    "run",
    "role IN ('builder','repair')",
    "'planner'",
    V4_RUN_DDL("run_next"),
    V4_RUN_COLUMNS,
  );
  rebuildForV4(
    db,
    "artifact",
    "'diff','status','park-payload'",
    "'plan'",
    `CREATE TABLE artifact_next (
       id             INTEGER PRIMARY KEY AUTOINCREMENT,
       run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
       kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan')),
       key            TEXT NOT NULL,
       bytes_original INTEGER NOT NULL,
       bytes_stored   INTEGER NOT NULL,
       truncated      INTEGER NOT NULL DEFAULT 0,
       sha256         TEXT NOT NULL,
       capture        TEXT NOT NULL,
       created_at     TEXT NOT NULL,
       redacted       INTEGER NOT NULL DEFAULT 0
     )`,
    ["id", "run", "kind", "key", "bytes_original", "bytes_stored", "truncated", "sha256", "capture", "created_at", "redacted"],
  );
  rebuildForV4(
    db,
    "incident",
    "'malformed-decision','attempts-exhausted','commit-failure'",
    "'malformed-plan'",
    `CREATE TABLE incident_next (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       run         INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
       kind        TEXT NOT NULL CHECK (kind IN ('malformed-decision','attempts-exhausted','commit-failure','malformed-plan','plan-attempts-exhausted')),
       created_at  TEXT NOT NULL,
       resolved_at TEXT,
       resolved_by TEXT
     )`,
    ["id", "run", "kind", "created_at", "resolved_at", "resolved_by"],
  );
  // v8 (routines): purely additive — two new tables arrive through the fresh
  // SCHEMA's CREATE TABLE IF NOT EXISTS (they did not exist before, so the
  // recognizer story of the CHECK widenings does not apply), and task_ref
  // grows the nullable instance link. The routine table exists by the time
  // this runs because openStore executes SCHEMA first.
  addColumn(db, "task_ref", "routine_id", "INTEGER REFERENCES routine(id)");
  // v9 (providers): run.provider rides all three canonical shapes — fresh
  // SCHEMA, V4_RUN_DDL, V4_RUN_COLUMNS — AND this additive column for
  // databases whose run table is already current (the rebuilds only fire
  // on pre-v7 shapes; ordering per the Codex provider review, Q7). The
  // default backfills history truthfully: only claude ever spawned.
  addColumn(db, "run", "provider", "TEXT NOT NULL DEFAULT 'claude'");
  // The instance/task agent pin: stamped at routine fire time so a firing
  // resolved under approved terms cannot be re-routed by later flags.
  addColumn(db, "task_ref", "agent_provider", "TEXT");
  addColumn(db, "task_ref", "agent_model", "TEXT");
  // v10 (free-text answers): two new tables via the fresh SCHEMA, plus the
  // digest that binds an irreversible confirmation to the EXACT note it
  // confirmed (Codex free-text review, finding 3).
  addColumn(db, "telegram_action", "note_digest", "TEXT");
  // v11 (M5 worktree setup): additive — the worktree_setup table arrives
  // through the fresh SCHEMA's IF NOT EXISTS, and existing worktree rows
  // gain the setup cache column.
  addColumn(db, "worktree", "setup_digest", "TEXT");
  // v11b (M6.8 revision tasks): additive columns; diff_comment arrives via
  // the fresh SCHEMA's IF NOT EXISTS.
  addColumn(db, "task_ref", "revision_of", "TEXT");
  addColumn(db, "task_ref", "revision_brief_artifact", "INTEGER REFERENCES artifact(id)");
  // v11c (M8 audit C-6): the remote's observed PR verdict, additive.
  addColumn(db, "publication", "remote_state", "TEXT");
  // v11c (audit SD-4): the last OBSERVED check state, additive.
  addColumn(db, "publication", "last_check_state", "TEXT");
  addColumn(db, "publication", "last_check_at", "TEXT");
  // v11c (M8.17 PR-comment intake): the ingest idempotency key, additive —
  // a same-day v11 database gains it here; fresh ones carry it already.
  // Its unique index rides the post-migration block in openStore.
  addColumn(db, "diff_comment", "source_key", "TEXT");
  // v11 (M5 activity): the machine-authored phase — stamped by the control
  // plane at its own state-machine boundaries, never parsed out of a
  // provider stream. Transient in meaning (read while the run is open),
  // durable in storage (the simplest shared state between daemon and
  // console is the database they already share).
  addColumn(db, "run", "phase", "TEXT");
  // v11 (M5 terminal diff): artifact.kind admits 'terminal-diff' (the
  // immutable base→head patch captured before the worktree releases) and
  // 'diff-stat' (its machine-parsed summary). Same recognized-exactly
  // CHECK-widening recipe as v7's.
  rebuildForV4(
    db,
    "artifact",
    "'diff','status','park-payload','plan'",
    "'terminal-diff','diff-stat'",
    `CREATE TABLE artifact_next (
       id             INTEGER PRIMARY KEY AUTOINCREMENT,
       run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
       kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat')),
       key            TEXT NOT NULL,
       bytes_original INTEGER NOT NULL,
       bytes_stored   INTEGER NOT NULL,
       truncated      INTEGER NOT NULL DEFAULT 0,
       sha256         TEXT NOT NULL,
       capture        TEXT NOT NULL,
       created_at     TEXT NOT NULL,
       redacted       INTEGER NOT NULL DEFAULT 0
     )`,
    ["id", "run", "kind", "key", "bytes_original", "bytes_stored", "truncated", "sha256", "capture", "created_at", "redacted"],
  );
  // v11b (M6 handoff + revision briefs): the same recipe again, recognizing
  // BOTH the pre-v11 shape (already rebuilt by the step above when this
  // runs on an old file) and a database that opened at v11 earlier today.
  rebuildForV4(
    db,
    "artifact",
    "'terminal-diff','diff-stat'",
    "'handoff','revision-brief'",
    `CREATE TABLE artifact_next (
       id             INTEGER PRIMARY KEY AUTOINCREMENT,
       run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
       kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief')),
       key            TEXT NOT NULL,
       bytes_original INTEGER NOT NULL,
       bytes_stored   INTEGER NOT NULL,
       truncated      INTEGER NOT NULL DEFAULT 0,
       sha256         TEXT NOT NULL,
       capture        TEXT NOT NULL,
       created_at     TEXT NOT NULL,
       redacted       INTEGER NOT NULL DEFAULT 0
     )`,
    ["id", "run", "kind", "key", "bytes_original", "bytes_stored", "truncated", "sha256", "capture", "created_at", "redacted"],
  );
  // v12 (adoption review, finding 7): immutable filing provenance, additive.
  // installation_fact arrives through the fresh SCHEMA's IF NOT EXISTS.
  addColumn(db, "task_ref", "filed_via", "TEXT");
  addColumn(db, "routine", "filed_via", "TEXT");
  // v13 (fleet chat): purely additive — chat_config and chat_turn arrive
  // through the fresh SCHEMA's IF NOT EXISTS; no existing table changes.
  // v13b: the pinned per-token price joins the config row, additive.
  addColumn(db, "chat_config", "price_in_microusd", "INTEGER");
  addColumn(db, "chat_config", "price_out_microusd", "INTEGER");
  // v14 (tournaments): five new tables ride the fresh SCHEMA's IF NOT
  // EXISTS; existing tables gain nullable columns here; and hold's
  // owner_kind CHECK is WIDENED by the recognized-exactly rebuild — v14
  // is deliberately NOT purely additive, and this is the one place that
  // says so.
  addColumn(db, "run", "contestant", "INTEGER REFERENCES contestant(id)");
  addColumn(db, "decision", "contestant", "INTEGER REFERENCES contestant(id)");
  addColumn(db, "decision", "closed_reason", "TEXT CHECK (closed_reason IN ('excluded'))");
  addColumn(db, "artifact", "capture_status", "TEXT CHECK (capture_status IN ('ok','failed'))");
  addColumn(db, "runner", "capacity_mode", "TEXT NOT NULL DEFAULT 'tasks'");
  rebuildForV4(
    db,
    "hold",
    "'operator','decision','incident','backoff'",
    "'contest'",
    `CREATE TABLE hold_next (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
       owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff','contest')),
       owner_id   TEXT NOT NULL,
       reason     TEXT NOT NULL,
       until      TEXT,
       held_at    TEXT NOT NULL,
       UNIQUE (owner_kind, owner_id)
     )`,
    ["id", "task_ref", "owner_kind", "owner_id", "reason", "until", "held_at"],
  );
  // v15 (budgets, operator request): the per-attempt dollar cap joins the
  // scope, and spend_defaults arrives via the fresh SCHEMA's IF NOT EXISTS.
  addColumn(db, "task_scope", "budget_microusd", "INTEGER");
  // v16 (stage 6 + operator request): the default competing-agent count,
  // and the per-instance dollar cap on standing orders.
  addColumn(db, "spend_defaults", "race_agents", "INTEGER CHECK (race_agents BETWEEN 2 AND 4)");
  addColumn(db, "routine", "budget_per_run_microusd", "INTEGER");
  // v17 (live peek): the occupancy fence on checkouts, and artifact.kind
  // admits 'base-tree' (the enveloped dispatch-time snapshot the peek
  // consumes) — same recognized-exactly CHECK-widening recipe as v11's,
  // with the FULL current column set so capture_status survives.
  addColumn(db, "worktree", "lease_epoch", "TEXT");
  rebuildForV4(
    db,
    "artifact",
    "'diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief'",
    "'base-tree'",
    `CREATE TABLE artifact_next (
       id             INTEGER PRIMARY KEY AUTOINCREMENT,
       run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
       kind           TEXT NOT NULL CHECK (kind IN ('diff','status','park-payload','plan','terminal-diff','diff-stat','handoff','revision-brief','base-tree')),
       key            TEXT NOT NULL,
       bytes_original INTEGER NOT NULL,
       bytes_stored   INTEGER NOT NULL,
       truncated      INTEGER NOT NULL DEFAULT 0,
       sha256         TEXT NOT NULL,
       capture        TEXT NOT NULL,
       created_at     TEXT NOT NULL,
       redacted       INTEGER NOT NULL DEFAULT 0,
       capture_status TEXT CHECK (capture_status IN ('ok','failed'))
     )`,
    ["id", "run", "kind", "key", "bytes_original", "bytes_stored", "truncated", "sha256", "capture", "created_at", "redacted", "capture_status"],
  );
  // v18 (chains and next): the queue rank. Scheduling, never authority —
  // no digest binds it and no approval is voided by it.
  addColumn(db, "task", "priority", "INTEGER NOT NULL DEFAULT 0");
  // v19 (queue columns): reservations, the column note, and the queue
  // revision the console's drag CAS-checks. All additive; no index in
  // the fresh SCHEMA (the recorded partial-index trap).
  addColumn(db, "task_ref", "assigned_runner", "TEXT");
  addColumn(db, "runner", "queue_note", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS queue_state (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec("INSERT OR IGNORE INTO queue_state (id, revision) VALUES (1, 0)");
  // v20 (external dispatch): dispatch authority + blocked state on the
  // grant (cross-column rule dispatch=1 → remote_repo/plane_id lives in
  // saveGrant — ALTER ADD COLUMN cannot carry cross-column CHECKs), and
  // the mirror/ledger/intent tables. The trigger and every table are
  // shared with the fresh SCHEMA via CREATE IF NOT EXISTS.
  addColumn(db, "backend_grant", "dispatch", "INTEGER NOT NULL DEFAULT 0 CHECK (dispatch IN (0, 1))");
  addColumn(db, "backend_grant", "remote_repo", "TEXT");
  addColumn(db, "backend_grant", "plane_id", "TEXT");
  addColumn(db, "backend_grant", "dispatch_blocked", "TEXT CHECK (dispatch_blocked IN ('pending-marker','unreachable','foreign','missing','multiple-or-malformed'))");
  addColumn(db, "backend_grant", "dispatch_blocked_at", "TEXT");
  addColumn(db, "backend_grant", "dispatch_blocked_detail", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS external_mirror (
    local_task_id   TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
    backend         TEXT NOT NULL,
    remote_repo     TEXT NOT NULL,
    remote_id       TEXT NOT NULL,
    provenance      TEXT NOT NULL CHECK (provenance IN ('local-create','intake','granted-all')),
    intake_grant    INTEGER,
    established_by  TEXT NOT NULL,
    established_at  TEXT NOT NULL,
    remote_state    TEXT NOT NULL CHECK (remote_state IN ('open','closed','missing')),
    close_generation INTEGER,
    sync_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_ok     INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_ok IN (0, 1)),
    reopened_by     TEXT,
    reopened_at     TEXT,
    CHECK ((provenance = 'intake') = (intake_grant IS NOT NULL)),
    UNIQUE (backend, remote_repo, remote_id)
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS external_mirror_immutable
    BEFORE UPDATE ON external_mirror
    WHEN OLD.backend IS NOT NEW.backend OR OLD.remote_repo IS NOT NEW.remote_repo
      OR OLD.remote_id IS NOT NEW.remote_id OR OLD.provenance IS NOT NEW.provenance
      OR OLD.intake_grant IS NOT NEW.intake_grant
      OR OLD.established_by IS NOT NEW.established_by OR OLD.established_at IS NOT NEW.established_at
    BEGIN
      SELECT RAISE(ABORT, 'external mirror identity is immutable');
    END`);
  db.exec(`CREATE TABLE IF NOT EXISTS sync_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    backend     TEXT NOT NULL,
    remote_repo TEXT NOT NULL,
    generation  INTEGER NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    outcome     TEXT CHECK (outcome IN ('complete','capped','failed')),
    candidates  INTEGER NOT NULL DEFAULT 0,
    mirrored    INTEGER NOT NULL DEFAULT 0,
    detail      TEXT,
    UNIQUE (backend, remote_repo, generation)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS external_intent (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    mirror       TEXT NOT NULL REFERENCES external_mirror(local_task_id),
    kind         TEXT NOT NULL CHECK (kind IN ('comment','transition','close')),
    body         TEXT,
    state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','refused')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT NOT NULL,
    delivered_at TEXT
  )`);
  // v21 (merge grant): merge authority as explicit fields on the
  // publication grant (cross-column rule merge=1 → merge_method lives in
  // savePublicationGrant + a trigger — additive ALTER cannot carry it),
  // plus the observation/intent/blocker tables shared with fresh SCHEMA.
  addColumn(db, "publication_grant", "merge", "INTEGER NOT NULL DEFAULT 0 CHECK (merge IN (0, 1))");
  addColumn(db, "publication_grant", "merge_method", "TEXT CHECK (merge_method IN ('squash','merge','rebase'))");
  addColumn(db, "publication_grant", "merge_delete_branch", "INTEGER NOT NULL DEFAULT 0 CHECK (merge_delete_branch IN (0, 1))");
  db.exec(`CREATE TABLE IF NOT EXISTS ci_observation (
    github_repo TEXT NOT NULL,
    pr_number   INTEGER NOT NULL,
    head_sha    TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('passing','failing','running','none')),
    generation  INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (github_repo, pr_number)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS merge_intent (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    publication   INTEGER NOT NULL UNIQUE REFERENCES publication(id),
    grant_terms_hash TEXT NOT NULL,
    head_sha      TEXT NOT NULL,
    method        TEXT NOT NULL CHECK (method IN ('squash','merge','rebase')),
    delete_branch INTEGER NOT NULL DEFAULT 0 CHECK (delete_branch IN (0, 1)),
    state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','merged','refused','superseded')),
    claimed_by    TEXT,
    claimed_until TEXT,
    generation    INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    receipt       TEXT,
    created_at    TEXT NOT NULL,
    settled_at    TEXT,
    CHECK (state <> 'claimed' OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS merge_blocker (
    publication INTEGER NOT NULL UNIQUE REFERENCES publication(id),
    reason      TEXT NOT NULL CHECK (reason IN ('repair-open')),
    task_id     TEXT,
    created_at  TEXT NOT NULL
  )`);
  // v23 (arc 3, the phone): the push surface. Two NEW tables (their own
  // indexes may ride beside them — the whole tables are new) plus two
  // additive notification columns stamped by producers: a closed
  // attention class and a machine-minted console link. Kinds without a
  // class never push.
  addColumn(db, "notification", "push_class", "TEXT CHECK (push_class IN ('decision','pick','merge','attention'))");
  addColumn(db, "notification", "link", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscription (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint                  TEXT NOT NULL,
    p256dh                    TEXT NOT NULL,
    auth                      TEXT NOT NULL,
    approver                  TEXT NOT NULL,
    approver_generation       INTEGER NOT NULL,
    ua_words                  TEXT NOT NULL,
    vapid_fingerprint         TEXT NOT NULL,
    starts_after_notification INTEGER NOT NULL,
    created_at                TEXT NOT NULL,
    last_ok_at                TEXT,
    consecutive_failures      INTEGER NOT NULL DEFAULT 0,
    retired_at                TEXT,
    retired_reason            TEXT
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS push_subscription_live
    ON push_subscription (endpoint) WHERE retired_at IS NULL`);
  db.exec(`CREATE TABLE IF NOT EXISTS push_delivery (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    notification     INTEGER NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
    subscription     INTEGER NOT NULL REFERENCES push_subscription(id) ON DELETE CASCADE,
    state            TEXT NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending','claimed','accepted','rejected','undeliverable','retired')),
    claim_owner      TEXT,
    claim_expires_at TEXT,
    claim_generation INTEGER NOT NULL DEFAULT 0,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL,
    accepted_at      TEXT,
    UNIQUE (notification, subscription),
    CHECK (state <> 'claimed' OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS push_delivery_due
    ON push_delivery (state, next_attempt_at) WHERE state IN ('pending','claimed')`);

  // v22 (arc 1, the live window): operator steering notes. A NEW table —
  // additive, identical to the fresh SCHEMA; its partial pending index
  // lives in openStore's post-migration block (the v11c lesson).
  db.exec(`CREATE TABLE IF NOT EXISTS task_steer (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
    author        TEXT NOT NULL,
    note          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    attached_run  INTEGER REFERENCES run(id),
    attached_at   TEXT,
    delivered_at  TEXT,
    superseded_at TEXT,
    CHECK ((attached_run IS NULL) = (attached_at IS NULL)),
    CHECK (delivered_at IS NULL OR attached_run IS NOT NULL)
  )`);

  // v24 (Parity II foundations): the execution-profile columns, added with
  // LEGACY defaults — an existing row is grandfathered/unverified until the
  // data pass below classifies it; every new INSERT writes these columns
  // explicitly, so a road that forgets fails closed into the legacy label.
  addColumn(db, "task_scope", "profile_json", "TEXT");
  addColumn(db, "task_scope", "profile_state", "TEXT NOT NULL DEFAULT 'resolved'");
  addColumn(db, "task_scope", "unresolved_reason", "TEXT");
  addColumn(db, "task_scope", "approved_profile_json", "TEXT");
  addColumn(db, "task_scope", "digest_version", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "task_scope", "profile_provenance", "TEXT");
  addColumn(db, "routine", "profile_json", "TEXT");
  addColumn(db, "routine", "approved_profile_json", "TEXT");
  addColumn(db, "routine", "digest_version", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "routine", "profile_provenance", "TEXT");
  addColumn(db, "contest", "race_semantics", "INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "contestant", "profile_json", "TEXT");
  addColumn(db, "run", "scope_digest", "TEXT");
  addColumn(db, "run", "profile_digest", "TEXT");
  addColumn(db, "run", "provider_version", "TEXT");
  addColumn(db, "task_steer", "authorship_state", "TEXT NOT NULL DEFAULT 'unverified-legacy'");
  addColumn(db, "task_steer", "superseded_reason", "TEXT");
  // The v24 DATA pass runs exactly once — on a database whose stored
  // version predates it. A fresh database (no version row yet) has
  // nothing to classify, and a v24 database must never be re-classified:
  // a freshly approved routine with no profile column YET would otherwise
  // be "grandfathered" by its own migration on the next open.
  const stored = db.prepare("SELECT version FROM schema_version").get() as { version?: number } | undefined;
  if (stored !== undefined && Number(stored.version) < 24) migrateToV24(db);

  // v25 (attended core): two shape rebuilds, each recognized exactly and
  // idempotent, ordered AFTER every addColumn above so the only pre-v25
  // shape they ever see is the full v24 one. The three new tables arrive
  // through the fresh SCHEMA's IF NOT EXISTS (the v8 routines precedent);
  // their foreign keys into `run` survive the rename-swap by name, and the
  // rebuild's own foreign_key_check proves it.
  rebuildForV4(
    db,
    "run",
    "'built','failed','refused','parked','no-change'",
    "'interrupted'",
    V25_RUN_DDL("run_next"),
    V25_RUN_COLUMNS,
  );
  rebuildDecisionForV25(db);

  // v26 (attested runtime): phase_config's provider CHECK gains 'gemini'.
  rebuildPhaseConfigForV26(db);

  // v27 (labeled comparisons): tournament_terms gains kind + kind-aware
  // money CHECKs (a rebuild — the old positive-budget CHECKs live in the
  // DDL); contest gains the denormalized kind additively.
  addColumn(db, "contest", "kind", "TEXT NOT NULL DEFAULT 'race' CHECK (kind IN ('race','comparison'))");
  rebuildTournamentTermsForV27(db);

  // v28 (parallel attended sessions): the one-held-session-per-runner
  // bound is withdrawn — parallelism is many tasks, each with its own
  // signed envelope; per-task and per-run singulars all stay.
  db.exec("DROP INDEX IF EXISTS one_held_session_per_runner");

  // v29 (operating modes + the reviewer role + multi-user): additive
  // columns FIRST (round-4 ordering), then the exact-recognizer rebuilds.
  // The four new tables arrive through the fresh SCHEMA's IF NOT EXISTS.
  addColumn(db, "approver", "role", "TEXT NOT NULL DEFAULT 'approver' CHECK (role IN ('approver','viewer'))");
  addColumn(db, "approver", "revoked_at", "TEXT");
  addColumn(db, "approver", "revoked_by", "TEXT");
  addColumn(db, "attended_authorization", "authority_basis", "TEXT NOT NULL DEFAULT 'password' CHECK (authority_basis IN ('password','mode'))");
  addColumn(db, "attended_authorization", "mode_digest", "TEXT");
  addColumn(db, "task_scope", "approval_basis", "TEXT");
  addColumn(db, "task_scope", "mode_digest", "TEXT");
  addColumn(db, "diff_comment", "reviewer_run", "INTEGER REFERENCES run(id)");
  // review_request arrives whole by IF NOT EXISTS; these cover a file
  // that created the table before basis/mode_digest existed. FAIL CLOSED
  // on that upgrade (Codex reviewer round 2, finding 1): a pre-typed open
  // request queued by a mode would default to basis 'human' and survive
  // the mode's revocation — and legacy display strings are ambiguous with
  // human names, so NO open pre-typed request keeps its authority. Spent
  // as 'legacy-untyped'; a person simply asks again.
  const preTypedRequests = tableExists(db, "review_request") && !hasColumn(db, "review_request", "basis");
  addColumn(db, "review_request", "basis", "TEXT NOT NULL DEFAULT 'human' CHECK (basis IN ('human','mode'))");
  addColumn(db, "review_request", "mode_digest", "TEXT");
  if (preTypedRequests) {
    db.exec(
      `UPDATE review_request SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), consumed_reason = 'legacy-untyped' WHERE consumed_at IS NULL`,
    );
  }
  addColumn(db, "diff_comment", "severity", "TEXT CHECK (severity IN ('note','question','problem'))");
  addColumn(db, "task_ref", "plan_provider", "TEXT");
  addColumn(db, "task_ref", "plan_model", "TEXT");
  addColumn(db, "merge_blocker", "lifted_at", "TEXT");
  addColumn(db, "merge_blocker", "lifted_by", "TEXT");
  rebuildRunForV29(db);
  rebuildPhaseConfigForV29(db);
  rebuildMergeIntentForV29(db);
  rebuildMergeBlockerForV29(db);

  // v30 (fallback chains): additive columns on top of the v29 shapes; the
  // three new tables (fallback_cycle, fallback_transition) + the quota
  // identity rebuild arrive through the fresh SCHEMA's IF NOT EXISTS on a
  // fresh DB, and here on an upgrade. Quota needs a RECOGNIZED rebuild (its
  // PK changes) — additive columns cannot change a primary key.
  addColumn(db, "task_scope", "proposed_chain_json", "TEXT");
  addColumn(db, "task_scope", "approved_chain_json", "TEXT");
  addColumn(db, "task_scope", "approval_kind", "TEXT NOT NULL DEFAULT 'profile' CHECK (approval_kind IN ('profile','chain'))");
  addColumn(db, "run", "chain_cycle", "INTEGER REFERENCES fallback_cycle(id)");
  addColumn(db, "run", "chain_index", "INTEGER");
  addColumn(db, "run", "entry_digest", "TEXT");
  addColumn(db, "run", "auth_mode", "TEXT");
  addColumn(db, "run", "terminal_class", "TEXT");
  rebuildQuotaForV30(db);
}

/** v30: quota's PRIMARY KEY grows auth_mode + credential_fp (a subscription
 * and an API key exhaust independently). A PK change is a rebuild, not an
 * addColumn; recognized exactly like every other v-rebuild. */
function rebuildQuotaForV30(db: Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quota'").get();
  if (row === undefined) return;
  const stored = canonicalDdl(String(row["sql"]));
  const target = canonicalDdl(QUOTA_V30_DDL).replace("quota_next", "quota");
  if (stored === target) return;
  const oldBare = canonicalDdl(QUOTA_OLD_DDL);
  if (stored !== oldBare) {
    throw new Error("the quota table's DDL is not a shape this migration knows — refusing to rebuild it");
  }
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(QUOTA_V30_DDL);
      // Every pre-v30 row was a subscription-shaped credential with no
      // fingerprint — that is exactly what the defaults say.
      db.exec("INSERT INTO quota_next (runner, provider, scope, auth_mode, credential_fp, state, reason, observed_at, reset_at) SELECT runner, provider, scope, 'subscription', '', state, reason, observed_at, reset_at FROM quota");
      db.exec("DROP TABLE quota");
      db.exec("ALTER TABLE quota_next RENAME TO quota");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const QUOTA_OLD_DDL = `CREATE TABLE quota (
  runner      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL CHECK (state IN ('exhausted','half-open')),
  reason      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reset_at    TEXT,
  PRIMARY KEY (runner, provider, scope)
)`;

const QUOTA_V30_DDL = `CREATE TABLE quota_next (
  runner      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  auth_mode   TEXT NOT NULL DEFAULT 'subscription' CHECK (auth_mode IN ('subscription','api-key')),
  credential_fp TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL CHECK (state IN ('exhausted','half-open')),
  reason      TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reset_at    TEXT,
  PRIMARY KEY (runner, provider, scope, auth_mode, credential_fp)
)`;

/** The v28 run shape — V25's columns unchanged since; the recognizer for
 * the v29 rebuild. rebuildForV4's substring check is deliberately NOT
 * reused here (round-3 finding 5: substrings are not recognizers). */
function V28_RUN_DDL(name: string): string {
  return V25_RUN_DDL(name);
}

function V29_RUN_DDL(name: string): string {
  return `CREATE TABLE ${name} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
    lease_id      TEXT NOT NULL,
    runner        TEXT NOT NULL,
    scope_digest     TEXT,
    profile_digest   TEXT,
    provider_version TEXT,
    role          TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair','planner','reviewer')),
    provider      TEXT NOT NULL DEFAULT 'claude',
    parent_run    INTEGER REFERENCES run(id),
    session_id    TEXT,
    base_revision TEXT,
    branch        TEXT,
    worktree      TEXT,
    model         TEXT,
    phase         TEXT,
    contestant    INTEGER REFERENCES contestant(id),
    outcome       TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change','interrupted')),
    reason        TEXT,
    committed     INTEGER,
    attended_authorization TEXT REFERENCES attended_authorization(id),
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    provider_started_at TEXT,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    cost_usd      REAL,
    usage_json    TEXT,
    head_revision TEXT,
    handoff       TEXT,
    CHECK ((role = 'reviewer' AND branch IS NULL AND worktree IS NULL)
        OR (role <> 'reviewer' AND branch IS NOT NULL AND worktree IS NOT NULL))
  )`;
}

/** The v29 run shape after the v30 ALTER ADD COLUMNs — SQLite appends each
 * new column before the closing paren, AFTER the table-level CHECK. The
 * recognizer accepts this so a v30 database does not re-enter the v29
 * rebuild on every open. */
const V29_RUN_PLUS_V30_COLS_DDL = V29_RUN_DDL("run").replace(
  // ALTER ADD COLUMN inserts each column AFTER the last column definition
  // and BEFORE the table-level CHECK — never after the final paren.
  "    handoff       TEXT,\n    CHECK",
  "    handoff       TEXT, chain_cycle INTEGER REFERENCES fallback_cycle(id), chain_index INTEGER, entry_digest TEXT, auth_mode TEXT, terminal_class TEXT,\n    CHECK",
);

function rebuildRunForV29(db: Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run'").get();
  if (row === undefined) return;
  const stored = canonicalDdl(String(row["sql"]));
  // Already the v29 shape — OR the v29 shape PLUS the v30 addColumns
  // (chain_cycle … terminal_class), which ALTER appends after the CHECK.
  // Both are done shapes; only a pre-v29 (v28) table rebuilds. This mirrors
  // rebuildMergeBlockerForV29's old-plus-added-columns recognizer.
  if (stored === canonicalDdl(V29_RUN_DDL("run")) || stored === canonicalDdl(V29_RUN_PLUS_V30_COLS_DDL)) return;
  if (stored !== canonicalDdl(V28_RUN_DDL("run"))) {
    throw new Error("the run table's DDL is not a shape this migration knows — refusing to rebuild it");
  }
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(V29_RUN_DDL("run_next"));
      const names = V25_RUN_COLUMNS.join(", ");
      db.exec(`INSERT INTO run_next (${names}) SELECT ${names} FROM run`);
      db.exec("DROP TABLE run");
      db.exec("ALTER TABLE run_next RENAME TO run");
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) throw new Error("foreign keys did not survive the run rebuild");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const PHASE_CONFIG_V29_DDL = `CREATE TABLE phase_config_next (
  scope      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('plan','build','repair','review')),
  provider   TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')),
  model      TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
)`;

/** Rebuild #3 of phase_config: 'review' joins the phases (v29). */
function rebuildPhaseConfigForV29(db: Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'phase_config'").get();
  if (row === undefined) return;
  const stored = canonicalDdl(String(row["sql"]));
  if (stored === canonicalDdl(PHASE_CONFIG_V29_DDL).replace("phase_config_next", "phase_config")) return;
  // PHASE_CONFIG_V26_DDL is the CURRENT shape (the v26 migration's
  // product, unchanged through v28) — the constant is named for the
  // migration that made it, not the version reading it.
  if (stored !== canonicalDdl(PHASE_CONFIG_V26_DDL).replace("phase_config_next", "phase_config")) {
    throw new Error("the phase_config table's DDL is not a shape this migration knows — refusing to rebuild it");
  }
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(PHASE_CONFIG_V29_DDL);
      db.exec(`INSERT INTO phase_config_next (scope, phase, provider, model, updated_at, updated_by)
               SELECT scope, phase, provider, model, updated_at, updated_by FROM phase_config`);
      db.exec("DROP TABLE phase_config");
      db.exec("ALTER TABLE phase_config_next RENAME TO phase_config");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const MERGE_INTENT_V21_DDL = `CREATE TABLE merge_intent (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  publication   INTEGER NOT NULL UNIQUE REFERENCES publication(id),
  grant_terms_hash TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('squash','merge','rebase')),
  delete_branch INTEGER NOT NULL DEFAULT 0 CHECK (delete_branch IN (0, 1)),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','merged','refused','superseded')),
  claimed_by    TEXT,
  claimed_until TEXT,
  generation    INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  receipt       TEXT,
  created_at    TEXT NOT NULL,
  settled_at    TEXT,
  CHECK (state <> 'claimed' OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL))
)`;

const MERGE_INTENT_V29_DDL = `CREATE TABLE merge_intent_next (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  publication   INTEGER NOT NULL UNIQUE REFERENCES publication(id),
  grant_terms_hash TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('squash','merge','rebase')),
  delete_branch INTEGER NOT NULL DEFAULT 0 CHECK (delete_branch IN (0, 1)),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','waiting-human','firing','merged','refused','superseded')),
  claimed_by    TEXT,
  claimed_until TEXT,
  authority_basis TEXT NOT NULL DEFAULT 'grant' CHECK (authority_basis IN ('grant','mode','human')),
  mode_digest   TEXT,
  firing_at     TEXT,
  firing_deadline TEXT,
  generation    INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  receipt       TEXT,
  created_at    TEXT NOT NULL,
  settled_at    TEXT,
  CHECK (state <> 'claimed' OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL)),
  CHECK (state <> 'firing' OR (firing_at IS NOT NULL AND firing_deadline IS NOT NULL))
)`;

/** v29: the intent machine gains waiting-human + firing and the authority
 * binding. Existing rows keep basis 'grant' — the truthful backfill: every
 * pre-v29 intent fired under the grant ceremony's own signature. */
function rebuildMergeIntentForV29(db: Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'merge_intent'").get();
  if (row === undefined) return;
  const stored = canonicalDdl(String(row["sql"]));
  if (stored === canonicalDdl(MERGE_INTENT_V29_DDL).replace("merge_intent_next", "merge_intent")) return;
  if (stored !== canonicalDdl(MERGE_INTENT_V21_DDL)) {
    throw new Error("the merge_intent table's DDL is not a shape this migration knows — refusing to rebuild it");
  }
  const COLS = "id, publication, grant_terms_hash, head_sha, method, delete_branch, state, claimed_by, claimed_until, generation, attempts, last_error, receipt, created_at, settled_at";
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MERGE_INTENT_V29_DDL);
      db.exec(`INSERT INTO merge_intent_next (${COLS}) SELECT ${COLS} FROM merge_intent`);
      db.exec("DROP TABLE merge_intent");
      db.exec("ALTER TABLE merge_intent_next RENAME TO merge_intent");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const MERGE_BLOCKER_OLD_DDL = `CREATE TABLE merge_blocker (
  publication INTEGER NOT NULL UNIQUE REFERENCES publication(id),
  reason      TEXT NOT NULL CHECK (reason IN ('repair-open')),
  task_id     TEXT,
  created_at  TEXT NOT NULL
)`;

const MERGE_BLOCKER_V29_DDL = `CREATE TABLE merge_blocker_next (
  publication INTEGER NOT NULL REFERENCES publication(id),
  reason      TEXT NOT NULL CHECK (reason IN ('repair-open')),
  task_id     TEXT,
  created_at  TEXT NOT NULL,
  lifted_at   TEXT,
  lifted_by   TEXT
)`;

/** v29: lifting becomes a stamp; the in-table UNIQUE becomes the
 * one-live partial unique (post-migration block). The addColumn calls
 * above already handled a table that predates this rebuild's run, so the
 * recognizer accepts BOTH the bare old shape and old+added columns. */
function rebuildMergeBlockerForV29(db: Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'merge_blocker'").get();
  if (row === undefined) return;
  const stored = canonicalDdl(String(row["sql"]));
  const target = canonicalDdl(MERGE_BLOCKER_V29_DDL).replace("merge_blocker_next", "merge_blocker");
  if (stored === target) return;
  const oldBare = canonicalDdl(MERGE_BLOCKER_OLD_DDL);
  const oldPlusCols = canonicalDdl(MERGE_BLOCKER_OLD_DDL.replace(
    "  created_at  TEXT NOT NULL\n)",
    "  created_at  TEXT NOT NULL, lifted_at TEXT, lifted_by TEXT)",
  ));
  if (stored !== oldBare && stored !== oldPlusCols) {
    throw new Error("the merge_blocker table's DDL is not a shape this migration knows — refusing to rebuild it");
  }
  const has = new Set(db.prepare("PRAGMA table_info(merge_blocker)").all().map(one => String(one["name"])));
  const cols = ["publication", "reason", "task_id", "created_at", ...(has.has("lifted_at") ? ["lifted_at", "lifted_by"] : [])].join(", ");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MERGE_BLOCKER_V29_DDL);
      db.exec(`INSERT INTO merge_blocker_next (${cols}) SELECT ${cols} FROM merge_blocker`);
      db.exec("DROP TABLE merge_blocker");
      db.exec("ALTER TABLE merge_blocker_next RENAME TO merge_blocker");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

const TOURNAMENT_TERMS_V26_DDL = `CREATE TABLE tournament_terms (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref                  INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  generation                INTEGER NOT NULL,
  active                    INTEGER NOT NULL DEFAULT 1,
  race_digest               TEXT NOT NULL,
  -- The ordered agents, JSON: [{provider, model, repairModel}] — exact
  -- model ids, resolved at filing, priced at price_version.
  agents                    TEXT NOT NULL,
  n                         INTEGER NOT NULL CHECK (n BETWEEN 2 AND 4),
  per_agent_budget_microusd INTEGER NOT NULL CHECK (per_agent_budget_microusd > 0),
  overrun_reserve_microusd  INTEGER NOT NULL CHECK (overrun_reserve_microusd > 0),
  total_budget_microusd     INTEGER NOT NULL CHECK (total_budget_microusd > 0),
  price_version             INTEGER NOT NULL,
  retries                   INTEGER NOT NULL CHECK (retries = 0),
  -- 'none', or the JSON of the publication grant constraints in force.
  publication_policy        TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  approved_at               TEXT,
  approved_by               TEXT,
  approved_digest           TEXT
)`;

const TOURNAMENT_TERMS_V27_DDL = `CREATE TABLE tournament_terms_next (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref                  INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
  generation                INTEGER NOT NULL,
  active                    INTEGER NOT NULL DEFAULT 1,
  -- v27: 'race' = dollar-capped tournament (money contract required);
  -- 'comparison' = labeled cross-runtime comparison (no dollar terms
  -- exist; each lane's sealed clock is its bound). The money CHECK is
  -- kind-aware: races keep their positive budgets, comparisons pin 0.
  kind                      TEXT NOT NULL DEFAULT 'race' CHECK (kind IN ('race','comparison')),
  race_digest               TEXT NOT NULL,
  -- The ordered agents, JSON: [{provider, model, repairModel}] — exact
  -- model ids, resolved at filing, priced at price_version.
  agents                    TEXT NOT NULL,
  n                         INTEGER NOT NULL CHECK (n BETWEEN 2 AND 4),
  per_agent_budget_microusd INTEGER NOT NULL,
  overrun_reserve_microusd  INTEGER NOT NULL,
  total_budget_microusd     INTEGER NOT NULL,
  price_version             INTEGER NOT NULL,
  retries                   INTEGER NOT NULL CHECK (retries = 0),
  -- 'none', or the JSON of the publication grant constraints in force.
  publication_policy        TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  approved_at               TEXT,
  approved_by               TEXT,
  approved_digest           TEXT,
  CHECK ((kind = 'race' AND per_agent_budget_microusd > 0 AND overrun_reserve_microusd > 0 AND total_budget_microusd > 0)
      OR (kind = 'comparison' AND per_agent_budget_microusd = 0 AND overrun_reserve_microusd = 0 AND total_budget_microusd = 0))
)`;

const TOURNAMENT_TERMS_V27_COLUMNS =
  "task_ref, generation, active, race_digest, agents, n, per_agent_budget_microusd, " +
  "overrun_reserve_microusd, total_budget_microusd, price_version, retries, " +
  "publication_policy, created_at, approved_at, approved_by, approved_digest";

/**
 * The v27 rebuild: tournament_terms recognized by FULL canonical-DDL
 * equality in BOTH directions (the v26 lesson — a substring check is not
 * a recognizer): the v27 form returns untouched, the v26 form rebuilds,
 * anything else refuses. Rows copy verbatim; kind defaults to 'race'.
 */
function rebuildTournamentTermsForV27(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tournament_terms'")
    .get();
  if (row === undefined) return;
  const stored = canonicalDdl(String(row["sql"]));
  if (stored === canonicalDdl(TOURNAMENT_TERMS_V27_DDL).replace("tournament_terms_next", "tournament_terms")) return;
  if (stored !== canonicalDdl(TOURNAMENT_TERMS_V26_DDL)) {
    throw new Error("the tournament_terms table's DDL is not a shape this migration knows — refusing to rebuild it");
  }
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(TOURNAMENT_TERMS_V27_DDL);
      db.exec(
        `INSERT INTO tournament_terms_next (id, ${TOURNAMENT_TERMS_V27_COLUMNS})
         SELECT id, ${TOURNAMENT_TERMS_V27_COLUMNS} FROM tournament_terms`,
      );
      db.exec("DROP TABLE tournament_terms");
      db.exec("ALTER TABLE tournament_terms_next RENAME TO tournament_terms");
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tournament_terms_one_active
        ON tournament_terms (task_ref) WHERE active = 1`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** Whitespace-collapsed, IF-NOT-EXISTS-stripped DDL for full-equality
 * comparison — a doctored constraint that merely CONTAINS the expected
 * CHECK text must not pass (Phase 3 round-3 finding: the substring
 * recognizer is not a recognizer). */
function canonicalDdl(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "") // comments are prose, not shape (v29)
    .replace(/\bIF NOT EXISTS\b/i, "")
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1") // RENAME re-quotes the name
    .replace(/\s+/g, " ")
    // ALTER TABLE ADD COLUMN appends "\n, col …" — a newline BEFORE the
    // comma — so comma spacing is presentation, never shape (found live:
    // the v29 merge_blocker rebuild refused a real console database).
    .replace(/ ,/g, ",")
    .trim();
}

const PHASE_CONFIG_V25_DDL = `CREATE TABLE phase_config (
  scope      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('plan','build','repair')),
  provider   TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter')),
  model      TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
)`;

const PHASE_CONFIG_V26_DDL = `CREATE TABLE phase_config_next (
  scope      TEXT NOT NULL,
  phase      TEXT NOT NULL CHECK (phase IN ('plan','build','repair')),
  provider   TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')),
  model      TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (scope, phase)
)`;

/**
 * The v26 rebuild: phase_config recognized by FULL canonical-DDL equality
 * (sqlite_master's stored form, whitespace-collapsed), rows copied
 * verbatim, refused on any unrecognized shape. Idempotent: the v26 form
 * returns without touching anything.
 */
function rebuildPhaseConfigForV26(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'phase_config'")
    .get();
  if (row === undefined) return;
  const stored = canonicalDdl(String(row["sql"]));
  const target = canonicalDdl(PHASE_CONFIG_V26_DDL).replace("phase_config_next", "phase_config");
  if (stored === target) return;
  // A LATER shape is also done: a fresh database is born at the newest
  // DDL, and this earlier rebuild waves it through to v29's own pass.
  if (stored === canonicalDdl(PHASE_CONFIG_V29_DDL).replace("phase_config_next", "phase_config")) return;
  if (stored !== canonicalDdl(PHASE_CONFIG_V25_DDL)) {
    throw new Error("the phase_config table's DDL is not a shape this migration knows — refusing to rebuild it");
  }
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(PHASE_CONFIG_V26_DDL);
      db.exec(
        `INSERT INTO phase_config_next (scope, phase, provider, model, updated_at, updated_by)
         SELECT scope, phase, provider, model, updated_at, updated_by FROM phase_config`,
      );
      db.exec("DROP TABLE phase_config");
      db.exec("ALTER TABLE phase_config_next RENAME TO phase_config");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * The v24 DATA pass (foundations findings 10/16 + rulings 10/11): runs once
 * per database — idempotent because every UPDATE keys on the legacy state
 * it is classifying away from.
 *
 * - APPROVED scopes/routines (the full predicate: approved_digest equals
 *   the stored digest — reproposal keeps historical approval fields, so
 *   approved_at alone lies) get their EFFECTIVE profile resolved with
 *   today's precedence (pin > project > installation > default) and
 *   snapshotted as the approval profile, GRANDFATHERED (digest untouched,
 *   provenance says so). Unresolvable = profile_state 'unresolved': not
 *   dispatchable, not re-approvable, until restated.
 * - UNAPPROVED scopes get a working profile and their digest RECOMPUTED to
 *   v2 (nothing signed is altered — there is no live approval).
 * - Legacy contestants get per-contestant snapshots under race semantics 1;
 *   stored race fingerprints stay byte-identical.
 * - Every pre-v24 steer note is unverified-legacy (the column default);
 *   UNDELIVERED ones are additionally superseded so they can never enter
 *   a future brief (ruling 11's quarantine).
 */
function migrateToV24(db: Database): void {
  const now = new Date().toISOString();

  // -- steering quarantine ---------------------------------------------
  db.prepare(
    `UPDATE task_steer SET superseded_at = ?, superseded_reason = 'unverified-author'
      WHERE authorship_state = 'unverified-legacy' AND delivered_at IS NULL AND superseded_at IS NULL`,
  ).run(now);

  // -- effective-profile resolution, replicated for raw-db use ----------
  const KNOWN = new Set(["claude", "codex", "openrouter"]);
  const configRow = (scope: string): { provider: string; model: string | null } | null => {
    const row = db.prepare("SELECT provider, model FROM phase_config WHERE scope = ? AND phase = 'build'").get(scope) as
      | { provider: string; model: string | null }
      | undefined;
    return row ?? null;
  };
  const effective = (
    repo: string | null,
    pinProvider: string | null,
    pinModel: string | null,
  ): { ok: true; profile: ExecutionProfile; resolvedFrom: string } | { ok: false; reason: string } => {
    let provider: string | null = null;
    let model: string | null = null;
    let resolvedFrom = "default";
    if (pinProvider !== null) {
      provider = pinProvider;
      model = pinModel;
      resolvedFrom = "pinned";
    } else {
      const row = (repo === null ? null : configRow(repo)) ?? configRow("installation");
      if (row !== null) {
        provider = row.provider;
        model = row.model;
        resolvedFrom = "config";
      } else {
        provider = "claude";
        model = null;
      }
    }
    if (!KNOWN.has(provider)) return { ok: false, reason: `unknown provider \`${provider}\`` };
    if (model === null || model === "") return { ok: false, reason: "no configured model — name one and re-approve" };
    // Legacy effective repair behavior was inherit-the-build-model (flags
    // were per-invocation, never per-task), so "inherit" is the honest pin.
    const profile: ExecutionProfile =
      provider === "claude"
        ? {
            provider: "claude",
            model,
            permissionArgv: "acceptEdits",
            maxTurns: CLAUDE_LIMITS.maxTurns,
            repairMaxTurns: CLAUDE_LIMITS.repairMaxTurns,
            timeoutSeconds: CLAUDE_LIMITS.timeoutSeconds,
            repairTimeoutSeconds: CLAUDE_LIMITS.repairTimeoutSeconds,
            repairModel: "inherit",
          }
        : {
            provider: provider as "codex" | "openrouter",
            model,
            sandboxMode: "workspace-write",
            maxTurns: "unsupported",
            repairMaxTurns: "unsupported",
            timeoutSeconds: CODEX_SHAPED_LIMITS.timeoutSeconds,
            repairTimeoutSeconds: CODEX_SHAPED_LIMITS.repairTimeoutSeconds,
            repairModel: "inherit",
          };
    return { ok: true, profile, resolvedFrom };
  };

  // -- scopes ------------------------------------------------------------
  const scopes = db
    .prepare(
      `SELECT ts.task_id AS taskId, ts.goal, ts.out_of_scope AS outOfScope, ts.touches,
              ts.budget_microusd AS budget, ts.digest, ts.approved_digest AS approvedDigest,
              tr.repo AS repo, tr.agent_provider AS pinProvider, tr.agent_model AS pinModel
         FROM task_scope ts
         LEFT JOIN task_ref tr ON tr.id = (SELECT id FROM task_ref WHERE external_id = ts.task_id ORDER BY id LIMIT 1)
        WHERE ts.profile_json IS NULL AND ts.profile_state = 'resolved' AND ts.approved_profile_json IS NULL`,
    )
    .all() as {
    taskId: string; goal: string; outOfScope: string | null; touches: string;
    budget: number | null; digest: string; approvedDigest: string | null;
    repo: string | null; pinProvider: string | null; pinModel: string | null;
  }[];
  const setUnresolved = db.prepare(
    "UPDATE task_scope SET profile_state = 'unresolved', unresolved_reason = ? WHERE task_id = ?",
  );
  const pinApproved = db.prepare(
    `UPDATE task_scope SET profile_json = ?, approved_profile_json = ?, profile_provenance = ? WHERE task_id = ?`,
  );
  const stampUnapproved = db.prepare(
    `UPDATE task_scope SET profile_json = ?, digest = ?, digest_version = 2, profile_provenance = ? WHERE task_id = ?`,
  );
  for (const row of scopes) {
    const approved = row.approvedDigest !== null && row.approvedDigest === row.digest;
    const resolved = effective(row.repo, row.pinProvider, row.pinModel);
    if (!resolved.ok) {
      setUnresolved.run(resolved.reason, row.taskId);
      continue;
    }
    const snapshot = canonicalProfileJson(resolved.profile);
    const provenance = JSON.stringify({ resolvedFrom: resolved.resolvedFrom, grandfathered: approved, pinnedAt: now });
    if (approved) {
      // digest + digest_version stay EXACTLY as signed (golden-tested).
      pinApproved.run(snapshot, snapshot, provenance, row.taskId);
    } else {
      let touches: string[] = [];
      try { touches = JSON.parse(row.touches) as string[]; } catch { touches = []; }
      const recomputed = digestOf(
        { goal: row.goal, outOfScope: row.outOfScope, touches, budgetMicrousd: row.budget },
        resolved.profile,
      );
      stampUnapproved.run(snapshot, recomputed, provenance, row.taskId);
    }
  }

  // -- routines ----------------------------------------------------------
  const routines = db
    .prepare(
      `SELECT id, repo, digest, approved_digest AS approvedDigest FROM routine
        WHERE profile_json IS NULL AND approved_profile_json IS NULL`,
    )
    .all() as { id: number; repo: string; digest: string; approvedDigest: string | null }[];
  const pinRoutine = db.prepare(
    "UPDATE routine SET profile_json = ?, approved_profile_json = ?, profile_provenance = ? WHERE id = ?",
  );
  const parkRoutine = db.prepare(
    `UPDATE routine SET approved_at = NULL, approved_by = NULL, approved_digest = NULL, next_fire_at = NULL,
            profile_provenance = ? WHERE id = ?`,
  );
  const stampRoutine = db.prepare("UPDATE routine SET profile_json = ?, profile_provenance = ? WHERE id = ?");
  for (const row of routines) {
    const approved = row.approvedDigest !== null && row.approvedDigest === row.digest;
    const resolved = effective(row.repo, null, null);
    if (!resolved.ok) {
      if (approved) {
        // A standing order may not keep firing on floating authority
        // (ruling 10): the approval is demoted, said in provenance; the
        // routines screen shows it pending like any unapproved routine.
        parkRoutine.run(JSON.stringify({ demoted: "profile-unresolved", reason: resolved.reason, at: now }), row.id);
      } else {
        stampRoutine.run(null, JSON.stringify({ unresolved: resolved.reason, at: now }), row.id);
      }
      continue;
    }
    const snapshot = canonicalProfileJson(resolved.profile);
    const provenance = JSON.stringify({ resolvedFrom: resolved.resolvedFrom, grandfathered: approved, pinnedAt: now });
    if (approved) pinRoutine.run(snapshot, snapshot, provenance, row.id);
    else stampRoutine.run(snapshot, provenance, row.id);
  }

  // -- legacy contestants: exact provider/model/repair already stored -----
  const contestants = db
    .prepare("SELECT id, provider, model, repair_model AS repairModel FROM contestant WHERE profile_json IS NULL")
    .all() as { id: number; provider: string; model: string; repairModel: string }[];
  const stampContestant = db.prepare("UPDATE contestant SET profile_json = ? WHERE id = ?");
  for (const row of contestants) {
    if (!KNOWN.has(row.provider)) continue; // stays null; admission keeps byte-comparing v1 fingerprints
    const profile: ExecutionProfile =
      row.provider === "claude"
        ? {
            provider: "claude", model: row.model, permissionArgv: "acceptEdits",
            maxTurns: CLAUDE_LIMITS.maxTurns, repairMaxTurns: CLAUDE_LIMITS.repairMaxTurns,
            timeoutSeconds: CLAUDE_LIMITS.timeoutSeconds, repairTimeoutSeconds: CLAUDE_LIMITS.repairTimeoutSeconds,
            repairModel: row.repairModel,
          }
        : {
            provider: row.provider as "codex" | "openrouter", model: row.model,
            sandboxMode: "workspace-write", maxTurns: "unsupported", repairMaxTurns: "unsupported",
            timeoutSeconds: CODEX_SHAPED_LIMITS.timeoutSeconds, repairTimeoutSeconds: CODEX_SHAPED_LIMITS.repairTimeoutSeconds,
            repairModel: row.repairModel,
          };
    stampContestant.run(canonicalProfileJson(profile), row.id);
  }
}

/** The v4 run shape, shared by the fresh SCHEMA, the M2 rebuild, and the v3→v4 rebuild. */
function V4_RUN_DDL(name: string): string {
  return `CREATE TABLE ${name} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
    lease_id      TEXT NOT NULL,
    runner        TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair','planner')),
    provider      TEXT NOT NULL DEFAULT 'claude',
    parent_run    INTEGER REFERENCES run(id),
    session_id    TEXT,
    base_revision TEXT,
    branch        TEXT NOT NULL,
    worktree      TEXT NOT NULL,
    model         TEXT,
    phase         TEXT,
    outcome       TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change')),
    reason        TEXT,
    committed     INTEGER,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    provider_started_at TEXT,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    cost_usd      REAL,
    usage_json    TEXT,
    head_revision TEXT,
    handoff       TEXT
  )`;
}

const V4_RUN_COLUMNS = [
  "id", "task_ref", "lease_id", "runner", "role", "provider", "parent_run", "session_id",
  "base_revision", "branch", "worktree", "model", "phase", "outcome", "reason",
  "committed", "started_at", "finished_at", "provider_started_at", "tokens_in",
  "tokens_out", "cost_usd", "usage_json", "head_revision", "handoff",
];

/**
 * The v25 run shape: outcome admits 'interrupted' and the attended
 * authorization stamp arrives. The column list is the FULL v24 set —
 * this rebuild runs after every addColumn in migrate(), so the only
 * pre-v25 shape it ever sees carries all of them, and the intersection
 * copy tolerates an interrupted earlier migration exactly like v4's.
 */
function V25_RUN_DDL(name: string): string {
  return `CREATE TABLE ${name} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_ref      INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
    lease_id      TEXT NOT NULL,
    runner        TEXT NOT NULL,
    scope_digest     TEXT,
    profile_digest   TEXT,
    provider_version TEXT,
    role          TEXT NOT NULL DEFAULT 'builder' CHECK (role IN ('builder','repair','planner')),
    provider      TEXT NOT NULL DEFAULT 'claude',
    parent_run    INTEGER REFERENCES run(id),
    session_id    TEXT,
    base_revision TEXT,
    branch        TEXT NOT NULL,
    worktree      TEXT NOT NULL,
    model         TEXT,
    phase         TEXT,
    contestant    INTEGER REFERENCES contestant(id),
    outcome       TEXT CHECK (outcome IN ('built','failed','refused','parked','no-change','interrupted')),
    reason        TEXT,
    committed     INTEGER,
    attended_authorization TEXT REFERENCES attended_authorization(id),
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    provider_started_at TEXT,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    cost_usd      REAL,
    usage_json    TEXT,
    head_revision TEXT,
    handoff       TEXT
  )`;
}

const V25_RUN_COLUMNS = [
  "id", "task_ref", "lease_id", "runner", "scope_digest", "profile_digest",
  "provider_version", "role", "provider", "parent_run", "session_id",
  "base_revision", "branch", "worktree", "model", "phase", "contestant",
  "outcome", "reason", "committed", "attended_authorization", "started_at",
  "finished_at", "provider_started_at", "tokens_in", "tokens_out", "cost_usd",
  "usage_json", "head_revision", "handoff",
];

/**
 * v25: the decision table sheds its one-decision-per-run UNIQUE (a held
 * session parks, is answered, and parks again — many decisions, one run)
 * and gains the held-session linkage columns. Recognized exactly: the only
 * pre-v25 shape is rebuildDecisionVia's output (or the fresh pre-v25
 * SCHEMA, which is byte-compatible on the recognizer fragments); anything
 * else refuses loudly. The one-unresolved-per-run rule moves to a partial
 * unique index in openStore's post-migration block.
 */
function rebuildDecisionForV25(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'decision'")
    .get();
  if (row === undefined) return;
  const ddl = String(row["sql"]);
  if (ddl.includes("delivered_turn")) return;
  if (!ddl.includes("UNIQUE REFERENCES run(id)")) {
    throw new Error(
      "the decision table's DDL is not a shape this migration knows — refusing to rebuild it",
    );
  }

  const present = new Set(
    db.prepare("PRAGMA table_info(decision)").all().map(one => String(one["name"])),
  );
  const target = [
    "id", "run", "urgency", "state", "recap", "question", "options",
    "recommendation", "assignee", "deadline", "created_at", "answered_at",
    "answered_by", "contestant", "closed_reason", "answered_via", "choice", "note",
  ];
  const carried = target.filter(column => present.has(column));
  const names = carried.join(", ");

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        `CREATE TABLE decision_next (
           id             INTEGER PRIMARY KEY AUTOINCREMENT,
           run            INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
           urgency        TEXT NOT NULL CHECK (urgency IN ('blocking')),
           state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','expired','answered')),
           recap          TEXT NOT NULL,
           question       TEXT NOT NULL,
           options        TEXT NOT NULL,
           recommendation TEXT NOT NULL,
           assignee       TEXT,
           deadline       TEXT,
           created_at     TEXT NOT NULL,
           answered_at    TEXT,
           answered_by    TEXT,
           contestant     INTEGER REFERENCES contestant(id),
           closed_reason  TEXT CHECK (closed_reason IN ('excluded')),
           answered_via   TEXT CHECK (answered_via IN ('cli','web','telegram')),
           choice         TEXT,
           note           TEXT,
           session_turn   INTEGER REFERENCES session_turn(id),
           delivered_turn INTEGER REFERENCES session_turn(id)
         )`,
      );
      db.exec(`INSERT INTO decision_next (${names}) SELECT ${names} FROM decision`);
      db.exec("DROP TABLE decision");
      db.exec("ALTER TABLE decision_next RENAME TO decision");
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`decision rebuild left ${broken.length} dangling foreign key(s)`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * One v4 CHECK widening: recognized exactly, refused otherwise. The copy
 * moves the intersection of the target's columns and the columns actually
 * present, so an interrupted earlier migration cannot lose data.
 */
function rebuildForV4(
  db: Database,
  table: string,
  oldFragment: string,
  newFragment: string,
  targetDDL: string,
  targetColumns: readonly string[],
): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (row === undefined) return;
  const ddl = String(row["sql"]);
  if (ddl.includes(newFragment)) return;
  if (!ddl.includes(oldFragment)) {
    throw new Error(`the ${table} table's DDL is not a shape this migration knows — refusing to rebuild it`);
  }

  const present = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(one => String(one["name"])),
  );
  const carried = targetColumns.filter(column => present.has(column));
  const names = carried.join(", ");

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(targetDDL);
      db.exec(`INSERT INTO ${table}_next (${names}) SELECT ${names} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_next RENAME TO ${table}`);
      if (table === "hold") db.exec("CREATE INDEX IF NOT EXISTS hold_by_task ON hold (task_ref)");
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`${table} rebuild left ${broken.length} dangling foreign key(s)`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * v3: decision.answered_via admits 'telegram'. Same copy-rename recipe as
 * rebuild(), but the detection is exact: only the two DDL shapes this
 * project has ever written are recognized, and anything else refuses loudly
 * — a substring guess against somebody's hand-edited schema is how a
 * migration eats a database.
 */
function rebuildDecisionVia(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'decision'")
    .get();
  if (row === undefined) return;
  const ddl = String(row["sql"]);
  if (ddl.includes("'cli','web','telegram'")) return;
  if (!ddl.includes("'cli','web'")) {
    throw new Error(
      "the decision table's DDL is not a shape this migration knows — refusing to rebuild it",
    );
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        `CREATE TABLE decision_next (
           id             INTEGER PRIMARY KEY AUTOINCREMENT,
           run            INTEGER NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
           urgency        TEXT NOT NULL CHECK (urgency IN ('blocking')),
           state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','expired','answered')),
           recap          TEXT NOT NULL,
           question       TEXT NOT NULL,
           options        TEXT NOT NULL,
           recommendation TEXT NOT NULL,
           assignee       TEXT,
           deadline       TEXT,
           created_at     TEXT NOT NULL,
           answered_at    TEXT,
           answered_by    TEXT,
           answered_via   TEXT CHECK (answered_via IN ('cli','web','telegram')),
           choice         TEXT,
           note           TEXT
         )`,
      );
      db.exec(
        `INSERT INTO decision_next (id, run, urgency, state, recap, question, options,
                                    recommendation, assignee, deadline, created_at,
                                    answered_at, answered_by, answered_via, choice, note)
         SELECT id, run, urgency, state, recap, question, options,
                recommendation, assignee, deadline, created_at,
                answered_at, answered_by, answered_via, choice, note FROM decision`,
      );
      db.exec("DROP TABLE decision");
      db.exec("ALTER TABLE decision_next RENAME TO decision");
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`decision rebuild left ${broken.length} dangling foreign key(s)`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * The tables whose shape changed, not merely grew.
 *
 * `run`'s outcome CHECK had to admit 'parked' and `hold` had to move its
 * primary key, and SQLite's ALTER can do neither — so this is the manual's
 * copy-rename recipe: build the new table, move the rows, drop the old, take
 * its name. Detected by column presence, like `addColumn`, so it runs once
 * per database ever and is a no-op on a fresh file whose SCHEMA already has
 * the new shape.
 *
 * Every fresh-`:memory:` test passes without this function existing; the
 * first park against a real M2 database is what it exists for.
 */
function rebuild(db: Database): void {
  const oldHold = tableExists(db, "hold") && !hasColumn(db, "hold", "owner_kind");
  const oldRun = tableExists(db, "run") && !hasColumn(db, "run", "role");
  if (!oldHold && !oldRun) return;

  // Foreign keys off so `run` can be dropped while decision/artifact rows
  // name it — and a PRAGMA is a no-op inside a transaction, so it brackets
  // one rather than living in it. The check at the end proves the swap left
  // every reference intact before anything commits.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (oldHold) {
        db.exec(
          `CREATE TABLE hold_next (
             id         INTEGER PRIMARY KEY AUTOINCREMENT,
             task_ref   INTEGER NOT NULL REFERENCES task_ref(id) ON DELETE CASCADE,
             owner_kind TEXT NOT NULL CHECK (owner_kind IN ('operator','decision','incident','backoff')),
             owner_id   TEXT NOT NULL,
             reason     TEXT NOT NULL,
             until      TEXT,
             held_at    TEXT NOT NULL,
             UNIQUE (owner_kind, owner_id)
           )`,
        );
        // Every pre-M3 hold was placed by a person; ownership records that.
        db.exec(
          `INSERT INTO hold_next (task_ref, owner_kind, owner_id, reason, until, held_at)
           SELECT task_ref, 'operator', CAST(task_ref AS TEXT), reason, until, held_at FROM hold`,
        );
        db.exec("DROP TABLE hold");
        db.exec("ALTER TABLE hold_next RENAME TO hold");
        db.exec("CREATE INDEX IF NOT EXISTS hold_by_task ON hold (task_ref)");
      }
      if (oldRun) {
        // Straight to the newest shape: an M2 database does not stop at v3
        // on its way here.
        db.exec(V4_RUN_DDL("run_next"));
        db.exec(
          `INSERT INTO run_next (id, task_ref, lease_id, runner, branch, worktree, model,
                                 outcome, reason, committed, started_at, finished_at)
           SELECT id, task_ref, lease_id, runner, branch, worktree, model,
                  outcome, reason, committed, started_at, finished_at FROM run`,
        );
        db.exec("DROP TABLE run");
        db.exec("ALTER TABLE run_next RENAME TO run");
      }
      const broken = db.prepare("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`schema rebuild left ${broken.length} dangling foreign key(s)`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function tableExists(db: Database, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some(row => String(row["name"]) === column);
}

function addColumn(db: Database, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function defaultConnect(file: string): Database {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => Database;
  };
  return new DatabaseSync(file);
}

export class Store {
  constructor(private readonly db: Database) {}

  /** TESTS ONLY: raw database access for migration fixtures. Production
   * code never calls this — the typed methods are the API. */
  raw(): Database {
    return this.db;
  }

  /** Exposed so `claim.ts` can run its compare-and-swap in one transaction. */
  get handle(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // ---- the built-in task store -------------------------------------------

  /**
   * Creating a task also creates its overlay reference, because a task with no
   * `TaskRef` cannot be claimed, held, or scheduled — it would be work the
   * control plane can see and never act on.
   */
  createTask(spec: { id: string; title: string }, now: Date, mutation: Mutation = {}): Task {
    return this.once(mutation, "createTask", () =>
      // Both rows or neither, and the comment above is why: this used to be
      // two unwrapped statements, and the first real database caught it. A
      // schema change made the second one fail, the first had already
      // committed, and the result was a task with no reference — invisible to
      // the ready query, unclaimable, and silently given a reference later by
      // something else, with the wrong origin. Exactly the state this
      // invariant exists to rule out, arrived at by the invariant not being
      // enforced.
      this.transact(() => {
      const stamp = now.toISOString();
      this.db
        .prepare(
          "INSERT INTO task (id, title, state, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)",
        )
        .run(spec.id, spec.title, stamp, stamp);
      // Created here, so it is ours — the one place that is true by construction.
      this.refFor(BUILT_IN, spec.id, "ours");
      this.bumpWake();
      return {
        id: spec.id,
        title: spec.title,
        state: "queued" as TaskState,
        createdAt: stamp,
        updatedAt: stamp,
        priority: 0,
      };
      }),
    );
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM task WHERE id = ?").get(id);
    return row === undefined ? null : readTask(row);
  }

  /** Oldest first, so a list reads in the order the work was thought of. */
  listTasks(state?: TaskState): Task[] {
    const rows =
      state === undefined
        ? this.db.prepare("SELECT * FROM task ORDER BY created_at, id").all()
        : this.db.prepare("SELECT * FROM task WHERE state = ? ORDER BY created_at, id").all(state);
    return rows.map(readTask);
  }

  /** What this task is waiting for, whether or not those are finished. */
  blockers(id: string): string[] {
    return this.db
      .prepare("SELECT blocker FROM task_edge WHERE blocked = ? ORDER BY blocker")
      .all(id)
      .map(row => String(row["blocker"]));
  }

  /** The external id behind a reference, for reporting a claim back in words. */
  externalIdFor(taskRef: number): string | null {
    const row = this.db.prepare("SELECT external_id FROM task_ref WHERE id = ?").get(taskRef);
    return row === undefined ? null : String(row["external_id"]);
  }

  /** The whole reference by its id — the overlay's view of one task. */
  refForId(taskRef: number): TaskRef | null {
    const row = this.db.prepare("SELECT * FROM task_ref WHERE id = ?").get(taskRef);
    return row === undefined ? null : readTaskRef(row);
  }

  /**
   * THE one writer of `state = 'cancelled'` (MCP gateway spec v6, Codex
   * round-5 finding 2). Every cancellation road — the generic state verb,
   * operator dismissal, the external-mirror latch, a disowned fenced
   * completion — lands here, so a cancellation can never happen without a
   * stated reason and (once coordinator filings exist) its durable event.
   * An architecture test proves no other statement writes 'cancelled'.
   *
   * The floor does NOT decide admission — callers keep their own guards
   * (live-claim refusals, latch conditions, fencing) and pass the states
   * they admit from (`null` = any). It returns raw changes; callers keep
   * their own refusal words and wake bumps.
   */
  applyCancellation(
    taskId: string,
    reason:
      | { kind: "operator"; text: string | null }
      | { kind: "machine"; code: "mirror-latched" | "disowned-completion" },
    now: Date,
    admittedFrom: readonly TaskState[] | null,
  ): { changed: boolean } {
    const filter = admittedFrom === null ? "" : ` AND state IN (${admittedFrom.map(() => "?").join(",")})`;
    const { changes } = this.db
      .prepare(`UPDATE task SET state = 'cancelled', updated_at = ? WHERE id = ?${filter}`)
      .run(now.toISOString(), taskId, ...(admittedFrom ?? []));
    if (Number(changes) === 0) return { changed: false };
    // A cancelled task's pending steering settles superseded in the SAME
    // transaction, whichever road cancelled it — a note silently waiting
    // for a build that can no longer happen is wrong on every road, not
    // just the state verb's.
    const ref = this.db
      .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(BUILT_IN, taskId);
    if (ref !== undefined) this.supersedeSteerNotes(Number(ref["id"]), now);
    // The reason is part of the transition, not decoration: machine codes
    // are typed here; the coordinator_event row rides this exact seam when
    // coordinator filings arrive (spec: events atomic with state changes).
    void reason;
    return { changed: true };
  }

  setTaskState(
    id: string,
    state: TaskState,
    now: Date,
    mutation: Mutation = {},
  ): { ok: true } | { ok: false; reason: "unknown-task" | "external-closed" } {
    return this.once(
      mutation,
      "setTaskState",
      () => {
        // The terminal guard lives IN the primitive so every present and
        // future caller is covered (external dispatch, finding 23): a
        // mirror the tracker closed cannot be marked done — reopen it
        // first, or leave it cancelled. cancelled/failed stay allowed;
        // they are the latch's own vocabulary.
        if (state === "done") {
          const latched = this.db
            .prepare("SELECT 1 AS hit FROM external_mirror WHERE local_task_id = ? AND remote_state <> 'open'")
            .get(id);
          if (latched !== undefined) return { ok: false as const, reason: "external-closed" as const };
        }
        return this.transact(() => {
          if (state === "cancelled") {
            // The floor is the only writer of 'cancelled' — the state verb
            // is an operator road with no ceremony text of its own.
            const done = this.applyCancellation(id, { kind: "operator", text: null }, now, null);
            if (!done.changed) return { ok: false as const, reason: "unknown-task" as const };
            this.bumpWake();
            return { ok: true as const };
          }
          const { changes } = this.db
            .prepare("UPDATE task SET state = ?, updated_at = ? WHERE id = ?")
            .run(state, now.toISOString(), id);
          if (Number(changes) === 0) return { ok: false as const, reason: "unknown-task" as const };
          // A finished task's pending steering settles superseded in the
          // SAME transaction (arc 1): shown as what it is, never a note
          // silently waiting for a build that can no longer happen.
          if (state === "done") {
            const ref = this.db
              .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
              .get(BUILT_IN, id);
            if (ref !== undefined) this.supersedeSteerNotes(Number(ref["id"]), now);
          }
          this.bumpWake();
          return { ok: true as const };
        });
      },
      // A refusal mutated nothing, so there is nothing to replay — and
      // recording it would answer "no" forever, including after somebody
      // creates the task or reopens the mirror (finding 42).
      result => result.ok,
    );
  }

  /**
   * `blocked` waits for `blocker`.
   *
   * A cycle is refused rather than stored. Stored, it would be invisible: every
   * task in the ring stays un-ready forever and the ready set simply comes back
   * one task shorter each night, with nothing anywhere saying why.
   */
  addEdge(blocked: string, blocker: string, mutation: Mutation = {}): { ok: true } | { ok: false; reason: string } {
    return this.once(mutation, "addEdge", () =>
      // The reachability check and the insert have to be one atomic step.
      // Apart, two callers adding `a waits on b` and `b waits on a` at the
      // same moment each see no cycle, and between them store one.
      this.transact(() => {
        if (blocked === blocker) return { ok: false as const, reason: "a task cannot block itself" };
        if (this.reaches(blocker, blocked)) {
          return { ok: false as const, reason: `${blocker} already waits on ${blocked} — that is a cycle` };
        }
        this.db
          .prepare("INSERT OR IGNORE INTO task_edge (blocked, blocker) VALUES (?, ?)")
          .run(blocked, blocker);
        return { ok: true as const };
      }),
      result => result.ok,
    );
  }

  /**
   * Remove one dependency edge. Removal cannot create a cycle, so no
   * closure check — but delete-and-wake stay one transaction so it
   * serializes cleanly against claim admission: whichever commits first,
   * the claim's own re-proof sees a consistent world. Removing an edge
   * makes a task DISPATCHABLE sooner, never buildable without approval.
   */
  removeEdge(blocked: string, blocker: string, mutation: Mutation = {}): { ok: true } | { ok: false; reason: string } {
    return this.once(mutation, "removeEdge", () =>
      this.transact(() => {
        const changes = this.db
          .prepare("DELETE FROM task_edge WHERE blocked = ? AND blocker = ?")
          .run(blocked, blocker).changes;
        if (Number(changes) === 0) return { ok: false as const, reason: "not-waiting" };
        // A tick that snapshotted its ready list before this commit waits
        // for the next pass — the wake is what makes "next pass" now.
        this.bumpWake();
        return { ok: true as const };
      }),
      result => result.ok,
    );
  }

  /**
   * Move a task to the front of the queue: rank = one past the highest
   * rank any still-dispatchable task holds, computed and written in ONE
   * transaction (two racing "next" calls get distinct ranks; the later
   * ask wins). Scheduling only: it refuses anything not plainly queued —
   * building, finished, failed, cancelled, or racing a tournament — and
   * never touches updated_at, which the board reads as the stall clock.
   */
  moveTaskNext(taskId: string, now: Date, mutation: Mutation = {}): { ok: true; priority: number } | { ok: false; reason: string } {
    return this.once(mutation, "moveTaskNext", () =>
      this.transact(() => {
        const task = this.db.prepare("SELECT state FROM task WHERE id = ?").get(taskId);
        if (task === undefined) return { ok: false as const, reason: "unknown-task" };
        const ref = this.db
          .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
          .get(BUILT_IN, taskId);
        if (ref !== undefined) {
          // The live claim is checked BEFORE the state: taking a task sets
          // it running, so "claimed" would otherwise be unreachable and the
          // operator would read the less honest "not queued".
          if (this.currentLiveLease(Number(ref["id"]), now) !== null) return { ok: false as const, reason: "claimed" };
          const racing = this.db
            .prepare(
              `SELECT 1 AS hit FROM contest WHERE task_ref = ?
                AND state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted') LIMIT 1`,
            )
            .get(Number(ref["id"]));
          if (racing !== undefined) return { ok: false as const, reason: "contest-open" };
        }
        if (String(task["state"]) !== "queued") return { ok: false as const, reason: "not-queued" };
        // Rank is per COLUMN (assigned worker + repo partition) — "next"
        // means the front of THIS task's own queue, not a global race. A
        // legacy row with no reference lives in the (null, null) partition.
        const partition = this.db
          .prepare("SELECT repo, assigned_runner FROM task_ref WHERE backend = ? AND external_id = ?")
          .get(BUILT_IN, taskId);
        const top = this.db
          .prepare(
            `SELECT MAX(task.priority) AS top FROM task
               LEFT JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
              WHERE task.state IN ('queued','running')
                AND (task_ref.assigned_runner IS ?) AND (task_ref.repo IS ?)`,
          )
          .get(BUILT_IN, partition?.["assigned_runner"] ?? null, partition?.["repo"] ?? null);
        const highest = top === undefined || top["top"] === null ? 0 : Number(top["top"]);
        if (highest >= Number.MAX_SAFE_INTEGER - 1) return { ok: false as const, reason: "rank-overflow" };
        const priority = highest + 1;
        this.db.prepare("UPDATE task SET priority = ? WHERE id = ?").run(priority, taskId);
        this.bumpQueueRevision();
        this.bumpWake();
        return { ok: true as const, priority };
      }),
      result => result.ok,
    );
  }

  /** Undo a promotion: back to filing order. Refuses nothing but absence —
   * demoting finished work is harmless. */
  clearTaskPriority(taskId: string, mutation: Mutation = {}): { ok: true } | { ok: false; reason: string } {
    return this.once(mutation, "clearTaskPriority", () =>
      this.transact(() => {
        const changes = this.db.prepare("UPDATE task SET priority = 0 WHERE id = ?").run(taskId).changes;
        if (Number(changes) === 0) return { ok: false as const, reason: "unknown-task" };
        this.bumpQueueRevision();
        this.bumpWake();
        return { ok: true as const };
      }),
      result => result.ok,
    );
  }

  // ---- queue columns (v19) -------------------------------------------------

  /** The worker a task is reserved for, or null — the claim gate's read. */
  assignedRunnerOf(taskRef: number): string | null {
    const row = this.db.prepare("SELECT assigned_runner FROM task_ref WHERE id = ?").get(taskRef);
    return row === undefined || row["assigned_runner"] === null ? null : String(row["assigned_runner"]);
  }

  queueRevision(): number {
    const row = this.db.prepare("SELECT revision FROM queue_state WHERE id = 1").get();
    return row === undefined ? 0 : Number(row["revision"]);
  }

  private bumpQueueRevision(): void {
    this.db.exec("UPDATE queue_state SET revision = revision + 1 WHERE id = 1");
  }

  /** The column note — operator prose, display only. */
  setRunnerQueueNote(name: string, note: string | null): { ok: true } | { ok: false; reason: string } {
    const changes = this.db.prepare("UPDATE runner SET queue_note = ? WHERE name = ?").run(note, name).changes;
    return Number(changes) === 1 ? { ok: true } : { ok: false, reason: "no-such-worker" };
  }

  /**
   * One atomic queue move (queue-columns review, findings 3/9/13): the
   * revision CAS, every refusal, the assignment write, and the rerank of
   * BOTH affected columns are one transaction. The rerank member set is
   * the FREE members only — anything live-claimed or racing a tournament
   * keeps its rank untouched, so a drag can never rewrite work being
   * taken (a setup-failure release rejoins with the rank the operator
   * last gave it — intent, not a bug). Scheduling, never authority.
   */
  moveTask(
    args: { taskId: string; toRunner: string | null; beforeTaskId: string | null; queueRevision?: number },
    now: Date,
    mutation: Mutation = {},
  ): { ok: true } | { ok: false; reason: string } {
    return this.once(mutation, "moveTask", () =>
      this.transact(() => {
        if (args.queueRevision !== undefined && args.queueRevision !== this.queueRevision()) {
          return { ok: false as const, reason: "stale" };
        }
        const task = this.db.prepare("SELECT state FROM task WHERE id = ?").get(args.taskId);
        if (task === undefined) return { ok: false as const, reason: "unknown-task" };
        const ref = this.db
          .prepare("SELECT id, repo, assigned_runner FROM task_ref WHERE backend = ? AND external_id = ?")
          .get(BUILT_IN, args.taskId);
        if (ref === undefined) return { ok: false as const, reason: "unknown-task" };
        // Claimed before not-queued: taking a task sets it running, so the
        // honest word for mid-build work is "claimed" (same rule as next).
        if (this.currentLiveLease(Number(ref["id"]), now) !== null) return { ok: false as const, reason: "claimed" };
        if (String(task["state"]) !== "queued") return { ok: false as const, reason: "not-queued" };
        const racing = this.db
          .prepare(
            `SELECT 1 AS hit FROM contest WHERE task_ref = ?
              AND state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted') LIMIT 1`,
          )
          .get(Number(ref["id"]));
        if (racing !== undefined) return { ok: false as const, reason: "contest-open" };
        if (args.toRunner !== null) {
          const worker = this.db.prepare("SELECT retired_at FROM runner WHERE name = ?").get(args.toRunner);
          if (worker === undefined) return { ok: false as const, reason: "no-such-worker" };
          const alreadyOwns = ref["assigned_runner"] !== null && String(ref["assigned_runner"]) === args.toRunner;
          if (worker["retired_at"] !== null && !alreadyOwns) return { ok: false as const, reason: "worker-retired" };
        }
        const repo = ref["repo"] === null ? null : String(ref["repo"]);
        const fromRunner = ref["assigned_runner"] === null ? null : String(ref["assigned_runner"]);

        // The FREE members of a partition, in current queue order.
        const freeMembers = (runner: string | null): string[] =>
          this.db
            .prepare(
              `SELECT task.id AS id FROM task
                 JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
                WHERE task.state = 'queued'
                  AND (task_ref.assigned_runner IS ? )
                  AND (task_ref.repo IS ?)
                  AND NOT EXISTS (
                    SELECT 1 FROM claim WHERE claim.task_ref = task_ref.id
                      AND claim.released_at IS NULL AND claim.expires_at > ?
                      AND claim.lease_generation = (
                        SELECT MAX(newest.lease_generation) FROM claim AS newest
                        WHERE newest.task_ref = task_ref.id))
                  AND NOT EXISTS (
                    SELECT 1 FROM contest WHERE contest.task_ref = task_ref.id
                      AND contest.state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted'))
                ORDER BY task.priority DESC, task.created_at, task_ref.id`,
            )
            .all(BUILT_IN, runner, repo, now.toISOString())
            .map(row => String(row["id"]));

        const target = freeMembers(args.toRunner).filter(id => id !== args.taskId);
        if (args.beforeTaskId !== null) {
          if (args.beforeTaskId === args.taskId) return { ok: false as const, reason: "stale" };
          const at = target.indexOf(args.beforeTaskId);
          if (at === -1) return { ok: false as const, reason: "stale" };
          target.splice(at, 0, args.taskId);
        } else {
          target.push(args.taskId);
        }

        this.db
          .prepare("UPDATE task_ref SET assigned_runner = ? WHERE backend = ? AND external_id = ?")
          .run(args.toRunner, BUILT_IN, args.taskId);
        const rank = this.db.prepare("UPDATE task SET priority = ? WHERE id = ?");
        target.forEach((id, index) => rank.run(target.length - index, id));
        if (fromRunner !== args.toRunner) {
          const source = freeMembers(fromRunner).filter(id => id !== args.taskId);
          source.forEach((id, index) => rank.run(source.length - index, id));
        }
        this.bumpQueueRevision();
        this.bumpWake();
        return { ok: true as const };
      }),
      result => result.ok,
    );
  }

  /**
   * The queue screen's snapshot: every queued task in the project, in
   * column order, each saying whether the scheduler already has its hands
   * on it (those cards render pinned, not draggable — finding 13).
   */
  queueScoped(
    repo: string | null,
    now: Date,
  ): {
    id: string;
    title: string;
    repo: string | null;
    assignedRunner: string | null;
    approved: boolean;
    blockers: number;
    taken: boolean;
    createdAt: string;
  }[] {
    const stamp = now.toISOString();
    return this.db
      .prepare(
        `SELECT task.id AS id, task.title AS title, task_ref.repo AS repo,
                task_ref.assigned_runner AS assigned, task.created_at AS created_at,
                EXISTS (SELECT 1 FROM task_scope WHERE task_scope.task_id = task.id
                  AND task_scope.approved_digest = task_scope.digest AND task_scope.approved_at IS NOT NULL) AS approved,
                (SELECT COUNT(*) FROM task_edge JOIN task AS blocker ON blocker.id = task_edge.blocker
                  WHERE task_edge.blocked = task.id AND blocker.state <> 'done') AS blockers,
                (EXISTS (SELECT 1 FROM claim WHERE claim.task_ref = task_ref.id
                    AND claim.released_at IS NULL AND claim.expires_at > ?
                    AND claim.lease_generation = (SELECT MAX(newest.lease_generation) FROM claim AS newest
                      WHERE newest.task_ref = task_ref.id))
                 OR EXISTS (SELECT 1 FROM contest WHERE contest.task_ref = task_ref.id
                    AND contest.state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted'))) AS taken
           FROM task JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
          WHERE task.state = 'queued'
            AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
          ORDER BY task.priority DESC, task.created_at, task_ref.id
          LIMIT 200`,
      )
      .all(stamp, BUILT_IN, repo, repo)
      .map(row => ({
        id: String(row["id"]),
        title: String(row["title"]),
        repo: row["repo"] === null ? null : String(row["repo"]),
        assignedRunner: row["assigned"] === null ? null : String(row["assigned"]),
        approved: Number(row["approved"]) === 1,
        blockers: Number(row["blockers"]),
        taken: Number(row["taken"]) === 1,
        createdAt: String(row["created_at"]),
      }));
  }

  /**
   * Where a queued task stands, using the COMPLETE order — rank, then
   * filing time, then reference id (finding 15: rank alone calls every
   * unranked task "first"). Position is within the task's own column.
   */
  queuePosition(taskId: string): { position: number; total: number; column: string | null } | null {
    const me = this.db
      .prepare(
        `SELECT task.priority AS priority, task.created_at AS created_at, task_ref.id AS ref,
                task_ref.repo AS repo, task_ref.assigned_runner AS assigned
           FROM task JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
          WHERE task.id = ? AND task.state = 'queued'`,
      )
      .get(BUILT_IN, taskId);
    if (me === undefined) return null;
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN task.priority > ?
                 OR (task.priority = ? AND task.created_at < ?)
                 OR (task.priority = ? AND task.created_at = ? AND task_ref.id < ?)
               THEN 1 ELSE 0 END) AS ahead
           FROM task JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
          WHERE task.state = 'queued' AND (task_ref.assigned_runner IS ?) AND (task_ref.repo IS ?)`,
      )
      .get(
        Number(me["priority"]), Number(me["priority"]), String(me["created_at"]),
        Number(me["priority"]), String(me["created_at"]), Number(me["ref"]),
        BUILT_IN, me["assigned"], me["repo"],
      );
    return {
      position: Number(row?.["ahead"] ?? 0) + 1,
      total: Number(row?.["total"] ?? 1),
      column: me["assigned"] === null ? null : String(me["assigned"]),
    };
  }

  /**
   * The fleet screen's snapshot: every queued task across projects in
   * column order (like queueScoped but project-wide). The console layer
   * still filters each row through the ceiling before rendering — this is
   * a survey, not an admission, and a repo outside the wall never leaves
   * the page.
   */
  fleetQueue(
    now: Date,
  ): {
    id: string;
    title: string;
    repo: string | null;
    assignedRunner: string | null;
    approved: boolean;
    blockers: number;
    taken: boolean;
  }[] {
    const stamp = now.toISOString();
    return this.db
      .prepare(
        `SELECT task.id AS id, task.title AS title, task_ref.repo AS repo,
                task_ref.assigned_runner AS assigned,
                EXISTS (SELECT 1 FROM task_scope WHERE task_scope.task_id = task.id
                  AND task_scope.approved_digest = task_scope.digest AND task_scope.approved_at IS NOT NULL) AS approved,
                (SELECT COUNT(*) FROM task_edge JOIN task AS blocker ON blocker.id = task_edge.blocker
                  WHERE task_edge.blocked = task.id AND blocker.state <> 'done') AS blockers,
                (EXISTS (SELECT 1 FROM claim WHERE claim.task_ref = task_ref.id
                    AND claim.released_at IS NULL AND claim.expires_at > ?
                    AND claim.lease_generation = (SELECT MAX(newest.lease_generation) FROM claim AS newest
                      WHERE newest.task_ref = task_ref.id))
                 OR EXISTS (SELECT 1 FROM contest WHERE contest.task_ref = task_ref.id
                    AND contest.state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted'))) AS taken
           FROM task JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
          WHERE task.state = 'queued'
          ORDER BY task.priority DESC, task.created_at, task_ref.id
          LIMIT 400`,
      )
      .all(stamp, BUILT_IN)
      .map(row => ({
        id: String(row["id"]),
        title: String(row["title"]),
        repo: row["repo"] === null ? null : String(row["repo"]),
        assignedRunner: row["assigned"] === null ? null : String(row["assigned"]),
        approved: Number(row["approved"]) === 1,
        blockers: Number(row["blockers"]),
        taken: Number(row["taken"]) === 1,
      }));
  }

  /** Whether this connection is already inside transact(); see below. */
  private transacting = false;

  /**
   * IMMEDIATE, so two writers queue rather than both deciding they may write.
   *
   * Reentrant: a body that calls another transact()-wrapped method joins the
   * outer transaction instead of throwing "within a transaction". The outer
   * caller owns commit and rollback — which is the point: the Telegram
   * bridge composes pairing, action consumption, and the answer CAS into
   * one atomic unit precisely by nesting the methods that each guard
   * themselves when called alone.
   */
  transact<T>(body: () => T): T {
    if (this.transacting) return body();
    this.db.exec("BEGIN IMMEDIATE");
    this.transacting = true;
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transacting = false;
    }
  }

  /**
   * A named SAVEPOINT for a multi-statement primitive that must roll back
   * WHOLESALE on a mid-body error, EVEN when nested inside an outer
   * transaction a caller might catch around (fallback chains, Codex E1
   * review, finding 4): a plain reentrant transact() only propagates the
   * throw, so an outer catch could commit a half-done body (a cursor moved
   * without its transition). A savepoint releases on success and rolls
   * back to itself on any throw, so the body is all-or-nothing regardless
   * of the enclosing transaction. Reentrancy is handled by unique names.
   */
  private savepointCounter = 0;
  savepoint<T>(body: () => T): T {
    const name = `sp_${this.savepointCounter++}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = body();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  /** Whether `to` is reachable from `from` by following what it waits on. */
  private reaches(from: string, to: string): boolean {
    const row = this.db
      .prepare(
        `WITH RECURSIVE waits(id) AS (
           SELECT ?
           UNION
           SELECT task_edge.blocker FROM task_edge JOIN waits ON task_edge.blocked = waits.id
         )
         SELECT 1 AS hit FROM waits WHERE id = ? LIMIT 1`,
      )
      .get(from, to);
    return row !== undefined;
  }

  /**
   * The ready set: queued, every blocker finished, no active hold, and not
   * already claimed by somebody else.
   *
   * A hold whose `until` has passed is not a hold. Reading it as one would
   * strand work at exactly the moment it was supposed to resume.
   */
  listReady(now: Date, forRunner?: string): TaskRef[] {
    const stamp = now.toISOString();
    // With a runner named, this is the DISPATCH view (queue-columns v2):
    // tasks reserved for others are absent, and the runner's own reserved
    // work comes before the shared queue. Without one it is the report.
    const reservation =
      forRunner === undefined
        ? ""
        : " AND (task_ref.assigned_runner IS NULL OR task_ref.assigned_runner = ?) ";
    const order =
      forRunner === undefined
        ? "ORDER BY task.priority DESC, task.created_at, task_ref.id"
        : "ORDER BY (task_ref.assigned_runner IS NULL) ASC, task.priority DESC, task.created_at, task_ref.id";
    const rows = this.db
      .prepare(
        `SELECT task_ref.* FROM task
         JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
         WHERE task.state = 'queued'
           ${reservation}
           AND NOT EXISTS (
             SELECT 1 FROM hold
             WHERE hold.task_ref = task_ref.id
               AND (hold.until IS NULL OR hold.until > ?)
           )
           -- Only the newest lease can be holding the task. The claim log is
           -- append-only, so asking "does any unreleased row exist" would let
           -- a long-superseded lease keep work off the ready set forever.
           AND NOT EXISTS (
             SELECT 1 FROM claim
             WHERE claim.task_ref = task_ref.id
               AND claim.released_at IS NULL
               AND claim.expires_at > ?
               AND claim.lease_generation = (
                 SELECT MAX(newest.lease_generation) FROM claim AS newest
                 WHERE newest.task_ref = task_ref.id
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_edge
             JOIN task AS blocker ON blocker.id = task_edge.blocker
             WHERE task_edge.blocked = task.id AND blocker.state <> 'done'
           )
           -- External mirrors ride only while cheap eligibility holds; the
           -- admission transaction is the law, this is the courtesy filter
           -- (dispatch v3, finding 20 — the stale-scan reports the rest).
           AND NOT EXISTS (
             SELECT 1 FROM external_mirror
             WHERE external_mirror.local_task_id = task.id
               AND (external_mirror.remote_state <> 'open' OR external_mirror.dispatch_ok = 0)
           )
         ${order}`,
      )
      .all(...(forRunner === undefined ? [BUILT_IN, stamp, stamp] : [BUILT_IN, forRunner, stamp, stamp]));

    return rows.map(readTaskRef);
  }

  // ---- the overlay --------------------------------------------------------

  /**
   * Get or create the reference.
   *
   * Creating one grants nothing on its own, and defaults to `theirs`: merely
   * referring to a task — which happens whenever anything is looked up — must
   * never be what makes it ours to write.
   */
  refFor(backend: string, externalId: string, origin: TaskOrigin = "theirs"): TaskRef {
    const existing = this.db
      .prepare("SELECT * FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(backend, externalId);
    if (existing !== undefined) {
      // Ownership only ever widens by an explicit act, never by being looked
      // up again with a more generous argument.
      if (origin === "ours" && String(existing["origin"]) !== "ours") {
        this.db.prepare("UPDATE task_ref SET origin = 'ours' WHERE id = ?").run(existing["id"]);
        return readTaskRef({ ...existing, origin: "ours" });
      }
      return readTaskRef(existing);
    }

    this.db
      .prepare("INSERT INTO task_ref (backend, external_id, origin) VALUES (?, ?, ?)")
      .run(backend, externalId, origin);
    const created = this.db
      .prepare("SELECT * FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(backend, externalId);
    return readTaskRef(created as Record<string, unknown>);
  }

  /** The reference if it exists — a read that never creates, for surfaces that only look. */
  lookupRef(taskId: string): TaskRef | null {
    const row = this.db
      .prepare("SELECT * FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(BUILT_IN, taskId);
    return row === undefined ? null : readTaskRef(row);
  }

  /** Whether this task is one we created, as recorded — not as asserted. */
  originOf(backend: string, externalId: string): TaskOrigin {
    const row = this.db
      .prepare("SELECT origin FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(backend, externalId);
    return row !== undefined && String(row["origin"]) === "ours" ? "ours" : "theirs";
  }

  /**
   * The operator's hold — the CLI's pause button. One per task, replaced on
   * repeat. Decision and incident holds go through `holdOwned`, and lifting
   * this one never touches theirs.
   */
  hold(taskRef: number, reason: string, until: Date | null, now: Date, mutation: Mutation = {}): void {
    this.once(mutation, "hold", () => {
      this.holdOwned(
        { taskRef, ownerKind: "operator", ownerId: String(taskRef), reason, until },
        now,
      );
      return null;
    });
  }

  /** Place a hold on behalf of its owner. One hold per owner, replaced on repeat. */
  holdOwned(
    hold: {
      taskRef: number;
      ownerKind: HoldOwner;
      ownerId: string;
      reason: string;
      until: Date | null;
    },
    now: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO hold (task_ref, owner_kind, owner_id, reason, until, held_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_kind, owner_id) DO UPDATE SET task_ref = excluded.task_ref,
                                                          reason = excluded.reason,
                                                          until = excluded.until,
                                                          held_at = excluded.held_at`,
      )
      .run(
        hold.taskRef,
        hold.ownerKind,
        hold.ownerId,
        hold.reason,
        hold.until === null ? null : hold.until.toISOString(),
        now.toISOString(),
      );
  }

  /**
   * The CLI's unhold lifts only the operator's own hold. A task still held by
   * an open decision stays held — the way out of that hold is answering it.
   */
  unhold(taskRef: number, mutation: Mutation = {}): boolean {
    return this.once(
      mutation,
      "unhold",
      () => {
        const { changes } = this.db
          .prepare("DELETE FROM hold WHERE task_ref = ? AND owner_kind = 'operator'")
          .run(taskRef);
        if (Number(changes) > 0) this.bumpWake();
        return Number(changes) > 0;
      },
      lifted => lifted,
    );
  }

  /** Lift exactly one owner's hold, whoever else may still be holding. */
  releaseOwnedHold(ownerKind: HoldOwner, ownerId: string): boolean {
    const { changes } = this.db
      .prepare("DELETE FROM hold WHERE owner_kind = ? AND owner_id = ?")
      .run(ownerKind, ownerId);
    return Number(changes) > 0;
  }

  /** The hold in force right now, if any. An elapsed `until` is not one. */
  activeHold(taskRef: number, now: Date): Hold | null {
    const [first = null] = this.activeHolds(taskRef, now);
    return first;
  }

  /** Every hold in force — a task can be held by more than one owner at once. */
  activeHolds(taskRef: number, now: Date): Hold[] {
    return this.db
      .prepare(
        `SELECT * FROM hold WHERE task_ref = ? AND (until IS NULL OR until > ?)
         ORDER BY held_at, id`,
      )
      .all(taskRef, now.toISOString())
      .map(readHold);
  }

  // ---- grants -------------------------------------------------------------

  /**
   * Enrolling twice replaces rather than accumulates. Two grants over one
   * backend would mean the effective permission is whichever row a query
   * happened to reach first, and a permission you cannot read off the page is
   * not a permission anyone can reason about.
   */
  saveGrant(grant: BackendGrant, mutation: Mutation = {}): void {
    // The cross-column dispatch rule lives HERE because ALTER ADD COLUMN
    // cannot carry cross-column CHECKs: dispatch demands its exact remote
    // repository and a plane identity, or it is not a dispatch grant.
    if (grant.dispatch === true && (grant.remoteRepo == null || grant.planeId == null)) {
      throw new Error("a dispatch grant names exactly one remote repository and carries a plane id");
    }
    this.once(mutation, "saveGrant", () => {
      this.db
        .prepare(
          `INSERT INTO backend_grant
             (repo, backend, paths, mutations, selector, credential_scope, observed_by_git, granted_at, granted_by,
              dispatch, remote_repo, plane_id, dispatch_blocked, dispatch_blocked_at, dispatch_blocked_detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, backend) DO UPDATE SET
             paths = excluded.paths, mutations = excluded.mutations,
             selector = excluded.selector, credential_scope = excluded.credential_scope,
             observed_by_git = excluded.observed_by_git,
             granted_at = excluded.granted_at, granted_by = excluded.granted_by,
             dispatch = excluded.dispatch, remote_repo = excluded.remote_repo,
             plane_id = excluded.plane_id, dispatch_blocked = excluded.dispatch_blocked,
             dispatch_blocked_at = excluded.dispatch_blocked_at,
             dispatch_blocked_detail = excluded.dispatch_blocked_detail`,
        )
        .run(
          grant.repo,
          grant.backend,
          JSON.stringify(grant.paths),
          JSON.stringify(grant.mutations),
          grant.selector,
          grant.credentialScope,
          grant.observedByGit ? 1 : 0,
          grant.grantedAt,
          grant.grantedBy,
          grant.dispatch === true ? 1 : 0,
          grant.remoteRepo ?? null,
          grant.planeId ?? null,
          grant.dispatchBlocked ?? null,
          grant.dispatchBlockedAt ?? null,
          grant.dispatchBlockedDetail ?? null,
        );
      return null;
    });
  }

  // ---- external mirrors (v20) ---------------------------------------------

  /**
   * Establish a mirror: the ONE act that makes a local task stand for a
   * tracker item. Identity and provenance are immutable after this row
   * (trigger-enforced); labels and titles may nominate work, only this
   * establishes whose it is. Refuses tasks carrying race terms or an open
   * tournament (D1 — external work does not race in this release).
   */
  establishMirror(
    mirror: {
      localTaskId: string;
      backend: string;
      remoteRepo: string;
      remoteId: string;
      provenance: "local-create" | "intake" | "granted-all";
      intakeGrant?: number | null;
      establishedBy: string;
      syncGeneration?: number;
    },
    now: Date,
  ): { ok: true } | { ok: false; reason: "unknown-task" | "duplicate" | "racing" } {
    return this.transact(() => {
      const ref = this.db
        .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
        .get(BUILT_IN, mirror.localTaskId);
      if (ref === undefined) return { ok: false as const, reason: "unknown-task" as const };
      const racing = this.db
        .prepare(
          `SELECT 1 AS hit FROM contest WHERE task_ref = ?
            AND state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted') LIMIT 1`,
        )
        .get(Number(ref["id"]));
      const terms = this.db
        .prepare("SELECT 1 AS hit FROM tournament_terms WHERE task_ref = ? AND active = 1 LIMIT 1")
        .get(Number(ref["id"]));
      if (racing !== undefined || terms !== undefined) return { ok: false as const, reason: "racing" as const };
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO external_mirror
             (local_task_id, backend, remote_repo, remote_id, provenance, intake_grant,
              established_by, established_at, remote_state, sync_generation, dispatch_ok)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1)`,
        )
        .run(
          mirror.localTaskId,
          mirror.backend,
          mirror.remoteRepo,
          mirror.remoteId,
          mirror.provenance,
          mirror.provenance === "intake" ? (mirror.intakeGrant ?? null) : null,
          mirror.establishedBy,
          now.toISOString(),
          mirror.syncGeneration ?? 0,
        );
      if (Number(inserted.changes) === 0) return { ok: false as const, reason: "duplicate" as const };
      return { ok: true as const };
    });
  }

  mirrorByTask(taskId: string): ExternalMirror | null {
    const row = this.db.prepare("SELECT * FROM external_mirror WHERE local_task_id = ?").get(taskId);
    return row === undefined ? null : readMirror(row);
  }

  mirrorByRemote(backend: string, remoteRepo: string, remoteId: string): ExternalMirror | null {
    const row = this.db
      .prepare("SELECT * FROM external_mirror WHERE backend = ? AND remote_repo = ? AND remote_id = ?")
      .get(backend, remoteRepo, remoteId);
    return row === undefined ? null : readMirror(row);
  }

  externalMirrors(backend: string, remoteRepo: string): ExternalMirror[] {
    return this.db
      .prepare("SELECT * FROM external_mirror WHERE backend = ? AND remote_repo = ? ORDER BY local_task_id")
      .all(backend, remoteRepo)
      .map(readMirror);
  }

  /**
   * The latch (v3 §1): an authoritative closed/missing observation. ONE
   * transaction, and it never touches claims or runs — an idle mirror's
   * task is cancelled here (cancelTask's own matrix: queued/failed/
   * running, never done — done stays done, dependency satisfaction never
   * regresses); an in-flight one is left for the completion gate.
   */
  latchMirror(
    localTaskId: string,
    observed: "closed" | "missing",
    generation: number,
    now: Date,
  ): void {
    this.transact(() => {
      this.db
        .prepare(
          `UPDATE external_mirror
             SET remote_state = ?, dispatch_ok = 0,
                 close_generation = COALESCE(close_generation, ?), sync_generation = ?
           WHERE local_task_id = ?`,
        )
        .run(observed, generation, generation, localTaskId);
      const ref = this.db
        .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
        .get(BUILT_IN, localTaskId);
      if (ref === undefined) return;
      const live = this.currentLiveLease(Number(ref["id"]), now) !== null;
      const contested = this.db
        .prepare(
          `SELECT 1 AS hit FROM contest WHERE task_ref = ?
            AND state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted') LIMIT 1`,
        )
        .get(Number(ref["id"]));
      if (!live && contested === undefined) {
        this.applyCancellation(
          localTaskId,
          { kind: "machine", code: "mirror-latched" },
          now,
          ["queued", "failed", "running"],
        );
      }
      this.bumpWake();
    });
  }

  /** A fresh authoritative OPEN observation — recorded as reality; the
   * latch (dispatch_ok) clears only through the reopen act. */
  observeMirrorOpen(localTaskId: string, generation: number): void {
    this.db
      .prepare("UPDATE external_mirror SET remote_state = 'open', sync_generation = ? WHERE local_task_id = ?")
      .run(generation, localTaskId);
  }

  /**
   * The reopen act (v3 §7 + findings 18/30): an authenticated CAS that
   * requires the tracker to have been SEEN open again after the close,
   * and the task to be clean — no live claim, no open tournament, no
   * active hold, no open question, no unresolved incident. It reconciles
   * task state from any admitted state back to queued; the approved
   * scope is preserved (its digest never changed) — this act is the
   * operator's decision to resume.
   */
  reopenMirror(
    localTaskId: string,
    by: string,
    now: Date,
  ): { ok: true } | { ok: false; reason: "unknown-task" | "not-latched" | "not-seen-open" | "claimed" | "contest-open" | "held" | "question-open" | "incident-open" | "bad-state" } {
    return this.transact(() => {
      const mirror = this.mirrorByTask(localTaskId);
      if (mirror === null) return { ok: false as const, reason: "unknown-task" as const };
      if (mirror.dispatchOk && mirror.closeGeneration === null) return { ok: false as const, reason: "not-latched" as const };
      if (mirror.remoteState !== "open" || mirror.closeGeneration === null || mirror.syncGeneration <= mirror.closeGeneration) {
        return { ok: false as const, reason: "not-seen-open" as const };
      }
      const ref = this.db
        .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
        .get(BUILT_IN, localTaskId);
      if (ref === undefined) return { ok: false as const, reason: "unknown-task" as const };
      const taskRef = Number(ref["id"]);
      if (this.currentLiveLease(taskRef, now) !== null) return { ok: false as const, reason: "claimed" as const };
      const contested = this.db
        .prepare(
          `SELECT 1 AS hit FROM contest WHERE task_ref = ?
            AND state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted') LIMIT 1`,
        )
        .get(taskRef);
      if (contested !== undefined) return { ok: false as const, reason: "contest-open" as const };
      if (this.activeHolds(taskRef, now).length > 0) return { ok: false as const, reason: "held" as const };
      const question = this.db
        .prepare(
          `SELECT 1 AS hit FROM decision JOIN run ON run.id = decision.run
            WHERE run.task_ref = ? AND decision.answered_at IS NULL LIMIT 1`,
        )
        .get(taskRef);
      if (question !== undefined) return { ok: false as const, reason: "question-open" as const };
      const incident = this.db
        .prepare(
          `SELECT 1 AS hit FROM incident JOIN run ON run.id = incident.run
            WHERE run.task_ref = ? AND incident.resolved_at IS NULL LIMIT 1`,
        )
        .get(taskRef);
      if (incident !== undefined) return { ok: false as const, reason: "incident-open" as const };
      const task = this.db.prepare("SELECT state FROM task WHERE id = ?").get(localTaskId);
      if (task === undefined || !["cancelled", "failed", "queued"].includes(String(task["state"]))) {
        return { ok: false as const, reason: "bad-state" as const };
      }
      this.db
        .prepare(
          `UPDATE external_mirror SET dispatch_ok = 1, close_generation = NULL, reopened_by = ?, reopened_at = ?
            WHERE local_task_id = ?`,
        )
        .run(by, now.toISOString(), localTaskId);
      this.db
        .prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ?")
        .run(now.toISOString(), localTaskId);
      this.bumpWake();
      return { ok: true as const };
    });
  }

  /** The last COMPLETE sync pass for a tracker, or null — freshness's anchor. */
  lastCompleteSync(backend: string, remoteRepo: string): { generation: number; finishedAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT generation, finished_at FROM sync_ledger
          WHERE backend = ? AND remote_repo = ? AND outcome = 'complete'
          ORDER BY generation DESC LIMIT 1`,
      )
      .get(backend, remoteRepo);
    return row === undefined || row["finished_at"] === null
      ? null
      : { generation: Number(row["generation"]), finishedAt: String(row["finished_at"]) };
  }

  openSyncPass(backend: string, remoteRepo: string, now: Date): { id: number; generation: number } {
    return this.transact(() => {
      const last = this.db
        .prepare("SELECT MAX(generation) AS top FROM sync_ledger WHERE backend = ? AND remote_repo = ?")
        .get(backend, remoteRepo);
      const generation = (last === undefined || last["top"] === null ? 0 : Number(last["top"])) + 1;
      this.db
        .prepare(
          "INSERT INTO sync_ledger (backend, remote_repo, generation, started_at) VALUES (?, ?, ?, ?)",
        )
        .run(backend, remoteRepo, generation, now.toISOString());
      const row = this.db.prepare("SELECT last_insert_rowid() AS id").get();
      return { id: Number(row?.["id"]), generation };
    });
  }

  /**
   * Close a pass. ONLY `complete` advances the surviving mirrors'
   * generations — atomically with the ledger transition, so freshness can
   * never outrun the observation that earned it (v3 §6). A capped or
   * failed pass proves nothing about absence and advances nothing.
   */
  closeSyncPass(
    id: number,
    outcome: "complete" | "capped" | "failed",
    counts: { candidates: number; mirrored: number },
    now: Date,
    detail: string | null = null,
  ): void {
    this.transact(() => {
      this.db
        .prepare(
          "UPDATE sync_ledger SET finished_at = ?, outcome = ?, candidates = ?, mirrored = ?, detail = ? WHERE id = ?",
        )
        .run(now.toISOString(), outcome, counts.candidates, counts.mirrored, detail, id);
      if (outcome === "complete") {
        const pass = this.db.prepare("SELECT backend, remote_repo, generation FROM sync_ledger WHERE id = ?").get(id);
        if (pass !== undefined) {
          this.db
            .prepare(
              "UPDATE external_mirror SET sync_generation = ? WHERE backend = ? AND remote_repo = ? AND sync_generation < ?",
            )
            .run(Number(pass["generation"]), String(pass["backend"]), String(pass["remote_repo"]), Number(pass["generation"]));
        }
      }
    });
  }

  /**
   * The admission gate's fact (v3 §2 / v4 §26): why this mirror may not
   * dispatch right now, or null for "go" — and "not-a-mirror" costs one
   * indexed lookup for every ordinary task. The FULL live grant tuple is
   * re-proved here: revocation, narrowing, and marker blocks take effect
   * at the very next admission.
   */
  mirrorAdmissionRefusal(
    taskRef: number,
    now: Date,
    maxAgeMs: number,
  ): "stale-mirror" | "external-closed" | "dispatch-revoked" | "plane-blocked" | null | "not-a-mirror" {
    const ref = this.db.prepare("SELECT external_id, repo FROM task_ref WHERE id = ?").get(taskRef);
    if (ref === undefined) return "not-a-mirror";
    const mirror = this.mirrorByTask(String(ref["external_id"]));
    if (mirror === null) return "not-a-mirror";
    if (mirror.remoteState !== "open" || !mirror.dispatchOk) return "external-closed";
    const repo = ref["repo"] === null ? null : String(ref["repo"]);
    const grant = repo === null ? null : this.grantFor(repo, mirror.backend);
    if (grant === null || grant.dispatch !== true || grant.remoteRepo !== mirror.remoteRepo) return "dispatch-revoked";
    if (grant.selector === "ours" && mirror.provenance === "granted-all") return "dispatch-revoked";
    if (grant.dispatchBlocked != null) return "plane-blocked";
    const anchor = this.lastCompleteSync(mirror.backend, mirror.remoteRepo);
    if (
      anchor === null ||
      mirror.syncGeneration < anchor.generation ||
      now.getTime() - new Date(anchor.finishedAt).getTime() > maxAgeMs
    ) {
      return "stale-mirror";
    }
    return null;
  }

  /**
   * The stale-scan's rows (dispatch v3, finding 20): every mirror in this
   * repo that admission would refuse right now, with its typed reason —
   * so a skipped mirror is REPORTED, never silently absent from ready.
   */
  ineligibleMirrors(
    repo: string | null,
    now: Date,
    maxAgeMs: number,
  ): { taskId: string; why: "stale-mirror" | "external-closed" | "dispatch-revoked" | "plane-blocked" }[] {
    const rows = this.db
      .prepare(
        `SELECT external_mirror.local_task_id AS id, task_ref.id AS ref FROM external_mirror
           JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = external_mirror.local_task_id
           JOIN task ON task.id = external_mirror.local_task_id
          WHERE task.state = 'queued' AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
          LIMIT 100`,
      )
      .all(BUILT_IN, repo, repo);
    const skipped: { taskId: string; why: "stale-mirror" | "external-closed" | "dispatch-revoked" | "plane-blocked" }[] = [];
    for (const row of rows) {
      const why = this.mirrorAdmissionRefusal(Number(row["ref"]), now, maxAgeMs);
      if (why !== null && why !== "not-a-mirror") skipped.push({ taskId: String(row["id"]), why });
    }
    return skipped;
  }

  /** Whether a fresh completion may stand as done (v4 §24) — read INSIDE
   * completeFenced's transaction. Non-mirrors always complete. */
  mirrorAllowsCompletion(taskId: string): boolean {
    const row = this.db
      .prepare("SELECT remote_state, dispatch_ok FROM external_mirror WHERE local_task_id = ?")
      .get(taskId);
    if (row === undefined) return true;
    return String(row["remote_state"]) === "open" && Number(row["dispatch_ok"]) === 1;
  }

  /** Whether a stored acquire mutation exists — the replay marker's fact. */
  hasMutationRecord(mutation: Mutation): boolean {
    if (mutation.idempotencyKey === undefined) return false;
    const row = this.db
      .prepare("SELECT 1 AS hit FROM mutation WHERE idempotency_key = ? LIMIT 1")
      .get(mutation.idempotencyKey);
    return row !== undefined;
  }

  enqueueExternalIntent(
    mirror: string,
    kind: "comment" | "transition" | "close",
    body: string | null,
    now: Date,
  ): void {
    this.db
      .prepare("INSERT INTO external_intent (mirror, kind, body, created_at) VALUES (?, ?, ?, ?)")
      .run(mirror, kind, body, now.toISOString());
  }

  pendingExternalIntents(limit = 50): { id: number; mirror: string; kind: "comment" | "transition" | "close"; body: string | null; attempts: number }[] {
    return this.db
      .prepare("SELECT id, mirror, kind, body, attempts FROM external_intent WHERE state = 'pending' ORDER BY id LIMIT ?")
      .all(Math.max(1, Math.min(limit, 200)))
      .map(row => ({
        id: Number(row["id"]),
        mirror: String(row["mirror"]),
        kind: String(row["kind"]) as "comment" | "transition" | "close",
        body: row["body"] === null ? null : String(row["body"]),
        attempts: Number(row["attempts"]),
      }));
  }

  settleExternalIntent(id: number, state: "delivered" | "refused", now: Date, error: string | null = null): void {
    this.db
      .prepare(
        `UPDATE external_intent SET state = ?, attempts = attempts + 1, last_error = ?,
           delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
         WHERE id = ?`,
      )
      .run(state, error, state, now.toISOString(), id);
  }

  /** Marker verification writes its verdict here — fail closed, typed. */
  setDispatchBlocked(
    repo: string,
    backend: string,
    blocked: "pending-marker" | "unreachable" | "foreign" | "missing" | "multiple-or-malformed" | null,
    now: Date,
    detail: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE backend_grant SET dispatch_blocked = ?, dispatch_blocked_at = ?, dispatch_blocked_detail = ?
          WHERE repo = ? AND backend = ?`,
      )
      .run(blocked, blocked === null ? null : now.toISOString(), detail, repo, backend);
  }

  /** null is denial, and is the answer for anything never enrolled. */
  grantFor(repo: string, backend: string): BackendGrant | null {
    const row = this.db
      .prepare("SELECT * FROM backend_grant WHERE repo = ? AND backend = ?")
      .get(repo, backend);
    return row === undefined ? null : readGrant(row);
  }

  listGrants(): BackendGrant[] {
    return this.db
      .prepare("SELECT * FROM backend_grant ORDER BY repo, backend")
      .all()
      .map(readGrant);
  }

  revokeGrant(repo: string, backend: string, mutation: Mutation = {}): boolean {
    return this.once(
      mutation,
      "revokeGrant",
      () => {
        const { changes } = this.db
          .prepare("DELETE FROM backend_grant WHERE repo = ? AND backend = ?")
          .run(repo, backend);
        return Number(changes) > 0;
      },
      revoked => revoked,
    );
  }

  // ---- scope --------------------------------------------------------------

  saveScope(scope: Scope, mutation: Mutation = {}, options: { profile?: ExecutionProfile; posture?: "escalated" } = {}): void {
    this.once(mutation, "saveScope", () => {
      // THE filing invariant (foundations findings 5/13/19): every scope
      // row leaves this method either RESOLVED (working profile stamped,
      // digest recomputed to bind it, version 2) or UNRESOLVED with its
      // reason in words — saved atomically either way, because refusing
      // after the caller already validated everything else would strand
      // planner and revision output (finding 19). An explicit options
      // profile wins (routine firings stamp the routine's APPROVED
      // profile; demo stamps its illustrative one); otherwise resolution
      // runs pin > project > installation > default with the exact-model
      // rule.
      let profile: ExecutionProfile | null = options.profile ?? null;
      let unresolvedReason: string | null = null;
      let provenance: string | null = options.profile === undefined ? null : JSON.stringify({ resolvedFrom: "explicit" });
      if (profile === null) {
        const ref = this.lookupRef(scope.taskId);
        const resolved = resolveScopeProfile(
          this,
          ref?.repo ?? null,
          ref === null ? undefined : { agentProvider: ref.agentProvider, agentModel: ref.agentModel },
          {},
        );
        if (resolved.ok) {
          profile = resolved.profile;
          provenance = JSON.stringify(resolved.provenance);
        } else {
          unresolvedReason = resolved.problem;
        }
      }
      // The C7 escalation matrix, applied where the profile is sealed:
      // claude bypassPermissions / gemini yolo; codex-shaped lanes have
      // one posture and escalation changes nothing for them.
      if (options.posture === "escalated" && profile !== null) {
        profile =
          profile.provider === "claude"
            ? { ...profile, permissionArgv: "bypassPermissions" }
            : profile.provider === "gemini"
              ? { ...profile, approvalArgv: "yolo" }
              : profile;
      }
      const digest = profile === null
        ? scope.digest
        : digestOf(
            { goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, budgetMicrousd: scope.budgetMicrousd },
            profile,
          );
      // The fallback-chain binding (v30): when the scope resolved FROM CONFIG
      // (not an explicit routine/demo profile) and the repo has configured
      // fallbacks, the scope files as a CHAIN — the digest binds the whole
      // ordered chain, and the WORKING snapshot is stored so the seal copies
      // it verbatim (never re-resolves), exactly as approved_profile_json
      // mirrors profile_json. Inert until an operator configures fallbacks:
      // with none — every repo today — proposedChainJson stays NULL and the
      // digest is the byte-identical single-profile binding. A malformed or
      // duplicate chain config does NOT corrupt the scope: it files honestly
      // as the single profile, and the config error surfaces at the config
      // surface, never here.
      let proposedChainJson: string | null = null;
      let boundDigest = digest;
      if (options.profile === undefined && profile !== null) {
        const chainRef = this.lookupRef(scope.taskId);
        const chainRepo = chainRef?.repo ?? null;
        if (chainRepo !== null && this.fallbackConfig(chainRepo).length > 0) {
          const chain = resolveScopeChain(
            this,
            chainRepo,
            chainRef === null ? undefined : { agentProvider: chainRef.agentProvider, agentModel: chainRef.agentModel },
            {},
            readAuthMode(profile.provider),
          );
          if (chain.ok && chain.kind === "chain") {
            proposedChainJson = canonicalChainJson(chain.chain);
            boundDigest = digestOf(
              { goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, budgetMicrousd: scope.budgetMicrousd },
              { chain: chain.chain },
            );
          } else if (!chain.ok) {
            // The operator CONFIGURED fallbacks that cannot file (F+G
            // review, finding 4): silently filing single-profile would
            // approve something other than what they believe they set. The
            // scope goes VISIBLY unresolved — dispatch and approval both
            // blocked, the reason in words — until the config or the base
            // routing is fixed.
            profile = null;
            unresolvedReason = `the configured fallback chain cannot file: ${chain.problem} — fix \`config set fallback\` for this repository, or clear it`;
            boundDigest = scope.digest;
          }
        }
      }
      this.db
        .prepare(
          `INSERT INTO task_scope
             (task_id, goal, out_of_scope, touches, budget_microusd, proposed_at, digest, approved_at, approved_by, approved_digest,
              profile_json, profile_state, unresolved_reason, digest_version, profile_provenance, proposed_chain_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (task_id) DO UPDATE SET
             goal = excluded.goal, out_of_scope = excluded.out_of_scope,
             touches = excluded.touches, budget_microusd = excluded.budget_microusd,
             proposed_at = excluded.proposed_at,
             digest = excluded.digest, approved_at = excluded.approved_at,
             approved_by = excluded.approved_by, approved_digest = excluded.approved_digest,
             profile_json = excluded.profile_json, profile_state = excluded.profile_state,
             unresolved_reason = excluded.unresolved_reason, digest_version = excluded.digest_version,
             profile_provenance = excluded.profile_provenance, proposed_chain_json = excluded.proposed_chain_json`,
        )
        .run(
          scope.taskId,
          scope.goal,
          scope.outOfScope,
          JSON.stringify(scope.touches),
          scope.budgetMicrousd ?? null,
          scope.proposedAt,
          boundDigest,
          scope.approvedAt,
          scope.approvedBy,
          scope.approvedDigest,
          profile === null ? null : canonicalProfileJson(profile),
          profile === null ? "unresolved" : "resolved",
          unresolvedReason,
          profile === null ? 1 : 2,
          provenance,
          proposedChainJson,
        );
      return null;
    });
  }

  /** The approval SEAL (foundations finding 4/17): stamps the approval
   * fields and snapshots the CURRENT working profile as the immutable
   * approved profile — one UPDATE, no re-resolution, so what is sealed is
   * exactly what the signed digest was bound to. Returns false when the
   * scope vanished mid-ceremony. */
  sealScopeApproval(taskId: string, by: string, now: Date, mutation: Mutation = {}, basis?: { kind: "mode"; modeDigest: string }): boolean {
    return (
      this.once(mutation, "sealScopeApproval", () => {
        const changed = this.db
          .prepare(
            `UPDATE task_scope
                SET approved_at = ?, approved_by = ?, approved_digest = digest,
                    approved_profile_json = profile_json,
                    approval_basis = ?, mode_digest = ?,
                    -- The chain snapshot seals exactly as the profile does:
                    -- COPY the working proposed_chain_json into the immutable
                    -- approved_chain_json, and set approval_kind from whether
                    -- one exists. Because saveScope bound the signed digest to
                    -- that same proposed chain, what is sealed is byte-for-byte
                    -- what the approver agreed to — never re-resolved. A
                    -- rewritten-then-reapproved scope re-seals from its CURRENT
                    -- working snapshot, so a stale chain can never survive.
                    approved_chain_json = proposed_chain_json,
                    approval_kind = CASE WHEN proposed_chain_json IS NOT NULL THEN 'chain' ELSE 'profile' END
              WHERE task_id = ?`,
          )
          .run(now.toISOString(), by, basis === undefined ? "password" : basis.kind, basis === undefined ? null : basis.modeDigest, taskId);
        return changed.changes > 0;
      }) === true
    );
  }

  getScope(taskId: string): Scope | null {
    const row = this.db.prepare("SELECT * FROM task_scope WHERE task_id = ?").get(taskId);
    return row === undefined ? null : readScope(row);
  }

  /**
   * The mode-approval belt, as ONE question every consumer asks the same
   * way (Codex people round 2, finding 2): false exactly when this task's
   * approval was sealed by a mode signature that no longer stands — the
   * signed row live by CLOCK (durable closure not required), the digest
   * exact, the signer an active approver. Password-sealed and unapproved
   * scopes answer true: this belt only ever REMOVES mode authority.
   */
  modeApprovalLive(taskRef: number, now: Date): boolean {
    const dead = this.db
      .prepare(
        `SELECT 1 AS dead FROM task_scope
          JOIN task_ref ON task_ref.id = ? AND task_ref.backend = 'built-in' AND task_scope.task_id = task_ref.external_id
         WHERE task_scope.approval_basis = 'mode' AND task_scope.approved_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM operating_mode om
                            JOIN approver signer ON signer.name = om.signed_by
                           WHERE om.repo = task_ref.repo AND om.revoked_at IS NULL
                             AND om.absolute_expiry > ? AND om.digest = task_scope.mode_digest
                             AND signer.revoked_at IS NULL AND signer.role = 'approver')`,
      )
      .get(taskRef, now.toISOString());
    return dead === undefined;
  }

  // ---- approvers ----------------------------------------------------------

  saveApprover(name: string, credentialHash: string, now: Date, mutation: Mutation = {}): void {
    this.once(mutation, "saveApprover", () => {
      // Replacing a credential is a rotation: the generation moves, and
      // everything that derived authority from the old one — a paired chat,
      // an outstanding pairing code — is stranded by the comparison, then
      // swept by revokeDerivedAuthority in the same transaction.
      this.transact(() => {
        this.db
          .prepare(
            `INSERT INTO approver (name, credential_hash, added_at, generation) VALUES (?, ?, ?, 1)
             ON CONFLICT (name) DO UPDATE SET credential_hash = excluded.credential_hash,
                                              added_at = excluded.added_at,
                                              generation = approver.generation + 1`,
          )
          .run(name, credentialHash, now.toISOString());
        this.revokeDerivedAuthority(name, "credential-rotation", now);
      });
      return null;
    });
  }

  /** The full account row for identity checks (v29): hash, role,
   * generation, revocation — one read, no inference. */
  accountOf(name: string): { credentialHash: string; role: "approver" | "viewer"; generation: number; revokedAt: string | null } | null {
    const row = this.db
      .prepare("SELECT credential_hash, role, generation, revoked_at FROM approver WHERE name = ?")
      .get(name);
    if (row === undefined) return null;
    return {
      credentialHash: String(row["credential_hash"]),
      role: String(row["role"]) === "viewer" ? "viewer" : "approver",
      generation: Number(row["generation"]),
      revokedAt: row["revoked_at"] === null || row["revoked_at"] === undefined ? null : String(row["revoked_at"]),
    };
  }

  // ---- operating modes (v29, the modes chain) ---------------------------

  /** The live mode for a repo: unrevoked, unexpired, its SIGNER still an
   * active approver (D7's belt — a missed cascade cannot leave a dead
   * signer's authority alive). Expired-but-unrevoked rows are closed here,
   * durably, so the partial unique can never wedge a replacement. */
  activeMode(repo: string, now: Date): { id: number; name: string; termsJson: string; digest: string; signedBy: string; absoluteExpiry: string } | null {
    const row = this.db
      .prepare(
        `SELECT operating_mode.* FROM operating_mode
          JOIN approver ON approver.name = operating_mode.signed_by AND approver.revoked_at IS NULL AND approver.role = 'approver'
         WHERE operating_mode.repo = ? AND operating_mode.revoked_at IS NULL`,
      )
      .get(repo);
    if (row === undefined) return null;
    if (Date.parse(String(row["absolute_expiry"])) <= now.getTime()) {
      this.transact(() => {
        this.db
          .prepare("UPDATE operating_mode SET revoked_at = ?, revoked_by = ?, revoke_reason = 'expired' WHERE id = ? AND revoked_at IS NULL")
          .run(now.toISOString(), "the-clock", Number(row["id"]));
        this.db
          .prepare("INSERT INTO operating_mode_event (mode, kind, actor, at) VALUES (?, 'expired-closed', 'the-clock', ?)")
          .run(Number(row["id"]), now.toISOString());
        this.reconcileIntentsForMode(String(row["repo"]), null, now);
      });
      return null;
    }
    return {
      id: Number(row["id"]),
      name: String(row["name"]),
      termsJson: String(row["terms_json"]),
      digest: String(row["digest"]),
      signedBy: String(row["signed_by"]),
      absoluteExpiry: String(row["absolute_expiry"]),
    };
  }

  /** Sign (or renew) a mode: closes any predecessor with a typed event and
   * ATOMICALLY reconciles the repo's nonterminal merge intents to the new
   * posture (F2). The caller has already run the password ceremony. */
  signMode(
    spec: { repo: string; name: string; termsJson: string; digest: string; signedBy: string; absoluteExpiry: string; publication: "notify" | "automerge" },
    now: Date,
  ): number {
    return this.transact(() => {
      // The automerge prerequisite, proved INSIDE the signature (Codex
      // surfaces round 1, finding 4): a grant revoked between the screen
      // and the signature must lose — the pre-checks only shape the words.
      if (spec.publication === "automerge" && !this.hasMergeCapableGrant(spec.repo, now)) {
        throw new Error("automerge needs a merge-capable publication grant — grant one, then sign");
      }
      const previous = this.db
        .prepare("SELECT id FROM operating_mode WHERE repo = ? AND revoked_at IS NULL")
        .get(spec.repo);
      const renewal = previous !== undefined;
      if (renewal) {
        this.db
          .prepare("UPDATE operating_mode SET revoked_at = ?, revoked_by = ?, revoke_reason = 'renewed' WHERE id = ?")
          .run(now.toISOString(), spec.signedBy, Number(previous["id"]));
      }
      const inserted = this.db
        .prepare(
          `INSERT INTO operating_mode (repo, name, terms_json, digest, signed_by, signed_at, absolute_expiry)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(spec.repo, spec.name, spec.termsJson, spec.digest, spec.signedBy, now.toISOString(), spec.absoluteExpiry);
      const id = Number(inserted.lastInsertRowid);
      this.db
        .prepare("INSERT INTO operating_mode_event (mode, kind, actor, at) VALUES (?, ?, ?, ?)")
        .run(id, renewal ? "renewed" : "signed", spec.signedBy, now.toISOString());
      this.reconcileIntentsForMode(spec.repo, { digest: spec.digest, publication: spec.publication }, now);
      return id;
    });
  }

  /** One click for any approver (v4 doctrine): lowering authority needs no
   * ceremony. Reconciliation drops mode-basis intents to waiting-human;
   * `firing` rows are untouched — an issued call is one-shot (E1). */
  revokeMode(repo: string, by: string, reason: string, now: Date): boolean {
    return this.transact(() => {
      const row = this.db
        .prepare("SELECT id FROM operating_mode WHERE repo = ? AND revoked_at IS NULL")
        .get(repo);
      if (row === undefined) return false;
      this.db
        .prepare("UPDATE operating_mode SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?")
        .run(now.toISOString(), by, reason, Number(row["id"]));
      this.db
        .prepare("INSERT INTO operating_mode_event (mode, kind, actor, at) VALUES (?, 'revoked', ?, ?)")
        .run(Number(row["id"]), by, now.toISOString());
      this.reconcileIntentsForMode(repo, null, now);
      return true;
    });
  }

  /** F2/R-REVOKE: the ONE reconciliation road. newMode null = no live
   * automerge authority (revocation, expiry, or a notify posture):
   * mode-basis pending/claimed intents drop to waiting-human, leases
   * cleared, generations bumped. newMode with automerge: nonterminal
   * grant/mode intents REBIND to the new digest and return to pending.
   * `firing` is never touched by either arm. */
  private reconcileIntentsForMode(repo: string, newMode: { digest: string; publication: "notify" | "automerge" } | null, now: Date): void {
    void now;
    // MODE-DERIVED SCOPE APPROVALS demote here too (Codex people round 1,
    // finding 2 — R-REVOKE's "next gate" made durable): an approval sealed
    // under a mode signature that no longer stands falls back to the human
    // ceremony. Only UNDISPATCHED work demotes — the task still queued with
    // no live claim; running and finished work keeps its history untouched.
    this.db
      .prepare(
        `UPDATE task_scope
            SET approved_at = NULL, approved_by = NULL, approved_digest = NULL,
                approved_profile_json = NULL, approval_basis = 'password', mode_digest = NULL
          WHERE approval_basis = 'mode' AND approved_at IS NOT NULL
            AND (? IS NULL OR mode_digest <> ?)
            AND EXISTS (SELECT 1 FROM task_ref JOIN task ON task.id = task_ref.external_id
                         WHERE task_ref.backend = 'built-in'
                           AND task_ref.external_id = task_scope.task_id AND task_ref.repo = ?
                           AND task.state = 'queued')
            AND NOT EXISTS (SELECT 1 FROM claim JOIN task_ref tr ON tr.id = claim.task_ref
                             WHERE tr.backend = 'built-in'
                               AND tr.external_id = task_scope.task_id AND tr.repo = ?
                               AND claim.released_at IS NULL AND claim.expires_at > ?)`,
      )
      .run(
        newMode === null ? null : newMode.digest,
        newMode === null ? null : newMode.digest,
        repo,
        repo,
        now.toISOString(),
      );
    const repoIntents = `publication IN (
                SELECT publication.id FROM publication
                  JOIN run ON run.id = publication.run
                  JOIN task_ref ON task_ref.id = run.task_ref
                 WHERE task_ref.repo = ?)`;
    if (newMode !== null && newMode.publication === "automerge") {
      this.db
        .prepare(
          `UPDATE merge_intent SET state = 'pending', authority_basis = 'mode', mode_digest = ?,
                  claimed_by = NULL, claimed_until = NULL, generation = generation + 1
            WHERE state IN ('waiting-human','pending','claimed') AND ${repoIntents}`,
        )
        .run(newMode.digest, repo);
      return;
    }
    if (newMode !== null) {
      // A NOTIFY mode is the operator choosing the stricter posture for
      // the repo (D1): EVERY nonterminal intent waits for a human while it
      // is active — grant basis included. `firing` is untouched (E1).
      this.db
        .prepare(
          `UPDATE merge_intent SET state = 'waiting-human', authority_basis = 'human', mode_digest = NULL,
                  claimed_by = NULL, claimed_until = NULL, generation = generation + 1
            WHERE state IN ('pending','claimed') AND ${repoIntents}`,
        )
        .run(repo);
      return;
    }
    // No live mode (revocation or expiry): only MODE-derived authority
    // dies — a grant-basis intent reverts to the grant's own signature,
    // which the mode never restricted retroactively.
    this.db
      .prepare(
        `UPDATE merge_intent SET state = 'waiting-human', authority_basis = 'human', mode_digest = NULL,
                claimed_by = NULL, claimed_until = NULL, generation = generation + 1
          WHERE state IN ('pending','claimed') AND authority_basis = 'mode' AND ${repoIntents}`,
      )
      .run(repo);
  }

  /** The daily rails' atomic reservation (D4): caps are derived from the
   * ACTIVE mode inside this transaction — never caller-supplied. Returns
   * ok, or the typed rail that refused. Bypass roads never call this. */
  reserveModeRail(repo: string, starts: number, now: Date): { ok: true } | { ok: false; rail: "daily-runs" | "daily-dollars"; detail: string } {
    return this.transact(() => {
      const mode = this.activeMode(repo, now);
      if (mode === null) return { ok: true as const };
      let terms: { dailyRunCap?: number | null; dailyMeasuredCapMicrousd?: number | null };
      try {
        terms = JSON.parse(mode.termsJson) as typeof terms;
      } catch {
        return { ok: true as const };
      }
      const day = now.toISOString().slice(0, 10);
      if (typeof terms.dailyMeasuredCapMicrousd === "number") {
        const spent = this.db
          .prepare(
            `SELECT COALESCE(SUM(CAST(ROUND(run.cost_usd * 1000000) AS INTEGER)), 0) AS total
               FROM run JOIN task_ref ON task_ref.id = run.task_ref
              WHERE task_ref.repo = ? AND run.cost_usd IS NOT NULL
                AND run.provider_started_at >= ? AND run.provider_started_at < ?`,
          )
          .get(repo, `${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`);
        if (Number(spent?.["total"] ?? 0) >= terms.dailyMeasuredCapMicrousd) {
          return {
            ok: false as const,
            rail: "daily-dollars" as const,
            detail: `the day's measured budget ($${(terms.dailyMeasuredCapMicrousd / 1_000_000).toFixed(2)}) is spent — running work may finish; new admissions wait for tomorrow (UTC)`,
          };
        }
      }
      if (typeof terms.dailyRunCap === "number") {
        this.db
          .prepare("INSERT INTO mode_rail (repo, utc_day, reserved_starts) VALUES (?, ?, 0) ON CONFLICT (repo, utc_day) DO NOTHING")
          .run(repo, day);
        const updated = this.db
          .prepare("UPDATE mode_rail SET reserved_starts = reserved_starts + ? WHERE repo = ? AND utc_day = ? AND reserved_starts + ? <= ?")
          .run(starts, repo, day, starts, terms.dailyRunCap);
        if (Number(updated.changes) === 0) {
          return {
            ok: false as const,
            rail: "daily-runs" as const,
            detail: `the day's ${terms.dailyRunCap} agent starts are reserved — new admissions wait for tomorrow (UTC)`,
          };
        }
      }
      return { ok: true as const };
    });
  }

  approverHash(name: string): string | null {
    const row = this.db.prepare("SELECT credential_hash FROM approver WHERE name = ?").get(name);
    return row === undefined ? null : String(row["credential_hash"]);
  }

  approverGeneration(name: string): number | null {
    const row = this.db.prepare("SELECT generation FROM approver WHERE name = ?").get(name);
    return row === undefined ? null : Number(row["generation"]);
  }

  /**
   * Strand everything that speaks for an approver at one remove: live
   * Telegram bindings are revoked (softly — the audit trail stays), unspent
   * pairing codes and unconsumed action tokens die with them. Called on
   * credential rotation and on explicit unpair.
   */
  revokeDerivedAuthority(approver: string, by: string, now: Date): void {
    const stamp = now.toISOString();
    const bindings = this.db
      .prepare("SELECT id FROM telegram_binding WHERE approver = ? AND revoked_at IS NULL")
      .all(approver)
      .map(row => Number(row["id"]));
    this.db
      .prepare(
        "UPDATE telegram_binding SET revoked_at = ?, revoked_by = ? WHERE approver = ? AND revoked_at IS NULL",
      )
      .run(stamp, by, approver);
    for (const binding of bindings) {
      this.db
        .prepare("UPDATE telegram_action SET consumed_at = ? WHERE binding = ? AND consumed_at IS NULL")
        .run(stamp, binding);
    }
    this.db
      .prepare("DELETE FROM telegram_pairing WHERE approver = ? AND consumed_at IS NULL")
      .run(approver);
    // Push enrollments are derived authority too (arc 3 finding 6): the
    // rotation retires every live subscription of the old credential and
    // terminally settles its delivery pairs — claimed ones included, so an
    // in-flight sender's fence fails instead of paging a stranded device.
    const subscriptions = this.db
      .prepare("SELECT id FROM push_subscription WHERE approver = ? AND retired_at IS NULL")
      .all(approver)
      .map(row => Number(row["id"]));
    for (const id of subscriptions) this.retirePushSubscription(id, "credential-rotation", now);
  }

  listApprovers(): { name: string; addedAt: string }[] {
    return this.db
      .prepare("SELECT name, added_at FROM approver ORDER BY name")
      .all()
      .map(row => ({ name: String(row["name"]), addedAt: String(row["added_at"]) }));
  }

  // ---- invites + people (v29, U1-U3/D6/D7) --------------------------------

  /** Every account with its standing — the People screen's spine. History
   * is immutable: a revoked person's rows stay attributed forever. */
  accountFacts(): { name: string; role: "approver" | "viewer"; addedAt: string; revokedAt: string | null; revokedBy: string | null }[] {
    return this.db
      .prepare("SELECT name, role, added_at, revoked_at, revoked_by FROM approver ORDER BY name")
      .all()
      .map(row => ({
        name: String(row["name"]),
        role: String(row["role"]) as "approver" | "viewer",
        addedAt: String(row["added_at"]),
        revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
        revokedBy: row["revoked_by"] === null ? null : String(row["revoked_by"]),
      }));
  }

  /** A single-use door into the instance (U2): 128-bit token, sha256
   * stored, role pinned at mint, 72 hours. Only the caller's own
   * authentication gates this — an approver mints; a viewer cannot. */
  mintInvite(role: "approver" | "viewer", mintedBy: string, now: Date, token: () => string = () => randomBytes(16).toString("base64url")): { token: string; id: number; expiresAt: string } {
    const value = token();
    const expiresAt = new Date(now.getTime() + 72 * 60 * 60_000).toISOString();
    const inserted = this.db
      .prepare("INSERT INTO invite (token_hash, role, minted_by, minted_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(createHash("sha256").update(value, "utf8").digest("hex"), role, mintedBy, now.toISOString(), expiresAt);
    return { token: value, id: Number(inserted.lastInsertRowid), expiresAt };
  }

  /** Liveness WITHOUT spending an attempt — what the GET page renders on.
   * Every dead shape (unknown, expired, revoked, consumed) is the same
   * false: the disclosure boundary is one indistinguishable page (D6). */
  inviteIsLive(tokenValue: string, now: Date): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS hit FROM invite WHERE token_hash = ? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ? AND attempts < 10",
      )
      .get(createHash("sha256").update(tokenValue, "utf8").digest("hex"), now.toISOString());
    return row !== undefined;
  }

  /**
   * E3: submissions meter ADMITTED attempts, never refunds. One atomic
   * UPDATE spends the slot BEFORE the KDF runs — the eleventh concurrent
   * submission gets the indistinguishable terminal page without ever
   * reaching scrypt, and neither success nor failure gives it back.
   */
  admitInviteAttempt(tokenValue: string, now: Date): { role: "approver" | "viewer"; mintedBy: string } | null {
    const row = this.db
      .prepare(
        `UPDATE invite SET attempts = attempts + 1
          WHERE token_hash = ? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ? AND attempts < 10
          RETURNING role, minted_by`,
      )
      .get(createHash("sha256").update(tokenValue, "utf8").digest("hex"), now.toISOString());
    return row === undefined
      ? null
      : { role: String(row["role"]) as "approver" | "viewer", mintedBy: String(row["minted_by"]) };
  }

  /**
   * The join commit (D6): consume the invite AND create the account in
   * ONE transaction — the CAS on consumed_at is the single winner under
   * concurrent submissions, the name's uniqueness is proved in the same
   * breath, and the role is the PINNED one from mint, never a request
   * parameter. The caller runs scrypt before calling; the session cookie
   * mints only after this commits.
   */
  consumeInviteAndCreateAccount(
    args: { tokenValue: string; name: string; credentialHash: string },
    now: Date,
  ): { ok: true; role: "approver" | "viewer" } | { ok: false; reason: "gone" | "name-taken" } {
    return this.transact(() => {
      // Liveness FIRST (Codex people round 1, finding 3): the loser of a
      // concurrent join must read as 'gone' — the indistinguishable dead
      // shape — never as a name collision that discloses the winner.
      const hash = createHash("sha256").update(args.tokenValue, "utf8").digest("hex");
      const live = this.db
        .prepare("SELECT 1 AS hit FROM invite WHERE token_hash = ? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ?")
        .get(hash, now.toISOString());
      if (live === undefined) return { ok: false as const, reason: "gone" as const };
      const taken = this.db.prepare("SELECT 1 AS hit FROM approver WHERE name = ?").get(args.name);
      if (taken !== undefined) return { ok: false as const, reason: "name-taken" as const };
      const consumed = this.db
        .prepare(
          `UPDATE invite SET consumed_by = ?, consumed_at = ?
            WHERE token_hash = ? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ?
            RETURNING role`,
        )
        .get(args.name, now.toISOString(), hash, now.toISOString());
      if (consumed === undefined) return { ok: false as const, reason: "gone" as const };
      const role = String(consumed["role"]) as "approver" | "viewer";
      this.db
        .prepare("INSERT INTO approver (name, credential_hash, added_at, role, generation) VALUES (?, ?, ?, ?, 1)")
        .run(args.name, args.credentialHash, now.toISOString(), role);
      return { ok: true as const, role };
    });
  }

  /** The open invites — the People screen's and the CLI's list. Hashes
   * never leave the store; an invite is named by its row id. */
  openInvites(now: Date): { id: number; role: "approver" | "viewer"; mintedBy: string; mintedAt: string; expiresAt: string; attempts: number }[] {
    return this.db
      .prepare(
        "SELECT id, role, minted_by, minted_at, expires_at, attempts FROM invite WHERE revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ? ORDER BY id",
      )
      .all(now.toISOString())
      .map(row => ({
        id: Number(row["id"]),
        role: String(row["role"]) as "approver" | "viewer",
        mintedBy: String(row["minted_by"]),
        mintedAt: String(row["minted_at"]),
        expiresAt: String(row["expires_at"]),
        attempts: Number(row["attempts"]),
      }));
  }

  revokeInvite(id: number, now: Date): boolean {
    return (
      Number(
        this.db
          .prepare("UPDATE invite SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND consumed_at IS NULL")
          .run(now.toISOString(), id).changes,
      ) > 0
    );
  }

  /**
   * The revocation that actually severs (D7), one transaction: the stamp
   * plus a generation bump (live console sessions die at their next
   * lookup; bearer credentials die at authenticateAccount), their open
   * attended authorizations close, their unconsumed invites die, every
   * mode THEY signed is revoked with the typed 'signer-revoked' event —
   * demoting its derived merge authority through the one reconciliation
   * road — and the derived-authority sweep clears Telegram and push.
   * History is untouched: revocation ends capability, never rewrites the
   * ledger. Removing the LAST active approver is refused — an instance
   * nobody can approve into is a brick, not a posture.
   *
   * THE CLAIM, NARROWED (Codex people round 1, finding 2): what dies here
   * is authority that DERIVES from the person's standing — sessions,
   * invites, modes and everything mode-derived (their sealed filings
   * demote through the reconciliation road), Telegram, push. Standing
   * acts they completed WITH full ceremony — publication/backend/intake
   * grants, worktree setups, approved routines, approved scopes sealed by
   * password — deliberately survive: those are the instance's promises,
   * approved as themselves, and undoing history is not what revocation
   * means. An operator who distrusts those acts revokes them by their own
   * roads.
   */
  revokeAccount(
    name: string,
    by: string,
    now: Date,
  ):
    | { ok: true; modesRevoked: number; authorizationsClosed: number; invitesRevoked: number }
    | { ok: false; reason: "unknown" | "already-revoked" | "last-approver" } {
    return this.transact(() => {
      const account = this.db.prepare("SELECT role, revoked_at FROM approver WHERE name = ?").get(name);
      if (account === undefined) return { ok: false as const, reason: "unknown" as const };
      if (account["revoked_at"] !== null) return { ok: false as const, reason: "already-revoked" as const };
      if (String(account["role"]) === "approver") {
        const others = this.db
          .prepare("SELECT COUNT(*) AS n FROM approver WHERE role = 'approver' AND revoked_at IS NULL AND name <> ?")
          .get(name);
        if (Number(others?.["n"] ?? 0) === 0) return { ok: false as const, reason: "last-approver" as const };
      }
      const stamp = now.toISOString();
      this.db
        .prepare("UPDATE approver SET revoked_at = ?, revoked_by = ?, generation = generation + 1 WHERE name = ?")
        .run(stamp, by, name);
      const closed = this.db
        .prepare("UPDATE attended_authorization SET closed_at = ?, end_reason = 'approver-revoked' WHERE approver = ? AND closed_at IS NULL")
        .run(stamp, name);
      const invites = this.db
        .prepare("UPDATE invite SET revoked_at = ? WHERE minted_by = ? AND revoked_at IS NULL AND consumed_at IS NULL")
        .run(stamp, name);
      // Modes they signed die with them — and every intent that derived
      // merge authority from those signatures demotes through the ONE
      // reconciliation road, exactly as an explicit revocation would.
      const modes = this.db
        .prepare("SELECT id, repo FROM operating_mode WHERE signed_by = ? AND revoked_at IS NULL")
        .all(name);
      for (const mode of modes) {
        this.db
          .prepare("UPDATE operating_mode SET revoked_at = ?, revoked_by = ?, revoke_reason = 'signer-revoked' WHERE id = ?")
          .run(stamp, by, Number(mode["id"]));
        this.db
          .prepare("INSERT INTO operating_mode_event (mode, kind, actor, at) VALUES (?, 'signer-revoked', ?, ?)")
          .run(Number(mode["id"]), by, stamp);
        this.reconcileIntentsForMode(String(mode["repo"]), null, now);
      }
      this.revokeDerivedAuthority(name, by, now);
      return {
        ok: true as const,
        modesRevoked: modes.length,
        authorizationsClosed: Number(closed.changes),
        invitesRevoked: Number(invites.changes),
      };
    });
  }

  /** One person's open attended sessions, for their People card. */
  openAttendedOf(name: string): { taskId: string; createdAt: string; lastBeatAt: string | null }[] {
    return this.db
      .prepare(
        `SELECT task_ref.external_id AS taskId, aa.created_at, aa.last_beat_at
           FROM attended_authorization aa JOIN task_ref ON task_ref.id = aa.task_ref
          WHERE aa.approver = ? AND aa.closed_at IS NULL ORDER BY aa.created_at DESC`,
      )
      .all(name)
      .map(row => ({
        taskId: String(row["taskId"]),
        createdAt: String(row["created_at"]),
        lastBeatAt: row["last_beat_at"] === null ? null : String(row["last_beat_at"]),
      }));
  }

  /**
   * One person's recent consequential acts (U3), from the rows that were
   * ALREADY author-stamped — no new event kinds, just the ledger asked a
   * new question. Bounded and newest-first.
   */
  recentActsOf(name: string, limit = 8): { kind: string; subject: string; at: string }[] {
    return this.db
      .prepare(
        `SELECT kind, subject, at FROM (
           SELECT 'approved' AS kind, task_id AS subject, approved_at AS at FROM task_scope WHERE approved_by = ? AND approved_at IS NOT NULL
           UNION ALL
           SELECT 'decided', COALESCE((SELECT external_id FROM task_ref JOIN run ON run.task_ref = task_ref.id WHERE run.id = decision.run), ''), answered_at FROM decision WHERE answered_by = ? AND answered_at IS NOT NULL
           UNION ALL
           SELECT 'steered', (SELECT external_id FROM task_ref WHERE task_ref.id = task_steer.task_ref), created_at FROM task_steer WHERE author = ?
           UNION ALL
           SELECT 'mode ' || kind, (SELECT repo FROM operating_mode WHERE operating_mode.id = operating_mode_event.mode), at FROM operating_mode_event WHERE actor = ?
           UNION ALL
           SELECT 'merge unblocked', COALESCE(task_id, ''), lifted_at FROM merge_blocker WHERE lifted_by = ? AND lifted_at IS NOT NULL
         ) WHERE at IS NOT NULL ORDER BY at DESC LIMIT ?`,
      )
      .all(name, name, name, name, name, limit)
      .map(row => ({ kind: String(row["kind"]), subject: String(row["subject"] ?? ""), at: String(row["at"]) }));
  }

  // ---- runners ------------------------------------------------------------

  saveRunner(runner: Runner, credentialHash: string, mutation: Mutation = {}): void {
    this.once(mutation, "saveRunner", () => {
      this.db
        .prepare(
          `INSERT INTO runner
             (name, host, credential_hash, capacity, repos, agents, registered_at, heartbeat_at, retired_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (name) DO UPDATE SET
             host = excluded.host, credential_hash = excluded.credential_hash,
             capacity = excluded.capacity, repos = excluded.repos, agents = excluded.agents,
             registered_at = excluded.registered_at, heartbeat_at = excluded.heartbeat_at,
             retired_at = NULL`,
        )
        .run(
          runner.name,
          runner.host,
          credentialHash,
          runner.capacity,
          JSON.stringify(runner.repos),
          JSON.stringify(runner.agents),
          runner.registeredAt,
          runner.heartbeatAt,
        );
      return null;
    });
  }

  /**
   * The one-time binding ceremony's write (MCP gateway spec v6): REPLACES
   * the runner's repo list — stated authority, never accumulation — and
   * touches nothing else: credential, capacity, heartbeat, and retirement
   * all stand. The caller has already authenticated the operator; a
   * retired runner refuses (retire is final; re-register instead).
   */
  bindRunnerRepos(
    name: string,
    repos: readonly string[],
    now: Date,
  ): { ok: true; repos: string[] } | { ok: false; reason: "unknown" | "retired" } {
    return this.transact(() => {
      const found = this.getRunner(name);
      if (found === null) return { ok: false as const, reason: "unknown" as const };
      if (found.runner.retiredAt !== null) return { ok: false as const, reason: "retired" as const };
      const bound = [...repos];
      this.db
        .prepare("UPDATE runner SET repos = ? WHERE name = ?")
        .run(JSON.stringify(bound), name);
      void now;
      return { ok: true as const, repos: bound };
    });
  }

  /** The hash comes back with it; the token it was made from does not exist here. */
  getRunner(name: string): { runner: Runner; credentialHash: string } | null {
    const row = this.db.prepare("SELECT * FROM runner WHERE name = ?").get(name);
    if (row === undefined) return null;
    return { runner: readRunner(row), credentialHash: String(row["credential_hash"]) };
  }

  listRunners(): Runner[] {
    return this.db.prepare("SELECT * FROM runner ORDER BY name").all().map(readRunner);
  }

  touchRunner(name: string, now: Date): void {
    this.db
      .prepare("UPDATE runner SET heartbeat_at = ? WHERE name = ? AND retired_at IS NULL")
      .run(now.toISOString(), name);
  }

  retireRunner(name: string, now: Date, mutation: Mutation = {}): boolean {
    return this.once(
      mutation,
      "retireRunner",
      () => {
        const { changes } = this.db
          .prepare("UPDATE runner SET retired_at = ? WHERE name = ? AND retired_at IS NULL")
          .run(now.toISOString(), name);
        return Number(changes) > 0;
      },
      retired => retired,
    );
  }

  /**
   * Release every live claim a runner holds, and say which.
   *
   * Not a fenced release: this is the control plane taking a lease back from a
   * machine that is gone, not that machine handing it in. The generation is
   * untouched, so if the runner ever wakes up its completion is still fenced
   * out by the next acquire — which is exactly the behaviour that made the
   * fence worth having.
   */
  releaseClaimsOf(runner: string, now: Date): string[] {
    const held = this.db
      .prepare("SELECT lease_id, task_ref FROM claim WHERE runner = ? AND released_at IS NULL")
      .all(runner);
    if (held.length === 0) return [];

    this.db
      .prepare(
        "UPDATE claim SET released_at = ?, released_by = 'recovered' WHERE runner = ? AND released_at IS NULL",
      )
      .run(now.toISOString(), runner);

    // Releasing the lease is only half of it. Claiming a task moves it to
    // `running`, and the ready query asks for `queued` — so a lease taken back
    // from a dead machine without this leaves the task stranded in `running`
    // forever: not claimed by anybody, and never offered to anybody either.
    // The most expensive kind of bug, because nothing anywhere reports it.
    //
    // Matched on backend as well as id. Claims are backend-agnostic and ids
    // are only unique within a backend, so requeuing by id alone would let a
    // dead runner's GitHub issue #17 reset a built-in task that happens to be
    // called `17`. Somebody else's work, moved by a coincidence of naming.
    for (const row of held) {
      const ref = this.db
        .prepare("SELECT backend, external_id FROM task_ref WHERE id = ?")
        .get(Number(row["task_ref"]));
      if (ref === undefined || String(ref["backend"]) !== BUILT_IN) continue;

      this.db
        .prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'")
        .run(now.toISOString(), String(ref["external_id"]));
    }

    return held.map(row => String(row["lease_id"]));
  }

  // ---- worktrees ----------------------------------------------------------

  saveWorktree(worktree: WorktreeRow, mutation: Mutation = {}): void {
    this.once(mutation, "saveWorktree", () => {
      this.db
        .prepare(
          `INSERT INTO worktree (path, repo, branch, runner, task_ref, created_at, leased_at, released_at, verified, lease_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (path) DO UPDATE SET
             repo = excluded.repo, branch = excluded.branch, runner = excluded.runner,
             task_ref = excluded.task_ref, leased_at = excluded.leased_at,
             released_at = excluded.released_at, verified = excluded.verified,
             lease_epoch = excluded.lease_epoch`,
        )
        .run(
          worktree.path,
          worktree.repo,
          worktree.branch,
          worktree.runner,
          worktree.taskRef,
          worktree.createdAt,
          worktree.leasedAt,
          worktree.releasedAt,
          worktree.verified ? 1 : 0,
          worktree.leaseEpoch ?? null,
        );
      return null;
    });
  }

  getWorktree(path: string): WorktreeRow | null {
    const row = this.db.prepare("SELECT * FROM worktree WHERE path = ?").get(path);
    return row === undefined ? null : readWorktree(row);
  }

  /** Drop a row whose directory is gone; a lease over nothing only refuses work. */
  forgetWorktree(path: string): void {
    this.db.prepare("DELETE FROM worktree WHERE path = ?").run(path);
  }

  // ---- worktree setup (M5.7) ---------------------------------------------

  /**
   * Approve one repo's setup, revoking any predecessor in the same
   * transaction — exactly one live setup per repo, enforced by the partial
   * unique index rather than by anything a caller remembers.
   */
  setWorktreeSetup(
    args: { repo: string; command: string; timeoutMs: number; approvedBy: string },
    now: Date,
  ): WorktreeSetup {
    const digest = createHash("sha256")
      .update(`${args.repo}\u0000${args.command}\u0000${args.timeoutMs}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    return this.transact(() => {
      this.db
        .prepare("UPDATE worktree_setup SET revoked_at = ?, revoked_by = ? WHERE repo = ? AND revoked_at IS NULL")
        .run(now.toISOString(), args.approvedBy, args.repo);
      const inserted = this.db
        .prepare(
          `INSERT INTO worktree_setup (repo, command, timeout_ms, digest, approved_by, approved_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(args.repo, args.command, args.timeoutMs, digest, args.approvedBy, now.toISOString());
      const row = this.db.prepare("SELECT * FROM worktree_setup WHERE id = ?").get(Number(inserted.lastInsertRowid));
      return readWorktreeSetup(row as Record<string, unknown>);
    });
  }

  liveWorktreeSetup(repo: string): WorktreeSetup | null {
    const row = this.db
      .prepare("SELECT * FROM worktree_setup WHERE repo = ? AND revoked_at IS NULL")
      .get(repo);
    return row === undefined ? null : readWorktreeSetup(row);
  }

  clearWorktreeSetup(repo: string, by: string, now: Date): boolean {
    const done = this.db
      .prepare("UPDATE worktree_setup SET revoked_at = ?, revoked_by = ? WHERE repo = ? AND revoked_at IS NULL")
      .run(now.toISOString(), by, repo);
    return Number(done.changes) > 0;
  }

  /** The cache stamp: this checkout completed this setup. Success-only by contract. */
  stampWorktreeSetup(path: string, digest: string): void {
    this.db.prepare("UPDATE worktree SET setup_digest = ? WHERE path = ?").run(digest, path);
  }

  // ---- run notes (M6) -----------------------------------------------------

  /** Append one immutable operator note to a run. Validation is the caller's (validateNote). */
  addRunNote(runId: number, author: string, note: string, now: Date): number {
    const run = this.getRun(runId);
    if (run === null) throw new Error(`run ${runId} does not exist — a note needs a record to sit next to`);
    const inserted = this.db
      .prepare("INSERT INTO run_note (run, author, note, created_at) VALUES (?, ?, ?, ?)")
      .run(runId, author, note, now.toISOString());
    return Number(inserted.lastInsertRowid);
  }

  // ---- intake grants (M8.16) ---------------------------------------------

  setIntakeGrant(
    args: { repo: string; github: string; label: string; reviewers: string[] | null; approvedBy: string },
    now: Date,
  ): IntakeGrant {
    return this.transact(() => {
      this.db
        .prepare("UPDATE intake_grant SET revoked_at = ?, revoked_by = ? WHERE repo = ? AND revoked_at IS NULL")
        .run(now.toISOString(), args.approvedBy, args.repo);
      const inserted = this.db
        .prepare(
          `INSERT INTO intake_grant (repo, github, label, reviewers, approved_by, approved_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.repo,
          args.github,
          args.label,
          args.reviewers === null ? null : args.reviewers.join(","),
          args.approvedBy,
          now.toISOString(),
        );
      const row = this.db.prepare("SELECT * FROM intake_grant WHERE id = ?").get(Number(inserted.lastInsertRowid));
      return readIntakeGrant(row as Record<string, unknown>);
    });
  }

  liveIntakeGrant(repo: string): IntakeGrant | null {
    const row = this.db.prepare("SELECT * FROM intake_grant WHERE repo = ? AND revoked_at IS NULL").get(repo);
    return row === undefined ? null : readIntakeGrant(row);
  }

  clearIntakeGrant(repo: string, by: string, now: Date): boolean {
    const done = this.db
      .prepare("UPDATE intake_grant SET revoked_at = ?, revoked_by = ? WHERE repo = ? AND revoked_at IS NULL")
      .run(now.toISOString(), by, repo);
    return Number(done.changes) > 0;
  }

  // ---- diff comments and revision tasks (M6.8) ---------------------------

  /**
   * A comment on an immutable terminal diff. The artifact must belong to
   * the run and be a terminal diff; the recorded sha binds the words to the
   * exact bytes reviewed — a comment whose artifact hash no longer matches
   * is a comment on something else, refused at read time by the verifier.
   */
  addDiffComment(
    args: {
      artifactId: number;
      runId: number;
      path: string | null;
      line: number | null;
      note: string;
      author: string;
      /** Ingested comments carry their origin id — the idempotency key (M8.17). */
      sourceKey?: string;
    },
    now: Date,
  ): number | null {
    const artifact = this.artifactsFor(args.runId).find(one => one.id === args.artifactId);
    if (artifact === undefined || artifact.kind !== "terminal-diff") {
      throw new Error(`artifact ${args.artifactId} is not run ${args.runId}'s terminal diff — comments bind to the exact bytes reviewed`);
    }
    // The unique index is the real concurrent guard (audit C-9): a race on
    // the same source key lands in DO NOTHING, not in a thrown constraint.
    const inserted = this.db
      .prepare(
        `INSERT INTO diff_comment (artifact, artifact_sha, run, path, line, note, author, created_at, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING`,
      )
      .run(
        args.artifactId,
        artifact.sha256,
        args.runId,
        args.path,
        args.line,
        args.note,
        args.author,
        now.toISOString(),
        args.sourceKey ?? null,
      );
    return Number(inserted.changes) === 0 ? null : Number(inserted.lastInsertRowid);
  }

  /** Live (unsuperseded, unconsumed) comments on a run's terminal diff. */
  liveDiffComments(runId: number): DiffComment[] {
    return this.db
      .prepare("SELECT * FROM diff_comment WHERE run = ? AND superseded_by IS NULL AND consumed_by IS NULL ORDER BY id")
      .all(runId)
      .map(readDiffComment);
  }

  /** Every comment on a run, consumed included — the audit view. */
  allDiffComments(runId: number): DiffComment[] {
    return this.db.prepare("SELECT * FROM diff_comment WHERE run = ? ORDER BY id").all(runId).map(readDiffComment);
  }

  /**
   * Seal a comment batch into a revision task, in one transaction: the
   * comments are marked consumed by the new task id, so a second click
   * finds nothing to consume instead of minting a duplicate task.
   */
  consumeDiffComments(runId: number, ids: readonly number[], taskId: string): number {
    if (ids.length === 0) return 0;
    let consumed = 0;
    for (const id of ids) {
      const done = this.db
        .prepare("UPDATE diff_comment SET consumed_by = ? WHERE id = ? AND run = ? AND consumed_by IS NULL AND superseded_by IS NULL")
        .run(taskId, id, runId);
      consumed += Number(done.changes);
    }
    return consumed;
  }

  // ---- fallback chains: the fenced cycle state machine (v30, C7) --------

  /** The open cycle for a task, if one exists (the runtime's read). */
  fallbackCycleFor(taskRef: number): FallbackCycle | null {
    const row = this.db
      .prepare("SELECT * FROM fallback_cycle WHERE task_ref = ? AND state NOT IN ('closed','incident') ORDER BY id DESC LIMIT 1")
      .get(taskRef);
    return row === undefined ? null : readFallbackCycle(row as Record<string, unknown>);
  }

  /** Open a fresh cycle at index 0 for a running base attempt. One live
   * cycle per task — the SELECT-then-INSERT under BEGIN IMMEDIATE
   * serializes writers, and the one_live_fallback_cycle_per_task partial
   * unique index is the durable backstop (finding 5). A second refuses. */
  openFallbackCycle(taskRef: number, chainDigest: string, tailRun: number, now: Date): { ok: true; id: number } | { ok: false } {
    return this.transact(() => {
      const existing = this.db
        .prepare("SELECT 1 AS hit FROM fallback_cycle WHERE task_ref = ? AND state NOT IN ('closed','incident') LIMIT 1")
        .get(taskRef);
      if (existing !== undefined) return { ok: false as const };
      const inserted = this.db
        .prepare(
          `INSERT INTO fallback_cycle (task_ref, chain_digest, cursor, state, transition_generation, tail_run, created_at, updated_at)
           VALUES (?, ?, 0, 'open', 0, ?, ?, ?)`,
        )
        .run(taskRef, chainDigest, tailRun, now.toISOString(), now.toISOString());
      return { ok: true as const, id: Number(inserted.lastInsertRowid) };
    });
  }

  /**
   * The task's IMMUTABLE approved chain — the runtime's single source of
   * truth for chain length and per-entry authority (never mutable config).
   * Returns the rehydrated entries when the approval sealed a chain and the
   * snapshot still rehydrates strictly; null otherwise (a single-profile
   * approval, or a snapshot that fails the strict rehydrator — fail closed,
   * so a corrupt chain dispatches nothing).
   */
  approvedChainOf(taskId: string): ChainEntry[] | null {
    const scope = this.getScope(taskId);
    if (scope === null || scope.approvalKind !== "chain" || scope.approvedChainJson == null) return null;
    // The approval must still STAND (Codex E2/E3 review, finding 2): a scope
    // rewritten without reapproval has withdrawn its authority — chain
    // snapshot included — so a stale approved_chain_json can never remain
    // fallback authority. approvedDigest === digest is the same freshness the
    // build gate proves.
    if (scope.approvedAt === null || scope.approvedDigest === null || scope.approvedDigest !== scope.digest) {
      return null;
    }
    const chain = chainFromJson(scope.approvedChainJson);
    if (chain === null) return null;
    // The snapshot must be the one the SIGNED digest binds — recompute from
    // the current scope fields + this chain and require an exact match, so a
    // snapshot that does not correspond to the approved digest never governs.
    const rederived = digestOf(
      { goal: scope.goal, outOfScope: scope.outOfScope, touches: scope.touches, budgetMicrousd: scope.budgetMicrousd },
      { chain },
    );
    if (rederived !== scope.approvedDigest) return null;
    return chain;
  }

  /**
   * The coordinator's base-cycle door (E3b): called right after a run is
   * created for a task, it opens the fallback cycle IF (and only if) the
   * task's approval sealed an explicit chain. A single-profile approval
   * opens nothing and returns null — every task until an operator configures
   * a fallback chain, so this is inert by default. The chain digest is
   * derived from the IMMUTABLE approved snapshot, never mutable config. When
   * a cycle already exists and is still `open`, the live run is re-tagged as
   * its tail so a repair/retry at the current cursor advances on its OWN
   * exhaustion rather than a vanished predecessor's; a cycle mid-advance is
   * left untouched (its next run arrives through admitFallback, which sets
   * the tail itself). Returns the cycle id now governing this run, else null.
   */
  openChainCycleForDispatch(taskRef: number, taskId: string, runId: number, now: Date): number | null {
    const chain = this.approvedChainOf(taskId);
    if (chain === null) return null;
    const digest = chainDigestOf(chain);
    return this.transact(() => {
      // Bind the run to the entry it will spend as (E3d): cycle, index,
      // entry digest, and the PINNED auth mode, first-write only — the
      // dispatch proof re-derives all four from the approved chain and
      // refuses a run whose binding does not match. A run bound to a
      // cursor whose entry is not the profile it was asked to run fails
      // that proof — closed, not clever.
      const bind = (cycleId: number, index: number): void => {
        const entry = chain[index];
        if (entry === undefined) return;
        this.db
          .prepare(
            "UPDATE run SET chain_cycle = ?, chain_index = ?, entry_digest = ?, auth_mode = ? WHERE id = ? AND chain_cycle IS NULL",
          )
          .run(cycleId, index, entryDigestOf(entry), entry.authMode, runId);
      };
      const opened = this.openFallbackCycle(taskRef, digest, runId, now);
      if (opened.ok) {
        bind(opened.id, 0);
        return opened.id;
      }
      // A LIVE cycle already exists. There is NO in-passing re-tag (Codex
      // E3d review, finding 5): custody moves only through admitFallback or
      // the proven parked-resume road. The tick's deferral keeps ordinary
      // dispatch away from live-cycle tasks, so reaching here is a race or
      // a stale cycle — either way this run gets NO binding, and the
      // chain-entry dispatch proof refuses it before any money moves.
      const existing = this.fallbackCycleFor(taskRef);
      if (existing !== null && existing.chainDigest !== digest) {
        // Bound to a DIFFERENT approved chain: stale authority — incident it
        // so a human sees why; the next dispatch opens fresh under the new
        // chain (findings 2/3).
        this.incidentFallback(existing.id, existing.transitionGeneration, "chain-digest-changed-under-open-cycle", now);
      }
      return null;
    });
  }

  /**
   * The ONE chain-cycle resolver at a run's end (E3c/E3d): every concluded
   * tail resolves its cycle — success closes it, an ordinary end closes it
   * (the retry road runs the BASE entry under a FRESH cycle; a concluded
   * tail can never be re-tagged, so leaving it open would only strand it),
   * a parked tail is a PAUSED lineage and stays open for repair, and a
   * recognized eligible exhaustion advances. Both the disposition hook and
   * the crash reconciler call THIS method, so a crash between disposition
   * and resolution re-derives the same answer from durable state.
   *
   * The advance is FAIL CLOSED at every gate:
   *   - an OPEN cycle whose tail is exactly this finished run;
   *   - the run genuinely finished (outcome + finished_at +
   *     provider_started_at, same task) — never live custody;
   *   - a fallback-ELIGIBLE class consistent with the run's auth mode;
   *   - the C8 re-check: THIS build recognizes the exact class/auth for the
   *     run's (provider, version) — a downgrade severs to incident;
   *   - the LIVE signed mode's paid-fallback grant, re-read IN-transaction;
   *   - a next entry in the IMMUTABLE approved chain (else exhausted-end).
   * The fenced custody walk — sanitize, advance, release-to-pending — runs
   * atomically inside ONE transaction; a lost inner CAS rolls the whole
   * walk back. It NEVER dispatches: the admission pass creates the run.
   */
  resolveChainOnRunEnd(
    taskRef: number,
    taskId: string,
    repo: string | null,
    finishedRunId: number,
    now: Date,
  ):
    | { kind: "advanced"; toIndex: number }
    | { kind: "exhausted-end" }
    | { kind: "closed"; reason: "succeeded" | "entry-ended" }
    | { kind: "blocked"; reason: "no-recognizer" | "grant-withheld" | "corrupt-chain" | "cycle-mismatch" }
    | { kind: "parked-tail" }
    | { kind: "no-cycle" } {
    try {
      return this.transact(() => {
        const cycle = this.fallbackCycleFor(taskRef);
        if (cycle === null || cycle.state !== "open" || cycle.tailRun !== finishedRunId) {
          return { kind: "no-cycle" as const };
        }
        const run = this.getRun(finishedRunId);
        if (run === null) return { kind: "no-cycle" as const };
        // The predecessor must be genuinely FINISHED (Codex E2/E3 review,
        // finding 7): a run whose outcome is still open — or that never
        // spawned a provider — is live custody, and advancing off it could
        // start the next entry beside a running predecessor. Its task must be
        // this task, too. (A success that never spawned — a no-change without
        // a provider — still closes below; the started-at proof gates only
        // the ADVANCE road.)
        if (run.taskRef !== taskRef || run.outcome === null || run.finishedAt === null) {
          return { kind: "no-cycle" as const };
        }
        // A successful tail: the chain did its job — closed, terminally.
        if (run.outcome === "built" || run.outcome === "no-change") {
          this.closeFallbackCycle(cycle.id, cycle.transitionGeneration, "succeeded", now);
          return { kind: "closed" as const, reason: "succeeded" as const };
        }
        // A parked tail is a PAUSED lineage, not an ended one: repair resumes
        // the same custody, and the cycle stays open for it.
        if (run.outcome === "parked") return { kind: "parked-tail" as const };
        const cls: TerminalClass = run.terminalClass ?? "unknown";
        const authMode = run.authMode ?? "subscription";
        // An ordinary end (failure, refusal, interruption) — or a corrupt
        // class/auth pairing, which must READ as ordinary (finding 8) —
        // ends the cycle. The retry road opens a fresh one at the base.
        if (!isFallbackEligible(cls) || !classMatchesAuthMode(cls, authMode)) {
          this.closeFallbackCycle(cycle.id, cycle.transitionGeneration, "entry-ended", now);
          return { kind: "closed" as const, reason: "entry-ended" as const };
        }
        // The ADVANCE road requires a proven provider spawn.
        if (run.providerStartedAt === null) {
          this.closeFallbackCycle(cycle.id, cycle.transitionGeneration, "entry-ended", now);
          return { kind: "closed" as const, reason: "entry-ended" as const };
        }
        // C8 re-check at the authority point (findings 1/8): THIS build must
        // recognize the EXACT eligible class for this auth mode — not merely
        // "some eligible recognizer exists." A build with no such fixture
        // (every real build) severs the cycle to incident, loudly.
        if (!recognizesEligible(run.provider as ProviderId, run.providerVersion, authMode)) {
          this.incidentFallback(cycle.id, cycle.transitionGeneration, "recognizer-absent-at-advance", now);
          return { kind: "blocked" as const, reason: "no-recognizer" as const };
        }
        // The paid-fallback grant is re-proved from the LIVE signed mode
        // INSIDE this transaction (finding 4): a boolean read before the
        // transaction is a TOCTOU — a mode revoked or replaced meanwhile must
        // deny the advance.
        const liveGrant =
          repo === null
            ? false
            : modeTermsFromJson(this.activeMode(repo, now)?.termsJson ?? null)?.allowPaidFallback === true;
        if (!liveGrant) {
          // No live grant: the cycle ends here, cleanly, and the run disposes
          // as the ordinary exhaustion it is.
          this.closeFallbackCycle(cycle.id, cycle.transitionGeneration, "grant-withheld", now);
          return { kind: "blocked" as const, reason: "grant-withheld" as const };
        }
        const chain = this.approvedChainOf(taskId);
        if (chain === null) {
          // A chain we can no longer re-derive (or whose approval was
          // withdrawn) is never advanced on.
          this.incidentFallback(cycle.id, cycle.transitionGeneration, "approved-chain-unrehydratable", now);
          return { kind: "blocked" as const, reason: "corrupt-chain" as const };
        }
        // The open cycle must belong to THIS approved chain (finding 2,
        // scenario B): a scope reapproved under a different chain must not
        // let an old cycle admit into the new one.
        if (cycle.chainDigest !== chainDigestOf(chain)) {
          this.incidentFallback(cycle.id, cycle.transitionGeneration, "cycle-chain-digest-mismatch", now);
          return { kind: "blocked" as const, reason: "cycle-mismatch" as const };
        }
        const chainLength = chain.length;
        if (cycle.cursor + 1 >= chainLength) {
          // Eligible, but the whole chain is spent — the exhausted terminal.
          this.closeFallbackCycle(cycle.id, cycle.transitionGeneration, "chain-exhausted", now);
          return { kind: "exhausted-end" as const };
        }
        const g0 = cycle.transitionGeneration;
        if (!this.beginFallbackSanitize(cycle.id, g0, finishedRunId, now)) {
          throw new Error("fallback sanitize lost its CAS");
        }
        const adv = this.advanceFallbackFenced(
          {
            cycleId: cycle.id,
            expectGeneration: g0 + 1,
            fromIndex: cycle.cursor,
            chainLength,
            predecessorRun: finishedRunId,
            terminalClass: cls,
            evidence: {
              provider: run.provider,
              version: run.providerVersion,
              authMode: run.authMode ?? "subscription",
              fp: "",
            },
          },
          now,
        );
        if (!adv.ok) throw new Error(`fallback advance lost: ${adv.reason}`);
        if (!this.releaseFallbackToPending(cycle.id, g0 + 2, now)) {
          throw new Error("fallback release lost its CAS");
        }
        return { kind: "advanced" as const, toIndex: adv.toIndex };
      });
    } catch {
      // A lost CAS rolled the whole walk back (the cycle is untouched at its
      // generation): another authority raced us. Do nothing — next tick.
      return { kind: "no-cycle" as const };
    }
  }

  /**
   * The crash reconciler's read (E3d, review finding 3): OPEN cycles whose
   * tail run CONCLUDED (non-parked) but whose cycle was never resolved — the
   * window a crash between disposition and resolveChainOnRunEnd leaves. The
   * reconciler feeds each through the SAME resolver, so nothing is decided
   * twice or differently.
   */
  strandedChainCycles(repo: string): { cycleId: number; taskRef: number; taskId: string; tailRun: number }[] {
    return this.db
      .prepare(
        `SELECT fc.id AS cycle_id, fc.task_ref AS task_ref, tr.external_id AS task_id, fc.tail_run AS tail_run
           FROM fallback_cycle fc
           JOIN run r ON r.id = fc.tail_run
           JOIN task_ref tr ON tr.id = fc.task_ref AND tr.backend = ? AND tr.repo = ?
          WHERE fc.state = 'open' AND r.outcome IS NOT NULL AND r.outcome <> 'parked'`,
      )
      .all(BUILT_IN, repo)
      .map(row => ({
        cycleId: Number((row as Record<string, unknown>)["cycle_id"]),
        taskRef: Number((row as Record<string, unknown>)["task_ref"]),
        taskId: String((row as Record<string, unknown>)["task_id"]),
        tailRun: Number((row as Record<string, unknown>)["tail_run"]),
      }));
  }

  /**
   * The chain reconciler in ONE callable piece (F+G review, finding 5): the
   * EXACT code the tick runs each pass, so the fault tests drive the same
   * road production does — deleting the tick's call would fail them.
   * Resolves every open cycle whose tail concluded (non-parked) through the
   * one resolver; returns how many it fed through.
   */
  reconcileStrandedChains(repo: string, now: Date): number {
    let fed = 0;
    for (const stranded of this.strandedChainCycles(repo)) {
      this.resolveChainOnRunEnd(stranded.taskRef, stranded.taskId, repo, stranded.tailRun, now);
      fed++;
    }
    return fed;
  }

  /** Cycles awaiting their next entry's admission, for one repo — what the
   * tick's chain admission pass walks. */
  pendingChainAdmissions(repo: string): { cycleId: number; taskRef: number; taskId: string; cursor: number }[] {
    return this.db
      .prepare(
        `SELECT fc.id AS cycle_id, fc.task_ref AS task_ref, tr.external_id AS task_id, fc.cursor AS cursor
           FROM fallback_cycle fc
           JOIN task_ref tr ON tr.id = fc.task_ref AND tr.backend = ? AND tr.repo = ?
          WHERE fc.state = 'pending-admission'
          ORDER BY fc.id`,
      )
      .all(BUILT_IN, repo)
      .map(row => ({
        cycleId: Number((row as Record<string, unknown>)["cycle_id"]),
        taskRef: Number((row as Record<string, unknown>)["task_ref"]),
        taskId: String((row as Record<string, unknown>)["task_id"]),
        cursor: Number((row as Record<string, unknown>)["cursor"]),
      }));
  }

  /**
   * The PROVING admission (E3d): create the next entry's run from a
   * pending-admission cycle, with EVERY authority re-derived inside one
   * transaction — the approved chain must still stand and match the cycle's
   * digest, the entry at the cursor must exist, the LIVE signed mode must
   * still grant the paid fallback (revocation between advance and admission
   * denies), and the exact unconsumed pending edge is consumed by the run
   * it creates (admitFallback's single-use CAS). The caller carries only
   * claim, worktree, and rail; nothing it asserts becomes authority.
   */
  admitNextChainEntry(
    cycleId: number,
    run: { leaseId: string; runner: string; branch: string; worktree: string },
    now: Date,
  ):
    | { ok: true; runId: number; taskId: string; provider: string; model: string }
    | { ok: false; reason: "not-pending" | "stale-approval" | "grant-withheld" | "no-edge" | "raced" } {
    return this.transact(() => {
      const cycle = this.db.prepare("SELECT * FROM fallback_cycle WHERE id = ?").get(cycleId);
      if (cycle === undefined) return { ok: false as const, reason: "not-pending" as const };
      const c = readFallbackCycle(cycle as Record<string, unknown>);
      if (c.state !== "pending-admission") return { ok: false as const, reason: "not-pending" as const };
      // Task and repo are DERIVED from the cycle's own task_ref (Codex E3d
      // review, finding 7) — never accepted from the caller, so a mismatched
      // call can't marry task B's approval to task A's cycle.
      const owner = this.db
        .prepare("SELECT external_id, repo FROM task_ref WHERE id = ? AND backend = ?")
        .get(c.taskRef, BUILT_IN);
      const taskId = owner === undefined ? null : String((owner as Record<string, unknown>)["external_id"]);
      const repo = owner === undefined ? null : ((owner as Record<string, unknown>)["repo"] as string | null);
      if (taskId === null || repo === null) {
        this.incidentFallback(c.id, c.transitionGeneration, "cycle-task-unresolvable", now);
        return { ok: false as const, reason: "stale-approval" as const };
      }
      const chain = this.approvedChainOf(taskId);
      if (chain === null || chainDigestOf(chain) !== c.chainDigest) {
        this.incidentFallback(c.id, c.transitionGeneration, "approved-chain-invalid-at-admission", now);
        return { ok: false as const, reason: "stale-approval" as const };
      }
      const entry = chain[c.cursor];
      if (entry === undefined) {
        this.incidentFallback(c.id, c.transitionGeneration, "cursor-beyond-approved-chain", now);
        return { ok: false as const, reason: "stale-approval" as const };
      }
      // The paid-fallback grant, re-proved at the MONEY moment: an advance
      // was granted, but a mode revoked since must still deny the spend.
      const liveGrant = modeTermsFromJson(this.activeMode(repo, now)?.termsJson ?? null)?.allowPaidFallback === true;
      if (!liveGrant) {
        this.closeFallbackCycle(c.id, c.transitionGeneration, "grant-withheld", now);
        return { ok: false as const, reason: "grant-withheld" as const };
      }
      const edge = this.db
        .prepare("SELECT id FROM fallback_transition WHERE cycle = ? AND to_index = ? AND consumed_by IS NULL ORDER BY id DESC LIMIT 1")
        .get(c.id, c.cursor);
      if (edge === undefined) {
        this.incidentFallback(c.id, c.transitionGeneration, "no-unconsumed-edge-at-admission", now);
        return { ok: false as const, reason: "no-edge" as const };
      }
      const admitted = this.admitFallback(
        {
          cycleId: c.id,
          expectGeneration: c.transitionGeneration,
          expectCursor: c.cursor,
          transitionId: Number((edge as Record<string, unknown>)["id"]),
          run: {
            taskRef: c.taskRef,
            leaseId: run.leaseId,
            runner: run.runner,
            branch: run.branch,
            worktree: run.worktree,
            provider: entry.profile.provider,
            model: entry.profile.model,
          },
          entryDigest: entryDigestOf(entry),
          authMode: entry.authMode,
        },
        now,
      );
      if (!admitted.ok) return { ok: false as const, reason: "raced" as const };
      return { ok: true as const, runId: admitted.runId, taskId, provider: entry.profile.provider, model: entry.profile.model };
    });
  }

  /**
   * A repair/resume child inherits its parent's chain binding VERBATIM
   * (Codex E3d review, finding 2): the pinned entry — auth mode included —
   * follows the custody, so a repair turn can never spend under the mutable
   * per-provider auth file when its parent was pinned. First-write on the
   * child; a no-op when the parent carries no binding.
   */
  inheritChainBinding(childRun: number, parentRun: number): void {
    this.db
      .prepare(
        `UPDATE run SET
           chain_cycle = (SELECT chain_cycle FROM run WHERE id = ?2),
           chain_index = (SELECT chain_index FROM run WHERE id = ?2),
           entry_digest = (SELECT entry_digest FROM run WHERE id = ?2),
           auth_mode = (SELECT auth_mode FROM run WHERE id = ?2)
         WHERE id = ?1 AND chain_cycle IS NULL
           AND (SELECT chain_cycle FROM run WHERE id = ?2) IS NOT NULL`,
      )
      .run(childRun, parentRun);
  }

  /**
   * The PARKED-RESUME custody transfer (Codex E3d review, finding 5): the
   * ONE road a chain cycle's tail moves to a successor run — proved, never
   * re-tagged in passing. In one transaction: the parent must carry the
   * binding, its cycle must be OPEN with the parent as tail at the parent's
   * index, and the parent must have parked (the paused-lineage state).
   * The successor inherits the binding and becomes the tail.
   */
  resumeChainCustody(parkedRun: number, resumeRun: number, now: Date): boolean {
    return this.transact(() => {
      const parent = this.getRun(parkedRun);
      if (parent === null || parent.chainCycle == null || parent.outcome !== "parked") return false;
      const cycle = this.fallbackCycleFor(parent.taskRef);
      if (
        cycle === null ||
        cycle.id !== parent.chainCycle ||
        cycle.state !== "open" ||
        cycle.tailRun !== parkedRun ||
        cycle.cursor !== parent.chainIndex
      ) {
        return false;
      }
      this.inheritChainBinding(resumeRun, parkedRun);
      const moved = this.db
        .prepare("UPDATE fallback_cycle SET tail_run = ?, updated_at = ? WHERE id = ? AND state = 'open' AND tail_run = ?")
        .run(resumeRun, now.toISOString(), cycle.id, parkedRun);
      return Number(moved.changes) > 0;
    });
  }

  /**
   * The PRE-SPAWN custody proof (Codex E3d review, finding 3): the LAST
   * gate before a chain-bound run's provider process starts, coupled to the
   * start stamp in ONE transaction so nothing can lapse between the proof
   * and the money. Re-derives, from durable state only: the approved chain
   * still stands (freshness + digest); the run's cycle is live and OPEN
   * with THIS run as tail at THIS run's index; the entry digest and pinned
   * auth mode still match; and — for any entry past the base — the LIVE
   * signed mode still grants the paid fallback (a base entry is the
   * ordinary approved work and needs no grant). Only when every fact stands
   * is provider_started_at stamped (first-write, with the version when the
   * gateway proved one). Returns false — and stamps NOTHING — otherwise.
   */
  proveChainCustodyForSpawn(runId: number, now: Date, providerVersion?: string): boolean {
    return this.transact(() => {
      const run = this.getRun(runId);
      if (run === null || run.chainCycle == null || run.outcome !== null) return false;
      const owner = this.db
        .prepare("SELECT external_id, repo FROM task_ref WHERE id = ? AND backend = ?")
        .get(run.taskRef, BUILT_IN);
      if (owner === undefined) return false;
      const taskId = String((owner as Record<string, unknown>)["external_id"]);
      const repo = (owner as Record<string, unknown>)["repo"] as string | null;
      const chain = this.approvedChainOf(taskId);
      if (chain === null) return false;
      const cycle = this.fallbackCycleFor(run.taskRef);
      // The custody holder is normally the run itself — but a bounded
      // REPAIR turn spends under its PARENT'S custody (verify round, R2):
      // the parent is still the cycle's open tail while its own attempt
      // mends, and it vouches for exactly its child. Anything else refuses.
      const tailHolds =
        cycle !== null &&
        (cycle.tailRun === runId ||
          (run.role === "repair" && run.parentRun !== null && cycle.tailRun === run.parentRun));
      if (
        cycle === null ||
        cycle.id !== run.chainCycle ||
        cycle.state !== "open" ||
        cycle.cursor !== run.chainIndex ||
        !tailHolds ||
        cycle.chainDigest !== chainDigestOf(chain)
      ) {
        return false;
      }
      const entry = chain[run.chainIndex ?? -1];
      if (entry === undefined || entryDigestOf(entry) !== run.entryDigest || entry.authMode !== run.authMode) {
        return false;
      }
      if ((run.chainIndex ?? 0) > 0) {
        const liveGrant =
          repo !== null && modeTermsFromJson(this.activeMode(repo, now)?.termsJson ?? null)?.allowPaidFallback === true;
        if (!liveGrant) return false;
      }
      if (providerVersion !== undefined) {
        this.db
          .prepare("UPDATE run SET provider_started_at = COALESCE(provider_started_at, ?), provider_version = ? WHERE id = ?")
          .run(now.toISOString(), providerVersion, runId);
      } else {
        this.db
          .prepare("UPDATE run SET provider_started_at = COALESCE(provider_started_at, ?) WHERE id = ?")
          .run(now.toISOString(), runId);
      }
      return true;
    });
  }

  /**
   * open -> sanitizing (C7): a recognized ELIGIBLE exhaustion of the tail
   * run begins the sanitizer. CAS proves exact state, generation, and tail
   * run; a stale caller loses. Marks the cycle sanitizing so ordinary
   * admission is blocked even if the claim later expires.
   */
  beginFallbackSanitize(cycleId: number, expectGeneration: number, tailRun: number, now: Date): boolean {
    return (
      Number(
        this.db
          .prepare(
            `UPDATE fallback_cycle SET state = 'sanitizing', transition_generation = transition_generation + 1, updated_at = ?
              WHERE id = ? AND state = 'open' AND transition_generation = ? AND tail_run = ?`,
          )
          .run(now.toISOString(), cycleId, expectGeneration, tailRun).changes,
      ) > 0
    );
  }

  /**
   * sanitizing -> awaiting-release (C2/C7): the durable one-step advance.
   * ONE transaction: prove the cycle is sanitizing at this generation and
   * cursor i with this tail run; insert the immutable transition (unique
   * per (cycle, from_index)); advance the cursor to i+1; bump generation.
   * The target index MUST be < chainLength (proven by the caller from the
   * approved snapshot). Returns the new transition id, or null on a lost
   * CAS or an already-recorded step.
   */
  advanceFallbackFenced(
    args: {
      cycleId: number;
      expectGeneration: number;
      fromIndex: number;
      chainLength: number;
      predecessorRun: number;
      terminalClass: string;
      evidence: { provider: string; version: string | null; authMode: string; fp: string };
    },
    now: Date,
  ): { ok: true; transitionId: number; toIndex: number } | { ok: false; reason: "raced" | "at-end" | "dup" } {
    if (args.fromIndex + 1 >= args.chainLength) return { ok: false as const, reason: "at-end" as const };
    // A SAVEPOINT (finding 4): a UNIQUE(cycle, from_index) conflict rolls
    // the cursor move back too, even inside an outer transaction a caller
    // might catch around — never a committed cursor without its transition.
    return this.savepoint(() => {
      // Prove the from-state (no move yet); the state cannot change under
      // us inside the savepoint's serialized transaction.
      const at = this.db
        .prepare("SELECT 1 AS hit FROM fallback_cycle WHERE id = ? AND state = 'sanitizing' AND transition_generation = ? AND cursor = ? AND tail_run = ?")
        .get(args.cycleId, args.expectGeneration, args.fromIndex, args.predecessorRun);
      if (at === undefined) return { ok: false as const, reason: "raced" as const };
      // Insert the transition FIRST: its UNIQUE(cycle, from_index) is the
      // double-advance guard, and on a dup NOTHING has moved yet.
      let transitionId: number;
      try {
        const inserted = this.db
          .prepare(
            `INSERT INTO fallback_transition (cycle, kind, from_index, to_index, predecessor_run, terminal_class, evidence_provider, evidence_version, evidence_auth_mode, evidence_fp, created_at)
             VALUES (?, 'exhaustion', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            args.cycleId,
            args.fromIndex,
            args.fromIndex + 1,
            args.predecessorRun,
            args.terminalClass,
            args.evidence.provider,
            args.evidence.version,
            args.evidence.authMode,
            args.evidence.fp,
            now.toISOString(),
          );
        transitionId = Number(inserted.lastInsertRowid);
      } catch {
        return { ok: false as const, reason: "dup" as const };
      }
      // Only now move the cursor. If this CAS somehow fails, throw so the
      // savepoint rolls the inserted transition back too.
      const moved = this.db
        .prepare(
          `UPDATE fallback_cycle SET state = 'awaiting-release', cursor = cursor + 1, transition_generation = transition_generation + 1, updated_at = ?
            WHERE id = ? AND state = 'sanitizing' AND transition_generation = ? AND cursor = ? AND tail_run = ?`,
        )
        .run(now.toISOString(), args.cycleId, args.expectGeneration, args.fromIndex, args.predecessorRun);
      if (Number(moved.changes) === 0) throw new Error("fallback advance raced its own from-state");
      return { ok: true as const, transitionId, toIndex: args.fromIndex + 1 };
    });
  }

  /** awaiting-release -> pending-admission (C7): the epoch-fenced custody
   * release completed; the next entry is now admittable. */
  releaseFallbackToPending(cycleId: number, expectGeneration: number, now: Date): boolean {
    return (
      Number(
        this.db
          .prepare(
            `UPDATE fallback_cycle SET state = 'pending-admission', tail_run = NULL, transition_generation = transition_generation + 1, updated_at = ?
              WHERE id = ? AND state = 'awaiting-release' AND transition_generation = ?`,
          )
          .run(now.toISOString(), cycleId, expectGeneration).changes,
      ) > 0
    );
  }

  /**
   * pending-admission -> open at the new index (C3): the SINGLE-USE
   * admission. ONE transaction: prove pending at this generation, consume
   * the transition (consumed_by set once — a replay finds it consumed and
   * loses), and open the cycle at the new tail. Returns false on a lost
   * CAS or an already-consumed transition.
   */
  /**
   * The SINGLE-USE admission (Codex E1 review, finding 2): CREATES the next
   * run AND consumes the exact pending edge in ONE savepoint. The consumed
   * transition must be THIS cycle's, unconsumed, and its to_index must
   * EQUAL the cycle's current cursor (so an old unconsumed quota-skip
   * cannot authorize an unrelated admission). The run is opened with the
   * chain metadata (cycle, index, entry digest, auth mode) so nothing
   * downstream can substitute a foreign run. Returns the new run id, or
   * null on a lost CAS / already-consumed edge.
   */
  admitFallback(
    args: {
      cycleId: number;
      expectGeneration: number;
      expectCursor: number;
      transitionId: number;
      run: { taskRef: number; leaseId: string; runner: string; branch: string; worktree: string; provider: string; model?: string };
      entryDigest: string;
      authMode: "subscription" | "api-key";
    },
    now: Date,
  ): { ok: true; runId: number } | { ok: false } {
    return this.savepoint(() => {
      // The pending edge must exist BEFORE anything is created: this cycle,
      // unconsumed, to_index === current cursor, and the cycle
      // pending-admission at the expected generation + cursor.
      const edge = this.db
        .prepare(
          `SELECT 1 AS hit FROM fallback_transition t JOIN fallback_cycle c ON c.id = t.cycle
            WHERE t.id = ? AND t.cycle = ? AND t.consumed_by IS NULL AND t.to_index = c.cursor
              AND c.state = 'pending-admission' AND c.transition_generation = ? AND c.cursor = ?`,
        )
        .get(args.transitionId, args.cycleId, args.expectGeneration, args.expectCursor);
      if (edge === undefined) return { ok: false as const };
      // Open the fallback run WITH its chain metadata, in the same body.
      const inserted = this.db
        .prepare(
          `INSERT INTO run (task_ref, lease_id, runner, branch, worktree, model, role, provider, chain_cycle, chain_index, entry_digest, auth_mode, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'builder', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.run.taskRef,
          args.run.leaseId,
          args.run.runner,
          args.run.branch,
          args.run.worktree,
          args.run.model ?? null,
          args.run.provider,
          args.cycleId,
          args.expectCursor,
          args.entryDigest,
          args.authMode,
          now.toISOString(),
        );
      const runId = Number(inserted.lastInsertRowid);
      // Consume the edge with the real run id — the WHERE re-proves it is
      // still the unconsumed edge at the current cursor (single-use).
      const consumed = this.db
        .prepare(
          `UPDATE fallback_transition SET consumed_by = ?
            WHERE id = ? AND cycle = ? AND consumed_by IS NULL
              AND to_index = (SELECT cursor FROM fallback_cycle WHERE id = ?)`,
        )
        .run(runId, args.transitionId, args.cycleId, args.cycleId);
      if (Number(consumed.changes) === 0) throw new Error("the fallback edge was consumed under us");
      const moved = this.db
        .prepare(
          `UPDATE fallback_cycle SET state = 'open', tail_run = ?, transition_generation = transition_generation + 1, updated_at = ?
            WHERE id = ? AND state = 'pending-admission' AND transition_generation = ? AND cursor = ?`,
        )
        .run(runId, now.toISOString(), args.cycleId, args.expectGeneration, args.expectCursor);
      if (Number(moved.changes) === 0) throw new Error("admission raced the cycle state");
      return { ok: true as const, runId };
    });
  }

  /** open -> open at i+1 via a quota-skip (C7): index 0 (or any) already
   * durably exhausted before dispatch is skipped, one step, recorded. */
  quotaSkipFallback(
    args: { cycleId: number; expectGeneration: number; fromIndex: number; chainLength: number; tailRun: number },
    now: Date,
  ): { ok: true; toIndex: number; transitionId: number } | { ok: false; reason: "raced" | "at-end" | "dup" } {
    if (args.fromIndex + 1 >= args.chainLength) return { ok: false as const, reason: "at-end" as const };
    return this.savepoint(() => {
      const at = this.db
        .prepare("SELECT 1 AS hit FROM fallback_cycle WHERE id = ? AND state = 'open' AND transition_generation = ? AND cursor = ?")
        .get(args.cycleId, args.expectGeneration, args.fromIndex);
      if (at === undefined) return { ok: false as const, reason: "raced" as const };
      // Insert FIRST (the UNIQUE(cycle, from_index) guard); on a dup nothing
      // moved. Nothing RAN at this index, so we go STRAIGHT to
      // pending-admission with the tail cleared — admission is the ONE road
      // that installs the next tail (Codex E1 review, finding 3).
      let transitionId: number;
      try {
        const inserted = this.db
          .prepare("INSERT INTO fallback_transition (cycle, kind, from_index, to_index, predecessor_run, created_at) VALUES (?, 'quota-skip', ?, ?, ?, ?)")
          .run(args.cycleId, args.fromIndex, args.fromIndex + 1, args.tailRun, now.toISOString());
        transitionId = Number(inserted.lastInsertRowid);
      } catch {
        return { ok: false as const, reason: "dup" as const };
      }
      const moved = this.db
        .prepare(
          `UPDATE fallback_cycle SET state = 'pending-admission', tail_run = NULL, cursor = cursor + 1, transition_generation = transition_generation + 1, updated_at = ?
            WHERE id = ? AND state = 'open' AND transition_generation = ? AND cursor = ?`,
        )
        .run(now.toISOString(), args.cycleId, args.expectGeneration, args.fromIndex);
      if (Number(moved.changes) === 0) throw new Error("quota-skip raced its own from-state");
      return { ok: true as const, toIndex: args.fromIndex + 1, transitionId };
    });
  }

  /** Any nonterminal state -> incident (C8): a sanitizer failure, a
   * severed grant, or a policy downgrade pages a human; never silent. */
  /** Any nonterminal -> incident (C8): CAS on the exact generation so a
   * STALE observer cannot terminate a cycle that has since advanced
   * (Codex E1 review, finding 1). */
  incidentFallback(cycleId: number, expectGeneration: number, reason: string, now: Date): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE fallback_cycle SET state = 'incident', closed_reason = ?, transition_generation = transition_generation + 1, updated_at = ? WHERE id = ? AND state NOT IN ('closed','incident') AND transition_generation = ?",
          )
          .run(reason, now.toISOString(), cycleId, expectGeneration).changes,
      ) > 0
    );
  }

  /** A cycle succeeds or exhausts its chain: closed, terminally — CAS on
   * the exact generation (finding 1: a stale success observer cannot close
   * after an advance + admit). */
  closeFallbackCycle(cycleId: number, expectGeneration: number, reason: string, now: Date): boolean {
    return (
      Number(
        this.db
          .prepare("UPDATE fallback_cycle SET state = 'closed', closed_reason = ?, transition_generation = transition_generation + 1, updated_at = ? WHERE id = ? AND state NOT IN ('closed','incident') AND transition_generation = ?")
          .run(reason, now.toISOString(), cycleId, expectGeneration).changes,
      ) > 0
    );
  }

  // ---- the reviewer role (v29) --------------------------------------------

  /**
   * Ask for an agent review of one finished run's sealed diff. Manual
   * (`task review`, the run page) and automatic (a mode whose terms say
   * reviewAuto) requests land through this ONE door, and every refusal is
   * decided transactionally against the same facts the pass will re-prove:
   * the diff must exist and be complete (a truncated artifact is refused
   * HERE, before any money), and the run may only ever gain one review.
   */
  requestReview(
    runId: number,
    by: string,
    now: Date,
    basis?: { kind: "mode"; digest: string },
  ):
    | { ok: true; id: number }
    | {
        ok: false;
        reason:
          | "no-run"
          | "not-reviewable"
          | "unfinished"
          | "no-diff"
          | "diff-capture-failed"
          | "diff-truncated"
          | "already-reviewed"
          | "already-requested";
      } {
    return this.transact(() => {
      const run = this.getRun(runId);
      if (run === null) return { ok: false as const, reason: "no-run" as const };
      // A review reviews work — never another review.
      if (run.role === "reviewer") return { ok: false as const, reason: "not-reviewable" as const };
      if (run.outcome === null) return { ok: false as const, reason: "unfinished" as const };
      const diff = this.artifactsFor(runId).find(one => one.kind === "terminal-diff");
      if (diff === undefined) return { ok: false as const, reason: "no-diff" as const };
      // A failed capture stores the failure's words AS the artifact —
      // reviewing an error message would spend the run's one review on
      // nothing (Codex reviewer round 1, finding 5a).
      if (diff.captureStatus !== "ok") return { ok: false as const, reason: "diff-capture-failed" as const };
      if (diff.truncated) return { ok: false as const, reason: "diff-truncated" as const };
      const reviewed = this.db
        .prepare("SELECT 1 AS hit FROM run WHERE parent_run = ? AND role = 'reviewer' LIMIT 1")
        .get(runId);
      if (reviewed !== undefined) return { ok: false as const, reason: "already-reviewed" as const };
      const inserted = this.db
        .prepare(
          `INSERT INTO review_request (run, requested_by, basis, mode_digest, requested_at)
           SELECT ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM review_request WHERE run = ? AND consumed_at IS NULL)`,
        )
        .run(runId, by, basis === undefined ? "human" : "mode", basis === undefined ? null : basis.digest, now.toISOString(), runId);
      if (Number(inserted.changes) === 0) return { ok: false as const, reason: "already-requested" as const };
      this.bumpWake();
      return { ok: true as const, id: Number(inserted.lastInsertRowid) };
    });
  }

  /** The open review asks, oldest first, with the facts the pass needs. */
  openReviewRequests(): {
    id: number;
    run: number;
    requestedBy: string;
    basis: "human" | "mode";
    modeDigest: string | null;
    requestedAt: string;
    taskRef: number;
    taskId: string;
    repo: string | null;
  }[] {
    return this.db
      .prepare(
        `SELECT rr.id, rr.run, rr.requested_by, rr.basis, rr.mode_digest, rr.requested_at,
                run.task_ref AS taskRef, task_ref.external_id AS taskId, task_ref.repo
           FROM review_request rr
           JOIN run ON run.id = rr.run
           JOIN task_ref ON task_ref.id = run.task_ref
          WHERE rr.consumed_at IS NULL
          ORDER BY rr.id`,
      )
      .all()
      .map(row => ({
        id: Number((row as Record<string, unknown>)["id"]),
        run: Number((row as Record<string, unknown>)["run"]),
        requestedBy: String((row as Record<string, unknown>)["requested_by"]),
        basis: String((row as Record<string, unknown>)["basis"]) as "human" | "mode",
        modeDigest:
          (row as Record<string, unknown>)["mode_digest"] === null
            ? null
            : String((row as Record<string, unknown>)["mode_digest"]),
        requestedAt: String((row as Record<string, unknown>)["requested_at"]),
        taskRef: Number((row as Record<string, unknown>)["taskRef"]),
        taskId: String((row as Record<string, unknown>)["taskId"]),
        repo:
          (row as Record<string, unknown>)["repo"] === null
            ? null
            : String((row as Record<string, unknown>)["repo"]),
      }));
  }

  /** One attempt, whatever it came to (R4): the request is spent, never retried. */
  consumeReviewRequest(id: number, reason: string, now: Date): void {
    this.db
      .prepare("UPDATE review_request SET consumed_at = ?, consumed_reason = ? WHERE id = ? AND consumed_at IS NULL")
      .run(now.toISOString(), reason, id);
  }

  /** How the ledger's spent row learns what the attempt came to. */
  stampReviewRequestOutcome(id: number, reason: string): void {
    this.db.prepare("UPDATE review_request SET consumed_reason = ? WHERE id = ?").run(reason, id);
  }

  /**
   * The ADMISSION (Codex reviewer round 1, findings 4/5b/6): claim the
   * request, re-prove its authority, reserve the rail, and open the
   * reviewer run in ONE transaction — one winner under concurrent passes,
   * one rail reservation per actual start, and a crash after commit
   * leaves a spent request plus an outcome-NULL run row (a visible
   * cut-down attempt, the run table's own honesty) instead of an open
   * request no pass can ever consume.
   *
   * The mode re-proof is EXACT (R-REVOKE): the active mode's digest must
   * equal the digest the request was queued under — a renewal is a new
   * signature and inherits nothing; reviewAuto must still be among its
   * terms. A railed refusal leaves the request OPEN for a later pass.
   */
  admitReview(
    requestId: number,
    spec: { runner: string; provider: string; model: string | null },
    now: Date,
  ):
    | { ok: true; reviewerRunId: number; sourceRun: number; taskRef: number; taskId: string }
    | { ok: false; reason: "gone" | "mode-ended" | "already-reviewed" | "railed"; rail?: string; detail?: string } {
    return this.transact(() => {
      const row = this.db
        .prepare(
          `SELECT rr.run, rr.basis, rr.mode_digest,
                  run.task_ref AS taskRef, task_ref.external_id AS taskId, task_ref.repo
             FROM review_request rr
             JOIN run ON run.id = rr.run
             JOIN task_ref ON task_ref.id = run.task_ref
            WHERE rr.id = ? AND rr.consumed_at IS NULL`,
        )
        .get(requestId) as Record<string, unknown> | undefined;
      if (row === undefined) return { ok: false as const, reason: "gone" as const };
      const sourceRun = Number(row["run"]);
      const repo = row["repo"] === null ? null : String(row["repo"]);
      if (String(row["basis"]) === "mode") {
        const mode = repo === null ? null : this.activeMode(repo, now);
        let reviewAuto = false;
        if (mode !== null && mode.digest === String(row["mode_digest"] ?? "")) {
          try {
            reviewAuto = (JSON.parse(mode.termsJson) as { reviewAuto?: unknown }).reviewAuto === true;
          } catch {
            reviewAuto = false;
          }
        }
        if (!reviewAuto) {
          this.consumeReviewRequest(requestId, "mode-ended", now);
          return { ok: false as const, reason: "mode-ended" as const };
        }
      }
      const reviewed = this.db
        .prepare("SELECT 1 AS hit FROM run WHERE parent_run = ? AND role = 'reviewer' LIMIT 1")
        .get(sourceRun);
      if (reviewed !== undefined) {
        this.consumeReviewRequest(requestId, "already-reviewed", now);
        return { ok: false as const, reason: "already-reviewed" as const };
      }
      if (repo !== null) {
        const railed = this.reserveModeRail(repo, 1, now);
        if (!railed.ok) return { ok: false as const, reason: "railed" as const, rail: railed.rail, detail: railed.detail };
      }
      const reviewerRunId = this.startRun({
        taskRef: Number(row["taskRef"]),
        leaseId: `review:${requestId}:${now.getTime().toString(36)}`,
        runner: spec.runner,
        role: "reviewer",
        parentRun: sourceRun,
        provider: spec.provider,
        ...(spec.model === null ? {} : { model: spec.model }),
        now,
      });
      this.consumeReviewRequest(requestId, "dispatched", now);
      return {
        ok: true as const,
        reviewerRunId,
        sourceRun,
        taskRef: Number(row["taskRef"]),
        taskId: String(row["taskId"]),
      };
    });
  }

  /**
   * The reviewer's comments land through ONE proving transaction (D8):
   * the authoring run must BE a reviewer, must be parented to exactly the
   * commented run, must share its task, and the artifact must be the
   * commented run's own terminal diff. Anything else is an invariant
   * breach — thrown, nothing inserted — because a comment bound to bytes
   * the reviewer never saw is worse than no comment.
   */
  addReviewerComments(
    args: {
      reviewerRunId: number;
      runId: number;
      artifactId: number;
      author: string;
      comments: readonly { path: string; line: number | null; note: string; severity: "note" | "question" | "problem" }[];
    },
    now: Date,
  ): number[] {
    return this.transact(() => {
      const reviewer = this.getRun(args.reviewerRunId);
      if (reviewer === null || reviewer.role !== "reviewer") {
        throw new Error(`run ${args.reviewerRunId} is not a reviewer — only the reviewer role authors reviewer comments`);
      }
      if (reviewer.parentRun !== args.runId) {
        throw new Error(
          `reviewer ${args.reviewerRunId} reviews run ${String(reviewer.parentRun)}, not ${args.runId} — comments bind to the run the review was minted for`,
        );
      }
      const source = this.getRun(args.runId);
      if (source === null || source.taskRef !== reviewer.taskRef) {
        throw new Error(`reviewer ${args.reviewerRunId} and run ${args.runId} do not share a task — nothing is ingested`);
      }
      const artifact = this.artifactsFor(args.runId).find(one => one.id === args.artifactId);
      if (artifact === undefined || artifact.kind !== "terminal-diff") {
        throw new Error(`artifact ${args.artifactId} is not run ${args.runId}'s terminal diff — comments bind to the exact bytes reviewed`);
      }
      const ids: number[] = [];
      for (const comment of args.comments) {
        const inserted = this.db
          .prepare(
            `INSERT INTO diff_comment (artifact, artifact_sha, run, path, line, note, author, created_at, reviewer_run, severity)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            args.artifactId,
            artifact.sha256,
            args.runId,
            comment.path,
            comment.line,
            comment.note,
            args.author,
            now.toISOString(),
            args.reviewerRunId,
            comment.severity,
          );
        ids.push(Number(inserted.lastInsertRowid));
      }
      return ids;
    });
  }

  /** Stamp a task as the revision it is: source task + immutable brief. */
  markRevision(taskRef: number, revisionOf: string, briefArtifact: number): void {
    this.db
      .prepare("UPDATE task_ref SET revision_of = ?, revision_brief_artifact = ? WHERE id = ?")
      .run(revisionOf, briefArtifact, taskRef);
  }

  /**
   * Seal a revision in ONE transaction (Codex M5-M8 audit, C-3): the task
   * with its INHERITED scope limits, the brief's artifact row, the
   * revision relation, and — when comments are being consumed — exactly
   * the expected batch, or the whole seal rolls back. The brief FILE is
   * written by the caller before this runs; a file whose transaction
   * failed is an orphan on disk, not authority — no artifact row points
   * at it. Two concurrent seals race on the comment consumption count and
   * exactly one wins.
   */
  sealRevision(
    args: {
      task: { id?: string; title: string; repo?: string; goal: string; outOfScope?: string | null; touches?: string[]; budgetMicrousd?: number | null; posture?: "escalated" };
      artifact: { run: number; kind: Artifact["kind"]; key: string; bytesOriginal: number; bytesStored: number; truncated: boolean; sha256: string; capture: string };
      revisionOf: string;
      /** Comments to consume, or null when the brief has no comment batch (CI repair). */
      commentIds: readonly number[] | null;
      sourceRun: number;
    },
    now: Date,
  ): { ok: true; id: string; artifactId: number } | { ok: false; reason: string } {
    try {
      return this.transact(() => {
        const made = this.createConsoleTask({ ...args.task, filedVia: "revision" }, now);
        if (!made.ok) return { ok: false as const, reason: made.reason };
        const artifactId = this.saveArtifact(args.artifact, now);
        const ref = this.lookupRef(made.id);
        if (ref === null) throw new Error("the task this transaction just created has no ref — impossible, roll back");
        this.markRevision(ref.id, args.revisionOf, artifactId);
        if (args.commentIds !== null) {
          const consumed = this.consumeDiffComments(args.sourceRun, args.commentIds, made.id);
          if (consumed !== args.commentIds.length) {
            throw new Error("another seal took part of this batch — nothing is half-sealed, roll back");
          }
        }
        return { ok: true as const, id: made.id, artifactId };
      });
    } catch (error) {
      return { ok: false, reason: String((error as Error).message ?? error) };
    }
  }

  notesForRun(runId: number): { id: number; author: string; note: string; createdAt: string }[] {
    return this.db
      .prepare("SELECT * FROM run_note WHERE run = ? ORDER BY id")
      .all(runId)
      .map(row => ({
        id: Number(row["id"]),
        author: String(row["author"]),
        note: String(row["note"]),
        createdAt: String(row["created_at"]),
      }));
  }

  listWorktrees(): WorktreeRow[] {
    return this.db.prepare("SELECT * FROM worktree ORDER BY path").all().map(readWorktree);
  }

  /**
   * Hand back every worktree a dead runner held, unverified.
   *
   * Nobody watched what its process was doing when it stopped, so what is on
   * disk describes the past rather than the present. Marking these verified
   * would be asserting something we did not check.
   */
  releaseWorktreesOf(runner: string, now: Date): string[] {
    const held = this.db
      .prepare("SELECT path FROM worktree WHERE runner = ? AND released_at IS NULL")
      .all(runner)
      .map(row => String(row["path"]));
    if (held.length === 0) return [];

    this.db
      .prepare(
        "UPDATE worktree SET released_at = ?, verified = 0 WHERE runner = ? AND released_at IS NULL",
      )
      .run(now.toISOString(), runner);
    return held;
  }

  // ---- capabilities -------------------------------------------------------

  saveCapability(capability: Capability, mutation: Mutation = {}): void {
    this.once(mutation, "saveCapability", () => {
      this.db
        .prepare(
          `INSERT INTO capability (repo, kind, name, probe, status, added_by, created_at, last_verified_at, verified_by, last_result, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo, kind, name) DO UPDATE SET
             probe = excluded.probe, status = excluded.status,
             last_verified_at = excluded.last_verified_at,
             verified_by = excluded.verified_by, last_result = excluded.last_result,
             expires_at = excluded.expires_at`,
        )
        .run(
          capability.repo,
          capability.kind,
          capability.name,
          capability.probe,
          capability.status,
          capability.addedBy,
          capability.createdAt,
          capability.lastVerifiedAt,
          capability.verifiedBy,
          capability.lastResult,
          capability.expiresAt,
        );
      return null;
    });
  }

  getCapability(repo: string, kind: string, name: string): Capability | null {
    const row = this.db
      .prepare("SELECT * FROM capability WHERE repo = ? AND kind = ? AND name = ?")
      .get(repo, kind, name);
    return row === undefined ? null : readCapability(row);
  }

  /** By name alone, any kind — how a task requirement refers to one. */
  capabilityNamed(repo: string, name: string): Capability | null {
    const row = this.db
      .prepare("SELECT * FROM capability WHERE repo = ? AND name = ? ORDER BY kind LIMIT 1")
      .get(repo, name);
    return row === undefined ? null : readCapability(row);
  }

  listCapabilities(repo: string): Capability[] {
    return this.db
      .prepare("SELECT * FROM capability WHERE repo = ? ORDER BY kind, name")
      .all(repo)
      .map(readCapability);
  }

  /**
   * Record a probe's answer. Verification carries the moment it happened,
   * because "verified" is always a claim about a time (§3: presence is not
   * enough, and neither is a stale yes).
   */
  markCapability(
    repo: string,
    kind: string,
    name: string,
    outcome: { status: "verified" | "failed"; by: string; detail?: string },
    now: Date,
    expiresAt: string | null = null,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE capability SET status = ?, last_verified_at = ?, verified_by = ?, last_result = ?, expires_at = COALESCE(?, expires_at)
          WHERE repo = ? AND kind = ? AND name = ?`,
      )
      .run(
        outcome.status,
        outcome.status === "verified" ? now.toISOString() : null,
        outcome.by,
        outcome.detail ?? null,
        expiresAt,
        repo,
        kind,
        name,
      );
    // A gap that just filled ends its notification episode: the next failure
    // is a new fact, and must be allowed to say so.
    if (Number(changes) > 0 && outcome.status === "verified") {
      this.clearGapEpisode(repo, kind, name);
      this.bumpWake();
    }
    return Number(changes) > 0;
  }

  /** Set what a task needs, as `kind:name` keys, replacing what it needed before. */
  setRequirements(taskRef: number, keys: readonly string[], mutation: Mutation = {}): boolean {
    return this.once(mutation, "setRequirements", () => {
      const { changes } = this.db
        .prepare("UPDATE task_ref SET capability_requirements = ? WHERE id = ?")
        .run(JSON.stringify([...keys]), taskRef);
      return Number(changes) > 0;
    });
  }

  /**
   * The operator's answer to a stall: one transaction that resolves the
   * task's open incidents (lifting their holds), clears strikes and any
   * backoff, and returns the task to the queue. The authenticated act that
   * un-decides "this stopped being worth retrying".
   *
   * Requeueability is re-proved HERE, not by whoever rendered the button: a
   * task is requeueable when it is failed or carries an unresolved
   * incident, and nothing holds a live claim on it. A stale form submitted
   * after the world moved gets a refusal, never a silent erase of somebody
   * else's incident and backoff state.
   */
  /**
   * Whether a still-current, unexpired claim holds this task right now — the
   * one predicate cancel, requeue, and scope edits all defer to, because a
   * console act that ignored a live runner would be overwritten by that
   * runner's completion minutes later.
   */
  hasLiveClaim(taskRef: number, now: Date): boolean {
    return this.currentLiveLease(taskRef, now) !== null;
  }

  /**
   * The lease currently holding this task — the MAXIMUM claim generation,
   * still unreleased, strictly unexpired — or null. This is the one fact
   * "is this run live" derives from: a run is being built right now iff its
   * outcome is null AND its lease is this lease. `liveClaimByLease` proves
   * only that a lease exists; it cannot prove the lease is current, so it
   * must never stand in for this.
   */
  currentLiveLease(taskRef: number, now: Date): string | null {
    const live = this.db
      .prepare(
        `SELECT lease_id FROM claim
          WHERE task_ref = ? AND released_at IS NULL AND expires_at > ?
            AND lease_generation = (
              SELECT MAX(newest.lease_generation) FROM claim AS newest
              WHERE newest.task_ref = claim.task_ref
            )`,
      )
      .get(taskRef, now.toISOString());
    return live === undefined ? null : String(live["lease_id"]);
  }

  requeueTask(
    taskId: string,
    by: string,
    now: Date,
  ):
    | { ok: true; resolvedIncidents: number }
    | { ok: false; reason: "unknown-task" | "not-stalled" | "claimed" } {
    return this.transact(() => {
      const ref = this.db
        .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
        .get(BUILT_IN, taskId);
      if (ref === undefined) return { ok: false as const, reason: "unknown-task" as const };
      const taskRef = Number(ref["id"]);

      const stamp = now.toISOString();
      if (this.hasLiveClaim(taskRef, now)) return { ok: false as const, reason: "claimed" as const };

      const incidents = this.db
        .prepare(
          `SELECT incident.id FROM incident
           JOIN run ON run.id = incident.run
           WHERE run.task_ref = ? AND incident.resolved_at IS NULL`,
        )
        .all(taskRef)
        .map(row => Number(row["id"]));
      const state = this.db.prepare("SELECT state FROM task WHERE id = ?").get(taskId);
      if (incidents.length === 0 && String(state?.["state"]) !== "failed") {
        return { ok: false as const, reason: "not-stalled" as const };
      }

      for (const incident of incidents) this.resolveIncidentLocked(incident, by, now);

      this.resetStrikes(taskRef);
      this.db
        .prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state IN ('failed','queued')")
        .run(stamp, taskId);
      // The stall's page is answered by the act itself.
      this.resolveEpisode(`stalled:${taskRef}`, now);
      this.bumpWake();
      return { ok: true as const, resolvedIncidents: incidents.length };
    });
  }

  /**
   * Cancel, aware of who might be building right now. A live claim wins:
   * cancelling under a runner would let its completion overwrite the
   * cancellation minutes later, so the answer is a refusal that names the
   * holder — stop the claim first (or let it lapse), then cancel.
   */
  cancelTask(
    taskId: string,
    now: Date,
    reason?: string,
  ): { ok: true } | { ok: false; reason: "unknown-task" | "claimed" | "already-terminal" } {
    return this.transact(() => {
      const ref = this.db
        .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
        .get(BUILT_IN, taskId);
      if (ref === undefined) return { ok: false as const, reason: "unknown-task" as const };

      if (this.hasLiveClaim(Number(ref["id"]), now)) return { ok: false as const, reason: "claimed" as const };

      const done = this.applyCancellation(
        taskId,
        { kind: "operator", text: reason ?? null },
        now,
        ["queued", "failed", "running"],
      );
      if (!done.changed) return { ok: false as const, reason: "already-terminal" as const };
      this.bumpWake();
      return { ok: true as const };
    });
  }

  /**
   * The console's task creation: admission control and atomicity the CLI's
   * local-trust path does not need. One transaction checks the active
   * backlog (queued + running below the cap), validates the writable
   * fields' caps and control rules — these strings will be rendered to
   * every surface — and creates the task, its placement, and its optional
   * scope together or not at all.
   */
  createConsoleTask(
    spec: {
      id?: string;
      title: string;
      repo?: string;
      goal?: string;
      /** Mode filing defaults (C1/C7, people round-1 f2): the budget and
       * escalated posture ride the FILING, before the digest is computed —
       * never stamped after the fact. */
      budgetMicrousd?: number | null;
      posture?: "escalated";
      /** Revision tasks inherit these from the source scope (Codex M5-M8
       * audit, IV-2): a revision that silently drops the original's
       * exclusions and path limits is an approval screen claiming "no
       * exclusions" over work that had them. */
      outOfScope?: string | null;
      touches?: string[];
      /** Immutable provenance (v12): which door filed this. Stamped in the
       * same transaction as the create; there is no API to change it. */
      filedVia?: string;
    },
    now: Date,
    cap = 500,
  ):
    | { ok: true; id: string }
    | { ok: false; reason: "backlog-full" | "bad-id" | "bad-title" | "bad-goal" | "duplicate" } {
    if (spec.id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(spec.id)) {
      return { ok: false, reason: "bad-id" };
    }
    if (spec.title.trim() === "" || spec.title.length > 200 || hasForbiddenControls(spec.title)) {
      return { ok: false, reason: "bad-title" };
    }
    if (spec.goal !== undefined && (spec.goal.trim() === "" || spec.goal.length > 2_000 || hasForbiddenControls(spec.goal))) {
      return { ok: false, reason: "bad-goal" };
    }
    return this.transact(() => {
      const backlog = this.db
        .prepare("SELECT COUNT(*) AS n FROM task WHERE state IN ('queued','running')")
        .get();
      if (Number(backlog?.["n"] ?? 0) >= cap) return { ok: false as const, reason: "backlog-full" as const };

      // No id given: slug the title, uniquified inside this same transaction
      // so two concurrent creates cannot mint the same one.
      let id = spec.id;
      if (id === undefined) {
        const base =
          spec.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "task";
        id = base;
        for (let n = 2; this.db.prepare("SELECT 1 AS hit FROM task WHERE id = ?").get(id) !== undefined; n++) {
          id = `${base}-${n}`;
        }
      } else if (this.db.prepare("SELECT 1 AS hit FROM task WHERE id = ?").get(id) !== undefined) {
        return { ok: false as const, reason: "duplicate" as const };
      }

      this.createTask({ id, title: spec.title.trim() }, now);
      const ref = this.refFor(BUILT_IN, id, "ours");
      if (spec.filedVia !== undefined) {
        this.db.prepare("UPDATE task_ref SET filed_via = ? WHERE id = ? AND filed_via IS NULL").run(spec.filedVia, ref.id);
      }
      // Placement happens BEFORE the scope exists, so the immutability guard
      // in placeTask never fires here — atomic create, place, then scope.
      if (spec.repo !== undefined && spec.repo !== "") this.placeTask(ref.id, spec.repo);
      if (spec.goal !== undefined) {
        const draft = {
          goal: spec.goal.trim(),
          outOfScope: spec.outOfScope ?? null,
          touches: spec.touches ?? ([] as string[]),
        };
        const budgeted = { ...draft, budgetMicrousd: spec.budgetMicrousd ?? null };
        this.saveScope(
          {
            taskId: id,
            ...budgeted,
            proposedAt: now.toISOString(),
            digest: digestOf(budgeted),
            approvedAt: null,
            approvedBy: null,
            approvedDigest: null,
          },
          {},
          spec.posture === undefined ? {} : { posture: spec.posture },
        );
      }
      return { ok: true as const, id };
    });
  }

  /**
   * Tasks stranded behind a terminally failed or cancelled blocker — work
   * that will never become ready, silently, unless somebody looks. Derived,
   * never stored; edges are preserved, and `task requeue <blocker>` is the
   * way out.
   */
  strandedTasks(repo: string | null = null): { id: string; blockedBy: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT task_edge.blocked AS id, task_edge.blocker AS blocker FROM task_edge
         JOIN task AS dependent ON dependent.id = task_edge.blocked AND dependent.state = 'queued'
         JOIN task AS blocker ON blocker.id = task_edge.blocker AND blocker.state IN ('failed','cancelled')
         JOIN task_ref ON task_ref.backend = '${'built-in'}' AND task_ref.external_id = task_edge.blocked
         WHERE (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY task_edge.blocked, task_edge.blocker`,
      )
      .all(repo, repo);
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const id = String(row["id"]);
      grouped.set(id, [...(grouped.get(id) ?? []), String(row["blocker"])]);
    }
    return [...grouped.entries()].map(([id, blockedBy]) => ({ id, blockedBy }));
  }

  /** One more consecutive failure. Returns the new count. */
  /**
   * The operator's explicit ask: plan this before anything builds. Refused
   * transactionally when the moment has passed — an approved scope means
   * the promise is already made, a live claim means the machine is already
   * spending, and a plan already under way needs no second request.
   */
  requestPlan(taskRef: number, now: Date): { ok: true } | { ok: false; reason: string } {
    return this.transact(() => {
      const ref = this.db.prepare("SELECT * FROM task_ref WHERE id = ?").get(taskRef);
      if (ref === undefined) return { ok: false as const, reason: "no such task reference" };
      const task = this.db
        .prepare("SELECT state FROM task WHERE id = ?")
        .get(String(ref["external_id"]));
      if (task === undefined) return { ok: false as const, reason: "no such task" };
      if (String(task["state"]) !== "queued") {
        return { ok: false as const, reason: `state is ${String(task["state"])}, not queued` };
      }
      if (ref["plan"] !== null && ref["plan"] !== undefined) {
        return { ok: false as const, reason: `a plan is already ${String(ref["plan"])}` };
      }
      const approved = this.db
        .prepare(
          `SELECT 1 AS hit FROM task_scope
           WHERE task_id = ? AND approved_digest = digest AND approved_at IS NOT NULL`,
        )
        .get(String(ref["external_id"]));
      if (approved !== undefined) {
        return { ok: false as const, reason: "the scope is already approved — planning happens before the promise, not after" };
      }
      const live = this.db
        .prepare(
          `SELECT 1 AS hit FROM claim WHERE task_ref = ? AND released_at IS NULL AND expires_at > ?`,
        )
        .get(taskRef, now.toISOString());
      if (live !== undefined) {
        return { ok: false as const, reason: "a runner holds this task right now" };
      }
      this.db.prepare("UPDATE task_ref SET plan = 'requested' WHERE id = ?").run(taskRef);
      this.bumpWake();
      return { ok: true as const };
    });
  }

  /** Plan pins (P2/C7): separate columns, read ONLY by the plan phase,
   * with a mutation cutoff — a live plan claim means the pinned pair is
   * already spending, and rerouting a spend mid-flight is not a pin. */
  setPlanPins(
    taskRef: number,
    provider: string,
    model: string | null,
    now: Date,
  ): { ok: true } | { ok: false; reason: "live-claim" } {
    return this.transact(() => {
      const live = this.db
        .prepare("SELECT 1 AS hit FROM claim WHERE task_ref = ? AND released_at IS NULL AND expires_at > ? LIMIT 1")
        .get(taskRef, now.toISOString());
      if (live !== undefined) return { ok: false as const, reason: "live-claim" as const };
      this.db.prepare("UPDATE task_ref SET plan_provider = ?, plan_model = ? WHERE id = ?").run(provider, model, taskRef);
      return { ok: true as const };
    });
  }

  /** Move the planning state; null clears it. Caller owns the transaction story. */
  setPlanState(taskRef: number, state: "requested" | "drafted" | null): void {
    this.db.prepare("UPDATE task_ref SET plan = ? WHERE id = ?").run(state, taskRef);
  }

  addPlanStrike(taskRef: number): number {
    this.db.prepare("UPDATE task_ref SET plan_strikes = plan_strikes + 1 WHERE id = ?").run(taskRef);
    const row = this.db.prepare("SELECT plan_strikes FROM task_ref WHERE id = ?").get(taskRef);
    return Number(row?.["plan_strikes"] ?? 0);
  }

  resetPlanStrikes(taskRef: number): void {
    this.db.prepare("UPDATE task_ref SET plan_strikes = 0 WHERE id = ?").run(taskRef);
  }

  addStrike(taskRef: number): number {
    this.db.prepare("UPDATE task_ref SET strikes = strikes + 1 WHERE id = ?").run(taskRef);
    const row = this.db.prepare("SELECT strikes FROM task_ref WHERE id = ?").get(taskRef);
    return Number(row?.["strikes"] ?? 0);
  }

  /**
   * A concluded success — built, no-change, or parked — ends the streak and
   * lifts any backoff still standing from it.
   */
  resetStrikes(taskRef: number): void {
    this.db.prepare("UPDATE task_ref SET strikes = 0 WHERE id = ?").run(taskRef);
    this.releaseOwnedHold("backoff", String(taskRef));
  }

  /** Say which repository a task's work lives in. */
  /**
   * Placement is immutable once a scope exists: an approval restates a goal
   * *for a project*, and moving the task afterwards would re-aim the yes at
   * a repo nobody agreed to. Place first, then scope — or requeue a fresh
   * task. (Console v2 review, finding 3.)
   */
  placeTask(
    taskRef: number,
    repo: string,
    mutation: Mutation = {},
  ): boolean | { ok: false; reason: "scoped" } {
    return this.once(mutation, "placeTask", () => {
      return this.transact(() => {
        const external = this.db
          .prepare("SELECT external_id FROM task_ref WHERE id = ?")
          .get(taskRef);
        if (external !== undefined) {
          const scoped = this.db
            .prepare("SELECT 1 AS hit FROM task_scope WHERE task_id = ?")
            .get(String(external["external_id"]));
          const current = this.db.prepare("SELECT repo FROM task_ref WHERE id = ?").get(taskRef);
          const already = current?.["repo"] === null ? null : String(current?.["repo"]);
          if (scoped !== undefined && already !== repo) {
            return { ok: false as const, reason: "scoped" as const };
          }
        }
        const { changes } = this.db
          .prepare("UPDATE task_ref SET repo = ? WHERE id = ?")
          .run(repo, taskRef);
        return Number(changes) > 0;
      });
    });
  }

  /**
   * The newest moment a provider provably worked here: a stamped, concluded
   * success. Historical proof only — it says "was authenticated then",
   * never "is authenticated now".
   */
  providerLastSuccess(provider: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(started_at) AS at FROM run
          WHERE provider = ? AND provider_started_at IS NOT NULL
            AND outcome IN ('built','parked','no-change')`,
      )
      .get(provider);
    return row?.["at"] === null || row?.["at"] === undefined ? null : String(row["at"]);
  }

  // ---- phase configuration ------------------------------------------------

  /** One phase's configured agent at one scope, or null. */
  phaseConfig(scope: string, phase: string): { provider: string; model: string | null; updatedAt: string; updatedBy: string } | null {
    const row = this.db
      .prepare("SELECT * FROM phase_config WHERE scope = ? AND phase = ?")
      .get(scope, phase);
    return row === undefined
      ? null
      : {
          provider: String(row["provider"]),
          model: row["model"] === null ? null : String(row["model"]),
          updatedAt: String(row["updated_at"]),
          updatedBy: String(row["updated_by"]),
        };
  }

  listPhaseConfig(scope: string): { phase: string; provider: string; model: string | null; updatedAt: string; updatedBy: string }[] {
    return this.db
      .prepare("SELECT * FROM phase_config WHERE scope = ? ORDER BY phase")
      .all(scope)
      .map(row => ({
        phase: String(row["phase"]),
        provider: String(row["provider"]),
        model: row["model"] === null ? null : String(row["model"]),
        updatedAt: String(row["updated_at"]),
        updatedBy: String(row["updated_by"]),
      }));
  }

  /** Write one complete pair. Audited: who changed spend routing, and when. */
  setPhaseConfig(scope: string, phase: string, provider: string, model: string | null, by: string, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO phase_config (scope, phase, provider, model, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, phase) DO UPDATE SET
           provider = excluded.provider, model = excluded.model,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(scope, phase, provider, model, now.toISOString(), by);
  }

  /** The ordered FALLBACK entries after the base, for a scope's build
   * phase (v30). Each entry: {provider, model, authMode, repairModel?}.
   * Returns [] when none configured — a chain-of-one is the base alone. */
  fallbackConfig(scope: string): { provider: string; model: string; authMode: "subscription" | "api-key"; repairModel?: string }[] {
    const row = this.db.prepare("SELECT entries_json FROM fallback_config WHERE scope = ? AND phase = 'build'").get(scope);
    if (row === undefined) return [];
    try {
      const parsed = JSON.parse(String(row["entries_json"]));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  setFallbackConfig(
    scope: string,
    entries: { provider: string; model: string; authMode: "subscription" | "api-key"; repairModel?: string }[],
    by: string,
    now: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO fallback_config (scope, phase, entries_json, updated_at, updated_by)
         VALUES (?, 'build', ?, ?, ?)
         ON CONFLICT (scope, phase) DO UPDATE SET
           entries_json = excluded.entries_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(scope, JSON.stringify(entries), now.toISOString(), by);
  }

  clearFallbackConfig(scope: string): boolean {
    return Number(this.db.prepare("DELETE FROM fallback_config WHERE scope = ? AND phase = 'build'").run(scope).changes) > 0;
  }

  clearPhaseConfig(scope: string, phase: string): boolean {
    const { changes } = this.db
      .prepare("DELETE FROM phase_config WHERE scope = ? AND phase = ?")
      .run(scope, phase);
    return Number(changes) > 0;
  }

  /** Pin a task's agent — the fire transaction's stamp; flags never override it. */
  pinTaskAgent(taskRef: number, provider: string, model: string | null): void {
    this.db
      .prepare("UPDATE task_ref SET agent_provider = ?, agent_model = ? WHERE id = ?")
      .run(provider, model, taskRef);
  }

  // ---- routines -----------------------------------------------------------

  /**
   * File a standing order, unapproved. The digest is computed by the caller
   * (routineDigestOf) from exactly the terms stored here; approval later
   * binds to it. Nothing fires until a person agrees to the template.
   */
  createRoutine(
    spec: {
      name: string;
      repo: string;
      goal: string;
      outOfScope: string | null;
      touches: string[];
      requirements: string[];
      schedule: string;
      singleFlight: boolean;
      costCeilingUsd: number | null;
      budgetPerRunMicrousd?: number | null;
      digest: string;
      /** Immutable provenance (v12), same contract as createConsoleTask's. */
      filedVia?: string;
      /** v24: resolved at filing by the caller who computed the digest —
       * stored verbatim so digest and profile can never disagree. */
      profile?: ExecutionProfile;
    },
    now: Date,
  ): { ok: true; id: number } | { ok: false; reason: "duplicate" } {
    return this.transact(() => {
      const existing = this.db.prepare("SELECT 1 AS hit FROM routine WHERE name = ?").get(spec.name);
      if (existing !== undefined) return { ok: false as const, reason: "duplicate" as const };
      const stamp = now.toISOString();
      const inserted = this.db
        .prepare(
          `INSERT INTO routine
             (name, repo, goal, out_of_scope, touches, requirements, schedule,
              single_flight, cost_ceiling_usd, budget_per_run_microusd, digest, created_at, updated_at, filed_via,
              profile_json, digest_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          spec.name,
          spec.repo,
          spec.goal,
          spec.outOfScope,
          JSON.stringify(spec.touches),
          JSON.stringify(spec.requirements),
          spec.schedule,
          spec.singleFlight ? 1 : 0,
          spec.costCeilingUsd,
          spec.budgetPerRunMicrousd ?? null,
          spec.digest,
          stamp,
          stamp,
          spec.filedVia ?? null,
          spec.profile === undefined ? null : canonicalProfileJson(spec.profile),
          spec.profile === undefined ? 1 : 2,
        );
      return { ok: true as const, id: Number(inserted.lastInsertRowid) };
    });
  }

  /**
   * Set-once installation markers (v12). INSERT OR IGNORE is the whole
   * contract: the first write wins forever, there is no update and no
   * delete, so 'demo' can never be quietly unset and 'first-success-at'
   * survives any later pruning of the rows it was derived from.
   */
  recordInstallationFact(key: string, value: string, now: Date): void {
    this.db
      .prepare("INSERT OR IGNORE INTO installation_fact (key, value, created_at) VALUES (?, ?, ?)")
      .run(key, value, now.toISOString());
  }

  installationFact(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM installation_fact WHERE key = ?").get(key);
    return row === undefined ? null : String(row["value"]);
  }

  /** A database stamped as a demo sandbox: every spending or external-effect
   * entry point fails closed on it (adoption review, finding 8). */
  isDemo(): boolean {
    return this.installationFact("demo") !== null;
  }

  // ---- spend defaults (v15) ----------------------------------------------

  setSpendDefaults(
    defaults: { buildPerRunMicrousd: number | null; racePerAgentMicrousd: number | null; raceTotalMicrousd: number | null; raceAgents?: number | null },
    by: string,
    now: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO spend_defaults (id, build_per_run_microusd, race_per_agent_microusd, race_total_microusd, race_agents, updated_at, updated_by)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           build_per_run_microusd = excluded.build_per_run_microusd,
           race_per_agent_microusd = excluded.race_per_agent_microusd,
           race_total_microusd = excluded.race_total_microusd,
           race_agents = excluded.race_agents,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(defaults.buildPerRunMicrousd, defaults.racePerAgentMicrousd, defaults.raceTotalMicrousd, defaults.raceAgents ?? null, now.toISOString(), by);
  }

  getSpendDefaults(): { buildPerRunMicrousd: number | null; racePerAgentMicrousd: number | null; raceTotalMicrousd: number | null; raceAgents: number | null; updatedBy: string } | null {
    const row = this.db.prepare("SELECT * FROM spend_defaults WHERE id = 1").get();
    if (row === undefined) return null;
    const maybe = (key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]));
    return {
      buildPerRunMicrousd: maybe("build_per_run_microusd"),
      racePerAgentMicrousd: maybe("race_per_agent_microusd"),
      raceTotalMicrousd: maybe("race_total_microusd"),
      raceAgents: maybe("race_agents"),
      updatedBy: String(row["updated_by"]),
    };
  }

  // ---- tournaments (v14): persistence + the CAS primitives ---------------

  /**
   * File a new terms row: the previous active row (if any) deactivates in
   * the same transaction — rows are immutable, the ACTIVE pointer moves.
   * Approval lands later, by the same ceremony that approves the scope.
   */
  /** Withdraw the standing race: the row survives deactivated, exactly as
   * a superseding filing would leave it — the task returns to the ordinary
   * one-agent path. */
  retractTournamentTerms(taskRef: number): boolean {
    const changed = this.db
      .prepare("UPDATE tournament_terms SET active = 0 WHERE task_ref = ? AND active = 1")
      .run(taskRef);
    return Number(changed.changes) > 0;
  }

  fileTournamentTerms(
    spec: {
      taskRef: number;
      /** v27: absent = 'race' (every historical caller). */
      kind?: "race" | "comparison";
      raceDigest: string;
      agents: { provider: string; model: string; repairModel: string }[];
      perAgentBudgetMicrousd: number;
      overrunReserveMicrousd: number;
      totalBudgetMicrousd: number;
      priceVersion: number;
      publicationPolicy: string;
    },
    now: Date,
  ): number {
    return this.transact(() => {
      // D1 (external dispatch, finding 40): external work does not race in
      // this release — the STORE refuses, so no forged POST and no future
      // caller can file race terms on a mirror. UI hiding is convenience.
      const external = this.db
        .prepare(
          `SELECT 1 AS hit FROM external_mirror
            JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = external_mirror.local_task_id
           WHERE task_ref.id = ? LIMIT 1`,
        )
        .get(BUILT_IN, spec.taskRef);
      if (external !== undefined) {
        throw new Error("external work races in a follow-up release — file the tournament on a local task");
      }
      const previous = this.db
        .prepare("SELECT id, generation FROM tournament_terms WHERE task_ref = ? AND active = 1")
        .get(spec.taskRef);
      if (previous !== undefined) {
        this.db.prepare("UPDATE tournament_terms SET active = 0 WHERE id = ?").run(Number(previous["id"]));
      }
      const generation = previous === undefined ? 1 : Number(previous["generation"]) + 1;
      const inserted = this.db
        .prepare(
          `INSERT INTO tournament_terms
             (task_ref, generation, active, kind, race_digest, agents, n, per_agent_budget_microusd,
              overrun_reserve_microusd, total_budget_microusd, price_version, retries,
              publication_policy, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          spec.taskRef,
          generation,
          spec.kind ?? "race",
          spec.raceDigest,
          JSON.stringify(spec.agents),
          spec.agents.length,
          spec.perAgentBudgetMicrousd,
          spec.overrunReserveMicrousd,
          spec.totalBudgetMicrousd,
          spec.priceVersion,
          spec.publicationPolicy,
          now.toISOString(),
        );
      return Number(inserted.lastInsertRowid);
    });
  }

  activeTournamentTerms(taskRef: number): TournamentTerms | null {
    const row = this.db.prepare("SELECT * FROM tournament_terms WHERE task_ref = ? AND active = 1").get(taskRef);
    return row === undefined ? null : readTournamentTerms(row);
  }

  /** Approval persistence only — the restating ceremony wires in later. */
  approveTournamentTerms(id: number, by: string, sawDigest: string, now: Date): boolean {
    const changed = this.db
      .prepare(
        "UPDATE tournament_terms SET approved_at = ?, approved_by = ?, approved_digest = ? WHERE id = ? AND active = 1 AND race_digest = ?",
      )
      .run(now.toISOString(), by, sawDigest, id, sawDigest);
    return Number(changed.changes) === 1;
  }

  createContest(
    spec: { taskRef: number; terms: number; scopeDigest: string; raceDigest: string; kind?: "race" | "comparison" },
    now: Date,
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO contest (task_ref, terms, state, scope_digest, race_digest, created_at, race_semantics, kind)
         VALUES (?, ?, 'dispatching', ?, ?, ?, 2, ?)`,
      )
      .run(spec.taskRef, spec.terms, spec.scopeDigest, spec.raceDigest, now.toISOString(), spec.kind ?? "race");
    return Number(inserted.lastInsertRowid);
  }

  getContest(id: number): Contest | null {
    const row = this.db.prepare("SELECT * FROM contest WHERE id = ?").get(id);
    return row === undefined ? null : readContest(row);
  }

  /** The one non-finished tournament for a task, when one exists. */
  /** The newest tournament still owed to an operator — open states plus
   * the two that end with nothing pickable and wait for a human verdict. */
  contestNeedingOperator(taskRef: number): Contest | null {
    const row = this.db
      .prepare(
        `SELECT * FROM contest WHERE task_ref = ?
           AND state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(taskRef);
    return row === undefined ? null : readContest(row);
  }

  openContestFor(taskRef: number): Contest | null {
    const row = this.db
      .prepare(
        `SELECT * FROM contest WHERE task_ref = ?
           AND state IN ('dispatching','racing','pick-wait','decision-wait')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(taskRef);
    return row === undefined ? null : readContest(row);
  }

  /**
   * Every state change is a compare-and-swap on (state, generation): the
   * caller proves what it believes, the write bumps the generation, and
   * whichever of aggregation, reaping, or crash recovery loses the race
   * changes nothing (finding 17/27).
   */
  casContestState(id: number, from: readonly ContestState[], to: ContestState, expectedGeneration: number): boolean {
    const marks = from.map(() => "?").join(",");
    const changed = this.db
      .prepare(
        `UPDATE contest SET state = ?, generation = generation + 1
          WHERE id = ? AND generation = ? AND state IN (${marks})`,
      )
      .run(to, id, expectedGeneration, ...from);
    return Number(changed.changes) === 1;
  }

  stampContestLease(id: number, leaseId: string, runner: string, incarnation: string | null): void {
    this.db
      .prepare("UPDATE contest SET current_lease_id = ?, runner = ?, incarnation = ? WHERE id = ?")
      .run(leaseId, runner, incarnation, id);
  }

  stampContestDispatch(id: number, baseSha: string, setupDigest: string | null): void {
    this.db.prepare("UPDATE contest SET base_sha = ?, setup_digest = ? WHERE id = ?").run(baseSha, setupDigest, id);
  }

  createContestants(
    contest: number,
    agents: { provider: string; model: string; repairModel: string; branch: string; budgetMicrousd: number; reserveMicrousd: number; unknownSpend?: boolean }[],
  ): number[] {
    return this.transact(() =>
      agents.map((agent, index) => {
        const inserted = this.db
          .prepare(
            `INSERT INTO contestant
               (contest, ordinal, provider, model, repair_model, branch, budget_microusd, reserve_microusd, unknown_spend, profile_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            contest,
            index + 1,
            agent.provider,
            agent.model,
            agent.repairModel,
            agent.branch,
            agent.budgetMicrousd,
            agent.reserveMicrousd,
            // v27 (comparisons): a lane whose harness reports no dollars is
            // PRE-latched — unmeasured is a fact of the lane, not a
            // wait-and-see. Race lanes stay 0 and measure normally.
            agent.unknownSpend === true ? 1 : 0,
            // v24: the contestant's OWN sealed profile — race terms carry
            // exact models already; the effective limits join them here so
            // the dispatch proof holds each lane to its lane.
            canonicalProfileJson(contestantProfileOf(agent.provider, agent.model, agent.repairModel)),
          );
        return Number(inserted.lastInsertRowid);
      }),
    );
  }

  /** The lane's CUMULATIVE wall clock across its whole lineage — main
   * attempt, resumes, and repair children (Phase 3 slice B, Codex
   * finding 1): three sealed clocks bound a comparison lane. */
  contestantCumulativeMs(contestantId: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(
           MAX(0, (julianday(COALESCE(finished_at, provider_started_at)) - julianday(provider_started_at)) * 86400000)
         ), 0) AS total
           FROM run
          WHERE provider_started_at IS NOT NULL
            AND (contestant = ? OR parent_run IN (SELECT id FROM run WHERE contestant = ?))`,
      )
      .get(contestantId, contestantId);
    return Math.round(Number(row?.["total"] ?? 0));
  }

  /** The lane's money and tokens across its WHOLE lineage — main attempt,
   * resumes, and repair children (Codex slice-B finding 6): a lane's cell
   * that reads only the newest run under-reports every park cycle. */
  contestantSpendRollup(contestantId: number): { costMicrousd: number; tokensIn: number; tokensOut: number; measuredRuns: number; totalRuns: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 0 ELSE CAST(ROUND(cost_usd * 1000000) AS INTEGER) END), 0) AS cost,
                COALESCE(SUM(COALESCE(tokens_in, 0)), 0) AS tin,
                COALESCE(SUM(COALESCE(tokens_out, 0)), 0) AS tout,
                SUM(CASE WHEN cost_usd IS NULL THEN 0 ELSE 1 END) AS measured,
                COUNT(*) AS total
           FROM run
          WHERE provider_started_at IS NOT NULL
            AND (contestant = ? OR parent_run IN (SELECT id FROM run WHERE contestant = ?))`,
      )
      .get(contestantId, contestantId);
    return {
      costMicrousd: Number(row?.["cost"] ?? 0),
      tokensIn: Number(row?.["tin"] ?? 0),
      tokensOut: Number(row?.["tout"] ?? 0),
      measuredRuns: Number(row?.["measured"] ?? 0),
      totalRuns: Number(row?.["total"] ?? 0),
    };
  }

  contestants(contest: number): Contestant[] {
    return this.db.prepare("SELECT * FROM contestant WHERE contest = ? ORDER BY ordinal").all(contest).map(readContestant);
  }

  getContestant(id: number): Contestant | null {
    const row = this.db.prepare("SELECT * FROM contestant WHERE id = ?").get(id);
    return row === undefined ? null : readContestant(row);
  }

  casContestantState(
    id: number,
    from: readonly ContestantState[],
    to: ContestantState,
    expectedGeneration: number,
  ): boolean {
    const marks = from.map(() => "?").join(",");
    const changed = this.db
      .prepare(
        `UPDATE contestant SET state = ?, generation = generation + 1
          WHERE id = ? AND generation = ? AND state IN (${marks})`,
      )
      .run(to, id, expectedGeneration, ...from);
    return Number(changed.changes) === 1;
  }

  /** Exactly one live run per agent (finding 22): claiming the pointer
   * requires it empty; a second claimant loses cleanly. */
  claimContestantRun(id: number, runId: number, expectedGeneration: number): boolean {
    const changed = this.db
      .prepare(
        "UPDATE contestant SET active_run = ?, generation = generation + 1 WHERE id = ? AND generation = ? AND active_run IS NULL",
      )
      .run(runId, id, expectedGeneration);
    return Number(changed.changes) === 1;
  }

  releaseContestantRun(id: number, runId: number): void {
    this.db.prepare("UPDATE contestant SET active_run = NULL WHERE id = ? AND active_run = ?").run(id, runId);
  }

  setContestantWorktree(id: number, worktree: string): void {
    this.db.prepare("UPDATE contestant SET worktree = ? WHERE id = ?").run(worktree, id);
  }

  /** The lineage meter (finding 25 + round-2 finding on repairs): each
   * finished invocation settles ONCE, and the agent's total is the SUM
   * across its whole lineage — a park's spend and its resume's spend are
   * both real money. Accounted tracks at least the measured total. */
  recordContestantSpend(id: number, invocationMicrousd: number): void {
    this.db
      .prepare(
        `UPDATE contestant SET
           measured_microusd = measured_microusd + ?,
           accounted_microusd = MAX(accounted_microusd, measured_microusd + ?)
         WHERE id = ?`,
      )
      .run(Math.max(0, invocationMicrousd), Math.max(0, invocationMicrousd), id);
  }

  /** A started invocation that never reported: the ledger charges the FULL
   * reservation — never the remaining amount — and says the real figure is
   * unknown (finding 25). Idempotent; never lowers a larger accounting. */
  latchContestantUnknownSpend(id: number): void {
    this.db
      .prepare(
        `UPDATE contestant SET
           accounted_microusd = MAX(accounted_microusd, budget_microusd + reserve_microusd),
           unknown_spend = 1
         WHERE id = ?`,
      )
      .run(id);
  }

  setContestantCustody(id: number, custody: string | null): void {
    this.db.prepare("UPDATE contestant SET custody = ? WHERE id = ?").run(custody, id);
  }

  /** The cleanup queue (stage 6): agents of DECIDED tournaments whose
   * checkouts still sit outside the pool. Terminal contest states only —
   * an undecided tournament's evidence is never touched. */
  contestantsForCleanup(): Contestant[] {
    return this.db
      .prepare(
        `SELECT contestant.* FROM contestant
         JOIN contest ON contest.id = contestant.contest
         WHERE contest.state IN ('picked','abandoned') AND contestant.cleanup = 'pending'
         ORDER BY contestant.id`,
      )
      .all()
      .map(readContestant);
  }

  /** Exactly-once overdue escalation: the mark rides the page (stage 6). */
  markContestOverduePaged(contestId: number): boolean {
    const changed = this.db
      .prepare("UPDATE contest SET overdue_paged = 1 WHERE id = ? AND overdue_paged = 0")
      .run(contestId);
    return Number(changed.changes) === 1;
  }

  /** The pick, stamped: who chose, when, and which agent won. */
  setContestWinner(contestId: number, contestantId: number, approver: string, now: Date): void {
    this.db
      .prepare("UPDATE contest SET winner_contestant = ?, picked_by = ?, picked_at = ? WHERE id = ?")
      .run(contestantId, approver, now.toISOString(), contestId);
  }

  setContestantCleanup(id: number, cleanup: "pending" | "done" | "attention"): void {
    this.db.prepare("UPDATE contestant SET cleanup = ? WHERE id = ?").run(cleanup, id);
  }

  contestsInStates(states: readonly ContestState[]): Contest[] {
    const marks = states.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM contest WHERE state IN (${marks}) ORDER BY id`).all(...states).map(readContest);
  }

  /** The still-live claim behind a lease id, or null — recovery's question.
   * The clock is INJECTED like everywhere else; SQL wall-clock time would
   * silently disagree with every test's fixed timestamps. */
  liveClaimByLease(leaseId: string, now: Date): { leaseId: string } | null {
    const row = this.db
      .prepare("SELECT lease_id FROM claim WHERE lease_id = ? AND released_at IS NULL AND expires_at >= ?")
      .get(leaseId, now.toISOString());
    return row === undefined ? null : { leaseId: String(row["lease_id"]) };
  }


  /**
   * Close a racing agent's question WITHOUT answering it (the exclude
   * ceremony, round-3 finding 28): typed closure, never a fake option.
   * The caller owns authentication and the contestant's stop.
   */
  excludeDecision(id: number, by: string, now: Date): boolean {
    return this.transact(() => {
      const changed = this.db
        .prepare(
          `UPDATE decision SET state = 'answered', answered_at = ?, answered_by = ?, closed_reason = 'excluded'
            WHERE id = ? AND state IN ('open','expired') AND contestant IS NOT NULL`,
        )
        .run(now.toISOString(), by, id);
      if (Number(changed.changes) !== 1) return false;
      // Closure clears what an answer would have cleared (external
      // dispatch review, finding 43): the decision-owned hold and the
      // page episode — an excluded question must not hold work forever.
      this.releaseOwnedHold("decision", String(id));
      this.resolveEpisode(`decision:${id}`, now);
      this.bumpWake();
      return true;
    });
  }

  /** A racing agent's answered-but-undelivered question, for the resume pass. */
  answeredDecisionForContestant(contestantId: number): number | null {
    const row = this.db
      .prepare(
        `SELECT decision.id AS id FROM decision
          WHERE decision.contestant = ? AND decision.state = 'answered'
            AND (decision.closed_reason IS NULL OR decision.closed_reason != 'excluded')
            AND NOT EXISTS (
              SELECT 1 FROM run_decision
              JOIN run AS delivered ON delivered.id = run_decision.run
              WHERE run_decision.decision = decision.id AND delivered.outcome IS NOT NULL
            )
          LIMIT 1`,
      )
      .get(contestantId);
    return row === undefined ? null : Number(row["id"]);
  }

  /** A racing agent's one open (or expired-but-unanswered) question. */
  openDecisionForContestant(contestantId: number): number | null {
    const row = this.db
      .prepare("SELECT id FROM decision WHERE contestant = ? AND state IN ('open','expired') LIMIT 1")
      .get(contestantId);
    return row === undefined ? null : Number(row["id"]);
  }

  /** Admission binds each reserved slot to its agent, so recovery can
   * find and free every one of them (nothing reserved is ever orphaned). */
  assignSlotContestant(slotId: number, contestantId: number): void {
    this.db.prepare("UPDATE execution_slot SET contestant = ? WHERE id = ?").run(contestantId, slotId);
  }

  releaseSlotsForContest(contestId: number, now: Date): number {
    const changed = this.db
      .prepare(
        `UPDATE execution_slot SET state = 'released', released_at = ?
          WHERE state IN ('reserved','running')
            AND contestant IN (SELECT id FROM contestant WHERE contest = ?)`,
      )
      .run(now.toISOString(), contestId);
    return Number(changed.changes);
  }

  // ---- worker-process slots (v14, finding 26) ----------------------------

  reserveExecutionSlots(runner: string, count: number, now: Date): number[] {
    return this.transact(() => {
      const ids: number[] = [];
      for (let index = 0; index < count; index++) {
        const inserted = this.db
          .prepare("INSERT INTO execution_slot (runner, reserved_at) VALUES (?, ?)")
          .run(runner, now.toISOString());
        ids.push(Number(inserted.lastInsertRowid));
      }
      return ids;
    });
  }

  /** reserved → running happens in the stamp-before-spawn moment, carrying
   * the process group so recovery can ask the OS before freeing capacity. */
  markSlotRunning(
    id: number,
    facts: { run: number; contestant?: number | null; incarnation?: string | null; processGroup?: number | null },
    now: Date,
  ): boolean {
    const changed = this.db
      .prepare(
        `UPDATE execution_slot SET state = 'running', run = ?, contestant = ?, incarnation = ?, process_group = ?, running_at = ?
          WHERE id = ? AND state = 'reserved'`,
      )
      .run(facts.run, facts.contestant ?? null, facts.incarnation ?? null, facts.processGroup ?? null, now.toISOString(), id);
    return Number(changed.changes) === 1;
  }

  releaseExecutionSlot(id: number, now: Date): boolean {
    const changed = this.db
      .prepare("UPDATE execution_slot SET state = 'released', released_at = ? WHERE id = ? AND state IN ('reserved','running')")
      .run(now.toISOString(), id);
    return Number(changed.changes) === 1;
  }

  liveSlotCount(runner: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM execution_slot WHERE runner = ? AND state IN ('reserved','running')")
      .get(runner);
    return Number(row?.["n"] ?? 0);
  }

  getExecutionSlot(id: number): ExecutionSlot | null {
    const row = this.db.prepare("SELECT * FROM execution_slot WHERE id = ?").get(id);
    return row === undefined ? null : readExecutionSlot(row);
  }

  // ---- durable ceremony nonces (v14, findings 21/30) ---------------------

  /** Minted from a POST, never a GET. Bounded per approver; expired rows
   * are swept rather than accumulating. */
  mintCeremonyNonce(
    spec: { hash: string; approver: string; subject: string; subjectId: number; digest: string; ttlMs: number },
    now: Date,
  ): { ok: true } | { ok: false; reason: "too-many" } {
    return this.transact(() => {
      const open = this.db
        .prepare("SELECT COUNT(*) AS n FROM ceremony_nonce WHERE approver = ? AND consumed_at IS NULL AND expires_at >= ?")
        .get(spec.approver, now.toISOString());
      if (Number(open?.["n"] ?? 0) >= 50) return { ok: false as const, reason: "too-many" as const };
      this.db
        .prepare(
          `INSERT INTO ceremony_nonce (hash, approver, subject, subject_id, digest, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          spec.hash,
          spec.approver,
          spec.subject,
          spec.subjectId,
          spec.digest,
          now.toISOString(),
          new Date(now.getTime() + spec.ttlMs).toISOString(),
        );
      return { ok: true as const };
    });
  }

  /** Single use, inside whatever transaction the act runs in: the same
   * write that authorizes the act consumes its nonce, or neither happens. */
  consumeCeremonyNonce(
    hash: string,
    approver: string,
    subject: string,
    subjectId: number,
    digest: string,
    now: Date,
  ): boolean {
    const changed = this.db
      .prepare(
        `UPDATE ceremony_nonce SET consumed_at = ?
          WHERE hash = ? AND approver = ? AND subject = ? AND subject_id = ? AND digest = ?
            AND consumed_at IS NULL AND expires_at >= ?`,
      )
      .run(now.toISOString(), hash, approver, subject, subjectId, digest, now.toISOString());
    return Number(changed.changes) === 1;
  }

  sweepCeremonyNonces(now: Date): number {
    const swept = this.db.prepare("DELETE FROM ceremony_nonce WHERE expires_at < ?").run(now.toISOString());
    return Number(swept.changes);
  }

  // ----- fleet chat (v13) -------------------------------------------------

  /**
   * The chat context, read by DEDICATED queries only (Codex v3 review,
   * change 9): a non-empty explicit repo list is REQUIRED, admission binds
   * inside every query before its LIMIT, repo-null rows are excluded from
   * rows AND aggregates, and each item carries its repo as an INDEX into
   * the caller's list — the serializer turns that into an opaque id; full
   * paths never leave this process. Everything here is intentional
   * provider egress: titles and questions are operator text and go as-is.
   */
  chatSnapshot(admittedRepos: readonly string[], now: Date): ChatSnapshot {
    if (admittedRepos.length === 0) {
      throw new Error("chatSnapshot requires the explicit non-empty repo list — an empty ceiling has nothing to say");
    }
    const marks = admittedRepos.map(() => "?").join(",");
    const repoIndex = new Map(admittedRepos.map((repo, index) => [repo, index]));
    const indexOf = (repo: unknown): number => repoIndex.get(String(repo)) ?? -1;
    const hours = (iso: unknown): number => Math.max(0, Math.round((now.getTime() - Date.parse(String(iso))) / 3_600_000));
    return this.transact(() => {
      const taskRows = this.db
        .prepare(
          `SELECT task.id AS id, task.title AS title, task.state AS state, task.updated_at AS updated_at, task_ref.repo AS repo, task_ref.strikes AS strikes
             FROM task JOIN task_ref ON task_ref.backend = '${BUILT_IN}' AND task_ref.external_id = task.id
            WHERE task_ref.repo IN (${marks})
            ORDER BY task.updated_at DESC LIMIT 61`,
        )
        .all(...admittedRepos);
      const decisionRows = this.db
        .prepare(
          `SELECT decision.id AS id, decision.question AS question, decision.options AS options, task_ref.repo AS repo
             FROM decision JOIN run ON run.id = decision.run JOIN task_ref ON task_ref.id = run.task_ref
            WHERE decision.state IN ('open','expired') AND task_ref.repo IN (${marks})
            ORDER BY decision.id DESC LIMIT 21`,
        )
        .all(...admittedRepos);
      const incidentRows = this.db
        .prepare(
          `SELECT incident.kind AS kind, incident.created_at AS created_at, task_ref.repo AS repo
             FROM incident JOIN run ON run.id = incident.run JOIN task_ref ON task_ref.id = run.task_ref
            WHERE incident.resolved_at IS NULL AND task_ref.repo IN (${marks})
            ORDER BY incident.id DESC LIMIT 21`,
        )
        .all(...admittedRepos);
      const routineRows = this.db
        .prepare(
          `SELECT id, name, schedule, paused, digest, approved_at, approved_digest, repo
             FROM routine WHERE repo IN (${marks}) ORDER BY id LIMIT 31`,
        )
        .all(...admittedRepos);
      const publicationRows = this.db
        .prepare(
          `SELECT publication.pr_number AS pr, publication.last_check_state AS check_state, task_ref.repo AS repo
             FROM publication JOIN task_ref ON task_ref.id = publication.task_ref
            WHERE publication.state = 'opened'
              AND (publication.remote_state IS NULL OR publication.remote_state NOT IN ('MERGED','CLOSED'))
              AND task_ref.repo IN (${marks})
            ORDER BY publication.id DESC LIMIT 21`,
        )
        .all(...admittedRepos);
      const optionLabelsOf = (raw: unknown): string[] => {
        try {
          const parsed = JSON.parse(String(raw)) as { label?: unknown }[];
          return Array.isArray(parsed) ? parsed.map(one => String(one?.label ?? "")).slice(0, 6) : [];
        } catch {
          return [];
        }
      };
      return {
        repos: [...admittedRepos],
        tasks: taskRows.slice(0, 60).map(row => ({
          repoIndex: indexOf(row["repo"]),
          id: String(row["id"]),
          title: String(row["title"]),
          state: String(row["state"]),
          ageHours: hours(row["updated_at"]),
          strikes: Number(row["strikes"] ?? 0),
        })),
        tasksSaturated: taskRows.length > 60,
        decisions: decisionRows.slice(0, 20).map(row => ({
          repoIndex: indexOf(row["repo"]),
          id: Number(row["id"]),
          question: String(row["question"]),
          optionLabels: optionLabelsOf(row["options"]),
        })),
        decisionsSaturated: decisionRows.length > 20,
        incidents: incidentRows.slice(0, 20).map(row => ({
          repoIndex: indexOf(row["repo"]),
          kind: String(row["kind"]),
          ageHours: hours(row["created_at"]),
        })),
        incidentsSaturated: incidentRows.length > 20,
        routines: routineRows.slice(0, 30).map(row => {
          const approved = row["approved_at"] !== null && row["approved_digest"] === row["digest"];
          const fires = this.routineFires(Number(row["id"]), 1);
          return {
            repoIndex: indexOf(row["repo"]),
            name: String(row["name"]),
            schedule: String(row["schedule"]),
            status: Number(row["paused"]) === 1 ? "paused" : approved ? "live" : "awaiting approval",
            lastFire: fires.length === 0 ? null : `${fires[0]?.outcome}${fires[0]?.reason === null ? "" : `: ${fires[0]?.reason}`}`,
          };
        }),
        routinesSaturated: routineRows.length > 30,
        publications: publicationRows.slice(0, 20).map(row => ({
          repoIndex: indexOf(row["repo"]),
          pr: row["pr"] === null ? null : Number(row["pr"]),
          checkState: row["check_state"] === null ? null : String(row["check_state"]),
        })),
        publicationsSaturated: publicationRows.length > 20,
      };
    });
  }

  setChatConfig(
    config: {
      provider: ChatProviderId;
      model: string;
      dailyTurns: number;
      weeklyCeilingMicrousd: number;
      priceInMicrousd: number;
      priceOutMicrousd: number;
    },
    by: string,
    now: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO chat_config (id, provider, model, daily_turns, weekly_ceiling_microusd, price_in_microusd, price_out_microusd, updated_at, updated_by)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, model = excluded.model,
           daily_turns = excluded.daily_turns, weekly_ceiling_microusd = excluded.weekly_ceiling_microusd,
           price_in_microusd = excluded.price_in_microusd, price_out_microusd = excluded.price_out_microusd,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(
        config.provider,
        config.model,
        config.dailyTurns,
        config.weeklyCeilingMicrousd,
        config.priceInMicrousd,
        config.priceOutMicrousd,
        now.toISOString(),
        by,
      );
  }

  getChatConfig(): ChatConfig | null {
    const row = this.db.prepare("SELECT * FROM chat_config WHERE id = 1").get();
    if (row === undefined) return null;
    return {
      provider: String(row["provider"]) as ChatProviderId,
      model: String(row["model"]),
      dailyTurns: Number(row["daily_turns"]),
      weeklyCeilingMicrousd: Number(row["weekly_ceiling_microusd"]),
      priceInMicrousd: row["price_in_microusd"] === null || row["price_in_microusd"] === undefined ? null : Number(row["price_in_microusd"]),
      priceOutMicrousd: row["price_out_microusd"] === null || row["price_out_microusd"] === undefined ? null : Number(row["price_out_microusd"]),
      updatedAt: String(row["updated_at"]),
      updatedBy: String(row["updated_by"]),
    };
  }

  clearChatConfig(): void {
    this.db.prepare("DELETE FROM chat_config WHERE id = 1").run();
  }

  /**
   * Admit one turn, transactionally: the unknown-spend latch, the
   * one-live-turn-per-approver rule, the daily turn cap, and the rolling
   * 7-day ceiling (reservations count until settled — change 4) are all
   * proved inside the same write, so two concurrent posts cannot both
   * slip under a cap.
   */
  openChatTurn(
    args: {
      approver: string;
      credentialKey: string;
      provider: ChatProviderId;
      model: string;
      reservedMicrousd: number;
      dailyTurns: number;
      weeklyCeilingMicrousd: number;
      deadlineMs: number;
    },
    now: Date,
  ): { ok: true; id: number } | { ok: false; reason: "latched" | "concurrent" | "daily-cap" | "over-budget" } {
    return this.transact(() => {
      const latched = this.db
        .prepare("SELECT 1 AS hit FROM chat_turn WHERE credential_key = ? AND unknown_spend = 1 AND acknowledged_at IS NULL LIMIT 1")
        .get(args.credentialKey);
      if (latched !== undefined) return { ok: false as const, reason: "latched" as const };
      const live = this.db
        .prepare("SELECT 1 AS hit FROM chat_turn WHERE approver = ? AND state IN ('queued','running') LIMIT 1")
        .get(args.approver);
      if (live !== undefined) return { ok: false as const, reason: "concurrent" as const };
      const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
      const today = this.db
        .prepare("SELECT COUNT(*) AS n FROM chat_turn WHERE approver = ? AND created_at >= ?")
        .get(args.approver, dayStart);
      if (Number(today?.["n"] ?? 0) >= args.dailyTurns) return { ok: false as const, reason: "daily-cap" as const };
      const since = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
      const spent = this.db
        .prepare(
          `SELECT COALESCE(SUM(COALESCE(settled_microusd, reserved_microusd)), 0) AS spent
             FROM chat_turn WHERE credential_key = ? AND created_at >= ?`,
        )
        .get(args.credentialKey, since);
      if (Number(spent?.["spent"] ?? 0) + args.reservedMicrousd > args.weeklyCeilingMicrousd) {
        return { ok: false as const, reason: "over-budget" as const };
      }
      const inserted = this.db
        .prepare(
          `INSERT INTO chat_turn (approver, credential_key, provider, model, state, created_at, deadline_at, reserved_microusd)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          args.approver,
          args.credentialKey,
          args.provider,
          args.model,
          now.toISOString(),
          new Date(now.getTime() + args.deadlineMs).toISOString(),
          args.reservedMicrousd,
        );
      return { ok: true as const, id: Number(inserted.lastInsertRowid) };
    });
  }

  /** queued → running, exactly once. The dispatch CAS: whoever wins this
   * write sends the ONE request this row will ever describe. */
  startChatTurn(id: number, now: Date): { ok: true; generation: number } | { ok: false } {
    const changed = this.db
      .prepare("UPDATE chat_turn SET state = 'running', generation = generation + 1, started_at = ? WHERE id = ? AND state = 'queued'")
      .run(now.toISOString(), id);
    if (Number(changed.changes) !== 1) return { ok: false };
    const row = this.db.prepare("SELECT generation FROM chat_turn WHERE id = ?").get(id);
    return { ok: true, generation: Number(row?.["generation"] ?? 0) };
  }

  /** Terminal CAS, generation-checked: a response arriving after the sweep
   * already judged this row loses and changes nothing (change 5). */
  finalizeChatTurn(
    id: number,
    generation: number,
    outcome: {
      state: "answered" | "failed";
      failureReason?: ChatFailureReason;
      tokensIn?: number;
      tokensOut?: number;
      settledMicrousd: number | null;
      unknownSpend?: boolean;
      replyBytes?: number;
      candidateCount?: number;
    },
    now: Date,
  ): boolean {
    const changed = this.db
      .prepare(
        `UPDATE chat_turn SET state = ?, failure_reason = ?, tokens_in = ?, tokens_out = ?,
           settled_microusd = ?, unknown_spend = ?, reply_bytes = ?, candidate_count = ?, finished_at = ?
         WHERE id = ? AND generation = ? AND state IN ('queued','running')`,
      )
      .run(
        outcome.state,
        outcome.failureReason ?? null,
        outcome.tokensIn ?? null,
        outcome.tokensOut ?? null,
        outcome.settledMicrousd,
        outcome.unknownSpend === true ? 1 : 0,
        outcome.replyBytes ?? null,
        outcome.candidateCount ?? null,
        now.toISOString(),
        id,
        generation,
      );
    return Number(changed.changes) === 1;
  }

  /**
   * The crash sweep: turns past their deadline become failed('crashed'),
   * generation-bumped so a late finalize loses. A turn that STARTED may
   * have billed — it latches unknown spend and blocks its credential; a
   * queued one never dispatched and settles at zero.
   */
  sweepStaleChatTurns(now: Date): number {
    const swept = this.db
      .prepare(
        `UPDATE chat_turn SET state = 'failed', failure_reason = 'crashed', generation = generation + 1,
           unknown_spend = CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END,
           settled_microusd = CASE WHEN started_at IS NOT NULL THEN settled_microusd ELSE 0 END,
           finished_at = ?
         WHERE state IN ('queued','running') AND deadline_at < ?`,
      )
      .run(now.toISOString(), now.toISOString());
    return Number(swept.changes);
  }

  getChatTurn(id: number): ChatTurn | null {
    const row = this.db.prepare("SELECT * FROM chat_turn WHERE id = ?").get(id);
    return row === undefined ? null : readChatTurn(row);
  }

  liveChatTurnFor(approver: string): ChatTurn | null {
    const row = this.db
      .prepare("SELECT * FROM chat_turn WHERE approver = ? AND state IN ('queued','running') ORDER BY id DESC LIMIT 1")
      .get(approver);
    return row === undefined ? null : readChatTurn(row);
  }

  recentChatTurns(approver: string, limit = 20): ChatTurn[] {
    return this.db
      .prepare("SELECT * FROM chat_turn WHERE approver = ? ORDER BY id DESC LIMIT ?")
      .all(approver, Math.max(1, Math.min(limit, 100)))
      .map(readChatTurn);
  }

  /** Rolling 7-day spend for the caps line: settled where known, reserved
   * where not — the same arithmetic the admission transaction uses. */
  chatWeeklySpendMicrousd(credentialKey: string, now: Date): number {
    const since = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(settled_microusd, reserved_microusd)), 0) AS spent
           FROM chat_turn WHERE credential_key = ? AND created_at >= ?`,
      )
      .get(credentialKey, since);
    return Number(row?.["spent"] ?? 0);
  }

  chatTurnsToday(approver: string, now: Date): number {
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM chat_turn WHERE approver = ? AND created_at >= ?")
      .get(approver, dayStart);
    return Number(row?.["n"] ?? 0);
  }

  /** Turns blocking this credential until somebody owns the worst case. */
  latchedChatTurns(credentialKey: string): ChatTurn[] {
    return this.db
      .prepare("SELECT * FROM chat_turn WHERE credential_key = ? AND unknown_spend = 1 AND acknowledged_at IS NULL ORDER BY id")
      .all(credentialKey)
      .map(readChatTurn);
  }

  /**
   * The acknowledgement (change 6): append-only, names who accepted, and
   * charges the reserved worst case unless an authoritative settled cost
   * already exists — the ledger never shows unknown spend as free.
   */
  acknowledgeChatTurn(id: number, by: string, now: Date): boolean {
    const changed = this.db
      .prepare(
        `UPDATE chat_turn SET acknowledged_at = ?, acknowledged_by = ?,
           settled_microusd = COALESCE(settled_microusd, reserved_microusd)
         WHERE id = ? AND unknown_spend = 1 AND acknowledged_at IS NULL`,
      )
      .run(now.toISOString(), by, id);
    return Number(changed.changes) === 1;
  }

  /** Provenance for filing paths that create their ref outside
   * createConsoleTask. Set-once: an already-stamped row never changes. */
  stampFiledVia(refId: number, via: string): void {
    this.db.prepare("UPDATE task_ref SET filed_via = ? WHERE id = ? AND filed_via IS NULL").run(via, refId);
  }

  /**
   * When this installation first finished a run successfully — the
   * moment the first-run checklist retires, permanently. Derived from run
   * history the first time it is observed, then stamped as an append-only
   * installation fact so later pruning of those rows cannot resurrect the
   * checklist (adoption review, finding 14).
   */
  firstSuccessAt(now: Date): string | null {
    const fact = this.installationFact("first-success-at");
    if (fact !== null) return fact;
    const row = this.db
      .prepare("SELECT finished_at FROM run WHERE outcome IN ('built','no-change') AND finished_at IS NOT NULL ORDER BY id LIMIT 1")
      .get();
    if (row === undefined) return null;
    const when = String(row["finished_at"]);
    this.recordInstallationFact("first-success-at", when, now);
    return when;
  }

  /** Whether ANY spend routing is configured — a fact about this database,
   * not about any machine's binaries or authentication. */
  hasPhaseConfig(): boolean {
    return this.db.prepare("SELECT 1 AS hit FROM phase_config LIMIT 1").get() !== undefined;
  }

  /** The jump palette's food: open (queued/running/failed) tasks, admission
   * inside the query before its LIMIT, newest first. */
  paletteTasks(
    repo: string | null,
    limit: number,
    admitted: string[] | null = null,
  ): { id: string; title: string; repo: string | null }[] {
    const admission =
      admitted === null ? "" : `AND (task_ref.repo IS NULL OR task_ref.repo IN (${admitted.map(() => "?").join(",")}))`;
    return this.db
      .prepare(
        `SELECT task.id AS id, task.title AS title, task_ref.repo AS repo
           FROM task JOIN task_ref ON task_ref.backend = '${BUILT_IN}' AND task_ref.external_id = task.id
          WHERE task.state IN ('queued','running','failed')
            AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
            ${admission}
          ORDER BY task.updated_at DESC LIMIT ?`,
      )
      .all(repo, repo, ...(admitted ?? []), Math.max(1, Math.min(limit, 500)))
      .map(row => ({
        id: String(row["id"]),
        title: String(row["title"]),
        repo: row["repo"] === null || row["repo"] === undefined ? null : String(row["repo"]),
      }));
  }

  /** Whether any work was ever filed — task or routine. */
  hasAnyWork(): boolean {
    if (this.db.prepare("SELECT 1 AS hit FROM task LIMIT 1").get() !== undefined) return true;
    return this.db.prepare("SELECT 1 AS hit FROM routine LIMIT 1").get() !== undefined;
  }

  /** Which door filed a task; null for history from before v12. */
  filedViaOf(taskId: string): string | null {
    const row = this.db
      .prepare("SELECT filed_via FROM task_ref WHERE backend = ? AND external_id = ?")
      .get(BUILT_IN, taskId);
    return row === undefined || row["filed_via"] === null ? null : String(row["filed_via"]);
  }

  getRoutine(id: number): Routine | null {
    const row = this.db.prepare("SELECT * FROM routine WHERE id = ?").get(id);
    return row === undefined ? null : readRoutine(row);
  }

  routineByName(name: string): Routine | null {
    const row = this.db.prepare("SELECT * FROM routine WHERE name = ?").get(name);
    return row === undefined ? null : readRoutine(row);
  }

  /** Every routine one view may see. NULL repo filter means "no filter". */
  listRoutines(repo: string | null, admitted: string[] | null = null): Routine[] {
    const where =
      admitted === null
        ? "WHERE (? IS NULL OR routine.repo = ?)"
        : `WHERE routine.repo IN (${admitted.map(() => "?").join(",") || "''"})`;
    const params = admitted === null ? [repo, repo] : admitted;
    return this.db
      .prepare(`SELECT * FROM routine ${where} ORDER BY routine.name`)
      .all(...params)
      .map(readRoutine);
  }

  /**
   * Rewrite a template's terms. The new digest rides along, and the old
   * approval is kept — invalidated by the mismatch, exactly like a scope
   * edit, so the refusal can say "approved, then edited" rather than
   * "never approved". The firing transaction re-proves the match.
   */
  updateRoutineTerms(
    id: number,
    terms: {
      goal: string;
      outOfScope: string | null;
      touches: string[];
      requirements: string[];
      schedule: string;
      costCeilingUsd: number | null;
      digest: string;
      /** v24: restatement carries the profile its digest binds. */
      profile?: ExecutionProfile | null;
    },
    now: Date,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE routine SET goal = ?, out_of_scope = ?, touches = ?, requirements = ?,
                            schedule = ?, cost_ceiling_usd = ?, digest = ?, updated_at = ?,
                            profile_json = COALESCE(?, profile_json)
          WHERE id = ?`,
      )
      .run(
        terms.goal,
        terms.outOfScope,
        JSON.stringify(terms.touches),
        JSON.stringify(terms.requirements),
        terms.schedule,
        terms.costCeilingUsd,
        terms.digest,
        now.toISOString(),
        terms.profile === undefined || terms.profile === null ? null : canonicalProfileJson(terms.profile),
        id,
      );
    return Number(changes) > 0;
  }

  /**
   * The approval stamp, raw. Callers own the ceremony — credential,
   * digest re-read, and the transaction — in approveRoutine (routine.ts).
   */
  stampRoutineApproval(id: number, by: string, digest: string, nextFireAt: string, now: Date): void {
    this.db
      .prepare(
        `UPDATE routine SET approved_at = ?, approved_by = ?, approved_digest = ?,
                            approved_profile_json = profile_json,
                            next_fire_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(now.toISOString(), by, digest, nextFireAt, now.toISOString(), id);
  }

  /** Pausing is instant and needs no ceremony; resuming re-arms the schedule. */
  setRoutinePaused(id: number, paused: boolean, now: Date): boolean {
    const { changes } = this.db
      .prepare("UPDATE routine SET paused = ?, updated_at = ? WHERE id = ?")
      .run(paused ? 1 : 0, now.toISOString(), id);
    if (Number(changes) > 0) this.bumpWake();
    return Number(changes) > 0;
  }

  /**
   * Routines a pass should try to fire: approved (digest intact), unpaused,
   * due, and placed in this pass's repository. Each candidate is re-proved
   * inside fireRoutine's own transaction — this list only nominates.
   */
  dueRoutines(repo: string, now: Date): Routine[] {
    return this.db
      .prepare(
        `SELECT * FROM routine
         WHERE repo = ? AND paused = 0
           AND approved_at IS NOT NULL AND approved_digest = digest
           AND next_fire_at IS NOT NULL AND next_fire_at <= ?
         ORDER BY next_fire_at, id`,
      )
      .all(repo, now.toISOString())
      .map(readRoutine);
  }

  /** The last firings, newest first — the board's run-history strip. */
  routineFires(routineId: number, limit = 14): (RoutineFire & { instanceTaskId: string | null; instanceState: string | null })[] {
    return this.db
      .prepare(
        `SELECT routine_fire.*, task_ref.external_id AS instance_task_id, task.state AS instance_state
           FROM routine_fire
           LEFT JOIN task_ref ON task_ref.id = routine_fire.instance_task_ref
           LEFT JOIN task ON task.id = task_ref.external_id
          WHERE routine_fire.routine_id = ?
          ORDER BY routine_fire.id DESC LIMIT ?`,
      )
      .all(routineId, Math.max(1, Math.min(limit, 100)))
      .map(row => ({
        ...readRoutineFire(row),
        instanceTaskId: row["instance_task_id"] === null || row["instance_task_id"] === undefined ? null : String(row["instance_task_id"]),
        instanceState: row["instance_state"] === null || row["instance_state"] === undefined ? null : String(row["instance_state"]),
      }));
  }

  /**
   * What one routine's instances actually cost in a window, and whether any
   * paid run in it is unmeasured. NULL costs are counted, not summed over:
   * a sum that silently omits them reads as headroom that may not exist
   * (finding 5 — the arithmetic behind failing closed).
   */
  routineSpend(routineId: number, sinceIso: string): { costUsd: number; unmeasuredRuns: number; totalRuns: number } {
    // The window is anchored to provider_started_at — the exact stamp money
    // can move — never to when the run row was opened (Codex Phase C
    // review, M2): a run opened before the cutoff whose provider started
    // inside it is spend inside the window, measured or not.
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(run.cost_usd), 0) AS cost,
                SUM(CASE WHEN run.cost_usd IS NULL THEN 1 ELSE 0 END) AS unmeasured,
                COUNT(*) AS invoked
           FROM run
           JOIN task_ref ON task_ref.id = run.task_ref
          WHERE task_ref.routine_id = ?
            AND run.provider_started_at IS NOT NULL AND run.provider_started_at >= ?`,
      )
      .get(routineId, sinceIso);
    return {
      costUsd: Number(row?.["cost"] ?? 0),
      unmeasuredRuns: Number(row?.["unmeasured"] ?? 0),
      totalRuns: Number(row?.["invoked"] ?? 0),
    };
  }

  /**
   * The single-flight question: the oldest instance not successfully
   * completed nor explicitly abandoned — queued, running, held, parked,
   * and failed instances all block (finding 9's definition, verbatim).
   * A LIVE CLAIM blocks regardless of task state (Codex Phase C review,
   * H2): a state string written over a running build — `task state <id>
   * done` bypassing the guarded cancel — must not conjure a twin beside
   * a provider that is still spending.
   */
  routineBlocker(routineId: number, now: Date): { taskId: string; state: string } | null {
    const row = this.db
      .prepare(
        `SELECT task.id, task.state FROM task
           JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
          WHERE task_ref.routine_id = ?
            AND (
              task.state NOT IN ('done','cancelled')
              OR EXISTS (
                SELECT 1 FROM claim
                WHERE claim.task_ref = task_ref.id
                  AND claim.released_at IS NULL AND claim.expires_at > ?
                  AND claim.lease_generation = (
                    SELECT MAX(newest.lease_generation) FROM claim AS newest
                    WHERE newest.task_ref = task_ref.id
                  )
              )
            )
          ORDER BY task.created_at LIMIT 1`,
      )
      .get(BUILT_IN, routineId, now.toISOString());
    return row === undefined
      ? null
      : { taskId: String(row["id"]), state: String(row["state"]) };
  }

  /**
   * Whether a slot is still unrecorded. Only sound inside the fire
   * transaction — the IMMEDIATE lock is what makes read-then-insert atomic.
   */
  routineSlotOpen(routineId: number, scheduledFor: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 AS hit FROM routine_fire WHERE routine_id = ? AND scheduled_for = ?")
        .get(routineId, scheduledFor) === undefined
    );
  }

  /** Record one slot's outcome. False: the slot was already recorded — the caller lost the race. */
  recordRoutineFire(
    fire: {
      routineId: number;
      scheduledFor: string;
      outcome: "fired" | "skipped";
      reason: string | null;
      instanceTaskRef: number | null;
    },
    now: Date,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO routine_fire
           (routine_id, scheduled_for, outcome, reason, instance_task_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(fire.routineId, fire.scheduledFor, fire.outcome, fire.reason, fire.instanceTaskRef, now.toISOString());
    return Number(changes) > 0;
  }

  /** Advance the schedule. The fire transaction is the only caller. */
  setRoutineNextFire(id: number, nextFireAt: string, now: Date): void {
    this.db
      .prepare("UPDATE routine SET next_fire_at = ?, updated_at = ? WHERE id = ?")
      .run(nextFireAt, now.toISOString(), id);
  }

  /** Stamp which routine a task is an instance of. Set at spawn, never after. */
  linkRoutineInstance(taskRef: number, routineId: number): void {
    this.db.prepare("UPDATE task_ref SET routine_id = ? WHERE id = ?").run(routineId, taskRef);
  }

  /**
   * Page a blocked track once per EPISODE: an open episode under this
   * prefix already nags, so nothing enqueues; a resolved one is history,
   * and the fresh suffix keys a new row past the dedupe uniqueness — a
   * recurrence after recovery pages again (Codex Phase C review, L1).
   * Prefix matching is exact-bytes (substr), never LIKE — task ids may
   * contain `_`, which LIKE would read as a wildcard.
   */
  enqueueRoutineEpisode(
    prefix: string,
    notification: { kind: string; subject: string; body: string; pushClass?: "decision" | "pick" | "merge" | "attention"; link?: string },
    suffix: string,
    now: Date,
  ): boolean {
    return this.transact(() => {
      const head = `${prefix}:`;
      const open = this.db
        .prepare(
          `SELECT 1 AS hit FROM notification
            WHERE substr(dedupe_key, 1, ?) = ? AND resolved_at IS NULL LIMIT 1`,
        )
        .get(head.length, head);
      if (open !== undefined) return false;
      return this.enqueueNotification({ dedupeKey: `${head}${suffix}`, ...notification }, now);
    });
  }

  /**
   * Close every blocked-track episode for a routine — called when a firing
   * succeeds, because success is the proof the blocker is gone (budget
   * cleared, blocking instance finished). Receipts stay; only the "wants a
   * person" bit resolves.
   */
  resolveRoutineEpisodes(routineId: number, now: Date): void {
    for (const prefix of [
      `routine-budget:${routineId}:`,
      `routine-unmeasured:${routineId}:`,
      `routine-singleflight:${routineId}:`,
    ]) {
      this.db
        .prepare(
          `UPDATE notification SET resolved_at = ?
            WHERE resolved_at IS NULL AND substr(dedupe_key, 1, ?) = ?`,
        )
        .run(now.toISOString(), prefix.length, prefix);
    }
  }

  /**
   * Everything the board's track rows need, in one snapshot: each routine
   * with its recent firings, its rolling-window spend, and the instance
   * blocking it, if any. The caller applies the ceiling row by row.
   */
  routineTracks(
    repo: string | null,
    now: Date,
    admitted: string[] | null = null,
  ): {
    routine: Routine;
    fires: ReturnType<Store["routineFires"]>;
    spend: { costUsd: number; unmeasuredRuns: number; totalRuns: number };
    blocker: { taskId: string; state: string } | null;
  }[] {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
    return this.transact(() =>
      this.listRoutines(repo, admitted).map(routine => ({
        routine,
        fires: this.routineFires(routine.id, 14),
        spend: this.routineSpend(routine.id, since),
        blocker: this.routineBlocker(routine.id, now),
      })),
    );
  }

  // ---- the outbox ---------------------------------------------------------

  /** True if this is a new fact; false if the episode already knows.
   * `pushClass`/`link` (arc 3): the CLOSED attention class and machine-
   * minted console path a phone may be paged with — stamped here at
   * enqueue or never; subject and body never reach a push service. */
  enqueueNotification(
    notification: { dedupeKey: string; kind: string; subject: string; body: string; pushClass?: "decision" | "pick" | "merge" | "attention"; link?: string },
    now: Date,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO notification (dedupe_key, kind, subject, body, created_at, push_class, link)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        notification.dedupeKey,
        notification.kind,
        notification.subject,
        notification.body,
        now.toISOString(),
        notification.pushClass ?? null,
        notification.link ?? null,
      );
    return Number(changes) > 0;
  }

  /**
   * Episode semantics for recurring faults (arc 3 finding 23, generalizing
   * the routine-episode pattern): one OPEN row per prefix nags; a RESOLVED
   * one is history, and a fresh suffix keys a new row past the dedupe
   * uniqueness so a recurrence pages again instead of being suppressed
   * forever by its own past.
   */
  enqueueEpisode(
    prefix: string,
    notification: { kind: string; subject: string; body: string; pushClass?: "decision" | "pick" | "merge" | "attention"; link?: string },
    suffix: string,
    now: Date,
  ): boolean {
    return this.transact(() => {
      const head = `${prefix}:`;
      const open = this.db
        .prepare(
          `SELECT 1 AS hit FROM notification
            WHERE substr(dedupe_key, 1, ?) = ? AND resolved_at IS NULL LIMIT 1`,
        )
        .get(head.length, head);
      if (open !== undefined) return false;
      return this.enqueueNotification({ dedupeKey: `${head}${suffix}`, ...notification }, now);
    });
  }

  /** Close every open episode under a prefix — the fault is provably gone. */
  resolveEpisodes(prefix: string, now: Date): number {
    const head = `${prefix}:`;
    const { changes } = this.db
      .prepare(
        `UPDATE notification SET resolved_at = ?
          WHERE resolved_at IS NULL AND substr(dedupe_key, 1, ?) = ?`,
      )
      .run(now.toISOString(), head.length, head);
    return Number(changes);
  }

  listNotifications(only: "pending" | "all" = "pending"): Notification[] {
    // Resolved-but-undelivered is not pending: a decision answered before the
    // outbox ran is a fact that stopped wanting a person, and paging someone
    // about it anyway would teach them to ignore the pager.
    const where = only === "pending" ? "WHERE delivered_at IS NULL AND resolved_at IS NULL" : "";
    return this.db
      .prepare(`SELECT * FROM notification ${where} ORDER BY id`)
      .all()
      .map(readNotification);
  }

  recordDelivery(
    id: number,
    outcome: { ok: true; receipt: string | null } | { ok: false; error: string },
    now: Date,
  ): void {
    if (outcome.ok) {
      this.db
        .prepare(
          `UPDATE notification SET delivered_at = ?, receipt = ?, attempts = attempts + 1, last_attempt_at = ?, last_error = NULL
            WHERE id = ?`,
        )
        .run(now.toISOString(), outcome.receipt, now.toISOString(), id);
      return;
    }
    this.db
      .prepare(
        `UPDATE notification SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
          WHERE id = ?`,
      )
      .run(now.toISOString(), outcome.error, id);
  }

  /**
   * Close a gap's notification episode. Called when its capability verifies:
   * the next failure is a *new* fact, and a dedupe key that suppressed it
   * forever would be a gap the operator hears about exactly once per lifetime.
   */
  clearGapEpisode(repo: string, kind: string, name: string): void {
    this.db
      .prepare("DELETE FROM notification WHERE dedupe_key = ?")
      .run(`gap:${repo}:${kind}:${name}`);
  }

  /**
   * The other way an episode ends: the fact stopped wanting a person. Unlike
   * a gap — which is deleted so a recurrence can speak again — a resolved
   * decision or incident never recurs under the same key, so the row stays,
   * receipts and all.
   */
  resolveEpisode(dedupeKey: string, now: Date): void {
    this.db
      .prepare("UPDATE notification SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL")
      .run(now.toISOString(), dedupeKey);
  }

  // ---- runs ---------------------------------------------------------------

  /**
   * Open the record before the money is spent. If the process dies with the
   * agent, the row survives with outcome NULL — an attempt that was cut down
   * mid-flight, visible the next morning instead of vanished.
   */
  startRun(
    run: {
      taskRef: number;
      leaseId: string;
      runner: string;
      model?: string;
      provider?: string;
      sessionId?: string;
      /** Which racing agent this run belongs to (v14); absent = ordinary. */
      contestant?: number;
      now: Date;
    } & (
      | {
          role?: "builder" | "repair" | "planner";
          branch: string;
          worktree: string;
          parentRun?: number;
        }
      // The reviewer (v29, D5): an artifact-only pass over a sealed diff.
      // No branch, no worktree — the CHECK enforces the exclusive shape,
      // and the discriminated arm makes a workspace unrepresentable rather
      // than optional. The parent is mandatory: a review reviews a run.
      | { role: "reviewer"; parentRun: number; branch?: undefined; worktree?: undefined }
    ),
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO run (task_ref, lease_id, runner, branch, worktree, model, role, provider, parent_run, session_id, contestant, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.taskRef,
        run.leaseId,
        run.runner,
        run.branch ?? null,
        run.worktree ?? null,
        run.model ?? null,
        run.role ?? "builder",
        run.provider ?? "claude",
        run.parentRun ?? null,
        run.sessionId ?? null,
        run.contestant ?? null,
        run.now.toISOString(),
      );
    return Number(inserted.lastInsertRowid);
  }

  /**
   * Facts learned after the row was opened: the base revision is read just
   * before the agent spends, and the session id only exists once the agent's
   * envelope comes back. COALESCE, never overwrite — the first stamp is the
   * true one.
   */
  stampRun(
    id: number,
    facts: {
      baseRevision?: string;
      sessionId?: string;
      parentRun?: number;
      /** v24 dispatch stamps: what this invocation was PROVED against. */
      scopeDigest?: string;
      profileDigest?: string;
      providerVersion?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE run SET base_revision = COALESCE(base_revision, ?),
                        session_id = COALESCE(session_id, ?),
                        parent_run = COALESCE(parent_run, ?),
                        scope_digest = COALESCE(scope_digest, ?),
                        profile_digest = COALESCE(profile_digest, ?),
                        provider_version = COALESCE(provider_version, ?)
          WHERE id = ?`,
      )
      .run(
        facts.baseRevision ?? null,
        facts.sessionId ?? null,
        facts.parentRun ?? null,
        facts.scopeDigest ?? null,
        facts.profileDigest ?? null,
        facts.providerVersion ?? null,
        id,
      );
  }

  /**
   * The warm-resume candidate (M6.9): the latest PARKED builder run whose
   * session could carry this task's next attempt — same provider, same
   * branch, session captured — with the disqualifiers the Codex slice
   * names checked here, in one place: a newer accepted build supersedes
   * the park, and `tried` says whether any attempt already resumed it
   * (one warm try per park; after that the successor goes cold with the
   * answered decisions rather than failing on a dead session forever).
   */
  resumeCandidate(
    taskRef: number,
    provider: string,
    branch: string,
  ): { run: Run; tried: boolean } | null {
    const row = this.db
      .prepare(
        `SELECT * FROM run
          WHERE task_ref = ? AND outcome = 'parked' AND role = 'builder'
            AND session_id IS NOT NULL AND provider = ? AND branch = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(taskRef, provider, branch);
    if (row === undefined) return null;
    const parked = readRun(row);
    const superseded = this.db
      .prepare(
        `SELECT 1 AS hit FROM run
          WHERE task_ref = ? AND id > ? AND outcome IN ('built','no-change') LIMIT 1`,
      )
      .get(taskRef, parked.id);
    if (superseded !== undefined) return null;
    const child = this.db
      .prepare("SELECT 1 AS hit FROM run WHERE parent_run = ? AND role = 'builder' LIMIT 1")
      .get(parked.id);
    return { run: parked, tried: child !== undefined };
  }

  finishRun(
    id: number,
    result: {
      outcome: "built" | "failed" | "refused" | "parked" | "no-change" | "interrupted";
      reason?: string;
      committed?: boolean;
      now: Date;
    },
  ): void {
    this.db
      .prepare("UPDATE run SET outcome = ?, reason = ?, committed = ?, finished_at = ? WHERE id = ?")
      .run(
        result.outcome,
        result.reason ?? null,
        result.committed === undefined ? null : result.committed ? 1 : 0,
        result.now.toISOString(),
        id,
      );
    // The park rate is *measured* — parked over concluded builder attempts —
    // and maintained where attempts conclude, because the attention budget's
    // gate reads it inside a claim transaction and must never trust a number
    // something else remembered to update.
    if (result.outcome === "parked" || result.outcome === "built" || result.outcome === "no-change") {
      // Continuation runs are EXCLUDED (Phase 2E, v4 Q7/v5 P5): a watched
      // follow-up neither counts toward nor triggers the parent task's
      // measured park rate — "never mutates the parent task" includes its
      // derived statistics.
      this.db
        .prepare(
          `UPDATE task_ref SET park_rate = COALESCE((
             SELECT CAST(SUM(CASE WHEN outcome = 'parked' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
               FROM run
              WHERE run.task_ref = task_ref.id
                AND run.role = 'builder'
                AND run.outcome IN ('built', 'parked', 'no-change')
                AND NOT EXISTS (SELECT 1 FROM attended_authorization aa
                                 WHERE aa.id = run.attended_authorization AND aa.parent_run IS NOT NULL)
           ), 0)
           WHERE id = (SELECT task_ref FROM run
                        WHERE run.id = ? AND run.role = 'builder'
                          AND NOT EXISTS (SELECT 1 FROM attended_authorization aa
                                           WHERE aa.id = run.attended_authorization AND aa.parent_run IS NOT NULL))`,
        )
        .run(id);
    }
  }

  getRun(id: number): Run | null {
    const row = this.db.prepare("SELECT * FROM run WHERE id = ?").get(id);
    return row === undefined ? null : readRun(row);
  }

  /**
   * The instant before the provider process spawns, stamped by the gateway
   * and nothing else. First stamp wins: a run either paid once or it did
   * not, and "provider spawns == runs carrying this stamp" is the
   * zero-token invariant's testable half.
   */
  stampProviderStart(id: number, now: Date, providerVersion?: string): void {
    // The version is the GATEWAY'S authoritative fact (Phase 3 C5): it
    // OVERWRITES any caller-side best-effort stamp, in the same pre-spawn
    // statement as the start stamp so a daemon death loses neither.
    if (providerVersion !== undefined) {
      this.db
        .prepare(
          "UPDATE run SET provider_started_at = COALESCE(provider_started_at, ?), provider_version = ? WHERE id = ?",
        )
        .run(now.toISOString(), providerVersion, id);
      return;
    }
    this.db
      .prepare("UPDATE run SET provider_started_at = COALESCE(provider_started_at, ?) WHERE id = ?")
      .run(now.toISOString(), id);
  }

  /**
   * The gateway's honest disposal record for the fallback taxonomy (E2):
   * how this attempt authenticated, and the class its terminal fell into.
   * Recorded where the evidence still exists — the gateway holds the
   * structural terminal, the authoritative version, and the auth mode — and
   * NEVER re-derived in disposal, by which time the structural signal is
   * gone. Purely observational: the class is stamped on EVERY finished
   * attempt (usually 'unknown'/'not-exhausted', since the recognizers ship
   * empty), and it authorizes NOTHING on its own — the dispatch's C8 gate
   * re-proves hasRecognizer before any advance ever reads it.
   */
  stampTerminalClass(id: number, authMode: "subscription" | "api-key", terminalClass: TerminalClass): void {
    // FIRST-WRITE only (Codex E2/E3 review, finding 8): the gateway stamps
    // the disposal class exactly once, before disposition; nothing may
    // overwrite it into a class/auth pairing the recognizer never produced.
    // auth_mode is NEVER overwritten if already set — a fallback run's
    // admitted pin is authority (finding 5), so COALESCE keeps it and only a
    // never-stamped (base) run takes the gateway's mode.
    this.db
      .prepare("UPDATE run SET auth_mode = COALESCE(auth_mode, ?), terminal_class = ? WHERE id = ? AND terminal_class IS NULL")
      .run(authMode, terminalClass, id);
  }

  /** The race-refusal stamp (Phase 3 C5): the version that was REFUSED,
   * recorded without provider_started_at — no provider process started. */
  stampProviderVersion(id: number, providerVersion: string): void {
    this.db.prepare("UPDATE run SET provider_version = ? WHERE id = ?").run(providerVersion, id);
  }

  /** What the provider said it cost. NULL columns stay NULL — unmeasured, and said so. */
  recordUsage(
    id: number,
    usage: { tokensIn?: number; tokensOut?: number; costUsd?: number; usageJson?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE run SET tokens_in = COALESCE(?, tokens_in),
                        tokens_out = COALESCE(?, tokens_out),
                        cost_usd = COALESCE(?, cost_usd),
                        usage_json = COALESCE(?, usage_json)
          WHERE id = ?`,
      )
      .run(
        usage.tokensIn ?? null,
        usage.tokensOut ?? null,
        usage.costUsd ?? null,
        usage.usageJson ?? null,
        id,
      );
  }

  /**
   * Stamp the machine's current phase on an OPEN run. A closed run's phase
   * is history and stays put; an unknown phase is a caller bug and throws.
   * Bounded writes by construction: the vocabulary has four values and the
   * state machine passes each boundary once.
   */
  setRunPhase(id: number, phase: RunPhase): void {
    if (!RUN_PHASES.includes(phase)) {
      throw new Error(`"${phase}" is not a phase this machine has — the vocabulary is closed`);
    }
    this.db.prepare("UPDATE run SET phase = ? WHERE id = ? AND outcome IS NULL").run(phase, id);
  }

  /** The accepted head and the validated conclusion, once known. */
  recordOutcomeFacts(id: number, facts: { headRevision?: string; handoff?: string }): void {
    this.db
      .prepare(
        `UPDATE run SET head_revision = COALESCE(?, head_revision),
                        handoff = COALESCE(?, handoff)
          WHERE id = ?`,
      )
      .run(facts.headRevision ?? null, facts.handoff ?? null, id);
  }

  /** Every attempt since a moment, task ids attached — the overnight, as data. */
  runsSince(since: string): (Run & { taskId: string })[] {
    return this.db
      .prepare(
        `SELECT run.*, task_ref.external_id AS task_id FROM run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE run.started_at >= ? ORDER BY run.id`,
      )
      .all(since)
      .map(row => ({ ...readRun(row), taskId: String(row["task_id"]) }));
  }

  /**
   * The scoped read family: every list the console shows can be filtered to
   * one project. NULL repo rows (unplaced work) are always included — they
   * belong to every view — and a NULL filter means "no filter". Bounding
   * happens in the SQL, never by slicing a global read afterwards.
   */
  runsSinceScoped(since: string, repo: string | null): (Run & { taskId: string })[] {
    return this.db
      .prepare(
        `SELECT run.*, task_ref.external_id AS task_id FROM run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE run.started_at >= ? AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY run.id`,
      )
      .all(since, repo, repo)
      .map(row => ({ ...readRun(row), taskId: String(row["task_id"]) }));
  }

  /**
   * One bounded page of tasks for the list pane, newest first, with the
   * selected task injected even when it falls outside the page — a detail
   * view whose own row is missing from its list reads as a bug.
   */
  listTasksScoped(
    repo: string | null,
    state: TaskState | undefined,
    limit: number,
    selectedId: string | null,
  ): (Task & { repo: string | null })[] {
    const page = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT task.*, task_ref.repo AS task_repo FROM task
           JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
           WHERE (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
             AND (? IS NULL OR task.state = ?)
           ORDER BY task.created_at DESC, task.id DESC LIMIT ?
         )
         UNION
         SELECT task.*, task_ref.repo AS task_repo FROM task
         JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
         WHERE task.id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(BUILT_IN, repo, repo, state ?? null, state ?? null, page, BUILT_IN, selectedId);
    return rows.map(row => ({
      id: String(row["id"]),
      title: String(row["title"]),
      state: String(row["state"]) as TaskState,
      createdAt: String(row["created_at"]),
      updatedAt: String(row["updated_at"]),
      priority: row["priority"] === null || row["priority"] === undefined ? 0 : Number(row["priority"]),
      repo: row["task_repo"] === null ? null : String(row["task_repo"]),
    }));
  }

  /** Newest first, because the question is almost always "what just happened". */
  runsFor(taskRef: number): Run[] {
    return this.db
      .prepare("SELECT * FROM run WHERE task_ref = ? ORDER BY id DESC")
      .all(taskRef)
      .map(readRun);
  }

  /**
   * One page of runs, newest first, strictly before the cursor — id order,
   * because ids are the one monotonic thing a page can key on without a row
   * ever repeating or vanishing between requests. `null` means "from the
   * top". The limit is clamped here, not trusted from the caller: a page is
   * bounded by construction or it is not a page.
   */
  listRunsBefore(
    cursor: number | null,
    limit: number,
    repo: string | null = null,
  ): (Run & { taskId: string })[] {
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor <= 0)) return [];
    const page = Math.max(1, Math.min(Math.floor(limit), 200));
    return this.db
      .prepare(
        `SELECT run.*, task_ref.external_id AS task_id FROM run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE (? IS NULL OR run.id < ?)
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY run.id DESC LIMIT ?`,
      )
      .all(cursor, cursor, repo, repo, page)
      .map(row => ({ ...readRun(row), taskId: String(row["task_id"]) }));
  }

  // ---- decisions -----------------------------------------------------------

  /**
   * Insert a decision. Callers hand this a payload `parseDecision` already
   * validated and run it inside the park's fenced transaction — this method
   * is the write, not the policy.
   */
  saveDecision(
    decision: {
      run: number;
      urgency: "blocking";
      recap: string;
      question: string;
      options: DecisionOption[];
      recommendation: string;
      assignee?: string;
      deadline?: string;
      /** Which racing agent asked (v14); absent = ordinary. */
      contestant?: number;
    },
    now: Date,
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO decision (run, urgency, recap, question, options, recommendation, assignee, deadline, contestant, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.run,
        decision.urgency,
        decision.recap,
        decision.question,
        JSON.stringify(decision.options),
        decision.recommendation,
        decision.assignee ?? null,
        decision.deadline ?? null,
        decision.contestant ?? null,
        now.toISOString(),
      );
    return Number(inserted.lastInsertRowid);
  }

  getDecision(id: number): Decision | null {
    const row = this.db.prepare("SELECT * FROM decision WHERE id = ?").get(id);
    return row === undefined ? null : readDecision(row);
  }

  decisionForRun(run: number): Decision | null {
    const row = this.db.prepare("SELECT * FROM decision WHERE run = ?").get(run);
    return row === undefined ? null : readDecision(row);
  }

  /**
   * Decisions with their task attached, oldest first — the attention surface
   * reads in the order the questions arrived. "unanswered" is open + expired:
   * expiry makes a decision louder, never gone.
   */
  /** The newest planner run's plan document for a task, when one exists. */
  latestPlanArtifact(taskRef: number): Artifact | null {
    const row = this.db
      .prepare(
        `SELECT artifact.* FROM artifact
         JOIN run ON run.id = artifact.run
         WHERE run.task_ref = ? AND run.role = 'planner' AND artifact.kind = 'plan'
         ORDER BY artifact.id DESC LIMIT 1`,
      )
      .get(taskRef);
    return row === undefined ? null : readArtifact(row as Record<string, unknown>);
  }

  /** Answered questions for one task, newest first — the planner's memory. */
  answeredDecisionsFor(
    taskId: string,
    limit = 5,
  ): { question: string; choice: string | null; note: string | null }[] {
    return this.db
      .prepare(
        `SELECT decision.question, decision.choice, decision.note
         FROM decision
         JOIN run ON run.id = decision.run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE task_ref.backend = ? AND task_ref.external_id = ?
           AND decision.answered_at IS NOT NULL
         ORDER BY decision.answered_at DESC, decision.id DESC LIMIT ?`,
      )
      .all(BUILT_IN, taskId, Math.max(1, Math.min(Math.floor(limit), 20)))
      .map(row => ({
        question: String(row["question"]),
        choice: row["choice"] === null ? null : String(row["choice"]),
        note: row["note"] === null ? null : String(row["note"]),
      }));
  }

  listDecisions(only: "open" | "unanswered" | "all" = "unanswered"): (Decision & { taskId: string })[] {
    const where =
      only === "open"
        ? "WHERE decision.state = 'open'"
        : only === "unanswered"
          ? "WHERE decision.state IN ('open','expired')"
          : "";
    return this.db
      .prepare(
        `SELECT decision.*, task_ref.external_id AS task_id FROM decision
         JOIN run ON run.id = decision.run
         JOIN task_ref ON task_ref.id = run.task_ref
         ${where} ORDER BY decision.id`,
      )
      .all()
      .map(row => ({ ...readDecision(row), taskId: String(row["task_id"]) }));
  }

  /**
   * The lazy deadline sweep, run at every entry point that shows or answers
   * decisions. Expiry changes what a decision looks like, never what happens
   * to its task: the hold stays, and nothing chooses.
   */
  expireOverdueDecisions(now: Date): number {
    const { changes } = this.db
      .prepare(
        `UPDATE decision SET state = 'expired'
          WHERE state = 'open' AND deadline IS NOT NULL AND deadline <= ?`,
      )
      .run(now.toISOString());
    return Number(changes);
  }

  /** Every decision this task's runs ever raised, newest first — one task page's worth. */
  decisionsForTask(taskRef: number): Decision[] {
    return this.db
      .prepare(
        `SELECT decision.* FROM decision
         JOIN run ON run.id = decision.run
         WHERE run.task_ref = ? ORDER BY decision.id DESC`,
      )
      .all(taskRef)
      .map(readDecision);
  }

  /** Unanswered decisions whose task belongs to this project (or is unplaced). */
  listDecisionsScoped(repo: string | null): (Decision & { taskId: string; repo: string | null })[] {
    // The row's repo rides along so a roll-up caller can prove it against
    // the ceiling per row (Codex roll-up inbox review, finding 1). No SQL
    // LIMIT here, so post-filtering cannot be crowded out.
    return this.db
      .prepare(
        `SELECT decision.*, task_ref.external_id AS task_id, task_ref.repo AS task_repo FROM decision
         JOIN run ON run.id = decision.run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE decision.state IN ('open','expired')
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY decision.id`,
      )
      .all(repo, repo)
      .map(row => ({
        ...readDecision(row),
        taskId: String(row["task_id"]),
        repo: row["task_repo"] === null || row["task_repo"] === undefined ? null : String(row["task_repo"]),
      }));
  }

  countUnansweredScoped(repo: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM decision
         JOIN run ON run.id = decision.run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE decision.state IN ('open','expired')
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)`,
      )
      .get(repo, repo);
    return Number(row?.["n"] ?? 0);
  }

  countUnanswered(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM decision WHERE state IN ('open','expired')")
      .get();
    return Number(row?.["n"] ?? 0);
  }

  /**
   * Attach every answered-but-undelivered decision of this task to a run,
   * snapshot included — the causal record of which answers this attempt was
   * actually given (§4's parent_run provenance, as a relation).
   *
   * "Undelivered" means: not yet attached to any run that finished `built`.
   * A resume that failed may be handed the same answers again; the accepted
   * build is the durable terminus. Selection is causal, never temporal —
   * "newer than the last built run" stops being true the moment a resume
   * fails and a second decision is answered in between.
   */
  attachAnswers(runId: number, taskRef: number): (Decision & { taskId: string })[] {
    // Lineage filter (tournament round-2 finding 7): a racing agent's
    // answers reach only ITS runs; ordinary runs see only ordinary
    // decisions. NULL matches NULL — the two worlds never cross.
    const receiving = this.db.prepare("SELECT contestant FROM run WHERE id = ?").get(runId);
    const contestant = receiving === undefined || receiving["contestant"] === null ? null : Number(receiving["contestant"]);
    const rows = this.db
      .prepare(
        `SELECT decision.*, task_ref.external_id AS task_id FROM decision
         JOIN run ON run.id = decision.run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE run.task_ref = ? AND decision.state = 'answered'
           AND (decision.contestant IS ? OR decision.contestant = ?)
           AND NOT EXISTS (
             SELECT 1 FROM run_decision
             JOIN run AS delivered ON delivered.id = run_decision.run
             WHERE run_decision.decision = decision.id AND delivered.outcome = 'built'
           )
         ORDER BY decision.id`,
      )
      .all(taskRef, contestant, contestant);
    for (const row of rows) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO run_decision (run, decision, choice, note) VALUES (?, ?, ?, ?)`,
        )
        .run(runId, Number(row["id"]), row["choice"], row["note"]);
    }
    return rows.map(row => ({ ...readDecision(row), taskId: String(row["task_id"]) }));
  }

  // ---- attended core (v25) -------------------------------------------------

  /**
   * Mint one attended authorization. Expired predecessors are closed in the
   * SAME transaction (end reason 'expired'); a live one refuses — revoke
   * first, never silently supersede a signature.
   */
  mintAttendedAuthorization(
    input: {
      id: string;
      taskRef: number;
      approver: string;
      runner: string;
      runnerGeneration: number;
      compositeDigest: string;
      termsJson: string;
      maxSessionTurns: number;
      budgetMicrousd: number;
      parentRun?: number | null;
      followup?: string | null;
      absoluteExpiry: string;
      /** Quick mint (C2/M4): the mode signature substitutes for the
       * per-mint password — RE-PROVED here, in the mint transaction
       * itself, never a pre-checked flag: the mode must be live, its
       * digest exact, and the minting approver must BE the signer. */
      basis?: { kind: "mode"; digest: string };
      now: Date;
    },
    mutation: Mutation = {},
  ): { ok: true; authorization: AttendedAuthorization } | { ok: false; reason: "authorization-open" | "mode-ended" } {
    return this.once(mutation, "mintAttendedAuthorization", () =>
      this.transact(() => {
        const now = input.now.toISOString();
        if (input.basis !== undefined) {
          const ref = this.refForId(input.taskRef);
          const mode = ref === null || ref.repo === null ? null : this.activeMode(ref.repo, input.now);
          let quickMint = false;
          if (mode !== null && mode.digest === input.basis.digest && mode.signedBy === input.approver) {
            try {
              quickMint = (JSON.parse(mode.termsJson) as { quickMint?: unknown }).quickMint === true;
            } catch {
              quickMint = false;
            }
          }
          if (!quickMint) return { ok: false as const, reason: "mode-ended" as const };
        }
        this.db
          .prepare(
            `UPDATE attended_authorization SET closed_at = ?, end_reason = 'expired'
              WHERE task_ref = ? AND closed_at IS NULL AND absolute_expiry <= ?`,
          )
          .run(now, input.taskRef, now);
        const open = this.db
          .prepare("SELECT 1 AS hit FROM attended_authorization WHERE task_ref = ? AND closed_at IS NULL LIMIT 1")
          .get(input.taskRef);
        if (open !== undefined) return { ok: false as const, reason: "authorization-open" as const };
        this.db
          .prepare(
            `INSERT INTO attended_authorization
               (id, task_ref, approver, runner, runner_generation, composite_digest, terms_json,
                max_session_turns, budget_microusd, parent_run, followup, created_at, absolute_expiry,
                authority_basis, mode_digest)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.taskRef,
            input.approver,
            input.runner,
            input.runnerGeneration,
            input.compositeDigest,
            input.termsJson,
            input.maxSessionTurns,
            input.budgetMicrousd,
            input.parentRun ?? null,
            input.followup ?? null,
            now,
            input.absoluteExpiry,
            input.basis === undefined ? "password" : "mode",
            input.basis === undefined ? null : input.basis.digest,
          );
        const minted = this.readAuthorization(input.id);
        if (minted === null) throw new Error("attended authorization vanished inside its own mint");
        return { ok: true as const, authorization: minted };
      }),
      result => result.ok,
    );
  }

  /** Close every authorization past its absolute expiry (round-6 finding
   * 8): the durable closure the gates and the partial unique rely on —
   * an expired corpse must not keep a task locked to its named runner. */
  sweepExpiredAuthorizations(now: Date): number {
    const stamp = now.toISOString();
    const { changes } = this.db
      .prepare(
        `UPDATE attended_authorization SET closed_at = ?, end_reason = 'expired'
          WHERE closed_at IS NULL AND absolute_expiry <= ?`,
      )
      .run(stamp, stamp);
    return Number(changes);
  }

  readAuthorization(id: string): AttendedAuthorization | null {
    const row = this.db.prepare("SELECT * FROM attended_authorization WHERE id = ?").get(id);
    return row === undefined ? null : readAuthorizationRow(row);
  }

  /** Open continuation authorizations named to this runner (Phase 2E, A4):
   * unconsumed, carrying a parent attempt — tick's continuation pass reads
   * this; liveness is the caller's check, as everywhere. */
  openContinuationAuthorizations(runner: string): AttendedAuthorization[] {
    return this.db
      .prepare(
        `SELECT * FROM attended_authorization
          WHERE closed_at IS NULL AND attempt_run IS NULL AND parent_run IS NOT NULL AND runner = ?
          ORDER BY created_at`,
      )
      .all(runner)
      .map(readAuthorizationRow);
  }

  /**
   * Why a finished run cannot be continued right now, in words — or null.
   * The ENUMERATED non-terminal publication states (round-3 R7 demanded
   * the concrete list, not "open intents"): a publication still moving
   * ('intended','pushed', or 'opened' with the remote not yet settled) and
   * a merge intent still live ('pending','claimed') both block.
   */
  continuationBlockOf(runId: number): string | null {
    const publication = this.db
      .prepare(
        `SELECT state, remote_state FROM publication WHERE run = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(runId);
    if (publication !== undefined) {
      const state = String(publication["state"]);
      const remote = publication["remote_state"] === null ? null : String(publication["remote_state"]);
      if (state === "intended" || state === "pushed") {
        return `this attempt is being published (${state}) — continue after the pull request settles`;
      }
      if (state === "opened" && (remote === null || remote === "open")) {
        return "this attempt's pull request is open — review it there, or close it before continuing";
      }
      const intent = this.db
        .prepare(
          `SELECT merge_intent.state AS state FROM merge_intent
            JOIN publication ON publication.id = merge_intent.publication
           WHERE publication.run = ? AND merge_intent.state IN ('pending','claimed') LIMIT 1`,
        )
        .get(runId);
      if (intent !== undefined) return "a merge is in flight for this attempt — continue after it settles";
    }
    return null;
  }

  /** The one OPEN authorization for a task, or null. */
  openAuthorizationFor(taskRef: number): AttendedAuthorization | null {
    const row = this.db
      .prepare("SELECT * FROM attended_authorization WHERE task_ref = ? AND closed_at IS NULL")
      .get(taskRef);
    return row === undefined ? null : readAuthorizationRow(row);
  }

  /**
   * One durable liveness beat. The DURABLE COLUMN IS THE AUTHORITATIVE
   * CLOCK; the only suppressed writes are duplicate-tab beats landing
   * within 5 seconds of the stored value, so observed grace never shrinks
   * below 40 of the nominal 45 seconds.
   */
  beatAuthorization(id: string, now: Date): boolean {
    const cutoff = new Date(now.getTime() - 5_000).toISOString();
    const { changes } = this.db
      .prepare(
        `UPDATE attended_authorization SET last_beat_at = ?
          WHERE id = ? AND closed_at IS NULL
            AND (last_beat_at IS NULL OR last_beat_at <= ?)`,
      )
      .run(now.toISOString(), id, cutoff);
    return Number(changes) > 0;
  }

  /** Explicit terminal closure — run end, expiry, or revocation. CAS on open. */
  closeAuthorization(id: string, endReason: string, now: Date): boolean {
    const { changes } = this.db
      .prepare("UPDATE attended_authorization SET closed_at = ?, end_reason = ? WHERE id = ? AND closed_at IS NULL")
      .run(now.toISOString(), endReason, id);
    return Number(changes) > 0;
  }

  /**
   * Consume the ONE attempt — called inside the final dispatch-proof
   * transaction, immediately before spawn. CAS: a second consumer loses.
   */
  consumeAuthorization(id: string, run: number, now: Date): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE attended_authorization SET attempt_run = ?, consumed_at = ?
          WHERE id = ? AND closed_at IS NULL AND attempt_run IS NULL`,
      )
      .run(run, now.toISOString(), id);
    if (Number(changes) > 0) {
      this.db.prepare("UPDATE run SET attended_authorization = ? WHERE id = ?").run(id, run);
      return true;
    }
    return false;
  }

  /**
   * Money already committed against an authorization: settled and uncertain
   * turns at their accounted charge, plus the live reservation of any
   * unsettled turn. The budget gate reads THIS, never run.cost_usd.
   */
  authorizationSpendMicrousd(id: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE
            WHEN st.state IN ('settled','uncertain') THEN COALESCE(st.accounted_microusd, 0)
            WHEN st.state IN ('recorded','written','accepted') THEN st.reserved_microusd
            ELSE 0 END), 0) AS spent
           FROM session_turn st JOIN run r ON r.id = st.run
          WHERE r.attended_authorization = ?`,
      )
      .get(id);
    return Number(row?.["spent"] ?? 0);
  }

  /**
   * Record one turn — the gate where the cap, the single-flight rule, the
   * budget reservation, the lease re-proof, and the open-decision rule all
   * hold or refuse ATOMICALLY (v6 W6: a fenced coordinator fails inside
   * this transaction, not at its next poll). For 'answer' turns the
   * delivery-CAS on decision.delivered_turn happens here; run_decision
   * attaches only at ACCEPTANCE (v6 W5).
   */
  recordSessionTurn(input: {
    run: number;
    sourceKind: SessionTurn["sourceKind"];
    sourceId?: number | null;
    author?: string | null;
    text: string;
    repairLimit?: number;
    now: Date;
  }): { ok: true; turn: SessionTurn } | { ok: false; reason: RecordTurnRefusal } {
    return this.transact(() => {
      const now = input.now.toISOString();
      const held = this.heldSessionOf(input.run);
      if (held === null || held.endedAt !== null) return { ok: false as const, reason: "no-held-session" as const };
      if (held.state !== "open") return { ok: false as const, reason: "fenced" as const };
      const run = this.db.prepare("SELECT task_ref, attended_authorization FROM run WHERE id = ?").get(input.run);
      if (run === undefined || run["attended_authorization"] === null) {
        return { ok: false as const, reason: "no-held-session" as const };
      }
      const authorization = this.readAuthorization(String(run["attended_authorization"]));
      if (authorization === null || authorization.closedAt !== null) {
        return { ok: false as const, reason: "fenced" as const };
      }
      // The synchronous lease re-proof (v6 W6): the recorded lease must be
      // the task's current live lease at this instant.
      if (this.currentLiveLease(Number(run["task_ref"]), input.now) !== held.leaseId) {
        return { ok: false as const, reason: "fenced" as const };
      }
      // The per-authorization turn cap counts EVERY injection across the
      // authorization's runs.
      const counted = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM session_turn st JOIN run r ON r.id = st.run
            WHERE r.attended_authorization = ?`,
        )
        .get(authorization.id);
      if (Number(counted?.["n"] ?? 0) >= authorization.maxSessionTurns) {
        return { ok: false as const, reason: "turn-cap" as const };
      }
      // Single flight: one unsettled turn at a time, by design.
      const unsettled = this.db
        .prepare(
          `SELECT 1 AS hit FROM session_turn
            WHERE run = ? AND state IN ('recorded','written','accepted') LIMIT 1`,
        )
        .get(input.run);
      if (unsettled !== undefined) return { ok: false as const, reason: "turn-open" as const };
      // A waiting question outranks free-form speech: answer it first.
      if (input.sourceKind === "operator") {
        const open = this.db
          .prepare("SELECT 1 AS hit FROM decision WHERE run = ? AND state IN ('open','expired') LIMIT 1")
          .get(input.run);
        if (open !== undefined) return { ok: false as const, reason: "decision-open" as const };
      }
      // Machine repair is bounded per triggering decision, like REPAIR_TURNS.
      if (input.sourceKind === "repair") {
        const limit = input.repairLimit ?? 2;
        const prior = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM session_turn WHERE run = ? AND source_kind = 'repair' AND source_id IS ?",
          )
          .get(input.run, input.sourceId ?? null);
        if (Number(prior?.["n"] ?? 0) >= limit) return { ok: false as const, reason: "repair-exhausted" as const };
      }
      // Reservation = remaining budget: under the stop-threshold semantic
      // and the CLI's cumulative cap, that is the true worst case.
      const spent = this.authorizationSpendMicrousd(authorization.id);
      const remaining = authorization.budgetMicrousd - spent;
      if (remaining <= 0) return { ok: false as const, reason: "budget-exhausted" as const };
      // Answer exactly-once: the delivery-CAS (v6 W5). This whole method is
      // one transaction, so read-then-set is serialized; the partial unique
      // index is the backstop.
      if (input.sourceKind === "answer") {
        const decision = this.db
          .prepare("SELECT delivered_turn FROM decision WHERE id = ?")
          .get(input.sourceId ?? -1);
        if (decision === undefined || decision["delivered_turn"] !== null) {
          return { ok: false as const, reason: "answer-delivered" as const };
        }
      }
      const top = this.db.prepare("SELECT MAX(seq) AS top FROM session_turn WHERE run = ?").get(input.run);
      const seq = Number(top?.["top"] ?? 0) + 1;
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO session_turn
             (run, seq, source_kind, source_id, author, text, reserved_microusd, recorded_at, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recorded')`,
        )
        .run(
          input.run,
          seq,
          input.sourceKind,
          input.sourceId ?? null,
          input.author ?? null,
          input.text,
          remaining,
          now,
        );
      const id = Number(lastInsertRowid);
      if (input.sourceKind === "answer") {
        const claimed = this.db
          .prepare("UPDATE decision SET delivered_turn = ? WHERE id = ? AND delivered_turn IS NULL")
          .run(id, input.sourceId ?? -1);
        if (Number(claimed.changes) === 0) throw new Error("answer delivery lost a race inside its own transaction");
      }
      const turn = this.readSessionTurn(id);
      if (turn === null) throw new Error("session turn vanished inside its own recording");
      return { ok: true as const, turn };
    });
  }

  /** Answered decisions on a held run whose answer has not yet been
   * injected — the coordinator's per-pulse scan (v3 R3). */
  undeliveredDecisionsOf(run: number): Decision[] {
    return this.db
      .prepare("SELECT * FROM decision WHERE run = ? AND state = 'answered' AND delivered_turn IS NULL ORDER BY id")
      .all(run)
      .map(readDecision);
  }

  readSessionTurn(id: number): SessionTurn | null {
    const row = this.db.prepare("SELECT * FROM session_turn WHERE id = ?").get(id);
    return row === undefined ? null : readSessionTurnRow(row);
  }

  sessionTurnsOf(run: number): SessionTurn[] {
    return this.db
      .prepare("SELECT * FROM session_turn WHERE run = ? ORDER BY seq")
      .all(run)
      .map(readSessionTurnRow);
  }

  /** Bytes flushed to stdin. Write success is NOT acceptance (spike fact 5). */
  markTurnWritten(id: number, now: Date): boolean {
    const { changes } = this.db
      .prepare("UPDATE session_turn SET state = 'written', written_at = ? WHERE id = ? AND state = 'recorded'")
      .run(now.toISOString(), id);
    return Number(changes) > 0;
  }

  /**
   * Bind pending answers to the BRIEF turn (round-6 finding 2): a held
   * build's brief carries every answered-but-undelivered decision, and the
   * builder's ordinary pre-spawn attach would claim delivery the agent
   * never proved. The pre-attached run_decision rows are WITHDRAWN here and
   * each decision's delivery-CAS points at the brief turn — run_decision
   * re-attaches only at that turn's acceptance, exactly like answer turns.
   */
  bindBriefDeliveries(runId: number, briefTurn: number, decisionIds: readonly number[]): void {
    if (decisionIds.length === 0) return;
    this.transact(() => {
      for (const decision of decisionIds) {
        this.db.prepare("DELETE FROM run_decision WHERE run = ? AND decision = ?").run(runId, decision);
        this.db
          .prepare("UPDATE decision SET delivered_turn = ? WHERE id = ? AND delivered_turn IS NULL")
          .run(briefTurn, decision);
      }
    });
  }

  /**
   * Acceptance — THIS turn's system/init (or its result, retroactively).
   * This is also where run_decision attaches, for EVERY decision whose
   * delivery-CAS points at this turn (answer turns claim one at recording;
   * a brief turn claims every pending answer it carried): delivery is
   * claimed only once the agent provably received the words (v6 W5).
   */
  markTurnAccepted(id: number, now: Date): boolean {
    return this.transact(() => {
      const { changes } = this.db
        .prepare(
          `UPDATE session_turn SET state = 'accepted', accepted_at = ?
            WHERE id = ? AND state IN ('recorded','written')`,
        )
        .run(now.toISOString(), id);
      if (Number(changes) === 0) return false;
      const turn = this.readSessionTurn(id);
      if (turn !== null) this.attachDeliveriesOf(turn.run, id);
      return true;
    });
  }

  private attachDeliveriesOf(runId: number, turnId: number): void {
    const carried = this.db
      .prepare("SELECT id, choice, note FROM decision WHERE delivered_turn = ?")
      .all(turnId);
    for (const decision of carried) {
      this.db
        .prepare("INSERT OR IGNORE INTO run_decision (run, decision, choice, note) VALUES (?, ?, ?, ?)")
        .run(runId, Number(decision["id"]), decision["choice"], decision["note"]);
    }
  }

  /**
   * Settle a turn from its result. The provider's totals are CUMULATIVE per
   * process, so the measured charge is the marginal delta from the held
   * session's durable baseline, advanced here atomically. A missing or
   * regressing total is a TELEMETRY FAILURE: the turn settles uncertain at
   * its reservation, the baseline stays, and the caller must end the hold.
   * Run aggregates gain the same delta so attended spend never disappears
   * from routine reporting (v3 R4).
   */
  settleTurn(
    id: number,
    result: { cumulativeMicrousd: number | null; outputTokens: number | null; now: Date },
  ): { ok: true; measuredMicrousd: number } | { ok: false; reason: "telemetry" | "not-unsettled" } {
    return this.transact(() => {
      const turn = this.readSessionTurn(id);
      if (turn === null || !["recorded", "written", "accepted"].includes(turn.state)) {
        return { ok: false as const, reason: "not-unsettled" as const };
      }
      const held = this.heldSessionOf(turn.run);
      if (held === null) return { ok: false as const, reason: "not-unsettled" as const };
      const now = result.now.toISOString();
      if (result.cumulativeMicrousd === null || result.cumulativeMicrousd < held.cumulativeMicrousd) {
        // Conservative posture: charge the reservation, never invent zero.
        this.db
          .prepare(
            `UPDATE session_turn SET state = 'uncertain', settled_at = ?,
                    accounted_microusd = reserved_microusd, accounted_at = ? WHERE id = ?`,
          )
          .run(now, now, id);
        this.chargeRunAggregates(turn.run, turn.reservedMicrousd, 0);
        return { ok: false as const, reason: "telemetry" as const };
      }
      const measured = result.cumulativeMicrousd - held.cumulativeMicrousd;
      const tokens = result.outputTokens ?? 0;
      // Result proves acceptance when the init was missed (spike-consistent).
      this.db
        .prepare(
          `UPDATE session_turn SET state = 'settled', settled_at = ?,
                  accepted_at = COALESCE(accepted_at, ?),
                  measured_microusd = ?, output_tokens = ?,
                  accounted_microusd = ?, accounted_at = ? WHERE id = ?`,
        )
        .run(now, now, measured, result.outputTokens ?? null, measured, now, id);
      if (turn.acceptedAt === null) {
        // The acceptance this settlement back-filled attaches whatever
        // deliveries the turn carried (answers, or a brief's pending set).
        this.attachDeliveriesOf(turn.run, id);
      }
      this.db
        .prepare(
          `UPDATE held_session SET cumulative_microusd = ?, cumulative_tokens_out = cumulative_tokens_out + ?
            WHERE run = ?`,
        )
        .run(result.cumulativeMicrousd, tokens, turn.run);
      this.chargeRunAggregates(turn.run, measured, tokens);
      return { ok: true as const, measuredMicrousd: measured };
    });
  }

  /**
   * Terminal conservative settlement on process exit (ruling 15).
   * 'cancelled' = recorded but never written: charged zero. 'uncertain' =
   * written or accepted but never proven settled: charged its reservation.
   * A turn that never reached ACCEPTANCE reverts its delivery claim so the
   * ordinary road can deliver the answer later (v6 W5); an accepted turn
   * keeps its attach — acceptance is the proof.
   */
  settleTurnTerminal(id: number, terminal: "uncertain" | "cancelled", now: Date): boolean {
    return this.transact(() => {
      const turn = this.readSessionTurn(id);
      if (turn === null || !["recorded", "written", "accepted"].includes(turn.state)) return false;
      const at = now.toISOString();
      const charge = terminal === "uncertain" ? turn.reservedMicrousd : 0;
      this.db
        .prepare(
          `UPDATE session_turn SET state = ?, settled_at = ?, accounted_microusd = ?, accounted_at = ?
            WHERE id = ?`,
        )
        .run(terminal, at, charge, at, id);
      if (turn.acceptedAt === null) {
        // Never-accepted: EVERY delivery claim this turn held reverts —
        // an answer turn's one decision, or a brief turn's pending set —
        // so the ordinary road can deliver later (v6 W5, round-6 f2).
        this.db.prepare("UPDATE decision SET delivered_turn = NULL WHERE delivered_turn = ?").run(id);
      }
      if (charge > 0) this.chargeRunAggregates(turn.run, charge, 0);
      return true;
    });
  }

  private chargeRunAggregates(run: number, microusd: number, tokensOut: number): void {
    this.db
      .prepare(
        `UPDATE run SET cost_usd = COALESCE(cost_usd, 0) + ?,
                tokens_out = COALESCE(tokens_out, 0) + ? WHERE id = ?`,
      )
      .run(microusd / 1_000_000, tokensOut, run);
  }

  /**
   * Custody intent — INSERTed in the final dispatch-proof transaction,
   * before spawn. The run-held partial unique refuses a
   * second hold typed, not by accident.
   */
  openHeldSession(input: {
    run: number;
    authorizationId: string;
    runner: string;
    leaseId: string;
    upIncarnation: string;
    cookie: string;
    socketPath: string;
    now: Date;
  }): { ok: true } | { ok: false; reason: "run-held" } {
    try {
      this.db
        .prepare(
          `INSERT INTO held_session
             (run, authorization_id, runner, lease_id, up_incarnation, cookie, socket_path, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.run,
          input.authorizationId,
          input.runner,
          input.leaseId,
          input.upIncarnation,
          input.cookie,
          input.socketPath,
          input.now.toISOString(),
        );
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // SQLite names the COLUMN in unique violations, never the index.

      if (message.includes("UNIQUE") || message.includes("PRIMARY KEY")) return { ok: false, reason: "run-held" };
      throw error;
    }
  }

  /** Stamp pids after spawn. False = the row closed underneath the spawn — kill the child. */
  stampHeldSession(run: number, supervisorPid: number, agentPgid: number): boolean {
    const { changes } = this.db
      .prepare("UPDATE held_session SET supervisor_pid = ?, agent_pgid = ? WHERE run = ? AND ended_at IS NULL")
      .run(supervisorPid, agentPgid, run);
    return Number(changes) > 0;
  }

  heldSessionOf(run: number): HeldSession | null {
    const row = this.db.prepare("SELECT * FROM held_session WHERE run = ?").get(run);
    return row === undefined ? null : readHeldSessionRow(row);
  }

  /** Every un-ended custody row — the fence sweep's and hard-stop's read. */
  /** The durable session gauge (v28): open custody rows for this runner —
   * a restarted `up` with orphans pending must count them, so the
   * in-process map is never the truth. */
  openHeldSessionCount(runner: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM held_session WHERE runner = ? AND ended_at IS NULL")
      .get(runner);
    return Number(row?.["n"] ?? 0);
  }

  /** Every open authorization on this runner — the beat-all's worklist. */
  openAuthorizationsOf(runner: string): AttendedAuthorization[] {
    return this.db
      .prepare("SELECT * FROM attended_authorization WHERE runner = ? AND closed_at IS NULL")
      .all(runner)
      .map(readAuthorizationRow);
  }

  openHeldSessions(): HeldSession[] {
    return this.db
      .prepare("SELECT * FROM held_session WHERE ended_at IS NULL ORDER BY run")
      .all()
      .map(readHeldSessionRow);
  }

  /** Ordinary close by the owning coordinator. CAS on un-ended. */
  endHeldSession(run: number, endReason: string, now: Date): boolean {
    const { changes } = this.db
      .prepare("UPDATE held_session SET ended_at = ?, end_reason = ? WHERE run = ? AND ended_at IS NULL")
      .run(now.toISOString(), endReason, run);
    return Number(changes) > 0;
  }

  /**
   * SEIZE custody for fencing (v6, after v4 Q5): CAS open→fencing AND fence
   * the recorded lease in ONE transaction, so a wedged owner's heartbeat
   * revival and every later coordinator write fail before any kill happens.
   */
  seizeHeldSession(
    run: number,
    fencer: string,
    deadline: Date,
    now: Date,
  ): { ok: true; session: HeldSession } | { ok: false; reason: "not-open" } {
    return this.transact(() => {
      const { changes } = this.db
        .prepare(
          `UPDATE held_session SET state = 'fencing', fencer = ?, fencing_deadline = ?
            WHERE run = ? AND state = 'open' AND ended_at IS NULL`,
        )
        .run(fencer, deadline.toISOString(), run);
      if (Number(changes) === 0) return { ok: false as const, reason: "not-open" as const };
      const session = this.heldSessionOf(run);
      if (session === null) throw new Error("held session vanished inside its own seize");
      this.db
        .prepare("UPDATE claim SET released_at = ?, released_by = 'held-fence' WHERE lease_id = ? AND released_at IS NULL")
        .run(now.toISOString(), session.leaseId);
      return { ok: true as const, session };
    });
  }

  /**
   * Take over a fencing operation whose owner went quiet (v5 P3): CAS on
   * the EXPIRED deadline. A loser stops only while a live fencer owns it.
   */
  takeoverHeldFencing(run: number, fencer: string, deadline: Date, now: Date): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE held_session SET fencer = ?, fencing_deadline = ?
          WHERE run = ? AND state = 'fencing' AND ended_at IS NULL AND fencing_deadline <= ?`,
      )
      .run(fencer, deadline.toISOString(), run, now.toISOString());
    return Number(changes) > 0;
  }

  /** Re-arm the fencing deadline while the work continues. Owner-CASed. */
  renewHeldFencing(run: number, fencer: string, deadline: Date): boolean {
    const { changes } = this.db
      .prepare(
        "UPDATE held_session SET fencing_deadline = ? WHERE run = ? AND state = 'fencing' AND fencer = ?",
      )
      .run(deadline.toISOString(), run, fencer);
    return Number(changes) > 0;
  }

  /** Final close of a fenced session — owner-CASed, after kill + settlement. */
  closeHeldFencing(run: number, fencer: string, endReason: string, now: Date): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE held_session SET ended_at = ?, end_reason = ?
          WHERE run = ? AND state = 'fencing' AND fencer = ? AND ended_at IS NULL`,
      )
      .run(now.toISOString(), endReason, run, fencer);
    return Number(changes) > 0;
  }

  /**
   * File one steering note (arc 1). Validation is validateNote EXACTLY —
   * no bespoke rule — and filing refuses on finished tasks and during open
   * tournaments (contestants share a task; all-racer delivery is a future
   * many-to-many, not a silent single-racer lie).
   */
  fileSteerNote(
    taskId: string,
    author: VerifiedAuthor,
    note: string,
    now: Date,
    mutation: Mutation = {},
  ): { ok: true; id: number } | { ok: false; reason: "unknown-task" | "task-finished" | "contest-open" | "invalid-note"; problem?: string } {
    return this.once(
      mutation,
      "fileSteerNote",
      () =>
        this.transact(() => {
          const valid = validateNote(note);
          if (!valid.ok) return { ok: false as const, reason: "invalid-note" as const, problem: valid.problem };
          const task = this.db.prepare("SELECT state FROM task WHERE id = ?").get(taskId);
          const ref = this.db
            .prepare("SELECT id FROM task_ref WHERE backend = ? AND external_id = ?")
            .get(BUILT_IN, taskId);
          if (task === undefined || ref === undefined) return { ok: false as const, reason: "unknown-task" as const };
          const state = String(task["state"]);
          if (state === "done" || state === "cancelled") return { ok: false as const, reason: "task-finished" as const };
          const racing = this.db
            .prepare(
              `SELECT 1 AS hit FROM contest WHERE task_ref = ?
                AND state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted') LIMIT 1`,
            )
            .get(Number(ref["id"]));
          if (racing !== undefined) return { ok: false as const, reason: "contest-open" as const };
          const inserted = this.db
            .prepare("INSERT INTO task_steer (task_ref, author, note, created_at, authorship_state) VALUES (?, ?, ?, ?, 'verified')")
            .run(Number(ref["id"]), author as unknown as string, valid.note, now.toISOString());
          this.bumpWake();
          return { ok: true as const, id: Number(inserted.lastInsertRowid) };
        }),
      result => result.ok,
    );
  }

  /** Every steering note of a task, filing order, delivery state included. */
  listSteerNotes(taskRef: number): SteerNote[] {
    return this.db
      .prepare("SELECT * FROM task_steer WHERE task_ref = ? ORDER BY id")
      .all(taskRef)
      .map(readSteerNote);
  }

  /** Undelivered, unsuperseded notes — the admitContest refusal predicate. */
  pendingSteerCount(taskRef: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM task_steer WHERE task_ref = ? AND delivered_at IS NULL AND superseded_at IS NULL")
      .get(taskRef);
    return Number(row?.["n"] ?? 0);
  }

  /**
   * The attach transaction (arc 1 finding 9): a DEDICATED pre-invocation
   * step, called by the builder after the run row exists and immediately
   * before the spawn. Selects pending notes whose previous attachment — if
   * any — is provably ABANDONED (finding 12): the attached run concluded,
   * or its lease is no longer the task's current live lease. Crashed runs
   * keep outcome NULL forever, so liveness, not finalization, is the
   * predicate — the same ONE fact the console derives runIsLive from.
   * Stamps attachment and returns exactly what the brief must quote.
   */
  attachSteerNotes(taskRef: number, runId: number, now: Date): SteerNote[] {
    return this.transact(() => {
      const run = this.db.prepare("SELECT task_ref, outcome, lease_id FROM run WHERE id = ?").get(runId);
      if (run === undefined || Number(run["task_ref"]) !== taskRef || run["outcome"] !== null) {
        throw new Error(`run ${runId} is not an open attempt of this task — steering attaches to nothing else`);
      }
      const live = this.currentLiveLease(taskRef, now);
      const rows = this.db
        .prepare(
          `SELECT * FROM task_steer
            -- Only VERIFIED authorship may enter a brief (ruling 11): the
            -- quarantine superseded legacy rows, and this predicate is the
            -- belt to that braces.
            WHERE task_ref = ? AND authorship_state = 'verified'
              AND delivered_at IS NULL AND superseded_at IS NULL
              AND (
                attached_run IS NULL
                OR attached_run = ?
                OR EXISTS (
                  SELECT 1 FROM run AS held WHERE held.id = task_steer.attached_run
                    AND (held.outcome IS NOT NULL OR ? IS NULL OR held.lease_id <> ?)
                )
              )
            ORDER BY id`,
        )
        .all(taskRef, runId, live, live);
      const stamp = now.toISOString();
      for (const row of rows) {
        this.db
          .prepare("UPDATE task_steer SET attached_run = ?, attached_at = ? WHERE id = ?")
          .run(runId, stamp, Number(row["id"]));
      }
      return rows.map(row => readSteerNote({ ...row, attached_run: runId, attached_at: stamp }));
    });
  }

  /**
   * The receipt (arc 1 finding 8): the stream proved the prompt reached the
   * agent, so every note riding this run settles delivered — immediately,
   * durably, and independently of how the run later ends. Null-guarded:
   * first receipt wins, and a replay changes nothing.
   */
  settleSteerDelivered(runId: number, now: Date): number {
    const { changes } = this.db
      .prepare("UPDATE task_steer SET delivered_at = ? WHERE attached_run = ? AND delivered_at IS NULL")
      .run(now.toISOString(), runId);
    return Number(changes);
  }

  /** A finished task's pending notes settle superseded — shown, typed, done. */
  supersedeSteerNotes(taskRef: number, now: Date): number {
    const { changes } = this.db
      .prepare("UPDATE task_steer SET superseded_at = ? WHERE task_ref = ? AND delivered_at IS NULL AND superseded_at IS NULL")
      .run(now.toISOString(), taskRef);
    return Number(changes);
  }

  /** The answers a run was given, exactly as it was given them. */
  answersFor(runId: number): { decision: Decision; choice: string; note: string | null }[] {
    return this.db
      .prepare(
        `SELECT decision.*, run_decision.choice AS given_choice, run_decision.note AS given_note
           FROM run_decision
           JOIN decision ON decision.id = run_decision.decision
          WHERE run_decision.run = ? ORDER BY decision.id`,
      )
      .all(runId)
      .map(row => ({
        decision: readDecision(row),
        choice: String(row["given_choice"]),
        note: row["given_note"] === null ? null : String(row["given_note"]),
      }));
  }

  /**
   * Answer a decision: one transaction for the CAS, the hold, and the outbox
   * episode, because a crash between any two of them leaves a lie — answered
   * but still held, or free but still paging.
   *
   * `by` is an identity the CALLER authenticated; this method records, it
   * does not vouch. A decision is answered once: the same choice replayed is
   * the stored answer handed back, a different choice is refused — "done"
   * is not negotiable, and neither is "decided".
   */
  answerDecision(
    answer: { id: number; choice: string; by: string; via: "cli" | "web" | "telegram"; note?: string },
    now: Date,
    mutation: Mutation = {},
  ):
    | { ok: true; decision: Decision; duplicate?: boolean }
    | { ok: false; reason: "unknown-decision" | "bad-option" | "already-answered" | "bad-note" } {
    return this.once(
      mutation,
      "answerDecision",
      () => this.transact(() => this.answerDecisionLocked(answer, now)),
      result => result.ok,
    );
  }

  /**
   * The answer's body, for callers already holding the transaction — the
   * Telegram bridge re-proves its binding and consumes its action token in
   * the same transaction as this CAS, because "the chat was bound when we
   * looked" and "the chat is bound as this answer lands" are different
   * claims and only the second one authorizes anything.
   */
  answerDecisionLocked(
    answer: { id: number; choice: string; by: string; via: "cli" | "web" | "telegram"; note?: string },
    now: Date,
  ):
    | { ok: true; decision: Decision; duplicate?: boolean }
    | { ok: false; reason: "unknown-decision" | "bad-option" | "already-answered" | "bad-note" } {
    const existing = this.getDecision(answer.id);
    if (existing === null) return { ok: false as const, reason: "unknown-decision" as const };
    if (!existing.options.some(option => option.id === answer.choice)) {
      return { ok: false as const, reason: "bad-option" as const };
    }
    // The note reaches web pages, terminals, and — quoted — a later
    // agent's brief. One shared validator, and this is its final gate.
    if (answer.note !== undefined && !validateNote(answer.note).ok) {
      return { ok: false as const, reason: "bad-note" as const };
    }

    const { changes } = this.db
      .prepare(
        `UPDATE decision SET state = 'answered', answered_at = ?, answered_by = ?,
                             answered_via = ?, choice = ?, note = ?
          WHERE id = ? AND state IN ('open','expired')`,
      )
      .run(now.toISOString(), answer.by, answer.via, answer.choice, answer.note?.trim() ?? null, answer.id);
    if (Number(changes) === 0) {
      // Duplicate success requires the whole TUPLE — choice AND note. The
      // same option with a different note is not the same answer: reporting
      // success while the racing note was silently dropped would tell the
      // operator their constraint traveled when it never did (Codex
      // free-text review, finding 4).
      const settled = this.getDecision(answer.id) as Decision;
      return settled.choice === answer.choice && (settled.note ?? null) === (answer.note?.trim() ?? null)
        ? { ok: true as const, decision: settled, duplicate: true }
        : { ok: false as const, reason: "already-answered" as const };
    }

    this.releaseOwnedHold("decision", String(answer.id));
    this.resolveEpisode(`decision:${answer.id}`, now);
    this.bumpWake();
    return { ok: true as const, decision: this.getDecision(answer.id) as Decision };
  }

  // ---- evidence ------------------------------------------------------------

  saveArtifact(
    artifact: {
      run: number;
      kind: Artifact["kind"];
      key: string;
      bytesOriginal: number;
      bytesStored: number;
      truncated: boolean;
      sha256: string;
      capture: string;
      /** Set when the stored bytes were REDACTED before storage (audit IV-7). */
      redacted?: boolean;
      /** Typed verdict of the capture command — a pick predicate reads THIS, never the prose in `capture`. */
      captureStatus?: "ok" | "failed";
    },
    now: Date,
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO artifact (run, kind, key, bytes_original, bytes_stored, truncated, sha256, capture, created_at, redacted, capture_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.run,
        artifact.kind,
        artifact.key,
        artifact.bytesOriginal,
        artifact.bytesStored,
        artifact.truncated ? 1 : 0,
        artifact.sha256,
        artifact.capture,
        now.toISOString(),
        artifact.redacted === true ? 1 : 0,
        artifact.captureStatus ?? null,
      );
    return Number(inserted.lastInsertRowid);
  }

  /** The latest handoff artifact for a task's runs — what a successor reads (audit SD-2). */
  latestHandoffArtifact(taskRef: number): Artifact | null {
    const row = this.db
      .prepare(
        `SELECT artifact.* FROM artifact
         JOIN run ON run.id = artifact.run
         WHERE run.task_ref = ? AND artifact.kind = 'handoff'
         ORDER BY artifact.id DESC LIMIT 1`,
      )
      .get(taskRef);
    return row === undefined ? null : readArtifact(row);
  }

  /** Whether a run's terminal diff was redacted for secrets (audit IV-7) — the publication gate reads this. */
  hasRedactedTerminalDiff(run: number): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM artifact WHERE run = ? AND kind = 'terminal-diff' AND redacted = 1 LIMIT 1")
      .get(run);
    return row !== undefined;
  }

  getArtifact(id: number): Artifact | null {
    const row = this.db.prepare("SELECT * FROM artifact WHERE id = ?").get(id);
    return row === undefined ? null : readArtifact(row);
  }

  /**
   * The artifact only if it belongs to this run — membership enforced by
   * the lookup itself, never by route choreography around two lookups. A
   * mismatched pair is simply not found, whatever the URL claimed.
   */
  artifactForRun(runId: number, artifactId: number): Artifact | null {
    const row = this.db
      .prepare("SELECT * FROM artifact WHERE run = ? AND id = ?")
      .get(runId, artifactId);
    return row === undefined ? null : readArtifact(row);
  }

  artifactsFor(run: number): Artifact[] {
    return this.db
      .prepare("SELECT * FROM artifact WHERE run = ? ORDER BY id")
      .all(run)
      .map(readArtifact);
  }

  /**
   * Attach evidence to a decision — refused unless both belong to the same
   * run. The guard is in the INSERT itself rather than checked first, so
   * nothing can slip between the check and the write.
   */
  linkEvidence(decision: number, artifact: number): void {
    const { changes } = this.db
      .prepare(
        `INSERT INTO decision_artifact (decision, artifact)
         SELECT d.id, a.id FROM decision AS d JOIN artifact AS a
          WHERE d.id = ? AND a.id = ? AND a.run = d.run`,
      )
      .run(decision, artifact);
    if (Number(changes) === 0) {
      throw new Error(
        `artifact ${artifact} does not belong to decision ${decision}'s run — evidence never crosses runs`,
      );
    }
  }

  evidenceFor(decision: number): Artifact[] {
    return this.db
      .prepare(
        `SELECT artifact.* FROM artifact
         JOIN decision_artifact ON decision_artifact.artifact = artifact.id
         WHERE decision_artifact.decision = ? ORDER BY artifact.id`,
      )
      .all(decision)
      .map(readArtifact);
  }

  // ---- incidents -----------------------------------------------------------

  createIncident(incident: { run: number; kind: Incident["kind"] }, now: Date): number {
    const inserted = this.db
      .prepare("INSERT INTO incident (run, kind, created_at) VALUES (?, ?, ?)")
      .run(incident.run, incident.kind, now.toISOString());
    return Number(inserted.lastInsertRowid);
  }

  incidentForRun(run: number): Incident | null {
    const row = this.db.prepare("SELECT * FROM incident WHERE run = ?").get(run);
    return row === undefined ? null : readIncident(row);
  }

  /** Unresolved, task attached, oldest first. No time window: these do not age out. */
  openIncidents(repo: string | null = null): (Incident & { taskId: string })[] {
    return this.db
      .prepare(
        `SELECT incident.*, task_ref.external_id AS task_id FROM incident
         JOIN run ON run.id = incident.run
         JOIN task_ref ON task_ref.id = run.task_ref
         WHERE incident.resolved_at IS NULL
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY incident.id`,
      )
      .all(repo, repo)
      .map(row => ({ ...readIncident(row), taskId: String(row["task_id"]) }));
  }

  /** Every incident this task's runs ever raised, newest first, resolved or not. */
  incidentsForTask(taskRef: number): Incident[] {
    return this.db
      .prepare(
        `SELECT incident.* FROM incident
         JOIN run ON run.id = incident.run
         WHERE run.task_ref = ? ORDER BY incident.id DESC`,
      )
      .all(taskRef)
      .map(readIncident);
  }

  /** Resolving also lifts the incident's hold — one act, one transaction, owned here. */
  resolveIncident(id: number, by: string, now: Date): boolean {
    return this.transact(() => this.resolveIncidentLocked(id, by, now));
  }

  /** The body, for callers already holding the transaction (requeueTask). */
  private resolveIncidentLocked(id: number, by: string, now: Date): boolean {
    const incident = this.db
      .prepare("SELECT kind, run FROM incident WHERE id = ?")
      .get(id);
    const { changes } = this.db
      .prepare("UPDATE incident SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL")
      .run(now.toISOString(), by, id);
    if (Number(changes) === 0) return false;
    this.releaseOwnedHold("incident", String(id));
    // The incident's PAGE episode resolves with it (external dispatch
    // review, finding 43) — a stale page delivered after resolution told
    // the operator about a problem that no longer stands. Keys follow the
    // enqueue sites' own vocabulary, per kind.
    if (incident !== undefined) {
      const run = Number(incident["run"]);
      const kind = String(incident["kind"]);
      const taskRef = this.db.prepare("SELECT task_ref FROM run WHERE id = ?").get(run);
      const keys: Record<string, string> = {
        "malformed-decision": `malformed:${run}`,
        "commit-failure": `commit-failure:${run}`,
        "malformed-plan": `malformed-plan:${run}`,
        ...(taskRef === undefined
          ? {}
          : {
              "attempts-exhausted": `stalled:${Number(taskRef["task_ref"])}`,
              "plan-attempts-exhausted": `plan-stalled:${Number(taskRef["task_ref"])}`,
            }),
      };
      const key = keys[kind];
      if (key !== undefined) this.resolveEpisode(key, now);
    }
    this.bumpWake();
    return true;
  }

  // ---- telegram ------------------------------------------------------------

  /** Mint a pairing code's record. The code itself was shown once; this is its hash. */
  createTelegramPairing(
    pairing: { codeHash: string; approver: string; by: string; ttlMs: number },
    now: Date,
  ): void {
    const generation = this.approverGeneration(pairing.approver);
    if (generation === null) throw new Error(`no approver named ${pairing.approver}`);
    this.db
      .prepare(
        `INSERT INTO telegram_pairing (code_hash, approver, approver_generation, created_at, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pairing.codeHash,
        pairing.approver,
        generation,
        now.toISOString(),
        pairing.by,
        new Date(now.getTime() + pairing.ttlMs).toISOString(),
      );
  }

  /**
   * Consume a pairing code and create the binding, as one transaction.
   *
   * The conditional UPDATE is the consumption: exactly one caller ever sees
   * `changes = 1`, however many pollers race. A replay of the very update
   * that paired (Telegram redelivers) recognizes the finished binding
   * instead of failing. Success invalidates every other outstanding code —
   * a code that was minted and superseded must not still open a door — and
   * the partial unique index enforces one live binding per bot.
   */
  consumeTelegramPairing(
    attempt: {
      codeHash: string;
      botId: string;
      chatId: string;
      userId: string;
      updateId: number;
    },
    now: Date,
  ):
    | { ok: true; binding: TelegramBinding; replay: boolean }
    | { ok: false; reason: "unknown-code" | "already-bound" } {
    return this.transact(() => {
      const stamp = now.toISOString();
      const { changes } = this.db
        .prepare(
          `UPDATE telegram_pairing
              SET consumed_at = ?, consumed_chat = ?, consumed_user = ?, consumed_update = ?
            WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(stamp, attempt.chatId, attempt.userId, attempt.updateId, attempt.codeHash, stamp);

      if (Number(changes) === 0) {
        // The same update replayed after a crash-between-apply-and-ack:
        // the code is consumed by exactly this chat and user, and the
        // binding it made is live. That is a completed pairing, not a foe.
        const consumed = this.db
          .prepare(
            `SELECT 1 AS hit FROM telegram_pairing
              WHERE code_hash = ? AND consumed_chat = ? AND consumed_user = ? AND consumed_update = ?`,
          )
          .get(attempt.codeHash, attempt.chatId, attempt.userId, attempt.updateId);
        if (consumed !== undefined) {
          const live = this.liveTelegramBinding(attempt.botId);
          if (live !== null && live.chatId === attempt.chatId && live.userId === attempt.userId) {
            return { ok: true as const, binding: live, replay: true };
          }
        }
        return { ok: false as const, reason: "unknown-code" as const };
      }

      const pairing = this.db
        .prepare("SELECT approver, approver_generation FROM telegram_pairing WHERE code_hash = ?")
        .get(attempt.codeHash) as Record<string, unknown>;

      // The code was minted under a generation; the binding is only valid
      // if that generation still stands — a rotation between mint and
      // consumption strands the code.
      const current = this.approverGeneration(String(pairing["approver"]));
      if (current === null || current !== Number(pairing["approver_generation"])) {
        return { ok: false as const, reason: "unknown-code" as const };
      }

      try {
        this.db
          .prepare(
            `INSERT INTO telegram_binding (bot_id, chat_id, user_id, approver, approver_generation, paired_at, paired_by, pair_update_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            attempt.botId,
            attempt.chatId,
            attempt.userId,
            String(pairing["approver"]),
            Number(pairing["approver_generation"]),
            stamp,
            String(pairing["approver"]),
            attempt.updateId,
          );
      } catch {
        // The partial unique index said no: a live binding already exists.
        return { ok: false as const, reason: "already-bound" as const };
      }
      // Every other outstanding code dies with this success.
      this.db.prepare("DELETE FROM telegram_pairing WHERE consumed_at IS NULL").run();

      const binding = this.liveTelegramBinding(attempt.botId);
      if (binding === null) throw new Error("the binding vanished inside its own transaction");
      return { ok: true as const, binding, replay: false };
    });
  }

  /**
   * The one live binding for a bot — and only while its approver's
   * credential generation still matches. A rotation that somehow missed the
   * sweep reads as no binding at all, which is the failure direction that
   * fails closed.
   */
  liveTelegramBinding(botId: string): TelegramBinding | null {
    const row = this.db
      .prepare(
        `SELECT telegram_binding.* FROM telegram_binding
         JOIN approver ON approver.name = telegram_binding.approver
          AND approver.generation = telegram_binding.approver_generation
          AND approver.revoked_at IS NULL
         WHERE bot_id = ? AND telegram_binding.revoked_at IS NULL`,
      )
      .get(botId);
    return row === undefined ? null : readTelegramBinding(row);
  }

  /** Revoke a bot's live binding and everything it could still do. */
  unpairTelegram(botId: string, by: string, now: Date): boolean {
    return this.transact(() => {
      const live = this.liveTelegramBinding(botId);
      if (live === null) return false;
      const stamp = now.toISOString();
      this.db
        .prepare("UPDATE telegram_binding SET revoked_at = ?, revoked_by = ? WHERE id = ?")
        .run(stamp, by, live.id);
      this.db
        .prepare("UPDATE telegram_action SET consumed_at = ? WHERE binding = ? AND consumed_at IS NULL")
        .run(stamp, live.id);
      return true;
    });
  }

  createTelegramAction(
    action: {
      token: string;
      binding: number;
      decision: number;
      optionId: string;
      phase: "choose" | "confirm" | "cancel";
      chatId: string;
      messageId?: string;
      ttlMs?: number;
      /** Binds an irreversible confirmation to the EXACT note it showed. */
      noteDigest?: string;
    },
    now: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO telegram_action (token, binding, decision, option_id, phase, chat_id, message_id, created_at, expires_at, note_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.token,
        action.binding,
        action.decision,
        action.optionId,
        action.phase,
        action.chatId,
        action.messageId ?? null,
        now.toISOString(),
        action.ttlMs === undefined ? null : new Date(now.getTime() + action.ttlMs).toISOString(),
        action.noteDigest ?? null,
      );
  }

  // ---- free-text drafts (v10) ---------------------------------------------

  /** Which decision an outbound Telegram message carried. Recorded after the
   * send returns its id; a send whose record was lost routes nothing. */
  recordTelegramDecisionMessage(binding: number, chatId: string, messageId: string, decision: number, now: Date): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO telegram_decision_message (binding, chat_id, message_id, decision, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(binding, chatId, messageId, decision, now.toISOString());
  }

  /** The decision behind an exact replied-to message, or nothing. Never "the latest". */
  decisionForTelegramMessage(binding: number, chatId: string, messageId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT decision FROM telegram_decision_message WHERE binding = ? AND chat_id = ? AND message_id = ?",
      )
      .get(binding, chatId, messageId);
    return row === undefined ? null : Number(row["decision"]);
  }

  /** The one live, unexpired draft for a decision, if any. */
  liveNoteDraft(binding: number, decision: number, now: Date): { id: number; note: string; updateId: number; state: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, note, update_id, state FROM telegram_note_draft
          WHERE binding = ? AND decision = ? AND state IN ('pending','armed') AND expires_at > ?`,
      )
      .get(binding, decision, now.toISOString());
    return row === undefined
      ? null
      : { id: Number(row["id"]), note: String(row["note"]), updateId: Number(row["update_id"]), state: String(row["state"]) };
  }

  /**
   * Persist a validated note as the live draft. A newer update SUPERSEDES
   * the old draft — drafts are immutable, and only a GREATER update_id may
   * replace one, so out-of-order delivery cannot resurrect an older note
   * (Codex free-text review, state machine). Returns false when an older
   * or equal update tried.
   */
  saveNoteDraft(
    draft: { binding: number; decision: number; updateId: number; messageId: string; replyTo: string; note: string },
    now: Date,
    ttlMs = 10 * 60_000,
  ): boolean {
    return this.transact(() => {
      const live = this.db
        .prepare(
          `SELECT id, update_id FROM telegram_note_draft
            WHERE binding = ? AND decision = ? AND state IN ('pending','armed')`,
        )
        .get(draft.binding, draft.decision);
      if (live !== undefined) {
        if (Number(live["update_id"]) >= draft.updateId) return false;
        this.db.prepare("UPDATE telegram_note_draft SET state = 'superseded' WHERE id = ?").run(live["id"]);
      }
      this.db
        .prepare(
          `INSERT INTO telegram_note_draft (binding, decision, update_id, message_id, reply_to, note, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          draft.binding,
          draft.decision,
          draft.updateId,
          draft.messageId,
          draft.replyTo,
          draft.note,
          now.toISOString(),
          new Date(now.getTime() + ttlMs).toISOString(),
        );
      return true;
    });
  }

  /** Move a draft between states; the caller owns the transaction story. */
  setNoteDraftState(id: number, state: "pending" | "armed" | "superseded" | "consumed" | "discarded"): void {
    this.db.prepare("UPDATE telegram_note_draft SET state = ? WHERE id = ?").run(state, id);
  }

  getTelegramAction(token: string): TelegramAction | null {
    const row = this.db.prepare("SELECT * FROM telegram_action WHERE token = ?").get(token);
    return row === undefined ? null : readTelegramAction(row);
  }

  /**
   * Kill every live confirm/cancel challenge on a decision. Cancel means
   * cancelled: a confirm that survived its own cancellation would be an
   * irreversible choice still armed after the person said stop.
   */
  consumeTelegramChallenges(decision: number, now: Date): void {
    this.db
      .prepare(
        `UPDATE telegram_action SET consumed_at = ?
          WHERE decision = ? AND phase IN ('confirm','cancel') AND consumed_at IS NULL`,
      )
      .run(now.toISOString(), decision);
  }

  /** Consume once. False means somebody already did, or it expired — either way, no. */
  consumeTelegramAction(token: string, now: Date): boolean {
    const stamp = now.toISOString();
    const { changes } = this.db
      .prepare(
        `UPDATE telegram_action SET consumed_at = ?
          WHERE token = ? AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .run(stamp, token, stamp);
    return Number(changes) > 0;
  }

  /** Stamp the message a choose-action's keyboard actually landed on. */
  placeTelegramActions(tokens: readonly string[], messageId: string): void {
    for (const token of tokens) {
      this.db
        .prepare("UPDATE telegram_action SET message_id = ? WHERE token = ?")
        .run(messageId, token);
    }
  }

  /**
   * Take or renew the bridge's poll lease. One live poller per bot: cron
   * overlapping a follower gets `bridge-busy`, an expired holder is taken
   * over at the next generation, and the cursor rides the lease so a stale
   * generation can neither poll nor move it.
   */
  acquireBridgeLease(
    botId: string,
    owner: string,
    ttlMs: number,
    now: Date,
  ):
    | { ok: true; generation: number; cursor: number }
    | { ok: false; reason: "bridge-busy"; holder: string; until: string } {
    return this.transact(() => {
      const stamp = now.toISOString();
      const expires = new Date(now.getTime() + ttlMs).toISOString();
      const row = this.db.prepare("SELECT * FROM bridge_lease WHERE bot_id = ?").get(botId);
      if (row === undefined) {
        this.db
          .prepare(
            `INSERT INTO bridge_lease (bot_id, owner, generation, cursor, expires_at, heartbeat_at)
             VALUES (?, ?, 1, 0, ?, ?)`,
          )
          .run(botId, owner, expires, stamp);
        return { ok: true as const, generation: 1, cursor: 0 };
      }
      const holder = String(row["owner"]);
      const live = String(row["expires_at"]) > stamp;
      if (live && holder !== owner) {
        return {
          ok: false as const,
          reason: "bridge-busy" as const,
          holder,
          until: String(row["expires_at"]),
        };
      }
      const generation = live && holder === owner ? Number(row["generation"]) : Number(row["generation"]) + 1;
      this.db
        .prepare(
          "UPDATE bridge_lease SET owner = ?, generation = ?, expires_at = ?, heartbeat_at = ? WHERE bot_id = ?",
        )
        .run(owner, generation, expires, stamp, botId);
      return { ok: true as const, generation, cursor: Number(row["cursor"]) };
    });
  }

  /** Hand the poll back at the end of a pass, so the next cron firing is not told busy. */
  releaseBridgeLease(botId: string, owner: string, now: Date): void {
    this.db
      .prepare("UPDATE bridge_lease SET expires_at = ? WHERE bot_id = ? AND owner = ?")
      .run(now.toISOString(), botId, owner);
  }

  // ---- publication ---------------------------------------------------------

  /** Grant publication for a repo. Replaces any live grant — one at a time, the newest word wins. */
  savePublicationGrant(
    grant: {
      repo: string;
      githubRepo: string;
      remote: string;
      headPrefix: string;
      base: string;
      capabilities: PublicationCapability[];
      selector: "ours" | "all";
      draft: boolean;
      grantedBy: string;
      merge?: boolean;
      mergeMethod?: "squash" | "merge" | "rebase" | null;
      mergeDeleteBranch?: boolean;
    },
    now: Date,
  ): void {
    // Cross-column rule (v21): merge authority names its method, always —
    // additive ALTER cannot carry a table CHECK for this.
    if (grant.merge === true && grant.mergeMethod == null) {
      throw new Error("a merge grant names its method: --merge-method squash|merge|rebase");
    }
    this.transact(() => {
      this.db
        .prepare("UPDATE publication_grant SET revoked_at = ?, revoked_by = ? WHERE repo = ? AND revoked_at IS NULL")
        .run(now.toISOString(), grant.grantedBy, grant.repo);
      this.db
        .prepare(
          `INSERT INTO publication_grant
             (repo, github_repo, remote, head_prefix, base, capabilities, selector, draft, granted_by, granted_at,
              merge, merge_method, merge_delete_branch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grant.repo,
          grant.githubRepo,
          grant.remote,
          grant.headPrefix,
          grant.base,
          JSON.stringify(grant.capabilities),
          grant.selector,
          grant.draft ? 1 : 0,
          grant.grantedBy,
          now.toISOString(),
          grant.merge === true ? 1 : 0,
          grant.mergeMethod ?? null,
          grant.mergeDeleteBranch === true ? 1 : 0,
        );
    });
  }

  // ---- the merge grant's machinery (v21) ----------------------------------

  /**
   * Reserve the next observation generation for a PR BEFORE the network
   * call — the settle below is conditional on still being newest, so a
   * stalled older response can neither overwrite nor authorize.
   */
  reserveObservation(githubRepo: string, prNumber: number): number {
    return this.transact(() => {
      const row = this.db
        .prepare("SELECT generation FROM ci_observation WHERE github_repo = ? AND pr_number = ?")
        .get(githubRepo, prNumber);
      const generation = (row === undefined ? 0 : Number(row["generation"])) + 1;
      if (row === undefined) {
        this.db
          .prepare(
            "INSERT INTO ci_observation (github_repo, pr_number, head_sha, state, generation, observed_at) VALUES (?, ?, '', 'none', ?, '')",
          )
          .run(githubRepo, prNumber, generation);
      } else {
        this.db
          .prepare("UPDATE ci_observation SET generation = ? WHERE github_repo = ? AND pr_number = ?")
          .run(generation, githubRepo, prNumber);
      }
      return generation;
    });
  }

  /**
   * Conditional settle: writes ONLY when this generation is still the
   * newest reserved one, and RETURNS whether it won — a losing response
   * has no effects and never yields a merge-eligible tuple (round-4
   * finding 24). Callers gate every side effect on `won`.
   */
  settleObservation(
    observation: { githubRepo: string; prNumber: number; headSha: string; state: "passing" | "failing" | "running" | "none"; generation: number },
    now: Date,
  ): { won: boolean } {
    const { changes } = this.db
      .prepare(
        `UPDATE ci_observation SET head_sha = ?, state = ?, observed_at = ?
          WHERE github_repo = ? AND pr_number = ? AND generation = ?`,
      )
      .run(observation.headSha, observation.state, now.toISOString(), observation.githubRepo, observation.prNumber, observation.generation);
    return { won: Number(changes) === 1 };
  }

  /** A repair in flight durably blocks its source PR's merge — STICKY:
   * lifted only by the authenticated unblock act or remote closure. */
  createMergeBlocker(publication: number, taskId: string, now: Date): void {
    this.db
      .prepare("INSERT OR IGNORE INTO merge_blocker (publication, reason, task_id, created_at) VALUES (?, 'repair-open', ?, ?)")
      .run(publication, taskId, now.toISOString());
  }

  mergeBlockerFor(publication: number): { reason: string; taskId: string | null; createdAt: string } | null {
    const row = this.db
      .prepare("SELECT reason, task_id, created_at FROM merge_blocker WHERE publication = ? AND lifted_at IS NULL")
      .get(publication);
    return row === undefined
      ? null
      : { reason: String(row["reason"]), taskId: row["task_id"] === null ? null : String(row["task_id"]), createdAt: String(row["created_at"]) };
  }

  /** Lifting is a STAMP, never a delete (D7): the People screen's history
   * claim — who unblocked which merge — has rows to stand on. */
  liftMergeBlocker(publication: number, by: string, now: Date): boolean {
    return (
      Number(
        this.db
          .prepare("UPDATE merge_blocker SET lifted_at = ?, lifted_by = ? WHERE publication = ? AND lifted_at IS NULL")
          .run(now.toISOString(), by, publication).changes,
      ) > 0
    );
  }

  /** Creation binds the AUTHORITY POSTURE the repo holds right now (E1's
   * first two transitions): no mode = the grant's own signature; a notify
   * mode = waiting-human even under a merge-capable grant; an automerge
   * mode = basis 'mode' bound to the signing digest. INSERT OR IGNORE —
   * an existing row's posture is the reconciler's job, never creation's. */
  createMergeIntent(
    intent: { publication: number; repo: string; grantTermsHash: string; headSha: string; method: "squash" | "merge" | "rebase"; deleteBranch: boolean },
    now: Date,
  ): void {
    this.transact(() => {
      const mode = this.activeMode(intent.repo, now);
      let state = "pending";
      let basis = "grant";
      let modeDigest: string | null = null;
      if (mode !== null) {
        let publication: unknown;
        try {
          publication = (JSON.parse(mode.termsJson) as { publication?: unknown }).publication;
        } catch {
          publication = undefined;
        }
        if (publication === "automerge") {
          basis = "mode";
          modeDigest = mode.digest;
        } else {
          state = "waiting-human";
          basis = "human";
        }
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO merge_intent (publication, grant_terms_hash, head_sha, method, delete_branch, state, authority_basis, mode_digest, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(intent.publication, intent.grantTermsHash, intent.headSha, intent.method, intent.deleteBranch ? 1 : 0, state, basis, modeDigest, now.toISOString());
    });
  }

  /**
   * Claim by CAS with an expiring lease and a generation fence (the
   * delivery-claim discipline): only pending rows, or claimed rows whose
   * lease EXPIRED, are claimable; every later transition must present the
   * generation this claim minted, so a reclaimed row's old owner loses
   * every subsequent write. No permanently-claimed row is representable
   * (the table CHECK demands owner+expiry on 'claimed').
   */
  claimMergeIntent(id: number, by: string, leaseMs: number, now: Date): { generation: number } | null {
    return this.transact(() => {
      const row = this.db.prepare("SELECT state, claimed_until, generation FROM merge_intent WHERE id = ?").get(id);
      if (row === undefined) return null;
      const state = String(row["state"]);
      const expired = row["claimed_until"] !== null && String(row["claimed_until"]) <= now.toISOString();
      if (state !== "pending" && !(state === "claimed" && expired)) return null;
      const generation = Number(row["generation"]) + 1;
      const { changes } = this.db
        .prepare(
          `UPDATE merge_intent SET state = 'claimed', claimed_by = ?, claimed_until = ?, generation = ?
            WHERE id = ? AND generation = ?`,
        )
        .run(by, new Date(now.getTime() + leaseMs).toISOString(), generation, id, Number(row["generation"]));
      return Number(changes) === 1 ? { generation } : null;
    });
  }

  /** Renew the lease AND re-prove the generation in one CAS — the last
   * gate before the external call; a failed re-proof aborts the attempt. */
  renewMergeClaim(id: number, generation: number, leaseMs: number, now: Date): boolean {
    const { changes } = this.db
      .prepare("UPDATE merge_intent SET claimed_until = ? WHERE id = ? AND state = 'claimed' AND generation = ?")
      .run(new Date(now.getTime() + leaseMs).toISOString(), id, generation);
    return Number(changes) === 1;
  }

  /** STATE-SPECIFIC and TERMINALLY MONOTONIC (E1): the writer names the
   * state it believes it owns, and a terminal row is never overwritten —
   * a stale claim owner cannot un-merge what the observer already settled,
   * even at the same generation. bumpGeneration is the observer's fence:
   * settling somebody else's live row invalidates their later writes. */
  settleMergeIntent(
    id: number,
    generation: number,
    state: "merged" | "refused" | "superseded" | "pending" | "waiting-human",
    now: Date,
    detail: { error?: string | null; receipt?: string | null; countAttempt?: boolean; from?: "claimed" | "firing" | "nonterminal"; bumpGeneration?: boolean } = {},
  ): boolean {
    const from = detail.from ?? "nonterminal";
    const { changes } = this.db
      .prepare(
        `UPDATE merge_intent SET state = ?, claimed_by = NULL, claimed_until = NULL,
           firing_at = NULL, firing_deadline = NULL,
           authority_basis = CASE WHEN ? = 'waiting-human' THEN 'human' ELSE authority_basis END,
           mode_digest = CASE WHEN ? = 'waiting-human' THEN NULL ELSE mode_digest END,
           generation = generation + ?,
           attempts = attempts + ?, last_error = COALESCE(?, last_error), receipt = COALESCE(?, receipt),
           settled_at = CASE WHEN ? IN ('merged','refused','superseded') THEN ? ELSE settled_at END
         WHERE id = ? AND generation = ?
           AND state NOT IN ('merged','refused','superseded')
           AND (? = 'nonterminal' OR state = ?)`,
      )
      .run(
        state, state, state,
        detail.bumpGeneration === true ? 1 : 0,
        detail.countAttempt === true ? 1 : 0,
        detail.error ?? null, detail.receipt ?? null,
        state, now.toISOString(),
        id, generation,
        from, from,
      );
    return Number(changes) === 1;
  }

  /** The per-merge password ceremony's write (E1: waiting-human → pending
   * by the EXACT-INTENT ceremony): the caller has authenticated and shown
   * the operator the head they are authorizing. Basis becomes 'human' —
   * this signature covers this one merge and nothing else. */
  authorizeMergeIntent(id: number, expectedHeadSha: string, by: string, now: Date): { ok: true } | { ok: false; reason: "not-waiting" | "head-moved" } {
    void by;
    void now;
    return this.transact(() => {
      const row = this.db.prepare("SELECT state, head_sha FROM merge_intent WHERE id = ?").get(id);
      if (row === undefined || String(row["state"]) !== "waiting-human") return { ok: false as const, reason: "not-waiting" as const };
      if (String(row["head_sha"]) !== expectedHeadSha) return { ok: false as const, reason: "head-moved" as const };
      this.db
        .prepare(
          `UPDATE merge_intent SET state = 'pending', authority_basis = 'human', mode_digest = NULL,
                  generation = generation + 1, last_error = NULL
            WHERE id = ? AND state = 'waiting-human'`,
        )
        .run(id);
      return { ok: true as const };
    });
  }

  /** E1's linearization point: claimed → firing as a DURABLE CAS that
   * re-proves EVERY piece of the intent's authority inside one
   * transaction — the live grant's terms against the hash the intent was
   * written under, the exact head, and the basis-specific signature (a
   * live automerge mode with the bound digest for 'mode'; the absence of
   * a stricter notify posture for 'grant'). A revocation that committed
   * first already moved the row and this CAS fails; once this CAS
   * commits, no later revocation demotes it — the external call is
   * acknowledged one-shot. */
  fireMergeIntent(
    id: number,
    generation: number,
    proof: { repo: string; headSha: string; liveGrantTermsHash: string | null; graceMs: number },
    now: Date,
  ): { ok: true } | { ok: false; outcome: "raced" | "superseded" | "waiting-human"; why: string } {
    return this.transact(() => {
      const row = this.db
        .prepare("SELECT state, generation, head_sha, grant_terms_hash, authority_basis, mode_digest FROM merge_intent WHERE id = ?")
        .get(id);
      if (row === undefined || String(row["state"]) !== "claimed" || Number(row["generation"]) !== generation) {
        return { ok: false as const, outcome: "raced" as const, why: "the claim moved" };
      }
      const supersede = (why: string): { ok: false; outcome: "superseded"; why: string } => {
        this.settleMergeIntent(id, generation, "superseded", now, { error: why, from: "claimed" });
        return { ok: false as const, outcome: "superseded" as const, why };
      };
      const fence = (why: string): { ok: false; outcome: "waiting-human"; why: string } => {
        this.settleMergeIntent(id, generation, "waiting-human", now, { error: why, from: "claimed", bumpGeneration: true });
        return { ok: false as const, outcome: "waiting-human" as const, why };
      };
      if (String(row["head_sha"]) !== proof.headSha) return supersede("the head moved");
      if (proof.liveGrantTermsHash === null || proof.liveGrantTermsHash !== String(row["grant_terms_hash"])) {
        return supersede("the grant was revoked or its merge terms changed since this intent was written");
      }
      const basis = String(row["authority_basis"]);
      const mode = this.activeMode(proof.repo, now);
      if (basis === "mode") {
        let publication: unknown;
        try {
          publication = mode === null ? undefined : (JSON.parse(mode.termsJson) as { publication?: unknown }).publication;
        } catch {
          publication = undefined;
        }
        if (mode === null || mode.digest !== String(row["mode_digest"]) || publication !== "automerge") {
          return fence("the mode this merge was signed under is gone — it waits for you");
        }
      } else if (basis === "grant" && mode !== null) {
        let publication: unknown;
        try {
          publication = (JSON.parse(mode.termsJson) as { publication?: unknown }).publication;
        } catch {
          publication = undefined;
        }
        if (publication !== "automerge") return fence("the active mode says merges wait for you");
      }
      const { changes } = this.db
        .prepare(
          `UPDATE merge_intent SET state = 'firing', firing_at = ?, firing_deadline = ?
            WHERE id = ? AND state = 'claimed' AND generation = ?`,
        )
        .run(now.toISOString(), new Date(now.getTime() + proof.graceMs).toISOString(), id, generation);
      return Number(changes) === 1
        ? { ok: true as const }
        : { ok: false as const, outcome: "raced" as const, why: "the claim moved" };
    });
  }

  /** F1: an OPEN same-head PR under a STALE firing row is never
   * auto-retried — this authenticated recovery ceremony re-arms it
   * through the full firing CAS, generation bumped so the dead owner's
   * late writes lose. Refuses while the deadline has not passed. */
  refireMergeIntent(id: number, by: string, now: Date): { ok: true } | { ok: false; reason: "not-firing" | "not-stale" } {
    void by;
    return this.transact(() => {
      const row = this.db.prepare("SELECT state, firing_deadline FROM merge_intent WHERE id = ?").get(id);
      if (row === undefined || String(row["state"]) !== "firing") return { ok: false as const, reason: "not-firing" as const };
      if (String(row["firing_deadline"]) > now.toISOString()) return { ok: false as const, reason: "not-stale" as const };
      this.db
        .prepare(
          `UPDATE merge_intent SET state = 'pending', authority_basis = 'human', mode_digest = NULL,
                  firing_at = NULL, firing_deadline = NULL, generation = generation + 1, last_error = NULL
            WHERE id = ? AND state = 'firing'`,
        )
        .run(id);
      return { ok: true as const };
    });
  }

  /** Refused intents rearm to pending after the operator fixed the cause. */
  rearmMergeIntent(publication: number): boolean {
    const { changes } = this.db
      .prepare("UPDATE merge_intent SET state = 'pending', last_error = NULL WHERE publication = ? AND state = 'refused'")
      .run(publication);
    return Number(changes) > 0;
  }

  mergeIntentFor(publication: number): { id: number; state: string; headSha: string; generation: number; attempts: number; lastError: string | null; firingDeadline: string | null } | null {
    const row = this.db
      .prepare("SELECT id, state, head_sha, generation, attempts, last_error, firing_deadline FROM merge_intent WHERE publication = ?")
      .get(publication);
    return row === undefined
      ? null
      : {
          id: Number(row["id"]),
          state: String(row["state"]),
          headSha: String(row["head_sha"]),
          generation: Number(row["generation"]),
          attempts: Number(row["attempts"]),
          lastError: row["last_error"] === null ? null : String(row["last_error"]),
          firingDeadline: row["firing_deadline"] === null ? null : String(row["firing_deadline"]),
        };
  }

  latestObservation(githubRepo: string, prNumber: number): { headSha: string; state: string; observedAt: string; generation: number } | null {
    const row = this.db
      .prepare("SELECT head_sha, state, observed_at, generation FROM ci_observation WHERE github_repo = ? AND pr_number = ?")
      .get(githubRepo, prNumber);
    return row === undefined || String(row["observed_at"]) === ""
      ? null
      : { headSha: String(row["head_sha"]), state: String(row["state"]), observedAt: String(row["observed_at"]), generation: Number(row["generation"]) };
  }

  /** Revocation is immediate: intents not yet pushed die with the grant. */
  revokePublicationGrant(repo: string, by: string, now: Date): boolean {
    const { changes } = this.db
      .prepare("UPDATE publication_grant SET revoked_at = ?, revoked_by = ? WHERE repo = ? AND revoked_at IS NULL")
      .run(now.toISOString(), by, repo);
    return Number(changes) > 0;
  }

  publicationGrantFor(repo: string): PublicationGrant | null {
    const row = this.db
      .prepare("SELECT * FROM publication_grant WHERE repo = ? AND revoked_at IS NULL")
      .get(repo);
    return row === undefined ? null : readPublicationGrant(row);
  }

  /** v29: whether the repo has a live grant that authorizes MERGING — the
   * precondition automerge modes require (D1). */
  hasMergeCapableGrant(repo: string, now: Date): boolean {
    void now;
    const grant = this.publicationGrantFor(repo);
    return grant !== null && grant.merge === true;
  }

  /**
   * The intent, written wherever completion was proved — callers run this
   * inside the fenced completion transaction, so "done" and "this must
   * reach a PR" are one write or neither.
   */
  createPublicationIntent(
    intent: {
      run: number;
      taskRef: number;
      githubRepo: string;
      remote: string;
      base: string;
      head: string;
      headSha: string;
      bodyHash: string;
      draft: boolean;
    },
    now: Date,
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO publication
           (run, task_ref, github_repo, remote, base, head, head_sha, body_hash, draft, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intended', ?, ?)`,
      )
      .run(
        intent.run,
        intent.taskRef,
        intent.githubRepo,
        intent.remote,
        intent.base,
        intent.head,
        intent.headSha,
        intent.bodyHash,
        intent.draft ? 1 : 0,
        now.toISOString(),
        now.toISOString(),
      );
    return Number(inserted.lastInsertRowid);
  }

  /** Work the publisher still owes, oldest first — crash-retryable by construction. */
  pendingPublications(): Publication[] {
    return this.db
      .prepare("SELECT * FROM publication WHERE state IN ('intended','pushed') ORDER BY id")
      .all()
      .map(readPublication);
  }

  publicationForRun(run: number): Publication | null {
    const row = this.db.prepare("SELECT * FROM publication WHERE run = ?").get(run);
    return row === undefined ? null : readPublication(row);
  }

  markPublicationPushed(id: number, now: Date): void {
    this.db
      .prepare("UPDATE publication SET state = 'pushed', updated_at = ? WHERE id = ? AND state = 'intended'")
      .run(now.toISOString(), id);
  }

  markPublicationOpened(id: number, prNumber: number, prUrl: string, now: Date): void {
    this.db
      .prepare(
        "UPDATE publication SET state = 'opened', pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ? AND state = 'pushed'",
      )
      .run(prNumber, prUrl, now.toISOString(), id);
  }

  /** One more failed attempt, error kept. Returns the new count; the caller decides when enough is enough. */
  recordPublicationError(id: number, error: string, now: Date): number {
    this.db
      .prepare("UPDATE publication SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?")
      .run(error.slice(0, 2_000), now.toISOString(), id);
    const row = this.db.prepare("SELECT attempts FROM publication WHERE id = ?").get(id);
    return Number(row?.["attempts"] ?? 0);
  }

  failPublication(id: number, now: Date): void {
    this.db
      .prepare("UPDATE publication SET state = 'failed', updated_at = ? WHERE id = ? AND state IN ('intended','pushed')")
      .run(now.toISOString(), id);
  }

  /** PRs this control plane opened and should keep watching — remotely
   * merged/closed ones have left the watch (audit C-6). */
  openedPublications(): Publication[] {
    return this.db
      .prepare(
        "SELECT * FROM publication WHERE state = 'opened' AND (remote_state IS NULL OR remote_state NOT IN ('MERGED','CLOSED')) ORDER BY id",
      )
      .all()
      .map(readPublication);
  }

  /** Whether an UNRESOLVED CI failure episode is open for exactly this repository's PR (M8.19; audit C-2). */
  hasOpenCiEpisode(githubRepo: string, prNumber: number): boolean {
    return this.latestOpenCiEpisode(githubRepo, prNumber) !== null;
  }

  /** Record what CI was last SEEN doing (audit SD-4). Observation only. */
  recordPublicationCheckState(id: number, state: string, now: Date): void {
    this.db
      .prepare("UPDATE publication SET last_check_state = ?, last_check_at = ? WHERE id = ?")
      .run(state, now.toISOString(), id);
  }

  /** The remote's own verdict on a PR — MERGED/CLOSED ends the watch (audit C-6). */
  recordPublicationRemoteState(id: number, remoteState: string, now: Date): void {
    this.db
      .prepare("UPDATE publication SET remote_state = ?, updated_at = ? WHERE id = ?")
      .run(remoteState, now.toISOString(), id);
  }

  /**
   * Resolve CI episodes for a PR whose failing head is gone — a new commit
   * superseded it, or the same head turned green. Episodes are keyed
   * `ci:<githubRepo>:<pr>:<headOid>` (the repository is part of the
   * identity — Codex M5-M8 audit, C-2); the legacy `ci:<pr>:<head>` shape
   * is swept too, so pre-rename rows cannot linger open forever.
   */
  resolveCiEpisodes(githubRepo: string, prNumber: number, exceptKey: string | null, now: Date): number {
    const { changes } = this.db
      .prepare(
        `UPDATE notification SET resolved_at = ?
          WHERE (dedupe_key LIKE ? ESCAPE '\\' OR dedupe_key LIKE ? ESCAPE '\\') AND resolved_at IS NULL AND dedupe_key != COALESCE(?, '')`,
      )
      .run(now.toISOString(), `${likeEscape(`ci:${githubRepo}:${prNumber}:`)}%`, `${likeEscape(`ci:${prNumber}:`)}%`, exceptKey);
    return Number(changes);
  }

  /**
   * The latest OPEN failing episode for exactly this repository's PR —
   * head and observation time included, because a repair brief binds the
   * head the failure was SEEN on, never the click (audit C-2).
   */
  latestOpenCiEpisode(githubRepo: string, prNumber: number): { headSha: string; createdAt: string } | null {
    const row = this.db
      .prepare(
        "SELECT dedupe_key, created_at FROM notification WHERE dedupe_key LIKE ? ESCAPE '\\' AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get(`${likeEscape(`ci:${githubRepo}:${prNumber}:`)}%`);
    if (row === undefined) return null;
    const key = String(row["dedupe_key"]);
    const headSha = key.slice(key.lastIndexOf(":") + 1);
    return { headSha, createdAt: String(row["created_at"]) };
  }

  /** What is being built right now: current, unexpired claims with their task and holder. */
  liveClaims(repo: string | null, now: Date): { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null; repo: string | null }[] {
    return this.db
      .prepare(
        `SELECT task_ref.external_id AS task_id, task_ref.repo AS repo, claim.runner, claim.acquired_at, claim.expires_at,
                (SELECT run.model FROM run WHERE run.lease_id = claim.lease_id LIMIT 1) AS model
         FROM claim JOIN task_ref ON task_ref.id = claim.task_ref
         WHERE claim.released_at IS NULL AND claim.expires_at > ?
           AND claim.lease_generation = (
             SELECT MAX(newest.lease_generation) FROM claim AS newest
             WHERE newest.task_ref = claim.task_ref
           )
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY claim.acquired_at`,
      )
      .all(now.toISOString(), repo, repo)
      .map(row => ({
        taskId: String(row["task_id"]),
        runner: String(row["runner"]),
        claimedAt: String(row["acquired_at"]),
        expiresAt: String(row["expires_at"]),
        model: row["model"] === null || row["model"] === undefined ? null : String(row["model"]),
        repo: row["repo"] === null ? null : String(row["repo"]),
      }));
  }

  // ---- projects ------------------------------------------------------------

  /** Remember a project was opened. Upsert keeps added_at; recency always moves. */
  upsertProject(path: string, name: string, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO project (path, name, added_at, last_opened_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET name = excluded.name, last_opened_at = excluded.last_opened_at`,
      )
      .run(path, name, now.toISOString(), now.toISOString());
  }

  /** Most recently opened first — the opener page's order. */
  listProjects(): { path: string; name: string; addedAt: string; lastOpenedAt: string }[] {
    return this.db
      .prepare("SELECT * FROM project ORDER BY last_opened_at DESC")
      .all()
      .map(row => ({
        path: String(row["path"]),
        name: String(row["name"]),
        addedAt: String(row["added_at"]),
        lastOpenedAt: String(row["last_opened_at"]),
      }));
  }

  /**
   * Tasks whose scope waits on a person's yes: proposed, not approved (or
   * approval voided by an edit), task not terminal. The inbox's core row —
   * an unapproved scope is work the machine is forbidden to start.
   */
  scopesAwaitingApproval(
    repo: string | null,
    limit = 10,
    admitted: string[] | null = null,
  ): { taskId: string; title: string; goal: string; digest: string; proposedAt: string; repo: string | null }[] {
    const page = Math.max(1, Math.min(Math.floor(limit), 50));
    // Roll-up admission binds BEFORE the LIMIT (Codex roll-up review,
    // finding 2): a repo outside the ceiling must not consume the page.
    const admission =
      admitted === null
        ? "(? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)"
        : `(task_ref.repo IS NULL${admitted.length === 0 ? "" : ` OR task_ref.repo IN (${admitted.map(() => "?").join(",")})`})`;
    const params = admitted === null ? [repo, repo] : admitted;
    return this.db
      .prepare(
        `SELECT task.id AS task_id, task.title, task_scope.goal, task_scope.digest, task_scope.proposed_at, task_ref.repo AS task_repo
         FROM task_scope
         JOIN task ON task.id = task_scope.task_id
         JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
         WHERE task.state IN ('queued','running')
           AND (task_scope.approved_at IS NULL OR task_scope.approved_by IS NULL
                OR task_scope.approved_digest IS NULL OR task_scope.approved_digest != task_scope.digest)
           AND ${admission}
         ORDER BY task_scope.proposed_at, task.id LIMIT ?`,
      )
      .all(BUILT_IN, ...params, page)
      .map(row => ({
        taskId: String(row["task_id"]),
        title: String(row["title"]),
        goal: String(row["goal"]),
        digest: String(row["digest"]),
        proposedAt: String(row["proposed_at"]),
        repo: row["task_repo"] === null || row["task_repo"] === undefined ? null : String(row["task_repo"]),
      }));
  }

  /**
   * One row per human-stalled task (v3 review, finding 2): failed, or
   * carrying unresolved incidents, and free of live claims — requeue is the
   * one inline verb, and incident kinds ride along as context, never as
   * separate cards.
   */
  listRequeueablesScoped(
    repo: string | null,
    now: Date,
    limit = 10,
    admitted: string[] | null = null,
  ): { taskId: string; title: string; state: TaskState; strikes: number; incidentCount: number; repo: string | null }[] {
    const page = Math.max(1, Math.min(Math.floor(limit), 50));
    const admission =
      admitted === null
        ? "(? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)"
        : `(task_ref.repo IS NULL${admitted.length === 0 ? "" : ` OR task_ref.repo IN (${admitted.map(() => "?").join(",")})`})`;
    const params = admitted === null ? [repo, repo] : admitted;
    return this.db
      .prepare(
        `WITH open_incidents AS (
           SELECT run.task_ref AS task_ref, COUNT(*) AS incident_count,
                  MIN(incident.created_at) AS oldest
           FROM incident JOIN run ON run.id = incident.run
           WHERE incident.resolved_at IS NULL
           GROUP BY run.task_ref
         )
         SELECT task.id, task.title, task.state, task_ref.strikes, task_ref.repo AS task_repo,
                COALESCE(open_incidents.incident_count, 0) AS incident_count,
                COALESCE(open_incidents.oldest, task.updated_at) AS sort_at
         FROM task
         JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
         LEFT JOIN open_incidents ON open_incidents.task_ref = task_ref.id
         WHERE (task.state = 'failed' OR open_incidents.task_ref IS NOT NULL)
           AND ${admission}
           AND NOT EXISTS (
             SELECT 1 FROM claim
             WHERE claim.task_ref = task_ref.id AND claim.released_at IS NULL
               AND claim.expires_at > ?
               AND claim.lease_generation = (
                 SELECT MAX(newest.lease_generation) FROM claim AS newest
                 WHERE newest.task_ref = claim.task_ref
               )
           )
         ORDER BY sort_at, task_ref.id LIMIT ?`,
      )
      .all(BUILT_IN, ...params, now.toISOString(), page)
      .map(row => ({
        taskId: String(row["id"]),
        title: String(row["title"]),
        state: String(row["state"]) as TaskState,
        strikes: Number(row["strikes"]),
        incidentCount: Number(row["incident_count"]),
        repo: row["task_repo"] === null || row["task_repo"] === undefined ? null : String(row["task_repo"]),
      }));
  }

  /**
   * Cancelled blockers with queued dependents — one repair card per
   * blocker, because a cancelled task cannot be requeued; the dependents
   * are impact, not additional items.
   */
  listCancelledBlockersScoped(
    repo: string | null,
    limit = 10,
    admitted: string[] | null = null,
  ): { blockerId: string; dependentCount: number; exampleDependent: string; repo: string | null; blockerRepo: string | null }[] {
    const page = Math.max(1, Math.min(Math.floor(limit), 50));
    // Edges may cross projects, and "cancelled" is a fact about the
    // BLOCKER's project (Codex roll-up review, finding 4): both refs are
    // joined, both repos returned and admitted BEFORE aggregation, and the
    // grouping carries the pair so one blocker's impact never aggregates
    // across a ceiling the caller must re-prove row by row.
    const admissionOf = (alias: string): string =>
      admitted === null
        ? `(? IS NULL OR ${alias}.repo IS NULL OR ${alias}.repo = ?)`
        : `(${alias}.repo IS NULL${admitted.length === 0 ? "" : ` OR ${alias}.repo IN (${admitted.map(() => "?").join(",")})`})`;
    const paramsOf = (): unknown[] => (admitted === null ? [repo, repo] : [...admitted]);
    return this.db
      .prepare(
        `SELECT task_edge.blocker AS blocker, COUNT(*) AS dependents, MIN(task_edge.blocked) AS example,
                dependent_ref.repo AS dependent_repo, blocker_ref.repo AS blocker_repo
         FROM task_edge
         JOIN task AS blocker_task ON blocker_task.id = task_edge.blocker AND blocker_task.state = 'cancelled'
         JOIN task AS dependent ON dependent.id = task_edge.blocked AND dependent.state = 'queued'
         JOIN task_ref AS dependent_ref ON dependent_ref.backend = ? AND dependent_ref.external_id = task_edge.blocked
         JOIN task_ref AS blocker_ref ON blocker_ref.backend = ? AND blocker_ref.external_id = task_edge.blocker
         WHERE ${admissionOf("dependent_ref")}
           AND ${admissionOf("blocker_ref")}
         GROUP BY task_edge.blocker, dependent_ref.repo, blocker_ref.repo
         ORDER BY task_edge.blocker LIMIT ?`,
      )
      .all(BUILT_IN, BUILT_IN, ...paramsOf(), ...paramsOf(), page)
      .map(row => ({
        blockerId: String(row["blocker"]),
        dependentCount: Number(row["dependents"]),
        exampleDependent: String(row["example"]),
        repo: row["dependent_repo"] === null || row["dependent_repo"] === undefined ? null : String(row["dependent_repo"]),
        blockerRepo: row["blocker_repo"] === null || row["blocker_repo"] === undefined ? null : String(row["blocker_repo"]),
      }));
  }

  /**
   * Active work only, running first — the Work tab's page. Terminal history
   * belongs to Done and the build ledger, never to this list.
   */
  listActiveWorkScoped(
    repo: string | null,
    now: Date,
    limit = 50,
  ): (Task & { repo: string | null; approved: boolean; held: boolean; buildingBy: string | null; strikes: number })[] {
    const page = Math.max(1, Math.min(Math.floor(limit), 100));
    return this.db
      .prepare(
        `SELECT task.*, task_ref.repo AS task_repo, task_ref.strikes AS ref_strikes,
           EXISTS (
             SELECT 1 FROM task_scope
             WHERE task_scope.task_id = task.id AND task_scope.approved_digest = task_scope.digest
               AND task_scope.approved_at IS NOT NULL
           ) AS approved,
           EXISTS (
             SELECT 1 FROM hold
             WHERE hold.task_ref = task_ref.id AND (hold.until IS NULL OR hold.until > ?)
           ) AS held,
           (SELECT claim.runner FROM claim
             WHERE claim.task_ref = task_ref.id AND claim.released_at IS NULL AND claim.expires_at > ?
               AND claim.lease_generation = (
                 SELECT MAX(newest.lease_generation) FROM claim AS newest
                 WHERE newest.task_ref = claim.task_ref)
             LIMIT 1) AS building_by
         FROM task
         JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
         WHERE task.state IN ('running','queued')
           AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
         ORDER BY CASE task.state WHEN 'running' THEN 0 ELSE 1 END, task.updated_at DESC, task.id DESC
         LIMIT ?`,
      )
      .all(now.toISOString(), now.toISOString(), BUILT_IN, repo, repo, page)
      .map(row => ({
        id: String(row["id"]),
        title: String(row["title"]),
        state: String(row["state"]) as TaskState,
        createdAt: String(row["created_at"]),
        updatedAt: String(row["updated_at"]),
        priority: row["priority"] === null || row["priority"] === undefined ? 0 : Number(row["priority"]),
        repo: row["task_repo"] === null ? null : String(row["task_repo"]),
        approved: Number(row["approved"]) === 1,
        held: Number(row["held"]) === 1,
        buildingBy: row["building_by"] === null ? null : String(row["building_by"]),
        strikes: Number(row["ref_strikes"]),
      }));
  }

  /**
   * Completed work, one row per done task with its final accepted run and
   * any publication attached — never composed from separate task and PR
   * lists (v3 review, finding 8). Manual done-without-run rows stay
   * visible; no-change is labeled, not hidden.
   */
  listCompletedWorkScoped(
    repo: string | null,
    limit = 50,
    admitted: string[] | null = null,
  ): {
    taskId: string;
    title: string;
    repo: string | null;
    completedAt: string;
    outcome: string | null;
    handoff: string | null;
    costUsd: number | null;
    provider: string | null;
    ranMinutes: number | null;
    prNumber: number | null;
    prUrl: string | null;
    publicationState: string | null;
  }[] {
    const page = Math.max(1, Math.min(Math.floor(limit), 100));
    // Admission binds BEFORE the LIMIT here exactly as in the board's
    // task query (attended review, finding 3): rolled-up done rows must
    // not spend the page on repos the ceiling hides.
    const admission =
      admitted === null ? "" : `AND (task_ref.repo IS NULL OR task_ref.repo IN (${admitted.map(() => "?").join(",")}))`;
    return this.db
      .prepare(
        `WITH completed AS (
           SELECT task.id, task.title, task.updated_at AS completed_at, task_ref.id AS ref_id,
                  task_ref.repo AS task_repo
           FROM task
           JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
           WHERE task.state = 'done'
             AND (? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)
             ${admission}
         )
         SELECT completed.*, run.outcome, run.handoff, run.cost_usd, run.provider, run.started_at, run.finished_at,
                publication.state AS pub_state, publication.pr_number, publication.pr_url
         FROM completed
         LEFT JOIN run ON run.id = (
           SELECT MAX(final.id) FROM run AS final
           WHERE final.task_ref = completed.ref_id
             AND final.outcome IN ('built','no-change') AND final.finished_at IS NOT NULL
         )
         LEFT JOIN publication ON publication.run = run.id
         ORDER BY completed.completed_at DESC, completed.id DESC LIMIT ?`,
      )
      .all(BUILT_IN, repo, repo, ...(admitted ?? []), page)
      .map(row => ({
        taskId: String(row["id"]),
        title: String(row["title"]),
        repo: row["task_repo"] === null || row["task_repo"] === undefined ? null : String(row["task_repo"]),
        completedAt: String(row["completed_at"]),
        outcome: row["outcome"] === null ? null : String(row["outcome"]),
        handoff: row["handoff"] === null ? null : String(row["handoff"]),
        costUsd: row["cost_usd"] === null ? null : Number(row["cost_usd"]),
        provider: row["provider"] === null || row["provider"] === undefined ? null : String(row["provider"]),
        ranMinutes:
          row["started_at"] === null || row["finished_at"] === null || row["started_at"] === undefined
            ? null
            : Math.max(1, Math.round((new Date(String(row["finished_at"])).getTime() - new Date(String(row["started_at"])).getTime()) / 60_000)),
        prNumber: row["pr_number"] === null ? null : Number(row["pr_number"]),
        prUrl: row["pr_url"] === null ? null : String(row["pr_url"]),
        publicationState: row["pub_state"] === null ? null : String(row["pub_state"]),
      }));
  }

  /**
   * Everything the board needs, in one snapshot: every non-terminal task's
   * lane-relevant facts plus the recent completions, fetched inside a single
   * transaction so a concurrent writer cannot make one card appear in two
   * lanes or in none (Codex board review, finding 2). Classification itself
   * is the pure function in board.ts — this method only gathers facts.
   *
   * Bounded honestly: at most `cap` active tasks, newest first; when the
   * cap is hit `saturated` says so, and the board's lane totals speak only
   * for what was fetched.
   */
  boardScoped(
    repo: string | null,
    now: Date,
    cap = 200,
    admitted: string[] | null = null,
  ): {
    /** blockerRepo rides along so the caller can redact blockerState
     * against its ceiling before the pure classifier ever sees it. */
    tasks: (BoardFacts & { blockerRepo: string | null })[];
    saturated: boolean;
    done: ReturnType<Store["listCompletedWorkScoped"]>;
  } {
    const page = Math.max(1, Math.min(Math.floor(cap), 500));
    // The admission set is applied BEFORE the limit (Codex round 2,
    // finding 11): in the roll-up, rows outside the ceiling must not
    // consume the page and crowd out admitted cards. Serve still filters
    // per-row afterward — this is the bound, that is the law.
    const admission =
      admitted === null
        ? "(? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)"
        : `(task_ref.repo IS NULL OR task_ref.repo IN (${admitted.map(() => "?").join(",")}))`;
    const admissionParams = admitted === null ? [repo, repo] : admitted;

    const columns = `
        SELECT task.id, task.title, task.state, task.updated_at, task.priority, task_ref.strikes, task_ref.repo AS task_repo,
             EXISTS (SELECT 1 FROM task_scope WHERE task_scope.task_id = task.id) AS has_scope,
             EXISTS (
               SELECT 1 FROM task_scope
               WHERE task_scope.task_id = task.id AND task_scope.approved_digest = task_scope.digest
                 AND task_scope.approved_at IS NOT NULL
             ) AS approved,
             (SELECT substr(task_scope.goal, 1, 90) FROM task_scope WHERE task_scope.task_id = task.id) AS goal,
             (SELECT decision.id FROM decision JOIN run ON run.id = decision.run
               WHERE run.task_ref = task_ref.id AND decision.answered_at IS NULL
               ORDER BY decision.id LIMIT 1) AS open_decision,
             (SELECT substr(decision.question, 1, 120) FROM decision JOIN run ON run.id = decision.run
               WHERE run.task_ref = task_ref.id AND decision.answered_at IS NULL
               ORDER BY decision.id LIMIT 1) AS open_question,
             (SELECT decision.created_at FROM decision JOIN run ON run.id = decision.run
               WHERE run.task_ref = task_ref.id AND decision.answered_at IS NULL
               ORDER BY decision.id LIMIT 1) AS open_decision_at,
             (SELECT COUNT(*) FROM incident JOIN run ON run.id = incident.run
               WHERE run.task_ref = task_ref.id AND incident.resolved_at IS NULL) AS open_incidents,
             (SELECT MIN(incident.created_at) FROM incident JOIN run ON run.id = incident.run
               WHERE run.task_ref = task_ref.id AND incident.resolved_at IS NULL) AS oldest_incident_at,
             task_ref.plan AS plan_state,
             task_ref.routine_id AS routine_id,
             (SELECT routine.name FROM routine WHERE routine.id = task_ref.routine_id) AS routine_name,
             live.runner AS claim_runner, live.acquired_at AS claim_at, live.lease_id AS claim_lease,
             claim_run.model AS claim_model, claim_run.branch AS claim_branch, claim_run.worktree AS claim_worktree,
             claim_run.role AS claim_role, claim_run.provider AS claim_provider, claim_run.phase AS claim_phase,
             (SELECT MAX(unfinished.id) FROM run AS unfinished
               WHERE unfinished.lease_id = live.lease_id AND unfinished.outcome IS NULL) AS live_run_id,
             task_ref.assigned_runner AS assigned_runner,
             (SELECT hold.owner_kind FROM hold
               WHERE hold.task_ref = task_ref.id AND (hold.until IS NULL OR hold.until > ?)
               ORDER BY CASE hold.owner_kind WHEN 'operator' THEN 0 WHEN 'backoff' THEN 1 WHEN 'decision' THEN 2 ELSE 3 END, hold.id
               LIMIT 1) AS hold_kind,
             (SELECT hold.until FROM hold
               WHERE hold.task_ref = task_ref.id AND (hold.until IS NULL OR hold.until > ?)
               ORDER BY CASE hold.owner_kind WHEN 'operator' THEN 0 WHEN 'backoff' THEN 1 WHEN 'decision' THEN 2 ELSE 3 END, hold.id
               LIMIT 1) AS hold_until,
             (SELECT task_edge.blocker FROM task_edge
               JOIN task AS blocker_task ON blocker_task.id = task_edge.blocker
               WHERE task_edge.blocked = task.id AND blocker_task.state != 'done'
               ORDER BY task_edge.blocker LIMIT 1) AS unmet_dependency,
             (SELECT blocker_task.state FROM task_edge
               JOIN task AS blocker_task ON blocker_task.id = task_edge.blocker
               WHERE task_edge.blocked = task.id AND blocker_task.state != 'done'
               ORDER BY task_edge.blocker LIMIT 1) AS blocker_state,
             (SELECT blocker_ref.repo FROM task_edge
               JOIN task AS blocker_task ON blocker_task.id = task_edge.blocker
               JOIN task_ref AS blocker_ref ON blocker_ref.backend = task_ref.backend AND blocker_ref.external_id = task_edge.blocker
               WHERE task_edge.blocked = task.id AND blocker_task.state != 'done'
               ORDER BY task_edge.blocker LIMIT 1) AS blocker_repo,
             (SELECT contest.id FROM contest WHERE contest.task_ref = task_ref.id
                AND contest.state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted')
               ORDER BY contest.id DESC LIMIT 1) AS contest_id,
             (SELECT contest.state FROM contest WHERE contest.task_ref = task_ref.id
                AND contest.state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted')
               ORDER BY contest.id DESC LIMIT 1) AS contest_state,
             (SELECT contest.kind FROM contest WHERE contest.task_ref = task_ref.id
                AND contest.state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted')
               ORDER BY contest.id DESC LIMIT 1) AS contest_kind,
             (SELECT COUNT(*) FROM contestant WHERE contestant.contest =
               (SELECT contest.id FROM contest WHERE contest.task_ref = task_ref.id
                  AND contest.state IN ('dispatching','racing','pick-wait','decision-wait','exhausted','interrupted')
                ORDER BY contest.id DESC LIMIT 1)) AS contest_agents,
             (SELECT requirement.value FROM json_each(task_ref.capability_requirements) AS requirement
               WHERE task_ref.repo IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM capability
                 WHERE capability.repo = task_ref.repo AND capability.status = 'verified'
                   AND (capability.expires_at IS NULL OR capability.expires_at > ?)
                   AND capability.kind || ':' || capability.name = requirement.value
               ) LIMIT 1) AS missing_requirement
           FROM task
           JOIN task_ref ON task_ref.backend = ? AND task_ref.external_id = task.id
           LEFT JOIN claim AS live ON live.task_ref = task_ref.id
             AND live.released_at IS NULL AND live.expires_at > ?
             AND live.lease_generation = (
               SELECT MAX(newest.lease_generation) FROM claim AS newest
               WHERE newest.task_ref = live.task_ref
             )
           LEFT JOIN run AS claim_run ON claim_run.id = (
             SELECT MAX(candidate.id) FROM run AS candidate WHERE candidate.lease_id = live.lease_id
           )
           WHERE task.state IN ('queued','running','failed')
             AND ${admission}`;
    const shared = [now.toISOString(), now.toISOString(), now.toISOString(), BUILT_IN, now.toISOString(), ...admissionParams];

    return this.transact(() => {
      // Two bounded pages, one snapshot (Codex round 2, finding 11): the
      // newest active work, PLUS the oldest attention candidates by their
      // stall anchor — an old stalled task must not fall off the board
      // just because two hundred newer things moved. The predicate here
      // only SELECTS candidates; the classifier in board.ts still owns
      // what attention means.
      const newest = this.db
        .prepare(`${columns}
           ORDER BY task.updated_at DESC, task.id DESC
           LIMIT ?`)
        .all(...shared, page);
      const attentionPage = Math.min(page, 100);
      const stalled = this.db
        .prepare(`${columns}
             AND (
               task.state = 'failed'
               OR EXISTS (SELECT 1 FROM incident JOIN run ON run.id = incident.run
                          WHERE run.task_ref = task_ref.id AND incident.resolved_at IS NULL)
               OR EXISTS (SELECT 1 FROM decision JOIN run ON run.id = decision.run
                          WHERE run.task_ref = task_ref.id AND decision.answered_at IS NULL)
               OR NOT EXISTS (SELECT 1 FROM task_scope
                              WHERE task_scope.task_id = task.id AND task_scope.approved_digest = task_scope.digest
                                AND task_scope.approved_at IS NOT NULL)
             )
           ORDER BY COALESCE(open_decision_at, oldest_incident_at, task.updated_at) ASC, task.id
           LIMIT ?`)
        .all(...shared, attentionPage);

      // Every column's HEAD is pinned onto the page (queue-columns review,
      // finding 14): after a drag, whole columns carry positive ranks, so
      // "priority > 0" would let long columns crowd out a short column's
      // front card. One head per (worker, repo) partition instead.
      const promoted = this.db
        .prepare(`SELECT * FROM (
             SELECT ranked.*, ROW_NUMBER() OVER (
               PARTITION BY ranked.assigned_runner, ranked.task_repo
               ORDER BY ranked.priority DESC, ranked.updated_at, ranked.id
             ) AS in_column
             FROM (${columns} AND task.state = 'queued') AS ranked
           ) WHERE in_column = 1
           LIMIT ?`)
        .all(...shared, Math.min(page, 50));

      const seen = new Set<string>();
      const rows = [...newest, ...stalled, ...promoted].filter(row => {
        const id = String(row["id"]);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      const text = (row: Record<string, unknown>, key: string): string | null =>
        row[key] === null || row[key] === undefined ? null : String(row[key]);

      const tasks = rows.map(row => ({
        taskId: String(row["id"]),
        title: String(row["title"]),
        repo: text(row, "task_repo"),
        state: String(row["state"]) as "queued" | "running" | "failed",
        updatedAt: String(row["updated_at"]),
        strikes: Number(row["strikes"]),
        hasScope: Number(row["has_scope"]) === 1,
        approved: Number(row["approved"]) === 1,
        plan:
          row["plan_state"] === null || row["plan_state"] === undefined
            ? null
            : (String(row["plan_state"]) as "requested" | "drafted"),
        goal: text(row, "goal"),
        openDecisionId:
          row["open_decision"] === null || row["open_decision"] === undefined
            ? null
            : Number(row["open_decision"]),
        question: text(row, "open_question"),
        decisionCreatedAt: text(row, "open_decision_at"),
        openIncidents: Number(row["open_incidents"]),
        oldestIncidentAt: text(row, "oldest_incident_at"),
        claim:
          row["claim_runner"] === null || row["claim_runner"] === undefined
            ? null
            : {
                runner: String(row["claim_runner"]),
                claimedAt: String(row["claim_at"]),
                model: text(row, "claim_model"),
                branch: text(row, "claim_branch"),
                worktree: text(row, "claim_worktree"),
                role: text(row, "claim_role"),
                provider: text(row, "claim_provider"),
                phase: text(row, "claim_phase"),
              },
        liveRunId:
          row["live_run_id"] === null || row["live_run_id"] === undefined
            ? null
            : Number(row["live_run_id"]),
        priority: row["priority"] === null || row["priority"] === undefined ? 0 : Number(row["priority"]),
        assignedRunner:
          row["assigned_runner"] === null || row["assigned_runner"] === undefined ? null : String(row["assigned_runner"]),
        hold:
          row["hold_kind"] === null || row["hold_kind"] === undefined
            ? null
            : {
                ownerKind: String(row["hold_kind"]) as "operator" | "decision" | "incident" | "backoff",
                until: text(row, "hold_until"),
              },
        unmetDependency: text(row, "unmet_dependency"),
        blockerState: text(row, "blocker_state"),
        blockerRepo: text(row, "blocker_repo"),
        missingRequirement: text(row, "missing_requirement"),
        contest:
          row["contest_id"] === null || row["contest_id"] === undefined
            ? null
            : { id: Number(row["contest_id"]), state: String(row["contest_state"]), agents: Number(row["contest_agents"]), kind: (String(row["contest_kind"] ?? "race") === "comparison" ? "comparison" : "race") as "race" | "comparison" },
        routineId:
          row["routine_id"] === null || row["routine_id"] === undefined
            ? null
            : Number(row["routine_id"]),
        routineName: text(row, "routine_name"),
      }));
      return {
        tasks,
        saturated: newest.length === page,
        done: this.listCompletedWorkScoped(repo, 10, admitted),
      };
    });
  }

  /** Whether an open CI-failure episode exists for a PR — observed, never inferred. */
  ciFailureObserved(prNumber: number): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS hit FROM notification WHERE dedupe_key LIKE ? AND resolved_at IS NULL LIMIT 1",
      )
      .get(`ci:${prNumber}:%`);
    return row !== undefined;
  }

  /**
   * The inbox badge, saturated: counts action items up to a cap so the
   * sidebar never pays for an unbounded scan (v3 review, finding 7).
   * Requirement gaps are excluded here — they are derived, not stored —
   * and the inbox page itself shows them; the badge under-counting a gap
   * is a smaller wrong than a full graph walk on every render.
   */
  /** A cheap at-a-glance PEEK into one project for the switcher cards
   * (v30 UI): things waiting on a person, work queued, work running, and
   * builds that finished in the last day — each a single COUNT, scoped to
   * this exact repo. Never an unbounded read. */
  projectPeek(repo: string, now: Date): { waiting: number; queued: number; running: number; doneRecently: number } {
    const waiting = this.countInboxScoped(repo, now).count;
    const q = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN task.state = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN task.state = 'running' THEN 1 ELSE 0 END) AS running
           FROM task JOIN task_ref ON task_ref.backend = 'built-in' AND task_ref.external_id = task.id
          WHERE task_ref.repo = ?`,
      )
      .get(repo) as { queued: number | null; running: number | null };
    const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const done = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM run
           JOIN task_ref ON task_ref.id = run.task_ref
          WHERE task_ref.repo = ? AND run.outcome = 'built' AND run.finished_at IS NOT NULL AND run.finished_at >= ?`,
      )
      .get(repo, since) as { n: number };
    return { waiting: waiting, queued: Number(q.queued ?? 0), running: Number(q.running ?? 0), doneRecently: Number(done.n) };
  }

  countInboxScoped(
    repo: string | null,
    now: Date,
    cap = 100,
    admitted: string[] | null = null,
  ): { count: number; saturated: boolean } {
    // Roll-up admission binds inside EVERY union branch (Codex roll-up
    // review, finding 11): with repo NULL the old predicate admitted every
    // stored project, ceiling or not. An empty admitted list reduces to
    // unplaced rows only — never IN ().
    const admission =
      admitted === null
        ? "(? IS NULL OR task_ref.repo IS NULL OR task_ref.repo = ?)"
        : `(task_ref.repo IS NULL${admitted.length === 0 ? "" : ` OR task_ref.repo IN (${admitted.map(() => "?").join(",")})`})`;
    const params = (): unknown[] => (admitted === null ? [repo, repo] : [...admitted]);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 'd' || decision.id AS k FROM decision
             JOIN run ON run.id = decision.run
             JOIN task_ref ON task_ref.id = run.task_ref
             WHERE decision.state IN ('open','expired')
               AND ${admission}
           UNION ALL
           SELECT 'a' || task.id FROM task_scope
             JOIN task ON task.id = task_scope.task_id
             JOIN task_ref ON task_ref.backend = '${'built-in'}' AND task_ref.external_id = task.id
             WHERE task.state IN ('queued','running')
               AND (task_scope.approved_at IS NULL OR task_scope.approved_by IS NULL
                    OR task_scope.approved_digest IS NULL OR task_scope.approved_digest != task_scope.digest)
               AND ${admission}
           UNION ALL
           SELECT 'r' || task.id FROM task
             JOIN task_ref ON task_ref.backend = '${'built-in'}' AND task_ref.external_id = task.id
             WHERE (task.state = 'failed' OR EXISTS (
                 SELECT 1 FROM incident JOIN run ON run.id = incident.run
                 WHERE run.task_ref = task_ref.id AND incident.resolved_at IS NULL))
               AND ${admission}
               AND NOT EXISTS (
                 SELECT 1 FROM claim
                 WHERE claim.task_ref = task_ref.id AND claim.released_at IS NULL AND claim.expires_at > ?
                   AND claim.lease_generation = (
                     SELECT MAX(newest.lease_generation) FROM claim AS newest
                     WHERE newest.task_ref = claim.task_ref))
           UNION ALL
           SELECT DISTINCT 'c' || task_edge.blocker FROM task_edge
             JOIN task AS blocker_task ON blocker_task.id = task_edge.blocker AND blocker_task.state = 'cancelled'
             JOIN task AS dependent ON dependent.id = task_edge.blocked AND dependent.state = 'queued'
             JOIN task_ref ON task_ref.backend = '${"built-in"}' AND task_ref.external_id = task_edge.blocked
             JOIN task_ref AS blocker_ref ON blocker_ref.backend = '${"built-in"}' AND blocker_ref.external_id = task_edge.blocker
             WHERE ${admission}
               AND ${admission.replace(/task_ref\./g, "blocker_ref.")}
           LIMIT ?
         )`,
      )
      .get(...params(), ...params(), ...params(), now.toISOString(), ...params(), ...params(), cap);
    const count = Number(row?.["n"] ?? 0);
    return { count, saturated: count >= cap };
  }

  /** Every repo the queue has ever seen — candidates for the opener, never authorization. */

  /** Every repo the queue has ever seen — candidates for the opener, never authorization. */
  knownRepos(): string[] {
    return this.db
      .prepare(
        `SELECT DISTINCT repo AS path FROM task_ref WHERE repo IS NOT NULL
         UNION SELECT DISTINCT repo FROM capability
         UNION SELECT DISTINCT repo FROM publication_grant`,
      )
      .all()
      .map(row => String(row["path"]));
  }

  // ---- the watch episode ---------------------------------------------------

  /** The night begins: one row per watch, keyed by its incarnation. */
  startWatchEpisode(episode: { repo: string; runner: string; incarnation: string }, now: Date): number {
    const inserted = this.db
      .prepare(
        "INSERT INTO watch_episode (repo, runner, incarnation, started_at) VALUES (?, ?, ?, ?)",
      )
      .run(episode.repo, episode.runner, episode.incarnation, now.toISOString());
    return Number(inserted.lastInsertRowid);
  }

  /** The night ends, with its own numbers. A crash never writes this — and that absence is data. */
  endWatchEpisode(
    incarnation: string,
    totals: { ticks: number; built: number; broke: number },
    now: Date,
  ): void {
    this.db
      .prepare(
        "UPDATE watch_episode SET ended_at = ?, ticks = ?, built = ?, broke = ? WHERE incarnation = ?",
      )
      .run(now.toISOString(), totals.ticks, totals.built, totals.broke, incarnation);
  }

  latestWatchEpisode(repo: string): {
    id: number;
    repo: string;
    runner: string;
    incarnation: string;
    startedAt: string;
    endedAt: string | null;
    ticks: number;
    built: number;
    broke: number;
  } | null {
    const row = this.db
      .prepare("SELECT * FROM watch_episode WHERE repo = ? ORDER BY id DESC LIMIT 1")
      .get(repo);
    if (row === undefined) return null;
    return {
      id: Number(row["id"]),
      repo: String(row["repo"]),
      runner: String(row["runner"]),
      incarnation: String(row["incarnation"]),
      startedAt: String(row["started_at"]),
      endedAt: row["ended_at"] === null ? null : String(row["ended_at"]),
      ticks: Number(row["ticks"]),
      built: Number(row["built"]),
      broke: Number(row["broke"]),
    };
  }

  // ---- the wake sequence ---------------------------------------------------

  /** Something changed that could make work dispatchable. Cheap, and safe anywhere. */
  bumpWake(): void {
    this.db.prepare("UPDATE wake SET seq = seq + 1 WHERE id = 1").run();
  }

  wakeSeq(): number {
    const row = this.db.prepare("SELECT seq FROM wake WHERE id = 1").get();
    return Number(row?.["seq"] ?? 0);
  }

  // ---- the watch lease -----------------------------------------------------

  /**
   * One watch per (runner, repo). Same shape as the bridge's poll lease:
   * takeover on expiry bumps the generation, and the superseded owner's
   * name comes back so its claims can be recovered before anything new
   * dispatches. `watch + cron tick` deliberately does NOT contend here —
   * ordinary claims make that race safe; only watch+watch is an error.
   */
  acquireWatchLease(
    runner: string,
    repo: string,
    owner: string,
    ttlMs: number,
    now: Date,
  ):
    | { ok: true; generation: number; superseded: string | null }
    | { ok: false; reason: "watch-busy"; holder: string; until: string } {
    return this.transact(() => {
      const stamp = now.toISOString();
      const expires = new Date(now.getTime() + ttlMs).toISOString();
      const row = this.db
        .prepare("SELECT * FROM watch_lease WHERE runner = ? AND repo = ?")
        .get(runner, repo);
      if (row === undefined) {
        this.db
          .prepare(
            `INSERT INTO watch_lease (runner, repo, owner, generation, started_at, expires_at, heartbeat_at)
             VALUES (?, ?, ?, 1, ?, ?, ?)`,
          )
          .run(runner, repo, owner, stamp, expires, stamp);
        return { ok: true as const, generation: 1, superseded: null };
      }
      const holder = String(row["owner"]);
      const live = String(row["expires_at"]) > stamp;
      if (live && holder !== owner) {
        return {
          ok: false as const,
          reason: "watch-busy" as const,
          holder,
          until: String(row["expires_at"]),
        };
      }
      const generation = live && holder === owner ? Number(row["generation"]) : Number(row["generation"]) + 1;
      this.db
        .prepare(
          `UPDATE watch_lease SET owner = ?, generation = ?, expires_at = ?, heartbeat_at = ?
            WHERE runner = ? AND repo = ?`,
        )
        .run(owner, generation, expires, stamp, runner, repo);
      return {
        ok: true as const,
        generation,
        superseded: holder === owner ? null : holder,
      };
    });
  }

  heartbeatWatchLease(runner: string, repo: string, owner: string, ttlMs: number, now: Date): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE watch_lease SET expires_at = ?, heartbeat_at = ?
          WHERE runner = ? AND repo = ? AND owner = ? AND expires_at > ?`,
      )
      .run(
        new Date(now.getTime() + ttlMs).toISOString(),
        now.toISOString(),
        runner,
        repo,
        owner,
        now.toISOString(),
      );
    return Number(changes) > 0;
  }

  releaseWatchLease(runner: string, repo: string, owner: string, now: Date): void {
    this.db
      .prepare("UPDATE watch_lease SET expires_at = ? WHERE runner = ? AND repo = ? AND owner = ?")
      .run(now.toISOString(), runner, repo, owner);
  }

  /** The first still-unexpired watch lease this runner holds, if any (arc 2:
   * the takeover door refuses while one exists). */
  liveWatchLeaseOf(runner: string, now: Date): { repo: string; owner: string; until: string } | null {
    const row = this.db
      .prepare("SELECT repo, owner, expires_at FROM watch_lease WHERE runner = ? AND expires_at > ? LIMIT 1")
      .get(runner, now.toISOString());
    return row === undefined
      ? null
      : { repo: String(row["repo"]), owner: String(row["owner"]), until: String(row["expires_at"]) };
  }

  /**
   * Finish everything a dead runner left mid-flight, BY THE RUNS TABLE
   * (arc 2 findings 26/31): every open run recorded against the runner —
   * deliberately NOT filtered on claim released_at, so work whose claim a
   * reaper already released still gets its run finished as interrupted and
   * its task requeued. The requeue guards on the ONE liveness fact: a task
   * some newer live claim owns is that claim's business, not ours. Also
   * sweeps tasks stranded `running` with no open run at all (a prior
   * recovery crashed between finishing the run and requeueing).
   */
  recoverRunnerWork(runner: string, now: Date): number {
    return this.transact(() => {
      const stamp = now.toISOString();
      let recovered = 0;
      const open = this.db
        .prepare(
          `SELECT id, task_ref FROM run WHERE runner = ? AND outcome IS NULL
            AND NOT EXISTS (SELECT 1 FROM held_session WHERE held_session.run = run.id AND held_session.ended_at IS NULL)`,
        )
        .all(runner);
      for (const row of open) {
        const taskRef = Number(row["task_ref"]);
        this.db
          .prepare("UPDATE run SET outcome = 'failed', reason = 'interrupted', finished_at = ? WHERE id = ?")
          .run(stamp, Number(row["id"]));
        if (this.currentLiveLease(taskRef, now) === null) {
          this.db
            .prepare(
              `UPDATE task SET state = 'queued', updated_at = ?
                WHERE state = 'running' AND id = (
                  SELECT external_id FROM task_ref WHERE id = ? AND backend = ?
                )`,
            )
            .run(stamp, taskRef, BUILT_IN);
        }
        this.db
          .prepare("UPDATE worktree SET released_at = ?, verified = 0 WHERE runner = ? AND task_ref = ? AND released_at IS NULL")
          .run(stamp, runner, taskRef);
        recovered += 1;
      }
      // Stranded `running` tasks whose newest claim was this runner's and
      // whose lease is gone: no open run to finish, still not in the ready
      // set — requeue them too (finding 31's crashed-recovery walk).
      const stranded = this.db
        .prepare(
          `SELECT task_ref.id AS ref, task.id AS task_id FROM task
             JOIN task_ref ON task_ref.external_id = task.id AND task_ref.backend = ?
            WHERE task.state = 'running'
              AND (SELECT claim.runner FROM claim WHERE claim.task_ref = task_ref.id
                    ORDER BY claim.lease_generation DESC LIMIT 1) = ?
              AND NOT EXISTS (SELECT 1 FROM run WHERE run.task_ref = task_ref.id AND run.outcome IS NULL)
              AND NOT EXISTS (SELECT 1 FROM held_session
                              JOIN run AS held_run ON held_run.id = held_session.run
                              WHERE held_run.task_ref = task_ref.id AND held_session.ended_at IS NULL)`,
        )
        .all(BUILT_IN, runner);
      for (const row of stranded) {
        if (this.currentLiveLease(Number(row["ref"]), now) !== null) continue;
        this.db
          .prepare("UPDATE task SET state = 'queued', updated_at = ? WHERE id = ? AND state = 'running'")
          .run(stamp, String(row["task_id"]));
        recovered += 1;
      }
      if (recovered > 0) this.bumpWake();
      return recovered;
    });
  }

  /**
   * The first-approver door (arc 2 finding 2): INSERT only while the table
   * is EMPTY, one transaction — `up` can never upsert, never rotate an
   * existing password, and two cold starts serialize to one winner.
   */
  bootstrapApproverIfNone(
    name: string,
    credentialHash: string,
    now: Date,
  ): { ok: true } | { ok: false; reason: "approvers-exist" } {
    return this.transact(() => {
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM approver").get();
      if (Number(count?.["n"] ?? 0) > 0) return { ok: false as const, reason: "approvers-exist" as const };
      this.db
        .prepare("INSERT INTO approver (name, credential_hash, added_at, generation) VALUES (?, ?, ?, 1)")
        .run(name, credentialHash, now.toISOString());
      return { ok: true as const };
    });
  }

  /**
   * Recover everything a dead incarnation still holds, atomically, before
   * its successor dispatches anything: its live claims released as
   * 'recovered', their running tasks requeued, their open runs finished as
   * interrupted, their worktrees released unverified. Keyed to the
   * incarnation, never to runner liveness — the successor IS the runner,
   * alive and heartbeating, which is exactly how the crash would otherwise
   * hide.
   */
  recoverIncarnation(runner: string, incarnation: string, now: Date): number {
    return this.transact(() => {
      const stamp = now.toISOString();
      const claims = this.db
        .prepare(
          `SELECT lease_id, task_ref FROM claim
            WHERE runner = ? AND incarnation = ? AND released_at IS NULL
              AND lease_generation = (
                SELECT MAX(newest.lease_generation) FROM claim AS newest
                WHERE newest.task_ref = claim.task_ref
              )`,
        )
        .all(runner, incarnation);

      for (const row of claims) {
        const leaseId = String(row["lease_id"]);
        const taskRef = Number(row["task_ref"]);
        this.db
          .prepare("UPDATE claim SET released_at = ?, released_by = 'recovered' WHERE lease_id = ?")
          .run(stamp, leaseId);
        this.db
          .prepare(
            `UPDATE task SET state = 'queued', updated_at = ?
              WHERE state = 'running' AND id = (
                SELECT external_id FROM task_ref WHERE id = ? AND backend = ?
              )`,
          )
          .run(stamp, taskRef, BUILT_IN);
        this.db
          .prepare(
            `UPDATE run SET outcome = 'failed', reason = 'interrupted', finished_at = ?
              WHERE lease_id = ? AND outcome IS NULL`,
          )
          .run(stamp, leaseId);
        this.db
          .prepare(
            `UPDATE worktree SET released_at = ?, verified = 0
              WHERE runner = ? AND task_ref = ? AND released_at IS NULL`,
          )
          .run(stamp, runner, taskRef);
      }
      // Claims a reaper already released can still have OPEN runs — the
      // reap stamps released_at without finishing anything (arc 2 findings
      // 26/31). Their runs finish as interrupted here and their tasks
      // requeue when no newer live claim owns them, so reaped work cannot
      // stay `running` outside the ready set forever.
      let extra = 0;
      const orphaned = this.db
        .prepare(
          `SELECT run.id AS run_id, run.task_ref AS task_ref FROM run
             JOIN claim ON claim.lease_id = run.lease_id
            WHERE claim.runner = ? AND claim.incarnation = ? AND run.outcome IS NULL`,
        )
        .all(runner, incarnation);
      for (const row of orphaned) {
        const taskRef = Number(row["task_ref"]);
        this.db
          .prepare("UPDATE run SET outcome = 'failed', reason = 'interrupted', finished_at = ? WHERE id = ?")
          .run(stamp, Number(row["run_id"]));
        if (this.currentLiveLease(taskRef, now) === null) {
          this.db
            .prepare(
              `UPDATE task SET state = 'queued', updated_at = ?
                WHERE state = 'running' AND id = (
                  SELECT external_id FROM task_ref WHERE id = ? AND backend = ?
                )`,
            )
            .run(stamp, taskRef, BUILT_IN);
        }
        this.db
          .prepare("UPDATE worktree SET released_at = ?, verified = 0 WHERE runner = ? AND task_ref = ? AND released_at IS NULL")
          .run(stamp, runner, taskRef);
        extra += 1;
      }
      if (claims.length + extra > 0) this.bumpWake();
      return claims.length + extra;
    });
  }

  // ---- quota ---------------------------------------------------------------

  /** Record that a credential ran dry — from a structured signal or an operator, never prose. */
  stampQuota(
    quota: { runner: string; provider: string; scope?: string; reason: string; resetAt?: Date; authMode?: "subscription" | "api-key"; credentialFp?: string },
    now: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO quota (runner, provider, scope, auth_mode, credential_fp, state, reason, observed_at, reset_at)
         VALUES (?, ?, ?, ?, ?, 'exhausted', ?, ?, ?)
         ON CONFLICT (runner, provider, scope, auth_mode, credential_fp) DO UPDATE SET
           state = 'exhausted', reason = excluded.reason,
           observed_at = excluded.observed_at, reset_at = excluded.reset_at`,
      )
      .run(
        quota.runner,
        quota.provider,
        quota.scope ?? "",
        quota.authMode ?? "subscription",
        quota.credentialFp ?? "",
        quota.reason,
        now.toISOString(),
        quota.resetAt === undefined ? null : quota.resetAt.toISOString(),
      );
  }

  /**
   * The quota gate's answer, with the lazy exhausted→half-open transition at
   * the known reset. Null means no recorded constraint.
   */
  quotaState(
    runner: string,
    provider: string,
    scope: string,
    now: Date,
    authMode: "subscription" | "api-key" = "subscription",
    credentialFp = "",
  ): { state: "exhausted" | "half-open"; reason: string; resetAt: string | null } | null {
    const stamp = now.toISOString();
    this.db
      .prepare(
        `UPDATE quota SET state = 'half-open'
          WHERE runner = ? AND provider = ? AND scope = ? AND auth_mode = ? AND credential_fp = ? AND state = 'exhausted'
            AND reset_at IS NOT NULL AND reset_at <= ?`,
      )
      .run(runner, provider, scope, authMode, credentialFp, stamp);
    const row = this.db
      .prepare("SELECT state, reason, reset_at FROM quota WHERE runner = ? AND provider = ? AND scope = ? AND auth_mode = ? AND credential_fp = ?")
      .get(runner, provider, scope, authMode, credentialFp);
    if (row === undefined) return null;
    return {
      state: String(row["state"]) as "exhausted" | "half-open",
      reason: String(row["reason"]),
      resetAt: row["reset_at"] === null ? null : String(row["reset_at"]),
    };
  }

  /**
   * Take the half-open slot: exactly one dispatch probes a recovered quota.
   * The conditional update is what makes it exactly one — and it re-arms
   * the exhausted state for a short window so racing passes stay refused
   * while the probe flies. The probe's success clears the row; the same
   * structured signal that stamped it re-stamps on failure.
   */
  consumeHalfOpen(runner: string, provider: string, scope: string, now: Date, authMode: "subscription" | "api-key" = "subscription", credentialFp = ""): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE quota SET state = 'exhausted', reset_at = ?
          WHERE runner = ? AND provider = ? AND scope = ? AND auth_mode = ? AND credential_fp = ? AND state = 'half-open'`,
      )
      .run(new Date(now.getTime() + 5 * 60_000).toISOString(), runner, provider, scope, authMode, credentialFp);
    return Number(changes) > 0;
  }

  /** A structured all-clear (or an operator's), by name. */
  clearQuota(runner: string, provider: string, scope: string, authMode: "subscription" | "api-key" = "subscription", credentialFp = ""): boolean {
    const { changes } = this.db
      .prepare("DELETE FROM quota WHERE runner = ? AND provider = ? AND scope = ? AND auth_mode = ? AND credential_fp = ?")
      .run(runner, provider, scope, authMode, credentialFp);
    return Number(changes) > 0;
  }

  /**
   * Live claims this runner holds right now — the occupied slots of §8's
   * capacity gate. A claim whose run is a HELD attended session is EXCLUDED
   * (v6 W2): capacity governs unattended work; the attended bound is the
   * session's own signed envelope (v28: any number of them), so watched
   * conversations never freeze the runner's queue.
   */
  liveClaimCount(runner: string, now: Date): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM claim
          WHERE runner = ? AND released_at IS NULL AND expires_at > ?
            AND lease_generation = (
              SELECT MAX(newest.lease_generation) FROM claim AS newest
              WHERE newest.task_ref = claim.task_ref
            )
            AND lease_id NOT IN (SELECT lease_id FROM held_session WHERE ended_at IS NULL)`,
      )
      .get(runner, now.toISOString());
    return Number(row?.["n"] ?? 0);
  }

  /** Forward only, and only under the live generation. A stale poller moves nothing. */
  advanceBridgeCursor(
    botId: string,
    owner: string,
    generation: number,
    cursor: number,
    now: Date,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE bridge_lease SET cursor = ?, heartbeat_at = ?
          WHERE bot_id = ? AND owner = ? AND generation = ? AND cursor < ?`,
      )
      .run(cursor, now.toISOString(), botId, owner, generation, cursor);
    return Number(changes) > 0;
  }

  /** True if this update has not been applied before. The PRIMARY KEY is the idempotency. */
  markTelegramUpdateApplied(updateId: number, result: string, now: Date): boolean {
    const { changes } = this.db
      .prepare(
        "INSERT OR IGNORE INTO telegram_update (update_id, applied_at, result) VALUES (?, ?, ?)",
      )
      .run(updateId, now.toISOString(), result);
    return Number(changes) > 0;
  }

  // ---- delivery claiming ---------------------------------------------------

  /**
   * Claim pending notifications for one deliverer. Two deliverers — the
   * bridge and `outbox deliver` — select-then-send-then-record, and without
   * a claim both can send the same row in the gap. The claim is a short
   * lease on the act of sending; a deliverer that dies mid-send leaves rows
   * that unclaim themselves by expiry.
   */
  claimDeliveries(owner: string, ttlMs: number, now: Date): Notification[] {
    return this.transact(() => {
      const stamp = now.toISOString();
      const rows = this.db
        .prepare(
          `SELECT id FROM notification
            WHERE delivered_at IS NULL AND resolved_at IS NULL
              AND (claim_owner IS NULL OR claim_expires_at <= ?)
            ORDER BY id`,
        )
        .all(stamp)
        .map(row => Number(row["id"]));
      const expires = new Date(now.getTime() + ttlMs).toISOString();
      for (const id of rows) {
        this.db
          .prepare("UPDATE notification SET claim_owner = ?, claim_expires_at = ? WHERE id = ?")
          .run(owner, expires, id);
      }
      return rows
        .map(id => this.db.prepare("SELECT * FROM notification WHERE id = ?").get(id))
        .filter((row): row is Record<string, unknown> => row !== undefined)
        .map(readNotification);
    });
  }

  /** Finalize only what this owner still holds. A lapsed claim writes nothing. */
  finalizeDelivery(
    id: number,
    owner: string,
    outcome: { ok: true; receipt: string | null } | { ok: false; error: string },
    now: Date,
  ): boolean {
    const stamp = now.toISOString();
    if (outcome.ok) {
      const { changes } = this.db
        .prepare(
          `UPDATE notification SET delivered_at = ?, receipt = ?, attempts = attempts + 1,
                                   last_attempt_at = ?, last_error = NULL,
                                   claim_owner = NULL, claim_expires_at = NULL
            WHERE id = ? AND claim_owner = ? AND delivered_at IS NULL`,
        )
        .run(stamp, outcome.receipt, stamp, id, owner);
      return Number(changes) > 0;
    }
    const { changes } = this.db
      .prepare(
        `UPDATE notification SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?,
                                 claim_owner = NULL, claim_expires_at = NULL
          WHERE id = ? AND claim_owner = ?`,
      )
      .run(stamp, outcome.error, id, owner);
    return Number(changes) > 0;
  }

  // ---- web push (arc 3) ----------------------------------------------------

  /**
   * Enroll a phone. One transaction: the high-water mark is MAX
   * (notification.id) read HERE (finding 11 — only newer facts ever page
   * this device); an identical live enrollment (same endpoint, approver,
   * generation) returns idempotent success; a CONFLICTING live binding —
   * different approver or a stale generation — is retired 'replaced' with
   * its pairs settled, and the fresh activation gets its own row
   * (finding 28).
   */
  enrollPushSubscription(
    args: {
      endpoint: string;
      p256dh: string;
      auth: string;
      approver: string;
      approverGeneration: number;
      uaWords: string;
      vapidFingerprint: string;
    },
    now: Date,
  ): { ok: true; id: number; replayed: boolean } | { ok: false; reason: "approver-cap" | "installation-cap" } {
    return this.transact(() => {
      const live = this.db
        .prepare("SELECT * FROM push_subscription WHERE endpoint = ? AND retired_at IS NULL")
        .get(args.endpoint);
      if (live !== undefined) {
        if (
          String(live["approver"]) === args.approver &&
          Number(live["approver_generation"]) === args.approverGeneration &&
          String(live["vapid_fingerprint"]) === args.vapidFingerprint
        ) {
          return { ok: true as const, id: Number(live["id"]), replayed: true };
        }
        this.retirePushSubscription(Number(live["id"]), "replaced", now);
      }
      const mine = this.db
        .prepare("SELECT COUNT(*) AS n FROM push_subscription WHERE approver = ? AND retired_at IS NULL")
        .get(args.approver);
      if (Number(mine?.["n"] ?? 0) >= 5) return { ok: false as const, reason: "approver-cap" as const };
      const all = this.db.prepare("SELECT COUNT(*) AS n FROM push_subscription WHERE retired_at IS NULL").get();
      if (Number(all?.["n"] ?? 0) >= 20) return { ok: false as const, reason: "installation-cap" as const };
      const mark = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS top FROM notification").get();
      const inserted = this.db
        .prepare(
          `INSERT INTO push_subscription
             (endpoint, p256dh, auth, approver, approver_generation, ua_words, vapid_fingerprint,
              starts_after_notification, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.endpoint,
          args.p256dh,
          args.auth,
          args.approver,
          args.approverGeneration,
          args.uaWords,
          args.vapidFingerprint,
          Number(mark?.["top"] ?? 0),
          now.toISOString(),
        );
      return { ok: true as const, id: Number(inserted.lastInsertRowid), replayed: false };
    });
  }

  /**
   * Retire an enrollment and terminally settle EVERY unsettled pair —
   * pending AND claimed (finding 25): an in-flight sender's fence or
   * settlement fails instead of paging a device that was just removed.
   */
  retirePushSubscription(id: number, reason: string, now: Date): void {
    this.transact(() => {
      const stamp = now.toISOString();
      this.db
        .prepare("UPDATE push_subscription SET retired_at = ?, retired_reason = ? WHERE id = ? AND retired_at IS NULL")
        .run(stamp, reason, id);
      this.db
        .prepare(
          `UPDATE push_delivery SET state = 'retired', claim_owner = NULL, claim_expires_at = NULL,
                                    claim_generation = claim_generation + 1
            WHERE subscription = ? AND state IN ('pending','claimed')`,
        )
        .run(id);
    });
  }

  listPushSubscriptions(approver?: string): PushSubscription[] {
    const rows =
      approver === undefined
        ? this.db.prepare("SELECT * FROM push_subscription ORDER BY id").all()
        : this.db.prepare("SELECT * FROM push_subscription WHERE approver = ? ORDER BY id").all(approver);
    return rows.map(readPushSubscription);
  }

  /** Retire every live enrollment whose VAPID key is not the current one
   * (finding 27): a subscription is bound to the key it enrolled under and
   * rejects any other — after a key regeneration they are dead weight. */
  retirePushSubscriptionsOfOtherKeys(currentFingerprint: string, now: Date): number {
    const stale = this.db
      .prepare("SELECT id FROM push_subscription WHERE retired_at IS NULL AND vapid_fingerprint <> ?")
      .all(currentFingerprint)
      .map(row => Number(row["id"]));
    for (const id of stale) this.retirePushSubscription(id, "key-rotated", now);
    return stale.length;
  }

  /**
   * Seed pairs (arc 3 finding 1): one per (eligible notification, live
   * subscription), INSERT OR IGNORE — eligibility is a STAMPED class, an
   * unresolved row, and an id NEWER than the subscription's high-water
   * mark. The outbox's delivered_at is deliberately not consulted.
   */
  seedPushPairs(now: Date): number {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO push_delivery (notification, subscription, created_at)
         SELECT notification.id, push_subscription.id, ?
           FROM notification, push_subscription
          WHERE notification.push_class IS NOT NULL
            AND notification.resolved_at IS NULL
            AND push_subscription.retired_at IS NULL
            AND notification.id > push_subscription.starts_after_notification`,
      )
      .run(now.toISOString());
    return Number(changes);
  }

  /**
   * Claim due pairs: pending (respecting next_attempt_at) or claimed-but-
   * expired (reclaim bumps the generation — the old owner loses every
   * subsequent conditional write, the merge-ledger discipline).
   */
  claimPushPairs(owner: string, ttlMs: number, limit: number, now: Date): PushPair[] {
    return this.transact(() => {
      const stamp = now.toISOString();
      const expires = new Date(now.getTime() + ttlMs).toISOString();
      const due = this.db
        .prepare(
          `SELECT id FROM push_delivery
            WHERE (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
               OR (state = 'claimed' AND claim_expires_at <= ?)
            ORDER BY id LIMIT ?`,
        )
        .all(stamp, stamp, limit)
        .map(row => Number(row["id"]));
      const taken: number[] = [];
      for (const id of due) {
        const { changes } = this.db
          .prepare(
            `UPDATE push_delivery SET state = 'claimed', claim_owner = ?, claim_expires_at = ?,
                                      claim_generation = claim_generation + 1
              WHERE id = ? AND (
                (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
                OR (state = 'claimed' AND claim_expires_at <= ?)
              )`,
          )
          .run(owner, expires, id, stamp, stamp);
        if (Number(changes) > 0) taken.push(id);
      }
      return taken
        .map(id => this.db.prepare("SELECT * FROM push_delivery WHERE id = ?").get(id))
        .filter((row): row is Record<string, unknown> => row !== undefined)
        .map(readPushPair);
    });
  }

  /** Renew a claim this owner+generation still holds — false is FATAL to the send. */
  renewPushClaim(id: number, owner: string, generation: number, ttlMs: number, now: Date): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE push_delivery SET claim_expires_at = ?
          WHERE id = ? AND state = 'claimed' AND claim_owner = ? AND claim_generation = ?`,
      )
      .run(new Date(now.getTime() + ttlMs).toISOString(), id, owner, generation);
    return Number(changes) > 0;
  }

  /**
   * The send-time fence (finding 12/25), one read: the pair still ours,
   * the subscription live under its enrolled generation, the notification
   * unresolved and still stamped. Null = do not transmit.
   */
  pushSendFence(id: number, owner: string, generation: number): (PushPair & { subscriptionRow: PushSubscription; notificationRow: Notification }) | null {
    const pair = this.db
      .prepare(
        `SELECT * FROM push_delivery
          WHERE id = ? AND state = 'claimed' AND claim_owner = ? AND claim_generation = ?`,
      )
      .get(id, owner, generation);
    if (pair === undefined) return null;
    const subscription = this.db
      .prepare("SELECT * FROM push_subscription WHERE id = ? AND retired_at IS NULL")
      .get(Number(pair["subscription"]));
    if (subscription === undefined) return null;
    const approver = this.db.prepare("SELECT generation FROM approver WHERE name = ?").get(String(subscription["approver"]));
    if (approver === undefined || Number(approver["generation"]) !== Number(subscription["approver_generation"])) return null;
    const notification = this.db
      .prepare("SELECT * FROM notification WHERE id = ? AND resolved_at IS NULL AND push_class IS NOT NULL")
      .get(Number(pair["notification"]));
    if (notification === undefined) return null;
    return { ...readPushPair(pair), subscriptionRow: readPushSubscription(subscription), notificationRow: readNotification(notification) };
  }

  /** Settle a pair, conditionally on owner + generation (finding 25). */
  settlePushPair(
    id: number,
    owner: string,
    generation: number,
    outcome:
      | { kind: "accepted" }
      | { kind: "rejected"; error: string }
      | { kind: "undeliverable"; error: string }
      | { kind: "backoff"; nextAttemptAt: Date; error: string },
    now: Date,
  ): boolean {
    return this.transact(() => {
      const stamp = now.toISOString();
      const fence = "id = ? AND state = 'claimed' AND claim_owner = ? AND claim_generation = ?";
      if (outcome.kind === "accepted") {
        const { changes } = this.db
          .prepare(
            `UPDATE push_delivery SET state = 'accepted', accepted_at = ?, attempts = attempts + 1,
                                      claim_owner = NULL, claim_expires_at = NULL, last_error = NULL
              WHERE ${fence}`,
          )
          .run(stamp, id, owner, generation);
        if (Number(changes) > 0) {
          this.db
            .prepare(
              `UPDATE push_subscription SET last_ok_at = ?, consecutive_failures = 0
                WHERE id = (SELECT subscription FROM push_delivery WHERE id = ?)`,
            )
            .run(stamp, id);
        }
        return Number(changes) > 0;
      }
      if (outcome.kind === "backoff") {
        const { changes } = this.db
          .prepare(
            `UPDATE push_delivery SET state = 'pending', next_attempt_at = ?, attempts = attempts + 1,
                                      last_error = ?, claim_owner = NULL, claim_expires_at = NULL
              WHERE ${fence}`,
          )
          .run(outcome.nextAttemptAt.toISOString(), outcome.error, id, owner, generation);
        if (Number(changes) > 0) this.bumpPushFailures(id);
        return Number(changes) > 0;
      }
      const { changes } = this.db
        .prepare(
          `UPDATE push_delivery SET state = ?, attempts = attempts + 1, last_error = ?,
                                    claim_owner = NULL, claim_expires_at = NULL
            WHERE ${fence}`,
        )
        .run(outcome.kind, outcome.error, id, owner, generation);
      if (Number(changes) > 0) this.bumpPushFailures(id);
      return Number(changes) > 0;
    });
  }

  private bumpPushFailures(pairId: number): void {
    this.db
      .prepare(
        `UPDATE push_subscription SET consecutive_failures = consecutive_failures + 1
          WHERE id = (SELECT subscription FROM push_delivery WHERE id = ?)`,
      )
      .run(pairId);
  }

  // ---- idempotency --------------------------------------------------------

  /**
   * Run `body` once per key, ever.
   *
   * The case this exists for is a runner that completes its work, has its
   * acknowledgement lost to a dropped connection, and retries. Without a key
   * the retry is a second, different mutation; with one it is the same answer
   * handed back. Callers that pass no key are not protected, which is why the
   * dispatch path always passes one.
   */
  /**
   * `worthRecording` exists for one case, and it is not a nicety.
   *
   * Idempotency protects against a mutation happening twice. A refusal is not
   * a mutation — nothing happened — so recording it turns the key into a
   * permanent "no". A dispatcher that asked for a busy task, was told no, and
   * retried the same key an hour later would be handed that hour-old refusal
   * about a task that has been free for fifty minutes.
   */
  replay<T>(
    mutation: Mutation,
    operation: string,
    body: () => T,
    worthRecording: (result: T) => boolean = () => true,
  ): T {
    return this.once(mutation, operation, body, worthRecording);
  }

  private once<T>(
    mutation: Mutation,
    operation: string,
    body: () => T,
    worthRecording: (result: T) => boolean = () => true,
  ): T {
    const { idempotencyKey, actor = DEFAULT_ACTOR, at = new Date() } = mutation;
    if (idempotencyKey === undefined) return body();

    const seen = this.db
      .prepare("SELECT result FROM mutation WHERE idempotency_key = ?")
      .get(idempotencyKey);
    if (seen !== undefined) return JSON.parse(String(seen["result"])) as T;

    const result = body();
    if (!worthRecording(result)) return result;

    this.db
      .prepare(
        "INSERT INTO mutation (idempotency_key, operation, result, actor, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(idempotencyKey, operation, JSON.stringify(result ?? null), actor, at.toISOString());
    return result;
  }
}

function readRun(row: Record<string, unknown>): Run {
  return {
    id: Number(row["id"]),
    taskRef: Number(row["task_ref"]),
    leaseId: String(row["lease_id"]),
    runner: String(row["runner"]),
    role: String(row["role"] ?? "builder") as Run["role"],
    provider: String(row["provider"] ?? "claude"),
    parentRun: row["parent_run"] === null || row["parent_run"] === undefined ? null : Number(row["parent_run"]),
    sessionId: row["session_id"] === null || row["session_id"] === undefined ? null : String(row["session_id"]),
    contestant: row["contestant"] === null || row["contestant"] === undefined ? null : Number(row["contestant"]),
    baseRevision:
      row["base_revision"] === null || row["base_revision"] === undefined
        ? null
        : String(row["base_revision"]),
    scopeDigest: row["scope_digest"] === null || row["scope_digest"] === undefined ? null : String(row["scope_digest"]),
    profileDigest: row["profile_digest"] === null || row["profile_digest"] === undefined ? null : String(row["profile_digest"]),
    attendedAuthorization:
      row["attended_authorization"] === null || row["attended_authorization"] === undefined
        ? null
        : String(row["attended_authorization"]),
    branch: row["branch"] === null ? null : String(row["branch"]),
    worktree: row["worktree"] === null ? null : String(row["worktree"]),
    model: row["model"] === null ? null : String(row["model"]),
    outcome: row["outcome"] === null ? null : (String(row["outcome"]) as Run["outcome"]),
    reason: row["reason"] === null ? null : String(row["reason"]),
    committed: row["committed"] === null ? null : Number(row["committed"]) === 1,
    startedAt: String(row["started_at"]),
    finishedAt: row["finished_at"] === null ? null : String(row["finished_at"]),
    providerVersion:
      row["provider_version"] === null || row["provider_version"] === undefined
        ? null
        : String(row["provider_version"]),
    providerStartedAt:
      row["provider_started_at"] === null || row["provider_started_at"] === undefined
        ? null
        : String(row["provider_started_at"]),
    tokensIn: row["tokens_in"] === null || row["tokens_in"] === undefined ? null : Number(row["tokens_in"]),
    tokensOut: row["tokens_out"] === null || row["tokens_out"] === undefined ? null : Number(row["tokens_out"]),
    costUsd: row["cost_usd"] === null || row["cost_usd"] === undefined ? null : Number(row["cost_usd"]),
    headRevision:
      row["head_revision"] === null || row["head_revision"] === undefined
        ? null
        : String(row["head_revision"]),
    handoff: row["handoff"] === null || row["handoff"] === undefined ? null : String(row["handoff"]),
    phase:
      row["phase"] === null || row["phase"] === undefined
        ? null
        : (RUN_PHASES as readonly string[]).includes(String(row["phase"]))
          ? (String(row["phase"]) as RunPhase)
          : null,
    chainCycle: row["chain_cycle"] === null || row["chain_cycle"] === undefined ? null : Number(row["chain_cycle"]),
    chainIndex: row["chain_index"] === null || row["chain_index"] === undefined ? null : Number(row["chain_index"]),
    entryDigest: row["entry_digest"] === null || row["entry_digest"] === undefined ? null : String(row["entry_digest"]),
    authMode:
      row["auth_mode"] === null || row["auth_mode"] === undefined
        ? null
        : String(row["auth_mode"]) === "api-key"
          ? "api-key"
          : "subscription",
    terminalClass:
      row["terminal_class"] === null || row["terminal_class"] === undefined
        ? null
        : (String(row["terminal_class"]) as TerminalClass),
  };
}

function readAuthorizationRow(row: Record<string, unknown>): AttendedAuthorization {
  return {
    id: String(row["id"]),
    taskRef: Number(row["task_ref"]),
    approver: String(row["approver"]),
    runner: String(row["runner"]),
    runnerGeneration: Number(row["runner_generation"]),
    compositeDigest: String(row["composite_digest"]),
    termsJson: String(row["terms_json"]),
    maxSessionTurns: Number(row["max_session_turns"]),
    budgetMicrousd: Number(row["budget_microusd"]),
    parentRun: row["parent_run"] === null ? null : Number(row["parent_run"]),
    followup: row["followup"] === null ? null : String(row["followup"]),
    createdAt: String(row["created_at"]),
    absoluteExpiry: String(row["absolute_expiry"]),
    lastBeatAt: row["last_beat_at"] === null ? null : String(row["last_beat_at"]),
    attemptRun: row["attempt_run"] === null ? null : Number(row["attempt_run"]),
    consumedAt: row["consumed_at"] === null ? null : String(row["consumed_at"]),
    closedAt: row["closed_at"] === null ? null : String(row["closed_at"]),
    endReason: row["end_reason"] === null ? null : String(row["end_reason"]),
  };
}

function readSessionTurnRow(row: Record<string, unknown>): SessionTurn {
  return {
    id: Number(row["id"]),
    run: Number(row["run"]),
    seq: Number(row["seq"]),
    sourceKind: String(row["source_kind"]) as SessionTurn["sourceKind"],
    sourceId: row["source_id"] === null ? null : Number(row["source_id"]),
    author: row["author"] === null ? null : String(row["author"]),
    text: String(row["text"]),
    reservedMicrousd: Number(row["reserved_microusd"]),
    accountedMicrousd: row["accounted_microusd"] === null ? null : Number(row["accounted_microusd"]),
    accountedAt: row["accounted_at"] === null ? null : String(row["accounted_at"]),
    recordedAt: String(row["recorded_at"]),
    writtenAt: row["written_at"] === null ? null : String(row["written_at"]),
    acceptedAt: row["accepted_at"] === null ? null : String(row["accepted_at"]),
    settledAt: row["settled_at"] === null ? null : String(row["settled_at"]),
    measuredMicrousd: row["measured_microusd"] === null ? null : Number(row["measured_microusd"]),
    outputTokens: row["output_tokens"] === null ? null : Number(row["output_tokens"]),
    state: String(row["state"]) as SessionTurn["state"],
  };
}

function readHeldSessionRow(row: Record<string, unknown>): HeldSession {
  return {
    run: Number(row["run"]),
    authorizationId: String(row["authorization_id"]),
    runner: String(row["runner"]),
    leaseId: String(row["lease_id"]),
    upIncarnation: String(row["up_incarnation"]),
    cookie: String(row["cookie"]),
    socketPath: String(row["socket_path"]),
    supervisorPid: row["supervisor_pid"] === null ? null : Number(row["supervisor_pid"]),
    agentPgid: row["agent_pgid"] === null ? null : Number(row["agent_pgid"]),
    cumulativeMicrousd: Number(row["cumulative_microusd"]),
    cumulativeTokensOut: Number(row["cumulative_tokens_out"]),
    state: String(row["state"]) as HeldSession["state"],
    fencer: row["fencer"] === null ? null : String(row["fencer"]),
    fencingDeadline: row["fencing_deadline"] === null ? null : String(row["fencing_deadline"]),
    startedAt: String(row["started_at"]),
    endedAt: row["ended_at"] === null ? null : String(row["ended_at"]),
    endReason: row["end_reason"] === null ? null : String(row["end_reason"]),
  };
}

function readHold(row: Record<string, unknown>): Hold {
  return {
    id: Number(row["id"]),
    taskRef: Number(row["task_ref"]),
    ownerKind: String(row["owner_kind"]) as HoldOwner,
    ownerId: String(row["owner_id"]),
    reason: String(row["reason"]),
    until: row["until"] === null ? null : String(row["until"]),
    heldAt: String(row["held_at"]),
  };
}

function readNotification(row: Record<string, unknown>): Notification {
  return {
    id: Number(row["id"]),
    dedupeKey: String(row["dedupe_key"]),
    kind: String(row["kind"]),
    subject: String(row["subject"]),
    body: String(row["body"]),
    createdAt: String(row["created_at"]),
    attempts: Number(row["attempts"]),
    lastAttemptAt: row["last_attempt_at"] === null ? null : String(row["last_attempt_at"]),
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    deliveredAt: row["delivered_at"] === null ? null : String(row["delivered_at"]),
    receipt: row["receipt"] === null ? null : String(row["receipt"]),
    resolvedAt:
      row["resolved_at"] === null || row["resolved_at"] === undefined
        ? null
        : String(row["resolved_at"]),
    pushClass:
      row["push_class"] === null || row["push_class"] === undefined
        ? null
        : (String(row["push_class"]) as Notification["pushClass"]),
    link: row["link"] === null || row["link"] === undefined ? null : String(row["link"]),
  };
}

function readPushSubscription(row: Record<string, unknown>): PushSubscription {
  return {
    id: Number(row["id"]),
    endpoint: String(row["endpoint"]),
    p256dh: String(row["p256dh"]),
    auth: String(row["auth"]),
    approver: String(row["approver"]),
    approverGeneration: Number(row["approver_generation"]),
    uaWords: String(row["ua_words"]),
    vapidFingerprint: String(row["vapid_fingerprint"]),
    startsAfterNotification: Number(row["starts_after_notification"]),
    createdAt: String(row["created_at"]),
    lastOkAt: row["last_ok_at"] === null ? null : String(row["last_ok_at"]),
    consecutiveFailures: Number(row["consecutive_failures"]),
    retiredAt: row["retired_at"] === null ? null : String(row["retired_at"]),
    retiredReason: row["retired_reason"] === null ? null : String(row["retired_reason"]),
  };
}

function readPushPair(row: Record<string, unknown>): PushPair {
  return {
    id: Number(row["id"]),
    notification: Number(row["notification"]),
    subscription: Number(row["subscription"]),
    state: String(row["state"]) as PushPair["state"],
    claimOwner: row["claim_owner"] === null ? null : String(row["claim_owner"]),
    claimGeneration: Number(row["claim_generation"]),
    attempts: Number(row["attempts"]),
    nextAttemptAt: row["next_attempt_at"] === null ? null : String(row["next_attempt_at"]),
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    acceptedAt: row["accepted_at"] === null ? null : String(row["accepted_at"]),
  };
}

function readSteerNote(row: Record<string, unknown>): SteerNote {
  return {
    id: Number(row["id"]),
    taskRef: Number(row["task_ref"]),
    author: String(row["author"]),
    note: String(row["note"]),
    createdAt: String(row["created_at"]),
    attachedRun: row["attached_run"] === null ? null : Number(row["attached_run"]),
    attachedAt: row["attached_at"] === null ? null : String(row["attached_at"]),
    deliveredAt: row["delivered_at"] === null ? null : String(row["delivered_at"]),
    supersededAt: row["superseded_at"] === null ? null : String(row["superseded_at"]),
    authorshipState: row["authorship_state"] === "verified" ? "verified" : "unverified-legacy",
    supersededReason: row["superseded_reason"] === null || row["superseded_reason"] === undefined ? null : String(row["superseded_reason"]),
  };
}

function readDecision(row: Record<string, unknown>): Decision {
  return {
    id: Number(row["id"]),
    run: Number(row["run"]),
    urgency: String(row["urgency"]) as Decision["urgency"],
    state: String(row["state"]) as Decision["state"],
    recap: String(row["recap"]),
    question: String(row["question"]),
    options: JSON.parse(String(row["options"])) as DecisionOption[],
    recommendation: String(row["recommendation"]),
    assignee: row["assignee"] === null ? null : String(row["assignee"]),
    deadline: row["deadline"] === null ? null : String(row["deadline"]),
    createdAt: String(row["created_at"]),
    answeredAt: row["answered_at"] === null ? null : String(row["answered_at"]),
    answeredBy: row["answered_by"] === null ? null : String(row["answered_by"]),
    answeredVia:
      row["answered_via"] === null ? null : (String(row["answered_via"]) as Decision["answeredVia"]),
    choice: row["choice"] === null ? null : String(row["choice"]),
    note: row["note"] === null ? null : String(row["note"]),
  };
}

function readArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: Number(row["id"]),
    run: Number(row["run"]),
    kind: String(row["kind"]) as Artifact["kind"],
    key: String(row["key"]),
    bytesOriginal: Number(row["bytes_original"]),
    bytesStored: Number(row["bytes_stored"]),
    truncated: Number(row["truncated"]) === 1,
    sha256: String(row["sha256"]),
    capture: String(row["capture"]),
    createdAt: String(row["created_at"]),
    redacted: Number(row["redacted"]) === 1,
    captureStatus: row["capture_status"] === null || row["capture_status"] === undefined ? null : (String(row["capture_status"]) as "ok" | "failed"),
  };
}

function readTelegramBinding(row: Record<string, unknown>): TelegramBinding {
  return {
    id: Number(row["id"]),
    botId: String(row["bot_id"]),
    chatId: String(row["chat_id"]),
    userId: String(row["user_id"]),
    approver: String(row["approver"]),
    approverGeneration: Number(row["approver_generation"]),
    pairedAt: String(row["paired_at"]),
    pairedBy: String(row["paired_by"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
    revokedBy: row["revoked_by"] === null ? null : String(row["revoked_by"]),
  };
}

function readTelegramAction(row: Record<string, unknown>): TelegramAction {
  return {
    token: String(row["token"]),
    binding: Number(row["binding"]),
    decision: Number(row["decision"]),
    optionId: String(row["option_id"]),
    phase: String(row["phase"]) as TelegramAction["phase"],
    chatId: String(row["chat_id"]),
    messageId: row["message_id"] === null ? null : String(row["message_id"]),
    createdAt: String(row["created_at"]),
    expiresAt: row["expires_at"] === null ? null : String(row["expires_at"]),
    consumedAt: row["consumed_at"] === null ? null : String(row["consumed_at"]),
    noteDigest: row["note_digest"] === null || row["note_digest"] === undefined ? null : String(row["note_digest"]),
  };
}

function readIncident(row: Record<string, unknown>): Incident {
  return {
    id: Number(row["id"]),
    run: Number(row["run"]),
    kind: String(row["kind"]) as Incident["kind"],
    createdAt: String(row["created_at"]),
    resolvedAt: row["resolved_at"] === null ? null : String(row["resolved_at"]),
    resolvedBy: row["resolved_by"] === null ? null : String(row["resolved_by"]),
  };
}

/** LIKE-prefix escaping (merge-grant round 1, finding 2): `_` and `%` in
 * a repository name are DATA — `o/a_b` must never match `o/axb`. */
function likeEscape(prefix: string): string {
  return prefix.replace(/\\/g, "\\\\").replace(/[%_]/g, match => `\\${match}`);
}

function readPublicationGrant(row: Record<string, unknown>): PublicationGrant {
  return {
    id: Number(row["id"]),
    repo: String(row["repo"]),
    githubRepo: String(row["github_repo"]),
    remote: String(row["remote"]),
    headPrefix: String(row["head_prefix"]),
    base: String(row["base"]),
    capabilities: JSON.parse(String(row["capabilities"])) as PublicationCapability[],
    selector: String(row["selector"]) as "ours" | "all",
    draft: Number(row["draft"]) === 1,
    grantedBy: String(row["granted_by"]),
    grantedAt: String(row["granted_at"]),
    revokedBy: row["revoked_by"] === null ? null : String(row["revoked_by"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
    merge: Number(row["merge"] ?? 0) === 1,
    mergeMethod:
      row["merge_method"] === null || row["merge_method"] === undefined
        ? null
        : (String(row["merge_method"]) as "squash" | "merge" | "rebase"),
    mergeDeleteBranch: Number(row["merge_delete_branch"] ?? 0) === 1,
  };
}

function readPublication(row: Record<string, unknown>): Publication {
  return {
    id: Number(row["id"]),
    run: Number(row["run"]),
    taskRef: Number(row["task_ref"]),
    githubRepo: String(row["github_repo"]),
    remote: String(row["remote"]),
    base: String(row["base"]),
    head: String(row["head"]),
    headSha: String(row["head_sha"]),
    bodyHash: String(row["body_hash"]),
    draft: Number(row["draft"]) === 1,
    state: String(row["state"]) as Publication["state"],
    prNumber: row["pr_number"] === null ? null : Number(row["pr_number"]),
    prUrl: row["pr_url"] === null ? null : String(row["pr_url"]),
    attempts: Number(row["attempts"]),
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    remoteState:
      row["remote_state"] === null || row["remote_state"] === undefined ? null : String(row["remote_state"]),
    lastCheckState:
      row["last_check_state"] === null || row["last_check_state"] === undefined ? null : String(row["last_check_state"]),
    lastCheckAt:
      row["last_check_at"] === null || row["last_check_at"] === undefined ? null : String(row["last_check_at"]),
  };
}

function readCapability(row: Record<string, unknown>): Capability {
  return {
    repo: String(row["repo"]),
    kind: String(row["kind"]) as Capability["kind"],
    name: String(row["name"]),
    probe: row["probe"] === null ? null : String(row["probe"]),
    status: String(row["status"]) as Capability["status"],
    addedBy: String(row["added_by"]),
    createdAt: String(row["created_at"]),
    lastVerifiedAt: row["last_verified_at"] === null ? null : String(row["last_verified_at"]),
    verifiedBy: row["verified_by"] === null ? null : String(row["verified_by"]),
    lastResult: row["last_result"] === null ? null : String(row["last_result"]),
    expiresAt: row["expires_at"] === null ? null : String(row["expires_at"]),
  };
}

function readTask(row: Record<string, unknown>): Task {
  return {
    id: String(row["id"]),
    title: String(row["title"]),
    state: String(row["state"]) as TaskState,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    priority: row["priority"] === null || row["priority"] === undefined ? 0 : Number(row["priority"]),
  };
}

function readTaskRef(row: Record<string, unknown>): TaskRef {
  return {
    id: Number(row["id"]),
    backend: String(row["backend"]),
    externalId: String(row["external_id"]),
    repo: row["repo"] === null || row["repo"] === undefined ? null : String(row["repo"]),
    assignedRunner:
      row["assigned_runner"] === null || row["assigned_runner"] === undefined ? null : String(row["assigned_runner"]),
    zones: readJsonArray(row["zones"]),
    capabilityRequirements: readJsonArray(row["capability_requirements"]),
    parkRate: Number(row["park_rate"]),
    plan:
      row["plan"] === null || row["plan"] === undefined
        ? null
        : (String(row["plan"]) as "requested" | "drafted"),
    planStrikes: Number(row["plan_strikes"] ?? 0),
    strikes: Number(row["strikes"] ?? 0),
    routineId:
      row["routine_id"] === null || row["routine_id"] === undefined
        ? null
        : Number(row["routine_id"]),
    agentProvider:
      row["agent_provider"] === null || row["agent_provider"] === undefined
        ? null
        : String(row["agent_provider"]),
    agentModel:
      row["agent_model"] === null || row["agent_model"] === undefined
        ? null
        : String(row["agent_model"]),
    planProvider:
      row["plan_provider"] === null || row["plan_provider"] === undefined
        ? null
        : String(row["plan_provider"]),
    planModel:
      row["plan_model"] === null || row["plan_model"] === undefined
        ? null
        : String(row["plan_model"]),
    revisionOf:
      row["revision_of"] === null || row["revision_of"] === undefined
        ? null
        : String(row["revision_of"]),
    revisionBriefArtifact:
      row["revision_brief_artifact"] === null || row["revision_brief_artifact"] === undefined
        ? null
        : Number(row["revision_brief_artifact"]),
    origin: String(row["origin"]) === "ours" ? "ours" : "theirs",
  };
}

function readRoutine(row: Record<string, unknown>): Routine {
  return {
    id: Number(row["id"]),
    name: String(row["name"]),
    repo: String(row["repo"]),
    goal: String(row["goal"]),
    outOfScope: row["out_of_scope"] === null ? null : String(row["out_of_scope"]),
    touches: readJsonArray(row["touches"]),
    requirements: readJsonArray(row["requirements"]),
    schedule: String(row["schedule"]),
    singleFlight: Number(row["single_flight"]) === 1,
    costCeilingUsd: row["cost_ceiling_usd"] === null ? null : Number(row["cost_ceiling_usd"]),
    budgetPerRunMicrousd:
      row["budget_per_run_microusd"] === null || row["budget_per_run_microusd"] === undefined
        ? null
        : Number(row["budget_per_run_microusd"]),
    paused: Number(row["paused"]) === 1,
    digest: String(row["digest"]),
    approvedAt: row["approved_at"] === null ? null : String(row["approved_at"]),
    approvedBy: row["approved_by"] === null ? null : String(row["approved_by"]),
    approvedDigest: row["approved_digest"] === null ? null : String(row["approved_digest"]),
    nextFireAt: row["next_fire_at"] === null ? null : String(row["next_fire_at"]),
    filedVia: row["filed_via"] === null || row["filed_via"] === undefined ? null : String(row["filed_via"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    profile: profileFromJson(row["profile_json"] === null || row["profile_json"] === undefined ? null : String(row["profile_json"])),
    approvedProfile: profileFromJson(
      row["approved_profile_json"] === null || row["approved_profile_json"] === undefined ? null : String(row["approved_profile_json"]),
    ),
  };
}


function readTournamentTerms(row: Record<string, unknown>): TournamentTerms {
  return {
    id: Number(row["id"]),
    taskRef: Number(row["task_ref"]),
    generation: Number(row["generation"]),
    active: Number(row["active"]) === 1,
    kind: String(row["kind"] ?? "race") === "comparison" ? "comparison" : "race",
    raceDigest: String(row["race_digest"]),
    agents: JSON.parse(String(row["agents"])) as TournamentTerms["agents"],
    n: Number(row["n"]),
    perAgentBudgetMicrousd: Number(row["per_agent_budget_microusd"]),
    overrunReserveMicrousd: Number(row["overrun_reserve_microusd"]),
    totalBudgetMicrousd: Number(row["total_budget_microusd"]),
    priceVersion: Number(row["price_version"]),
    retries: Number(row["retries"]),
    publicationPolicy: String(row["publication_policy"]),
    createdAt: String(row["created_at"]),
    approvedAt: row["approved_at"] === null ? null : String(row["approved_at"]),
    approvedBy: row["approved_by"] === null ? null : String(row["approved_by"]),
    approvedDigest: row["approved_digest"] === null ? null : String(row["approved_digest"]),
  };
}

function readContest(row: Record<string, unknown>): Contest {
  const maybe = (key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));
  return {
    id: Number(row["id"]),
    taskRef: Number(row["task_ref"]),
    terms: Number(row["terms"]),
    generation: Number(row["generation"]),
    state: String(row["state"]) as ContestState,
    scopeDigest: String(row["scope_digest"]),
    raceDigest: String(row["race_digest"]),
    baseSha: maybe("base_sha"),
    setupDigest: maybe("setup_digest"),
    currentLeaseId: maybe("current_lease_id"),
    runner: maybe("runner"),
    incarnation: maybe("incarnation"),
    createdAt: String(row["created_at"]),
    pickedAt: maybe("picked_at"),
    pickedBy: maybe("picked_by"),
    winnerContestant: row["winner_contestant"] === null ? null : Number(row["winner_contestant"]),
    overduePaged: Number(row["overdue_paged"] ?? 0) === 1,
    kind: String(row["kind"] ?? "race") === "comparison" ? "comparison" : "race",
  };
}

function readContestant(row: Record<string, unknown>): Contestant {
  return {
    id: Number(row["id"]),
    contest: Number(row["contest"]),
    ordinal: Number(row["ordinal"]),
    provider: String(row["provider"]),
    profile: profileFromJson(row["profile_json"] === null || row["profile_json"] === undefined ? null : String(row["profile_json"])),
    model: String(row["model"]),
    repairModel: String(row["repair_model"]),
    branch: String(row["branch"]),
    worktree: row["worktree"] === null ? null : String(row["worktree"]),
    generation: Number(row["generation"]),
    state: String(row["state"]) as ContestantState,
    activeRun: row["active_run"] === null ? null : Number(row["active_run"]),
    budgetMicrousd: Number(row["budget_microusd"]),
    reserveMicrousd: Number(row["reserve_microusd"]),
    measuredMicrousd: Number(row["measured_microusd"]),
    accountedMicrousd: Number(row["accounted_microusd"]),
    unknownSpend: Number(row["unknown_spend"]) === 1,
    cleanup: row["cleanup"] === null ? null : (String(row["cleanup"]) as "pending" | "done" | "attention"),
    custody: row["custody"] === null ? null : String(row["custody"]),
  };
}

function readExecutionSlot(row: Record<string, unknown>): ExecutionSlot {
  const maybe = (key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));
  return {
    id: Number(row["id"]),
    runner: String(row["runner"]),
    state: String(row["state"]) as ExecutionSlot["state"],
    run: row["run"] === null ? null : Number(row["run"]),
    contestant: row["contestant"] === null ? null : Number(row["contestant"]),
    incarnation: maybe("incarnation"),
    processGroup: row["process_group"] === null ? null : Number(row["process_group"]),
    reservedAt: String(row["reserved_at"]),
    runningAt: maybe("running_at"),
    releasedAt: maybe("released_at"),
  };
}

function readChatTurn(row: Record<string, unknown>): ChatTurn {
  const maybe = (key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));
  const maybeN = (key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]));
  return {
    id: Number(row["id"]),
    approver: String(row["approver"]),
    credentialKey: String(row["credential_key"]),
    provider: String(row["provider"]) as ChatProviderId,
    model: String(row["model"]),
    state: String(row["state"]) as ChatTurn["state"],
    generation: Number(row["generation"]),
    createdAt: String(row["created_at"]),
    startedAt: maybe("started_at"),
    deadlineAt: maybe("deadline_at"),
    finishedAt: maybe("finished_at"),
    tokensIn: maybeN("tokens_in"),
    tokensOut: maybeN("tokens_out"),
    reservedMicrousd: Number(row["reserved_microusd"]),
    settledMicrousd: maybeN("settled_microusd"),
    failureReason: maybe("failure_reason") as ChatFailureReason | null,
    unknownSpend: Number(row["unknown_spend"]) === 1,
    acknowledgedAt: maybe("acknowledged_at"),
    acknowledgedBy: maybe("acknowledged_by"),
    replyBytes: maybeN("reply_bytes"),
    candidateCount: maybeN("candidate_count"),
  };
}

function readRoutineFire(row: Record<string, unknown>): RoutineFire {
  return {
    id: Number(row["id"]),
    routineId: Number(row["routine_id"]),
    scheduledFor: String(row["scheduled_for"]),
    outcome: String(row["outcome"]) as "fired" | "skipped",
    reason: row["reason"] === null ? null : String(row["reason"]),
    instanceTaskRef: row["instance_task_ref"] === null ? null : Number(row["instance_task_ref"]),
    createdAt: String(row["created_at"]),
  };
}

export type WorktreeRow = {
  path: string;
  repo: string;
  branch: string;
  runner: string | null;
  taskRef: number | null;
  createdAt: string;
  leasedAt: string | null;
  releasedAt: string | null;
  /** Whether the state on disk has been checked since it was last let go. */
  verified: boolean;
  /** The approved setup this checkout last completed — the cache key (M5.7). */
  setupDigest?: string | null;
  /** Occupancy fence (v17): fresh random value per lease, rotated on
   * release — never repeats, never resets. Read by the live peek. */
  leaseEpoch?: string | null;
};

/** Permission to turn labeled GitHub issues into local unapproved proposals. */
export type IntakeGrant = {
  id: number;
  repo: string;
  /** owner/name on GitHub. */
  github: string;
  label: string;
  /** Reviewer logins whose PR comments may become revision drafts; null = none. */
  reviewers: string[] | null;
  approvedBy: string;
  approvedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
};

/** A review comment bound to the exact bytes of an immutable terminal diff. */
export type FallbackCycle = {
  id: number;
  taskRef: number;
  chainDigest: string;
  cursor: number;
  state: "open" | "sanitizing" | "awaiting-release" | "pending-admission" | "incident" | "closed";
  transitionGeneration: number;
  tailRun: number | null;
  closedReason: string | null;
};

function readFallbackCycle(row: Record<string, unknown>): FallbackCycle {
  return {
    id: Number(row["id"]),
    taskRef: Number(row["task_ref"]),
    chainDigest: String(row["chain_digest"]),
    cursor: Number(row["cursor"]),
    state: String(row["state"]) as FallbackCycle["state"],
    transitionGeneration: Number(row["transition_generation"]),
    tailRun: row["tail_run"] === null || row["tail_run"] === undefined ? null : Number(row["tail_run"]),
    closedReason: row["closed_reason"] === null || row["closed_reason"] === undefined ? null : String(row["closed_reason"]),
  };
}

export type DiffComment = {
  id: number;
  artifact: number;
  artifactSha: string;
  run: number;
  path: string | null;
  line: number | null;
  note: string;
  author: string;
  createdAt: string;
  supersededBy: number | null;
  consumedBy: string | null;
  /** `gh:<owner/name>:<id>` for ingested comments; null for the console's own. */
  sourceKey: string | null;
  /** The reviewer run that authored this comment (v29); null = a human's. */
  reviewerRun: number | null;
  /** The reviewer's weighting; null on human comments (a person's note
   * carries its own weight in its words). */
  severity: "note" | "question" | "problem" | null;
};

/** One repo's approved worktree setup — the command text, never secret values. */
export type WorktreeSetup = {
  id: number;
  repo: string;
  command: string;
  timeoutMs: number;
  digest: string;
  approvedBy: string;
  approvedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
};

/** A contestant's execution profile (v24): exact ids from the race terms,
 * effective limits from the same constants every dispatch uses. */
export function contestantProfileOf(provider: string, model: string, repairModel: string): ExecutionProfile {
  return provider === "claude"
    ? {
        provider: "claude",
        model,
        permissionArgv: "acceptEdits",
        maxTurns: CLAUDE_LIMITS.maxTurns,
        repairMaxTurns: CLAUDE_LIMITS.repairMaxTurns,
        timeoutSeconds: CLAUDE_LIMITS.timeoutSeconds,
        repairTimeoutSeconds: CLAUDE_LIMITS.repairTimeoutSeconds,
        repairModel,
      }
    : provider === "gemini"
      ? {
          // v27 (comparisons): gemini's OWN shape — before this branch a
          // gemini string would have flowed into the codex profile via
          // the fallthrough, unreachable while tournaments refused it,
          // reachable the moment comparisons admitted it.
          provider: "gemini",
          model,
          approvalArgv: "auto_edit",
          maxTurns: "unsupported",
          repairMaxTurns: "unsupported",
          timeoutSeconds: GEMINI_LIMITS.timeoutSeconds,
          repairTimeoutSeconds: GEMINI_LIMITS.repairTimeoutSeconds,
          repairModel,
        }
      : {
          provider: provider === "openrouter" ? "openrouter" : "codex",
          model,
          sandboxMode: "workspace-write",
          maxTurns: "unsupported",
          repairMaxTurns: "unsupported",
          timeoutSeconds: CODEX_SHAPED_LIMITS.timeoutSeconds,
          repairTimeoutSeconds: CODEX_SHAPED_LIMITS.repairTimeoutSeconds,
          repairModel,
        };
}

function readScope(row: Record<string, unknown>): Scope {
  return {
    taskId: String(row["task_id"]),
    goal: String(row["goal"]),
    outOfScope: row["out_of_scope"] === null ? null : String(row["out_of_scope"]),
    touches: readJsonArray(row["touches"]),
    proposedAt: String(row["proposed_at"]),
    digest: String(row["digest"]),
    budgetMicrousd: row["budget_microusd"] === null || row["budget_microusd"] === undefined ? null : Number(row["budget_microusd"]),
    approvalBasis:
      row["approval_basis"] === null || row["approval_basis"] === undefined
        ? null
        : (String(row["approval_basis"]) as "password" | "mode"),
    modeDigest: row["mode_digest"] === null || row["mode_digest"] === undefined ? null : String(row["mode_digest"]),
    approvedAt: row["approved_at"] === null ? null : String(row["approved_at"]),
    approvedBy: row["approved_by"] === null ? null : String(row["approved_by"]),
    approvedDigest: row["approved_digest"] === null ? null : String(row["approved_digest"]),
    profile: profileFromJson(row["profile_json"] === null || row["profile_json"] === undefined ? null : String(row["profile_json"])),
    profileState: row["profile_state"] === "unresolved" ? "unresolved" : "resolved",
    unresolvedReason: row["unresolved_reason"] === null || row["unresolved_reason"] === undefined ? null : String(row["unresolved_reason"]),
    approvedProfile: profileFromJson(
      row["approved_profile_json"] === null || row["approved_profile_json"] === undefined ? null : String(row["approved_profile_json"]),
    ),
    digestVersion: row["digest_version"] === undefined ? 1 : Number(row["digest_version"]),
    proposedChainJson:
      row["proposed_chain_json"] === null || row["proposed_chain_json"] === undefined ? null : String(row["proposed_chain_json"]),
    approvedChainJson:
      row["approved_chain_json"] === null || row["approved_chain_json"] === undefined ? null : String(row["approved_chain_json"]),
    approvalKind: String(row["approval_kind"] ?? "profile") === "chain" ? "chain" : "profile",
  };
}

function readRunner(row: Record<string, unknown>): Runner {
  return {
    name: String(row["name"]),
    host: String(row["host"]),
    capacity: Number(row["capacity"]),
    repos: readJsonArray(row["repos"]),
    agents: readJsonArray(row["agents"]),
    registeredAt: String(row["registered_at"]),
    heartbeatAt: String(row["heartbeat_at"]),
    retiredAt: row["retired_at"] === null ? null : String(row["retired_at"]),
    queueNote: row["queue_note"] === null || row["queue_note"] === undefined ? null : String(row["queue_note"]),
  };
}

function readWorktree(row: Record<string, unknown>): WorktreeRow {
  return {
    path: String(row["path"]),
    repo: String(row["repo"]),
    branch: String(row["branch"]),
    runner: row["runner"] === null ? null : String(row["runner"]),
    taskRef: row["task_ref"] === null ? null : Number(row["task_ref"]),
    createdAt: String(row["created_at"]),
    leasedAt: row["leased_at"] === null ? null : String(row["leased_at"]),
    releasedAt: row["released_at"] === null ? null : String(row["released_at"]),
    verified: Number(row["verified"]) === 1,
    setupDigest:
      row["setup_digest"] === null || row["setup_digest"] === undefined ? null : String(row["setup_digest"]),
    leaseEpoch: row["lease_epoch"] === null || row["lease_epoch"] === undefined ? null : String(row["lease_epoch"]),
  };
}

function readIntakeGrant(row: Record<string, unknown>): IntakeGrant {
  const reviewers = row["reviewers"];
  return {
    id: Number(row["id"]),
    repo: String(row["repo"]),
    github: String(row["github"]),
    label: String(row["label"]),
    reviewers:
      reviewers === null || reviewers === undefined || String(reviewers) === ""
        ? null
        : String(reviewers).split(",").map(one => one.trim()).filter(one => one !== ""),
    approvedBy: String(row["approved_by"]),
    approvedAt: String(row["approved_at"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
    revokedBy: row["revoked_by"] === null ? null : String(row["revoked_by"]),
  };
}

function readDiffComment(row: Record<string, unknown>): DiffComment {
  return {
    id: Number(row["id"]),
    artifact: Number(row["artifact"]),
    artifactSha: String(row["artifact_sha"]),
    run: Number(row["run"]),
    path: row["path"] === null ? null : String(row["path"]),
    line: row["line"] === null ? null : Number(row["line"]),
    note: String(row["note"]),
    author: String(row["author"]),
    createdAt: String(row["created_at"]),
    supersededBy: row["superseded_by"] === null ? null : Number(row["superseded_by"]),
    consumedBy: row["consumed_by"] === null ? null : String(row["consumed_by"]),
    sourceKey:
      row["source_key"] === null || row["source_key"] === undefined ? null : String(row["source_key"]),
    reviewerRun:
      row["reviewer_run"] === null || row["reviewer_run"] === undefined ? null : Number(row["reviewer_run"]),
    severity:
      row["severity"] === null || row["severity"] === undefined
        ? null
        : (String(row["severity"]) as DiffComment["severity"]),
  };
}

function readWorktreeSetup(row: Record<string, unknown>): WorktreeSetup {
  return {
    id: Number(row["id"]),
    repo: String(row["repo"]),
    command: String(row["command"]),
    timeoutMs: Number(row["timeout_ms"]),
    digest: String(row["digest"]),
    approvedBy: String(row["approved_by"]),
    approvedAt: String(row["approved_at"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
    revokedBy: row["revoked_by"] === null ? null : String(row["revoked_by"]),
  };
}

export type ExternalMirror = {
  localTaskId: string;
  backend: string;
  remoteRepo: string;
  remoteId: string;
  provenance: "local-create" | "intake" | "granted-all";
  intakeGrant: number | null;
  establishedBy: string;
  establishedAt: string;
  remoteState: "open" | "closed" | "missing";
  closeGeneration: number | null;
  syncGeneration: number;
  dispatchOk: boolean;
  reopenedBy: string | null;
  reopenedAt: string | null;
};

function readMirror(row: Record<string, unknown>): ExternalMirror {
  return {
    localTaskId: String(row["local_task_id"]),
    backend: String(row["backend"]),
    remoteRepo: String(row["remote_repo"]),
    remoteId: String(row["remote_id"]),
    provenance: String(row["provenance"]) as ExternalMirror["provenance"],
    intakeGrant: row["intake_grant"] === null ? null : Number(row["intake_grant"]),
    establishedBy: String(row["established_by"]),
    establishedAt: String(row["established_at"]),
    remoteState: String(row["remote_state"]) as ExternalMirror["remoteState"],
    closeGeneration: row["close_generation"] === null ? null : Number(row["close_generation"]),
    syncGeneration: Number(row["sync_generation"]),
    dispatchOk: Number(row["dispatch_ok"]) === 1,
    reopenedBy: row["reopened_by"] === null ? null : String(row["reopened_by"]),
    reopenedAt: row["reopened_at"] === null ? null : String(row["reopened_at"]),
  };
}

function readGrant(row: Record<string, unknown>): BackendGrant {
  return {
    repo: String(row["repo"]),
    backend: String(row["backend"]),
    paths: readJsonArray(row["paths"]),
    mutations: readJsonArray(row["mutations"]) as MutationClass[],
    selector: String(row["selector"]) === "all" ? "all" : "ours",
    credentialScope: row["credential_scope"] === null ? null : String(row["credential_scope"]),
    observedByGit: Number(row["observed_by_git"]) === 1,
    grantedAt: String(row["granted_at"]),
    grantedBy: String(row["granted_by"]),
    dispatch: Number(row["dispatch"] ?? 0) === 1,
    remoteRepo: row["remote_repo"] === null || row["remote_repo"] === undefined ? null : String(row["remote_repo"]),
    planeId: row["plane_id"] === null || row["plane_id"] === undefined ? null : String(row["plane_id"]),
    dispatchBlocked:
      row["dispatch_blocked"] === null || row["dispatch_blocked"] === undefined
        ? null
        : (String(row["dispatch_blocked"]) as "pending-marker" | "unreachable" | "foreign" | "missing" | "multiple-or-malformed"),
    dispatchBlockedAt: row["dispatch_blocked_at"] === null || row["dispatch_blocked_at"] === undefined ? null : String(row["dispatch_blocked_at"]),
    dispatchBlockedDetail:
      row["dispatch_blocked_detail"] === null || row["dispatch_blocked_detail"] === undefined ? null : String(row["dispatch_blocked_detail"]),
  };
}

function readJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A steering author the plane VERIFIED (ruling 11): constructible only by
 * the two authenticated callers — the console's cookie session (who.name)
 * and the CLI's password ceremony. The brand makes "just pass a string"
 * a compile error, which is the whole point: the OPERATOR STEERING fence
 * in briefs is reachable by no unverified road.
 */
export type VerifiedAuthor = string & { readonly __verifiedAuthor: unique symbol };
export function verifiedAuthor(name: string): VerifiedAuthor {
  return name as VerifiedAuthor;
}
