import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, main, isDirectInvocation, partitionRoots } from "./cli.js";

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
    // Compared against resolve() rather than the literals, because an absolute
    // POSIX path is not absolute on Windows: "/tmp" resolves onto the current
    // drive. What is being asserted is that paths are resolved, not how.
    const absolute = resolve(tmpdir());

    expect(options(["src", absolute]).roots).toEqual([resolve(process.cwd(), "src"), absolute]);
  });

  test("reads --depth", () => {
    expect(options(["--depth", "8"]).maxDepth).toBe(8);
  });

  test("rejects a --depth that is missing or not a number", () => {
    expect(error(["--depth"])).toContain("--depth");
    expect(error(["--depth", "deep"])).toContain("--depth");
    expect(error(["--depth", "-1"])).toContain("--depth");
  });

  test("reads --json and --hidden", () => {
    const parsed = options(["--json", "--hidden"]);

    expect(parsed.json).toBe(true);
    expect(parsed.includeHidden).toBe(true);
  });

  test("keeps --all and --hidden as different questions", () => {
    // --hidden is about where to look; --all is about whether the connected
    // list applies. Conflating them would make one of them unreachable.
    const parsed = options(["--all"]);

    expect(parsed.all).toBe(true);
    expect(parsed.includeHidden).toBe(false);
  });

  test("records whether paths were given, not just what they defaulted to", () => {
    // The connected list applies only when the operator named no paths.
    expect(options([]).rootsGiven).toBe(false);
    expect(options(["/tmp"]).rootsGiven).toBe(true);
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

describe("missing paths", () => {
  test("splits roots into those that exist and those that do not", () => {
    const { present, missing } = partitionRoots(["/here", "/gone"], path => path === "/here");

    expect(present).toEqual(["/here"]);
    expect(missing).toEqual(["/gone"]);
  });

  test("calls a typo a typo instead of reporting an empty search", async () => {
    const lines: string[] = [];

    const code = await main(["/Users/nobody/Documentd"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("does not exist");
    expect(lines.join("\n")).not.toContain("No git repositories found");
  });

  test("keeps JSON parseable when a path is missing", async () => {
    // A warning printed above the envelope would break every consumer of it
    const lines: string[] = [];
    const absent = join(tmpdir(), "nightorders-nobody", "Documentd");

    const code = await main(["--json", absent], line => lines.push(line));

    expect(code).toBe(2);
    const payload = JSON.parse(lines.join("\n"));
    expect(payload.missingRoots).toEqual([resolve(absent)]);
    expect(payload.repos).toEqual([]);
  });
});

describe("isDirectInvocation", () => {
  const MODULE = pathToFileURL("/pkg/dist/cli.js").href;

  test("recognises the module when invoked through a symlink on PATH", () => {
    // The failure this guards is silent: the command runs, prints nothing,
    // and exits 0, because argv[1] is the link and the module is the target.
    const resolved = isDirectInvocation(MODULE, "/home/me/.local/bin/nightorders", () =>
      "/pkg/dist/cli.js",
    );

    expect(resolved).toBe(true);
  });

  test("recognises a direct path invocation", () => {
    expect(isDirectInvocation(MODULE, "/pkg/dist/cli.js", path => path)).toBe(true);
  });

  test("stays quiet when imported by something else", () => {
    expect(isDirectInvocation(MODULE, "/usr/bin/vitest", path => path)).toBe(false);
    expect(isDirectInvocation(MODULE, undefined, path => path)).toBe(false);
  });

  test("treats an unresolvable entry as not a direct invocation", () => {
    const resolved = isDirectInvocation(MODULE, "/gone", () => {
      throw new Error("ENOENT");
    });

    expect(resolved).toBe(false);
  });
});

describe("link command", () => {
  const NEVER_CREATED = join(tmpdir(), "nightorders-never-created");

  test("changes nothing without --yes", async () => {
    // The tool refuses to install things on your behalf; that has to include
    // installing itself. Showing the plan is the whole point.
    const lines: string[] = [];

    const code = await main(["link", "--to", NEVER_CREATED], line => lines.push(line), {
      binSource: process.execPath,
    });

    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("Nothing has been written");
    expect(existsSync(NEVER_CREATED)).toBe(false);
  });

  test("rejects a --to with no directory", async () => {
    const lines: string[] = [];

    const code = await main(["link", "--to"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--to");
  });

  test("says nothing to remove when the link is not there", async () => {
    // Deliberately no binSource: `unlink` has nothing to point at, so it must
    // not go looking for a build. Requiring one would strand anyone whose
    // dist/ has been cleaned since they linked.
    const lines: string[] = [];

    const code = await main(["unlink", "--to", NEVER_CREATED], line => lines.push(line));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Nothing to remove");
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

describe("graph command", () => {
  test("rejects an option it does not have", async () => {
    const lines: string[] = [];

    const code = await main(["graph", "--deep"], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("--deep");
  });

  test("says a named path does not exist rather than reporting nothing found", async () => {
    // Same rule as the main report: a typo is not an empty search.
    const lines: string[] = [];
    const absent = join(tmpdir(), "nightorders-no-such-repo");

    const code = await main(["graph", absent], line => lines.push(line));

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("does not exist");
  });

  test("emits JSON when asked, for the half of the audience that is an agent", async () => {
    const lines: string[] = [];

    const code = await main(["graph", "--json", tmpdir()], line => lines.push(line));

    expect(code).toBe(0);
    expect(() => JSON.parse(lines.join("\n"))).not.toThrow();
  });
});
