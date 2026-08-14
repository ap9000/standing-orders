/**
 * Running external commands.
 *
 * Two rules define this module. Arguments are passed as an array and never
 * through a shell, so a directory named `; rm -rf ~` is a string and not a
 * command. And nothing here rejects: a failed command is a value. Discovery
 * walks repos it has never seen, and one broken repo must not end the scan.
 */

import { execFile, spawn } from "node:child_process";

export type ExecResult = {
  /** Process exit code, or one of the synthetic codes below. */
  code: number;
  stdout: string;
  stderr: string;
  /** Killed for exceeding its timeout. */
  timedOut: boolean;
  /** Binary is not on PATH — distinct from "ran and failed", and worth saying so. */
  notFound: boolean;
};

export type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /**
   * Extra environment, merged over the process's own. A capability probe is a
   * question about an environment, and a test has to be able to construct the
   * environment the question is about.
   */
  env?: Record<string, string>;
  /**
   * Names removed from the child's environment after the merge. This exists
   * for exactly one class of variable: a secret the parent holds that the
   * child must never see — the Telegram bot token in an agent's process
   * would let the agent read and answer the operator's own decisions.
   */
  omitEnv?: readonly string[];
  /**
   * When set, the child's environment is EXACTLY these names, taken from
   * the parent where present, plus whatever `env` merges on top (audit
   * IV-5): the approved worktree setup sees an allowlist, never a clone
   * of the operator's shell with two names scrubbed.
   */
  envAllowlist?: readonly string[];
  /**
   * Run the child in its own process group and register it as a live
   * provider (M6.12). Set by the invocation gateway and nowhere else: an
   * agent harness spawns shells and tools of its own, and stopping "the
   * provider" must mean the whole tree — a kill that orphans the
   * grandchildren stops nothing. Timeout kills become group kills too.
   */
  processGroup?: boolean;
  /**
   * Called the moment the stream announces its session (codex:
   * thread.started), so a crash mid-turn cannot lose the id (M6.9 —
   * currently only the streaming transport can deliver this early).
   */
  onSessionId?: (id: string) => void;
};

/** Live provider children, for the deterministic stop. Registered only when `processGroup` was set. */
const liveProviders = new Set<import("node:child_process").ChildProcess>();

/** SIGKILL the child's whole process group; fall back to the child alone. */
function killGroup(child: import("node:child_process").ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform === "win32") {
    // Windows has no process groups to signal (Codex M5-M8 audit, IV-6):
    // taskkill /T walks the tree, so a harness's shell grandchildren die
    // with it instead of writing to the worktree after "stopped". Untested
    // on physical Windows, like the daemon — stated, not hidden.
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // taskkill missing or refused — the direct kill below still runs.
    }
  }
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // No group of ours (not detached, or already gone) — fall through.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * The hard stop (M6.12): SIGKILL every live provider's process group.
 * Called by the watch when its stop grace expires — never on the first
 * signal, which stays graceful. Late output cannot commit or publish:
 * the killed process exits nonzero, the build finalizes as the failure
 * it is, and every commit sits behind fences the corpse cannot pass.
 */
export function terminateLiveProviders(): number {
  let terminated = 0;
  for (const child of liveProviders) {
    killGroup(child);
    terminated += 1;
  }
  return terminated;
}

/** The one place a child's environment is decided (audit IV-5). */
/**
 * Chat credentials never reach a child process (Codex chat v3 review,
 * change 10): ANTHROPIC_API_KEY is the chat key AND would silently flip
 * the claude harness from subscription auth to API billing if inherited.
 * A caller that genuinely needs it re-supplies it via `env` explicitly.
 * (OPENROUTER_API_KEY is not listed: the openrouter BUILD adapter reads
 * it from the child env by design, and the agent-facing shell excludes
 * it separately via the provider's own config.)
 */
const CHAT_KEYS_NEVER_INHERITED: readonly string[] = ["ANTHROPIC_API_KEY"];

