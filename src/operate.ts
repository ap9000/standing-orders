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

import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  openStore,
  databasePath,
  BUILT_IN,
  DEFAULT_ACTOR,
  type Store,
  type TaskState,
} from "./store.js";
import { acquire, heartbeat, release, reap, currentClaim, DEFAULT_LEASE_MS } from "./claim.js";
import {
  proposeGrant,
  describeGrant,
  describeWithheld,
  permits,
  MUTATION_CLASSES,
  DEFAULT_MUTATIONS,
  type MutationClass,
} from "./grant.js";
import { builtIn, guarded, type GraphBackend } from "./backend.js";
import {
  register,
  authenticate,
  heartbeat as heartbeatRunner,
  isAlive,
  recoverDead,
} from "./runner.js";
import { propose, approve, addApprover, describeScope, approvalOf } from "./scope.js";
import { WorktreePool } from "./worktree.js";
import { build } from "./builder.js";
import { beads } from "./beads.js";
import { githubIssues } from "./issues.js";

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

Runners — the machines that may be given work
  nightorders runner register <name> [--capacity <n>]
                                        mints a token, shown once
  nightorders runner list               who is registered, and answering
  nightorders runner heartbeat <name> --token <token>
  nightorders runner reap               take back what a dead runner held
  nightorders runner retire <name>

Write access — discovery stays read-only until you grant it
  nightorders enroll [repo] --backend <name> --paths <p>[,<p>]
                                        show what it would grant; --yes agrees
  nightorders grants                    what has been granted, and to what
  nightorders revoke [repo] --backend <name>

  --allow <a,b>     mutation classes (default: ${DEFAULT_MUTATIONS.join(",")})
  --selector ours|all   which tasks (default: ours — never a whole backlog)
  --credentials <name>  which credential scope it may use

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
  const wantsValue = new Set([
    "key", "db", "runner", "ttl", "state", "on", "reason", "until", "id", "backend",
    "allow", "selector", "paths", "credentials", "repo", "token", "capacity",
    "goal", "not", "touches", "by", "digest", "as", "branch", "pool", "base", "model", "turns",
  ]);

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
      return readyCommand(flags, context);
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
    case "runner":
      return runnerCommand(positional, flags, context);
    case "approver":
      return approverCommand(positional, flags, context);
    case "build":
      return buildCommand(positional, flags, context);
    case "enroll":
      return enrollCommand(positional, flags, context);
    case "grants":
      return grantsCommand(context);
    case "revoke":
      return revokeCommand(positional, flags, context);
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

/**
 * The backend a command is talking to, already wrapped in its guard.
 *
 * Constructed here rather than at each call site so that no command can
 * accidentally reach an adapter that has not been through `guarded` — the
 * unguarded constructors exist for tests and for this function, and for
 * nothing else.
 */
function openBackend(name: string, store: Store, repo: string): GraphBackend | null {
  if (name === BUILT_IN) return builtIn(store);
  if (name === "beads") return guarded(beads({ repo }), { store, repo });
  if (name === "github-issues") return guarded(githubIssues({ repo }), { store, repo });
  return null;
}

