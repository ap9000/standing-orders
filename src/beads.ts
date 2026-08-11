/**
 * beads, through the `bd` binary already on the machine.
 *
 * Every command here was read out of beads' own documentation rather than
 * guessed at, and the ones that were not are refused instead of attempted.
 * That distinction is the whole design of this file, so it is written down
 * per call:
 *
 *   bd ready --json        confirmed — the ready set, which is the same
 *                          question `list_ready` asks
 *   bd create "<title>"    confirmed
 *   bd close <id>          confirmed
 *   bd dep add <a> <b>     confirmed — native edges, so they are used
 *   bd show <id> --json    the subcommand is confirmed, the --json flag is not
 *   bd update --status     NOT confirmed; only `--claim` appears in the docs
 *
 * Where the flag is unconfirmed the call parses defensively and fails closed
 * with a message naming what could not be established. Writing a plausible
 * flag into somebody's issue tracker and finding out at 3am whether it meant
 * what we hoped is the exact failure this project exists to avoid.
 *
 * Unlike the GitHub adapter, none of this has been exercised against a real
 * installation — `bd` is not present on the machine it was written on. It is
 * built to the documentation, tested against a stubbed runner, and should be
 * treated as unproven until somebody runs it with beads actually installed.
 */

import { run } from "./exec.js";
import type { TaskState } from "./store.js";
import {
  ok,
  no,
  describeFailure,
  parseJson,
  type BackendTask,
  type GraphBackend,
  type Outcome,
  type Runner,
  type TaskSpec,
} from "./backend.js";

const BD = "bd";

/** Local work, so a local bound. */
export const BEADS_TIMEOUT_MS = 10_000;

export type BeadsOptions = {
  repo: string;
  runner?: Runner;
};

export function beads(options: BeadsOptions): GraphBackend {
  const { repo, runner = run } = options;
  const call = (args: readonly string[]) => runner(BD, args, { cwd: repo, timeoutMs: BEADS_TIMEOUT_MS });

  return {
    name: "beads",
    // Confirmed native, and the only backend here with edges we can write.
    deps: "native",

    async listReady(): Promise<Outcome<BackendTask[]>> {
      const result = await call(["ready", "--json"]);
      if (result.code !== 0) return no("unreachable", describeFailure(result));

      const parsed = parseJson(result.stdout);
      if (!Array.isArray(parsed)) return no("unreadable", "bd returned something that is not a list");

      return ok(parsed.map(readIssue).filter((task): task is BackendTask => task !== null));
    },

    async get(id: string): Promise<Outcome<BackendTask | null>> {
      const result = await call(["show", id, "--json"]);
      if (result.code !== 0) return no("unreachable", describeFailure(result));

      const task = readIssue(parseJson(result.stdout));
      if (task === null) {
        return no(
          "unreadable",
          "bd show did not return JSON — this build may not support --json on show",
        );
      }
      return ok(task);
    },

    /**
     * `bd create` is confirmed; what it prints is not. The id is read out of
     * its output if it is there, and the absence of one is reported rather
     * than filled in: a caller holding an id we invented would attach claims
     * and leases to a task that does not exist.
     */
    async create(spec: TaskSpec): Promise<Outcome<string>> {
      const result = await call(["create", spec.title, "--json"]);
      if (result.code !== 0) return no("rejected", describeFailure(result));

      const id = readCreatedId(result.stdout);
      if (id === null) {
        return no(
          "unreadable",
          "bd created the task but did not print an id we could read — check `bd ready` for it",
        );
      }
      return ok(id);
    },

    /**
     * Only closing is confirmed. Everything else would need `bd update` with a
     * status flag that this adapter has not established exists, and guessing
     * at it is how a queue quietly fills with tasks in a state nobody meant.
     */
    async setState(id: string, state: TaskState): Promise<Outcome<void>> {
      if (state !== "done" && state !== "cancelled" && state !== "failed") {
        return no(
          "unsupported",
          `beads: only closing is confirmed here, so \`${state}\` is not applied — the flag for it has not been established`,
        );
      }

      const result = await call(["close", id]);
      if (result.code !== 0) return no("rejected", describeFailure(result));
      return ok(undefined);
    },

    /** `bd dep add <child> <parent>`: the child waits for the parent. */
    async addEdge(blocked: string, blocker: string): Promise<Outcome<void>> {
      const result = await call(["dep", "add", blocked, blocker]);
      if (result.code !== 0) return no("rejected", describeFailure(result));
      return ok(undefined);
    },
  };
}

/** beads ids are its own; only their shape is assumed, never their meaning. */
function readIssue(record: unknown): BackendTask | null {
  if (typeof record !== "object" || record === null) return null;
  const raw = record as Record<string, unknown>;

  const id = raw["id"];
  if (typeof id !== "string" && typeof id !== "number") return null;

  return {
    id: String(id),
    title: typeof raw["title"] === "string" ? raw["title"] : "",
    state: readState(raw["status"] ?? raw["state"]),
  };
}

/**
 * beads' status vocabulary is not documented in full, so this maps the values
 * that are, and treats anything unrecognised as queued rather than inventing a
 * meaning for it. Being wrong toward "still to do" leaves work visible; being
 * wrong toward "done" loses it.
 */
function readState(value: unknown): TaskState {
  const text = String(value ?? "").toLowerCase();
  if (text === "closed" || text === "done") return "done";
  if (text === "in_progress" || text === "in-progress") return "running";
  return "queued";
}

function readCreatedId(stdout: string): string | null {
  const parsed = parseJson(stdout);
  if (typeof parsed === "object" && parsed !== null) {
    const id = (parsed as Record<string, unknown>)["id"];
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  // Falls back to the id-shaped token beads prints in its examples (bd-a1b2).
  const printed = /\b(bd-[a-z0-9]+)\b/i.exec(stdout);
  return printed?.[1] ?? null;
}
