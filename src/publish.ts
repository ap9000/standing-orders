/**
 * Publication (§M4): built work becomes a pushed branch and a pull request,
 * under a grant whose every term was shown before the yes, through a durable
 * intent that survives any crash between "done" and "opened".
 *
 * Two external writes, two named capabilities. Pushing a branch and opening
 * a PR hurt differently, so `push-branch` and `open-pr` are granted
 * separately, with the exact GitHub repository, remote, allowed head
 * prefix, and base branch fixed at grant time — the worker re-proves all of
 * them at publish time, because a grant revoked overnight must stop the
 * morning's pushes.
 *
 * The push names the exact SHA the fenced completion accepted —
 * `git push <remote> <sha>:refs/heads/<head>` — never "whatever the branch
 * points at now". The PR is adopt-or-create: the worker first asks GitHub
 * for an open PR on that head and adopts it, so a crash after `pr create`
 * and before the record lands cannot mint a twin. The body is generated
 * only from durable state (task, scope, run record, answered decisions),
 * with the agent's prose fenced in a quote block so `Fixes #…` or an
 * @-mention in its conclusion cannot acquire GitHub semantics.
 */

import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as execRun, type ExecResult, type RunOptions } from "./exec.js";
import { summarizeChecks } from "./pulls.js";
import type { Publication, PublicationGrant, Store } from "./store.js";

export const BODY_TEMPLATE_VERSION = 1;
/** After this many failed attempts a publication stops retrying and pages instead. */
export const MAX_PUBLISH_ATTEMPTS = 5;
const EXEC_TIMEOUT_MS = 60_000;

export type PublishExec = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

/** The grant's terms, in the words the approver must be shown before agreeing. */
export function describePublicationGrant(grant: {
  repo: string;
  githubRepo: string;
  remote: string;
  headPrefix: string;
  base: string;
  capabilities: readonly string[];
  selector: "ours" | "all";
  draft: boolean;
}): string[] {
  return [
    `  repo         ${grant.repo}`,
    `  github       ${grant.githubRepo}`,
    `  remote       ${grant.remote}`,
    `  may push     branches under ${grant.headPrefix} — nothing else, ever`,
    `  base         PRs target ${grant.base}`,
    `  capabilities ${grant.capabilities.join(", ")}`,
    `  tasks        ${grant.selector === "ours" ? "only tasks standing-orders created or was given" : "any task"}`,
    `  mode         ${grant.draft ? "draft PRs" : "ready-for-review PRs"}`,
  ];
}

/**
 * The PR body, from durable state only — the same rows produce the same
 * bytes after any crash, which is what lets the intent carry a hash of it.
 */
export function publicationBody(store: Store, publication: Publication): string {
  const run = store.getRun(publication.run);
  const taskId = store.externalIdFor(publication.taskRef) ?? "?";
  const task = taskId === "?" ? null : store.getTask(taskId);
  const scope = taskId === "?" ? null : store.getScope(taskId);
  const answers = store.answersFor(publication.run);

  const lines: string[] = [
    `## ${task?.title ?? taskId}`,
    "",
    ...(scope === null ? [] : [`**Goal:** ${scope.goal}`, ""]),
    `Built unattended by standing-orders (task \`${taskId}\`, run #${publication.run}).`,
    `Base \`${run?.baseRevision ?? "?"}\` → head \`${publication.headSha}\`.`,
  ];

  if (answers.length > 0) {
    lines.push("", "**Decisions a person answered along the way:**");
    for (const answer of answers) {
      lines.push(
        `- ${answer.decision.question} → **${answer.choice}** (${answer.decision.answeredBy ?? "?"})`,
      );
    }
  }

  // The agent's own words ride in a quote fence: prose, never semantics.
  // Outside it, nothing in this body mentions or closes anything.
  if (run?.handoff !== null && run?.handoff !== undefined) {
    lines.push("", "**The agent's conclusion, quoted:**", "", "```text", run.handoff, "```");
  }

  lines.push("", `*Template v${BODY_TEMPLATE_VERSION} — generated from run records, reproducible.*`);
  return lines.join("\n");
}

export function bodyHashOf(body: string): string {
  return createHash("sha256").update(`v${BODY_TEMPLATE_VERSION}\n${body}`, "utf8").digest("hex");
}

export type PublishReport = {
  pushed: number;
  opened: number;
  adopted: number;
  failed: number;
  problems: string[];
};

/**
 * One pass over everything owed. Each phase re-proves the grant and moves
 * exactly one durable state — a crash at any point leaves a row the next
 * pass picks up where this one stopped.
 */
