import { execFileSync, type ChildProcess } from "node:child_process";

type ProcessRow = { pid: number; parent: number; group: number };
export type ProcessTreeObserver = { onDescendant?: (pid: number, group: boolean) => void; onUnknown?: () => void };
const observed = new Map<ChildProcess, { observer: ProcessTreeObserver; seen: Set<number> }>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Read identifiers only: command lines can contain private provider inputs. */
function snapshot(): ProcessRow[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024 })
    .trim().split("\n").map(line => {
      const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
      if (!pid || !Number.isSafeInteger(pid) || parent === undefined || group === undefined) throw new Error("unreadable process ancestry");
      return { pid, parent, group };
    });
}
function descendants(rows: ProcessRow[], root: number): ProcessRow[] {
  const ids = new Set([root]);
  const found: ProcessRow[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (!ids.has(row.pid) && ids.has(row.parent)) {
      ids.add(row.pid); found.push(row); changed = true;
    }
  }
  return found;
}
function live(child: ChildProcess): boolean { return child.pid !== undefined && child.exitCode === null && child.signalCode === null; }
function remember(child: ChildProcess, rows: ProcessRow[]): void {
  const tracked = observed.get(child);
  if (!tracked) return;
  for (const row of rows) if (!tracked.seen.has(row.pid)) {
    tracked.observer.onDescendant?.(row.pid, row.group === row.pid);
    tracked.seen.add(row.pid);
  }
}
function uncertain(child: ChildProcess): void {
  // A failed observation must not become an uncaught timer exception. The
  // persistent witness is attempted once by custody; the run remains fenced.
  try { observed.get(child)?.observer.onUnknown?.(); } catch {}
}

/** Observe escaped process groups while their ancestry is still provable.
 * Durable witnesses prevent recovery from mistaking a dead harness for a dead
 * shell. They never grant permission to send a signal after worker recovery. */
export function observeProcessTree(child: ChildProcess, observer: ProcessTreeObserver): void {
  if (process.platform === "win32" || observer.onDescendant === undefined) return;
  observed.set(child, { observer, seen: new Set() });
  child.once("close", () => {
    observed.delete(child);
    if (observed.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
  });
  if (timer !== null) return;
  timer = setInterval(() => {
    try {
      const rows = snapshot();
      for (const [one] of observed) if (live(one)) remember(one, descendants(rows, one.pid!));
    } catch {
      for (const [one] of observed) if (live(one)) uncertain(one);
    }
  }, 500);
  timer.unref();
}

/** Freeze the owned handle, then its live descendants before killing them.
 * Claude's tool shells create new process groups, so killing only -rootPid
 * leaves writers behind. Re-scan after freezing parents to catch a child born
 * during the previous scan. Every target comes from current ancestry of the
 * still-owned handle, never from a saved PID. Unknown ancestry stays blocked. */
export function stopProcessTree(child: ChildProcess): boolean {
  if (process.platform === "win32" || !live(child)) return false;
  const stopped = new Set<number>();
  try {
    if (!child.kill("SIGSTOP")) return false;
    for (let pass = 0; pass < 8; pass++) {
      const rows = descendants(snapshot(), child.pid!);
      remember(child, rows);
      const fresh = rows.filter(row => !stopped.has(row.pid));
      if (fresh.length === 0) {
        // Parents are frozen, so none can fork between this seal and kill.
        for (const row of rows.reverse()) { try { process.kill(row.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
        child.kill("SIGKILL");
        return true;
      }
      for (const row of fresh) {
        try { process.kill(row.pid, "SIGSTOP"); stopped.add(row.pid); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
    throw new Error("process ancestry did not settle");
  } catch {
    uncertain(child);
    // Do not leave any process frozen after a failed observation. The caller
    // can still stop its known group; unresolved custody prevents Resume.
    for (const pid of stopped) { try { process.kill(pid, "SIGCONT"); } catch {} }
    try { child.kill("SIGCONT"); } catch {}
    return false;
  }
}
