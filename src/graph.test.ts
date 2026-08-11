import { describe, test, expect } from "vitest";
import { join } from "node:path";
import {
  detectGraphs,
  chooseBackend,
  compareVersions,
  parseVersion,
  GH_DEPS_MIN_VERSION,
  type Detection,
  type Runner,
} from "./graph.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const MISSING = { ...OK, code: 127, notFound: true };

/** A runner driven by a table of `binary arg` prefixes, so tests state intent. */
function runnerFor(replies: Record<string, Partial<typeof OK>>): Runner {
  return async (file, args) => {
    const key = `${file} ${args[0]}`;
    return { ...OK, ...(replies[key] ?? { code: 1, stderr: `no stub for ${key}` }) };
  };
}

const existsFor = (paths: readonly string[]) => (path: string) => paths.includes(path);

const REPO = "/code/thing";
const OTHER = "/code/other";

describe("parseVersion", () => {
  test("reads the version out of what a tool actually prints", () => {
    expect(parseVersion("gh version 2.67.0 (2026-01-02)")).toBe("2.67.0");
    expect(parseVersion("bd version 1.4")).toBe("1.4.0");
  });

  test("is null when nothing version-shaped is there", () => {
    // Absence of a number, not zero — a tool that answered without a version
    // must not be treated as version 0 and called too old.
    expect(parseVersion("command not found")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("orders by number and not by string", () => {
    // "2.100.0" < "2.94.0" lexically, which would gate the wrong way round.
    expect(compareVersions("2.100.0", "2.94.0")).toBeGreaterThan(0);
    expect(compareVersions("2.94.0", "2.94.0")).toBe(0);
    expect(compareVersions("2.67.0", "2.94.0")).toBeLessThan(0);
  });

  test("treats a missing segment as zero", () => {
    expect(compareVersions("3", "3.0.0")).toBe(0);
  });
});

describe("detectGraphs", () => {
  test("finds beads by its directory and counts the ready set", async () => {
    const runner = runnerFor({
      "bd version": { stdout: "bd version 1.4.0" },
      "bd ready": { stdout: JSON.stringify([{ id: "a" }, { id: "b" }, { id: "c" }]) },
      "gh --version": { stdout: "gh version 2.94.0" },
      "gh issue": { stdout: "[]" },
    });

    const [beads] = await detectGraphs([REPO], {
      runner,
      exists: existsFor([join(REPO, ".beads")]),
    });

    expect(beads?.kind).toBe("beads");
    expect(beads?.count).toEqual({ of: "ready", value: 3 });
    expect(beads?.deps).toBe("native");
    expect(beads?.dispatchable).toBe(true);
  });

  test("reports beads data with no runtime as present but not dispatchable", async () => {
    // The failure this prevents: work that exists, a machine that cannot run
    // it, and finding that out inside a dead loop at 3am instead of at 9am.
    const runner = runnerFor({
      "bd version": MISSING,
      "gh --version": { stdout: "gh version 2.94.0" },
      "gh issue": { stdout: "[]" },
    });

    const [beads] = await detectGraphs([REPO], {
      runner,
      exists: existsFor([join(REPO, ".beads")]),
    });

    expect(beads?.dispatchable).toBe(false);
    expect(beads?.count).toBeNull();
    expect(beads?.problems.join(" ")).toContain("bd is not on PATH");
  });

  test("counts beads across every repo that has it", async () => {
    const runner = runnerFor({
      "bd version": { stdout: "bd version 1.4.0" },
      "bd ready": { stdout: JSON.stringify([{ id: "a" }, { id: "b" }]) },
      "gh --version": { stdout: "gh version 2.94.0" },
      "gh issue": { stdout: "[]" },
    });

    const [beads] = await detectGraphs([REPO, OTHER], {
      runner,
      exists: existsFor([join(REPO, ".beads"), join(OTHER, ".beads")]),
    });

    expect(beads?.repos).toEqual([REPO, OTHER]);
    expect(beads?.count).toEqual({ of: "ready", value: 4 });
  });

  test("refuses to call beads dispatchable when every read failed", async () => {
    // `bd version` answering proves the binary exists, not that the ready set
    // can be read — a locked database fails every read while version keeps
    // saying yes. Unverified fails closed.
    const runner = runnerFor({
      "bd version": { stdout: "bd version 1.4.0" },
      "bd ready": { code: 1, stderr: "database is locked" },
      "gh --version": { stdout: "gh version 2.94.0" },
      "gh issue": { stdout: "[]" },
    });

    const [beads] = await detectGraphs([REPO], {
      runner,
      exists: existsFor([join(REPO, ".beads")]),
    });

    expect(beads?.runtime.state).toBe("ok");
    expect(beads?.count).toBeNull();
    expect(beads?.dispatchable).toBe(false);
  });

  test("counts an empty ready set as dispatchable", () => {
    // Nothing ready is a real answer from a working backend, and must not be
    // confused with having failed to ask.
    return detectGraphs([REPO], {
      runner: runnerFor({
        "bd version": { stdout: "bd version 1.4.0" },
        "bd ready": { stdout: "[]" },
        "gh --version": { stdout: "gh version 2.94.0" },
        "gh issue": { stdout: "[]" },
      }),
      exists: existsFor([join(REPO, ".beads")]),
    }).then(([beads]) => {
      expect(beads?.count).toEqual({ of: "ready", value: 0 });
      expect(beads?.dispatchable).toBe(true);
    });
  });

  test("keeps one unreadable repo from sinking the count", async () => {
    // Same rule as discovery: one broken repository must not end the scan.
    const runner: Runner = async (file, args, options) => {
      if (file === "bd" && args[0] === "version") return { ...OK, stdout: "bd version 1.4.0" };
      if (file === "bd" && options?.cwd === OTHER) {
        return { ...OK, code: 1, stderr: "database is locked" };
      }
      if (file === "bd") return { ...OK, stdout: JSON.stringify([{ id: "a" }]) };
      if (file === "gh" && args[0] === "--version") return { ...OK, stdout: "gh version 2.94.0" };
      return { ...OK, stdout: "[]" };
    };

    const [beads] = await detectGraphs([REPO, OTHER], {
      runner,
      exists: existsFor([join(REPO, ".beads"), join(OTHER, ".beads")]),
    });

    expect(beads?.count).toEqual({ of: "ready", value: 1 });
    expect(beads?.problems.join(" ")).toContain("database is locked");
  });

  test("marks Backlog.md dependencies unverified and refuses to dispatch it", async () => {
    // Unverified is not a soft yes. Emulating edges nobody else can see is
    // exactly the shadow data §4 forbids.
    const runner = runnerFor({
      "backlog --version": { stdout: "backlog 1.2.0" },
      "gh --version": { stdout: "gh version 2.94.0" },
      "gh issue": { stdout: "[]" },
    });

    const [backlog] = await detectGraphs([REPO], {
      runner,
      exists: existsFor([join(REPO, "backlog.md")]),
    });

    expect(backlog?.kind).toBe("backlog-md");
    expect(backlog?.deps).toBe("unverified");
    expect(backlog?.dispatchable).toBe(false);
  });

  test("counts GitHub Issues and names only the repos that have any", async () => {
    const runner: Runner = async (file, args, options) => {
      if (args[0] === "--version") return { ...OK, stdout: "gh version 2.94.0" };
      if (options?.cwd === REPO) return { ...OK, stdout: JSON.stringify([{ number: 1 }]) };
      return { ...OK, stdout: "[]" };
    };

    const [issues] = await detectGraphs([REPO, OTHER], { runner, exists: () => false });

    expect(issues?.kind).toBe("github-issues");
    expect(issues?.count).toEqual({ of: "open", value: 1 });
    expect(issues?.repos).toEqual([REPO]);
  });

  test("flags a gh too old for dependency fields without hiding the count", async () => {
    // An older gh still answers how many issues are open; what it cannot be
    // trusted with is the dependency fields scheduling would read.
    const runner = runnerFor({
      "gh --version": { stdout: "gh version 2.67.0 (2026-01-02)" },
      "gh issue": { stdout: JSON.stringify([{ number: 1 }, { number: 2 }]) },
    });

    const [issues] = await detectGraphs([REPO], { runner, exists: () => false });

    expect(issues?.runtime).toEqual({
      state: "outdated",
      version: "2.67.0",
      needs: GH_DEPS_MIN_VERSION,
    });
    expect(issues?.count).toEqual({ of: "open", value: 2 });
    // The version gate IS the dependency probe: an old gh cannot be trusted
    // with the blocked_by fields, so the edges are unconfirmed, not merely
    // inconvenient to read.
    expect(issues?.deps).toBe("unverified");
  });

  test("stays quiet about repos that simply have no GitHub remote", async () => {
    // Most machines are full of local-only work. One line per repo saying so
    // would bury the report it is printed above.
    const runner = runnerFor({
      "gh --version": { stdout: "gh version 2.94.0" },
      "gh issue": { code: 1, stderr: "no git remotes found" },
    });

    const [issues] = await detectGraphs([REPO, OTHER], { runner, exists: () => false });

    expect(issues?.problems).toEqual([]);
    expect(issues?.count).toBeNull();
  });

  test("reports an auth failure instead of reading it as an empty tracker", async () => {
    // The dangerous shape of this bug: expired credentials look exactly like
    // "this repo has no issues", and the report would then be confidently
    // wrong rather than visibly incomplete.
    const runner = runnerFor({
      "gh --version": { stdout: "gh version 2.94.0" },
      "gh issue": { code: 1, stderr: "gh auth login required" },
    });

    const [issues] = await detectGraphs([REPO], { runner, exists: () => false });

    expect(issues?.problems.join(" ")).toContain("auth login required");
    expect(issues?.count).toBeNull();
  });

  test("reports unreadable issue output rather than skipping it", async () => {
    const runner = runnerFor({
      "gh --version": { stdout: "gh version 2.94.0" },
      "gh issue": { stdout: "not json at all" },
    });

    const [issues] = await detectGraphs([REPO], { runner, exists: () => false });

    expect(issues?.problems.join(" ")).toContain("unreadable");
  });

  test("never runs a tracker command for a tracker that is not there", async () => {
    // Detection reads; it does not install or initialize. `bd init` stages
    // files and can make a commit, so nothing may reach for bd on spec.
    const called: string[] = [];
    const runner: Runner = async (file, args) => {
      called.push(`${file} ${args[0]}`);
      return { ...OK, stdout: args[0] === "--version" ? "gh version 2.94.0" : "[]" };
    };

    await detectGraphs([REPO], { runner, exists: () => false });

    expect(called.some(call => call.startsWith("bd"))).toBe(false);
    expect(called.some(call => call.startsWith("backlog"))).toBe(false);
  });
});

/** Detections are verbose; build them from a sensible default. */
function detection(over: Partial<Detection> & Pick<Detection, "kind">): Detection {
  return {
    label: over.kind,
    repos: [REPO],
    count: { of: "ready", value: 4 },
    deps: "native",
    runtime: { state: "ok", version: "1.0.0" },
    dispatchable: true,
    problems: [],
    ...over,
  };
}

describe("chooseBackend", () => {
  test("recommends the sole populated repo-local tracker", () => {
    const choice = chooseBackend([detection({ kind: "beads" })]);

    expect(choice).toMatchObject({ action: "recommend", kind: "beads", dispatchable: true });
  });

  test("lets an enrolled backend outrank what detection would have picked", () => {
    // Rung 1. An operator who already said which one must not be re-asked
    // because a second tracker turned up in some other repository.
    const choice = chooseBackend(
      [detection({ kind: "beads" }), detection({ kind: "backlog-md", dispatchable: false })],
      { enrolled: "backlog-md" },
    );

    expect(choice).toMatchObject({ action: "recommend", kind: "backlog-md" });
  });

  test("recommends a populated tracker whose runtime is missing, but not for dispatch", () => {
    // DESIGN.md §3: "A populated `backlog.md` with no working runtime is
    // displayed and recommended; it is not dispatchable." Recommending it is
    // the specified behaviour, not an oversight — the gap is the point.
    const choice = chooseBackend([
      detection({
        kind: "beads",
        count: null,
        dispatchable: false,
        runtime: { state: "missing", binary: "bd" },
      }),
    ]);

    expect(choice).toMatchObject({ action: "recommend", dispatchable: false });
    if (choice.action === "recommend") expect(choice.why).toContain("bd is not on PATH");
  });

  test("chooses nothing when two trackers are populated", () => {
    // Task count is not write authority — the biggest tracker may be the
    // abandoned one, so this stays discovery-only until a person says.
    const choice = chooseBackend([
      detection({ kind: "beads" }),
      detection({ kind: "backlog-md", deps: "unverified", dispatchable: false }),
    ]);

    expect(choice.action).toBe("ambiguous");
    if (choice.action === "ambiguous") expect(choice.kinds).toEqual(["beads", "backlog-md"]);
  });

  test("never picks GitHub Issues on its own, however many are open", () => {
    // Native edges, but a populated issue tracker is evidence people file
    // issues — not that anyone wants an agent closing them unattended.
    const choice = chooseBackend([
      detection({ kind: "github-issues", count: { of: "open", value: 112 }, dispatchable: false }),
    ]);

    expect(choice.action).toBe("built-in");
    // and it says so, rather than falling through in a silence that would read
    // as "nothing found" to someone staring at 112 open issues
    expect(choice.why).toContain("GitHub Issues");
  });

  test("falls through to the built-in store, and says it is not built yet", () => {
    const choice = chooseBackend([]);

    expect(choice.action).toBe("built-in");
    expect(choice.why).toContain("not built yet");
  });

  test("does not count an empty tracker as populated", () => {
    const choice = chooseBackend([
      detection({ kind: "beads", count: { of: "ready", value: 0 } }),
      detection({ kind: "backlog-md", deps: "unverified", dispatchable: false, count: null }),
    ]);

    expect(choice).toMatchObject({ action: "recommend", kind: "backlog-md" });
  });
});