export async function publishPass(
  store: Store,
  options: {
    repo: string;
    clock?: () => Date;
    exec?: PublishExec;
  },
): Promise<PublishReport> {
  const clock = options.clock ?? (() => new Date());
  const exec = options.exec ?? execRun;
  const report: PublishReport = { pushed: 0, opened: 0, adopted: 0, failed: 0, problems: [] };

  for (const publication of store.pendingPublications()) {
    // The grant is re-read per publication, live: revocation is immediate,
    // and an intent created under a grant that has since died goes nowhere.
    const grant = store.publicationGrantFor(options.repo);
    const verdict = permitsPublication(grant, publication);
    if (!verdict.ok) {
      report.problems.push(`publication ${publication.id}: ${verdict.message}`);
      const attempts = store.recordPublicationError(publication.id, verdict.message, clock());
      if (attempts >= MAX_PUBLISH_ATTEMPTS) concede(store, publication, verdict.message, report, clock);
      continue;
    }

    if (publication.state === "intended") {
      // The exact SHA to the exact ref. A branch that moved since completion
      // is not what was accepted, and this push cannot be talked into it.
      const push = await exec(
        "git",
        ["push", publication.remote, `${publication.headSha}:refs/heads/${publication.head}`],
        { cwd: options.repo, timeoutMs: EXEC_TIMEOUT_MS },
      );
      if (push.code !== 0) {
        const why = push.notFound ? "git is not on PATH" : firstLine(push.stderr) || `git push exited ${push.code}`;
        const attempts = store.recordPublicationError(publication.id, why, clock());
        report.problems.push(`publication ${publication.id}: ${why}`);
        if (attempts >= MAX_PUBLISH_ATTEMPTS) concede(store, publication, why, report, clock);
        continue;
      }
      store.markPublicationPushed(publication.id, clock());
      report.pushed++;
      publication.state = "pushed";
    }

    if (publication.state === "pushed") {
      const outcome = await openOrAdopt(store, publication, grant as PublicationGrant, exec, clock);
      if (!outcome.ok) {
        const attempts = store.recordPublicationError(publication.id, outcome.why, clock());
        report.problems.push(`publication ${publication.id}: ${outcome.why}`);
        if (attempts >= MAX_PUBLISH_ATTEMPTS) concede(store, publication, outcome.why, report, clock);
        continue;
      }
      if (outcome.adopted) report.adopted++;
      else report.opened++;
    }
  }

  return report;
}

/** Why a publication may not proceed — checked against the whole grant, per phase. */
export function permitsPublication(
  grant: PublicationGrant | null,
  publication: Pick<Publication, "githubRepo" | "remote" | "base" | "head" | "state">,
): { ok: true } | { ok: false; message: string } {
  if (grant === null) return { ok: false, message: "no live publication grant — nothing may be pushed" };
  if (grant.githubRepo !== publication.githubRepo || grant.remote !== publication.remote || grant.base !== publication.base) {
    return { ok: false, message: "the intent's terms no longer match the live grant" };
  }
  if (!publication.head.startsWith(grant.headPrefix)) {
    return { ok: false, message: `head ${publication.head} is outside the granted prefix ${grant.headPrefix}` };
  }
  const needs = publication.state === "intended" ? "push-branch" : "open-pr";
  if (!grant.capabilities.includes(needs as PublicationGrant["capabilities"][number])) {
    return { ok: false, message: `the grant does not include ${needs}` };
  }
  return { ok: true };
}

