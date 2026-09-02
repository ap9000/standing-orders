import { describe, test, expect } from "vitest";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  run, runStreamJsonl, runGeminiStreamJsonl, terminateLiveProviders, NOT_FOUND_CODE,
  retryTransientSpawn, isTransientSpawnFailure, type SpawnAttempt,
} from "./exec.js";

/** node itself is the one binary guaranteed to exist wherever these tests run. */
const NODE = process.execPath;

describe("run", () => {
  test("returns stdout and a zero code for a successful command", async () => {
    // Arrange / Act
    const result = await run(NODE, ["-e", "process.stdout.write('hello')"]);

    // Assert
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
    expect(result.notFound).toBe(false);
  });

  test("reports a non-zero exit as a result rather than throwing", async () => {
    // `git` fails routinely — outside a repo, on a bad ref. Failure is data.
    const result = await run(NODE, ["-e", "process.exit(3)"]);

    expect(result.code).toBe(3);
  });

  test("captures stderr alongside a successful exit", async () => {
    const result = await run(NODE, ["-e", "process.stderr.write('boom')"]);

    expect(result.stderr).toBe("boom");
    expect(result.code).toBe(0);
  });

  test("flags a missing binary instead of rejecting", async () => {
    // `gh` is absent on most machines; that must not end discovery
    const result = await run("standing-orders-no-such-binary", ["--version"]);

    expect(result.notFound).toBe(true);
    expect(result.code).toBe(NOT_FOUND_CODE);
  });

  test("kills a command that outruns its timeout and flags it", async () => {
    const result = await run(NODE, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 150 });

    expect(result.timedOut).toBe(true);
    expect(result.notFound).toBe(false);
  });

  test("passes arguments verbatim, without shell interpretation", async () => {
    // A scanned directory may be named anything at all. Arguments are data.
    const hostile = "; rm -rf ~";

    const result = await run(NODE, ["-e", "process.stdout.write(process.argv[1])", hostile]);

    expect(result.stdout).toBe(hostile);
  });

  test("runs in the requested working directory", async () => {
    const dir = await realpath(tmpdir());

    const result = await run(NODE, ["-e", "process.stdout.write(process.cwd())"], { cwd: dir });

    expect(result.stdout).toBe(dir);
  });
});

