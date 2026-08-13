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
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { probeRepo, isVerified } from "./probe.js";
import { PROVIDER_BINARY } from "./invoke.js";
import { createDecisionServer } from "./serve.js";
import {
  daemonStatus,
  installDaemon,
  planDaemon,
  uninstallDaemon,
  type SupervisorRunner,
} from "./daemon.js";
import {
  bridgePass,
  clearBotToken,
  createTransport,
  followBridge,
  hashPairingCode,
  loadBotToken,
  mintPairingCode,
  redactToken,
  saveBotToken,
  PAIRING_TTL_MS,
  TOKEN_ENV,
  type FollowReport,
  type TelegramTransport,
} from "./telegram.js";
import { scanRepo } from "./capscan.js";
import { computeGaps, describeCapability, type Gap } from "./gaps.js";
import { ask, askHidden, confirm, interactive } from "./prompt.js";
import { canonicalProject } from "./project.js";
import { tally, spendLine } from "./summary.js";
import {
  bodyHashOf,
  describePublicationGrant,
  observeChecks,
  publicationBody,
  publishPass,
  type PublishExec,
} from "./publish.js";

type CapabilityKind = Capability["kind"];
import {
  acquire,
  acquireIfReady,
  completeFenced,
  finalizeFailureFenced,
  finalizeMalformedFenced,
  finalizeParkFenced,
  finalizePlanFenced,
  finalizePlanFailureFenced,
  type FailureClass,
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
import { propose, approve, addApprover, authenticateApprover, describeScope, approvalOf } from "./scope.js";
import { WorktreePool } from "./worktree.js";
import {
  build,
  DEFAULT_BUILD_TIMEOUT_MS,
  type Runner as CommandRunner,
} from "./builder.js";
import { plan as planTask } from "./planner.js";
import { run } from "./exec.js";
import { readPulls } from "./pulls.js";
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
  /** Injected by tests: the Telegram Bot API. Production dials the real one. */
  telegramTransport?: TelegramTransport;
  publishExec?: PublishExec;
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

  nightorders brief [--repo <path>] [--local] [--since <iso>]
                                        the report: recent runs, gaps,
                                        PRs (--local skips the network and
                                        says REVIEW was not read)

The outbox — facts that want a person, durably
  nightorders outbox list [--all]
  nightorders outbox deliver --cmd <c>  runs once per pending row, reading
                                        $NIGHTORDERS_KIND / _SUBJECT / _BODY;
                                        exit 0 delivered receipts, 1 any fail

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
    "max", "cap", "probe", "kind", "expires", "cmd", "since", "repair-model",
    "choose", "note", "max-open-decisions", "port", "host", "allow-host",
    "for", "tick-every", "bridge-every", "reconcile-every", "incarnation",
    "token-file", "bin", "poll", "github", "remote", "head-prefix", "password",
    "project-root",
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
      // Evidence lives beside the database for the same reason the database
      // lives beside repos.json: somebody will want to back it up, sync it,
      // or delete it, and files hidden somewhere clever cannot be found when
      // it matters.
      evidenceRoot: join(dirname(file), "evidence"),
      // The bot token's file home. Never a column; see telegram.ts.
      telegramTokenFile: join(dirname(file), "telegram-token"),
      ...(options.agentRunner === undefined ? {} : { agentRunner: options.agentRunner }),
      ...(options.gitRunner === undefined ? {} : { gitRunner: options.gitRunner }),
      ...(options.telegramTransport === undefined ? {} : { telegramTransport: options.telegramTransport }),
      ...(options.publishExec === undefined ? {} : { publishExec: options.publishExec }),
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
  evidenceRoot: string;
  telegramTokenFile: string;
  agentRunner?: CommandRunner;
  gitRunner?: CommandRunner;
  telegramTransport?: TelegramTransport;
  /** Injected by tests: what `publish` runs for git and gh. */
  publishExec?: PublishExec;
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
    case "outbox":
      return outboxCommand(positional, flags, context);
    case "brief":
      return briefCommand(flags, context);
    case "decide":
      return decideCommand(positional, flags, context);
    case "incident":
      return incidentCommand(positional, flags, context);
    case "serve":
      return serveCommand(flags, context);
    case "watch":
      return watchCommand(flags, context);
    case "daemon":
      return daemonCommand(positional, flags, context);
    case "bridge":
      return bridgeCommand(positional, flags, context);
    case "publish":
      return publishCommand(positional, flags, context);
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

  // The standalone road records its attempt and carries its exact lease the
  // same as tick's — a park sealed here goes through the same fenced
  // transaction, because a gate one road bypasses is a suggestion. No claim
  // yet is fine: build() refuses no-claim itself, and the run row records
  // that the attempt was made.
  const held = currentClaim(store, ref.id, now);
  const runId = store.startRun({
    taskRef: ref.id,
    leaseId: held?.leaseId ?? "unclaimed",
    runner,
    branch,
    worktree: leased.worktree.path,
    ...(text(flags, "model") === undefined ? {} : { model: text(flags, "model") as string }),
    now,
  });

  const result = await build(store, {
    taskId: id,
    taskRef: ref.id,
    runner,
    ...(held === null ? {} : { leaseId: held.leaseId }),
    runId,
    evidenceRoot: context.evidenceRoot,
    worktree: leased.worktree.path,
    branch,
    now,
    clock: context.clock,
    ...(text(flags, "model") === undefined ? {} : { model: text(flags, "model") as string }),
    ...(text(flags, "repair-model") === undefined ? {} : { repairModel: text(flags, "repair-model") as string }),
    ...(text(flags, "turns") === undefined ? {} : { maxTurns: Number(text(flags, "turns")) }),
    ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
    ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
  });

  // Handed back either way. A tree with work still in it comes back
  // unverified and is reported rather than cleaned.
  const handedBack = await worktrees.release(leased.worktree.path, now);

  if (result.ok && result.parked !== undefined) {
    const sealed =
      held === null
        ? null
        : finalizeParkFenced(store, {
            leaseId: held.leaseId,
            runId,
            taskId: id,
            decision: result.parked.decision,
            artifactIds: result.parked.artifactIds,
            now: context.clock(),
          });
    if (sealed === null || !sealed.ok) {
      return fail(write, json, "build", "fenced", `${id} parked, but the lease was gone before the decision could be sealed`, EXIT.refused, {
        worktree: leased.worktree.path,
      });
    }
    return succeed(
      write,
      json,
      "build",
      { parked: true, decision: sealed.decisionId, worktree: leased.worktree.path },
      () => [
        `${id} parked a decision instead of guessing.`,
        `  decision  ${sealed.decisionId} — \`nightorders decide ${sealed.decisionId}\``,
        `  worktree  ${leased.worktree.path} (work in progress preserved)`,
      ],
    );
  }

  if (!result.ok) {
    if (result.reason === "malformed-decision" && held !== null) {
      finalizeMalformedFenced(store, {
        leaseId: held.leaseId,
        runId,
        taskId: id,
        problems: result.problems ?? [],
        now: context.clock(),
      });
    } else {
      const brokeish =
        result.reason === "agent" ||
        result.reason === "agent-reported" ||
        result.reason === "no-op" ||
        result.reason === "moved-head" ||
        result.reason === "timeout" ||
        result.reason === "git";
      store.finishRun(runId, {
        outcome: brokeish ? "failed" : "refused",
        reason: result.reason,
        now: context.clock(),
      });
    }
    // The exit-code contract separates "no" from "broken", and a build whose
    // agent crashed or timed out *broke* — 3 here taught callers that a dead
    // model and an unapproved scope were the same kind of news. Refusals —
    // the gates saying no — stay 3, which is them working.
    const broke =
      result.reason === "agent" ||
      result.reason === "agent-reported" ||
      result.reason === "no-op" ||
      result.reason === "moved-head" ||
      result.reason === "timeout" ||
      result.reason === "git" ||
      result.reason === "malformed-decision";
    return fail(write, json, "build", result.reason, result.message, broke ? EXIT.failed : EXIT.refused, {
      worktree: leased.worktree.path,
    });
  }

  store.finishRun(runId, {
    outcome: result.noChange === true ? "no-change" : "built",
    ...(result.noChange === true ? { reason: "handoff" } : {}),
    committed: result.committed,
    now: context.clock(),
  });
  return succeed(
    write,
    json,
    "build",
    { ...result, worktree: leased.worktree.path, clean: handedBack.ok },
    () => [
      result.committed
        ? `Built ${id} and committed to ${branch}.`
        : `${id}: no change needed — the agent said so and the tree agrees.`,
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
  outcome: "built" | "planned" | "parked" | "skipped" | "failed";
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
  const repairModel = text(flags, "repair-model");
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
  let parked = 0;
  let broke = 0;

  for (const ref of ready) {
    if (built >= max) break;
    const id = ref.externalId;

    // A task placed in another repository is not this pass's to build.
    if (ref.repo !== null && ref.repo !== repo) {
      dispatched.push({ id, outcome: "skipped", reason: "other-repo" });
      continue;
    }

    // A plan the operator asked for dispatches a PLANNER — the one
    // legitimate spend on a task with no approved scope. Everything else
    // unapproved is a person's pending decision: skip, not refuse.
    const wantsPlan = ref.plan === "requested" && !approvalOf(store.getScope(id)).approved;
    if (!wantsPlan && !approvalOf(store.getScope(id)).approved) {
      dispatched.push({ id, outcome: "skipped", reason: "unapproved" });
      continue;
    }

    const claimed = acquireIfReady(store, ref.id, runner, {
      ...(wantsPlan ? { dispatchRole: "planner" as const } : {}),
      now: clock(),
      ttlMs: leaseTtlMs,
      repo,
      ...(model === undefined ? {} : { model }),
      ...(text(flags, "incarnation") === undefined ? {} : { incarnation: text(flags, "incarnation") as string }),
      ...(text(flags, "max-open-decisions") === undefined
        ? {}
        : { maxOpenDecisions: Number(text(flags, "max-open-decisions")) }),
    });
    if (!claimed.ok) {
      // Losing a race, finding the task no longer ready, and a machine that
      // lacks what the task needs are all the system working. None fails the
      // pass; a capability gap names itself so the gaps report can too.
      if (claimed.reason === "capability" && "message" in claimed) {
        // A gap is a fact that wants a person. One notification per episode:
        // the dedupe key holds until the capability verifies, then the next
        // failure is a new fact and says so again.
        const key = /needs (\S+)/.exec(claimed.message)?.[1];
        const parsed = key === undefined ? null : parseCapabilityKey(key);
        if (parsed !== null) {
          const home = ref.repo ?? repo;
          store.enqueueNotification(
            {
              dedupeKey: `gap:${home}:${parsed.kind}:${parsed.name}`,
              kind: "gap",
              subject: `${key} blocks work in ${home}`,
              body: `${id} (and possibly others) cannot dispatch: ${claimed.message}. \`nightorders gaps --repo ${home}\``,
            },
            clock(),
          );
        }
      }
      dispatched.push({
        id,
        outcome: "skipped",
        reason: claimed.reason,
        ...("message" in claimed && claimed.reason === "capability" ? { detail: claimed.message } : {}),
      });
      continue;
    }
    const lease = claimed.claim.leaseId;

    if (wantsPlan) {
      // The planner's workspace is disposable and its branch namespace is
      // its own — never the builder's, so a later build starts from base
      // with nothing a planning session could have left as an ancestor
      // (Codex planning review, finding 1).
      const planBranch = `nightorders-plan/${id}`;
      const planLeased = await worktrees.lease({
        repo,
        branch: planBranch,
        runner,
        taskRef: ref.id,
        now: clock(),
        base,
      });
      if (!planLeased.ok) {
        release(store, lease, clock());
        dispatched.push({ id, outcome: "failed", reason: planLeased.reason });
        broke++;
        continue;
      }
      const planRunId = store.startRun({
        taskRef: ref.id,
        leaseId: lease,
        runner,
        role: "planner",
        branch: planBranch,
        worktree: planLeased.worktree.path,
        ...(model === undefined ? {} : { model }),
        now: clock(),
      });
      const answers = store
        .answeredDecisionsFor(id, 5)
        .map(one => ({ question: one.question, choice: one.choice ?? "", note: one.note }));
      const outcome = await planTask(store, {
        taskId: id,
        taskTitle: store.getTask(id)?.title ?? id,
        taskRef: ref.id,
        runner,
        leaseId: lease,
        runId: planRunId,
        worktree: planLeased.worktree.path,
        branch: planBranch,
        now: clock(),
        clock,
        evidenceRoot: context.evidenceRoot,
        answers,
        ...(model === undefined ? {} : { model }),
        ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
        ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
      });
      await worktrees.release(planLeased.worktree.path, clock());

      if (outcome.ok && "parked" in outcome) {
        const sealed = finalizeParkFenced(store, {
          leaseId: lease,
          runId: planRunId,
          taskId: id,
          decision: outcome.parked.decision,
          artifactIds: outcome.parked.artifactIds,
          now: clock(),
        });
        if (sealed.ok) {
          store.resetPlanStrikes(ref.id);
          dispatched.push({ id, outcome: "parked", reason: `decision:${sealed.decisionId}` });
          parked++;
        } else {
          dispatched.push({ id, outcome: "failed", reason: "fenced" });
          broke++;
        }
        continue;
      }
      if (outcome.ok) {
        const sealed = finalizePlanFenced(store, {
          leaseId: lease,
          runId: planRunId,
          taskId: id,
          plan: outcome.drafted.plan,
          artifact: outcome.drafted.artifact,
          now: clock(),
        });
        if (sealed.ok) {
          store.clearQuota(runner, PROVIDER_BINARY, model ?? "");
          dispatched.push({ id, outcome: "planned" });
        } else {
          dispatched.push({ id, outcome: "failed", reason: "fenced" });
          broke++;
        }
        continue;
      }
      const sealedFailure = finalizePlanFailureFenced(store, {
        leaseId: lease,
        runId: planRunId,
        taskId: id,
        kind: outcome.kind,
        message: outcome.message,
        now: clock(),
      });
      dispatched.push({ id, outcome: "failed", reason: outcome.reason });
      if (!sealedFailure.ok) release(store, lease, clock());
      broke++;
      continue;
    }

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
      runId,
      evidenceRoot: context.evidenceRoot,
      worktree: leased.worktree.path,
      branch,
      now: clock(),
      clock,
      timeoutMs,
      ...(model === undefined ? {} : { model }),
      ...(repairModel === undefined ? {} : { repairModel }),
      ...(turns === undefined ? {} : { maxTurns: Number(turns) }),
      ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
      ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
    });

    // Handed back either way; a tree with somebody's work in it comes back
    // unverified rather than cleaned, same as `build`.
    await worktrees.release(leased.worktree.path, clock());

    if (result.ok && result.parked !== undefined) {
      // The seal is one fenced transaction: decision, hold, run outcome, and
      // outbox row exist together or — if the lease was superseded between
      // the builder's last proof and this write — not at all.
      const sealed = finalizeParkFenced(store, {
        leaseId: lease,
        runId,
        taskId: id,
        decision: result.parked.decision,
        artifactIds: result.parked.artifactIds,
        now: clock(),
      });
      if (sealed.ok) {
        // A park is the system working: the agent refused to guess, the
        // question is in the attention surface, the pass moves on — and it
        // ends any failure streak: refusing to guess is not failing.
        store.resetStrikes(ref.id);
        dispatched.push({ id, outcome: "parked", reason: `decision:${sealed.decisionId}`, worktree: leased.worktree.path });
        parked++;
      } else {
        dispatched.push({ id, outcome: "failed", reason: "fenced", worktree: leased.worktree.path });
        broke++;
      }
      continue;
    }

    if (result.ok) {
      // The completion has to be *accepted*, not assumed. A fence here means
      // the world moved past this lease between the builder's final check and
      // now; the commit exists on the branch, but the task is not ours to
      // close, and reporting "built" would count work the fence disowned.
      // One transaction around all of it: the fenced release, the run's
      // outcome, and — when a grant covers this task — the publication
      // intent, so "done" and "this must reach a PR" cannot come apart.
      const sealed = store.transact(() => {
        const fence = completeFenced(store, lease, "done", clock());
        if (!fence.ok) return fence;
        store.finishRun(runId, {
          outcome: result.noChange === true ? "no-change" : "built",
          ...(result.noChange === true ? { reason: "handoff" } : {}),
          committed: result.committed,
          now: clock(),
        });
        // A stated no-change publishes nothing — there is nothing to push,
        // and an empty PR would be noise wearing a grant.
        if (result.noChange !== true && result.committed) {
          const grant = store.publicationGrantFor(repo);
          const headSha = store.getRun(runId)?.headRevision ?? null;
          if (
            grant !== null &&
            headSha !== null &&
            branch.startsWith(grant.headPrefix) &&
            (grant.selector === "all" || ref.origin === "ours")
          ) {
            const intentId = store.createPublicationIntent(
              {
                run: runId,
                taskRef: ref.id,
                githubRepo: grant.githubRepo,
                remote: grant.remote,
                base: grant.base,
                head: branch,
                headSha,
                bodyHash: "",
                draft: grant.draft,
              },
              clock(),
            );
            // The body's identity is computed from the rows this very
            // transaction made durable — reproducible after any crash.
            const publication = store.publicationForRun(runId);
            if (publication !== null) {
              store.handle
                .prepare("UPDATE publication SET body_hash = ? WHERE id = ?")
                .run(bodyHashOf(publicationBody(store, publication)), intentId);
            }
          }
        }
        return fence;
      });
      if (sealed.ok) {
        // A concluded success ends the failure streak and its backoff —
        // and proves the credential, clearing any quota stamp it was
        // dispatched through as a half-open probe.
        store.resetStrikes(ref.id);
        store.clearQuota(runner, PROVIDER_BINARY, model ?? "");
        dispatched.push({
          id,
          outcome: "built",
          committed: result.committed,
          branch,
          worktree: leased.worktree.path,
        });
        built++;
      } else {
        // The run record is canonical; the report and any notification say
        // exactly what it says, in one transaction, so a crash between them
        // cannot leave a failure nobody hears about.
        store.transact(() => {
          store.finishRun(runId, { outcome: "failed", reason: "fenced", committed: result.committed, now: clock() });
          store.enqueueNotification(
            {
              dedupeKey: `run:${runId}:fenced`,
              kind: "build-fenced",
              subject: `${id}: completed, but the lease was gone`,
              body: `The commit exists on ${branch}, but the world moved past this lease before the completion was accepted. Look before anything reuses it.`,
            },
            clock(),
          );
        });
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

    if (result.reason === "malformed-decision") {
      // The agent tried to park and could not say what, twice over. The
      // fenced transaction records the incident, holds the task so the next
      // pass does not spend the same tokens on the same wall, and pages a
      // person — atomically, so a crash cannot leave the stall silent.
      const sealed = finalizeMalformedFenced(store, {
        leaseId: lease,
        runId,
        taskId: id,
        problems: result.problems ?? [],
        now: clock(),
      });
      dispatched.push({
        id,
        outcome: "failed",
        reason: sealed.ok ? "malformed-decision" : "fenced",
        worktree: leased.worktree.path,
      });
      broke++;
      continue;
    }

    if (
      result.reason === "agent" ||
      result.reason === "agent-reported" ||
      result.reason === "no-op" ||
      result.reason === "moved-head" ||
      result.reason === "moved-branch" ||
      result.reason === "timeout" ||
      result.reason === "git" ||
      result.reason === "commit-failure"
    ) {
      // The attempt itself broke. One fenced transaction decides what that
      // means — a strike and a doubling backoff, a stall after three, or a
      // commit-failure incident guarding the preserved worktree — and the
      // run record is canonical over anything this summary says. The
      // classification trusts only what the machine itself observed
      // (finding 19): a timeout is retryable infrastructure, protocol
      // violations are the agent's, commit-stage breakage is its own thing,
      // and every other nonzero exit is 'unknown' with bounded retry.
      const failureClass: FailureClass =
        result.reason === "agent-reported"
          ? "agent-reported"
          : result.reason === "no-op" || result.reason === "moved-head" || result.reason === "moved-branch"
            ? "no-op"
            : result.reason === "timeout" || result.reason === "git"
              ? "retryable-infra"
              : result.reason === "commit-failure"
                ? "commit-failure"
                : "unknown";
      const sealed = finalizeFailureFenced(store, {
        leaseId: lease,
        runId,
        taskId: id,
        failureClass,
        message: result.message,
        worktree: leased.worktree.path,
        now: clock(),
      });
      dispatched.push({
        id,
        outcome: "failed",
        reason: sealed.ok
          ? `${failureClass}${sealed.disposition === "backoff" ? ` — retry ${sealed.strikes}/3` : sealed.disposition === "stalled" ? " — stalled" : ""}`
          : "fenced",
        worktree: leased.worktree.path,
      });
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
    const lines = [`Considered ${considered}, built ${built}, parked ${parked}, broke ${broke}.`];
    for (const entry of dispatched) {
      const detail =
        entry.outcome === "built"
          ? entry.committed === true
            ? `committed to ${entry.branch}`
            : "no-change, stated and verified"
          : entry.outcome === "parked"
            ? `${entry.reason} — \`nightorders decide\``
            : entry.reason ?? "";
      lines.push(`  ${entry.id.padEnd(24)} ${entry.outcome}  ${detail}`.trimEnd());
    }
    if (built > 0) {
      lines.push("", "Nothing has been pushed. Look at the branches before they go anywhere.");
    }
    if (parked > 0) {
      lines.push("", `${parked} decision${parked === 1 ? "" : "s"} waiting — \`nightorders decide\`, or \`nightorders brief\`.`);
    }
    return lines;
  };

  // One broken build fails the pass even if others succeeded: exit 0 must
  // mean "nothing needs you", and a half-broken pass does not qualify.
  if (broke > 0) {
    return fail(write, json, "tick", "build-failed", `${broke} of ${dispatched.length} dispatched tasks broke`, EXIT.failed, {
      considered,
      dispatched,
    });
  }
  // A pass whose only events were parks or drafted plans exits 0: nothing
  // broke, nothing needs code — the questions and the plan are in the
  // attention surface where they belong, which is the system working.
  if (built > 0 || parked > 0 || dispatched.some(one => one.outcome === "planned")) {
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
 * The recovery sweep: everything an unattended stretch may have left behind, in one pass.
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
  for (const one of recovered) {
    for (const leaseId of one.claims) {
      // Lease ids are unique forever, so each recovery is its own episode.
      store.enqueueNotification(
        {
          dedupeKey: `recover:${leaseId}`,
          kind: "runner-recovered",
          subject: `${one.runner} went dead holding work`,
          body: `Its claims were requeued and its worktrees handed back unverified. Lease ${leaseId}.`,
        },
        clock(),
      );
    }
  }
  const reaped = reap(store, clock());

  const worktrees = new WorktreePool(store, {
    root: pool,
    ...(context.gitRunner === undefined ? {} : { runner: context.gitRunner }),
  });
  const adoption = await worktrees.adopt(repo, clock());
  if (adoption.ok) {
    for (const path of adoption.adopted) {
      store.enqueueNotification(
        {
          dedupeKey: `adopt:${path}:${clock().toISOString()}`,
          kind: "worktree-adopted",
          subject: `Adopted an unrecorded worktree`,
          body: `${path} existed in the pool with no row — a crash between creation and record. It is released and unverified; somebody should look.`,
        },
        clock(),
      );
    }
  }
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
        ? ["Nothing to reconcile. Everything is where it should be."]
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
// The computation lives in gaps.ts, shared with the web console; the CLI
// keeps only its own presentation.

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

// ---- the report -----------------------------------------------------------

/**
 * `nightorders brief` — one ritual (§6). The recent runs from the run table,
 * the blocked gaps ranked by what filling them frees, the PRs waiting on a
 * person, and where decisions will go when M3 gives them a shape.
 *
 * REVIEW is a live network read through `gh`, so it distinguishes three
 * states a lazy version would collapse: read and empty, read and full, and
 * *not read* — offline (--local) or failed — because "no PRs" and "could
 * not look" send the reader in different directions. Token and dollar
 * figures wait until run records carry usage (M4's economics); a briefing
 * that printed $0.00 it never measured would be lying with precision.
 */
async function briefCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const repo = repoFrom(flags);

  // --latest-watch bounds the report to one service window's actual edges
  // (§6): the last watch episode's window and runner, instead of "the last
  // 24 hours" — which can mix two windows, or none.
  const episode = flags.has("latest-watch") ? store.latestWatchEpisode(repo) : null;
  if (flags.has("latest-watch") && episode === null) {
    return fail(write, json, "brief", "no-watch", "no watch episode recorded for this repo yet — run `nightorders watch` first", EXIT.refused);
  }
  const since =
    episode?.startedAt ??
    text(flags, "since") ??
    new Date(clock().getTime() - 24 * 60 * 60_000).toISOString();

  let runs = store.runsSince(since);
  if (episode !== null) {
    runs = runs.filter(
      one =>
        one.runner === episode.runner &&
        (episode.endedAt === null || one.startedAt <= episode.endedAt),
    );
  }
  // One arithmetic, shared with the console — see summary.ts for why the
  // measured/invoked distinction exists.
  const { built, failed, refused, cutDown, invoked, measured, spend, tokens } = tally(runs);

  const gaps = computeGaps(store, repo, clock());
  const pending = store.listNotifications("pending");

  // Deadlines are swept wherever decisions are shown, so "overdue" is a fact
  // the brief computes rather than one it hopes somebody else computed.
  store.expireOverdueDecisions(clock());
  const decisions = store.listDecisions("unanswered");
  // No time window on incidents: a task held by a malformed park last
  // Tuesday is still held, and a brief that let it age out of view would
  // make the stall silent — which is the one thing an incident exists to
  // prevent.
  const incidents = store.openIncidents();
  // Nor on stranded work: a queued task behind a terminally failed blocker
  // never becomes ready, silently, forever — unless it is said here.
  const stranded = store.strandedTasks();

  let review:
    | { state: "read"; pulls: { number: number; title: string }[] }
    | { state: "not-read"; why: string };
  if (flags.has("local")) {
    review = { state: "not-read", why: "--local, the network was not asked" };
  } else {
    const read = await readPulls(repo);
    review =
      read.problems.length > 0 && read.pulls.length === 0
        ? { state: "not-read", why: read.problems[0] ?? "unreadable" }
        : { state: "read", pulls: read.pulls.map(one => ({ number: one.number, title: one.title })) };
  }

  if (json) {
    write(
      JSON.stringify(
        {
          ok: true,
          command: "brief",
          repo,
          since,
          episode,
          tally: { built, failed, refused, cutDown },
          economics: {
            invocations: invoked.length,
            measured: measured.length,
            costUsd: spend,
            tokens,
          },
          gaps,
          review,
          outboxPending: pending.length,
          decide: decisions,
          incidents,
          stranded,
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }

  const lines: string[] = [`nightorders — the report ─ ${repo}`];
  if (episode !== null) {
    lines.push(
      `  episode      watch #${episode.id} on ${episode.runner} · ${episode.startedAt} → ${
        episode.endedAt ?? "never ended — it is running, or it died without saying"
      }`,
    );
  }
  lines.push(
    `  runs         ${built.length} built · ${failed.length} failed · ${refused.length} refused${
      cutDown.length > 0 ? ` · ${cutDown.length} cut down mid-flight` : ""
    }`,
  );
  for (const one of built) {
    lines.push(`      ${one.taskId.padEnd(20)} ${one.committed === true ? `committed to ${one.branch}` : "changed nothing, which is a real answer"}`);
  }
  for (const one of failed) {
    lines.push(`      ${one.taskId.padEnd(20)} failed: ${one.reason ?? "?"} — work kept in ${one.worktree}`);
  }
  for (const one of cutDown) {
    lines.push(`      ${one.taskId.padEnd(20)} never finished — the process died with it; \`task show ${one.taskId}\``);
  }

  lines.push(`  spend        ${spendLine({ built, failed, refused, cutDown, invoked, measured, spend, tokens })}`);

  if (gaps.length > 0) {
    const best = gaps[0] as Gap;
    lines.push(`  ▸ BLOCKED    ${gaps.length} gap(s)${best.unblocks.length > 0 ? ` — filling ${best.key} starts ${best.unblocks.length} task(s)` : ""}`);
    for (const gap of gaps) {
      lines.push(`      ${gap.key.padEnd(28)} ${gap.state}`);
    }
    lines.push(`      → nightorders gaps --repo ${repo}`);
  }

  lines.push(
    review.state === "read"
      ? `  ▸ REVIEW     ${review.pulls.length} PR(s)${review.pulls.length > 0 ? "" : " — nothing waits"}`
      : `  ▸ REVIEW     not read — ${review.why}`,
  );
  if (review.state === "read") {
    for (const pull of review.pulls) lines.push(`      #${pull.number}  ${pull.title}`);
  }

  if (pending.length > 0) {
    lines.push(`  ▸ OUTBOX     ${pending.length} undelivered — nightorders outbox deliver --cmd …`);
  }

  if (decisions.length > 0) {
    const overdue = decisions.filter(one => one.state === "expired").length;
    lines.push(
      `  ▸ DECIDE     ${decisions.length} waiting${overdue > 0 ? ` (${overdue} overdue)` : ""} — nightorders decide`,
    );
    for (const one of decisions) {
      lines.push(`      ${String(one.id).padEnd(4)} ${one.taskId.padEnd(20)} ${one.question}`);
    }
  } else {
    lines.push("  ▸ DECIDE     nothing waits on you");
  }

  if (stranded.length > 0) {
    lines.push(`  ▸ STRANDED   ${stranded.length} task(s) behind failed blockers — they will never become ready on their own`);
    for (const one of stranded) {
      lines.push(`      ${one.id.padEnd(20)} waits on ${one.blockedBy.join(", ")} — \`nightorders task requeue ${one.blockedBy[0]}\``);
    }
  }

  if (incidents.length > 0) {
    lines.push(`  ▸ INCIDENTS  ${incidents.length} unresolved — these do not age out`);
    for (const incident of incidents) {
      lines.push(
        `      ${incident.taskId.padEnd(20)} ${incident.kind} since ${incident.createdAt} — read run ${incident.run}'s evidence, then \`nightorders incident resolve ${incident.id}\``,
      );
    }
  }

  write(lines.join("\n"));
  return EXIT.ok;
}

// ---- decisions ------------------------------------------------------------

/**
 * `nightorders decide` — the attention surface, in the terminal.
 *
 *   decide                          what waits, oldest first
 *   decide <id>                     one decision, whole, with its evidence
 *   decide <id> --choose <option> --as <you> --token <t> [--note …] [--key …]
 *
 * Who decided is recorded, never asserted: answering takes the same
 * authenticated identity as approving a scope, because "the operator chose
 * this" is exactly the sentence a later agent will act on — an agent or any
 * local process typing `--by operator` must not be able to write it.
 * Expiry runs first and never chooses: an overdue decision gets louder, and
 * stays answerable.
 */
async function decideCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  store.expireOverdueDecisions(clock());

  const [idText] = positional;
  if (idText === undefined) {
    const waiting = store.listDecisions("unanswered");
    if (json) {
      write(JSON.stringify({ ok: true, command: "decide", waiting }, null, 2));
      return waiting.length === 0 ? EXIT.ok : EXIT.refused;
    }
    if (waiting.length === 0) {
      write("Nothing waits on you. No decisions were parked.");
      return EXIT.ok;
    }
    for (const one of waiting) {
      const overdue = one.state === "expired" ? "  OVERDUE" : "";
      write(`  ${String(one.id).padEnd(4)} ${one.taskId.padEnd(20)} ${one.question}${overdue}`);
      write(`       options: ${one.options.map(option => option.id).join(" · ")}   recommended: ${one.recommendation}`);
    }
    write("");
    write("  → nightorders decide <id>       the whole screen");
    write("  → nightorders decide <id> --choose <option> --as <you> --token <t>");
    return EXIT.refused;
  }

  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) {
    return fail(write, json, "decide", "usage", "`nightorders decide [<id>] [--choose <option>]`", EXIT.usage);
  }
  const decision = store.getDecision(id);
  if (decision === null) {
    return fail(write, json, "decide", "unknown-decision", `no decision ${id}`, EXIT.refused);
  }

  const choice = text(flags, "choose");
  if (choice === undefined) {
    const evidence = store.evidenceFor(id);
    const run = store.getRun(decision.run);
    const taskId = run === null ? "?" : store.externalIdFor(run.taskRef) ?? "?";
    if (json) {
      write(JSON.stringify({ ok: true, command: "decide", decision, taskId, evidence }, null, 2));
      return EXIT.ok;
    }
    write(`${taskId} — ${decision.state.toUpperCase()}${decision.deadline === null ? "" : ` · deadline ${decision.deadline}`}`);
    write("");
    write(`  ${decision.recap}`);
    write("");
    write(`  ${decision.question}`);
    write("");
    for (const option of decision.options) {
      const marks = [
        option.id === decision.recommendation ? "recommended" : "",
        option.reversible ? "reversible" : "IRREVERSIBLE",
      ]
        .filter(mark => mark !== "")
        .join(" · ");
      write(`  [${option.id}] ${option.label}  (${marks})`);
      write(`      ${option.consequence}`);
    }
    if (decision.state === "answered") {
      write("");
      write(`  answered: ${decision.choice} by ${decision.answeredBy} at ${decision.answeredAt}${decision.note === null ? "" : ` — ${decision.note}`}`);
    }
    if (evidence.length > 0) {
      write("");
      for (const artifact of evidence) {
        write(`  evidence  ${artifact.kind.padEnd(14)} ${artifact.key}${artifact.truncated ? "  (truncated)" : ""}`);
      }
    }
    write("");
    write(`  → nightorders decide ${id} --choose <option> --as <you> --token <t>`);
    return EXIT.ok;
  }

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(
      write,
      json,
      "decide",
      "usage",
      "answering takes `--as <you> --token <t>` — who decided is recorded, not asserted",
      EXIT.usage,
    );
  }
  const { name: asWho, token } = acting;
  const authenticated = authenticateApprover(store, asWho, token);
  if (!authenticated.ok) {
    return fail(write, json, "decide", authenticated.reason, describeApproveFailure(authenticated.reason, String(id)), EXIT.refused);
  }

  const note = text(flags, "note");
  const answered = store.answerDecision(
    { id, choice, by: asWho, via: "cli", ...(note === undefined ? {} : { note }) },
    clock(),
    mutationFrom(flags, clock()),
  );
  if (!answered.ok) {
    const why =
      answered.reason === "bad-option"
        ? `"${choice}" is not one of this decision's options — \`nightorders decide ${id}\` shows them`
        : answered.reason === "already-answered"
          ? `decision ${id} was already answered differently — "decided" is not negotiable; park a new task if the answer must change`
          : answered.reason === "bad-note"
            ? "the note is too long or carries control characters"
            : `no decision ${id}`;
    return fail(write, json, "decide", answered.reason, why, EXIT.refused);
  }

  return succeed(write, json, "decide", { decision: answered.decision, duplicate: answered.duplicate === true }, () =>
    answered.duplicate === true
      ? [`Decision ${id} was already answered with ${choice} — nothing changed.`]
      : [
          `Decided: ${choice} for decision ${id}, as ${asWho}.`,
          "The task returns to the ready set; the next tick resumes it with your answer in hand.",
        ],
  );
}

/**
 * `nightorders serve [--port N] [--host H] [--allow-host name:port …]` —
 * the decision view, on a phone. Signing in takes the approver credential;
 * there is no unauthenticated bind, localhost included. Plain HTTP: put a
 * TLS proxy in front for anything beyond a trusted network — Tailscale is
 * the intended road, with its name passed via --allow-host.
 */
async function serveCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const port = Number(text(flags, "port") ?? 4180);
  const host = text(flags, "host") ?? "127.0.0.1";
  const allow = text(flags, "allow-host");
  // The authorization ceiling: --repo (comma-separable) names repos this
  // server may show; --project-root authorizes any git repo under a
  // directory. Neither given = legacy unscoped mode, everything visible.
  const repoFlag = text(flags, "repo");
  const rootFlag = text(flags, "project-root");

  const server = createDecisionServer({
    store,
    evidenceRoot: context.evidenceRoot,
    clock: context.clock,
    telegramTokenFile: context.telegramTokenFile,
    ...(allow === undefined ? {} : { allowedHosts: allow.split(",") }),
    ...(repoFlag === undefined ? {} : { repos: repoFlag.split(",").map(one => one.trim()).filter(one => one !== "") }),
    ...(rootFlag === undefined ? {} : { projectRoots: rootFlag.split(",").map(one => one.trim()).filter(one => one !== "") }),
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  }).catch(error => {
    throw new Error(`could not listen on ${host}:${port} — ${describe(error)}`);
  });

  const bound = server.address();
  const actual = typeof bound === "object" && bound !== null ? bound.port : port;
  if (json) {
    write(JSON.stringify({ ok: true, command: "serve", host, port: actual }, null, 2));
  } else {
    write(`Decisions at http://${host}:${actual}/ — sign in with your approver name and token.`);
    write("Plain HTTP: keep it on localhost or a tailnet, and put TLS in front for anything else.");
    write("Ctrl-C stops it.");
  }

  await new Promise<void>(resolve => {
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return EXIT.ok;
}

/**
 * `nightorders task requeue <id>` — the authenticated way back from a stall.
 * Resolves the task's open incidents (their holds lift with them), clears
 * strikes and backoff, and returns the task to the queue in one
 * transaction. Nothing else moves a stalled task: retrying by hand-editing
 * state would leave the incident claiming the task is stopped.
 */
async function requeueTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [id] = positional;
  if (id === undefined) {
    return fail(write, json, "task requeue", "usage", "`nightorders task requeue <id> --as <you> --token <t>`", EXIT.usage);
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task requeue", "usage", "requeueing takes `--as <you> --token <t>` — who overrode the stall is recorded, not asserted", EXIT.usage);
  }
  const { name: asWho, token } = acting;
  const authenticated = authenticateApprover(store, asWho, token);
  if (!authenticated.ok) {
    return fail(write, json, "task requeue", authenticated.reason, describeApproveFailure(authenticated.reason, id), EXIT.refused);
  }

  const result = store.requeueTask(id, asWho, clock());
  if (!result.ok) {
    return fail(write, json, "task requeue", result.reason, `no task ${id}`, EXIT.refused);
  }
  return succeed(write, json, "task requeue", { id, resolvedIncidents: result.resolvedIncidents }, () => [
    `${id} is queued again${result.resolvedIncidents > 0 ? `, ${result.resolvedIncidents} incident(s) resolved` : ""}. Strikes cleared; the next pass may take it.`,
  ]);
}

/**
 * `nightorders task plan <id>` — ask for a plan before any promise exists.
 * Authenticated like every act that spends money on the operator's behalf:
 * a planner agent will read the repository and interrogate you over the
 * decision surface, and who asked for that is recorded, not asserted.
 */
async function planTaskCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [id] = positional;
  if (id === undefined) {
    return fail(write, json, "task plan", "usage", "`nightorders task plan <id> --as <you> --token <t>`", EXIT.usage);
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task plan", "usage", "planning takes `--as <you> --token <t>` — it dispatches an agent that spends", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, "task plan", authenticated.reason, describeApproveFailure(authenticated.reason, id), EXIT.refused);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task plan", "refused", `no task ${id}`, EXIT.refused);
  }
  const ref = store.refFor(BUILT_IN, id);
  const result = store.requestPlan(ref.id, clock());
  if (!result.ok) {
    return fail(write, json, "task plan", "refused", result.reason, EXIT.refused);
  }
  return succeed(write, json, "task plan", { id }, () => [
    `${id} will be planned before it is built: the next pass dispatches a planner.`,
    "Its questions reach you like any decision; its plan lands as a scope for you to edit and approve.",
  ]);
}

/**
 * `nightorders incident list|resolve <id>` — the parks that never became
 * decisions. Resolving is an authenticated human act, the same credential as
 * approving and deciding, and it is the only thing that lifts the
 * incident's hold: `task unhold` deliberately cannot, because an operator
 * pause and a broken park are different facts owned by different acts.
 */
async function incidentCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, idText] = positional;

  if (action === undefined || action === "list") {
    const incidents = store.openIncidents();
    if (json) {
      write(JSON.stringify({ ok: true, command: "incident list", incidents }, null, 2));
      return incidents.length === 0 ? EXIT.ok : EXIT.refused;
    }
    if (incidents.length === 0) {
      write("No unresolved incidents.");
      return EXIT.ok;
    }
    for (const incident of incidents) {
      write(`  ${String(incident.id).padEnd(4)} ${incident.taskId.padEnd(20)} ${incident.kind}  since ${incident.createdAt}  run ${incident.run}`);
    }
    write("");
    write("  → nightorders incident resolve <id> --as <you> --token <t>");
    return EXIT.refused;
  }

  if (action !== "resolve") {
    return fail(write, json, "incident", "usage", "`nightorders incident [list|resolve <id>]`", EXIT.usage);
  }
  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) {
    return fail(write, json, "incident resolve", "usage", "`nightorders incident resolve <id> --as <you> --token <t>`", EXIT.usage);
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "incident resolve", "usage", "resolving takes `--as <you> --token <t>` — who looked is recorded, not asserted", EXIT.usage);
  }
  const { name: asWho, token } = acting;
  const authenticated = authenticateApprover(store, asWho, token);
  if (!authenticated.ok) {
    return fail(write, json, "incident resolve", authenticated.reason, describeApproveFailure(authenticated.reason, String(id)), EXIT.refused);
  }

  const resolved = store.resolveIncident(id, asWho, clock());
  if (!resolved) {
    return fail(write, json, "incident resolve", "unknown-or-resolved", `no unresolved incident ${id}`, EXIT.refused);
  }
  return succeed(write, json, "incident resolve", { id, by: asWho }, () => [
    `Resolved incident ${id}, as ${asWho}. The task's hold is lifted; the next tick may take it.`,
  ]);
}

