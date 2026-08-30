import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClaudeHeldSession, heldSocketPathProblem, HELD_SOCKET_PATH_LIMIT } from "./exec.js";

/**
 * The held transport against REAL processes: a fake agent that speaks just
 * enough stream-json, under the real supervisor.mjs, with the real byte
 * relay, control sockets, and fences. No claude binary is involved.
 */

const FAKE_AGENT = `
process.stdin.setEncoding("utf8");
let buf = "";
let n = 0;
const mode = process.argv[2] ?? "echo";
process.stdin.on("data", c => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    if (mode === "silent") continue;
    n += 1;
    if (mode === "frame-noise" && n === 1) {
      console.log(JSON.stringify({ so_supervisor: "ready", agentPgid: 424242 }));
    }
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-fake" }));
    console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: null }));
    // One JSON line emitted in TWO chunks: the relay and the transport's
    // line assembly must be byte-exact across the seam.
    const result = JSON.stringify({ type: "result", subtype: "success", total_cost_usd: n * 0.01, usage: { output_tokens: n }, result: "turn " + n });
    const cut = Math.floor(result.length / 2);
    process.stdout.write(result.slice(0, cut));
    setTimeout(() => process.stdout.write(result.slice(cut) + "\\n"), 15);
  }
});
process.stdin.on("end", () => {
  if (mode === "silent") { setInterval(() => {}, 1000); return; }
  setTimeout(() => process.exit(0), 40);
});
`;

