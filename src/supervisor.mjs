#!/usr/bin/env node
/**
 * The held-session supervisor (Parity II Phase 2, spec v5 P4 / v6 W7+W9).
 *
 * A minimal, zero-dependency parent for one held agent process. Its whole
 * value is PARENTHOOD: while this process lives and has not reaped its
 * child, POSIX guarantees the child's PID cannot be reused — so a kill
 * ordered through this process can never hit an innocent stranger, which
 * no PID-plus-timestamp guess can promise. Everything else here is a dumb
 * byte pump.
 *
 * Invocation (by exec.ts only):
 *   node supervisor.mjs <agent-binary> <agent-args...>
 *   env: SO_HELD_SOCKET  — unix socket path for the control channel
 *        SO_HELD_COOKIE  — 128-bit hex cookie; every socket verb must carry it
 *        SO_HELD_GRACE_MS — EOF→SIGKILL grace (default 10s)
 *
 * Protocol, in order:
 *   1. The control socket is created FIRST (mode 0600), so a fencer can
 *      always reach a supervisor that got as far as spawning.
 *   2. The agent spawns DETACHED into its own fresh process group.
 *   3. stdout emits exactly ONE control frame before any relayed agent
 *      byte: {"so_supervisor":"ready","agentPgid":N,"supervisorPid":N}
 *      or {"so_supervisor":"spawn-failed","message":...}. Everything after
 *      the ready frame is the agent's stream, byte for byte.
 *   4. stdin bytes relay to the agent verbatim. stdin EOF (the owner ended
 *      the hold, or died — the pipe broke) starts the AUTONOMOUS FENCE:
 *      EOF to the agent, grace, then SIGKILL of its whole group. SIGTERM
 *      and SIGHUP take the same road (the hard-stop sweep's contract).
 *   5. Socket verbs, one JSON line per connection, cookie-checked:
 *      {"cookie":..,"verb":"status"} → {"ok":true,"alive":bool,...}
 *      {"cookie":..,"verb":"kill"}   → group SIGKILL via the held handle,
 *      answered only after the group is PROVEN gone (ESRCH poll, 5s bound).
 *   6. The supervisor exits when the agent has exited and the relay has
 *      flushed; the socket file is unlinked on the way out.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, unlinkSync } from "node:fs";

const socketPath = process.env["SO_HELD_SOCKET"] ?? "";
const cookie = process.env["SO_HELD_COOKIE"] ?? "";
const graceMs = Math.max(1000, Number(process.env["SO_HELD_GRACE_MS"] ?? 10_000) || 10_000);
const [agentFile, ...agentArgs] = process.argv.slice(2);

const frame = payload => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

if (socketPath === "" || cookie === "" || agentFile === undefined) {
  frame({ so_supervisor: "spawn-failed", message: "missing SO_HELD_SOCKET, SO_HELD_COOKIE, or agent argv" });
  process.exit(2);
}

let exited = false;
let exitCode = null;
let fencing = false;
let server = null;
let killsInFlight = 0;
let exitWanted = false;

/** The exit road, deferred while a kill verb's reply is still owed: the
 * fencer must HEAR that the group is proven gone before the process that
 * proved it disappears. */
const maybeExit = () => {
  if (!exitWanted || killsInFlight > 0) return;
  cleanup();
  for (const connection of pending) connection.destroy();
  process.exit(exitCode ?? 1);
};

const cleanup = () => {
  try {
    server?.close();
  } catch {
    // Already closed.
  }
  try {
    unlinkSync(socketPath);
  } catch {
    // Never existed, or already gone.
  }
};

/** True while ANY member of the agent's group survives. */
const groupAlive = pgid => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/** SIGKILL the group and poll to PROVEN-gone (bounded). */
const killGroupSettled = async pgid => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Group already gone — proving below still runs.
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await new Promise(pass => setTimeout(pass, 50));
  }
  return !groupAlive(pgid);
};

