/**
 * `/metrics` (v104): Standing Orders in the Prometheus text format, for the
 * dashboards and alerts a company already runs. Labels are small, fixed
 * sets (state, role, outcome, provider, project, destination), never a task
 * id, a person or a path, so a scrape stays cheap and says nothing private.
 */
import { basename } from "node:path";
import type { Store } from "./store.js";

type Sample = { labels?: Record<string, string>; value: number };
type Metric = { name: string; help: string; type: "gauge" | "counter"; samples: Sample[] };

const label = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const line = (name: string, sample: Sample) => {
  const labels = Object.entries(sample.labels ?? {});
  return `${name}${labels.length === 0 ? "" : `{${labels.map(([key, value]) => `${key}="${label(value)}"`).join(",")}}`} ${Number.isFinite(sample.value) ? sample.value : 0}`;
};

export function prometheusMetrics(store: Store, now: Date): string {
  const db = store.handle;
  const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);
  const metrics: Metric[] = [];
  const add = (name: string, help: string, type: Metric["type"], samples: Sample[]) => metrics.push({ name, help, type, samples });

  add("standing_orders_tasks", "Tasks by state.", "gauge",
    rows("SELECT state, COUNT(*) AS n FROM task GROUP BY state").map(row => ({ labels: { state: String(row["state"]) }, value: Number(row["n"]) })));
  const runs = rows(`SELECT role, COALESCE(outcome, 'running') AS outcome, provider, COUNT(*) AS n,
      SUM(CASE WHEN finished_at IS NULL THEN 0 ELSE (julianday(finished_at) - julianday(started_at)) * 86400 END) AS seconds,
      SUM(COALESCE(cost_usd, 0)) AS cost, SUM(COALESCE(tokens_in, 0)) AS tokens_in, SUM(COALESCE(tokens_out, 0)) AS tokens_out
    FROM run GROUP BY role, COALESCE(outcome, 'running'), provider`);
  const byRun = (pick: (row: Record<string, unknown>) => number) => runs.map(row => ({ labels: { role: String(row["role"]), outcome: String(row["outcome"]), provider: String(row["provider"]) }, value: pick(row) }));
  add("standing_orders_runs_total", "Agent runs, by role, outcome and provider.", "counter", byRun(row => Number(row["n"])));
  add("standing_orders_run_seconds_total", "Time agent runs took, in seconds.", "counter", byRun(row => Math.round(Number(row["seconds"] ?? 0))));
  add("standing_orders_spend_usd_total", "What agent runs cost, in US dollars (as providers report it).", "counter", byRun(row => Number(row["cost"] ?? 0)));
  add("standing_orders_tokens_total", "Tokens agent runs used.", "counter", runs.flatMap(row => [
    { labels: { role: String(row["role"]), provider: String(row["provider"]), direction: "in" }, value: Number(row["tokens_in"] ?? 0) },
    { labels: { role: String(row["role"]), provider: String(row["provider"]), direction: "out" }, value: Number(row["tokens_out"] ?? 0) },
  ]));
  add("standing_orders_decisions_waiting", "Questions from agents waiting on a person.", "gauge", [{ value: store.countUnansweredScoped(null) }]);

  const chain = store.ledgerChain();
  add("standing_orders_ledger_entries", "Entries in the action ledger's chain.", "gauge", [{ value: chain.entries }]);
  add("standing_orders_ledger_chain_ok", "1 when the action ledger's chain verifies, 0 when it's broken.", "gauge", [{ value: chain.ok ? 1 : 0 }]);
  add("standing_orders_ledger_checked_timestamp_seconds", "When the whole chain was last walked.", "gauge", chain.checkedAt === null ? [] : [{ value: Math.floor(Date.parse(chain.checkedAt) / 1000) }]);

  const head = store.ledgerHeadId();
  const status = store.monitoringStatus();
  add("standing_orders_monitoring_lag_entries", "Ledger entries a monitoring destination hasn't been sent yet.", "gauge", status.map(one => ({ labels: { destination: one.sink }, value: Math.max(0, head - one.through) })));
  add("standing_orders_monitoring_failures", "Failed deliveries in a row, by destination.", "gauge", status.map(one => ({ labels: { destination: one.sink }, value: one.failures })));
  add("standing_orders_monitoring_last_ok_timestamp_seconds", "When a destination last took a delivery.", "gauge",
    status.filter(one => one.lastOkAt !== null).map(one => ({ labels: { destination: one.sink }, value: Math.floor(Date.parse(one.lastOkAt!) / 1000) })));

  add("standing_orders_worker_heartbeat_age_seconds", "Seconds since each project's worker last checked in.", "gauge",
    rows("SELECT repo, MAX(heartbeat_at) AS at FROM watch_lease GROUP BY repo").map(row => ({ labels: { project: basename(String(row["repo"])) }, value: Math.max(0, Math.round((now.getTime() - Date.parse(String(row["at"]))) / 1000)) })));
  add("standing_orders_checkouts", "Build checkouts on disk, by state.", "gauge",
    rows("SELECT CASE WHEN runner IS NOT NULL AND released_at IS NULL THEN 'leased' ELSE 'released' END AS state, COUNT(*) AS n FROM worktree GROUP BY 1").map(row => ({ labels: { state: String(row["state"]) }, value: Number(row["n"]) })));

  return `${metrics.map(metric => [`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`, ...metric.samples.map(sample => line(metric.name, sample))].join("\n")).join("\n")}\n`;
}
