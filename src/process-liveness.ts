/** Read-only checks of retained process witnesses. Saved PIDs authorize no
 * signal: only ESRCH proves absence; denied/unknown checks remain occupied. */
export function processMayBeAlive(pid: number, group: boolean): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (group && process.platform !== "win32") {
    try { process.kill(-pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true; }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
