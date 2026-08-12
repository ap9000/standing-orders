/**
 * Reading what a repository says it needs.
 *
 * Detection walks files the repo itself controls — .env.example, .mcp.json,
 * supabase/config.toml, workflow files — which makes every byte here
 * untrusted input. The rule that keeps that safe: **scanned content never
 * becomes shell code.** A probe is either a fixed template over an
 * identifier that passed a strict validator, or it is absent. A name that
 * fails validation is dropped with a note, not quoted, not escaped, not
 * given the benefit of the doubt — escaping is how injection bugs are
 * born promising to behave.
 *
 * Detection is not authorization, and it is not verification either: every
 * capability found here lands `unprobed`. CI secret references are recorded
 * as `ci` capabilities with no probe — a secret living in GitHub's vault is
 * a fact about CI, not about this machine's environment, and synthesizing
 * a local env probe for it would manufacture a gap that is not real.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Capability } from "./store.js";

/** A capability as detected, before anybody decides to record it. */
export type Found = {
  kind: Capability["kind"];
  name: string;
  probe: string | null;
  source: string;
};

export type ScanReport = {
  found: Found[];
  /** Names that appeared but failed validation — reported, never used. */
  rejected: { name: string; source: string }[];
};

/** Environment variable names, and nothing that only resembles one. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** MCP server labels: package-ish names, no shell metacharacters possible. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Reading a whole minified bundle to find nothing is not detection. */
const MAX_BYTES = 256 * 1024;

export function scanRepo(repo: string): ScanReport {
  const found: Found[] = [];
  const rejected: ScanReport["rejected"] = [];
  const seen = new Set<string>();

  const keep = (one: Found) => {
    const key = `${one.kind}:${one.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(one);
  };

  // .env.example — each key is an env capability, probe from a fixed
  // template. The identifier validator is what makes the template safe.
  const envExample = readSmall(join(repo, ".env.example"));
  if (envExample !== null) {
    for (const line of envExample.split("\n")) {
      const match = /^\s*(?:export\s+)?([^#\s=]+)=/.exec(line);
      if (match === null) continue;
      const name = match[1] as string;
      if (!IDENTIFIER.test(name)) {
        rejected.push({ name, source: ".env.example" });
        continue;
      }
      keep({ kind: "env", name, probe: `test -n "$${name}"`, source: ".env.example" });
    }
  }

  // .mcp.json — server names, probe-less: whether a server answers is a
  // question `mcp initialize` will earn a probe for later; inventing one
  // now would verify nothing.
  const mcp = readSmall(join(repo, ".mcp.json"));
  if (mcp !== null) {
    try {
      const parsed = JSON.parse(mcp) as { mcpServers?: Record<string, unknown> };
      for (const name of Object.keys(parsed.mcpServers ?? {})) {
        if (!LABEL.test(name)) {
          rejected.push({ name, source: ".mcp.json" });
          continue;
        }
        keep({ kind: "mcp", name, probe: null, source: ".mcp.json" });
      }
    } catch {
      // A file that does not parse describes nothing.
    }
  }

  // supabase/config.toml — its presence means the supabase CLI is part of
  // this repo's workflow. The probe is a constant; nothing scanned enters it.
  if (existsSync(join(repo, "supabase", "config.toml"))) {
    keep({
      kind: "cli",
      name: "supabase",
      probe: "supabase projects list",
      source: "supabase/config.toml",
    });
  }

  // Workflow files — `secrets.NAME` references are ci capabilities, no
  // probe: they live in GitHub's vault, not this machine's environment.
  const workflows = join(repo, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const file of readdirSync(workflows).filter(name => /\.ya?ml$/.test(name))) {
      const text = readSmall(join(workflows, file));
      if (text === null) continue;
      for (const match of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
        const name = match[1] as string;
        if (name === "GITHUB_TOKEN") continue; // furnished by the platform, never a gap
        if (!IDENTIFIER.test(name)) {
          rejected.push({ name, source: `.github/workflows/${file}` });
          continue;
        }
        keep({ kind: "ci", name, probe: null, source: `.github/workflows/${file}` });
      }
    }
  }

  return { found, rejected };
}

function readSmall(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  } catch {
    return null;
  }
}
