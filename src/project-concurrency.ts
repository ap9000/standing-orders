/**
 * How many tasks of one project the service builds at once, and which
 * project gets a free slot when several are waiting.
 *
 * The number is a per-project setting an approver changes (Settings →
 * Projects, or `toolroll project concurrency <n> --repo <p>`), kept in a
 * small file beside the database and recorded in the ledger as before →
 * after. A project without a saved number builds up to two at once. The
 * worker's own capacity always caps the total: a project's number above
 * it means "as many as the worker has".
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { RUNNER_CAPACITY_MAX } from "./runner.js";

export const PROJECT_CONCURRENCY_DEFAULT = 2;

export const projectConcurrencyPath = (databaseFile: string): string => join(dirname(databaseFile), "project-concurrency.json");

/** A number as typed: a whole number from 1 to RUNNER_CAPACITY_MAX, or null. */
export function parseProjectConcurrency(value: string): number | null {
  const n = Number(value.trim());
  return value.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= RUNNER_CAPACITY_MAX ? n : null;
}

/** Every saved number, by canonical project path. An unreadable file reads as none saved. */
export function savedProjectConcurrency(databaseFile: string): Map<string, number> {
  const saved = new Map<string, number>();
  const file = projectConcurrencyPath(databaseFile);
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size > 262_144) return saved;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    const projects = value !== null && typeof value === "object" ? (value as { projects?: unknown }).projects : undefined;
    if (projects === null || typeof projects !== "object") return saved;
    for (const [repo, n] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= RUNNER_CAPACITY_MAX) saved.set(repo, n);
    }
  } catch {
    // A damaged file never stops building: every project falls back to the default.
  }
  return saved;
}

/** The project's own number: saved, or the default. */
export function projectConcurrency(databaseFile: string, repo: string): number {
  return savedProjectConcurrency(databaseFile).get(repo) ?? PROJECT_CONCURRENCY_DEFAULT;
}

/** Save one project's number atomically; returns the number before and after. */
export function saveProjectConcurrency(databaseFile: string, repo: string, n: number): { before: number; after: number } {
  const saved = savedProjectConcurrency(databaseFile);
  const before = saved.get(repo) ?? PROJECT_CONCURRENCY_DEFAULT;
  saved.set(repo, n);
  const file = projectConcurrencyPath(databaseFile);
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temp, `${JSON.stringify({ version: 1, projects: Object.fromEntries([...saved].sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
  return { before, after: n };
}

/** What a project actually gets on one worker: its number, never above the worker's capacity. */
export function effectiveConcurrency(setting: number, capacity: number): number {
  return Math.max(1, Math.min(setting, capacity));
}

/**
 * The in-process record of when each project's builder last finished a
 * pass, shared by every project loop of one service. A project that yields
 * a free slot to another waits only until that project has had a pass to
 * take it: a waiting project that cannot use the slot (a missing tool, a
 * paused provider) never holds a busy one back for long.
 */
export class ProjectPasses {
  private readonly finished = new Map<string, number>();
  private tick = 0;

  /** A monotonic stamp, so ordering never depends on the wall clock. */
  stamp(): number {
    return ++this.tick;
  }

  passed(repo: string): void {
    this.finished.set(repo, this.stamp());
  }

  lastPass(repo: string): number {
    return this.finished.get(repo) ?? 0;
  }
}

export type SlotFacts = {
  repo: string;
  /** This worker's capacity. */
  capacity: number;
  /** Builds this worker holds now, by project (the asking lane holds none). */
  running: ReadonlyMap<string, number>;
  /** Each project's own number. */
  limitOf: (repo: string) => number;
  /** Projects with work this worker could start now. */
  waiting: ReadonlySet<string>;
  /** Since when this lane has been yielding, or null. */
  yieldingSince: number | null;
  passes: ProjectPasses;
};

export type SlotAnswer = { take: true } | { take: false; why: "limit" | "capacity" | "fair-share"; to?: string };

/**
 * May a build lane of `repo` start one more task now?
 *
 * - never past the project's own number (capped by the worker's capacity);
 * - never past the worker's capacity;
 * - fair share: a project already building yields a free slot to any other
 *   project with ready work that is building fewer, until that project has
 *   had a pass to take it. A project building nothing never yields, so every
 *   project with work gets its first build ahead of another's second.
 */
export function maySlotTake(facts: SlotFacts): SlotAnswer {
  const here = facts.running.get(facts.repo) ?? 0;
  const total = [...facts.running.values()].reduce((sum, n) => sum + n, 0);
  if (here >= effectiveConcurrency(facts.limitOf(facts.repo), facts.capacity)) return { take: false, why: "limit" };
  if (total >= facts.capacity) return { take: false, why: "capacity" };
  if (here === 0) return { take: true };
  for (const other of [...facts.waiting].sort()) {
    if (other === facts.repo) continue;
    const theirs = facts.running.get(other) ?? 0;
    if (theirs >= here || theirs >= effectiveConcurrency(facts.limitOf(other), facts.capacity)) continue;
    if (facts.yieldingSince !== null && facts.passes.lastPass(other) > facts.yieldingSince) continue;
    return { take: false, why: "fair-share", to: other };
  }
  return { take: true };
}
