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

import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  openStore,
  databasePath,
  BUILT_IN,
  DEFAULT_ACTOR,
  parseCapabilityKey,
  verifiedAuthor,
  contestantProfileOf,
  type Capability,
  type Store,
  type TaskState,
} from "./store.js";
import { randomBytes, randomUUID } from "node:crypto";
import { ghDispatchAdapter, mirrorTaskId, syncPass, type DispatchAdapter } from "./sync.js";
import { sweepLiveLogs } from "./live.js";
import { configPath, addRepos, updateRepos } from "./repos.js";
import { pushPass } from "./push.js";
import { closeSync, constants as fsConstants, existsSync, fsyncSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync, mkdirSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { spawn as spawnChild } from "node:child_process";
import { envelopeJson } from "./envelope.js";
import { hasDisguisedText, hasForbiddenControls, validateNote } from "./decision.js";
import { readVerifiedArtifact } from "./evidence.js";
import { probeRepo, isVerified } from "./probe.js";

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
  sweepMerges,
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
  SYNC_MAX_AGE_MS,
  acquireContinuation,
} from "./claim.js";
import { disposeBuildOutcome } from "./dispose.js";
import { attendedLivenessState } from "./liveness.js";
import { HeldSessionCoordinator, sweepHeldOrphans } from "./held.js";
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
  acquireWatchLeaseAuthed,
  heartbeatWatchLeaseAuthed,
  registerRunnerIfIdle,
  retireRunnerIfCurrent,
  normalizeRunnerName,
  validRunnerName,
  RUNNER_NAME_MAX,
} from "./runner.js";
import { propose, approve, addApprover, authenticateApprover, describeScope, approvalOf, hashToken as hashApproverToken, profileFromJson, type ExecutionProfile } from "./scope.js";
import { WorktreePool } from "./worktree.js";
import {
  approveRoutine,
  describeRoutine,
  fireRoutine,
  routineDigestOf,
  validateRoutineTerms,
  ROUTINE_NAME,
  type RoutineTerms,
} from "./routine.js";
import { fileTaskProposal, fileRoutineProposal, validateTaskText } from "./proposal.js";
import { TEMPLATES, templateByName } from "./templates.js";
import { planTournament, planComparison, contestNoun, jointApprovalDigest, admitContest, crossReadyBarrier, finalizeContestant, recoverContests, maybeAggregate as contestMaybeAggregate, sweepContestCleanup, escalateOverdueContests } from "./contest.js";
import { priceOf, PRICED_MODELS } from "./converse.js";
import { resolvePhaseAgent, resolveScopeProfile, INSTALLATION_SCOPE } from "./agentconfig.js";
import { clearWebhook, effectivePrimary, isMessagingChannel, loadConsoleUrl, loadPrimary, loadWebhookTargets, saveConsoleUrl, savePrimary, saveWebhook, webhookPass, SLACK_ENV, DISCORD_ENV } from "./webhooks.js";
import { auditOf, inspectionOf, isProviderId, MONEY_CAPABILITIES, PROVIDER_IDS, validateSpec, type ProviderAudit, type ProviderId } from "./provider.js";
import { attestProvider, attestationOf, versionInRange, type AttestOutcome, type AttestationRange } from "./attest.js";
import {
  build,
  type Runner as CommandRunner,
} from "./builder.js";
import { plan as planTask } from "./planner.js";
import { run, terminateLiveProviders } from "./exec.js";
import { readPulls } from "./pulls.js";
import { beads } from "./beads.js";
import { githubIssues } from "./issues.js";

export type Write = (line: string) => void;

/**
 * 0 done · 1 broke · 2 bad usage · 3 ran fine, the answer is no.
 *
 * 3 is the one that matters. `standing-orders claim` losing a race and
 * `standing-orders claim` failing to open the database must not look the same to a
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
  /** Injected by tests: the stop fence a watch would set. */
  shouldStop?: () => boolean;
  /** Injected by tests: the external-dispatch gh surface. */
  dispatchAdapter?: DispatchAdapter;
};

const STATES: readonly TaskState[] = ["queued", "running", "done", "failed", "cancelled"];

