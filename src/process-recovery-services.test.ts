import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DarwinCoalitionProcessIdentity, DarwinCoalitionRecoverySnapshot } from "./process-recovery-native.js";
const probe = vi.hoisted(() => ({ command: vi.fn(), collect: vi.fn(), file: vi.fn(), hash: vi.fn(), sign: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: (...args: unknown[]) => probe.command(...args), spawnSync: (...args: unknown[]) => probe.sign(...args) }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), readFileSync: (...args: unknown[]) => probe.file(...args) }));
vi.mock("node:crypto", () => ({ createHash: () => { let value: string; return { update(x: string) { value = x; return this; }, digest: () => probe.hash(value) }; } }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), release: () => "25.5.0" }));
vi.mock("./process-recovery-native.js", async original => ({ ...await original<typeof import("./process-recovery-native.js")>(), collectDarwinCoalitionSnapshot: (...args: unknown[]) => probe.collect(...args) }));
import { APP_SERVICE_PLATFORM as platform, collectPreexistingAppServices } from "./process-recovery-services.js";

const bundle = "/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/SpeechSynthesis.framework/Versions/A/XPCServices/SpeechSynthesisServerXPC.xpc";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", executable = `${bundle}/Contents/MacOS/SpeechSynthesisServerXPC`, label = platform.label;
const identity = (pid: number, uniqueId: string, exe: string): DarwinCoalitionProcessIdentity => ({ pid, uniqueId, executable: exe,
  ppid: 1, parentUniqueId: "1", uid: 501, birthMs: 1, traced: false, originalParentVersion: 7, pidVersion: pid * 10, resourceCoalitionId: "591" });
function snapshot(): DarwinCoalitionRecoverySnapshot {
  return { schema: 1, host: "test", bootId: "0774c645-ad9a-4d83-9efb-eca6506656c5", osRelease: "25.5.0", startedAt: "before", finishedAt: "after",
    complete: true, stable: true, resourceCoalitionId: "591", anchorPids: [30], anchors: [identity(30, "300", "/worker")], anchorIdentityChanges: [],
    processes: [identity(10, "100", chrome), identity(20, "400", executable), identity(40, "500", "/census")],
    counterBefore: { tasksStarted: "10", tasksExited: "7" }, counterAfter: { tasksStarted: "10", tasksExited: "7" }, countersStable: true,
    kernelTableRead: true, unreadableMembershipCount: 0, identityChanges: [], errors: [], collector: { pid: 40, uniqueId: "500", exited: true },
    nativeSourceSha256: "a".repeat(64), nativeExecutableSha256: "b".repeat(64) };
}
let domain: string, job: string;
const clone = "/private/audited-clone/Google Chrome";
const args = () => ({ snapshot: snapshot(), native: { sourcePath: "/census.c", executablePath: "/census", sourceSha256: "a".repeat(64), executableSha256: "b".repeat(64) }, upperBound: { pid: 30, uniqueId: "300" }, anchorPids: [30] });
beforeEach(() => {
  vi.stubGlobal("process", new Proxy(process, { get(target, key) { return key === "platform" ? "darwin" : Reflect.get(target, key); } }));
  domain = `pid/10 = {\n\ttype = pid\n\thandle = 10\n\toriginator = /Applications/Google Chrome.app\n\tcreator = Google Chrome[10]\n\tcreator euid = 501\n\tuniqueid = 100\n\tenvironment = {\n\t\tSECRET => PRIVATE_ENVIRONMENT\n\t}\n\tservices = {\n\t\t20 (pe) ${label}\n\t}\n\ttask-special ports = {\n\t\t\t 0x123 4 bootstrap (unknown)\n\t}\n}\n`;
  job = `pid/10/${label} = {\n\ttype = XPCService\n\tstate = running\n\tpath = ${bundle}\n\tprogram = ${executable}\n\tbundle id = ${label}\n\tenvironment = {\n\t\tSECRET => PRIVATE_ENVIRONMENT\n\t}\n\tdomain = pid/10 [Google Chrome]\n\tpid = 20\n\tforks = 0\n\texecs = 1\n}\n`;
  probe.command.mockReset().mockImplementation((file: string, argv: string[]) => {
    if (file === "/usr/bin/sw_vers" && argv.join() === "-buildVersion") return "25F84\n";
    if (file === "/bin/launchctl" && argv[0] === "print" && argv[1] === "pid/10") return domain;
    if (file === "/bin/launchctl" && argv[0] === "print" && argv[1] === `pid/10/${label}`) return job;
    throw Error("unexpected command");
  });
  probe.hash.mockReset().mockImplementation((data: string) => data === clone ? platform.clonePathSha256 : data);
  probe.sign.mockReset().mockImplementation((_file: string, argv: string[]) => ({ status: 0, signal: null, stdout: "", stderr: argv[0] === "--verify" ? "" : `Executable=${clone}\nIdentifier=com.google.Chrome\nTimestamp=Sep 7, 2026 at 5:44:02\u202fPM\nTeamIdentifier=EQHXZ8M8AV\nCDHash=${platform.cloneCdHash}\n` }));
  probe.file.mockReset().mockImplementation((path: string) => path === clone ? platform.cloneSha256 : path === "/usr/bin/codesign" ? platform.codesignSha256 : path === "/bin/launchctl" ? platform.launchctlSha256 : path.endsWith("Info.plist") ? platform.plistSha256 : platform.executableSha256);
  probe.collect.mockReset().mockImplementation(async () => snapshot());
});
afterEach(() => vi.unstubAllGlobals());

