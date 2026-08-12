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
  parseCapabilityKey,
  type Capability,
  type Store,
  type TaskState,
} from "./store.js";
import { probeRepo, isVerified } from "./probe.js";

type CapabilityKind = Capability["kind"];
import {
  acquire,
  acquireIfReady,
  completeFenced,
  heartbeat,
  release,
  reap,
  currentClaim,
  DEFAULT_LEASE_MS,
} from "./claim.js";
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
import {
  build,
  DEFAULT_BUILD_TIMEOUT_MS,
  type Runner as CommandRunner,
} from "./builder.js";
import { run } from "./exec.js";
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
  /**
   * Injected by tests: the processes `tick` and `build` run. The agent runner
   * is what spends money, so a test that forgets to stub it fails loudly on a
   * missing `claude` binary rather than quietly building something.
   */
  agentRunner?: CommandRunner;
  gitRunner?: CommandRunner;
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

  nightorders tick --runner <name> --token <t> --repo <path>
                                        one unattended pass: claim what is
                                        ready and approved, build it in a
                                        leased worktree, commit to a branch.
                                        [--max <n>] tasks (default 1),
                                        [--base <ref>] for first attempts.
                                        Never pushes.
  nightorders reconcile --repo <path>   the morning sweep: recover dead
                                        runners, reap expired leases, adopt
                                        or forget orphaned worktrees. Run it
                                        before tick.

Capabilities — what the work needs, recorded and probed, never valued
  nightorders cap add <name> [--kind env|cli|mcp|ci|other] [--probe <cmd>]
                                        env kind synthesizes test -n "$NAME"
  nightorders cap list [--repo <path>]
  nightorders cap probe [<kind:name>…]  ask the environment; exit 0 all
                                        verified, 3 any gap
  nightorders task require <id> --cap <kind:name>[,…]
                                        nothing dispatches it until every
                                        one is verified (--cap none clears)
  nightorders gaps [--repo <path>]      what is missing, ranked by how many
                                        tasks filling it would start

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
    "max", "cap", "probe", "kind", "expires",
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

  // One `Date` per command is fine for a lookup and wrong for a pass that
  // runs an agent for half an hour: leases granted, extended, and released
  // with the same stale stamp. Injected time stays frozen — a test's clock
  // must not advance under it — while real time is read again at each step.
  const clock = options.now === undefined ? () => new Date() : () => now;

  try {
    return await dispatch(command, positional, flags, {
      store,
      write,
      json,
      now,
      clock,
      ...(options.agentRunner === undefined ? {} : { agentRunner: options.agentRunner }),
      ...(options.gitRunner === undefined ? {} : { gitRunner: options.gitRunner }),
    });
  } catch (error) {
    return fail(write, json, command, "failed", describe(error), EXIT.failed);
  } finally {
    store.close();
  }
}

type Context = {
  store: Store;
  write: Write;
  json: boolean;
  now: Date;
  clock: () => Date;
  agentRunner?: CommandRunner;
  gitRunner?: CommandRunner;
};

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
    case "tick":
      return tickCommand(flags, context);
    case "reconcile":
      return reconcileCommand(flags, context);
    case "cap":
      return capCommand(positional, flags, context);
    case "gaps":
      return gapsCommand(flags, context);
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

// ---- the unattended pass --------------------------------------------------

/** What happened to one task this pass looked at. */
type TickOutcome = {
  id: string;
  outcome: "built" | "skipped" | "failed";
  /** Why it was skipped or how it failed; absent on a build. */
  reason?: string;
  /** The gap's own words, when the reason is a capability. */
  detail?: string;
  committed?: boolean;
  branch?: string;
  worktree?: string;
};