export const OPERATE_HELP = `standing-orders — operating the queue

  standing-orders ready                     what could be dispatched right now
  standing-orders task add <title>          queue work
  standing-orders task list [--state <s>]   everything, or one state
  standing-orders task show <id>
  standing-orders task state <id> <state>   queued|running|done|failed|cancelled
  standing-orders task block <id> --on <id> <id> waits for <on>
  standing-orders task unblock <id> --on <id>  stop waiting for <on>
  standing-orders task next <id> [--undo]   move it to the front of ITS
                                        queue (scheduling only — approval
                                        is still required); --undo puts it
                                        back in filing order
  standing-orders task steer <id> --note "..."
                                        guidance for the next attempt — it
                                        reads the note before starting; a
                                        running agent is not interrupted
  standing-orders task assign <id> --runner <name> | --anyone
                                        reserve it for one worker (it joins
                                        the back of that worker's queue) or
                                        return it to the shared queue
  standing-orders task reopen <id> --as <you> --token <t>
                                        resume external work its tracker
                                        closed and has been SEEN open again

External trackers — build what a tracker nominates, under local approvals
  standing-orders enroll <repo> --backend github-issues --github <owner/name>
      --allow-dispatch [--selector ours|all] --yes
                                        the dispatch grant: its own explicit
                                        yes, never in any default; writes a
                                        plane marker label to the repository
  standing-orders publish grant --github <owner/name> --allow-merge
      --merge-method squash|merge|rebase [--merge-delete-branch] --yes
                                        auto-merge this plane's own PRs —
                                        ONLY after CI was OBSERVED green on
                                        the exact head commit; drafts,
                                        merge queues, and unreadable
                                        protection refuse, typed and paged
  standing-orders publish unblock <pr> --as <you> --token <t>
                                        lift a repair's merge hold
  standing-orders publish rearm <pr> --as <you> --token <t>
                                        re-arm a refused merge after you
                                        fixed the named cause
  standing-orders sync [--repo <path>]      pull nominated work in as ordinary
                                        local tasks (titles only, validated;
                                        bodies never), refresh every mirror
                                        INDIVIDUALLY, verify the marker, and
                                        deliver write-backs — zero tokens,
                                        fail closed; runs with reconcile and
                                        under watch automatically
  standing-orders task hold <id> --reason <why> [--until <iso>]
  standing-orders task unhold <id>

  standing-orders approver add <name> [--password <p>]
                                        mint the credential that lets a
                                        person say yes; the bootstrap for
                                        every approving act
  standing-orders approver list
  standing-orders task scope <id> --goal <what success is>
      [--not <text>] [--touches a,b] [--budget-usd <n>]
      [--race provider:model[,provider:model…]] [--race-count 2..4]
      [--race-per-usd <n>] [--race-total-usd <n>]
      [--compare provider:model[,provider:model…]]  (labeled comparison — no dollar caps; needs a lane no budget can bound)
                                        a tournament races 2-4 agents on the
                                        task; you compare and pick one
  standing-orders task approve <id>         the yes — interactive, or
      --yes --digest <d> --as <you> --token <t> for scripts; a tournament
      approves both documents with one yes, on the joint fingerprint
  standing-orders task requeue <id> --as <you> --token <t>
                                        exit a stall: incidents resolved,
                                        strikes cleared, queued again
  standing-orders config set budgets [--build-usd <n>] [--race-per-usd <n>]
      [--race-total-usd <n>] [--race-agents 2..4] --as <you> --token <t>
                                        spend defaults new filings pre-fill
                                        from; config clear budgets resets

  standing-orders claim <id> --runner <name> [--ttl <seconds>]
  standing-orders heartbeat <lease>         still working; extends the lease
  standing-orders release <lease>           done with it; fenced if superseded
  standing-orders reap                      release every lease that ran out

  standing-orders tick --runner <name> --token <t> --repo <path>
                                        one unattended pass: claim what is
                                        ready and approved, build it in a
                                        leased worktree, commit to a branch.
                                        [--max <n>] tasks (default 1),
                                        [--base <ref>] for first attempts.
                                        Never pushes.
  standing-orders up [--repo <path>]...     one command to a working cockpit:
                                        console + worker + browser. Mints
                                        your login on first run (saved to
                                        up-login.txt beside the database),
                                        registers this machine as a worker,
                                        and watches every named repository
                                        (none named: the current one).
                                        --no-open skips the browser;
                                        --runner names the worker;
                                        --editor vscode links changed files
                                        to VS Code on the device you browse
                                        from (turn on per device, in the
                                        build page's review section).
  standing-orders reconcile --repo <path>   the morning sweep: recover dead
                                        runners, reap expired leases, adopt
                                        or forget orphaned worktrees. Run it
                                        before tick.

Capabilities — what the work needs, recorded and probed, never valued
  standing-orders cap add <name> [--kind env|cli|mcp|ci|other] [--probe <cmd>]
                                        env kind synthesizes test -n "$NAME"
  standing-orders cap list [--repo <path>]
  standing-orders cap probe [<kind:name>…]  ask the environment; exit 0 all
                                        verified, 3 any gap
  standing-orders task require <id> --cap <kind:name>[,…]
                                        nothing dispatches it until every
                                        one is verified (--cap none clears)
  standing-orders gaps [--repo <path>]      what is missing, ranked by how many
                                        tasks filling it would start

  standing-orders task plan <id> --as <you> --token <t>
                                        plan before building: an agent reads
                                        the repo, asks you questions, and
                                        proposes a scope you approve

Routines — standing orders that fire on a schedule, each instance isolated
  standing-orders template list             common standing orders, shipped
  standing-orders template show <name>      the full prefill + what to edit
  standing-orders template apply <name> --repo <path> [--file]
      previews the exact filing; --file files it UNAPPROVED through the
      same door as a manual filing — a template carries no authority

  standing-orders routine add <name> --repo <path> --goal <text>
      --schedule every:<min>|daily:<HH:MM>   (UTC)
      [--not <text>] [--touches a,b] [--require kind:name,…] [--ceiling <usd>]
      [--budget-usd <n>]                    what each firing may spend
  standing-orders routine approve <name>    the step-up: approving means each
                                        firing builds WITHOUT asking, inside
                                        exactly the stated terms; editing any
                                        term voids the approval
  standing-orders routine list | show <name>
  standing-orders routine pause|resume <name>
  standing-orders routine run-now <name> --as <you> --token <t>

Agents — which provider and model each phase runs on
  standing-orders providers                 what is installed, logged in, and
                                        configured on this machine — without
                                        spending anything to find out
  standing-orders config set chat --provider anthropic-api|openrouter-api
      --model <m> --weekly-usd <n> [--daily-turns <n>] --as <you> --token <t>
      the fleet chat engine: a direct no-tool API call; the key rides the
      serve environment, the ceiling is enforced in integer micro-dollars
  standing-orders config show [--repo <path>]
  standing-orders config set <phase> --provider claude|codex|openrouter
      [--model <m>] [--repo <path>] --as <you> --token <t>
                                        phases: plan | build | repair. The
                                        repo form is a project override;
                                        without it, installation-wide.
                                        Repair's PROVIDER always inherits
                                        the build it mends.
  standing-orders config clear <phase> [--repo <path>] --as <you> --token <t>

  standing-orders setup show --repo <path>  what a fresh checkout runs first
  standing-orders setup set --repo <path> --command "npm ci"
      [--timeout-seconds <n>] --as <you> --token <t> [--yes]
                                        approve the command every fresh
                                        worktree runs before any agent —
                                        a failed setup blocks the build
  standing-orders setup clear --repo <path> --as <you> --token <t>
  Pass flags still win for one pass: --provider/--model,
  --plan-provider/--plan-model, --repair-model. A routine instance is
  pinned at fire time and ignores all of them.
  standing-orders brief [--repo <path>] [--local] [--since <iso>]
                                        the report: recent runs, gaps,
                                        PRs (--local skips the network and
                                        says REVIEW was not read)

The outbox — facts that want a person, durably
  standing-orders webhook set slack|discord <url>
                                        UI-only chat mirrors: every page a
                                        message with a console link; acting
                                        stays in the console. Delivers when
                                        Telegram is not configured.
  standing-orders webhook set console-url <http://host:port>
  standing-orders webhook primary telegram|slack|discord
                                        which service receives alerts when
                                        several are connected (asked once,
                                        the first time you add a second)
  standing-orders webhook status | test | clear slack|discord
  standing-orders outbox list [--all]
  standing-orders outbox deliver --cmd <c>  runs once per pending row, reading
                                        $STANDING_ORDERS_KIND / _SUBJECT / _BODY;
                                        exit 0 delivered receipts, 1 any fail

Runners — the machines that may be given work
  standing-orders runner register <name> [--capacity <n>]
                                        mints a token, shown once
  standing-orders runner list               who is registered, and answering
  standing-orders runner heartbeat <name> --token <token>
  standing-orders runner reap               take back what a dead runner held
  standing-orders runner retire <name>

Write access — discovery stays read-only until you grant it
  standing-orders enroll [repo] --backend <name> --paths <p>[,<p>]
                                        show what it would grant; --yes agrees
  standing-orders grants                    what has been granted, and to what
  standing-orders revoke [repo] --backend <name>

  --allow <a,b>     mutation classes (default: ${DEFAULT_MUTATIONS.join(",")})
  --selector ours|all   which tasks (default: ours — never a whole backlog)
  --credentials <name>  which credential scope it may use

Options
  --help            this, from any queue command — nothing runs, nothing is created
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
  /** EVERY --repo occurrence, in order (arc 2 finding 22): the Map keeps its
   * last-wins behavior for every existing verb; only `up` reads this. */
  repoList: string[];
};

/**
 * The subcommand inventories the dispatchers consult (arc 5): each verb's
 * runner refuses an action outside its list BEFORE its switch, so these
 * exports are behavior, not commentary — and the declared command guide
 * (surface.ts) is tested for exact equality against them.
 */
export const TASK_ACTIONS = [
  "add", "list", "show", "state", "block", "unblock", "next", "steer", "assign",
  "reopen", "scope", "approve", "hold", "unhold", "require", "requeue", "plan",
] as const;
export const PUBLISH_ACTIONS = ["grant", "revoke", "status", "unblock", "rearm"] as const;
export const CONFIG_ACTIONS = ["show", "set", "clear"] as const;
export const APPROVER_ACTIONS = ["list", "add"] as const;
export const ROUTINE_ACTIONS = ["list", "add", "show", "approve", "pause", "resume", "run-now"] as const;
export const CONTEST_ACTIONS = ["show", "exclude"] as const;

/**
 * The GLOBAL flag vocabulary (exported for the command guide's drift
 * tests): every value-taking flag any verb reads, and every boolean.
 * A --flag in neither set is a typo, refused by name.
 */
export const OPERATE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "key", "db", "runner", "ttl", "state", "on", "reason", "until", "id", "backend",
  "allow", "selector", "paths", "credentials", "repo", "token", "capacity",
  "goal", "not", "touches", "by", "digest", "as", "branch", "pool", "base", "model", "turns",
  "max", "cap", "probe", "kind", "expires", "cmd", "since", "repair-model",
  "choose", "note", "max-open-decisions", "max-held-sessions", "port", "host", "allow-host",
  "for", "tick-every", "bridge-every", "reconcile-every", "incarnation",
  "token-file", "bin", "poll", "github", "remote", "head-prefix", "password",
  "project-root", "schedule", "ceiling", "require",
  "provider", "plan-model", "plan-provider", "public-url", "editor",
  "command", "timeout-seconds", "stop-grace", "title", "name",
  "label", "reviewers", "limit", "weekly-usd", "daily-turns", "race", "compare", "race-per-usd", "race-total-usd", "race-count", "race-agents", "budget-usd", "build-usd", "sync-max-age", "merge-method",
]);
export const OPERATE_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "json", "yes", "all", "local", "latest-watch", "dry-run", "file",
  "clear", "follow", "ready", "all-tasks", "inbound-only", "help", "undo", "anyone", "allow-dispatch", "allow-merge", "merge-delete-branch",
  "no-open",
]);

export function parseOperateArgs(argv: readonly string[]): Args | { error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const repoList: string[] = [];
  const wantsValue = OPERATE_VALUE_FLAGS;

  // Every boolean flag any verb reads. A --flag in neither set is a typo,
  // and a typo silently becoming `true` (with its intended value demoted to
  // a positional) surfaces later as a different, wronger error — refuse it
  // here by name instead (Codex round-4 findings 3/8).
  const booleans = OPERATE_BOOLEAN_FLAGS;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (!argument.startsWith("--")) {
      // `-h` is the one short flag people type from habit; only `--` forms
      // are flags here, so normalize it rather than scanning it as data.
      if (argument === "-h") {
        flags.set("help", true);
        continue;
      }
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (booleans.has(name)) {
      flags.set(name, true);
      continue;
    }
    if (!wantsValue.has(name)) {
      return { error: `unknown option --${name} — add --help to any queue command for the whole surface` };
    }
    const value = argv[++index];
    // A following --flag is not a value — consuming it would swallow a real
    // flag and leave this one holding a name-shaped lie.
    if (value === undefined || value.startsWith("--")) return { error: `--${name} needs a value` };
    flags.set(name, value);
    if (name === "repo") {
      for (const one of value.split(",").map(part => part.trim()).filter(part => part !== "")) repoList.push(one);
    }
  }

  return { positional, flags, repoList };
}

/** Route an `operate` command. Returns the process exit code. */
export async function runOperate(
  command: string,
  argv: readonly string[],
  write: Write,
  options: OperateOptions = {},
): Promise<number> {
  const parsed = parseOperateArgs(argv);
  // A parse error precedes the flags map, so JSON mode is read from the raw
  // argv — the envelope contract holds even for the earliest refusal.
  if ("error" in parsed) return fail(write, argv.includes("--json"), command, "usage", parsed.error, EXIT.usage);

  const { positional, flags } = parsed;
  const json = flags.has("json");

  // Help answers BEFORE the database opens: asking what the commands are
  // must not create ~/.config/standing-orders/orders.db as a side effect,
  // and `serve --help` must print help, never start a server (round-4
  // findings 2/7).
  if (flags.has("help")) {
    if (json) {
      write(envelopeJson({ ok: true, command: "help", help: OPERATE_HELP }));
    } else {
      write(OPERATE_HELP);
    }
    return EXIT.ok;
  }

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
      repoList: parsed.repoList,
      now,
      clock,
      // Evidence lives beside the database for the same reason the database
      // lives beside repos.json: somebody will want to back it up, sync it,
      // or delete it, and files hidden somewhere clever cannot be found when
      // it matters.
      evidenceRoot: join(dirname(file), "evidence"),
      databaseFile: file,
      // The bot token's file home. Never a column; see telegram.ts.
      telegramTokenFile: join(dirname(file), "telegram-token"),
      ...(options.agentRunner === undefined ? {} : { agentRunner: options.agentRunner }),
      ...(options.gitRunner === undefined ? {} : { gitRunner: options.gitRunner }),
      ...(options.telegramTransport === undefined ? {} : { telegramTransport: options.telegramTransport }),
      ...(options.publishExec === undefined ? {} : { publishExec: options.publishExec }),
      ...(options.dispatchAdapter === undefined ? {} : { dispatchAdapter: options.dispatchAdapter }),
      ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
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
  /** Every --repo occurrence in order (arc 2) — only `up` reads it. */
  repoList?: string[];
  now: Date;
  clock: () => Date;
  evidenceRoot: string;
  /** The directory holding the database — where credential files live. */
  databaseFile: string;
  telegramTokenFile: string;
  agentRunner?: CommandRunner;
  gitRunner?: CommandRunner;
  telegramTransport?: TelegramTransport;
  /** Injected by tests: what `publish` runs for git and gh. */
  publishExec?: PublishExec;
  /** Injected by tests: the external-dispatch gh surface. */
  dispatchAdapter?: DispatchAdapter;
  /**
   * The stop fence (Codex M5-M8 audit, IV-1): set by the watch when a
   * signal lands. A pass that sees true admits NOTHING more — no routine
   * fires, no claim, no run, no spawn. The in-flight build finishes under
   * its own bounds (or the grace kill); admission is what stops.
   */
  shouldStop?: () => boolean;
  /** The held-session coordinator (Phase 2, attended road) — co-located
   * `up` only; its absence means attended tasks stay attended-only skips. */
  heldCoordinator?: import("./held.js").HeldSessionCoordinator;
  /** This up process's incarnation, for held custody rows. */
  upIncarnation?: string;
  /** Short directory for held control sockets (sun_path bound). */
  heldSocketDir?: string;
  /** Test seams for the held transport. */
  heldStarter?: typeof import("./exec.js").startClaudeHeldSession;
  heldGraceMs?: number;
  /** v28: optional attended-session cap; absent = unbounded. */
  maxHeldSessions?: number;
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
    case "routine":
      return routineCommand(positional, flags, context);
    case "config":
      return configCommand(positional, flags, context);
    case "setup":
      return setupCommand(positional, flags, context);
    case "intake":
      return intakeCommand(positional, flags, context);
    case "providers":
      return providersCommand(flags, context);
    case "template":
      return templateCommand(positional, flags, context);
    case "contest":
      return contestCommand(positional, flags, context);
    case "webhook":
      return webhookCommand(positional, flags, context);
    case "sync":
      return syncCommand(flags, context);
    case "serve":
      return serveCommand(flags, context);
    case "watch":
      return watchCommand(flags, context);
    case "up":
      return upCommand(flags, context);
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
      write(envelopeJson({ ok: tasks.length > 0, command: "ready", ...(tasks.length > 0 ? {} : { reason: "empty", message: "nothing is ready to dispatch" }), backend: backendName, count: tasks.length, tasks }));
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
    write(envelopeJson({ ok: ready.length > 0, command: "ready", ...(ready.length > 0 ? {} : { reason: "empty", message: "nothing is ready to dispatch" }), count: ready.length, tasks: ready.map(ref => describeRef(store, ref, now)) }));
    return ready.length > 0 ? EXIT.ok : EXIT.refused;
  }

  if (ready.length === 0) {
    write("Nothing is ready to dispatch.");
    return EXIT.refused;
  }

  write(`${ready.length} ready (each worker takes its own reserved work first — this is the shared view):`);
  for (const ref of ready) {
    const task = store.getTask(ref.externalId);
    write(`  ${ref.externalId}  ${task === null ? "" : task.title}${ref.assignedRunner === null ? "" : `  (reserved for ${ref.assignedRunner})`}`);
  }
  return EXIT.ok;
}

function describeRef(store: Store, ref: { externalId: string; backend: string; id: number; assignedRunner?: string | null }, now: Date) {
  const task = store.getTask(ref.externalId);
  return {
    id: ref.externalId,
    ref: ref.id,
    backend: ref.backend,
    title: task?.title ?? null,
    state: task?.state ?? null,
    reservedFor: ref.assignedRunner ?? null,
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

  if (id === undefined) return fail(write, json, "claim", "usage", "which task? `standing-orders claim <id> --runner <name> --token <token>`", EXIT.usage);
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
    // Two distinct refusals: somebody HOLDS it right now, or it is
    // RESERVED for a specific worker whoever asks (queue columns, v19).
    if (result.reason === "reserved") {
      return fail(
        write,
        json,
        "claim",
        "reserved",
        `${id} is reserved for ${result.reservedFor} — only that worker takes it`,
        EXIT.refused,
        { reservedFor: result.reservedFor },
      );
    }
    if (result.reason === "external") {
      const said: Record<string, string> = {
        "stale-mirror": "this tracker item has not been seen recently — run `standing-orders sync` first",
        "external-closed": "the tracker closed this — reopen it first, or leave it be",
        "dispatch-revoked": "this tracker's building permission was revoked or narrowed",
        "plane-blocked": "this tracker's plane marker could not be verified — building is paused",
      };
      return fail(write, json, "claim", "external", said[result.detail] ?? "external work is not dispatchable right now", EXIT.refused, {
        detail: result.detail,
      });
    }
    if (result.reason === "attended-held") {
      return fail(write, json, "claim", "attended-held", `an attended session holds this task for ${result.runner}`, EXIT.refused, {
        runner: result.runner,
      });
    }
    if (result.reason === "attended-only") {
      return fail(
        write,
        json,
        "claim",
        "attended-only",
        "this task runs only while its operator watches — it needs a live attended authorization or a real approval",
        EXIT.refused,
      );
    }
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
  // On an idempotent REPLAY the transition runs only as the ONE narrow
  // repair (external dispatch, finding 36): the stored claim is still the
  // live lease and the task never left queued — anything else (cancelled,
  // done, reopened elsewhere) mutates nothing.
  if (result.replayed === true) {
    const task = store.getTask(id);
    const ref = store.lookupRef(id);
    const stillMine = ref !== null && store.currentLiveLease(ref.id, now) === result.claim.leaseId;
    if (task !== null && task.state === "queued" && stillMine) store.setTaskState(id, "running", now);
  } else {
    store.setTaskState(id, "running", now);
  }

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
  if (lease === undefined) return fail(write, json, command, "usage", `which lease? \`standing-orders ${command} <lease>\``, EXIT.usage);

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
    write(envelopeJson({ ok: true, command: "reap", count: reaped.length, released: reaped }));
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
      write(envelopeJson({ ok: true, command: "runner list", count: runners.length, runners }));
      return EXIT.ok;
    }
    if (runners.length === 0) {
      write("No runners registered.");
      write("  standing-orders runner register <name>");
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
      write(envelopeJson({ ok: true, command: "runner reap", recovered }));
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
  const demoFence = refuseDemo(context, "build");
  if (demoFence !== null) return demoFence;
  const id = positional[0];
  if (id !== undefined && store.mirrorByTask(id) !== null) {
    // D2 (external dispatch): the debug verb keeps zero mirror surface —
    // tick/watch is the product path, where the completion gate lives.
    return fail(write, json, "build", "external-task", "external work dispatches through tick/watch — the completion gate lives there", EXIT.refused);
  }
  const runner = text(flags, "runner");
  const token = text(flags, "token");
  const branch = text(flags, "branch");

  if (id === undefined || runner === undefined || token === undefined || branch === undefined) {
    return fail(write, json, "build", "usage", "`standing-orders build <id> --runner <name> --token <t> --branch <b> --repo <path>`", EXIT.usage);
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
    runnerToken: token,
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

  // Disposition through the shared service (Phase 2C), on the standalone
  // policy: run records only — no task completion, no strikes, no
  // publication — exactly this road's historical shape.
  const disposition = disposeBuildOutcome(
    {
      store,
      policy: "standalone",
      leaseId: held?.leaseId,
      runId,
      taskId: id,
      taskRef: ref.id,
      runner,
      repo,
      branch,
      origin: ref.origin,
      provider: "claude",
      model: text(flags, "model") ?? null,
      worktreePath: leased.worktree.path,
      clock: context.clock,
    },
    result,
  );

  if (result.ok && result.parked !== undefined) {
    if (disposition.kind !== "parked") {
      return fail(write, json, "build", "fenced", `${id} parked, but the lease was gone before the decision could be sealed`, EXIT.refused, {
        worktree: leased.worktree.path,
      });
    }
    return succeed(
      write,
      json,
      "build",
      { parked: true, decision: disposition.decisionId, worktree: leased.worktree.path },
      () => [
        `${id} parked a decision instead of guessing.`,
        `  decision  ${disposition.decisionId} — \`standing-orders decide ${disposition.decisionId}\``,
        `  worktree  ${leased.worktree.path} (work in progress preserved)`,
      ],
    );
  }

  if (!result.ok) {
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
  outcome: "built" | "planned" | "parked" | "skipped" | "failed" | "contest" | "held";
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
  const demoFence = refuseDemo(context, "tick");
  if (demoFence !== null) return demoFence;
  const runner = text(flags, "runner");
  const token = text(flags, "token");

  if (runner === undefined || token === undefined) {
    return fail(write, json, "tick", "usage", "`standing-orders tick --runner <name> --token <t> --repo <path> [--max <n>] [--base <ref>]`", EXIT.usage);
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
  const syncAgeGiven = text(flags, "sync-max-age");
  const syncMaxAgeMs = syncAgeGiven === undefined ? SYNC_MAX_AGE_MS : Number(syncAgeGiven) * 1000;
  if (!Number.isInteger(syncMaxAgeMs) || syncMaxAgeMs <= 0) {
    return fail(write, json, "tick", "usage", "--sync-max-age takes whole seconds", EXIT.usage);
  }

  const repo = repoFrom(flags);
  const pool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");
  const model = text(flags, "model");
  const repairModel = text(flags, "repair-model");
  const providerFlag = text(flags, "provider");
  const planModel = text(flags, "plan-model");
  const planProvider = text(flags, "plan-provider");
  const turns = text(flags, "turns");
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

  // Standing orders fire before the ready set is read, so a fresh instance
  // joins THIS pass. dueRoutines only nominates; every proof — approval
  // digest, pause, due, single-flight, budget — is re-made inside
  // fireRoutine's own transaction, and skipped slots ledger and page
  // themselves there. This loop just reports.
  const routines: { routine: string; outcome: string; taskId?: string; detail?: string }[] = [];
  for (const routine of store.dueRoutines(repo, clock())) {
    // The stop fence (audit IV-1): a signal that landed mid-pass stops
    // every further admission — a routine not yet fired stays unfired.
    if (context.shouldStop?.() === true) break;
    const outcome = fireRoutine(store, routine.id, clock());
    routines.push(
      outcome.ok
        ? { routine: routine.name, outcome: "fired", taskId: outcome.taskId }
        : {
            routine: routine.name,
            outcome: outcome.reason,
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          },
    );
  }

  // Tournament housekeeping before the ordinary pass (stage 4): interrupted
  // races recover by CAS, and an ANSWERED question re-admits its parked
  // agent — fresh claim, fresh slot, remaining budget only, the SAME
  // verified checkout on the SAME runner (finding 29's custody rule).
  recoverContests(store, clock());
  // Expired ceremony nonces are litter with a bound (round-3 finding 30):
  // the mint refuses past 50 open per approver, so the sweep keeps the
  // ceiling meaningful rather than letting dead rows consume it.
  store.sweepCeremonyNonces(clock());
  // Decided tournaments give their checkouts back (stage 6) — this runner's
  // custody only; a checkout that will not release cleanly is flagged and
  // paged, never force-cleaned. Undecided ones escalate once at 14 days.
  await sweepContestCleanup(store, path => worktrees.release(path, clock()), runner, clock());
  escalateOverdueContests(store, clock());
  const resumed: TickOutcome[] = [];
  for (const waiting of store.contestsInStates(["decision-wait"])) {
    // D1 belt-and-braces (external dispatch, finding 41): a mirror and a
    // contest should never coexist; if one ever does, its race resumes
    // NOTHING — no claim, no run, no worktree, no spend.
    const waitingTaskId = store.externalIdFor(waiting.taskRef);
    if (waitingTaskId !== null && store.mirrorByTask(waitingTaskId) !== null) {
      resumed.push({ id: waitingTaskId, outcome: "skipped", reason: "external-race" });
      continue;
    }
    // THE ANSWERED BATCH IS MARKED ACTIVE FIRST (Codex slice-B finding 2):
    // resuming lanes one at a time let the FIRST finisher aggregate the
    // contest while later answered lanes were still 'parked' — excluded
    // from active, their decisions no longer open — stranding them in a
    // contest that had already moved on. 'ready' counts as active, so
    // aggregation waits for the whole batch. Any lane that bails before
    // its build reverts to 'parked' so the next pass retries it.
    const batch: { racer: ReturnType<Store["contestants"]>[number] }[] = [];
    for (const racer of store.contestants(waiting.id).filter(one => one.state === "parked")) {
      if (store.answeredDecisionForContestant(racer.id) === null) continue;
      if (store.casContestantState(racer.id, ["parked"], "ready", racer.generation)) {
        batch.push({ racer });
      }
    }
    for (const { racer } of batch) {
      const backToParked = (): void => {
        const current = store.getContestant(racer.id);
        if (current !== null) store.casContestantState(racer.id, ["ready"], "parked", current.generation);
      };
      const custody = racer.custody === null ? null : (JSON.parse(racer.custody) as { branch: string; head: string | null; runner: string });
      const taskId = store.externalIdFor(waiting.taskRef);
      if (custody === null || custody.runner !== runner || taskId === null) {
        backToParked();
        continue;
      }
      // Comparison lanes carry NO dollar terms (Phase 3 slice B, E1): the
      // clock is the bound, and a budget-of-zero must never read as
      // exhausted. But the clock must be CUMULATIVE (Codex slice-B
      // finding 1): every resume re-arms the sealed per-attempt timeout,
      // so without a lane-total bound a park/answer loop could run
      // forever. Three sealed clocks bound the lane, stated in the
      // ceremony words.
      const remaining = waiting.kind === "comparison" ? null : racer.budgetMicrousd - racer.accountedMicrousd;
      if (remaining !== null && remaining <= 0) {
        const current = store.getContestant(racer.id);
        if (current !== null) store.casContestantState(racer.id, ["ready"], "stopped", current.generation);
        contestMaybeAggregate(store, waiting.id, clock());
        resumed.push({ id: taskId, outcome: "skipped", reason: "over-ceiling" });
        continue;
      }
      if (waiting.kind === "comparison") {
        const laneProfile = racer.profile ?? contestantProfileOf(racer.provider, racer.model, racer.repairModel);
        const clockCapMs = 3 * laneProfile.timeoutSeconds * 1000;
        if (store.contestantCumulativeMs(racer.id) >= clockCapMs) {
          const current = store.getContestant(racer.id);
          if (current !== null) store.casContestantState(racer.id, ["ready"], "stopped", current.generation);
          contestMaybeAggregate(store, waiting.id, clock());
          resumed.push({ id: taskId, outcome: "skipped", reason: "over-ceiling" });
          continue;
        }
      }
      const reclaimed = acquire(store, waiting.taskRef, runner, { now: clock(), ttlMs: leaseTtlMs });
      if (!reclaimed.ok) {
        backToParked();
        continue;
      }
      const freshContest = store.getContest(waiting.id);
      if (freshContest === null || !store.casContestState(waiting.id, ["decision-wait", "racing"], "racing", freshContest.generation)) {
        release(store, reclaimed.claim.leaseId, clock());
        backToParked();
        continue;
      }
      store.stampContestLease(waiting.id, reclaimed.claim.leaseId, runner, text(flags, "incarnation") ?? null);
      const leased = await worktrees.lease({ repo, branch: racer.branch, runner, taskRef: waiting.taskRef, now: clock() });
      const headCheck = leased.ok ? await git("git", ["rev-parse", "HEAD"], { cwd: leased.worktree.path }) : null;
      if (!leased.ok || (custody.head !== null && headCheck !== null && headCheck.stdout.trim() !== custody.head)) {
        // The tree cannot be proved to be the one the agent left — stop the
        // agent rather than cold-starting against a different history.
        if (leased.ok) await worktrees.release(leased.worktree.path, clock());
        const current = store.getContestant(racer.id);
        if (current !== null) store.casContestantState(racer.id, ["ready"], "stopped", current.generation);
        store.setContestantCleanup(racer.id, "attention");
        contestMaybeAggregate(store, waiting.id, clock());
        release(store, reclaimed.claim.leaseId, clock());
        resumed.push({ id: taskId, outcome: "failed", reason: "contest-custody" });
        continue;
      }
      const [resumeSlot] = store.reserveExecutionSlots(runner, 1, clock());
      const parkedRun = racer.activeRun;
      const resumeRun = store.startRun({
        taskRef: waiting.taskRef,
        leaseId: reclaimed.claim.leaseId,
        runner,
        branch: racer.branch,
        worktree: leased.worktree.path,
        provider: racer.provider,
        model: racer.model,
        contestant: racer.id,
        ...(parkedRun === null ? {} : { parentRun: parkedRun }),
        now: clock(),
      });
      if (parkedRun !== null) store.releaseContestantRun(racer.id, parkedRun);
      const beforeBuild = store.getContestant(racer.id);
      if (beforeBuild === null || !store.claimContestantRun(racer.id, resumeRun, beforeBuild.generation)) {
        await worktrees.release(leased.worktree.path, clock());
        release(store, reclaimed.claim.leaseId, clock());
        backToParked();
        continue;
      }
      const afterClaim = store.getContestant(racer.id);
      if (afterClaim !== null) store.casContestantState(racer.id, ["ready"], "building", afterClaim.generation);
      const resumeResult = await build(store, {
        taskId,
        taskRef: waiting.taskRef,
        runner,
        leaseId: reclaimed.claim.leaseId,
        runnerToken: token,
        runId: resumeRun,
        evidenceRoot: context.evidenceRoot,
        worktree: leased.worktree.path,
        branch: racer.branch,
        now: clock(),
        clock,
        provider: racer.provider as ProviderId,
        // v24: the contestant's OWN sealed profile is the authority — the
        // proof holds the lane to it (model, limits, permissions), so no
        // flag-shaped overrides ride along.
        contestProfile: racer.profile ?? contestantProfileOf(racer.provider, racer.model, racer.repairModel),
        ...(remaining === null ? {} : { maxBudgetUsd: remaining / 1_000_000 }),
        ...(resumeSlot === undefined
          ? {}
          : {
              onProviderSpawn: (pid: number) =>
                store.markSlotRunning(resumeSlot, { run: resumeRun, contestant: racer.id, incarnation: text(flags, "incarnation") ?? null, processGroup: pid }, clock()),
            }),
        ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
        ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
        ...(context.shouldStop === undefined ? {} : { shouldStop: context.shouldStop }),
      });
      const resumedRunRow = store.getRun(resumeRun);
      const resumeMeasured =
        resumedRunRow === null || resumedRunRow.providerStartedAt === null
          ? 0
          : resumedRunRow.costUsd !== null
            ? Math.round(resumedRunRow.costUsd * 1_000_000)
            : null;
      let resumedOutcome: "built" | "failed" | "parked" | "stopped" = "failed";
      let resumedCommitted = false;
      if (resumeResult.ok && resumeResult.parked !== undefined) {
        resumedOutcome = "parked";
        const asked = resumeResult.parked.decision;
        const racerDecision = store.saveDecision(
          {
            run: resumeRun,
            contestant: racer.id,
            urgency: asked.urgency,
            recap: asked.recap,
            question: asked.question,
            options: asked.options,
            recommendation: asked.recommendation,
            ...(asked.assignee === null ? {} : { assignee: asked.assignee }),
            ...(asked.deadline === null ? {} : { deadline: asked.deadline }),
          },
          clock(),
        );
        // A racing agent's question pages like any other (arc 3 finding 21):
        // aggregation stays quiet ASSUMING this row already spoke.
        store.enqueueNotification(
          {
            dedupeKey: `decision:${racerDecision}`,
            kind: "decision",
            subject: `${taskId} parked a decision (${contestNoun(waiting.kind)} agent)`,
            body: `\`standing-orders decide ${racerDecision}\``,
            pushClass: "decision",
            link: `/d/${racerDecision}`,
          },
          clock(),
        );
      } else if (resumeResult.ok) {
        resumedOutcome = "built";
        resumedCommitted = resumeResult.committed;
      } else if (resumeResult.reason === "stopped") {
        resumedOutcome = "stopped";
      }
      if (resumedRunRow !== null && resumedRunRow.outcome === null) {
        // The reason rides the resumed run too (Codex slice-B finding 7):
        // both settlement paths, one honesty.
        const resumeReason = !resumeResult.ok ? resumeResult.reason : undefined;
        store.finishRun(resumeRun, {
          outcome: resumedOutcome === "built" && !resumedCommitted ? "no-change" : resumedOutcome === "stopped" ? "failed" : resumedOutcome === "parked" ? "parked" : resumedOutcome,
          committed: resumedCommitted,
          ...(resumeReason === undefined ? {} : { reason: resumeReason }),
          now: clock(),
        });
      }
      if (resumedOutcome === "parked") {
        // Custody refreshes on EVERY park (Codex slice-B finding 9): a
        // re-parked lane whose custody still named the pre-resume head
        // would falsely stop as contest-custody on its next answer.
        const headNow = await git("git", ["rev-parse", "HEAD"], { cwd: leased.worktree.path });
        const dirtyNow = await git("git", ["status", "--porcelain"], { cwd: leased.worktree.path });
        store.setContestantCustody(
          racer.id,
          JSON.stringify({
            branch: racer.branch,
            head: headNow.code === 0 ? headNow.stdout.trim() : null,
            runner,
            dirty: dirtyNow.stdout.trim() !== "",
            at: clock().toISOString(),
          }),
        );
      }
      await worktrees.release(leased.worktree.path, clock());
      const resumedFinal = finalizeContestant(
        store,
        {
          contestId: waiting.id,
          contestantId: racer.id,
          runId: resumeRun,
          outcome: resumedOutcome,
          measuredMicrousd: resumeMeasured,
          slotId: resumeSlot ?? null,
        },
        clock(),
      );
      resumed.push({ id: taskId, outcome: "contest", reason: resumedFinal.aggregated ?? "racing" });
    }
  }

  // The DISPATCH view of the queue (queue columns, v19): this runner's own
  // reserved work first, then the shared queue; work reserved for other
  // workers is absent. The claim primitive re-proves the reservation.
  const ready = store.listReady(clock(), runner);
  const considered = ready.length;
  const dispatched: TickOutcome[] = [...resumed];
  // Expired attended authorizations close durably each pass (round-6
  // finding 8): the partial unique frees, and the claim gates stop
  // honoring corpses.
  store.sweepExpiredAuthorizations(clock());
  // The stale-scan (dispatch v3, finding 20): mirrors the courtesy filter
  // kept out of ready are REPORTED here, typed, with a paged episode —
  // an undispatakable tracker item is a 9am fact, not a silent absence.
  const MIRROR_WORDS: Record<string, string> = {
    "stale-mirror": "its tracker has not been synced recently — `standing-orders sync` restores freshness",
    "external-closed": "the tracker closed it — reopen it there, then `standing-orders task reopen`",
    "dispatch-revoked": "the tracker's building permission was revoked or narrowed",
    "plane-blocked": "the tracker's plane marker could not be verified — building is paused",
  };
  for (const skippedMirror of store.ineligibleMirrors(repo, clock(), syncMaxAgeMs)) {
    dispatched.push({ id: skippedMirror.taskId, outcome: "skipped", reason: skippedMirror.why });
    store.enqueueNotification(
      {
        dedupeKey: `mirror:${skippedMirror.taskId}:${skippedMirror.why}`,
        kind: "external-skipped",
        subject: `${skippedMirror.taskId} cannot dispatch`,
        body: MIRROR_WORDS[skippedMirror.why] ?? "the tracker item is not dispatchable right now",
      },
      clock(),
    );
  }

  let built = 0;
  let parked = 0;
  let broke = 0;

  // One attestation verdict per provider per pass (Phase 3 A3): the
  // gateway re-checks freshly at spawn; this cache only keeps a skipped
  // queue from probing once per task.
  const attestedThisPass = new Map<ProviderId, AttestOutcome | null>();

  for (const ref of ready) {
    // The build budget governs UNATTENDED admissions (round-1 finding 4):
    // once it is spent, the pass keeps SCANNING for attended
    // authorizations — operator-invoked sessions launch regardless —
    // while declining every further ordinary admission.
    if (built >= max) {
      const openAuth = store.openAuthorizationFor(ref.id);
      if (openAuth === null || openAuth.runner !== runner || openAuth.attemptRun !== null) continue;
    }
    // The stop fence (audit IV-1): checked before every claim. The build
    // already in flight finishes under its own bounds; nothing NEW is
    // admitted once the operator has said stop.
    if (context.shouldStop?.() === true) break;
    const id = ref.externalId;

    // A task placed in another repository is not this pass's to build.
    if (ref.repo !== null && ref.repo !== repo) {
      dispatched.push({ id, outcome: "skipped", reason: "other-repo" });
      continue;
    }

    // A plan the operator asked for dispatches a PLANNER — the one
    // legitimate spend on a task with no approved scope. Everything else
    // unapproved is a person's pending decision: skip, not refuse — EXCEPT
    // the attended road (Phase 2, v6 W1): a live attended authorization
    // naming THIS runner is authority for one watched attempt, and the
    // skip for everything short of that is its own typed word, never the
    // generic `unapproved` the round-5 review caught masking it.
    const scopeApproved = approvalOf(store.getScope(id)).approved;
    const wantsPlan = ref.plan === "requested" && !scopeApproved;
    let attendedDispatch: import("./store.js").AttendedAuthorization | null = null;
    if (!wantsPlan && !scopeApproved) {
      const open = store.openAuthorizationFor(ref.id);
      const watching =
        open === null
          ? null
          : attendedLivenessState(
              open.lastBeatAt === null ? null : Date.parse(open.lastBeatAt),
              clock().getTime(),
              Date.parse(open.absoluteExpiry),
            );
      if (
        open !== null &&
        open.runner === runner &&
        (watching === "live" || watching === "grace") &&
        open.attemptRun === null &&
        context.heldCoordinator !== undefined
      ) {
        // v28: sessions are unbounded by default; an operator-set cap
        // skips FURTHER launches in words. The gauge is durable custody
        // rows, never the in-process map — a restarted up with orphans
        // pending must count them.
        if (context.maxHeldSessions !== undefined && store.openHeldSessionCount(runner) >= context.maxHeldSessions) {
          dispatched.push({
            id,
            outcome: "skipped",
            reason: "session-cap",
            detail: `this machine holds ${store.openHeldSessionCount(runner)} of ${context.maxHeldSessions} attended sessions — end one, or raise --max-held-sessions`,
          });
          continue;
        }
        attendedDispatch = open;
      } else if (open !== null) {
        dispatched.push({ id, outcome: "skipped", reason: "attended-only" });
        continue;
      } else {
        dispatched.push({ id, outcome: "skipped", reason: "unapproved" });
        continue;
      }
    }

    // TOURNAMENT TERMS FIRST (foundations finding 8's reorder): an approved
    // race's admission is governed by its own fingerprinted terms, and pass
    // flags must not be able to shape it — so the terms are discovered
    // before any flag-shaped resolution runs, and a raced task's build
    // resolution ignores the flags outright.
    const racedAhead = wantsPlan || attendedDispatch !== null ? null : store.activeTournamentTerms(ref.id);
    // The attended spec comes from the authorization's PINNED terms — the
    // courtesy half of the proof; the coordinator's transaction re-proves
    // byte-for-byte at the actual HEAD (v6 W1).
    let attendedSpec: { provider: ProviderId; model: string | null } | null = null;
    if (attendedDispatch !== null) {
      try {
        const terms = JSON.parse(attendedDispatch.termsJson) as { profileJson?: unknown };
        const pinned = profileFromJson(typeof terms.profileJson === "string" ? terms.profileJson : null);
        if (pinned !== null) attendedSpec = { provider: pinned.provider, model: pinned.model };
      } catch {
        attendedSpec = null;
      }
      if (attendedSpec === null) {
        dispatched.push({ id, outcome: "skipped", reason: "attended-only", detail: "the authorization's pinned profile cannot be read" });
        continue;
      }
    }
    // The phase agent, resolved BEFORE anything is claimed and snapshotted
    // into the run: pin > flags > project > installation > default. Planner
    // flags fall back to the pass flags, which is exactly today's behavior
    // when no plan-specific flag is given.
    const resolution = attendedSpec !== null
      ? null
      : wantsPlan
        ? resolvePhaseAgent(store, "plan", repo, {
            provider: planProvider ?? providerFlag,
            model: planModel ?? model,
          })
        : racedAhead !== null
          ? resolvePhaseAgent(store, "build", repo, {}, ref)
          : resolvePhaseAgent(store, "build", repo, { provider: providerFlag, model }, ref);
    if (resolution !== null && !resolution.ok) {
      dispatched.push({ id, outcome: "skipped", reason: "agent-config", detail: resolution.problem });
      continue;
    }
    const spec = resolution === null ? (attendedSpec as { provider: ProviderId; model: string | null }) : resolution.spec;

    // THE PRE-CLAIM ATTESTATION SKIP (Phase 3 A3/B4/C2): an attested
    // provider outside its range never claims — no lease, no run row, no
    // worktree, no wake churn. The provider source is the AUTHORITATIVE
    // one per road: the sealed approval snapshot for ordinary builds (the
    // same snapshot the dispatch proof enforces), the plan resolver for
    // planner runs. Attended work is claude-only and excluded; tournament
    // contestants cannot be tier-2 today (the money gate refuses them at
    // filing). A missing or malformed snapshot is NOT skipped here — the
    // existing approval refusals own that road, and attestation must
    // never mask them. The gateway re-checks before spawn; this skip only
    // keeps the normal road cheap.
    const skipProviders: ProviderId[] =
      attendedSpec !== null
        ? []
        : racedAhead !== null
          ? // The contest road (slice B): every lane's provider, so an
            // out-of-range attested lane skips the WHOLE contest before
            // any claim — running a subset is a different contest than
            // the one the operator signed.
            racedAhead.agents.filter(agent => isProviderId(agent.provider)).map(agent => agent.provider as ProviderId)
          : wantsPlan
            ? [spec.provider]
            : ([store.getScope(id)?.approvedProfile?.provider].filter((one): one is ProviderId => one !== null && one !== undefined) as ProviderId[]);
    let unattestedLane: string | null = null;
    for (const candidate of new Set(skipProviders)) {
      if (attestationOf(candidate) === null) continue;
      let verdict = attestedThisPass.get(candidate);
      if (verdict === undefined) {
        verdict = await attestProvider(candidate, inspectionOf(candidate).binary);
        attestedThisPass.set(candidate, verdict);
      }
      if (verdict !== null && !verdict.ok) {
        unattestedLane = verdict.problem;
        break;
      }
    }
    if (unattestedLane !== null) {
      dispatched.push({ id, outcome: "skipped", reason: "provider-unattested", detail: unattestedLane });
      continue;
    }

    const claimed = acquireIfReady(store, ref.id, runner, {
      ...(wantsPlan ? { dispatchRole: "planner" as const } : {}),
      now: clock(),
      ttlMs: leaseTtlMs,
      syncMaxAgeMs,
      repo,
      provider: spec.provider,
      ...(spec.model === null ? {} : { model: spec.model }),
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
              body: `${id} (and possibly others) cannot dispatch: ${claimed.message}. \`standing-orders gaps --repo ${home}\``,
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

    // A tournament rides this claim (stage 3b): approved race terms send N
    // agents instead of one builder. Everything after admission either
    // reaches the ready barrier for ALL agents or interrupts the whole
    // tournament — a partial race is never dispatched (finding 19).
    const raceTerms = racedAhead;
    if (raceTerms !== null && raceTerms.approvedDigest === raceTerms.raceDigest) {
      const admittedKind = raceTerms.kind;
      const scopeRow = store.getScope(id);
      const admitted = admitContest(
        store,
        {
          taskId: id,
          taskRef: ref.id,
          runner,
          leaseId: lease,
          incarnation: text(flags, "incarnation") ?? null,
          scopeDigest: scopeRow?.digest ?? "",
          scopeApproved: scopeRow !== null && approvalOf(scopeRow).approved,
          // 'tasks' capacity mode keeps the claim-counted contract; the
          // slot ledger records regardless (finding 26).
          capacity: null,
          quotaBlocked: (provider, model) => store.quotaState(runner, provider, model, clock())?.state ?? null,
        },
        clock(),
      );
      if (!admitted.ok) {
        release(store, lease, clock());
        dispatched.push({ id, outcome: "skipped", reason: admitted.reason });
        continue;
      }
      const interrupt = async (why: string, leasedPaths: string[]): Promise<void> => {
        const fresh = store.getContest(admitted.contestId);
        if (fresh !== null) store.casContestState(admitted.contestId, ["dispatching", "racing"], "interrupted", fresh.generation);
        store.releaseSlotsForContest(admitted.contestId, clock());
        for (const path of leasedPaths) await worktrees.release(path, clock());
        release(store, lease, clock());
        dispatched.push({ id, outcome: "failed", reason: why });
        broke++;
      };
      const baseRead = await git("git", ["rev-parse", "HEAD"], { cwd: repo });
      if (baseRead.code !== 0) {
        await interrupt("contest-base", []);
        continue;
      }
      const baseSha = baseRead.stdout.trim();
      store.stampContestDispatch(admitted.contestId, baseSha, store.liveWorktreeSetup(repo)?.digest ?? null);
      const agents = store.contestants(admitted.contestId);
      const prepared: { contestantId: number; slotId: number; runId: number; worktree: string; branch: string }[] = [];
      let prepFailed = false;
      for (const [index, agent] of agents.entries()) {
        const leased = await worktrees.lease({ repo, branch: agent.branch, runner, taskRef: ref.id, now: clock(), base: baseSha });
        if (!leased.ok) {
          prepFailed = true;
          break;
        }
        store.setContestantWorktree(agent.id, leased.worktree.path);
        const contestantRun = store.startRun({
          taskRef: ref.id,
          leaseId: lease,
          runner,
          branch: agent.branch,
          worktree: leased.worktree.path,
          provider: agent.provider,
          model: agent.model,
          contestant: agent.id,
          now: clock(),
        });
        const freshAgent = store.getContestant(agent.id);
        if (freshAgent === null || !store.claimContestantRun(agent.id, contestantRun, freshAgent.generation)) {
          prepFailed = true;
          break;
        }
        prepared.push({
          contestantId: agent.id,
          slotId: admitted.slotIds[index] ?? -1,
          runId: contestantRun,
          worktree: leased.worktree.path,
          branch: agent.branch,
        });
      }
      const freshContest = store.getContest(admitted.contestId);
      if (prepFailed || freshContest === null || !crossReadyBarrier(store, freshContest, admitted.contestantIds)) {
        await interrupt("contest-admission", prepared.map(one => one.worktree));
        continue;
      }
      // Every agent is READY and nothing has spawned: cross into racing and
      // spend. The builds run concurrently; the stop fence stops them all.
      const settled = await Promise.allSettled(
        prepared.map(async entry => {
          const agent = store.getContestant(entry.contestantId);
          if (agent === null) throw new Error("contestant vanished");
          store.casContestantState(entry.contestantId, ["ready"], "building", agent.generation);
          return build(store, {
            taskId: id,
            taskRef: ref.id,
            runner,
            leaseId: lease,
            runId: entry.runId,
            evidenceRoot: context.evidenceRoot,
            worktree: entry.worktree,
            branch: entry.branch,
            now: clock(),
            clock,
            provider: agent.provider as ProviderId,
            contestProfile: contestantProfileOf(agent.provider, agent.model, agent.repairModel),
            // A comparison lane has no dollar cap — the sealed clock is the
            // bound; only race lanes carry the harness stop (E1).
            ...(agent.budgetMicrousd > 0 ? { maxBudgetUsd: agent.budgetMicrousd / 1_000_000 } : {}),
            onProviderSpawn: pid =>
              store.markSlotRunning(entry.slotId, { run: entry.runId, contestant: entry.contestantId, incarnation: text(flags, "incarnation") ?? null, processGroup: pid }, clock()),
            ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
            ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
            ...(context.shouldStop === undefined ? {} : { shouldStop: context.shouldStop }),
          });
        }),
      );
      let lastAggregate: string | null = null;
      for (const [index, entry] of prepared.entries()) {
        const outcome = settled[index];
        const run = store.getRun(entry.runId);
        const measured =
          run === null || run.providerStartedAt === null
            ? 0
            : run.costUsd !== null
              ? Math.round(run.costUsd * 1_000_000)
              : null;
        let contestantOutcome: "built" | "failed" | "parked" | "stopped" = "failed";
        let committed = false;
        if (outcome !== undefined && outcome.status === "fulfilled") {
          const result = outcome.value;
          if (result.ok && result.parked !== undefined) {
            contestantOutcome = "parked";
            // The question still reaches the operator, tagged with its agent;
            // decision-wait mechanics land in stage 4 — the card works today.
            const asked = result.parked.decision;
            const contestantDecision = store.saveDecision(
              {
                run: entry.runId,
                contestant: entry.contestantId,
                urgency: asked.urgency,
                recap: asked.recap,
                question: asked.question,
                options: asked.options,
                recommendation: asked.recommendation,
                ...(asked.assignee === null ? {} : { assignee: asked.assignee }),
                ...(asked.deadline === null ? {} : { deadline: asked.deadline }),
              },
              clock(),
            );
            store.enqueueNotification(
              {
                dedupeKey: `decision:${contestantDecision}`,
                kind: "decision",
                subject: `${id} parked a decision (${contestNoun(admittedKind)} agent)`,
                body: `\`standing-orders decide ${contestantDecision}\``,
                pushClass: "decision",
                link: `/d/${contestantDecision}`,
              },
              clock(),
            );
          } else if (result.ok) {
            contestantOutcome = "built";
            committed = result.committed;
          } else if (result.reason === "stopped") {
            contestantOutcome = "stopped";
          }
        }
        if (run !== null && run.outcome === null) {
          // The reason rides the run (slice B, E2 — kind-agnostic): "lane 3
          // failed" with no words when a binary drifted out of its attested
          // range is exactly the silence the attested runtime rules out.
          const laneReason =
            outcome !== undefined && outcome.status === "fulfilled" && !outcome.value.ok
              ? outcome.value.reason
              : undefined;
          store.finishRun(entry.runId, {
            outcome: contestantOutcome === "built" && !committed ? "no-change" : contestantOutcome === "stopped" ? "failed" : contestantOutcome === "parked" ? "parked" : contestantOutcome,
            committed,
            ...(laneReason === undefined ? {} : { reason: laneReason }),
            now: clock(),
          });
        }
        if (contestantOutcome === "parked") {
          // Custody (round-3 finding 29): who owns this checkout while the
          // question waits, and what exact state it was left in — the
          // resume verifies all of it before trusting the tree again.
          const headNow = await git("git", ["rev-parse", "HEAD"], { cwd: entry.worktree });
          const dirtyNow = await git("git", ["status", "--porcelain"], { cwd: entry.worktree });
          store.setContestantCustody(
            entry.contestantId,
            JSON.stringify({
              branch: entry.branch,
              head: headNow.code === 0 ? headNow.stdout.trim() : null,
              runner,
              dirty: dirtyNow.stdout.trim() !== "",
              at: clock().toISOString(),
            }),
          );
        }
        await worktrees.release(entry.worktree, clock());
        const final = finalizeContestant(
          store,
          {
            contestId: admitted.contestId,
            contestantId: entry.contestantId,
            runId: entry.runId,
            outcome: contestantOutcome,
            measuredMicrousd: measured,
            slotId: entry.slotId >= 0 ? entry.slotId : null,
          },
          clock(),
        );
        if (final.aggregated !== null) lastAggregate = final.aggregated;
      }
      dispatched.push({ id, outcome: "contest", reason: lastAggregate ?? "racing" });
      continue;
    }

    if (wantsPlan) {
      // The planner's workspace is disposable and its branch namespace is
      // its own — never the builder's, so a later build starts from base
      // with nothing a planning session could have left as an ancestor
      // (Codex planning review, finding 1).
      const planBranch = `standing-orders-plan/${id}`;
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
        provider: spec.provider,
        branch: planBranch,
        worktree: planLeased.worktree.path,
        ...(spec.model === null ? {} : { model: spec.model }),
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
        runnerToken: token,
        runId: planRunId,
        worktree: planLeased.worktree.path,
        branch: planBranch,
        now: clock(),
        clock,
        evidenceRoot: context.evidenceRoot,
        answers,
        provider: spec.provider,
        ...(spec.model === null ? {} : { model: spec.model }),
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
          store.clearQuota(runner, spec.provider, spec.model ?? "");
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

    const branch = `standing-orders/${id}`;

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
      provider: spec.provider,
      ...(spec.model === null ? {} : { model: spec.model }),
      now: clock(),
    });

    // The per-attempt dollar cap (v15): the scope's approved term and the
    // installation backstop, the smaller of the two. A provider that
    // cannot hold a cap does not run capped work (ruling 3: enforce only
    // explicit budgets; never pretend).
    const scopeBudget = store.getScope(id)?.budgetMicrousd ?? null;
    const backstop = store.getSpendDefaults()?.buildPerRunMicrousd ?? null;
    const capMicrousd =
      scopeBudget === null ? backstop : backstop === null ? scopeBudget : Math.min(scopeBudget, backstop);
    if (capMicrousd !== null && MONEY_CAPABILITIES[spec.provider].nativeDollarCapFlag === null) {
      release(store, lease, clock());
      await worktrees.release(leased.worktree.path, clock());
      dispatched.push({ id, outcome: "skipped", reason: "budget-unenforceable" });
      continue;
    }
    const result = await build(store, {
      taskId: id,
      taskRef: ref.id,
      runner,
      leaseId: lease,
      runnerToken: token,
      runId,
      evidenceRoot: context.evidenceRoot,
      worktree: leased.worktree.path,
      branch,
      now: clock(),
      clock,
      // No timeoutMs here, deliberately (Phase 3): the tick asks for
      // nothing, so the SEALED profile's clock governs. Passing the old
      // 30-minute constant read as an operator's ask and stale-approved
      // every profile whose honest clock is shorter (codex-shaped, gemini).
      ...(capMicrousd === null ? {} : { maxBudgetUsd: capMicrousd / 1_000_000 }),
      provider: spec.provider,
      ...(spec.model === null ? {} : { model: spec.model }),
      ...(repairModel === undefined ? {} : { repairModel }),
      ...(turns === undefined ? {} : { maxTurns: Number(turns) }),
      ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
      ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
      // The stop fence rides into the builder (audit IV-1): re-proved at
      // the last gate before the commit, so an operator's stop beats an
      // agent's finish even mid-build.
      ...(context.shouldStop === undefined ? {} : { shouldStop: context.shouldStop }),
      ...(attendedDispatch === null || context.heldCoordinator === undefined
        ? {}
        : {
            attended: {
              authorization: attendedDispatch,
              coordinator: context.heldCoordinator,
              upIncarnation: context.upIncarnation ?? "unknown",
              socketDir: context.heldSocketDir ?? tmpdir(),
              releaseWorktree: async (path: string) => worktrees.release(path, clock()),
              dispose: { repo, origin: ref.origin, provider: spec.provider, model: spec.model },
              ...(context.heldStarter === undefined ? {} : { starter: context.heldStarter }),
              ...(context.heldGraceMs === undefined ? {} : { graceMs: context.heldGraceMs }),
              ...(context.maxHeldSessions === undefined ? {} : { maxHeldSessions: context.maxHeldSessions }),
            },
          }),
    });

    // THE HELD HANDOFF (Phase 2, v2 S0d): ownership transferred — the
    // coordinator owns run, lease, and worktree; this pass releases and
    // settles NOTHING and moves on. Nonblocking is the whole point.
    if (result.ok && result.parked === undefined && result.held === true) {
      dispatched.push({ id, outcome: "held", branch, worktree: leased.worktree.path });
      continue;
    }

    // Handed back either way; a tree with somebody's work in it comes back
    // unverified rather than cleaned, same as `build`.
    await worktrees.release(leased.worktree.path, clock());

    // Disposition through the ONE shared service (Phase 2C): sealing,
    // completion fences, publication intents, strikes, and failure classes
    // all live in disposeBuildOutcome now; this loop only reports.
    const disposition = disposeBuildOutcome(
      {
        store,
        policy: "tick",
        leaseId: lease,
        runId,
        taskId: id,
        taskRef: ref.id,
        runner,
        repo,
        branch,
        origin: ref.origin,
        provider: spec.provider,
        model: spec.model,
        worktreePath: leased.worktree.path,
        clock,
      },
      result,
    );
    switch (disposition.kind) {
      case "parked":
        dispatched.push({ id, outcome: "parked", reason: `decision:${disposition.decisionId}`, worktree: leased.worktree.path });
        parked++;
        break;
      case "park-fenced":
        dispatched.push({ id, outcome: "failed", reason: "fenced", worktree: leased.worktree.path });
        broke++;
        break;
      case "disowned":
        dispatched.push({ id, outcome: "failed", reason: "external-closed", branch, worktree: leased.worktree.path });
        broke++;
        break;
      case "built":
        dispatched.push({ id, outcome: "built", committed: disposition.committed, branch, worktree: leased.worktree.path });
        built++;
        break;
      case "built-fenced":
        dispatched.push({ id, outcome: "failed", reason: "fenced", branch, worktree: leased.worktree.path });
        broke++;
        break;
      case "skipped":
        dispatched.push({ id, outcome: "skipped", reason: disposition.reason });
        break;
      case "fenced":
        dispatched.push({ id, outcome: "failed", reason: "fenced", worktree: leased.worktree.path });
        broke++;
        break;
      case "malformed":
        dispatched.push({ id, outcome: "failed", reason: disposition.sealed ? "malformed-decision" : "fenced", worktree: leased.worktree.path });
        broke++;
        break;
      case "failed":
        dispatched.push({
          id,
          outcome: "failed",
          reason: disposition.sealed
            ? `${disposition.failureClass}${disposition.disposition === "backoff" ? ` — retry ${disposition.strikes}/3` : disposition.disposition === "stalled" ? " — stalled" : ""}`
            : "fenced",
          worktree: leased.worktree.path,
        });
        broke++;
        break;
      case "recorded":
        // The standalone-only arm; unreachable under the tick policy.
        break;
      case "invariant":
        dispatched.push({ id, outcome: "failed", reason: disposition.reason });
        broke++;
        break;
    }
  }

  // THE CONTINUATION PASS (Phase 2E, A4): open continuation authorizations
  // named to this runner dispatch here — the finished parent task never
  // re-enters the queue; the authorization is the claimable unit (v3 R7).
  // Only a co-located coordinator can hold the session, and everything
  // else (liveness, one attempt, the final proof at the parent's exact
  // head) is re-proved on the way in.
  if (context.heldCoordinator !== undefined) {
    for (const continuation of store.openContinuationAuthorizations(runner)) {
      if (context.shouldStop?.() === true) break;
      const watching = attendedLivenessState(
        continuation.lastBeatAt === null ? null : Date.parse(continuation.lastBeatAt),
        clock().getTime(),
        Date.parse(continuation.absoluteExpiry),
      );
      if (watching !== "live" && watching !== "grace") continue;
      const parent = continuation.parentRun === null ? null : store.getRun(continuation.parentRun);
      const parentRef = parent === null ? null : store.refForId(parent.taskRef);
      if (parent === null || parentRef === null) continue;
      if (parentRef.repo !== null && parentRef.repo !== repo) continue;
      const taskId = parentRef.externalId;

      let pinned: { provider: ProviderId; model: string | null } | null = null;
      try {
        const terms = JSON.parse(continuation.termsJson) as { profileJson?: unknown };
        const profile = profileFromJson(typeof terms.profileJson === "string" ? terms.profileJson : null);
        if (profile !== null) pinned = { provider: profile.provider, model: profile.model };
      } catch {
        pinned = null;
      }
      if (pinned === null) {
        dispatched.push({ id: taskId, outcome: "skipped", reason: "attended-only", detail: "the continuation's pinned profile cannot be read" });
        continue;
      }

      const claimed = acquireContinuation(store, continuation, runner, { now: clock(), ttlMs: leaseTtlMs });
      if (!claimed.ok) {
        dispatched.push({ id: taskId, outcome: "skipped", reason: claimed.reason, ...("message" in claimed ? { detail: claimed.message } : {}) });
        continue;
      }
      const lease = claimed.claim.leaseId;
      // The parent's branch, at the head the terms signed — a moved branch
      // fails the final proof with words naming the head.
      const leased = await worktrees.lease({ repo, branch: parent.branch, runner, taskRef: parent.taskRef, now: clock() });
      if (!leased.ok) {
        release(store, lease, clock());
        dispatched.push({ id: taskId, outcome: "failed", reason: leased.reason });
        broke++;
        continue;
      }
      const runId = store.startRun({
        taskRef: parent.taskRef,
        leaseId: lease,
        runner,
        branch: parent.branch,
        worktree: leased.worktree.path,
        parentRun: parent.id,
        ...(pinned.model === null ? {} : { model: pinned.model }),
        now: clock(),
      });
      const result = await build(store, {
        taskId,
        taskRef: parent.taskRef,
        runner,
        leaseId: lease,
        runnerToken: token,
        runId,
        evidenceRoot: context.evidenceRoot,
        worktree: leased.worktree.path,
        branch: parent.branch,
        now: clock(),
        clock,
        provider: pinned.provider,
        ...(pinned.model === null ? {} : { model: pinned.model }),
        ...(context.agentRunner === undefined ? {} : { agent: context.agentRunner }),
        ...(context.gitRunner === undefined ? {} : { git: context.gitRunner }),
        ...(context.shouldStop === undefined ? {} : { shouldStop: context.shouldStop }),
        attended: {
          authorization: continuation,
          coordinator: context.heldCoordinator,
          upIncarnation: context.upIncarnation ?? "unknown",
          socketDir: context.heldSocketDir ?? tmpdir(),
          releaseWorktree: async (path: string) => worktrees.release(path, clock()),
          dispose: { repo, origin: parentRef.origin, provider: pinned.provider, model: pinned.model, policy: "continuation" },
          ...(context.heldStarter === undefined ? {} : { starter: context.heldStarter }),
          ...(context.heldGraceMs === undefined ? {} : { graceMs: context.heldGraceMs }),
              ...(context.maxHeldSessions === undefined ? {} : { maxHeldSessions: context.maxHeldSessions }),
        },
      });
      if (result.ok && result.parked === undefined && result.held === true) {
        dispatched.push({ id: taskId, outcome: "held", branch: parent.branch, worktree: leased.worktree.path });
        continue;
      }
      // A refusal before the hold (stale proof, spawn failure): record it
      // through the continuation policy — taskless, always — and release.
      await worktrees.release(leased.worktree.path, clock());
      const disposition = disposeBuildOutcome(
        {
          store,
          policy: "continuation",
          leaseId: lease,
          runId,
          taskId,
          taskRef: parent.taskRef,
          runner,
          repo,
          branch: parent.branch,
          origin: parentRef.origin,
          provider: pinned.provider,
          model: pinned.model,
          worktreePath: leased.worktree.path,
          clock,
        },
        result,
      );
      dispatched.push({
        id: taskId,
        outcome: disposition.kind === "built" ? "built" : "failed",
        ...(result.ok ? {} : { reason: result.reason }),
        worktree: leased.worktree.path,
      });
      if (disposition.kind !== "built") broke++;
    }
  }

  const summary = () => {
    const lines = [`Considered ${considered}, built ${built}, parked ${parked}, broke ${broke}.`];
    for (const entry of routines) {
      lines.push(
        entry.outcome === "fired"
          ? `  routine ${entry.routine.padEnd(16)} fired  ${entry.taskId ?? ""}`.trimEnd()
          : `  routine ${entry.routine.padEnd(16)} skipped  ${entry.detail ?? entry.outcome}`,
      );
    }
    for (const entry of dispatched) {
      const detail =
        entry.outcome === "built"
          ? entry.committed === true
            ? `committed to ${entry.branch}`
            : "no-change, stated and verified"
          : entry.outcome === "parked"
            ? `${entry.reason} — \`standing-orders decide\``
            : entry.reason ?? "";
      lines.push(`  ${entry.id.padEnd(24)} ${entry.outcome}  ${detail}`.trimEnd());
    }
    if (built > 0) {
      lines.push("", "Nothing has been pushed. Look at the branches before they go anywhere.");
    }
    if (parked > 0) {
      lines.push("", `${parked} decision${parked === 1 ? "" : "s"} waiting — \`standing-orders decide\`, or \`standing-orders brief\`.`);
    }
    return lines;
  };

  // One broken build fails the pass even if others succeeded: exit 0 must
  // mean "nothing needs you", and a half-broken pass does not qualify.
  if (broke > 0) {
    return fail(write, json, "tick", "build-failed", `${broke} of ${dispatched.length} dispatched tasks broke`, EXIT.failed, {
      considered,
      dispatched,
      routines,
    });
  }
  // A pass whose only events were parks or drafted plans exits 0: nothing
  // broke, nothing needs code — the questions and the plan are in the
  // attention surface where they belong, which is the system working.
  if (built > 0 || parked > 0 || dispatched.some(one => one.outcome === "planned" || one.outcome === "held")) {
    return succeed(write, json, "tick", { considered, dispatched, routines }, summary);
  }
  if (considered === 0) {
    return fail(write, json, "tick", "empty", "nothing is ready", EXIT.refused, {
      considered,
      dispatched,
      routines,
    });
  }
  return fail(
    write,
    json,
    "tick",
    "nothing-dispatched",
    "everything ready is waiting on a person or held by somebody else",
    EXIT.refused,
    { considered, dispatched, routines },
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
  const demoFence = refuseDemo(context, "reconcile");
  if (demoFence !== null) return demoFence;
  const repo = repoFrom(flags);
  const pool = text(flags, "pool") ?? join(dirname(databasePath(process.env, homedir())), "worktrees");

  // External trackers sync at reconcile cadence — the daemon inherits it
  // (watch runs reconcile periodically), and a FAILED pass is reported,
  // never swallowed: stale mirrors refuse dispatch on their own clock.
  const syncReports = [];
  for (const dispatchGrant of store.listGrants().filter(one => one.dispatch === true && one.remoteRepo != null && one.repo === repo)) {
    syncReports.push(await syncPass(store, dispatchGrant, context.dispatchAdapter ?? ghDispatchAdapter(), clock));
  }
  for (const report of syncReports) {
    if (report.outcome === "failed" || report.outcome === "blocked") {
      // Episodic and stamped (arc 3 findings 14/23): one open episode per
      // remote nags, a clean pass closes it, a recurrence pages again.
      store.enqueueEpisode(
        `sync:${report.remoteRepo}`,
        {
          kind: "sync-failed",
          pushClass: "attention",
          link: "/system",
          subject: `syncing ${report.remoteRepo} ${report.outcome === "blocked" ? "is blocked" : "failed"}`,
          body: `${report.detail ?? "the pass did not finish"} — external work keeps its last verified state and stops dispatching past its freshness window.`,
        },
        clock().toISOString(),
        clock(),
      );
    } else {
      store.resolveEpisodes(`sync:${report.remoteRepo}`, clock());
    }
  }

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

  // Live-window display files age out here (arc 1): finalized runs after a
  // day, orphans on mtime, active runs untouchable. Never evidence, never
  // load-bearing — a sweep that finds nothing is the common case.
  const liveSwept = sweepLiveLogs(store, context.evidenceRoot, clock());

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
    adoption.forgotten.length === 0 &&
    liveSwept.removed.length === 0;

  return succeed(
    write,
    json,
    "reconcile",
    {
      recovered,
      reaped: reaped.map(claim => claim.leaseId),
      adopted: adoption.adopted,
      forgotten: adoption.forgotten,
      liveViewsSwept: liveSwept.removed.length,
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
            ...(liveSwept.removed.length === 0 ? [] : [`Cleared ${liveSwept.removed.length} finished live view(s).`]),
          ],
  );
}

// ---- gaps -----------------------------------------------------------------
// The computation lives in gaps.ts, shared with the web console; the CLI
// keeps only its own presentation.

/** `standing-orders gaps` — the BLOCKED section of the morning, standalone. */
function gapsCommand(flags: Map<string, string | true>, context: Context): number {
  const { store, write, json, clock } = context;
  const repo = repoFrom(flags);
  const gaps = computeGaps(store, repo, clock());

  if (json) {
    write(envelopeJson({ ok: true, command: "gaps", repo, gaps }));
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
 * `standing-orders brief` — one ritual (§6). The recent runs from the run table,
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
    return fail(write, json, "brief", "no-watch", "no watch episode recorded for this repo yet — run `standing-orders watch` first", EXIT.refused);
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
      envelopeJson(
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
      ),
    );
    return EXIT.ok;
  }

  const lines: string[] = [`standing-orders — the report ─ ${repo}`];
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
    lines.push(`      → standing-orders gaps --repo ${repo}`);
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
    lines.push(`  ▸ OUTBOX     ${pending.length} undelivered — standing-orders outbox deliver --cmd …`);
  }

  if (decisions.length > 0) {
    const overdue = decisions.filter(one => one.state === "expired").length;
    lines.push(
      `  ▸ DECIDE     ${decisions.length} waiting${overdue > 0 ? ` (${overdue} overdue)` : ""} — standing-orders decide`,
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
      lines.push(`      ${one.id.padEnd(20)} waits on ${one.blockedBy.join(", ")} — \`standing-orders task requeue ${one.blockedBy[0]}\``);
    }
  }

  if (incidents.length > 0) {
    lines.push(`  ▸ INCIDENTS  ${incidents.length} unresolved — these do not age out`);
    for (const incident of incidents) {
      lines.push(
        `      ${incident.taskId.padEnd(20)} ${incident.kind} since ${incident.createdAt} — read run ${incident.run}'s evidence, then \`standing-orders incident resolve ${incident.id}\``,
      );
    }
  }

  write(lines.join("\n"));
  return EXIT.ok;
}

// ---- decisions ------------------------------------------------------------

/**
 * `standing-orders decide` — the attention surface, in the terminal.
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
      write(envelopeJson({ ok: true, command: "decide", waiting }));
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
    write("  → standing-orders decide <id>       the whole screen");
    write("  → standing-orders decide <id> --choose <option> --as <you> --token <t>");
    return EXIT.refused;
  }

  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) {
    return fail(write, json, "decide", "usage", "`standing-orders decide [<id>] [--choose <option>]`", EXIT.usage);
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
      write(envelopeJson({ ok: true, command: "decide", decision, taskId, evidence }));
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
    write(`  → standing-orders decide ${id} --choose <option> --as <you> --token <t>`);
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
        ? `"${choice}" is not one of this decision's options — \`standing-orders decide ${id}\` shows them`
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
 * `standing-orders serve [--port N] [--host H] [--allow-host name:port …]` —
 * the decision view, on a phone. Signing in takes the approver credential;
 * there is no unauthenticated bind, localhost included. Plain HTTP: put a
 * TLS proxy in front for anything beyond a trusted network — Tailscale is
 * the intended road, with its name passed via --allow-host.
 */
/**
 * The extracted console starter (arc 2 finding 5/20): binds and resolves —
 * or rejects — with NO signal handlers and NO output. serveCommand wraps it
 * with its historical greeting and Ctrl-C wait; `up` supervises it beside
 * the watch loops.
 */
async function startConsole(options: {
  context: Context;
  host: string;
  port: number;
  localRunner?: string;
  poolRoot: string;
  allowedHosts?: string[];
  repos?: string[];
  projectRoots?: string[];
  publicUrl?: string;
  registryPath?: string;
  upConsole?: boolean;
  editorLinks?: "vscode";
  attended?: import("./serve.js").ServeOptions["attended"];
}): Promise<{ server: ReturnType<typeof createDecisionServer>; port: number; url: string }> {
  const { context } = options;
  const server = createDecisionServer({
    store: context.store,
    evidenceRoot: context.evidenceRoot,
    clock: context.clock,
    telegramTokenFile: context.telegramTokenFile,
    configDir: dirname(context.databaseFile),
    ...(options.localRunner === undefined ? {} : { localRunner: options.localRunner }),
    poolRoot: options.poolRoot,
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    ...(options.repos === undefined ? {} : { repos: options.repos }),
    ...(options.projectRoots === undefined ? {} : { projectRoots: options.projectRoots }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    ...(options.registryPath === undefined ? {} : { registryPath: options.registryPath }),
    ...(options.upConsole === undefined ? {} : { upConsole: options.upConsole }),
    ...(options.editorLinks === undefined ? {} : { editorLinks: options.editorLinks }),
    ...(options.attended === undefined ? {} : { attended: options.attended }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  }).catch(error => {
    throw new Error(`could not listen on ${options.host}:${options.port} — ${describe(error)}`);
  });
  const bound = server.address();
  const port = typeof bound === "object" && bound !== null ? bound.port : options.port;
  return { server, port, url: `http://${options.host}:${port}/` };
}

async function serveCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const portGiven = text(flags, "port");
  const port = Number(portGiven ?? 4180);
  // Validated like demo's --port — a NaN handed to listen() surfaced as a
  // baffling bind failure instead of a usage answer (round-4 finding 11).
  if (portGiven !== undefined && (!Number.isInteger(port) || port < 1 || port >= 65536)) {
    return fail(write, json, "serve", "usage", "--port is a whole number under 65536", EXIT.usage);
  }
  const host = text(flags, "host") ?? "127.0.0.1";
  const allow = text(flags, "allow-host");
  // The authorization ceiling: --repo (comma-separable) names repos this
  // server may show; --project-root authorizes any git repo under a
  // directory. Neither given = legacy unscoped mode, everything visible.
  const repoFlag = text(flags, "repo");
  const rootFlag = text(flags, "project-root");

  // The live peek's locality assertion (live-peek v3 §3): --runner names
  // the runner this machine owns — an ADMINISTRATOR ASSERTION, documented
  // as such, and the peek stays off entirely without it. --pool overrides
  // the checkout pool root the peek confines itself to.
  const localRunner = text(flags, "runner");
  const poolRoot = text(flags, "pool") ?? join(dirname(context.databaseFile), "worktrees");
  const publicUrl = text(flags, "public-url");
  // Editor deep links (arc 6): a deployment capability whose value is an
  // allow-list of one, and which is meaningless without the machine's
  // runner assertion — links bind to runs this machine owns.
  const editor = text(flags, "editor");
  if (editor !== undefined && editor !== "vscode") {
    return fail(write, json, "serve", "usage", "--editor supports: vscode", EXIT.usage);
  }
  if (editor !== undefined && localRunner === undefined) {
    return fail(write, json, "serve", "usage", "--editor needs --runner <name> — links bind to the worktrees this machine's runner owns", EXIT.usage);
  }

  const console_ = await startConsole({
    context,
    host,
    port,
    ...(localRunner === undefined ? {} : { localRunner }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(editor === undefined ? {} : { editorLinks: "vscode" as const }),
    registryPath: configPath(process.env, homedir()),
    poolRoot,
    ...(allow === undefined ? {} : { allowedHosts: allow.split(",") }),
    ...(repoFlag === undefined ? {} : { repos: repoFlag.split(",").map(one => one.trim()).filter(one => one !== "") }),
    ...(rootFlag === undefined ? {} : { projectRoots: rootFlag.split(",").map(one => one.trim()).filter(one => one !== "") }),
  });
  const server = console_.server;
  const actual = console_.port;
  if (json) {
    write(envelopeJson({ ok: true, command: "serve", host, port: actual }));
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
 * `standing-orders task requeue <id>` — the authenticated way back from a stall.
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
    return fail(write, json, "task requeue", "usage", "`standing-orders task requeue <id> --as <you> --token <t>`", EXIT.usage);
  }
  const racingGuard = refuseWhileRacing(context, "task requeue", id);
  if (racingGuard !== null) return racingGuard;
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
 * `standing-orders task plan <id>` — ask for a plan before any promise exists.
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
    return fail(write, json, "task plan", "usage", "`standing-orders task plan <id> --as <you> --token <t>`", EXIT.usage);
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
 * `standing-orders incident list|resolve <id>` — the parks that never became
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
      write(envelopeJson({ ok: true, command: "incident list", incidents }));
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
    write("  → standing-orders incident resolve <id> --as <you> --token <t>");
    return EXIT.refused;
  }

  if (action !== "resolve") {
    return fail(write, json, "incident", "usage", "`standing-orders incident [list|resolve <id>]`", EXIT.usage);
  }
  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) {
    return fail(write, json, "incident resolve", "usage", "`standing-orders incident resolve <id> --as <you> --token <t>`", EXIT.usage);
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

/**
 * `standing-orders webhook …` — Slack and Discord as UI-ONLY mirrors: every
 * page is a message with a console link; acting stays in the console
 * behind its own authentication. The URL is a credential: 0600 file
 * beside the database, or the environment, never anywhere else.
 */
async function webhookCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const dir = dirname(context.databaseFile);
  const [action, which, value] = positional;

  const telegramConfigured = loadBotToken(process.env, context.telegramTokenFile) !== null;

  if (action === undefined || action === "status") {
    const targets = loadWebhookTargets(process.env, dir);
    const consoleUrl = loadConsoleUrl(process.env, dir);
    const primary = effectivePrimary(process.env, dir, telegramConfigured);
    if (json) {
      write(envelopeJson({ ok: true, command: "webhook status", configured: primary.configured, primary: primary.channel, implicit: primary.implicit, consoleUrl }));
      return EXIT.ok;
    }
    write(`Messaging${primary.configured.length === 0 ? ": nothing configured" : ""}`);
    for (const channel of primary.configured) {
      write(`  ${channel.padEnd(8)} connected${channel === primary.channel ? "  ← receives alerts" : "  (silent — not primary)"}`);
    }
    if (primary.implicit && primary.channel !== null) {
      write(`  ! several services are connected and none was chosen — ${primary.channel} receives alerts by default.`);
      write(`    Choose: standing-orders webhook primary telegram|slack|discord`);
    }
    write(`  links    ${consoleUrl ?? "NOT SET — messages will carry no console link; standing-orders webhook set console-url http://host:port"}`);
    if (targets.length === 0) {
      write("");
      write("  standing-orders webhook set slack https://hooks.slack.com/services/…");
      write("  standing-orders webhook set discord https://discord.com/api/webhooks/…");
      write(`  (or export ${SLACK_ENV} / ${DISCORD_ENV})`);
    }
    write("");
    write("  Mirrors deliver when Telegram is not configured; with a paired Telegram");
    write("  chat, Telegram carries the page (it can hold buttons) and mirrors stay quiet.");
    return EXIT.ok;
  }

  if (action === "test") {
    const targets = loadWebhookTargets(process.env, dir);
    if (targets.length === 0) {
      return fail(write, json, "webhook test", "unconfigured", "no webhook configured — `standing-orders webhook set slack|discord <url>`", EXIT.refused);
    }
    store.enqueueNotification(
      { dedupeKey: `webhook-test:${clock().getTime()}`, kind: "test", subject: "standing-orders webhook test", body: "If you can read this, the mirror works. Acting happens in the console." },
      clock(),
    );
    const report = await webhookPass(store, { targets, consoleUrl: loadConsoleUrl(process.env, dir), clock });
    if (report.problems.length > 0) {
      return fail(write, json, "webhook test", "delivery", report.problems.join("; "), EXIT.failed);
    }
    return succeed(write, json, "webhook test", { sent: report.sent }, () => [`Sent ${report.sent} message(s). Check the channel.`]);
  }

  if (action === "primary") {
    if (which === undefined || !isMessagingChannel(which)) {
      return fail(write, json, "webhook primary", "usage", "primary is one of telegram, slack, discord", EXIT.usage);
    }
    const primary = effectivePrimary(process.env, dir, telegramConfigured);
    if (!primary.configured.includes(which)) {
      return fail(write, json, "webhook primary", "unconfigured", `${which} is not configured — set it up first, then choose it`, EXIT.refused);
    }
    savePrimary(dir, which);
    return succeed(write, json, "webhook primary", { primary: which }, () => [
      `Alerts now go to ${which}. ${which === "telegram" ? "Buttons and replies work there as always." : "Telegram (if configured) still accepts taps and replies — it just stops sending alerts."}`,
    ]);
  }

  if (action === "clear" && (which === "slack" || which === "discord")) {
    clearWebhook(dir, which);
    return succeed(write, json, "webhook clear", { which }, () => [`${which} mirror cleared.`]);
  }

  if (action !== "set" || which === undefined || value === undefined) {
    return fail(write, json, "webhook", "usage", "`standing-orders webhook [status|test|set slack|discord|console-url <value>|clear slack|discord]`", EXIT.usage);
  }
  if (which === "console-url") {
    const saved = saveConsoleUrl(dir, value);
    if (!saved.ok) return fail(write, json, "webhook set", "invalid", saved.message, EXIT.usage);
    return succeed(write, json, "webhook set", { which }, () => [`Console links will open ${value.replace(/\/+$/, "")}.`]);
  }
  if (which !== "slack" && which !== "discord") {
    return fail(write, json, "webhook set", "usage", "set what? slack, discord, or console-url", EXIT.usage);
  }
  const saved = saveWebhook(dir, which, value);
  if (!saved.ok) return fail(write, json, "webhook set", "invalid", saved.message, EXIT.usage);

  // The first moment more than one service exists is the moment to ask
  // which one pages — once, right here, not at 3am when both fire.
  const after = effectivePrimary(process.env, dir, telegramConfigured);
  let chosen: string | null = null;
  if (after.implicit && loadPrimary(process.env, dir) === null && after.configured.length > 1 && interactive() && !json) {
    write(`You now have ${after.configured.join(" and ")} connected.`);
    const answer = (await ask(`Which service should receive alerts? [${after.configured.join("/")}] `)).trim().toLowerCase();
    if (isMessagingChannel(answer) && after.configured.includes(answer)) {
      savePrimary(dir, answer);
      chosen = answer;
    } else {
      write(`Left unchosen — ${after.channel} receives alerts by default. Decide any time: standing-orders webhook primary <service>`);
    }
  }
  return succeed(write, json, "webhook set", { which, ...(chosen === null ? {} : { primary: chosen }) }, () => [
    `${which} mirror configured — the URL lives in a private file beside the database.`,
    ...(chosen === null ? [] : [`${chosen} carries the pages.`]),
    ...(after.implicit && chosen === null && !interactive() ? [`Several services are configured — choose the pager: standing-orders webhook primary <service>`] : []),
    `Send yourself a proof: standing-orders webhook test`,
  ]);
}

/**
 * `standing-orders providers` — identification, never integration theater.
 *
 * Four different claims, kept apart on purpose (Codex provider review):
 * INSTALLED (the binary answered --version), CONFIGURED (a phase names
 * it), HISTORICALLY SUCCESSFUL (a stamped run concluded — proof of login
 * AT THAT TIME), and CURRENTLY AUTHENTICATED (only where a cheap,
 * non-spending probe exists — codex's \`login status\`). Claude has no
 * probe that does not risk spend, and this report says so instead of
 * guessing; an OpenRouter key's PRESENCE proves neither validity nor
 * authorization, and is reported as exactly that.
 */
async function providersCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const probe = context.gitRunner ?? run;
  const configured = new Map<string, string[]>();
  for (const scope of [INSTALLATION_SCOPE]) {
    for (const row of store.listPhaseConfig(scope)) {
      configured.set(row.provider, [...(configured.get(row.provider) ?? []), row.phase]);
    }
  }

  // Probed CONCURRENTLY: each --version is a whole CLI start, and a report
  // that serializes four of them reads as a hang (Phase 3).
  const probed = await Promise.all(
    PROVIDER_IDS.map(async id => {
      const facts = inspectionOf(id);
      const version = await probe(facts.binary, ["--version"], { timeoutMs: 5_000 });
      const installed = version.code === 0 && !version.notFound;
      let identity: string | null = null;
      if (installed && facts.identityProbe !== null) {
        const asked = await probe(facts.binary, [...facts.identityProbe], { timeoutMs: 5_000 });
        identity = asked.code === 0 ? (asked.stdout.trim().split("\n")[0] ?? null) : "not logged in";
      }
      return { id, facts, version, installed, identity };
    }),
  );
  const report: Record<string, unknown>[] = [];
  for (const { id, facts, version, installed, identity } of probed) {
    const lastSuccess = store.providerLastSuccess(id);
    const keyPresent = facts.requiresEnv === null ? null : (process.env[facts.requiresEnv] ?? "") !== "";
    report.push({
      provider: id,
      binary: facts.binary,
      installed,
      version: installed ? (version.stdout.trim().split("\n")[0] ?? "") : null,
      identity,
      lastSuccessfulRun: lastSuccess,
      ...(keyPresent === null ? {} : { keyPresent, keyEnv: facts.requiresEnv }),
      measuresCost: facts.measuresCost,
      configuredPhases: configured.get(id) ?? [],
      // The audit: facts about the harness, reported before any of them is
      // enforced. What transport we read, whether a session can resume,
      // which init signal exists, what hermetic flag we deliberately do NOT
      // pass, and which user-global config can reach an unattended run.
      audit: auditOf(id),
      // Tier-2 attestation (Phase 3): the range this adapter's conformance
      // fixtures cover, against what is installed right now. Tier-1
      // providers carry no entry — their runs are not version-gated.
      ...(attestationOf(id) === null
        ? {}
        : {
            attestation: {
              ...(attestationOf(id) as object),
              installedInRange:
                installed && versionInRange((version.stdout.trim().split("\n")[0] ?? ""), attestationOf(id) as AttestationRange),
            },
          }),
    });
  }

  if (json) {
    write(envelopeJson({ ok: true, command: "providers", providers: report }));
    return EXIT.ok;
  }
  for (const one of report) {
    const name = String(one["provider"]);
    write(`${name}`);
    write(`  installed      ${one["installed"] === true ? `yes — ${String(one["version"])}` : `no — \`${String(one["binary"])}\` did not answer`}`);
    if (one["identity"] !== null && one["identity"] !== undefined) {
      write(`  authenticated  ${String(one["identity"])} (probed just now, without spending)`);
    } else if (name === "claude") {
      write(`  authenticated  not probed — no non-spending check exists; a real run is the proof`);
    }
    write(`  last success   ${one["lastSuccessfulRun"] === null ? "never on this installation" : `${String(one["lastSuccessfulRun"])} — login was valid then`}`);
    if (one["keyEnv"] !== undefined) {
      write(`  ${String(one["keyEnv"])}  ${one["keyPresent"] === true ? "present (not validated — presence is not authorization)" : "ABSENT — runs will fail until the runner exports it"}`);
    }
    write(`  cost           ${one["measuresCost"] === true ? "measured in dollars per run" : "tokens only — runs land as UNMEASURED; ceilinged routines fail closed on them"}`);
    const phases = one["configuredPhases"] as string[];
    if (phases.length > 0) write(`  configured     ${phases.join(", ")} (installation)`);
    const audit = one["audit"] as ProviderAudit;
    write(`  transport      ${audit.transport}${audit.initSignal === "none" ? " — no init signal; a failed run cannot say whether the harness came up" : ` — init signal: ${audit.initSignal}`}`);
    write(`  resume         ${audit.resume}`);
    const attested = one["attestation"] as (AttestationRange & { installedInRange: boolean }) | undefined;
    if (attested !== undefined) {
      write(
        `  attested       ${attested.floor} up to (not including) ${attested.ceiling}, fixtures at ${attested.fixturesAt} — ${
          attested.installedInRange
            ? "the installed version is inside the range"
            : "the INSTALLED VERSION IS OUTSIDE THE RANGE; dispatch will refuse until re-attestation"
        }`,
      );
    }
    write(
      `  isolation      ${
        audit.isolation.flag === null
          ? "no hermetic flag"
          : `${audit.isolation.flag} exists, not passed${audit.isolation.resumeSafe === false ? " — it would break session resume" : audit.isolation.resumeSafe === null ? " — its effect on resume is unvalidated" : ""}`
      }`,
    );
    write(`  config surface ${audit.configSurface.join("; ")}`);
    write("");
  }
  write("  \u2192 standing-orders config show    which provider each phase actually resolves to");
  return EXIT.ok;
}

/**
 * \`standing-orders config …\` — which provider and model each phase runs on.
 *
 * Two scopes: the installation, and one project's override. Mutations are
 * AUTHENTICATED and AUDITED — spend routing is authority, not preference
 * (Codex provider review, Q4): an unauthenticated verb here would let
 * anything that can run a shell reroute every future build. Rows are
 * complete pairs; `show` prints what each phase actually resolves to.
 */
async function configCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, phase] = positional;
  if (action !== undefined && !(CONFIG_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "config", "usage", `unknown \`config ${action}\` — try ${CONFIG_ACTIONS.join(", ")}`, EXIT.usage);
  }
  const repoGiven = text(flags, "repo");
  const scope = repoGiven === undefined ? INSTALLATION_SCOPE : canonicalProject(repoGiven) ?? resolve(repoGiven);

  if (action === undefined || action === "show") {
    const installation = store.listPhaseConfig(INSTALLATION_SCOPE);
    const project = scope === INSTALLATION_SCOPE ? [] : store.listPhaseConfig(scope);
    const resolved = (["plan", "build", "repair"] as const).map(one => {
      const answer = resolvePhaseAgent(store, one, scope === INSTALLATION_SCOPE ? null : scope, {});
      return {
        phase: one,
        ...(answer.ok
          ? { provider: answer.spec.provider, model: answer.spec.model, source: answer.source }
          : { problem: answer.problem }),
      };
    });
    if (json) {
      write(envelopeJson({ ok: true, command: "config show", installation, project, resolved }));
      return EXIT.ok;
    }
    write(`Effective phase agents${scope === INSTALLATION_SCOPE ? "" : ` for ${scope}`}:`);
    for (const one of resolved) {
      if ("problem" in one) {
        write(`  ${one.phase.padEnd(8)} MISCONFIGURED — ${one.problem}`);
      } else {
        write(`  ${one.phase.padEnd(8)} ${one.provider}${one.model === null ? " (harness default model)" : ` · ${one.model}`}  [${one.source}]`);
      }
    }
    write("");
    write("  repair note: the repair PROVIDER always inherits the build it mends — only its model is configurable.");
    if (installation.length === 0 && project.length === 0) {
      write("  nothing configured — every phase runs the default (claude).");
      write("  standing-orders config set build --provider claude --model sonnet --as <you> --token <t>");
    }
    return EXIT.ok;
  }

  if (action !== "set" && action !== "clear") {
    return fail(write, json, "config", "usage", "`standing-orders config [show|set <phase> --provider <p> [--model <m>]|clear <phase>] [--repo <path>] --as <you> --token <t>`", EXIT.usage);
  }

  // Global dollar thresholds (v15, operator request): defaults for filings
  // and an installation-wide backstop. Authenticated like every spend
  // routing act; the per-task digest stays the authority.
  if (phase === "budgets") {
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `config ${action}`, "usage", "changing spend defaults takes `--as <you> --token <t>`", EXIT.usage);
    }
    const authedBudget = authenticateApprover(store, acting.name, acting.token);
    if (!authedBudget.ok) {
      return fail(write, json, `config ${action}`, "unauthenticated", "that is not an approver, or the token does not match", EXIT.refused);
    }
    if (action === "clear") {
      store.setSpendDefaults({ buildPerRunMicrousd: null, racePerAgentMicrousd: null, raceTotalMicrousd: null }, acting.name, clock());
      return succeed(write, json, "config clear", { budgets: null }, () => ["Spend defaults cleared — filings state their own numbers again."]);
    }
    const parseUsd = (flag: string): number | null | false => {
      const given = text(flags, flag);
      if (given === undefined) return null;
      const value = Number(given);
      return Number.isFinite(value) && value > 0 ? Math.round(value * 1_000_000) : false;
    };
    const build = parseUsd("build-usd");
    const racePer = parseUsd("race-per-usd");
    const raceTotal = parseUsd("race-total-usd");
    // Name the flag that was bad — "budgets are positive dollar amounts"
    // over four candidates left the caller diffing their own command line.
    const badFlag = build === false ? "--build-usd" : racePer === false ? "--race-per-usd" : raceTotal === false ? "--race-total-usd" : null;
    if (badFlag !== null || build === false || racePer === false || raceTotal === false) {
      return fail(write, json, "config set", "usage", `${badFlag ?? "--build-usd"} is a positive dollar amount`, EXIT.usage);
    }
    // The default competing-agent count (operator request): applied only
    // where a filing names one agent and no explicit count; a race digest
    // always binds the actual lineup.
    const agentsGiven = text(flags, "race-agents");
    const raceAgents = agentsGiven === undefined ? null : Number(agentsGiven);
    if (raceAgents !== null && (!Number.isInteger(raceAgents) || raceAgents < 2 || raceAgents > 4)) {
      return fail(write, json, "config set", "usage", "--race-agents is how many agents compete by default: a whole number from 2 to 4", EXIT.usage);
    }
    store.setSpendDefaults({ buildPerRunMicrousd: build, racePerAgentMicrousd: racePer, raceTotalMicrousd: raceTotal, raceAgents }, acting.name, clock());
    return succeed(write, json, "config set", { budgets: store.getSpendDefaults() }, () => [
      "Spend defaults set. New filings pre-fill from these; every approval still restates its own numbers:",
      ...(build === null ? [] : [`  each ordinary build attempt: $${(build / 1_000_000).toFixed(2)} (also the installation backstop)`]),
      ...(racePer === null ? [] : [`  each tournament agent: $${(racePer / 1_000_000).toFixed(2)}`]),
      ...(raceTotal === null ? [] : [`  each tournament total: $${(raceTotal / 1_000_000).toFixed(2)}`]),
      ...(raceAgents === null ? [] : [`  tournaments race ${raceAgents} agents unless a filing says otherwise`]),
    ]);
  }

  // Chat is its OWN configuration, deliberately not a phase (Codex v3
  // review, change 1): a shared table would admit build+anthropic-api.
  // Installation-scoped only — a per-repo chat would splinter the spend
  // ceiling that makes the ledger a ceiling at all.
  if (phase === "chat") {
    if (repoGiven !== undefined) {
      return fail(write, json, `config ${action}`, "usage", "chat is installation-scoped — no --repo", EXIT.usage);
    }
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `config ${action}`, "usage", "changing chat spend takes `--as <you> --token <t>`", EXIT.usage);
    }
    const authedChat = authenticateApprover(store, acting.name, acting.token);
    if (!authedChat.ok) {
      return fail(write, json, `config ${action}`, "unauthenticated", "that is not an approver, or the token does not match", EXIT.refused);
    }
    if (action === "clear") {
      store.clearChatConfig();
      return succeed(write, json, "config clear", { chat: null }, () => ["Chat is off — the config row is gone."]);
    }
    const provider = text(flags, "provider");
    const model = text(flags, "model");
    const weeklyUsd = text(flags, "weekly-usd");
    const dailyGiven = text(flags, "daily-turns");
    if (provider !== "anthropic-api" && provider !== "openrouter-api") {
      return fail(write, json, "config set", "usage", "chat providers are direct API adapters: --provider anthropic-api|openrouter-api", EXIT.usage);
    }
    if (model === undefined || priceOf(model) === null) {
      return fail(write, json, "config set", "unpriced-model", `chat reserves worst-case spend up front, so the model needs a pinned price — priced today: ${PRICED_MODELS.join(", ")}`, EXIT.refused);
    }
    const weekly = Number(weeklyUsd);
    if (weeklyUsd === undefined || !Number.isFinite(weekly) || weekly <= 0) {
      return fail(write, json, "config set", "usage", "--weekly-usd <dollars> is required — chat without a ceiling is not configured, it is unbounded", EXIT.usage);
    }
    const daily = dailyGiven === undefined ? 50 : Number(dailyGiven);
    if (!Number.isInteger(daily) || daily <= 0 || daily > 1_000) {
      return fail(write, json, "config set", "usage", "--daily-turns is a whole number between 1 and 1000", EXIT.usage);
    }
    // The CLI pins from the compiled table (the console additionally offers
    // OpenRouter's live catalog — priced by the party that bills it).
    const pinned = priceOf(model);
    if (pinned === null) {
      return fail(write, json, "config set", "unpriced-model", `no compiled price for ${model}`, EXIT.refused);
    }
    store.setChatConfig(
      {
        provider,
        model,
        dailyTurns: daily,
        weeklyCeilingMicrousd: Math.round(weekly * 1_000_000),
        priceInMicrousd: pinned.inMicrousd,
        priceOutMicrousd: pinned.outMicrousd,
      },
      acting.name,
      clock(),
    );
    return succeed(write, json, "config set", { chat: store.getChatConfig() }, () => [
      `Chat answers with ${provider} · ${model}, at most ${daily} turns/day, at most $${weekly.toFixed(2)} per rolling week.`,
      `The key rides the serve environment (${provider === "anthropic-api" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY"}) — never this database.`,
    ]);
  }

  if (phase === undefined || !["plan", "build", "repair"].includes(phase)) {
    return fail(write, json, `config ${action}`, "usage", "which phase? plan, build, repair — or chat", EXIT.usage);
  }

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, `config ${action}`, "usage", "changing spend routing takes `--as <you> --token <t>`", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, `config ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, phase), EXIT.refused);
  }

  if (action === "clear") {
    const cleared = store.clearPhaseConfig(scope, phase);
    return succeed(write, json, "config clear", { scope, phase, cleared }, () => [
      cleared ? `Cleared ${phase} at ${scope} — it resolves one layer down now.` : `Nothing was configured for ${phase} at ${scope}.`,
    ]);
  }

  const providerGiven = text(flags, "provider");
  if (providerGiven === undefined || !isProviderId(providerGiven)) {
    return fail(write, json, "config set", "usage", `--provider is one of ${PROVIDER_IDS.join(", ")}`, EXIT.usage);
  }
  const modelGiven = text(flags, "model") ?? null;
  const valid = validateSpec({ provider: providerGiven, model: modelGiven });
  if (!valid.ok) {
    return fail(write, json, "config set", "invalid", valid.problem, EXIT.usage);
  }
  store.setPhaseConfig(scope, phase, providerGiven, modelGiven, acting.name, clock());
  const warnings: string[] = [];
  if (providerGiven === "openrouter" && (process.env["OPENROUTER_API_KEY"] ?? "") === "") {
    warnings.push("OPENROUTER_API_KEY is not present in this environment — runs will fail until the runner exports it.");
  }
  if (providerGiven !== "claude") {
    warnings.push(`${providerGiven} does not report dollar cost: its runs land as UNMEASURED, and any routine with a cost ceiling fails closed on them by design.`);
  }
  return succeed(write, json, "config set", { scope, phase, provider: providerGiven, model: modelGiven, warnings }, () => [
    `${phase} at ${scope === INSTALLATION_SCOPE ? "the installation" : scope} now runs ${providerGiven}${modelGiven === null ? "" : ` · ${modelGiven}`}, set by ${acting.name}.`,
    ...warnings.map(one => `  ! ${one}`),
  ]);
}

/**
 * `standing-orders setup …` — the per-repo worktree setup (M5.7). What a
 * fresh checkout runs before any agent spawns in it: dependencies, .env
 * copies, generated code. Approval is authority (an approved command runs
 * unattended in every future worktree), so `set` and `clear` take the
 * approver's credential and `set` restates the exact terms — command,
 * timeout, digest — before `--yes` lands them. The command TEXT is stored;
 * secret values never are.
 */
async function setupCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const clock = context.clock ?? (() => new Date());
  const action = positional[0] ?? "show";
  const repo = text(flags, "repo");

  if (action === "show") {
    if (repo === undefined) {
      return fail(write, json, "setup show", "usage", "which repo? --repo <path>", EXIT.usage);
    }
    const live = store.liveWorktreeSetup(repo);
    if (json) {
      write(envelopeJson({ ok: true, command: "setup show", repo, setup: live }));
      return EXIT.ok;
    }
    write(
      live === null
        ? `No worktree setup for ${repo}. Fresh checkouts run nothing before the agent.`
        : `${repo} runs before every agent:\n  ${live.command}\n  timeout ${Math.round(live.timeoutMs / 1000)}s · digest ${live.digest} · approved by ${live.approvedBy} at ${live.approvedAt}`,
    );
    return EXIT.ok;
  }

  if (action !== "set" && action !== "clear") {
    return fail(write, json, "setup", "usage", "`standing-orders setup [show|set --command <cmd> [--timeout-seconds <n>] --yes|clear] --repo <path> --as <you> --token <t>`", EXIT.usage);
  }
  if (repo === undefined) {
    return fail(write, json, `setup ${action}`, "usage", "which repo? --repo <path>", EXIT.usage);
  }

  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, `setup ${action}`, "usage", "an approved setup runs unattended in every future worktree — changing it takes `--as <you> --token <t>`", EXIT.usage);
  }
  const authenticated = authenticateApprover(store, acting.name, acting.token);
  if (!authenticated.ok) {
    return fail(write, json, `setup ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, repo), EXIT.refused);
  }

  if (action === "clear") {
    const cleared = store.clearWorktreeSetup(repo, acting.name, clock());
    return succeed(write, json, "setup clear", { repo, cleared }, () => [
      cleared ? `Cleared — fresh checkouts of ${repo} run nothing now.` : `Nothing was set for ${repo}.`,
    ]);
  }

  const command = text(flags, "command");
  if (command === undefined || command.trim() === "") {
    return fail(write, json, "setup set", "usage", "--command <cmd> is what every fresh checkout will run", EXIT.usage);
  }
  if (command.length > 2000 || hasDisguisedText(command)) {
    return fail(write, json, "setup set", "invalid", "the command must be under 2000 characters with no control or bidi characters", EXIT.usage);
  }
  // Literal credentials never become standing rows (audit IV-5): a command
  // that embeds a token is stored forever in plain text. Reference an
  // environment variable the runner already exports instead. `$TOKEN` is
  // a reference and passes; `=secret123` is a value and refuses.
  const credentialShaped =
    /([A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api_key|authorization|bearer|credential)[A-Za-z0-9_-]*\s*[=:]\s*)(?![$"']?\$)\S+/i.test(command) ||
    /\/\/[^\s/@]+:[^\s/@]+@/.test(command);
  if (credentialShaped) {
    return fail(write, json, "setup set", "credential-shaped", "the command appears to embed a credential — reference an environment variable the runner exports (e.g. $NPM_TOKEN) instead of a literal value", EXIT.usage);
  }
  const timeoutSeconds = Number(text(flags, "timeout-seconds") ?? "300");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    return fail(write, json, "setup set", "invalid", "--timeout-seconds is 1..3600", EXIT.usage);
  }

  if (flags.get("yes") !== true) {
    if (json) {
      write(envelopeJson({ ok: false, command: "setup set", reason: "unconfirmed", repo, setupCommand: command, timeoutSeconds }));
      return EXIT.refused;
    }
    for (const line of [
      `The terms, exactly:`,
      `  repo     ${repo}`,
      `  command  ${command}`,
      `  timeout  ${timeoutSeconds}s`,
      ``,
      `Every FUTURE worktree of this repo runs this command unattended,`,
      `before any agent spawns in it, under an ALLOWLISTED environment`,
      `(PATH, HOME, locale, temp — no credentials). A failed setup blocks`,
      `the build as an environment problem. Re-run with --yes to approve.`,
    ]) {
      write(line);
    }
    return EXIT.refused;
  }

  const saved = store.setWorktreeSetup(
    { repo, command, timeoutMs: timeoutSeconds * 1000, approvedBy: acting.name },
    clock(),
  );
  return succeed(write, json, "setup set", { repo, digest: saved.digest, timeoutSeconds }, () => [
    `Approved: fresh checkouts of ${repo} run \`${command}\` (digest ${saved.digest}, ${timeoutSeconds}s) before any agent.`,
  ]);
}

