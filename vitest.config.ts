import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Review snapshots under output/ are artifacts, never runnable suites.
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup-state.ts"],
    // The run's own temp root first (every worker inherits it; the teardown removes it), then the build.
    globalSetup: ["./test/temp-root.ts", "./test/ensure-build.ts"],
    // These files launch real processes. Keep parallel gates from exhausting
    // the controller's capacity to track children and renew its worker lease:
    // at most half the cores, and never more than 4.
    maxWorkers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
    // The suite exercises real SQLite files, git repositories, and child
    // processes. Shared CI runners, and every core busy when the files run
    // in parallel, can legitimately take more than Vitest's five-second
    // unit-test default without the underlying operation hanging.
    // The migration suites open and upgrade whole databases file by file;
    // on the slowest shared macOS runners those alone can pass 30 s.
    testTimeout: 90_000,
  },
});
