import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reserveDesktopArtifact } from "../scripts/desktop-artifact.mjs";

test("building refuses existing apps, files and links without touching them", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-artifact-"));
  try {
    const app = join(root, "Installed.app"), file = join(root, "File.app"), alias = join(root, "Alias.app");
    mkdirSync(app); writeFileSync(join(app, "sentinel"), "running release"); writeFileSync(file, "unrelated");
    symlinkSync(app, alias, process.platform === "win32" ? "junction" : "dir");
    for (const path of [app, file, alias]) expect(() => reserveDesktopArtifact(path)).toThrow(/output already exists/);
    expect(() => reserveDesktopArtifact(root)).toThrow(/new .app/);
    expect(readFileSync(join(app, "sentinel"), "utf8")).toBe("running release");
    expect(readFileSync(file, "utf8")).toBe("unrelated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication exposes only a finished bundle and a failed build releases only its empty reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-artifact-"));
  try {
    const destination = join(root, "New.app"), staged = join(root, "Staged.app");
    const output = reserveDesktopArtifact(destination);
    expect(() => reserveDesktopArtifact(destination)).toThrow(/output already exists/);
    expect(() => output.publish(staged)).toThrow();
    output.release(); expect(existsSync(destination)).toBe(false);
    mkdirSync(join(staged, "Contents"), { recursive: true });
    writeFileSync(join(staged, "Contents", "Info.plist"), "signed bundle");
    const retry = reserveDesktopArtifact(destination); retry.publish(staged); retry.release();
    expect(readFileSync(join(destination, "Contents", "Info.plist"), "utf8")).toBe("signed bundle");
    expect(existsSync(join(staged, "Contents"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a changed or replaced output is preserved instead of overwritten or cleaned up", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-artifact-"));
  try {
    const destination = join(root, "New.app"), output = reserveDesktopArtifact(destination);
    writeFileSync(join(destination, "foreign"), "keep");
    expect(() => output.publish(join(root, "Stage.app"))).toThrow(/reserved output changed/);
    output.release(); expect(readFileSync(join(destination, "foreign"), "utf8")).toBe("keep");
    renameSync(destination, join(root, "Moved.app")); mkdirSync(destination);
    expect(() => output.publish(join(root, "Stage.app"))).toThrow(/reserved output changed/);
    output.release(); expect(existsSync(destination)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
