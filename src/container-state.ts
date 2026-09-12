/** Read-only kernel evidence. Recorded names never authorize signals. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, readlinkSync, realpathSync, statfsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

export type ContainerEmptiness = "empty" | "populated" | "unknown";
const CGROUP2_MAGIC = 0x63677270;

type CgroupIdentity = { version: 1; namespace: string; parentDevice: number; parentInode: number; inode: number };

function parentIdentity(container: string): Omit<CgroupIdentity, "inode"> {
  if (!isAbsolute(container) || normalize(container) !== container || !/^so-[A-Za-z0-9._-]+-[a-f0-9]{12}$/.test(basename(container))) throw new Error("invalid cgroup custody path");
  const parent = dirname(container);
  if (realpathSync(parent) !== parent || statfsSync(parent).type !== CGROUP2_MAGIC) throw new Error("custody parent is not the original cgroup v2 mount");
  const stat = statSync(parent);
  return { version: 1, namespace: readlinkSync("/proc/self/ns/cgroup"), parentDevice: stat.dev, parentInode: stat.ino };
}

export function captureCgroupIdentity(container: string): string {
  const parent = parentIdentity(container);
  if (realpathSync(container) !== container || statfsSync(container).type !== CGROUP2_MAGIC) throw new Error("custody object is not a cgroup v2 directory");
  return JSON.stringify({ ...parent, inode: statSync(container).ino });
}

export function parseCgroupEvents(events: string): ContainerEmptiness {
  const rows = events.split("\n").filter(line => line.startsWith("populated"));
  return rows.length !== 1 ? "unknown" : rows[0] === "populated 0" ? "empty" : rows[0] === "populated 1" ? "populated" : "unknown";
}

export function cgroupEmptiness(container: string, identity: string | null | undefined): ContainerEmptiness {
  if (!identity) return "unknown";
  try {
    const saved = JSON.parse(identity) as CgroupIdentity;
    const current = parentIdentity(container);
    if (saved.version !== 1 || saved.namespace !== current.namespace || saved.parentDevice !== current.parentDevice || saved.parentInode !== current.parentInode || !Number.isSafeInteger(saved.inode)) return "unknown";
    try {
      if (realpathSync(container) !== container || statSync(container).ino !== saved.inode || statfsSync(container).type !== CGROUP2_MAGIC) return "unknown";
    } catch (error) {
      // Only the original, still-mounted parent may prove removal. Linux
      // refuses rmdir while a cgroup has members; an unmounted hierarchy,
      // another namespace, a replaced directory or an ordinary file cannot.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "empty" : "unknown";
    }
    return parseCgroupEvents(readFileSync(join(container, "cgroup.events"), "utf8"));
  } catch { return "unknown"; }
}

export function containerEmptiness(backend: string, container: string, platform: NodeJS.Platform = process.platform, identity?: string | null): ContainerEmptiness {
  if (backend === "cgroup2" && platform === "linux") return cgroupEmptiness(container, identity);
  if (backend === "job-object" && platform === "win32" && process.platform === "win32" && identity === "job-object-v1" && /^Global\\so-[A-Za-z0-9._-]+-[a-f0-9]{64}$/.test(container)) {
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const shell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./job-object-helper.ps1", import.meta.url)), "-QueryName", container], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
    const evidence = result.stdout?.trim();
    if (result.status === 0 && (evidence === "empty" || evidence === "populated")) return evidence;
  }
  return "unknown";
}
