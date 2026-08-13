#!/usr/bin/env node
/**
 * The command.
 *
 * `standing-orders` with no arguments reads the repositories below the working
 * directory and prints what is in flight. It writes nothing, starts nothing,
 * and asks nothing. Everything it knows comes from git and from the operator's
 * own filesystem.
 *
 * `--json` exists because half the intended audience is an agent, and an agent
 * should not have to parse a column layout.
 */

import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configPath, loadRepos, saveRepos, addRepos, removeRepos } from "./repos.js";
import { CAPABILITIES, ENVELOPE_VERSION, capturedEnvelope, envelopeJson, resetCapturedEnvelope } from "./envelope.js";
import { discover, inspectAll, type RepoSnapshot } from "./discover.js";
import { readPulls } from "./pulls.js";
import {
  detectGraphs,
  chooseBackend,
  setupOptions,
  LABELS as GRAPH_LABELS,
  type BackendKind,
} from "./graph.js";
import { openStore, databasePath, type Store } from "./store.js";
import type { BackendGrant } from "./grant.js";
import { runOperate, OPERATE_HELP, type OperateOptions } from "./operate.js";
import { renderReport, renderPulls, renderGraph, type PullGroup, type RemoteMap } from "./render.js";
import { readRemote } from "./remote.js";
import { DEFAULT_MAX_DEPTH } from "./scan.js";
import {
  BIN_NAME,
  chooseTarget,
  planLink,
  applyLink,
  planUnlink,
  applyUnlink,
} from "./link.js";

export type CliOptions = {
  roots: string[];
  /** Whether roots came from the command line, as opposed to the default. */
  rootsGiven: boolean;
  maxDepth: number;
  json: boolean;
  includeHidden: boolean;
  /** Report everything discoverable, ignoring the enrolled list. */
  all: boolean;
  dirty: boolean;
  /** Skip the network entirely: branches only, no pull requests or issues. */
  local: boolean;
  help: boolean;
};

export type ParseResult = { options: CliOptions } | { error: string };

type Write = (line: string) => void;

const USAGE_EXIT = 2;

export const HELP = `standing-orders — a control plane for unattended coding agents

Usage
  standing-orders [path...]        report what is in flight
  standing-orders pulls            report what is waiting on a person
  standing-orders graph            report which work graph is already here
  standing-orders repos            list connected repositories, and how to adjust
  standing-orders repos add <path> connect one (no path: the repo you are in)
  standing-orders repos remove <path>
  standing-orders link             put \`standing-orders\` on your PATH
  standing-orders unlink           take it off again
  standing-orders contract         the machine contract: envelope version + capabilities

Operating the queue — see \`standing-orders task\` for the whole surface
  standing-orders ready            what could be dispatched right now
  standing-orders task add <title> queue work
  standing-orders claim <id> --runner <name>
  standing-orders heartbeat <lease> / release <lease> / reap
  standing-orders tick --runner <name> --token <t> --repo <path>
                               one unattended pass over the ready set
  standing-orders reconcile        recover what the last stretch left behind

With nothing connected it reports everything it can find below the working
directory. Once you connect repositories it reports those instead.

Options
  --all         report everything discoverable, ignoring connected repos
  --depth <n>   directory levels to descend (default: ${DEFAULT_MAX_DEPTH})
  --hidden      include dot-directories, which are skipped by default
  --dirty       also read each working tree for uncommitted files
  --local       branches only: no network, no pull requests, no issues
  --json        emit a machine-readable envelope instead of a report
  -o <file>     also write that envelope to a file (requires --json)
  -h, --help    show this

Nothing is written, installed, or configured. Every repository is read
through git with --no-optional-locks, so a scan never contends for the
index lock with an editor you have open.

--dirty is off by default because reading a working tree is unbounded
work: on a large or cloud-synced repo \`git status\` can take minutes,
where listing branches takes milliseconds.

link shows what it would do and changes nothing; add --yes to apply it,
or --to <dir> to choose where. It never uses sudo, never leaves your
home directory, and never touches a file it did not create.`;

