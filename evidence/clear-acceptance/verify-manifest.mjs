// Confirms the committed screenshots still belong to the inspected build:
// every source hash and capture hash in manifest.json must match the tree.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("evidence/clear-acceptance/manifest.json", "utf8"));
const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const mismatches = [];
for (const [path, expected] of Object.entries(manifest.sourceHashes)) if (sha256(path) !== expected) mismatches.push(path);
for (const artifact of manifest.artifacts) if (sha256(artifact.path) !== artifact.sha256) mismatches.push(artifact.path);
if (mismatches.length > 0) {
  console.error(`manifest hashes differ: ${mismatches.join(", ")}`);
  process.exit(1);
}
console.log(`manifest hashes match: ${Object.keys(manifest.sourceHashes).length} sources, ${manifest.artifacts.length} captures`);