/** The repository a backend command applies to, normalised like the grant is. */
function repoFrom(flags: Map<string, string | true>): string {
  return resolve(text(flags, "repo") ?? process.cwd());
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
async function readyCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const backendName = text(flags, "backend") ?? BUILT_IN;

  // An external tracker is asked directly. This is a network or subprocess
  // round trip and is deliberately not somewhere a scheduler should sit in a
  // tight loop — §4 wants a materialised snapshot for that, which belongs with
  // the scheduler rather than here.
  if (backendName !== BUILT_IN) {
    const repo = repoFrom(flags);
    const backend = openBackend(backendName, store, repo);
    if (backend === null) {
      return fail(write, json, "ready", "usage", `no backend \`${backendName}\``, EXIT.usage);
    }

    const result = await backend.listReady();
    if (!result.ok) return fail(write, json, "ready", result.reason, result.message, EXIT.failed);

    const tasks = result.value;
    if (json) {
      write(JSON.stringify({ ok: tasks.length > 0, command: "ready", backend: backendName, count: tasks.length, tasks }, null, 2));
      return tasks.length > 0 ? EXIT.ok : EXIT.refused;
    }
    if (tasks.length === 0) {
      write(`Nothing is ready in ${backendName}.`);
      return EXIT.refused;
    }
    write(`${tasks.length} ready in ${backendName}:`);
    for (const task of tasks) write(`  ${task.id}  ${task.title}`);
    return EXIT.ok;
  }

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

  if (id === undefined) return fail(write, json, "claim", "usage", "which task? `nightorders claim <id> --runner <name> --token <token>`", EXIT.usage);
  if (runner === undefined) return fail(write, json, "claim", "usage", "--runner names who is taking it", EXIT.usage);

  // Taking work requires proving who you are. Accepting a runner *name* alone
  // would make the credential decorative: anyone who could reach the queue
  // could mint leases under somebody else's identity, and the fencing that
  // protects those leases would be protecting the wrong thing. This is what
  // "auth from the first commit" is for — it is only cheap now.
  const token = text(flags, "token");
  if (token === undefined) {
    return fail(write, json, "claim", "usage", "--token proves the runner is who it says", EXIT.usage);
  }
  const auth = authenticate(store, runner, token);
  if (!auth.ok) {
    return fail(write, json, "claim", auth.reason, describeAuth(auth.reason, runner), EXIT.refused);
  }

  const backend = text(flags, "backend") ?? BUILT_IN;
  if (backend === BUILT_IN && store.getTask(id) === null) {
    return fail(write, json, "claim", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const ttl = readTtl(flags);
  if (ttl === null) return fail(write, json, "claim", "usage", "--ttl takes whole seconds", EXIT.usage);

  // Taking a task in somebody else's tracker is a write to it — the claim
  // transitions their task and, for a repo-local backend, touches their files.
  // So this is where the grant is checked rather than assumed, and the
  // built-in store is exempt because it is ours by construction.
  if (backend !== BUILT_IN) {
    // Resolved, because `enroll` resolves too. Storing a grant under an
    // absolute path and looking it up under `.` denies a permission that was
    // genuinely given, which is a failure mode that looks exactly like the
    // security check working and is therefore the hardest kind to diagnose.
    const repo = resolve(text(flags, "repo") ?? process.cwd());
    const verdict = permits(store.grantFor(repo, backend), {
      repo,
      backend,
      mutation: "transition",
      // Read from the store, never from the caller: a rule that says "only our
      // tasks" while letting the asker declare which those are is not a rule.
      origin: store.originOf(backend, id),
    });
    if (!verdict.ok) {
      return fail(write, json, "claim", verdict.reason, verdict.message, EXIT.refused);
    }
  }

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

// ---- runners --------------------------------------------------------------

/**
 * Registering, checking in, and taking back what a dead machine was holding.
 *
 * The token is printed once and never again — there is no command that
 * recovers it, because a control plane able to hand back a runner's credential
 * is one whose database is worth stealing.
 */
function runnerCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const [action, name] = positional;

  if (action === "list" || action === undefined) {
    const runners = store.listRunners().map(one => ({ ...one, alive: isAlive(one, now) }));
    if (json) {
      write(JSON.stringify({ ok: true, command: "runner list", count: runners.length, runners }, null, 2));
      return EXIT.ok;
    }
    if (runners.length === 0) {
      write("No runners registered.");
      write("  nightorders runner register <name>");
      return EXIT.ok;
    }
    for (const one of runners) {
      write(`  ${one.name}  ${one.alive ? "alive" : "not answering"}  last heard ${one.heartbeatAt}`);
    }
    return EXIT.ok;
  }

  if (action === "register") {
    if (name === undefined) {
      return fail(write, json, "runner register", "usage", "a runner needs a name", EXIT.usage);
    }
    const capacity = Number(text(flags, "capacity") ?? "1");
    if (!Number.isInteger(capacity) || capacity < 1) {
      return fail(write, json, "runner register", "usage", "--capacity is a whole number of tasks", EXIT.usage);
    }

    const { runner, token, reclaimed } = register(store, {
      name,
      host: hostname(),
      capacity,
      now,
      mutation: mutationFrom(flags, now),
    });

    return succeed(write, json, "runner register", { runner, token, reclaimed }, () => [
      `Registered ${runner.name} on ${runner.host}, capacity ${runner.capacity}.`,
      "",
      `  token  ${token}`,
      "",
      "That token is shown once and is not stored — only a hash of it is.",
      "If it is lost, register again to mint a new one.",
      // Taking work back from the previous holder of this name is a side
      // effect somebody should hear about, not one they discover later from a
      // task that mysteriously requeued itself.
      ...(reclaimed === null
        ? []
        : [
            "",
            `A previous ${runner.name} was still holding work; it has been taken back:`,
            ...reclaimed.claims.map(lease => `  claim     ${lease}`),
            ...reclaimed.worktrees.map(path => `  worktree  ${path} (unverified)`),
          ]),
    ]);
  }

  if (action === "heartbeat") {
    const token = text(flags, "token");
    if (name === undefined || token === undefined) {
      return fail(write, json, "runner heartbeat", "usage", "`runner heartbeat <name> --token <token>`", EXIT.usage);
    }

    const result = heartbeatRunner(store, name, token, now);
    if (!result.ok) {
      return fail(write, json, "runner heartbeat", result.reason, describeAuth(result.reason, name), EXIT.refused);
    }
    return succeed(write, json, "runner heartbeat", { runner: result.runner }, () => [
      `${name} checked in.`,
    ]);
  }

  if (action === "reap") {
    // Claims and worktrees together: they are two halves of one fact, and
    // recovering only one leaves a task dispatchable with its working copy
    // still checked out to a process that no longer exists.
    const recovered = recoverDead(store, now).filter(
      one => one.claims.length > 0 || one.worktrees.length > 0,
    );

    if (json) {
      write(JSON.stringify({ ok: true, command: "runner reap", recovered }, null, 2));
      return EXIT.ok;
    }
    if (recovered.length === 0) {
      write("Every runner is answering, or held nothing.");
      return EXIT.ok;
    }
    for (const one of recovered) {
      write(`${one.runner} is not answering — took back:`);
      for (const lease of one.claims) write(`  claim     ${lease}`);
      for (const path of one.worktrees) write(`  worktree  ${path} (unverified)`);
    }
    return EXIT.ok;
  }

  if (action === "retire") {
    if (name === undefined) {
      return fail(write, json, "runner retire", "usage", "which runner?", EXIT.usage);
    }
    const retired = store.retireRunner(name, now, mutationFrom(flags, now));
    if (!retired) {
      return fail(write, json, "runner retire", "unknown", `no runner \`${name}\``, EXIT.refused);
    }
    return succeed(write, json, "runner retire", { name }, () => [`${name} is retired.`]);
  }

  return fail(
    write,
    json,
    "runner",
    "usage",
    `unknown \`runner ${action}\` — try list, register, heartbeat, reap, retire`,
    EXIT.usage,
  );
}

function describeAuth(reason: string, name: string): string {
  if (reason === "unknown") return `no runner \`${name}\` — register it first`;
  if (reason === "retired") return `${name} has been retired`;
  return "that token does not match";
}

/**
 * Dispatch one task to a builder: lease a checkout, run it, hand it back.
 *
 * Every gate lives in `build()` rather than here, so this cannot forget one.
 * What this owns is the worktree lifecycle around it — including handing the
 * checkout back afterwards, and *not* handing it back when the agent left
 * uncommitted work in it, because that work is somebody's and gets kept.
 */
async function buildCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const id = positional[0];
  const runner = text(flags, "runner");
  const token = text(flags, "token");
  const branch = text(flags, "branch");

  if (id === undefined || runner === undefined || token === undefined || branch === undefined) {
    return fail(write, json, "build", "usage", "`nightorders build <id> --runner <name> --token <t> --branch <b> --repo <path>`", EXIT.usage);
  }

  const auth = authenticate(store, runner, token);
  if (!auth.ok) {
    return fail(write, json, "build", auth.reason, describeAuth(auth.reason, runner), EXIT.refused);
  }

  const repo = repoFrom(flags);
  const pool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");
  const ref = store.refFor(BUILT_IN, id);

  const worktrees = new WorktreePool(store, { root: pool });
  const leased = await worktrees.lease({
    repo,
    branch,
    runner,
    taskRef: ref.id,
    now,
    ...(text(flags, "base") === undefined ? {} : { base: text(flags, "base") as string }),
  });
  if (!leased.ok) {
    return fail(write, json, "build", leased.reason, leased.message, EXIT.refused);
  }

  const result = await build(store, {
    taskId: id,
    taskRef: ref.id,
    runner,
    worktree: leased.worktree.path,
    branch,
    now,
    ...(text(flags, "model") === undefined ? {} : { model: text(flags, "model") as string }),
    ...(text(flags, "turns") === undefined ? {} : { maxTurns: Number(text(flags, "turns")) }),
  });

  // Handed back either way. A tree with work still in it comes back
  // unverified and is reported rather than cleaned.
  const handedBack = await worktrees.release(leased.worktree.path, now);

  if (!result.ok) {
    return fail(write, json, "build", result.reason, result.message, EXIT.refused, {
      worktree: leased.worktree.path,
    });
  }

  return succeed(
    write,
    json,
    "build",
    { ...result, worktree: leased.worktree.path, clean: handedBack.ok },
    () => [
      result.committed
        ? `Built ${id} and committed to ${branch}.`
        : `Built ${id}; the agent changed nothing, which is a real answer.`,
      `  worktree  ${leased.worktree.path}`,
      "",
      result.summary,
      "",
      "Nothing has been pushed. Look at the branch before it goes anywhere.",
    ],
  );
}

// ---- write access ---------------------------------------------------------

/**
 * Hand a repository over, deliberately.
 *
 * Like `link`, this shows what it would do and does nothing without `--yes` —
 * for a stronger reason. `link` writes one file into a directory the operator
 * named; this one is the moment discovery stops being read-only, and the
 * grant's own terms are what somebody is agreeing to. Printing them after the
 * fact would be a receipt, not consent.
 */
async function enrollCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const repo = positional[0] === undefined ? process.cwd() : resolve(positional[0]);
  const backend = text(flags, "backend") ?? BUILT_IN;

  const mutations = readMutations(flags);
  if (mutations === null) {
    return fail(write, json, "enroll", "usage", `--allow takes ${MUTATION_CLASSES.join(", ")}`, EXIT.usage);
  }

  const selectorFlag = text(flags, "selector") ?? "ours";
  if (selectorFlag !== "ours" && selectorFlag !== "all") {
    return fail(write, json, "enroll", "usage", "--selector is `ours` or `all`", EXIT.usage);
  }

  const paths = readPaths(flags, backend);
  if (paths.length === 0) {
    return fail(
      write,
      json,
      "enroll",
      "usage",
      `--paths says what may be written for backend \`${backend}\``,
      EXIT.usage,
    );
  }

  const grant = await proposeGrant({
    repo,
    backend,
    paths,
    mutations,
    selector: selectorFlag,
    credentialScope: text(flags, "credentials") ?? null,
    now,
  });

  if (!flags.has("yes")) {
    if (json) {
      write(JSON.stringify({ ok: false, command: "enroll", reason: "unconfirmed", grant }, null, 2));
      return EXIT.refused;
    }
    write("Would grant write access:");
    write("");
    for (const line of describeGrant(grant)) write(line);
    for (const line of describeWithheld(grant)) write(line);
    write("");
    write("Nothing has been granted. Re-run with --yes to agree to this.");
    return EXIT.ok;
  }

  store.saveGrant(grant, mutationFrom(flags, now));

  return succeed(write, json, "enroll", { grant }, () => [
    `Granted. Night Orders may now write to ${backend} in ${repo}.`,
    ...describeGrant(grant),
    ...describeWithheld(grant),
    "",
    "Take it back with `nightorders revoke`.",
  ]);
}

