/**
 * The build's own claim, adjudicated against evidence the plane captured
 * itself (`docs/PRIORITIES.md` Priority 2). Modelled line-for-line on the
 * scout's report (`scout-report.ts`): fail closed, every problem reported at
 * once, stable reasons, byte caps, control-character rejection on every
 * string.
 *
 * The proof is a distinct deliverable from the terminal handoff every
 * attempt writes (including `failed` ones, whose lists are deliberately
 * compacted prose) — only a `completed` attempt owes one, and the plane
 * judges it. A missing or malformed proof never fails the attempt or
 * touches the commit; it only keeps the verdict off "verified".
 *
 * `adjudicate` is pure and does no I/O: every fact it reasons over — whether
 * the proof artifact exists, whether the handoff and terminal diff exist,
 * what the sealed diff-stat says, whether a screenshot's bytes actually are
 * a PNG or JPEG, whether an approved verification command ran and what it
 * returned — is gathered by the caller (`builder.ts`) and handed in as data,
 * so the review itself stays testable without a filesystem or a database.
 */

import { hasForbiddenControls } from "./decision.js";

export type ProofVerdict = "verified" | "attested" | "short" | "refuted";

export type ParsedCriterion = {
  id: string;
  statement: string;
  verdict: "met" | "not-met" | "not-checked";
  how: string;
};

export type ParsedCheck = {
  command: string;
  exitCode: number;
  summary: string;
};

/** A screenshot the agent claims proves UI-facing work. `path` is the
 * repository-relative path the file lived at in the worktree when the
 * agent wrote the proof — validated as a path shape here; validated as an
 * actual bounded PNG/JPEG, and read, by the caller. */
export type ParsedScreenshot = {
  path: string;
  caption: string;
};

export type ParsedProof = {
  version: 1;
  criteria: ParsedCriterion[];
  checks: ParsedCheck[];
  changed: string[];
  caveats: string[];
  screenshots: ParsedScreenshot[];
};

export type ProofProblem = { reason: string; message: string };

export type ProofParseResult =
  | { ok: true; proof: ParsedProof }
  | { ok: false; problems: ProofProblem[] };

/** Caps are BYTES of UTF-8, matching the scout report's rule: a payload is
 * the same size whatever script it is written in. */
export const PROOF_LIMITS = {
  payload: 64 * 1024,
  criteria: 12,
  criterionId: 40,
  criterionStatement: 300,
  criterionHow: 500,
  checks: 12,
  checkCommand: 300,
  checkSummary: 300,
  changed: 64,
  changedPath: 300,
  caveats: 8,
  caveat: 300,
  screenshots: 8,
  screenshotPath: 300,
  screenshotCaption: 300,
} as const;

function refuse(reason: string, message: string): ProofParseResult {
  return { ok: false, problems: [{ reason, message }] };
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return `a ${value.length}-char string`;
  return `a ${Array.isArray(value) ? "array" : typeof value}`;
}