/** A credential from a 0600 file, for units that must not carry it inline. */
function readTokenFile(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw === "" ? undefined : raw;
  } catch {
    return undefined;
  }
}

// ---- the daemon ------------------------------------------------------------

/**
 * `nightorders daemon install|status|uninstall|logs` — the loop as a
 * service, no crontab. Writes the platform's own supervision unit (launchd
 * on macOS, systemd --user on Linux) pointed at `nightorders watch`, with
 * the runner token in a 0600 file beside the database rather than inside
 * the unit. The OS restarts it across crashes and reboots, and watch's
 * incarnation recovery is what makes those restarts safe.
 */
async function daemonCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const [action = "status"] = positional;
  const repo = repoFrom(flags);
  const configDir = dirname(context.telegramTokenFile);
  const supervise: SupervisorRunner = context.gitRunner ?? run;

  const binFlag = text(flags, "bin");
  const resolveBin = async (): Promise<{ bin: string; binArgs: string[] } | null> => {
    if (binFlag !== undefined) return { bin: binFlag, binArgs: [] };
    const found = await supervise("sh", ["-lc", "command -v nightorders"]);
    if (found.code === 0 && found.stdout.trim() !== "") {
      return { bin: found.stdout.trim(), binArgs: [] };
    }
    return null;
  };

  if (action === "install") {
    const runnerName = text(flags, "runner");
    const token = text(flags, "token");
    if (runnerName === undefined || token === undefined) {
      return fail(write, json, "daemon install", "usage", "`nightorders daemon install --runner <name> --token <t> --repo <path>` (plus any watch flags to bake in)", EXIT.usage);
    }
    const auth = authenticate(store, runnerName, token);
    if (!auth.ok) {
      return fail(write, json, "daemon install", auth.reason, describeAuth(auth.reason, runnerName), EXIT.refused);
    }
    const located = await resolveBin();
    if (located === null) {
      return fail(
        write,
        json,
        "daemon install",
        "no-bin",
        "`nightorders` is not on the PATH the service would use — run `nightorders link` first, or pass --bin <absolute path>",
        EXIT.refused,
      );
    }

    const watchFlags: string[] = [];
    for (const name of ["pool", "model", "repair-model", "max", "turns", "tick-every", "bridge-every", "reconcile-every", "max-open-decisions"]) {
      const value = text(flags, name);
      if (value !== undefined) watchFlags.push(`--${name}`, value);
    }

    const plan = planDaemon({
      platform: process.platform,
      bin: located.bin,
      binArgs: located.binArgs,
      runner: runnerName,
      repo,
      configDir,
      watchFlags,
    });
    if ("error" in plan) return fail(write, json, "daemon install", "unsupported", plan.error, EXIT.refused);

    if (flags.has("dry-run")) {
      if (json) {
        write(JSON.stringify({ ok: true, command: "daemon install", dryRun: true, plan }, null, 2));
        return EXIT.ok;
      }
      write(`Would write ${plan.unitPath}:`);
      write("");
      write(plan.unitContent);
      write(`Token (0600): ${plan.tokenFile} · logs: ${plan.logPath}`);
      write("Nothing was written. Re-run without --dry-run to install.");
      return EXIT.ok;
    }

    const installed = await installDaemon(plan, token, supervise);
    if (!installed.ok) {
      return fail(write, json, "daemon install", "supervisor", installed.message, EXIT.failed);
    }
    return succeed(write, json, "daemon install", { label: plan.label, unit: plan.unitPath, logs: plan.logPath }, () => [
      `Installed and started ${plan.label}.`,
      `  unit    ${plan.unitPath}`,
      `  token   ${plan.tokenFile} (0600 — the unit never carries it)`,
      `  logs    ${plan.logPath}`,
      "",
      "It survives reboots and restarts itself after crashes; watch's",
      "incarnation recovery makes those restarts safe. `nightorders daemon",
      "status` to check on it, `daemon uninstall` to take it back off.",
    ]);
  }

  // status / uninstall / logs share the computed plan; the bin is cosmetic there.
  const plan = planDaemon({
    platform: process.platform,
    bin: binFlag ?? "nightorders",
    binArgs: [],
    runner: text(flags, "runner") ?? "runner",
    repo,
    configDir,
    watchFlags: [],
  });
  if ("error" in plan) return fail(write, json, `daemon ${action}`, "unsupported", plan.error, EXIT.refused);

  if (action === "status") {
    const state = await daemonStatus(plan, supervise);
    if (json) {
      write(JSON.stringify({ ok: true, command: "daemon status", ...state, label: plan.label, logs: plan.logPath }, null, 2));
      return state.state === "running" ? EXIT.ok : EXIT.refused;
    }
    write(`${plan.label}: ${state.detail}`);
    write(`  logs  ${plan.logPath}`);
    if (state.state === "not-installed") write("  → nightorders daemon install --runner <name> --token <t> --repo <path>");
    return state.state === "running" ? EXIT.ok : EXIT.refused;
  }

  if (action === "uninstall") {
    const gone = await uninstallDaemon(plan, supervise);
    return succeed(write, json, "daemon uninstall", { removed: gone.existed }, () => [
      gone.existed ? `Stopped and removed ${plan.label}.` : `${plan.label} was not installed; nothing to remove.`,
    ]);
  }

  if (action === "logs") {
    return succeed(write, json, "daemon logs", { logs: plan.logPath }, () => [
      plan.logPath,
      `  → tail -f ${plan.logPath}`,
    ]);
  }

  return fail(write, json, "daemon", "usage", "`nightorders daemon [install|status|uninstall|logs]`", EXIT.usage);
}

