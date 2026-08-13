/**
 * Evidence: what actually happened, captured by the machine (§4, §7).
 *
 * The agent does not choose what counts as evidence — a diff the agent could
 * fabricate is a screenshot of a different crime scene. At park time the
 * builder captures the working state itself, relative to the base revision
 * stamped before the agent spent anything, and records how each capture was
 * made, whether it is complete, and what it hashes to. A truncated capture
 * says truncated; a failed capture stores the failure. Presenting either as
 * the whole story is the one dishonesty this module exists to rule out.
 *
 * Files live under the evidence root — outside every worktree, so an agent
 * cannot pre-write them — created exclusively (`wx`) with mode 0600. The
 * store holds keys relative to that root, never absolute paths.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { LIMITS } from "./decision.js";
import { PLAN_LIMITS } from "./plan.js";
import type { Artifact, Store } from "./store.js";
import type { ExecResult } from "./exec.js";

/** The park mailbox pattern. Each run's actual name carries a nonce; see `mailboxName`. */
export const MAILBOX_PREFIX = "STANDING-ORDERS-PARK-";
/** The terminal handoff: how every non-parking attempt says how it ended. */
export const HANDOFF_PREFIX = "STANDING-ORDERS-DONE-";
/** The planner's terminal handoff: the proposed scope and the plan document. */
export const PLAN_PREFIX = "STANDING-ORDERS-PLAN-";
export const MAILBOX_SUFFIX = ".json";

/** Bytes each kind may store. Originals can be any size; the record says what was cut. */
export const EVIDENCE_CAPS: Record<Artifact["kind"], number> = {
  diff: 256 * 1024,
  status: 64 * 1024,
  "park-payload": LIMITS.payload,
  plan: PLAN_LIMITS.document,
  "terminal-diff": 256 * 1024,
  "diff-stat": 32 * 1024,
};

export function evidenceRoot(home: string): string {
  const renamed = join(home, ".standing-orders", "evidence");
  // Same continuity rule as the database: evidence recorded under the old
  // name keeps verifying until a new-name root exists.
  const legacy = join(home, ".nightorders", "evidence");
  if (!existsSync(renamed) && existsSync(legacy)) return legacy;
  return renamed;
}

/**
 * Unpredictable per attempt, so nothing on disk before this build can already
 * be the mailbox: a stale file, however it got there, simply has the wrong
 * name. The agent learns the name from its brief and nowhere else.
 */
