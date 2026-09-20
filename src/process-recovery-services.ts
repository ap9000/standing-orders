import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { release } from "node:os";
import { normalizeBootId } from "./boot-identity.js";
import { changedDarwinProcessIdentities, collectDarwinCoalitionSnapshot, type DarwinCoalitionRecoverySnapshot, type PreparedDarwinProcessCensus } from "./process-recovery-native.js";
import type { ProcessRecoveryAnchor } from "./process-recovery.js";

const label = "com.apple.speech.SpeechSynthesisServerXPC";
const bundle = "/System/Library/Frameworks/ApplicationServices.framework/Versions/A/Frameworks/SpeechSynthesis.framework/Versions/A/XPCServices/SpeechSynthesisServerXPC.xpc";
export const APP_SERVICE_EXECUTABLE = `${bundle}/Contents/MacOS/SpeechSynthesisServerXPC`;
const executable = APP_SERVICE_EXECUTABLE;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const clonePathSha256 = "0e92ba8224883b668b6becb0f2768fdca1912630e176ded161b6786822ec2a73";
const cloneSha256 = "fe21b4086d7f035b17ce4c8ff9d1ceef88eb9510252a5b311d7a5aa48c352b32";
const cloneCdHash = "fab09b6e6ce70ffb18f6f672564b1215c8a7c75f";
export const APP_SERVICE_PLATFORM = Object.freeze({ osRelease: "25.5.0", osBuild: "25F84", serviceType: "Application", label,
  codesignSha256: "214d455584d19abc0d74d02b9cbc7d3da6bdcb0596c235e6156dd9ed2f4e1ba7", clonePathSha256, cloneSha256, cloneCdHash,
  launchctlSha256: "b1f2b90f349938cc4c3c9234f11cefd05545f7b4bfe9b1751ac01f1cb27d3714",
  plistSha256: "c26cec3d7afe55cb33c360018c04d0c848df45dbe1ea3c3c50c9dd3b9d483aee",
  executableSha256: "0be2afc6ec7bce4c06e14cdfe7e5155b394f98a689189f069a6ca8611fd7911d" });
export type PreexistingAppService = { pid: number; uniqueId: string; ownerPid: number; ownerUniqueId: string;
  ownerExecutable: string; ownerPidVersion: number; ownerSigning: { identifier: "com.google.Chrome"; teamId: "EQHXZ8M8AV"; cdHash: string; dynamicallyVerified: true } | null;
  uid: number; resourceCoalitionId: string; executable: string; domain: string; platform: typeof APP_SERVICE_PLATFORM };
