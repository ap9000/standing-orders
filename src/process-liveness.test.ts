import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as childProcess from "node:child_process";
import { processMayBeAlive } from "./process-liveness.js";

vi.mock("node:child_process", { spy: true });

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const pid = 87803;
const witness = { observedAt: "2026-09-12T16:53:59.658Z", finishedAt: "2026-09-12T17:00:00.000Z" };
const birth = "Mon Sep 14 14:33:43 2026\n";
const failure = (code: string) => Object.assign(new Error(code), { code });

describe("historical process identity", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(childProcess.execFileSync).mockReturnValue(birth);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-15T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(childProcess.execFileSync).mockReset();
    Object.defineProperty(process, "platform", platform);
  });

  test("a newer PID frees only its historical identity using a UTC, C-locale read", () => {
    expect(processMayBeAlive(pid, false, witness)).toBe(false);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(pid, 0);
    expect(childProcess.execFileSync).toHaveBeenCalledExactlyOnceWith("/bin/ps", ["-p", String(pid), "-o", "lstart="], expect.objectContaining({
      encoding: "utf8", env: expect.objectContaining({ TZ: "UTC", LC_ALL: "C" }), stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1024,
    }));
  });

  test("an absent group with a recycled leader PID is absent", () => {
    vi.mocked(process.kill).mockImplementation(target => { if (target < 0) throw failure("ESRCH"); return true; });
    expect(processMayBeAlive(pid, true, witness)).toBe(false);
    expect(vi.mocked(process.kill).mock.calls).toEqual([[-pid, 0], [pid, 0]]);
  });

  test.each(["populated", "EPERM", "EACCES", "EIO"])("a %s group blocks even with a recycled leader", state => {
    vi.mocked(process.kill).mockImplementation(() => { if (state !== "populated") throw failure(state); return true; });
    expect(processMayBeAlive(pid, true, witness)).toBe(true);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-pid, 0);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  test.each([false, true])("missing PID stays absent and denied PID stays unknown (group=%s)", group => {
    for (const code of ["ESRCH", "EPERM", "EACCES", "EINVAL", "unknown"]) {
      vi.mocked(process.kill).mockImplementation(target => { throw failure(target < 0 ? "ESRCH" : code); });
      expect(processMayBeAlive(pid, group, witness), code).toBe(code !== "ESRCH");
    }
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("invalid PID %s remains unknown without probing", invalid => {
    expect(processMayBeAlive(invalid, true, witness)).toBe(true);
    expect(process.kill).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  test.each(["linux", "win32", "freebsd"])("%s retains its previous PID and group behavior", os => {
    Object.defineProperty(process, "platform", { value: os });
    expect(processMayBeAlive(pid, true, witness)).toBe(true);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(os === "win32" ? pid : -pid, 0);
    expect(processMayBeAlive(pid, false, witness)).toBe(true);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  test("birth during the run cannot disprove a reservation made before spawn", () => {
    expect(processMayBeAlive(pid, false, { ...witness, finishedAt: "2026-09-14T14:33:44.000Z" })).toBe(true);
  });

  test.each(["2026-09-14T14:33:43.000Z", "2026-09-14T14:33:43.999Z", "2026-09-14T14:33:44.000Z"])("same-second or older birth is ambiguous at %s", time => {
    expect(processMayBeAlive(pid, false, { ...witness, observedAt: time })).toBe(true);
    expect(processMayBeAlive(pid, false, { ...witness, finishedAt: time })).toBe(true);
  });

  test("the next whole second is strictly newer than both witness bounds", () => {
    const time = "2026-09-14T14:33:42.999Z";
    expect(processMayBeAlive(pid, false, { observedAt: time, finishedAt: time })).toBe(false);
  });

  test.each([undefined, null, "", "garbage", 0, "2026-02-30T00:00:00.000Z", "2026-09-12T16:53:59Z", "2026-09-12T16:53:59.658", "2026-09-12T09:53:59.658-07:00"])("missing, invalid or noncanonical witness time %s stays unknown", time => {
    expect(processMayBeAlive(pid, false, { ...witness, observedAt: time })).toBe(true);
    expect(processMayBeAlive(pid, false, { ...witness, finishedAt: time })).toBe(true);
    expect(processMayBeAlive(pid, false)).toBe(true);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  test.each(["", "unknown", birth + birth, "Mon Sep 14 14:33 2026", "Mon Sep 14 14:33:43 2026 UTC", "Lun Sep 14 14:33:43 2026", "Tue Sep 14 14:33:43 2026", "Mon Sep 31 14:33:43 2026", "Mon Sep 14 25:33:43 2026", "Wed Sep 16 14:33:43 2026"])("missing or invalid birth output %j stays unknown", output => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(output);
    expect(processMayBeAlive(pid, false, witness)).toBe(true);
  });

  test.each(["EPERM", "EACCES", "ENOENT", "ESRCH", "EIO", "ETIMEDOUT", "ENOBUFS"])("a failed birth read (%s), including disappearance between probes, stays unknown", code => {
    // Partial stdout on a timeout or buffer overflow is not identity proof.
    vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw Object.assign(failure(code), { stdout: birth }); });
    expect(processMayBeAlive(pid, false, witness)).toBe(true);
  });
});

test("the real host distinguishes an artificial old witness and preserves a current observation", () => {
  const old = "1970-01-01T00:00:00.000Z";
  expect(processMayBeAlive(process.pid, false, { observedAt: old, finishedAt: old })).toBe(process.platform !== "darwin");
  const time = new Date().toISOString();
  expect(processMayBeAlive(process.pid, false, { observedAt: time, finishedAt: time })).toBe(true);
});
