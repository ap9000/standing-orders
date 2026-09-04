/**
 * The pool of working copies, and the leases over them.
 *
 * Semantics copied from treehouse rather than reinvented, including the two
 * rules that are easy to get wrong and expensive to get wrong quietly:
 *
 * **Untracked files count as dirty.** A repository whose `.gitignore` hides
 * build output is still a repository with somebody's work in it, and a pool
 * that recycles a directory because `git status` looked clean under the
 * operator's config will delete something they wanted. So the check is run
 * with ignored files excluded but untracked files included, which is the
 * conservative reading of "is anyone using this".
 *
 * **Reconstructed state is leased-until-verified.** A worktree found on disk
 * after a crash describes what a dead process was doing, not what is true now.
 * It comes back into the pool marked unverified, and something has to look at
 * it before it is handed to anybody.
 *
 * Where the pool lives is a decision, not a detail. Worktrees are created
 * outside the repository — never inside it, where they would appear as
 * untracked directories in the operator's own `git status`, and never inside a
 * synced folder like OneDrive or Dropbox, where a sync client racing an agent
 * over `.git` internals corrupts both.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { run, type ExecResult, type RunOptions } from "./exec.js";
import type { Store, WorktreeRow } from "./store.js";

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

export type PoolOptions = {
  /** Where worktrees are created. Outside the repo, and outside any sync root. */
  root: string;
  runner?: Runner;
};

export type LeaseRequest = {
  repo: string;
  branch: string;
  runner: string;
  taskRef?: number;
  now: Date;
  /** Branch to create from, when the branch does not exist yet. */
  base?: string;
  /**
   * Reclaim this task's OWN leftover: when the checkout was released dirty
   * by a finished attempt of the same task (not a dead runner's, not
   * another task's), keep what it left as a patch under the last run's
   * evidence and reset the tree for the next attempt. Without this a
   * failed attempt's half-edit blocks every retry forever.
   */
  reclaim?: { evidenceRoot: string };
};

export type LeaseResult =
  | { ok: true; worktree: WorktreeRow; created: boolean; reclaimed?: string }
  | { ok: false; reason: LeaseFailure; message: string };

export type LeaseFailure = "held" | "dirty" | "git" | "unverified" | "unknown-runner" | "in-use";

/**
 * The note a lease leaves in the checkout, naming the process holding it.
 *
 * Deliberately inside the worktree rather than beside it: it travels with the
 * directory, and `git status` will show it as untracked, which is honest —
 * something is in there.
 */
export const MARKER = ".standing-orders-lease";

/** Creating a worktree copies a tree; it is local work but not instant. */
export const WORKTREE_TIMEOUT_MS = 60_000;
const GIT = "git";
const READ_ONLY = ["--no-optional-locks"] as const;

/**
 * A path for this repository and branch that is stable across runs.
 *
 * Stable so that a second attempt at the same task reuses the checkout it
 * already paid for, and flattened so a branch called `feat/a/b` cannot escape
 * the pool root through its own slashes.
 */
export function worktreePath(root: string, repo: string, branch: string): string {
  // The readable part is for a person reading `ls`; the digest is what makes
  // it correct. Flattening alone collides in two ways that both end with one
  // task's work landing in another's checkout: `feat/a` and `feat-a` reduce to
  // the same name, and `/x/api` and `/y/api` share a basename. The digest is
  // taken over the full repository path and the exact branch, so neither can.
  const digest = createHash("sha256")
    .update(`${normalisePath(repo)}\u0000${branch}`, "utf8")
    .digest("hex")
    .slice(0, 8);

  return join(root, safeSegment(basenameOf(repo)), `${safeSegment(branch)}-${digest}`);
}

function normalisePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function basenameOf(repo: string): string {
  const parts = repo.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "repo";
}

/** Anything that is not a plain name becomes one; no separators survive. */
function safeSegment(text: string): string {
  const cleaned = text.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return cleaned === "" ? "x" : cleaned;
}

export class WorktreePool {
  private readonly runner: Runner;

  constructor(
    private readonly store: Store,
    private readonly options: PoolOptions,
  ) {
    this.runner = options.runner ?? run;
  }

