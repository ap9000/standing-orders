import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIsStale } from "../test/ensure-build.js";

const roots: string[] = [];
const old = new Date("2026-01-01T00:00:00Z");
const built = new Date("2026-01-02T00:00:00Z");
const edited = new Date("2026-01-03T00:00:00Z");

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "standing-orders-build-freshness-"));
  roots.push(root);
  const files = [
    "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json",
    "tsconfig.browser.json", "scripts/browser-build.mjs", "scripts/postbuild.mjs",
    "THIRD_PARTY_NOTICES.md", "src/cli.ts", "src/browser/app.tsx",
    "src/browser/workspace.css", "src/browser/ui/button.tsx",
    "src/browser/workspace-client.test.ts", "dist/cli.js",
    "dist/browser/workspace.js", "dist/browser/workspace.css", "dist/browser/THIRD_PARTY_NOTICES.txt",
  ];
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture\n");
    utimesSync(path, file.startsWith("dist/") ? built : old, file.startsWith("dist/") ? built : old);
  }
  for (const directory of ["src/browser", "src/browser/ui"]) utimesSync(join(root, directory), old, old);
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("published runtime freshness", () => {
  it("keeps an unchanged build and ignores edits to browser tests", () => {
    const root = fixture();
    expect(buildIsStale(root)).toBe(false);
    utimesSync(join(root, "src/browser/workspace-client.test.ts"), edited, edited);
    expect(buildIsStale(root)).toBe(false);
  });

  it.each([
    "src/browser/app.tsx", "src/browser/workspace.css", "src/browser/ui/button.tsx",
    "scripts/browser-build.mjs", "scripts/postbuild.mjs", "tsconfig.browser.json",
    "package-lock.json", "THIRD_PARTY_NOTICES.md",
  ])("rebuilds after changing %s", input => {
    const root = fixture();
    utimesSync(join(root, input), edited, edited);
    expect(buildIsStale(root)).toBe(true);
  });

  it("rebuilds after deleting a browser input", () => {
    const root = fixture();
    rmSync(join(root, "src/browser/ui/button.tsx"));
    utimesSync(join(root, "src/browser/ui"), edited, edited);
    expect(buildIsStale(root)).toBe(true);
  });

  it.each(["workspace.js", "workspace.css", "THIRD_PARTY_NOTICES.txt"])("rebuilds when %s is absent", output => {
    const root = fixture();
    rmSync(join(root, "dist/browser", output));
    expect(buildIsStale(root)).toBe(true);
  });
});