/**
 * One scheduling pass: the M1 loop, without the human typing each step.
 *
 * This is deliberately a pass and not a daemon. M4 owns the loop, the failure
 * taxonomy, and the economics of staying awake; what M1 needs is that a task
 * can go queued → branch → commit with nobody present, and a single pass a
 * cron job can call is the smallest honest shape of that. Run it twice and
 * the fences hold: the second pass finds the first's claims and skips them.
 *
 * The pass never decides what to build — only whether each ready task has
 * already been agreed to. Approval is checked here once to avoid burning a
 * claim on a task the builder would refuse, and checked again inside
 * `build()`, which trusts no caller, this one included.
 *
 * Refusals are sorted by what they mean, not treated alike:
 *
 *   unapproved, scope-changed   waiting on a person — left queued, untouched
 *   lease/branch invariants     this machine's problem — left queued, pass fails
 *   agent, timeout, git         the attempt itself broke — task marked failed
 *
 * The lease is granted for longer than the build may run, so a healthy build
 * cannot outlive its own claim and be reaped mid-commit by the next pass.
 */
async function tickCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const runner = text(flags, "runner");
  const token = text(flags, "token");

  if (runner === undefined || token === undefined) {
    return fail(write, json, "tick", "usage", "`nightorders tick --runner <name> --token <t> --repo <path> [--max <n>] [--base <ref>]`", EXIT.usage);
  }

  // Heartbeat rather than bare auth: a pass that is about to hold leases for
  // half an hour should also be on record as alive.
  const auth = heartbeatRunner(store, runner, token, clock());
  if (!auth.ok) {
    return fail(write, json, "tick", auth.reason, describeAuth(auth.reason, runner), EXIT.refused);
  }

  const maxGiven = text(flags, "max");
  const max = maxGiven === undefined ? 1 : Number(maxGiven);
  if (!Number.isInteger(max) || max <= 0) {
    return fail(write, json, "tick", "usage", "--max takes a whole number of tasks", EXIT.usage);
  }

  const repo = repoFrom(flags);
  const pool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");
  const model = text(flags, "model");
  const turns = text(flags, "turns");
  const timeoutMs = DEFAULT_BUILD_TIMEOUT_MS;
  // The ordinary lease is enough: the build's own pulse extends it while the
  // agent runs, which is the correct causality — the lease stays alive
  // because the build is alive. A fat TTL would only mask a dead pulse and
  // delay recovery by exactly its margin.
  const leaseTtlMs = DEFAULT_LEASE_MS;

  const git = context.gitRunner ?? run;
  const worktrees = new WorktreePool(store, {
    root: pool,
    ...(context.gitRunner === undefined ? {} : { runner: context.gitRunner }),
  });

  // Where a first attempt's branch grows from, resolved once per pass. A
  // detached HEAD refuses the pass rather than guessing: an unattended commit
  // onto "wherever the operator happened to be" is not a default.
  let base = text(flags, "base");
  if (base === undefined) {
    const head = await git("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: repo });
    if (head.code !== 0 || head.stdout.trim() === "") {
      return fail(write, json, "tick", "git", `${repo} has no branch checked out — say --base explicitly`, EXIT.refused);
    }
    base = head.stdout.trim();
  }

  // Probes run at every checkpoint (§3): a key revoked overnight is caught
  // here, before any claim exists — not by the agent, forty thousand tokens
  // in. Statuses land in the store; the gate inside the claim transaction is
  // what acts on them.
  await probeRepo(store, repo, runner, clock());

  const ready = store.listReady(clock());
  const considered = ready.length;
  const dispatched: TickOutcome[] = [];
  let built = 0;
  let broke = 0;

  for (const ref of ready) {
    if (built >= max) break;
    const id = ref.externalId;

    // A task placed in another repository is not this pass's to build.
    if (ref.repo !== null && ref.repo !== repo) {
      dispatched.push({ id, outcome: "skipped", reason: "other-repo" });
      continue;
    }

    // Skip, not refuse: an unapproved task in the ready set is a person's
    // pending decision, and the pass reports it rather than spending on it.
    if (!approvalOf(store.getScope(id)).approved) {
      dispatched.push({ id, outcome: "skipped", reason: "unapproved" });
      continue;
    }

    const claimed = acquireIfReady(store, ref.id, runner, { now: clock(), ttlMs: leaseTtlMs, repo });
    if (!claimed.ok) {
      // Losing a race, finding the task no longer ready, and a machine that
      // lacks what the task needs are all the system working. None fails the
      // pass; a capability gap names itself so the gaps report can too.
      dispatched.push({
        id,
        outcome: "skipped",
        reason: claimed.reason,
        ...("message" in claimed && claimed.reason === "capability" ? { detail: claimed.message } : {}),
      });
      continue;
    }
    const lease = claimed.claim.leaseId;
    const branch = `nightorders/${id}`;

    // A retry of this task reuses its branch; a first attempt creates it from
    // base. Suffixing instead would scatter one logical attempt across
    // branches nobody asked for.
    const exists = await git(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: repo },
    );

    const leased = await worktrees.lease({
      repo,
      branch,
      runner,
      taskRef: ref.id,
      now: clock(),
      ...(exists.code === 0 ? {} : { base }),
    });
    if (!leased.ok) {
      // The task is fine; this machine's pool is not. Hand the claim back so
      // a healthier pass can take it, and let the exit code say we broke.
      release(store, lease, clock());
      dispatched.push({ id, outcome: "failed", reason: leased.reason });
      broke++;
      continue;
    }

    // The record opens before the money is spent, so a crash mid-agent leaves
    // a row with no outcome — an attempt that vanished, visible by morning.
    const runId = store.startRun({
      taskRef: ref.id,
      leaseId: lease,
      runner,
      branch,
      worktree: leased.worktree.path,
      ...(model === undefined ? {} : { model }),
      now: clock(),
    });

    const result = await build(store, {
      taskId: id,
      taskRef: ref.id,
      runner,
      leaseId: lease,
      worktree: leased.worktree.path,
      branch,
      now: clock(),
      clock,
      timeoutMs,
      ...(model === undefined ? {} : { model }),
      ...(turns === undefined ? {} : { maxTurns: Number(turns) }),
      ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
      ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
    });

    // Handed back either way; a tree with somebody's work in it comes back
    // unverified rather than cleaned, same as `build`.
    await worktrees.release(leased.worktree.path, clock());

    if (result.ok) {
      // The completion has to be *accepted*, not assumed. A fence here means
      // the world moved past this lease between the builder's final check and
      // now; the commit exists on the branch, but the task is not ours to
      // close, and reporting "built" would count work the fence disowned.
      const sealed = completeFenced(store, lease, "done", clock());
      if (sealed.ok) {
        store.finishRun(runId, { outcome: "built", committed: result.committed, now: clock() });
        dispatched.push({
          id,
          outcome: "built",
          committed: result.committed,
          branch,
          worktree: leased.worktree.path,
        });
        built++;
      } else {
        store.finishRun(runId, { outcome: "failed", reason: "fenced", committed: result.committed, now: clock() });
        dispatched.push({ id, outcome: "failed", reason: "fenced", branch, worktree: leased.worktree.path });
        broke++;
      }
      continue;
    }

    if (result.reason === "unapproved" || result.reason === "scope-changed") {
      // Approval drifted between our prefilter and the builder's own gate.
      // That is a person's pending decision, not a fault.
      release(store, lease, clock());
      store.finishRun(runId, { outcome: "refused", reason: result.reason, now: clock() });
      dispatched.push({ id, outcome: "skipped", reason: result.reason });
      continue;
    }

    if (result.reason === "fenced") {
      // The lease did not survive the build. Nothing is ours to release or to
      // mark; the work sits in the worktree for whoever holds the task now.
      store.finishRun(runId, { outcome: "refused", reason: "fenced", now: clock() });
      dispatched.push({ id, outcome: "failed", reason: "fenced", worktree: leased.worktree.path });
      broke++;
      continue;
    }

    if (result.reason === "agent" || result.reason === "timeout" || result.reason === "git") {
      // The attempt itself broke. The terminal state and the release are one
      // step, so the task is never simultaneously free and unfinished — and
      // even that write can be fenced, in which case the failure is recorded
      // but the task belongs to whoever took it.
      const sealed = completeFenced(store, lease, "failed", clock());
      store.finishRun(runId, {
        outcome: "failed",
        reason: sealed.ok ? result.reason : "fenced",
        now: clock(),
      });
      dispatched.push({ id, outcome: "failed", reason: result.reason, worktree: leased.worktree.path });
      broke++;
      continue;
    }

    // no-claim, not-yours, not-leased, protected-branch, wrong-branch,
    // moved-branch: invariants this dispatcher was supposed to uphold. The
    // task is left queued for a correct pass; this one admits it broke.
    release(store, lease, clock());
    store.finishRun(runId, { outcome: "refused", reason: result.reason, now: clock() });
    dispatched.push({ id, outcome: "failed", reason: result.reason });
    broke++;
  }

  const summary = () => {
    const lines = [`Considered ${considered}, built ${built}, broke ${broke}.`];
    for (const entry of dispatched) {
      const detail =
        entry.outcome === "built"
          ? entry.committed === true
            ? `committed to ${entry.branch}`
            : "the agent changed nothing, which is a real answer"
          : entry.reason ?? "";
      lines.push(`  ${entry.id.padEnd(24)} ${entry.outcome}  ${detail}`.trimEnd());
    }
    if (built > 0) {
      lines.push("", "Nothing has been pushed. Look at the branches before they go anywhere.");
    }
    return lines;
  };

  // One broken build fails the pass even if others succeeded: exit 0 must
  // mean "nothing needs you", and a half-broken night does.
  if (broke > 0) {
    return fail(write, json, "tick", "build-failed", `${broke} of ${dispatched.length} dispatched tasks broke`, EXIT.failed, {
      considered,
      dispatched,
    });
  }
  if (built > 0) {
    return succeed(write, json, "tick", { considered, dispatched }, summary);
  }
  if (considered === 0) {
    return fail(write, json, "tick", "empty", "nothing is ready", EXIT.refused, {
      considered,
      dispatched,
    });
  }
  return fail(
    write,
    json,
    "tick",
    "nothing-dispatched",
    "everything ready is waiting on a person or held by somebody else",
    EXIT.refused,
    { considered, dispatched },
  );
}

