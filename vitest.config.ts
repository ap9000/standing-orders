import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Review snapshots under output/ are artifacts, never runnable suites.
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup-state.ts"],
    globalSetup: ["./test/ensure-build.ts"],
    // These files launch real processes (git, the CLI, SQLite writers). A
    // third of the cores, never fewer than 4: on a 24-core machine that is 8
    // files at once, which measured twice as fast as 4, while 12 spilled onto
    // efficiency cores and contended with the browser journeys the release
    // check runs beside it (and with the controller's own lease renewals).
    maxWorkers: Math.max(4, Math.floor(availableParallelism() / 3)),
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