function resolveChildEnv(options: RunOptions): Record<string, string | undefined> | undefined {
  const { env, omitEnv, envAllowlist } = options;
  if (envAllowlist !== undefined) {
    const picked: Record<string, string | undefined> = {};
    for (const name of envAllowlist) {
      const value = process.env[name];
      if (value !== undefined) picked[name] = value;
    }
    Object.assign(picked, env ?? {});
    for (const name of omitEnv ?? []) delete picked[name];
    for (const name of CHAT_KEYS_NEVER_INHERITED) {
      if (env?.[name] === undefined) delete picked[name];
    }
    return picked;
  }
  const merged: Record<string, string | undefined> = { ...process.env, ...(env ?? {}) };
  for (const name of omitEnv ?? []) delete merged[name];
  for (const name of CHAT_KEYS_NEVER_INHERITED) {
    if (env?.[name] === undefined) delete merged[name];
  }
  return merged;
}

/** Conventions from the shell and from coreutils `timeout(1)`. */
export const NOT_FOUND_CODE = 127;
export const TIMEOUT_CODE = 124;
/** Output too large to hold. Not a timeout, and must not be reported as one. */
export const OVERFLOW_CODE = 125;

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

const MAX_BUFFER_ERROR = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

type ExecError = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

export function run(file: string, args: readonly string[], options: RunOptions = {}): Promise<ExecResult> {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = options;
  const childEnv = resolveChildEnv(options);

  // A provider run needs its own process group; execFile cannot give one,
  // so the buffered path detours through spawn with identical semantics.
  if (options.processGroup === true) {
    return runBufferedGroup(file, args, {
      timeoutMs,
      maxBuffer,
      ...(cwd === undefined ? {} : { cwd }),
      ...(childEnv === undefined ? {} : { childEnv }),
    });
  }

  return new Promise(resolve => {
    execFile(
      file,
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        ...(childEnv === undefined ? {} : { env: childEnv }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr, timedOut: false, notFound: false });
          return;
        }
        resolve(describeFailure(error as ExecError, stdout, stderr));
      },
    );
  });
}

/**
 * The buffered transport for process-group providers (claude): spawn
 * detached so the harness and everything it launches share one killable
 * group, collect output up to the same maxBuffer contract as execFile,
 * and register as a live provider for the watch's hard stop.
 */
function runBufferedGroup(
  file: string,
  args: readonly string[],
  bag: { cwd?: string; timeoutMs: number; maxBuffer: number; childEnv?: Record<string, string | undefined> },
): Promise<ExecResult> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        cwd: bag.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        ...(bag.childEnv === undefined ? {} : { env: bag.childEnv }),
      });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: String(error), timedOut: false, notFound: false });
      return;
    }
    liveProviders.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;
    let notFound = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, bag.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > bag.maxBuffer) {
        overflowed = true;
        killGroup(child);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < bag.maxBuffer) stderr += chunk.slice(0, bag.maxBuffer - stderr.length);
    });

    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveProviders.delete(child);
      resolve({
        code: notFound ? NOT_FOUND_CODE : overflowed ? OVERFLOW_CODE : timedOut ? TIMEOUT_CODE : (code ?? 1),
        stdout,
        stderr,
        // Overflow also killed the child; it is not a timeout and must not read as one.
        timedOut: timedOut && !overflowed,
        notFound,
      });
    };
    child.on("error", error => {
      notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (stderr === "") stderr = String(error);
      finish(null);
    });
    child.on("close", code => finish(code));
  });
}

/**
 * Turn an execFile error into a result. The order matters: a maxBuffer overflow
 * also arrives with `killed: true`, so it has to be recognised before the
 * timeout check or a truncated `git log` reads as a hung one.
 */
function describeFailure(error: ExecError, stdout: string, stderr: string): ExecResult {
  const notFound = error.code === "ENOENT";
  const overflowed = error.code === MAX_BUFFER_ERROR;
  const timedOut = !overflowed && error.killed === true;

  return {
    code: resolveCode(error, { notFound, overflowed, timedOut }),
    stdout,
    stderr: stderr === "" ? error.message : stderr,
    timedOut,
    notFound,
  };
}

