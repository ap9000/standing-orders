/**
 * The contract every work graph is driven through, and the guard around it.
 *
 * §4's interface, with one deliberate omission: `hold` is not here. A hold is
 * an operational pause — "not tonight, we are waiting on a person" — and not a
 * claim about how the work is structured, so it lives in the overlay where it
 * costs nobody else's tracker anything. Dependency edges are the opposite, and
 * that asymmetry is the whole rule:
 *
 * **Scheduling edges are never emulated.** A backend with no native edges is
 * *ineligible for dependency scheduling*, not repaired with invisible ones. A
 * private graph is shadow data: teammates and other tools read a task as ready
 * while our overlay privately calls it blocked, and the divergence becomes
 * migration-critical the moment anybody wants out. So `addEdge` on a backend
 * whose edges are unverified refuses, and says why, rather than storing
 * something only we can see.
 *
 * Every method answers with an outcome rather than throwing. These call other
 * people's binaries over other people's networks; failure is a normal Tuesday,
 * and one unreachable backend must not end a run covering four others.
 */

import { BUILT_IN, type Store, type TaskState } from "./store.js";
import type { Deps } from "./graph.js";
import type { ExecResult, RunOptions } from "./exec.js";
import { permits, type MutationClass } from "./grant.js";

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

/** What a backend can tell us about a task, in terms we share across all of them. */
export type BackendTask = {
  id: string;
  title: string;
  state: TaskState;
};

export type TaskSpec = { title: string; body?: string };

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: OutcomeReason; message: string };

/**
 * `unsupported` is not a failure of this run — it is a permanent property of
 * the backend, and a caller should stop asking rather than retry.
 */
export type OutcomeReason =
  | "unsupported"
  | "denied"
  | "unreachable"
  | "unreadable"
  | "rejected";

export interface GraphBackend {
  readonly name: string;
  /** Whether this backend carries dependency edges of its own. */
  readonly deps: Deps;

  listReady(): Promise<Outcome<BackendTask[]>>;
  get(id: string): Promise<Outcome<BackendTask | null>>;
  create(spec: TaskSpec): Promise<Outcome<string>>;
  setState(id: string, state: TaskState): Promise<Outcome<void>>;
  addEdge(blocked: string, blocker: string): Promise<Outcome<void>>;
}

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });

export const no = (reason: OutcomeReason, message: string): Outcome<never> => ({
  ok: false,
  reason,
  message,
});

/**
 * The refusal a backend without confirmed edges gives, spelled once so every
 * adapter says the same thing and nobody is tempted to soften it.
 */
export function edgesNotEmulated(name: string): Outcome<never> {
  return no(
    "unsupported",
    `${name} dependency edges are not confirmed here, and Standing Orders does not invent them — a graph only we can see would read as ready to everyone else`,
  );
}

/** Turn a failed command into words, without pretending to know more than we do. */
export function describeFailure(result: ExecResult): string {
  if (result.notFound) return "the command is not installed";
  if (result.timedOut) return "it timed out";
  const [line = ""] = result.stderr.trim().split("\n");
  return line === "" ? `exit ${result.code}` : line;
}

export function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The built-in store, behind the same contract as everyone else.
 *
 * Worth the wrapper even though it is ours: the scheduler should not be able
 * to tell which backend it is driving, and the day this is the only one with a
 * privileged shortcut is the day the interface stops being tested.
 *
 * It is the only backend here whose edges are both native and ours to write,
 * so it is also the only one where dependency scheduling is unconditionally
 * available.
 */
export function builtIn(store: Store, now: () => Date = () => new Date()): GraphBackend {
  return {
    name: BUILT_IN,
    deps: "native",

    async listReady() {
      const ready = store.listReady(now());
      return ok(
        ready
          .map(ref => store.getTask(ref.externalId))
          .filter((task): task is NonNullable<typeof task> => task !== null)
          .map(task => ({ id: task.id, title: task.title, state: task.state })),
      );
    },

    async get(id) {
      const task = store.getTask(id);
      return ok(task === null ? null : { id: task.id, title: task.title, state: task.state });
    },

    async create(spec) {
      // The id is derived from the title here rather than by the caller, so
      // that every backend's `create` has the same shape: hand it a spec, get
      // an id back.
      const id = `${slug(spec.title)}-${now().toISOString().slice(11, 19).replace(/:/g, "")}`;
      if (store.getTask(id) !== null) return no("rejected", `\`${id}\` already exists`);
      store.createTask({ id, title: spec.title }, now());
      return ok(id);
    },

    async setState(id, state) {
      return store.setTaskState(id, state, now())
        ? ok(undefined)
        : no("rejected", `no task \`${id}\``);
    },

    async addEdge(blocked, blocker) {
      const result = store.addEdge(blocked, blocker);
      return result.ok ? ok(undefined) : no("rejected", result.reason);
    },
  };
}

function slug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return words === "" ? "task" : words;
}

export type GuardOptions = {
  store: Store;
  repo: string;
};

/**
 * Wrap a backend so nothing can write through it without a grant.
 *
 * Applied once, at construction, rather than checked inside each adapter — an
 * authorization that every implementation has to remember to call is one that
 * a future adapter will forget, and it will forget it silently. Here the only
 * way to reach a mutating method is through the wrapper, and adding a backend
 * later inherits the check by construction.
 *
 * Reads pass straight through. Discovery has always been read-only and needs
 * no permission; it is writing to somebody else's tracker that requires one.
 */
export function guarded(backend: GraphBackend, options: GuardOptions): GraphBackend {
  const { store, repo } = options;

  const allowed = (mutation: MutationClass, id?: string): Outcome<never> | null => {
    const verdict = permits(store.grantFor(repo, backend.name), {
      repo,
      backend: backend.name,
      mutation,
      // Read from the overlay, never from the caller. A task we have merely
      // seen is `theirs` until something explicitly makes it ours.
      origin: id === undefined ? "ours" : store.originOf(backend.name, id),
    });
    return verdict.ok ? null : no("denied", verdict.message);
  };

  return {
    name: backend.name,
    deps: backend.deps,

    listReady: () => backend.listReady(),
    get: id => backend.get(id),

    async create(spec) {
      // A task we are about to create is ours by definition; there is no id to
      // ask the overlay about yet, and the selector cannot be what stops it.
      const denied = allowed("create");
      return denied ?? backend.create(spec);
    },

    async setState(id, state) {
      // Closing somebody's issue and moving our own task along are different
      // acts to a person, however alike they look to a database, so they check
      // against different mutation classes.
      const terminal = state === "done" || state === "failed" || state === "cancelled";
      const denied = allowed(terminal ? "close" : "transition", id);
      return denied ?? backend.setState(id, state);
    },

    async addEdge(blocked, blocker) {
      const denied = allowed("edge", blocked);
      return denied ?? backend.addEdge(blocked, blocker);
    },
  };
}
