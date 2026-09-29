/**
 * Spend (v105): what agent work cost, priced for every provider, and who and
 * what it counts toward. A run's cost is what its provider reported (Claude);
 * otherwise its tokens at the model's catalogue price (Settings → Models); a
 * run with neither is "unpriced" and said so, never counted as free.
 *
 * Spend counts toward a project (a run's task, a teammate's, a project chat),
 * a person (who filed the task, or had the chat), a teammate (its turns, and
 * tasks it filed), and the whole installation. Budgets are per calendar
 * month (UTC).
 */
import type { Database } from "./store.js";

export type PriceSource = "reported" | "estimated" | "unpriced";
export type Price = { inputUsd: number; outputUsd: number; model: string };

const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku", "fable"];
const catalogSource = (provider: string): string | null =>
  provider === "claude" || provider === "claude-subscription" || provider === "anthropic-api" ? "claude"
    : provider === "codex" || provider === "codex-subscription" ? "codex"
    : provider === "gemini" ? "gemini"
    : provider === "openrouter" || provider === "openrouter-api" ? "openrouter" : null;

/** A model's catalogue price (US dollars per million tokens), or null when the catalogue doesn't list one. A
 * Claude short name ("sonnet") is priced as the newest of its family, as the Claude CLI runs it. */
export function priceFor(db: Database, provider: string, model: string | null): Price | null {
  const source = catalogSource(provider);
  if (source === null || model === null || model === "" || model === "default") return null;
  const priced = (row: Record<string, unknown> | undefined): Price | null =>
    row === undefined || row["input_usd"] == null || row["output_usd"] == null ? null
      : { inputUsd: Number(row["input_usd"]), outputUsd: Number(row["output_usd"]), model: String(row["id"]) };
  const exact = priced(db.prepare("SELECT id, input_usd, output_usd FROM model_seen WHERE source = ? AND id = ?").get(source, model));
  if (exact !== null || source !== "claude" || !CLAUDE_FAMILIES.includes(model)) return exact;
  return priced(db.prepare(`SELECT id, input_usd, output_usd FROM model_seen WHERE source = 'claude' AND id LIKE ? AND last_seen_at = (SELECT MAX(last_seen_at) FROM model_seen WHERE source = 'claude')
    ORDER BY COALESCE(released_at, '') DESC, id DESC LIMIT 1`).get(`claude-${model}-%`));
}

/** What a piece of work cost, in micro-dollars: reported, or tokens at the catalogue price (usd per million tokens
 * times tokens is micro-dollars), or unpriced. */
export function priceWork(db: Database, work: { provider: string; model: string | null; costUsd: number | null; tokensIn: number | null; tokensOut: number | null }):
  { microusd: number | null; source: PriceSource; price: Price | null } {
  if (work.costUsd !== null && Number.isFinite(work.costUsd)) return { microusd: Math.round(work.costUsd * 1_000_000), source: "reported", price: null };
  if (work.tokensIn === null && work.tokensOut === null) return { microusd: null, source: "unpriced", price: null };
  const price = priceFor(db, work.provider, work.model);
  if (price === null) return { microusd: null, source: "unpriced", price: null };
  return { microusd: Math.round((work.tokensIn ?? 0) * price.inputUsd + (work.tokensOut ?? 0) * price.outputUsd), source: "estimated", price };
}

export const SPEND_SCHEMA = `
CREATE TABLE IF NOT EXISTS run_spend (
  run         INTEGER PRIMARY KEY,
  microusd    INTEGER,
  source      TEXT NOT NULL CHECK (source IN ('reported', 'estimated', 'unpriced')),
  price_model TEXT,
  input_usd   REAL,
  output_usd  REAL,
  priced_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('installation', 'project', 'person', 'teammate')),
  scope_key   TEXT NOT NULL,
  limit_microusd INTEGER NOT NULL CHECK (limit_microusd > 0),
  hard_stop   INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  removed_by  TEXT,
  removed_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_live ON budget (scope_kind, scope_key) WHERE removed_at IS NULL;
`;

