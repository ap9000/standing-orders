/**
 * Inherited review context (v51, contract handoff task 3): the bounded,
 * sealed source-and-ancestry inventory a REVISION's reviewer is shown
 * beside the revision's own patch.
 *
 * A small revision to a larger feature carries the whole feature's signed
 * rubric, but its terminal diff shows only what the revision touched — so
 * an honest reviewer could only say `cannot-tell` about every criterion
 * the earlier build implemented (run 1518 said exactly that three times,
 * although run 1514 had upheld those same criteria on the base). This
 * module closes that gap WITHOUT letting a reviewer read a checkout:
 *
 *  - Every item is a file read from the git object database BY EXACT
 *    COMMIT (the revision's sealed head) and literal path — `ls-tree` for
 *    identity and size, `cat-file blob` for bytes — with lazy fetch,
 *    replace refs, filters, textconv, and diff drivers all out of the
 *    picture. The working tree is never read: a checkout is mutable, a
 *    blob at a commit is not.
 *  - Which paths are relevant comes from VERIFIED ancestor artifacts: the
 *    source run's sealed proof (its changed paths and the changed-path
 *    evidence it cited per criterion) and its sealed diff-stat. Every item
 *    binds to the source run, the commit, the path, the blob id, and a
 *    SHA-256 of the stored bytes.
 *  - Bounds are explicit and honest: an oversized, binary, non-UTF-8,
 *    missing, non-file, or over-aggregate path is a NAMED GAP, never a
 *    truncated item; a secret-shaped line is redacted before the bytes
 *    become durable, and the redaction is a gap too.
 *  - An earlier reviewer's judgement on the source run is CONTEXT ONLY.
 *    It is exposed as `priorReview` with its own eligibility proof — same
 *    criterion text, verified ancestry, relevant code byte-identical
 *    between the source head and this head, the source review's own
 *    bindings intact — and never as an automatic judgement for this run.
 *
 * `coverage` is the per-criterion projection every surface reads: `patch`
 * (judged from this revision's own diff), `context` (inherited, untouched
 * by the patch, every relevant path sealed here), or `gap` (inherited but
 * some relevant context could not be supplied — the reasons are listed).
 */

import { createHash } from "node:crypto";
import { hasForbiddenControls } from "./decision.js";
import type { ExecResult } from "./exec.js";
import { EVIDENCE_CAPS, readVerifiedArtifact, redactSecretLines, scanForSecrets, storeEvidence } from "./evidence.js";
import { parseProof, type ApprovedCriterion, type CriterionJudgementWord, type ParsedProof } from "./proof.js";
import type { Artifact, Store } from "./store.js";

/** Explicit bounds. Content bytes are UTF-8 of the stored (possibly
 * redacted) text; the aggregate is the sum over every stored item. */
export const REVIEW_CONTEXT_LIMITS = {
  /** One source file's stored bytes. Larger files are a named gap. */
  itemBytes: 48 * 1024,
  /** Every item's bytes together. Whatever would cross it is a named gap. */
  aggregateBytes: 192 * 1024,
  /** Items stored, in deterministic relevance order. */
  items: 24,
  /** Candidate paths considered from the source proof and diff-stat. */
  candidatePaths: 200,
  /** Prior review rows carried as context. */
  priorReviews: 48,
} as const;

export type ContextGapReason =
  | "source-missing"
  | "source-unverified"
  | "source-proof-missing"
  | "source-scope-changed"
  | "criterion-changed"
  | "stale-ancestry"
  | "missing-at-head"
  | "not-a-file"
  | "binary"
  | "over-limit"
  | "aggregate-limit"
  | "item-cap"
  | "secret-redacted"
  | "capture-failed";

export type ContextItemWhy = "source-criterion-evidence" | "source-changed-path";

export type ReviewContextItem = {
  /** `ctx-<n>`: the provenance token a reviewer cites in its notes. */
  id: string;
  path: string;
  /** The exact commit the blob was read at — this run's sealed head. */
  commit: string;
  /** The git blob id at that commit and path. */
  blob: string;
  /** SHA-256 of `content` exactly as stored (after any redaction). */
  sha256: string;
  bytes: number;
  content: string;
  /** The ancestor run whose verified artifacts made this path relevant. */
  sourceRun: number;
  /** Signed criterion ids this path is relevant to. */
  criteria: string[];
  why: ContextItemWhy[];
  /** Whether the blob is byte-identical at the source run's head. null
   * when ancestry could not be verified, so nothing is claimed. */
  unchangedSinceSource: boolean | null;
  redacted: boolean;
};

export type ReviewContextGap = {
  reason: ContextGapReason;
  path: string | null;
  criteria: string[];
  detail: string;
};

export type PriorReviewSupport = {
  criterionId: string;
  sourceRun: number;
  reviewerRun: number;
  author: string;
  judgement: CriterionJudgementWord;
  note: string;
  statementMatches: boolean;
  ancestryVerified: boolean;
  relevantPaths: string[];
  relevantUnchanged: boolean;
  bindingsVerified: boolean;
  /** `eligible` = every proof above holds, so the reviewer may weigh it;
   * `invalid` = at least one failed, and the reasons say which. Neither
   * is a judgement on THIS run. */
  support: "eligible" | "invalid";
  reasons: string[];
};