const GITHUB_REPO_SHAPE = /^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/;
const LABEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9:_. -]{0,49}$/;

/** `ghi-owner-name-123` — deterministic, so existence IS the dedupe. */
function intakeTaskId(github: string, issueNumber: number): string {
  // The suffix IS the identity; the slug gives way to it (audit C-7) —
  // truncating the issue number off a long owner/repo would silently map
  // distinct issues onto one task id.
  const suffix = `-${issueNumber}`;
  const slug = github.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `ghi-${slug}`.slice(0, 64 - suffix.length) + suffix;
}

/**
 * `standing-orders intake …` (M8.16) — labeled GitHub issues become LOCAL
 * UNAPPROVED task proposals, preview-first, under an explicit grant.
 *
 * Detection is not authorization: enrolling a repo with four hundred open
 * issues is not volunteering them, so the grant names the exact repository
 * AND the exact label, and its terms are restated before --yes. The run
 * pass mutates nothing remote — reads make proposals, people approve them,
 * and external-backend dispatch remains unshipped and says so. Issue
 * titles are untrusted text: control/bidi characters refuse the candidate
 * rather than importing a disguise, and the issue BODY is never imported
 * at all — the proposal links to GitHub where a person reads it.
 */
async function intakeCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const clock = context.clock ?? (() => new Date());
  const gh = context.gitRunner ?? run;
  const action = positional[0] ?? "show";
  const repo = repoFrom(flags);

  if (action === "pr-comments" || action === "preview" || action === "run") {
    // Reads too: a demo sandbox makes no gh call at all (finding 8).
    const demoFence = refuseDemo(context, `intake ${action}`);
    if (demoFence !== null) return demoFence;
  }

  if (action === "show") {
    const grant = store.liveIntakeGrant(repo);
    if (json) {
      write(envelopeJson({ ok: true, command: "intake show", repo, grant }));
      return EXIT.ok;
    }
    write(
      grant === null
        ? `No intake grant for ${repo}. Nothing on GitHub becomes a proposal here.`
        : `${repo} intakes GitHub issues from ${grant.github} labeled "${grant.label}"${grant.reviewers === null ? "" : `; PR comments from: ${grant.reviewers.join(", ")}`} — granted by ${grant.approvedBy} at ${grant.approvedAt}.`,
    );
    return EXIT.ok;
  }

  if (action === "grant" || action === "clear") {
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `intake ${action}`, "usage", "an intake grant is standing authority — it takes `--as <you> --token <t>`", EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, `intake ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, repo), EXIT.refused);
    }
    if (action === "clear") {
      const cleared = store.clearIntakeGrant(repo, acting.name, clock());
      return succeed(write, json, "intake clear", { repo, cleared }, () => [
        cleared ? `Revoked — nothing on GitHub becomes a proposal for ${repo} now.` : `Nothing was granted for ${repo}.`,
      ]);
    }
    const github = text(flags, "github");
    const label = text(flags, "label");
    if (github === undefined || !GITHUB_REPO_SHAPE.test(github)) {
      return fail(write, json, "intake grant", "usage", "--github <owner/name> names the repository on GitHub", EXIT.usage);
    }
    if (label === undefined || !LABEL_SHAPE.test(label)) {
      return fail(write, json, "intake grant", "usage", "--label <label> names the exact label that nominates an issue", EXIT.usage);
    }
    const reviewersRaw = text(flags, "reviewers");
    const reviewers =
      reviewersRaw === undefined
        ? null
        : reviewersRaw.split(",").map(one => one.trim()).filter(one => /^[A-Za-z0-9-]{1,39}$/.test(one));
    if (flags.get("yes") !== true) {
      if (json) {
        write(envelopeJson({ ok: false, command: "intake grant", reason: "unconfirmed", repo, github, label, reviewers }));
        return EXIT.refused;
      }
      for (const line of [
        `The terms, exactly:`,
        `  local repo   ${repo}`,
        `  github       ${github}`,
        `  label        ${label}`,
        `  pr comments  ${reviewers === null || reviewers.length === 0 ? "nobody's — PR-comment intake stays off" : `from ${reviewers.join(", ")} only`}`,
        ``,
        `Open issues carrying exactly this label become LOCAL, UNAPPROVED task`,
        `proposals when \`standing-orders intake run\` passes. Nothing builds`,
        `without a scope you approve; nothing on GitHub is ever written to.`,
        `Re-run with --yes to grant.`,
      ]) {
        write(line);
      }
      return EXIT.refused;
    }
    const granted = store.setIntakeGrant({ repo, github, label, reviewers, approvedBy: acting.name }, clock());
    return succeed(write, json, "intake grant", { repo, github, label, reviewers: granted.reviewers }, () => [
      `Granted: issues in ${github} labeled "${label}" become unapproved proposals for ${repo}.`,
    ]);
  }

  if (action !== "preview" && action !== "run" && action !== "pr-comments") {
    return fail(write, json, "intake", "usage", "`standing-orders intake [show|grant|clear|preview|run|pr-comments] --repo <path> …`", EXIT.usage);
  }

  const grant = store.liveIntakeGrant(repo);
  if (grant === null) {
    return fail(write, json, `intake ${action}`, "no-grant", `no intake grant for ${repo} — \`standing-orders intake grant\` states the terms`, EXIT.refused);
  }

  if (action === "pr-comments") {
    // PR review comments become LOCAL diff comments (M8.17): own PRs only
    // (the publication table IS the list of ours), named reviewers only,
    // the GitHub comment id the idempotency key, every body through the
    // shared validator. Nothing here authorizes a spawn — ingested
    // comments wait on the run page for the same one-tap seal and the
    // same scope approval as comments typed in the console.
    if (grant.reviewers === null || grant.reviewers.length === 0) {
      return fail(write, json, "intake pr-comments", "no-reviewers", "the grant names no reviewers — `intake grant --reviewers <logins>` is the authority for this", EXIT.refused);
    }
    const publications = store
      .openedPublications()
      .filter(
        one =>
          one.prNumber !== null &&
          store.refForId(one.taskRef)?.repo === repo &&
          // The grant names ONE GitHub repository; a publication opened
          // against another must not have that repo's PR numbers fetched
          // onto its runs (audit C-5).
          one.githubRepo === grant.github,
      );
    let ingested = 0;
    let duplicates = 0;
    let refused = 0;
    const skippedPrs: { pr: number; reason: string }[] = [];
    for (const publication of publications) {
      const pr = publication.prNumber as number;
      const terminal = store.artifactsFor(publication.run).find(one => one.kind === "terminal-diff");
      if (terminal === undefined) {
        skippedPrs.push({ pr, reason: "no terminal diff to bind comments to" });
        continue;
      }
      const proven = readVerifiedArtifact(context.evidenceRoot, terminal);
      if (!proven.ok) {
        skippedPrs.push({ pr, reason: `the terminal diff no longer verifies — ${proven.problem}` });
        continue;
      }
      const asked = await gh("gh", ["api", "--paginate", `repos/${grant.github}/pulls/${pr}/comments`], { timeoutMs: 60_000 });
      if (asked.code !== 0) {
        skippedPrs.push({ pr, reason: "github unreachable" });
        continue;
      }
      let remote: { id?: unknown; user?: { login?: unknown }; path?: unknown; line?: unknown; original_line?: unknown; body?: unknown }[];
      try {
        remote = JSON.parse(asked.stdout) as typeof remote;
      } catch {
        skippedPrs.push({ pr, reason: "github answered without its promised JSON" });
        continue;
      }
      if (!Array.isArray(remote)) {
        skippedPrs.push({ pr, reason: "github answered with JSON that is not the promised array" });
        continue;
      }
      for (const comment of remote) {
        const login = String(comment.user?.login ?? "");
        // GitHub logins are case-insensitive; the allowlist match is too.
        if (!grant.reviewers.some(one => one.toLowerCase() === login.toLowerCase())) continue;
        const id = Number(comment.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        const body = validateNote(String(comment.body ?? ""));
        if (!body.ok) {
          refused += 1;
          continue;
        }
        const rawPath = String(comment.path ?? "");
        const lineRaw = comment.line ?? comment.original_line;
        const line = typeof lineRaw === "number" && Number.isInteger(lineRaw) && lineRaw > 0 ? lineRaw : null;
        const added = store.addDiffComment(
          {
            artifactId: terminal.id,
            runId: publication.run,
            path: rawPath !== "" && rawPath.length <= 300 && !hasDisguisedText(rawPath) ? rawPath : null,
            line,
            note: body.note,
            author: `github:${login}`,
            sourceKey: `gh:${grant.github}:${id}`,
          },
          clock(),
        );
        if (added === null) duplicates += 1;
        else ingested += 1;
      }
    }
    return succeed(write, json, "intake pr-comments", { repo, prs: publications.length, ingested, duplicates, refused, skippedPrs }, () => [
      `${ingested} comment(s) ingested across ${publications.length} PR(s)${duplicates > 0 ? `, ${duplicates} already known` : ""}${refused > 0 ? `, ${refused} refused by the validator` : ""}.`,
      ...skippedPrs.map(one => `  PR #${one.pr} skipped: ${one.reason}`),
      ingested > 0 ? "Seal them into revision tasks from each build's page — every revision takes its own approval." : "",
    ]);
  }

  const limit = Math.min(Math.max(Number(text(flags, "limit") ?? "50"), 1), 200);
  const asked = await gh(
    "gh",
    ["issue", "list", "--repo", grant.github, "--label", grant.label, "--state", "open", "--limit", String(limit), "--json", "number,title,updatedAt"],
    { timeoutMs: 20_000 },
  );
  if (asked.code !== 0) {
    return fail(write, json, `intake ${action}`, "github-unreachable", `gh could not list ${grant.github}: ${(asked.stderr.split("\n")[0] ?? "").slice(0, 200)}`, EXIT.failed);
  }
  let issues: { number: number; title: string; updatedAt?: string }[];
  try {
    issues = JSON.parse(asked.stdout) as typeof issues;
  } catch {
    return fail(write, json, `intake ${action}`, "github-unreadable", "gh answered, but not with the JSON it promised", EXIT.failed);
  }

  const candidates = issues
    .filter(issue => Number.isInteger(issue.number) && issue.number > 0)
    .map(issue => {
      const id = intakeTaskId(grant.github, issue.number);
      const title = String(issue.title ?? "");
      const clean = title.length > 0 && title.length <= 180 && !hasDisguisedText(title);
      return {
        id,
        number: issue.number,
        title,
        clean,
        exists: store.getTask(id) !== null,
      };
    });

  if (action === "preview") {
    if (json) {
      write(envelopeJson({ ok: true, command: "intake preview", repo, github: grant.github, label: grant.label, candidates }));
      return EXIT.ok;
    }
    if (candidates.length === 0) {
      write(`Nothing open in ${grant.github} carries "${grant.label}".`);
      return EXIT.ok;
    }
    write(`Would intake from ${grant.github} ("${grant.label}"):`);
    for (const one of candidates) {
      write(`  #${one.number}  ${one.exists ? "already here as" : one.clean ? "→" : "REFUSED (title carries control characters)"} ${one.id}${one.clean ? ` — ${one.title}` : ""}`);
    }
    write(`Nothing was created. \`standing-orders intake run\` makes the proposals.`);
    return EXIT.ok;
  }

  // run: create the missing, clean proposals — local, unapproved, deduped
  // by their deterministic id. The remote is never written.
  const created: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const one of candidates) {
    if (one.exists) continue;
    if (!one.clean) {
      skipped.push({ id: one.id, reason: "title-refused" });
      continue;
    }
    const made = store.transact(() => {
      const filed = fileTaskProposal(
        store,
        {
          id: one.id,
          title: `GH#${one.number}: ${one.title}`,
          repo,
          goal: `Imported from GitHub issue #${one.number} in ${grant.github} (label "${grant.label}"). Only the title was imported — read the issue at https://github.com/${grant.github}/issues/${one.number} for full context, then edit and approve this scope before anything builds.`,
          filedVia: "intake",
        },
        clock(),
      );
      if (!filed.ok) return filed;
      // The mirror row rides the SAME transaction (v3 §4): provenance is
      // this intake grant, immutably — never inferred later from a label.
      const established = store.establishMirror(
        {
          localTaskId: filed.id,
          backend: "github-issues",
          remoteRepo: grant.github,
          remoteId: String(one.number),
          provenance: "intake",
          intakeGrant: grant.id,
          establishedBy: "intake",
        },
        clock(),
      );
      if (!established.ok && established.reason !== "duplicate") {
        throw new Error(`mirror not established: ${established.reason}`);
      }
      return filed;
    });
    if (made.ok) created.push(made.id);
    else skipped.push({ id: one.id, reason: made.reason });
  }
  return succeed(write, json, "intake run", { repo, github: grant.github, label: grant.label, created, skipped }, () => [
    `${created.length} proposal(s) created${skipped.length > 0 ? `, ${skipped.length} skipped` : ""} — each awaits its own scope approval.`,
    ...created.map(one => `  ${one}`),
    ...skipped.map(one => `  skipped ${one.id}: ${one.reason}`),
  ]);
}


