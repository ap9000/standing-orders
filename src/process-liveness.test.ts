import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as childProcess from "node:child_process";
import { processMayBeAlive } from "./process-liveness.js";

vi.mock("node:child_process", { spy: true });

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const pid = 87803;
const witness = { observedAt: "2026-09-12T16:53:59.658Z", finishedAt: "2026-09-12T17:00:00.000Z" };
const birth = "Mon Sep 14 14:33:43 2026\n";
const failure = (code: string) => Object.assign(new Error(code), { code });

// The same uncertainty must block both ordinary and permission-denied probes,
// for the single PID and the exact PID equal to a populated historical PGID.
function expectUnknownIdentity(w: Parameters<typeof processMayBeAlive>[2]) {
  for (const group of [false, true]) {
    for (const denied of [false, true]) {
      vi.mocked(process.kill).mockImplementation(() => { if (denied) throw failure("EPERM"); return true; });
      expect(processMayBeAlive(pid, group, w), `group=${group}, EPERM=${denied}`).toBe(true);
    }
  }
}

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

  test.each(["populated", "EPERM"])("a %s historical group is gone only with proven allocation of its exact number as a newer PID", state => {
    vi.mocked(process.kill).mockImplementation(() => { if (state === "EPERM") throw failure(state); return true; });
    expect(processMayBeAlive(pid, true, witness)).toBe(false);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-pid, 0);
    expect(childProcess.execFileSync).toHaveBeenCalledExactlyOnceWith("/bin/ps", ["-p", String(pid), "-o", "lstart="], expect.anything());
  });

  test.each(["EACCES", "EIO"])("an unexpected %s group error remains occupied even with readable newer birth", state => {
    vi.mocked(process.kill).mockImplementation(() => { throw failure(state); });
    expect(processMayBeAlive(pid, true, witness)).toBe(true);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-pid, 0);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  test.each([false, true])("missing PID stays absent and unexpected PID errors stay unknown (group=%s)", group => {
    for (const code of ["ESRCH", "EACCES", "EINVAL", "unknown"]) {
      vi.mocked(process.kill).mockImplementation(target => { throw failure(target < 0 ? "ESRCH" : code); });
      expect(processMayBeAlive(pid, group, witness), code).toBe(code !== "ESRCH");
    }
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  test.each([false, true])("EPERM on the PID requires independently readable proven-new birth (group=%s)", group => {
    vi.mocked(process.kill).mockImplementation(target => { throw failure(target < 0 ? "ESRCH" : "EPERM"); });
    expect(processMayBeAlive(pid, group, witness)).toBe(false);
    vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw failure("EPERM"); });
    expect(processMayBeAlive(pid, group, witness)).toBe(true);
    expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  test.each(["populated", "EPERM"])("orphan children in a %s group survive an absent leader, regardless of newer members", state => {
    vi.mocked(process.kill).mockImplementation(target => {
      if (target > 0) throw failure("ESRCH");
      if (state === "EPERM") throw failure(state);
      return true;
    });
    vi.mocked(childProcess.execFileSync).mockImplementation((_file, args) => {
      if (args?.[1] === String(pid)) throw failure("ESRCH");
      return birth; // A newer member is never requested or accepted as proof.
    });
    expect(processMayBeAlive(pid, true, witness)).toBe(true);
    expect(childProcess.execFileSync).toHaveBeenCalledExactlyOnceWith("/bin/ps", ["-p", String(pid), "-o", "lstart="], expect.anything());
  });

  test.each([
    [65058, "2026-09-12T18:48:12.284Z", "2026-09-12T19:22:17.385Z", "Tue Sep 15 05:07:32 2026\n"],
    [31964, "2026-09-14T00:28:37.547Z", "2026-09-14T00:53:45.504Z", "Tue Sep 15 00:21:28 2026\n"],
  ] as const)("read-only Mac sample PGID %s is positively reused", (saved, observedAt, finishedAt, output) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-15T18:11:08.770Z"));
    vi.mocked(childProcess.execFileSync).mockReturnValue(output);
    expect(processMayBeAlive(saved, true, { observedAt, finishedAt })).toBe(false);
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
    vi.mocked(process.kill).mockImplementation(() => { throw failure("EPERM"); });
    expect(processMayBeAlive(pid, true, witness)).toBe(true);
    expect(processMayBeAlive(pid, false, witness)).toBe(true);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  test("birth during the run cannot disprove a reservation made before spawn", () => {
    expectUnknownIdentity({ ...witness, finishedAt: "2026-09-14T14:33:44.000Z" });
  });

  test.each(["2026-09-14T14:33:43.000Z", "2026-09-14T14:33:43.999Z", "2026-09-14T14:33:44.000Z"])("same-second or older birth is ambiguous at %s", time => {
    expectUnknownIdentity({ ...witness, observedAt: time });
    expectUnknownIdentity({ ...witness, finishedAt: time });
  });

  test("the next whole second is strictly newer than both witness bounds", () => {
    const time = "2026-09-14T14:33:42.999Z";
    expect(processMayBeAlive(pid, false, { observedAt: time, finishedAt: time })).toBe(false);
  });

  test.each([undefined, null, "", "garbage", 0, "2026-02-30T00:00:00.000Z", "2026-09-12T16:53:59Z", "2026-09-12T16:53:59.658", "2026-09-12T09:53:59.658-07:00"])("missing, invalid or noncanonical witness time %s stays unknown", time => {
    expectUnknownIdentity({ ...witness, observedAt: time });
    expectUnknownIdentity({ ...witness, finishedAt: time });
    expectUnknownIdentity(undefined);
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });

  test.each(["", "unknown", birth + birth, "Mon Sep 14 14:33 2026", "Mon Sep 14 14:33:43 2026 UTC", "Lun Sep 14 14:33:43 2026", "Tue Sep 14 14:33:43 2026", "Mon Sep 31 14:33:43 2026", "Mon Sep 14 25:33:43 2026", "Wed Sep 16 14:33:43 2026"])("missing or invalid birth output %j stays unknown", output => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(output);
    expectUnknownIdentity(witness);
  });

  test.each(["EPERM", "EACCES", "ENOENT", "ESRCH", "EIO", "ETIMEDOUT", "ENOBUFS"])("a failed birth read (%s), including disappearance between probes, stays unknown", code => {
    // Partial stdout on a timeout or buffer overflow is not identity proof.
    vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw Object.assign(failure(code), { stdout: birth }); });
    expectUnknownIdentity(witness);
  });
});

test("the real host distinguishes an artificial old witness and preserves a current observation", () => {
  const old = "1970-01-01T00:00:00.000Z";
  expect(processMayBeAlive(process.pid, false, { observedAt: old, finishedAt: old })).toBe(process.platform !== "darwin");
  const time = new Date().toISOString();
  expect(processMayBeAlive(process.pid, false, { observedAt: time, finishedAt: time })).toBe(true);
});