export function parseArgs(argv: readonly string[]): ParseResult {
  const roots: string[] = [];
  const options: CliOptions = {
    roots: [],
    rootsGiven: false,
    maxDepth: DEFAULT_MAX_DEPTH,
    json: false,
    includeHidden: false,
    all: false,
    dirty: false,
    local: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;

    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--hidden") {
      options.includeHidden = true;
    } else if (argument === "--all") {
      options.all = true;
    } else if (argument === "--dirty") {
      options.dirty = true;
    } else if (argument === "--local") {
      options.local = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--depth") {
      const depth = Number(argv[++index]);
      if (!Number.isInteger(depth) || depth < 0) {
        return { error: "--depth needs a whole number, for example `--depth 8`" };
      }
      options.maxDepth = depth;
    } else if (argument.startsWith("-")) {
      return { error: `unknown option ${argument} — try \`standing-orders --help\`` };
    } else {
      roots.push(resolve(argument));
    }
  }

  return {
    options: {
      ...options,
      roots: roots.length > 0 ? roots : [process.cwd()],
      rootsGiven: roots.length > 0,
    },
  };
}

/** The commands that operate the queue rather than report on the world. */
const OPERATE_COMMANDS = new Set([
  "ready",
  "task",
  "claim",
  "heartbeat",
  "release",
  "reap",
  "enroll",
  "grants",
  "revoke",
  "runner",
  "approver",
  "build",
  "tick",
  "cap",
  "gaps",
  "outbox",
  "brief",
  "decide",
  "incident",
  "serve",
  "watch",
  "daemon",
  "bridge",
  "publish",
  "reconcile",
  "routine",
  "config",
  "setup",
  "providers",
  "webhook",
]);

/** binSource exists so tests can exercise linking without depending on a build. */
export type MainOptions = { binSource?: string; operate?: OperateOptions };

/**
 * Strip `-o <file>` / `--output <file>` before dispatch. The flag belongs to
 * the entry point, not to any one command: after the command runs, whatever
 * envelope it serialized is copied to the file, so an agent reads its answer
 * from a path instead of scraping a terminal. Requires `--json`, because the
 * file receives the machine envelope and nothing else does.
 */
export function extractOutputFlag(
  argv: readonly string[],
): { args: string[]; outputFile?: string } | { error: string } {
  const args: string[] = [];
  let outputFile: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: `${arg} takes a file path` };
      }
      outputFile = value;
      i += 1;
      continue;
    }
    args.push(arg as string);
  }
  return { args, ...(outputFile === undefined ? {} : { outputFile }) };
}

export async function main(
  argv: readonly string[],
  write: Write = line => console.log(line),
  mainOptions: MainOptions = {},
): Promise<number> {
  const extracted = extractOutputFlag(argv);
  if ("error" in extracted) {
    write(extracted.error);
    return USAGE_EXIT;
  }
  const { args, outputFile } = extracted;
  if (outputFile !== undefined && !args.includes("--json")) {
    write("-o requires --json — the output file receives the machine envelope");
    return USAGE_EXIT;
  }

  resetCapturedEnvelope();
  const code = await dispatch(args, write, mainOptions);

  if (outputFile !== undefined) {
    const captured = capturedEnvelope();
    if (captured !== null) writeFileSync(outputFile, `${captured}\n`);
  }
  return code;
}

