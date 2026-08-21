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

export const BODY_TEMPLATE_VERSION = 2;
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
/** One line of untrusted prose, kept inline: newlines flatten so no agent
 * text can START a Markdown line and gain semantics (audit IV-9) —
 * `Closes #123` at line start closes; mid-sentence it is words. */
function mdInline(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

/** Untrusted multi-line prose as an INDENTED code block: backticks cannot
 * terminate indentation, so no conclusion escapes its quoting (audit IV-9). */
function mdIndented(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map(line => `    ${line}`);
}

export function publicationBody(store: Store, publication: Publication): string {
  const run = store.getRun(publication.run);
  const taskId = store.externalIdFor(publication.taskRef) ?? "?";
  const task = taskId === "?" ? null : store.getTask(taskId);
  const scope = taskId === "?" ? null : store.getScope(taskId);
  const answers = store.answersFor(publication.run);

  const lines: string[] = [
    `## ${mdInline(task?.title ?? taskId)}`,
    "",
    ...(scope === null ? [] : [`**Goal:** ${mdInline(scope.goal)}`, ""]),
    `Built unattended by standing-orders (task \`${taskId}\`, run #${publication.run}).`,
    `Base \`${run?.baseRevision ?? "?"}\` → head \`${publication.headSha}\`.`,
  ];

  if (answers.length > 0) {
    lines.push("", "**Decisions a person answered along the way:**");
    for (const answer of answers) {
      lines.push(
        `- ${mdInline(answer.decision.question)} → **${mdInline(answer.choice)}** (${mdInline(answer.decision.answeredBy ?? "?")})`,
      );
    }
  }

  // The agent's own words ride INDENTED: an indented code block has no
  // terminator an agent's text could supply, so prose stays prose.
  if (run?.handoff !== null && run?.handoff !== undefined) {
    lines.push("", "**The agent's conclusion, quoted:**", "", ...mdIndented(run.handoff));
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
    // The secret gate (audit IV-7): a run whose accepted diff carried a
    // high-confidence secret shape publishes NOTHING — pushing the branch
    // would hand the credential to the remote. Fail closed, say why once,
    // and leave the person to rewrite the branch and requeue.
    if (store.hasRedactedTerminalDiff(publication.run)) {
      concede(store, publication, "the accepted diff carries a detected secret — rewrite the branch before anything publishes", report, clock);
      continue;
    }
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
      // The base filter (merge-grant finding 21): a same-head PR aimed at
      // a DIFFERENT base is not this publication's PR and must never be
      // adopted under authority granted for another branch.
      "--base", publication.base,
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
    // The observation generation is RESERVED before the network call
    // (merge grant, findings 20/24): a stalled older response loses its
    // conditional settle, and a loser has NO effects — not the mirror
    // row, not remote_state, not check state, not an episode.
    const generation = store.reserveObservation(publication.githubRepo, publication.prNumber);
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
    let payload: { statusCheckRollup?: unknown; headRefOid?: unknown; state?: unknown };
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

    // A merged or closed PR leaves the watch (Codex M5-M8 audit, C-6): its
    // remote state is recorded, its episodes resolve, and neither the
    // review queue nor the next observation pass carries it forever.
    const remoteState = typeof payload.state === "string" ? payload.state.toUpperCase() : null;
    if (remoteState === "MERGED" || remoteState === "CLOSED") {
      store.transact(() => {
        const settled = store.settleObservation(
          { githubRepo: publication.githubRepo, prNumber: publication.prNumber as number, headSha: headOid, state: "none", generation },
          clock(),
        );
        if (!settled.won) return;
        store.recordPublicationRemoteState(publication.id, remoteState, clock());
        report.resolved += store.resolveCiEpisodes(publication.githubRepo, publication.prNumber as number, null, clock());
        // A closed PR moots its merge blocker and supersedes its intent.
        store.liftMergeBlocker(publication.id);
        const intent = store.mergeIntentFor(publication.id);
        if (intent !== null && (intent.state === "pending" || intent.state === "claimed")) {
          store.settleMergeIntent(intent.id, intent.generation, remoteState === "MERGED" ? "merged" : "superseded", clock(), {
            receipt: `observed ${remoteState.toLowerCase()} remotely`,
          });
        }
      });
      continue;
    }

    const state = summarizeChecks(payload.statusCheckRollup);
    const settled = store.settleObservation(
      { githubRepo: publication.githubRepo, prNumber: publication.prNumber, headSha: headOid, state, generation },
      clock(),
    );
    if (!settled.won) {
      // An out-of-order response: a newer observation already spoke.
      // Nothing persists from this one (round-4 findings 24/25).
      report.problems.push(`PR #${publication.prNumber}: superseded observation discarded`);
      continue;
    }
    store.recordPublicationCheckState(publication.id, state, clock());
    // The episode identity carries the REPOSITORY (audit C-2): PR #55 in
    // repo A and PR #55 in repo B are different worlds, and one's failure
    // must never light the other's repair button.
    const key = `ci:${publication.githubRepo}:${publication.prNumber}:${headOid}`;
    const taskId = store.externalIdFor(publication.taskRef) ?? publication.head;

    if (state === "failing") {
      report.failing++;
      store.transact(() => {
        // Older heads' episodes die with their commits; this head's opens once.
        store.resolveCiEpisodes(publication.githubRepo, publication.prNumber as number, key, clock());
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
      report.resolved += store.resolveCiEpisodes(publication.githubRepo, publication.prNumber, null, clock());
    } else {
      // running / none: not good news, not bad news — old episodes for
      // *other* heads still resolve (their commit is gone), this head's
      // verdict stays open.
      store.resolveCiEpisodes(publication.githubRepo, publication.prNumber, key, clock());
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


// ---- the merge sweep (v21; four review rounds are the spec) ---------------

export const MERGE_LEASE_MS = 5 * 60_000;
export const MERGE_MAX_ATTEMPTS = 3;

/** The exact terms a merge intent binds - drift supersedes, never surprises. */
export function mergeTermsHash(grant: PublicationGrant): string {
  return createHash("sha256")
    .update(
      "merge-terms/v1 " + grant.githubRepo + " " + grant.base + " " + grant.headPrefix + " " + (grant.mergeMethod ?? "") + " " + (grant.mergeDeleteBranch === true ? 1 : 0),
    )
    .digest("hex");
}

export type MergeReport = { merged: number; refused: number; skipped: number; problems: string[] };

/** One fresh, WINNING observation - the only tuple that may authorize. */
async function observeOne(
  store: Store,
  exec: PublishExec,
  clock: () => Date,
  githubRepo: string,
  prNumber: number,
): Promise<{ ok: true; state: string; headSha: string } | { ok: false; why: string }> {
  const generation = store.reserveObservation(githubRepo, prNumber);
  const viewed = await exec(
    "gh",
    ["pr", "view", String(prNumber), "--repo", githubRepo, "--json", "statusCheckRollup,headRefOid,state,isDraft,baseRefName"],
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  if (viewed.code !== 0) return { ok: false, why: firstLine(viewed.stderr) || ("exit " + viewed.code) };
  let payload: { statusCheckRollup?: unknown; headRefOid?: unknown; state?: unknown; isDraft?: unknown; baseRefName?: unknown };
  try {
    payload = JSON.parse(viewed.stdout) as typeof payload;
  } catch {
    return { ok: false, why: "gh said something that is not JSON" };
  }
  const headSha = typeof payload.headRefOid === "string" ? payload.headRefOid : null;
  if (headSha === null) return { ok: false, why: "no head OID in the answer" };
  if (payload.isDraft === true) return { ok: false, why: "draft" };
  if (String(payload.state ?? "").toUpperCase() === "MERGED") return { ok: false, why: "pr-merged" };
  if (String(payload.state ?? "").toUpperCase() !== "OPEN") return { ok: false, why: "pr-" + String(payload.state ?? "gone").toLowerCase() };
  const state = summarizeChecks(payload.statusCheckRollup);
  const settled = store.settleObservation({ githubRepo, prNumber, headSha, state, generation }, clock());
  // A losing settle is NO observation (round-4 finding 24).
  if (!settled.won) return { ok: false, why: "stale-observation" };
  return { ok: true, state, headSha };
}

/** A COMPLETE negative proof that no merge queue governs the base - or no
 * merge (round-4 finding 22): every rules page, plus the classic-protection
 * probe with a STRUCTURED status; any classic protection at all, or any
 * unreadable answer, refuses merge-queue-unknown, fail closed. */
async function proveNoMergeQueue(
  exec: PublishExec,
  githubRepo: string,
  base: string,
): Promise<{ ok: true } | { ok: false; why: "merge-queue" | "merge-queue-unknown" }> {
  const rules = await exec(
    "gh",
    ["api", "--paginate", "--slurp", "repos/" + githubRepo + "/rules/branches/" + encodeURIComponent(base)],
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  if (rules.code !== 0) return { ok: false, why: "merge-queue-unknown" };
  try {
    const pages = JSON.parse(rules.stdout) as unknown;
    if (!Array.isArray(pages)) return { ok: false, why: "merge-queue-unknown" };
    const flat = (pages as unknown[]).flat();
    for (const rule of flat) {
      if (typeof rule === "object" && rule !== null && (rule as Record<string, unknown>)["type"] === "merge_queue") {
        return { ok: false, why: "merge-queue" };
      }
    }
  } catch {
    return { ok: false, why: "merge-queue-unknown" };
  }
  // Classic protection: the endpoint cannot PROVE queue absence, so any
  // 200 refuses conservatively; only a structured 404 is a readable "no".
  const classic = await exec(
    "gh",
    ["api", "--include", "repos/" + githubRepo + "/branches/" + encodeURIComponent(base) + "/protection"],
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  const statusLine = classic.stdout.split("\n")[0] ?? "";
  if (classic.code === 0 && /^HTTP\/[\d.]+ 200/.test(statusLine)) return { ok: false, why: "merge-queue-unknown" };
  if (/^HTTP\/[\d.]+ 404/.test(statusLine) || /HTTP 404/.test(firstLine(classic.stderr))) return { ok: true };
  return { ok: false, why: "merge-queue-unknown" };
}

/**
 * Merge what the grant allows and the evidence proves: this plane's own
 * publications, on this repo, whose PR was OBSERVED green on the exact
 * head - through a claim lease, a live-grant re-read, the queue proof,
 * and GitHub's own head CAS. Every refusal is typed and durable.
 */
export async function sweepMerges(
  store: Store,
  options: { repo: string; runner?: string; clock?: () => Date; exec?: PublishExec },
): Promise<MergeReport> {
  const clock = options.clock ?? (() => new Date());
  const exec = options.exec ?? execRun;
  const who = options.runner ?? "publish";
  const report: MergeReport = { merged: 0, refused: 0, skipped: 0, problems: [] };
  const page = (key: string, subject: string, body: string): void => {
    store.enqueueNotification({ dedupeKey: key, kind: "merge", subject, body }, clock());
  };

  const grant = store.publicationGrantFor(options.repo);
  if (grant === null || grant.merge !== true || grant.mergeMethod == null) return report;
  const method = grant.mergeMethod;
  const termsHash = mergeTermsHash(grant);

  for (const publication of store.openedPublications()) {
    if (publication.prNumber === null || publication.headSha === null) continue;
    const prNumber = publication.prNumber;
    const headSha = publication.headSha;
    // The local-repo fence (finding 6): repo B's publication never rides
    // repo A's sweep, whatever the remote terms coincide on.
    const ref = store.refForId(publication.taskRef);
    if (ref === null || ref.repo !== options.repo) continue;
    if (publication.githubRepo !== grant.githubRepo) continue;

    const blocker = store.mergeBlockerFor(publication.id);
    if (blocker !== null) {
      report.skipped++;
      page(
        "merge:" + publication.id + ":blocked",
        "PR #" + prNumber + " holds for a repair",
        "A CI repair (" + (blocker.taskId ?? "?") + ") is in flight. It merges nothing until you lift it: standing-orders publish unblock " + prNumber + ".",
      );
      continue;
    }

    store.createMergeIntent(
      { publication: publication.id, grantTermsHash: termsHash, headSha, method, deleteBranch: grant.mergeDeleteBranch === true },
      clock(),
    );
    const intent = store.mergeIntentFor(publication.id);
    if (intent === null || intent.state === "merged" || intent.state === "refused" || intent.state === "superseded") continue;

    const claim = store.claimMergeIntent(intent.id, who, MERGE_LEASE_MS, clock());
    if (claim === null) continue; // someone else's live claim
    const settle = (state: "merged" | "refused" | "superseded" | "pending", detail: { error?: string | null; receipt?: string | null; countAttempt?: boolean } = {}) =>
      store.settleMergeIntent(intent.id, claim.generation, state, clock(), detail);

    // The live grant, re-read AFTER the claim (finding 7): revocation,
    // narrowing, or any term drift supersedes rather than merges.
    const live = store.publicationGrantFor(options.repo);
    if (live === null || live.merge !== true || mergeTermsHash(live) !== termsHash || intent.headSha !== headSha) {
      settle("superseded", { error: "the grant or the head moved since this intent was written" });
      continue;
    }

    const queue = await proveNoMergeQueue(exec, grant.githubRepo, grant.base);
    if (!queue.ok) {
      settle("refused", { error: queue.why });
      report.refused++;
      page(
        "merge:" + publication.id + ":" + queue.why,
        "PR #" + prNumber + " will not auto-merge",
        queue.why === "merge-queue"
          ? "The base branch requires a merge queue - out of this release's scope. Merge it on GitHub, or lift the queue and run: standing-orders publish rearm " + prNumber + "."
          : "The branch's protection could not be READ well enough to prove no merge queue governs it - auto-merge stays paused. Check access, then run: standing-orders publish rearm " + prNumber + ".",
      );
      continue;
    }

    // One fresh, winning observation - green on the EXACT publication head.
    const seen = await observeOne(store, exec, clock, grant.githubRepo, prNumber);
    if (!seen.ok) {
      if (seen.why === "draft") {
        settle("refused", { error: "draft" });
        report.refused++;
        page(
          "merge:" + publication.id + ":draft",
          "PR #" + prNumber + " is a draft",
          "Drafts never merge themselves. Mark it ready on GitHub, then run: standing-orders publish rearm " + prNumber + ".",
        );
      } else if (seen.why.startsWith("pr-")) {
        settle("superseded", { error: seen.why });
      } else {
        settle("pending");
        report.problems.push("PR #" + prNumber + ": " + seen.why);
      }
      continue;
    }
    if (seen.headSha !== headSha || seen.state !== "passing") {
      settle(seen.headSha !== headSha ? "superseded" : "pending", {
        error: seen.headSha !== headSha ? "the head moved" : "CI is " + seen.state + ", not green",
      });
      continue;
    }

    // The last fence before the external call: renew + generation re-proof.
    if (!store.renewMergeClaim(intent.id, claim.generation, MERGE_LEASE_MS, clock())) continue;

    const merged = await exec(
      "gh",
      [
        "pr", "merge", String(prNumber),
        "--repo", grant.githubRepo,
        "--" + method,
        "--match-head-commit", headSha,
        ...(grant.mergeDeleteBranch === true ? ["--delete-branch"] : []),
      ],
      { timeoutMs: EXEC_TIMEOUT_MS },
    );

    if (merged.code === 0) {
      store.transact(() => {
        settle("merged", { receipt: "merged " + headSha.slice(0, 12) + " at " + clock().toISOString(), countAttempt: true });
        store.recordPublicationRemoteState(publication.id, "MERGED", clock());
        store.resolveCiEpisodes(grant.githubRepo, prNumber, null, clock());
      });
      report.merged++;
      page(
        "merge:" + publication.id + ":merged",
        "merged: PR #" + prNumber,
        (publication.prUrl ?? grant.githubRepo) + " - " + method + " of " + headSha.slice(0, 12) + ", under the merge terms you approved.",
      );
      continue;
    }

    // NEVER classify from the exit code alone (only auth=4 is distinct):
    // re-read structured state and let the PR say what happened.
    if (merged.code === 4) {
      settle("refused", { error: "credential", countAttempt: true });
      report.refused++;
      page(
        "merge:" + publication.id + ":credential",
        "PR #" + prNumber + ": gh is not signed in",
        "The merge acts as this machine's GitHub account, and it could not authenticate. Run gh auth login, then: standing-orders publish rearm " + prNumber + ".",
      );
      continue;
    }
    const after = await observeOne(store, exec, clock, grant.githubRepo, prNumber);
    if (!after.ok && after.why === "pr-merged") {
      settle("merged", { receipt: "merged (confirmed by re-read after an ambiguous exit)", countAttempt: true });
      report.merged++;
    } else if (!after.ok && (after.why === "draft" || after.why.startsWith("pr-"))) {
      settle(after.why === "draft" ? "refused" : "superseded", { error: after.why, countAttempt: true });
      if (after.why === "draft") report.refused++;
    } else if (after.ok && after.headSha !== headSha) {
      settle("superseded", { error: "the head moved during the attempt", countAttempt: true });
    } else if (intent.attempts + 1 >= MERGE_MAX_ATTEMPTS) {
      settle("refused", { error: firstLine(merged.stderr) || "the merge was rejected", countAttempt: true });
      report.refused++;
      page(
        "merge:" + publication.id + ":rejected",
        "PR #" + prNumber + " would not merge",
        (firstLine(merged.stderr) || "GitHub rejected the merge") + " - likely branch protection, required reviews, or a conflict. Fix the cause, then run: standing-orders publish rearm " + prNumber + ".",
      );
    } else {
      settle("pending", { error: firstLine(merged.stderr) || "transport", countAttempt: true });
    }
  }
  return report;
}