function prose(value: unknown, field: string, cap: number, problems: ProofProblem[]): string | null {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    problems.push({ reason: `missing-${field}`, message: `${field} is required` });
    return null;
  }
  if (typeof value !== "string") {
    problems.push({ reason: `bad-${field}`, message: `${field} must be a string (got ${describe(value)})` });
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

/** A repository-relative path: no leading slash, no drive letter, no `.`/`..`
 * segment, no backslash, no control character. The same shape
 * `readVerifiedArtifact` enforces on an evidence key, applied here to a
 * path an agent claims rather than one the machine already wrote. */
function relativePath(value: unknown, field: string, cap: number, problems: ProofProblem[]): string | null {
  const raw = prose(value, field, cap, problems);
  if (raw === null) return null;
  const segments = raw.split("/");
  const wellFormed =
    !raw.startsWith("/") &&
    segments.every(segment => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\"));
  if (!wellFormed) {
    problems.push({ reason: `${field}-not-relative`, message: `${field} must be a normalized repository-relative path (got ${describe(value)})` });
    return null;
  }
  return raw;
}

function parseCriteria(value: unknown, problems: ProofProblem[]): ParsedCriterion[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push({ reason: "bad-criteria", message: `criteria must be an array (got ${describe(value)})` });
    return [];
  }
  if (value.length > PROOF_LIMITS.criteria) {
    problems.push({ reason: "criteria-too-many", message: `criteria lists ${value.length} — cap is ${PROOF_LIMITS.criteria}` });
    return [];
  }
  const criteria: ParsedCriterion[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push({ reason: `criteria[${index}]-shape`, message: `criteria[${index}] must be an object` });
      continue;
    }
    const one = entry as Record<string, unknown>;
    const id = prose(one["id"], `criteria[${index}].id`, PROOF_LIMITS.criterionId, problems);
    if (id !== null && seen.has(id)) {
      problems.push({ reason: `criteria[${index}]-duplicate-id`, message: `criterion id "${id}" appears twice` });
    } else if (id !== null) {
      seen.add(id);
    }
    const statement = prose(one["statement"], `criteria[${index}].statement`, PROOF_LIMITS.criterionStatement, problems);
    const how = prose(one["how"], `criteria[${index}].how`, PROOF_LIMITS.criterionHow, problems);
    const verdict = one["verdict"];
    if (verdict !== "met" && verdict !== "not-met" && verdict !== "not-checked") {
      problems.push({
        reason: `criteria[${index}]-bad-verdict`,
        message: `criteria[${index}].verdict must be "met", "not-met", or "not-checked" (got ${describe(verdict)})`,
      });
      continue;
    }
    if (id === null || statement === null || how === null) continue;
    criteria.push({ id, statement, how, verdict });
  }
  return criteria;
}

function parseChecks(value: unknown, problems: ProofProblem[]): ParsedCheck[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push({ reason: "bad-checks", message: `checks must be an array (got ${describe(value)})` });
    return [];
  }
  if (value.length > PROOF_LIMITS.checks) {
    problems.push({ reason: "checks-too-many", message: `checks lists ${value.length} — cap is ${PROOF_LIMITS.checks}` });
    return [];
  }
  const checks: ParsedCheck[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push({ reason: `checks[${index}]-shape`, message: `checks[${index}] must be an object` });
      continue;
    }
    const one = entry as Record<string, unknown>;
    const command = prose(one["command"], `checks[${index}].command`, PROOF_LIMITS.checkCommand, problems);
    const summary = prose(one["summary"], `checks[${index}].summary`, PROOF_LIMITS.checkSummary, problems);
    const exitCode = one["exitCode"];
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      problems.push({
        reason: `checks[${index}]-bad-exit-code`,
        message: `checks[${index}].exitCode must be an integer 0-255 (got ${describe(exitCode)})`,
      });
      continue;
    }
    if (command === null || summary === null) continue;
    checks.push({ command, summary, exitCode });
  }
  return checks;
}

function parseStringList(
  value: unknown,
  field: string,
  cap: number,
  itemCap: number,
  problems: ProofProblem[],
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push({ reason: `bad-${field}`, message: `${field} must be an array (got ${describe(value)})` });
    return [];
  }
  if (value.length > cap) {
    problems.push({ reason: `${field}-too-many`, message: `${field} lists ${value.length} — cap is ${cap}` });
    return [];
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    const item = prose(entry, `${field}[${index}]`, itemCap, problems);
    if (item !== null) out.push(item);
  }
  return out;
}

