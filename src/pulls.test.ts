import { describe, test, expect } from "vitest";
import {
  parsePulls,
  summarizeChecks,
  classify,
  describe as describePull,
  idleDays,
  isStalled,
  readPulls,
  DEFAULT_STALE_DAYS,
  type Pull,
} from "./pulls.js";

const NOW = new Date("2026-08-10T00:00:00Z");

const pull = (overrides: Partial<Pull> = {}): Pull => ({
  number: 1,
  title: "Add a post",
  branch: "seo-draft/thing",
  url: "https://github.com/o/r/pull/1",
  isDraft: false,
  mergeable: "MERGEABLE",
  checks: "passing",
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  ...overrides,
});

const ok = (stdout: string) => async () => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  notFound: false,
});

describe("parsePulls", () => {
  test("reads the fields gh actually returns", () => {
    const parsed = parsePulls(
      JSON.stringify([
        {
          number: 22,
          title: "VA for real estate agents",
          headRefName: "seo-draft/va-for-real-estate-agents",
          url: "https://github.com/o/r/pull/22",
          isDraft: false,
          mergeable: "UNKNOWN",
          createdAt: "2026-05-29T00:00:00Z",
          updatedAt: "2026-05-29T00:00:00Z",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      ]),
    );

    expect(parsed).toEqual([
      {
        number: 22,
        title: "VA for real estate agents",
        branch: "seo-draft/va-for-real-estate-agents",
        url: "https://github.com/o/r/pull/22",
        isDraft: false,
        mergeable: "UNKNOWN",
        checks: "passing",
        createdAt: "2026-05-29T00:00:00Z",
        updatedAt: "2026-05-29T00:00:00Z",
      },
    ]);
  });

  test("returns null rather than an empty list when the payload is not an array", () => {
    // An empty list means "no open pull requests", which is a claim. Failing to
    // parse is not that claim, and collapsing the two would report a broken
    // read as a clean repository.
    expect(parsePulls("{}")).toBeNull();
    expect(parsePulls("not json")).toBeNull();
    expect(parsePulls("[]")).toEqual([]);
  });

  test("drops records with no number instead of inventing one", () => {
    expect(parsePulls(JSON.stringify([{ title: "nameless" }, { number: 3 }]))).toHaveLength(1);
  });
});

describe("summarizeChecks", () => {
  test("calls an empty rollup none, not passing", () => {
    // No CI configured has told us nothing. Treating silence as approval is how
    // a broken change gets reported as ready to merge.
    expect(summarizeChecks([])).toBe("none");
    expect(summarizeChecks(undefined)).toBe("none");
  });

  test("does not count a skipped job as a failure", () => {
    // A job whose `if` guard excluded it did exactly what it was written to do.
    const rollup = [
      { status: "COMPLETED", conclusion: "SKIPPED" },
      { status: "COMPLETED", conclusion: "SUCCESS" },
    ];

    expect(summarizeChecks(rollup)).toBe("passing");
  });

  test("lets a failure outrank a check still running", () => {
    const rollup = [
      { status: "IN_PROGRESS", conclusion: "" },
      { status: "COMPLETED", conclusion: "FAILURE" },
    ];

    expect(summarizeChecks(rollup)).toBe("failing");
  });

  test("reads status contexts, which use `state` instead", () => {
    expect(summarizeChecks([{ state: "PENDING" }])).toBe("running");
    expect(summarizeChecks([{ state: "ERROR" }])).toBe("failing");
    expect(summarizeChecks([{ state: "SUCCESS" }])).toBe("passing");
  });
});

describe("classify", () => {
  test("says a green open pull request is waiting on a person", () => {
    // The case this module exists for: nothing is wrong with it, and that is
    // exactly why nobody notices it.
    expect(classify(pull())).toBe("human");
  });

  test("treats an uncomputed mergeability as unknown, not as a conflict", () => {
    // GitHub computes mergeability lazily. UNKNOWN is absence of a verdict.
    expect(classify(pull({ mergeable: "UNKNOWN" }))).toBe("human");
    expect(classify(pull({ mergeable: "CONFLICTING" }))).toBe("agent");
  });

  test("sends failures and revisions back to the agent", () => {
    expect(classify(pull({ checks: "failing" }))).toBe("agent");
    expect(classify(pull({ title: "Add a post [NEEDS REVISION]" }))).toBe("agent");
  });

  test("blocks nobody on a draft", () => {
    expect(classify(pull({ isDraft: true }))).toBe("none");
  });

  test("waits on the machine while checks run", () => {
    expect(classify(pull({ checks: "running" }))).toBe("machine");
  });

  test("matches a revision marker regardless of case", () => {
    expect(classify(pull({ title: "post [needs revision]" }))).toBe("agent");
  });

  test("honours markers a caller supplies instead of the default", () => {
    expect(classify(pull({ title: "post [CHANGES]" }), ["[CHANGES]"])).toBe("agent");
    expect(classify(pull({ title: "post [NEEDS REVISION]" }), ["[CHANGES]"])).toBe("human");
  });
});

describe("describe", () => {
  test("names the reason in the words the operator would use", () => {
    expect(describePull(pull())).toBe("ready to merge");
    expect(describePull(pull({ checks: "none" }))).toBe("ready, no checks configured");
    expect(describePull(pull({ checks: "failing" }))).toBe("checks failing");
    expect(describePull(pull({ isDraft: true }))).toBe("still a draft");
  });
});

describe("idleDays and isStalled", () => {
  test("measures from the last activity, not from opening", () => {
    // A two-month-old pull request being actively discussed is not stalled.
    const busy = pull({ createdAt: "2026-05-29T00:00:00Z", updatedAt: "2026-08-09T00:00:00Z" });

    expect(idleDays(busy, NOW)).toBeCloseTo(1);
    expect(isStalled(busy, NOW)).toBe(false);
  });

  test("catches the green pull request nobody looked at", () => {
    const forgotten = pull({ number: 22, updatedAt: "2026-05-29T00:00:00Z" });

    expect(idleDays(forgotten, NOW)).toBeGreaterThan(70);
    expect(isStalled(forgotten, NOW)).toBe(true);
  });

  test("never calls a draft or a running build stalled", () => {
    // Neither is waiting on anyone, however long it has been.
    const old = { updatedAt: "2026-01-01T00:00:00Z" };

    expect(isStalled(pull({ ...old, isDraft: true }), NOW)).toBe(false);
    expect(isStalled(pull({ ...old, checks: "running" }), NOW)).toBe(false);
  });

  test("treats an unreadable timestamp as unknown rather than stale", () => {
    expect(idleDays(pull({ updatedAt: "" }), NOW)).toBeNull();
    expect(isStalled(pull({ updatedAt: "" }), NOW)).toBe(false);
  });

  test("uses the threshold it was given", () => {
    const yesterday = pull({ updatedAt: "2026-08-09T00:00:00Z" });

    expect(isStalled(yesterday, NOW, DEFAULT_STALE_DAYS)).toBe(false);
    expect(isStalled(yesterday, NOW, 1)).toBe(true);
  });
});

describe("readPulls", () => {
  test("names a missing gh instead of reporting no pull requests", async () => {
    const result = await readPulls("/repo", {
      runner: async () => ({ code: 127, stdout: "", stderr: "", timedOut: false, notFound: true }),
    });

    expect(result.pulls).toEqual([]);
    expect(result.problems[0]).toContain("gh is not installed");
  });

  test("carries gh's own complaint through rather than swallowing it", async () => {
    const result = await readPulls("/repo", {
      runner: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: not authenticated\nrun gh auth login",
        timedOut: false,
        notFound: false,
      }),
    });

    expect(result.problems[0]).toContain("not authenticated");
  });

  test("reads open pull requests only, in the repository it was given", async () => {
    const calls: { args: readonly string[]; cwd: string | undefined }[] = [];

    await readPulls("/repo", {
      runner: async (_file, args, options) => {
        calls.push({ args, cwd: options?.cwd });
        return { code: 0, stdout: "[]", stderr: "", timedOut: false, notFound: false };
      },
    });

    expect(calls[0]?.cwd).toBe("/repo");
    expect(calls[0]?.args).toContain("--state");
    expect(calls[0]?.args).toContain("open");
  });

  test("reports unreadable output as a problem, not as an empty backlog", async () => {
    const result = await readPulls("/repo", { runner: ok("<html>rate limited</html>") });

    expect(result.pulls).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });

  test("comes back clean when there is genuinely nothing open", async () => {
    const result = await readPulls("/repo", { runner: ok("[]") });

    expect(result).toEqual({ pulls: [], problems: [] });
  });
});
