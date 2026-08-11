/**
 * Running external commands.
 *
 * Two rules define this module. Arguments are passed as an array and never
 * through a shell, so a directory named `; rm -rf ~` is a string and not a
 * command. And nothing here rejects: a failed command is a value. Discovery
 * walks repos it has never seen, and one broken repo must not end the scan.
 */

import { execFile } from "node:child_process";

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
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = options;

  return new Promise(resolve => {
    execFile(
      file,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer, encoding: "utf8", shell: false, windowsHide: true },
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
