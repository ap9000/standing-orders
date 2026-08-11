/**
 * Which work graph is already here.
 *
 * Chosen by looking, not by asking — an operator who already keeps their work
 * in beads should not be made to declare that to a tool standing in the same
 * directory. But **detection is not authorization.** Finding a populated
 * tracker says it exists; it says nothing about whether its owner wants Night
 * Orders scheduling, closing, or restructuring what is in it. Nothing here
 * writes, enrolls, or grants anything.
 *
 * **Nothing is ever installed.** No package manager, no package runner, no
 * initializer — `bd init` stages files, edits agent integrations, and can make
 * a commit, so it is the operator's to run. This module runs read commands
 * against binaries that are already on PATH, and prints what it cannot do.
 *
 * Data and runtime are detected independently, and that separation is the
 * point. A populated tracker with no working runtime is real work that this
 * machine cannot currently dispatch, and saying so at 9am is the whole job —
 * the alternative is finding out inside a dead loop at 3am.
 *
 * Where a fact is not established it is `unverified`, and unverified fails
 * closed. A backend whose dependency edges we cannot confirm is shown and may
 * even be recommended, but it is not dispatchable, because §4's rule is that
 * scheduling edges are never emulated: a private graph other tools cannot see
 * is shadow data.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { run, type ExecResult, type RunOptions } from "./exec.js";

export type BackendKind = "beads" | "backlog-md" | "github-issues";

/**
 * Whether the backend carries dependency edges of its own.
 *
 * `unverified` is not a soft `native`. It means nobody has confirmed it, and a
 * scheduler must treat it as absent rather than assume in its own favour.
 */
export type Deps = "native" | "unverified" | "none";

export type Runtime =
  | { state: "ok"; version: string | null }
  | { state: "missing"; binary: string }
  | { state: "outdated"; version: string; needs: string }
  | { state: "unreadable"; reason: string };

/**
 * What was counted, and which question it answers. A ready count and an open
 * count are different numbers, and labelling one as the other would misreport
 * how much work is actually dispatchable.
 */
export type Count = { of: "ready" | "open"; value: number };

export type Detection = {
  kind: BackendKind;
  label: string;
  /** Repositories whose data was found on disk, or which have issues. */
  repos: string[];
  /** null when nothing could be counted — absence of a number, not zero. */
  count: Count | null;
  deps: Deps;
  runtime: Runtime;
  /** Whether work here could actually be scheduled tonight. */
  dispatchable: boolean;
  /** What could not be read, in words. Never silently dropped. */
  problems: string[];
};

/**
 * The ladder from §3. `ambiguous` is a deliberate outcome and not a failure:
 * several populated trackers mean the operator has to say which one, because
 * task count is not write authority and the biggest tracker may be the
 * abandoned one.
 */
export type Choice =
  | { action: "recommend"; kind: BackendKind; dispatchable: boolean; why: string }
  | { action: "ambiguous"; kinds: BackendKind[]; why: string }
  | { action: "built-in"; why: string };

export type ChooseOptions = {
  /** A backend the operator already enrolled. Outranks anything detected. */
  enrolled?: BackendKind;
};

/**
 * What the operator would run to set a backend up, and what it would do to
 * their repository.
 *
 * This is text, and stays text. `bd init` creates or updates `AGENTS.md` and
 * installs Claude and Codex integrations unless told not to — which is a
 * substantial thing to do to somebody's repository, and not ours to do on
 * their behalf. A tool that refuses to run `bd init` for you and then quietly
 * ran it from inside a helpful setup prompt would have spent the only
 * credibility it had.
 *
 * There is deliberately no prompt. A wizard would cost the zero-config opening
 * this tool is built around, and half the intended audience is an agent or a
 * scheduled run, where anything that blocks on an answer simply hangs.
 *
 * Commands are quoted from each tool's own documentation rather than inferred.
 * Backlog.md is detected but not offered here, because its install path has
 * not been verified — and printing a command that has not been checked is how
 * an operator ends up running the wrong thing on our say-so.
 */
export type SetupOption = {
  kind: BackendKind | "built-in";
  label: string;
  /** null when there is nothing to install. */
  install: string | null;
  /** null when there is nothing to initialize. */
  init: string | null;
  /** What it changes in the repository. Never omitted where there is one. */
  sideEffects: string | null;
  note: string | null;
};