async function dispatch(
  argv: readonly string[],
  write: Write,
  mainOptions: MainOptions,
): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "link" || first === "unlink") {
    return runLinkCommand(first, rest, write, mainOptions.binSource);
  }
  if (first === "contract") return runContractCommand(rest, write);
  if (first === "repos") return runReposCommand(rest, write);
  if (first === "pulls") return runPullsCommand(rest, write);
  if (first === "graph") return runGraphCommand(rest, write);
  if (first !== undefined && OPERATE_COMMANDS.has(first)) {
    return runOperate(first, rest, write, mainOptions.operate ?? {});
  }

  const parsed = parseArgs(argv);

  if ("error" in parsed) {
    write(parsed.error);
    return USAGE_EXIT;
  }

  const { options } = parsed;
  if (options.help) {
    write(HELP);
    return 0;
  }

  const now = new Date();

  // An enrolled list is a decision the operator already made; honour it unless
  // they asked otherwise by naming paths or passing --all.
  const enrolled = await loadRepos(configFile());
  if ("error" in enrolled) {
    write(enrolled.error);
    return 1;
  }
  if (!options.all && !options.rootsGiven && enrolled.repos.length > 0) {
    return reportEnrolled(enrolled.repos, options, now, write);
  }

  const { present, missing } = partitionRoots(options.roots, existsSync);

  // A path that does not exist is a typo, not an empty search, and saying
  // "no repositories found" about it would be answering a question we never
  // asked. Warnings go inside the envelope in JSON mode so it stays parseable.
  if (present.length === 0) {
    write(options.json ? renderJson([], options.roots, missing, now) : describeMissing(missing));
    return USAGE_EXIT;
  }
  if (missing.length > 0 && !options.json) {
    write(describeMissing(missing));
    write("");
  }

  const repos = await discover(present, {
    scan: { maxDepth: options.maxDepth, includeHidden: options.includeHidden },
    dirty: options.dirty,
  });
  const remote = await maybeReadRemote(repos, options);

  const output = options.json
    ? renderJson(repos, present, missing, now, remote)
    : renderReport(repos, { now, roots: present, ...(remote === undefined ? {} : { remote }) });

  write(output);
  return 0;
}

/**
 * Pull requests and issues, unless the operator asked to stay local.
 *
 * Reading them is the difference between "every branch in flight" and "every
 * branch, pull request and issue in flight", which is what the milestone asks
 * for — but it is also the only part of this report that touches the network,
 * so it is bounded and `--local` turns it off entirely.
 */
async function maybeReadRemote(
  repos: readonly RepoSnapshot[],
  options: CliOptions,
): Promise<RemoteMap | undefined> {
  if (options.local) return undefined;
  return readRemote(repos.map(repo => ({ path: repo.path, remoteUrl: repo.remoteUrl })));
}

function configFile(): string {
  return configPath(process.env, homedir());
}

/**
 * Report the enrolled repositories directly. A path that has since been moved
 * or deleted is named rather than silently dropped — a list that quietly
 * shrinks is worse than one that tells you it is stale.
 */
async function reportEnrolled(
  repos: readonly string[],
  options: CliOptions,
  now: Date,
  write: Write,
): Promise<number> {
  const { present, missing } = partitionRoots(repos, existsSync);
  const snapshots = await inspectAll(present, { dirty: options.dirty });
  const remote = await maybeReadRemote(snapshots, options);

  if (options.json) {
    write(renderJson(snapshots, present, missing, now, remote));
    return 0;
  }

  if (missing.length > 0) {
    for (const repo of missing) write(`${repo} is enrolled but is no longer there.`);
    write(`Drop it with \`standing-orders repos remove ${missing[0]}\`.`);
    write("");
  }
  write(
    renderReport(snapshots, {
      now,
      roots: present,
      ...(remote === undefined ? {} : { remote }),
    }),
  );
  return 0;
}

export function partitionRoots(
  roots: readonly string[],
  exists: (path: string) => boolean,
): { present: string[]; missing: string[] } {
  return {
    present: roots.filter(exists),
    missing: roots.filter(root => !exists(root)),
  };
}

function describeMissing(missing: readonly string[]): string {
  return missing.map(root => `${root} does not exist — check the path.`).join("\n");
}

/**
 * `repos` with no arguments lists what is connected and shows how to change
 * it, so the way to adjust the list is visible at the moment you are looking
 * at it — rather than being something you have to remember a flag for.
 */
