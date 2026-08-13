import { describe, test, expect } from "vitest";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { run, runStreamJsonl, terminateLiveProviders, NOT_FOUND_CODE } from "./exec.js";

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
