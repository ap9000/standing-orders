import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { observeProcessTree, sampleProcessTree, stopProcessTree, readProcessObservationFailure } from "./process-tree.js";

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

test.each(["ETIMEDOUT", "EPERM", "malformed", "diagnostic-write"])("a final %s lookup retains known descendants without inventing a lost spawn", code => {
  const exited = vi.fn(), unknown = vi.fn(), diagnostic = vi.fn();
  observeProcessTree(child, { onDescendant: vi.fn(), onDescendantExit: exited, onUnknown: unknown, onObservationFailure: diagnostic });
  sampleProcessTree(child);
  if (code === "diagnostic-write") diagnostic.mockImplementation(() => { throw new Error("private ledger error"); });
  vi.mocked(childProcess.execFileSync).mockImplementation(() => {
    if (code === "malformed") return "100 not-a-parent 100";
    throw Object.assign(new Error("private error output"), { code: code === "diagnostic-write" ? "EIO" : code, stdout: "private stdout" });
  });
  child.emit("close");
  expect(exited).not.toHaveBeenCalled(); expect(unknown).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ phase: "final-exit", operation: "snapshot", code: code === "malformed" ? "MALFORMED_SNAPSHOT" : code === "diagnostic-write" ? "EIO" : code, rootPid: 100, at: expect.any(String), identityUnknown: false });
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private");
});

test("discovery failure stays fenced after a later successful scan; diagnostics are bounded", () => {
  const unknown = vi.fn(), diagnostic = vi.fn();
  observeProcessTree(child, { onDescendant: vi.fn(), onUnknown: unknown, onObservationFailure: diagnostic });
  vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw Object.assign(new Error("private"), { code: "EAGAIN" }); });
  vi.advanceTimersByTime(1000);
  expect(unknown).toHaveBeenCalledTimes(2); expect(diagnostic).toHaveBeenCalledOnce();
  expect(diagnostic.mock.calls[0]![0]).toMatchObject({ phase: "periodic", operation: "snapshot", identityUnknown: true });
  vi.mocked(childProcess.execFileSync).mockReturnValue("100 1 100\n");
  sampleProcessTree(child);
  expect(unknown).toHaveBeenCalledTimes(2);
});

test("descendant write failure stays fenced, but failed exit writes never erase known identity", () => {
  const unknown = vi.fn(), diagnostic = vi.fn(), appeared = vi.fn().mockImplementation(() => { throw new Error("private database error"); });
  observeProcessTree(child, { onDescendant: appeared, onDescendantExit: () => { throw new Error("failed exit write"); }, onUnknown: unknown, onObservationFailure: diagnostic });
  sampleProcessTree(child);
  expect(unknown).toHaveBeenCalledOnce();
  expect(diagnostic.mock.calls[0]![0]).toMatchObject({ operation: "descendant-write", identityUnknown: true });
  appeared.mockImplementation(() => {}); sampleProcessTree(child);
  rows = "100 1 100\n"; child.emit("close");
  expect(unknown).toHaveBeenCalledOnce();
  expect(diagnostic.mock.calls[1]![0]).toMatchObject({ phase: "final-exit", operation: "exit-write", identityUnknown: false });
});

test("private supervisor diagnostics validate and discard non-diagnostic fields", () => {
  const failure = { phase: "final-exit", operation: "snapshot", code: "EPERM", rootPid: 100, at: "2026-09-20T00:00:00.000Z", identityUnknown: false };
  expect(readProcessObservationFailure({ ...failure, argv: "private" })).toEqual(failure);
  expect(readProcessObservationFailure({ ...failure, code: "private error text" })).toBeNull();
  expect(readProcessObservationFailure({ ...failure, rootPid: -1 })).toBeNull();
});

test("becoming a group leader records the stronger group witness too", () => {
  const appeared = vi.fn(); rows = "100 1 100\n200 100 100\n";
  observeProcessTree(child, { onDescendant: appeared }); sampleProcessTree(child);
  rows = "100 1 100\n200 100 200\n"; sampleProcessTree(child);
  expect(appeared.mock.calls).toEqual([[200, false], [200, true]]);
});


test("a durable fallback preserves the failed ID and every unprocessed sibling without replaying callbacks", () => {
  rows = "100 1 100\n200 100 200\n300 100 100\n400 300 400\n";
  const appeared = vi.fn((pid: number) => {
    if (pid === 300) throw Object.assign(new Error("private database path"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  });
  const fallback = vi.fn(() => true), unknown = vi.fn(), exited = vi.fn(), diagnostic = vi.fn();
  observeProcessTree(child, { onDescendant: appeared, onDescendantWriteFailure: fallback,
    onDescendantExit: exited, onUnknown: unknown, onObservationFailure: diagnostic });
  sampleProcessTree(child);
  expect(appeared.mock.calls).toEqual([[200, true], [300, false]]);
  expect(fallback).toHaveBeenCalledExactlyOnceWith([{ pid: 300, group: false }, { pid: 400, group: true }]);
  expect(unknown).not.toHaveBeenCalled();
  expect(diagnostic.mock.calls[0]![0]).toMatchObject({ operation: "descendant-write", code: "SQLITE_BUSY", identityUnknown: false });
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private");
  // The processes can disappear or reparent before the next scan: every ID
  // remains available for the ordinary positive-exit probe.
  rows = "100 1 100\n"; sampleProcessTree(child);
  expect(exited.mock.calls).toEqual([[200, true], [300, false], [400, true]]);
  expect(appeared).toHaveBeenCalledTimes(2);
});

test.each(["refused", "throws"])("a %s durable fallback preserves the unknown safeguard", mode => {
  const unknown = vi.fn(), diagnostic = vi.fn();
  observeProcessTree(child, { onDescendant: () => { throw new Error("write failed"); },
    onDescendantWriteFailure: () => { if (mode === "throws") throw new Error("commit failed"); return false; },
    onUnknown: unknown, onObservationFailure: diagnostic });
  sampleProcessTree(child);
  expect(unknown).toHaveBeenCalledOnce();
  expect(diagnostic.mock.calls[0]![0]).toMatchObject({ operation: "descendant-write", identityUnknown: true });
});

test("a known-ID fallback cannot settle a failed process scan", () => {
  const fallback = vi.fn(() => true), unknown = vi.fn();
  observeProcessTree(child, { onDescendant: vi.fn(), onDescendantWriteFailure: fallback, onUnknown: unknown });
  vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw Object.assign(new Error("scan failed"), { code: "EIO" }); });
  sampleProcessTree(child);
  expect(fallback).not.toHaveBeenCalled(); expect(unknown).toHaveBeenCalledOnce();
});


test("a stop never signals descendants from a snapshot delayed by fallback persistence", () => {
  child.kill = vi.fn(() => true);
  const fallback = vi.fn(() => true), unknown = vi.fn();
  observeProcessTree(child, { onDescendant: () => { throw new Error("write failed"); },
    onDescendantWriteFailure: fallback, onUnknown: unknown });
  expect(stopProcessTree(child)).toBe(false);
  expect(fallback).not.toHaveBeenCalled();
  expect(process.kill).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith("SIGSTOP");
  expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  expect(unknown).toHaveBeenCalledOnce();
});