export function mailboxName(): string {
  return `${MAILBOX_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

export function looksLikeMailbox(name: string): boolean {
  return name.startsWith(MAILBOX_PREFIX) && name.endsWith(MAILBOX_SUFFIX);
}

/** Every protocol file the sweep must never let an old attempt leave behind.
 * The pre-rename NIGHTORDERS- prefix stays recognized here — a worktree cut
 * down before 2026-08-13 may still hold one, and cleanup has no vintage. */
export function looksLikeProtocolFile(name: string): boolean {
  return (
    (name.startsWith(MAILBOX_PREFIX) ||
      name.startsWith(HANDOFF_PREFIX) ||
      name.startsWith(PLAN_PREFIX) ||
      name.startsWith("NIGHTORDERS-")) &&
    name.endsWith(MAILBOX_SUFFIX)
  );
}

export function handoffName(): string {
  return `${HANDOFF_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

export function planFileName(): string {
  return `${PLAN_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
}

/**
 * Read a mailbox without following anything: the path must be a regular file,
 * opened O_NOFOLLOW and measured through its own descriptor — an agent that
 * made the pathname a symlink or FIFO gets a refusal, not a runner reading an
 * unrelated local file into web-visible evidence.
 */
export function readMailbox(
  path: string,
  cap: number = LIMITS.payload,
): { ok: true; raw: Buffer } | { ok: false; problem: string; missing: boolean } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      missing: code === "ENOENT",
      problem:
        code === "ELOOP"
          ? "the mailbox is a symlink, which is not a park — it is a pointer at somebody else's file"
          : `cannot open the mailbox: ${code ?? String(error)}`,
    };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, missing: false, problem: "the mailbox is not a regular file" };
    }
    if (stat.size > cap) {
      return { ok: false, missing: false, problem: `the mailbox is over ${cap} bytes` };
    }
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return { ok: true, raw: buffer.subarray(0, offset) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Write one evidence file and record it. The row is written through the
 * store the caller passed — inside whatever transaction the caller holds.
 */
export function storeEvidence(
  store: Store,
  root: string,
  runId: number,
  kind: Artifact["kind"],
  name: string,
  content: Buffer,
  capture: string,
  now: Date,
): number {
  const cap = EVIDENCE_CAPS[kind];
  const stored = content.subarray(0, cap);
  const key = writeEvidenceFile(root, runId, name, stored);
  return store.saveArtifact(
    {
      run: runId,
      kind,
      key,
      bytesOriginal: content.length,
      bytesStored: stored.length,
      truncated: content.length > stored.length,
      sha256: createHash("sha256").update(stored).digest("hex"),
      capture,
    },
    now,
  );
}

/**
 * Read an artifact's bytes back, believing nothing until it is proved on the
 * descriptor actually read (§7's honesty, applied to serving). The record's
 * key must be a normalized relative path; the resolved path must live under
 * the root; the open refuses symlinks; the size and hash checks run against
 * the same descriptor the bytes come from — so a pathname swapped between a
 * check and the read buys an attacker nothing. Only a buffer whose SHA-256
 * matches the row is ever returned: unverified bytes never leave this
 * function, which is what lets a caller stream with a clear conscience.
 */
export function readVerifiedArtifact(
  root: string,
  artifact: Artifact,
): { ok: true; content: Buffer } | { ok: false; problem: string } {
  const segments = artifact.key.split("/");
  const wellFormed =
    segments.length > 0 &&
    segments.every(
      segment =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\\") &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f\u007f:]/.test(segment),
    );
  if (!wellFormed) return { ok: false, problem: "the key is not a normalized relative path" };

  const cap = EVIDENCE_CAPS[artifact.kind];
  if (artifact.bytesStored > cap) {
    return { ok: false, problem: "the record claims more bytes than its kind may store" };
  }

  let resolved: string;
  try {
    resolved = realpathSync(join(root, ...segments));
    const rootReal = realpathSync(root);
    if (!resolved.startsWith(rootReal + sep)) {
      return { ok: false, problem: "the file resolves outside the evidence root" };
    }
  } catch {
    return { ok: false, problem: "the file is gone or unresolvable" };
  }

  let fd: number;
  try {
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, problem: "cannot open the file without following a link" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, problem: "not a regular file" };
    if (Number(stat.size) !== artifact.bytesStored) {
      return { ok: false, problem: "the file's size no longer matches its record" };
    }
    const buffer = Buffer.alloc(artifact.bytesStored);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== buffer.length) return { ok: false, problem: "the file ended early" };
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (digest !== artifact.sha256) {
      return { ok: false, problem: "the file no longer hashes to its record" };
    }
    return { ok: true, content: buffer };
  } finally {
    closeSync(fd);
  }
}

/** The file alone, no row — quarantines use this; they belong to no live run. */
export function writeEvidenceFile(root: string, runId: number, name: string, content: Buffer): string {
  const dir = join(root, String(runId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), content, { flag: "wx", mode: 0o600 });
  return `${runId}/${name}`;
}

/**
 * Sweep every park-shaped file out of a worktree before the agent runs.
 *
 * A mailbox left by a cut-down attempt is never ingested as a decision — the
 * lease that could have vouched for it is gone — but its bytes may still say
 * what the agent meant, so what can be read safely is kept under quarantine
 * in the current run's evidence directory. What cannot be read safely (a
 * symlink, a FIFO, something oversized) is removed unread.
 */
export function quarantineMailboxes(
  worktree: string,
  root: string | null,
  runId: number | null,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(worktree);
  } catch {
    return [];
  }

  const swept: string[] = [];
  for (const name of entries) {
    if (!looksLikeProtocolFile(name)) continue;
    const path = join(worktree, name);
    if (root !== null && runId !== null) {
      const read = readMailbox(path);
      if (read.ok) {
        try {
          writeEvidenceFile(root, runId, `quarantine-${randomBytes(4).toString("hex")}-${name}`, read.raw);
        } catch {
          // Quarantine is best-effort; removal below is not.
        }
      }
    }
    try {
      unlinkSync(path);
      swept.push(name);
    } catch {
      // A mailbox that cannot be removed will fail the freshness check at
      // ingestion anyway: it does not carry this attempt's nonce.
    }
  }
  return swept;
}

/**
 * Capture the park's evidence: the complete working state against the base
 * revision, and the porcelain inventory that names what the diff cannot —
 * untracked and staged files included. External diff drivers and textconv
 * are disabled by name: both run repository-configured commands, and this
 * capture must not execute anything the agent may have just written.
 */
export async function captureParkEvidence(
  store: Store,
  git: (file: string, args: readonly string[], options?: { cwd?: string }) => Promise<ExecResult>,
  worktree: string,
  baseRevision: string | null,
  root: string,
  runId: number,
  now: Date,
): Promise<number[]> {
  const captures: { kind: Artifact["kind"]; name: string; args: string[] }[] = [
    {
      kind: "diff",
      name: "diff.patch",
      args:
        baseRevision === null
          ? ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-color"]
          : ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-color", baseRevision, "--", "."],
    },
    {
      kind: "status",
      name: "status.txt",
      args: ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"],
    },
  ];

  const ids: number[] = [];
  for (const { kind, name, args } of captures) {
    const result = await git("git", args, { cwd: worktree });
    const command = `git ${args.filter(a => a !== "--no-optional-locks").join(" ")} (exit ${result.code})`;
    // A failed capture is stored as the failure it is — stderr under the
    // same key, labeled by its exit code — never silently skipped, because
    // "no diff shown" and "diff capture failed" read very differently at 7am.
    const content = Buffer.from(result.code === 0 ? result.stdout : result.stderr, "utf8");
    ids.push(storeEvidence(store, root, runId, kind, name, content, command, now));
  }
  return ids;
}

/** One file's row in the terminal diff-stat. null adds/dels = binary. */
export type DiffStatFile = {
  path: string;
  additions: number | null;
  deletions: number | null;
  renamedFrom?: string;
};

export type DiffStat = {
  schema: 1;
  base: string;
  head: string;
  fileCount: number;
  additions: number;
  deletions: number;
  binaryCount: number;
  files: DiffStatFile[];
  /** True when the file list was cut to fit the cap — counts stay complete. */
  filesTruncated: boolean;
};

const DIFF_STAT_FILE_LIMIT = 400;

/**
 * Parse `git diff --numstat -z` output. NUL-delimited, so filenames are never
 * guessed out of patch headers (Codex roadmap review, scope cut A.3): plain
 * entries are one token "adds\tdels\tpath"; renames are "adds\tdels\t" with
 * the two paths as the following tokens. Binary files carry "-" counts,
 * recorded as null — never coerced to zero.
 */
export function parseNumstat(raw: string, base: string, head: string): DiffStat {
  const tokens = raw.split("\u0000").filter(token => token.length > 0);
  const files: DiffStatFile[] = [];
  let additions = 0;
  let deletions = 0;
  let binaryCount = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    const parts = token.split("\t");
    if (parts.length < 3) continue; // not a numstat entry this parser knows
    const adds = parts[0] === "-" ? null : Number(parts[0]);
    const dels = parts[1] === "-" ? null : Number(parts[1]);
    if ((adds !== null && !Number.isFinite(adds)) || (dels !== null && !Number.isFinite(dels))) continue;
    let path = parts.slice(2).join("\t");
    let renamedFrom: string | undefined;
    if (path === "") {
      // Rename: the next two tokens are the old and new paths.
      renamedFrom = tokens[i + 1];
      path = tokens[i + 2] ?? "";
      i += 2;
      if (path === "") continue;
    }
    if (adds === null || dels === null) binaryCount += 1;
    additions += adds ?? 0;
    deletions += dels ?? 0;
    files.push({ path, additions: adds, deletions: dels, ...(renamedFrom === undefined ? {} : { renamedFrom }) });
  }
  const kept = files.slice(0, DIFF_STAT_FILE_LIMIT);
  return {
    schema: 1,
    base,
    head,
    fileCount: files.length,
    additions,
    deletions,
    binaryCount,
    files: kept,
    filesTruncated: kept.length < files.length,
  };
}

/**
 * Capture the TERMINAL diff — the immutable base→head patch of a run that
 * committed, taken before its worktree is released (M5.3; the Codex scope
 * cut is the spec). Two artifacts: the bounded plain patch, and a
 * machine-parsed stat whose filenames came NUL-delimited from git, never
 * from patch headers. Same execution posture as the park capture: external
 * diff drivers and textconv disabled by name, because this must not run
 * anything the agent may have just written. A no-change run stores the
 * explicit zero-stat rather than storing nothing — "no diff" and "capture
 * failed" have to read differently.
 */
export async function captureTerminalDiff(
  store: Store,
  git: (file: string, args: readonly string[], options?: { cwd?: string }) => Promise<ExecResult>,
  worktree: string,
  base: string,
  head: string,
  root: string,
  runId: number,
  now: Date,
): Promise<{ diffId: number; statId: number }> {
  const patchArgs = ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--no-color", base, head];
  const patch = await git("git", patchArgs, { cwd: worktree });
  const patchCommand = `git ${patchArgs.filter(a => a !== "--no-optional-locks").join(" ")} (exit ${patch.code})`;
  const patchContent = Buffer.from(patch.code === 0 ? patch.stdout : patch.stderr, "utf8");
  const diffId = storeEvidence(store, root, runId, "terminal-diff", "terminal-diff.patch", patchContent, patchCommand, now);

  const statArgs = ["--no-optional-locks", "diff", "--numstat", "-z", base, head];
  const stat = await git("git", statArgs, { cwd: worktree });
  const statCommand = `git ${statArgs.filter(a => a !== "--no-optional-locks").join(" ")} (exit ${stat.code})`;
  const statContent =
    stat.code === 0
      ? Buffer.from(JSON.stringify(parseNumstat(stat.stdout, base, head)), "utf8")
      : Buffer.from(stat.stderr, "utf8");
  const statId = storeEvidence(store, root, runId, "diff-stat", "terminal-diff-stat.json", statContent, statCommand, now);

  return { diffId, statId };
}