export type BudgetScope = "installation" | "project" | "person" | "teammate";
export type Budget = { id: number; scope: BudgetScope; key: string; limitMicrousd: number; hardStop: boolean; updatedBy: string; updatedAt: string };

/** One piece of spend, whatever made it, with what it counts toward. */
export type SpendItem = {
  at: string; kind: "run" | "teammate" | "chat"; microusd: number | null; source: PriceSource;
  project: string | null; person: string | null; teammate: number | null; provider: string; model: string | null;
  tokensIn: number | null; tokensOut: number | null; taskId: string | null; runId: number | null; authMode: string | null;
};

/** The calendar month (UTC) `at` falls in: [start, end) as ISO strings, and its name (YYYY-MM). */
export function monthOf(at: Date): { from: string; to: string; name: string } {
  const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const to = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString(), name: from.toISOString().slice(0, 7) };
}

/** A month by its name (YYYY-MM), or null. */
export function monthNamed(name: string | null): { from: string; to: string; name: string } | null {
  if (name === null || !/^\d{4}-(0[1-9]|1[0-2])$/.test(name)) return null;
  return monthOf(new Date(`${name}-01T00:00:00.000Z`));
}

/** Every piece of spend in [from, to): runs (by when they started), teammate turns and chat turns. A teammate that
 * filed a task is found by its handle in the task's project ("<handle> (AI)"). */
export function spendItems(db: Database, from: string, to: string): SpendItem[] {
  const runs = db.prepare(`SELECT run.id, run.provider, run.model, run.cost_usd, run.tokens_in, run.tokens_out, run.started_at, run.auth_mode,
      r.external_id AS task, r.repo, r.filed_by, r.filed_by_kind, s.microusd, s.source,
      (SELECT m.id FROM teammate m WHERE m.repo = r.repo AND r.filed_by_kind = 'teammate' AND r.filed_by = m.handle || ' (AI)' ORDER BY m.id DESC LIMIT 1) AS teammate
    FROM run JOIN task_ref r ON r.id = run.task_ref LEFT JOIN run_spend s ON s.run = run.id
    WHERE run.started_at >= ? AND run.started_at < ? ORDER BY run.id`).all(from, to);
  const items: SpendItem[] = runs.map(row => {
    const settled = row["source"] != null;
    const priced = settled ? null : priceWork(db, { provider: String(row["provider"]), model: row["model"] == null ? null : String(row["model"]),
      costUsd: row["cost_usd"] == null ? null : Number(row["cost_usd"]), tokensIn: row["tokens_in"] == null ? null : Number(row["tokens_in"]), tokensOut: row["tokens_out"] == null ? null : Number(row["tokens_out"]) });
    const kind = row["filed_by_kind"] == null ? null : String(row["filed_by_kind"]);
    return {
      at: String(row["started_at"]), kind: "run", microusd: settled ? (row["microusd"] == null ? null : Number(row["microusd"])) : priced!.microusd,
      source: settled ? String(row["source"]) as PriceSource : priced!.source,
      project: row["repo"] == null ? null : String(row["repo"]),
      person: kind === "person" || kind === "coordinator" ? (row["filed_by"] == null ? null : String(row["filed_by"])) : null,
      teammate: row["teammate"] == null ? null : Number(row["teammate"]), provider: String(row["provider"]), model: row["model"] == null ? null : String(row["model"]),
      tokensIn: row["tokens_in"] == null ? null : Number(row["tokens_in"]), tokensOut: row["tokens_out"] == null ? null : Number(row["tokens_out"]),
      taskId: String(row["task"]), runId: Number(row["id"]), authMode: row["auth_mode"] == null ? null : String(row["auth_mode"]),
    };
  });
  for (const row of db.prepare(`SELECT t.at, t.teammate, t.model, t.cost_usd, t.tokens_in, t.tokens_out, m.repo FROM teammate_turn t JOIN teammate m ON m.id = t.teammate
      WHERE t.at >= ? AND t.at < ? ORDER BY t.id`).all(from, to)) {
    const priced = priceWork(db, { provider: "claude", model: row["model"] == null ? null : String(row["model"]), costUsd: row["cost_usd"] == null ? null : Number(row["cost_usd"]),
      tokensIn: row["tokens_in"] == null ? null : Number(row["tokens_in"]), tokensOut: row["tokens_out"] == null ? null : Number(row["tokens_out"]) });
    items.push({ at: String(row["at"]), kind: "teammate", microusd: priced.microusd, source: priced.source, project: String(row["repo"]), person: null,
      teammate: Number(row["teammate"]), provider: "claude", model: row["model"] == null ? null : String(row["model"]),
      tokensIn: row["tokens_in"] == null ? null : Number(row["tokens_in"]), tokensOut: row["tokens_out"] == null ? null : Number(row["tokens_out"]), taskId: null, runId: null, authMode: null });
  }
  // A chat turn that mirrors a project chat's turn is that turn: counted once, as the project chat's.
  for (const row of db.prepare(`SELECT created_at AS at, approver, provider, model, settled_microusd, reserved_microusd, state, tokens_in, tokens_out, NULL AS scope_kind, NULL AS scope_key
      FROM chat_turn WHERE mate_turn IS NULL AND created_at >= ? AND created_at < ?
    UNION ALL SELECT t.created_at, t.approver, 'lead', NULL, t.settled_microusd, t.reserved_microusd, t.state, t.tokens_in, t.tokens_out, th.scope_kind, th.scope_key
      FROM mate_turn t LEFT JOIN mate_thread th ON th.id = t.thread WHERE t.created_at >= ? AND t.created_at < ?`).all(from, to, from, to)) {
    const settled = row["settled_microusd"] == null ? null : Number(row["settled_microusd"]);
    items.push({ at: String(row["at"]), kind: "chat", microusd: settled, source: settled === null ? "unpriced" : "reported",
      project: row["scope_kind"] === "project" && row["scope_key"] != null ? String(row["scope_key"]) : null, person: row["approver"] == null ? null : String(row["approver"]),
      teammate: null, provider: String(row["provider"]), model: row["model"] == null ? null : String(row["model"]),
      tokensIn: row["tokens_in"] == null ? null : Number(row["tokens_in"]), tokensOut: row["tokens_out"] == null ? null : Number(row["tokens_out"]), taskId: null, runId: null, authMode: null });
  }
  return items;
}

