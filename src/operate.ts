/**
 * The commands that actually move work: authoring tasks, and the claim loop.
 *
 * These are written for an agent first and a person second, because the agent
 * is the one that will run them ten thousand times unattended. Four rules fall
 * out of that, and they are worth stating because each one has a failure it
 * prevents.
 *
 * **Every outcome is data.** `--json` returns the same envelope from every
 * command — `{ ok, command, ... }` — including failures. An agent that has to
 * regex stderr to find out what happened will eventually match the wrong line
 * and act on it.
 *
 * **Exit codes separate "no" from "broken".** Losing a claim race is a correct
 * answer, not an error; so is asking for the ready set and finding it empty. If
 * those exited non-zero alongside real failures, every caller would either stop
 * on a normal outcome or ignore genuine breakage. So: 0 got it, 3 ran fine and
 * the answer is no, 2 you typed it wrong, 1 something broke.
 *
 * **Every mutation takes `--key`.** An agent whose command succeeded but whose
 * output was lost will retry. Without a key that retry is a second, different
 * mutation — a second lease, a second task. With one it is the same answer
 * handed back. This is the single most important flag here.
 *
 * **Nothing ever prompts.** There is no terminal on the other end at 3am.
 */

import { homedir } from "node:os";
import { openStore, databasePath, BUILT_IN, type Store, type TaskState } from "./store.js";
import { acquire, heartbeat, release, reap, currentClaim, DEFAULT_LEASE_MS } from "./claim.js";

export type Write = (line: string) => void;

/**
 * 0 done · 1 broke · 2 bad usage · 3 ran fine, the answer is no.
 *
 * 3 is the one that matters. `nightorders claim` losing a race and
 * `nightorders claim` failing to open the database must not look the same to a
 * caller deciding whether to try the next task or wake somebody up.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

export type OperateOptions = {
  /** Overridden by tests and by an agent that wants its own queue. */
  databaseFile?: string;
  openDatabase?: (file: string) => Store;
  now?: Date;
};

const STATES: readonly TaskState[] = ["queued", "running", "done", "failed", "cancelled"];

export const OPERATE_HELP = `nightorders — operating the queue

  nightorders ready                     what could be dispatched right now
  nightorders task add <title>          queue work
  nightorders task list [--state <s>]   everything, or one state
  nightorders task show <id>
  nightorders task state <id> <state>   queued|running|done|failed|cancelled
  nightorders task block <id> --on <id> <id> waits for <on>
  nightorders task hold <id> --reason <why> [--until <iso>]
  nightorders task unhold <id>

  nightorders claim <id> --runner <name> [--ttl <seconds>]
  nightorders heartbeat <lease>         still working; extends the lease
  nightorders release <lease>           done with it; fenced if superseded
  nightorders reap                      release every lease that ran out

Options
  --json            one envelope per command: { ok, command, ... }
  --key <key>       idempotency key; a retry returns the first answer
  --db <path>       use a different queue
  --backend <name>  which backend the id belongs to (default: built-in)

Exit codes
  0  it happened          2  bad usage
  1  something broke      3  ran fine, the answer is no`;

/** Parsed flags, with the positionals left over. */
type Args = {
  positional: string[];
  flags: Map<string, string | true>;
};

export function parseOperateArgs(argv: readonly string[]): Args | { error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const wantsValue = new Set(["key", "db", "runner", "ttl", "state", "on", "reason", "until", "id", "backend"]);

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!wantsValue.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = argv[++index];
    if (value === undefined) return { error: `--${name} needs a value` };
    flags.set(name, value);
  }

  return { positional, flags };
}

/** Route an `operate` command. Returns the process exit code. */
export async function runOperate(
  command: string,
  argv: readonly string[],
  write: Write,
  options: OperateOptions = {},
): Promise<number> {
  const parsed = parseOperateArgs(argv);
  if ("error" in parsed) return fail(write, false, command, "usage", parsed.error, EXIT.usage);

  const { positional, flags } = parsed;
  const json = flags.has("json");
  const file = text(flags, "db") ?? options.databaseFile ?? databasePath(process.env, homedir());
  const now = options.now ?? new Date();

  let store: Store;
  try {
    store = (options.openDatabase ?? openStore)(file);
  } catch (error) {
    return fail(write, json, command, "database", describe(error), EXIT.failed);
  }

  try {
    return await dispatch(command, positional, flags, { store, write, json, now });
  } catch (error) {
    return fail(write, json, command, "failed", describe(error), EXIT.failed);
  } finally {
    store.close();
  }
}

type Context = { store: Store; write: Write; json: boolean; now: Date };

