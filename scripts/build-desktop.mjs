#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync, rmSync, existsSync, lstatSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") throw new Error("The first desktop shell targets macOS. The web console remains cross-platform.");
const destination = resolve(process.argv[2] ?? join(homedir(), "Applications", "Standing Orders.app"));
// Only remove our own known bundle output, never an arbitrary caller path.
if (existsSync(destination)) {
  if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory() || !existsSync(join(destination, "Contents", "Resources", "standing-orders-bundle"))) throw new Error("Output exists and is not a Standing Orders build.");
}
mkdirSync(dirname(destination), { recursive: true });
const staging = mkdtempSync(join(dirname(destination), ".standing-orders-build-"));
const app = join(staging, "Standing Orders.app");
const previous = join(staging, "previous.app");
let published = false;
// A login service must not depend on a removable nvm version or Homebrew
// symlink. Bundle the actual runtime and its redistribution notices. Refuse
// a dynamically linked package-manager build we cannot make self-contained.
const sourceNode = realpathSync(process.execPath);
const libraries = execFileSync("/usr/bin/otool", ["-L", sourceNode], { encoding: "utf8" }).split("\n").slice(1)
  .map(line => line.trim().split(" (", 1)[0]).filter(Boolean);
if (libraries.some(path => !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"))) {
  throw new Error("The desktop needs a standalone Node distribution. Build with an official Node binary; this runtime depends on external package-manager libraries.");
}
const nodeLicense = join(dirname(sourceNode), "..", "LICENSE");
if (!existsSync(nodeLicense)) throw new Error("The Node distribution's LICENSE is missing. Build with an official Node distribution so its redistribution notices can be included.");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
try {
const contents = join(app, "Contents"), resources = join(contents, "Resources"), macos = join(contents, "MacOS");
mkdirSync(macos, { recursive: true }); mkdirSync(resources, { recursive: true });
writeFileSync(join(resources, "standing-orders-bundle"), "local desktop build\n");
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
cpSync(join(root, "dist"), join(resources, "dist"), { recursive: true });
mkdirSync(join(resources, "runtime"));
const bundledNode = join(resources, "runtime", "node");
cpSync(sourceNode, bundledNode);
cpSync(nodeLicense, join(resources, "runtime", "LICENSE"));
if (execFileSync(bundledNode, ["--version"], { encoding: "utf8" }).trim() !== process.version) throw new Error("The copied Node runtime failed its version check.");
// Relative to Resources, so moving the finished app does not strand its runtime.
// The original bin remains only a provider search path, never the service runtime.
writeFileSync(join(resources, "runtime.json"), JSON.stringify({ node: "runtime/node", providerBin: dirname(sourceNode) }));
writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleName</key><string>Standing Orders</string><key>CFBundleDisplayName</key><string>Standing Orders</string>
<key>CFBundleIdentifier</key><string>com.standing-orders.desktop</string><key>CFBundleExecutable</key><string>StandingOrders</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`);
execFileSync("/usr/bin/swiftc", ["-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`, "-parse-as-library", "-swift-version", "5", "-framework", "AppKit", "-framework", "WebKit", "-framework", "Security", join(root, "desktop", "StandingOrders.swift"), "-o", join(macos, "StandingOrders")], { stdio: "inherit" });
execFileSync("/usr/bin/xattr", ["-cr", app]);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", bundledNode], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
if (existsSync(destination)) renameSync(destination, previous);
try { renameSync(app, destination); published = true; }
catch (error) { if (existsSync(previous)) renameSync(previous, destination); throw error; }
console.log(`Built ${destination}\nIncludes Node ${process.version}; the background controller does not depend on the build machine's Node installation.`);
} finally {
  if (!published && existsSync(previous)) console.error(`The previous app is preserved at ${previous}.`);
  else rmSync(staging, { recursive: true, force: true });
}