// ---- the watch loop --------------------------------------------------------

const WATCH_LEASE_MS = 90_000;
const WATCH_HEARTBEAT_MS = 30_000;

/**
 * `nightorders watch` — the loop (§5, §6): the cron chain as one
 * work-conserving process, still spending zero tokens while idle.
 *
 * Composition, not new semantics: every pass it runs — tick, reconcile, the
 * bridge — is the same tested command cron calls, and cron remains
 * first-class; ordinary claims make watch-and-cron coexistence safe, so
 * only watch+watch contends (per runner and repo, loudly, `watch-busy`).
 *
 * Work-conserving by the wake sequence: every readiness-changing write
 * bumps a durable counter; watch records what it saw before a pass and
 * runs again immediately if the world moved while it worked — a decision
 * answered from a phone triggers the next tick in seconds, not at the next
 * interval. Timers are the fallback, not the mechanism.
 *
 * Crash-safe by incarnation: this process's claims carry its UUID, and a
 * successor taking over the lease recovers exactly the superseded
 * incarnation's claims, runs, and worktrees before dispatching anything —
 * the case liveness cannot see, because the successor IS the runner,
 * alive and heartbeating.
 *
 * Graceful stop: a signal stops admitting new passes; the in-flight one
 * finishes under its own bounded timeouts while the lease keeps beating,
 * then the lease is handed back. (A hard kill of the provider process
 * group on grace expiry is deferred, in the ledger, with this note.)
 */