export function setupOptions(): SetupOption[] {
  return [
    {
      kind: "beads",
      label: LABELS.beads,
      install: "brew install beads   # or: npm install -g @beads/bd",
      init: "bd init",
      sideEffects:
        "creates .beads/, and creates or updates AGENTS.md and installs Claude/Codex integrations unless you pass --skip-agents or --stealth",
      note: "native dependency edges and a ready query",
    },
    {
      kind: "github-issues",
      label: LABELS["github-issues"],
      install: null,
      init: null,
      sideEffects: null,
      note: `already there if the repo is on GitHub; needs gh ${GH_DEPS_MIN_VERSION}+ for dependency fields`,
    },
    {
      kind: "built-in",
      label: "built-in",
      install: null,
      init: null,
      sideEffects: null,
      note: "a deliberately small local store, not built yet",
    },
  ];
}

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

export type DetectOptions = {
  runner?: Runner;
  /** Injected so the pure half of detection needs no fixture tree. */
  exists?: (path: string) => boolean;
};

const BD = "bd";
const GH = "gh";
const BACKLOG = "backlog";

/** Reading a tracker is local work; only the GitHub one crosses the network. */
export const LOCAL_TIMEOUT_MS = 10_000;
export const NETWORK_TIMEOUT_MS = 20_000;

/**
 * Dependency fields on GitHub Issues need a newer `gh` than the REST route
 * does. The version gate is therefore about *native edges*, not about whether
 * issues can be read at all — an older gh still counts them, it just cannot be
 * trusted to schedule from them.
 */
export const GH_DEPS_MIN_VERSION = "2.94.0";

export const LABELS: Record<BackendKind, string> = {
  beads: "beads",
  "backlog-md": "Backlog.md",
  "github-issues": "GitHub Issues",
};

/** Where each repo-local tracker keeps its data, relative to the repo root. */
const DATA_PATHS: Record<"beads" | "backlog-md", string> = {
  beads: ".beads",
  "backlog-md": "backlog.md",
};

export async function detectGraphs(
  repos: readonly string[],
  options: DetectOptions = {},
): Promise<Detection[]> {
  const { runner = run, exists = existsSync } = options;

  const beadsRepos = repos.filter(repo => exists(join(repo, DATA_PATHS.beads)));
  const backlogRepos = repos.filter(repo => exists(join(repo, DATA_PATHS["backlog-md"])));

  const [beads, backlog, issues] = await Promise.all([
    beadsRepos.length === 0 ? null : detectBeads(beadsRepos, runner),
    backlogRepos.length === 0 ? null : detectBacklog(backlogRepos, runner),
    repos.length === 0 ? null : detectIssues(repos, runner),
  ]);

  return [beads, backlog, issues].filter((one): one is Detection => one !== null);
}

/**
 * beads keeps its data in `.beads/`, and `bd ready --json` is the read that
 * matters: it is the ready set, which is the same question the scheduler asks.
 * There is no `bd list`, so an open count is not available without exporting
 * the whole graph — and counting ready work is the more honest number anyway.
 */
async function detectBeads(repos: readonly string[], runner: Runner): Promise<Detection> {
  const runtime = await probeVersion(runner, BD, ["version"], repos[0] as string);
  const problems: string[] = [];
  let count: Count | null = null;

  if (runtime.state === "ok") {
    const counted = await countReady(runner, repos);
    count = counted.count;
    problems.push(...counted.problems);
  } else if (runtime.state === "missing") {
    problems.push("bd is not on PATH — beads data is here but cannot be read or scheduled");
  }

  return {
    kind: "beads",
    label: LABELS.beads,
    repos: [...repos],
    count,
    deps: "native",
    runtime,
    // A binary that answers `version` has proved it exists, not that the ready
    // set can be read: a locked database or a schema this build does not
    // understand fails every read while `bd version` keeps saying yes. Reading
    // it once is the only evidence that dispatch would work, so nothing is
    // dispatchable until a read has actually succeeded.
    dispatchable: runtime.state === "ok" && count !== null,
    problems,
  };
}

