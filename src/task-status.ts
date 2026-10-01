/** One answer per task, then the details (docs/design/task-status.md). Every
 * surface — the Tasks list, the task page, the build page, Crew, the Chat
 * result, the Telegram/Slack/Discord/Teams cards and `toolroll status` — reads
 * its headline, sentence, tone and detail rows from `taskStatusOf`, so the
 * words cannot drift apart again. Pure: it reads facts the existing
 * projections already recorded and never changes a check, approval or
 * completion.
 *
 * Severity: red belongs to the Failed headline alone. A detail problem that
 * doesn't undo the outcome (a pull request that couldn't open, shortened
 * output) is an amber note on its own row with one action; the exact
 * technical reason stays one tap away in `why`. */
import type { AssignmentSnapshot } from "./assignment.js";

/** A cancelled task with a successor reads "Replaced by <id>" everywhere, never "Cancelled". */
export const replacedWords = (successor: string): string => `Replaced by ${successor}`;
const REPLACED = /^Replaced by \S+/;
export const HEADLINES = ["Queued", "Planning", "Needs you", "Building", "Built, not checked", "Ready for review", "Complete", "Failed", "Stopped"] as const;
export type Headline = (typeof HEADLINES)[number];
export type HeadlineTone = "neutral" | "live" | "attention" | "ready" | "success" | "danger";
export const HEADLINE_TONE: Readonly<Record<Headline, HeadlineTone>> = {
  Queued: "neutral", Planning: "live", "Needs you": "attention", Building: "live",
  "Built, not checked": "neutral", "Ready for review": "ready", Complete: "success", Failed: "danger", Stopped: "neutral",
};

export type DetailKey = "checks" | "pull-request" | "requirements" | "evidence";
/** The row's small icon: the only coloured part of a detail. `failed` is red
 * and only ever appears under the Failed headline; `note` is amber. */
export type DetailMark = "ok" | "running" | "none" | "note" | "failed";
export type StatusAction = { label: string; href: string | null };
export type StatusDetail = { key: DetailKey; label: string; text: string; mark: DetailMark; href: string | null; action: StatusAction | null; why: string | null };
export type TaskStatus = { headline: Headline; tone: HeadlineTone; sentence: string; details: StatusDetail[]; primaryAction: StatusAction | null; why: string[] };

export type TaskStage = "queued" | "planning" | "needs-you" | "building" | "checking" | "finished" | "complete" | "failed" | "stopped";
export type ChecksFact = {
  status: "passed" | "failed" | "running" | "not-run" | "unavailable"; exitCode: number | null; head: string | null;
  /** The check level that ran (check-levels.ts). Off never reads Ready; a quick pass says so. */
  level?: "quick" | "full" | "off" | null;
  /** A follow-up check (Run checks) waiting or running on this commit. */
  running?: "quick" | "full" | null;
};
export type PullRequestFact = {
  state: "none" | "opening" | "open" | "merged" | "closed" | "failed";
  number: number | null; url: string | null; ci: "running" | "passing" | "failing" | null; error: string | null;
  /** GitHub's compare page for the pushed branch: where a person opens it by hand. */
  compareUrl?: string | null;
  /** Who merged it and its merge commit, shown on request. */
  note?: string | null;
};
export type TaskStatusFacts = {
  stage: TaskStage;
  /** Needs you: what a person is asked for. The sentence names it. */
  need?: "approval" | "answer" | "sign-in" | "other";
  /** The recorded reason in plain words, when the stage has one. */
  reason?: string | null;
  /** A research report rather than a code change. */
  report?: boolean;
  checks?: ChecksFact | null;
  pullRequest?: PullRequestFact | null;
  requirements?: { met: number; total: number; yours: number } | null;
  evidence?: { shortened: number; missing: number; damaged: number } | null;
  completedBy?: string | null;
  action?: StatusAction | null;
  /** Where a row's one action leads: the result (and its Checks tab), the task's pull request, Run checks. */
  links?: { result?: string | null; checks?: string | null; pullRequest?: string | null; runChecks?: string | null };
  /** Exact technical reasons, shown only on request. */
  why?: readonly string[];
};

const short = (sha: string | null): string | null => sha !== null && /^[a-f0-9]{7,40}$/.test(sha) ? sha.slice(0, 7) : null;

