/**
 * Which repositories the operator has actually committed to.
 *
 * Discovery is total and costs nothing, so it stays the way you find things.
 * Enrollment is the smaller, deliberate list: what gets reported by default,
 * and later what may be written to. Keeping the two separate is what lets the
 * first run need no configuration while the tenth run stays quiet.
 *
 * The file is plain JSON in a conventional location because someone will want
 * to edit it by hand or check it into their dotfiles — which also means it is
 * untrusted input and gets validated like any other.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CONFIG_VERSION = 1;
const DIR_NAME = "nightorders";
const FILE_NAME = "repos.json";

export type LoadResult = { repos: string[] } | { error: string };

export function configPath(env: Record<string, string | undefined>, home: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg !== undefined && xdg !== "" ? xdg : join(home, ".config");
  return join(base, DIR_NAME, FILE_NAME);
}

export async function loadRepos(file: string): Promise<LoadResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // No file yet is the ordinary first-run state, not a failure.
    return { repos: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `${file} is not valid JSON — fix or delete it` };
  }

  const repos = readRepoList(parsed);
  if (repos === null) {
    return { error: `${file} does not look like a Night Orders config — fix or delete it` };
  }
  return { repos: sortUnique(repos) };
}

export async function saveRepos(file: string, repos: readonly string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const config = { version: CONFIG_VERSION, repos: sortUnique(repos) };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function addRepos(existing: readonly string[], incoming: readonly string[]): string[] {
  return sortUnique([...existing, ...incoming]);
}

export function removeRepos(existing: readonly string[], targets: readonly string[]): string[] {
  const unwanted = new Set(targets);
  return existing.filter(repo => !unwanted.has(repo));
}

/** null when the shape is wrong; non-string entries are dropped, not trusted. */
function readRepoList(parsed: unknown): string[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const { repos } = parsed as { repos?: unknown };
  if (!Array.isArray(repos)) return null;
  return repos.filter((repo): repo is string => typeof repo === "string");
}

function sortUnique(repos: readonly string[]): string[] {
  return [...new Set(repos)].sort();
}
