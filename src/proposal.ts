/**
 * The one door work enters through (Codex adoption review, finding 7).
 *
 * Before this module, each filing surface — CLI, console, intake — validated
 * what it happened to think of: createConsoleTask checked title and goal but
 * not disguised text, the routine command checked terms but nothing checked a
 * repo against the caller's ceiling, and nothing stamped who filed what. The
 * review's ruling: one canonical service that every filer calls, with an
 * exact field allowlist, so a careless caller CANNOT spread a template or
 * model object into scope rows and smuggle approval metadata.
 *
 * The contract, in order:
 *   - every text field is validated here, identically for every caller:
 *     length bounds, control characters, and DISGUISED text (invisibles,
 *     bidi overrides) on the fields an approver reads;
 *   - the repo is canonicalized, and when the caller has a ceiling the
 *     canonical repo must be inside it — an absent ceiling is the CLI's
 *     honest "no ceiling", never a wildcard for surfaces that have one;
 *   - approval fields are hardcoded null by the store methods this calls;
 *     nothing a caller passes can reach them (exact allowlist, no spread);
 *   - the digest is computed HERE, never accepted from the caller;
 *   - provenance (filedVia) is stamped in the same transaction and is
 *     immutable — there is no API to change it, anywhere.
 *
 * Filing carries NO authority. Everything this module creates is unapproved
 * and stays inert until the operator's own ceremony says otherwise.
 */

import { resolveScopeProfile } from "./agentconfig.js";
import { resolve } from "node:path";
import { hasForbiddenControls, hasDisguisedText } from "./decision.js";
import { canonicalProject } from "./project.js";
import {
  ROUTINE_NAME,
  routineDigestOf,
  validateRoutineTerms,
  type RoutineTerms,
} from "./routine.js";
import type { Store } from "./store.js";

/** Provenance tokens are part of the audit surface: lowercase, bounded,
 * nothing that could render as anything but itself. */
const FILED_VIA = /^[a-z][a-z0-9:-]{0,63}$/;

export type ProposalRefusal = {
  ok: false;
  /** Stable, machine-readable — joins the envelope like every reason. */
  reason:
    | "bad-title"
    | "bad-goal"
    | "bad-id"
    | "bad-name"
    | "bad-terms"
    | "bad-repo"
    | "outside-ceiling"
    | "bad-provenance"
    | "backlog-full"
    | "duplicate";
  message: string;
};

export type TaskProposalInput = {
  id?: string;
  title: string;
  repo?: string;
  goal?: string;
  outOfScope?: string | null;
  touches?: string[];
  /** Which door filed this: 'cli', 'console', 'intake', 'template:<name>'. */
  filedVia: string;
  /**
   * The caller's ceiling as canonical repo paths. undefined = the caller
   * genuinely has none (the CLI on the operator's own machine). A surface
   * that HAS a ceiling must pass it — an empty list refuses every repo,
   * which is the fail-closed reading of an empty ceiling (finding 4).
   */
  admittedRepos?: readonly string[];
};

export type RoutineProposalInput = {
  name: string;
  repo: string;
  goal: string;
  outOfScope: string | null;
  touches: string[];
  requirements: string[];
  schedule: string;
  costCeilingUsd: number | null;
  /** Per-instance dollar cap in micro-USD (v16); optional, digest-bound. */
  budgetPerRunMicrousd?: number | null;
  filedVia: string;
  admittedRepos?: readonly string[];
};

function refuse(reason: ProposalRefusal["reason"], message: string): ProposalRefusal {
  return { ok: false, reason, message };
}

/** The fields an approver reads must BE what they appear to be: no control
 * characters anywhere, no invisible or direction-override text either. */
function dishonest(text: string): boolean {
  return hasForbiddenControls(text) || hasDisguisedText(text);
}

/** Byte caps beside the character caps (Codex v3 review, change 8): a
 * 2000-character goal of astral-plane text is 8000 bytes — model-authored
 * fields must bound STORAGE, not just what a screen shows. */
const BYTE_CAPS = { title: 800, name: 200, text: 8_000, path: 800, requirement: 400 } as const;

function overBytes(text: string, cap: number): boolean {
  return Buffer.byteLength(text, "utf8") > cap;
}

function checkRepo(
  given: string | undefined,
  admitted: readonly string[] | undefined,
): { ok: true; repo: string | undefined } | ProposalRefusal {
  if (given === undefined || given === "") {
    // A ceiling names the ONLY repos this surface may file into. Filing
    // repo-less under a ceiling would bypass it wholesale (MCP spec v2,
    // Codex round 2 finding 2) — a bounded surface must say where.
    if (admitted !== undefined) {
      return refuse("outside-ceiling", "this surface must name a repository — it is limited to specific ones");
    }
    return { ok: true, repo: undefined };
  }
  // Best-effort canonicalization, the codebase's one convention: a real
  // directory resolves through symlinks; a path that does not exist yet
  // still normalizes, because filing must not depend on this machine
  // seeing every repo the plane knows about.
  const canonical = canonicalProject(given) ?? resolve(given);
  if (admitted !== undefined && !admitted.includes(canonical)) {
    return refuse("outside-ceiling", "that repository is outside what this surface was configured to show");
  }
  return { ok: true, repo: canonical };
}

/**
 * The text rules every filed task obeys, exported so the CLI's replayed
 * `task add` path (which keeps its own idempotency machinery) validates
 * identically to the service instead of approximately.
 */