/**
 * `standing-orders contest …` — the tournament from the terminal: `show`
 * for the machine-readable state, `exclude` to stop a racing agent whose
 * question you will not answer (authenticated: it cancels paid-for work
 * and un-sticks the race). The pick itself stays a console ceremony.
 */
function contestCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> | number {
  const { store, write, json, clock } = context;
  const [action, idGiven, ordinalGiven] = positional;
  if (action === undefined || !(CONTEST_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "contest", "usage", `unknown \`contest ${action ?? ""}\` — try ${CONTEST_ACTIONS.join(", ")}`, EXIT.usage);
  }
  if (action === "show") {
    const contest = store.getContest(Number(idGiven));
    if (contest === null) return fail(write, json, "contest show", "unknown", "no tournament or comparison with that id", EXIT.refused);
    const agents = store.contestants(contest.id);
    if (json) {
      write(envelopeJson({ ok: true, command: "contest show", contest, agents }));
      return EXIT.ok;
    }
    write(`${contestNoun(contest.kind)} #${contest.id} — ${contest.state}`);
    for (const racer of agents) {
      const money =
        contest.kind === "comparison"
          ? racer.unknownSpend
            ? "spend unmeasured (tokens only)"
            : `$${(racer.measuredMicrousd / 1_000_000).toFixed(2)} measured`
          : `charged $${(racer.accountedMicrousd / 1_000_000).toFixed(2)}${racer.unknownSpend ? " (exact figure unknown — charged the reserved worst case)" : ""}`;
      write(`  agent ${racer.ordinal}: ${racer.provider} · ${racer.model} — ${racer.state} · ${money}`);
    }
    return EXIT.ok;
  }
  if (action === "exclude") {
    return (async () => {
      const contest = store.getContest(Number(idGiven));
      const ordinal = Number(ordinalGiven);
      if (contest === null || !Number.isInteger(ordinal)) {
        return fail(write, json, "contest exclude", "usage", "`standing-orders contest exclude <tournament-id> <agent-number> --as <you> --token <t>`", EXIT.usage);
      }
      const acting = await askCredentials(flags, context);
      if (acting === null) {
        return fail(write, json, "contest exclude", "usage", "stopping a racing agent takes `--as <you> --token <t>`", EXIT.usage);
      }
      const authed = authenticateApprover(store, acting.name, acting.token);
      if (!authed.ok) {
        return fail(write, json, "contest exclude", "unauthenticated", "that is not an approver, or the token does not match", EXIT.refused);
      }
      const racer = store.contestants(contest.id).find(one => one.ordinal === ordinal);
      if (racer === undefined || racer.state !== "parked") {
        return fail(write, json, "contest exclude", "not-waiting", "that agent is not waiting on an answer", EXIT.refused);
      }
      const question = store.openDecisionForContestant(racer.id);
      const moved = store.transact(() => {
        if (question !== null && !store.excludeDecision(question, acting.name, clock())) return false;
        if (!store.casContestantState(racer.id, ["parked"], "stopped", racer.generation)) return false;
        contestMaybeAggregate(store, contest.id, clock());
        return true;
      });
      if (!moved) return fail(write, json, "contest exclude", "changed", "the tournament moved while you were reading — look again", EXIT.refused);
      const after = store.getContest(contest.id);
      return succeed(write, json, "contest exclude", { contest: after }, () => [
        `Agent ${ordinal} stopped; its question is closed as excluded. The tournament is now ${after?.state ?? "?"}.`,
      ]);
    })();
  }
  return fail(write, json, "contest", "usage", "`standing-orders contest show <id> | exclude <id> <agent-number>`", EXIT.usage);
}