async function runReposCommand(argv: readonly string[], write: Write): Promise<number> {
  const [action, ...paths] = argv;
  const file = configFile();
  const loaded = await loadRepos(file);
  if ("error" in loaded) {
    write(loaded.error);
    return 1;
  }

  if (action === undefined) return listRepos(loaded.repos, file, write);
  if (action !== "add" && action !== "remove") {
    write(`unknown command \`repos ${action}\` — try \`repos\`, \`repos add\`, or \`repos remove\``);
    return USAGE_EXIT;
  }

  // `repos add` with no path means the repository you are standing in.
  const targets = (paths.length > 0 ? paths : [process.cwd()]).map(path => resolve(path));
  return action === "add"
    ? addToRepos(loaded.repos, targets, file, write)
    : removeFromRepos(loaded.repos, targets, file, write);
}

function listRepos(repos: readonly string[], file: string, write: Write): number {
  if (repos.length === 0) {
    write("No repositories connected. Standing Orders reports on everything it can find.");
    write("");
    write("Connect the ones you actually work in:");
    write("  standing-orders repos add ~/code/thing");
    write("  standing-orders repos add            # the repo you are standing in");
    return 0;
  }

  write(`${repos.length === 1 ? "1 repository" : `${repos.length} repositories`} connected:`);
  for (const repo of repos) write(`  ${repo}${existsSync(repo) ? "" : "   (missing)"}`);
  write("");
  write("  standing-orders repos add <path>      connect another");
  write("  standing-orders repos remove <path>   disconnect one");
  write("  standing-orders --all                 report everything, ignoring this list");
  write(`  ${file}`);
  return 0;
}

async function addToRepos(
  existing: readonly string[],
  targets: readonly string[],
  file: string,
  write: Write,
): Promise<number> {
  // Enrolling something that is not a repository would fail later and further
  // away, so it fails here instead.
  const rejected = targets.filter(path => !existsSync(join(path, ".git")));
  if (rejected.length > 0) {
    for (const path of rejected) write(`${path} is not a git repository.`);
    return USAGE_EXIT;
  }

  const added = targets.filter(path => !existing.includes(path));
  await saveRepos(file, addRepos(existing, targets));

  if (added.length === 0) {
    write(`Already connected: ${targets.join(", ")}`);
    return 0;
  }
  for (const path of added) write(`Connected ${path}`);
  write("");
  write("`standing-orders` now reports these. `standing-orders --all` still shows everything.");
  return 0;
}

async function removeFromRepos(
  existing: readonly string[],
  targets: readonly string[],
  file: string,
  write: Write,
): Promise<number> {
  const removed = targets.filter(path => existing.includes(path));
  if (removed.length === 0) {
    write(`Not connected: ${targets.join(", ")}`);
    return 0;
  }

  await saveRepos(file, removeRepos(existing, targets));
  for (const path of removed) write(`Disconnected ${path}`);
  return 0;
}

/**
 * `pulls` reads the same repositories the default report does, because the
 * question "what is waiting on me" is asked about the same set of work. It is
 * a separate command rather than part of the report because it costs a network
 * round trip per repository, and the default report is meant to stay local.
 */
async function runPullsCommand(argv: readonly string[], write: Write): Promise<number> {
  const json = argv.includes("--json");
  const unknown = argv.find(argument => argument.startsWith("-") && argument !== "--json");
  if (unknown !== undefined) {
    write(`unknown option ${unknown} — \`pulls\` takes paths and --json`);
    return USAGE_EXIT;
  }

  const named = argv.filter(argument => !argument.startsWith("-")).map(path => resolve(path));
  const targets = named.length > 0 ? named : await defaultPullTargets(write);
  if (targets === null) return 1;

  const { present, missing } = partitionRoots(targets, existsSync);
  if (present.length === 0) {
    write(json ? envelopeJson({ ok: false, command: "pulls", reason: "no-repositories", message: describeMissing(missing), groups: [] }) : describeMissing(missing));
    return USAGE_EXIT;
  }

  const groups: PullGroup[] = await Promise.all(
    present.map(async path => {
      const read = await readPulls(path);
      return { repo: basename(path), pulls: read.pulls, problems: read.problems };
    }),
  );

  write(
    json
      ? envelopeJson({ ok: true, command: "pulls", count: groups.length, groups })
      : renderPulls(groups, { now: new Date() }),
  );
  return 0;
}