async function countReady(
  runner: Runner,
  repos: readonly string[],
): Promise<{ count: Count | null; problems: string[] }> {
  const problems: string[] = [];
  let total = 0;
  let counted = false;

  for (const repo of repos) {
    const result = await runner(BD, ["ready", "--json"], {
      cwd: repo,
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      problems.push(`${repo}: could not read beads: ${describeFailure(result)}`);
      continue;
    }
    const items = countArray(result.stdout);
    if (items === null) {
      problems.push(`${repo}: beads returned something unreadable`);
      continue;
    }
    total += items;
    counted = true;
  }

  return { count: counted ? { of: "ready", value: total } : null, problems };
}

/**
 * Backlog.md is detected from its file and probed for a runtime, but its
 * dependency model is not something this program has confirmed. Unverified
 * fails closed, so it is reported and never dispatched — §4 would rather show
 * a visible gap than emulate edges nobody else can see.
 */
async function detectBacklog(repos: readonly string[], runner: Runner): Promise<Detection> {
  const runtime = await probeVersion(runner, BACKLOG, ["--version"], repos[0] as string);

  return {
    kind: "backlog-md",
    label: LABELS["backlog-md"],
    repos: [...repos],
    count: null,
    deps: "unverified",
    runtime,
    dispatchable: false,
    problems: [
      runtime.state === "missing"
        ? "backlog is not on PATH — the file is here but nothing can read it"
        : "dependency edges are unverified — readable, but not scheduled from",
    ],
  };
}

/**
 * GitHub Issues are counted through `gh`, which is already how pull requests
 * are read, so no new credential is involved. The version gate is separate
 * from the count on purpose: an older `gh` still answers how many issues are
 * open, it just cannot be trusted for the dependency fields that scheduling
 * would need.
 */
async function detectIssues(repos: readonly string[], runner: Runner): Promise<Detection> {
  const version = await probeVersion(runner, GH, ["--version"], repos[0] as string);
  const runtime = gateGhVersion(version);

  const problems: string[] = [];
  const withIssues: string[] = [];
  let total = 0;
  let counted = false;

  if (runtime.state === "missing") {
    problems.push("gh is not installed — GitHub Issues were not read");
  } else {
    for (const repo of repos) {
      const result = await runner(
        GH,
        ["issue", "list", "--state", "open", "--limit", "100", "--json", "number"],
        { cwd: repo, timeoutMs: NETWORK_TIMEOUT_MS },
      );

      if (result.code !== 0) {
        // Only one failure is ordinary: a repository that is not on GitHub, on
        // a machine full of local-only work. Everything else — expired auth, a
        // rate limit, a transport error — is a repository we failed to read,
        // and reporting that as "no issues here" would be a false negative of
        // exactly the kind this tool exists to prevent.
        if (!isMissingRemote(result.stderr)) {
          problems.push(`${repo}: could not read issues: ${describeFailure(result)}`);
        }
        continue;
      }

      const items = countArray(result.stdout);
      if (items === null) {
        problems.push(`${repo}: gh returned something unreadable for issues`);
        continue;
      }

      counted = true;
      if (items > 0) {
        total += items;
        withIssues.push(repo);
      }
    }
  }

  return {
    kind: "github-issues",
    label: LABELS["github-issues"],
    repos: withIssues,
    count: counted ? { of: "open", value: total } : null,
    // Issues have native `blocked_by` and sub-issues, but the dependency
    // fields need a newer gh than reading them does — so an old gh means the
    // edges are unconfirmed, not merely inconvenient. Cross-repository
    // semantics stay unverified regardless, and unverified fails closed.
    deps: runtime.state === "ok" ? "native" : "unverified",
    runtime,
    // Never a default, per the ladder's last rung; see chooseBackend.
    dispatchable: false,
    problems,
  };
}

/**
 * The one `gh` failure that means "this is not a GitHub repository" rather
 * than "we could not read it". Matched on the message because gh returns 1 for
 * everything, so the exit code cannot tell these apart.
 */
function isMissingRemote(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("no git remotes") ||
    text.includes("not a git repository") ||
    text.includes("could not determine base repository") ||
    text.includes("none of the git remotes")
  );
}

/** `gh --version` prints `gh version 2.67.0 (...)`; take the first number triple. */
function gateGhVersion(runtime: Runtime): Runtime {
  if (runtime.state !== "ok" || runtime.version === null) return runtime;
  if (compareVersions(runtime.version, GH_DEPS_MIN_VERSION) >= 0) return runtime;

  return { state: "outdated", version: runtime.version, needs: GH_DEPS_MIN_VERSION };
}

async function probeVersion(
  runner: Runner,
  binary: string,
  args: readonly string[],
  cwd: string,
): Promise<Runtime> {
  const result = await runner(binary, args, { cwd, timeoutMs: LOCAL_TIMEOUT_MS });

  if (result.notFound) return { state: "missing", binary };
  if (result.code !== 0) return { state: "unreadable", reason: describeFailure(result) };

  return { state: "ok", version: parseVersion(result.stdout) };
}