/**
 * `standing-orders template …` — the shipped library of common standing
 * orders (adoption track, step 2). A template is a pre-filled form:
 * `apply` PREVIEWS by default and files only under `--file`, through the
 * same one door as every manual filing, landing UNAPPROVED. Recipes
 * (issue-intake, ci-babysitter) display existing ceremonies and cannot be
 * applied — the authority they would need is a separate authenticated act
 * a template must never perform (adoption review, finding 10).
 */
function templateCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json, clock } = context;
  const [action, name] = positional;

  if (action === undefined || action === "list") {
    if (json) {
      write(envelopeJson({
        ok: true,
        command: "template list",
        templates: TEMPLATES.map(one => ({ name: one.name, kind: one.kind, purpose: one.purpose })),
      }));
      return EXIT.ok;
    }
    write("Templates — common standing orders you edit to fit. Nothing a template");
    write("files is approved; recipes only show existing ceremonies.");
    write("");
    for (const one of TEMPLATES) {
      write(`  ${one.name.padEnd(16)} ${one.kind.padEnd(9)} ${one.purpose}`);
    }
    write("");
    write("`standing-orders template show <name>` · `template apply <name> --repo <path>`");
    return EXIT.ok;
  }

  if (action !== "show" && action !== "apply") {
    return fail(write, json, `template ${action}`, "usage", "`standing-orders template list | show <name> | apply <name> --repo <path> [--file]`", EXIT.usage);
  }
  if (name === undefined) {
    return fail(write, json, `template ${action}`, "usage", "which template? `standing-orders template list` names them", EXIT.usage);
  }
  const template = templateByName(name);
  if (template === null) {
    return fail(write, json, `template ${action}`, "unknown", `no template named ${name} — \`standing-orders template list\``, EXIT.refused);
  }

  if (action === "show") {
    if (json) {
      write(envelopeJson({ ok: true, command: "template show", template }));
      return EXIT.ok;
    }
    write(`${template.name} — ${template.purpose}`);
    if (template.kind === "recipe") {
      write("");
      write(`This one is a recipe, not an application: ${template.why}`);
      for (const step of template.steps) {
        write("");
        write(`  ${step.say}`);
        write(`    ${step.run}`);
      }
      return EXIT.ok;
    }
    write("");
    if (template.kind === "task") {
      write(`  files      one task (unapproved until you approve its scope)`);
      write(`  title      ${template.title}`);
    } else {
      write(`  files      one routine (cannot fire until you approve its terms)`);
      write(`  name       ${template.routineName}`);
      write(`  schedule   ${template.schedule}`);
    }
    write(`  goal       ${template.goal}`);
    if (template.outOfScope !== null) write(`  not        ${template.outOfScope}`);
    if (template.touches.length > 0) write(`  touches    ${template.touches.join(", ")}`);
    write("");
    write("You will probably edit:");
    for (const hint of template.edit) write(`  - ${hint}`);
    write("");
    write(`\`standing-orders template apply ${template.name} --repo <path>\` previews the exact filing.`);
    return EXIT.ok;
  }

  // apply
  if (template.kind === "recipe") {
    return fail(
      write,
      json,
      "template apply",
      "recipe",
      `${template.name} cannot be applied: ${template.why} \`standing-orders template show ${template.name}\` walks the ceremonies.`,
      EXIT.refused,
    );
  }
  const repoGiven = text(flags, "repo");
  if (repoGiven === undefined) {
    return fail(write, json, "template apply", "usage", "which repository? --repo <path> — a template never guesses where work lands", EXIT.usage);
  }
  const goal = text(flags, "goal") ?? template.goal;
  const outOfScope = text(flags, "not") ?? template.outOfScope;
  const touches =
    text(flags, "touches") === undefined
      ? template.touches
      : (text(flags, "touches") ?? "").split(",").map(one => one.trim()).filter(one => one !== "");

  if (template.kind === "task") {
    const title = text(flags, "title") ?? template.title;
    const draft = {
      kind: "task" as const,
      title,
      repo: canonicalProject(repoGiven) ?? resolve(repoGiven),
      goal,
      outOfScope,
      touches,
      filedVia: `template:${template.name}`,
    };
    if (!flags.has("file")) {
      if (json) {
        write(envelopeJson({ ok: false, command: "template apply", reason: "unconfirmed", draft }));
        return 3;
      }
      write("Would file, exactly (edit with --title/--goal/--not/--touches):");
      write("");
      write(`  task    ${draft.title}`);
      write(`  repo    ${draft.repo}`);
      write(`  goal    ${draft.goal}`);
      if (draft.outOfScope !== null) write(`  not     ${draft.outOfScope}`);
      if (draft.touches.length > 0) write(`  touches ${draft.touches.join(", ")}`);
      write("");
      write("Nothing was filed. Re-run with --file to file it — UNAPPROVED either way.");
      return 3;
    }
    const made = fileTaskProposal(
      store,
      { title, repo: repoGiven, goal, outOfScope, touches, filedVia: `template:${template.name}` },
      clock(),
    );
    if (!made.ok) return fail(write, json, "template apply", made.reason, made.message, made.reason === "duplicate" ? EXIT.refused : EXIT.usage);
    const filedLink = consoleLinkFor(context, `/t/${encodeURIComponent(made.id)}`);
    return succeed(
      write,
      json,
      "template apply",
      { filed: "task", id: made.id, approved: false, ...(filedLink === null ? {} : { links: { task: filedLink } }) },
      () => [
        `Filed ${made.id} from template ${template.name}.`,
        "",
        "UNAPPROVED — NO AUTHORITY GRANTED. It builds only after you approve its scope:",
        `  standing-orders task show ${made.id}`,
        ...(filedLink === null ? [] : [`  ${filedLink}`]),
      ],
    );
  }

  const routineName = text(flags, "name") ?? template.routineName;
  const schedule = text(flags, "schedule") ?? template.schedule;
  const ceilingGiven = text(flags, "ceiling");
  const costCeilingUsd = ceilingGiven === undefined ? template.costCeilingUsd : Number(ceilingGiven);
  if (!flags.has("file")) {
    const draft = {
      kind: "routine" as const,
      name: routineName,
      repo: canonicalProject(repoGiven) ?? resolve(repoGiven),
      goal,
      outOfScope,
      touches,
      requirements: template.requirements,
      schedule,
      costCeilingUsd,
      filedVia: `template:${template.name}`,
    };
    if (json) {
      write(envelopeJson({ ok: false, command: "template apply", reason: "unconfirmed", draft }));
      return 3;
    }
    write("Would file, exactly (edit with --name/--goal/--not/--touches/--schedule/--ceiling):");
    write("");
    write(`  routine  ${draft.name}`);
    write(`  repo     ${draft.repo}`);
    write(`  schedule ${draft.schedule}${draft.schedule.startsWith("every:10080") ? "  (weekly)" : ""}`);
    write(`  goal     ${draft.goal}`);
    if (draft.outOfScope !== null) write(`  not      ${draft.outOfScope}`);
    if (draft.touches.length > 0) write(`  touches  ${draft.touches.join(", ")}`);
    if (draft.costCeilingUsd !== null) write(`  ceiling  $${draft.costCeilingUsd}/week`);
    write("");
    write("Nothing was filed. Re-run with --file to file it — UNAPPROVED either way; it cannot fire until you approve it.");
    return 3;
  }
  const made = fileRoutineProposal(
    store,
    {
      name: routineName,
      repo: repoGiven,
      goal,
      outOfScope,
      touches,
      requirements: template.requirements,
      schedule,
      costCeilingUsd,
      filedVia: `template:${template.name}`,
    },
    clock(),
  );
  if (!made.ok) return fail(write, json, "template apply", made.reason, made.message, made.reason === "duplicate" ? EXIT.refused : EXIT.usage);
  return succeed(write, json, "template apply", { filed: "routine", id: made.id, approved: false }, () => [
    `Filed routine ${routineName} from template ${template.name}.`,
    "",
    "UNAPPROVED — NO AUTHORITY GRANTED. It cannot fire until you approve the standing order:",
    `  standing-orders routine approve ${routineName}`,
  ]);
}

/**
 * `standing-orders routine …` — standing orders. Filing one is cheap; the
 * expensive act is the approval, which restates every term including "each
 * firing builds without asking" and takes the approver's credential, same
 * as a scope. Pausing needs no ceremony because stopping spend never does.
 */
async function routineCommand(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const [action, name] = positional;
  if (action !== undefined && !(ROUTINE_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "routine", "usage", `unknown \`routine ${action}\` — try ${ROUTINE_ACTIONS.join(", ")}`, EXIT.usage);
  }

  if (action === undefined || action === "list") {
    const repoFilter = text(flags, "repo");
    const routines = store.listRoutines(
      repoFilter === undefined ? null : canonicalProject(repoFilter) ?? resolve(repoFilter),
    );
    if (json) {
      write(envelopeJson({ ok: true, command: "routine list", routines }));
      return EXIT.ok;
    }
    if (routines.length === 0) {
      write("No standing orders. `standing-orders routine add <name> --repo <path> --goal <text> --schedule every:60` files one.");
      return EXIT.ok;
    }
    for (const routine of routines) {
      const approved = routine.approvedAt !== null && routine.approvedDigest === routine.digest;
      const status = routine.paused ? "paused" : approved ? "live" : "awaiting approval";
      write(`  ${routine.name.padEnd(20)} ${status.padEnd(18)} ${routine.schedule.padEnd(14)} ${routine.repo}`);
    }
    return EXIT.ok;
  }

  if (action === "add") {
    if (name === undefined || !ROUTINE_NAME.test(name)) {
      return fail(write, json, "routine add", "usage", "a routine's name is lowercase letters, digits, and dashes — it becomes each instance's id", EXIT.usage);
    }
    const repoGiven = text(flags, "repo");
    const goal = text(flags, "goal");
    const schedule = text(flags, "schedule");
    if (repoGiven === undefined || goal === undefined || schedule === undefined) {
      return fail(write, json, "routine add", "usage", "`standing-orders routine add <name> --repo <path> --goal <text> --schedule every:<min>|daily:<HH:MM> [--not <text>] [--touches a,b] [--require kind:name,…] [--ceiling <usd>] [--budget-usd <n>]`", EXIT.usage);
    }
    const ceilingGiven = text(flags, "ceiling");
    // --budget-usd on a routine caps EACH instance (v16): it becomes the
    // instance scope's digest-bound budget term, enforced by the same
    // native-cap plumbing as any other scope budget.
    const perRunGiven = text(flags, "budget-usd");
    if (perRunGiven !== undefined && (!Number.isFinite(Number(perRunGiven)) || Number(perRunGiven) <= 0)) {
      return fail(write, json, "routine add", "bad-budget", "--budget-usd is a positive dollar amount — what each firing may spend", EXIT.usage);
    }
    // One filing door for every surface (Codex adoption review, finding 7):
    // validation, canonicalization, digest, and provenance live in the
    // service, not here.
    const created = fileRoutineProposal(
      store,
      {
        name,
        repo: repoGiven,
        goal,
        outOfScope: text(flags, "not") ?? null,
        touches: (text(flags, "touches") ?? "").split(",").map(one => one.trim()).filter(one => one !== ""),
        requirements: (text(flags, "require") ?? "").split(",").map(one => one.trim()).filter(one => one !== ""),
        schedule,
        costCeilingUsd: ceilingGiven === undefined ? null : Number(ceilingGiven),
        ...(perRunGiven === undefined ? {} : { budgetPerRunMicrousd: Math.round(Number(perRunGiven) * 1_000_000) }),
        filedVia: "cli",
      },
      clock(),
    );
    if (!created.ok) {
      return fail(write, json, "routine add", created.reason, created.message, created.reason === "duplicate" ? EXIT.refused : EXIT.usage);
    }
    const routine = store.getRoutine(created.id);
    return succeed(write, json, "routine add", { routine }, () => [
      `Filed ${name}. Nothing fires until somebody approves the standing order:`,
      ...(routine === null ? [] : describeRoutine(routine)),
      "",
      `  standing-orders routine approve ${name}`,
    ]);
  }

  if (name === undefined) {
    return fail(write, json, `routine ${action}`, "usage", "which routine? give its name", EXIT.usage);
  }
  const routine = store.routineByName(name);
  if (routine === null) {
    return fail(write, json, `routine ${action}`, "unknown", `no routine named ${name}`, EXIT.refused);
  }

  switch (action) {
    case "show": {
      const fires = store.routineFires(routine.id, 14);
      if (json) {
        write(envelopeJson({ ok: true, command: "routine show", routine, fires }));
        return EXIT.ok;
      }
      const approved = routine.approvedAt !== null && routine.approvedDigest === routine.digest;
      write(`${routine.name} — ${routine.paused ? "paused" : approved ? "live" : "awaiting approval"}`);
      for (const line of describeRoutine(routine)) write(line);
      if (routine.nextFireAt !== null && !routine.paused && approved) write(`  next fire    ${routine.nextFireAt}`);
      if (fires.length > 0) {
        write("");
        write("  recent firings, newest first:");
        for (const fire of fires) {
          const said =
            fire.outcome === "fired"
              ? `${fire.instanceTaskId ?? "instance"}${fire.instanceState === null ? "" : ` (${fire.instanceState})`}${fire.reason === "manual" ? "  (run now)" : ""}`
              : `skipped — ${fire.reason ?? ""}`;
          write(`    ${fire.scheduledFor.replace(/^manual:/, "")}  ${said}`);
        }
      }
      return EXIT.ok;
    }
    case "approve": {
      let saw = text(flags, "digest");
      let asWho = text(flags, "as");
      let token = text(flags, "token");
      let confirmedAloud = false;
      if ((!flags.has("yes") || saw === undefined || asWho === undefined || token === undefined) && interactive() && !json) {
        write(`Approving ${name} makes it a STANDING order:`);
        write("");
        for (const line of describeRoutine(routine)) write(line);
        write("");
        const agreed = await confirm("Approve exactly this standing order?");
        if (!agreed) {
          write("Nothing approved.");
          return EXIT.refused;
        }
        saw ??= routine.digest;
        const acting = await askCredentials(flags, context);
        if (acting === null) return fail(write, json, "routine approve", "usage", "approval needs who is agreeing", EXIT.usage);
        asWho = acting.name;
        token = acting.token;
        confirmedAloud = true;
      }
      const armed = (flags.has("yes") || confirmedAloud) && saw !== undefined && asWho !== undefined && token !== undefined;
      if (!armed) {
        if (json) {
          write(envelopeJson({ ok: false, command: "routine approve", reason: "unconfirmed", routine }));
          return EXIT.refused;
        }
        write(`Would approve this standing order — every firing of it builds without asking:`);
        write("");
        for (const line of describeRoutine(routine)) write(line);
        write("");
        write("Nothing has been approved. Agree to exactly this with:");
        write(`  standing-orders routine approve ${name} --yes --digest ${routine.digest} --as <you> --token <your password>`);
        // A preview reached by omitting --yes is the answer "no, not yet" —
        // exit 3 in both modes, matching the JSON path (round-4 finding 10).
        return EXIT.refused;
      }
      const approved = approveRoutine(store, routine.id, asWho as string, clock(), saw as string, token as string);
      if (!approved.ok) {
        return fail(write, json, "routine approve", approved.reason, describeApproveFailure(approved.reason, name), EXIT.refused);
      }
      return succeed(write, json, "routine approve", { routine: approved.routine }, () => [
        `Approved. ${name} fires on its schedule from now on; first at ${approved.routine.nextFireAt}.`,
        `Pause it any time: standing-orders routine pause ${name}`,
      ]);
    }
    case "pause":
    case "resume": {
      store.setRoutinePaused(routine.id, action === "pause", clock());
      return succeed(write, json, `routine ${action}`, { name }, () => [
        action === "pause"
          ? `${name} is paused — no firing until you resume it. Already-running instances finish.`
          : `${name} resumed — the next due slot fires again.`,
      ]);
    }
    case "run-now": {
      const acting = await askCredentials(flags, context);
      if (acting === null) {
        return fail(write, json, "routine run-now", "usage", "run-now takes `--as <you> --token <t>` — it dispatches work that spends", EXIT.usage);
      }
      const authenticated = authenticateApprover(store, acting.name, acting.token);
      if (!authenticated.ok) {
        return fail(write, json, "routine run-now", authenticated.reason, describeApproveFailure(authenticated.reason, name), EXIT.refused);
      }
      const outcome = fireRoutine(store, routine.id, clock(), { manual: true });
      if (!outcome.ok) {
        return fail(write, json, "routine run-now", outcome.reason, outcome.detail ?? outcome.reason, EXIT.refused);
      }
      return succeed(write, json, "routine run-now", { taskId: outcome.taskId }, () => [
        `Spawned ${outcome.taskId} — it builds on the next pass. The regular schedule is untouched.`,
      ]);
    }
    default:
      return fail(write, json, "routine", "usage", "`standing-orders routine [add|list|show|approve|pause|resume|run-now]`", EXIT.usage);
  }
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
 * `standing-orders daemon install|status|uninstall|logs` — the loop as a
 * service, no crontab. Writes the platform's own supervision unit (launchd
 * on macOS, systemd --user on Linux) pointed at `standing-orders watch`, with
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
  const demoFence = refuseDemo(context, "daemon");
  if (demoFence !== null) return demoFence;
  const [action = "status"] = positional;
  const repo = repoFrom(flags);
  const configDir = dirname(context.telegramTokenFile);
  const supervise: SupervisorRunner = context.gitRunner ?? run;

  const binFlag = text(flags, "bin");
  const resolveBin = async (): Promise<{ bin: string; binArgs: string[] } | null> => {
    if (binFlag !== undefined) return { bin: binFlag, binArgs: [] };
    const found = await supervise("sh", ["-lc", "command -v standing-orders"]);
    if (found.code === 0 && found.stdout.trim() !== "") {
      return { bin: found.stdout.trim(), binArgs: [] };
    }
    return null;
  };

  if (action === "install") {
    const runnerName = text(flags, "runner");
    const token = text(flags, "token");
    if (runnerName === undefined || token === undefined) {
      return fail(write, json, "daemon install", "usage", "`standing-orders daemon install --runner <name> --token <t> --repo <path>` (plus any watch flags to bake in)", EXIT.usage);
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
        "`standing-orders` is not on the PATH the service would use — run `standing-orders link` first, or pass --bin <absolute path>",
        EXIT.refused,
      );
    }

    const watchFlags: string[] = [];
    for (const name of ["pool", "model", "repair-model", "provider", "plan-model", "plan-provider", "max", "turns", "tick-every", "bridge-every", "reconcile-every", "max-open-decisions"]) {
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
        write(envelopeJson({ ok: true, command: "daemon install", dryRun: true, plan }));
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
      "incarnation recovery makes those restarts safe. `standing-orders daemon",
      "status` to check on it, `daemon uninstall` to take it back off.",
    ]);
  }

  // status / uninstall / logs share the computed plan; the bin is cosmetic there.
  const plan = planDaemon({
    platform: process.platform,
    bin: binFlag ?? "standing-orders",
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
      write(envelopeJson({ ok: true, command: "daemon status", ...state, label: plan.label, logs: plan.logPath }));
      return state.state === "running" ? EXIT.ok : EXIT.refused;
    }
    write(`${plan.label}: ${state.detail}`);
    write(`  logs  ${plan.logPath}`);
    if (state.state === "not-installed") write("  → standing-orders daemon install --runner <name> --token <t> --repo <path>");
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

  return fail(write, json, "daemon", "usage", "`standing-orders daemon [install|status|uninstall|logs]`", EXIT.usage);
}

