import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { runOperate, EXIT } from "./operate.js";
import { TEMPLATES, templateByName } from "./templates.js";
import { validateTaskText } from "./proposal.js";
import { validateRoutineTerms } from "./routine.js";
import { hasDisguisedText } from "./decision.js";

const T0 = new Date("2026-08-14T12:00:00.000Z");

describe("the template library is honest data", () => {
  test("every applyable template passes the same validators as manual input", () => {
    for (const one of TEMPLATES) {
      if (one.kind === "task") {
        expect(
          validateTaskText({ title: one.title, goal: one.goal, outOfScope: one.outOfScope, touches: one.touches }),
          one.name,
        ).toBeNull();
      } else if (one.kind === "routine") {
        expect(
          validateRoutineTerms({
            repo: "/anywhere",
            goal: one.goal,
            outOfScope: one.outOfScope,
            touches: one.touches,
            requirements: one.requirements,
            schedule: one.schedule,
            singleFlight: true,
            costCeilingUsd: one.costCeilingUsd,
          }),
          one.name,
        ).toEqual([]);
      } else {
        // Recipes carry only display text — still honest text.
        for (const step of one.steps) {
          expect(hasDisguisedText(step.say + step.run), one.name).toBe(false);
        }
      }
    }
  });

  test("names are unique and lowercase", () => {
    const names = TEMPLATES.map(one => one.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("template — preview by default, --file files unapproved", () => {
  let store: Store;
  let db: string;
  let dir: string;
  let repo: string;
  let lines: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "template-test-"));
    db = join(dir, "orders.db");
    repo = realpathSync(mkdtempSync(join(tmpdir(), "template-repo-")));
    lines = [];
    store = openStore(db);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const write = (line: string) => lines.push(line);
  const run = (argv: string[]) =>
    runOperate(argv[0] as string, argv.slice(1), write, { databaseFile: db, now: T0 });
  const payload = () => JSON.parse(lines.join("\n"));

  test("list and show answer with envelopes", async () => {
    expect(await run(["template", "list", "--json"])).toBe(EXIT.ok);
    expect(payload().templates.length).toBeGreaterThanOrEqual(6);
    lines = [];
    expect(await run(["template", "show", "nightly-deps", "--json"])).toBe(EXIT.ok);
    expect(payload().template.kind).toBe("routine");
  });

  test("apply previews by default: exit 3, reason unconfirmed, nothing filed", async () => {
    const code = await run(["template", "apply", "nightly-deps", "--repo", repo, "--json"]);
    expect(code).toBe(3);
    expect(payload()).toMatchObject({ ok: false, reason: "unconfirmed" });
    expect(store.listRoutines(null)).toHaveLength(0);
  });

  test("apply --file files an UNAPPROVED routine with template provenance", async () => {
    const code = await run(["template", "apply", "nightly-deps", "--repo", repo, "--file", "--json"]);
    expect(code).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ ok: true, filed: "routine", approved: false });
    const routine = store.routineByName("nightly-deps");
    expect(routine?.approvedAt).toBeNull();
    expect(routine?.filedVia).toBe("template:nightly-deps");
    // Overrides won: the default schedule came from the template.
    expect(routine?.schedule).toBe("daily:03:30");
  });

  test("apply --file with overrides files the edited draft, not the template", async () => {
    const code = await run([
      "template", "apply", "lint-sweep", "--repo", repo,
      "--title", "Sweep the admin package only",
      "--touches", "packages/admin",
      "--file", "--json",
    ]);
    expect(code).toBe(EXIT.ok);
    const id = payload().id as string;
    expect(store.getTask(id)?.title).toBe("Sweep the admin package only");
    expect(store.getScope(id)?.approvedAt).toBeNull();
    expect(store.getScope(id)?.touches).toEqual(["packages/admin"]);
    expect(store.filedViaOf(id)).toBe("template:lint-sweep");
  });

  test("a recipe cannot be applied — the refusal names the missing authority", async () => {
    const code = await run(["template", "apply", "issue-intake", "--repo", repo, "--file", "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(payload()).toMatchObject({ ok: false, reason: "recipe" });
    expect(store.listTasks()).toHaveLength(0);
  });

  test("apply without --repo is refused — a template never guesses where work lands", async () => {
    const code = await run(["template", "apply", "nightly-deps", "--file", "--json"]);
    expect(code).toBe(EXIT.usage);
    expect(payload().reason).toBe("usage");
  });

  test("unknown template refuses with the stable token", async () => {
    const code = await run(["template", "show", "no-such", "--json"]);
    expect(code).toBe(EXIT.refused);
    expect(payload().reason).toBe("unknown");
  });

  test("the recipes really are in the library", () => {
    expect(templateByName("issue-intake")?.kind).toBe("recipe");
    expect(templateByName("ci-babysitter")?.kind).toBe("recipe");
  });
});