function resolveCode(
  error: ExecError,
  flags: { notFound: boolean; overflowed: boolean; timedOut: boolean },
): number {
  if (typeof error.code === "number") return error.code;
  if (flags.notFound) return NOT_FOUND_CODE;
  if (flags.overflowed) return OVERFLOW_CODE;
  if (flags.timedOut) return TIMEOUT_CODE;
  return 1;
}

/**
 * The streaming transport for JSONL-emitting providers.
 *
 * A long agent session can write far more event stream than any fixed
 * buffer should hold, and the lines that matter — the session identity,
 * the terminal usage — arrive LAST. Buffering-and-overflowing would kill
 * the process at 8 MiB and lose exactly the facts a paid run must not
 * lose (Codex provider review, high finding 2). So stdout is consumed
 * incrementally and only the load-bearing lines are retained:
 *
 *   - every `thread.started` and `turn.completed` / `turn.failed` line
 *   - the LAST `item.completed` line carrying an agent_message
 *
 * each capped per line; everything else is counted and dropped. The
 * result's stdout is the retained lines joined — a synthetic, bounded
 * envelope the parser reads exactly like test fixtures.
 */
const JSONL_LINE_CAP = 64 * 1024;
const JSONL_STDERR_CAP = 64 * 1024;

export function runStreamJsonl(
  file: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const childEnv = resolveChildEnv(options);

  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        detached: options.processGroup === true && process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        ...(childEnv === undefined ? {} : { env: childEnv }),
      });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: String(error), timedOut: false, notFound: false });
      return;
    }
    if (options.processGroup === true) liveProviders.add(child);

    const kept: string[] = [];
    let lastMessage: string | null = null;
    let partial = "";
    let stderr = "";
    let timedOut = false;
    let notFound = false;

    const keep = (line: string): void => {
      if (line.length > JSONL_LINE_CAP) return; // oversized: counted absent, never truncated JSON
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const type = String(event["type"] ?? "");
        if (type === "thread.started" || type === "turn.completed" || type === "turn.failed") {
          kept.push(line);
          if (type === "thread.started" && options.onSessionId !== undefined) {
            const id = event["thread_id"];
            if (typeof id === "string" && id !== "") {
              try {
                options.onSessionId(id);
              } catch {
                // A registry that cannot be written must not kill the turn.
              }
            }
          }
        } else if (type === "item.completed") {
          const item = event["item"] as Record<string, unknown> | undefined;
          if (item !== undefined && String(item["type"] ?? "") === "agent_message") {
            lastMessage = line;
          }
        }
      } catch {
        // Not JSON: not an event; dropped.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (options.processGroup === true) killGroup(child);
      else child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      partial += chunk;
      let cut = partial.indexOf("\n");
      while (cut !== -1) {
        keep(partial.slice(0, cut));
        partial = partial.slice(cut + 1);
        cut = partial.indexOf("\n");
      }
      if (partial.length > JSONL_LINE_CAP * 2) partial = partial.slice(-JSONL_LINE_CAP);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < JSONL_STDERR_CAP) stderr += chunk.slice(0, JSONL_STDERR_CAP - stderr.length);
    });

    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveProviders.delete(child);
      if (partial.trim() !== "") keep(partial);
      const lines = lastMessage === null ? kept : [...kept, lastMessage];
      resolve({
        code: notFound ? NOT_FOUND_CODE : timedOut ? TIMEOUT_CODE : (code ?? 1),
        stdout: lines.join("\n"),
        stderr,
        timedOut,
        notFound,
      });
    };

    // A failed spawn fires 'error' and may never fire 'close' — both routes
    // settle, exactly once.
    child.on("error", error => {
      notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (stderr === "") stderr = String(error);
      finish(null);
    });
    child.on("close", code => finish(code));
  });
}
