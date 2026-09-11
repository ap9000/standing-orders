import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup-state.ts"],
    // The suite exercises real SQLite files, git repositories, and child
    // processes. Shared CI runners can legitimately take more than Vitest's
    // five-second unit-test default without the underlying operation hanging.
    testTimeout: 15_000,
  },
});