/** Whether a piece of spend counts toward a budget. */
export function countsToward(item: SpendItem, budget: Pick<Budget, "scope" | "key">): boolean {
  if (budget.scope === "installation") return true;
  if (budget.scope === "project") return item.project === budget.key;
  if (budget.scope === "person") return item.person === budget.key;
  return item.teammate !== null && String(item.teammate) === budget.key;
}

export type BudgetState = Budget & { spentMicrousd: number; unpriced: number; percent: number };

/** Each budget's month so far: what counted toward it, and how many pieces of work had no price. */
export function budgetStates(budgets: readonly Budget[], items: readonly SpendItem[]): BudgetState[] {
  return budgets.map(budget => {
    const mine = items.filter(item => countsToward(item, budget));
    const spent = mine.reduce((sum, item) => sum + (item.microusd ?? 0), 0);
    return { ...budget, spentMicrousd: spent, unpriced: mine.filter(item => item.microusd === null && item.source === "unpriced" && (item.tokensIn !== null || item.kind !== "run")).length,
      percent: Math.floor((spent / budget.limitMicrousd) * 100) };
  });
}

/** A budget in words: "The shop project's", "alex's", "Maya's (teammate)", "The whole installation's". */
export function budgetLabel(budget: Pick<Budget, "scope" | "key">, teammateName?: string): string {
  if (budget.scope === "installation") return "The whole installation's";
  if (budget.scope === "project") return `The ${budget.key.split("/").filter(Boolean).pop() ?? budget.key} project's`;
  if (budget.scope === "person") return `${budget.key}'s`;
  return `${teammateName ?? `Teammate ${budget.key}`}'s`;
}

export const usd = (microusd: number | null): string => microusd === null ? "unpriced" : `$${(microusd / 1_000_000).toFixed(microusd !== 0 && Math.abs(microusd) < 10_000_000 ? 2 : 0)}`;