export type CriterionContextCoverage = {
  id: string;
  /** `patch`: judged from this revision's own diff (a criterion new to this
   * rubric, or one whose relevant code the patch touches). `context`:
   * inherited, untouched by the patch, every relevant path sealed as an
   * item. `gap`: inherited, untouched, and some relevant context is
   * missing — see `gaps`. */
  state: "patch" | "context" | "gap";
  /** Same id AND same statement as the source run's signed rubric. */
  inherited: boolean;
  paths: string[];
  items: string[];
  gaps: string[];
  priorSupport: "eligible" | "invalid" | "none";
};

export type ReviewContextInventory = {
  schema: 1;
  run: number;
  head: string;
  base: string | null;
  source: {
    task: string;
    run: number;
    head: string | null;
    scopeDigest: string | null;
    /** The source run's sealed proof AND diff-stat both verified. */
    verified: boolean;
    problems: string[];
  };
  ancestry: { verified: boolean; detail: string };
  items: ReviewContextItem[];
  gaps: ReviewContextGap[];
  priorReview: PriorReviewSupport[];
  coverage: CriterionContextCoverage[];
  limits: { itemBytes: number; aggregateBytes: number; items: number };
};

const SHA1 = /^[0-9a-f]{40}$/;
const ITEM_ID = /^ctx-[1-9][0-9]{0,3}$/;

/** A candidate path the object reader will accept on argv: repository-
 * relative, no `..` or `.` segments, no leading dash, no control bytes. */