async function openOrAdopt(
  store: Store,
  publication: Publication,
  grant: PublicationGrant,
  exec: PublishExec,
  clock: () => Date,
): Promise<{ ok: true; adopted: boolean } | { ok: false; why: string }> {
  // Adopt first: a PR this head already has — whoever opened it, including
  // a crashed earlier attempt — is the PR. Creating a second would be the
  // duplicate the durable intent exists to prevent.
  const listed = await exec(
    "gh",
    [
      "pr", "list",
      "--repo", publication.githubRepo,
      "--head", publication.head,
      "--state", "open",
      "--json", "number,url",
    ],
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  if (listed.code !== 0) {
    return {
      ok: false,
      why: listed.notFound ? "gh is not on PATH" : firstLine(listed.stderr) || `gh pr list exited ${listed.code}`,
    };
  }
  let existing: { number: number; url: string }[];
  try {
    existing = JSON.parse(listed.stdout || "[]") as { number: number; url: string }[];
  } catch {
    return { ok: false, why: "gh pr list said something that is not JSON" };
  }
  const adopted = existing[0];
  if (adopted !== undefined) {
    store.markPublicationOpened(publication.id, adopted.number, adopted.url, clock());
    enqueueOpened(store, publication, adopted.url, clock);
    return { ok: true, adopted: true };
  }

  const body = publicationBody(store, publication);
  const taskId = store.externalIdFor(publication.taskRef) ?? publication.head;
  const title = store.getTask(taskId)?.title ?? taskId;
  // --body-file, not --body: the body quotes an agent and a shell must not
  // meet it. The file lives in a private temp dir for exactly one call.
  const dir = mkdtempSync(join(tmpdir(), "standing-orders-pr-"));
  try {
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, body, { mode: 0o600 });
    const created = await exec(
      "gh",
      [
        "pr", "create",
        "--repo", publication.githubRepo,
        "--base", publication.base,
        "--head", publication.head,
        "--title", `${taskId}: ${title}`.slice(0, 200),
        "--body-file", bodyFile,
        ...(publication.draft ? ["--draft"] : []),
      ],
      { timeoutMs: EXEC_TIMEOUT_MS, env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } },
    );
    if (created.code !== 0) {
      return { ok: false, why: firstLine(created.stderr) || `gh pr create exited ${created.code}` };
    }
    const url = firstLine(created.stdout);
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
    if (number === 0) return { ok: false, why: "gh pr create returned no PR URL" };
    store.markPublicationOpened(publication.id, number, url, clock());
    enqueueOpened(store, publication, url, clock);
    return { ok: true, adopted: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type CheckReport = {
  observed: number;
  failing: number;
  resolved: number;
  problems: string[];
};

/**
 * Read CI for every PR this control plane opened — structured rollup and the
 * exact head OID, never a command's exit status (finding 18). Episodes are
 * keyed `ci:<pr>:<headOid>`: a red head pages once; the episode resolves
 * when that exact head turns green or a newer commit supersedes it. `none`,
 * `running`, and not-read are never called green — an unread rollup neither
 * pages nor resolves anything.
 */
export async function observeChecks(
  store: Store,
  options: { clock?: () => Date; exec?: PublishExec },
): Promise<CheckReport> {
  const clock = options.clock ?? (() => new Date());
  const exec = options.exec ?? execRun;
  const report: CheckReport = { observed: 0, failing: 0, resolved: 0, problems: [] };

  for (const publication of store.openedPublications()) {
    if (publication.prNumber === null) continue;
    const viewed = await exec(
      "gh",
      [
        "pr", "view", String(publication.prNumber),
        "--repo", publication.githubRepo,
        "--json", "statusCheckRollup,headRefOid,state",
      ],
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (viewed.code !== 0) {
      report.problems.push(
        `PR #${publication.prNumber}: not read — ${viewed.notFound ? "gh is not on PATH" : firstLine(viewed.stderr) || `exit ${viewed.code}`}`,
      );
      continue;
    }
    let payload: { statusCheckRollup?: unknown; headRefOid?: unknown };
    try {
      payload = JSON.parse(viewed.stdout) as typeof payload;
    } catch {
      report.problems.push(`PR #${publication.prNumber}: not read — gh said something that is not JSON`);
      continue;
    }
    const headOid = typeof payload.headRefOid === "string" ? payload.headRefOid : null;
    if (headOid === null) {
      report.problems.push(`PR #${publication.prNumber}: not read — no head OID in the answer`);
      continue;
    }

    report.observed++;
    const state = summarizeChecks(payload.statusCheckRollup);
    const key = `ci:${publication.prNumber}:${headOid}`;
    const taskId = store.externalIdFor(publication.taskRef) ?? publication.head;

    if (state === "failing") {
      report.failing++;
      store.transact(() => {
        // Older heads' episodes die with their commits; this head's opens once.
        store.resolveCiEpisodes(publication.prNumber as number, key, clock());
        store.enqueueNotification(
          {
            dedupeKey: key,
            kind: "ci-failing",
            subject: `CI failing: ${taskId} (PR #${publication.prNumber})`,
            body: `${publication.prUrl ?? publication.githubRepo} — head ${headOid.slice(0, 12)} is red.`,
          },
          clock(),
        );
      });
    } else if (state === "passing") {
      report.resolved += store.resolveCiEpisodes(publication.prNumber, null, clock());
    } else {
      // running / none: not good news, not bad news — old episodes for
      // *other* heads still resolve (their commit is gone), this head's
      // verdict stays open.
      store.resolveCiEpisodes(publication.prNumber, key, clock());
    }
  }

  return report;
}

/** Retries are over; say so durably and page a person — silence is the one failure mode ruled out. */
function concede(
  store: Store,
  publication: Publication,
  why: string,
  report: PublishReport,
  clock: () => Date,
): void {
  store.transact(() => {
    store.failPublication(publication.id, clock());
    store.enqueueNotification(
      {
        dedupeKey: `publication:${publication.id}:failed`,
        kind: "publication-failed",
        subject: `publication of run #${publication.run} gave up`,
        body: `After ${MAX_PUBLISH_ATTEMPTS} attempts: ${why}. The commit ${publication.headSha} is safe locally; nothing was lost, nothing more will be pushed.`,
      },
      clock(),
    );
  });
  report.failed++;
}

function enqueueOpened(store: Store, publication: Publication, url: string, clock: () => Date): void {
  store.enqueueNotification(
    {
      dedupeKey: `publication:${publication.id}:opened`,
      kind: "publication-opened",
      subject: `PR ready: ${store.externalIdFor(publication.taskRef) ?? publication.head}`,
      body: url,
    },
    clock(),
  );
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}