function parseScreenshots(value: unknown, problems: ProofProblem[]): ParsedScreenshot[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push({ reason: "bad-screenshots", message: `screenshots must be an array (got ${describe(value)})` });
    return [];
  }
  if (value.length > PROOF_LIMITS.screenshots) {
    problems.push({ reason: "screenshots-too-many", message: `screenshots lists ${value.length} — cap is ${PROOF_LIMITS.screenshots}` });
    return [];
  }
  const screenshots: ParsedScreenshot[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push({ reason: `screenshots[${index}]-shape`, message: `screenshots[${index}] must be an object` });
      continue;
    }
    const one = entry as Record<string, unknown>;
    const path = relativePath(one["path"], `screenshots[${index}].path`, PROOF_LIMITS.screenshotPath, problems);
    const caption = prose(one["caption"], `screenshots[${index}].caption`, PROOF_LIMITS.screenshotCaption, problems);
    if (path !== null && seen.has(path)) {
      problems.push({ reason: `screenshots[${index}]-duplicate-path`, message: `screenshot path "${path}" appears twice` });
      continue;
    }
    if (path === null || caption === null) continue;
    seen.add(path);
    screenshots.push({ path, caption });
  }
  return screenshots;
}

export function parseProof(raw: string): ProofParseResult {
  if (Buffer.byteLength(raw, "utf8") > PROOF_LIMITS.payload) {
    return refuse("too-large", `the payload is over ${PROOF_LIMITS.payload} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return refuse("not-json", `the payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("not-an-object", "the payload must be one JSON object");
  }
  const body = parsed as Record<string, unknown>;
  const problems: ProofProblem[] = [];

  if (body["version"] !== 1) {
    problems.push({ reason: "bad-version", message: `version must be 1 (got ${describe(body["version"])})` });
  }

  const criteria = parseCriteria(body["criteria"], problems);
  const checks = parseChecks(body["checks"], problems);
  const changed = parseStringList(body["changed"], "changed", PROOF_LIMITS.changed, PROOF_LIMITS.changedPath, problems);
  const caveats = parseStringList(body["caveats"], "caveats", PROOF_LIMITS.caveats, PROOF_LIMITS.caveat, problems);
  const screenshots = parseScreenshots(body["screenshots"], problems);

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    proof: { version: 1, criteria, checks, changed, caveats, screenshots },
  };
}

/** Re-serialize the validated shape, never the agent's raw bytes (the
 * scout report's rule, `scout.ts`): what is stored and later hash-verified
 * is exactly what this parser admitted, key order and all. */
export function serializeProof(proof: ParsedProof): string {
  return JSON.stringify(proof, null, 2);
}

/** One claimed screenshot's fate once the caller has read its bytes off the
 * worktree and checked them against the PNG/JPEG signature and size cap. */
export type ScreenshotOutcome = {
  path: string;
  ok: boolean;
  /** Set when ok is false — why the claimed file did not become evidence. */
  problem?: string;
};

/** What `captureTerminalDiff` gives back, restated for adjudication:
 * whether the sealed stat parsed at all, whether the file list was cut to
 * fit the cap, and the set of paths it names. A truncated stat cannot prove
 * a claimed path is ABSENT, so rule 4 does not fire against one. */
export type DiffStatFacts = {
  captured: boolean;
  truncated: boolean;
  paths: ReadonlySet<string>;
};

/** The plane's own re-run of the repository's approved verification
 * command, when one is configured. `ran: false` covers both "none
 * configured" and "configured but the run could not attempt it" — the
 * latter is distinguished by `attemptFailed`, which downgrades to `short`
 * rather than `refuted`: "we could not check" is not "the claim is false". */
export type VerifyCommandFacts =
  | { configured: false }
  | { configured: true; ran: false; attemptFailed: true }
  | { configured: true; ran: true; exitCode: number };

export type AdjudicateInput = {
  /** Whether a `proof` artifact was stored at all for this run. */
  proofArtifactPresent: boolean;
  /** null when no proof artifact exists; otherwise the parse of its bytes. */
  proofParse: ProofParseResult | null;
  handoffPresent: boolean;
  terminalDiffPresent: boolean;
  terminalDiffCaptureStatus: "ok" | "failed" | null;
  diffStat: DiffStatFacts | null;
  verifyCommand: VerifyCommandFacts;
  /** One entry per screenshot the proof claimed, in the order claimed.
   * Empty when the proof named none. */
  screenshots: readonly ScreenshotOutcome[];
};

export type AdjudicateResult = { verdict: ProofVerdict; reasons: string[] };

