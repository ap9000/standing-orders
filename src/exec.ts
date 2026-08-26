/**
 * Running external commands.
 *
 * Two rules define this module. Arguments are passed as an array and never
 * through a shell, so a directory named `; rm -rf ~` is a string and not a
 * command. And nothing here rejects: a failed command is a value. Discovery
 * walks repos it has never seen, and one broken repo must not end the scan.
 */

import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  /** Fires once the child exists, with its pid (the process-group id when
   * processGroup is set) — the slot ledger records it (v14 finding 26). */
  onSpawn?: (pid: number) => void;
  /**
   * Every parsed stream event, as it arrives (claude's streaming transport
   * only). Purely observational: exceptions are caught and counted, and
   * nothing about the run — retention, timeout, exit — changes because a
   * listener misbehaved. The live window renders these; nothing else may.
   */
  onStreamEvent?: (event: Record<string, unknown>) => void;
  /**
   * Fires ONCE, the moment the stream proves the prompt reached the agent
   * (arc 1 finding 11): the first top-level assistant event, or a
   * successful primary result when no assistant event preceded it. Error
   * results never fire it — a startup death is not a delivery. Latched
   * before invocation, so a throwing listener cannot make it fire twice.
   */
  onReceipt?: () => void;
};

/** Live provider children, for the deterministic stop. Registered only when `processGroup` was set. */
const liveProviders = new Set<import("node:child_process").ChildProcess>();

/**
 * Live held-session SUPERVISORS (v6 W7). Not in liveProviders: SIGKILLing a
 * supervisor's group would orphan the agent living in its own fresh group.
 * The sweep's contract here is SIGTERM first — the supervisor's handler
 * fences its child (EOF → grace → group SIGKILL) — and SIGKILL only on a
 * repeat sweep, which is the one road that can orphan an agent and is why
 * it is the escalation, never the opener.
 */
