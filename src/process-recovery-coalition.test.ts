import { describe, expect, test } from "vitest";
import { assessDarwinCoalitionRecovery } from "./process-recovery-coalition.js";
import { APP_SERVICE_EXECUTABLE, APP_SERVICE_PLATFORM, type PreexistingAppService } from "./process-recovery-services.js";
import type { DarwinCoalitionProcessIdentity, DarwinCoalitionRecoverySnapshot } from "./process-recovery-native.js";

const bootId = "0774c645-ad9a-4d83-9efb-eca6506656c5";
const row = (pid: number, uniqueId: string, extra: Partial<DarwinCoalitionProcessIdentity> = {}): DarwinCoalitionProcessIdentity => ({ pid, uniqueId, ppid: 1, parentUniqueId: "1", uid: 501, birthMs: 1, traced: false, executable: "/usr/bin/example", originalParentVersion: 7, resourceCoalitionId: "591", ...extra });
function fixture(): DarwinCoalitionRecoverySnapshot {
  return {
    schema: 1, host: "same-host", bootId, osRelease: "25.5", startedAt: "2026-09-20T16:00:00.000Z", finishedAt: "2026-09-20T16:00:00.010Z",
    resourceCoalitionId: "591", complete: true, stable: true, kernelTableRead: true, countersStable: true,
    processes: [row(10, "100"), row(11, "450"), row(20, "600", { ppid: 10, parentUniqueId: "100" }), row(30, "700", { ppid: 20, parentUniqueId: "600" })],
    counterBefore: { tasksStarted: "10000", tasksExited: "9996" }, counterAfter: { tasksStarted: "10000", tasksExited: "9996" },
    unreadableMembershipCount: 0, identityChanges: [], errors: [], collector: { pid: 30, uniqueId: "700", exited: true },
    nativeSourceSha256: "a".repeat(64), nativeExecutableSha256: "b".repeat(64),
    anchorPids: [90], anchors: [row(90, "500", { resourceCoalitionId: "900" })], anchorIdentityChanges: [],
  };
}
const assess = (snapshot = fixture(), overrides = {}) => assessDarwinCoalitionRecovery({ host: "same-host", bootId, resourceCoalitionId: "591", sourceRoot: { pid: 10, uniqueId: "100" }, preRunUpperBound: { pid: 90, uniqueId: "500" }, snapshot, ...overrides });

