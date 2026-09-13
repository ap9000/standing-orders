import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec.js";

export type DesktopBundle = { path: string; hash: string; buildId: string; version: string; bundleId: string; schemaVersion: number; development: boolean; providerBin: string; recoveryProtocol?: number };

/** Hash the exact bundle, including executable modes; reject aliases inside
 * it so a checked file cannot secretly refer to mutable external code. */
export function bundleHash(path: string): string {
  const hash = createHash("sha256");
  const walk = (file: string, relative: string): void => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error("Update bundles must contain only regular files and directories, not links.");
    hash.update(JSON.stringify([relative, stat.isDirectory() ? "directory" : "file", stat.mode & 0o777])).update("\0");
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) walk(join(file, name), `${relative}/${name}`);
    else hash.update(readFileSync(file));
    hash.update("\0");
  };
  walk(path, "app"); return hash.digest("hex");
}

export function readDesktopBundle(path: string): DesktopBundle {
  if (!path.endsWith(".app") || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw Error("Choose an app bundle, not a link.");
  const canonical = realpathSync(path), resources = join(canonical, "Contents", "Resources");
  const manifest = JSON.parse(readFileSync(join(resources, "runtime.json"), "utf8"));
  readFileSync(join(resources, "standing-orders-bundle"));
  if (manifest.updateProtocol !== 1) throw Error("This app predates controlled updates. Complete the documented first installation before using this updater.");
  if (manifest.node !== "runtime/node" || !/^[a-f0-9-]{36}$/.test(manifest.buildId) || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !Number.isSafeInteger(manifest.schemaVersion)) throw Error("The update manifest is invalid.");
  const development = manifest.bundleId === "com.standing-orders.desktop.development";
  if (!development && manifest.bundleId !== "com.standing-orders.desktop") throw Error("This is not a Standing Orders app identity.");
  if (manifest.development !== development || typeof manifest.providerBin !== "string") throw Error("The update runtime identity is inconsistent.");
  for (const file of ["runtime/node", "runtime/bundle-swap", "dist/desktop-host.js"]) if (!lstatSync(join(resources, file)).isFile()) throw Error("The app is missing an update helper.");
  return { path: canonical, hash: bundleHash(canonical), buildId: manifest.buildId, version: manifest.version, bundleId: manifest.bundleId, schemaVersion: manifest.schemaVersion, development, providerBin: manifest.providerBin, ...(manifest.recoveryProtocol === 1 ? { recoveryProtocol: 1 } : {}) };
}

async function checked(file: string, args: string[]): Promise<string> {
  const result = await run(file, args, { timeoutMs: 60_000, maxBuffer: 32_768 });
  if (result.code !== 0) throw Error(`App verification failed: ${(result.stderr || result.stdout || "command unavailable").slice(0, 1000)}`);
  return result.stdout + result.stderr;
}

export async function verifyDesktopUpdateBundles(previous: DesktopBundle, candidate: DesktopBundle): Promise<void> {
  if (process.platform !== "darwin") throw Error("The native app updater currently supports macOS only.");
  if (previous.bundleId !== candidate.bundleId) throw Error("A preview cannot replace a release, or a different app identity.");
  for (const app of [previous, candidate]) await checked("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path]);
  const old = await checked("/usr/bin/codesign", ["-dv", "--verbose=4", previous.path]);
  const next = await checked("/usr/bin/codesign", ["-dv", "--verbose=4", candidate.path]);
  for (const [app, signature] of [[previous, old], [candidate, next]] as const) {
    if (!signature.includes(`Identifier=${app.bundleId}\n`)) throw Error("The manifest and signed app identity disagree.");
  }
  if (candidate.development) return; // Explicitly separate preview identity only.
  const team = (text: string) => /^TeamIdentifier=(?!not set$)(.+)$/m.exec(text)?.[1];
  if (!team(old) || team(old) !== team(next) || !/^Authority=Developer ID Application:/m.test(next)) throw Error("A release update must preserve the installed Developer ID signing team.");
  const requirement = /designated => (.+)/.exec(await checked("/usr/bin/codesign", ["-dr", "-", previous.path]))?.[1];
  if (!requirement) throw Error("The installed signing requirement could not be read.");
  await checked("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, candidate.path]);
  await checked("/usr/sbin/spctl", ["--assess", "--type", "execute", candidate.path]);
  await checked("/usr/bin/xcrun", ["stapler", "validate", candidate.path]);
}