// ---- the watch loop --------------------------------------------------------

const WATCH_LEASE_MS = 90_000;
const WATCH_HEARTBEAT_MS = 30_000;

/**
 * `standing-orders watch` — the loop (§5, §6): the cron chain as one
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
 * then the lease is handed back. A second signal, or the grace clock
 * (--stop-grace, default 30s), SIGKILLs every live provider's process
 * group (M6.12): runs finalize as failures, worktrees are preserved, and
 * fences keep late output out of every commit.
 */
/**
 * The extracted watch loop (arc 2 finding 5/20): NON-EMITTING — every line
 * goes through `args.progress`, every stop decision through the caller's
 * fences, and the answer is a typed result, never an envelope. watchCommand
 * wraps it with its historical signals and output; `up` supervises several
 * of them beside a console. The lease and heartbeat ride the CREDENTIALED
 * doors (findings 15/25): after a takeover rotates this runner's token,
 * acquisition refuses and the very next renewal is FATAL — a loop that has
 * lost its lease or its credential stops admitting work immediately.
 */
type WatchLoopResult =
  | { ok: true; ticks: number; built: number; broke: number; incarnation: string }
  | { ok: false; reason: "watch-busy" | "lease-lost"; detail: string; ticks: number; built: number; broke: number };

async function runWatchLoop(args: {
  flags: Map<string, string | true>;
  context: Context;
  runner: string;
  token: string;
  repo: string;
  progress: (line: string) => void;
  /** The caller's admission fence — true stops the loop at the next gate. */
  isStopping: () => boolean;
  /** Hands the caller the follower's controller so its stop can abort the long poll. */
  onFollowController?: (controller: AbortController) => void;
  /** Resolves the caller's readiness: fired after the lease is held. */
  onReady?: () => void;
}): Promise<WatchLoopResult> {
  const { context, flags, runner, token, repo, progress } = args;
  const { store } = context;

  const tickEveryMs = Number(text(flags, "tick-every") ?? 60_000);
  const bridgeEveryMs = Number(text(flags, "bridge-every") ?? 45_000);
  const reconcileEveryMs = Number(text(flags, "reconcile-every") ?? 5 * 60_000);
  const runFor = text(flags, "for") === undefined ? null : Number(text(flags, "for"));

  const incarnation = randomUUID();
  const lease = acquireWatchLeaseAuthed(
    store,
    { runner, token, repo, owner: incarnation, ttlMs: WATCH_LEASE_MS },
    new Date(),
  );
  if (!lease.ok) {
    return {
      ok: false,
      reason: "watch-busy",
      detail:
        lease.reason === "watch-busy"
          ? `another watch holds ${runner} on ${repo} until ${lease.until} — one watch per runner and repo; cron ticks may coexist, watches may not`
          : describeAuth(lease.reason, runner),
      ticks: 0,
      built: 0,
      broke: 0,
    };
  }
  if (lease.superseded !== null && lease.recovered > 0) {
    progress(`Recovered ${lease.recovered} claim(s) from the previous watch (${lease.superseded.slice(0, 8)}…) before dispatching anything.`);
  }

  // The night is a row, not "the last 24 hours": everything this watch does
  // attributes to this episode by runner and window, and `brief
  // --latest-watch` bounds itself to exactly it.
  store.startWatchEpisode({ repo, runner, incarnation }, new Date());
  args.onReady?.();

  // A false renewal is FATAL (arc 2 finding 15): the lease or the
  // credential is gone, and admitting one more pass would be work done for
  // an authority this process no longer holds.
  let leaseLost = false;
  const followController = new AbortController();
  args.onFollowController?.(followController);
  const stopping = (): boolean => args.isStopping() || leaseLost;

  const heartbeat = setInterval(() => {
    const renewed = heartbeatWatchLeaseAuthed(
      store,
      { runner, token, repo, owner: incarnation, ttlMs: WATCH_LEASE_MS },
      new Date(),
    );
    if (!renewed && !leaseLost) {
      leaseLost = true;
      followController.abort();
      progress(`watch: the lease or credential for ${runner} on ${repo} was taken — stopping without admitting more work`);
    }
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
    const followerPrimary = effectivePrimary(process.env, dirname(context.databaseFile), true);
    follower = followBridge(store, {
      ...(followerPrimary.channel === "telegram" ? {} : { deliver: false }),
      botId: followSource.botId,
      transport,
      signal: followController.signal,
      onCycle: cycle => {
        // progress(), not write(): under --json this line went to stdout
        // BESIDE the final envelope — the one stdout contamination in the
        // watch (round-4 finding 12).
        progress(
          `watch: bridge sent ${cycle.sent}, answered ${cycle.answered}, paired ${cycle.paired}` +
            (cycle.problems.length > 0 ? ` — ${cycle.problems.length} problem(s)` : ""),
        );
      },
    }).catch(error => {
      progress(`watch: the telegram follower died — ${describe(error)}; taps wait for the next watch`);
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
  const quietContext: Context = { ...context, write: sink, json: true, shouldStop: stopping };


  const startedAt = Date.now();
  const deadline = runFor === null ? null : startedAt + runFor;
  let lastTick = 0;
  let lastBridge = 0;
  let lastReconcile = 0;
  let lastPush = 0;
  let ticks = 0;
  let built = 0;
  let brokeCount = 0;

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    while (!stopping() && (deadline === null || Date.now() < deadline)) {
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
          if (checks.failing > 0) progress(`watch: CI is red on ${checks.failing} published PR(s) — the outbox has it`);
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
          progress(`watch: pass ${ticks} did work (${new Date().toISOString()})`);
        } else if (code === EXIT.failed) {
          tickDidWork = true;
          brokeCount++;
          progress(`watch: pass ${ticks} broke something — the run records have it`);
        }
      }

      // Built work goes out in the same window it was built: the pass is one
      // SELECT when nothing is owed, and each phase is durable if we crash.
      // Except under a stop (audit IV-1): once the signal lands, nothing
      // more is published this incarnation — the durable intent keeps the
      // work safe for the successor.
      if (!stopping() && store.pendingPublications().length > 0) {
        const published = await publishPass(store, {
          repo,
          ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
        });
        if (published.pushed + published.opened + published.adopted + published.failed > 0) {
          progress(
            `watch: published — pushed ${published.pushed}, opened ${published.opened}, adopted ${published.adopted}` +
              (published.failed > 0 ? `, gave up on ${published.failed}` : ""),
          );
        }
      }

      // Push rides its OWN cadence, whether or not Telegram holds the wire
      // (arc 3 finding 8): the pair ledger's claims fence concurrent loops.
      if (now - lastPush >= 45_000) {
        lastPush = now;
        try {
          await pushPass(context.store, { configDir: dirname(context.databaseFile), clock: () => new Date() });
        } catch {
          // Push is additive; a broken pass never stops the watch.
        }
      }

      // The embedded follower owns the wire while it lives; the timer-driven
      // pass is the fallback shape for a watch started before a token existed.
      if (follower === null && now - lastBridge >= bridgeEveryMs) {
        lastBridge = now;
        const source = loadBotToken(process.env, context.telegramTokenFile);
        const dir = dirname(context.databaseFile);
        // Exactly ONE service carries the pages — the chosen primary, or
        // the sensible implicit one. Telegram keeps draining taps and
        // replies even when another service is primary: answering is its
        // job whether or not paging is.
        const primary = effectivePrimary(process.env, dir, source !== null);
        if (source !== null) {
          quiet.length = 0;
          await bridgeCommand(
            ["telegram"],
            passFlags(primary.channel === "telegram" ? {} : { "inbound-only": "1" }),
            quietContext,
          );
        }
        if (primary.channel !== null && primary.channel !== "telegram") {
          const targets = loadWebhookTargets(process.env, dir).filter(one => one.kind === primary.channel);
          if (targets.length > 0) {
            await webhookPass(store, { targets, consoleUrl: loadConsoleUrl(process.env, dir), clock: context.clock });
          }
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
      while (!stopping() && Date.now() < dozeUntil && store.wakeSeq() === seqIdle) {
        await sleep(50);
      }
    }
  } finally {
    clearInterval(heartbeat);
    followController.abort();
    if (follower !== null) await follower;
    store.endWatchEpisode(incarnation, { ticks, built, broke: brokeCount }, new Date());
    store.releaseWatchLease(runner, repo, incarnation, new Date());
  }

  if (leaseLost) {
    return { ok: false, reason: "lease-lost", detail: `the watch lease for ${runner} on ${repo} stopped renewing — another process may have taken this worker over`, ticks, built, broke: brokeCount };
  }
  return { ok: true, ticks, built, broke: brokeCount, incarnation };
}

async function watchCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const demoFence = refuseDemo(context, "watch");
  if (demoFence !== null) return demoFence;
  const runner = text(flags, "runner");
  const token = text(flags, "token") ?? readTokenFile(text(flags, "token-file"));
  if (runner === undefined || token === undefined) {
    return fail(write, json, "watch", "usage", "`standing-orders watch --runner <name> --token <t>|--token-file <path> --repo <path> [--for <ms>]`", EXIT.usage);
  }
  // Passes built from these flags authenticate with the resolved token.
  flags.set("token", token);
  const auth = authenticate(store, runner, token);
  if (!auth.ok) {
    return fail(write, json, "watch", auth.reason, describeAuth(auth.reason, runner), EXIT.refused);
  }
  const repo = repoFrom(flags);

  // The envelope contract holds for long commands too (Codex M5-M8 audit,
  // C-1): in --json mode every progress line goes to stderr, and stdout
  // receives exactly the final envelope.
  const progress = (line: string): void => {
    if (json) process.stderr.write(`${line}\n`);
    else write(line);
  };

  // The historical signal shell, wrapped around the extracted loop: first
  // signal stops admission and starts the grace clock; the second — or the
  // clock — SIGKILLs every live provider group (M6.12).
  let stopping = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let followAbort: AbortController | null = null;
  const stopGraceMs = Number(text(flags, "stop-grace") ?? 30_000);
  const hardStop = () => {
    const terminated = terminateLiveProviders();
    if (terminated > 0) {
      progress(`Hard stop: ${terminated} provider process group(s) terminated. Their runs finalize as failures; worktrees are preserved; fences keep late output out of every commit.`);
    }
  };
  const stop = () => {
    if (stopping) {
      hardStop();
      return;
    }
    stopping = true;
    followAbort?.abort();
    graceTimer = setTimeout(hardStop, stopGraceMs);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const startedAt = Date.now();
  let result: WatchLoopResult;
  try {
    result = await runWatchLoop({
      flags,
      context,
      runner,
      token,
      repo,
      progress,
      isStopping: () => stopping,
      onFollowController: controller => {
        followAbort = controller;
      },
    });
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }

  if (!result.ok) {
    return fail(write, json, "watch", result.reason, result.detail, EXIT.refused, {
      ticks: result.ticks,
      built: result.built,
      broke: result.broke,
    });
  }
  return succeed(write, json, "watch", { ticks: result.ticks, built: result.built, broke: result.broke, incarnation: result.incarnation }, () => [
    `Watched ${repo} for ${Math.round((Date.now() - startedAt) / 1000)}s: ${result.ticks} pass(es), ${result.built} with work, ${result.broke} broke.`,
    "The lease is handed back; cron or the next watch may take it.",
  ]);
}

// ---- one command to a working cockpit (arc 2) ------------------------------

/**
 * `standing-orders up` — cold start to an open, working cockpit.
 *
 * COMPOSITION ONLY: identities mint through the atomic doors (a first
 * approver only while none exists; a runner only while its name is idle),
 * then the extracted console and one watch loop per repository run in this
 * one process, under one supervisor, over one shared store. Nothing here
 * loosens a ceremony: approval, budgets, publication, and every fence work
 * exactly as they do for the long-hand verbs.
 */
const UP_LOGIN_FILE = "up-login.txt";

/** Durably create the login file BEFORE the bootstrap commits (arc 2
 * finding 27): exclusive, 0600, fsynced — file and directory both — so the
 * row only ever follows a durable secret. Throws on any failure. */
function writeLoginFileDurably(path: string, name: string, password: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeSync(fd, `${name} ${password}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(dirname(path), fsConstants.O_RDONLY);
  try {
    fsyncSync(dir);
  } catch {
    // Some filesystems refuse directory fsync; the file's own fsync stands.
  } finally {
    closeSync(dir);
  }
}

function readLoginFile(path: string): { name: string; password: string } | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const cut = raw.indexOf(" ");
    if (cut <= 0) return null;
    const name = raw.slice(0, cut);
    const password = raw.slice(cut + 1);
    if (name === "" || password === "") return null;
    return { name, password };
  } catch {
    return null;
  }
}

type UpApprover = {
  approver: string | null;
  approvers: string[];
  verified: boolean;
  passwordFile: string | null;
  /** The password to print once — set ONLY when this run minted it. */
  mintedPassword: string | null;
  notes: string[];
};

/** The approver decision tree (arc 2 findings 8/21/29/32), exhaustively. */
async function resolveUpApprover(
  context: Context,
  flags: Map<string, string | true>,
  canPrompt: boolean,
): Promise<UpApprover | { refusal: string }> {
  const { store, clock } = context;
  const loginFile = join(dirname(context.databaseFile), UP_LOGIN_FILE);
  const asFlag = text(flags, "as");
  const notes: string[] = [];

  let names = store.listApprovers().map(one => one.name);
  if (names.length === 0) {
    // Adoption first (finding 27/32): an orphan file from a crashed
    // bootstrap is a valid intent — and never OURS to unlink.
    const orphan = readLoginFile(loginFile);
    if (orphan !== null) {
      const adopted = store.bootstrapApproverIfNone(orphan.name, hashApproverToken(orphan.password), clock());
      if (adopted.ok) {
        notes.push(`adopted the login from ${UP_LOGIN_FILE} — a previous start was interrupted before it finished`);
        return { approver: orphan.name, approvers: [orphan.name], verified: true, passwordFile: loginFile, mintedPassword: null, notes };
      }
      names = store.listApprovers().map(one => one.name); // a winner appeared; fall through
    } else {
      // Mint: the FILE is the durable intent, written and fsynced before
      // the insert (finding 27). A refused insert unlinks only when an
      // UNRELATED approver won (finding 32).
      const name = asFlag ?? process.env["USER"] ?? process.env["USERNAME"] ?? "operator";
      const password = randomBytes(12).toString("base64url");
      try {
        writeLoginFileDurably(loginFile, name, password);
      } catch (error) {
        return {
          refusal: `could not create ${UP_LOGIN_FILE} beside the database (${describe(error)}) — if a file is already there, another \`up\` may be starting; wait a moment, your login will be in it`,
        };
      }
      const made = store.bootstrapApproverIfNone(name, hashApproverToken(password), clock());
      if (made.ok) {
        return { approver: name, approvers: [name], verified: true, passwordFile: loginFile, mintedPassword: password, notes };
      }
      // Lost the race. Keep the file if the winner IS our identity (an
      // adopter beat us to our own file); otherwise it is ours to remove.
      if (authenticateApprover(store, name, password).ok) {
        return { approver: name, approvers: store.listApprovers().map(one => one.name), verified: true, passwordFile: loginFile, mintedPassword: null, notes };
      }
      try {
        unlinkSync(loginFile);
      } catch {
        // already gone
      }
      names = store.listApprovers().map(one => one.name);
    }
  }

  // Approvers exist. The stale-or-current file is advertised only when it
  // still authenticates (finding 32).
  let fileLogin: { name: string; password: string } | null = null;
  const present = readLoginFile(loginFile);
  if (present !== null) {
    if (authenticateApprover(store, present.name, present.password).ok) {
      fileLogin = present;
    } else {
      notes.push(`${UP_LOGIN_FILE} no longer matches any login — it is stale; your current password is the one you know`);
    }
  }

  let selected: string | null = null;
  if (asFlag !== undefined) {
    if (!names.includes(asFlag)) {
      return { refusal: `no approver named \`${asFlag}\` — known: ${names.join(", ")}` };
    }
    selected = asFlag;
  } else if (names.length === 1) {
    selected = names[0] as string;
  }

  let verified = false;
  let passwordFile: string | null = null;
  if (selected !== null && fileLogin !== null && fileLogin.name === selected) {
    verified = true;
    passwordFile = loginFile;
  } else if (selected !== null && canPrompt) {
    const { askHidden } = await import("./prompt.js");
    for (let attempt = 1; attempt <= 3 && !verified; attempt += 1) {
      const typed = await askHidden(`password for ${selected} (${attempt}/3): `);
      if (typed !== "" && authenticateApprover(store, selected, typed).ok) verified = true;
    }
    if (!verified) {
      notes.push(
        `could not verify ${selected}'s password — the console will still ask at login. If it is lost: another approver can add you (\`approver add\`), or restore the database/${UP_LOGIN_FILE}.`,
      );
    }
  }
  return { approver: selected, approvers: names, verified, passwordFile, mintedPassword: null, notes };
}

/** The platform browser opener — detached, silent, never load-bearing. */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    const child = spawnChild(command[0] as string, command.slice(1), { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // A browser that will not open is a URL the greeting already printed.
  }
}

async function upCommand(
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json, clock } = context;
  const demoFence = refuseDemo(context, "up");
  if (demoFence !== null) return demoFence;

  // 1. Validation, before anything at all.
  const portGiven = text(flags, "port");
  const port = Number(portGiven ?? 4180);
  if (portGiven !== undefined && (!Number.isInteger(port) || port < 1 || port >= 65536)) {
    return fail(write, json, "up", "usage", "--port is a whole number under 65536", EXIT.usage);
  }
  const editorGiven = text(flags, "editor");
  if (editorGiven !== undefined && editorGiven !== "vscode") {
    return fail(write, json, "up", "usage", "--editor supports: vscode", EXIT.usage);
  }
  const forGiven = text(flags, "for");
  if (forGiven !== undefined && (!Number.isInteger(Number(forGiven)) || Number(forGiven) <= 0)) {
    return fail(write, json, "up", "usage", "--for takes a positive whole number of milliseconds", EXIT.usage);
  }
  const runnerFlag = text(flags, "runner");
  if (runnerFlag !== undefined && !validRunnerName(runnerFlag)) {
    return fail(write, json, "up", "usage", `a worker name is 1–${RUNNER_NAME_MAX} characters with no control characters`, EXIT.usage);
  }

  const progress = (line: string): void => {
    if (json) process.stderr.write(`${line}\n`);
    else write(line);
  };

  // 2. Canonical repository roots (finding 10): the git top-level, then the
  // real path, deduplicated — printed before any side effect.
  const inputs = context.repoList !== undefined && context.repoList.length > 0 ? context.repoList : [process.cwd()];
  let sweptHeldOrphans = false;
  const gitRun = context.gitRunner ?? ((file: string, args: readonly string[], opts?: { cwd?: string }) => run(file, [...args], { ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }), timeoutMs: 10_000 }));
  const repos: string[] = [];
  for (const input of inputs) {
    const top = await gitRun("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(input) });
    if (top.code !== 0) {
      return fail(
        write,
        json,
        "up",
        "not-a-repository",
        `${input} is not inside a git repository — name one with \`--repo <path>\`, or try the sandbox first: \`standing-orders demo\``,
        EXIT.refused,
      );
    }
    let root: string;
    try {
      root = realpathSync(top.stdout.trim());
    } catch {
      return fail(write, json, "up", "not-a-repository", `${input} could not be resolved to a real path`, EXIT.refused);
    }
    if (!repos.includes(root)) repos.push(root);
  }
  for (const repo of repos) progress(`repository  ${repo}`);

  // 3. Reserve the port BEFORE any identity or enrollment mutation
  // (finding 7/19): a busy port must refuse while the world is untouched.
  const probe = createNetServer();
  const reserved = await new Promise<boolean>(resolveProbe => {
    probe.once("error", () => resolveProbe(false));
    probe.listen(port, "127.0.0.1", () => resolveProbe(true));
  });
  if (!reserved) {
    return fail(
      write,
      json,
      "up",
      "port-busy",
      `port ${port} is taken — another \`up\` or \`serve\` may already be running; stop it, or pick a different --port`,
      EXIT.refused,
    );
  }

  const canPrompt = !json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  let runnerName = "";
  let runnerToken = "";
  let approver: UpApprover | null = null;
  try {
    // 4. The approver (findings 2/8/17/21/27/29/32).
    const approverPlan = await resolveUpApprover(context, flags, canPrompt);
    if ("refusal" in approverPlan) {
      return fail(write, json, "up", "login", approverPlan.refusal, EXIT.refused);
    }
    approver = approverPlan;
    for (const note of approverPlan.notes) progress(note);

    // 5. The runner, through the atomic door (findings 1/16/26/31), with
    // the suffix budget (finding 24) for generated names only.
    const base = runnerFlag ?? normalizeRunnerName(hostname());
    let doorAnswer: ReturnType<typeof registerRunnerIfIdle> | null = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const name = attempt === 1 ? base : `${base.slice(0, RUNNER_NAME_MAX - suffix.length)}${suffix}`;
      // The held orphan fence runs BEFORE any recovery road (v6 W6): a
      // crashed predecessor's held session is seized, killed through its
      // supervisor, and settled — or paged — before registration's
      // recovery may touch its run or worktree.
      if (!sweptHeldOrphans) {
        sweptHeldOrphans = true;
        const swept = await sweepHeldOrphans(store, `up:${hostname()}:${process.pid}`, clock);
        if (swept.fenced > 0) progress(`fenced ${swept.fenced} orphaned held session(s) from a previous up`);
        if (swept.paged > 0) progress(`${swept.paged} held session(s) could not be stopped — see the inbox`);
      }
      const answer = registerRunnerIfIdle(store, { name, host: hostname(), now: clock() });
      if (answer.ok) {
        runnerName = name;
        runnerToken = answer.token;
        if (answer.recoveredRuns > 0) progress(`recovered ${answer.recoveredRuns} interrupted attempt(s) left by the previous ${name}`);
        doorAnswer = answer;
        break;
      }
      doorAnswer = answer;
      if (runnerFlag !== undefined) break; // an explicit name is never suffixed around
    }
    if (runnerName === "") {
      const detail = doorAnswer !== null && !doorAnswer.ok ? doorAnswer.detail : "no worker name could be taken";
      return fail(
        write,
        json,
        "up",
        "runner-alive",
        `${detail} — that worker looks alive; stop the other \`up\` or watch, or name a different worker with --runner`,
        EXIT.refused,
      );
    }

    // 6. Enrollment: the canonical roots join repos.json so the plain
    // report and future runs see them.
    {
      // The locked registry primitive (onboarding findings 9/17/25): a
      // refusal here also retires the runner this start just registered —
      // never today's silent empty-registry fallback.
      const enrolled = await updateRepos(configPath(process.env, homedir()), current => addRepos(current, repos));
      if (!enrolled.ok) {
        retireRunnerIfCurrent(store, runnerName, runnerToken, clock());
        return fail(write, json, "up", "registry", `${enrolled.message} — nothing started`, EXIT.refused);
      }
    }
  } finally {
    await new Promise<void>(done => probe.close(() => done()));
  }

  // 6b. The held-session coordinator (Phase 2): one per up process, shared
  // by the console and every watch loop through the context. Its socket
  // directory is deliberately SHORT and flat — sun_path is unforgiving.
  const heldDir = join(homedir(), ".standing-orders", "held");
  try {
    mkdirSync(heldDir, { recursive: true, mode: 0o700 });
  } catch {
    // The launch's own path check refuses with words if this failed.
  }
  context.heldCoordinator = new HeldSessionCoordinator();
  context.upIncarnation = randomUUID();
  context.heldSocketDir = heldDir;
  // v28: sessions are unbounded unless the operator caps them.
  const heldCap = text(flags, "max-held-sessions");
  if (heldCap !== undefined) {
    const cap = Number(heldCap);
    if (!Number.isInteger(cap) || cap < 1) {
      return fail(write, json, "up", "usage", "--max-held-sessions is a whole number of concurrent attended sessions, at least 1", EXIT.usage);
    }
    context.maxHeldSessions = cap;
  }

  // 7. The console, on the just-released port. The tiny window between the
  // probe closing and this bind can lose a race; that failure tears down
  // cleanly below instead of leaving identities half-claimed silently.
  const pool = join(dirname(context.databaseFile), "worktrees");
  let console_: Awaited<ReturnType<typeof startConsole>>;
  try {
    console_ = await startConsole({
      context,
      host: "127.0.0.1",
      port,
      localRunner: runnerName,
      poolRoot: pool,
      repos,
      upConsole: true,
      attended: {
        runner: runnerName,
        coordinator: context.heldCoordinator,
        headOf: async (repo: string) => {
          const answer = await gitRun("git", ["--no-optional-locks", "rev-parse", "HEAD"], { cwd: repo });
          return answer.code === 0 ? answer.stdout.trim() : null;
        },
      },
      registryPath: configPath(process.env, homedir()),
      ...(text(flags, "project-root") === undefined ? {} : { projectRoots: [text(flags, "project-root") as string] }),
      ...(text(flags, "public-url") === undefined ? {} : { publicUrl: text(flags, "public-url") as string }),
      ...(text(flags, "editor") === undefined ? {} : { editorLinks: "vscode" as const }),
    });
  } catch (error) {
    retireRunnerIfCurrent(store, runnerName, runnerToken, clock());
    return fail(write, json, "up", "port-busy", `${describe(error)} — the port was taken while starting; try again`, EXIT.refused);
  }

  // 8. The watch loops: one per repository, sharing this store and this
  // supervisor. First signal stops admission and starts the grace clock;
  // the second — or the clock — hard-stops provider groups (M6.12).
  let stopping = false;
  let fatal: string | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const followControllers: AbortController[] = [];
  const stopGraceMs = Number(text(flags, "stop-grace") ?? 30_000);
  const hardStop = () => {
    const terminated = terminateLiveProviders();
    if (terminated > 0) progress(`Hard stop: ${terminated} provider process group(s) terminated.`);
  };
  const stop = () => {
    if (stopping) {
      hardStop();
      return;
    }
    stopping = true;
    for (const controller of followControllers) controller.abort();
    graceTimer = setTimeout(hardStop, stopGraceMs);
    graceTimer.unref?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const loopFlagsFor = (repo: string): Map<string, string | true> => {
    const copy = new Map<string, string | true>();
    copy.set("runner", runnerName);
    copy.set("token", runnerToken);
    copy.set("repo", repo);
    copy.set("pool", pool);
    if (forGiven !== undefined) copy.set("for", forGiven);
    return copy;
  };
  const prefix = (repo: string): string => (repos.length > 1 ? `[${repo.split("/").pop() ?? repo}] ` : "");

  const readiness: Promise<void>[] = [];
  const loops = repos.map(repo => {
    let markReady: () => void = () => {};
    readiness.push(new Promise<void>(resolveReady => (markReady = resolveReady)));
    return runWatchLoop({
      flags: loopFlagsFor(repo),
      context,
      runner: runnerName,
      token: runnerToken,
      repo,
      progress: line => progress(`${prefix(repo)}${line}`),
      isStopping: () => stopping,
      onFollowController: controller => followControllers.push(controller),
      onReady: markReady,
    }).then(
      result => ({ repo, result }),
      error => ({ repo, result: { ok: false as const, reason: "lease-lost" as const, detail: describe(error), ticks: 0, built: 0, broke: 0 } }),
    );
  });

  // A loop that dies while its siblings live must not leave a partial
  // cockpit standing silently (finding 5): first failure aborts everything.
  const watchdog = loops.map(one =>
    one.then(({ repo, result }) => {
      if (!result.ok && !stopping) {
        fatal = `${prefix(repo)}${result.detail}`;
        stop();
      }
    }),
  );

  // 9. Readiness, then the ONE startup envelope / greeting (finding 11/20).
  const approverPlan2 = approver as UpApprover;
  await Promise.race([Promise.all(readiness), Promise.all(loops)]);
  const url = console_.url;
  if (fatal === null) {
    if (json) {
      write(
        envelopeJson({
          ok: true,
          command: "up",
          url,
          repos,
          runner: runnerName,
          approver: approverPlan2.approver,
          approvers: approverPlan2.approvers,
          approverVerified: approverPlan2.verified,
          ...(approverPlan2.passwordFile === null ? {} : { passwordFile: approverPlan2.passwordFile }),
        }),
      );
    } else {
      write("");
      write(`The console is on ${url}`);
      if (approverPlan2.mintedPassword !== null && canPrompt) {
        write(`  login     ${approverPlan2.approver} / ${approverPlan2.mintedPassword}`);
        write(`  (also saved to ${approverPlan2.passwordFile})`);
      } else if (approverPlan2.passwordFile !== null) {
        write(`  login     ${approverPlan2.approver} — the password is in ${approverPlan2.passwordFile}`);
      } else if (approverPlan2.approver !== null) {
        write(`  login     ${approverPlan2.approver} — with your password`);
      } else {
        write(`  login     one of: ${approverPlan2.approvers.join(", ")}`);
      }
      write(`  worker    ${runnerName} is watching ${repos.length === 1 ? repos[0] : `${repos.length} repositories`}`);
      write("  The inbox checklist shows what remains before approved work builds unattended.");
      write("  Ctrl-C stops the console and the worker together.");
    }
    if (!json && !flags.has("no-open") && process.stdout.isTTY === true) openBrowser(url);
  }

  // 10. Supervise to the end.
  const results = await Promise.all(loops);
  await Promise.all(watchdog);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  // Held sessions fence before the runner retires (v2 S0f): bounded, and
  // every controller settles conservatively or is paged.
  if (context.heldCoordinator !== undefined) {
    const unsettled = await context.heldCoordinator.close();
    for (const runId of unsettled) {
      // The shutdown deadline won: say so durably — the orphan sweep of
      // the NEXT up owns the cleanup, and silence would contradict
      // "settled conservatively or paged".
      store.enqueueNotification(
        {
          dedupeKey: `held-shutdown-unsettled:${runId}`,
          kind: "attended-unsettled",
          subject: `an attended session did not settle before shutdown (run #${runId})`,
          body: `The shutdown deadline passed before run #${runId}'s session finished fencing. The next \`standing-orders up\` will fence and settle it; its worktree is preserved.`,
        },
        clock(),
      );
    }
  }
  retireRunnerIfCurrent(store, runnerName, runnerToken, clock());
  await new Promise<void>(done => console_.server.close(() => done()));

  if (fatal !== null) {
    // The startup envelope (when json) already went out; the exit code is
    // the health signal (finding 11/20) — never a second envelope.
    process.stderr.write(`up: ${fatal}\n`);
    return EXIT.failed;
  }
  const ticks = results.reduce((sum, one) => sum + one.result.ticks, 0);
  const built = results.reduce((sum, one) => sum + one.result.built, 0);
  progress(`up: stopped cleanly — ${ticks} pass(es), ${built} with work. The worker is retired; the next \`up\` reuses its name.`);
  return EXIT.ok;
}

