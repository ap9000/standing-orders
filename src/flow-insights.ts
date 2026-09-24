/**
 * Flow insights (v84): how work moves through a flow and where it breaks,
 * read from what the flow already records — every card's moves (flow_event)
 * and every script or update step's run (flow_step_run, with its log). No
 * model, no sampling: counts over a window, per zone and per script.
 */
import { flowDefinitionOf } from "./flow-engine.js";
import type { FlowRow, FlowStepRunRow, Store } from "./store.js";

export type ZoneInsight = {
  zone: string; title: string; kind: string;
  /** Cards that arrived in the window, and what happened next. */
  entered: number; movedOn: number; failed: number; sentBack: number;
  /** Cards sitting there now. */
  here: number;
  /** The middle of how long cards stayed before moving on, in minutes. */
  typicalMinutes: number | null;
  lastProblem: { card: number; cardTitle: string; note: string | null; at: string } | null;
};
export type ScriptInsight = { script: string; runs: number; passed: number; failed: number; typicalSeconds: number | null; lastFailure: string | null };
export type StepRunInsight = {
  card: number; cardTitle: string; entry: number; zone: string; zoneTitle: string; kind: "check" | "update";
  script: string | null; version: number | null; state: FlowStepRunRow["state"]; result: string | null; exitCode: number | null; durationMs: number | null; at: string; hasLog: boolean;
};
export type FlowInsights = {
  flow: number; name: string; days: number;
  cards: { started: number; finished: number; active: number };
  zones: ZoneInsight[];
  /** The zones that fail or send work back most, worst first. */
  breaks: { zone: string; title: string; problems: number; of: number }[];
  scripts: ScriptInsight[];
  runs: StepRunInsight[];
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** One flow's insights over the last `days` days. */
export function flowInsights(store: Store, flow: FlowRow, now: Date, days = 30): FlowInsights {
  const since = new Date(now.getTime() - days * 86_400_000);
  const definition = flowDefinitionOf(flow);
  const stages = definition?.stages ?? [];
  const titleOf = (id: string) => stages.find(one => one.id === id)?.title ?? id;
  const cards = store.flowCards(flow.id, true);
  const cardTitle = (id: number) => cards.find(one => one.id === id)?.title ?? `card ${id}`;
  const zones = new Map<string, ZoneInsight & { stays: number[] }>(stages.map(stage => [stage.id, {
    zone: stage.id, title: stage.title, kind: stage.kind, entered: 0, movedOn: 0, failed: 0, sentBack: 0,
    here: cards.filter(card => card.state === "active" && card.stage === stage.id).length, typicalMinutes: null, lastProblem: null, stays: [],
  }]));
  const moves = store.flowMoves(flow.id, since);
  const byCard = new Map<number, typeof moves>();
  for (const move of moves) byCard.set(move.card, [...byCard.get(move.card) ?? [], move]);
  for (const [card, list] of byCard) list.forEach((move, index) => {
    const arrived = zones.get(move.toStage);
    if (arrived !== undefined) {
      arrived.entered++;
      const next = list[index + 1];
      if (next !== undefined) arrived.stays.push((Date.parse(next.at) - Date.parse(move.at)) / 60_000);
    }
    const left = move.fromStage === null ? undefined : zones.get(move.fromStage);
    if (left === undefined) return;
    if (move.outcome === "fail" || move.outcome === "sent-back") {
      if (move.outcome === "fail") left.failed++; else left.sentBack++;
      left.lastProblem = { card, cardTitle: cardTitle(card), note: move.note, at: move.at };
    } else if (move.outcome !== "cancelled") left.movedOn++;
  });
  const zoneList = [...zones.values()].map(({ stays, ...zone }) => ({ ...zone, typicalMinutes: median(stays) === null ? null : Math.round(median(stays)! * 10) / 10 }));
  const doneZones = new Set(stages.filter(one => one.kind === "done").map(one => one.id));
  const runs = store.flowStepRuns(flow.id, since, 200);
  const scripts = new Map<string, { runs: number; passed: number; failed: number; durations: number[]; lastFailure: string | null }>();
  for (const run of runs) {
    if (run.script === null || (run.state !== "passed" && run.state !== "failed")) continue;
    const entry = scripts.get(run.script) ?? { runs: 0, passed: 0, failed: 0, durations: [], lastFailure: null };
    entry.runs++;
    if (run.state === "passed") entry.passed++; else { entry.failed++; entry.lastFailure ??= run.result; }
    if (run.durationMs !== null) entry.durations.push(run.durationMs / 1000);
    scripts.set(run.script, entry);
  }
  return {
    flow: flow.id, name: flow.name, days,
    cards: {
      started: moves.filter(one => one.outcome === "created").length,
      finished: new Set(moves.filter(one => doneZones.has(one.toStage)).map(one => one.card)).size,
      active: cards.filter(one => one.state === "active").length,
    },
    zones: zoneList,
    breaks: zoneList.filter(one => one.failed + one.sentBack > 0).sort((a, b) => (b.failed + b.sentBack) - (a.failed + a.sentBack)).slice(0, 3)
      .map(one => ({ zone: one.zone, title: one.title, problems: one.failed + one.sentBack, of: Math.max(one.entered, one.failed + one.sentBack) })),
    scripts: [...scripts].map(([script, one]) => ({ script, runs: one.runs, passed: one.passed, failed: one.failed, typicalSeconds: median(one.durations) === null ? null : Math.round(median(one.durations)!), lastFailure: one.lastFailure })),
    runs: runs.slice(0, 40).map(run => ({
      card: run.card, cardTitle: run.cardTitle, entry: run.entry, zone: run.stage, zoneTitle: titleOf(run.stage), kind: run.kind, script: run.script, version: run.scriptVersion,
      state: run.state, result: run.result, exitCode: run.exitCode, durationMs: run.durationMs, at: run.finishedAt ?? run.startedAt, hasLog: run.log !== null && run.log !== "",
    })),
  };
}

/** One line for a flow's list entry: where it has had the most trouble lately. */
export function troubleWords(insights: FlowInsights): string | null {
  const worst = insights.breaks[0];
  return worst === undefined ? null : `most trouble in ${worst.title} (${worst.problems} of ${worst.of} in the last ${insights.days} days)`;
}
