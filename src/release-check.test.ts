import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { definesSchema, planFor, versionOnly } from "../scripts/release-check.mjs";
import { completionProblems, installPublished, lastPublished, missingTables } from "../scripts/upgrade-path.mjs";

const pkg = (version: string, dependencies: Record<string, string> = { zod: "^3.23.0" }) => JSON.stringify({ name: "toolroll", version, type: "module", dependencies }, null, 2) + "\n";
const lock = (version: string, zod = "3.23.8") => JSON.stringify({
  name: "toolroll", version, lockfileVersion: 3, requires: true,
  packages: { "": { name: "toolroll", version, dependencies: { zod: "^3.23.0" } }, "node_modules/zod": { version: zod, resolved: `https://registry.npmjs.org/zod/-/zod-${zod}.tgz` } },
}, null, 2) + "\n";

describe("a release's version bump", () => {
  test("only the project's own version changed: not a dependency change", () => {
    expect(versionOnly("package.json", pkg("0.9.5"), pkg("0.9.6"))).toBe(true);
    expect(versionOnly("package-lock.json", lock("0.9.5"), lock("0.9.6"))).toBe(true);
  });

  test("a dependency, its locked version, a missing side or unreadable JSON is a real change", () => {
    expect(versionOnly("package.json", pkg("0.9.5"), pkg("0.9.6", { zod: "^3.24.0" }))).toBe(false);
    expect(versionOnly("package-lock.json", lock("0.9.5"), lock("0.9.6", "3.24.1"))).toBe(false);
    expect(versionOnly("package.json", null, pkg("0.9.6"))).toBe(false);
    expect(versionOnly("package.json", pkg("0.9.5"), "{")).toBe(false);
    expect(versionOnly("src/version.ts", "a", "a")).toBe(false);
  });

  test("the plan: a bump beside a change sizes to that change; without one, the version files run everything", () => {
    const changed = ["package.json", "package-lock.json", "src/store.ts", "CHANGELOG.md"];
    expect(planFor(changed, { versionBumps: ["package.json", "package-lock.json"] })).toMatchObject({ unit: "related", browser: false });
    expect(planFor(changed)).toMatchObject({ unit: "all", browser: true });
    expect(planFor(["package.json", "package-lock.json"], { versionBumps: ["package.json", "package-lock.json"] })).toMatchObject({ unit: "none", browser: false });
    expect(planFor(changed, { full: true, versionBumps: ["package.json"] })).toMatchObject({ unit: "all", browser: true });
  });
});

describe("node scripts/release-check.mjs --plan", () => {
  let dir: string | null = null;
  afterEach(() => { if (dir !== null) rmSync(dir, { recursive: true, force: true }); dir = null; });
  const script = resolve(import.meta.dirname, "../scripts/release-check.mjs");

  /** A repository at `base`, then one commit with `files`; the plan the release check prints for it. */
  const planOf = (files: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), "so-release-check-"));
    const git = (...argv: string[]) => execFileSync("git", ["-C", dir!, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...argv], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "package.json"), pkg("0.9.5")); writeFileSync(join(dir, "package-lock.json"), lock("0.9.5"));
    writeFileSync(join(dir, "store.ts"), "export const a = 1;\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    git("add", "."); git("commit", "-qm", "change");
    return execFileSync(process.execPath, [script, "--plan", "--base", base], { cwd: dir, encoding: "utf8" }).trim();
  };

  test("a version-only package.json and lockfile change plans the sized check", () => {
    expect(planOf({ "package.json": pkg("0.9.6"), "package-lock.json": lock("0.9.6") }))
      .toMatch(/\(2 changed files\): nothing a test reads changed; only the version changed in package-lock\.json and package\.json\.$/);
  });

  test("a run: the unit tests start beside the build and wait for its outcome; the summary keeps its lines and says how long each part took", () => {
    // Stand-in scripts: the build takes a moment and the tests wait for the outcome the release check hands them.
    const scripts = {
      typecheck: "node -e \"console.log('typed')\"",
      build: "node -e \"setTimeout(() => console.log('built'), 1500)\"",
      test: "node units.cjs",
    };
    const units = "const fs = require('fs'), at = Date.now(), m = process.env.TOOLROLL_RELEASE_BUILD;\n" +
      "const wait = () => fs.existsSync(m) ? console.log(' Test Files  1 passed (1) after ' + fs.readFileSync(m, 'utf8') + ', waited ' + (Date.now() - at >= 500)) : setTimeout(wait, 50);\nwait();\n";
    const manifest = (version: string) => JSON.stringify({ name: "toolroll", version, scripts }, null, 2) + "\n";
    dir = mkdtempSync(join(tmpdir(), "so-release-check-"));
    const git = (...argv: string[]) => execFileSync("git", ["-C", dir!, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...argv], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "package.json"), manifest("0.9.5")); writeFileSync(join(dir, "units.cjs"), units);
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "package.json"), manifest("0.9.6"));
    mkdirSync(join(dir, "test")); writeFileSync(join(dir, "test", "setup.ts"), "export {};\n");
    git("add", "."); git("commit", "-qm", "change");
    const out = execFileSync(process.execPath, [script, "--base", base], { cwd: dir, encoding: "utf8" });
    const summary = out.slice(out.indexOf("== summary"));
    expect(out).toContain("(2 changed files): every unit test (test/setup.ts changed); no browser journeys (nothing a page shows changed); only the version changed in package.json.");
    expect(summary.split("\n").slice(0, 4)).toEqual(["== summary", "plan: every unit test (test/setup.ts changed); no browser journeys (nothing a page shows changed); only the version changed in package.json", "unit: exit 0", " Test Files  1 passed (1) after ok, waited true"]);
    expect(summary).toMatch(/\ntook: typecheck \d+ s, build \d+ s, unit \d+ s; whole check \d+ s\n$/);
  });

  test("a real dependency change still runs everything", () => {
    expect(planOf({ "package.json": pkg("0.9.6", { zod: "^3.24.0" }), "package-lock.json": lock("0.9.6", "3.24.1") }))
      .toMatch(/\(2 changed files\): every unit test \(package-lock\.json changed\); browser journeys \(package-lock\.json changed\)\.$/);
  });
});