export function headlineOf(facts: Pick<TaskStatusFacts, "stage" | "checks" | "report">): Headline {
  switch (facts.stage) {
    case "queued": return "Queued";
    case "planning": return "Planning";
    case "needs-you": return "Needs you";
    case "building": case "checking": return "Building";
    case "finished":
      if (facts.report) return "Ready for review";
      if (facts.checks?.status === "failed") return "Failed";
      // Off: built, and nothing checked it. Never Ready until a check passes.
      return facts.checks?.level === "off" && facts.checks.status !== "passed" ? "Built, not checked" : "Ready for review";
    case "complete": return "Complete";
    case "failed": return "Failed";
    case "stopped": return "Stopped";
  }
}

function sentenceOf(headline: Headline, facts: TaskStatusFacts): string {
  const reason = facts.reason?.trim() || null;
  const sha = short(facts.checks?.head ?? null);
  switch (headline) {
    case "Queued": return reason ?? "Waiting for a worker.";
    case "Planning": return reason ?? "The lead is writing the plan.";
    // An approval always reads the same way; the plan itself names the work.
    case "Needs you": return facts.need === "approval" ? "Review the plan and approve it to start." : reason ?? (facts.need === "answer" ? "Answer the question so the work can continue."
      : facts.need === "sign-in" ? "Sign in again; the task starts on its own after."
      : "Something needs your decision before the work can continue.");
    case "Building": return facts.stage === "checking" ? "Checks are running on the change." : reason ?? "An agent is working on it.";
    case "Built, not checked": return "Checks were off for this build. Review the change, or run checks first.";
    case "Ready for review":
      if (facts.report) return "The report is ready to read. Read it, then mark it complete.";
      if (facts.checks?.status === "passed") return `${facts.checks.level === "quick" ? "Quick checks" : "Checks"} passed${sha === null ? "" : ` on ${sha}`}. Review the change, then mark it complete.`;
      // Never claim a check that isn't known to have passed.
      if (facts.checks == null) return "Review the change, then mark it complete.";
      return "Built without a passing project check. Review the change, then mark it complete.";
    case "Complete": {
      const by = facts.completedBy ? `Marked complete by ${facts.completedBy}.` : "Marked complete.";
      const pr = facts.pullRequest;
      return pr?.state === "merged" ? `${by} ${pr.number === null ? "Its pull request" : `Pull request #${pr.number}`} merged.` : by;
    }
    case "Failed":
      if (facts.checks?.status === "failed") return `${facts.checks.level === "quick" ? "Quick checks" : "Checks"} failed${sha === null ? "" : ` on ${sha}`}. See what broke, then retry or ask for changes.`;
      return reason ?? "The last attempt stopped before it finished. Review it, then retry.";
    case "Stopped": return reason ?? "Stopped by a person. The work so far is kept.";
  }
}

/** A detail problem: red only under Failed, otherwise an amber note. */
const problem = (headline: Headline): DetailMark => headline === "Failed" ? "failed" : "note";