/**
 * `graph` answers "what work graph is already here", which is the question
 * standing between discovery and anything autonomous. It reads the same
 * repositories the report does, and like everything else in M0 it writes
 * nothing: detection is not authorization.
 */
async function runGraphCommand(argv: readonly string[], write: Write): Promise<number> {
  const json = argv.includes("--json");
  const unknown = argv.find(argument => argument.startsWith("-") && argument !== "--json");
  if (unknown !== undefined) {
    write(`unknown option ${unknown} — \`graph\` takes paths and --json`);
    return USAGE_EXIT;
  }

  const named = argv.filter(argument => !argument.startsWith("-")).map(path => resolve(path));
  const targets = named.length > 0 ? named : await defaultPullTargets(write);
  if (targets === null) return 1;

  const { present, missing } = partitionRoots(targets, existsSync);
  if (present.length === 0) {
    write(json ? envelopeJson({ ok: false, command: "graph", reason: "no-repositories", message: describeMissing(missing), detections: [] }) : describeMissing(missing));
    return USAGE_EXIT;
  }

  const detections = await detectGraphs(present);

  // An enrolled backend outranks anything detection would have picked — the
  // ladder's first rung, and now reachable because grants are persisted. An
  // operator who already said which one must not be re-asked because a second
  // tracker turned up somewhere else on the machine.
  const enrolled = enrolledBackend(present);

  // The envelope carries the choice and the setup commands, not just the raw
  // detections: an agent reading this has the same question a person does —
  // what is here, what would you use, and what would I have to run.
  const envelope = {
    detections,
    choice: chooseBackend(detections, enrolled === undefined ? {} : { enrolled }),
    setup: setupOptions(),
  };

  write(
    json
      ? envelopeJson({ ok: true, command: "graph", ...envelope })
      : renderGraph(detections, enrolled === undefined ? {} : { enrolled }),
  );
  return 0;
}

/**
 * The backend enrolled for any of these repositories, if one is.
 *
 * Read-only and failure-tolerant on purpose: `graph` is a reporting command,
 * and a queue that cannot be opened must degrade to plain detection rather
 * than take the report down with it.
 */
function enrolledBackend(repos: readonly string[]): BackendKind | undefined {
  let store: Store;
  try {
    store = openStore(databasePath(process.env, homedir()));
  } catch {
    return undefined;
  }
  try {
    const wanted = new Set(repos);
    const grant = store.listGrants().find((one: BackendGrant) => wanted.has(one.repo));
    // A grant may name the built-in store, which detection never reports, so
    // only a backend the graph report knows about is passed through.
    return grant !== undefined && isBackendKind(grant.backend) ? grant.backend : undefined;
  } finally {
    store.close();
  }
}

function isBackendKind(name: string): name is BackendKind {
  return Object.prototype.hasOwnProperty.call(GRAPH_LABELS, name);
}

/** null means the configuration could not be read, and was already reported. */
async function defaultPullTargets(write: Write): Promise<string[] | null> {
  const enrolled = await loadRepos(configFile());
  if ("error" in enrolled) {
    write(enrolled.error);
    return null;
  }
  return enrolled.repos.length > 0 ? enrolled.repos : [process.cwd()];
}

export type LinkArgs = { to?: string; yes: boolean };

export function parseLinkArgs(argv: readonly string[]): { args: LinkArgs } | { error: string } {
  const args: LinkArgs = { yes: false };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (argument === "--yes" || argument === "-y") {
      args.yes = true;
    } else if (argument === "--to") {
      const dir = argv[++index];
      if (dir === undefined) return { error: "--to needs a directory" };
      args.to = dir;
    } else {
      return { error: `unknown option ${argument} — try \`standing-orders --help\`` };
    }
  }

  return { args };
}

