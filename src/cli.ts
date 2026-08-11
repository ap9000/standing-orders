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

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discover, type RepoSnapshot } from "./discover.js";
import { renderReport } from "./render.js";
import { DEFAULT_MAX_DEPTH } from "./scan.js";

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
where listing branches takes milliseconds.`;

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

export async function main(
  argv: readonly string[],
  write: Write = line => console.log(line),
): Promise<number> {
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

function renderJson(repos: readonly RepoSnapshot[], roots: readonly string[], now: Date): string {
  return JSON.stringify({ scannedAt: now.toISOString(), roots, repos }, null, 2);
}

/** Only run when invoked as a command, so importing this module stays free. */
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
