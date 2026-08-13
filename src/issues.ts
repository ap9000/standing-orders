/**
 * GitHub Issues, through `gh`.
 *
 * No new credential: `gh` is already authenticated on any machine where the
 * rest of this tool works, which is the same reason pull requests are read
 * that way. Nothing here holds a token.
 *
 * Two things it deliberately will not do.
 *
 * **It will not write dependency edges.** GitHub grew native `blocked_by`
 * relations and sub-issues, and the design says to use them *where a
 * capability probe confirms them* — including a `gh` new enough to expose the
 * fields. This adapter has confirmed neither the endpoint shape nor the
 * version behaviour against a live repository, so it refuses instead of
 * guessing, and refuses rather than emulating. An invented edge would make our
 * scheduler disagree with what every human on the repository can see.
 *
 * **It will not reach the network on the scheduler's hot path.** Reading is a
 * round trip per repository, and GitHub allows five thousand authenticated
 * requests an hour; a scheduler polling dependencies for a hundred issues once
 * a minute would exhaust that before doing any real work. §4's answer is a
 * materialised snapshot read out of band, which is the scheduler's job to hold
 * — this module just makes each read explicit and bounded so that when the
 * scheduler arrives it is obvious what costs a network call.
 */

import { run } from "./exec.js";
import type { TaskState } from "./store.js";
import type { Deps } from "./graph.js";
import {
  ok,
  no,
  edgesNotEmulated,
  describeFailure,
  parseJson,
  type BackendTask,
  type GraphBackend,
  type Outcome,
  type Runner,
  type TaskSpec,
} from "./backend.js";

const GH = "gh";

/** A network round trip; bounded like the pull request read it sits beside. */
export const ISSUE_TIMEOUT_MS = 20_000;

/** Enough to see a backlog without paginating. */
export const DEFAULT_LIMIT = 100;

export type IssuesOptions = {
  repo: string;
  runner?: Runner;
  limit?: number;
  /** Overridden when a caller is spending a shared budget; see `remote.ts`. */
  timeoutMs?: number;
  /** Whether `gh` is new enough for the dependency fields; see `graph.ts`. */
  deps?: Deps;
};

export function githubIssues(options: IssuesOptions): GraphBackend {
  const {
    repo,
    runner = run,
    limit = DEFAULT_LIMIT,
    timeoutMs = ISSUE_TIMEOUT_MS,
    deps = "unverified",
  } = options;

  const call = (args: readonly string[]) => runner(GH, args, { cwd: repo, timeoutMs });

  return {
    name: "github-issues",
    deps,

    /**
     * Every open issue. Without confirmed edges there is no dependency order
     * to apply, so "ready" here means "open" — which is exactly why a backend
     * in this state is not an autonomous-scheduling default.
     */
    async listReady(): Promise<Outcome<BackendTask[]>> {
      const result = await call([
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        String(limit),
        "--json",
        "number,title,state",
      ]);
      if (result.code !== 0) return no("unreachable", describeFailure(result));

      const parsed = parseJson(result.stdout);
      if (!Array.isArray(parsed)) return no("unreadable", "gh returned something that is not a list");

      return ok(parsed.map(readIssue).filter((task): task is BackendTask => task !== null));
    },

    async get(id: string): Promise<Outcome<BackendTask | null>> {
      const result = await call(["issue", "view", id, "--json", "number,title,state"]);
      // gh returns non-zero for a missing issue, which is an answer rather
      // than a fault: null means "not there", and the caller can tell that
      // apart from "we could not ask".
      if (result.code !== 0) {
        return isMissing(result.stderr) ? ok(null) : no("unreachable", describeFailure(result));
      }

      const task = readIssue(parseJson(result.stdout));
      return task === null ? no("unreadable", "gh returned an issue in a shape we do not know") : ok(task);
    },

    /**
     * `gh issue create` prints the new issue's URL and nothing else, so the
     * number is read back off the end of it. Parsed strictly: a URL we cannot
     * read means we do not know what was created, and reporting a made-up id
     * would be worse than reporting the failure.
     */
    async create(spec: TaskSpec): Promise<Outcome<string>> {
      const result = await call([
        "issue",
        "create",
        "--title",
        spec.title,
        "--body",
        spec.body ?? "Filed by Standing Orders.",
      ]);
      if (result.code !== 0) return no("rejected", describeFailure(result));

      const number = /\/issues\/(\d+)\s*$/.exec(result.stdout.trim());
      if (number?.[1] === undefined) {
        return no("unreadable", "the issue was created, but gh did not print a URL we could read");
      }
      return ok(number[1]);
    },

    /**
     * GitHub has two states, so everything terminal closes and everything
     * else reopens. The mapping is lossy and says so rather than inventing
     * labels to carry the difference — a `failed` task and a `done` one look
     * the same to GitHub, and pretending otherwise would put our vocabulary
     * into somebody else's tracker.
     */
    async setState(id: string, state: TaskState): Promise<Outcome<void>> {
      const closing = state === "done" || state === "failed" || state === "cancelled";
      const result = await call(["issue", closing ? "close" : "reopen", id]);

      if (result.code !== 0) return no("rejected", describeFailure(result));
      return ok(undefined);
    },

    async addEdge(): Promise<Outcome<void>> {
      return edgesNotEmulated("GitHub Issues");
    },
  };
}

function readIssue(record: unknown): BackendTask | null {
  if (typeof record !== "object" || record === null) return null;
  const raw = record as Record<string, unknown>;

  const number = raw["number"];
  if (typeof number !== "number") return null;

  return {
    id: String(number),
    title: typeof raw["title"] === "string" ? raw["title"] : "",
    state: String(raw["state"]).toUpperCase() === "CLOSED" ? "done" : "queued",
  };
}

function isMissing(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("could not resolve") || text.includes("not found");
}
