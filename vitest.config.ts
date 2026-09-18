import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Review snapshots under output/ are artifacts, never runnable suites.
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup-state.ts"],
    globalSetup: ["./test/ensure-build.ts"],
    // These files launch real processes. Keep parallel gates from exhausting
    // the controller's capacity to track children and renew its worker lease.
    maxWorkers: 4,
    // The suite exercises real SQLite files, git repositories, and child
    // processes. Shared CI runners, and every core busy when the files run
    // in parallel, can legitimately take more than Vitest's five-second
    // unit-test default without the underlying operation hanging.
    testTimeout: 30_000,
  },
});