export function safeContextPath(path: string): boolean {
  if (path.length === 0 || path.length > 300 || path.startsWith("-") || path.startsWith("/") || path.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

export function serializeReviewContext(inventory: ReviewContextInventory): string {
  return JSON.stringify(inventory, null, 1);
}

/**
 * The strict reader every consumer uses (the reviewer pass, the surfaces,
 * the tests): shape, bounds, unique ids, and every item's SHA-256
 * recomputed from its content. What this refuses, nothing shows.
 */
export function parseReviewContext(raw: string): { ok: true; inventory: ReviewContextInventory } | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problem: "not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, problem: "not an object" };
  const r = parsed as Record<string, unknown>;
  const str = (value: unknown, max = 2000): value is string => typeof value === "string" && value.length <= max && !hasForbiddenControls(value);
  const strList = (value: unknown, max = 64): value is string[] => Array.isArray(value) && value.length <= max && value.every(one => str(one, 300));
  const optionalStr = (value: unknown, max = 2000): value is string | null => value === null || str(value, max);
  if (r["schema"] !== 1) return { ok: false, problem: "schema must be 1" };
  if (!Number.isSafeInteger(r["run"]) || Number(r["run"]) <= 0) return { ok: false, problem: "run must be a positive integer" };
  if (!str(r["head"], 40) || !SHA1.test(r["head"])) return { ok: false, problem: "head must be a 40-hex commit" };
  if (!optionalStr(r["base"], 40)) return { ok: false, problem: "base must be a string or null" };
  const source = r["source"];
  if (source === null || typeof source !== "object" || Array.isArray(source)) return { ok: false, problem: "source must be an object" };
  const so = source as Record<string, unknown>;
  if (!str(so["task"], 200) || !Number.isSafeInteger(so["run"]) || !optionalStr(so["head"], 40) || !optionalStr(so["scopeDigest"], 200) || typeof so["verified"] !== "boolean" || !strList(so["problems"], 16)) {
    return { ok: false, problem: "source is malformed" };
  }
  const ancestry = r["ancestry"];
  if (ancestry === null || typeof ancestry !== "object" || Array.isArray(ancestry)) return { ok: false, problem: "ancestry must be an object" };
  const an = ancestry as Record<string, unknown>;
  if (typeof an["verified"] !== "boolean" || !str(an["detail"], 500)) return { ok: false, problem: "ancestry is malformed" };
  const limits = r["limits"];
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) return { ok: false, problem: "limits must be an object" };
  const li = limits as Record<string, unknown>;
  if (![li["itemBytes"], li["aggregateBytes"], li["items"]].every(one => Number.isSafeInteger(one) && Number(one) > 0)) return { ok: false, problem: "limits are malformed" };

  const items: ReviewContextItem[] = [];
  if (!Array.isArray(r["items"]) || r["items"].length > REVIEW_CONTEXT_LIMITS.items) return { ok: false, problem: `items must be an array of at most ${REVIEW_CONTEXT_LIMITS.items}` };
  const ids = new Set<string>();
  let aggregate = 0;
  for (const [index, one] of (r["items"] as unknown[]).entries()) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) return { ok: false, problem: `item ${index}: not an object` };
    const it = one as Record<string, unknown>;
    if (!str(it["id"], 12) || !ITEM_ID.test(it["id"]) || ids.has(it["id"])) return { ok: false, problem: `item ${index}: id must be a unique ctx-<n> token` };
    if (!str(it["path"], 300) || !safeContextPath(it["path"])) return { ok: false, problem: `item ${index}: path is not a safe repository path` };
    if (!str(it["commit"], 40) || !SHA1.test(it["commit"])) return { ok: false, problem: `item ${index}: commit must be a 40-hex commit` };
    if (!str(it["blob"], 40) || !SHA1.test(it["blob"])) return { ok: false, problem: `item ${index}: blob must be a 40-hex object id` };
    if (typeof it["content"] !== "string" || it["content"].includes("\u0000")) return { ok: false, problem: `item ${index}: content must be a NUL-free string` };
    const bytes = Buffer.byteLength(it["content"], "utf8");
    if (bytes > REVIEW_CONTEXT_LIMITS.itemBytes || it["bytes"] !== bytes) return { ok: false, problem: `item ${index}: bytes must equal the content's UTF-8 length and fit the item limit` };
    aggregate += bytes;
    if (aggregate > REVIEW_CONTEXT_LIMITS.aggregateBytes) return { ok: false, problem: "items exceed the aggregate content limit" };
    const sha256 = createHash("sha256").update(it["content"], "utf8").digest("hex");
    if (it["sha256"] !== sha256) return { ok: false, problem: `item ${index}: sha256 does not match its content` };
    if (!Number.isSafeInteger(it["sourceRun"]) || Number(it["sourceRun"]) <= 0) return { ok: false, problem: `item ${index}: sourceRun must be a positive integer` };
    if (!strList(it["criteria"], 12)) return { ok: false, problem: `item ${index}: criteria must be a list of ids` };
    if (!Array.isArray(it["why"]) || it["why"].length === 0 || it["why"].length > 2 || !it["why"].every(w => w === "source-criterion-evidence" || w === "source-changed-path")) {
      return { ok: false, problem: `item ${index}: why must name how the path became relevant` };
    }
    if (it["unchangedSinceSource"] !== null && typeof it["unchangedSinceSource"] !== "boolean") return { ok: false, problem: `item ${index}: unchangedSinceSource must be boolean or null` };
    if (typeof it["redacted"] !== "boolean") return { ok: false, problem: `item ${index}: redacted must be boolean` };
    ids.add(it["id"]);
    items.push({
      id: it["id"],
      path: it["path"],
      commit: it["commit"],
      blob: it["blob"],
      sha256,
      bytes,
      content: it["content"],
      sourceRun: Number(it["sourceRun"]),
      criteria: [...(it["criteria"] as string[])],
      why: [...(it["why"] as ContextItemWhy[])],
      unchangedSinceSource: it["unchangedSinceSource"] as boolean | null,
      redacted: it["redacted"],
    });
  }

  const gaps: ReviewContextGap[] = [];
  if (!Array.isArray(r["gaps"]) || r["gaps"].length > 400) return { ok: false, problem: "gaps must be a bounded array" };
  const GAP_REASONS = new Set<string>([
    "source-missing", "source-unverified", "source-proof-missing", "source-scope-changed", "criterion-changed", "stale-ancestry",
    "missing-at-head", "not-a-file", "binary", "over-limit", "aggregate-limit", "item-cap", "secret-redacted", "capture-failed",
  ]);
  for (const [index, one] of (r["gaps"] as unknown[]).entries()) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) return { ok: false, problem: `gap ${index}: not an object` };
    const g = one as Record<string, unknown>;
    if (!str(g["reason"], 40) || !GAP_REASONS.has(g["reason"]) || !optionalStr(g["path"], 300) || !strList(g["criteria"], 12) || !str(g["detail"], 500)) {
      return { ok: false, problem: `gap ${index}: malformed` };
    }
    gaps.push({ reason: g["reason"] as ContextGapReason, path: g["path"], criteria: [...(g["criteria"] as string[])], detail: g["detail"] });
  }

  const priorReview: PriorReviewSupport[] = [];
  if (!Array.isArray(r["priorReview"]) || r["priorReview"].length > REVIEW_CONTEXT_LIMITS.priorReviews) return { ok: false, problem: "priorReview must be a bounded array" };
  for (const [index, one] of (r["priorReview"] as unknown[]).entries()) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) return { ok: false, problem: `priorReview ${index}: not an object` };
    const p = one as Record<string, unknown>;
    if (
      !str(p["criterionId"], 64) || !Number.isSafeInteger(p["sourceRun"]) || !Number.isSafeInteger(p["reviewerRun"]) || !str(p["author"], 200) ||
      (p["judgement"] !== "upholds" && p["judgement"] !== "contradicts" && p["judgement"] !== "cannot-tell") || !str(p["note"], 500) ||
      typeof p["statementMatches"] !== "boolean" || typeof p["ancestryVerified"] !== "boolean" || !strList(p["relevantPaths"], 200) ||
      typeof p["relevantUnchanged"] !== "boolean" || typeof p["bindingsVerified"] !== "boolean" ||
      (p["support"] !== "eligible" && p["support"] !== "invalid") || !strList(p["reasons"], 16)
    ) {
      return { ok: false, problem: `priorReview ${index}: malformed` };
    }
    if (p["support"] === "eligible" && !(p["statementMatches"] && p["ancestryVerified"] && p["relevantUnchanged"] && p["bindingsVerified"])) {
      return { ok: false, problem: `priorReview ${index}: claims eligibility without every proof` };
    }
    priorReview.push({
      criterionId: p["criterionId"], sourceRun: Number(p["sourceRun"]), reviewerRun: Number(p["reviewerRun"]), author: p["author"],
      judgement: p["judgement"] as CriterionJudgementWord, note: p["note"], statementMatches: p["statementMatches"], ancestryVerified: p["ancestryVerified"],
      relevantPaths: [...(p["relevantPaths"] as string[])], relevantUnchanged: p["relevantUnchanged"], bindingsVerified: p["bindingsVerified"],
      support: p["support"] as "eligible" | "invalid", reasons: [...(p["reasons"] as string[])],
    });
  }

  const coverage: CriterionContextCoverage[] = [];
  if (!Array.isArray(r["coverage"]) || r["coverage"].length > 12) return { ok: false, problem: "coverage must be a bounded array" };
  const coverageIds = new Set<string>();
  for (const [index, one] of (r["coverage"] as unknown[]).entries()) {
    if (one === null || typeof one !== "object" || Array.isArray(one)) return { ok: false, problem: `coverage ${index}: not an object` };
    const c = one as Record<string, unknown>;
    if (
      !str(c["id"], 64) || coverageIds.has(c["id"]) || (c["state"] !== "patch" && c["state"] !== "context" && c["state"] !== "gap") ||
      typeof c["inherited"] !== "boolean" || !strList(c["paths"], 200) || !strList(c["items"], 64) || !strList(c["gaps"], 64) ||
      (c["priorSupport"] !== "eligible" && c["priorSupport"] !== "invalid" && c["priorSupport"] !== "none")
    ) {
      return { ok: false, problem: `coverage ${index}: malformed` };
    }
    if ((c["items"] as string[]).some(id => !ids.has(id))) return { ok: false, problem: `coverage ${index}: names an item that is not in the inventory` };
    coverageIds.add(c["id"]);
    coverage.push({
      id: c["id"], state: c["state"] as CriterionContextCoverage["state"], inherited: c["inherited"], paths: [...(c["paths"] as string[])],
      items: [...(c["items"] as string[])], gaps: [...(c["gaps"] as string[])], priorSupport: c["priorSupport"] as CriterionContextCoverage["priorSupport"],
    });
  }

  return {
    ok: true,
    inventory: {
      schema: 1,
      run: Number(r["run"]),
      head: r["head"],
      base: r["base"],
      source: { task: so["task"], run: Number(so["run"]), head: so["head"], scopeDigest: so["scopeDigest"], verified: so["verified"], problems: [...(so["problems"] as string[])] },
      ancestry: { verified: an["verified"], detail: an["detail"] },
      items,
      gaps,
      priorReview,
      coverage,
      limits: { itemBytes: Number(li["itemBytes"]), aggregateBytes: Number(li["aggregateBytes"]), items: Number(li["items"]) },
    },
  };
}

