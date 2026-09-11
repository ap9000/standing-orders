import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs before each test file's imports. A reporting command, subprocess, or
// failed fixture must never fall back to the developer's control-plane state.
const state = mkdtempSync(join(tmpdir(), "standing-orders-tests-"));
const before = {
  STANDING_ORDERS_DB: process.env.STANDING_ORDERS_DB,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
process.env.STANDING_ORDERS_DB = join(state, "orders.db");
process.env.XDG_CONFIG_HOME = join(state, "config");
afterAll(() => {
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(state, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
