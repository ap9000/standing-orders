/**
 * The fallback chain, END TO END through the real tick (E3d): a chain-
 * approved task's base entry exhausts its subscription, the cycle advances,
 * and THE SAME PASS admits the approved gemini fallback — which builds,
 * closes the cycle, and finishes the task. Only the agent processes and the
 * exhaustion RECOGNITION are stubbed: production ships no recognizer (fail
 * closed), so this file mocks the exhaustion module the way a fixtured
 * build would behave — everything else is the actual machinery: the store
 * on disk, claims, worktrees on real git, the chain-entry dispatch proof,
 * the fenced cycle walk, and the admission pass.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { writeFileSync, chmodSync, mkdirSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { resetAttestationCache } from "./attest.js";
import { runOperate } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore } from "./store.js";
import { register } from "./runner.js";
import { presetTerms, modeTermsJson, modeDigestOf, type ModeTerms } from "./modes.js";
import type { Runner } from "./builder.js";

// A "fixtured build," simulated at the module boundary (the production
// module ships NO mutation surface — review finding 1): the marker below
// classifies as a subscription exhaustion, and claude/subscription is
// recognized. Everything else stays the real, fail-closed implementation.
const MARKER = "USAGE_LIMIT_E2E";
vi.mock("./exhaustion.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./exhaustion.js")>();
  return {
    ...actual,
    classifyTerminal: (args: Parameters<typeof actual.classifyTerminal>[0]) =>
      args.terminal?.failed === true && args.terminal.text?.includes("USAGE_LIMIT_E2E") === true && args.authMode === "subscription"
        ? ("usage-exhausted" as const)
        : actual.classifyTerminal(args),
    recognizesEligible: (provider: string, _version: string | null, authMode: string) =>
      provider === "claude" && authMode === "subscription",
  };
});

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-11T22:00:00.000Z");

describe("the fallback chain end-to-end (E3d)", () => {
  let base: string;
  let repo: string;
  let db: string;
  let pool: string;
  let lines: string[] = [];
  let providersRan: string[] = [];

  const git = (args: string[], cwd = repo) => exec("git", args, { cwd });

  const concludeDone = async (cwd: string, args: readonly string[]): Promise<void> => {
    const prompt = args[args.indexOf("-p") + 1] ?? "";
    const name = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(prompt)?.[0];
    if (name !== undefined && cwd !== "") {
      await writeFile(join(cwd, name), JSON.stringify({ version: 1, status: "completed", conclusion: "guarded" }));
    }
  };

  /** ONE polyglot stub: the claude dialect answers EXHAUSTED; the gemini
   * dialect (spotted by --approval-mode) does real work and succeeds. */
  const polyglot: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    if (args.includes("--approval-mode")) {
      providersRan.push("gemini");
      const minted = args[args.indexOf("--session-id") + 1] ?? "never-minted";
      await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
      await concludeDone(cwd, args);
      return {
        ...OK,
        stdout: [
          JSON.stringify({ type: "init", session_id: minted, model: "gemini-2.5-pro" }),
          JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 120, output_tokens: 30 } }),
        ].join("\n"),
      };
    }
    providersRan.push("claude");
    // The harness came up, then the subscription cap ended the turn: an
    // error result whose text a fixtured build recognizes.
    return {
      ...OK,
      code: 1,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s-exhausted" }),
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: `${MARKER}: You've hit your usage limit. Try again later.`,
          session_id: "s-exhausted",
        }),
      ].join("\n"),
    };
  };

  const run = (argv: string[], runner: Runner = polyglot) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now: T0, agentRunner: runner });
  };
  const payload = () => JSON.parse(lines.join("\n"));

  beforeEach(async () => {
    // realpath: the runner gate compares the task's PLACED repo against the
    // runner's CANONICALIZED registered repos — macOS tmpdir symlinks
    // (/var/folders → /private/var) must not split the two identities.
    base = realpathSync(await mkdtemp(join(tmpdir(), "standing-orders-fb-")));
    repo = join(base, "repo");
    db = join(base, "queue.db");
    pool = join(base, "pool");
    providersRan = [];
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "first"]);
    // The attested fallback lane: a fake gemini on PATH at a fixtured version.
    const bin = join(base, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gemini"), '#!/bin/sh\necho "0.57.0"\n');
    chmodSync(join(bin, "gemini"), 0o755);
    process.env["PATH"] = `${bin}${delimiter}${process.env["PATH"] ?? ""}`;
    // The pinned api-key entry REFUSES with no key at all (review finding
    // 1) — the stub never reads it, but the gateway must see one exist.
    process.env["GEMINI_API_KEY"] = "test-key-never-read";
    resetAttestationCache();
  });

  afterEach(async () => {
    delete process.env["GEMINI_API_KEY"];
    resetAttestationCache();
    await rm(base, { recursive: true, force: true });
  });

  test("base exhausts → cycle advances → the SAME pass admits and builds the approved gemini fallback", async () => {
    // Credentials + the claude base routing.
    // CLI runner register is now a password ceremony (MCP spec v6) — the
    // fixture mints at store level below with a fixed token instead.
    const runnerToken = "tok-builder-1";
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);

    // The task exists, PLACED first (placement is immutable once scoped),
    // then the repo gains its fallback config and a mode GRANTING the paid
    // fallback — both store-level acts until Layer F ships their surfaces.
    await run(["task", "add", "the work", "--id", "t-fb"]);
    {
      const store = openStore(db);
      // The runner gate (MCP spec v6): dispatch authority is the runner's
      // REGISTERED repo list — bind this repo to the CLI-minted credential.
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      const ref = store.refFor("built-in", "t-fb").id;
      expect(store.placeTask(ref, repo)).toBe(true);
      store.setFallbackConfig(repo, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
      // reviewAuto off: this proof is about the CHAIN; an auto-review of the
      // built fallback would spend a third stubbed run and muddy the ledger.
      const terms: ModeTerms = { ...presetTerms("standard", new Date(T0.getTime() + 24 * 60 * 60_000).toISOString()), allowPaidFallback: true, reviewAuto: false };
      store.signMode(
        { repo, name: "standard", termsJson: modeTermsJson(terms), digest: modeDigestOf(terms), signedBy: "alex", absoluteExpiry: terms.absoluteExpiry, publication: terms.publication },
        T0,
      );
      store.close();
    }

    // Scope + approve: the signed digest binds the WHOLE chain.
    await run(["task", "scope", "t-fb", "--goal", "add a guard on the payout path"]);
    await run(["task", "approve", "t-fb", "--json"]);
    const digest = payload().scope.digest as string;
    await run(["task", "approve", "t-fb", "--yes", "--digest", digest, "--as", "alex", "--token", approverToken]);
    {
      const store = openStore(db);
      expect(store.getScope("t-fb")).toMatchObject({ approvalKind: "chain" });
      store.close();
    }

    // ONE tick: the base claude entry runs and exhausts; the resolver
    // advances the cycle; the chain admission pass — same pass — admits the
    // approved gemini entry, which builds.
    // The pass reports the exhausted base HONESTLY as a failure (its strike
    // is real) — so the exit code reflects a broke attempt even though the
    // fallback delivered; the outcomes and the durable state are the proof.
    await run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"]);
    const outcomes = payload().dispatched as { id: string; outcome: string; reason?: string }[];
    expect(providersRan).toEqual(["claude", "gemini"]);
    expect(outcomes.some(one => one.id === "t-fb" && one.outcome === "failed")).toBe(true); // the exhausted base, honestly
    expect(outcomes.some(one => one.id === "t-fb" && one.outcome === "built")).toBe(true); // the fallback delivered

    const store = openStore(db);
    const runs = store
      .raw()
      .prepare("SELECT provider, outcome, terminal_class, auth_mode, chain_index, entry_digest FROM run ORDER BY id")
      .all() as Record<string, unknown>[];
    // The base: claude, subscription, classified exhausted, chain index 0.
    expect(runs[0]).toMatchObject({ provider: "claude", outcome: "failed", terminal_class: "usage-exhausted", auth_mode: "subscription", chain_index: 0 });
    // The fallback: gemini under its PINNED api-key mode, chain index 1, built.
    expect(runs[1]).toMatchObject({ provider: "gemini", outcome: "built", auth_mode: "api-key", chain_index: 1 });
    expect(runs[1]?.["entry_digest"]).not.toBeNull();
    // The cycle: closed, succeeded — one exhaustion transition on the record,
    // consumed by exactly the run it admitted.
    const cycle = store.raw().prepare("SELECT state, cursor, closed_reason FROM fallback_cycle").get();
    expect(cycle).toMatchObject({ state: "closed", cursor: 1, closed_reason: "succeeded" });
    const transition = store.raw().prepare("SELECT kind, from_index, to_index, terminal_class, consumed_by FROM fallback_transition").get() as Record<string, unknown>;
    expect(transition).toMatchObject({ kind: "exhaustion", from_index: 0, to_index: 1, terminal_class: "usage-exhausted" });
    expect(Number(transition["consumed_by"])).toBeGreaterThan(0);
    // The task itself concluded through the fallback.
    store.close();
    await run(["task", "show", "t-fb", "--json"]);
    expect(payload().task.state).toBe("done");
  });

  test("WITHOUT the paid-fallback grant, the exhausted base never advances — the cycle ends clean, nothing else spends", async () => {
    // CLI runner register is now a password ceremony (MCP spec v6) — the
    // fixture mints at store level below with a fixed token instead.
    const runnerToken = "tok-builder-1";
    await run(["approver", "add", "alex", "--json"]);
    const approverToken = payload().token as string;
    await run(["config", "set", "build", "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approverToken, "--json"]);
    await run(["task", "add", "the work", "--id", "t-nogrant"]);
    {
      const store = openStore(db);
      // The runner gate (MCP spec v6): bind the repo to the registered runner.
      register(store, { name: "builder-1", host: "test", capacity: 9, repos: [repo], now: T0, newToken: () => runnerToken });
      const ref = store.refFor("built-in", "t-nogrant").id;
      expect(store.placeTask(ref, repo)).toBe(true);
      // A chain is configured and approved — but NO mode grants the spend.
      store.setFallbackConfig(repo, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
      store.close();
    }
    await run(["task", "scope", "t-nogrant", "--goal", "add a guard on the payout path"]);
    await run(["task", "approve", "t-nogrant", "--json"]);
    const digest = payload().scope.digest as string;
    await run(["task", "approve", "t-nogrant", "--yes", "--digest", digest, "--as", "alex", "--token", approverToken]);

    await run(["tick", "--runner", "builder-1", "--token", runnerToken, "--repo", repo, "--pool", pool, "--json"]);
    expect(providersRan).toEqual(["claude"]); // gemini NEVER ran
    const store = openStore(db);
    expect(store.raw().prepare("SELECT COUNT(*) AS n FROM run").get()).toMatchObject({ n: 1 });
    const cycle = store.raw().prepare("SELECT state, closed_reason FROM fallback_cycle").get();
    expect(cycle).toMatchObject({ state: "closed", closed_reason: "grant-withheld" });
    store.close();
  });
});
