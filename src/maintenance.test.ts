import { afterEach, describe, expect, test, vi } from "vitest";
import { startMaintenance } from "./maintenance.js";

afterEach(() => vi.useRealTimers());
describe("independent serialized maintenance", () => {
  test("runs during other work, coalesces slow passes, and drains before shutdown", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let passes = 0;
    const maintenance = startMaintenance({ intervalMs: 10, shouldStop: () => false, onError: error => { throw error; }, run: async () => {
      passes++;
      await new Promise<void>(resolve => { release = resolve; });
    } });
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(1);
    let drained = false;
    const stopping = maintenance.stop().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(1);
    expect(drained).toBe(true);
  });

  test("a failed pass reports once and retries at the next interval; loss of ownership stops passes", async () => {
    vi.useFakeTimers();
    let stop = false;
    let passes = 0;
    const errors: unknown[] = [];
    const maintenance = startMaintenance({ intervalMs: 10, shouldStop: () => stop, onError: error => errors.push(error), run: async () => {
      passes++;
      if (passes === 1) throw new Error("database busy");
    } });
    await maintenance.runNow();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(passes).toBe(2);
    stop = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);
    await maintenance.stop();
  });

  test("a failed error reporter cannot reject a background timer or prevent shutdown", async () => {
    vi.useFakeTimers();
    const maintenance = startMaintenance({ intervalMs: 10, shouldStop: () => false,
      run: async () => { throw new Error("database busy"); },
      onError: () => { throw new Error("output closed"); },
    });
    await expect(maintenance.runNow()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    await expect(maintenance.stop()).resolves.toBeUndefined();
  });
});