let dir = "";
let agentPath = "";
let socketN = 0;
const socket = (): string => {
  socketN += 1;
  return join(tmpdir(), `so-held-${process.pid}-${socketN}.sock`);
};
const turn = (text: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "so-held-test-"));
  agentPath = join(dir, "fake-agent.cjs");
  writeFileSync(agentPath, FAKE_AGENT);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the held-session transport under the real supervisor", () => {
  test("ready frame, per-turn init/result counting, session id, clean EOF exit", async () => {
    const inits: number[] = [];
    const results: Array<{ seq: number; cost: unknown }> = [];
    let sessionId = "";
    const start = await startClaudeHeldSession(process.execPath, [agentPath], {
      socketPath: socket(),
      cookie: "c".repeat(32),
      events: {
        onTurnInit: seq => inits.push(seq),
        onTurnResult: (seq, event) => results.push({ seq, cost: event["total_cost_usd"] }),
        onSessionId: id => {
          sessionId = id;
        },
      },
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.handle.agentPgid).toBeGreaterThan(0);
    expect(start.handle.supervisorPid).toBeGreaterThan(0);

    expect(start.handle.writeTurn(turn("one"))).toBe(true);
    await new Promise(pass => setTimeout(pass, 300));
    expect(inits).toEqual([1]);
    expect(results).toEqual([{ seq: 1, cost: 0.01 }]);
    expect(sessionId).toBe("sess-fake");

    expect(start.handle.writeTurn(turn("two"))).toBe(true);
    await new Promise(pass => setTimeout(pass, 300));
    expect(inits).toEqual([1, 2]);
    expect(results.map(one => one.seq)).toEqual([1, 2]);
    // cumulative totals rode through the relay byte-exact across the split write
    expect(results[1]?.cost).toBe(0.02);

    start.handle.endInput();
    const exit = await start.handle.exited;
    expect(exit.code).toBe(0);
  });

  test("a fake control frame mid-stream is dropped — never a second start, never a stream event", async () => {
    const seen: string[] = [];
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "frame-noise"], {
      socketPath: socket(),
      cookie: "c".repeat(32),
      events: { onStreamEvent: event => seen.push(String(event["type"] ?? event["so_supervisor"] ?? "?")) },
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    // the REAL frame carried a real pgid, not the agent's forged 424242
    expect(start.handle.agentPgid).not.toBe(424242);
    start.handle.writeTurn(turn("one"));
    await new Promise(pass => setTimeout(pass, 300));
    expect(seen).not.toContain("undefined");
    expect(seen.filter(one => one === "system").length).toBe(1);
    start.handle.endInput();
    await start.handle.exited;
  });

  test("a missing agent binary answers spawn-failed through the two-hop handshake", async () => {
    const start = await startClaudeHeldSession(join(dir, "no-such-binary"), [], {
      socketPath: socket(),
      cookie: "c".repeat(32),
    });
    expect(start).toMatchObject({ ok: false, reason: "spawn-failed" });
  });

  test("an oversized socket path refuses BEFORE anything spawns", async () => {
    const long = join(tmpdir(), `${"x".repeat(HELD_SOCKET_PATH_LIMIT)}.sock`);
    expect(heldSocketPathProblem(long)).not.toBeNull();
    const start = await startClaudeHeldSession(process.execPath, [agentPath], {
      socketPath: long,
      cookie: "c".repeat(32),
    });
    expect(start).toMatchObject({ ok: false, reason: "socket-path" });
  });

  test("the control socket: status with the cookie, refusal without, kill settles the group", async () => {
    const path = socket();
    const cookie = "d".repeat(32);
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "silent"], {
      socketPath: path,
      cookie,
      graceMs: 60_000,
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;

    const ask = (payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
      new Promise((pass, fail) => {
        const wire = connect(path, () => {
          wire.write(`${JSON.stringify(payload)}\n`);
        });
        let answer = "";
        wire.on("data", chunk => {
          answer += String(chunk);
        });
        wire.on("end", () => {
          try {
            pass(JSON.parse(answer) as Record<string, unknown>);
          } catch (error) {
            fail(error as Error);
          }
        });
        wire.on("error", fail);
      });

    const status = await ask({ cookie, verb: "status" });
    expect(status).toMatchObject({ ok: true, alive: true });
    expect(status["agentPgid"]).toBe(start.handle.agentPgid);

    const refused = await ask({ cookie: "wrong", verb: "kill" });
    expect(refused).toMatchObject({ ok: false });
    // the wrong cookie killed nothing
    expect(await ask({ cookie, verb: "status" })).toMatchObject({ ok: true, alive: true });

    const killed = await ask({ cookie, verb: "kill" });
    expect(killed).toMatchObject({ ok: true, killed: true, settled: true });
    const exit = await start.handle.exited;
    expect(exit.code === 0).toBe(false);
  }, 20_000);

  test("stdin EOF fences autonomously: grace, then the group dies without any order", async () => {
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "silent"], {
      socketPath: socket(),
      cookie: "e".repeat(32),
      graceMs: 1_200,
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    start.handle.endInput();
    const exit = await start.handle.exited;
    // killed, not clean — the silent agent never honors EOF
    expect(exit.code === 0).toBe(false);
  }, 20_000);

  test("SIGTERM takes the same fence road (the hard-stop sweep's contract)", async () => {
    const start = await startClaudeHeldSession(process.execPath, [agentPath, "silent"], {
      socketPath: socket(),
      cookie: "f".repeat(32),
      graceMs: 1_200,
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    start.handle.terminate();
    const exit = await start.handle.exited;
    expect(exit.code === 0).toBe(false);
  }, 20_000);
});

describe("the held invocation gateway", () => {
  test("verifies the open run, refuses non-claude, stamps provider start BEFORE the spawn, and threads the session id", async () => {
    const { openStore } = await import("./store.js");
    const { invokeHeldAgent } = await import("./invoke.js");
    const { register } = await import("./runner.js");
    const { acquire } = await import("./claim.js");
    const T0 = new Date("2026-08-25T22:00:00.000Z");
    const store = openStore(":memory:");
    store.createTask({ id: "t-gw", title: "gateway" }, T0);
    const ref = store.refFor("built-in", "t-gw");
    // The runner gate's spawn leg (MCP spec v6): the run's lease is REAL —
    // registered runner, placed task, acquired claim. The TTL outlives the
    // gateway's wall clock.
    const REPO = "/repo/held-gw";
    store.placeTask(ref.id, REPO);
    register(store, { name: "w", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-w" });
    const claimed = acquire(store, ref.id, "w", {
      now: T0,
      token: "tok-w",
      ttlMs: 10 * 365 * 24 * 3_600_000,
      newLeaseId: () => "lease-gw",
    });
    expect(claimed.ok).toBe(true);
    const run = store.startRun({ taskRef: ref.id, leaseId: "lease-gw", runner: "w", branch: "b", worktree: "/w", now: T0 });

    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const starter = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ file, args });
      // the provider-start stamp must already be durable at spawn time
      expect(store.getRun(run)?.providerStartedAt).not.toBeNull();
      (options["events"] as { onSessionId?: (id: string) => void }).onSessionId?.("sess-gw");
      return Promise.resolve({ ok: false as const, reason: "spawn-failed" as const, message: "fake" });
    }) as never;

    const start = await invokeHeldAgent(
      store,
      run,
      { provider: "claude", model: "sonnet" },
      ["-p", "--input-format", "stream-json"],
      { socketPath: "/tmp/so-gw.sock", cookie: "c".repeat(32), starter },
    );
    expect(start).toMatchObject({ ok: false, reason: "spawn-failed" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.file).toBe("claude");
    expect(store.getRun(run)?.sessionId).toBe("sess-gw");

    // a finished run never spawns
    store.finishRun(run, { outcome: "failed", reason: "test", now: T0 });
    await expect(
      invokeHeldAgent(store, run, { provider: "claude", model: null }, [], {
        socketPath: "/tmp/so-gw.sock",
        cookie: "c".repeat(32),
        starter,
      }),
    ).rejects.toThrow(/not an open attempt/);
    store.close();
  });
});