// ---- the telegram bridge ---------------------------------------------------

/**
 * `standing-orders bridge telegram …` — decisions out, answers back, no LLM in
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
  const demoFence = refuseDemo(context, "bridge");
  if (demoFence !== null) return demoFence;
  const [channel, action] = positional;
  if (channel !== "telegram") {
    return fail(write, json, "bridge", "usage", "`standing-orders bridge telegram [pair|unpair|token|status]`", EXIT.usage);
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
        "`standing-orders bridge telegram token <bot-token>` (from @BotFather), or --clear",
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
        envelopeJson(
          {
            ok: true,
            command: "bridge status",
            token: source === null ? null : { source: source.source, botId: source.botId, redacted: redactToken(source.token) },
            paired: binding !== null,
            approver: binding?.approver ?? null,
            outboxPending: pending,
          },
        ),
      );
      return EXIT.ok;
    }
    write(source === null
      ? `No bot token. Set ${TOKEN_ENV}, run \`standing-orders bridge telegram token <t>\`, or use the serve settings card.`
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
    return fail(write, json, "bridge", "usage", "`standing-orders bridge telegram [pair|unpair|token|status]`", EXIT.usage);
  }

  // The pass.
  if (source === null) {
    return fail(
      write,
      json,
      "bridge",
      "no-token",
      `no bot token — set ${TOKEN_ENV}, run \`standing-orders bridge telegram token <t>\`, or use the serve settings card`,
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

  const passed = await bridgePass(store, {
    botId: source.botId,
    transport,
    clock,
    ...(flags.has("inbound-only") ? { deliver: false } : {}),
  });
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
 * `standing-orders publish …` — built work to a pushed branch and a PR, under a
 * grant whose terms were shown before the yes.
 *
 *   publish                              one pass: push intents, open/adopt PRs
 *   publish grant --github <owner/name> [--base main] [--remote origin]
 *                 [--head-prefix standing-orders/] [--all-tasks] [--ready]
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
  const demoFence = refuseDemo(context, "publish");
  if (demoFence !== null) return demoFence;
  const repo = repoFrom(flags);
  const [action] = positional;
  // Bare `publish` IS an action: the publication pass (push branches,
  // open PRs, sweep merges) — only a NAMED unknown action refuses.
  if (action !== undefined && !(PUBLISH_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "publish", "usage", `unknown \`publish ${action}\` — try ${PUBLISH_ACTIONS.join(", ")}, or bare \`publish\` for the publication pass`, EXIT.usage);
  }

  if (action === "grant") {
    const github = text(flags, "github");
    if (github === undefined || !/^[\w.-]+\/[\w.-]+$/.test(github)) {
      return fail(write, json, "publish grant", "usage", "`--github <owner/name>` is required, exactly", EXIT.usage);
    }
    const wantsMerge = flags.has("allow-merge");
    const mergeMethod = text(flags, "merge-method");
    if (wantsMerge && (mergeMethod === undefined || !["squash", "merge", "rebase"].includes(mergeMethod))) {
      return fail(write, json, "publish grant", "usage", "--allow-merge names its method: --merge-method squash|merge|rebase", EXIT.usage);
    }
    const spec = {
      repo,
      githubRepo: github,
      remote: text(flags, "remote") ?? "origin",
      headPrefix: text(flags, "head-prefix") ?? "standing-orders/",
      base: text(flags, "base") ?? "main",
      capabilities: ["push-branch", "open-pr"] as ("push-branch" | "open-pr")[],
      selector: (flags.has("all-tasks") ? "all" : "ours") as "all" | "ours",
      draft: !flags.has("ready"),
      merge: wantsMerge,
      mergeMethod: wantsMerge ? (mergeMethod as "squash" | "merge" | "rebase") : null,
      mergeDeleteBranch: wantsMerge && flags.has("merge-delete-branch"),
    };
    // The merge terms are restated with the ACTUAL credential that would
    // act (round-2 finding c): the account is shown, and named unpinned.
    const mergeTerms: string[] = [];
    if (wantsMerge) {
      const whoAmI = await (context.publishExec ?? undefined) ?.("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 10_000 })
        ?? await (await import("./exec.js")).run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 10_000 });
      const account = whoAmI.code === 0 ? whoAmI.stdout.trim() : "(gh is not signed in — merges will refuse)";
      mergeTerms.push(
        "",
        "AND auto-merge: pull requests this plane opened or adopted, on " + github + " into " + spec.base + ",",
        "merge as " + mergeMethod + (spec.mergeDeleteBranch ? " and delete the remote branch" : "") + " — ONLY after CI was OBSERVED green on the exact",
        "head commit (silence, running, or a moved head never merge; drafts never merge;",
        "a base with a merge queue, or protection this plane cannot read, pauses with a page).",
        "Merging acts as the GitHub account signed into gh on the machine that runs the",
        "sweep — currently: " + account + " — and is NOT pinned; changing gh auth changes who merges.",
        "CI can turn red on the same commit between the last look and the merge; the",
        "exact-commit match cannot see that. An all-skipped check rollup reads as passing.",
      );
    }

    if (!flags.has("yes")) {
      // Unconfirmed, like every other grant preview: ok:false, reason
      // "unconfirmed", exit 3 — this one alone said ok:true (round-4
      // finding 10 / round-3 finding B5).
      if (json) {
        write(envelopeJson({ ok: false, command: "publish grant", reason: "unconfirmed", proposed: spec, granted: false }));
        return EXIT.refused;
      }
      write("This grant would allow, unattended:");
      for (const line of describePublicationGrant(spec)) write(line);
      for (const line of mergeTerms) write(line);
      write("");
      write("Nothing is granted yet. Repeat with --yes --as <you> --token <approver-token> to agree to exactly this.");
      return EXIT.refused;
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
      "Revoke any time: `standing-orders publish revoke --as <you> --token <t>`.",
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
      write(envelopeJson({ ok: true, command: "publish status", grant, pending }));
      return EXIT.ok;
    }
    write(grant === null ? "No live publication grant." : `Granted by ${grant.grantedBy} at ${grant.grantedAt}:`);
    if (grant !== null) for (const line of describePublicationGrant(grant)) write(line);
    write(pending.length === 0 ? "Nothing owed." : `Owed: ${pending.length} publication(s) pending.`);
    return EXIT.ok;
  }

  if (action === "unblock" || action === "rearm") {
    const prGiven = positional[1];
    const pr = Number(prGiven);
    if (prGiven === undefined || !Number.isInteger(pr) || pr <= 0) {
      return fail(write, json, `publish ${action}`, "usage", `\`standing-orders publish ${action} <pr> --as <you> --token <t>\``, EXIT.usage);
    }
    const acting = await askCredentials(flags, context);
    if (acting === null) {
      return fail(write, json, `publish ${action}`, "usage", `${action === "unblock" ? "lifting a repair hold" : "re-arming a refused merge"} takes \`--as <you> --token <t>\` — who decided is recorded, not asserted`, EXIT.usage);
    }
    const authenticated = authenticateApprover(store, acting.name, acting.token);
    if (!authenticated.ok) {
      return fail(write, json, `publish ${action}`, authenticated.reason, describeApproveFailure(authenticated.reason, acting.name), EXIT.refused);
    }
    const publication = store.openedPublications().find(one => one.prNumber === pr);
    if (publication === undefined) {
      return fail(write, json, `publish ${action}`, "unknown", `no open publication holds PR #${pr}`, EXIT.refused);
    }
    if (action === "unblock") {
      const lifted = store.liftMergeBlocker(publication.id);
      store.resolveEpisodes(`merge-attn:${publication.id}`, context.clock());
      return succeed(write, json, "publish unblock", { pr, lifted }, () => [
        lifted
          ? `PR #${pr} no longer holds for its repair — the next sweep may merge it under the granted terms.`
          : `PR #${pr} was not held by a repair.`,
      ]);
    }
    const rearmed = store.rearmMergeIntent(publication.id);
    store.resolveEpisodes(`merge-attn:${publication.id}`, context.clock());
    return succeed(write, json, "publish rearm", { pr, rearmed }, () => [
      rearmed
        ? `PR #${pr}'s merge is re-armed — the next sweep re-proves everything and tries again.`
        : `PR #${pr} had no refused merge to re-arm.`,
    ]);
  }

  if (action !== undefined) {
    return fail(write, json, "publish", "usage", "`standing-orders publish [grant|revoke|status|unblock|rearm]`", EXIT.usage);
  }

  // The pass.
  const report = await publishPass(store, {
    repo,
    clock,
    ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
  });
  // The merge sweep rides every publish pass: green, proved, granted work
  // leaves as MERGED PRs (v21; four review rounds are the spec).
  const merges = await sweepMerges(store, {
    repo,
    clock,
    ...(context.publishExec === undefined ? {} : { exec: context.publishExec }),
  });
  const idle =
    report.pushed === 0 && report.opened === 0 && report.adopted === 0 && report.failed === 0 && merges.merged === 0 && merges.refused === 0;
  const lines = () => [
    `Pushed ${report.pushed}, opened ${report.opened}, adopted ${report.adopted}, gave up on ${report.failed}.` +
      (merges.merged + merges.refused + merges.skipped > 0 ? ` Merged ${merges.merged}, refused ${merges.refused}, holding ${merges.skipped}.` : ""),
    ...report.problems.map(problem => `  problem: ${problem}`),
    ...merges.problems.map(problem => `  merge: ${problem}`),
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
 * `standing-orders outbox list|deliver` — reading and draining the durable
 * outbox. Delivery runs an operator-supplied command once per pending row;
 * the notification's text reaches it as environment variables, never
 * substituted into the command line, because subjects and bodies quote
 * things agents and repositories said and a shell must not meet those.
 *
 *   standing-orders outbox deliver --cmd 'curl -d "$STANDING_ORDERS_SUBJECT" ntfy.sh/mine'
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
      write(envelopeJson({ ok: true, command: "outbox list", notifications }));
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
    const demoFence = refuseDemo(context, "outbox deliver");
    if (demoFence !== null) return demoFence;
    const command = text(flags, "cmd");
    if (command === undefined) {
      return fail(write, json, "outbox deliver", "usage", "--cmd says how: it runs once per notification, reading $STANDING_ORDERS_KIND, $STANDING_ORDERS_SUBJECT, $STANDING_ORDERS_BODY", EXIT.usage);
    }

    // Claimed, not merely listed: the Telegram bridge drains this same
    // outbox, and select-then-send-then-record from two deliverers pages a
    // person twice. The claim is a short lease on the act of sending; a
    // deliverer that dies mid-send leaves rows that unclaim by expiry.
    const owner = `outbox-${randomUUID()}`;
    // Push first, independently (arc 3 finding 8): its pair ledger does not
    // depend on globally-undelivered notifications — Telegram or a webhook
    // may already have stamped delivered_at.
    let pushed = 0;
    try {
      pushed = (await pushPass(store, { configDir: dirname(context.databaseFile), clock })).accepted;
    } catch {
      // additive; the shell delivery below still runs
    }
    const pending = store.claimDeliveries(owner, 2 * 60_000, clock());
    if (pending.length === 0) {
      return succeed(write, json, "outbox deliver", { delivered: 0, failed: 0, pushed }, () => [
        pushed > 0 ? `Nothing for the shell command; ${pushed} push(es) accepted.` : "Nothing waiting to be delivered.",
      ]);
    }

    let delivered = 0;
    let failed = 0;
    for (const one of pending) {
      const sent = await run("sh", ["-lc", command], {
        timeoutMs: 30_000,
        env: {
          STANDING_ORDERS_KIND: one.kind,
          STANDING_ORDERS_SUBJECT: one.subject,
          STANDING_ORDERS_BODY: one.body,
          STANDING_ORDERS_DEDUPE_KEY: one.dedupeKey,
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
      write(envelopeJson({ ok: failed === 0, command: "outbox deliver", delivered, failed }));
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

  // External dispatch (v20): its own explicit yes, never in any default.
  // A dispatch grant binds EXACTLY ONE remote repository and mints this
  // plane's marker identity.
  const wantsDispatch = flags.has("allow-dispatch");
  const dispatchRepo = text(flags, "github");
  if (wantsDispatch && backend !== "github-issues") {
    return fail(write, json, "enroll", "usage", "--allow-dispatch is a github-issues authority in this release", EXIT.usage);
  }
  if (wantsDispatch && (dispatchRepo === undefined || !GITHUB_REPO_SHAPE.test(dispatchRepo))) {
    return fail(write, json, "enroll", "usage", "--allow-dispatch binds exactly one tracker: name it with `--github <owner/name>`", EXIT.usage);
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
  if (wantsDispatch) {
    const previous = store.grantFor(repo, backend);
    grant.dispatch = true;
    grant.remoteRepo = dispatchRepo as string;
    // Re-enrolling keeps the plane identity — that is exactly how a
    // marker is repaired after a semantic block.
    grant.planeId = previous?.planeId ?? randomBytes(8).toString("hex");
    grant.dispatchBlocked = "pending-marker";
  }

  if (!flags.has("yes")) {
    if (json) {
      write(envelopeJson({ ok: false, command: "enroll", reason: "unconfirmed", grant }));
      return EXIT.refused;
    }
    write("Would grant write access:");
    write("");
    for (const line of describeGrant(grant)) write(line);
    for (const line of describeWithheld(grant)) write(line);
    if (wantsDispatch) {
      write("");
      write(`AND external dispatch: this plane will BUILD what ${dispatchRepo} nominates,`);
      write("under scopes approved here, and spend accordingly. Write-back stays limited");
      write("to the classes above. Enrolling writes a plane marker label to the repository");
      write("(needs push permission there); a second plane's marker pauses building here.");
    }
    write("");
    write("Nothing has been granted. Re-run with --yes to agree to this.");
    // Unconfirmed is "no, not yet" — exit 3 in both modes (round-4 finding 10).
    return EXIT.refused;
  }

  store.saveGrant(grant, mutationFrom(flags, now));

  // The marker, AFTER the grant row (v3 §5): a partial failure leaves the
  // grant honestly blocked 'pending-marker'; re-running enroll repairs it.
  if (wantsDispatch) {
    const adapter = ghDispatchAdapter();
    const wrote = await adapter.writeMarker(dispatchRepo as string, grant.planeId as string);
    if (wrote.ok) {
      store.setDispatchBlocked(repo, backend, null, now);
    } else {
      store.setDispatchBlocked(repo, backend, "pending-marker", now, wrote.message);
    }
    if (!wrote.ok) {
      return succeed(write, json, "enroll", { grant, marker: "pending" }, () => [
        `Granted, but the plane marker could not be written (${wrote.message}).`,
        "Building stays paused until it is — re-run this enroll to retry.",
      ]);
    }
  }

  return succeed(write, json, "enroll", { grant }, () => [
    `Granted. Standing Orders may now write to ${backend} in ${repo}.`,
    ...describeGrant(grant),
    ...describeWithheld(grant),
    ...(wantsDispatch ? ["", `External dispatch is ON for ${dispatchRepo} — \`standing-orders sync\` pulls its nominated work.`] : []),
    "",
    "Take it back with `standing-orders revoke`.",
  ]);
}

function grantsCommand(context: Context): number {
  const { store, write, json } = context;
  const grants = store.listGrants();

  if (json) {
    write(envelopeJson({ ok: true, command: "grants", count: grants.length, grants }));
    return EXIT.ok;
  }
  if (grants.length === 0) {
    write("Nothing is enrolled. Discovery is read-only until something is.");
    write("  standing-orders enroll <repo> --backend <name> --paths <path>");
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
  const outgoing = store.grantFor(repo, backend);
  const revoked = store.revokeGrant(repo, backend, mutationFrom(flags, now));
  // Best-effort marker cleanup: a failure leaves a stale label another
  // plane will read as foreign — stated, and repairable there by enroll.
  if (revoked && outgoing?.dispatch === true && outgoing.remoteRepo != null) {
    void ghDispatchAdapter().deleteMarker(outgoing.remoteRepo);
  }
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
    case "unblock":
      return unblockTask(rest, flags, context);
    case "next":
      return nextTask(rest, flags, context);
    case "steer":
      return steerTask(rest, flags, context);
    case "assign":
      return assignTask(rest, flags, context);
    case "reopen":
      return reopenTask(rest, flags, context);
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
        `unknown \`task ${action ?? ""}\` — try ${TASK_ACTIONS.join(", ")}`,
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
  // The same text rules every filing door applies (Codex adoption review,
  // finding 7): the bare CLI path must not accept a title the console or a
  // template would refuse.
  const badText = validateTaskText({ title });
  if (badText !== null) return fail(write, json, "task add", badText.reason, badText.message, EXIT.usage);

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

    // Created through Standing Orders, so it is ours — recorded here rather than
    // asserted later, which is what the grant's default selector rests on.
    store.refFor(backendName, created.value, "ours");
    // With a dispatch grant standing, the created item ALSO becomes a local
    // mirror (provenance local-create) — established at creation, the only
    // moment "we made this" is a fact rather than a claim (v3 §4).
    const dispatchGrant = store.grantFor(repoFrom(flags), backendName);
    let mirrored: string | null = null;
    if (backendName === "github-issues" && dispatchGrant?.dispatch === true && dispatchGrant.remoteRepo != null) {
      const localId = mirrorTaskId(dispatchGrant.remoteRepo, created.value);
      const made = store.transact(() => {
        const filed = fileTaskProposal(store, { id: localId, title, repo: dispatchGrant.repo, filedVia: "cli" }, now);
        if (!filed.ok) return filed;
        const established = store.establishMirror(
          {
            localTaskId: filed.id,
            backend: backendName,
            remoteRepo: dispatchGrant.remoteRepo as string,
            remoteId: created.value,
            provenance: "local-create",
            establishedBy: "cli",
          },
          now,
        );
        if (!established.ok) throw new Error(`mirror not established: ${established.reason}`);
        return filed;
      });
      if (made.ok) mirrored = made.id;
    }
    return succeed(write, json, "task add", { id: created.value, backend: backendName, ...(mirrored === null ? {} : { mirror: mirrored }) }, () => [
      `Filed ${created.value} in ${backendName}.`,
      ...(mirrored === null ? [] : [`Mirrored locally as ${mirrored} — scope and approve it, and this plane builds it.`]),
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

  store.stampFiledVia(store.refFor(BUILT_IN, id).id, "cli");

  // Placement is explicit, never inferred from where the command happened to
  // run: a task filed from the wrong directory would silently bind to it.
  const placedIn = text(flags, "repo");
  if (placedIn !== undefined) {
    const placed = store.placeTask(store.refFor(BUILT_IN, id).id, canonicalProject(placedIn) ?? resolve(placedIn));
    if (typeof placed === "object" && !placed.ok) {
      return fail(write, json, "task add", "scoped", "this task already has a scope — placement is immutable once somebody could have approved it", EXIT.refused);
    }
  }

  const link = consoleLinkFor(context, `/t/${encodeURIComponent(outcome.task.id)}`);
  return succeed(
    write,
    json,
    "task add",
    {
      task: outcome.task,
      repo: placedIn === undefined ? null : resolve(placedIn),
      ...(link === null ? {} : { links: { task: link } }),
    },
    () => [`Queued ${outcome.task.id} — ${outcome.task.title}`, ...(link === null ? [] : [`  ${link}`])],
  );
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
    return fail(write, json, "task require", "usage", "`standing-orders task require <id> --cap <kind:name>[,<kind:name>]` — or --cap none to clear", EXIT.usage);
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
      return fail(write, json, "cap add", "usage", "`standing-orders cap add <name> [--kind env|cli|mcp|ci|other] [--probe <cmd>] [--expires <iso>]`", EXIT.usage);
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
      "Nothing is verified yet: `standing-orders cap probe`.",
    ]);
  }

  if (action === "list" || action === undefined) {
    const capabilities = store.listCapabilities(repo);
    if (json) {
      write(envelopeJson({ ok: true, command: "cap list", repo, capabilities }));
      return EXIT.ok;
    }
    if (capabilities.length === 0) {
      write(`No capabilities recorded for ${repo}. \`standing-orders cap add\` or \`cap scan\`.`);
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
      write(envelopeJson({ ok: true, command: "cap scan", repo, recorded, ...report }));
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
    write(`${recorded} new, ${report.found.length - recorded} already recorded. Nothing is verified: \`standing-orders cap probe\`.`);
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
      write(envelopeJson({ ok: true, command: "cap probe", repo, outcomes }));
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
    write(envelopeJson({ ok: true, command: "task list", count: tasks.length, tasks }));
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
    position: store.queuePosition(id),
    reservedFor: ref.assignedRunner,
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
    ...(detail.position === null
      ? []
      : [`  position  ${detail.position.position} of ${detail.position.total}${detail.position.column === null ? " in the shared queue" : ` in ${detail.position.column}'s queue`}`]),
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
    return fail(write, json, "task state", "usage", "`standing-orders task state <id> <state>`", EXIT.usage);
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
  if (!moved.ok) {
    return moved.reason === "external-closed"
      ? fail(write, json, "task state", "external-closed", "the tracker closed this — reopen it first, or leave it cancelled", EXIT.refused)
      : fail(write, json, "task state", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

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
    return fail(write, json, "task block", "usage", "`standing-orders task block <id> --on <id>`", EXIT.usage);
  }
  for (const each of [id, on]) {
    if (store.getTask(each) === null) {
      return fail(write, json, "task block", "unknown-task", `no task \`${each}\``, EXIT.refused);
    }
  }
  const racingGuard = refuseWhileRacing(context, "task block", id);
  if (racingGuard !== null) return racingGuard;

  const result = store.addEdge(id, on, mutationFrom(flags, context.now));
  if (!result.ok) return fail(write, json, "task block", "rejected", result.reason, EXIT.refused);

  return succeed(write, json, "task block", { blocked: id, blocker: on }, () => [
    `${id} now waits for ${on}.`,
  ]);
}

/**
 * File a steering note (arc 1): guidance the next attempt's brief quotes,
 * fenced, inside the approved scope. Scheduling-adjacent like block/next —
 * no credential; the recorded author is "cli" or --as when given.
 */