/**
 * The morning sweep: everything the night may have left behind, in one pass.
 *
 * Three recoveries, in an order that matters. Dead runners first, because
 * recovery is the only path that *requeues* the tasks they held — reaping an
 * expired claim first would release it quietly and leave its task stranded
 * in `running`, unclaimable and unoffered, which is the most expensive kind
 * of bug because nothing anywhere reports it. Then expired leases. Then the
 * worktrees: rows whose directory is gone are dropped, and directories the
 * pool made but never recorded — a crash between `git worktree add` and the
 * row — are adopted, released and unverified, so they stop being invisible.
 *
 * Adoption fails closed: a git listing that errored is not a listing that
 * came back empty, and nothing is written or forgotten on its word. Run it
 * from cron before `tick`; a pass that trips over an orphan it could have
 * adopted is a dead loop at 3am.
 */
async function reconcileCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const repo = repoFrom(flags);
  const pool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");

  const recovered = recoverDead(store, clock());
  const reaped = reap(store, clock());

  const worktrees = new WorktreePool(store, {
    root: pool,
    ...(context.gitRunner === undefined ? {} : { runner: context.gitRunner }),
  });
  const adoption = await worktrees.adopt(repo, clock());
  if (!adoption.ok) {
    // The claim and lease work above is real and stands; only the worktree
    // half could not be trusted, and the exit code says the sweep is not done.
    return fail(write, json, "reconcile", "git", adoption.message, EXIT.failed, {
      recovered,
      reaped: reaped.map(claim => claim.leaseId),
    });
  }

  const nothing =
    recovered.length === 0 &&
    reaped.length === 0 &&
    adoption.adopted.length === 0 &&
    adoption.forgotten.length === 0;

  return succeed(
    write,
    json,
    "reconcile",
    {
      recovered,
      reaped: reaped.map(claim => claim.leaseId),
      adopted: adoption.adopted,
      forgotten: adoption.forgotten,
    },
    () =>
      nothing
        ? ["Nothing to reconcile. The night left everything where it should be."]
        : [
            ...recovered.map(
              one =>
                `Recovered ${one.runner}: ${one.claims.length} claim(s) requeued, ${one.worktrees.length} worktree(s) handed back unverified.`,
            ),
            ...(reaped.length === 0 ? [] : [`Reaped ${reaped.length} expired lease(s).`]),
            ...adoption.adopted.map(path => `Adopted ${path} — released, unverified, somebody should look.`),
            ...adoption.forgotten.map(path => `Forgot ${path} — its directory is gone.`),
          ],
  );
}