async function watchCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const runner = text(flags, "runner");
  const token = text(flags, "token") ?? readTokenFile(text(flags, "token-file"));
  if (runner === undefined || token === undefined) {
    return fail(write, json, "watch", "usage", "`nightorders watch --runner <name> --token <t>|--token-file <path> --repo <path> [--for <ms>]`", EXIT.usage);
  }
  // Passes built from these flags authenticate with the resolved token.
  flags.set("token", token);
  const auth = authenticate(store, runner, token);
  if (!auth.ok) {
    return fail(write, json, "watch", auth.reason, describeAuth(auth.reason, runner), EXIT.refused);
  }
  const repo = repoFrom(flags);

  const tickEveryMs = Number(text(flags, "tick-every") ?? 60_000);
  const bridgeEveryMs = Number(text(flags, "bridge-every") ?? 45_000);
  const reconcileEveryMs = Number(text(flags, "reconcile-every") ?? 5 * 60_000);
  const runFor = text(flags, "for") === undefined ? null : Number(text(flags, "for"));

  const incarnation = randomUUID();
  const lease = store.acquireWatchLease(runner, repo, incarnation, WATCH_LEASE_MS, new Date());
  if (!lease.ok) {
    return fail(
      write,
      json,
      "watch",
      "watch-busy",
      `another watch holds ${runner} on ${repo} until ${lease.until} — one watch per runner and repo; cron ticks may coexist, watches may not`,
      EXIT.refused,
    );
  }
  if (lease.superseded !== null) {
    const recovered = store.recoverIncarnation(runner, lease.superseded, new Date());
    if (recovered > 0) {
      write(`Recovered ${recovered} claim(s) from the previous watch (${lease.superseded.slice(0, 8)}…) before dispatching anything.`);
    }
  }

  // The night is a row, not "the last 24 hours": everything this watch does
  // attributes to this episode by runner and window, and `brief
  // --latest-watch` bounds itself to exactly it.
  store.startWatchEpisode({ repo, runner, incarnation }, new Date());

  let stopping = false;
  const followController = new AbortController();
  const stop = () => {
    stopping = true;
    // First signal: stop admitting work AND abort the in-flight long poll,
    // so shutdown is not held hostage by a poll Telegram is still holding.
    followController.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const heartbeat = setInterval(() => {
    store.heartbeatWatchLease(runner, repo, incarnation, WATCH_LEASE_MS, new Date());
  }, WATCH_HEARTBEAT_MS);
  heartbeat.unref?.();

  // The follower rides along when Telegram is configured: taps apply the
  // moment they arrive, and answering bumps the wake sequence, so the very
  // loop below wakes and resumes the freed task — phone to build, seconds.
  // The poll lease keeps this the only live poller; a cron `bridge
  // telegram` overlapping it loses the lease race and reports busy.
  let follower: Promise<FollowReport | null> | null = null;
  const followSource = loadBotToken(process.env, context.telegramTokenFile);
  if (followSource !== null) {
    const transport = context.telegramTransport ?? createTransport(followSource.token);
    follower = followBridge(store, {
      botId: followSource.botId,
      transport,
      signal: followController.signal,
      onCycle: cycle => {
        write(
          `watch: bridge sent ${cycle.sent}, answered ${cycle.answered}, paired ${cycle.paired}` +
            (cycle.problems.length > 0 ? ` — ${cycle.problems.length} problem(s)` : ""),
        );
      },
    }).catch(error => {
      write(`watch: the telegram follower died — ${describe(error)}; taps wait for the next watch`);
      return null;
    });
  }

  // Passes reuse the tested commands with a quiet sink; watch narrates one
  // line per pass that did something instead of streaming their reports.
  const quiet: string[] = [];
  const sink: Write = line => quiet.push(line);
  const passFlags = (extra: Record<string, string> = {}): Map<string, string | true> => {
    const copy = new Map(flags);
    copy.set("json", true);
    copy.set("incarnation", incarnation);
    for (const [key, value] of Object.entries(extra)) copy.set(key, value);
    return copy;
  };
  const quietContext: Context = { ...context, write: sink, json: true };

  const startedAt = Date.now();
  const deadline = runFor === null ? null : startedAt + runFor;
  let lastTick = 0;
  let lastBridge = 0;
  let lastReconcile = 0;
  let ticks = 0;
  let built = 0;
  let brokeCount = 0;

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    while (!stopping && (deadline === null || Date.now() < deadline)) {
      const seqBefore = store.wakeSeq();
      const now = Date.now();

      if (now - lastReconcile >= reconcileEveryMs) {
        lastReconcile = now;
        quiet.length = 0;
        await reconcileCommand(passFlags(), quietContext);
        // CI on the same slow cadence: red heads page once, superseded and
        // greened heads resolve their episodes, unread rollups say so.
        if (store.openedPublications().length > 0) {
          const checks = await observeChecks(store, {
            ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
          });
          if (checks.failing > 0) write(`watch: CI is red on ${checks.failing} published PR(s) — the outbox has it`);
        }
      }

      // The tick pass runs whenever the loop spins — and the loop only
      // spins when the sequence moved, a timer came due, or work just
      // finished, so this IS the schedule.
      let tickDidWork = false;
      {
        lastTick = now;
        quiet.length = 0;
        store.expireOverdueDecisions(new Date());
        const code = await tickCommand(passFlags(), quietContext);
        ticks++;
        if (code === EXIT.ok) {
          tickDidWork = true;
          built++;
          write(`watch: pass ${ticks} did work (${new Date().toISOString()})`);
        } else if (code === EXIT.failed) {
          tickDidWork = true;
          brokeCount++;
          write(`watch: pass ${ticks} broke something — the run records have it`);
        }
      }

      // Built work goes out in the same window it was built: the pass is one
      // SELECT when nothing is owed, and each phase is durable if we crash.
      if (store.pendingPublications().length > 0) {
        const published = await publishPass(store, {
          repo,
          ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
        });
        if (published.pushed + published.opened + published.adopted + published.failed > 0) {
          write(
            `watch: published — pushed ${published.pushed}, opened ${published.opened}, adopted ${published.adopted}` +
              (published.failed > 0 ? `, gave up on ${published.failed}` : ""),
          );
        }
      }

      // The embedded follower owns the wire while it lives; the timer-driven
      // pass is the fallback shape for a watch started before a token existed.
      if (follower === null && now - lastBridge >= bridgeEveryMs) {
        lastBridge = now;
        const source = loadBotToken(process.env, context.telegramTokenFile);
        if (source !== null) {
          quiet.length = 0;
          await bridgeCommand(["telegram"], passFlags(), quietContext);
        }
      }

      // Work-conserving: if the world moved while we worked — or we just
      // finished something that may have freed a dependent — go again now.
      if (tickDidWork || store.wakeSeq() !== seqBefore) continue;

      // Idle: doze in short steps until the sequence moves, a timer comes
      // due, a signal lands, or the trial window (--for) ends. Reading one
      // integer from SQLite twice a second is the entire idle cost — no
      // token has anywhere to be spent from here.
      const idleUntil =
        Math.min(
          lastTick + tickEveryMs,
          lastBridge + bridgeEveryMs,
          lastReconcile + reconcileEveryMs,
          deadline ?? Number.MAX_SAFE_INTEGER,
        ) - Date.now();
      const step = Math.max(50, Math.min(500, idleUntil));
      const seqIdle = store.wakeSeq();
      const dozeUntil = Date.now() + Math.max(step, 0);
      while (!stopping && Date.now() < dozeUntil && store.wakeSeq() === seqIdle) {
        await sleep(50);
      }
    }
  } finally {
    clearInterval(heartbeat);
    followController.abort();
    if (follower !== null) await follower;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    store.endWatchEpisode(incarnation, { ticks, built, broke: brokeCount }, new Date());
    store.releaseWatchLease(runner, repo, incarnation, new Date());
  }

  return succeed(write, json, "watch", { ticks, built, broke: brokeCount, incarnation }, () => [
    `Watched ${repo} for ${Math.round((Date.now() - startedAt) / 1000)}s: ${ticks} pass(es), ${built} with work, ${brokeCount} broke.`,
    "The lease is handed back; cron or the next watch may take it.",
  ]);
}