/**
 * Both halves show their work before doing it. Nothing changes without --yes,
 * which is the same courtesy this tool extends to `bd init`.
 */
async function runLinkCommand(
  command: "link" | "unlink",
  argv: readonly string[],
  write: Write,
  binSource: string | undefined,
): Promise<number> {
  const parsed = parseLinkArgs(argv);
  if ("error" in parsed) {
    write(parsed.error);
    return USAGE_EXIT;
  }

  const { to, yes } = parsed.args;

  const choice = chooseTarget({
    pathEntries: (process.env["PATH"] ?? "").split(delimiter).filter(Boolean),
    home: homedir(),
    ...(to === undefined ? {} : { override: to }),
  });

  // Only `link` needs something to point at. Demanding a build before you are
  // allowed to uninstall would strand anyone whose dist/ has been cleaned.
  if (command === "unlink") return runUnlink(choice.dir, yes, write);

  const resolved = binSource === undefined ? resolveBinSource() : { source: binSource };
  if ("error" in resolved) {
    write(resolved.error);
    return USAGE_EXIT;
  }

  return runLink(resolved.source, choice, yes, write);
}

/**
 * A link must point at the built command. Running through tsx puts us in
 * src/, so resolve across to dist/ rather than linking a file node cannot run.
 */
function resolveBinSource(): { source: string } | { error: string } {
  const here = fileURLToPath(import.meta.url);
  const source = here.endsWith(".ts") ? resolve(dirname(here), "..", "dist", "cli.js") : here;

  if (!existsSync(source)) {
    return { error: "Run `npm run build` first — there is no built command to link to yet." };
  }
  return { source };
}

async function runLink(
  source: string,
  choice: { dir: string; onPath: boolean },
  yes: boolean,
  write: Write,
): Promise<number> {
  const plan = await planLink(source, choice.dir);

  if (plan.action === "conflict") {
    write(`${plan.target}: ${plan.reason}.`);
    write("Remove it yourself if you want it gone, or use --to <dir> to link elsewhere.");
    return 1;
  }
  if (plan.action === "already") {
    write(`Already linked: ${plan.target} → ${plan.source}`);
    return 0;
  }

  write(plan.action === "replace" ? `Will replace ${plan.target}` : `Will create ${plan.target}`);
  write(`             → ${plan.source}`);
  if (plan.action === "replace") write(`   (it currently points at ${plan.current})`);

  if (!yes) {
    write("");
    write("Nothing has been written. Re-run with --yes to do it.");
    return 0;
  }

  try {
    await applyLink(plan);
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }

  write("");
  write(`Linked. \`${BIN_NAME}\` is now a command.`);
  if (!choice.onPath) {
    write("");
    write(`${choice.dir} is not on your PATH. ${describePathFix(choice.dir)}`);
  }
  return 0;
}

/**
 * The instruction has to be one the operator can paste into the shell they are
 * actually in. `export` is meaningless in PowerShell, and the separator between
 * PATH entries is not `:` everywhere.
 */
function describePathFix(dir: string): string {
  if (process.platform === "win32") {
    return [
      "Add it for this session:",
      `  $env:PATH = "${dir}${delimiter}$env:PATH"`,
      "or permanently, for your user only:",
      `  setx PATH "${dir}${delimiter}%PATH%"`,
    ].join("\n");
  }
  return ["Add this to your shell profile:", `  export PATH="${dir}${delimiter}$PATH"`].join("\n");
}

async function runUnlink(dir: string, yes: boolean, write: Write): Promise<number> {
  const plan = await planUnlink(dir);

  if (plan.action === "absent") {
    write(`Nothing to remove: ${plan.target} does not exist.`);
    return 0;
  }
  if (plan.action === "foreign") {
    write(`${plan.target}: ${plan.reason}. Leaving it alone.`);
    return 1;
  }

  write(`Will remove ${plan.target} → ${plan.current}`);
  if (!yes) {
    write("");
    write("Nothing has been removed. Re-run with --yes to do it.");
    return 0;
  }

  await applyUnlink(plan);
  write("");
  write("Removed.");
  return 0;
}