async function steerTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const id = positional[0];
  const note = text(flags, "note");
  if (id === undefined || note === undefined) {
    return fail(write, json, "task steer", "usage", "`standing-orders task steer <id> --note \"...\" --as <you> --token <t>` — steering speaks with the operator's voice, so it takes your credential; the note reaches the next attempt's brief, fenced, inside the approved scope", EXIT.usage);
  }
  // Ruling 11: authorship derives from a VERIFIED principal, never a flag.
  // Missing credentials are usage (the invocation is incomplete); present
  // but wrong is not-an-approver — the same taxonomy as every ceremony.
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task steer", "usage", "steering takes `--as <you> --token <t>` — anonymous notes never reach an agent's brief", EXIT.usage);
  }
  const authed = authenticateApprover(store, acting.name, acting.token);
  if (!authed.ok) {
    return fail(write, json, "task steer", "not-an-approver", "that is not an approver, or the token does not match", EXIT.refused);
  }
  const filed = store.fileSteerNote(id, verifiedAuthor(acting.name), note, context.now, mutationFrom(flags, context.now));
  if (!filed.ok) {
    const detail =
      filed.reason === "unknown-task"
        ? `no task \`${id}\``
        : filed.reason === "task-finished"
          ? `${id} is finished — a note has no next attempt to reach`
          : filed.reason === "contest-open"
            ? "agents are racing on this task — steering waits until the tournament settles"
            : (filed.problem ?? "that note will not store");
    return fail(write, json, "task steer", filed.reason, detail, EXIT.refused);
  }
  return succeed(write, json, "task steer", { task: id, note: filed.id }, () => [
    `Noted. The next attempt at ${id} reads it before starting — a running agent is not interrupted.`,
  ]);
}

/** The mirror of block: stop waiting. Removal cannot create a cycle. */
function unblockTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  const on = text(flags, "on");
  if (id === undefined || on === undefined) {
    return fail(write, json, "task unblock", "usage", "`standing-orders task unblock <id> --on <id>`", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task unblock", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }
  const racingGuard = refuseWhileRacing(context, "task unblock", id);
  if (racingGuard !== null) return racingGuard;

  const result = store.removeEdge(id, on, mutationFrom(flags, context.now));
  if (!result.ok) {
    return fail(write, json, "task unblock", "not-waiting", `${id} was not waiting on ${on}`, EXIT.refused);
  }
  return succeed(write, json, "task unblock", { blocked: id, blocker: on }, () => [
    `${id} no longer waits for ${on}.`,
  ]);
}

/**
 * Move a task to the front of the queue — or put it back with --undo.
 * Scheduling only: the rank changes when the next free worker looks,
 * and approval is still required for anything to build.
 */
function nextTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  if (id === undefined) {
    return fail(write, json, "task next", "usage", "`standing-orders task next <id> [--undo]`", EXIT.usage);
  }
  if (flags.has("undo")) {
    const cleared = store.clearTaskPriority(id, mutationFrom(flags, context.now));
    if (!cleared.ok) return fail(write, json, "task next", "unknown-task", `no task \`${id}\``, EXIT.refused);
    return succeed(write, json, "task next", { task: id, priority: 0 }, () => [
      `${id} is back in filing order.`,
    ]);
  }
  const moved = store.moveTaskNext(id, context.clock(), mutationFrom(flags, context.now));
  if (!moved.ok) {
    const message =
      moved.reason === "unknown-task"
        ? `no task \`${id}\``
        : moved.reason === "not-queued"
          ? `${id} is not queued — only queued work can move up`
          : moved.reason === "claimed"
            ? `${id} is being built right now — it needs no place in line`
            : moved.reason === "contest-open"
              ? "a tournament is running on this task — let it finish, then pick or abandon it from the tournament screen in the console (the task's page links to it)"
              : "the queue rank could not be raised any further";
    return fail(write, json, "task next", moved.reason, message, EXIT.refused);
  }
  return succeed(write, json, "task next", { task: id, priority: moved.priority }, () => [
    `${id} moved to the front of its queue — a worker takes its own reserved work first, then the shared queue (approval still required).`,
  ]);
}

/**
 * Reserve a task for one worker, or return it to the shared queue.
 * Scheduling, never authority — the claim primitive enforces it, and
 * approval still decides what may build.
 */
function assignTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): number {
  const { store, write, json } = context;
  const id = positional[0];
  const runner = text(flags, "runner");
  const anyone = flags.has("anyone");
  if (id === undefined || (runner === undefined && !anyone) || (runner !== undefined && anyone)) {
    return fail(write, json, "task assign", "usage", "`standing-orders task assign <id> --runner <name> | --anyone`", EXIT.usage);
  }
  const moved = store.moveTask(
    { taskId: id, toRunner: runner ?? null, beforeTaskId: null },
    context.clock(),
    mutationFrom(flags, context.now),
  );
  if (!moved.ok) {
    const message =
      moved.reason === "unknown-task"
        ? `no task \`${id}\``
        : moved.reason === "not-queued"
          ? `${id} is not queued — only queued work can be reserved`
          : moved.reason === "claimed"
            ? `${id} is being built right now — it needs no reservation`
            : moved.reason === "contest-open"
              ? "a tournament is running on this task — let it finish, then pick or abandon it from the tournament screen in the console (the task's page links to it)"
              : moved.reason === "no-such-worker"
                ? `no worker named \`${runner}\` — \`standing-orders runner list\` names them`
                : moved.reason === "worker-retired"
                  ? `${runner} is retired — register the name again, or reserve for another worker`
                  : "the queue did not accept the move";
    return fail(write, json, "task assign", moved.reason, message, EXIT.refused);
  }
  return succeed(write, json, "task assign", { task: id, reservedFor: runner ?? null }, () => [
    runner === undefined
      ? `${id} is back in the shared queue — any free worker takes it.`
      : `${id} is reserved for ${runner}, at the back of that worker's queue — only that worker takes it.`,
  ]);
}

/**
 * Reopen an externally-closed mirror: an authenticated act that needs the
 * tracker SEEN open again after the close, and the task clean — the
 * refusals point at the existing acts that clear each blocker.
 */
async function reopenTask(
  positional: readonly string[],
  flags: Map<string, string | true>,
  context: Context,
): Promise<number> {
  const { store, write, json } = context;
  const id = positional[0];
  if (id === undefined) {
    return fail(write, json, "task reopen", "usage", "`standing-orders task reopen <id> --as <you> --token <t>`", EXIT.usage);
  }
  const acting = await askCredentials(flags, context);
  if (acting === null) {
    return fail(write, json, "task reopen", "usage", "reopening takes `--as <you> --token <t>` — who resumed external work is recorded, not asserted", EXIT.usage);
  }
  const reopened = store.reopenMirror(id, acting.name, context.clock());
  if (!reopened.ok) {
    const said: Record<string, string> = {
      "unknown-task": `no external task \`${id}\``,
      "not-latched": `${id} was never closed on its tracker — there is nothing to reopen`,
      "not-seen-open": "the tracker has not been SEEN open again since the close — reopen it there, then `standing-orders sync`",
      claimed: `${id} is being built right now`,
      "contest-open": "a tournament is open on this task — decide it first",
      held: "a hold stands — lift it first (`task unhold`, or wait out the timer)",
      "question-open": "an unanswered question stands — answer or close it first (it is on the task page)",
      "incident-open": "an unresolved incident stands — resolve it first",
      "bad-state": `${id} is not in a state reopen can take (it may already be done)`,
    };
    return fail(write, json, "task reopen", reopened.reason, said[reopened.reason] ?? "the mirror could not be reopened", EXIT.refused);
  }
  return succeed(write, json, "task reopen", { task: id, by: acting.name }, () => [
    `${id} is queued again — the tracker was seen open, the approved scope stands, and the next pass may take it.`,
  ]);
}

/**
 * The sync pass, by hand: every dispatch-granted tracker (or one repo's),
 * through the same engine the daemon runs. Zero tokens; fail closed.
 */
async function syncCommand(flags: Map<string, string | true>, context: Context): Promise<number> {
  const { store, write, json } = context;
  const demoFence = refuseDemo(context, "sync");
  if (demoFence !== null) return demoFence;
  const only = text(flags, "repo");
  const grants = store
    .listGrants()
    .filter(grant => grant.dispatch === true && grant.remoteRepo != null)
    .filter(grant => only === undefined || grant.repo === resolve(only));
  if (grants.length === 0) {
    return fail(write, json, "sync", "no-grant", "no tracker has a dispatch grant — `standing-orders enroll <repo> --backend github-issues --github <owner/name> --allow-dispatch` states the terms", EXIT.refused);
  }
  const adapter = ghDispatchAdapter();
  const reports = [];
  for (const grant of grants) {
    reports.push(await syncPass(store, grant, adapter, context.clock));
  }
  const failed = reports.filter(one => one.outcome === "failed" || one.outcome === "blocked");
  if (json) {
    write(envelopeJson({ ok: failed.length === 0, command: "sync", ...(failed.length === 0 ? {} : { reason: "sync-failed", message: failed[0]?.detail ?? "a pass failed" }), reports }));
    return failed.length === 0 ? EXIT.ok : EXIT.failed;
  }
  for (const report of reports) {
    write(
      `${report.remoteRepo}  ${report.outcome}` +
        `${report.outcome === "complete" || report.outcome === "capped" ? ` — ${report.candidates} open, ${report.mirrored} newly mirrored, ${report.latched} closed there, ${report.delivered} write-back(s) delivered` : ""}` +
        `${report.detail === null ? "" : `  (${report.detail})`}`,
    );
  }
  if (failed.length > 0) {
    write("A failed or blocked pass advances nothing — external work keeps its last verified state and will not dispatch past its freshness window.");
    return EXIT.failed;
  }
  return EXIT.ok;
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
    return fail(write, json, "task scope", "usage", "`standing-orders task scope <id> --goal <what success is> [--not <text>] [--touches a,b] [--budget-usd <n>] [--race provider:model[,provider:model…]] [--race-count 2..4] [--race-per-usd <n>] [--race-total-usd <n>]`", EXIT.usage);
  }
  if (store.getTask(id) === null) {
    return fail(write, json, "task scope", "unknown-task", `no task \`${id}\``, EXIT.refused);
  }

  const touches = (text(flags, "touches") ?? "").split(",").map(one => one.trim()).filter(Boolean);

  // A tournament rides the same filing (stage 3): --race names the agents,
  // the dollar terms are REQUIRED, and everything lands unapproved — the
  // one yes later covers scope AND race terms as a single fingerprint.
  const budgetGiven = text(flags, "budget-usd");
  const defaults = store.getSpendDefaults();
  const budgetUsd =
    budgetGiven !== undefined
      ? Number(budgetGiven)
      : defaults?.buildPerRunMicrousd != null
        ? defaults.buildPerRunMicrousd / 1_000_000
        : null;
  if (budgetGiven !== undefined && (!Number.isFinite(Number(budgetGiven)) || Number(budgetGiven) <= 0)) {
    return fail(write, json, "task scope", "bad-budget", "--budget-usd is a positive dollar amount", EXIT.usage);
  }
  const raceGiven = text(flags, "race");
  const raceCountGiven = text(flags, "race-count");
  // The comparison road (Phase 3 slice B): labeled lanes, no dollar terms,
  // any registered provider — refused outright when every lane could hold
  // a real budget (the discipline gate: race those instead).
  const compareGiven = text(flags, "compare");
  let plannedComparison: ReturnType<typeof planComparison> | null = null;
  if (compareGiven !== undefined) {
    if (raceGiven !== undefined || raceCountGiven !== undefined || text(flags, "race-per-usd") !== undefined || text(flags, "race-total-usd") !== undefined) {
      return fail(write, json, "task scope", "usage", "--compare and the --race flags are different ceremonies — file one or the other", EXIT.usage);
    }
    if (store.mirrorByTask(id) !== null) {
      return fail(write, json, "task scope", "external-race", "external work compares in a follow-up release — file the comparison on a local task", EXIT.refused);
    }
    const lanes = compareGiven.split(",").map(one => {
      const [provider = "", model = ""] = one.trim().split(":");
      return { provider, model };
    });
    plannedComparison = planComparison({ agents: lanes });
    if (!plannedComparison.ok) {
      return fail(write, json, "task scope", plannedComparison.reason, plannedComparison.message, EXIT.refused);
    }
  }
  let plannedRace: ReturnType<typeof planTournament> | null = null;
  if (raceCountGiven !== undefined && raceGiven === undefined) {
    return fail(write, json, "task scope", "usage", "--race-count needs --race to name the competing agent, e.g. `--race claude:claude-sonnet-5 --race-count 3`", EXIT.usage);
  }
  if (raceGiven !== undefined) {
    // Explicit flags win; absent ones fall back to the configured defaults
    // (operator request) — the digest binds the ACTUAL numbers either way,
    // and the approval restates them. A budget that is simply MISSING is
    // named as the missing flag here, before planTournament's generic
    // positive-amount backstop turns it into a riddle (round-4 finding 11).
    if (text(flags, "race-per-usd") === undefined && defaults?.racePerAgentMicrousd == null) {
      return fail(write, json, "task scope", "bad-budget", "--race-per-usd is missing and no default is set — pass it, or set one with `standing-orders config set budgets --race-per-usd <n>`", EXIT.usage);
    }
    if (text(flags, "race-total-usd") === undefined && defaults?.raceTotalMicrousd == null) {
      return fail(write, json, "task scope", "bad-budget", "--race-total-usd is missing and no default is set — pass it, or set one with `standing-orders config set budgets --race-total-usd <n>`", EXIT.usage);
    }
    const perUsd = Number(text(flags, "race-per-usd") ?? (defaults?.racePerAgentMicrousd == null ? Number.NaN : defaults.racePerAgentMicrousd / 1_000_000));
    const totalUsd = Number(text(flags, "race-total-usd") ?? (defaults?.raceTotalMicrousd == null ? Number.NaN : defaults.raceTotalMicrousd / 1_000_000));
    if (store.mirrorByTask(id) !== null) {
      return fail(write, json, "task scope", "external-race", "external work races in a follow-up release — file the tournament on a local task", EXIT.refused);
    }
    let agents = raceGiven.split(",").map(one => {
      const [provider = "", model = ""] = one.trim().split(":");
      return { provider, model };
    });
    // The competing-agent COUNT (operator request): an explicit --race-count
    // replicates a single named agent; with several named agents it may only
    // agree with the list — a count that contradicts an explicit lineup is a
    // question, not an instruction. Absent both, the configured default
    // count replicates a single agent; an explicit list is always itself.
    if (raceCountGiven !== undefined) {
      const count = Number(raceCountGiven);
      if (!Number.isInteger(count) || count < 2 || count > 4) {
        return fail(write, json, "task scope", "usage", "--race-count is how many agents compete: a whole number from 2 to 4", EXIT.usage);
      }
      if (agents.length === 1) {
        agents = Array.from({ length: count }, () => ({ ...(agents[0] as { provider: string; model: string }) }));
      } else if (agents.length !== count) {
        return fail(write, json, "task scope", "usage", `--race names ${agents.length} agents but --race-count says ${count} — make them agree, or name one agent and let the count replicate it`, EXIT.usage);
      }
    } else if (agents.length === 1 && defaults?.raceAgents != null) {
      agents = Array.from({ length: defaults.raceAgents }, () => ({ ...(agents[0] as { provider: string; model: string }) }));
    }
    plannedRace = planTournament({
      agents,
      perAgentBudgetUsd: perUsd,
      totalBudgetUsd: totalUsd,
    });
    if (!plannedRace.ok) {
      return fail(write, json, "task scope", plannedRace.reason, plannedRace.message, EXIT.refused);
    }
  }

  // v24 routing flags (foundations finding 5 — these used to be silently
  // swallowed by the global parser): explicit flags resolve HERE, and an
  // explicit ask that cannot resolve refuses rather than filing unresolved.
  const routingAsked =
    text(flags, "provider") !== undefined || text(flags, "model") !== undefined || text(flags, "repair-model") !== undefined;
  let explicitProfile: ExecutionProfile | undefined;
  if (routingAsked) {
    const scopeRef = store.lookupRef(id);
    const resolvedRouting = resolveScopeProfile(
      store,
      scopeRef?.repo ?? null,
      scopeRef === null ? undefined : { agentProvider: scopeRef.agentProvider, agentModel: scopeRef.agentModel },
      { provider: text(flags, "provider"), model: text(flags, "model"), repairModel: text(flags, "repair-model") },
    );
    if (!resolvedRouting.ok) {
      return fail(write, json, "task scope", resolvedRouting.reason, resolvedRouting.problem, EXIT.usage);
    }
    explicitProfile = resolvedRouting.profile;
  }
  // The race branch shares ONE transaction with the scope save (round-6
  // finding 5): the attended exclusion refuses BEFORE anything writes, and
  // a filing failure rolls the proposal back — a refused race never leaves
  // a rewritten scope behind it.
  const filed = store.transact(():
    | { ok: true; scope: ReturnType<typeof propose> }
    | { ok: false; reason: string; message: string } => {
    if (plannedRace !== null && plannedRace.ok) {
      const raceRef = store.refFor(BUILT_IN, id);
      if (store.openAuthorizationFor(raceRef.id) !== null) {
        return {
          ok: false,
          reason: "attended-open",
          message: "an attended authorization is open on this task — revoke it before filing a tournament",
        };
      }
    }
    const proposed = propose(store, {
      taskId: id,
      goal,
      outOfScope: text(flags, "not") ?? null,
      touches,
      ...(budgetUsd === null ? {} : { budgetMicrousd: Math.round(budgetUsd * 1_000_000) }),
      ...(explicitProfile === undefined ? {} : { profile: explicitProfile }),
      now,
      mutation: mutationFrom(flags, now),
    });
    if (plannedRace !== null && plannedRace.ok) {
      const plan = plannedRace.plan;
      const raceRef = store.refFor(BUILT_IN, id);
      store.fileTournamentTerms(
        {
          taskRef: raceRef.id,
          raceDigest: plan.raceDigest,
          agents: plan.agents,
          perAgentBudgetMicrousd: plan.perAgentBudgetMicrousd,
          overrunReserveMicrousd: plan.overrunReserveMicrousd,
          totalBudgetMicrousd: plan.totalBudgetMicrousd,
          priceVersion: plan.priceVersion,
          publicationPolicy: plan.publicationPolicy,
        },
        now,
      );
    }
    if (plannedComparison !== null && plannedComparison.ok) {
      const plan = plannedComparison.plan;
      const compareRef = store.refFor(BUILT_IN, id);
      if (store.openAuthorizationFor(compareRef.id) !== null) {
        return {
          ok: false,
          reason: "attended-open",
          message: "an attended authorization is open on this task — revoke it before filing a comparison",
        };
      }
      store.fileTournamentTerms(
        {
          taskRef: compareRef.id,
          kind: "comparison",
          raceDigest: plan.comparisonDigest,
          agents: plan.agents,
          perAgentBudgetMicrousd: 0,
          overrunReserveMicrousd: 0,
          totalBudgetMicrousd: 0,
          priceVersion: 0,
          publicationPolicy: plan.publicationPolicy,
        },
        now,
      );
    }
    return { ok: true, scope: proposed };
  });
  if (!filed.ok) {
    return fail(write, json, "task scope", filed.reason, filed.message, EXIT.refused);
  }
  const scope = filed.scope;

  if (plannedComparison !== null && plannedComparison.ok) {
    const plan = plannedComparison.plan;
    return succeed(write, json, "task scope", { scope, comparison: plan }, () => [
      `Scope and comparison written for ${id}. Nothing builds until somebody approves BOTH, with one yes:`,
      ...describeScope(scope),
      "",
      ...plan.laneWords.map(lane => `  ${lane}`),
      "  no dollar caps exist on a comparison — each agent runs until it finishes or its clock ends it;",
      "  spend lands measured only where the harness reports dollars",
      "",
      `  standing-orders task approve ${id} --yes`,
    ]);
  }

  if (plannedRace !== null && plannedRace.ok) {
    const plan = plannedRace.plan;
    const worst = plan.perAgentReserveMicrousd.reduce((sum, reserve) => sum + plan.perAgentBudgetMicrousd + reserve, 0);
    return succeed(write, json, "task scope", { scope, race: plan }, () => [
      `Scope and tournament written for ${id}. Nothing builds until somebody approves BOTH, with one yes:`,
      ...describeScope(scope),
      "",
      `  tournament: ${plan.agents.map(agent => `${agent.provider} · ${agent.model}`).join("  vs  ")}`,
      `  each agent may spend $${(plan.perAgentBudgetMicrousd / 1_000_000).toFixed(2)}, plus its stated overrun reserve;` +
        ` worst case $${(worst / 1_000_000).toFixed(2)} total`,
      "",
      `  standing-orders task approve ${id} --yes`,
    ]);
  }

  return succeed(write, json, "task scope", { scope }, () => [
    `Scope written for ${id}. Nothing will build it until somebody approves it.`,
    ...describeScope(scope),
    "",
    `  standing-orders task approve ${id} --yes`,
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
    const interactiveRace = store.activeTournamentTerms(store.refFor(BUILT_IN, id).id);
    if (interactiveRace !== null) {
      write("");
      write(`  AND it starts a tournament: ${interactiveRace.n} agents build this independently —`);
      write(`  ${interactiveRace.agents.map(agent => `${agent.provider} · ${agent.model}`).join("  vs  ")}`);
      write(`  each may spend $${(interactiveRace.perAgentBudgetMicrousd / 1_000_000).toFixed(2)} plus its overrun reserve;`);
      write(`  the whole tournament is capped at $${(interactiveRace.totalBudgetMicrousd / 1_000_000).toFixed(2)}. You pick the winner; only the winner publishes.`);
    }
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
      write(envelopeJson({ ok: false, command: "task approve", reason: "unconfirmed", scope }));
      return EXIT.refused;
    }
    write(`Would approve this, and let a builder work on ${id}:`);
    write("");
    for (const line of describeScope(scope)) write(line);
    write("");
    const previewRace = store.activeTournamentTerms(store.refFor(BUILT_IN, id).id);
    if (previewRace !== null) {
      write(`  AND the tournament: ${previewRace.agents.map(agent => `${agent.provider} · ${agent.model}`).join("  vs  ")}`);
      write(`  each capped at $${(previewRace.perAgentBudgetMicrousd / 1_000_000).toFixed(2)} + reserve, total $${(previewRace.totalBudgetMicrousd / 1_000_000).toFixed(2)}`);
      write("");
    }
    write("Nothing has been approved. Agree to this exact scope with:");
    write(
      `  standing-orders task approve ${id} --yes --digest ${
        previewRace === null ? scope.digest : jointApprovalDigest(scope.digest, previewRace.raceDigest)
      } --as <you> --token <your password>`,
    );
    // Unconfirmed is "no, not yet" — exit 3 in both modes (round-4 finding 10).
    return EXIT.refused;
  }
  if (saw === undefined || asWho === undefined || token === undefined) {
    return fail(write, json, "task approve", "usage", "approving non-interactively takes --yes --digest <d> --as <you> --token <t>", EXIT.usage);
  }

  // The digest is named rather than assumed, so an operator who read one scope
  // cannot approve a different one that replaced it while they were reading.
  // The credential is required for a different reason: an agent that can run
  // these commands can read the digest out of `task show`, and an approval
  // nobody has to authenticate would let it agree to its own brief.
  //
  // A tournament task's yes covers BOTH documents (finding 31): the named
  // digest is tournament-approval/v1 = H(scope, race), and the scope and
  // the race terms approve together, in one transaction, or not at all.
  const raceTerms = store.activeTournamentTerms(store.refFor(BUILT_IN, id).id);
  if (raceTerms !== null) {
    const joint = jointApprovalDigest(scope.digest, raceTerms.raceDigest);
    if (saw !== joint && saw !== scope.digest) {
      return fail(write, json, "task approve", "changed", `this task races a tournament — approve the JOINT fingerprint: ${joint}`, EXIT.refused);
    }
    if (saw === scope.digest && !confirmedAloud) {
      return fail(write, json, "task approve", "changed", `this task races a tournament — the yes must name the joint fingerprint ${joint}, which covers the race terms too`, EXIT.refused);
    }
    const both = store.transact(() => {
      const scopeApproved = approve(store, id, asWho as string, now, scope.digest, token as string, mutationFrom(flags, now));
      if (!scopeApproved.ok) return scopeApproved;
      if (!store.approveTournamentTerms(raceTerms.id, asWho as string, raceTerms.raceDigest, now)) {
        throw new Error("the race terms changed while you were reading — nothing was approved");
      }
      return scopeApproved;
    });
    if (!both.ok) {
      return fail(write, json, "task approve", both.reason, describeApproveFailure(both.reason, id), EXIT.refused);
    }
    return succeed(write, json, "task approve", { scope: both.scope, race: raceTerms }, () => [
      `Approved — scope AND tournament, with one yes. ${raceTerms.n} agents will build ${id} independently:`,
      ...describeScope(both.scope),
      `  ${raceTerms.agents.map(agent => `${agent.provider} · ${agent.model}`).join("  vs  ")}`,
      `  each may spend $${(raceTerms.perAgentBudgetMicrousd / 1_000_000).toFixed(2)} plus its overrun reserve; total cap $${(raceTerms.totalBudgetMicrousd / 1_000_000).toFixed(2)}`,
    ]);
  }

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
    return "nobody can approve anything yet — `standing-orders approver add <you>` mints the credential that lets a person say yes";
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
  if (action !== undefined && !(APPROVER_ACTIONS as readonly string[]).includes(action)) {
    return fail(write, json, "approver", "usage", `unknown \`approver ${action}\` — try ${APPROVER_ACTIONS.join(", ")}`, EXIT.usage);
  }

  if (action === "list" || action === undefined) {
    const approvers = store.listApprovers();
    if (json) {
      write(envelopeJson({ ok: true, command: "approver list", approvers }));
      return EXIT.ok;
    }
    if (approvers.length === 0) {
      write("Nobody can approve a scope yet, so nothing can be built.");
      write("  standing-orders approver add <your name>");
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
    return fail(write, json, "task hold", "usage", "`standing-orders task hold <id> --reason <why>`", EXIT.usage);
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
  const racingGuard = refuseWhileRacing(context, "task unhold", id);
  if (racingGuard !== null) return racingGuard;

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
  write(json ? envelopeJson({ ok: true, command, ...data }) : lines().join("\n"));
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
  write(json ? envelopeJson({ ok: false, command, reason, message, ...extra }) : message);
  return code;
}

function text(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/** A running tournament owns its task (round-1 finding 5): the generic
 * doors refuse until it finishes, is picked, or is abandoned. */
function refuseWhileRacing(context: Context, command: string, taskId: string): number | null {
  const ref = context.store.lookupRef(taskId);
  if (ref === null || context.store.openContestFor(ref.id) === null) return null;
  return fail(
    context.write,
    context.json,
    command,
    "contest-open",
    "a tournament is running on this task — let it finish, then pick or abandon it from the tournament screen in the console (the task's page links to it)",
    EXIT.refused,
  );
}

/**
 * The demo fence (Codex adoption review, finding 8): a database stamped as
 * a demo sandbox NEVER spends money or touches the world outside — no
 * agent spawns, no PR, no message, no gh call. The stamp is an append-only
 * installation fact, so a kept sandbox stays fenced forever even when a
 * real worker is pointed at it by mistake. A banner is decoration; this
 * is the enforcement.
 */
/**
 * Deep links (attended A5): when a console URL is configured (`webhook set
 * console-url`), CLI answers print it beside ids so the attended eye can
 * jump. Absent configuration prints nothing — a link nobody configured is
 * a guess, and stale guesses are worse than none.
 */
function consoleLinkFor(context: Context, path: string): string | null {
  const base = loadConsoleUrl(process.env, dirname(context.databaseFile));
  if (base === null) return null;
  return `${base}${path}`;
}

function refuseDemo(context: Context, command: string): number | null {
  if (!context.store.isDemo()) return null;
  return fail(
    context.write,
    context.json,
    command,
    "demo-database",
    "this database is a demo sandbox — it never spends money or touches a remote; point this command at a real database",
    EXIT.refused,
  );
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
