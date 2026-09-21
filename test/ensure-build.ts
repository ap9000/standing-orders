import { execSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** CLI integration tests are required even on a fresh checkout. Build once,
 * before workers import tests, only when published runtime inputs changed. */
export function buildIsStale(root: string): boolean {
  const runtimeOutput = join(root, "dist", "cli.js");
  if (!existsSync(runtimeOutput)) return true;
  const runtimeBuiltAt = statSync(runtimeOutput).mtimeMs;
  const buildInputs = [
    "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json",
    "tsconfig.browser.json", "scripts/browser-build.mjs", "scripts/postbuild.mjs",
    "THIRD_PARTY_NOTICES.md",
  ];
  if (buildInputs.some(input => !existsSync(join(root, input)) || statSync(join(root, input)).mtimeMs > runtimeBuiltAt)) return true;

  if (readdirSync(join(root, "src")).some(name => {
    if ((!name.endsWith(".ts") || name.endsWith(".test.ts")) && name !== "supervisor.mjs" && name !== "job-object-helper.ps1") return false;
    if (name.endsWith(".d.ts")) return statSync(join(root, "src", name)).mtimeMs > runtimeBuiltAt;
    const output = join(root, "dist", name.replace(/\.ts$/, ".js"));
    return !existsSync(output) || statSync(join(root, "src", name)).mtimeMs > statSync(output).mtimeMs;
  })) return true;

  const browserOutputs = ["workspace.js", "workspace.css", "THIRD_PARTY_NOTICES.txt"].map(name => join(root, "dist", "browser", name));
  if (browserOutputs.some(output => !existsSync(output))) return true;
  const browserBuiltAt = Math.min(...browserOutputs.map(output => statSync(output).mtimeMs));
  const newerBrowserInput = (directory: string): boolean => {
    if (!existsSync(directory) || statSync(directory).mtimeMs > browserBuiltAt) return true;
    return readdirSync(directory, { withFileTypes: true }).some(entry => {
      if (/\.test\.tsx?$/.test(entry.name)) return false;
      const path = join(directory, entry.name);
      // Directory mtimes also catch deleted imports; file-only scans miss them.
      return entry.isDirectory() ? newerBrowserInput(path) : statSync(path).mtimeMs > browserBuiltAt;
    });
  };
  return newerBrowserInput(join(root, "src", "browser"));
}

export default function ensureBuild(): void {
  const root = resolve(import.meta.dirname, "..");
  if (buildIsStale(root)) execSync("npm run build", { cwd: root, stdio: "inherit" });
}