/** What the reviewer's parser needs from an inventory: the provenance
 * tokens a note may cite, and the criteria whose judgement must cite one —
 * every criterion NOT judged from the patch alone. */
export function reviewContextRules(inventory: ReviewContextInventory): { itemIds: ReadonlySet<string>; provenanceRequired: ReadonlySet<string> } {
  return {
    itemIds: new Set(inventory.items.map(one => one.id)),
    provenanceRequired: new Set(inventory.coverage.filter(one => one.state !== "patch").map(one => one.id)),
  };
}

/** Whether a reviewer's note cites supplied provenance: a `ctx-<n>` item
 * id from the inventory, a path the patch names, or a sealed file name. */
export function citesSuppliedProvenance(
  note: string,
  supplied: { itemIds: ReadonlySet<string>; patchPaths: ReadonlySet<string>; sealedFiles: ReadonlySet<string> },
): boolean {
  for (const token of note.match(/ctx-[0-9]{1,4}/g) ?? []) if (supplied.itemIds.has(token)) return true;
  for (const path of supplied.patchPaths) if (path.length > 0 && note.includes(path)) return true;
  for (const file of supplied.sealedFiles) if (note.includes(file)) return true;
  return false;
}

type GitRunner = (file: string, args: readonly string[], options?: { cwd?: string; maxBuffer?: number }) => Promise<ExecResult>;

const GIT_READ = ["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks"] as const;

/** One `ls-tree -l` entry: mode, type, object id, size (null for gitlinks). */
type TreeEntry = { mode: string; type: string; object: string; size: number | null };

async function treeEntries(git: GitRunner, cwd: string, revision: string, paths: readonly string[]): Promise<Map<string, TreeEntry> | null> {
  if (paths.length === 0) return new Map();
  const listed = await git("git", [...GIT_READ, "ls-tree", "-z", "-l", revision, "--", ...paths], { cwd, maxBuffer: 4 * 1024 * 1024 });
  if (listed.code !== 0) return null;
  const entries = new Map<string, TreeEntry>();
  for (const record of listed.stdout.split("\u0000")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object, sizeText] = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    if (mode === undefined || type === undefined || object === undefined || sizeText === undefined) continue;
    entries.set(path, { mode, type, object, size: sizeText === "-" ? null : Number(sizeText) });
  }
  return entries;
}

