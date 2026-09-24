/**
 * Flows (v81): a canvas of zones that work moves through. Each zone is one
 * stage of a team's process; each card is one piece of work. When a card
 * is routed or dropped into a zone, the zone's step runs:
 *
 * - inbox     — a holding zone: cards wait for someone to move them.
 * - task      — build it: files the card's work as an ordinary task, so the
 *               existing plan → approve → build → verify pipeline (with its
 *               approvals and agent fence) does the work; the card moves on
 *               when the result is ready, or down its failure path.
 * - report    — research it: files a report task (no code changes) and
 *               keeps the report on the card for later zones.
 * - approval  — a person decides: approve moves on; send back (with a
 *               note) takes the failure path, and a send back to a build
 *               zone becomes a revision of the card's work.
 * - notify    — posts a message to the project's chat and moves on.
 * - done      — the end.
 *
 * The engine is deterministic and model-free: it runs in the worker's pass
 * beside routines, and no card ever skips an approval the task itself needs.
 */
import { createHash } from "node:crypto";

export const FLOW_STAGE_KINDS = ["inbox", "task", "report", "approval", "notify", "done"] as const;
export type FlowStageKind = (typeof FLOW_STAGE_KINDS)[number];
export const FLOW_COLORS = ["slate", "blue", "violet", "amber", "green", "rose"] as const;
export type FlowColor = (typeof FLOW_COLORS)[number];

export type FlowZone = { x: number; y: number; w: number; h: number; color: FlowColor };

export type FlowStage = {
  id: string;
  title: string;
  kind: FlowStageKind;
  zone: FlowZone;
  /** task/report: what the agent is asked to do. `{{card.title}}`,
   * `{{card.description}}`, `{{note}}` (the latest send-back note) and
   * `{{stage.<id>}}` (an earlier zone's report) are filled in. */
  instructions: string | null;
  /** task: plan first (required), let Standing Orders decide (auto), or build directly (skip). */
  planning: "auto" | "required" | "skip" | null;
  /** approval: the one person who decides, or null for any approver on the project. */
  approver: string | null;
  /** notify: the message, with the same fill-ins. */
  message: string | null;
  /** Where a card goes when this zone's step succeeds, and when it fails or is sent back. */
  next: string | null;
  onFail: string | null;
};

export type FlowDefinition = { version: 1; start: string; stages: FlowStage[] };

/** What each kind is called and does, in the words the canvas uses. */
export const FLOW_KIND_WORDS: Record<FlowStageKind, { label: string; about: string }> = {
  inbox: { label: "Holding", about: "Cards wait here until someone moves them." },
  task: { label: "Build", about: "An agent does the work as a task, with the usual approvals and checks." },
  report: { label: "Research", about: "An agent investigates and writes a report. No code changes." },
  approval: { label: "Person decides", about: "Someone approves, or sends it back with a note." },
  notify: { label: "Message", about: "Posts a message to the project's chat, then moves on." },
  done: { label: "Done", about: "The end of the flow." },
};

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const text = (value: unknown, cap: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Zone text must be plain text.");
  const trimmed = value.trim();
  if (trimmed.length > cap) throw new Error(`Zone text is up to ${cap} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) throw new Error("Zone text cannot contain control characters.");
  return trimmed === "" ? null : trimmed;
};
const coordinate = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;

/** A flow as drawn on the canvas, checked whole. Throws in plain words. */
export function validateFlowDefinition(input: unknown): FlowDefinition {
  const raw = input as { version?: unknown; start?: unknown; stages?: unknown } | null;
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.stages)) throw new Error("A flow is a list of zones.");
  if (raw.stages.length === 0 || raw.stages.length > 24) throw new Error("A flow has 1 to 24 zones.");
  const stages: FlowStage[] = raw.stages.map((one, index) => {
    const stage = one as Record<string, unknown>;
    const id = typeof stage["id"] === "string" ? stage["id"] : "";
    if (!ID.test(id)) throw new Error("Each zone needs a short id: lowercase letters, numbers and dashes.");
    const kind = stage["kind"];
    if (!FLOW_STAGE_KINDS.includes(kind as FlowStageKind)) throw new Error(`Zone ${id}: choose what it does.`);
    const title = text(stage["title"], 60);
    if (title === null) throw new Error(`Zone ${id} needs a name.`);
    const zone = (stage["zone"] ?? {}) as Record<string, unknown>;
    const color = FLOW_COLORS.includes(zone["color"] as FlowColor) ? zone["color"] as FlowColor : "slate";
    const planning = stage["planning"] === "required" || stage["planning"] === "skip" || stage["planning"] === "auto" ? stage["planning"] : null;
    return {
      id, title, kind: kind as FlowStageKind,
      zone: { x: coordinate(zone["x"], -20000, 20000, index * 320), y: coordinate(zone["y"], -20000, 20000, 0), w: coordinate(zone["w"], 220, 1200, 280), h: coordinate(zone["h"], 160, 1600, 360), color },
      instructions: text(stage["instructions"], 4000),
      planning: kind === "task" ? planning ?? "auto" : null,
      approver: kind === "approval" ? text(stage["approver"], 64) : null,
      message: text(stage["message"], 1000),
      next: text(stage["next"], 32),
      onFail: text(stage["onFail"], 32),
    };
  });
  const ids = new Set<string>();
  for (const stage of stages) {
    if (ids.has(stage.id)) throw new Error(`Two zones are called ${stage.id}.`);
    ids.add(stage.id);
  }
  for (const stage of stages) {
    for (const target of [stage.next, stage.onFail]) if (target !== null && !ids.has(target)) throw new Error(`Zone ${stage.title} points at a zone that no longer exists.`);
    if ((stage.kind === "task" || stage.kind === "report") && stage.instructions === null) throw new Error(`Zone ${stage.title}: say what the agent should do.`);
    if (stage.kind === "notify" && stage.message === null) throw new Error(`Zone ${stage.title}: write the message to post.`);
    if (stage.kind === "done" && (stage.next !== null || stage.onFail !== null)) throw new Error(`Zone ${stage.title} is the end; it can't lead anywhere.`);
  }
  const start = typeof raw.start === "string" && ids.has(raw.start) ? raw.start : stages[0]!.id;
  return { version: 1, start, stages };
}

