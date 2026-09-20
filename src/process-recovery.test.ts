import { expect, test } from "vitest";
import { assessDarwinObserverRecovery, type ProcessRecoveryAnchor } from "./process-recovery.js";
import type { DarwinProcessIdentity, DarwinProcessRecoverySnapshot } from "./process-recovery-native.js";

const boot = "0774c645-ad9a-4d83-9efb-eca6506656c5";
const boundary = "2026-09-20T12:23:00.315Z";
const old = Date.parse("2026-09-20T11:00:00.000Z"), young = Date.parse("2026-09-20T12:24:00.000Z");
const row = (pid: number, ppid: number, birthMs: number | null, uniqueId = String(pid), parentUniqueId = String(ppid)): DarwinProcessIdentity => ({ pid, ppid, uid: 501, birthMs, uniqueId, parentUniqueId, traced: false, executable: null, originalParentVersion: 7 });
const snapshot = (...processes: DarwinProcessIdentity[]): DarwinProcessRecoverySnapshot => ({
  schema: 1, host: "test-host", bootId: boot, osRelease: "test", startedAt: "2026-09-20T12:30:00.000Z", finishedAt: "2026-09-20T12:30:01.000Z",
  elevation: "none", complete: true, stable: true, processes: [row(1, 0, old), row(10, 1, old), ...processes], managedServices: [],
  collectorPids: [], domainFailures: [], identityChanges: [], errors: [], nativeSourceSha256: "a".repeat(64), nativeExecutableSha256: "b".repeat(64), pidDomains: [],
});
const preRun: ProcessRecoveryAnchor[] = [{ pid: 1, uniqueId: "1" }, { pid: 10, uniqueId: "10" }];
const assess = (s: DarwinProcessRecoverySnapshot, anchors: { preRunIdentities?: readonly ProcessRecoveryAnchor[]; trustedExternalManagedServiceIdentities?: readonly ProcessRecoveryAnchor[] } = {}) => assessDarwinObserverRecovery({
  host: "test-host", bootId: boot, boundary, runFinishedAt: "2026-09-20T12:27:00.000Z", snapshot: s,
  preRunIdentities: anchors.preRunIdentities ?? preRun,
  trustedExternalManagedServiceIdentities: anchors.trustedExternalManagedServiceIdentities ?? [],
});

