import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, main } from "./cli.js";

const options = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if ("error" in parsed) throw new Error(`expected options, got: ${parsed.error}`);
  return parsed.options;
};

const error = (argv: string[]) => {
  const parsed = parseArgs(argv);
  if (!("error" in parsed)) throw new Error("expected an error");
  return parsed.error;
};

describe("parseArgs", () => {
  test("scans the working directory when given nothing", () => {
    // Scanning cwd rather than the home directory by default: a first run
    // should not read every repository a person owns without being asked.
    expect(options([]).roots).toEqual([process.cwd()]);
  });

  test("resolves positional paths against the working directory", () => {
    expect(options(["src", "/tmp"]).roots).toEqual([resolve(process.cwd(), "src"), "/tmp"]);
  });

  test("reads --depth", () => {
    expect(options(["--depth", "8"]).maxDepth).toBe(8);
  });

  test("rejects a --depth that is missing or not a number", () => {
    expect(error(["--depth"])).toContain("--depth");
    expect(error(["--depth", "deep"])).toContain("--depth");
    expect(error(["--depth", "-1"])).toContain("--depth");
  });

  test("reads --json and --all", () => {
    const parsed = options(["--json", "--all"]);

    expect(parsed.json).toBe(true);
    expect(parsed.includeHidden).toBe(true);
  });

  test("leaves the working-tree read off unless --dirty is given", () => {
    // reading a working tree is unbounded work; opting in has to be explicit
    expect(options([]).dirty).toBe(false);
    expect(options(["--dirty"]).dirty).toBe(true);
  });

  test("reads --help", () => {
    expect(options(["--help"]).help).toBe(true);
    expect(options(["-h"]).help).toBe(true);
  });

  test("names an unknown flag instead of ignoring it", () => {
    // Silently ignoring a typo'd flag is how someone concludes the tool is broken
    expect(error(["--jsonn"])).toContain("--jsonn");
  });
});

describe("main", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "nightorders-cli-"));
    await mkdir(join(base, "alpha", ".git"), { recursive: true });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("prints help and exits successfully", async () => {
    const lines: string[] = [];

    const code = await main(["--help"], line => lines.push(line));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("nightorders");
  });

  test("exits with a usage code on a bad flag", async () => {
    const lines: string[] = [];

    const code = await main(["--nope"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--nope");
  });

  test("emits a JSON envelope agents can consume", async () => {
    const lines: string[] = [];

    const code = await main(["--json", base], line => lines.push(line));

    expect(code).toBe(0);
    const payload = JSON.parse(lines.join("\n"));
    expect(payload.roots).toEqual([base]);
    expect(payload.repos).toHaveLength(1);
    expect(payload.repos[0].name).toBe("alpha");
    expect(typeof payload.scannedAt).toBe("string");
  });

  test("prints a readable report by default", async () => {
    const lines: string[] = [];

    const code = await main([base], line => lines.push(line));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("repositor");
  });
});
