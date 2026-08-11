#!/usr/bin/env node
/**
 * The command.
 *
 * `nightorders` with no arguments reads the repositories below the working
 * directory and prints what is in flight. It writes nothing, starts nothing,
 * and asks nothing. Everything it knows comes from git and from the operator's
 * own filesystem.
 *
 * `--json` exists because half the intended audience is an agent, and an agent
 * should not have to parse a column layout.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configPath, loadRepos, saveRepos, addRepos, removeRepos } from "./repos.js";
import { discover, inspectAll, type RepoSnapshot } from "./discover.js";
import { readPulls } from "./pulls.js";
import { detectGraphs, chooseBackend, setupOptions } from "./graph.js";
import { runOperate, OPERATE_HELP, type OperateOptions } from "./operate.js";
import { renderReport, renderPulls, renderGraph, type PullGroup } from "./render.js";
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
  help: boolean;
};

export type ParseResult = { options: CliOptions } | { error: string };

type Write = (line: string) => void;

const USAGE_EXIT = 2;

export const HELP = `nightorders — standing orders for your agents

Usage
  nightorders [path...]        report what is in flight
  nightorders pulls            report what is waiting on a person
  nightorders graph            report which work graph is already here
  nightorders repos            list connected repositories, and how to adjust
  nightorders repos add <path> connect one (no path: the repo you are in)
  nightorders repos remove <path>
  nightorders link             put \`nightorders\` on your PATH
  nightorders unlink           take it off again

Operating the queue — see \`nightorders task\` for the whole surface
  nightorders ready            what could be dispatched right now
  nightorders task add <title> queue work
  nightorders claim <id> --runner <name>
  nightorders heartbeat <lease> / release <lease> / reap

With nothing connected it reports everything it can find below the working
directory. Once you connect repositories it reports those instead.

Options
  --all         report everything discoverable, ignoring connected repos
  --depth <n>   directory levels to descend (default: ${DEFAULT_MAX_DEPTH})
  --hidden      include dot-directories, which are skipped by default
  --dirty       also read each working tree for uncommitted files
  --json        emit a machine-readable envelope instead of a report
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
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--depth") {
      const depth = Number(argv[++index]);
      if (!Number.isInteger(depth) || depth < 0) {
        return { error: "--depth needs a whole number, for example `--depth 8`" };
      }
      options.maxDepth = depth;
    } else if (argument.startsWith("-")) {
      return { error: `unknown option ${argument} — try \`nightorders --help\`` };
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
const OPERATE_COMMANDS = new Set(["ready", "task", "claim", "heartbeat", "release", "reap"]);

/** binSource exists so tests can exercise linking without depending on a build. */
export type MainOptions = { binSource?: string; operate?: OperateOptions };

export async function main(
  argv: readonly string[],
  write: Write = line => console.log(line),
  mainOptions: MainOptions = {},
): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "link" || first === "unlink") {
    return runLinkCommand(first, rest, write, mainOptions.binSource);
  }
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

  const output = options.json
    ? renderJson(repos, present, missing, now)
    : renderReport(repos, { now, roots: present });

  write(output);
  return 0;
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

  if (options.json) {
    write(renderJson(snapshots, present, missing, now));
    return 0;
  }

  if (missing.length > 0) {
    for (const repo of missing) write(`${repo} is enrolled but is no longer there.`);
    write(`Drop it with \`nightorders repos remove ${missing[0]}\`.`);
    write("");
  }
  write(renderReport(snapshots, { now, roots: present }));
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
    write("No repositories connected. Night Orders reports on everything it can find.");
    write("");
    write("Connect the ones you actually work in:");
    write("  nightorders repos add ~/code/thing");
    write("  nightorders repos add            # the repo you are standing in");
    return 0;
  }

  write(`${repos.length === 1 ? "1 repository" : `${repos.length} repositories`} connected:`);
  for (const repo of repos) write(`  ${repo}${existsSync(repo) ? "" : "   (missing)"}`);
  write("");
  write("  nightorders repos add <path>      connect another");
  write("  nightorders repos remove <path>   disconnect one");
  write("  nightorders --all                 report everything, ignoring this list");
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
  write("`nightorders` now reports these. `nightorders --all` still shows everything.");
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
    write(json ? "[]" : describeMissing(missing));
    return USAGE_EXIT;
  }

  const groups: PullGroup[] = await Promise.all(
    present.map(async path => {
      const read = await readPulls(path);
      return { repo: basename(path), pulls: read.pulls, problems: read.problems };
    }),
  );

  write(json ? JSON.stringify(groups, null, 2) : renderPulls(groups, { now: new Date() }));
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
    write(json ? "[]" : describeMissing(missing));
    return USAGE_EXIT;
  }

  const detections = await detectGraphs(present);

  // The envelope carries the choice and the setup commands, not just the raw
  // detections: an agent reading this has the same question a person does —
  // what is here, what would you use, and what would I have to run.
  const envelope = {
    detections,
    choice: chooseBackend(detections),
    setup: setupOptions(),
  };

  write(json ? JSON.stringify(envelope, null, 2) : renderGraph(detections));
  return 0;
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
      return { error: `unknown option ${argument} — try \`nightorders --help\`` };
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

function renderJson(
  repos: readonly RepoSnapshot[],
  roots: readonly string[],
  missingRoots: readonly string[],
  now: Date,
): string {
  return JSON.stringify(
    { scannedAt: now.toISOString(), roots, missingRoots, repos },
    null,
    2,
  );
}

/**
 * Whether this module is the program being run, rather than an import.
 *
 * Node resolves a module to its real path while argv[1] keeps whatever name it
 * was invoked by, so a symlinked `nightorders` on PATH compares unequal to
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