function detailsOf(headline: Headline, facts: TaskStatusFacts): StatusDetail[] {
  const rows: StatusDetail[] = [];
  const row = (key: DetailKey, label: string, text: string, mark: DetailMark, extra: Partial<Pick<StatusDetail, "href" | "action" | "why">> = {}) =>
    rows.push({ key, label, text, mark, href: extra.href ?? null, action: extra.action ?? null, why: extra.why ?? null });
  const checks = facts.checks;
  if (checks != null && !facts.report) {
    const sha = short(checks.head);
    const checksHref = facts.links?.checks ?? facts.links?.result ?? null;
    const runChecks = facts.links?.runChecks === undefined ? null : { label: "Run checks", href: facts.links.runChecks };
    const quick = checks.level === "quick";
    if (checks.running != null) row("checks", "Checks", `${checks.running === "quick" ? "Quick" : "Full"} checks running`, "running", { href: checksHref });
    else if (checks.status === "passed") row("checks", "Checks", `${quick ? "Quick checks passed" : "Passed"}${sha === null ? "" : ` on ${sha}`}`, "ok",
      quick && runChecks !== null && headline !== "Complete" ? { href: checksHref, action: { label: "Run full checks", href: runChecks.href } } : { href: checksHref });
    else if (checks.status === "failed") row("checks", "Checks", `${quick ? "Quick checks failed" : "Failed"}${checks.exitCode === null ? "" : ` (exit ${checks.exitCode})`}`, problem(headline),
      headline === "Failed" ? { href: checksHref } : { action: { label: "See what failed", href: checksHref } });
    else if (checks.status === "running") row("checks", "Checks", "Running", "running");
    else if (checks.level === "off") row("checks", "Checks", "Off", "none", runChecks === null ? {} : { action: runChecks });
    else if (checks.status === "not-run") row("checks", "Checks", "Didn't run", "none", runChecks === null ? {} : { action: runChecks });
    else row("checks", "Checks", "Couldn't be read", "note", { action: { label: "Open the result", href: facts.links?.result ?? null } });
  }
  const pr = facts.pullRequest;
  if (pr != null) {
    const name = pr.number === null ? "Pull request" : `#${pr.number}`;
    const github = pr.url !== null && /^https:\/\/github\.com\//.test(pr.url) ? pr.url : null;
    if (pr.state === "none") row("pull-request", "Pull request", "None", "none");
    else if (pr.state === "opening") row("pull-request", "Pull request", "Opening…", "running", { why: pr.error });
    else if (pr.state === "merged") row("pull-request", "Pull request", `${name} merged`, "ok", { href: github, why: pr.note ?? null });
    else if (pr.state === "closed") row("pull-request", "Pull request", `${name} closed without merging`, "none", { href: github });
    else if (pr.state === "failed") row("pull-request", "Pull request", "Couldn't open", "note",
      { action: pr.compareUrl ? { label: "Open it on GitHub", href: pr.compareUrl } : { label: "See why", href: facts.links?.pullRequest ?? null }, why: pr.error === null ? "Publishing gave up. The commit is safe locally." : `${pr.error} The commit is safe locally.` });
    else if (pr.ci === "running") row("pull-request", "Pull request", `${name} open, CI running`, "running", { href: github });
    else if (pr.ci === "passing") row("pull-request", "Pull request", `${name} open, CI passed`, "ok", { href: github });
    else if (pr.ci === "failing") row("pull-request", "Pull request", `${name} open, CI failing`, "note", { action: { label: "Open it on GitHub", href: github } });
    else row("pull-request", "Pull request", `${name} open`, "none", { href: github });
  }
  const req = facts.requirements;
  if (req != null && req.total > 0) {
    const unmet = req.total - req.met - req.yours;
    const text = `${req.met} of ${req.total} met${req.yours > 0 ? ` · You check ${req.yours}` : ""}`;
    row("requirements", "Requirements", text, unmet > 0 ? problem(headline) : req.met === req.total ? "ok" : "none",
      unmet > 0 && headline !== "Failed" ? { action: { label: "See which", href: facts.links?.checks ?? facts.links?.result ?? null } } : {});
  }
  const evidence = facts.evidence;
  if (evidence != null) {
    const action = { label: "See what was kept", href: facts.links?.result ?? null };
    if (evidence.damaged > 0) row("evidence", "Saved evidence", "Some saved files changed", problem(headline), headline === "Failed" ? {} : { action });
    else if (evidence.missing > 0) row("evidence", "Saved evidence", "Some saved files are missing", problem(headline), headline === "Failed" ? {} : { action });
    else if (evidence.shortened > 0) row("evidence", "Saved evidence", "Some output shortened", "note", { action });
    else row("evidence", "Saved evidence", "Complete", "ok");
  }
  return rows;
}

export function taskStatusOf(facts: TaskStatusFacts): TaskStatus {
  const headline = headlineOf(facts);
  return { headline, tone: HEADLINE_TONE[headline], sentence: sentenceOf(headline, facts), details: detailsOf(headline, facts),
    primaryAction: facts.action ?? null, why: [...new Set(facts.why ?? [])].filter(one => one.trim() !== "") };
}

// ---- reading the existing projections ----------------------------------------

/** Every dispatch or work-index code, as the stage it means. Unknown codes that
 * wait on a person stay Needs you; everything else waits in the queue. */
