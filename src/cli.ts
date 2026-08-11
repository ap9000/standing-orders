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
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discover, type RepoSnapshot } from "./discover.js";
import { renderReport } from "./render.js";
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
  maxDepth: number;
  json: boolean;
  includeHidden: boolean;
  dirty: boolean;
  help: boolean;
};

export type ParseResult = { options: CliOptions } | { error: string };

type Write = (line: string) => void;

const USAGE_EXIT = 2;

export const HELP = `nightorders — standing orders for your agents

Usage
  nightorders [path...]        report what is in flight (default: .)
  nightorders link             put \`nightorders\` on your PATH
  nightorders unlink           take it off again

Options
  --depth <n>   directory levels to descend (default: ${DEFAULT_MAX_DEPTH})
  --all         include dot-directories, which are skipped by default
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
    maxDepth: DEFAULT_MAX_DEPTH,
    json: false,
    includeHidden: false,
    dirty: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;

    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--all") {
      options.includeHidden = true;
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

  return { options: { ...options, roots: roots.length > 0 ? roots : [process.cwd()] } };
}

/** binSource exists so tests can exercise linking without depending on a build. */
export type MainOptions = { binSource?: string };

export async function main(
  argv: readonly string[],
  write: Write = line => console.log(line),
  mainOptions: MainOptions = {},
): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "link" || first === "unlink") {
    return runLinkCommand(first, rest, write, mainOptions.binSource);
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
  const repos = await discover(options.roots, {
    scan: { maxDepth: options.maxDepth, includeHidden: options.includeHidden },
    dirty: options.dirty,
  });

  const output = options.json
    ? renderJson(repos, options.roots, now)
    : renderReport(repos, { now, roots: options.roots });

  write(output);
  return 0;
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
  const resolved = binSource === undefined ? resolveBinSource() : { source: binSource };
  if ("error" in resolved) {
    write(resolved.error);
    return USAGE_EXIT;
  }

  const choice = chooseTarget({
    pathEntries: (process.env["PATH"] ?? "").split(delimiter).filter(Boolean),
    home: homedir(),
    ...(to === undefined ? {} : { override: to }),
  });

  return command === "link"
    ? runLink(resolved.source, choice, yes, write)
    : runUnlink(choice.dir, yes, write);
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
    write(`${choice.dir} is not on your PATH. Add this to your shell profile:`);
    write(`  export PATH="${choice.dir}:$PATH"`);
  }
  return 0;
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

function renderJson(repos: readonly RepoSnapshot[], roots: readonly string[], now: Date): string {
  return JSON.stringify({ scannedAt: now.toISOString(), roots, repos }, null, 2);
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

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