/**
 * Ordered rules; the first that fires wins. Every reason is a sentence the
 * surfaces print verbatim — this function is the only place that decides
 * wording, so the task page, run page, board, CLI, and chat cards cannot
 * drift from each other (Priority 2, the "one surface, six places" rule).
 */
export function adjudicate(input: AdjudicateInput): AdjudicateResult {
  if (!input.proofArtifactPresent) {
    return { verdict: "short", reasons: ["no proof was written"] };
  }
  if (input.proofParse === null || !input.proofParse.ok) {
    const detail =
      input.proofParse !== null && !input.proofParse.ok
        ? input.proofParse.problems.map(p => p.message).join("; ")
        : "the proof could not be read";
    return { verdict: "short", reasons: [`the proof is malformed: ${detail}`] };
  }
  const proof = input.proofParse.proof;

  if (!input.handoffPresent) {
    return { verdict: "short", reasons: ["the terminal handoff is missing"] };
  }
  if (!input.terminalDiffPresent || input.terminalDiffCaptureStatus === "failed") {
    return { verdict: "short", reasons: ["the machine-captured diff is missing or failed to capture"] };
  }

  if (input.diffStat !== null && input.diffStat.captured && !input.diffStat.truncated) {
    const missing = proof.changed.filter(path => !input.diffStat!.paths.has(path));
    if (missing.length > 0) {
      return {
        verdict: "refuted",
        reasons: [`claimed changed path${missing.length > 1 ? "s" : ""} not in the sealed diff: ${missing.join(", ")}`],
      };
    }
  }

  if (input.verifyCommand.configured && input.verifyCommand.ran && input.verifyCommand.exitCode !== 0) {
    return {
      verdict: "refuted",
      reasons: [`the repository's approved verification command exited ${input.verifyCommand.exitCode}`],
    };
  }

  const unmet = proof.criteria.filter(c => c.verdict !== "met");
  if (unmet.length > 0) {
    return {
      verdict: "short",
      reasons: unmet.map(c => `criterion "${c.statement}" is ${c.verdict === "not-met" ? "not met" : "not checked"}`),
    };
  }

  const badScreenshots = input.screenshots.filter(s => !s.ok);
  if (badScreenshots.length > 0) {
    return {
      verdict: "short",
      reasons: badScreenshots.map(s => `claimed screenshot "${s.path}" could not be verified${s.problem ? `: ${s.problem}` : ""}`),
    };
  }

  if (input.verifyCommand.configured && input.verifyCommand.ran && input.verifyCommand.exitCode === 0) {
    return { verdict: "verified", reasons: ["the approved verification command passed"] };
  }
  if (input.verifyCommand.configured && !input.verifyCommand.ran) {
    return { verdict: "short", reasons: ["the approved verification command could not be run"] };
  }
  return { verdict: "attested", reasons: ["the proof agrees with the sealed diff; no verification command is configured to re-run"] };
}

/** Plain words for a verdict, shared by every surface (the `summary.ts`
 * pattern) so the task page, run page, board, CLI, and chat cannot say
 * three different things about the same run. */
export function verdictWords(verdict: ProofVerdict, reasons: readonly string[]): { word: string; detail: string } {
  const detail = reasons.length > 0 ? reasons.join("; ") : "";
  switch (verdict) {
    case "verified":
      return { word: "complete — verified", detail };
    case "attested":
      return { word: "complete — evidence attested", detail };
    case "short":
      return { word: "needs verification", detail };
    case "refuted":
      return { word: "proof refuted", detail };
  }
}

/** The `data-dispatch-status` token a page's CSS and tests key off. */
export function dispatchStatusToken(verdict: ProofVerdict): "complete-verified" | "complete-with-evidence" | "needs-verification" | "proof-refuted" {
  switch (verdict) {
    case "verified":
      return "complete-verified";
    case "attested":
      return "complete-with-evidence";
    case "short":
      return "needs-verification";
    case "refuted":
      return "proof-refuted";
  }
}
