/**
 * The morning plane review: what went wrong on this plane in the last 24
 * hours, read straight from the store — never a model, never a fenced
 * script — as one problem per distinct thing worth fixing:
 *
 * - failed or no-change runs, grouped by cause (provider error, sign-in
 *   expiry, check failure, timeout, quit without handoff, stuck lease,
 *   orphaned process, no change, other);
 * - tasks waiting on a person for over a day, grouped by what they wait for;
 * - sign-in and plan-limit pauses, per provider;
 * - chat replies that couldn't be delivered, per app;
 * - integrations that are Broken (integration_check);
 * - release checks that failed;
 * - worker passes that logged work as broke.
 *
 * Each problem has a stable key, so the same problem tomorrow is the same
 * problem (flow-triggers.ts joins it to its card), and carries counts, run
 * ids and short evidence excerpts with anything shaped like a secret hidden.
 * A clean day is no problems at all. Only projects the reader may see count.
 */
import { scanForSecrets } from "./evidence.js";
import { scrubIntegrationText } from "./integrations.js";
import { taskWaitSnapshot } from "./lead-status.js";
import type { Store } from "./store.js";

export type PlaneProblem = {
  /** Stable across days: the same problem tomorrow has the same key. Only [a-z0-9/._-]. */
  key: string;
  title: string;
  /** One line: how many, in the last 24 hours. */
  summary: string;
  count: number;
  runs: number[];
  /** Short excerpts, secrets hidden, at most EVIDENCE_LINES. */
  evidence: string[];
};

export const REVIEW_HOURS = 24;
const EVIDENCE_LINES = 5;
const WAITING_DAYS = 1;
/** A Ready result older than this is history, not today's problem. */
const READY_WINDOW_DAYS = 7;

export const RUN_CAUSES = ["provider", "sign-in", "check", "timeout", "no-handoff", "stuck-lease", "orphaned", "no-change", "other"] as const;
export type RunCause = (typeof RUN_CAUSES)[number];
const CAUSE_TITLES: Record<RunCause, string> = {
  provider: "Runs failed on a provider error",
  "sign-in": "Runs stopped: sign-in expired",
  check: "Runs failed their checks",
  timeout: "Runs timed out",
  "no-handoff": "Agents quit without a handoff",
  "stuck-lease": "Leases got stuck",
  orphaned: "Processes were left behind",
  "no-change": "Runs ended with no change",
  other: "Runs failed for another reason",
};

/** Anything shaped like a key is hidden; one short line. */
export function excerpt(text: string | null | undefined, cap = 160): string {
  if (text === null || text === undefined) return "";
  const clean = scrubIntegrationText(text);
  if (scanForSecrets(clean).length > 0) return "[hidden: it looked like it held a key or password]";
  return clean.length > cap ? `${clean.slice(0, cap - 1).trimEnd()}…` : clean;
}

const PROVIDER_REASONS = new Set(["retryable-infra", "provider-init", "provider-protocol", "provider-unattested", "setup"]);
const TIMEOUT_WORDS = /made no observable progress|ran past \d+ minutes|timed out/i;

/** Why one finished run is a problem, or null when it isn't. */
export function runCause(run: { outcome: string | null; reason: string | null; terminalClass: string | null; handoff: string | null; check: string | null; stopped: boolean }): RunCause | "plan-limit" | null {
  const reason = run.reason ?? "";
  if (reason === "auth-expired" || run.terminalClass === "auth-expired") return "sign-in";
  if (run.terminalClass === "usage-exhausted" || run.terminalClass === "credits-depleted") return "plan-limit";
  if (run.check === "failed") return "check";
  if (reason === "timeout" || (run.outcome === "failed" && TIMEOUT_WORDS.test(run.handoff ?? ""))) return "timeout";
  if (reason === "no-handoff") return "no-handoff";
  if (reason === "interrupted" || run.outcome === "interrupted") return run.stopped ? null : "orphaned";
  if (PROVIDER_REASONS.has(reason) || run.terminalClass === "transient-throttle") return "provider";
  if (run.outcome === "no-change") return "no-change";
  if (run.outcome === "failed") return "other";
  return null;
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const keyPart = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unknown";
const str = (value: unknown): string | null => value === null || value === undefined ? null : String(value);
const tableExists = (store: Store, table: string) => store.handle.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
const columnExists = (store: Store, table: string, column: string) => store.handle.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column) !== undefined;