function grantsCommand(context: Context): number {
  const { store, write, json } = context;
  const grants = store.listGrants();

  if (json) {
    write(JSON.stringify({ ok: true, command: "grants", count: grants.length, grants }, null, 2));
    return EXIT.ok;
  }
  if (grants.length === 0) {
    write("Nothing is enrolled. Discovery is read-only until something is.");
    write("  nightorders enroll <repo> --backend <name> --paths <path>");
    return EXIT.ok;
  }
  for (const grant of grants) {
    write(`${grant.repo}  ${grant.backend}`);
    for (const line of describeGrant(grant).slice(2)) write(line);
    write("");
  }
  return EXIT.ok;
}

function revokeCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const repo = positional[0] === undefined ? process.cwd() : resolve(positional[0]);
  const backend = text(flags, "backend") ?? BUILT_IN;

  // No --yes here on purpose: taking permission away is the safe direction,
  // and a confirmation prompt on the brakes is how people stop using them.
  const revoked = store.revokeGrant(repo, backend, mutationFrom(flags, now));
  if (!revoked) {
    return fail(write, json, "revoke", "no-grant", `${repo} was not enrolled for ${backend}`, EXIT.refused);
  }

  return succeed(write, json, "revoke", { repo, backend }, () => [
    `Revoked. ${backend} in ${repo} is read-only again.`,
  ]);
}

