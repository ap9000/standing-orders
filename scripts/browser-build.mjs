#!/usr/bin/env node
/** Build a self-contained browser client. No CDN, provider token, or runtime loader. */
import { build } from "esbuild";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "dist", "browser");

// Remove stale bundles produced by an earlier entry point or compiler config.
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { workspace: "src/browser/app.tsx" },
  outdir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  tsconfig: "tsconfig.browser.json",
  minify: true,
  sourcemap: false,
  charset: "utf8",
  legalComments: "eof",
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  banner: { js: "/*! Third-party notices: /assets/THIRD_PARTY_NOTICES.txt */" },
  logLevel: "info",
});

// Browser dependencies are bundled, so their package LICENSE files would
// otherwise be absent from the deployed dist. Include only packages actually
// present in the bundle, in a stable order without machine-specific paths.
const packageRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packageRoots.add(match[1]);
}
const notices = [await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8")];
// This release omits LICENSE from npm; its pinned upstream license is preserved
// in the root notices above. Keep the exception version-specific.
const recordedLicenses = new Set(["react-remove-scroll-bar@2.3.8"]);
for (const packageRoot of [...packageRoots].sort()) {
  const directory = resolve(root, packageRoot);
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const files = (await readdir(directory)).filter(name => /^(licen[sc]e|notice)(\.[^.]+)?$/i.test(name)).sort();
  if (files.length === 0 && !recordedLicenses.has(`${pkg.name}@${pkg.version}`)) {
    throw new Error(`Missing redistribution license for bundled dependency ${pkg.name}`);
  }
  notices.push(`\n## Bundled dependency: ${pkg.name} ${pkg.version}\n`);
  for (const file of files) notices.push(await readFile(join(directory, file), "utf8"));
}
await writeFile(join(outdir, "THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
