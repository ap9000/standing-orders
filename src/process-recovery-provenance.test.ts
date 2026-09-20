import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { collectLegacySourceProvenance, collectedLegacyProvenanceOf, inspectLegacyExecutionAncestry, inspectLegacyProvenanceRecords,
  LEGACY_PROVENANCE_PROFILE_V1_SHA256, type LegacyProvenanceProfile } from "./process-recovery-provenance.js";
import type { DarwinCoalitionProcessIdentity, DarwinCoalitionRecoverySnapshot } from "./process-recovery-native.js";

const time = (n: number) => `2026-09-20T12:00:0${n}.000Z`;
const bootId = "0774c645-ad9a-4d83-9efb-eca6506656c5";
function fixture() {
  const profile: LegacyProvenanceProfile = {
    schema: 1, kind: "codex-local-prepared-run-provenance-v1", appSession: "app-session", threadId: "thread",
    bundle: { asarPath: "/app/archive", members: [], cliPath: "/app/cli", cliSha256: "a", infoPath: "/app/info", infoSha256: "b", cliVersion: "1", appVersion: "2" },
    startup: { path: "/logs/codex-desktop-app-session-10-a.log", bytes: 1, sha256: "c", spawnLine: 1, connectionLine: 2, cliVersionLine: 3, appVersionLine: 4 },
    rollout: { path: "/logs/thread.jsonl", bytes: 1, sha256: "d", invocationLine: 1, startLine: 2, completionLine: 3 },
    invocation: { callId: "call", turnId: "turn", input: "exact tool input", sessionId: "session", command: ["/bin/zsh", "-lc", "exact command"], cwd: "file:///repo" },
    source: { desktopPid: 10, desktopUniqueId: "100", desktopExecutable: "/app/desktop", serverPid: 20, serverUniqueId: "200" },
    target: { runId: 40, taskRef: 2, base: "base", head: "head", scopeDigest: "scope", startedAt: time(2), finishedAt: time(3) },
    firstPartyAudit: { source: { path: "/audit/source", sha256: "a" }, environment: { path: "/audit/environment", sha256: "b" },
      codeEvidence: { path: "/audit/code", sha256: "c" }, repository: "/repo", candidate: "head", tree: "tree", installedSourceCommit: "installed", command: "gate" },
    anchor: { databasePath: "/db", targetRun: 40, anchorReviewerRun: 30, runtime: "/runtime", runtimeSha256: "e", runner: "runner", repo: "/repo",
      host: "host", bootId, resourceCoalitionId: "5", service: "gui/501/service", supervisorPid: 50, workerPid: 60, port: 4000, supervisorArgv: [], workerArgv: [] },
  };
  const startup = ["[StdioConnection] stdio_transport_spawned executablePath=/app/cli pid=20 spawnCommand=/app/cli",
    "Transport start success connectionId=1 hostId=local transport=stdio",
    "Current reported app-server version: currentVersion=1 hostId=local", "appSessionId=app-session release=2 ready=true"];
  const meta = { turn_id: "turn" };
  const records = [
    { timestamp: time(0), type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call", input: "exact tool input", internal_chat_message_metadata_passthrough: meta } },
    { timestamp: time(1), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", internal_chat_message_metadata_passthrough: meta,
      output: [{ type: "input_text", text: JSON.stringify({ session_id: "session" }) }] } },
    { timestamp: time(4), type: "event_msg", payload: { type: "item_completed", thread_id: "thread", turn_id: "turn", item: { type: "CommandExecution", source: "unified_exec_startup",
      process_id: "session", status: "completed", exit_code: 0, command: profile.invocation.command, cwd: profile.invocation.cwd,
      stdout: JSON.stringify({ mode: "build", status: "tick-returned", exitCode: 0, results: [{ id: 40, role: "builder", parentRun: null, outcome: "built", head: "head", finishedAt: time(3) }] }) } } },
  ];
  const inspect = () => inspectLegacyProvenanceRecords(profile, Buffer.from(startup.join("\n")), Buffer.from(records.map(one => JSON.stringify(one)).join("\n")));
  return { profile, startup, records, inspect };
}
const row = (pid: number, uniqueId: string, ppid: number, parentUniqueId: string, extra = {}): DarwinCoalitionProcessIdentity => ({
  pid, uniqueId, ppid, parentUniqueId, uid: 501, birthMs: 1, traced: false, executable: "/app/other", originalParentVersion: 1, resourceCoalitionId: "5", ...extra,
});
function census(): DarwinCoalitionRecoverySnapshot {
  return { schema: 1, host: "host", bootId, resourceCoalitionId: "5", osRelease: "25", startedAt: time(5), finishedAt: time(6),
    complete: true, stable: true, kernelTableRead: true, countersStable: true, errors: [], identityChanges: [], anchorIdentityChanges: [],
    counterBefore: { tasksStarted: "100", tasksExited: "96" }, counterAfter: { tasksStarted: "100", tasksExited: "96" }, unreadableMembershipCount: 0,
    nativeSourceSha256: "a".repeat(64), nativeExecutableSha256: "b".repeat(64), anchorPids: [], anchors: [],
    processes: [row(10, "100", 1, "1", { executable: "/app/desktop" }), row(20, "200", 10, "100", { executable: "/app/cli" }), row(30, "500", 20, "200"), row(40, "600", 30, "500")],
    collector: { pid: 40, uniqueId: "600", exited: true } };
}

