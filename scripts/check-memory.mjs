/**
 * Checks that fit in memory. A browser group (a console, a worker and Chrome) takes about 400 MB, so the journeys
 * run at most as many groups at once as the memory available allows, and never more than 6; a group starts only
 * while there is room for it. The release check records the peak.
 *
 * "Available" is what the OS can hand out without swapping: on macOS free, inactive, speculative and purgeable pages
 * (os.freemem() counts only free pages, a fraction of it); on Linux MemAvailable.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

export const GROUP_BYTES = 400 * 1024 * 1024;
export const MAX_GROUPS = 6;

/** Bytes vm_stat says the OS can hand out: free, inactive, speculative and purgeable pages. */
export function parseVmStat(text) {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
  const pages = name => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * size;
}

/** /proc/meminfo's MemAvailable, in bytes; null when it doesn't say. */
export function parseMeminfo(text) {
  const kb = /^MemAvailable:\s+(\d+) kB/m.exec(text)?.[1];
  return kb === undefined ? null : Number(kb) * 1024;
}

export function availableMemory() {
  try {
    if (process.platform === "darwin") return parseVmStat(execFileSync("vm_stat", { encoding: "utf8", timeout: 5_000 }));
    if (process.platform === "linux") return parseMeminfo(readFileSync("/proc/meminfo", "utf8")) ?? freemem();
  } catch { /* the plain count below */ }
  return freemem();
}

/** How many browser groups fit at once: one per 400 MB available, at least 1, at most 6. */
export function browserSlots(available = availableMemory(), max = MAX_GROUPS) {
  return Math.max(1, Math.min(max, Math.floor(available / GROUP_BYTES)));
}

/**
 * A gate for browser groups: `slot(body)` runs body once fewer than `limit` run and, beyond the first, `room()` says
 * there is memory for one more (asked again every `everyMs` until there is).
 */
export function limiter(limit, { room = () => availableMemory() >= GROUP_BYTES, everyMs = 1_000 } = {}) {
  let running = 0;
  const waiters = [];
  const acquire = async () => {
    for (;;) {
      if (running < limit && (running === 0 || room())) { running += 1; return; }
      await new Promise(done => { waiters.push(done); setTimeout(done, everyMs); });
    }
  };
  const release = () => { running -= 1; for (const done of waiters.splice(0)) done(); };
  return async body => { await acquire(); try { return await body(); } finally { release(); } };
}

/** Resident memory of `root` and everything under it, in bytes; null where `ps` can't say. */
export function treeBytes(root = process.pid) {
  let text;
  try { text = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  const rows = text.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3 && row.every(Number.isFinite));
  const inside = new Set([root]);
  let total = 0;
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) if (!inside.has(pid) && inside.has(ppid)) { inside.add(pid); grew = true; }
  }
  for (const [pid, , rss] of rows) if (inside.has(pid)) total += rss * 1024;
  return total;
}

/** Sample memory every `everyMs` until stopped: the peak in use on the machine, the lowest available, and the peak
 * the check's own processes held. */
export function watchMemory({ everyMs = 2_000, available = availableMemory, tree = treeBytes, total = totalmem() } = {}) {
  const seen = { total, peakUsed: 0, lowestAvailable: Infinity, peakCheck: null };
  const sample = () => {
    const free = available();
    seen.peakUsed = Math.max(seen.peakUsed, total - free);
    seen.lowestAvailable = Math.min(seen.lowestAvailable, free);
    const mine = tree();
    if (mine !== null) seen.peakCheck = Math.max(seen.peakCheck ?? 0, mine);
  };
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref?.();
  return { stop: () => { clearInterval(timer); sample(); return { ...seen }; } };
}

const gb = bytes => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** "peak memory: the check's processes 4.8 GB; the machine 41.2 GB in use of 64.0 GB (lowest available 22.8 GB)" */
export function memoryWords(seen) {
  return `peak memory: ${seen.peakCheck === null ? "" : `the check's processes ${gb(seen.peakCheck)}; `}the machine ${gb(seen.peakUsed)} in use of ${gb(seen.total)} (lowest available ${gb(seen.lowestAvailable)})`;
}
