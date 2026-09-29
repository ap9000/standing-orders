/**
 * `/metrics` (v104): Toolroll in the Prometheus text format, for the
 * dashboards and alerts a company already runs. Labels are small, fixed
 * sets (state, role, outcome, provider, project, destination), never a task
 * id, a person or a path, so a scrape stays cheap and says nothing private.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Store } from "./store.js";

type Sample = { labels?: Record<string, string>; value: number };
type Metric = { name: string; help: string; type: "gauge" | "counter"; samples: Sample[] };

const label = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const line = (name: string, sample: Sample) => {
  const labels = Object.entries(sample.labels ?? {});
  return `${name}${labels.length === 0 ? "" : `{${labels.map(([key, value]) => `${key}="${label(value)}"`).join(",")}}`} ${Number.isFinite(sample.value) ? sample.value : 0}`;
};

/** `repos`: the projects this console serves (null: all); task, run and worker figures count only theirs. */
export function prometheusMetrics(store: Store, now: Date, repos: readonly string[] | null = null, destinations?: ReadonlyMap<string, string>): string {
  const db = store.handle;
  const inProjects = (column: string) => repos === null ? "1 = 1" : repos.length === 0 ? "1 = 0" : `${column} IN (${repos.map(() => "?").join(",")})`;
  const scoped = repos ?? [];
  const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);
  const metrics: Metric[] = [];
  const add = (name: string, help: string, type: Metric["type"], samples: Sample[]) => metrics.push({ name, help, type, samples });
  // A project's label is its folder name, told apart by a short digest when two share one.
  const names = new Map<string, number>();
  for (const repo of rows(`SELECT DISTINCT repo FROM watch_lease WHERE ${inProjects("repo")}`, ...scoped).map(row => String(row["repo"]))) names.set(basename(repo), (names.get(basename(repo)) ?? 0) + 1);
  const project = (repo: string) => (names.get(basename(repo)) ?? 0) > 1 ? `${basename(repo)}-${createHash("sha256").update(repo).digest("hex").slice(0, 6)}` : basename(repo);

  add("standing_orders_tasks", "Tasks by state.", "gauge",
    rows(`SELECT t.state, COUNT(*) AS n FROM task t JOIN task_ref r ON r.external_id = t.id AND r.backend = 'built-in' WHERE ${inProjects("r.repo")} GROUP BY t.state`, ...scoped)
      .map(row => ({ labels: { state: String(row["state"]) }, value: Number(row["n"]) })));
  const runs = rows(`SELECT run.role, COALESCE(run.outcome, 'running') AS outcome, run.provider, COUNT(*) AS n,
      SUM(CASE WHEN run.finished_at IS NULL THEN 0 ELSE (julianday(run.finished_at) - julianday(run.started_at)) * 86400 END) AS seconds,
      SUM(COALESCE(run.cost_usd, 0)) AS cost
    FROM run JOIN task_ref r ON r.id = run.task_ref WHERE ${inProjects("r.repo")} GROUP BY run.role, COALESCE(run.outcome, 'running'), run.provider`, ...scoped);
  const byRun = (pick: (row: Record<string, unknown>) => number) => runs.map(row => ({ labels: { role: String(row["role"]), outcome: String(row["outcome"]), provider: String(row["provider"]) }, value: pick(row) }));
  add("standing_orders_runs_total", "Agent runs, by role, outcome and provider.", "counter", byRun(row => Number(row["n"])));
  add("standing_orders_run_seconds_total", "Time agent runs took, in seconds.", "counter", byRun(row => Math.round(Number(row["seconds"] ?? 0))));
  add("standing_orders_spend_usd_total", "What agent runs cost, in US dollars (as providers report it).", "counter", byRun(row => Number(row["cost"] ?? 0)));
  add("standing_orders_tokens_total", "Tokens agent runs used.", "counter", rows(`SELECT run.role, run.provider, SUM(COALESCE(run.tokens_in, 0)) AS tokens_in, SUM(COALESCE(run.tokens_out, 0)) AS tokens_out
      FROM run JOIN task_ref r ON r.id = run.task_ref WHERE ${inProjects("r.repo")} GROUP BY run.role, run.provider`, ...scoped).flatMap(row => [
    { labels: { role: String(row["role"]), provider: String(row["provider"]), direction: "in" }, value: Number(row["tokens_in"] ?? 0) },
    { labels: { role: String(row["role"]), provider: String(row["provider"]), direction: "out" }, value: Number(row["tokens_out"] ?? 0) },
  ]));
  add("standing_orders_decisions_waiting", "Questions from agents waiting on a person.", "gauge",
    [{ value: repos === null ? store.countUnansweredScoped(null) : repos.reduce((sum, repo) => sum + store.countUnansweredScoped(repo), 0) }]);

  const chain = store.ledgerChain();
  add("standing_orders_ledger_entries", "Entries in the action ledger's chain.", "gauge", [{ value: chain.entries }]);
  add("standing_orders_ledger_chain_ok", "1 when the action ledger's chain verifies, 0 when it's broken.", "gauge", [{ value: chain.ok ? 1 : 0 }]);
  add("standing_orders_ledger_checked_timestamp_seconds", "When the whole chain was last walked.", "gauge", chain.checkedAt === null ? [] : [{ value: Math.floor(Date.parse(chain.checkedAt) / 1000) }]);

  const head = store.ledgerHeadId();
  // Only destinations set up now, each for its current address (`destinations`: sink → target; all when not given).
  const status = store.monitoringStatus().filter(one => destinations === undefined || destinations.get(one.sink) === one.target);
  add("standing_orders_monitoring_lag_entries", "Ledger entries a monitoring destination hasn't been sent yet.", "gauge", status.map(one => ({ labels: { destination: one.sink }, value: Math.max(0, head - one.through) })));
  add("standing_orders_monitoring_failures", "Failed deliveries in a row, by destination.", "gauge", status.map(one => ({ labels: { destination: one.sink }, value: one.failures })));
  add("standing_orders_monitoring_last_ok_timestamp_seconds", "When a destination last took a delivery.", "gauge",
    status.filter(one => one.lastOkAt !== null).map(one => ({ labels: { destination: one.sink }, value: Math.floor(Date.parse(one.lastOkAt!) / 1000) })));

  add("standing_orders_worker_heartbeat_age_seconds", "Seconds since each project's worker last checked in.", "gauge",
    rows(`SELECT repo, MAX(heartbeat_at) AS at FROM watch_lease WHERE ${inProjects("repo")} GROUP BY repo`, ...scoped).map(row => ({ labels: { project: project(String(row["repo"])) }, value: Math.max(0, Math.round((now.getTime() - Date.parse(String(row["at"]))) / 1000)) })));
  add("standing_orders_checkouts", "Build checkouts on disk, by state.", "gauge",
    rows(`SELECT CASE WHEN runner IS NOT NULL AND released_at IS NULL THEN 'leased' ELSE 'released' END AS state, COUNT(*) AS n FROM worktree WHERE ${inProjects("repo")} GROUP BY 1`, ...scoped).map(row => ({ labels: { state: String(row["state"]) }, value: Number(row["n"]) })));

  return `${metrics.map(metric => [`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`, ...metric.samples.map(sample => line(metric.name, sample))].join("\n")).join("\n")}\n`;
}