it("binds exact pre-run owner/service identities through repeated reads and fresh complete censuses, without custody writes or raw environments", async () => {
  const input = args(), before = structuredClone(input);
  const result = await collectPreexistingAppServices(input);
  expect(result).toMatchObject({ ok: true, services: [{ pid: 20, uniqueId: "400", ownerPid: 10, ownerUniqueId: "100", domain: "pid/10", platform }] });
  expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE_ENVIRONMENT/);
  expect(input).toEqual(before);
  expect(probe.collect).toHaveBeenCalledTimes(2);
  expect(Math.max(...probe.command.mock.invocationCallOrder, ...probe.file.mock.invocationCallOrder, ...probe.sign.mock.invocationCallOrder)).toBeLessThan(probe.collect.mock.invocationCallOrder[1]!);
  expect(probe.collect).toHaveBeenCalledWith({ native: input.native, resourceCoalitionId: "591", anchorPids: [30], maxAttempts: 1 });
  expect(probe.command.mock.calls.every(([file, argv]) => file === "/usr/bin/sw_vers" || argv[0] === "print")).toBe(true);
});
it.each(["launchctl", "plist", "executable", "os"])("refuses substituted platform input: %s", async variant => {
  if (variant === "os") probe.command.mockReturnValueOnce("changed");
  else probe.file.mockImplementation((path: string) => path === "/bin/launchctl" ? (variant === "launchctl" ? "changed" : platform.launchctlSha256) : path.endsWith("Info.plist") ? (variant === "plist" ? "changed" : platform.plistSha256) : "changed");
  expect(await collectPreexistingAppServices(args())).toEqual({ ok: false, reason: "app-service-platform-unrecognized" });
  expect(probe.collect).not.toHaveBeenCalled();
});
it.each(["owner-reuse", "service-reuse", "exec", "missing", "traced", "uid", "coalition", "executable", "anchor", "incomplete", "helper", "boot"])("refuses changed native observation: %s", async variant => {
  const next = snapshot();
  if (variant === "owner-reuse") next.processes[0]!.uniqueId = "101";
  if (variant === "exec") next.processes[0]!.pidVersion!++;
  if (variant === "service-reuse") next.processes[1]!.uniqueId = "401";
  if (variant === "missing") next.processes.splice(1, 1);
  if (variant === "traced") next.processes[1]!.traced = true;
  if (variant === "uid") next.processes[1]!.uid = 502;
  if (variant === "coalition") next.processes[1]!.resourceCoalitionId = "592";
  if (variant === "executable") next.processes[1]!.executable = "/other";
  if (variant === "anchor") next.anchors[0]!.uniqueId = "301";
  if (variant === "incomplete") next.complete = false;
  if (variant === "helper") next.nativeExecutableSha256 = "c".repeat(64);
  if (variant === "boot") next.bootId = "00000000-0000-0000-0000-000000000000";
  probe.collect.mockResolvedValueOnce(next);
  expect((await collectPreexistingAppServices(args())).ok).toBe(false);
});
it("does not promote a new owner's service or query its domain", async () => {
  const input = args(); input.snapshot.processes[0]!.uniqueId = "301";
  const next = structuredClone(input.snapshot); probe.collect.mockResolvedValue(next);
  expect(await collectPreexistingAppServices(input)).toMatchObject({ ok: true, services: [] });
  expect(probe.command.mock.calls.filter(([file]) => file === "/bin/launchctl")).toHaveLength(0);
});
it("creates no exclusion binding from a pending PID 0 and retains unmatched native processes", async () => {
  domain = domain.replace(`20 (pe) ${label}`, `0 (pe) ${label}`);
  const input = args(); input.snapshot.processes[0]!.executable = clone;
  probe.collect.mockResolvedValue(structuredClone(input.snapshot));
  const result = await collectPreexistingAppServices(input);
  expect(result).toMatchObject({ ok: true, services: [], snapshot: { processes: expect.arrayContaining([expect.objectContaining({ pid: 20, uniqueId: "400" })]) } });
  expect(probe.collect).toHaveBeenCalledTimes(2);
  expect(probe.command.mock.calls.some(([, argv]) => argv[1] === `pid/10/${label}`)).toBe(false);
  expect(probe.sign).not.toHaveBeenCalled();
  probe.collect.mockImplementationOnce(async () => { domain = domain.replace(`0 (pe) ${label}`, `20 (pe) ${label}`); return structuredClone(input.snapshot); });
  expect(await collectPreexistingAppServices(input)).toMatchObject({ ok: false, diagnostic: { phase: "repeated-binding" } });
});
it.each(["duplicate-field", "duplicate-section", "nested-field", "environment-injection", "brace", "control", "mapping", "creator", "missing-table", "duplicate-job", "duplicate-service"])("rejects malformed/ambiguous launchd text: %s", async variant => {
  if (variant === "duplicate-field") domain = domain.replace("\tuniqueid = 100", "\tuniqueid = 100\n\tuniqueid = 100");
  if (variant === "duplicate-section") domain = domain.replace("\tservices = {", "\tservices = {\n\t}\n\tservices = {");
  if (variant === "nested-field") job = job.replace("\tpid = 20", "\tendpoints = {\n\t\tpid = 20\n\t}");
  if (variant === "environment-injection") job = job.replace("PRIVATE_ENVIRONMENT", "x\n\t}\n\tpid = 20\n\tenvironment = {\n\t\tX => y");
  if (variant === "brace") domain = domain.replace("PRIVATE_ENVIRONMENT", "x}y");
  if (variant === "control") domain = domain.replace("PRIVATE_ENVIRONMENT", "x\ry");
  if (variant === "mapping") job = job.replace("\tpid = 20", "\tpid = 21");
  if (variant === "creator") domain = domain.replace("Google Chrome[10]", "Google Chrome[11]");
  if (variant === "missing-table") domain = domain.replace(/\tservices = \{[^}]*\}/, "");
  if (variant === "duplicate-job") job += job;
  if (variant === "duplicate-service") domain = domain.replace(`\t\t20 (pe) ${label}`, `\t\t20 (pe) ${label}\n\t\t20 (pe) ${label}`);
  expect((await collectPreexistingAppServices(args())).ok).toBe(false);
});
it("rejects service remapping after census and identity reuse after the second mapping", async () => {
  probe.collect.mockImplementationOnce(async () => { job = job.replace("\tpid = 20", "\tpid = 21"); return snapshot(); });
  expect((await collectPreexistingAppServices(args())).ok).toBe(false);
  job = job.replace("\tpid = 21", "\tpid = 20");
  probe.collect.mockReset().mockResolvedValueOnce(snapshot()).mockImplementationOnce(async () => { const s = snapshot(); s.processes[1]!.uniqueId = "401"; return s; });
  expect((await collectPreexistingAppServices(args())).ok).toBe(false);
});