// ---- gaps -----------------------------------------------------------------

/** One thing the machine lacks, and what filling it would actually free. */
type Gap = {
  key: string;
  repo: string;
  /** Why it is a gap, in the capability's own words. */
  state: string;
  /** Tasks this gap alone is holding back — fill it and they start. */
  unblocks: string[];
  /** Tasks waiting on this *and* something else — filling this is not enough. */
  alsoBlocks: string[];
  /** How to prove it filled. */
  verify: string;
  instructions: string;
};

/**
 * What is missing, ranked by how many tasks it unblocks — never
 * alphabetically (§6). The count is honest in the way that matters at 9am:
 * a task waiting on two gaps starts when *both* fill, so it counts toward
 * neither gap's `unblocks` and both gaps' `alsoBlocks`. A ranking that
 * counted it twice would send the operator to fill the wrong gap first.
 *
 * Derived, not stored: every field here is a join over capabilities and the
 * ready set, and a stored copy would only learn to disagree with them.
 */
function computeGaps(store: Store, repo: string, now: Date): Gap[] {
  const gaps = new Map<string, Gap>();

  const claim = (key: string, state: string, verify: string, kind: string): Gap => {
    const existing = gaps.get(key);
    if (existing !== undefined) return existing;
    const made: Gap = {
      key,
      repo,
      state,
      unblocks: [],
      alsoBlocks: [],
      verify,
      instructions: adviceFor(kind),
    };
    gaps.set(key, made);
    return made;
  };

  // Unverified capabilities are gaps even before anything requires them —
  // visible early is the point. Requirements referencing capabilities nobody
  // recorded become gaps the moment a task names them.
  for (const capability of store.listCapabilities(repo)) {
    if (isVerified(capability, now)) continue;
    claim(
      `${capability.kind}:${capability.name}`,
      describeCapability(capability, now),
      capability.probe ?? "no probe recorded — nothing can verify it",
      capability.kind,
    );
  }

  for (const ref of store.listReady(now)) {
    if (ref.repo !== null && ref.repo !== repo) continue;
    if (!approvalOf(store.getScope(ref.externalId)).approved) continue;
    if (ref.capabilityRequirements.length === 0) continue;

    const unmet: string[] = [];
    for (const key of ref.capabilityRequirements) {
      const parsed = parseCapabilityKey(key);
      if (parsed === null) continue;
      const taskRepo = ref.repo ?? repo;
      const capability = store.getCapability(taskRepo, parsed.kind, parsed.name);
      if (capability === null) {
        unmet.push(key);
        claim(key, `unrecorded for ${taskRepo}`, "nightorders cap add, then cap probe", parsed.kind);
      } else if (!isVerified(capability, now)) {
        unmet.push(key);
      }
    }

    for (const key of unmet) {
      const gap = gaps.get(key);
      if (gap === undefined) continue;
      (unmet.length === 1 ? gap.unblocks : gap.alsoBlocks).push(ref.externalId);
    }
  }

  return [...gaps.values()].sort(
    (a, b) => b.unblocks.length - a.unblocks.length || a.key.localeCompare(b.key),
  );
}

