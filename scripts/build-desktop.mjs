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
// Prefer a stable installation symlink, so routine Homebrew updates keep working.
const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find(path => existsSync(path) && realpathSync(path) === realpathSync(process.execPath)) ?? process.execPath;
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
try {
const contents = join(app, "Contents"), resources = join(contents, "Resources"), macos = join(contents, "MacOS");
mkdirSync(macos, { recursive: true }); mkdirSync(resources, { recursive: true });
writeFileSync(join(resources, "standing-orders-bundle"), "local desktop build\n");
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
cpSync(join(root, "dist"), join(resources, "dist"), { recursive: true });
writeFileSync(join(resources, "runtime.json"), JSON.stringify({ node }));
writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleName</key><string>Standing Orders</string><key>CFBundleDisplayName</key><string>Standing Orders</string>
<key>CFBundleIdentifier</key><string>com.standing-orders.desktop</string><key>CFBundleExecutable</key><string>StandingOrders</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`);
execFileSync("/usr/bin/swiftc", ["-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`, "-parse-as-library", "-swift-version", "5", "-framework", "AppKit", "-framework", "WebKit", "-framework", "Security", join(root, "desktop", "StandingOrders.swift"), "-o", join(macos, "StandingOrders")], { stdio: "inherit" });
execFileSync("/usr/bin/xattr", ["-cr", app]);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
if (existsSync(destination)) renameSync(destination, previous);
try { renameSync(app, destination); published = true; }
catch (error) { if (existsSync(previous)) renameSync(previous, destination); throw error; }
console.log(`Built ${destination}\nUses the Node runtime installed at ${node}.`);
} finally {
  if (!published && existsSync(previous)) console.error(`The previous app is preserved at ${previous}.`);
  else rmSync(staging, { recursive: true, force: true });
}