// ---- the telegram bridge ---------------------------------------------------

/**
 * `nightorders bridge telegram …` — decisions out, answers back, no LLM in
 * the path.
 *
 *   bridge telegram                      one pass: send pending, apply taps
 *   bridge telegram --follow             stay on the wire: long poll, apply as they arrive
 *   bridge telegram pair --as <you> --token <approver-token>
 *   bridge telegram unpair --as <you> --token <approver-token>
 *   bridge telegram token [<bot-token>|--clear]   set the credential file
 *   bridge telegram status
 *
 * The bot token comes from ${TOKEN_ENV} or the credential file this command
 * writes (0600, beside the database). Cron the pass right after tick; a
 * second concurrent pass loses the poll lease and reports `bridge-busy`,
 * which is the fences working, not an error to fix.
 */
async function bridgeCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [channel, action] = positional;
  if (channel !== "telegram") {
    return fail(write, json, "bridge", "usage", "`nightorders bridge telegram [pair|unpair|token|status]`", EXIT.usage);
  }

  if (action === "token") {
    const value = positional[2];
    if (flags.has("clear")) {
      const removed = clearBotToken(context.telegramTokenFile);
      return succeed(write, json, "bridge token", { cleared: removed }, () => [
        removed ? "Token file removed." : "There was no token file to remove.",
      ]);
    }
    if (value === undefined) {
      return fail(
        write,
        json,
        "bridge token",
        "usage",
        "`nightorders bridge telegram token <bot-token>` (from @BotFather), or --clear",
        EXIT.usage,
      );
    }
    const saved = saveBotToken(context.telegramTokenFile, value);
    if (!saved.ok) return fail(write, json, "bridge token", "bad-token", saved.message, EXIT.refused);
    return succeed(write, json, "bridge token", { saved: true, file: context.telegramTokenFile }, () => [
      `Saved (owner-only) to ${context.telegramTokenFile}.`,
      `${TOKEN_ENV} in the environment would take precedence over it.`,
    ]);
  }

  const source = loadBotToken(process.env, context.telegramTokenFile);

  if (action === "status") {
    const binding = source === null ? null : store.liveTelegramBinding(source.botId);
    const pending = store.listNotifications("pending").length;
    if (json) {
      write(
        JSON.stringify(
          {
            ok: true,
            command: "bridge status",
            token: source === null ? null : { source: source.source, botId: source.botId, redacted: redactToken(source.token) },
            paired: binding !== null,
            approver: binding?.approver ?? null,
            outboxPending: pending,
          },
          null,
          2,
        ),
      );
      return EXIT.ok;
    }
    write(source === null
      ? `No bot token. Set ${TOKEN_ENV}, run \`nightorders bridge telegram token <t>\`, or use the serve settings card.`
      : `Token ${redactToken(source.token)} (${source.source}), bot ${source.botId}.`);
    write(binding === null ? "No chat is paired." : `Paired: chat answers as ${binding.approver}.`);
    write(`Outbox pending: ${pending}.`);
    return EXIT.ok;
  }

  if (action === "pair" || action === "unpair") {
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `bridge ${action}`, "usage", "`--as <you> --token <your password>` — pairing hands your authority to a chat, so it takes your credential", EXIT.usage);
    }
    const { name: asWho, token } = acting;
    const authenticated = authenticateApprover(store, asWho, token);
    if (!authenticated.ok) {
      return fail(write, json, `bridge ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, asWho), EXIT.refused);
    }

    if (action === "unpair") {
      if (source === null) {
        return fail(write, json, "bridge unpair", "no-token", "no bot token, so no bot to unpair", EXIT.refused);
      }
      const revoked = store.unpairTelegram(source.botId, asWho, clock());
      return succeed(write, json, "bridge unpair", { revoked }, () => [
        revoked
          ? "Unpaired. Every outstanding button from that chat is dead. Rotate the bot token with @BotFather if it may have leaked."
          : "Nothing was paired.",
      ]);
    }

    const code = mintPairingCode();
    store.createTelegramPairing(
      { codeHash: hashPairingCode(code), approver: asWho, by: asWho, ttlMs: PAIRING_TTL_MS },
      clock(),
    );
    return succeed(write, json, "bridge pair", { code, expiresInMs: PAIRING_TTL_MS }, () => [
      "From your phone, send your bot this message within 10 minutes:",
      "",
      `  /pair ${code}`,
      "",
      "The next bridge pass completes it. The code works once, in a private",
      "chat only, and the chat will answer as you — treat it accordingly.",
    ]);
  }

  if (action !== undefined) {
    return fail(write, json, "bridge", "usage", "`nightorders bridge telegram [pair|unpair|token|status]`", EXIT.usage);
  }

  // The pass.
  if (source === null) {
    return fail(
      write,
      json,
      "bridge",
      "no-token",
      `no bot token — set ${TOKEN_ENV}, run \`nightorders bridge telegram token <t>\`, or use the serve settings card`,
      EXIT.refused,
    );
  }
  const transport = context.telegramTransport ?? createTransport(source.token);

  // --follow: stay on the wire. One long-poll actor holds the poll lease;
  // an answer tapped on a phone lands in seconds instead of at the next
  // cron firing. Ctrl-C (or --for, for trials) stops it cleanly — the
  // in-flight long poll is aborted, not waited out.
  if (flags.has("follow")) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const runFor = text(flags, "for");
    const timer = runFor === undefined ? null : setTimeout(() => controller.abort(), Number(runFor));
    timer?.unref?.();
    if (!json) write(`Following bot ${source.botId} — taps apply as they arrive. Ctrl-C stops it.`);
    try {
      const report = await followBridge(store, {
        botId: source.botId,
        transport,
        signal: controller.signal,
        clock,
        ...(text(flags, "poll") === undefined ? {} : { pollSeconds: Number(text(flags, "poll")) }),
        onCycle: cycle => {
          if (!json) {
            write(
              `bridge: sent ${cycle.sent}, answered ${cycle.answered}, paired ${cycle.paired}` +
                (cycle.problems.length > 0 ? ` — ${cycle.problems.length} problem(s)` : ""),
            );
          }
        },
      });
      return succeed(write, json, "bridge follow", { report }, () => [
        `Followed for ${report.cycles} cycle(s): sent ${report.sent}, answered ${report.answered}, paired ${report.paired}, ignored ${report.ignored}.`,
        ...report.problems.slice(-5).map(problem => `  problem: ${problem}`),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }

  const passed = await bridgePass(store, { botId: source.botId, transport, clock });
  if (!passed.ok) {
    return fail(write, json, "bridge", passed.reason, passed.message, EXIT.refused);
  }

  const { report } = passed;
  const broke = report.problems.length > 0;
  const idle = report.sent === 0 && report.answered === 0 && report.paired === 0;
  const lines = () => [
    `Sent ${report.sent}, answered ${report.answered}, paired ${report.paired}, ignored ${report.ignored}.`,
    ...(report.backlog ? ["Telegram still holds more updates than one pass's budget — run it again."] : []),
    ...report.problems.map(problem => `  problem: ${problem}`),
  ];
  if (broke) {
    return fail(write, json, "bridge", "telegram-transport", lines().join("\n"), EXIT.failed, { report });
  }
  if (idle) {
    return fail(write, json, "bridge", "idle", "nothing to send, nothing arrived", EXIT.refused, { report });
  }
  return succeed(write, json, "bridge", { report }, lines);
}

// ---- publication -----------------------------------------------------------

/**
 * `nightorders publish …` — built work to a pushed branch and a PR, under a
 * grant whose terms were shown before the yes.
 *
 *   publish                              one pass: push intents, open/adopt PRs
 *   publish grant --github <owner/name> [--base main] [--remote origin]
 *                 [--head-prefix nightorders/] [--all-tasks] [--ready]
 *                 --as <you> --token <approver-token> [--yes]
 *   publish revoke --as <you> --token <approver-token>
 *   publish status
 *
 * Granting without --yes prints the exact terms and does nothing — the same
 * see-it-first ceremony as a scope approval. Revocation is immediate: the
 * next pass pushes nothing, whatever intents exist.
 */
async function publishCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const repo = repoFrom(flags);
  const [action] = positional;

  if (action === "grant") {
    const github = text(flags, "github");
    if (github === undefined || !/^[\w.-]+\/[\w.-]+$/.test(github)) {
      return fail(write, json, "publish grant", "usage", "`--github <owner/name>` is required, exactly", EXIT.usage);
    }
    const spec = {
      repo,
      githubRepo: github,
      remote: text(flags, "remote") ?? "origin",
      headPrefix: text(flags, "head-prefix") ?? "nightorders/",
      base: text(flags, "base") ?? "main",
      capabilities: ["push-branch", "open-pr"] as ("push-branch" | "open-pr")[],
      selector: (flags.has("all-tasks") ? "all" : "ours") as "all" | "ours",
      draft: !flags.has("ready"),
    };

    if (!flags.has("yes")) {
      return succeed(write, json, "publish grant", { proposed: spec, granted: false }, () => [
        "This grant would allow, unattended:",
        ...describePublicationGrant(spec),
        "",
        "Nothing is granted yet. Repeat with --yes --as <you> --token <approver-token> to agree to exactly this.",
      ]);
    }

    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "publish grant", "usage", "granting takes --as <you> --token <your password> — pushing your repos is a person's yes", EXIT.usage);
    }
    const { name: asWho, token } = acting;
    const authenticated = authenticateApprover(store, asWho, token);
    if (!authenticated.ok) {
      return fail(write, json, "publish grant", authenticated.reason, describeApproveFailure(authenticated.reason, asWho), EXIT.refused);
    }

    store.savePublicationGrant({ ...spec, grantedBy: asWho }, clock());
    return succeed(write, json, "publish grant", { granted: true, grant: spec }, () => [
      `Granted by ${asWho}:`,
      ...describePublicationGrant(spec),
      "Revoke any time: `nightorders publish revoke --as <you> --token <t>`.",
    ]);
  }

  if (action === "revoke") {
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, "publish revoke", "usage", "`--as <you> --token <your password>`", EXIT.usage);
    }
    const { name: asWho, token } = acting;
    const authenticated = authenticateApprover(store, asWho, token);
    if (!authenticated.ok) {
      return fail(write, json, "publish revoke", authenticated.reason, describeApproveFailure(authenticated.reason, asWho), EXIT.refused);
    }
    const revoked = store.revokePublicationGrant(repo, asWho, clock());
    return succeed(write, json, "publish revoke", { revoked }, () => [
      revoked
        ? "Revoked. The next pass pushes nothing, whatever intents exist."
        : "There was no live grant to revoke.",
    ]);
  }

  if (action === "status") {
    const grant = store.publicationGrantFor(repo);
    const pending = store.pendingPublications();
    if (json) {
      write(JSON.stringify({ ok: true, command: "publish status", grant, pending }, null, 2));
      return EXIT.ok;
    }
    write(grant === null ? "No live publication grant." : `Granted by ${grant.grantedBy} at ${grant.grantedAt}:`);
    if (grant !== null) for (const line of describePublicationGrant(grant)) write(line);
    write(pending.length === 0 ? "Nothing owed." : `Owed: ${pending.length} publication(s) pending.`);
    return EXIT.ok;
  }

  if (action !== undefined) {
    return fail(write, json, "publish", "usage", "`nightorders publish [grant|revoke|status]`", EXIT.usage);
  }

  // The pass.
  const report = await publishPass(store, {
    repo,
    clock,
    ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
  });
  const idle = report.pushed === 0 && report.opened === 0 && report.adopted === 0 && report.failed === 0;
  const lines = () => [
    `Pushed ${report.pushed}, opened ${report.opened}, adopted ${report.adopted}, gave up on ${report.failed}.`,
    ...report.problems.map(problem => `  problem: ${problem}`),
  ];
  if (report.problems.length > 0) {
    return fail(write, json, "publish", "publish-problems", lines().join("\n"), EXIT.failed, { report });
  }
  if (idle) {
    return fail(write, json, "publish", "idle", "nothing owed — no pending publications", EXIT.refused, { report });
  }
  return succeed(write, json, "publish", { report }, lines);
}

