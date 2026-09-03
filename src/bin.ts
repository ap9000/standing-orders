#!/usr/bin/env node
/**
 * The package bin (install review). Nothing here touches the store: this
 * file exists so the runtime is checked BEFORE `node:sqlite` is imported,
 * and the answer to "why did it die" is one sentence instead of a resolver
 * stack. Bun's runtime has no node:sqlite; `bunx standing-orders …`
 * (without --bun) hands the shebang to Node and works.
 */
const versions = process.versions as { bun?: string; node: string };
const [major = 0, minor = 0] = versions.node.split(".").map(Number);
if (versions.bun !== undefined) {
  process.stderr.write(
    "standing-orders runs on Node 22.13 or newer — Bun's runtime has no node:sqlite.\n" +
      "Run it with Node: `bunx standing-orders up` (no --bun) or `npx standing-orders up`.\n",
  );
  process.exit(2);
}
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`standing-orders needs Node 22.13 or newer (this is ${versions.node}) — it uses node:sqlite.\n`);
  process.exit(2);
}
const { runCliProcess } = await import("./cli.js");
await runCliProcess(process.argv.slice(2));
