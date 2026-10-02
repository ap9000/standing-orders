/**
 * Fixtures shared by the tick suites (src/tick.*.test.ts): runner enrollment,
 * the agent's half of the terminal handoff and a typed proof manifest.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openStore } from "../src/store.js";
import { register } from "../src/runner.js";

export { presented } from "./route-fixture.js";

export const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
export const T0 = new Date("2026-08-11T22:00:00.000Z");
export const AGENT_SAID = JSON.stringify({ result: "Added the guard and a test for it." });

/**
 * The runner gate (MCP spec v6): every claim now authenticates the runner
 * and requires the task's PLACED repo to be in the runner's registered
 * `repos`. The CLI's `runner register` binds no repos yet, so these tests
 * enroll their runners through the store, bound to the repo their tasks
 * are placed in (`task add --repo`), and use the minted token everywhere
 * the CLI takes one.
 */
export const registerRunner = (db: string, name: string, repo: string, now: Date = T0): string => {
  const store = openStore(db);
  try {
    return register(store, { name, host: "test", capacity: 9, repos: [repo], now }).token;
  } finally {
    store.close();
  }
};

/** The agent's half of the terminal handoff protocol. */
export const concludeDone = async (
  cwd: string,
  args: readonly string[],
  status: "completed" | "no-change" | "failed" = "completed",
  conclusion = "Added the guard and a test for it.",
): Promise<void> => {
  const prompt = args[args.indexOf("-p") + 1] ?? "";
  const name = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
  // An empty cwd would write into the checkout running the tests.
  if (name !== undefined && cwd !== "") {
    await writeFile(join(cwd, name), JSON.stringify({ version: 1, status, conclusion }));
  }
};

/** A real typed proof manifest for the recovery certification path. The
 * nonce comes only from the builder brief, exactly as a provider sees it. */
export const proveChangedPath = async (
  cwd: string,
  args: readonly string[],
  statement: string,
  path: string,
): Promise<void> => {
  const prompt = args[args.indexOf("-p") + 1] ?? "";
  const name = /STANDING-ORDERS-PROOF-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
  if (name === undefined || cwd === "") return;
  await writeFile(join(cwd, name), JSON.stringify({
    version: 1,
    criteria: [{
      id: "c1",
      statement,
      verdict: "met",
      how: `confirmed ${path} in the completed diff`,
      evidence: [{ kind: "changed-path", ref: path }],
    }],
    checks: [],
    changed: [path],
    caveats: [],
    screenshots: [],
  }));
};