describe("legacy source provenance", () => {
  test("matches positive startup/version, exact invocation and awaited prepared-run completion", () => { expect(fixture().inspect).not.toThrow(); });
  test.each(["app-session", "source-pid", "connection", "cli-version", "app-version", "input", "turn", "session", "thread", "command", "exit", "head", "ordering"])("refuses changed %s historical binding", variant => {
    const f = fixture();
    if (variant === "app-session") f.profile.appSession = "different";
    if (variant === "source-pid") f.profile.source.serverPid++;
    if (variant === "connection") f.startup[1] = f.startup[1]!.replace("connectionId=1", "connectionId=2");
    if (variant === "cli-version") f.profile.bundle.cliVersion = "other";
    if (variant === "app-version") f.profile.bundle.appVersion = "other";
    if (variant === "input") f.profile.invocation.input += "changed";
    if (variant === "turn") f.profile.invocation.turnId = "other";
    if (variant === "session") f.profile.invocation.sessionId = "other";
    if (variant === "thread") f.profile.threadId = "other";
    if (variant === "command") f.profile.invocation.command = ["different"];
    if (variant === "exit") f.records[2]!.payload.item!.exit_code = 1;
    if (variant === "head") f.profile.target.head = "different";
    if (variant === "ordering") f.profile.target.startedAt = time(5);
    expect(f.inspect).toThrow();
  });
  test("current execution must positively descend from the exact old source, not merely find it alive", () => {
    const profile = fixture().profile, snapshot = census();
    expect(() => inspectLegacyExecutionAncestry(profile, snapshot, 30, "400")).not.toThrow();
    snapshot.processes[2]!.ppid = 1; snapshot.processes[2]!.parentUniqueId = "1";
    expect(() => inspectLegacyExecutionAncestry(profile, snapshot, 30, "400")).toThrow();
  });
  test("the native uppercase UUID names the same boot; malformed tokens still refuse", () => {
    const s = census(), profile = fixture().profile;
    s.bootId = bootId.toUpperCase(); expect(() => inspectLegacyExecutionAncestry(profile, s, 30, "400")).not.toThrow();
    s.bootId += " unrelated"; expect(() => inspectLegacyExecutionAncestry(profile, s, 30, "400")).toThrow();
  });
  test.each(["source-reused", "desktop-reused", "traced", "parent-reused", "parent-later", "uid", "collector-reused", "collector-parent", "missing", "unstable", "host", "boot", "foreign", "bound"])("refuses %s live identity proof", variant => {
    const profile = fixture().profile, s = census(); let bound = "400";
    if (variant === "source-reused") s.processes[1]!.uniqueId = "201";
    if (variant === "desktop-reused") s.processes[0]!.uniqueId = "101";
    if (variant === "traced") s.processes[1]!.traced = true;
    if (variant === "parent-reused") s.processes[2]!.parentUniqueId = "199";
    if (variant === "parent-later") s.processes[2]!.uniqueId = "199";
    if (variant === "uid") s.processes[2]!.uid = 502;
    if (variant === "collector-reused") s.collector!.uniqueId = "601";
    if (variant === "collector-parent") s.processes[3]!.parentUniqueId = "499";
    if (variant === "missing") s.processes.splice(2, 1);
    if (variant === "unstable") s.identityChanges = [30];
    if (variant === "host") s.host = "other";
    if (variant === "boot") s.bootId = "other";
    if (variant === "foreign") s.resourceCoalitionId = "6";
    if (variant === "bound") bound = "199";
    expect(() => inspectLegacyExecutionAncestry(profile, s, 30, bound)).toThrow();
  });
  test("successful document inspection cannot mint or deserialize a live proof", () => {
    fixture().inspect();
    const counterfeit = { kind: "collected-legacy-source-provenance" as const, profileSha256: LEGACY_PROVENANCE_PROFILE_V1_SHA256, digest: "a".repeat(64) };
    expect(collectedLegacyProvenanceOf(counterfeit)).toBeNull();
    expect(collectedLegacyProvenanceOf(JSON.parse(JSON.stringify(counterfeit)))).toBeNull();
  });
  test.each(["unpinned", "oversized", "symlink"])("refuses %s profile before database or native collection", async variant => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "provenance-"))), path = join(directory, "profile.json");
    try {
      writeFileSync(path, variant === "oversized" ? "x".repeat(32769) : JSON.stringify(fixture().profile), { mode: 0o600 });
      const linked = join(directory, "linked.json"); if (variant === "symlink") symlinkSync(path, linked);
      const prepare = vi.fn(() => { throw Error("must not touch database"); });
      expect(await collectLegacySourceProvenance({ prepare }, { profilePath: variant === "symlink" ? linked : path, compilationDirectory: directory }))
        .toEqual({ ok: false, reason: "legacy-source-provenance-unproven", phase: "reviewed-profile" });
      expect(prepare).not.toHaveBeenCalled();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
