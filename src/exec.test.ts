import { describe, test, expect } from "vitest";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { run, NOT_FOUND_CODE } from "./exec.js";

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