describe("the provider process group (M6.12)", () => {
  test("a processGroup child's whole tree dies at the timeout — no orphaned grandchildren", async () => {
    // A parent that spawns a grandchild and exits nothing: without group
    // semantics, killing the parent leaves the grandchild running.
    const script = `
      const { spawn } = require("node:child_process");
      const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      console.log(JSON.stringify({ type: "thread.started", thread_id: String(grand.pid) }));
      setInterval(()=>{},1000);
    `;
    const result = await runStreamJsonl(process.execPath, ["-e", script], {
      timeoutMs: 1_500,
      processGroup: true,
    });
    expect(result.timedOut).toBe(true);
    const grandPid = Number(/"thread_id":"(\d+)"/.exec(result.stdout)?.[1]);
    expect(Number.isInteger(grandPid)).toBe(true);
    // The grandchild must be gone (give the kernel a beat to reap).
    await new Promise(resolve => setTimeout(resolve, 300));
    let alive = true;
    try {
      process.kill(grandPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  test("terminateLiveProviders ends a live provider now; the run settles as the failure it is", async () => {
    const pending = runStreamJsonl(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 60_000,
      processGroup: true,
    });
    // Let it spawn, then hard-stop.
    await new Promise(resolve => setTimeout(resolve, 200));
    const terminated = terminateLiveProviders();
    expect(terminated).toBeGreaterThan(0);
    const result = await pending;
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("the buffered group transport keeps execFile's contract — output, timeout, not-found", async () => {
    const ok = await run(process.execPath, ["-e", "console.log('hi')"], { processGroup: true, timeoutMs: 10_000 });
    expect(ok).toMatchObject({ code: 0, timedOut: false });
    expect(ok.stdout).toContain("hi");

    const slow = await run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { processGroup: true, timeoutMs: 500 });
    expect(slow.timedOut).toBe(true);

    const missing = await run("definitely-not-a-binary-xyz", [], { processGroup: true, timeoutMs: 2_000 });
    expect(missing.notFound).toBe(true);
  });
});


describe("the gemini retention runner (Phase 3 D1/A7)", () => {
  const emit = (lines: unknown[]): string =>
    `const lines=${JSON.stringify(lines.map(one => (typeof one === "string" ? one : JSON.stringify(one))))};for(const l of lines)console.log(l);`;

  const parseOut = (stdout: string): Record<string, unknown>[] =>
    stdout.split("\n").filter(one => one !== "").map(one => JSON.parse(one) as Record<string, unknown>);

  test("deltas assemble into ONE synthetic line the real CLI cannot emit", async () => {
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", emit([
      "Loaded cached credentials.",
      { type: "init", session_id: "s-9", model: "m" },
      { type: "message", role: "user", content: "the brief" },
      { type: "message", role: "assistant", content: "part one ", delta: true },
      { type: "tool_use", tool_name: "write_file", tool_id: "t1", parameters: {} },
      { type: "tool_result", tool_id: "t1", status: "success" },
      { type: "message", role: "assistant", content: "part two", delta: true },
      { type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 2 } },
    ])], { timeoutMs: 15_000 });
    const kept = parseOut(result.stdout);
    expect(kept.map(one => one["type"])).toEqual(["init", "synthetic_message", "result"]);
    expect(kept[1]).toMatchObject({ content: "part one part two" });
  });

  test("REAL BYTES (S3, live spike 2026-08-29, gemini 0.57.0): the recorded happy-path stream assembles exactly", async () => {
    // Captured verbatim from a live API-key run — the fixture the spec
    // demanded once auth existed: real timestamps, real session id, real
    // delta framing. Note the live CLI emits SEPARATE assistant messages
    // both flagged delta:true (the haiku, then "done"); the runner's
    // concatenation rule is what makes the terminal message whole.
    const LIVE = [
    "{\"type\":\"init\",\"timestamp\":\"2026-08-29T17:38:58.092Z\",\"session_id\":\"b2e7f647-85e1-4c7e-a65c-0e914255ecbf\",\"model\":\"auto\"}",
    "{\"type\":\"message\",\"timestamp\":\"2026-08-29T17:38:58.093Z\",\"role\":\"user\",\"content\":\"Write a haiku about worktrees, then reply done\"}",
    "{\"type\":\"message\",\"timestamp\":\"2026-08-29T17:39:14.292Z\",\"role\":\"assistant\",\"content\":\"Branch in its own space,\\nNo need to stash or commit,\\nWork on both at once.\\n\\n\",\"delta\":true}",
    "{\"type\":\"message\",\"timestamp\":\"2026-08-29T17:39:14.299Z\",\"role\":\"assistant\",\"content\":\"done\",\"delta\":true}",
    "{\"type\":\"result\",\"timestamp\":\"2026-08-29T17:39:14.327Z\",\"status\":\"success\",\"stats\":{\"total_tokens\":9887,\"input_tokens\":8257,\"output_tokens\":60,\"cached\":4058,\"input\":4199,\"duration_ms\":16235,\"tool_calls\":0,\"models\":{\"gemini-3.1-flash-lite\":{\"total_tokens\":1640,\"input_tokens\":821,\"output_tokens\":37,\"cached\":0,\"input\":821},\"gemini-3.5-flash\":{\"total_tokens\":8247,\"input_tokens\":7436,\"output_tokens\":23,\"cached\":4058,\"input\":3378}}}}"
    ];
    // The captured lines are fed to the emitter AS OBJECTS parsed once —
    // no double round-trip claiming a fidelity the reserialize would break
    // (Codex gemini verify, finding 4). The bytes that matter are the
    // stream SHAPE and the assembled content, both asserted below.
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", emit(LIVE.map(one => JSON.parse(one)))], { timeoutMs: 15_000 });
    const kept = parseOut(result.stdout);
    expect(kept.map(one => one["type"])).toEqual(["init", "synthetic_message", "result"]);
    expect(kept[0]).toMatchObject({ session_id: "b2e7f647-85e1-4c7e-a65c-0e914255ecbf" });
    expect(kept[1]).toMatchObject({
      content: "Branch in its own space,\nNo need to stash or commit,\nWork on both at once.\n\ndone",
    });
    expect(kept[2]).toMatchObject({ status: "success" });
  });

  test("a non-delta assistant message REPLACES the buffer; non-string content is dropped", async () => {
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", emit([
      { type: "init", session_id: "s", model: "m" },
      { type: "message", role: "assistant", content: "draft ", delta: true },
      { type: "message", role: "assistant", content: "the whole final message" },
      { type: "message", role: "assistant", content: { not: "a string" } },
      { type: "result", status: "success" },
    ])], { timeoutMs: 15_000 });
    const message = parseOut(result.stdout).find(one => one["type"] === "synthetic_message");
    expect(message).toMatchObject({ content: "the whole final message" });
  });

  test("the first error-severity line is retained; warnings and user echoes are not", async () => {
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", emit([
      { type: "init", session_id: "s", model: "m" },
      { type: "error", severity: "warning", message: "loop detected" },
      { type: "error", severity: "error", message: "the real failure" },
      { type: "error", severity: "error", message: "a later failure" },
      { type: "result", status: "error" },
    ])], { timeoutMs: 15_000 });
    const kept = parseOut(result.stdout);
    const errors = kept.filter(one => one["type"] === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "the real failure" });
  });

  test("a delta flood past the cap truncates with the marker and holds the line discipline", async () => {
    const script =
      `console.log(JSON.stringify({type:"init",session_id:"s",model:"m"}));` +
      `const chunk="ab\u00e9".repeat(1000);` + // multi-byte: the cap is bytes, not chars
      `for(let i=0;i<40;i++)console.log(JSON.stringify({type:"message",role:"assistant",content:chunk,delta:true}));` +
      `console.log(JSON.stringify({type:"result",status:"success"}));`;
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 20_000 });
    const message = result.stdout.split("\n").find(one => one.includes("synthetic_message"));
    expect(message).toBeDefined();
    expect(Buffer.byteLength(message as string, "utf8")).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(message as string) as { content: string; truncated?: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.content.endsWith("\u2026[truncated]")).toBe(true);
  });

  test("escaping-hostile content (quotes, backslashes, 4-byte unicode) still yields one parseable capped line", async () => {
    const script =
      `console.log(JSON.stringify({type:"init",session_id:"s",model:"m"}));` +
      `const chunk=('\\"\\\\'+String.fromCodePoint(0x1F680)).repeat(400);` +
      `for(let i=0;i<80;i++)console.log(JSON.stringify({type:"message",role:"assistant",content:chunk,delta:true}));` +
      `console.log(JSON.stringify({type:"result",status:"success"}));`;
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", script], { timeoutMs: 20_000 });
    const message = result.stdout.split("\n").find(one => one.includes("synthetic_message"));
    expect(Buffer.byteLength(message as string, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(() => JSON.parse(message as string)).not.toThrow();
  });

  test("zero output stays zero output — exit code intact, nothing synthesized", async () => {
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", "process.exit(41)"], { timeoutMs: 15_000 });
    expect(result.code).toBe(41);
    expect(result.stdout).toBe("");
  });

  test("stderr is captured bounded, exactly like the sibling runners", async () => {
    const result = await runGeminiStreamJsonl(process.execPath, ["-e", "console.error('auth: set GEMINI_API_KEY');process.exit(41)"], { timeoutMs: 15_000 });
    expect(result.code).toBe(41);
    expect(result.stderr).toContain("GEMINI_API_KEY");
  });

  test("a missing binary is NOT_FOUND, never a throw", async () => {
    const result = await runGeminiStreamJsonl("/no/such/gemini-binary", [], { timeoutMs: 5_000 });
    expect(result.notFound).toBe(true);
    expect(result.code).toBe(NOT_FOUND_CODE);
  });
});