const CODE_STAGE: Readonly<Record<string, [TaskStage, TaskStatusFacts["need"]?]>> = {
  queued: ["queued"], ready: ["queued"], "worker-at-capacity": ["queued"], "retry-scheduled": ["queued"], updating: ["queued"],
  "waiting-dependency": ["queued"], "scouting-ready": ["queued"], "planning-ready": ["queued"], "provider-quota": ["queued"], "planner-source": ["queued"],
  running: ["building"], reviewing: ["building"], "review-pending": ["building"],
  "signed-out": ["needs-you", "sign-in"],
  "needs-approval": ["needs-you", "approval"],
  "waiting-decision": ["needs-you", "answer"], "decision-queue": ["needs-you", "answer"],
  stopping: ["stopped"], stopped: ["stopped"], paused: ["stopped"], cancelled: ["stopped"],
  failed: ["failed"], "waiting-incident": ["failed"], "checks-failed": ["failed"],
  "ready-to-check": ["finished"], "ready-to-review": ["finished"], "report-ready": ["finished"], "no-change": ["finished"],
  "pr-opened": ["finished"], "merge-observed": ["finished"], "pr-closed": ["finished"], "agent-attested": ["finished"], "accepted-exception": ["finished"],
  complete: ["complete"],
};

/** Queue reasons worth a sentence of their own; any other queued or
 * building reason is scheduler wording, and the default sentence is plainer. */
const QUEUED_REASONS = new Set(["worker-at-capacity", "waiting-dependency", "retry-scheduled", "updating", "planning-ready", "scouting-ready", "provider-quota"]);
export function plainReasonOf(stage: TaskStage, code: string, detail: string | null | undefined): string | null {
  if (stage === "building" || stage === "checking" || stage === "planning") return null;
  if (stage === "queued") return QUEUED_REASONS.has(code) ? detail ?? null : null;
  return detail ?? null;
}

export function stageOfCode(code: string, options: { needsPerson?: boolean; planning?: boolean; operatorHold?: boolean } = {}): { stage: TaskStage; need?: TaskStatusFacts["need"] } {
  if (code === "running" && options.planning) return { stage: "planning" };
  if (code === "held") return options.operatorHold === false ? { stage: "needs-you", need: "other" } : { stage: "stopped" };
  const known = CODE_STAGE[code];
  if (known !== undefined) return known[1] === undefined ? { stage: known[0] } : { stage: known[0], need: known[1] };
  return options.needsPerson === false ? { stage: "queued" } : { stage: "needs-you", need: "other" };
}

/** The pull request as the task page's follower reports it, or the bare publication row. */
export function pullRequestFactOf(publication: { state: string; prNumber?: number | null; prUrl: string | null; remoteState: string | null; lastCheckState?: string | null; lastError?: string | null; merged?: boolean;
  githubRepo?: string; base?: string; head?: string } | null): PullRequestFact | null {
  if (publication === null) return null;
  const safe = (part: string | undefined) => part !== undefined && /^[A-Za-z0-9_.\/-]+$/.test(part) && !part.includes("..") ? part : null;
  const repo = safe(publication.githubRepo), from = safe(publication.base), to = safe(publication.head);
  const compareUrl = repo !== null && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && from !== null && to !== null ? `https://github.com/${repo}/compare/${from}...${to}?expand=1` : null;
  const seen = publication.lastCheckState;
  const ci: PullRequestFact["ci"] = seen === "running" || seen === "passing" || seen === "failing" ? seen : null;
  const fromUrl = /\/pull\/(\d+)$/.exec(publication.prUrl ?? "");
  const number = publication.prNumber ?? (fromUrl === null ? null : Number(fromUrl[1]));
  const base = { number, url: publication.prUrl, ci, error: publication.lastError ?? null, compareUrl };
  if (publication.merged === true || publication.remoteState === "MERGED") return { ...base, state: "merged" };
  if (publication.remoteState === "CLOSED") return { ...base, state: "closed" };
  if (publication.state === "failed") return { ...base, state: "failed" };
  if (publication.state === "opened") return { ...base, state: "open" };
  return { ...base, state: "opening" };
}

/** The assignment's stage. The work status, when the caller read one, names
 * the exact reason (a running planner, a pause, a failed attempt, a sign-in). */