type ServicePhase = "platform" | "initial-census" | "owner-identity" | "owner-signature-bytes" | "owner-signature-verify" | "owner-signature-display" | "owner-domain" | "service-job" | "middle-census" | "repeated-binding" | "final-census";
type Result = { ok: true; snapshot: DarwinCoalitionRecoverySnapshot; services: PreexistingAppService[] } | { ok: false; reason: "app-service-platform-unrecognized" | "app-service-observation-refused"; diagnostic?: { phase: ServicePhase } };
const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC" };
const command = (file: string, args: string[]) => execFileSync(file, args, { encoding: "utf8", env, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hash = (path: string) => digest(readFileSync(path));
const isChrome = (path: string | null): path is string => path !== null && (path === chrome || digest(path) === clonePathSha256);
function platformMatches(): boolean {
  return process.platform === "darwin" && release() === APP_SERVICE_PLATFORM.osRelease && command("/usr/bin/sw_vers", ["-buildVersion"]).trim() === APP_SERVICE_PLATFORM.osBuild &&
    hash("/usr/bin/codesign") === APP_SERVICE_PLATFORM.codesignSha256 && hash("/bin/launchctl") === APP_SERVICE_PLATFORM.launchctlSha256 && hash(`${bundle}/Contents/Info.plist`) === APP_SERVICE_PLATFORM.plistSha256 && hash(executable) === APP_SERVICE_PLATFORM.executableSha256;
}
const id = (s: unknown): s is string => typeof s === "string" && /^[1-9][0-9]{0,19}$/.test(s) && BigInt(s) <= 0xffffffffffffffffn;
function requireFact(ok: unknown): asserts ok { if (!ok) throw Error("unrecognized-app-service-fact"); }

/** launchctl explicitly promises no stable print API. This parser is restricted
 * to the inspected tool/OS hashes, entire balanced records and singleton fields.
 * Environment continuations cannot create identity fields or hide duplicates. */
function record(text: string, header: string) {
  requireFact(!/[^\x09\x0a\x20-\x7e]/.test(text));
  const lines = text.trimEnd().split("\n");
  requireFact(lines.shift() === `${header} = {` && lines.pop() === "}");
  const fields = new Map<string, string>(), sections = new Map<string, string[]>();
  const stack: string[] = [], seen = new Set<string>();
  const allowed = new Set(["security context", "environment", "inherited environment", "default environment", "services", "service stubs", "unmanaged processes", "endpoints", "task-special ports", "resource coalition", "jetsam coalition"]);
  for (const line of lines) {
    if (line === "") continue;
    const m = /^(\t*)([^\t].*)$/.exec(line); requireFact(m);
    const depth = m[1]!.length, value = m[2]!;
    if (value === "}") { requireFact(stack.length && depth === stack.length); stack.pop(); continue; }
    if (stack.length === 1 && stack[0] === "task-special ports") {
      requireFact(depth === 3 && /^ *0x[0-9a-f]+ +[0-9]+ +[a-z-]+ +\([^{}=\t]*\)$/.test(value)); continue;
    }
    requireFact(depth === stack.length + 1);
    const open = /^([^{}]+) = \{$/.exec(value);
    if (open) {
      const key = open[1]!, path = [...stack, key].join("/");
      requireFact(!seen.has(path) && !fields.has(key) && (stack.length === 0 ? allowed.has(key) : stack.length === 1 && stack[0] === "endpoints" && /^"?[A-Za-z0-9._-]+"?$/.test(key)));
      seen.add(path); stack.push(key); if (stack.length === 1) sections.set(key, []); continue;
    }
    requireFact(!/[{}]/.test(value));
    if (stack.length) {
      if (stack[0]!.endsWith("environment")) requireFact(stack.length === 1 && /^[A-Za-z_][A-Za-z0-9_]* => [^\t]*$/.test(value));
      else requireFact(!/^(?:pid|uniqueid|handle|creator|domain|program|path|bundle id) = /.test(value));
      sections.get(stack[0]!)!.push(line); continue;
    }
    const field = /^([^=]+) = ([^\t]*)$/.exec(value); requireFact(field);
    requireFact(!fields.has(field[1]!) && !seen.has(field[1]!)); fields.set(field[1]!, field[2]!);
  }
  requireFact(!stack.length);
  return { fields, sections };
}
function sealed(s: DarwinCoalitionRecoverySnapshot, anchorPids: number[], bound: ProcessRecoveryAnchor): boolean {
  const a = s.anchors.find(p => p.pid === bound.pid), counters = s.counterBefore;
  return s.schema === 1 && s.complete && s.stable && s.kernelTableRead && s.countersStable && s.unreadableMembershipCount === 0 &&
    !s.errors.length && !s.identityChanges.length && !s.anchorIdentityChanges.length && !!normalizeBootId(s.bootId ?? "") &&
    s.osRelease === APP_SERVICE_PLATFORM.osRelease && s.anchorPids.length === anchorPids.length && anchorPids.every(pid => s.anchorPids.includes(pid)) &&
    a?.uniqueId === bound.uniqueId && a.traced === false && s.collector?.exited === true &&
    s.processes.some(p => p.pid === s.collector!.pid && p.uniqueId === s.collector!.uniqueId) &&
    !!counters && id(counters.tasksStarted) && /^(0|[1-9][0-9]*)$/.test(counters.tasksExited) &&
    counters.tasksStarted === s.counterAfter?.tasksStarted && counters.tasksExited === s.counterAfter?.tasksExited &&
    BigInt(counters.tasksStarted) - BigInt(counters.tasksExited) === BigInt(s.processes.length) &&
    new Set(s.processes.map(p => p.pid)).size === s.processes.length && new Set(s.processes.map(p => p.uniqueId)).size === s.processes.length &&
    s.processes.every(p => Number.isSafeInteger(p.pid) && p.pid > 1 && p.pid <= 0x7fffffff && id(p.uniqueId) && p.resourceCoalitionId === s.resourceCoalitionId);
}
function signing(pid: number, path: string, phase: (value: ServicePhase) => void): PreexistingAppService["ownerSigning"] {
  if (path === chrome) return null;
  phase("owner-signature-bytes");
  requireFact(digest(path) === clonePathSha256 && hash(path) === cloneSha256);
  // Dynamic PID verification checks the running code. A display alone is not
  // validation; the inspected clone's static resource-metadata check refused.
  const run = (args: string[]) => {
    const r = spawnSync("/usr/bin/codesign", args, { encoding: "utf8", env, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 65536, stdio: "pipe" });
    requireFact(!r.error && r.status === 0 && r.signal === null && r.stdout === ""); return r.stderr;
  };
  phase("owner-signature-verify");
  run(["--verify", "--strict", `+${pid}`]);
  phase("owner-signature-display");
  const display = run(["--display", "--verbose=4", `+${pid}`]);
  // codesign localizes its non-authoritative timestamp with a narrow no-break
  // space even under LC_ALL=C. Identity lines remain exact ASCII singletons.
  requireFact(display.split("\n").every(line => !/[^\x20-\x7e]/.test(line) || /^Timestamp=[\x20-\x7e]*\u202f(?:AM|PM)$/.test(line)));
  const value = (key: string) => { const all = display.split("\n").filter(l => l.startsWith(`${key}=`)); requireFact(all.length === 1); return all[0]!.slice(key.length + 1); };
  requireFact(value("Executable") === path && value("Identifier") === "com.google.Chrome" && value("TeamIdentifier") === "EQHXZ8M8AV" && value("CDHash") === cloneCdHash);
  return { identifier: "com.google.Chrome", teamId: "EQHXZ8M8AV", cdHash: cloneCdHash, dynamicallyVerified: true };
}
function bindings(s: DarwinCoalitionRecoverySnapshot, ownerPids: number[], bound: ProcessRecoveryAnchor, phase: (value: ServicePhase) => void): PreexistingAppService[] {
  const result: PreexistingAppService[] = [];
  for (const ownerPid of ownerPids) {
    phase("owner-identity");
    const owner = s.processes.find(p => p.pid === ownerPid);
    requireFact(owner && id(owner.uniqueId) && BigInt(owner.uniqueId) <= BigInt(bound.uniqueId) && owner.traced === false && isChrome(owner.executable) && owner.uid !== null && Number.isInteger(owner.pidVersion) && owner.pidVersion! > 0);
    phase("owner-domain");
    const domain = `pid/${ownerPid}`, d = record(command("/bin/launchctl", ["print", domain]), domain);
    requireFact(d.fields.get("type") === "pid" && d.fields.get("handle") === String(ownerPid) && d.fields.get("uniqueid") === owner.uniqueId &&
      d.fields.get("creator") === `Google Chrome[${ownerPid}]` && d.fields.get("creator euid") === String(owner.uid) && d.fields.get("originator") === "/Applications/Google Chrome.app");
    const rows = d.sections.get("services"); requireFact(rows);
    const entries = rows.map(line => { const m = /^\t\t\s*(0|[1-9][0-9]*|-)\s+([-A-Za-z0-9?()]+)\s+([A-Za-z0-9._-]+)$/.exec(line); requireFact(m); return { pid: m[1], label: m[3] }; });
    requireFact(new Set(entries.map(e => e.label)).size === entries.length);
    // A pending job supplies no live identity or exit evidence. Any unmatched
    // process in the final native census still needs its own exclusion proof.
    const entry = entries.find(e => e.label === label); if (!entry || entry.pid === "-" || entry.pid === "0") continue;
    phase("service-job");
    const pid = Number(entry.pid), process = s.processes.find(p => p.pid === pid);
    requireFact(process && id(process.uniqueId) && process.traced === false && process.uid === owner.uid && process.executable === executable && process.resourceCoalitionId === owner.resourceCoalitionId);
    const job = record(command("/bin/launchctl", ["print", `${domain}/${label}`]), `${domain}/${label}`).fields;
    requireFact(job.get("type") === "XPCService" && job.get("state") === "running" && job.get("domain") === `${domain} [Google Chrome]` &&
      job.get("pid") === String(pid) && job.get("path") === bundle && job.get("program") === executable && job.get("bundle id") === label && job.get("forks") === "0" && job.get("execs") === "1");
    requireFact(!result.some(p => p.pid === pid));
    const ownerSigning = signing(ownerPid, owner.executable, phase);
    result.push({ pid, uniqueId: process.uniqueId, ownerPid, ownerUniqueId: owner.uniqueId, ownerExecutable: owner.executable, ownerPidVersion: owner.pidVersion!, ownerSigning, uid: owner.uid, resourceCoalitionId: owner.resourceCoalitionId, executable, domain, platform: APP_SERVICE_PLATFORM });
  }
  return result;
}

/** Read-only observations, not exit/custody authority. Caller must authenticate
 * upperBound historically and consume these facts inside its existing proof. */
export async function collectPreexistingAppServices(args: { snapshot: DarwinCoalitionRecoverySnapshot; native: PreparedDarwinProcessCensus; upperBound: ProcessRecoveryAnchor; anchorPids: number[] }): Promise<Result> {
  let phase: ServicePhase = "platform";
  const at = (value: ServicePhase) => { phase = value; };
  try {
    if (!platformMatches()) return { ok: false, reason: "app-service-platform-unrecognized" };
    const native = { ...args.native };
    const initial = structuredClone(args.snapshot), bound = { ...args.upperBound }, anchorPids = [...args.anchorPids];
    at("initial-census");
    requireFact(id(bound.uniqueId) && anchorPids.includes(bound.pid) && new Set(anchorPids).size === anchorPids.length && sealed(initial, anchorPids, bound));
    requireFact(initial.nativeSourceSha256 === native.sourceSha256 && initial.nativeExecutableSha256 === native.executableSha256);
    const owners = initial.processes.filter(p => isChrome(p.executable) && p.traced === false && id(p.uniqueId) && BigInt(p.uniqueId) <= BigInt(bound.uniqueId)).map(p => p.pid).sort((a,b) => a-b);
    const first = bindings(initial, owners, bound, at);
    const collect = () => collectDarwinCoalitionSnapshot({ native, resourceCoalitionId: initial.resourceCoalitionId, anchorPids, maxAttempts: 1 });
    const validate = (next: DarwinCoalitionRecoverySnapshot) => {
      requireFact(sealed(next, anchorPids, bound) && normalizeBootId(next.bootId ?? "") === normalizeBootId(initial.bootId ?? "") && next.host === initial.host && next.resourceCoalitionId === initial.resourceCoalitionId && next.nativeSourceSha256 === initial.nativeSourceSha256 && next.nativeExecutableSha256 === initial.nativeExecutableSha256);
      const pids = new Set([...owners, ...first.map(p => p.pid)]);
      requireFact(!changedDarwinProcessIdentities(initial.processes.filter(p => pids.has(p.pid)), next.processes.filter(p => pids.has(p.pid))).length &&
        !changedDarwinProcessIdentities(initial.anchors, next.anchors).length);
    };
    at("middle-census");
    const middle = await collect(); validate(middle);
    const repeated = bindings(middle, owners, bound, at);
    at("repeated-binding");
    requireFact(JSON.stringify(first) === JSON.stringify(repeated));
    at("platform");
    if (!platformMatches()) return { ok: false, reason: "app-service-platform-unrecognized" };
    at("final-census");
    const final = await collect(); validate(final);
    return { ok: true, snapshot: final, services: first };
  } catch { return { ok: false, reason: "app-service-observation-refused", diagnostic: { phase } }; }
}