// The control socket comes up BEFORE the agent spawns.
const pending = new Set();
server = createServer(connection => {
  pending.add(connection);
  connection.on("close", () => pending.delete(connection));
  let buffered = "";
  connection.on("data", chunk => {
    buffered += String(chunk);
    const cut = buffered.indexOf("\n");
    if (cut === -1) {
      if (buffered.length > 4096) connection.destroy();
      return;
    }
    const line = buffered.slice(0, cut);
    buffered = "";
    let order = null;
    try {
      order = JSON.parse(line);
    } catch {
      connection.destroy();
      return;
    }
    if (order === null || typeof order !== "object" || order.cookie !== cookie) {
      // Wrong cookie: one refusal, no detail, connection over.
      connection.end(`${JSON.stringify({ ok: false })}\n`);
      return;
    }
    if (order.verb === "status") {
      const pgid = child?.pid;
      const group = pgid !== undefined && groupAlive(pgid);
      connection.end(
        `${JSON.stringify({ ok: true, alive: !exited || group, groupAlive: group, agentPgid: pgid ?? null, exitCode })}\n`,
      );
      return;
    }
    if (order.verb === "kill") {
      const pgid = child.pid;
      if (exited || pgid === undefined) {
        connection.end(`${JSON.stringify({ ok: true, killed: false, settled: true, exitCode })}\n`);
        return;
      }
      killsInFlight += 1;
      killGroupSettled(pgid).then(settled => {
        // The reply counts as owed until the write side has FLUSHED —
        // exiting on the mere call would let process death eat the FIN.
        let settledReply = false;
        const done = () => {
          if (settledReply) return;
          settledReply = true;
          killsInFlight -= 1;
          maybeExit();
        };
        try {
          connection.on("finish", done);
          connection.on("close", done);
          connection.end(`${JSON.stringify({ ok: true, killed: true, settled, exitCode })}\n`);
          setTimeout(done, 2_000).unref();
        } catch {
          done();
        }
      });
      return;
    }
    connection.end(`${JSON.stringify({ ok: false })}\n`);
  });
});

let child;
server.on("error", error => {
  frame({ so_supervisor: "spawn-failed", message: `control socket: ${String(error)}` });
  process.exit(1);
});
server.listen(socketPath, () => {
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    // Best effort; the parent directory is already private.
  }

  child = spawn(agentFile, agentArgs, {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.on("error", error => {
    frame({ so_supervisor: "spawn-failed", message: String(error) });
    cleanup();
    process.exit(1);
  });

  child.on("spawn", () => {
    frame({ so_supervisor: "ready", agentPgid: child.pid, supervisorPid: process.pid });
    // Relay AFTER the frame: agent bytes buffered meanwhile flow next.
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    process.stdin.pipe(child.stdin, { end: false });
    process.stdin.on("end", () => fence());
    process.stdin.on("error", () => fence());
  });

  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code ?? (signal === null ? 1 : 143);
  });

  child.on("close", code => {
    // stdio flushed and the process reaped. The GROUP may still have
    // members — a tool the agent launched can outlive its leader (round-6
    // finding 4) — so the whole group is drained and PROVEN gone before
    // custody releases; the whole-tree invariant is the group, never the
    // one pid.
    exitCode = exitCode ?? code ?? 1;
    const pgid = child.pid;
    const drained = pgid !== undefined && groupAlive(pgid) ? killGroupSettled(pgid) : Promise.resolve(true);
    drained.then(() => {
      exitWanted = true;
      maybeExit();
    });
  });
});

/** EOF → grace → group SIGKILL. Idempotent; every exit road converges here. */
const fence = () => {
  if (fencing || exited || child === undefined) return;
  fencing = true;
  try {
    child.stdin.end();
  } catch {
    // Already closed.
  }
  const timer = setTimeout(() => {
    if (!exited && child.pid !== undefined) void killGroupSettled(child.pid);
  }, graceMs);
  timer.unref();
};

process.on("SIGTERM", () => fence());
process.on("SIGHUP", () => fence());
process.on("SIGINT", () => fence());