function adviceFor(kind: string): string {
  switch (kind) {
    case "env":
      return "supply the value in the runner's environment — shell profile or keychain; values never enter the control plane";
    case "cli":
      return "install it or log it in, then re-probe";
    case "mcp":
      return "start or configure the server, then re-probe";
    case "ci":
      return "this lives in CI; supply a local equivalent only if local tasks need it";
    default:
      return "supply it where the runner can see it, then re-probe";
  }
}

/** `nightorders gaps` — the BLOCKED section of the morning, standalone. */
function gapsCommand(flags: Map<string, string | true>, context: Context): number {
  const { store, write, json, clock } = context;
  const repo = repoFrom(flags);
  const gaps = computeGaps(store, repo, clock());

  if (json) {
    write(JSON.stringify({ ok: true, command: "gaps", repo, gaps }, null, 2));
    return gaps.length === 0 ? EXIT.ok : EXIT.refused;
  }
  if (gaps.length === 0) {
    write(`No gaps for ${repo}. Everything recorded is verified.`);
    return EXIT.ok;
  }
  for (const gap of gaps) {
    const freed =
      gap.unblocks.length > 0
        ? `fills → ${gap.unblocks.length} task(s) start: ${gap.unblocks.join(", ")}`
        : gap.alsoBlocks.length > 0
          ? `part of what holds: ${gap.alsoBlocks.join(", ")}`
          : "nothing queued needs it yet";
    write(`  ${gap.key.padEnd(28)} ${gap.state}`);
    write(`    ${freed}`);
    write(`    verify: ${gap.verify}`);
    write(`    ${gap.instructions}`);
  }
  return EXIT.refused;
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
    case "require":
      return requireTask(rest, flags, context);
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

  // Placement is explicit, never inferred from where the command happened to
  // run: a task filed from the wrong directory would silently bind to it.
  const placedIn = text(flags, "repo");
  if (placedIn !== undefined) {
    store.placeTask(store.refFor(BUILT_IN, id).id, resolve(placedIn));
  }

  return succeed(write, json, "task add", { task: outcome.task, repo: placedIn === undefined ? null : resolve(placedIn) }, () => [
    `Queued ${outcome.task.id} — ${outcome.task.title}`,
  ]);
}

