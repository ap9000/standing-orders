/**
 * Tier-2 attestation (Phase 3): ranges, probes, and the executable-identity
 * cache. Real files and real subprocesses — the cache's revalidation story
 * is about inodes and ctimes, so the tests use actual ones.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, statSync, utimesSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  attestProvider,
  attestationOf,
  resetAttestationCache,
  resolveExecutable,
  versionInRange,
  type VersionProbe,
} from "./attest.js";

const RANGE = attestationOf("gemini");

describe("the version rule", () => {
  test("gemini carries a range; tier-1 providers deliberately carry none", () => {
    expect(RANGE).not.toBeNull();
    expect(attestationOf("claude")).toBeNull();
    expect(attestationOf("codex")).toBeNull();
    expect(attestationOf("openrouter")).toBeNull();
  });

  test("floor inclusive, ceiling exclusive", () => {
    expect(versionInRange("0.57.0", RANGE!)).toBe(true);
    expect(versionInRange("0.57.9", RANGE!)).toBe(true);
    expect(versionInRange("0.56.9", RANGE!)).toBe(false);
    expect(versionInRange("0.58.0", RANGE!)).toBe(false);
    expect(versionInRange("1.0.0", RANGE!)).toBe(false);
  });

  test("only a plain release attests — prerelease, nightly, and garbage are out BY RULE", () => {
    expect(versionInRange("0.57.1-nightly.20260826", RANGE!)).toBe(false);
    expect(versionInRange("0.58.0-preview.0", RANGE!)).toBe(false);
    expect(versionInRange("v0.57.0", RANGE!)).toBe(false);
    expect(versionInRange("", RANGE!)).toBe(false);
    expect(versionInRange("not-a-version", RANGE!)).toBe(false);
  });
});

describe("the probe and its cache", () => {
  let dir: string;
  let savedPath: string | undefined;

  const fakeGemini = (version: string): string => {
    const path = join(dir, "gemini");
    writeFileSync(path, `#!/bin/sh\necho "${version}"\n`);
    chmodSync(path, 0o755);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attest-"));
    savedPath = process.env["PATH"];
    resetAttestationCache();
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env["PATH"] = savedPath;
    rmSync(dir, { recursive: true, force: true });
    resetAttestationCache();
  });

  const onPath = (): void => {
    process.env["PATH"] = `${dir}${delimiter}${savedPath ?? ""}`;
  };

  test("an in-range binary attests, and probe and spawn share ONE resolved path", async () => {
    const executable = fakeGemini("0.57.0");
    onPath();
    const outcome = await attestProvider("gemini", "gemini");
    expect(outcome).toMatchObject({ ok: true, version: "0.57.0" });
    expect(resolveExecutable("gemini")).toBe((outcome as { executable: string }).executable);
    expect((outcome as { executable: string }).executable).toBe(statSync(executable) && (outcome as { executable: string }).executable);
  });

  test("out of range refuses with both versions in words", async () => {
    fakeGemini("0.58.1");
    onPath();
    const outcome = await attestProvider("gemini", "gemini");
    expect(outcome).toMatchObject({ ok: false, version: "0.58.1" });
    expect((outcome as { problem: string }).problem).toContain("0.58.1");
    expect((outcome as { problem: string }).problem).toContain("0.57.0");
  });

  test("a prerelease answer refuses as not-a-plain-release", async () => {
    fakeGemini("0.59.0-nightly.20260826.g64b5b79a6");
    onPath();
    const outcome = await attestProvider("gemini", "gemini");
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { problem: string }).problem).toContain("plain releases");
  });

  test("not installed refuses in words — never a throw", async () => {
    process.env["PATH"] = dir; // empty dir: nothing resolves
    const outcome = await attestProvider("gemini", "gemini");
    expect(outcome).toMatchObject({ ok: false, version: null });
    expect((outcome as { problem: string }).problem).toContain("not installed");
  });

  test("a probe that answers nonsense or fails refuses", async () => {
    const path = join(dir, "gemini");
    writeFileSync(path, `#!/bin/sh\nexit 3\n`);
    chmodSync(path, 0o755);
    onPath();
    const outcome = await attestProvider("gemini", "gemini");
    expect(outcome).toMatchObject({ ok: false, version: null });
  });

  test("tier-1 providers return null — no probe ever runs for them", async () => {
    let probed = 0;
    const probe: VersionProbe = async () => {
      probed++;
      return { code: 0, stdout: "1.0.0" };
    };
    expect(await attestProvider("claude", "claude", probe)).toBeNull();
    expect(probed).toBe(0);
  });

  test("an unchanged binary is probed once; a swap re-probes even with size AND mtime preserved", async () => {
    const path = fakeGemini("0.57.0");
    onPath();
    let probes = 0;
    const probe: VersionProbe = async (file, args, timeout) => {
      probes++;
      const { execFileSync } = await import("node:child_process");
      return { code: 0, stdout: execFileSync(file, [...args], { timeout, encoding: "utf8" }) };
    };

    expect(await attestProvider("gemini", "gemini", probe)).toMatchObject({ ok: true, version: "0.57.0" });
    expect(await attestProvider("gemini", "gemini", probe)).toMatchObject({ ok: true, version: "0.57.0" });
    expect(probes).toBe(1); // the second check revalidated by stat alone

    // The hard case (round-3 f3): replace with a SAME-SIZE file and restore
    // the mtime — only dev/ino/ctime give the swap away.
    const before = statSync(path);
    const swap = join(dir, "gemini-next");
    writeFileSync(swap, `#!/bin/sh\necho "0.58.5"\n`); // same byte length as 0.57.0 line
    chmodSync(swap, 0o755);
    renameSync(swap, path);
    utimesSync(path, before.atime, before.mtime);
    const after = statSync(path);
    expect(after.size).toBe(before.size);
    expect(Math.round(after.mtimeMs)).toBe(Math.round(before.mtimeMs));

    const outcome = await attestProvider("gemini", "gemini", probe);
    expect(probes).toBe(2); // the swap forced a fresh probe
    expect(outcome).toMatchObject({ ok: false, version: "0.58.5" });
  });
});
