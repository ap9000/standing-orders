import { createHash } from "node:crypto";
import { normalizeBootId } from "./boot-identity.js";
import type { DarwinCoalitionRecoverySnapshot } from "./process-recovery-native.js";
import { APP_SERVICE_EXECUTABLE, APP_SERVICE_PLATFORM, type PreexistingAppService } from "./process-recovery-services.js";
import type { ProcessRecoveryAnchor, ProcessRecoveryAssessment } from "./process-recovery.js";

const uint64 = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const identity = (value: unknown): value is string => uint64(value) && value !== "0";
const anchorValid = (value: ProcessRecoveryAnchor): boolean => Number.isSafeInteger(value.pid) && value.pid > 1 && identity(value.uniqueId);

/** A current coalition inventory supplies membership, not historical authority.
 * Before calling, independently authenticate that the terminal run inherited
 * sourceRoot's resource coalition, could not select another coalition or delegate
 * a launch, and has no remaining producer. All known owned processes must have
 * positive exit evidence. A lost direct spawn is not an observer gap.
 *
 * Independently authenticate that preRunUpperBound's exact STILL-LIVE identity
 * existed before the run could spawn. This can be a causally bound live service;
 * calendar birth times, numeric PIDs, names and absent restart logs do not count.
 * XNU assigns increasing 64-bit process IDs at fork and preserves them at exec.
 * IDs no greater than that authenticated bound therefore predate the run.
 * The native collector must revalidate this anchor alongside its counter seal.
 * This pure assessment never records an exit or authorizes a database mutation. */