async function dispatch(
  command: string,
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  switch (command) {
    case "ready":
      return readyCommand(context);
    case "task":
      return taskCommand(positional, flags, context);
    case "claim":
      return claimCommand(positional, flags, context);
    case "heartbeat":
      return leaseCommand("heartbeat", positional, flags, context);
    case "release":
      return leaseCommand("release", positional, flags, context);
    case "reap":
      return reapCommand(context);
    default:
      return fail(
        context.write,
        context.json,
        command,
        "usage",
        `unknown command \`${command}\``,
        EXIT.usage,
      );
  }
}

// ---- the dispatch loop ----------------------------------------------------

/**
 * The ready set: everything a runner could legitimately start on right now.
 *
 * An empty ready set is exit 3 rather than 0. There is nothing wrong, but a
 * caller in a loop needs to tell "here is work" from "there is none" without
 * parsing anything, and the alternative is every scheduler re-implementing
 * that check against an empty array.
 */
function readyCommand(context: Context): number {
  const { store, write, json, now } = context;
  const ready = store.listReady(now);

  if (json) {
    write(JSON.stringify({ ok: ready.length > 0, command: "ready", count: ready.length, tasks: ready.map(ref => describeRef(store, ref, now)) }, null, 2));
    return ready.length > 0 ? EXIT.ok : EXIT.refused;
  }

  if (ready.length === 0) {
    write("Nothing is ready to dispatch.");
    return EXIT.refused;
  }

  write(`${ready.length} ready:`);
  for (const ref of ready) {
    const task = store.getTask(ref.externalId);
    write(`  ${ref.externalId}  ${task === null ? "" : task.title}`);
  }
  return EXIT.ok;
}

function describeRef(store: Store, ref: { externalId: string; backend: string; id: number }, now: Date) {
  const task = store.getTask(ref.externalId);
  return {
    id: ref.externalId,
    ref: ref.id,
    backend: ref.backend,
    title: task?.title ?? null,
    state: task?.state ?? null,
    claim: currentClaim(store, ref.id, now),
  };
}

/**
 * Take a task.
 *
 * The refusal carries who holds it and until when, because a caller that only
 * learns "no" has to poll blindly, while one that learns "runner-b until
 * 22:14" can go and do something else until then.
 */
function claimCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  const runner = text(flags, "runner");

  if (id === undefined) return fail(write, json, "claim", "usage", "which task? `nightorders claim <id> --runner <name>`", EXIT.usage);
  if (runner === undefined) return fail(write, json, "claim", "usage", "--runner names who is taking it", EXIT.usage);

  const backend = text(flags, "backend") ?? BUILT_IN;
  if (backend === BUILT_IN && store.getTask(id) === null) {
    return fail(write, json, "claim", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const ttl = readTtl(flags);
  if (ttl === null) return fail(write, json, "claim", "usage", "--ttl takes whole seconds", EXIT.usage);

  const ref = store.refFor(backend, id);
  const result = acquire(store, ref.id, runner, {
    now,
    ttlMs: ttl,
    mutation: mutationFrom(flags, now),
  });

  if (!result.ok) {
    return fail(
      write,
      json,
      "claim",
      result.reason,
      `held by ${result.by} until ${result.until}`,
      EXIT.refused,
      { holder: result.by, until: result.until },
    );
  }

  // Taking a task is what makes it running; leaving that to the caller would
  // let a claimed task keep showing up as queued to anything reading state.
  store.setTaskState(id, "running", now);

  return succeed(write, json, "claim", { lease: result.claim, reclaimed: result.reclaimed }, () => [
    `Claimed ${id} as ${runner}.`,
    `  lease   ${result.claim.leaseId}`,
    `  expires ${result.claim.expiresAt}`,
  ]);
}

/**
 * Heartbeat and release differ by one word and share every failure mode, so
 * they share a path — including the one that matters, where `fenced` means a
 * runner has been superseded and should stop rather than retry.
 */
function leaseCommand(
  command: "heartbeat" | "release",
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const lease = positional[0];
  if (lease === undefined) return fail(write, json, command, "usage", `which lease? \`nightorders ${command} <lease>\``, EXIT.usage);

  const ttl = readTtl(flags);
  if (ttl === null) return fail(write, json, command, "usage", "--ttl takes whole seconds", EXIT.usage);

  const result =
    command === "heartbeat" ? heartbeat(store, lease, now, ttl) : release(store, lease, now);

  if (!result.ok) {
    const message =
      result.reason === "fenced"
        ? "superseded — another runner holds this task now; stop rather than retry"
        : "no such lease";
    return fail(write, json, command, result.reason, message, EXIT.refused);
  }

  if (command === "release") {
    const task = store.getTask(String(refExternalId(store, result.claim.taskRef)));
    // Releasing says the runner is finished with it, not that it succeeded, so
    // a task left running is put back rather than marked done.
    if (task !== null && task.state === "running") store.setTaskState(task.id, "queued", now);
  }

  return succeed(write, json, command, { lease: result.claim }, () => [
    command === "heartbeat"
      ? `Still yours until ${result.claim.expiresAt}.`
      : `Released ${result.claim.leaseId}.`,
  ]);
}

function reapCommand(context: Context): number {
  const { store, write, json, now } = context;
  const reaped = reap(store, now);

  if (json) {
    write(JSON.stringify({ ok: true, command: "reap", count: reaped.length, released: reaped }, null, 2));
    return EXIT.ok;
  }

  if (reaped.length === 0) {
    write("No leases had run out.");
    return EXIT.ok;
  }
  write(`Released ${reaped.length}:`);
  for (const claim of reaped) write(`  ${claim.leaseId}  held by ${claim.runner}`);
  return EXIT.ok;
}

// ---- authoring ------------------------------------------------------------

function taskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const [action, ...rest] = positional;

  // `task` on its own is somebody asking what this can do, not a mistake.
  if (action === undefined) {
    context.write(OPERATE_HELP);
    return EXIT.ok;
  }

  switch (action) {
    case "add":
      return addTask(rest, flags, context);
    case "list":
      return listTasks(flags, context);
    case "show":
      return showTask(rest, context);
    case "state":
      return stateTask(rest, flags, context);
    case "block":
      return blockTask(rest, flags, context);
    case "hold":
      return holdTask(rest, flags, context);
    case "unhold":
      return unholdTask(rest, flags, context);
    default:
      return fail(
        context.write,
        context.json,
        "task",
        "usage",
        `unknown \`task ${action ?? ""}\` — try add, list, show, state, block, hold, unhold`,
        EXIT.usage,
      );
  }
}

function addTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const title = positional.join(" ").trim();
  if (title === "") return fail(write, json, "task add", "usage", "a task needs a title", EXIT.usage);

  const id = text(flags, "id") ?? slug(title, now);

  // The existence check goes *inside* the replayed body. Outside it, a retry
  // with the same key hits "already exists" and reports failure for a task the
  // first attempt created — which is precisely the retry idempotency exists to
  // make safe. The inner createTask takes no key of its own, so only this
  // outer result is recorded, and only when it succeeded.
  const outcome = store.replay(
    mutationFrom(flags, now),
    "task add",
    () => {
      if (store.getTask(id) !== null) return { ok: false as const };
      return { ok: true as const, task: store.createTask({ id, title }, now) };
    },
    result => result.ok,
  );

  if (!outcome.ok) {
    return fail(write, json, "task add", "exists", `\`${id}\` already exists`, EXIT.refused);
  }
  return succeed(write, json, "task add", { task: outcome.task }, () => [
    `Queued ${outcome.task.id} — ${outcome.task.title}`,
  ]);
}

function listTasks(flags: Map<string, string | true>, context: Context): number {
  const { store, write, json, now } = context;
  const wanted = text(flags, "state");
  if (wanted !== undefined && !STATES.includes(wanted as TaskState)) {
    return fail(write, json, "task list", "usage", `--state takes one of ${STATES.join(", ")}`, EXIT.usage);
  }

  const tasks = store.listTasks(wanted as TaskState | undefined);

  if (json) {
    write(JSON.stringify({ ok: true, command: "task list", count: tasks.length, tasks }, null, 2));
    return EXIT.ok;
  }
  if (tasks.length === 0) {
    write(wanted === undefined ? "The queue is empty." : `Nothing is ${wanted}.`);
    return EXIT.ok;
  }
  const width = Math.max(...tasks.map(task => task.id.length));
  for (const task of tasks) {
    const held = store.activeHold(store.refFor(BUILT_IN, task.id).id, now);
    const suffix = held === null ? "" : `  (held: ${held.reason})`;
    write(`  ${task.id.padEnd(width)}  ${task.state.padEnd(9)}  ${task.title}${suffix}`);
  }
  return EXIT.ok;
}

function showTask(positional: readonly string[], context: Context): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  if (id === undefined) return fail(write, json, "task show", "usage", "which task?", EXIT.usage);

  const task = store.getTask(id);
  if (task === null) return fail(write, json, "task show", "unknown-task", `no task \`${id}\``, EXIT.refused);

  const ref = store.refFor(BUILT_IN, id);
  const detail = {
    task,
    ref: ref.id,
    blockedBy: store.blockers(id),
    hold: store.activeHold(ref.id, now),
    claim: currentClaim(store, ref.id, now),
  };

  return succeed(write, json, "task show", detail, () => [
    `${task.id}  ${task.state}`,
    `  ${task.title}`,
    ...(detail.blockedBy.length > 0 ? [`  waits for ${detail.blockedBy.join(", ")}`] : []),
    ...(detail.hold === null ? [] : [`  held: ${detail.hold.reason}`]),
    ...(detail.claim === null ? [] : [`  claimed by ${detail.claim.runner} until ${detail.claim.expiresAt}`]),
  ]);
}

function stateTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const [id, state] = positional;
  if (id === undefined || state === undefined) {
    return fail(write, json, "task state", "usage", "`nightorders task state <id> <state>`", EXIT.usage);
  }
  if (!STATES.includes(state as TaskState)) {
    return fail(write, json, "task state", "usage", `state is one of ${STATES.join(", ")}`, EXIT.usage);
  }

  const moved = store.setTaskState(id, state as TaskState, now, mutationFrom(flags, now));
  if (!moved) return fail(write, json, "task state", "unknown-task", `no task \`${id}\``, EXIT.refused);

  return succeed(write, json, "task state", { id, state }, () => [`${id} is now ${state}.`]);
}

function blockTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  const on = text(flags, "on");
  if (id === undefined || on === undefined) {
    return fail(write, json, "task block", "usage", "`nightorders task block <id> --on <id>`", EXIT.usage);
  }
  for (const each of [id, on]) {
    if (store.getTask(each) === null) {
      return fail(write, json, "task block", "unknown-task", `no task \`${each}\``, EXIT.refused);
    }
  }

  const result = store.addEdge(id, on, mutationFrom(flags, context.now));
  if (!result.ok) return fail(write, json, "task block", "rejected", result.reason, EXIT.refused);

  return succeed(write, json, "task block", { blocked: id, blocker: on }, () => [
    `${id} now waits for ${on}.`,
  ]);
}

function holdTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  const reason = text(flags, "reason");
  if (id === undefined || reason === undefined) {
    return fail(write, json, "task hold", "usage", "`nightorders task hold <id> --reason <why>`", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task hold", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const untilText = text(flags, "until");
  const until = untilText === undefined ? null : new Date(untilText);
  if (until !== null && Number.isNaN(until.getTime())) {
    return fail(write, json, "task hold", "usage", "--until takes a date, e.g. 2026-08-12T09:00:00Z", EXIT.usage);
  }

  store.hold(store.refFor(BUILT_IN, id).id, reason, until, now, mutationFrom(flags, now));
  return succeed(write, json, "task hold", { id, reason, until: until?.toISOString() ?? null }, () => [
    `${id} is on hold${until === null ? "" : ` until ${until.toISOString()}`}: ${reason}`,
  ]);
}

function unholdTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  if (id === undefined) return fail(write, json, "task unhold", "usage", "which task?", EXIT.usage);
  if (store.getTask(id) === null) {
    return fail(write, json, "task unhold", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const lifted = store.unhold(store.refFor(BUILT_IN, id).id, mutationFrom(flags, context.now));
  if (!lifted) return fail(write, json, "task unhold", "not-held", `${id} was not on hold`, EXIT.refused);

  return succeed(write, json, "task unhold", { id }, () => [`${id} is off hold.`]);
}

// ---- shared ---------------------------------------------------------------

function succeed(
  write: Write,
  json: boolean,
  command: string,
  data: Record<string, unknown>,
  lines: () => string[],
): number {
  write(json ? JSON.stringify({ ok: true, command, ...data }, null, 2) : lines().join("\n"));
  return EXIT.ok;
}

/**
 * Failures are data too. The `reason` is a stable token an agent can branch on
 * — `fenced`, `held`, `unknown-task` — while `message` is for the human who
 * reads the transcript afterwards. Prose changes; tokens must not.
 */
function fail(
  write: Write,
  json: boolean,
  command: string,
  reason: string,
  message: string,
  code: number,
  extra: Record<string, unknown> = {},
): number {
  write(json ? JSON.stringify({ ok: false, command, reason, message, ...extra }, null, 2) : message);
  return code;
}

function text(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/** null means it was given and was not a whole number of seconds. */
function readTtl(flags: Map<string, string | true>): number | null {
  const given = text(flags, "ttl");
  if (given === undefined) return DEFAULT_LEASE_MS;
  const seconds = Number(given);
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  return seconds * 1_000;
}

function mutationFrom(flags: Map<string, string | true>, now: Date) {
  const key = text(flags, "key");
  return key === undefined ? { at: now } : { idempotencyKey: key, at: now };
}

/** Readable, sortable, and unique enough for a queue one person is filling. */
function slug(title: string, now: Date): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  const stamp = now.toISOString().slice(11, 19).replace(/:/g, "");
  return words === "" ? `task-${stamp}` : `${words}-${stamp}`;
}

function refExternalId(store: Store, taskRef: number): string | null {
  return store.externalIdFor(taskRef);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
