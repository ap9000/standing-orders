/**
 * The declared command guide, held to the code (arc 5, findings 1-4):
 * exact root coverage, exact subcommand inventories against the action
 * lists the dispatchers consult, flag arities against the parser's
 * exported vocabularies, truthful mutation semantics, operator rows
 * detail-free, and every documented reason tied to a source literal.
 */

import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_GUIDE, SURFACE_NOTES } from "./surface.js";
import {
  TASK_ACTIONS, PUBLISH_ACTIONS, CONFIG_ACTIONS, APPROVER_ACTIONS, PEOPLE_ACTIONS, KEYS_ACTIONS,
  ROUTINE_ACTIONS, CONTEST_ACTIONS, OPERATE_VALUE_FLAGS, OPERATE_BOOLEAN_FLAGS,
} from "./operate.js";
import { OPERATE_COMMANDS, TOP_LEVEL_COMMANDS, SKILLS_ACTIONS, SKILLS_FLAGS, CONTRACT_FLAGS, main } from "./cli.js";
import { DOCUMENTED_REASONS } from "./envelope.js";

const here = dirname(fileURLToPath(import.meta.url));
const rootOf = (invocation: string): string => invocation.split(" ")[0] as string;

describe("the declared command guide, held to the code", () => {
  test("root coverage is exact: every routed verb appears, every row's root is routed", () => {
    const guideRoots = new Set(COMMAND_GUIDE.map(row => rootOf(row.invocation)));
    const topLevelRoots = new Set(TOP_LEVEL_COMMANDS.map(rootOf));
    // every operate verb is documented
    for (const verb of OPERATE_COMMANDS) {
      expect(guideRoots.has(verb), `routed verb ${verb} is missing from the guide`).toBe(true);
    }
    // every declared top-level invocation is documented verbatim
    const invocations = new Set(COMMAND_GUIDE.map(row => row.invocation));
    for (const entry of TOP_LEVEL_COMMANDS) {
      expect(invocations.has(entry), `top-level ${entry || "(no verb)"} is missing from the guide`).toBe(true);
    }
    // no row invents a root
    for (const root of guideRoots) {
      expect(OPERATE_COMMANDS.has(root) || topLevelRoots.has(root), `guide root ${root || "(no verb)"} is not routed`).toBe(true);
    }
  });

  test("subcommand inventories match the action lists the dispatchers consult", () => {
    const subs = (root: string): Set<string> =>
      new Set(COMMAND_GUIDE.filter(row => rootOf(row.invocation) === root && row.invocation.includes(" "))
        .map(row => row.invocation.split(" ")[1] as string));
    expect([...subs("task")].sort()).toEqual([...TASK_ACTIONS].sort());
    expect([...subs("publish")].sort()).toEqual([...PUBLISH_ACTIONS].sort());
    expect([...subs("config")].sort()).toEqual([...CONFIG_ACTIONS].sort());
    expect([...subs("approver")].sort()).toEqual([...APPROVER_ACTIONS].sort());
    expect([...subs("routine")].sort()).toEqual([...ROUTINE_ACTIONS].sort());
    expect([...subs("contest")].sort()).toEqual([...CONTEST_ACTIONS].sort());
    expect([...subs("people")].sort()).toEqual([...PEOPLE_ACTIONS].sort());
    expect([...subs("keys")].sort()).toEqual([...KEYS_ACTIONS].sort());
    expect([...subs("skills")].sort()).toEqual([...SKILLS_ACTIONS].sort());
  });

  test("every declared flag lives in its parser's vocabulary with the declared arity", () => {
    const topLevel = new Set(TOP_LEVEL_COMMANDS);
    // the report parser's own vocabulary (cli.ts parseArgs)
    const reportBooleans = new Set(["json", "all", "local", "hidden", "dirty"]);
    for (const row of COMMAND_GUIDE) {
      for (const flag of row.flags ?? []) {
        const root = rootOf(row.invocation);
        if (row.invocation.startsWith("skills ")) {
          const action = row.invocation.split(" ")[1] as keyof typeof SKILLS_FLAGS;
          const arity = SKILLS_FLAGS[action][flag.name as keyof (typeof SKILLS_FLAGS)[typeof action]] as string | undefined;
          expect(arity, `skills ${String(action)} does not know --${flag.name}`).toBeDefined();
          expect(arity).toBe(flag.takesValue ? "value" : "flag");
        } else if (row.invocation === "contract") {
          expect((CONTRACT_FLAGS as readonly string[]).includes(flag.name), `contract does not know --${flag.name}`).toBe(true);
          expect(flag.takesValue).toBe(false);
        } else if (OPERATE_COMMANDS.has(root)) {
          const set = flag.takesValue ? OPERATE_VALUE_FLAGS : OPERATE_BOOLEAN_FLAGS;
          expect(set.has(flag.name), `--${flag.name} (${flag.takesValue ? "value" : "boolean"}) is not in the operate vocabulary for ${row.invocation}`).toBe(true);
        } else if (topLevel.has(row.invocation)) {
          expect(reportBooleans.has(flag.name), `report flag --${flag.name} unknown for ${row.invocation || "(no verb)"}`).toBe(true);
          expect(flag.takesValue).toBe(false);
        } else {
          throw new Error(`row ${row.invocation} matched no parser`);
        }
      }
    }
  });

  test("mutation semantics are self-consistent: keyed declares --key; operator rows are detail-free", () => {
    for (const row of COMMAND_GUIDE) {
      if (row.mutation === "keyed") {
        expect((row.flags ?? []).some(flag => flag.name === "key"), `${row.invocation} is keyed but declares no --key`).toBe(true);
      }
      expect(row.agentMayInvoke).toBe(row.audience === "agent");
      if (!row.agentMayInvoke) {
        // a schema is not permission: no flag detail, no reason detail
        expect(row.flags, `${row.invocation} is operator-only but carries flags`).toBeUndefined();
        expect(row.notableReasons, `${row.invocation} is operator-only but carries reasons`).toBeUndefined();
      }
    }
  });

  test("notableReasons come from the documented vocabulary, and every documented token exists in source", () => {
    for (const row of COMMAND_GUIDE) {
      for (const reason of row.notableReasons ?? []) {
        expect(DOCUMENTED_REASONS.includes(reason), `${row.invocation} cites undocumented reason ${reason}`).toBe(true);
      }
    }
    // the tie to runtime: every documented token appears as a quoted
    // literal somewhere in the non-test source (excluding its own
    // declaration file) — a typo'd token cannot ship.
    const sources = readdirSync(here)
      .filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "envelope.ts" && name !== "surface.ts")
      .map(name => readFileSync(join(here, name), "utf8"))
      .join("\n");
    for (const token of DOCUMENTED_REASONS) {
      expect(sources.includes(`"${token}"`), `documented reason ${token} appears nowhere in source`).toBe(true);
    }
  });

  test("contract --commands answers one envelope carrying the notes and the guide; scan is invocation-vs-envelope split", async () => {
    let lines: string[] = [];
    const code = await main(["contract", "--commands", "--json"], line => lines.push(line));
    expect(code).toBe(0);
    const body = JSON.parse(lines.join("\n")) as {
      ok: boolean; schemaVersion: number; notes: Record<string, string>; commands: { invocation: string; envelopeCommand?: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.schemaVersion).toBe(1);
    expect(body.notes).toEqual(SURFACE_NOTES);
    expect(body.commands.length).toBe(COMMAND_GUIDE.length);
    const scan = body.commands.find(row => row.invocation === "");
    expect(scan?.envelopeCommand).toBe("scan");
    // guide bodies never ride the schema dump (finding 8)
    expect(lines.join("\n")).not.toContain("# Working as a runner");

    // exact flags: an unknown flag refuses instead of being ignored
    lines = [];
    expect(await main(["contract", "--frobnicate"], line => lines.push(line))).toBe(2);
  });

  test("the guarded dispatchers refuse an action outside their exported lists", async () => {
    // consulting the arrays is behavior: a verb outside the list is a
    // usage refusal that names the real inventory
    const { runOperate } = await import("./operate.js");
    for (const [verb, argv, expectListed] of [
      ["publish", ["frobnicate", "--json"], "rearm"],
      ["config", ["frobnicate", "--json"], "clear"],
      ["approver", ["frobnicate", "--json"], "add"],
      ["routine", ["frobnicate", "--json"], "run-now"],
      ["contest", ["frobnicate", "--json"], "exclude"],
      ["task", ["frobnicate", "--json"], "steer"],
    ] as const) {
      const lines: string[] = [];
      await runOperate(verb, argv as unknown as string[], line => lines.push(line), { databaseFile: ":memory:" });
      const body = JSON.parse(lines.join("\n")) as { ok: boolean; reason: string; message: string };
      expect(body.ok, verb).toBe(false);
      expect(body.reason, verb).toBe("usage");
      expect(body.message, verb).toContain(expectListed);
    }
  });
});