export function validateTaskText(fields: {
  title: string;
  goal?: string;
  outOfScope?: string | null;
  touches?: string[];
}): ProposalRefusal | null {
  if (fields.title.trim() === "" || fields.title.length > 200 || overBytes(fields.title, BYTE_CAPS.title) || dishonest(fields.title)) {
    return refuse("bad-title", "a title is required, at most 200 characters, with no control or disguised text");
  }
  if (
    fields.goal !== undefined &&
    (fields.goal.trim() === "" || fields.goal.length > 2_000 || overBytes(fields.goal, BYTE_CAPS.text) || dishonest(fields.goal))
  ) {
    return refuse("bad-goal", "a goal is at most 2000 characters, with no control or disguised text");
  }
  const outOfScope = fields.outOfScope ?? null;
  if (outOfScope !== null && (outOfScope.length > 2_000 || overBytes(outOfScope, BYTE_CAPS.text) || dishonest(outOfScope))) {
    return refuse("bad-goal", "out-of-scope text is at most 2000 characters, with no control or disguised text");
  }
  const touches = fields.touches ?? [];
  if (
    touches.length > 50 ||
    touches.some(one => one.trim() === "" || one.length > 200 || overBytes(one, BYTE_CAPS.path) || dishonest(one))
  ) {
    return refuse("bad-goal", "touches: at most 50 paths, each non-empty, under 200 characters, honest text");
  }
  return null;
}

export function fileTaskProposal(
  store: Store,
  input: TaskProposalInput,
  now: Date,
): { ok: true; id: string } | ProposalRefusal {
  if (!FILED_VIA.test(input.filedVia)) {
    return refuse("bad-provenance", "filedVia is an audit token: lowercase letters, digits, dashes, colons");
  }
  const badText = validateTaskText(input);
  if (badText !== null) return badText;
  const outOfScope = input.outOfScope ?? null;
  const touches = input.touches ?? [];
  const repo = checkRepo(input.repo, input.admittedRepos);
  if (!repo.ok) return repo;

  // Exact allowlist — built field by field, never spread from the input.
  const made = store.createConsoleTask(
    {
      ...(input.id === undefined ? {} : { id: input.id }),
      title: input.title,
      ...(repo.repo === undefined ? {} : { repo: repo.repo }),
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      outOfScope,
      touches,
      filedVia: input.filedVia,
    },
    now,
  );
  if (!made.ok) {
    return refuse(
      made.reason,
      made.reason === "backlog-full"
        ? "the backlog is full — finish or cancel something first"
        : made.reason === "duplicate"
          ? "a task with that id already exists"
          : `the store refused the filing: ${made.reason}`,
    );
  }
  return { ok: true, id: made.id };
}

export function fileRoutineProposal(
  store: Store,
  input: RoutineProposalInput,
  now: Date,
): { ok: true; id: number; digest: string } | ProposalRefusal {
  if (!FILED_VIA.test(input.filedVia)) {
    return refuse("bad-provenance", "filedVia is an audit token: lowercase letters, digits, dashes, colons");
  }
  const repo = checkRepo(input.repo, input.admittedRepos);
  if (!repo.ok) return repo;
  if (repo.repo === undefined) return refuse("bad-repo", "a routine needs the repository it runs in");

  const terms: RoutineTerms = {
    repo: repo.repo,
    goal: input.goal,
    outOfScope: input.outOfScope,
    touches: input.touches,
    requirements: input.requirements,
    schedule: input.schedule,
    // v1 routines run one instance at a time, period — hardcoded, not accepted.
    singleFlight: true,
    costCeilingUsd: input.costCeilingUsd,
    ...(input.budgetPerRunMicrousd == null ? {} : { budgetPerRunMicrousd: input.budgetPerRunMicrousd }),
  };
  // EVERY problem at once — an operator fixing a form deserves the whole
  // list, not one complaint per submission.
  const problems = validateRoutineTerms(terms);
  if (!ROUTINE_NAME.test(input.name)) {
    problems.unshift({ field: "name", problem: "lowercase letters, digits, and dashes — it becomes each instance's id" });
  }
  if (
    dishonest(input.goal) ||
    overBytes(input.goal, BYTE_CAPS.text) ||
    (input.outOfScope !== null && (dishonest(input.outOfScope) || overBytes(input.outOfScope, BYTE_CAPS.text)))
  ) {
    problems.push({ field: "goal", problem: "no control or disguised text, bounded bytes" });
  }
  // The v3 review, change 8: touches and requirements are approver-read
  // text too — the door holds them to the same honesty everywhere.
  if (input.touches.some(one => dishonest(one) || overBytes(one, BYTE_CAPS.path))) {
    problems.push({ field: "touches", problem: "no control or disguised text, bounded bytes" });
  }
  if (input.requirements.some(one => dishonest(one) || overBytes(one, BYTE_CAPS.requirement))) {
    problems.push({ field: "requirements", problem: "no control or disguised text, bounded bytes" });
  }
  if (problems.length > 0) {
    const named = problems.map(one => `${one.field}: ${one.problem}`).join("; ");
    return refuse(problems.some(one => one.field === "name") ? "bad-name" : "bad-terms", named);
  }
  // v24 filing invariant, routine flavor: resolve the execution profile
  // once, here, and bind it into the digest a person will sign. Unresolved
  // saves too (finding 19) — approval then refuses until restated.
  const resolvedProfile = resolveScopeProfile(store, repo.repo, undefined, {});
  const routineProfile = resolvedProfile.ok ? resolvedProfile.profile : null;
  const created = store.createRoutine(
    {
      name: input.name,
      ...terms,
      digest: routineDigestOf(terms, routineProfile),
      filedVia: input.filedVia,
      ...(routineProfile === null ? {} : { profile: routineProfile }),
    },
    now,
  );
  if (!created.ok) return refuse("duplicate", `a routine named ${input.name} already exists`);
  return { ok: true, id: created.id, digest: routineDigestOf(terms, routineProfile) };
}
