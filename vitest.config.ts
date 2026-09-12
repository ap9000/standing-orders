import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Review snapshots under output/ are artifacts, never runnable suites.
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup-state.ts"],
    globalSetup: ["./test/ensure-build.ts"],
    // The suite exercises real SQLite files, git repositories, and child
    // processes. Shared CI runners can legitimately take more than Vitest's
    // five-second unit-test default without the underlying operation hanging.
    testTimeout: 15_000,
  },
});
