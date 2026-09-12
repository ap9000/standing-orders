import { afterEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const children: ChildProcess[] = [];
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("close", () => resolve()); child.kill("SIGKILL");
  })));
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function ask(path: string, verb: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const wire = connect(path, () => wire.write(JSON.stringify({ cookie: "test", verb }) + "\n"));
    let answer = "";
    wire.setTimeout(8000, () => wire.destroy(new Error("control reply timed out")));
    wire.on("data", chunk => { answer += chunk; });
    wire.on("error", reject);
    wire.on("end", () => { try { resolve(JSON.parse(answer)); } catch (error) { reject(error); } });
  });
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "so-drain-")); paths.push(dir);
  copyFileSync(new URL("./supervisor.mjs", import.meta.url), join(dir, "supervisor.mjs"));
  // Control the descendant observation boundary, not the supervisor. This
  // owned process remains live after root exit until the test releases it,
  // making the close-vs-drain race deterministic without timing SIGKILL.
  const descendant = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  children.push(descendant);
  const descendantExit = new Promise<void>(resolve => descendant.once("close", () => resolve()));
  writeFileSync(join(dir, "process-tree.js"), `
export function observeProcessTree(child, observer) { observer.onDescendant(${descendant.pid}); }
export function stopProcessTree(child) { return child.kill("SIGKILL"); }
`);
  const socket = join(dir, "control.sock");
  const supervisor = spawn(process.execPath, [join(dir, "supervisor.mjs"), process.execPath, "-e", "process.stdin.resume()"], {
    env: { ...process.env, SO_HELD_SOCKET: socket, SO_HELD_COOKIE: "test" }, stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(supervisor);
  const exited = new Promise<number | null>(resolve => supervisor.once("close", code => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.stdout!.once("data", () => resolve());
  });
  supervisor.stdin!.end();
  // The status reply tells us the actual root exit happened; no fixed wait.
  const deadline = Date.now() + 3000;
  let status;
  do { status = await ask(socket, "status"); if (status.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  expect(status?.exitCode).toBe(0);
  return { supervisor, descendant, descendantExit, exited, socket, status };
}

describe.skipIf(process.platform === "win32")("supervisor drain ownership", () => {
  test("root close retains custody and a kill reply until the observed descendant is gone", async () => {
    const f = await fixture();
    expect(f.status).toMatchObject({ alive: true, groupAlive: false });
    let replied = false;
    const reply = ask(f.socket, "kill").then(value => { replied = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(replied).toBe(false);
    expect(f.supervisor.exitCode).toBeNull();
    f.descendant.stdin!.end(); await f.descendantExit;
    expect(await reply).toMatchObject({ ok: true, killed: false, settled: true });
    expect(await f.exited).toBe(0);
  }, 12000);

  test("a live descendant cannot produce a successful exit or settled kill after the drain deadline", async () => {
    const f = await fixture();
    expect(await ask(f.socket, "kill")).toMatchObject({ settled: false });
    expect(await f.exited).toBe(126);
    expect(f.descendant.exitCode).toBeNull();
  }, 12000);
});
