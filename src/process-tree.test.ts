import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { observeProcessTree, sampleProcessTree } from "./process-tree.js";

vi.mock("node:child_process", { spy: true });
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let child: childProcess.ChildProcess;
let rows: string;
const gone = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null }) as childProcess.ChildProcess;
  rows = "100 1 100\n200 100 200\n";
  vi.mocked(childProcess.execFileSync).mockImplementation(() => rows);
  vi.spyOn(process, "kill").mockImplementation(gone);
});
afterEach(() => {
  rows = "100 1 100\n"; child.emit("close");
  vi.restoreAllMocks(); vi.mocked(childProcess.execFileSync).mockReset();
  vi.useRealTimers(); Object.defineProperty(process, "platform", platform);
});

test("periodic observation records a gone descendant before root exit and observes reused numbers anew", () => {
  const appeared = vi.fn(), exited = vi.fn();
  observeProcessTree(child, { onDescendant: appeared, onDescendantExit: exited });
  vi.advanceTimersByTime(500);
  expect(appeared).toHaveBeenCalledExactlyOnceWith(200, true);
  rows = "100 1 100\n";
  vi.advanceTimersByTime(500);
  expect(exited).toHaveBeenCalledExactlyOnceWith(200, true);
  expect(child.exitCode).toBeNull();
  rows = "100 1 100\n200 100 200\n";
  vi.advanceTimersByTime(500);
  expect(appeared).toHaveBeenCalledTimes(2);
  expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

test.each(["reparented", "orphan-group", "denied", "unknown-probe"])("%s is never an exit observation", state => {
  const exited = vi.fn();
  observeProcessTree(child, { onDescendant: vi.fn(), onDescendantExit: exited });
  sampleProcessTree(child);
  rows = state === "reparented" ? "100 1 100\n200 1 200\n" : state === "orphan-group" ? "100 1 100\n201 1 200\n" : "100 1 100\n";
  if (state === "denied" || state === "unknown-probe") vi.mocked(process.kill).mockImplementation(() => {
    throw Object.assign(new Error(state), { code: state === "denied" ? "EPERM" : "EIO" });
  });
  sampleProcessTree(child);
  expect(exited).not.toHaveBeenCalled();
});

test("a failed final snapshot retains uncertainty; a root close never certifies its descendants", () => {
  const exited = vi.fn(), unknown = vi.fn();
  observeProcessTree(child, { onDescendant: vi.fn(), onDescendantExit: exited, onUnknown: unknown });
  sampleProcessTree(child);
  vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw new Error("unreadable snapshot"); });
  child.emit("close");
  expect(exited).not.toHaveBeenCalled(); expect(unknown).toHaveBeenCalledOnce();
});

test("becoming a group leader records the stronger group witness too", () => {
  const appeared = vi.fn(); rows = "100 1 100\n200 100 100\n";
  observeProcessTree(child, { onDescendant: appeared }); sampleProcessTree(child);
  rows = "100 1 100\n200 100 200\n"; sampleProcessTree(child);
  expect(appeared.mock.calls).toEqual([[200, false], [200, true]]);
});