export function assignmentStageOf(assignment: Pick<AssignmentSnapshot, "state" | "primaryAction">, work?: { token: string; views?: readonly string[] } | null, planning = false): { stage: TaskStage; need?: TaskStatusFacts["need"] } {
  switch (assignment.state) {
    case "cancelled": return { stage: "stopped" };
    case "complete": return { stage: "complete" };
    case "ready-to-check": return { stage: "finished" };
    case "checking": return { stage: "checking" };
    case "working": {
      const token = work?.token ?? "running";
      const read = stageOfCode(token, { needsPerson: work?.views?.includes("needs-you") ?? false, planning });
      return read.stage === "finished" || read.stage === "complete" ? { stage: "building" } : read;
    }
    case "needs-decision": {
      const action = assignment.primaryAction?.code;
      if (action === "approve-scope") return { stage: "needs-you", need: "approval" };
      if (action === "answer-decision" || action === "inspect-decisions") return { stage: "needs-you", need: "answer" };
      const token = work?.token ?? "";
      // A failed attempt is Failed. A saved result that still needs a decision
      // (its scope, a hold, a process exit) is Needs you, even if its checks
      // failed: the decision is the next step, and the Checks row says the rest.
      if (token === "failed" || token === "waiting-incident") return { stage: "failed" };
      const read = stageOfCode(token, { needsPerson: true, operatorHold: action === "unhold" });
      return read.stage === "stopped" ? read : { stage: "needs-you", need: read.need ?? "other" };
    }
  }
}

/** Requirements from the stored matrix: met, the ones only a person confirms, and the total. */
export function requirementsOf(matrix: readonly { state: string; assessment?: { evidenceState?: string } | undefined; review?: unknown }[] | null | undefined): NonNullable<TaskStatusFacts["requirements"]> | null {
  if (!matrix || matrix.length === 0) return null;
  // Evidence that passed and only awaits the retired assessment step is met.
  const met = (row: (typeof matrix)[number]) => row.state === "pass" || (row.assessment?.evidenceState === "pass" && (row.review ?? null) === null);
  return { met: matrix.filter(met).length, total: matrix.length, yours: matrix.filter(row => !met(row) && row.state === "manual-review").length };
}

/** Saved evidence health from the receipt's artifact list and its caveats. */
export function evidenceOf(receipt: AssignmentSnapshot["receipt"], problems: readonly string[] = receipt?.caveats ?? []): NonNullable<TaskStatusFacts["evidence"]> | null {
  if (receipt === null) return null;
  const shortened = receipt.artifacts.filter(one => !one.complete).length + problems.filter(one => /shortened|cut short/.test(one)).length;
  const damaged = problems.filter(one => /unavailable or changed|no longer verif|cannot be read|could not be read|failed capture|altered|damaged/i.test(one)).length;
  const missing = problems.filter(one => /missing|ambiguous|no longer exists/i.test(one) && !/unavailable or changed/.test(one)).length;
  return { shortened, missing, damaged };
}

/** The status facts of one assignment, as every surface reads them. */
export function assignmentStatusFacts(assignment: AssignmentSnapshot, options: {
  work?: { token: string; views?: readonly string[]; detail?: string } | null; planning?: boolean;
  pullRequest?: PullRequestFact | null; action?: StatusAction | null; links?: TaskStatusFacts["links"];
  evidence?: TaskStatusFacts["evidence"]; why?: readonly string[];
} = {}): TaskStatusFacts {
  const { stage, need } = assignmentStageOf(assignment, options.work ?? null, options.planning ?? false);
  const receipt = assignment.receipt;
  const finished = stage === "finished" || stage === "complete";
  // A saved result's rows show whenever it is the reason a person is needed, too.
  const withResult = finished || stage === "failed" || (stage === "needs-you" && receipt !== null);
  const report = receipt?.completionKind === "research-report";
  const checks: ChecksFact | null = receipt === null || !withResult ? null
    : { status: receipt.checks.status, exitCode: receipt.checks.exitCode, head: receipt.head,
      ...(receipt.checks.level == null ? {} : { level: receipt.checks.level }), ...(receipt.checks.running == null ? {} : { running: receipt.checks.running }) };
  const publication = assignment.publication;
  const pullRequest = options.pullRequest !== undefined ? options.pullRequest
    : publication === null ? (withResult && !report ? { state: "none" as const, number: null, url: null, ci: null, error: null } : null)
    : pullRequestFactOf(publication);
  // Ready, Complete and Failed speak for themselves; every other stage keeps its recorded reason.
  const reason = stage === "needs-you" || stage === "stopped" || stage === "queued" || (stage === "failed" && checks?.status !== "failed")
    ? stage === "stopped" && assignment.state === "cancelled" ? REPLACED.test(assignment.detail) ? assignment.detail : "Cancelled. Nothing else will run." : plainReasonOf(stage, options.work?.token ?? "", options.work?.detail ?? assignment.detail)
    : null;
  return {
    stage, ...(need === undefined ? {} : { need }), reason, report,
    checks,
    pullRequest: withResult ? pullRequest : null,
    requirements: withResult ? requirementsOf(receipt?.proof?.matrix) : null,
    evidence: withResult ? options.evidence ?? evidenceOf(receipt, [...(receipt?.caveats ?? []), ...assignment.attention]) : null,
    completedBy: assignment.completion === null ? null : assignment.completion.lead === true ? "the lead" : assignment.completion.actor.replace(/^(?:operator|coordinator|lead):/, ""),
    action: options.action ?? null,
    ...(options.links === undefined ? {} : { links: options.links }),
    why: options.why ?? [],
  };
}

