import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, RunOptions } from "./exec.js";

export const CHILD_DATABASE_ENV = "STANDING_ORDERS_DB";

/** Self-hosted agents and project commands must not open their supervisor's store. */
export function isolatedChildDatabase(label: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `standing-orders-${label}-`));
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
      env: { ...options.env, [CHILD_DATABASE_ENV]: isolated.file },
    });
  } finally {
    removeChildDatabase(isolated.dir);
  }
}