/**
 * `contract` is the machine contract, stated by the machine: the envelope
 * version and the capability tokens an agent consumer can feature-detect on.
 * Behaviors, not versions — consumers ignore tokens they do not recognize.
 */
function runContractCommand(argv: readonly string[], write: Write): number {
  const json = argv.includes("--json");
  if (json) {
    write(envelopeJson({ ok: true, command: "contract", capabilities: [...CAPABILITIES] }));
    return 0;
  }
  write(`standing-orders machine contract — envelope v${ENVELOPE_VERSION}`);
  write("");
  write("Every --json answer is one envelope on stdout: { envelopeVersion, ok,");
  write("command, ... } — failures add a stable `reason` token and a human");
  write("`message`. Consumers must ignore keys and capabilities they do not");
  write("recognize.");
  write("");
  write("Capabilities:");
  for (const capability of CAPABILITIES) write(`  ${capability}`);
  return 0;
}

/**
 * The machine-readable envelope. Remote state is folded into each repository
 * rather than sitting in a parallel map, so a consumer never has to join two
 * collections to answer "what is happening in this repo" — and `remoteRead`
 * says whether the absence of pull requests means none or means we did not ask.
 */
function renderJson(
  repos: readonly RepoSnapshot[],
  roots: readonly string[],
  missingRoots: readonly string[],
  now: Date,
  remote?: RemoteMap,
): string {
  const withRemote = repos.map(repo => {
    const state = remote?.get(repo.path);
    return {
      ...repo,
      pulls: state?.pulls ?? [],
      issues: state?.issues ?? [],
      // Per repository, not only at the top level. An empty `pulls` means
      // three different things — none open, not asked, or asked and failed —
      // and a consumer should not have to join two parts of the envelope to
      // find out which.
      pullsRead: state?.pullsRead ?? false,
      issuesRead: state?.issuesRead ?? false,
      remoteSkipped: state?.skipped ?? false,
      remoteProblems: state?.problems ?? [],
    };
  });

  return envelopeJson({
    ok: true,
    command: "scan",
    scannedAt: now.toISOString(),
    roots,
    missingRoots,
    remoteRead: remote !== undefined,
    repos: withRemote,
  });
}

/**
 * Whether this module is the program being run, rather than an import.
 *
 * Node resolves a module to its real path while argv[1] keeps whatever name it
 * was invoked by, so a symlinked `standing-orders` on PATH compares unequal to
 * itself unless both sides are resolved. Getting this wrong is silent: the
 * command runs, prints nothing, and exits 0.
 */
export function isDirectInvocation(
  moduleUrl: string,
  entry: string | undefined,
  toRealPath: (path: string) => string = realpathSync,
): boolean {
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(toRealPath(entry)).href;
  } catch {
    return false;
  }
}

/**
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` to
 * stderr the first time the store is opened. One line is fair warning; one
 * line per invocation, in a dispatch loop that runs the command thousands of
 * times overnight, is a log nobody can read.
 *
 * It is filtered here and nowhere else. This runs only when the CLI is the
 * program — a process it legitimately owns — so importing any of these modules
 * as a library still leaves the host's warnings exactly as they were. The
 * mechanism matters too: wrapping `process.emitWarning`, which is what Node's
 * own experimental notice goes through, leaves every `warning` listener anyone
 * else registered working normally. An earlier attempt swapped the listeners
 * themselves and quietly made everybody's `once` permanent.
 */
function hushExperimentalSqlite(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string })?.type;
    const text = warning instanceof Error ? warning.message : String(warning);
    if (type === "ExperimentalWarning" && text.includes("SQLite")) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  hushExperimentalSqlite();
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
