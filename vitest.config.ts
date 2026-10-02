import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Review snapshots under output/ are artifacts, never runnable suites.
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup-state.ts"],
    // The run's own temp root first (every worker inherits it; the teardown removes it), then the build.
    globalSetup: ["./test/temp-root.ts", "./test/ensure-build.ts"],
    // These files launch real processes (git, the CLI, SQLite writers). At most 4 at once by default, so tests stay
    // light on a machine that is also running agents; never more than half the cores. VITEST_MAX_WORKERS raises it
    // where nothing else runs (8 measured twice as fast on a 24-core machine).
    maxWorkers: Math.max(1, Math.min(Number(process.env["VITEST_MAX_WORKERS"]) || 4, Math.floor(availableParallelism() / 2))),
    // Forks with per-file isolation stay: setup-state.ts points each file's
    // process.env at its own database, and modules keep per-process caches
    // (attestations, prepared statements) that must not leak between files.
    pool: "forks",
    isolate: true,
    // The suite exercises real SQLite files, git repositories, and child
    // processes. Shared CI runners, and every core busy when the files run
    // in parallel, can legitimately take more than Vitest's five-second
    // unit-test default without the underlying operation hanging.
    testTimeout: 90_000,
  },
});