export type CaptureReviewContextArgs = {
  runId: number;
  taskRef: number;
  /** This run's sealed head — the exact commit every item is read at. */
  head: string;
  base: string | null;
  /** The signed rubric this run built against, in id order. */
  rubric: readonly ApprovedCriterion[];
  /** Paths this run's own sealed diff-stat names (empty when unknown). */
  patchPaths: ReadonlySet<string>;
  worktree: string;
  root: string;
  now: () => Date;
};

/**
 * Capture and store the inventory for a revision run. Returns null — and
 * stores nothing — when the task is not a revision: an ordinary run's
 * reviewer keeps exactly the inputs it always had. Every other outcome
 * stores a parseable inventory; problems become gaps in it, never a
 * missing or truncated file.
 */
export async function captureReviewContext(
  store: Store,
  git: GitRunner,
  args: CaptureReviewContextArgs,
): Promise<{ inventory: ReviewContextInventory; artifactId: number } | null> {
  const lineage = store.revisionSourceOf(args.taskRef);
  if (lineage === null) return null;
  const inventory = await deriveReviewContext(store, git, args, lineage);
  let encoded = serializeReviewContext(inventory);
  if (Buffer.byteLength(encoded, "utf8") > EVIDENCE_CAPS["review-context"]) {
    // Unreachable under the content limits, but a structured artifact is
    // never byte-truncated: shed every item and say so.
    const stripped: ReviewContextInventory = {
      ...inventory,
      items: [],
      gaps: [...inventory.gaps, { reason: "over-limit", path: null, criteria: inventory.coverage.map(one => one.id), detail: "the encoded inventory exceeded its evidence cap — every item was shed" }],
      coverage: inventory.coverage.map(one => ({ ...one, state: one.state === "patch" ? "patch" : "gap", items: [], gaps: [...one.gaps, "the encoded inventory exceeded its evidence cap"] })),
      priorReview: inventory.priorReview.map(one => ({ ...one, support: "invalid", relevantUnchanged: false, reasons: [...one.reasons, "the inventory was shed"] })),
    };
    encoded = serializeReviewContext(stripped);
    const artifactId = storeEvidence(store, args.root, args.runId, "review-context", "review-context.json", Buffer.from(encoded, "utf8"), `machine-captured review context at ${args.head} (shed, exit 0)`, args.now(), { captureStatus: "ok" });
    return { inventory: stripped, artifactId };
  }
  const artifactId = storeEvidence(store, args.root, args.runId, "review-context", "review-context.json", Buffer.from(encoded, "utf8"), `machine-captured review context at ${args.head} (exit 0)`, args.now(), {
    captureStatus: "ok",
    redacted: inventory.items.some(one => one.redacted),
  });
  return { inventory, artifactId };
}

/**
 * The derivation, separated from storage so a test can hold the inventory
 * against a real repository without an evidence root.
 */
