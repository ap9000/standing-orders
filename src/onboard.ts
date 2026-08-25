/**
 * Repo onboarding (four Codex rounds, findings 1–39): clone a GitHub
 * repository into a configured projects root, as a ceremony.
 *
 * The boundaries, in one place: the clone is the ONLY network write and
 * acts as the serve process's ambient GitHub credential; the target is
 * confined to an explicitly configured --project-root; publication is
 * CLAIM-FIRST (an exclusive mkdir of the final directory — a lost race
 * fails before a byte is written); nothing is ever deleted that this
 * request did not create; submodules and LFS smudge fetches are off; and
 * a fresh clone enters with ZERO authority — no tasks, no scopes, no
 * grants, exactly like an `up`-enrolled repository.
 *
 * POSIX only: tree death is proven by polling the process group to
 * ESRCH. Windows cannot prove descendants died after the leader exited
 * (finding 32), so onboarding refuses there instead of guessing.
 */

import { mkdirSync, openSync, closeSync, writeSync, rmSync, constants as fsConstants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";

/** Strict, onboarding-only (finding 5/18): exactly owner/name, bounded
 * ASCII, alnum-leading, no leading dash or dot, `.`/`..` refused. The two
 * looser GITHUB_REPO_SHAPE call sites gate other, already-reviewed
 * authority and are deliberately untouched. */
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function parseGithubRepo(raw: string): { ok: true; owner: string; name: string } | { ok: false; problem: string } {
  let text = raw.trim();
  if (text.length === 0 || text.length > 512) return { ok: false, problem: "name a repository as owner/name or a github.com link" };
  if (text.startsWith("https://") || text.startsWith("http://")) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, problem: "that link is not a URL" };
    }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return { ok: false, problem: "only plain https://github.com/owner/name links are accepted" };
    }
    const segments = url.pathname.split("/").filter(one => one !== "");
    if (segments.length !== 2) return { ok: false, problem: "a repository link has exactly two path segments: owner/name" };
    text = `${segments[0]}/${segments[1]?.replace(/\.git$/, "")}`;
  }
  const parts = text.split("/");
  if (parts.length !== 2) return { ok: false, problem: "name a repository as owner/name" };
  const [owner = "", name = ""] = parts;
  for (const part of [owner, name]) {
    if (!COMPONENT.test(part) || part === "." || part === ".." || part.startsWith("-") || part.startsWith(".")) {
      return { ok: false, problem: "owner and name are letters, digits, dots, dashes, and underscores — nothing else" };
    }
  }
  return { ok: true, owner, name };
}

export type GhTreeResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
  /** The whole process tree is PROVEN dead (finding 21) — cleanup and
   * verification both gate on this; on doubt nothing is touched. */
  treeGone: boolean;
};

const GH_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Run gh with its own detached group and prove tree death on EVERY
 * outcome. Deliberately NOT exec.ts's processGroup path: liveProviders is
 * provider-owned (finding 12), and this contract — poll the group to
 * ESRCH before anyone may clean up — is onboarding's own.
 */
export function runGhTree(
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<GhTreeResult> {
  return new Promise(resolve => {
    if (process.platform === "win32") {
      resolve({ code: 1, stdout: "", stderr: "onboarding is not supported on Windows yet", timedOut: false, notFound: true, treeGone: true });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("gh", [...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...GH_ENV },
      });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: String(error), timedOut: false, notFound: false, treeGone: true });
      return;
    }
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let notFound = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // group already gone
        }
      }
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 256 * 1024) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", error => {
      notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (stderr === "") stderr = String(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      // Tree death, proven by the group answering ESRCH — on every path.
      const settle = (treeGone: boolean): void =>
        resolve({ code: notFound ? 127 : timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut, notFound, treeGone });
      if (pid === undefined) {
        settle(true);
        return;
      }
      const deadline = Date.now() + 5_000;
      const poll = (): void => {
        try {
          process.kill(-pid, 0);
        } catch {
          settle(true); // ESRCH: nobody left in the group
          return;
        }
        if (Date.now() > deadline) {
          settle(false);
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  });
}

/** Capped, control-stripped stderr for refusal text — never unbounded. */
export function ghWords(stderr: string): string {
  const line = stderr.split("\n").find(one => one.trim() !== "") ?? "";
  return line.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200).trim();
}

export type RepoPreview = {
  nameWithOwner: string;
  visibility: string;
  /** GitHub reports KiB (finding 18); null = unknown = treated LARGE. */
  diskUsageKib: number | null;
  description: string;
};

export const LARGE_REPO_KIB = 1_048_576; // 1 GiB in KiB

export function isLargeRepo(preview: RepoPreview): boolean {
  return preview.diskUsageKib === null || preview.diskUsageKib >= LARGE_REPO_KIB;
}

export type PreviewOutcome =
  | { ok: true; preview: RepoPreview }
  | { ok: false; reason: "gh-missing" | "gh-auth" | "gh-timeout" | "gh-said-no" | "malformed"; message: string };