/** What a card's work is held to: the zones' steps and paths, never where they sit on the canvas. */
export function flowDigest(definition: FlowDefinition): string {
  const terms = definition.stages.map(({ zone: _zone, ...rest }) => rest);
  return createHash("sha256").update(JSON.stringify({ start: definition.start, terms })).digest("hex").slice(0, 32);
}

/** Fill a zone's text from the card: title, description, the latest note and earlier zones' reports. */
export function fillFlowText(template: string, card: { title: string; description: string | null; note: string | null; outputs: Record<string, string> }): string {
  return template.replace(/\{\{\s*(card\.title|card\.description|note|stage\.([a-z0-9-]+))\s*\}\}/g, (_match, key: string, stage: string | undefined) => {
    if (key === "card.title") return card.title;
    if (key === "card.description") return card.description ?? "";
    if (key === "note") return card.note ?? "";
    return stage === undefined ? "" : card.outputs[stage] ?? "";
  }).trim();
}

const zone = (x: number, y: number, color: FlowColor, h = 300): FlowZone => ({ x, y, w: 260, h, color });
const stage = (id: string, title: string, kind: FlowStageKind, at: FlowZone, rest: Partial<FlowStage> = {}): FlowStage =>
  ({ id, title, kind, zone: at, instructions: null, planning: kind === "task" ? "auto" : null, approver: null, message: null, next: null, onFail: null, ...rest });

/** Ready-made flows: the coding flow is the whole business process around a change. */
export const FLOW_TEMPLATES: readonly { id: string; label: string; about: string; definition: FlowDefinition }[] = [
  {
    id: "coding",
    label: "Coding flow",
    about: "Triage, plan, build, review by a person, then tell the team.",
    definition: {
      version: 1,
      start: "inbox",
      stages: [
        stage("inbox", "Inbox", "inbox", zone(0, 0, "slate"), { next: "triage" }),
        stage("triage", "Triage", "report", zone(300, 0, "violet"), {
          instructions: "Investigate this request in the repository and write a short triage: what is being asked, where in the code it lands, the risks, and a rough size.\n\nRequest: {{card.title}}\n{{card.description}}",
          next: "go-ahead",
        }),
        stage("go-ahead", "Go ahead?", "approval", zone(600, 0, "amber"), { next: "build", onFail: "inbox" }),
        stage("build", "Build", "task", zone(900, 0, "blue"), {
          instructions: "{{card.title}}\n\n{{card.description}}\n\nTriage notes:\n{{stage.triage}}\n\nRequested changes (if any): {{note}}",
          next: "review",
        }),
        stage("review", "Review", "approval", zone(900, 380, "amber"), { next: "announce", onFail: "build" }),
        stage("announce", "Tell the team", "notify", zone(600, 380, "green", 220), { message: "Shipped: {{card.title}}", next: "done" }),
        stage("done", "Done", "done", zone(300, 380, "green", 220)),
      ],
    },
  },
  {
    id: "research",
    label: "Research flow",
    about: "Research a question, have a person check it, then share it.",
    definition: {
      version: 1,
      start: "inbox",
      stages: [
        stage("inbox", "Questions", "inbox", zone(0, 0, "slate"), { next: "research" }),
        stage("research", "Research", "report", zone(300, 0, "violet"), {
          instructions: "Research this and write a clear, sourced answer with a short summary first.\n\nQuestion: {{card.title}}\n{{card.description}}\n\nFeedback to address (if any): {{note}}",
          next: "check",
        }),
        stage("check", "Check", "approval", zone(600, 0, "amber"), { next: "share", onFail: "research" }),
        stage("share", "Share", "notify", zone(900, 0, "green", 220), { message: "Answered: {{card.title}}", next: "done" }),
        stage("done", "Done", "done", zone(900, 250, "green", 220)),
      ],
    },
  },
  {
    id: "blank",
    label: "Blank flow",
    about: "An inbox and a done zone to build from.",
    definition: { version: 1, start: "inbox", stages: [stage("inbox", "Inbox", "inbox", zone(0, 0, "slate"), { next: "done" }), stage("done", "Done", "done", zone(300, 0, "green"))] },
  },
];
