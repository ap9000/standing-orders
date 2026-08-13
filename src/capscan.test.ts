import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "./capscan.js";

describe("scanning a repository for what it says it needs", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "standing-orders-capscan-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("env keys become env capabilities with a templated probe", async () => {
    await writeFile(
      join(repo, ".env.example"),
      "# secrets\nSUPABASE_KEY=\nexport GH_TOKEN=xxx\n\nDATABASE_URL=postgres://…\n",
    );

    const { found } = scanRepo(repo);

    expect(found).toEqual([
      { kind: "env", name: "SUPABASE_KEY", probe: 'test -n "$SUPABASE_KEY"', source: ".env.example" },
      { kind: "env", name: "GH_TOKEN", probe: 'test -n "$GH_TOKEN"', source: ".env.example" },
      { kind: "env", name: "DATABASE_URL", probe: 'test -n "$DATABASE_URL"', source: ".env.example" },
    ]);
  });

  test("a name that could carry shell out of the template is dropped, and named", async () => {
    // The file is attacker-adjacent input. Nothing that fails the validator
    // may reach a probe — not escaped, not quoted, dropped.
    await writeFile(join(repo, ".env.example"), 'GOOD_KEY=\n$(curl-evil)=x\nBAD-KEY=\n');

    const report = scanRepo(repo);

    expect(report.found.map(one => one.name)).toEqual(["GOOD_KEY"]);
    expect(report.rejected.map(one => one.name)).toEqual(["$(curl-evil)", "BAD-KEY"]);
  });

  test("mcp servers are recorded probe-less — inventing one would verify nothing", async () => {
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { supabase: {}, "claude-in-chrome": {} } }),
    );

    const { found } = scanRepo(repo);

    expect(found).toEqual([
      { kind: "mcp", name: "supabase", probe: null, source: ".mcp.json" },
      { kind: "mcp", name: "claude-in-chrome", probe: null, source: ".mcp.json" },
    ]);
  });

  test("supabase config implies the CLI, with a constant probe", async () => {
    await mkdir(join(repo, "supabase"), { recursive: true });
    await writeFile(join(repo, "supabase", "config.toml"), "project_id = \"x\"\n");

    const { found } = scanRepo(repo);

    expect(found).toEqual([
      { kind: "cli", name: "supabase", probe: "supabase projects list", source: "supabase/config.toml" },
    ]);
  });

  test("workflow secrets are ci capabilities, not local env, and the platform token is nobody's gap", async () => {
    await mkdir(join(repo, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(repo, ".github", "workflows", "deploy.yml"),
      "env:\n  KEY: ${{ secrets.FAL_KEY }}\n  T: ${{ secrets.GITHUB_TOKEN }}\n",
    );

    const { found } = scanRepo(repo);

    expect(found).toEqual([
      { kind: "ci", name: "FAL_KEY", probe: null, source: ".github/workflows/deploy.yml" },
    ]);
  });

  test("an empty repository detects nothing, quietly", () => {
    expect(scanRepo(repo)).toEqual({ found: [], rejected: [] });
  });
});
