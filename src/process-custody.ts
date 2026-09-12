import type { Store } from "./store.js";
import type { ExecResult, RunOptions } from "./exec.js";

type Runner = (file: string, args: readonly string[], options?: RunOptions) => Promise<ExecResult>;

/** Reserve each spawn before the OS call. A crash before its PID is recorded
 * leaves an explicit unknown, even if earlier setup/check processes exited.
 * Only the returning transport can certify that its reserved spawn made no child.
 * Retained PIDs are read-only witnesses, never authority to signal a process. */
export function witnessedRunner(store: Store, runId: number, clock: () => Date, runner: Runner): Runner {
  return async (file, args, options = {}) => {
    const witnesses: number[] = [];
    const result = await runner(file, args, {
      ...options,
      beforeSpawn: () => {
        if (options.beforeSpawn?.() === false) return false;
        witnesses.push(store.reserveRunProcess(runId, clock(), options.processGroup === true));
        return true;
      },
      onSpawn: pid => {
        store.recordRunProcess(runId, pid, clock(), options.processGroup === true, witnesses.at(-1));
        options.onSpawn?.(pid);
      },
    });
    for (const witness of witnesses) store.finishUnspawnedProcess(witness, clock());
    return result;
  };
}
