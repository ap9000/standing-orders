import { normalizeBootId } from "./boot-identity.js";
import type { DarwinProcessRecoverySnapshot } from "./process-recovery-native.js";

export type ProcessRecoveryAssessment =
  | { ok: true; observedAt: string; external: { pid: number; basis: "predates-run" | "managed-service" | "pre-existing-app-service" | "ancestry" | "owned-probe"; anchor: number }[] }
  | { ok: false; problems: string[]; unresolved: number[] };

export type ProcessRecoveryAnchor = { pid: number; uniqueId: string };

const iso = (value: string): number | null => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
};
const identity = (value: string | null): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;

/** Read-only assessment of a COMPLETE, stable OS census. The caller must
 * separately prove that the missing record is an observation gap, every
 * actual spawn is accounted for, every recorded owned process has positive
 * exit evidence, and the terminal run cannot launch more work, including
 * outstanding delegated launches.
 * preRunIdentities must come from authenticated observations on this host/boot
 * before the earliest possible task spawn, not from current wall-clock birth
 * times. Trusted managed identities require independent proof that the job
 * is external to the task, including jobs the task could delegate to launchd.
 * A launchd service listing alone establishes no such independence. This
 * pure function checks identity binding, not the provenance of these inputs.
 * A missing spawn cannot be recovered by following its old worker's ancestry.
 * Numeric PIDs, process names and 32-bit original-parent versions authorize
 * nothing. In particular, reparenting to launchd is never exit evidence. */
export function assessDarwinObserverRecovery(args: {
  host: string; bootId: string; boundary: string; runFinishedAt: string;
  preRunIdentities: readonly ProcessRecoveryAnchor[];
  trustedExternalManagedServiceIdentities: readonly ProcessRecoveryAnchor[];
  snapshot: DarwinProcessRecoverySnapshot;
}): ProcessRecoveryAssessment {
  const { snapshot } = args;
  const refuse = (...problems: string[]): ProcessRecoveryAssessment => ({ ok: false, problems, unresolved: [] });
  const boundary = iso(args.boundary), ended = iso(args.runFinishedAt);
  const began = iso(snapshot.startedAt), finished = iso(snapshot.finishedAt);
  const boot = normalizeBootId(args.bootId);
  if (boot === null || snapshot.bootId === null || normalizeBootId(snapshot.bootId) !== boot || snapshot.host !== args.host) return refuse("The process census belongs to a different or unreadable host/boot.");
  if (boundary === null || ended === null || began === null || finished === null || boundary > ended || ended > began || began > finished) return refuse("The run and process census timestamps do not establish a recovery interval.");
  if (snapshot.schema !== 1 || !snapshot.complete || !snapshot.stable || snapshot.errors.length || snapshot.identityChanges.length) return refuse("The complete process census could not be read and revalidated without changes.");
  const rows = new Map(snapshot.processes.map(row => [row.pid, row]));
  if (rows.size === 0 || rows.size !== snapshot.processes.length || !rows.has(1) ||
      snapshot.processes.some(row => !Number.isSafeInteger(row.pid) || row.pid <= 0 || !identity(row.uniqueId)) ||
      new Set(snapshot.processes.map(row => row.uniqueId)).size !== rows.size) return refuse("The process census has missing or ambiguous kernel identities.");
  const anchorsValid = (anchors: readonly ProcessRecoveryAnchor[]): boolean => Array.isArray(anchors) &&
    anchors.every(anchor => Number.isSafeInteger(anchor.pid) && anchor.pid > 0 && identity(anchor.uniqueId)) &&
    new Set(anchors.map(anchor => anchor.pid)).size === anchors.length &&
    new Set(anchors.map(anchor => anchor.uniqueId)).size === anchors.length;
  if (!anchorsValid(args.preRunIdentities) || !anchorsValid(args.trustedExternalManagedServiceIdentities)) return refuse("The authenticated external process identities are malformed or ambiguous.");
  const preRun = new Map(args.preRunIdentities.map(anchor => [anchor.pid, anchor.uniqueId]));
  const trustedManaged = new Map(args.trustedExternalManagedServiceIdentities.map(anchor => [anchor.pid, anchor.uniqueId]));
  const probes = new Set(snapshot.collectorPids);
  if ([...probes].some(pid => !Number.isSafeInteger(pid) || pid <= 1)) return refuse("The owned diagnostic process inventory is malformed.");
  const managed = new Set(snapshot.managedServices.filter(service => {
    const row = rows.get(service.pid);
    return service.identityBound && identity(service.uniqueId) && row?.uniqueId === service.uniqueId &&
      trustedManaged.get(service.pid) === service.uniqueId &&
      service.beforeUniqueId === service.uniqueId && service.afterUniqueId === service.uniqueId &&
      /^(system|gui\/[0-9]+|user\/[0-9]+|pid\/[0-9]+)$/.test(service.domain) && service.label.length > 0;
  }).map(service => service.pid));
  const external = new Map<number, { pid: number; basis: "predates-run" | "managed-service" | "ancestry" | "owned-probe"; anchor: number }>();
  const visiting = new Set<number>();
  const visit = (pid: number): boolean => {
    if (external.has(pid)) return true;
    if (visiting.has(pid)) return false;
    const row = rows.get(pid);
    if (!row || row.traced !== false) return false;
    const accept = (basis: "predates-run" | "managed-service" | "ancestry" | "owned-probe", anchor = pid): true => { external.set(pid, { pid, basis, anchor }); return true; };
    if (probes.has(pid)) return accept("owned-probe");
    if (preRun.get(pid) === row.uniqueId) return accept("predates-run");
    if (managed.has(pid)) return accept("managed-service");
    // An orphan may exec and acquire launchd's parentUniqueId. Even a launchd
    // service record needs independent caller provenance; there is no PID1
    // ancestry shortcut. Wall birth times cannot establish age after a
    // clock adjustment. Kernel fork identities must increase along each edge,
    // also refusing reparenting to a later process after historical tracing.
    if (row.ppid === null || row.ppid <= 1 || row.ppid === pid || !identity(row.parentUniqueId)) return false;
    const parent = rows.get(row.ppid);
    if (!parent || parent.uniqueId !== row.parentUniqueId || BigInt(parent.uniqueId) >= BigInt(row.uniqueId!)) return false;
    visiting.add(pid);
    const gone = visit(parent.pid);
    visiting.delete(pid);
    return gone ? accept("ancestry", external.get(parent.pid)!.anchor) : false;
  };
  const unresolved = snapshot.processes.filter(row => !visit(row.pid)).map(row => row.pid).sort((a, b) => a - b);
  return unresolved.length ? { ok: false, problems: ["Some current processes cannot be distinguished from unobserved descendants."], unresolved }
    : { ok: true, observedAt: snapshot.finishedAt, external: [...external.values()].sort((a, b) => a.pid - b.pid) };
}