describe("coalition recovery assessment", () => {
  test("uses an authenticated kernel creation bound and current ancestry, not wall birth or executable names", () => {
    const s = fixture(); s.processes[1]!.birthMs = null; s.processes[1]!.executable = null;
    expect(assess(s)).toMatchObject({ ok: true, external: [
      { pid: 10, basis: "predates-run", anchor: 90 }, { pid: 11, basis: "predates-run", anchor: 90 },
      { pid: 20, basis: "ancestry", anchor: 90 }, { pid: 30, basis: "owned-probe", anchor: 30 },
    ] });
  });
  test("a new orphan stays unresolved even with an old wall birth, launchd parent and familiar name", () => {
    const s = fixture(); s.processes[1] = row(11, "800", { executable: "/System/Library/example", birthMs: 1 });
    expect(assess(s)).toMatchObject({ ok: false, unresolved: [11] });
  });
  test.each(["host", "boot", "coalition", "source", "anchor", "trace", "anchor-trace"])("refuses changed %s identity", variant => {
    const s = fixture();
    if (variant === "host") s.host = "other";
    if (variant === "boot") s.bootId = "0774c645-ad9a-4d83-9efb-eca6506656c6";
    if (variant === "coalition") s.resourceCoalitionId = "592";
    if (variant === "source") s.processes[0]!.uniqueId = "101";
    if (variant === "anchor") s.anchors[0]!.uniqueId = "501";
    if (variant === "trace") s.processes[0]!.traced = true;
    if (variant === "anchor-trace") s.anchors[0]!.traced = true;
    expect(assess(s).ok).toBe(false);
  });
  test("both counters must remain unchanged even when their difference is unchanged", () => {
    const s = fixture(); s.counterAfter = { tasksStarted: "10001", tasksExited: "9997" };
    expect(assess(s).ok).toBe(false);
  });
  test.each(["count", "duplicate", "foreign", "overflow", "negative", "unreadable", "unknown-membership", "unstable", "anchor-changed", "kernel", "missing-anchor"])("refuses an incomplete or malformed %s inventory", variant => {
    const s = fixture();
    if (variant === "count") s.processes.pop();
    if (variant === "duplicate") s.processes[1]!.uniqueId = "100";
    if (variant === "foreign") s.processes[1]!.resourceCoalitionId = "592";
    if (variant === "overflow") s.counterBefore!.tasksStarted = "18446744073709551616";
    if (variant === "negative") s.counterBefore!.tasksExited = "-1";
    if (variant === "unreadable") s.errors = ["native-census-unavailable"];
    if (variant === "unknown-membership") s.unreadableMembershipCount = 1;
    if (variant === "unstable") s.identityChanges = [20];
    if (variant === "anchor-changed") s.anchorIdentityChanges = [90];
    if (variant === "kernel") s.kernelTableRead = false;
    if (variant === "missing-anchor") s.anchorPids = [];
    expect(assess(s).ok).toBe(false);
  });
  test.each(["missing", "reused", "later", "trace"])("refuses %s ancestry for a post-bound process", variant => {
    const s = fixture();
    if (variant === "missing") s.processes[2]!.ppid = 12;
    if (variant === "reused") s.processes[2]!.parentUniqueId = "99";
    if (variant === "later") { s.processes[1] = row(11, "650", { ppid: 10, parentUniqueId: "100" }); s.processes[2]!.ppid = 11; s.processes[2]!.parentUniqueId = "650"; }
    if (variant === "trace") s.processes[2]!.traced = true;
    expect(assess(s)).toMatchObject({ ok: false, unresolved: [20] });
  });
  test("a collector exclusion requires the exact identity and positive owned exit", () => {
    const s = fixture(); s.collector!.uniqueId = "701";
    expect(assess(s).ok).toBe(false);
    s.collector = null; expect(assess(s).ok).toBe(false);
  });
  test("large uint64 identities retain ordering beyond JavaScript number precision", () => {
    const s = fixture(); s.anchors[0]!.uniqueId = "9007199254740993"; s.processes[1]!.uniqueId = "9007199254740994";
    expect(assess(s, { preRunUpperBound: { pid: 90, uniqueId: "9007199254740993" } })).toMatchObject({ ok: false, unresolved: [11] });
  });
  function appService() {
    const snapshot = fixture(); snapshot.osRelease = APP_SERVICE_PLATFORM.osRelease;
    snapshot.processes[0]!.executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    snapshot.processes[0]!.pidVersion = 1;
    snapshot.processes[1] = row(11, "800", { executable: APP_SERVICE_EXECUTABLE });
    const binding: PreexistingAppService = { pid: 11, uniqueId: "800", ownerPid: 10, ownerUniqueId: "100", uid: 501,
      ownerExecutable: snapshot.processes[0]!.executable!, ownerPidVersion: 1, ownerSigning: null,
      resourceCoalitionId: "591", executable: APP_SERVICE_EXECUTABLE, domain: "pid/10", platform: APP_SERVICE_PLATFORM };
    return { snapshot, binding };
  }
  test("a collected app-domain mapping distinguishes a new service from an unexplained orphan", () => {
    const { snapshot, binding } = appService();
    expect(assess(snapshot)).toMatchObject({ ok: false, unresolved: [11] });
    // A launchd PID 0 yields no receipt; a still-live orphan in the final
    // native census cannot be cleared by that non-running service entry.
    expect(assess(snapshot, { preexistingAppServices: [] })).toMatchObject({ ok: false, unresolved: [11] });
    expect(assess(snapshot, { preexistingAppServices: [binding] })).toMatchObject({ ok: true,
      external: expect.arrayContaining([{ pid: 11, basis: "pre-existing-app-service", anchor: 10 }]) });
  });
  test.each(["service-reuse", "owner-reuse", "new-owner", "traced", "uid", "domain", "platform", "duplicate", "missing", "owner-executable", "pid-version", "service-executable"])("refuses a %s app-service mapping", variant => {
    const { snapshot, binding } = appService(); const services = [binding];
    if (variant === "service-reuse") binding.uniqueId = "801";
    if (variant === "owner-reuse") binding.ownerUniqueId = "101";
    if (variant === "new-owner") { snapshot.processes[0]!.uniqueId = "550"; binding.ownerUniqueId = "550"; }
    if (variant === "traced") snapshot.processes[1]!.traced = true;
    if (variant === "uid") binding.uid = 502;
    if (variant === "domain") binding.domain = "pid/20";
    if (variant === "platform") binding.platform = { ...APP_SERVICE_PLATFORM, launchctlSha256: "changed" };
    if (variant === "duplicate") services.push(binding);
    if (variant === "missing") binding.pid = 12;
    if (variant === "owner-executable") binding.ownerExecutable = "/untrusted/Chrome";
    if (variant === "pid-version") binding.ownerPidVersion++;
    if (variant === "service-executable") { binding.executable = "/untrusted/Speech"; snapshot.processes[1]!.executable = binding.executable; }
    expect(assess(snapshot, { preexistingAppServices: services }).ok).toBe(false);
  });
});
