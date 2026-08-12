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
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LIMITS } from "./decision.js";
import type { Artifact, Store } from "./store.js";
import type { ExecResult } from "./exec.js";

/** The park mailbox pattern. Each run's actual name carries a nonce; see `mailboxName`. */
export const MAILBOX_PREFIX = "NIGHTORDERS-PARK-";
/** The terminal handoff: how every non-parking attempt says how it ended. */
export const HANDOFF_PREFIX = "NIGHTORDERS-DONE-";
export const MAILBOX_SUFFIX = ".json";

/** Bytes each kind may store. Originals can be any size; the record says what was cut. */
export const EVIDENCE_CAPS: Record<Artifact["kind"], number> = {
  diff: 256 * 1024,
  status: 64 * 1024,
  "park-payload": LIMITS.payload,
};

export function evidenceRoot(home: string): string {
  return join(home, ".nightorders", "evidence");
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

/** Every protocol file the sweep must never let an old attempt leave behind. */
export function looksLikeProtocolFile(name: string): boolean {
  return (
    (name.startsWith(MAILBOX_PREFIX) || name.startsWith(HANDOFF_PREFIX)) &&
    name.endsWith(MAILBOX_SUFFIX)
  );
}

export function handoffName(): string {
  return `${HANDOFF_PREFIX}${randomBytes(8).toString("hex")}${MAILBOX_SUFFIX}`;
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