export async function deriveReviewContext(
  store: Store,
  git: GitRunner,
  args: CaptureReviewContextArgs,
  lineage: { sourceTask: string; sourceRun: number },
): Promise<ReviewContextInventory> {
  const gaps: ReviewContextGap[] = [];
  const allIds = args.rubric.map(one => one.id);
  const sourceRun = store.getRun(lineage.sourceRun);
  const sourceProblems: string[] = [];
  const inventory: ReviewContextInventory = {
    schema: 1,
    run: args.runId,
    head: args.head,
    base: args.base,
    source: { task: lineage.sourceTask, run: lineage.sourceRun, head: sourceRun?.headRevision ?? null, scopeDigest: sourceRun?.scopeDigest ?? null, verified: false, problems: sourceProblems },
    ancestry: { verified: false, detail: "not checked" },
    items: [],
    gaps,
    priorReview: [],
    coverage: [],
    limits: { itemBytes: REVIEW_CONTEXT_LIMITS.itemBytes, aggregateBytes: REVIEW_CONTEXT_LIMITS.aggregateBytes, items: REVIEW_CONTEXT_LIMITS.items },
  };
  const finish = (coverage: CriterionContextCoverage[]): ReviewContextInventory => ({ ...inventory, coverage });
  const gapAll = (reason: ContextGapReason, detail: string): void => {
    gaps.push({ reason, path: null, criteria: allIds, detail });
  };
  const patchOnly = (id: string, inherited: boolean, extra: string[] = []): CriterionContextCoverage => ({
    id, state: "patch", inherited, paths: [], items: [], gaps: extra, priorSupport: "none",
  });

  // 1. The source run and its VERIFIED artifacts.
  if (sourceRun === null) {
    gapAll("source-missing", `source run #${lineage.sourceRun} does not exist — no inherited context can be supplied`);
    return finish(allIds.map(id => ({ ...patchOnly(id, false), state: "gap", gaps: [`source run #${lineage.sourceRun} does not exist`] })));
  }
  const sourceHead = sourceRun.headRevision !== null && SHA1.test(sourceRun.headRevision) ? sourceRun.headRevision : null;
  if (sourceHead === null) sourceProblems.push("the source run has no sealed 40-hex head");
  const sourceArtifacts = store.artifactsFor(sourceRun.id);
  const verifiedOne = (kind: Artifact["kind"], label: string): Buffer | null => {
    const found = sourceArtifacts.filter(one => one.kind === kind);
    if (found.length !== 1) {
      sourceProblems.push(found.length === 0 ? `the source run has no sealed ${label}` : `the source run carries ${found.length} ${label} artifacts — ambiguous`);
      return null;
    }
    const artifact = found[0]!;
    if (artifact.captureStatus === "failed" || artifact.truncated) {
      sourceProblems.push(`the source run's ${label} is ${artifact.truncated ? "truncated" : "a failed capture"}`);
      return null;
    }
    let verified: ReturnType<typeof readVerifiedArtifact>;
    try {
      verified = readVerifiedArtifact(args.root, artifact);
    } catch {
      verified = { ok: false, problem: "the file could not be read" };
    }
    if (!verified.ok) {
      sourceProblems.push(`the source run's ${label} no longer verifies (${verified.problem})`);
      return null;
    }
    return verified.content;
  };
  const proofBytes = verifiedOne("proof", "proof");
  let sourceProof: ParsedProof | null = null;
  if (proofBytes !== null) {
    const parsed = parseProof(proofBytes.toString("utf8"));
    if (parsed.ok) sourceProof = parsed.proof;
    else sourceProblems.push("the source run's proof is not a proof this build can read");
  }
  const statBytes = verifiedOne("diff-stat", "diff-stat");
  let sourceDiffPaths: string[] | null = null;
  if (statBytes !== null) {
    try {
      const stat = JSON.parse(statBytes.toString("utf8")) as { filesTruncated?: unknown; files?: { path?: unknown }[] };
      if (stat.filesTruncated === true) sourceProblems.push("the source run's diff-stat file list is truncated");
      else sourceDiffPaths = (stat.files ?? []).map(one => String(one.path ?? "")).filter(one => one !== "");
    } catch {
      sourceProblems.push("the source run's diff-stat is not JSON");
    }
  }
  const sourceDiffOk = sourceArtifacts.some(one => one.kind === "terminal-diff" && one.captureStatus !== "failed" && !one.truncated);
  if (!sourceDiffOk) sourceProblems.push("the source run has no complete sealed terminal diff");
  inventory.source.verified = sourceProof !== null && sourceDiffPaths !== null && sourceDiffOk && sourceHead !== null;

  // 2. The source rubric: only the exact scope the source run built under
  // (its digest still live on the source task) can say what a criterion
  // meant then. A moved scope is a gap for every criterion.
  const sourceTaskId = store.externalIdFor(sourceRun.taskRef);
  const sourceScope = sourceTaskId === null ? null : store.getScope(sourceTaskId);
  const sourceScopeVerified = sourceRun.scopeDigest !== null && sourceScope !== null && sourceScope.digest === sourceRun.scopeDigest;
  if (!sourceScopeVerified) {
    gapAll("source-scope-changed", sourceRun.scopeDigest === null ? "the source run built under no signed scope — no criterion can be matched to it" : "the source task's scope no longer carries the digest the source run built under — its criteria cannot be matched");
  }
  const sourceCriteria = new Map((sourceScopeVerified ? sourceScope!.acceptance : []).map(one => [one.id, one] as const));

  // 3. Ancestry: is the source head an ancestor of this head?
  if (sourceHead !== null) {
    const check = await git("git", [...GIT_READ, "merge-base", "--is-ancestor", sourceHead, args.head], { cwd: args.worktree });
    if (check.code === 0) inventory.ancestry = { verified: true, detail: `${sourceHead} is an ancestor of ${args.head}` };
    else if (check.code === 1) {
      inventory.ancestry = { verified: false, detail: `${sourceHead} is not an ancestor of ${args.head} — the source work is not in this history` };
      gapAll("stale-ancestry", inventory.ancestry.detail);
    } else {
      inventory.ancestry = { verified: false, detail: `ancestry could not be checked (git exit ${check.code})` };
      gapAll("capture-failed", inventory.ancestry.detail);
    }
  } else {
    inventory.ancestry = { verified: false, detail: "the source run has no sealed head to check ancestry against" };
    gapAll("source-unverified", inventory.ancestry.detail);
  }
  if (sourceProof === null) gapAll("source-proof-missing", sourceProblems.find(one => one.includes("proof")) ?? "the source run's proof is unavailable");
  else if (!inventory.source.verified) gapAll("source-unverified", sourceProblems.join("; "));

  // 4. Relevance: which paths matter to which criterion, from the source
  // proof only — criterion-cited changed paths first, then every changed
  // path of the source build for criteria that cited none.
  const generalPaths = [...new Set([...(sourceProof?.changed ?? []), ...(sourceDiffPaths ?? [])])].filter(safeContextPath).sort();
  const specificFor = new Map<string, string[]>();
  for (const criterion of sourceProof?.criteria ?? []) {
    const cited = [...new Set(criterion.evidence.filter(one => one.kind === "changed-path").map(one => one.ref))].filter(safeContextPath).sort();
    if (cited.length > 0) specificFor.set(criterion.id, cited);
  }
  type Plan = { id: string; knownInSource: boolean; inherited: boolean; paths: string[]; changedText: boolean };
  const plans: Plan[] = args.rubric.map(criterion => {
    const inSource = sourceCriteria.get(criterion.id);
    const knownInSource = inSource !== undefined;
    const inherited = knownInSource && inSource.statement.trim() === criterion.statement.trim();
    if (knownInSource && !inherited) {
      gaps.push({ reason: "criterion-changed", path: null, criteria: [criterion.id], detail: `criterion "${criterion.id}" reads differently now than in the source run's signed rubric — its earlier judgement cannot support it` });
    }
    const paths = knownInSource ? (specificFor.get(criterion.id) ?? generalPaths) : [];
    return { id: criterion.id, knownInSource, inherited, paths, changedText: knownInSource && !inherited };
  });
  const relevance = new Map<string, { criteria: Set<string>; why: Set<ContextItemWhy> }>();
  for (const plan of plans) {
    for (const path of plan.paths) {
      const entry = relevance.get(path) ?? { criteria: new Set(), why: new Set() };
      entry.criteria.add(plan.id);
      entry.why.add(specificFor.get(plan.id)?.includes(path) ? "source-criterion-evidence" : "source-changed-path");
      relevance.set(path, entry);
    }
  }
  const candidates = [...relevance.keys()].sort((a, b) => {
    const aSpecific = relevance.get(a)!.why.has("source-criterion-evidence") ? 0 : 1;
    const bSpecific = relevance.get(b)!.why.has("source-criterion-evidence") ? 0 : 1;
    return aSpecific !== bSpecific ? aSpecific - bSpecific : a.localeCompare(b);
  });
  if (candidates.length > REVIEW_CONTEXT_LIMITS.candidatePaths) {
    for (const path of candidates.slice(REVIEW_CONTEXT_LIMITS.candidatePaths)) {
      gaps.push({ reason: "item-cap", path, criteria: [...relevance.get(path)!.criteria].sort(), detail: `${path}: beyond the ${REVIEW_CONTEXT_LIMITS.candidatePaths} candidate-path bound` });
    }
    candidates.length = REVIEW_CONTEXT_LIMITS.candidatePaths;
  }

  // 5. Read every candidate at the EXACT head — identity and size first,
  // bytes only for what the bounds admit — and compare identity at the
  // source head when ancestry verified.
  const itemsByPath = new Map<string, ReviewContextItem>();
  if (candidates.length > 0) {
    const atHead = await treeEntries(git, args.worktree, args.head, candidates);
    const atSource = inventory.ancestry.verified && sourceHead !== null ? await treeEntries(git, args.worktree, sourceHead, candidates) : null;
    if (atHead === null) {
      gapAll("capture-failed", `the tree at ${args.head} could not be listed`);
    } else {
      let aggregate = 0;
      for (const path of candidates) {
        const criteria = [...relevance.get(path)!.criteria].sort();
        const why = [...relevance.get(path)!.why].sort() as ContextItemWhy[];
        const entry = atHead.get(path);
        const gap = (reason: ContextGapReason, detail: string): void => { gaps.push({ reason, path, criteria, detail: `${path}: ${detail}` }); };
        if (entry === undefined) { gap("missing-at-head", `no object at ${args.head}`); continue; }
        if (entry.type !== "blob" || entry.mode === "120000" || entry.size === null) { gap("not-a-file", `a ${entry.mode === "120000" ? "symlink" : entry.type} at ${args.head}, not a regular file`); continue; }
        if (entry.size > REVIEW_CONTEXT_LIMITS.itemBytes) { gap("over-limit", `${entry.size} bytes at ${args.head} exceeds the ${REVIEW_CONTEXT_LIMITS.itemBytes}-byte item limit`); continue; }
        if (itemsByPath.size >= REVIEW_CONTEXT_LIMITS.items) { gap("item-cap", `beyond the ${REVIEW_CONTEXT_LIMITS.items}-item bound`); continue; }
        if (aggregate + entry.size > REVIEW_CONTEXT_LIMITS.aggregateBytes) { gap("aggregate-limit", `${entry.size} bytes would cross the ${REVIEW_CONTEXT_LIMITS.aggregateBytes}-byte aggregate limit`); continue; }
        const read = await git("git", [...GIT_READ, "cat-file", "blob", entry.object], { cwd: args.worktree, maxBuffer: REVIEW_CONTEXT_LIMITS.itemBytes + 4096 });
        if (read.code !== 0) { gap("capture-failed", `blob ${entry.object} could not be read (git exit ${read.code})`); continue; }
        if (read.stdout.includes("\u0000") || read.stdout.includes("\uFFFD") || Buffer.byteLength(read.stdout, "utf8") !== entry.size) { gap("binary", "not UTF-8 text"); continue; }
        const hits = scanForSecrets(read.stdout);
        const content = hits.length > 0 ? redactSecretLines(read.stdout, hits) : read.stdout;
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > REVIEW_CONTEXT_LIMITS.itemBytes || aggregate + bytes > REVIEW_CONTEXT_LIMITS.aggregateBytes) { gap("over-limit", "redaction did not fit the bounds"); continue; }
        if (hits.length > 0) gap("secret-redacted", `${hits.length} secret-shaped line(s) redacted before storage — the redacted lines cannot support any criterion`);
        aggregate += bytes;
        const sourceEntry = atSource?.get(path);
        itemsByPath.set(path, {
          id: `ctx-${itemsByPath.size + 1}`,
          path,
          commit: args.head,
          blob: entry.object,
          sha256: createHash("sha256").update(content, "utf8").digest("hex"),
          bytes,
          content,
          sourceRun: sourceRun.id,
          criteria,
          why,
          unchangedSinceSource: atSource === null ? null : sourceEntry !== undefined && sourceEntry.object === entry.object,
          redacted: hits.length > 0,
        });
      }
    }
  }
  inventory.items = [...itemsByPath.values()];

  // 6. Prior review provenance — context, proved per criterion, never a verdict.
  const sourceDiff = sourceArtifacts.find(one => one.kind === "terminal-diff") ?? null;
  const sourceProofArtifact = sourceArtifacts.find(one => one.kind === "proof") ?? null;
  const planOf = new Map(plans.map(one => [one.id, one] as const));
  for (const row of store.criterionReviewsFor(sourceRun.id).slice(0, REVIEW_CONTEXT_LIMITS.priorReviews)) {
    const plan = planOf.get(row.criterionId);
    if (plan === undefined || !plan.knownInSource) continue;
    const reasons: string[] = [];
    if (!plan.inherited) reasons.push("the criterion's signed text changed since the source review");
    if (!inventory.ancestry.verified) reasons.push("the source head is not verified ancestry of this head");
    if (!inventory.source.verified) reasons.push("the source run's sealed artifacts do not all verify");
    const relevantUnchanged = plan.paths.length > 0 && plan.paths.every(path => itemsByPath.get(path)?.unchangedSinceSource === true);
    if (!relevantUnchanged) reasons.push(plan.paths.length === 0 ? "no relevant source paths are known for this criterion" : "relevant code is not byte-identical between the source head and this head, or could not be sealed");
    const bindingsVerified =
      row.headSha === sourceHead &&
      row.scopeDigest === sourceRun.scopeDigest &&
      sourceDiff !== null && row.artifact === sourceDiff.id && row.artifactSha === sourceDiff.sha256 &&
      (row.proof === null ? sourceProofArtifact === null : sourceProofArtifact !== null && row.proof.artifact === sourceProofArtifact.id && row.proof.sha256 === sourceProofArtifact.sha256);
    if (!bindingsVerified) reasons.push("the source review's own evidence bindings no longer match the source run's sealed artifacts");
    inventory.priorReview.push({
      criterionId: row.criterionId,
      sourceRun: sourceRun.id,
      reviewerRun: row.reviewerRun,
      author: row.author,
      judgement: row.judgement,
      note: row.note,
      statementMatches: plan.inherited,
      ancestryVerified: inventory.ancestry.verified,
      relevantPaths: plan.paths,
      relevantUnchanged,
      bindingsVerified,
      support: reasons.length === 0 ? "eligible" : "invalid",
      reasons,
    });
  }

  // 7. Coverage per criterion — the projection every surface reads.
  const coverage = plans.map((plan): CriterionContextCoverage => {
    const prior = inventory.priorReview.filter(one => one.criterionId === plan.id);
    const priorSupport: CriterionContextCoverage["priorSupport"] = prior.length === 0 ? "none" : prior.some(one => one.support === "eligible") ? "eligible" : "invalid";
    const relevantGaps = gaps.filter(one => one.criteria.includes(plan.id)).map(one => one.detail);
    if (!plan.knownInSource) return { ...patchOnly(plan.id, false, relevantGaps), priorSupport };
    const items = plan.paths.flatMap(path => (itemsByPath.has(path) ? [itemsByPath.get(path)!.id] : []));
    // "Judged from the patch" needs KNOWN relevance: only a verified source
    // proof can say the patch touched what this criterion is about.
    const touched = sourceProof !== null && plan.paths.some(path => args.patchPaths.has(path));
    const complete = plan.paths.length > 0 && plan.paths.every(path => itemsByPath.has(path) && !itemsByPath.get(path)!.redacted) && inventory.source.verified && inventory.ancestry.verified;
    const state: CriterionContextCoverage["state"] = touched ? "patch" : complete && relevantGaps.length === 0 ? "context" : "gap";
    const gapsFor = state === "gap" && relevantGaps.length === 0 ? [plan.paths.length === 0 ? "no relevant source paths are known" : "inherited context is incomplete"] : relevantGaps;
    return { id: plan.id, state, inherited: plan.inherited, paths: plan.paths, items, gaps: gapsFor, priorSupport };
  });
  return finish(coverage);
}