it("refuses a platform-file replacement during collection", async () => {
  probe.collect.mockImplementationOnce(async () => { probe.file.mockReturnValue("replaced"); return snapshot(); });
  expect(await collectPreexistingAppServices(args())).toEqual({ ok: false, reason: "app-service-platform-unrecognized" });
});

it("accepts only the exact pinned clone after dynamic PID verification and retains its bound code identity", async () => {
  const input = args(); input.snapshot.processes[0]!.executable = clone;
  probe.collect.mockResolvedValue(structuredClone(input.snapshot));
  expect(await collectPreexistingAppServices(input)).toMatchObject({ ok: true, services: [{ ownerExecutable: clone, ownerPidVersion: 100, ownerSigning: { identifier: "com.google.Chrome", teamId: "EQHXZ8M8AV", cdHash: platform.cloneCdHash, dynamicallyVerified: true } }] });
  expect(probe.sign).toHaveBeenCalledWith("/usr/bin/codesign", ["--verify", "--strict", "+10"], expect.anything());
  expect(probe.sign).toHaveBeenCalledTimes(4);
  expect(Math.max(...probe.sign.mock.invocationCallOrder)).toBeLessThan(probe.collect.mock.invocationCallOrder[1]!);
});
it.each(["verify", "signature", "team", "hash", "duplicate", "unicode", "version", "clone-bytes"])("refuses unsafe clone signing observation: %s", async variant => {
  const input = args(); input.snapshot.processes[0]!.executable = clone;
  probe.collect.mockResolvedValue(structuredClone(input.snapshot));
  if (variant === "verify") probe.sign.mockReturnValue({ status: 1, signal: null, stdout: "", stderr: "PRIVATE_ERROR" });
  if (variant === "version") delete input.snapshot.processes[0]!.pidVersion;
  if (variant === "clone-bytes") probe.file.mockImplementation((path: string) => path === "/usr/bin/codesign" ? platform.codesignSha256 : path === "/bin/launchctl" ? platform.launchctlSha256 : path.endsWith("Info.plist") ? platform.plistSha256 : path === executable ? platform.executableSha256 : "wrong");
  if (["signature", "team", "hash", "duplicate", "unicode"].includes(variant)) probe.sign.mockImplementation((_file: string, argv: string[]) => ({ status: 0, signal: null, stdout: "", stderr: argv[0] === "--verify" ? "" : `Executable=${clone}\nIdentifier=${variant === "signature" ? "other" : "com.google.Chrome"}\nTeamIdentifier=${variant === "team" ? "other" : "EQHXZ8M8AV"}\nCDHash=${variant === "hash" ? "other" : platform.cloneCdHash}\n${variant === "duplicate" ? "CDHash=other\n" : variant === "unicode" ? "Other=\u202fPM\n" : ""}` }));
  const result = await collectPreexistingAppServices(input);
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR");
  if (variant !== "version") expect(result).toMatchObject({ diagnostic: { phase: variant === "clone-bytes" ? "owner-signature-bytes" : variant === "verify" ? "owner-signature-verify" : "owner-signature-display" } });
});

it("reports only fixed safe failure phases without raw native or command errors", async () => {
  probe.command.mockImplementation((file: string) => { if (file.endsWith("sw_vers")) return "25F84"; throw Error("PRIVATE_ARGS_ENV"); });
  expect(await collectPreexistingAppServices(args())).toEqual({ ok: false, reason: "app-service-observation-refused", diagnostic: { phase: "owner-domain" } });
  probe.collect.mockResolvedValueOnce({ ...snapshot(), complete: false });
  const input = args(); input.snapshot.complete = false;
  expect(await collectPreexistingAppServices(input)).toEqual({ ok: false, reason: "app-service-observation-refused", diagnostic: { phase: "initial-census" } });
});
