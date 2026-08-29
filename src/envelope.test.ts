import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runOperate } from "./operate.js";
import { main } from "./cli.js";
import { ENVELOPE_VERSION, CAPABILITIES, envelopeJson } from "./envelope.js";

const T0 = new Date("2026-08-13T22:00:00.000Z");
const here = dirname(fileURLToPath(import.meta.url));

describe("the machine envelope", () => {
  let dir: string;
  let db: string;
  let lines: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "standing-orders-envelope-"));
    db = join(dir, "orders.db");
    lines = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (line: string) => lines.push(line);
  const out = () => lines.join("\n");
  const parsed = () => JSON.parse(out());

  test("envelopeJson stamps the version before everything else", () => {
    const body = JSON.parse(envelopeJson({ ok: true, command: "x" }));
    expect(body.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(Object.keys(body)[0]).toBe("envelopeVersion");
  });

  // The rule that keeps the contract a contract: no command may serialize its
  // own success/failure shape. If this fails, a new emission site bypassed
  // envelopeJson and its output silently lacks the version stamp.
  test("every CLI emission routes through envelopeJson (source rule)", () => {
    for (const file of ["operate.ts", "cli.ts"]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source.includes("JSON.stringify({ ok"), `${file} hand-rolls an envelope`).toBe(false);
      expect(/write\(\s*JSON\.stringify/.test(source), `${file} writes raw JSON.stringify`).toBe(false);
    }
  });

  test("success envelopes carry version, ok, command — across subsystems", async () => {
    const cases: string[][] = [
      ["ready", "--json"],
      ["task", "list", "--json"],
      ["providers", "--json"],
      ["grants", "--json"],
      ["incident", "list", "--json"],
      ["routine", "list", "--json"],
      ["outbox", "list", "--json"],
      ["webhook", "status", "--json"],
    ];
    for (const argv of cases) {
      lines = [];
      const [command = "", ...rest] = argv;
      await runOperate(command, rest, write, { databaseFile: db, now: T0 });
      const body = JSON.parse(out());
      expect(body.envelopeVersion, argv.join(" ")).toBe(ENVELOPE_VERSION);
      expect(typeof body.ok, argv.join(" ")).toBe("boolean");
      expect(typeof body.command, argv.join(" ")).toBe("string");
      // Exactly one JSON document on the wire — nothing before, nothing after.
      expect(() => JSON.parse(out())).not.toThrow();
    }
  });

  test("failure envelopes add the stable reason token", async () => {
    await runOperate("task", ["show", "no-such-task", "--json"], write, { databaseFile: db, now: T0 });
    const body = parsed();
    expect(body.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(body.ok).toBe(false);
    expect(typeof body.reason).toBe("string");
    expect(typeof body.message).toBe("string");
  });

  test("contract states the envelope version and capabilities", async () => {
    const code = await main(["contract", "--json"], write);
    expect(code).toBe(0);
    const body = parsed();
    expect(body.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(body.command).toBe("contract");
    expect(body.capabilities).toEqual([...CAPABILITIES]);
    expect(body.capabilities).toContain("envelope/1");
    expect(body.capabilities.length).toBeLessThan(16); // bounded, per the contract
  });

  test("-o writes the same envelope to a file", async () => {
    const file = join(dir, "answer.json");
    const code = await main(["contract", "--json", "-o", file], write);
    expect(code).toBe(0);
    const fromFile = JSON.parse(await readFile(file, "utf8"));
    expect(fromFile).toEqual(parsed());
  });

  test("-o without --json is refused as usage", async () => {
    const code = await main(["contract", "-o", join(dir, "x.json")], write);
    expect(code).toBe(2);
    expect(out()).toContain("--json");
  });

  test("-o without a path is refused as usage", async () => {
    const code = await main(["contract", "--json", "-o"], write);
    expect(code).toBe(2);
  });

  /**
   * The FULL sweep (audit TG-3): every routed command answers --json with
   * exactly one envelope — successes, refusals, and usage failures alike,
   * because an agent's parser meets all three. The drift guard below reads
   * OPERATE_COMMANDS from source: a new command cannot ship without either
   * joining this table or being exempted BY NAME with its reason.
   */
  test("every routed command answers --json with exactly one envelope", async () => {
    const quickGit = async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: true });
    // One terminating --json invocation per verb. Usage and refusal paths
    // are deliberate: the contract must hold on the road an agent actually
    // hits first, not only on the happy one.
    const operateTable: Record<string, string[]> = {
      sync: ["--json"],
      // The usage road terminates without binding a port or minting anything.
      up: ["--for", "not-a-number", "--json"],
      ready: ["--json"],
      task: ["list", "--json"],
      claim: ["--json"],
      heartbeat: ["--json"],
      release: ["--json"],
      reap: ["--json"],
      enroll: ["--json"],
      grants: ["--json"],
      revoke: ["--json"],
      runner: ["list", "--json"],
      approver: ["list", "--json"],
      build: ["--json"],
      tick: ["--json"],
      cap: ["list", "--json"],
      gaps: ["--json"],
      outbox: ["list", "--json"],
      brief: ["--json"],
      decide: ["--json"],
      incident: ["list", "--json"],
      serve: ["--port", "99999999", "--json"], // invalid port: throws into the catch-all, which must envelope
      watch: ["--json"],
      daemon: ["--json"],
      bridge: ["--json"],
      publish: ["status", "--json"],
      reconcile: ["--json"],
      routine: ["list", "--json"],
      config: ["show", "--json"],
      mode: ["show", "--repo", "/nope", "--json"],
      people: ["list", "--json"],
      keys: ["status", "--json"],
      setup: ["show", "--json"],
      intake: ["show", "--json"],
      providers: ["--json"],
      template: ["list", "--json"],
      contest: ["show", "999", "--json"],
      webhook: ["status", "--json"],
    };

    // The drift guard: the routed set, read from source, must be covered.
    const cliSource = readFileSync(join(here, "cli.ts"), "utf8");
    const routed = /const OPERATE_COMMANDS = new Set\(\[([^\]]+)\]\)/.exec(cliSource)?.[1] ?? "";
    const routedVerbs = [...routed.matchAll(/"([a-z-]+)"/g)].map(one => one[1] as string);
    const missing = routedVerbs.filter(verb => operateTable[verb] === undefined);
    expect(missing, "every routed command joins the sweep or is exempted by name").toEqual([]);

    for (const [verb, argv] of Object.entries(operateTable)) {
      lines = [];
      await runOperate(verb, argv, write, { databaseFile: db, now: T0, gitRunner: quickGit });
      const wire = out();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(wire) as Record<string, unknown>;
      } catch {
        throw new Error(`${verb} --json wrote something that is not one JSON document:\n${wire.slice(0, 400)}`);
      }
      expect(body["envelopeVersion"], `${verb} lacks envelopeVersion`).toBe(ENVELOPE_VERSION);
      expect(typeof body["ok"], `${verb} lacks ok`).toBe("boolean");
      expect(typeof body["command"], `${verb} lacks command`).toBe("string");
      if (body["ok"] === false) {
        expect(typeof body["reason"], `${verb} failure lacks a stable reason`).toBe("string");
      }
    }

    // The cli-level commands hold the same contract.
    const cliTable: string[][] = [
      ["contract", "--json"],
      ["demo", "--port", "99999999", "--json"], // invalid port: the fast, non-serving path

      ["skills", "--json"],
      ["repos", "--json"],
      ["pulls", dir, "--json"],
      ["graph", dir, "--json"],
      [dir, "--json", "--local"], // the scan itself
    ];
    for (const argv of cliTable) {
      lines = [];
      await main(argv, write);
      const wire = out();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(wire) as Record<string, unknown>;
      } catch {
        throw new Error(`${argv.join(" ")} wrote something that is not one JSON document:\n${wire.slice(0, 400)}`);
      }
      expect(body["envelopeVersion"], `${argv.join(" ")} lacks envelopeVersion`).toBe(ENVELOPE_VERSION);
      expect(typeof body["ok"], `${argv.join(" ")} lacks ok`).toBe("boolean");
    }
  });
});
