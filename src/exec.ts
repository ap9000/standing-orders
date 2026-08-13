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
};

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
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER, env, omitEnv } = options;

  let childEnv: Record<string, string | undefined> | undefined;
  if (env !== undefined || (omitEnv !== undefined && omitEnv.length > 0)) {
    childEnv = { ...process.env, ...(env ?? {}) };
    for (const name of omitEnv ?? []) delete childEnv[name];
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
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env, omitEnv } = options;

  let childEnv: Record<string, string | undefined> | undefined;
  if (env !== undefined || (omitEnv !== undefined && omitEnv.length > 0)) {
    childEnv = { ...process.env, ...(env ?? {}) };
    for (const name of omitEnv ?? []) delete childEnv[name];
  }

  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(childEnv === undefined ? {} : { env: childEnv }),
      });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: String(error), timedOut: false, notFound: false });
      return;
    }

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
      child.kill("SIGKILL");
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