  /**
   * Take a working copy for this branch.
   *
   * Refused when somebody else holds it — losing is ordinary, and a caller
   * that is told who holds it can go and do something else rather than poll.
   */
  /**
   * Whether a live process is working in there, independently of what the
   * database believes.
   *
   * treehouse's rule, and it exists because the database is the thing most
   * likely to be wrong: a row saying "released" written by a process that then
   * kept running, or a stale row from a crash, are both cases where the
   * checkout is genuinely occupied and only the machine can say so. So each
   * lease drops a note naming the process holding it, and `process.kill(pid, 0)`
   * — which signals nothing and only asks whether the pid exists — is what
   * answers the question afterwards.
   *
   * A pid can be recycled by the operating system, so this can say "in use"
   * about a stranger. That is the safe direction: refusing a checkout somebody
   * may be in costs a retry, and taking one they are in costs their work.
   */
  inUse(path: string): { held: true; by: number } | { held: false } {
    const note = join(path, MARKER);
    if (!existsSync(note)) return { held: false };

    const pid = Number(readFileSync(note, "utf8").trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) return { held: false };
    if (pid === process.pid) return { held: false };

    try {
      process.kill(pid, 0);
      return { held: true, by: pid };
    } catch (error) {
      // Two different answers hide behind one throw. ESRCH means the process
      // is gone and the note is what it left behind. EPERM means it is very
      // much alive and simply not ours to signal — running as another user, or
      // elevated — and reading that as "gone" would hand somebody's live
      // checkout to another runner. Only ESRCH frees it.
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ESRCH" ? { held: false } : { held: true, by: pid };
    }
  }

  async lease(request: LeaseRequest): Promise<LeaseResult> {
    // A worktree leased to a runner nobody registered cannot be heartbeated
    // and cannot be recovered — it would be a checkout that never comes back.
    // The database enforces this too; catching it here is what turns a foreign
    // key error into a sentence somebody can act on.
    if (this.store.getRunner(request.runner) === null) {
      return {
        ok: false,
        reason: "unknown-runner",
        message: `no runner \`${request.runner}\` — register it before giving it work`,
      };
    }

    const path = worktreePath(this.options.root, request.repo, request.branch);
    const existing = this.store.getWorktree(path);

    // The machine outranks the database here. A row can say "released" while a
    // process that never got to write its own ending is still working in the
    // directory, and that is exactly when taking it away costs somebody a
    // night's work.
    const occupied = this.inUse(path);
    if (occupied.held) {
      return {
        ok: false,
        reason: "in-use",
        message: `${path} is being used by process ${occupied.by} — leaving it alone`,
      };
    }

    if (existing !== null && existing.releasedAt === null && existing.runner !== request.runner) {
      return {
        ok: false,
        reason: "held",
        message: `${path} is leased to ${existing.runner ?? "someone"}`,
      };
    }

    // A directory that came back from a dead runner is unverified: what is in
    // it describes a process that stopped without saying why. Checked before
    // reuse, never assumed.
    let reclaimed: string | undefined;
    if (existing !== null && !existing.verified && existing.releasedAt !== null) {
      const dirty = await this.isDirty(path);
      if (dirty === null) {
        return { ok: false, reason: "git", message: `${path} could not be inspected` };
      }
      if (dirty) {
        // The task's own leftover, from an attempt that finished and said
        // so: kept as evidence, then cleared, so the retry starts from the
        // branch and not from a half-edit. Anything else stays for a person.
        const own = request.reclaim !== undefined && request.taskRef !== undefined && existing.taskRef === request.taskRef;
        if (!own) {
          return {
            ok: false,
            reason: "dirty",
            message: `${path} has uncommitted or untracked work from a previous run — look before reusing it`,
          };
        }
        const kept = await this.keepLeftover(path, (request.reclaim as { evidenceRoot: string }).evidenceRoot, request.now);
        if (!kept.ok) return { ok: false, reason: "git", message: kept.message };
        const reset = await this.resetTree(path);
        if (!reset.ok) return { ok: false, reason: "git", message: reset.message };
        reclaimed = kept.file;
      }
    }

    const created = existing === null;
    if (created) {
      const add = await this.git(request.repo, [
        "worktree",
        "add",
        ...(request.base === undefined ? [] : ["-b", request.branch]),
        path,
        ...(request.base === undefined ? [request.branch] : [request.base]),
      ]);
      if (add.code !== 0) {
        return { ok: false, reason: "git", message: firstLine(add.stderr) };
      }
    }

    const row: WorktreeRow = {
      path,
      repo: request.repo,
      branch: request.branch,
      runner: request.runner,
      taskRef: request.taskRef ?? null,
      createdAt: existing?.createdAt ?? request.now.toISOString(),
      leasedAt: request.now.toISOString(),
      releasedAt: null,
      // Freshly created, or inspected just above — either way, checked.
      verified: true,
      // The occupancy epoch (live-peek findings 16/28): fresh randomness,
      // written by the SAME row write that grants the lease — it can never
      // repeat and never lag the occupancy it names.
      leaseEpoch: randomBytes(12).toString("hex"),
    };
    // The note goes down before the lease is granted. A checkout we cannot
    // mark is one whose next holder cannot tell it is occupied — the in-use
    // check would report it free while a process worked in it — so failing to
    // write the note fails the lease rather than quietly leaving the gap.
    if (!this.mark(path, request.runner)) {
      return {
        ok: false,
        reason: "git",
        message: `${path} could not be marked as in use, so it is not safe to hand out`,
      };
    }

    this.store.saveWorktree(row);
    return { ok: true, worktree: row, created, ...(reclaimed === undefined ? {} : { reclaimed }) };
  }