describe("transient spawn failures are retried, bounded — a process that never started is not a result", () => {
  const failed = (code: string | number): SpawnAttempt => ({
    result: { code: 1, stdout: "", stderr: `spawn git ${code}`, timedOut: false, notFound: false },
    transient: isTransientSpawnFailure({ code }),
  });
  const ok: SpawnAttempt = { result: { code: 0, stdout: "main\n", stderr: "", timedOut: false, notFound: false }, transient: false };

  test("EAGAIN, EMFILE, and ENFILE are the transient class; exits, not-found, and timeouts are not", () => {
    expect(isTransientSpawnFailure({ code: "EAGAIN" })).toBe(true);
    expect(isTransientSpawnFailure({ code: "EMFILE" })).toBe(true);
    expect(isTransientSpawnFailure({ code: "ENFILE" })).toBe(true);
    expect(isTransientSpawnFailure({ code: "ENOENT" })).toBe(false);
    expect(isTransientSpawnFailure({ code: 1 })).toBe(false);
    expect(isTransientSpawnFailure({})).toBe(false);
    expect(isTransientSpawnFailure(null)).toBe(false);
  });

  test("two refused spawns then a start: three attempts, the delays honored in order, the real answer returned", async () => {
    const answers = [failed("EAGAIN"), failed("EMFILE"), ok];
    let attempts = 0;
    const slept: number[] = [];
    const result = await retryTransientSpawn(
      () => Promise.resolve(answers[attempts++] as SpawnAttempt),
      [10, 20, 30],
      ms => { slept.push(ms); return Promise.resolve(); },
    );
    expect(attempts).toBe(3);
    expect(slept).toEqual([10, 20]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("main\n");
  });

  test("a machine that never frees a slot: the delays run out and the last refusal stands, honestly", async () => {
    let attempts = 0;
    const result = await retryTransientSpawn(
      () => { attempts++; return Promise.resolve(failed("EAGAIN")); },
      [1, 1, 1],
      () => Promise.resolve(),
    );
    expect(attempts).toBe(4);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("EAGAIN");
  });

  test("a real failure is answered at once — no retry hides an exit code or a missing binary", async () => {
    let attempts = 0;
    const exit = await retryTransientSpawn(
      () => { attempts++; return Promise.resolve({ result: { code: 128, stdout: "", stderr: "fatal", timedOut: false, notFound: false }, transient: false }); },
      [1, 1],
      () => Promise.resolve(),
    );
    expect(attempts).toBe(1);
    expect(exit.code).toBe(128);
    let again = 0;
    const missing = await retryTransientSpawn(
      () => { again++; return Promise.resolve({ result: { code: NOT_FOUND_CODE, stdout: "", stderr: "", timedOut: false, notFound: true }, transient: false }); },
      [1, 1],
      () => Promise.resolve(),
    );
    expect(again).toBe(1);
    expect(missing.notFound).toBe(true);
  });
});