describe("the upgrade path step", () => {
  test("runs only for what an update from an installed release can trip on", () => {
    for (const file of ["src/store.ts", "src/assignment.ts", "src/assignment-status.ts", "src/dispatch.ts", "src/work-summary.ts", "src/review-switch.ts",
      "src/toolroll-update.ts", "src/desktop-update.ts", "src/desktop-update-gate.ts", "scripts/deploy-browser.mjs", "scripts/deploy-candidate.mjs", "scripts/upgrade-path.mjs"])
      expect(planFor([file]), file).toMatchObject({ upgrade: true, upgradeWhy: `${file} changed` });
    // A file that defines a table, whatever its name.
    expect(planFor(["src/spend.ts"], { schemaFiles: ["src/spend.ts"] })).toMatchObject({ upgrade: true, upgradeWhy: "src/spend.ts changed" });
    for (const changed of [["src/spend.ts"], ["src/browser/chat.ts", "src/serve.ts"], ["src/store.test.ts", "src/toolroll-update.test.ts"], ["docs/x.md", "CHANGELOG.md"]])
      expect(planFor(changed), changed.join()).toMatchObject({ upgrade: false });
    expect(planFor(["docs/x.md"], { full: true })).toMatchObject({ upgrade: true });
    expect(definesSchema("const x = 1;\nexport const SPEND_SCHEMA = `CREATE TABLE spend(id)`;")).toBe(true);
    expect(definesSchema("const SCHEMA_EPOCH = 4;\nimport { STORE_SCHEMA } from './store.js';")).toBe(false);
  });

  test("a published release is installed once, then copied from the cache; an interrupted install is not used", () => {
    const root = mkdtempSync(join(tmpdir(), "so-upgrade-cache-"));
    try {
      const cache = join(root, "cache");
      let installs = 0;
      // npm's global layout: the command a relative link into lib/node_modules.
      const install = (into: string) => {
        installs++;
        mkdirSync(join(into, "lib", "node_modules", "toolroll", "dist"), { recursive: true }); mkdirSync(join(into, "bin"));
        writeFileSync(join(into, "lib", "node_modules", "toolroll", "dist", "bin.js"), "// 0.9.7\n");
        symlinkSync("../lib/node_modules/toolroll/dist/bin.js", join(into, "bin", "toolroll"));
      };
      // A run killed mid-install left a partial copy behind.
      mkdirSync(join(cache, "0.9.7", "lib"), { recursive: true });
      expect(installPublished("0.9.7", join(root, "a"), {}, { cache, install })).toBe("installed");
      expect(installPublished("0.9.7", join(root, "b"), {}, { cache, install })).toBe("cached");
      expect(installs).toBe(1);
      for (const home of ["a", "b"]) {
        expect(readlinkSync(join(root, home, "bin", "toolroll"))).toBe("../lib/node_modules/toolroll/dist/bin.js");
        expect(realpathSync(join(root, home, "bin", "toolroll"))).toBe(realpathSync(join(root, home, "lib", "node_modules", "toolroll", "dist", "bin.js")));
        expect(existsSync(join(root, home, ".complete"))).toBe(false);
      }
      // Each home is its own copy: what one release's run writes never reaches the cache.
      writeFileSync(join(root, "a", "lib", "node_modules", "toolroll", "dist", "bin.js"), "changed");
      expect(readFileSync(join(cache, "0.9.7", "lib", "node_modules", "toolroll", "dist", "bin.js"), "utf8")).toBe("// 0.9.7\n");
      expect(() => installPublished("../x", join(root, "c"), {}, { cache, install })).toThrow("not a release version");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the last 3 published releases, oldest first; a prerelease is not one", () => {
    expect(lastPublished(["0.9.10", "0.9.4", "0.9.9-beta.1", "0.9.8", "0.10.0", "0.9.9"])).toEqual(["0.9.9", "0.9.10", "0.10.0"]);
  });

  test("a completed task must stay complete under the same digest, and every fresh table must exist", () => {
    const before = [{ task: "a", digest: "d1" }, { task: "b", digest: "d2" }, { task: "c", digest: "d3" }];
    expect(completionProblems(before, { a: { state: "complete", digest: "d1" }, b: { state: "complete", digest: "d2" }, c: { state: "complete", digest: "d3" } })).toEqual([]);
    expect(completionProblems(before, { a: { state: "ready-to-check", digest: null }, b: { state: "complete", digest: "other" } }))
      .toEqual(["a is ready-to-check, not complete", "b's completed result changed digest (d2 → other)", "c is gone"]);
    expect(missingTables(["build_review", "run", "task"], ["run", "task"])).toEqual(["build_review"]);
  });
});
