import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.js";

/**
 * The cancellation floor (MCP gateway spec v6, Codex round-5 finding 2):
 * one function is the only writer of state='cancelled', so no road can
 * cancel without a typed reason — and, once coordinator filings exist,
 * without their durable event.
 */
describe("cancellation floor", () => {
  test("ARCH: exactly one statement in src/ writes state='cancelled'", () => {
    const src = join(import.meta.dirname);
    const hits: string[] = [];
    for (const name of readdirSync(src)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(src, name), "utf8");
      let at = -1;
      while ((at = text.indexOf("SET state = 'cancelled'", at + 1)) !== -1) hits.push(name);
    }
    expect(hits).toEqual(["store.ts"]);
  });

  test("the floor honors admitted-from states and reports unknown tasks as unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "cancel-floor-"));
    const store = openStore(join(dir, "t.db"));
    const now = new Date("2026-08-30T12:00:00Z");
    expect(store.applyCancellation("nope", { kind: "operator", text: null }, now, null)).toEqual({
      changed: false,
    });
    const made = store.createConsoleTask({ title: "cancel me", filedVia: "console" }, now);
    if (!made.ok) throw new Error("filing failed");
    // done is not in the admitted set — the floor refuses to cancel it.
    const forced = store.setTaskState(made.id, "done", now);
    expect(forced).toMatchObject({ ok: true });
    expect(
      store.applyCancellation(made.id, { kind: "machine", code: "mirror-latched" }, now, [
        "queued",
        "failed",
        "running",
      ]),
    ).toEqual({ changed: false });
    // admittedFrom null cancels from any state (the state verb's law).
    expect(store.applyCancellation(made.id, { kind: "operator", text: "wrong task" }, now, null)).toEqual({
      changed: true,
    });
    store.close();
  });
});
