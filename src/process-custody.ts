import type { Store } from "./store.js";
import type { ExecResult, RunOptions } from "./exec.js";

type Runner = (file: string, args: readonly string[], options?: RunOptions) => Promise<ExecResult>;

/** Reserve each spawn before the OS call. A crash before its PID is recorded
 * leaves an explicit unknown, even if earlier setup/check processes exited.
 * Only the returning transport can certify that its reserved spawn made no child.
 * Retained PIDs are read-only witnesses, never authority to signal a process.
 * A native OS object (v53) rides the same witness: named at the spawn, and
 * marked empty only when the OS proved it so — never on a transport exit. */
export function witnessedRunner(store: Store, runId: number, clock: () => Date, runner: Runner): Runner {
  return async (file, args, options = {}) => {
    const witnesses: number[] = [];
    let unknown = false;
    const result = await runner(file, args, {
      ...options,
      onDescendant: (pid, group) => {
        store.recordRunProcess(runId, pid, clock(), group);
        options.onDescendant?.(pid, group);
      },
      onUnknown: () => {
        if (!unknown) { store.reserveRunProcess(runId, clock(), true); unknown = true; }
        options.onUnknown?.();
      },
      beforeSpawn: () => {
        if (options.beforeSpawn?.() === false) return false;
        witnesses.push(store.reserveRunProcess(runId, clock(), options.processGroup === true));
        return true;
      },
      onSpawn: pid => {
        store.recordRunProcess(runId, pid, clock(), options.processGroup === true, witnesses.at(-1));
        options.onSpawn?.(pid);
      },
      onContainer: info => {
        const witness = witnesses.at(-1);
        if (witness !== undefined) store.recordRunContainer(witness, info.backend, info.id);
        options.onContainer?.(info);
      },
      onContainerEmpty: () => {
        const witness = witnesses.at(-1);
        if (witness !== undefined) store.markRunContainerEmpty(witness, clock());
        options.onContainerEmpty?.();
      },
    });
    for (const witness of witnesses) store.finishUnspawnedProcess(witness, clock());
    return result;
  };
}
