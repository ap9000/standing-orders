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
});
