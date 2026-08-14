import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal, fileRoutineProposal, validateTaskText } from "./proposal.js";
import { termsOf, routineDigestOf } from "./routine.js";

const T0 = new Date("2026-08-14T12:00:00.000Z");

describe("the one filing door", () => {
  let store: Store;
  let repo: string;

  beforeEach(() => {
    store = openStore(":memory:");
    repo = realpathSync(mkdtempSync(join(tmpdir(), "proposal-repo-")));
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  test("files an unapproved task with provenance stamped", () => {
    const made = fileTaskProposal(
      store,
      { title: "tighten the payout guard", repo, goal: "add the missing bounds check", filedVia: "console" },
      T0,
    );
    if (!made.ok) throw new Error(made.reason);
    const scope = store.getScope(made.id);
    expect(scope?.approvedAt).toBeNull();
    expect(scope?.approvedBy).toBeNull();
    expect(scope?.approvedDigest).toBeNull();
    expect(store.filedViaOf(made.id)).toBe("console");
  });

  test("provenance is set-once — a stamped row never changes", () => {
    const made = fileTaskProposal(store, { title: "one", filedVia: "intake" }, T0);
    if (!made.ok) throw new Error(made.reason);
    const ref = store.lookupRef(made.id);
    if (ref === null) throw new Error("no ref");
    store.stampFiledVia(ref.id, "cli");
    expect(store.filedViaOf(made.id)).toBe("intake");
  });

  test("disguised text in a title is refused, not laundered", () => {
    const bidi = fileTaskProposal(store, { title: "fix ‮gnihtemos", filedVia: "cli" }, T0);
    expect(bidi).toMatchObject({ ok: false, reason: "bad-title" });
    const invisible = fileTaskProposal(store, { title: "fix‎ it", filedVia: "cli" }, T0);
    expect(invisible).toMatchObject({ ok: false, reason: "bad-title" });
  });

  test("provenance tokens are audit text, not free text", () => {
    expect(fileTaskProposal(store, { title: "x", filedVia: "Console!" }, T0)).toMatchObject({
      ok: false,
      reason: "bad-provenance",
    });
  });

  test("a ceiling refuses repos outside it — and an EMPTY ceiling refuses every repo", () => {
    const outside = fileTaskProposal(
      store,
      { title: "x", repo, filedVia: "console", admittedRepos: ["/somewhere/else"] },
      T0,
    );
    expect(outside).toMatchObject({ ok: false, reason: "outside-ceiling" });
    const empty = fileTaskProposal(store, { title: "x", repo, filedVia: "console", admittedRepos: [] }, T0);
    expect(empty).toMatchObject({ ok: false, reason: "outside-ceiling" });
    // No ceiling at all (the CLI) admits it.
    const cli = fileTaskProposal(store, { title: "x", repo, filedVia: "cli" }, T0);
    expect(cli).toMatchObject({ ok: true });
  });

  test("a repo that does not exist still normalizes — filing never depends on this machine seeing it", () => {
    const made = fileTaskProposal(store, { title: "x", repo: join(repo, "not-yet-cloned"), filedVia: "cli" }, T0);
    expect(made).toMatchObject({ ok: true });
  });

  test("touches obey the same bounds everywhere", () => {
    expect(
      fileTaskProposal(store, { title: "x", touches: ["ok", ""], filedVia: "cli" }, T0),
    ).toMatchObject({ ok: false, reason: "bad-goal" });
    expect(validateTaskText({ title: "x", touches: Array.from({ length: 51 }, (_, i) => `p${i}`) })).not.toBeNull();
  });

  test("files an unapproved routine, digest computed inside the door", () => {
    const made = fileRoutineProposal(
      store,
      {
        name: "nightly-deps",
        repo,
        goal: "refresh the lockfile and note anything major",
        outOfScope: null,
        touches: [],
        requirements: [],
        schedule: "daily:03:30",
        costCeilingUsd: null,
        filedVia: "template:nightly-deps",
      },
      T0,
    );
    if (!made.ok) throw new Error(made.reason);
    const routine = store.getRoutine(made.id);
    if (routine === null) throw new Error("no routine");
    expect(routine.approvedAt).toBeNull();
    expect(routine.filedVia).toBe("template:nightly-deps");
    // The digest the door computed is exactly the digest of the stored terms.
    expect(routine.digest).toBe(routineDigestOf(termsOf(routine)));
  });

  test("a routine's schedule and name are validated in the door", () => {
    const base = {
      repo,
      goal: "g",
      outOfScope: null,
      touches: [],
      requirements: [],
      costCeilingUsd: null,
      filedVia: "cli",
    };
    expect(
      fileRoutineProposal(store, { ...base, name: "Bad Name", schedule: "daily:03:30" }, T0),
    ).toMatchObject({ ok: false, reason: "bad-name" });
    expect(
      fileRoutineProposal(store, { ...base, name: "ok-name", schedule: "sometimes" }, T0),
    ).toMatchObject({ ok: false, reason: "bad-terms" });
  });

  test("a routine outside the caller's ceiling is refused", () => {
    expect(
      fileRoutineProposal(
        store,
        {
          name: "sneaky",
          repo,
          goal: "g",
          outOfScope: null,
          touches: [],
          requirements: [],
          schedule: "every:60",
          costCeilingUsd: null,
          filedVia: "console",
          admittedRepos: [],
        },
        T0,
      ),
    ).toMatchObject({ ok: false, reason: "outside-ceiling" });
  });
});

describe("installation facts", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("set-once: the first write wins forever", () => {
    expect(store.installationFact("demo")).toBeNull();
    expect(store.isDemo()).toBe(false);
    store.recordInstallationFact("demo", "1", T0);
    expect(store.isDemo()).toBe(true);
    store.recordInstallationFact("demo", "0", new Date("2027-01-01T00:00:00.000Z"));
    expect(store.installationFact("demo")).toBe("1");
  });
});