test("stable kernel ancestry to an authenticated pre-run identity is external", () => {
  expect(assess(snapshot(row(20, 10, young), row(21, 20, young)))).toMatchObject({ ok: true, external: expect.arrayContaining([{ pid: 21, basis: "ancestry", anchor: 10 }]) });
});
test("wall birth alone cannot establish a pre-run anchor, including a rollback birth", () => {
  expect(assess(snapshot(row(20, 1, old)))).toMatchObject({ ok: false, unresolved: [20] });
  expect(assess(snapshot(), { preRunIdentities: [] })).toMatchObject({ ok: false, unresolved: [1, 10] });
  const changedWallClock = snapshot();
  changedWallClock.processes[1]!.birthMs = young;
  expect(assess(changedWallClock)).toMatchObject({ ok: true });
});
test("pre-run anchors bind the exact PID and unique64, not a reused PID", () => {
  const s = snapshot(row(20, 10, young, "200", "100"));
  s.processes[1]!.uniqueId = "100";
  expect(assess(s)).toMatchObject({ ok: false, unresolved: [10, 20] });
});
test("an orphan, including orphan exec with launchd parent64 and matching version32, remains unresolved", () => {
  expect(assess(snapshot(row(20, 1, young)))).toMatchObject({ ok: false, unresolved: [20] });
});
test("a launchd service requires an independent exact external identity as well as service binding", () => {
  const s = snapshot(row(20, 1, young), row(21, 20, young));
  const trustedExternalManagedServiceIdentities = [{ pid: 20, uniqueId: "20" }];
  expect(assess(s, { trustedExternalManagedServiceIdentities })).toMatchObject({ ok: false, unresolved: [20, 21] });
  s.managedServices = [{ domain: "system", label: "test.service", pid: 20, uniqueId: "20", beforeUniqueId: "20", afterUniqueId: "20", identityBound: true }];
  // A task-delegated job is also managed by launchd; its listing is insufficient.
  expect(assess(s)).toMatchObject({ ok: false, unresolved: [20, 21] });
  expect(assess(s, { trustedExternalManagedServiceIdentities: [{ pid: 20, uniqueId: "2000" }] })).toMatchObject({ ok: false, unresolved: [20, 21] });
  expect(assess(s, { trustedExternalManagedServiceIdentities })).toMatchObject({ ok: true });
  s.managedServices[0]!.afterUniqueId = "2000";
  expect(assess(s, { trustedExternalManagedServiceIdentities })).toMatchObject({ ok: false, unresolved: [20, 21] });
});
test.each(["pre-run", "managed", "probe"])("a traced %s root cannot anchor external descendants", variant => {
  const s = snapshot(row(20, 10, young), row(21, 20, young));
  s.processes[2]!.traced = true;
  const anchors: Parameters<typeof assess>[1] = {};
  if (variant === "pre-run") anchors.preRunIdentities = [...preRun, { pid: 20, uniqueId: "20" }];
  if (variant === "managed") {
    s.managedServices = [{ domain: "system", label: "test.service", pid: 20, uniqueId: "20", beforeUniqueId: "20", afterUniqueId: "20", identityBound: true }];
    anchors.trustedExternalManagedServiceIdentities = [{ pid: 20, uniqueId: "20" }];
  }
  if (variant === "probe") s.collectorPids = [20];
  expect(assess(s, anchors)).toMatchObject({ ok: false, unresolved: [20, 21] });
});
test("parent creation identity must precede its child even after detach and exec changed parent64", () => {
  expect(assess(snapshot(row(30, 10, young), row(20, 30, young)))).toMatchObject({ ok: false, unresolved: [20] });
  // Compare full uint64 values, not rounded JS numbers or decimal strings.
  expect(assess(snapshot(row(20, 10, young, "9007199254740993"), row(21, 20, young, "9007199254740992", "9007199254740993")))).toMatchObject({ ok: false, unresolved: [21] });
  expect(assess(snapshot(row(20, 10, young, "100"), row(21, 20, young, "101", "100")))).toMatchObject({ ok: true });
});
test.each(["preRunIdentities", "trustedExternalManagedServiceIdentities"] as const)("%s rejects malformed or ambiguous anchors", field => {
  for (const anchors of [[{ pid: 10, uniqueId: "18446744073709551616" }], [...preRun, { pid: 10, uniqueId: "11" }], [...preRun, { pid: 11, uniqueId: "10" }]]) {
    expect(assess(snapshot(), { [field]: anchors }).ok).toBe(false);
  }
});
test.each(["reused-parent", "missing-parent", "traced", "unknown-birth", "same-second"])("%s cannot be an externality shortcut", variant => {
  const child = row(20, 10, young);
  if (variant === "reused-parent") child.parentUniqueId = "10000";
  if (variant === "missing-parent") child.ppid = 99;
  if (variant === "traced") child.traced = true;
  if (variant === "unknown-birth") { child.ppid = 1; child.birthMs = null; }
  if (variant === "same-second") { child.ppid = 1; child.birthMs = Date.parse(boundary) - 1; }
  expect(assess(snapshot(child))).toMatchObject({ ok: false, unresolved: [20] });
});
test("cycles and PID domains without a managed-service PID are not proof", () => {
  const s = snapshot(row(20, 21, young), row(21, 20, young));
  expect(assess(s)).toMatchObject({ ok: false, unresolved: [20, 21] });
  const orphan = snapshot(row(22, 1, young));
  orphan.pidDomains = [{ pid: 22, domain: "pid/22", readable: true, identityBound: true, uniqueId: "22", type: "pid", handle: 22, originator: "/System/test.xpc", creatorPid: 1 }];
  expect(assess(orphan)).toMatchObject({ ok: false, unresolved: [22] });
});
test.each(["different-boot", "different-host", "incomplete", "changed", "error", "duplicate", "before-finish"])("%s census cannot authorize recovery", variant => {
  const s = snapshot();
  if (variant === "different-boot") s.bootId = "1774c645-ad9a-4d83-9efb-eca6506656c5";
  if (variant === "different-host") s.host = "another-host";
  if (variant === "incomplete") s.complete = false;
  if (variant === "changed") s.identityChanges = [10];
  if (variant === "error") s.errors = ["unreadable-process"];
  if (variant === "duplicate") s.processes.push({ ...s.processes[0]! });
  if (variant === "before-finish") s.startedAt = boundary;
  expect(assess(s).ok).toBe(false);
});
