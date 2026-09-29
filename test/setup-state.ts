import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs before each test file's imports. A reporting command, subprocess, or
// failed fixture must never fall back to the developer's control-plane state.
const state = mkdtempSync(join(tmpdir(), "toolroll-tests-"));
const before = {
  TOOLROLL_DB: process.env.TOOLROLL_DB,
  STANDING_ORDERS_DB: process.env.STANDING_ORDERS_DB,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
// Both names: the new one is read first, and neither may name the live store.
process.env.TOOLROLL_DB = join(state, "orders.db");
process.env.STANDING_ORDERS_DB = join(state, "orders.db");
process.env.XDG_CONFIG_HOME = join(state, "config");
afterAll(() => {
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