  /**
   * Preserve a dirty tree's work as one patch — tracked changes against
   * HEAD, then each untracked file against nothing — under the evidence of
   * the last run that lived in this checkout (or a leftover folder when no
   * run is on record). Nothing is deleted here.
   */
  private async keepLeftover(path: string, evidenceRoot: string, now: Date): Promise<{ ok: true; file: string } | { ok: false; message: string }> {
    const status = await this.runner(GIT, [...READ_ONLY, "status", "--porcelain", "--untracked-files=all"], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (status.code !== 0) return { ok: false, message: `${path} could not be inspected before reclaiming it` };
    const untracked = status.stdout
      .split("\n")
      .filter(line => line.startsWith("?? ") && !line.trimEnd().endsWith(MARKER))
      .map(line => line.slice(3).trim());
    const tracked = await this.runner(GIT, [...READ_ONLY, "diff", "--binary", "HEAD"], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (tracked.code !== 0) return { ok: false, message: `${path}: git diff failed while reclaiming (${firstLine(tracked.stderr)})` };
    const parts = [tracked.stdout];
    for (const file of untracked) {
      // --no-index exits 1 when the sides differ; that is the expected answer.
      const one = await this.runner(GIT, [...READ_ONLY, "diff", "--binary", "--no-index", "--", "/dev/null", file], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
      if (one.code > 1) return { ok: false, message: `${path}: ${file} could not be captured (${firstLine(one.stderr)})` };
      parts.push(one.stdout);
    }
    const lastRun = this.store.latestRunInWorktree(path);
    const dir = lastRun === null ? join(evidenceRoot, "leftover") : join(evidenceRoot, String(lastRun));
    const file = join(dir, lastRun === null ? `${now.toISOString().replace(/[:.]/g, "-")}.patch` : "leftover.patch");
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `# leftover from ${path}\n# kept ${now.toISOString()} before the tree was reset for the next attempt\n` + parts.join(""), { mode: 0o600 });
    } catch (error) {
      return { ok: false, message: `${path}: the leftover could not be written to ${file} (${error instanceof Error ? error.message : String(error)})` };
    }
    return { ok: true, file };
  }

  /** Back to HEAD, untracked gone, our lease note kept; proven clean after. */
  private async resetTree(path: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const checkout = await this.runner(GIT, ["checkout", "--", "."], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (checkout.code !== 0) return { ok: false, message: `${path}: git checkout failed while resetting (${firstLine(checkout.stderr)})` };
    const clean = await this.runner(GIT, ["clean", "-fd", "-e", MARKER], { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS });
    if (clean.code !== 0) return { ok: false, message: `${path}: git clean failed while resetting (${firstLine(clean.stderr)})` };
    const dirty = await this.isDirty(path);
    if (dirty !== false) return { ok: false, message: `${path} is still not clean after the reset — leaving it for a person` };
    return { ok: true };
  }

  /** Leave a note naming the process holding this checkout. */
  private mark(path: string, runner: string): boolean {
    try {
      writeFileSync(join(path, MARKER), `${process.pid} ${runner}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Hand a working copy back.
   *
   * The tree is inspected first, and dirt is reported rather than cleaned.
   * `git reset --hard` leaves untracked files behind and destroys work that
   * might have been repairable, which is why the failure taxonomy this project
   * borrows says to preserve a failed commit rather than blanket-reset.
   */
  async release(path: string, now: Date): Promise<LeaseResult> {
    const existing = this.store.getWorktree(path);
    if (existing === null) {
      return { ok: false, reason: "git", message: `${path} is not a worktree we made` };
    }

    const dirty = await this.isDirty(path);
    // The note goes before the row is written: a crash between the two should
    // leave a checkout that looks free rather than one held by a pid that has
    // gone, which is the direction that needs no human to unstick it.
    try {
      rmSync(join(path, MARKER), { force: true });
    } catch {
      // Nothing to do about it, and the pid check handles a note left behind.
    }

    const row: WorktreeRow = {
      ...existing,
      runner: null,
      releasedAt: now.toISOString(),
      // Unknown counts as unverified. Saying "clean" about a tree we could not
      // read would hand the next runner a surprise.
      verified: dirty === false,
      // Occupancy ended: the epoch rotates HERE too, so a peek proved
      // against the tenancy that just ended can only discard (finding 28).
      leaseEpoch: randomBytes(12).toString("hex"),
    };
    this.store.saveWorktree(row);

    if (dirty === null) {
      return { ok: false, reason: "git", message: `${path} could not be inspected on release` };
    }
    if (dirty) {
      return {
        ok: false,
        reason: "dirty",
        message: `${path} still has uncommitted or untracked work — it is kept, not cleaned`,
      };
    }
    return { ok: true, worktree: row, created: false };
  }

  /**
   * Worktrees git knows about that this pool does not, and the reverse.
   *
   * The first is somebody else's business and is left alone. The second is
   * ours: a row for a directory that is no longer there, which happens when a
   * machine is reimaged or a pool root is deleted between runs.
   */
  /**
   * Remove a released checkout and its branch (v4 review, finding 3): the
   * read-only roles' workspaces are disposable, so the next attempt starts
   * from the requested base instead of whatever the last one saw. Refused
   * while a process holds the directory; a failure leaves the checkout
   * where `worktrees` can see it rather than pretending it is gone.
   */
  async discard(path: string, now: Date): Promise<{ ok: true } | { ok: false; message: string }> {
    const existing = this.store.getWorktree(path);
    if (existing === null) return { ok: false, message: `${path} is not a worktree we made` };
    if (existing.releasedAt === null) return { ok: false, message: `${path} is still leased — release it first` };
    const occupied = this.inUse(path);
    if (occupied.held) return { ok: false, message: `${path} is being used by process ${occupied.by} — leaving it alone` };
    const removed = await this.git(existing.repo, ["worktree", "remove", "--force", path]);
    if (removed.code !== 0) return { ok: false, message: `git worktree remove: ${removed.stderr.trim() || `exit ${removed.code}`}` };
    // The branch is disposable too; a failure here is bookkeeping, not custody.
    await this.git(existing.repo, ["branch", "-D", existing.branch]);
    this.store.forgetWorktree(path);
    void now;
    return { ok: true };
  }

  async orphans(
    repo: string,
  ): Promise<{ ok: true; untracked: string[]; missing: string[] } | { ok: false; message: string }> {
    const listed = await this.git(repo, ["worktree", "list", "--porcelain"], READ_ONLY);
    // A listing that failed is not a listing that came back empty. Treating
    // it as empty would report every stored row as missing — and anything
    // acting on that answer would erase real bookkeeping over a git hiccup.
    if (listed.code !== 0) {
      return {
        ok: false,
        message: `git could not list ${repo}'s worktrees — ${listed.stderr.trim() || `exit ${listed.code}`}`,
      };
    }
    const onDisk = new Set(
      listed.stdout
        .split("\n")
        .filter(line => line.startsWith("worktree "))
        .map(line => line.slice("worktree ".length).trim()),
    );

    const ours = this.store.listWorktrees().filter(row => row.repo === repo);
    const known = new Set(ours.map(row => row.path));

    return {
      ok: true,
      untracked: [...onDisk].filter(path => !known.has(path) && path !== repo),
      missing: ours.filter(row => !onDisk.has(row.path)).map(row => row.path),
    };
  }

  /**
   * Take responsibility for worktrees that exist but nothing recorded.
   *
   * These turn up after a crash between `git worktree add` and the row that
   * should have followed it, or when a database is replaced while checkouts
   * survive on disk. Left alone they are invisible: git knows about them,
   * every pool query does not, and the same branch gets checked out again
   * beside them.
   *
   * Adopted **released and unverified**, never leased. Nobody watched them
   * being made, so they are a claim about the past — the same rule that
   * governs a dead runner's worktrees, for the same reason.
   *
   * Rows whose directory is gone are dropped: a lease over a path that does
   * not exist can only refuse work that could otherwise have run.
   */
  async adopt(
    repo: string,
    now: Date,
  ): Promise<{ ok: true; adopted: string[]; forgotten: string[] } | { ok: false; message: string }> {
    const found = await this.orphans(repo);
    // Fail closed, before anything is written or forgotten: an answer built
    // on a failed listing would adopt nothing and erase everything.
    if (!found.ok) return found;

    // Only what lives under this pool's root is ours to adopt. A worktree the
    // operator made by hand, wherever they made it, is somebody's business —
    // it is named by `orphans()` and left exactly where it is. Compared as
    // real paths, because git reports where a directory actually is while the
    // configured root may reach it through a symlink (macOS's /var, for one).
    const real = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    const root = normalisePath(real(this.options.root)) + "/";
    const adoptable = found.untracked.filter(path => normalisePath(real(path)).startsWith(root));

    for (const path of adoptable) {
      this.store.saveWorktree({
        path,
        repo,
        // The branch is not knowable from the listing alone, and inventing one
        // would be worse than admitting it: whoever verifies this will look.
        branch: "unknown",
        runner: null,
        taskRef: null,
        createdAt: now.toISOString(),
        leasedAt: null,
        releasedAt: now.toISOString(),
        verified: false,
      });
    }

    for (const path of found.missing) this.store.forgetWorktree(path);

    return { ok: true, adopted: adoptable, forgotten: found.missing };
  }

  /**
   * Whether anybody's work is in there. null means we could not tell, which is
   * neither clean nor dirty and must not be rounded to either.
   *
   * `--untracked-files=all` and no `--ignored`: build output that .gitignore
   * hides is not work, but a file somebody dropped in and never staged is.
   */
  private async isDirty(path: string): Promise<boolean | null> {
    const status = await this.runner(
      GIT,
      [...READ_ONLY, "status", "--porcelain", "--untracked-files=all"],
      { cwd: path, timeoutMs: WORKTREE_TIMEOUT_MS },
    );
    if (status.code !== 0) return null;

    // Our own lease note is not the operator's work. Without this the marker
    // makes every checkout permanently dirty, which would jam the pool shut on
    // the first lease — untracked files counting as dirty is the right rule,
    // and this is the one file it must not apply to.
    return status.stdout
      .split("\n")
      .filter(line => line.trim() !== "")
      .some(line => !line.trimEnd().endsWith(MARKER));
  }

  private git(
    cwd: string,
    args: readonly string[],
    prefix: readonly string[] = [],
  ): Promise<ExecResult> {
    return this.runner(GIT, [...prefix, ...args], { cwd, timeoutMs: WORKTREE_TIMEOUT_MS });
  }
}

function firstLine(text: string): string {
  const [line = ""] = text.trim().split("\n");
  return line;
}