// ---- the outbox -----------------------------------------------------------

/**
 * `nightorders outbox list|deliver` — reading and draining the durable
 * outbox. Delivery runs an operator-supplied command once per pending row;
 * the notification's text reaches it as environment variables, never
 * substituted into the command line, because subjects and bodies quote
 * things agents and repositories said and a shell must not meet those.
 *
 *   nightorders outbox deliver --cmd 'curl -d "$NIGHTORDERS_SUBJECT" ntfy.sh/mine'
 *
 * Exit 0 when everything pending delivered (or nothing was pending);
 * 1 when any delivery failed — a broken channel is breakage, not a "no".
 */
async function outboxCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action] = positional;

  if (action === "list" || action === undefined) {
    const wanted = flags.has("all") ? "all" : "pending";
    const notifications = store.listNotifications(wanted);
    if (json) {
      write(JSON.stringify({ ok: true, command: "outbox list", notifications }, null, 2));
      return EXIT.ok;
    }
    if (notifications.length === 0) {
      write(wanted === "pending" ? "Nothing waiting to be delivered." : "The outbox is empty.");
      return EXIT.ok;
    }
    for (const one of notifications) {
      const state =
        one.deliveredAt !== null
          ? `delivered ${one.deliveredAt}`
          : one.attempts > 0
            ? `pending, ${one.attempts} failed attempt(s): ${one.lastError ?? ""}`
            : "pending";
      write(`  #${one.id} ${one.kind.padEnd(18)} ${one.subject}`);
      write(`      ${state}`);
    }
    return EXIT.ok;
  }

  if (action === "deliver") {
    const command = text(flags, "cmd");
    if (command === undefined) {
      return fail(write, json, "outbox deliver", "usage", "--cmd says how: it runs once per notification, reading $NIGHTORDERS_KIND, $NIGHTORDERS_SUBJECT, $NIGHTORDERS_BODY", EXIT.usage);
    }

    // Claimed, not merely listed: the Telegram bridge drains this same
    // outbox, and select-then-send-then-record from two deliverers pages a
    // person twice. The claim is a short lease on the act of sending; a
    // deliverer that dies mid-send leaves rows that unclaim by expiry.
    const owner = `outbox-${randomUUID()}`;
    const pending = store.claimDeliveries(owner, 2 * 60_000, clock());
    if (pending.length === 0) {
      return succeed(write, json, "outbox deliver", { delivered: 0, failed: 0 }, () => [
        "Nothing waiting to be delivered.",
      ]);
    }

    let delivered = 0;
    let failed = 0;
    for (const one of pending) {
      const sent = await run("sh", ["-lc", command], {
        timeoutMs: 30_000,
        env: {
          NIGHTORDERS_KIND: one.kind,
          NIGHTORDERS_SUBJECT: one.subject,
          NIGHTORDERS_BODY: one.body,
          NIGHTORDERS_DEDUPE_KEY: one.dedupeKey,
        },
      });
      if (sent.code === 0) {
        const receipt = sent.stdout.split("\n")[0]?.trim() ?? "";
        store.finalizeDelivery(one.id, owner, { ok: true, receipt: receipt === "" ? null : receipt }, clock());
        delivered++;
      } else {
        const error = sent.timedOut
          ? "timed out"
          : sent.stderr.split("\n")[0]?.trim() || `exit ${sent.code}`;
        store.finalizeDelivery(one.id, owner, { ok: false, error }, clock());
        failed++;
      }
    }

    const code = failed > 0 ? EXIT.failed : EXIT.ok;
    if (json) {
      write(JSON.stringify({ ok: failed === 0, command: "outbox deliver", delivered, failed }, null, 2));
      return code;
    }
    write(`Delivered ${delivered}, failed ${failed}.`);
    return code;
  }

  return fail(write, json, "outbox", "usage", `unknown \`outbox ${action}\` — try list, deliver`, EXIT.usage);
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
    case "requeue":
      return requeueTask(rest, flags, context);
    case "plan":
      return planTaskCommand(rest, flags, context);
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
    const placed = store.placeTask(store.refFor(BUILT_IN, id).id, canonicalProject(placedIn) ?? resolve(placedIn));
    if (typeof placed === "object" && !placed.ok) {
      return fail(write, json, "task add", "scoped", "this task already has a scope — placement is immutable once somebody could have approved it", EXIT.refused);
    }
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

  if (action === "scan") {
    const report = scanRepo(repo);
    let recorded = 0;
    for (const one of report.found) {
      // Scan proposes; it never overwrites. A capability the operator wrote
      // — or a probe they tuned — outranks anything a file implies.
      if (store.getCapability(repo, one.kind, one.name) !== null) continue;
      store.saveCapability({
        repo,
        kind: one.kind,
        name: one.name,
        probe: one.probe,
        status: "unprobed",
        addedBy: `scan:${one.source}`,
        createdAt: clock().toISOString(),
        lastVerifiedAt: null,
        verifiedBy: null,
        lastResult: null,
        expiresAt: null,
      });
      recorded++;
    }
    if (json) {
      write(JSON.stringify({ ok: true, command: "cap scan", repo, recorded, ...report }, null, 2));
      return EXIT.ok;
    }
    if (report.found.length === 0) {
      write(`Nothing detected in ${repo}. Detection reads .env.example, .mcp.json, supabase/config.toml and workflow files.`);
      return EXIT.ok;
    }
    for (const one of report.found) {
      write(`  ${`${one.kind}:${one.name}`.padEnd(32)} ${one.source}${one.probe === null ? "  (no probe)" : ""}`);
    }
    for (const bad of report.rejected) {
      write(`  rejected ${bad.name} from ${bad.source} — not a valid identifier`);
    }
    write("");
    write(`${recorded} new, ${report.found.length - recorded} already recorded. Nothing is verified: \`nightorders cap probe\`.`);
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

  return fail(write, json, "cap", "usage", `unknown \`cap ${action}\` — try add, list, scan, probe`, EXIT.usage);
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
async function approveTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, now } = context;
  const id = positional[0];
  if (id === undefined) {
    return fail(write, json, "task approve", "usage", "which task?", EXIT.usage);
  }

  const scope = store.getScope(id);
  if (scope === null) {
    return fail(write, json, "task approve", "no-scope", `${id} has no scope to approve — write one first`, EXIT.refused);
  }

  let saw = text(flags, "digest");
  let asWho = text(flags, "as");
  let token = text(flags, "token");

  let confirmedAloud = false;
  // At a terminal, approval is a conversation, not flag assembly: the scope
  // prints, a person says yes to exactly what printed, and the digest that
  // binds the yes is the one this very process just displayed — approve()
  // still re-proves it transactionally, so a scope swapped mid-read refuses.
  if ((!flags.has("yes") || saw === undefined || asWho === undefined || token === undefined) &&
      interactive() && !json) {
    write(`Approving lets a builder work on ${id}, within exactly this:`);
    write("");
    for (const line of describeScope(scope)) write(line);
    write("");
    const agreed = await confirm("Approve exactly this?");
    if (!agreed) {
      write("Nothing approved.");
      return EXIT.refused;
    }
    saw ??= scope.digest;
    const acting = await askCredentials(flags, context);
    if (acting === null) return fail(write, json, "task approve", "usage", "approval needs who is agreeing", EXIT.usage);
    asWho = acting.name;
    token = acting.token;
    confirmedAloud = true;
  }

  const armed =
    (flags.has("yes") || confirmedAloud) &&
    saw !== undefined && asWho !== undefined && token !== undefined;
  if (!armed) {
    if (json) {
      write(JSON.stringify({ ok: false, command: "task approve", reason: "unconfirmed", scope }, null, 2));
      return EXIT.refused;
    }
    write(`Would approve this, and let a builder work on ${id}:`);
    write("");
    for (const line of describeScope(scope)) write(line);
    write("");
    write("Nothing has been approved. Agree to this exact scope with:");
    write(`  nightorders task approve ${id} --yes --digest ${scope.digest} --as <you> --token <your password>`);
    return EXIT.ok;
  }
  if (saw === undefined || asWho === undefined || token === undefined) {
    return fail(write, json, "task approve", "usage", "approving non-interactively takes --yes --digest <d> --as <you> --token <t>", EXIT.usage);
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
/**
 * Who is acting, from flags — or from a person at the terminal. Scripts and
 * agents pass --as/--token and never see a prompt; a human who left them off
 * is simply asked, with the password hidden. Under --json (or any non-TTY)
 * missing credentials stay a usage refusal, exactly as before.
 */
async function askCredentials(
  flags: Map<string, string | true>,
  context: Context,
): Promise<{ name: string; token: string } | null> {
  let name = text(flags, "as");
  let token = text(flags, "token");
  if ((name === undefined || token === undefined) && interactive() && !context.json) {
    name ??= await ask("username: ");
    token ??= await askHidden("password: ");
  }
  if (name === undefined || token === undefined || name === "" || token === "") return null;
  return { name, token };
}

async function approverCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
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
    let password = text(flags, "password");
    const bootstrap = store.listApprovers().length === 0;
    let by: { name: string; token: string } | undefined;
    if (!bootstrap) {
      const vouched = await askCredentials(flags, context);
      if (vouched !== null) by = vouched;
    }
    if (password === undefined && interactive() && !json) {
      const chosen = await askHidden(`password for ${name} (enter to auto-generate): `);
      if (chosen !== "") {
        const again = await askHidden("again: ");
        if (again !== chosen) {
          return fail(write, json, "approver add", "mismatch", "the two passwords did not match", EXIT.refused);
        }
        password = chosen;
      }
    }

    const added = addApprover(store, name, now, by, undefined, mutationFrom(flags, now), password);
    if (!added.ok) {
      return fail(
        write,
        json,
        "approver add",
        added.reason,
        added.reason === "weak-password"
          ? "a password needs at least 8 characters"
          : "only an existing approver can add another — `--as <you> --token <your password>`",
        EXIT.refused,
      );
    }

    return succeed(write, json, "approver add", { ...added, ...(added.chosen ? { token: "(chosen)" } : {}) }, () => [
      `${added.name} may now sign in and approve scopes.`,
      "",
      ...(added.chosen
        ? ["Password set — stored salted and stretched, never readable again."]
        : [
            `  password  ${added.token}`,
            "",
            "Shown once, stored only as a hash. Keep it somewhere an agent cannot read",
            "(or choose your own next time: `approver add <name> --password <yours>`).",
          ]),
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