type Bucket = { title: string; count: number; runs: Set<number>; evidence: string[]; noun: [string, string] };

/**
 * Every problem worth fixing in the `REVIEW_HOURS` before `now`, worst first.
 * `canSee(repo)` says which projects' work counts (a run or task with no
 * project counts only when every project may be seen).
 */
export function reviewPlane(store: Store, now: Date, canSee: (repo: string | null) => boolean = () => true): PlaneProblem[] {
  const since = new Date(now.getTime() - REVIEW_HOURS * 3_600_000).toISOString();
  const buckets = new Map<string, Bucket>();
  const add = (key: string, title: string, noun: [string, string], item: { run?: number | null; evidence?: string | null; count?: number }) => {
    const bucket = buckets.get(key) ?? { title, count: 0, runs: new Set<number>(), evidence: [], noun };
    bucket.count += item.count ?? 1;
    if (item.run !== undefined && item.run !== null) bucket.runs.add(item.run);
    if (item.evidence && bucket.evidence.length < EVIDENCE_LINES && !bucket.evidence.includes(item.evidence)) bucket.evidence.push(item.evidence);
    buckets.set(key, bucket);
  };

  // Runs that finished badly, by cause.
  const runs = store.handle.prepare(`SELECT run.id, run.outcome, run.reason, run.terminal_class, run.handoff, run.provider, ref.repo, ref.external_id AS task,
      (SELECT status FROM run_check WHERE run_check.run = run.id AND run_check.release = 0) AS check_status,
      (SELECT line FROM run_check WHERE run_check.run = run.id AND run_check.release = 0) AS check_line,
      EXISTS (SELECT 1 FROM run_stop WHERE run_stop.run = run.id) AS stopped
    FROM run JOIN task_ref ref ON ref.id = run.task_ref
    WHERE run.finished_at >= ? AND run.finished_at <= ? ORDER BY run.id`).all(since, now.toISOString());
  for (const row of runs) {
    if (!canSee(str(row["repo"]))) continue;
    const cause = runCause({ outcome: str(row["outcome"]), reason: str(row["reason"]), terminalClass: str(row["terminal_class"]), handoff: str(row["handoff"]), check: str(row["check_status"]), stopped: Number(row["stopped"]) === 1 });
    if (cause === null) continue;
    const id = Number(row["id"]);
    const said = excerpt(cause === "check" ? str(row["check_line"]) ?? str(row["handoff"]) : str(row["handoff"]) ?? str(row["reason"]));
    const evidence = `Run ${id} (task ${str(row["task"]) ?? "?"})${said === "" ? "" : `: ${said}`}`;
    if (cause === "plan-limit") {
      const provider = str(row["provider"]) ?? "provider";
      add(`pause/limit/${keyPart(provider)}`, `${provider} hit its plan limit`, ["time", "times"], { run: id, evidence });
    } else add(`run/${cause}`, CAUSE_TITLES[cause], ["run", "runs"], { run: id, evidence });
  }

  // Leases that expired without being given back: the worker holding them went quiet.
  const leases = store.handle.prepare(`SELECT claim.lease_id, claim.runner, claim.expires_at, claim.released_by, ref.repo, ref.external_id AS task,
      (SELECT MAX(run.id) FROM run WHERE run.lease_id = claim.lease_id) AS run
    FROM claim JOIN task_ref ref ON ref.id = claim.task_ref
    WHERE (claim.released_by = 'reaped' AND claim.released_at >= ?) OR (claim.released_at IS NULL AND claim.expires_at <= ? AND claim.expires_at >= ?)
    ORDER BY claim.expires_at`).all(since, now.toISOString(), since);
  for (const row of leases) {
    if (!canSee(str(row["repo"]))) continue;
    const run = row["run"] === null ? null : Number(row["run"]);
    add("run/stuck-lease", CAUSE_TITLES["stuck-lease"], ["lease", "leases"], { run,
      evidence: `Task ${str(row["task"]) ?? "?"}${run === null ? "" : `, run ${run}`}: the lease held by ${excerpt(str(row["runner"]), 40)} ${row["released_by"] === "reaped" ? "expired and was taken back" : "expired and is still held"}` });
  }

  // Processes still alive for a run that has finished.
  const orphans = store.handle.prepare(`SELECT rp.run, rp.pid, rp.host, ref.repo, ref.external_id AS task FROM run_process rp
    JOIN run ON run.id = rp.run JOIN task_ref ref ON ref.id = run.task_ref
    WHERE rp.exited_at IS NULL AND run.outcome IS NOT NULL AND (run.finished_at >= ? OR rp.observed_at >= ?) ORDER BY rp.run`).all(since, since);
  for (const row of orphans) {
    if (!canSee(str(row["repo"]))) continue;
    const run = Number(row["run"]);
    add("run/orphaned", CAUSE_TITLES.orphaned, ["run", "runs"], { run, evidence: `Run ${run} (task ${str(row["task"]) ?? "?"}): process ${str(row["pid"]) ?? "?"} on ${excerpt(str(row["host"]), 40)} was still running after it finished` });
  }

  // Tasks waiting on a person for over a day, by what they wait for.
  const waited = new Date(now.getTime() - WAITING_DAYS * 86_400_000).toISOString();
  const readyFrom = new Date(now.getTime() - READY_WINDOW_DAYS * 86_400_000).toISOString();
  const tasks = store.handle.prepare(`SELECT task.id, task.title, task.updated_at, ref.repo FROM task JOIN task_ref ref ON ref.backend = 'built-in' AND ref.external_id = task.id
    WHERE task.updated_at <= ? AND (task.state IN ('queued', 'running') OR (task.state = 'done' AND task.updated_at >= ?)) ORDER BY task.updated_at LIMIT 500`).all(waited, readyFrom);
  for (const row of tasks) {
    if (!canSee(str(row["repo"]))) continue;
    const snapshot = taskWaitSnapshot(store, String(row["id"]), now);
    if (snapshot === null || (snapshot.reason !== "needs-person" && snapshot.reason !== "ready")) continue;
    const days = Math.floor((now.getTime() - Date.parse(String(row["updated_at"]))) / 86_400_000);
    add(`waiting/${keyPart(snapshot.next)}`, `Tasks waited over a day: ${snapshot.next}`, ["task", "tasks"], { run: snapshot.run,
      evidence: `Task ${String(row["id"])} “${excerpt(str(row["title"]), 80)}”: ${plural(days, "day")} waiting` });
  }

  // Sign-in and plan-limit pauses.
  if (tableExists(store, "provider_auth_pause")) {
    for (const row of store.handle.prepare("SELECT provider, opened_at, lifted_at, runs, first_run FROM provider_auth_pause WHERE opened_at >= ? OR lifted_at IS NULL OR lifted_at >= ? ORDER BY id").all(since, since)) {
      const provider = String(row["provider"]);
      add(`pause/sign-in/${keyPart(provider)}`, `${provider} needed signing in again`, ["pause", "pauses"], { run: row["first_run"] === null ? null : Number(row["first_run"]),
        evidence: `Paused ${String(row["opened_at"]).slice(0, 16).replace("T", " ")} UTC, ${plural(Number(row["runs"] ?? 1), "run")} held; ${row["lifted_at"] === null ? "still paused" : "lifted"}` });
    }
  }
  if (tableExists(store, "provider_limit")) {
    for (const row of store.handle.prepare("SELECT provider, window, used_percent, resets_at FROM provider_limit WHERE reached = 1 AND observed_at >= ? ORDER BY provider, window").all(since)) {
      const provider = String(row["provider"]);
      add(`pause/limit/${keyPart(provider)}`, `${provider} hit its plan limit`, ["time", "times"], {
        evidence: `The ${excerpt(str(row["window"]), 20)} limit was reached (${Math.round(Number(row["used_percent"]))}% used)${row["resets_at"] === null ? "" : `; resets ${String(row["resets_at"]).slice(0, 16).replace("T", " ")} UTC`}` });
    }
  }

  // Chat replies that couldn't be delivered.
  for (const app of ["slack", "discord", "teams"] as const) {
    if (!tableExists(store, `${app}_part`)) continue;
    const name = { slack: "Slack", discord: "Discord", teams: "Teams" }[app];
    for (const row of store.handle.prepare(`SELECT id, problem, attempts FROM ${app}_part WHERE state = 'dropped' AND created >= ? ORDER BY id`).all(since)) {
      add(`chat/${app}`, `${name} replies weren't delivered`, ["reply", "replies"], { evidence: `After ${plural(Number(row["attempts"] ?? 0), "try", "tries")}: ${excerpt(str(row["problem"])) || "dropped"}` });
    }
  }
  if (tableExists(store, "telegram_conversation_part")) {
    for (const row of store.handle.prepare("SELECT last_error, attempts FROM telegram_conversation_part WHERE state = 'dropped' AND created_at >= ?").all(since)) {
      add("chat/telegram", "Telegram replies weren't delivered", ["reply", "replies"], { evidence: `After ${plural(Number(row["attempts"] ?? 0), "try", "tries")}: ${excerpt(str(row["last_error"])) || "dropped"}` });
    }
  }
  if (tableExists(store, "notification_delivery")) {
    for (const row of store.handle.prepare("SELECT last_error, attempts FROM notification_delivery WHERE destination LIKE 'telegram:%' AND last_error IS NOT NULL AND delivered_at IS NULL AND last_attempt_at >= ?").all(since)) {
      add("chat/telegram", "Telegram replies weren't delivered", ["reply", "replies"], { evidence: `After ${plural(Number(row["attempts"] ?? 0), "try", "tries")}: ${excerpt(str(row["last_error"]))}` });
    }
  }

  // Integrations that are Broken now and were checked in the window.
  if (tableExists(store, "integration_check")) {
    for (const row of store.handle.prepare("SELECT key, problem, checked_at FROM integration_check WHERE outcome = 'failed' AND checked_at >= ? ORDER BY key").all(since)) {
      const key = String(row["key"]);
      add(`integration/${keyPart(key)}`, `Integration broken: ${excerpt(key, 40)}`, ["check", "checks"], { evidence: excerpt(str(row["problem"])) || "The last check failed." });
    }
  }

  // Release checks that failed.
  const releases = store.handle.prepare(`SELECT rc.run, rc.line, ref.repo, ref.external_id AS task FROM run_check rc JOIN run ON run.id = rc.run JOIN task_ref ref ON ref.id = run.task_ref
    WHERE rc.release = 1 AND rc.status = 'failed' AND rc.recorded_at >= ? ORDER BY rc.run`).all(since);
  for (const row of releases) {
    if (!canSee(str(row["repo"]))) continue;
    const run = Number(row["run"]);
    const said = excerpt(str(row["line"]));
    add("release-check", "Release checks failed", ["check", "checks"], { run, evidence: `Run ${run} (task ${str(row["task"]) ?? "?"})${said === "" ? "" : `: ${said}`}` });
  }

  // What the worker counted as broke in its passes.
  if (tableExists(store, "watch_episode") && columnExists(store, "watch_episode", "broke")) {
    for (const row of store.handle.prepare("SELECT id, repo, runner, broke, started_at, ended_at FROM watch_episode WHERE broke > 0 AND COALESCE(ended_at, started_at) >= ? ORDER BY id").all(since)) {
      if (!canSee(str(row["repo"]))) continue;
      const broke = Number(row["broke"]);
      add("worker/broke", "The worker logged work as broke", ["time", "times"], { count: broke,
        evidence: `Worker ${excerpt(str(row["runner"]), 40)} (pass ${Number(row["id"])}): ${plural(broke, "piece")} of work broke${row["ended_at"] === null ? ", still running" : ""}` });
    }
  }

  return [...buckets].map(([key, bucket]) => {
    const runsList = [...bucket.runs].sort((a, b) => a - b);
    return { key, title: bucket.title, count: bucket.count, runs: runsList, evidence: bucket.evidence,
      summary: `${plural(bucket.count, bucket.noun[0], bucket.noun[1])} in the last ${REVIEW_HOURS} hours${runsList.length === 0 ? "" : ` (${runsList.length === 1 ? "run" : "runs"} ${runsList.slice(0, 12).join(", ")}${runsList.length > 12 ? ", …" : ""})`}.` };
  }).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** A problem as a card's details (or a day's note on a card it joins). */
export function problemText(problem: PlaneProblem, day: string): string {
  return [`${day}: ${problem.summary}`, ...problem.evidence.map(line => `- ${line}`)].join("\n");
}

/** The card's opening details: the day's evidence, and what it is. */
export function problemCard(problem: PlaneProblem, day: string): { title: string; description: string } {
  return { title: problem.title, description: `${problemText(problem, day)}\n\nFound by the morning plane review (problem ${problem.key}). If it comes back, the new day joins this card.` };
}