export function assessDarwinCoalitionRecovery(args: {
  host: string; bootId: string; resourceCoalitionId: string;
  sourceRoot: ProcessRecoveryAnchor; preRunUpperBound: ProcessRecoveryAnchor;
  snapshot: DarwinCoalitionRecoverySnapshot;
  // Only internally collected, opaque provenance can authorize use of these
  // facts by settlement. This pure function checks their final census binding.
  preexistingAppServices?: readonly PreexistingAppService[];
}): ProcessRecoveryAssessment {
  const s = args.snapshot;
  const refuse = (problem: string, unresolved: number[] = []): ProcessRecoveryAssessment => ({ ok: false, problems: [problem], unresolved });
  const boot = normalizeBootId(args.bootId);
  if (!boot || !s.bootId || normalizeBootId(s.bootId) !== boot || s.host !== args.host || !args.host ||
      !identity(args.resourceCoalitionId) || s.resourceCoalitionId !== args.resourceCoalitionId) return refuse("The process inventory does not match the authenticated host, boot and resource coalition.");
  if (!anchorValid(args.sourceRoot) || !anchorValid(args.preRunUpperBound)) return refuse("The historical process identities are missing or malformed.");
  if (s.schema !== 1 || !s.complete || !s.stable || !s.kernelTableRead || !s.countersStable || s.unreadableMembershipCount !== 0 || s.errors.length || s.identityChanges.length || s.anchorIdentityChanges.length) return refuse("The target process inventory or its external anchor changed during observation.");
  const before = s.counterBefore, after = s.counterAfter;
  if (!before || !after || !uint64(before.tasksStarted) || !uint64(before.tasksExited) ||
      before.tasksStarted !== after.tasksStarted || before.tasksExited !== after.tasksExited ||
      BigInt(before.tasksStarted) < BigInt(before.tasksExited) ||
      BigInt(before.tasksStarted) - BigInt(before.tasksExited) !== BigInt(s.processes.length)) return refuse("Kernel task counters do not establish a complete target inventory.");
  const rows = new Map(s.processes.map(row => [row.pid, row]));
  if (!rows.size || rows.size !== s.processes.length || new Set(s.processes.map(row => row.uniqueId)).size !== rows.size ||
      s.processes.some(row => !Number.isSafeInteger(row.pid) || row.pid < 1 || !identity(row.uniqueId) || row.resourceCoalitionId !== s.resourceCoalitionId)) return refuse("The target inventory contains missing or ambiguous process identities.");
  const source = rows.get(args.sourceRoot.pid);
  if (source?.uniqueId !== args.sourceRoot.uniqueId || source.traced !== false) return refuse("The original execution service is no longer the authenticated kernel identity.");
  const anchorRows = s.anchors.filter(row => row.pid === args.preRunUpperBound.pid);
  if (s.anchorPids.filter(pid => pid === args.preRunUpperBound.pid).length !== 1 || anchorRows.length !== 1 ||
      anchorRows[0]!.uniqueId !== args.preRunUpperBound.uniqueId || anchorRows[0]!.traced !== false) return refuse("The pre-run service identity was not independently revalidated by the native collector.");
  const collector = s.collector;
  if (!collector || collector.exited !== true || rows.get(collector.pid)?.uniqueId !== collector.uniqueId) return refuse("The owned diagnostic process has no bound positive exit evidence.");
  const bound = BigInt(args.preRunUpperBound.uniqueId);
  const services = new Map<number, PreexistingAppService>();
  for (const binding of args.preexistingAppServices ?? []) {
    const service = rows.get(binding.pid), owner = rows.get(binding.ownerPid);
    const signing = binding.ownerSigning;
    const recognizedOwner = typeof binding.ownerExecutable === "string" &&
      (binding.ownerExecutable === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ? signing === null :
        createHash("sha256").update(binding.ownerExecutable).digest("hex") === APP_SERVICE_PLATFORM.clonePathSha256 &&
        signing?.identifier === "com.google.Chrome" && signing.teamId === "EQHXZ8M8AV" &&
        signing.cdHash === APP_SERVICE_PLATFORM.cloneCdHash && signing.dynamicallyVerified === true);
    if (services.has(binding.pid) || !identity(binding.uniqueId) || !identity(binding.ownerUniqueId) ||
        service?.uniqueId !== binding.uniqueId || owner?.uniqueId !== binding.ownerUniqueId || service.pid === owner.pid ||
        service.traced !== false || owner.traced !== false || BigInt(owner.uniqueId) > bound || BigInt(owner.uniqueId) >= BigInt(service.uniqueId) ||
        !recognizedOwner || owner.executable !== binding.ownerExecutable || !Number.isInteger(binding.ownerPidVersion) ||
        binding.ownerPidVersion <= 0 || owner.pidVersion !== binding.ownerPidVersion ||
        service.uid !== binding.uid || owner.uid !== binding.uid || binding.uid === null ||
        service.resourceCoalitionId !== binding.resourceCoalitionId || owner.resourceCoalitionId !== binding.resourceCoalitionId ||
        service.executable !== binding.executable || binding.executable !== APP_SERVICE_EXECUTABLE || binding.domain !== `pid/${owner.pid}` ||
        s.osRelease !== APP_SERVICE_PLATFORM.osRelease || JSON.stringify(binding.platform) !== JSON.stringify(APP_SERVICE_PLATFORM)) {
      return refuse("A collected app service does not match its pre-existing owner and final kernel identities.");
    }
    services.set(binding.pid, binding);
  }
  type External = Extract<ProcessRecoveryAssessment, { ok: true }>["external"][number];
  const external = new Map<number, External>();
  const visiting = new Set<number>();
  const visit = (pid: number): boolean => {
    if (external.has(pid)) return true;
    if (visiting.has(pid)) return false;
    const row = rows.get(pid);
    if (!row || row.traced !== false) return false;
    const accept = (basis: External["basis"], anchor: number): true => { external.set(pid, { pid, basis, anchor }); return true; };
    if (pid === collector.pid && row.uniqueId === collector.uniqueId) return accept("owned-probe", pid);
    if (BigInt(row.uniqueId!) <= bound) return accept("predates-run", args.preRunUpperBound.pid);
    const service = services.get(pid);
    if (service) return accept("pre-existing-app-service", service.ownerPid);
    if (!row.ppid || row.ppid <= 1 || row.ppid === pid || !identity(row.parentUniqueId)) return false;
    const parent = rows.get(row.ppid);
    if (!parent || parent.uniqueId !== row.parentUniqueId || BigInt(parent.uniqueId) >= BigInt(row.uniqueId!)) return false;
    visiting.add(pid);
    const found = visit(parent.pid);
    visiting.delete(pid);
    return found ? accept("ancestry", external.get(parent.pid)!.anchor) : false;
  };
  const unresolved = s.processes.filter(row => !visit(row.pid)).map(row => row.pid).sort((a, b) => a - b);
  return unresolved.length ? refuse("Some processes could still be unobserved descendants of the completed run.", unresolved)
    : { ok: true, observedAt: s.finishedAt, external: [...external.values()].sort((a, b) => a.pid - b.pid) };
}
