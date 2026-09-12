import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCgroupIdentity, containerEmptiness, parseCgroupEvents } from "./container-state.js";

describe("kernel custody evidence", () => {
  test("only one exact kernel populated flag establishes emptiness", () => {
    expect(parseCgroupEvents("populated 0\nfrozen 0\n")).toBe("empty");
    expect(parseCgroupEvents("populated 1\n")).toBe("populated");
    for (const text of ["", "populated 2\n", "populated 00\n", "populated 0garbage", "populated 0\npopulated 1\n"]) expect(parseCgroupEvents(text)).toBe("unknown");
  });
  test("ordinary files, missing paths, partial custody and another platform never prove kernel emptiness", () => {
    const root = mkdtempSync(join(tmpdir(), "so-kernel-proof-"));
    const object = join(root, "so-audit-123456789abc");
    try {
      mkdirSync(object); writeFileSync(join(object, "cgroup.events"), "populated 0\n");
      expect(() => captureCgroupIdentity(object)).toThrow();
      for (const identity of [undefined, "{}", "garbage"]) expect(containerEmptiness("cgroup2", object, "linux", identity)).toBe("unknown");
      rmSync(object, { recursive: true });
      expect(containerEmptiness("cgroup2", object, "linux", "{}")).toBe("unknown");
      expect(containerEmptiness("job-object", "not-a-job", "win32", "job-object-v1")).toBe("unknown");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
