/**
 * Read-only emptiness of a recorded OS object (v53 custody), for stop
 * settlement and recovery in a process that never held the object's
 * handle. Like the PID witnesses, this authorizes no signal: it only says
 * whether the OS can prove the object empty right now.
 *
 *   cgroup2     `cgroup.events` populated flag; a directory that is gone
 *               was removed, and the kernel removes only empty cgroups.
 *   job-object  no handle survives the owning helper, so nothing here can
 *               query it: unknown, unless the witness already carries the
 *               helper's empty proof (the caller checks that first).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ContainerEmptiness = "empty" | "populated" | "unknown";

export function containerEmptiness(backend: string, container: string, platform: NodeJS.Platform = process.platform): ContainerEmptiness {
  if (backend === "cgroup2") {
    if (platform !== "linux") return "unknown";
    let events: string;
    try {
      events = readFileSync(join(container, "cgroup.events"), "utf8");
    } catch (error) {
      // The whole directory gone = removed, and only an empty cgroup can
      // be removed. A directory that exists without cgroup.events is not
      // a cgroup at all: nothing is proven.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
      return existsSync(container) ? "unknown" : "empty";
    }
    const match = /populated (\d)/.exec(events);
    if (match === null) return "unknown";
    return match[1] === "1" ? "populated" : "empty";
  }
  return "unknown";
}