// ---- rendering helpers shared by the server pages and chat cards ------------

/** The legacy work tone each headline wears where a surface still keys off StatusTone. */
export function workToneOf(headline: Headline): "attention" | "problem" | "live" | "ready" | "done" | "muted" {
  switch (headline) {
    case "Needs you": return "attention";
    case "Failed": return "problem";
    case "Building": case "Planning": return "live";
    case "Ready for review": return "ready";
    case "Built, not checked": return "muted";
    case "Complete": return "done";
    default: return "muted";
  }
}

/** One plain-text line per detail for chat cards: an icon, the label, the words. */
export function statusDetailLines(status: TaskStatus): string[] {
  const icon: Record<DetailMark, string> = { ok: "✓", running: "●", none: "○", note: "⚠", failed: "✕" };
  return status.details.map(one => `${icon[one.mark]} ${one.label} · ${one.text}${one.action === null ? "" : ` — ${one.action.label}`}`);
}

/** The headline's emoji for chat cards (colour is never the only signal: the words follow). */
export function headlineEmoji(headline: Headline): string {
  return ({ Queued: "🕓", Planning: "📝", "Needs you": "👋", Building: "⏳", "Built, not checked": "🔨", "Ready for review": "✅", Complete: "✅", Failed: "❌", Stopped: "⏹" } as const)[headline];
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const ICON_PATHS: Record<DetailMark, string> = {
  ok: `<path d="M20 6 9 17l-5-5"/>`,
  running: `<circle cx="12" cy="12" r="4"/>`,
  none: `<circle cx="12" cy="12" r="3"/>`,
  note: `<path d="M12 8v5"/><path d="M12 16.5h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>`,
  failed: `<path d="M18 6 6 18M6 6l12 12"/>`,
};
export const statusIconSvg = (mark: DetailMark): string =>
  `<svg class="status-icon status-icon--${mark}" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[mark]}</svg>`;

/** The detail rows as server HTML: quiet rows, colour only on the icon. */
export function statusDetailsHtml(status: TaskStatus): string {
  if (status.details.length === 0) return "";
  return `<ul class="status-details" aria-label="Details">` + status.details.map(one => {
    const text = one.href === null ? escapeHtml(one.text) : `<a href="${escapeHtml(one.href)}">${escapeHtml(one.text)}</a>`;
    const action = one.action === null ? "" : one.action.href === null ? `<span class="status-detail-act">${escapeHtml(one.action.label)}</span>` : `<a class="status-detail-act" href="${escapeHtml(one.action.href)}">${escapeHtml(one.action.label)}</a>`;
    return `<li class="status-detail status-detail--${one.mark}" data-status-detail="${one.key}" data-mark="${one.mark}">${statusIconSvg(one.mark)}<span class="status-detail-label">${escapeHtml(one.label)}</span><span class="status-detail-text"><span>${text}</span>${action}</span></li>`;
  }).join("") + `</ul>`;
}

/** The technical reasons, one tap away. */
export function statusWhyHtml(status: TaskStatus, extra: readonly string[] = [], diagnostics: readonly { token: string; label: string; detail: string }[] = []): string {
  const lines = [...new Set([...status.details.flatMap(one => one.why === null ? [] : [`${one.label}: ${one.why}`]), ...status.why, ...extra])];
  if (lines.length === 0 && diagnostics.length === 0) return "";
  return `<details class="status-why"><summary>Details</summary>${lines.map(one => `<p class="meta">${escapeHtml(one)}</p>`).join("")}` +
    diagnostics.map(one => `<p class="meta" data-work-diagnostic="${escapeHtml(one.token)}">${escapeHtml(one.label)} · ${escapeHtml(one.detail)}</p>`).join("") + `</details>`;
}

/** Shared CSS for the server-rendered status: neutral rows, coloured icons. */
export const TASK_STATUS_CSS = `.status-headline{display:flex;align-items:center;gap:.6rem;margin:0;font-size:1.125rem;font-weight:600;color:var(--foreground)}.status-headline i{width:.625rem;height:.625rem;border-radius:999px;flex-shrink:0;background:var(--muted-foreground)}[data-headline-tone=live] .status-headline i{background:var(--so-info,#0d74ce)}[data-headline-tone=attention] .status-headline i{background:var(--so-attention,var(--attention))}[data-headline-tone=ready] .status-headline i{background:transparent;box-shadow:inset 0 0 0 2px var(--so-success,#218358)}[data-headline-tone=success] .status-headline i{background:var(--so-success,#218358)}[data-headline-tone=danger] .status-headline i{background:var(--so-danger,#c4320a)}.status-sentence{margin:.35rem 0 0;color:var(--muted-foreground)}.status-details{list-style:none;margin:.75rem 0 0;padding:.25rem 0 0;border-top:1px solid var(--so-line,var(--border))}.status-detail{display:grid;grid-template-columns:14px 7.5rem minmax(0,1fr);align-items:center;gap:.6rem;padding:.4rem 0;font-size:.8125rem;color:var(--foreground)}.status-detail .status-icon{align-self:center;color:var(--muted-foreground)}.status-detail--ok .status-icon{color:var(--so-success,#218358)}.status-detail--running .status-icon{color:var(--so-info,#0d74ce)}.status-detail--note .status-icon{color:var(--so-warning,#ab6400)}.status-detail--failed .status-icon{color:var(--so-danger,#c4320a)}.status-detail-label{color:var(--muted-foreground)}.status-detail-text{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .6rem;min-width:0;overflow-wrap:anywhere}.status-detail-text a{color:inherit}.status-detail-act{font-weight:600;white-space:nowrap}.status-detail--note .status-detail-act{color:var(--so-warning,#ab6400)}@media(max-width:480px){.status-detail{grid-template-columns:14px 6.5rem minmax(0,1fr);min-height:2.75rem;padding:.25rem 0}.status-detail-text a{display:inline-block;padding:.75rem 0;margin:-.75rem 0}}.status-why{border:0;padding:0;margin:.25rem 0 0;background:transparent;box-shadow:none}.status-why>summary{cursor:pointer;min-height:2.75rem;display:list-item;align-content:center;font-size:.8125rem;color:var(--muted-foreground)}.status-why p{margin:.25rem 0 .5rem}.receipt-note{display:flex;align-items:center;gap:.45rem;font-size:.8125rem;color:var(--foreground)}.receipt-note .status-icon{color:var(--so-warning,#ab6400)}`;

/** A dispatch diagnosis as its stage, for the phone and CLI reads that hold
 * no assignment. A done task is Complete once a person marked its result;
 * a refuted result whose project check failed is Failed. */
export function stageOfDispatch(d: { code: string; condition: string; action: string | null; role?: string | null; detail?: string },
  options: { completed?: boolean } = {}): { stage: TaskStage; need?: TaskStatusFacts["need"] } {
  if (d.code === "complete" || d.code.startsWith("review-") || d.code === "reviewing") return { stage: options.completed ? "complete" : "finished" };
  if (d.code === "proof-refuted") return /approved check failed|checks failed/i.test(d.detail ?? "") ? { stage: "failed" } : { stage: "needs-you", need: "other" };
  if (d.code === "needs-verification") return { stage: "needs-you", need: "other" };
  return stageOfCode(d.code, { needsPerson: d.condition === "waiting" && d.action !== null, planning: d.condition === "running" && d.role === "planner", operatorHold: d.action === "unhold" });
}