/** `gh repo view` — nothing is written on ANY preview outcome. */
export async function previewGithubRepo(owner: string, name: string): Promise<PreviewOutcome> {
  const answer = await runGhTree(
    ["repo", "view", `github.com/${owner}/${name}`, "--json", "nameWithOwner,visibility,diskUsage,description"],
    { timeoutMs: 30_000 },
  );
  if (answer.notFound) return { ok: false, reason: "gh-missing", message: "the GitHub CLI is not installed on this machine — install gh where serve runs" };
  if (answer.timedOut) return { ok: false, reason: "gh-timeout", message: "GitHub did not answer in time — nothing was written" };
  if (answer.code === 4) return { ok: false, reason: "gh-auth", message: "gh is not signed in — run `gh auth login --hostname github.com` where serve runs" };
  if (answer.code !== 0) return { ok: false, reason: "gh-said-no", message: `GitHub said no — ${ghWords(answer.stderr) || "the repository may not exist, or this account cannot see it"}; nothing was written` };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(answer.stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "malformed", message: "GitHub's answer was not the JSON gh promises — nothing was written" };
  }
  const nameWithOwner = parsed["nameWithOwner"];
  // The returned identity is RE-PARSED through the strict parser before
  // anything derives from it (finding 18) — gh's answer is data too.
  if (typeof nameWithOwner !== "string" || !parseGithubRepo(nameWithOwner).ok) {
    return { ok: false, reason: "malformed", message: "GitHub named a repository shape this console refuses — nothing was written" };
  }
  const disk = parsed["diskUsage"];
  const description = typeof parsed["description"] === "string" ? parsed["description"] : "";
  return {
    ok: true,
    preview: {
      nameWithOwner,
      visibility: typeof parsed["visibility"] === "string" ? parsed["visibility"].toLowerCase() : "unknown",
      diskUsageKib: typeof disk === "number" && disk >= 0 ? disk : null,
      description: description.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200),
    },
  };
}

export type CloneOutcome =
  | { ok: true; target: string }
  | { ok: false; reason: "exists" | "gh-missing" | "gh-auth" | "gh-timeout" | "clone-failed" | "verify-failed" | "residual"; message: string };

/**
 * The claim-first clone (findings 6/11/23): mkdir the FINAL target
 * exclusively — EEXIST loses the race with NOTHING written — then clone
 * into it. Cleanup removes the target only because THIS call created it,
 * and only after the tree is proven dead; on doubt the residual is named.
 */
export async function cloneGithubRepo(
  nameWithOwner: string,
  root: string,
  gitVerify: (cwd: string) => Promise<{ code: number; stdout: string }>,
): Promise<CloneOutcome> {
  const shape = parseGithubRepo(nameWithOwner);
  if (!shape.ok) return { ok: false, reason: "clone-failed", message: shape.problem };
  const target = join(root, shape.name);
  if (dirname(target) !== root || basename(target) !== shape.name) {
    return { ok: false, reason: "clone-failed", message: "the target escaped its root — refused" };
  }
  try {
    mkdirSync(target); // the CLAIM — exclusive by mkdir semantics
  } catch {
    return {
      ok: false,
      reason: "exists",
      message: `nothing was written by this request — a directory already exists at ${target}; if it is empty and nobody is cloning, it is an abandoned claim: inspect and remove it by hand`,
    };
  }
  // The ownership marker (finding 11): written and removed before gh runs;
  // its lifecycle is within this invocation only.
  const marker = join(target, ".so-claim");
  try {
    const fd = openSync(marker, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeSync(fd, "claimed by standing-orders onboarding\n");
    closeSync(fd);
    rmSync(marker);
  } catch {
    // The claim stands; a marker hiccup is not worth a wedged directory.
  }

  const answer = await runGhTree(
    ["repo", "clone", `github.com/${nameWithOwner}`, target, "--", "--no-tags", "--no-recurse-submodules"],
    { timeoutMs: 10 * 60_000 },
  );
  const cleanOwn = (): boolean => {
    if (!answer.treeGone) return false; // doubt: touch nothing (finding 21)
    try {
      rmSync(target, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  if (answer.notFound) {
    cleanOwn();
    return { ok: false, reason: "gh-missing", message: "the GitHub CLI is not installed on this machine — the claimed directory was removed" };
  }
  if (answer.code === 4) {
    const removed = cleanOwn();
    return { ok: false, reason: "gh-auth", message: `gh is not signed in — run \`gh auth login --hostname github.com\` where serve runs; ${removed ? "the claimed directory was removed" : `a residual remains at ${target}`}` };
  }
  if (answer.timedOut || answer.code !== 0) {
    const removed = cleanOwn();
    const said = answer.timedOut ? "the clone ran past ten minutes and was stopped" : `the clone failed — ${ghWords(answer.stderr) || "git said no"}`;
    return {
      ok: false,
      reason: answer.timedOut ? "gh-timeout" : "clone-failed",
      message: `${said}; ${removed ? "this request's partial copy was removed" : `a residual remains at ${target} — remove it by hand`}`,
    };
  }
  if (!answer.treeGone) {
    return { ok: false, reason: "residual", message: `the clone finished but its helpers could not be proven gone — inspect ${target} before using it` };
  }
  // Verify what landed IS the repository we asked for, where we asked.
  const top = await gitVerify(target);
  if (top.code !== 0 || top.stdout.trim() !== target) {
    const removed = (() => {
      try {
        rmSync(target, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    })();
    return { ok: false, reason: "verify-failed", message: `what landed did not verify as a repository at ${target}; ${removed ? "it was removed" : "a residual remains — remove it by hand"}` };
  }
  return { ok: true, target };
}