const heldSupervisors = new Map<import("node:child_process").ChildProcess, "fresh" | "termed">();

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
  // Held supervisors take the graceful road first (v6 W7): SIGTERM makes
  // the supervisor fence its own agent race-free through the handle only
  // it holds. A second sweep escalates to SIGKILL — the documented
  // residual hole, reachable only by double-escalation, with the startup
  // orphan fence paging for anything that lingers.
  for (const [supervisor, stage] of heldSupervisors) {
    try {
      if (stage === "fresh") {
        supervisor.kill("SIGTERM");
        heldSupervisors.set(supervisor, "termed");
      } else {
        supervisor.kill("SIGKILL");
      }
    } catch {
      // Already gone.
    }
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
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
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
  bag: { cwd?: string; timeoutMs: number; maxBuffer: number; childEnv?: Record<string, string | undefined>; onSpawn?: (pid: number) => void },
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
      if (child.pid !== undefined) bag.onSpawn?.(child.pid);
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
      if (child.pid !== undefined) options.onSpawn?.(child.pid);
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

/**
 * The streaming transport for claude's stream-json dialect (arc 1).
 *
 * Same rationale as `runStreamJsonl`: a long agent session writes far more
 * event stream than any fixed buffer should hold, and the line that matters
 * — the terminal result carrying session, usage, and dollars — arrives
 * LAST. The 8 MiB buffered kill would destroy exactly that accounting
 * envelope, so stdout is consumed incrementally and only the load-bearing
 * lines are retained:
 *
 *   - the FIRST `system`/`init` event (the harness came up — claude's
 *     init signal, the classification codex always had)
 *   - the FIRST primary `result` event, selected STRUCTURALLY (finding 10):
 *     origin absent or `origin.kind === "human"` — an allowlist, so a
 *     background task's result (or any future origin kind) can never be
 *     mistaken for the main query's accounting. Later results are dropped.
 *
 * The result's stdout is the retained lines joined — a synthetic, bounded
 * envelope `claudeParse` reads exactly like test fixtures. Timeout,
 * process-group, kill, and spawn semantics match `runStreamJsonl`.
 */
function primaryResultOrigin(event: Record<string, unknown>): boolean {
  const origin = event["origin"];
  if (origin === undefined || origin === null) return true;
  if (typeof origin === "object" && String((origin as Record<string, unknown>)["kind"] ?? "") === "human") return true;
  return false; // task-notification, channel, peer, coordinator, unknown: never the envelope
}

export function runClaudeStreamJsonl(
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
      if (child.pid !== undefined) options.onSpawn?.(child.pid);
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: String(error), timedOut: false, notFound: false });
      return;
    }
    if (options.processGroup === true) liveProviders.add(child);

    let initLine: string | null = null;
    let resultLine: string | null = null;
    let receiptFired = false;
    let partial = "";
    let stderr = "";
    let timedOut = false;
    let notFound = false;

    // Latch BEFORE invoking (finding 13): a throwing listener has already
    // consumed its one firing, and the stream goes on unharmed.
    const fireReceipt = (): void => {
      if (receiptFired || options.onReceipt === undefined) {
        receiptFired = true;
        return;
      }
      receiptFired = true;
      try {
        options.onReceipt();
      } catch {
        // A receipt that cannot be recorded must not alter the run; the
        // note stays honestly unreceipted and re-attaches later.
      }
    };

    const keep = (line: string): void => {
      if (line.length > JSONL_LINE_CAP) return; // oversized: counted absent, never truncated JSON
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // not JSON: not an event; dropped
      }
      if (event === null || typeof event !== "object") return;
      const type = String(event["type"] ?? "");
      if (type === "system" && String(event["subtype"] ?? "") === "init") {
        if (initLine === null) {
          initLine = line;
          if (options.onSessionId !== undefined) {
            const id = event["session_id"];
            if (typeof id === "string" && id !== "") {
              try {
                options.onSessionId(id);
              } catch {
                // A registry that cannot be written must not kill the turn.
              }
            }
          }
        }
      } else if (type === "assistant") {
        // Top-level only (finding 11): assistant events carry no origin;
        // parent_tool_use_id is the correlation field, and a subagent's
        // words prove nothing about the main prompt.
        const parent = event["parent_tool_use_id"];
        if (parent === undefined || parent === null) fireReceipt();
      } else if (type === "result" && resultLine === null && primaryResultOrigin(event)) {
        resultLine = line;
        // Fallback receipt (finding 11): a SUCCESSFUL main-query completion
        // entails the prompt ran even if the stream elided assistant
        // events. Error results never fire — startup death is not delivery.
        if (event["is_error"] !== true && String(event["subtype"] ?? "") === "success") fireReceipt();
      }
      if (options.onStreamEvent !== undefined) {
        try {
          options.onStreamEvent(event);
        } catch {
          // Observational only: a broken listener never touches the run.
        }
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
      const lines = [initLine, resultLine].filter((one): one is string => one !== null);
      resolve({
        code: notFound ? NOT_FOUND_CODE : timedOut ? TIMEOUT_CODE : (code ?? 1),
        stdout: lines.join("\n"),
        stderr,
        timedOut,
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

// ---- the held session transport (Parity II Phase 2, spec v2 S0a + v6 W9) ----

/**
 * Where the supervisor script lives: a plain-.mjs sibling of this module in
 * BOTH layouts (src/ under tsx, dist/ after build — postbuild copies it).
 */
export function supervisorPath(): string {
  return fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
}

/**
 * Darwin's sun_path is 104 bytes including the terminator; Linux allows a
 * hair more. Refusing at spawn beats failing inside bind() with a raw
 * ENAMETOOLONG after custody was already recorded.
 */
export const HELD_SOCKET_PATH_LIMIT = 103;

export function heldSocketPathProblem(path: string): string | null {
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes > HELD_SOCKET_PATH_LIMIT) {
    return `the control socket path is ${bytes} bytes — the platform limit is ${HELD_SOCKET_PATH_LIMIT}: ${path}`;
  }
  return null;
}

export type HeldSessionEvents = {
  /** The nth system/init observed (1-based) — acceptance of the nth written turn. */
  onTurnInit?: (seq: number) => void;
  /** The nth primary-origin result (1-based) — settlement material for the nth turn. */
  onTurnResult?: (seq: number, event: Record<string, unknown>) => void;
  /** Every parsed stream event, arc-1 isolation rules unchanged. */
  onStreamEvent?: (event: Record<string, unknown>) => void;
  onSessionId?: (id: string) => void;
  /** The supervisor exited: the hold is over, however it ended. */
  onExit?: (info: { code: number | null }) => void;
};

export type HeldSessionHandle = {
  supervisorPid: number | null;
  agentPgid: number | null;
  /** One turn as a stream-json line. False = the pipe is gone; nothing was written. */
  writeTurn(json: string): boolean;
  /** The EOF road: the supervisor fences (EOF → grace → group kill) on its own. */
  endInput(): void;
  /** SIGTERM the supervisor — the same fence, for expiry/revocation/lapse. */
  terminate(): void;
  /** Last resort only: SIGKILL the supervisor itself (can orphan the agent). */
  killHard(): void;
  exited: Promise<{ code: number | null }>;
};

export type HeldSessionStart =
  | { ok: true; handle: HeldSessionHandle }
  | { ok: false; reason: "socket-path" | "spawn-failed" | "ready-timeout"; message: string };

/**
 * Hold one claude process open across stream-json turns, under a
 * supervisor whose parenthood makes the eventual kill provable. Returns
 * once the supervisor's control frame settles the spawn either way.
 *
 * No timers live here: the per-turn wall deadline, liveness lapse, and
 * absolute expiry are the coordinator's exact timers (v2 S1d) — this
 * transport only moves bytes and counts the protocol's own marks.
 */
export function startClaudeHeldSession(
  file: string,
  args: readonly string[],
  options: RunOptions & {
    socketPath: string;
    cookie: string;
    graceMs?: number;
    events?: HeldSessionEvents;
    readyTimeoutMs?: number;
  },
): Promise<HeldSessionStart> {
  const pathProblem = heldSocketPathProblem(options.socketPath);
  if (pathProblem !== null) {
    return Promise.resolve({ ok: false, reason: "socket-path", message: pathProblem });
  }
  const childEnv = resolveChildEnv(options) ?? { ...process.env };
  const events = options.events ?? {};

  return new Promise(resolveStart => {
    let supervisor: ReturnType<typeof spawn>;
    try {
      supervisor = spawn(process.execPath, [supervisorPath(), file, ...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...childEnv,
          SO_HELD_SOCKET: options.socketPath,
          SO_HELD_COOKIE: options.cookie,
          SO_HELD_GRACE_MS: String(options.graceMs ?? 10_000),
        },
      });
    } catch (error) {
      resolveStart({ ok: false, reason: "spawn-failed", message: String(error) });
      return;
    }

    heldSupervisors.set(supervisor, "fresh");

    let settledStart = false;
    let agentPgid: number | null = null;
    let initSeq = 0;
    let resultSeq = 0;
    let sessionSeen = false;
    let partial = "";
    let exitResolve: (info: { code: number | null }) => void = () => {};
    const exited = new Promise<{ code: number | null }>(pass => {
      exitResolve = pass;
    });

    const readyTimer = setTimeout(() => {
      if (settledStart) return;
      settledStart = true;
      try {
        supervisor.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      resolveStart({ ok: false, reason: "ready-timeout", message: "the supervisor never sent its control frame" });
    }, options.readyTimeoutMs ?? 10_000);

    const handle: HeldSessionHandle = {
      supervisorPid: null,
      agentPgid: null,
      writeTurn(json: string): boolean {
        const stdin = supervisor.stdin;
        if (stdin === null || stdin.destroyed || !stdin.writable) return false;
        try {
          stdin.write(json.endsWith("\n") ? json : `${json}\n`);
          return true;
        } catch {
          return false;
        }
      },
      endInput(): void {
        try {
          supervisor.stdin?.end();
        } catch {
          // Already closed.
        }
      },
      terminate(): void {
        try {
          supervisor.kill("SIGTERM");
          heldSupervisors.set(supervisor, "termed");
        } catch {
          // Already gone.
        }
      },
      killHard(): void {
        try {
          supervisor.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      },
      exited,
    };

    const keep = (line: string): void => {
      if (line.length > JSONL_LINE_CAP) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event === null || typeof event !== "object") return;

      // The control frame settles the start, exactly once, before any
      // agent byte — the two-hop handshake (v6 W9).
      if (!settledStart && typeof event["so_supervisor"] === "string") {
        settledStart = true;
        clearTimeout(readyTimer);
        if (event["so_supervisor"] === "ready") {
          agentPgid = typeof event["agentPgid"] === "number" ? event["agentPgid"] : null;
          handle.agentPgid = agentPgid;
          handle.supervisorPid =
            typeof event["supervisorPid"] === "number" ? event["supervisorPid"] : (supervisor.pid ?? null);
          resolveStart({ ok: true, handle });
        } else {
          const message = typeof event["message"] === "string" ? event["message"] : "spawn failed";
          resolveStart({ ok: false, reason: "spawn-failed", message });
        }
        return;
      }
      if (typeof event["so_supervisor"] === "string") return; // never two frames; drop strays

      const type = String(event["type"] ?? "");
      if (type === "system" && String(event["subtype"] ?? "") === "init") {
        initSeq += 1;
        if (!sessionSeen && events.onSessionId !== undefined) {
          const id = event["session_id"];
          if (typeof id === "string" && id !== "") {
            sessionSeen = true;
            try {
              events.onSessionId(id);
            } catch {
              // A registry that cannot be written must not kill the turn.
            }
          }
        }
        try {
          events.onTurnInit?.(initSeq);
        } catch {
          // Observational.
        }
      } else if (type === "result" && primaryResultOrigin(event)) {
        resultSeq += 1;
        try {
          events.onTurnResult?.(resultSeq, event);
        } catch {
          // Observational.
        }
      }
      try {
        events.onStreamEvent?.(event);
      } catch {
        // Observational only, arc-1 rule unchanged.
      }
    };

    supervisor.stdout?.setEncoding("utf8");
    supervisor.stdout?.on("data", (chunk: string) => {
      partial += chunk;
      let cut = partial.indexOf("\n");
      while (cut !== -1) {
        keep(partial.slice(0, cut));
        partial = partial.slice(cut + 1);
        cut = partial.indexOf("\n");
      }
      if (partial.length > JSONL_LINE_CAP * 2) partial = partial.slice(-JSONL_LINE_CAP);
    });

    supervisor.on("error", error => {
      heldSupervisors.delete(supervisor);
      if (!settledStart) {
        settledStart = true;
        clearTimeout(readyTimer);
        resolveStart({ ok: false, reason: "spawn-failed", message: String(error) });
      }
      exitResolve({ code: null });
    });
    supervisor.on("close", code => {
      heldSupervisors.delete(supervisor);
      if (partial.trim() !== "") keep(partial);
      if (!settledStart) {
        settledStart = true;
        clearTimeout(readyTimer);
        resolveStart({ ok: false, reason: "spawn-failed", message: "the supervisor exited before its control frame" });
      }
      try {
        events.onExit?.({ code });
      } catch {
        // Observational.
      }
      exitResolve({ code });
    });
  });
}