/** null when a name was given that is not a mutation class. */
function readMutations(flags: Map<string, string | true>): MutationClass[] | null {
  const given = text(flags, "allow");
  if (given === undefined) return [...DEFAULT_MUTATIONS];

  const wanted = given.split(",").map(one => one.trim()).filter(Boolean);
  if (wanted.some(one => !MUTATION_CLASSES.includes(one as MutationClass))) return null;
  return wanted as MutationClass[];
}

/**
 * What may be written. The built-in store is ours and needs no path, so it
 * gets one implicitly; every other backend has to be told, because guessing
 * where somebody's tracker keeps its data and then writing there is exactly
 * the move this whole module exists to prevent.
 */
function readPaths(flags: Map<string, string | true>, backend: string): string[] {
  const given = text(flags, "paths");
  if (given !== undefined) return given.split(",").map(one => one.trim()).filter(Boolean);
  return backend === BUILT_IN ? [BUILT_IN] : [];
}

// ---- authoring ------------------------------------------------------------

function taskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number | Promise<number> {
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
    case "scope":
      return scopeTask(rest, flags, context);
    case "approve":
      return approveTask(rest, flags, context);
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

async function addTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const title = positional.join(" ").trim();
  if (title === "") return fail(write, json, "task add", "usage", "a task needs a title", EXIT.usage);

  const backendName = text(flags, "backend") ?? BUILT_IN;
  if (backendName !== BUILT_IN) {
    const repo = repoFrom(flags);
    const backend = openBackend(backendName, store, repo);
    if (backend === null) {
      return fail(write, json, "task add", "usage", `no backend \`${backendName}\``, EXIT.usage);
    }

    const created = await backend.create({ title });
    if (!created.ok) {
      // A denial is a refusal, not a breakage: the tool worked exactly as
      // asked and the answer is that permission was never given.
      const code = created.reason === "denied" ? EXIT.refused : EXIT.failed;
      return fail(write, json, "task add", created.reason, created.message, code);
    }

    // Created through Night Orders, so it is ours — recorded here rather than
    // asserted later, which is what the grant's default selector rests on.
    store.refFor(backendName, created.value, "ours");
    return succeed(write, json, "task add", { id: created.value, backend: backendName }, () => [
      `Filed ${created.value} in ${backendName}.`,
    ]);
  }

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
  const scope = store.getScope(id);
  const detail = {
    task,
    ref: ref.id,
    blockedBy: store.blockers(id),
    hold: store.activeHold(ref.id, now),
    claim: currentClaim(store, ref.id, now),
    scope,
    approval: approvalOf(scope),
  };

  return succeed(write, json, "task show", detail, () => [
    `${task.id}  ${task.state}`,
    `  ${task.title}`,
    ...(detail.blockedBy.length > 0 ? [`  waits for ${detail.blockedBy.join(", ")}`] : []),
    ...(detail.hold === null ? [] : [`  held: ${detail.hold.reason}`]),
    ...(detail.claim === null ? [] : [`  claimed by ${detail.claim.runner} until ${detail.claim.expiresAt}`]),
    ...(scope === null
      ? ["  no scope — nothing will build this until one is written and approved"]
      : describeScope(scope)),
  ]);
}