/**
 * Say what a task needs before it may run: capability keys, `kind:name`.
 *
 * Keys are qualified because names are not identities — `env:supabase` and
 * `mcp:supabase` are different facts about a machine, and a requirement that
 * names only "supabase" would verify against whichever one answered first.
 * The given list replaces the old one; requirements are a statement, not a
 * pile of appends.
 */
function requireTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, now } = context;
  const id = positional[0];
  const given = text(flags, "cap");
  if (id === undefined || given === undefined) {
    return fail(write, json, "task require", "usage", "`nightorders task require <id> --cap <kind:name>[,<kind:name>]` — or --cap none to clear", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task require", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const keys = given === "none" ? [] : given.split(",").map(one => one.trim()).filter(Boolean);
  for (const key of keys) {
    if (parseCapabilityKey(key) === null) {
      return fail(write, json, "task require", "usage", `\`${key}\` is not a capability key — say kind:name, like env:SUPABASE_KEY or cli:gh`, EXIT.usage);
    }
  }

  store.setRequirements(store.refFor(BUILT_IN, id).id, keys, mutationFrom(flags, now));

  return succeed(write, json, "task require", { id, requirements: keys }, () => [
    keys.length === 0
      ? `${id} requires nothing.`
      : `${id} now requires: ${keys.join(", ")}. Nothing dispatches it until every one is verified.`,
  ]);
}

// ---- capabilities ---------------------------------------------------------

/**
 * What a repo's work needs from the machine it runs on — recorded, probed,
 * and never valued. `cap add` stores an operator-authored probe; `cap probe`
 * asks the environment; verification is a stamped claim about this machine
 * at that moment. There is deliberately no `cap verify --yes`: presence is
 * not enough and an assertion is even less, so a capability nothing can
 * probe stays a visible gap instead of becoming a quiet lie.
 */
async function capCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, name] = positional;
  const repo = repoFrom(flags);

  if (action === "add") {
    if (name === undefined) {
      return fail(write, json, "cap add", "usage", "`nightorders cap add <name> [--kind env|cli|mcp|ci|other] [--probe <cmd>] [--expires <iso>]`", EXIT.usage);
    }
    const kind = (text(flags, "kind") ?? "env") as CapabilityKind;
    if (!["env", "cli", "mcp", "ci", "other"].includes(kind)) {
      return fail(write, json, "cap add", "usage", "--kind takes env, cli, mcp, ci or other", EXIT.usage);
    }

    // An env capability can have its probe synthesized from a fixed template
    // — but only over a validated identifier, because the name lands inside
    // a shell line. Anything else the operator writes explicitly.
    let probe = text(flags, "probe") ?? null;
    if (probe === null && kind === "env") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return fail(write, json, "cap add", "usage", `\`${name}\` is not an environment variable name — give --probe explicitly`, EXIT.usage);
      }
      probe = `test -n "$${name}"`;
    }

    const expires = text(flags, "expires") ?? null;
    store.saveCapability(
      {
        repo,
        kind,
        name,
        probe,
        status: "unprobed",
        addedBy: `operator@${hostname()}`,
        createdAt: clock().toISOString(),
        lastVerifiedAt: null,
        verifiedBy: null,
        lastResult: null,
        expiresAt: expires,
      },
      mutationFrom(flags, clock()),
    );
    return succeed(write, json, "cap add", { repo, kind, name, probe }, () => [
      `Recorded ${kind}:${name} for ${repo}.`,
      probe === null
        ? "No probe — nothing can verify it, so it will stand as a gap until it has one."
        : `Probe: ${probe}`,
      "Nothing is verified yet: `nightorders cap probe`.",
    ]);
  }

  if (action === "list" || action === undefined) {
    const capabilities = store.listCapabilities(repo);
    if (json) {
      write(JSON.stringify({ ok: true, command: "cap list", repo, capabilities }, null, 2));
      return EXIT.ok;
    }
    if (capabilities.length === 0) {
      write(`No capabilities recorded for ${repo}. \`nightorders cap add\` or \`cap scan\`.`);
      return EXIT.ok;
    }
    for (const one of capabilities) {
      const state = describeCapability(one, clock());
      write(`  ${`${one.kind}:${one.name}`.padEnd(32)} ${state}`);
    }
    return EXIT.ok;
  }

  if (action === "probe") {
    const only = positional.slice(1);
    for (const key of only) {
      if (parseCapabilityKey(key) === null) {
        return fail(write, json, "cap probe", "usage", `\`${key}\` is not a capability key — say kind:name`, EXIT.usage);
      }
    }
    const outcomes = await probeRepo(store, repo, `operator@${hostname()}`, clock(), {
      ...(only.length === 0 ? {} : { only: new Set(only) }),
    });
    if (outcomes.length === 0) {
      return fail(write, json, "cap probe", "empty", `nothing to probe for ${repo}`, EXIT.refused);
    }

    const unverified = outcomes.filter(one => one.status !== "verified");
    const lines = () =>
      outcomes.map(one =>
        `  ${`${one.kind}:${one.name}`.padEnd(32)} ${one.status}${one.detail === undefined ? "" : `  ${one.detail}`}`,
      );
    if (json) {
      write(JSON.stringify({ ok: true, command: "cap probe", repo, outcomes }, null, 2));
    } else {
      write(lines().join("\n"));
    }
    // All yes is 0; any no is 3 — a caller scripting "probe, then tick" needs
    // to branch on the answer without parsing prose.
    return unverified.length === 0 ? EXIT.ok : EXIT.refused;
  }

  return fail(write, json, "cap", "usage", `unknown \`cap ${action}\` — try add, list, probe`, EXIT.usage);
}

function describeCapability(capability: Capability, now: Date): string {
  if (isVerified(capability, now)) {
    return `verified ${capability.lastVerifiedAt} by ${capability.verifiedBy ?? "unknown"}`;
  }
  if (capability.status === "verified") return `verified, but expired ${capability.expiresAt}`;
  if (capability.status === "failed") return `failed  ${capability.lastResult ?? ""}`.trimEnd();
  return capability.probe === null ? "unprobed — no probe, nothing can vouch" : "unprobed";
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
    runs: store.runsFor(ref.id),
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
