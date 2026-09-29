import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, RunOptions } from "./exec.js";
import { envTwins } from "./names.js";

export const CHILD_DATABASE_ENV = "TOOLROLL_DB";

/** Both names, so neither an ambient TOOLROLL_DB nor an older tool reading STANDING_ORDERS_DB reaches the live store. */
export function childDatabaseEnv(file: string): Record<string, string> {
  return envTwins("DB", file);
}

/** Self-hosted agents and project commands must not open their supervisor's store. */
export function isolatedChildDatabase(label: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `toolroll-${label}-`));
  return { dir, file: join(dir, "orders.db") };
}

export function removeChildDatabase(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/** Override after environment filtering, even if an ambient override names the live DB. */
export async function runWithIsolatedDatabase(
  runner: (file: string, args: readonly string[], options: RunOptions) => Promise<ExecResult>,
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<ExecResult> {
  const isolated = isolatedChildDatabase("check");
  try {
    return await runner(file, args, {
      ...options,
      env: { ...options.env, ...childDatabaseEnv(isolated.file) },
    });
  } finally {
    removeChildDatabase(isolated.dir);
  }
}