/** null when no version-shaped token is present — unknown, not zero. */
export function parseVersion(text: string): string | null {
  const found = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return found === null ? null : `${found[1]}.${found[2]}.${found[3] ?? "0"}`;
}

/** Negative, zero, or positive, like every other comparator. */
export function compareVersions(left: string, right: string): number {
  const mine = numbersIn(left);
  const theirs = numbersIn(right);

  for (let index = 0; index < Math.max(mine.length, theirs.length); index++) {
    const difference = (mine[index] ?? 0) - (theirs[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function numbersIn(version: string): number[] {
  return version.split(".").map(part => Number.parseInt(part, 10) || 0);
}

/** null when the payload is not the array another program promised us. */
function countArray(json: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed.length : null;
}

function describeFailure(result: ExecResult): string {
  if (result.timedOut) return "timed out";
  const [line = ""] = result.stderr.trim().split("\n");
  return line === "" ? `exit ${result.code}` : line;
}

/**
 * The ladder from §3, as a pure function so the policy can be read and tested
 * without a filesystem.
 *
 * The rung that does the most work is the third: several populated repo-local
 * trackers mean Night Orders stays in discovery until a person says which one.
 * Picking the largest would be inventing authority out of a row count.
 *
 * GitHub Issues is never chosen automatically. It has native edges, but a
 * populated issue tracker is evidence people file issues, not evidence anyone
 * wants an unattended agent closing them — the design requires existing
 * dependency use *and* a confirmed write scope, and neither is established by
 * looking.
 */
export function chooseBackend(
  detections: readonly Detection[],
  options: ChooseOptions = {},
): Choice {
  const local = detections.filter(one => one.kind !== "github-issues");
  const populated = local.filter(isPopulated);

  // Rung 1. Nothing persists a grant yet — `BackendGrant` is still ahead of us
  // in M0 — so this is reachable only when a caller supplies one. It is here
  // rather than later because an enrolled backend must outrank detection the
  // moment enrollment exists: an operator who already said which one should
  // never be re-asked because a second tracker appeared in some other repo.
  const enrolled = detections.find(one => one.kind === options.enrolled);
  if (enrolled !== undefined) {
    return {
      action: "recommend",
      kind: enrolled.kind,
      dispatchable: enrolled.dispatchable,
      why: "already enrolled",
    };
  }

  if (populated.length === 1) {
    const only = populated[0] as Detection;
    return {
      action: "recommend",
      kind: only.kind,
      dispatchable: only.dispatchable,
      why: only.dispatchable
        ? `the only work graph in your repos, and ${runtimeWord(only)}`
        : `the only work graph in your repos, but ${blockedWord(only)}`,
    };
  }

  if (populated.length > 1) {
    return {
      action: "ambiguous",
      kinds: populated.map(one => one.kind),
      why: "task count is not authority, so nothing is chosen for you",
    };
  }

  // Rungs 3 and 5. GitHub Issues is deliberately not offered here even when it
  // is the only thing found and full of work. The spec wants existing native
  // dependency use *and* a confirmed write scope, and neither is established
  // by counting issues — people file issues without wanting an agent closing
  // them. Saying so beats falling through in silence, which would read as
  // "nothing found" to someone looking at 112 open issues.
  const issues = detections.find(one => one.kind === "github-issues");
  if (issues !== undefined && isPopulated(issues)) {
    return {
      action: "built-in",
      why: "GitHub Issues is the only tracker here, and is never scheduled from without you saying so; the built-in store is the fallback and is not built yet",
    };
  }

  return {
    action: "built-in",
    why: "no repo-local tracker found; the built-in store is the fallback and is not built yet",
  };
}

/**
 * Populated means its data is present, not that we managed to count it. A
 * tracker whose runtime is missing still holds the operator's work, and
 * hiding it because we could not read it would be the silence this tool
 * exists to break.
 */
function isPopulated(detection: Detection): boolean {
  return detection.repos.length > 0 && (detection.count === null || detection.count.value > 0);
}

function runtimeWord(detection: Detection): string {
  const { runtime } = detection;
  return runtime.state === "ok" && runtime.version !== null
    ? `its runtime answers (${runtime.version})`
    : "its runtime answers";
}

function blockedWord(detection: Detection): string {
  if (detection.runtime.state === "missing") return `${detection.runtime.binary} is not on PATH`;
  if (detection.deps !== "native") return "its dependency edges are unverified";
  return "it is not dispatchable";
}