async function stateTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const [id, state] = positional;
  if (id === undefined || state === undefined) {
    return fail(write, json, "task state", "usage", "`nightorders task state <id> <state>`", EXIT.usage);
  }
  if (!STATES.includes(state as TaskState)) {
    return fail(write, json, "task state", "usage", `state is one of ${STATES.join(", ")}`, EXIT.usage);
  }

  const backendName = text(flags, "backend") ?? BUILT_IN;
  if (backendName !== BUILT_IN) {
    const repo = repoFrom(flags);
    const backend = openBackend(backendName, store, repo);
    if (backend === null) {
      return fail(write, json, "task state", "usage", `no backend \`${backendName}\``, EXIT.usage);
    }

    const moved = await backend.setState(id, state as TaskState);
    if (!moved.ok) {
      const code = moved.reason === "denied" || moved.reason === "unsupported" ? EXIT.refused : EXIT.failed;
      return fail(write, json, "task state", moved.reason, moved.message, code);
    }
    return succeed(write, json, "task state", { id, state, backend: backendName }, () => [
      `${id} is now ${state} in ${backendName}.`,
    ]);
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

/**
 * Write down what a task is allowed to become.
 *
 * Proposing never approves. The two are separate commands because they are
 * separate acts by, usually, separate parties: an agent may draft a scope, and
 * only a person may agree to it.
 */
function scopeTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  const goal = text(flags, "goal");
  if (id === undefined || goal === undefined) {
    return fail(write, json, "task scope", "usage", "`nightorders task scope <id> --goal <what success is>`", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task scope", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const touches = (text(flags, "touches") ?? "").split(",").map(one => one.trim()).filter(Boolean);
  const scope = propose(store, {
    taskId: id,
    goal,
    outOfScope: text(flags, "not") ?? null,
    touches,
    now,
    mutation: mutationFrom(flags, now),
  });

  return succeed(write, json, "task scope", { scope }, () => [
    `Scope written for ${id}. Nothing will build it until somebody approves it.`,
    ...describeScope(scope),
    "",
    `  nightorders task approve ${id} --yes`,
  ]);
}

/**
 * A person says yes.
 *
 * `--yes` is required for the same reason `enroll` requires it: this is the
 * moment an agent is allowed to write code against somebody's repository, and
 * a command that did it as a side effect of being run would be the wrong shape
 * entirely.
 */
function approveTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  if (id === undefined) {
    return fail(write, json, "task approve", "usage", "which task?", EXIT.usage);
  }

  const scope = store.getScope(id);
  if (scope === null) {
    return fail(write, json, "task approve", "no-scope", `${id} has no scope to approve — write one first`, EXIT.refused);
  }

  const saw = text(flags, "digest");
  const asWho = text(flags, "as");
  const token = text(flags, "token");

  if (!flags.has("yes") || saw === undefined || asWho === undefined || token === undefined) {
    if (json) {
      write(JSON.stringify({ ok: false, command: "task approve", reason: "unconfirmed", scope }, null, 2));
      return EXIT.refused;
    }
    write(`Would approve this, and let a builder work on ${id}:`);
    write("");
    for (const line of describeScope(scope)) write(line);
    write("");
    write("Nothing has been approved. Agree to this exact scope with:");
    write(`  nightorders task approve ${id} --yes --digest ${scope.digest} --as <you> --token <token>`);
    return EXIT.ok;
  }

  // The digest is named rather than assumed, so an operator who read one scope
  // cannot approve a different one that replaced it while they were reading.
  // The credential is required for a different reason: an agent that can run
  // these commands can read the digest out of `task show`, and an approval
  // nobody has to authenticate would let it agree to its own brief.
  const approved = approve(store, id, asWho, now, saw, token, mutationFrom(flags, now));
  if (!approved.ok) {
    return fail(write, json, "task approve", approved.reason, describeApproveFailure(approved.reason, id), EXIT.refused);
  }

  return succeed(write, json, "task approve", { scope: approved.scope }, () => [
    `Approved. A builder may now work on ${id}, within this scope:`,
    ...describeScope(approved.scope),
  ]);
}

function describeApproveFailure(reason: string, id: string): string {
  if (reason === "changed") return "the scope changed since you read it — look again before approving";
  if (reason === "no-approvers") {
    return "nobody can approve anything yet — `nightorders approver add <you>` mints the credential that lets a person say yes";
  }
  if (reason === "not-an-approver") return "that is not an approver, or the token does not match";
  return `${id} has no scope to approve`;
}

/**
 * The people allowed to agree to a scope.
 *
 * Kept apart from runners deliberately: a runner credential takes work, and an
 * approver credential agrees to it. One token that did both would collapse the
 * gate into a formality the moment an agent held it.
 */
function approverCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const [action, name] = positional;

  if (action === "list" || action === undefined) {
    const approvers = store.listApprovers();
    if (json) {
      write(JSON.stringify({ ok: true, command: "approver list", approvers }, null, 2));
      return EXIT.ok;
    }
    if (approvers.length === 0) {
      write("Nobody can approve a scope yet, so nothing can be built.");
      write("  nightorders approver add <your name>");
      return EXIT.ok;
    }
    for (const one of approvers) write(`  ${one.name}  since ${one.addedAt}`);
    return EXIT.ok;
  }

  if (action === "add") {
    if (name === undefined) {
      return fail(write, json, "approver add", "usage", "an approver needs a name", EXIT.usage);
    }
    const asWho = text(flags, "as");
    const token = text(flags, "token");
    const by = asWho === undefined || token === undefined ? undefined : { name: asWho, token };

    const added = addApprover(store, name, now, by, undefined, mutationFrom(flags, now));
    if (!added.ok) {
      return fail(
        write,
        json,
        "approver add",
        added.reason,
        "only an existing approver can add another — `--as <you> --token <token>`",
        EXIT.refused,
      );
    }

    return succeed(write, json, "approver add", added, () => [
      `${added.name} may now approve scopes.`,
      "",
      `  token  ${added.token}`,
      "",
      "Shown once, stored only as a hash. Keep it somewhere an agent cannot read:",
      "it is the difference between a person agreeing to the work and the work",
      "agreeing to itself.",
      ...(added.bootstrap
        ? [
            "",
            "This was the first approver, so nothing had to vouch for it. Adding any",
            "further approver now requires an existing one — do this before anything",
            "else can reach this queue.",
          ]
        : []),
    ]);
  }

  return fail(write, json, "approver", "usage", `unknown \`approver ${action}\` — try list or add`, EXIT.usage);
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
