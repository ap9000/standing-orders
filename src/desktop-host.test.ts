import { test, expect } from "vitest";
import { mkdtempSync, rmSync, realpathSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDesktopConfig, writeDesktopConfig } from "./desktop-host.js";

test("repository aliases resolve together and missing checkouts retain the installation identity", () => {
  const root = mkdtempSync(join(tmpdir(), "so-desktop-config-"));
  try {
    const repo = join(root, "repo"); mkdirSync(repo);
    const alias = join(root, "alias"); symlinkSync(repo, alias);
    const missing = join(root, "moved-repo");
    const config = { version: 1 as const, databaseFile: join(root, "existing.db"), repos: [repo, alias, missing], port: 14187, identity: "a".repeat(64) };
    writeDesktopConfig(root, config);
    expect(readDesktopConfig(root)).toEqual({ ...config, repos: [realpathSync(repo), missing] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
