#!/usr/bin/env node
// Completeness check for a historical delivery manifest such as
// docs/TELEGRAM_DELIVERY_CANDIDATE_2026-09-15.json. The manifest names a
// base commit, the delivered source commit, every src/ path that commit
// range changed with its SHA-256, and an aggregate digest. The original
// manifest was typed by hand and omitted src/claim.ts; this check reads
// the exact Git diff instead so the next omission cannot pass unnoticed:
//   - the manifest's src/ paths equal `git diff --name-only base source -- src/`
//   - each sha256 equals the hash of that path's bytes at the source commit
//   - sourceDigest equals SHA-256 of sorted `path + NUL + sha256 + LF` entries
// It reads Git objects only and never mutates the checkout. Exit 0 when the
// manifest is complete and exact; 1 with every problem listed otherwise.
//
//   node scripts/delivery-manifest-check.mjs [--manifest <json-file>]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DEFAULT_MANIFEST = "docs/TELEGRAM_DELIVERY_CANDIDATE_2026-09-15.json";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

const args = process.argv.slice(2);
const manifestPath = args.length === 0 ? DEFAULT_MANIFEST : args.length === 2 && args[0] === "--manifest" ? args[1] : null;
if (!manifestPath) {
  console.error("usage: node scripts/delivery-manifest-check.mjs [--manifest <json-file>]");
  process.exit(1);
}

// src/store.ts alone is over 1 MiB; the default 1 MiB buffer would report it missing.
const gitBytes = (...argv) => execFileSync("git", argv, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const short = (commit) => commit.slice(0, 7);
const problems = [];

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { baseHead, sourceHead, files, sourceDigest } = manifest;
if (!COMMIT_HEX.test(baseHead ?? "")) problems.push(`baseHead is not a full commit id: ${JSON.stringify(baseHead)}`);
if (!COMMIT_HEX.test(sourceHead ?? "")) problems.push(`sourceHead is not a full commit id: ${JSON.stringify(sourceHead)}`);
if (!Array.isArray(files) || files.length === 0) problems.push("files must be a non-empty array");
if (problems.length > 0) fail();

// 1. Every src/ path the exact Git diff touched, and nothing else.
const range = `${short(baseHead)}..${short(sourceHead)}`;
const changed = gitBytes("diff", "--name-only", "-z", baseHead, sourceHead, "--", "src/").toString("utf8").split("\u0000").filter(Boolean).sort();
const listed = files.map((f) => f.path);
const listedSet = new Set(listed);
if (listedSet.size !== listed.length) problems.push("files lists a path more than once");
for (const p of changed) if (!listedSet.has(p)) problems.push(`omitted from manifest: ${p} changed in ${range}`);
for (const p of listed) if (!changed.includes(p)) problems.push(`listed but not changed in ${range}: ${p}`);

// 2. Each hash is the SHA-256 of the file's bytes at the source commit.
for (const { path, sha256: declared } of files) {
  if (!SHA256_HEX.test(declared ?? "")) {
    problems.push(`${path}: sha256 is not 64 hex characters`);
    continue;
  }
  let actual;
  try {
    actual = sha256(gitBytes("show", `${sourceHead}:${path}`));
  } catch {
    problems.push(`${path}: not present at ${short(sourceHead)}`);
    continue;
  }
  if (actual !== declared) problems.push(`${path}: sha256 ${declared} but ${short(sourceHead)} bytes hash to ${actual}`);
}

// 3. The aggregate digest is exactly the declared algorithm over the entries.
const entries = [...files]
  .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  .map((f) => `${f.path}\u0000${f.sha256}\n`)
  .join("");
const aggregate = sha256(entries);
if (aggregate !== sourceDigest) problems.push(`sourceDigest ${sourceDigest} but sorted path+NUL+sha256+LF entries hash to ${aggregate}`);

if (problems.length > 0) fail();
console.log(`delivery-manifest-check: ${manifestPath} lists all ${changed.length} src/ paths changed in ${range}; every sha256 matches ${short(sourceHead)} bytes and sourceDigest recomputes`);

function fail() {
  console.error(`delivery-manifest-check: ${problems.length} problem(s) in ${manifestPath}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
