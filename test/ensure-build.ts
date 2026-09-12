import { execSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** CLI integration tests are required even on a fresh checkout. Build once,
 * before workers import tests, only when published runtime inputs changed. */
export default function ensureBuild(): void {
  const root = resolve(import.meta.dirname, "..");
  const stale = readdirSync(join(root, "src")).some(name => {
    if ((!name.endsWith(".ts") || name.endsWith(".test.ts")) && name !== "supervisor.mjs" && name !== "job-object-helper.ps1") return false;
    const output = join(root, "dist", name.replace(/\.ts$/, ".js"));
    return !existsSync(output) || statSync(join(root, "src", name)).mtimeMs > statSync(output).mtimeMs;
  });
  if (stale) execSync("npm run build", { cwd: root, stdio: "inherit" });
}
