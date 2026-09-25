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
 * - draft     — (v86) Claude writes something from the card (a reply, a
 *               summary, a note) in seconds, with no repository and no
 *               tools. Nothing is sent: a later zone shows it to a person
 *               and a later step posts it ({{stage.<id>}}).
 * - sort      — (v85) Jev, a decision model reached through OpenRouter,
 *               reads the card and picks one of the zone's answers; the
 *               card goes where that answer leads, or down the not-sure
 *               path when Jev is less sure than the zone asks. It can also
 *               note a few scores or yes/no answers on the card.
 * - done      — the end.
 *
 * The engine is deterministic and model-free: it runs in the worker's pass
 * beside routines, and no card ever skips an approval the task itself needs.
 */
import { createHash } from "node:crypto";

export const FLOW_STAGE_KINDS = ["inbox", "task", "report", "approval", "check", "update", "notify", "sort", "draft", "done"] as const;
export type FlowStageKind = (typeof FLOW_STAGE_KINDS)[number];
export const FLOW_COLORS = ["slate", "blue", "violet", "amber", "green", "rose"] as const;
export type FlowColor = (typeof FLOW_COLORS)[number];

export type FlowZone = { x: number; y: number; w: number; h: number; color: FlowColor };

/** One answer a sort zone can pick: its name, what it means (what Jev reads), and the zone it sends the card to. */
export type FlowSortAnswer = { answer: string; means: string; to: string };
/** Something else a sort zone notes on the card: a score on a scale of levels, or a yes/no. */
export type FlowSortNote = { id: string; kind: "score" | "yes-no"; question: string; levels: string[] | null };
/** sort: the question, its answers, how sure Jev must be to act alone (0.5–0.99), and what else it notes. */
export type FlowSort = { question: string; answers: FlowSortAnswer[]; sureAt: number; notes: FlowSortNote[] };

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
  /** approval: the flow's owner decides (v86), whoever that is when the card arrives; `approver` is then unused. */
  toOwner?: boolean;
  /** notify: the message; update: the comment left on the issue. Same fill-ins. */
  message: string | null;
  /** update: also close the issue (Linear: move it to the team's done state). */
  close: boolean | null;
  /** check: the project script (by name) run on the card's work, with no AI. */
  script: string | null;
  /** sort: what Jev is asked and where each answer leads. Its onFail is where a card goes when Jev isn't sure. */
  sort: FlowSort | null;
  /** Where a card goes when this zone's step succeeds, and when it fails or is sent back (sort: when it isn't sure). */
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
  check: { label: "Run a script", about: "Runs one of the project's scripts on the card's work, with no AI. If it fails, the card takes its failure path." },
  update: { label: "Update the issue", about: "Comments on the GitHub or Linear issue the card came from, and can close it. Other cards pass straight through." },
  notify: { label: "Message", about: "Posts a message to the project's chat, then moves on." },
  draft: { label: "Draft", about: "Claude writes a reply, summary or note from the card in seconds. Nothing is sent until a later step sends it." },
  sort: { label: "Sort", about: "Jev reads the card in under a second and sends it where its answer leads. Cards it isn't sure about take the not-sure path." },
  done: { label: "Done", about: "The end of the flow." },
};

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A project script's name: short, lowercase, dashes — how zones and chat refer to it. */
export const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
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

/** How an answer is named to Jev: its words as a short key. */
export const sortKeyOf = (answer: string) => answer.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "answer";
/** The default for "sure enough to act alone". */
export const SORT_SURE_AT = 0.8;

/** A sort zone's settings, checked. Answers name zones by id; `ids` says which exist. */
function validateSort(input: unknown, title: string): FlowSort {
  const raw = (input ?? {}) as Record<string, unknown>;
  const question = text(raw["question"], 300);
  if (question === null) throw new Error(`Zone ${title}: write the question it sorts by.`);
  const answers = Array.isArray(raw["answers"]) ? raw["answers"] : [];
  if (answers.length < 2 || answers.length > 12) throw new Error(`Zone ${title}: give it 2 to 12 answers.`);
  const keys = new Set<string>();
  const checked = answers.map(one => {
    const answer = one as Record<string, unknown>;
    const name = text(answer["answer"], 40);
    if (name === null) throw new Error(`Zone ${title}: every answer needs a name.`);
    const means = text(answer["means"], 200) ?? name;
    const to = text(answer["to"], 32);
    if (to === null) throw new Error(`Zone ${title}: say where “${name}” goes.`);
    const key = sortKeyOf(name);
    if (keys.has(key)) throw new Error(`Zone ${title}: two answers are called ${name}.`);
    keys.add(key);
    return { answer: name, means, to };
  });
  const sureAt = typeof raw["sureAt"] === "number" && Number.isFinite(raw["sureAt"]) ? Math.round(Math.min(0.99, Math.max(0.5, raw["sureAt"])) * 100) / 100 : SORT_SURE_AT;
  const notes = Array.isArray(raw["notes"]) ? raw["notes"] : [];
  if (notes.length > 3) throw new Error(`Zone ${title}: it can note up to 3 other things.`);
  const noteIds = new Set<string>(["route"]);
  const checkedNotes = notes.map(one => {
    const note = one as Record<string, unknown>;
    const noteQuestion = text(note["question"], 300);
    if (noteQuestion === null) throw new Error(`Zone ${title}: every extra note needs a question.`);
    const kind = note["kind"] === "score" ? "score" : "yes-no";
    let id = typeof note["id"] === "string" && ID.test(note["id"]) ? note["id"] : sortKeyOf(noteQuestion).slice(0, 24);
    for (let n = 2; noteIds.has(id); n++) id = `${sortKeyOf(noteQuestion).slice(0, 20)}-${n}`;
    noteIds.add(id);
    const levels = kind === "score" ? (Array.isArray(note["levels"]) ? note["levels"] : []).map(level => text(level, 120)).filter((level): level is string => level !== null) : null;
    if (levels !== null && (levels.length < 2 || levels.length > 10)) throw new Error(`Zone ${title}: a score needs 2 to 10 levels, lowest first.`);
    return { id, kind, question: noteQuestion, levels } as FlowSortNote;
  });
  return { question, answers: checked, sureAt, notes: checkedNotes };
}

/** Who decides at an approval zone: its named person, the flow's owner, or null for anyone who approves on the project. */
export function deciderOf(stage: Pick<FlowStage, "approver" | "toOwner">, flow: { owner: string }): string | null {
  return stage.toOwner === true ? flow.owner : stage.approver;
}

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
      approver: kind === "approval" && stage["toOwner"] !== true ? text(stage["approver"], 64) : null,
      ...(kind === "approval" && stage["toOwner"] === true ? { toOwner: true } : {}),
      message: text(stage["message"], 1000),
      close: kind === "update" ? stage["close"] !== false : null,
      script: kind === "check" ? text(stage["script"], 40) : null,
      sort: kind === "sort" ? validateSort(stage["sort"], title) : null,
      next: kind === "sort" ? null : text(stage["next"], 32),
      onFail: text(stage["onFail"], 32),
    };
  });
  const ids = new Set<string>();
  for (const stage of stages) {
    if (ids.has(stage.id)) throw new Error(`Two zones are called ${stage.id}.`);
    ids.add(stage.id);
  }
  for (const stage of stages) {
    for (const target of [stage.next, stage.onFail, ...(stage.sort?.answers.map(one => one.to) ?? [])]) if (target !== null && !ids.has(target)) throw new Error(`Zone ${stage.title} points at a zone that no longer exists.`);
    if (stage.sort !== null && stage.sort.answers.some(one => one.to === stage.id)) throw new Error(`Zone ${stage.title}: an answer can't send cards back into the same zone.`);
    if ((stage.kind === "task" || stage.kind === "report") && stage.instructions === null) throw new Error(`Zone ${stage.title}: say what the agent should do.`);
    if (stage.kind === "draft" && stage.instructions === null) throw new Error(`Zone ${stage.title}: say what Claude should write.`);
    if (stage.kind === "notify" && stage.message === null) throw new Error(`Zone ${stage.title}: write the message to post.`);
    if (stage.kind === "check" && (stage.script === null || !SCRIPT_NAME.test(stage.script))) throw new Error(`Zone ${stage.title}: choose which script it runs.`);
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

/** A step as the lead describes it, in list order. A step that keeps an
 * existing zone (by `id`) carries over whatever it leaves out. */
export type FlowStepInput = {
  id?: string; title?: string; kind?: FlowStageKind;
  instructions?: string; planning?: "auto" | "required" | "skip"; decider?: string | null; message?: string;
  script?: string; close?: boolean;
  /** sort: the question, each answer with what it means and the step it goes to, how sure Jev must be (a percentage), and up to 3 other things to note. */
  question?: string; answers?: { answer?: string; means?: string; goesTo?: string }[]; sureAt?: number;
  alsoNote?: { question?: string; kind?: "score" | "yes-no"; levels?: string[] }[];
  next?: string; ifFails?: string; ifNotSure?: string;
};

const KIND_COLORS: Record<FlowStageKind, FlowColor> = { inbox: "slate", task: "blue", report: "violet", approval: "amber", check: "blue", update: "green", notify: "green", sort: "violet", draft: "violet", done: "green" };
/** A step id as the lead may write it (sort_by_hand, Sort-By-Hand) in the one form zones use. */
const idOf = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "zone";
const overlaps = (a: FlowZone, b: FlowZone) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** What a draft zone asks for when the steps leave it out. */
export const DRAFT_DEFAULT = "Write a short, friendly reply to the person who sent this card, in plain words.";

/** What an agent is asked when the steps leave it out: the card, any send-back note, and every earlier research step's report. */
function defaultInstructions(kind: "task" | "report", earlier: readonly FlowStage[]): string {
  const notes = earlier.filter(one => one.kind === "report").map(one => `\n\nNotes from ${one.title}:\n{{stage.${one.id}}}`).join("");
  return kind === "task"
    ? `{{card.title}}\n\n{{card.description}}${notes}\n\nChanges asked for (if any): {{note}}`
    : `Investigate this and write a short, clear report with a summary first: {{card.title}}\n\n{{card.description}}${notes}\n\nFeedback to address (if any): {{note}}`;
}

/**
 * A flow from an ordered list of steps: ids from names, each step leading
 * to the next, a Done zone at the end when none is listed, and a decision
 * sending work back to the nearest earlier step that does work. New zones
 * are laid out in rows; zones kept from `previous` keep their place.
 */
export function flowFromSteps(input: unknown, previous: FlowDefinition | null = null): FlowDefinition {
  if (!Array.isArray(input) || input.length === 0) throw new Error("List the flow's steps in order.");
  if (input.length > 24) throw new Error("A flow has 1 to 24 steps.");
  const kept = new Map((previous?.stages ?? []).map(one => [one.id, one]));
  const used = new Set<string>();
  const drafts = input.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Step ${index + 1} isn't a step.`);
    const step = raw as FlowStepInput;
    const asked = typeof step.id === "string" ? idOf(step.id) : "";
    const old = asked !== "" && !used.has(asked) ? kept.get(asked) ?? null : null;
    const title = typeof step.title === "string" && step.title.trim() !== "" ? step.title.trim() : old?.title ?? "";
    if (title === "") throw new Error(`Step ${index + 1} needs a name.`);
    const kind = step.kind ?? old?.kind;
    if (!FLOW_STAGE_KINDS.includes(kind as FlowStageKind)) throw new Error(`Step ${title}: choose what it does.`);
    // A new step keeps an id it is given (so the other steps can point at it by that id); otherwise its name makes one.
    const given = ID.test(asked) && !used.has(asked) ? asked : null;
    let id = old?.id ?? given ?? slugOf(title);
    for (let n = 2; old === null && used.has(id); n++) id = `${slugOf(title).slice(0, 25)}-${n}`;
    used.add(id);
    const same = old !== null && old.kind === kind;
    return { step, old: same ? old : null, id, title, kind: kind as FlowStageKind };
  });
  if (!drafts.some(one => one.kind === "done")) {
    let id = "done";
    for (let n = 2; used.has(id); n++) id = `done-${n}`;
    drafts.push({ step: {}, old: kept.get(id)?.kind === "done" ? kept.get(id)! : null, id, title: "Done", kind: "done" });
  }
  const find = (ref: string, from: string): string => {
    const wanted = ref.trim().toLowerCase();
    const hit = drafts.find(one => one.id === ref.trim() || one.id === idOf(ref) || one.title.toLowerCase() === wanted);
    if (hit === undefined) throw new Error(`Step ${from}: there's no step called ${ref}.`);
    return hit.id;
  };
  const stages: FlowStage[] = [];
  drafts.forEach(({ step, old, id, title, kind }, index) => {
    const earlier = stages.slice();
    const following = drafts.slice(index + 1).find(() => true) ?? null;
    const next = kind === "done" || kind === "sort" ? null
      : typeof step.next === "string" && step.next.trim() !== "" ? find(step.next, title)
      : following?.id ?? drafts.find(one => one.kind === "done")!.id;
    const keptFail = old?.onFail !== null && old?.onFail !== undefined && drafts.some(one => one.id === old.onFail) ? old.onFail : null;
    const worker = [...earlier].reverse().find(one => one.kind === "task" || one.kind === "report");
    const notSure = kind === "sort" && typeof step.ifNotSure === "string" && step.ifNotSure.trim() !== "" ? step.ifNotSure : step.ifFails;
    const onFail = kind === "done" ? null
      : typeof notSure === "string" && notSure.trim() !== "" ? find(notSure, title)
      : keptFail ?? (kind === "approval" ? worker?.id ?? (drafts[0]!.id === id ? null : drafts[0]!.id) : null);
    // "owner": whoever owns the flow when the card arrives.
    const toOwner = kind === "approval" && (step.decider === undefined ? old?.toOwner === true : typeof step.decider === "string" && /^(owner|the owner|flow owner|the flow owner|the flow's owner)$/i.test(step.decider.trim()));
    const approver = kind !== "approval" || toOwner ? null
      : step.decider === undefined ? old?.approver ?? null
      : step.decider === null || /^(anyone|any approver|anybody)$/i.test(step.decider.trim()) ? null : step.decider.trim();
    stages.push({
      id, title, kind,
      zone: old?.zone ?? { x: 0, y: 0, w: 260, h: kind === "done" || kind === "notify" ? 220 : 300, color: KIND_COLORS[kind] },
      // A kept step on our default instructions gets the default again, so it reads any research step added before it.
      instructions: kind === "draft" ? step.instructions?.trim() || old?.instructions || DRAFT_DEFAULT
        : kind === "task" || kind === "report"
        ? step.instructions?.trim() || (old?.instructions && old.instructions !== defaultInstructions(kind, previous!.stages.slice(0, previous!.stages.indexOf(old))) ? old.instructions : defaultInstructions(kind, earlier))
        : null,
      planning: kind === "task" ? step.planning ?? old?.planning ?? "auto" : null,
      approver,
      ...(toOwner ? { toOwner: true } : {}),
      message: kind === "notify" ? step.message?.trim() || old?.message || (drafts.find(one => one.id === next)?.kind === "done" ? "Finished: {{card.title}}" : "Update on {{card.title}}")
        : kind === "update" ? step.message?.trim() || old?.message || "Done: {{card.title}}" : null,
      close: kind === "update" ? step.close ?? old?.close ?? true : null,
      script: kind === "check" ? step.script?.trim() || old?.script || null : null,
      sort: kind === "sort" ? sortFromStep(step, old?.sort ?? null, ref => find(ref, title)) : null,
      next, onFail,
    });
  });
  // Lay out the new zones: in rows of four on a new flow, beside the step before them on an edited one.
  const placed = stages.filter(one => kept.get(one.id)?.zone === one.zone).map(one => one.zone);
  stages.forEach((stage, index) => {
    if (placed.includes(stage.zone)) return;
    let at: FlowZone;
    if (previous === null) {
      const row = Math.floor(index / 4), column = index % 4;
      at = { ...stage.zone, x: (row % 2 === 0 ? column : 3 - column) * 300, y: row * 380 };
    } else {
      const before = index > 0 ? stages[index - 1]!.zone : null;
      at = { ...stage.zone, x: before === null ? 0 : before.x + 300, y: before === null ? Math.max(0, ...placed.map(one => one.y + one.h + 80)) : before.y };
      for (let tries = 0; tries < 40 && placed.some(one => overlaps(one, at)); tries++) at = { ...at, y: at.y + 380 };
    }
    stage.zone = at;
    placed.push(at);
  });
  return validateFlowDefinition({ version: 1, start: stages[0]!.id, stages });
}

/** A sort step as the lead describes it: answers name the steps they go to; what it leaves out carries over from the zone it keeps. */
function sortFromStep(step: FlowStepInput, old: FlowSort | null, find: (ref: string) => string): FlowSort {
  const answers = Array.isArray(step.answers) && step.answers.length > 0
    ? step.answers.map(one => ({ answer: String(one?.answer ?? "").trim(), means: String(one?.means ?? "").trim() || String(one?.answer ?? "").trim(), to: typeof one?.goesTo === "string" && one.goesTo.trim() !== "" ? find(one.goesTo) : "" }))
    : old?.answers ?? [];
  // A percentage (80) or a fraction (0.8).
  const sure = typeof step.sureAt === "number" && Number.isFinite(step.sureAt) ? (step.sureAt > 1 ? step.sureAt / 100 : step.sureAt) : old?.sureAt ?? SORT_SURE_AT;
  const notes = Array.isArray(step.alsoNote) ? step.alsoNote.map(one => ({ id: "", kind: one?.kind === "score" ? "score" as const : "yes-no" as const, question: String(one?.question ?? "").trim(), levels: one?.kind === "score" ? (one.levels ?? []).map(String) : null }))
    : old?.notes ?? [];
  return { question: step.question?.trim() || old?.question || "", answers, sureAt: sure, notes };
}

/** What confirming a new or changed flow means, in the canvas's words: each step's job and path, what changed, and that the usual approvals still apply. */
export function flowTerms(definition: FlowDefinition, previous: FlowDefinition | null): string[] {
  const titleOf = (id: string | null) => definition.stages.find(one => one.id === id)?.title ?? "nowhere";
  // "Then → Go ahead?" ends a sentence already.
  const to = (id: string | null) => { const title = titleOf(id); return /[.?!]$/.test(title) ? title : `${title}.`; };
  // Fill-ins read as what they will hold.
  const plain = (text: string) => text.replace(/\{\{\s*(card\.title|card\.description|note|stage\.([a-z0-9-]+))\s*\}\}/g, (_match, key: string, stage: string | undefined) =>
    key === "card.title" ? "[card title]" : key === "card.description" ? "[card details]" : key === "note" ? "[send-back note]" : `[${titleOf(stage ?? null)} report]`);
  const same = (a: FlowStage, b: FlowStage) => JSON.stringify({ ...a, zone: null }) === JSON.stringify({ ...b, zone: null });
  const describe = (stage: FlowStage, index: number, mark: string): string => {
    const lines = [`${index + 1}. ${stage.title} — ${FLOW_KIND_WORDS[stage.kind].label}${mark}`];
    if (stage.kind === "task" || stage.kind === "report") {
      // Instructions the steps left to us are said in words; the operator's own are shown as written.
      const earlier = definition.stages.slice(0, index);
      const reports = earlier.filter(one => one.kind === "report").map(one => one.title);
      const notes = reports.length === 0 ? "" : `, using the notes from ${reports.join(" and ")}`;
      lines.push(stage.instructions !== defaultInstructions(stage.kind, earlier) ? `The agent is asked: ${plain(stage.instructions ?? "")}`
        : stage.kind === "task" ? `The agent builds what the card asks${notes}, plus any note it was sent back with.`
        : `The agent looks into the card and writes a short report${notes}, plus any note it was sent back with.`);
    }
    if (stage.kind === "task" && stage.planning !== "auto") lines.push(stage.planning === "required" ? "Plans first." : "Builds without a plan.");
    if (stage.kind === "draft") lines.push(`Claude writes: ${plain(stage.instructions ?? "")}`, `Then → ${to(stage.next)}`);
    else if (stage.kind === "approval") lines.push(`Decides: ${stage.toOwner === true ? "the flow's owner, in their chat app" : stage.approver ?? "anyone who approves on this project"}. Approve → ${to(stage.next)} Send back → ${stage.onFail === null ? "not possible." : to(stage.onFail)}`);
    else if (stage.kind === "notify") lines.push(`Posts: ${plain(stage.message ?? "")}`, `Then → ${to(stage.next)}`);
    else if (stage.kind === "update") lines.push(`Comments on the issue the card came from: ${plain(stage.message ?? "")}${stage.close === true ? " Then closes it (Linear: moves it to done)." : ""}`, `Then → ${to(stage.next)}${stage.onFail === null ? "" : ` If it can't → ${to(stage.onFail)}`}`);
    else if (stage.kind === "sort" && stage.sort !== null) {
      const percent = Math.round(stage.sort.sureAt * 100);
      lines.push(`Jev asks: ${stage.sort.question}`, ...stage.sort.answers.map(one => `${one.answer} → ${to(one.to)}`),
        `Less than ${percent}% sure → ${stage.onFail === null ? "waits here for a person." : to(stage.onFail)}`);
      if (stage.sort.notes.length > 0) lines.push(`Also notes: ${stage.sort.notes.map(one => one.kind === "score" ? `${one.question} (${one.levels?.join(" / ")})` : `${one.question} (yes or no)`).join("; ")}`);
    }
    else if (stage.kind === "check") lines.push(`Runs the project's script “${stage.script}” with no AI.`, `Passes → ${to(stage.next)}${stage.onFail === null ? " Fails → waits there." : ` Fails → ${to(stage.onFail)}`}`);
    else if (stage.next !== null) lines.push(`Then → ${to(stage.next)}${stage.onFail === null ? "" : ` If it fails → ${to(stage.onFail)}`}`);
    return lines.join("\n");
  };
  const terms: string[] = [];
  if (previous === null) terms.push(...definition.stages.map((stage, index) => describe(stage, index, "")));
  else {
    terms.push(`Steps: ${definition.stages.map(one => one.title).join(" → ")}`);
    definition.stages.forEach((stage, index) => {
      const old = previous.stages.find(one => one.id === stage.id);
      if (old === undefined || !same(old, stage)) terms.push(describe(stage, index, old === undefined ? " (new)" : " (changed)"));
    });
    const removed = previous.stages.filter(one => !definition.stages.some(stage => stage.id === one.id));
    if (removed.length > 0) terms.push(`Removes ${removed.map(one => one.title).join(", ")}. Any cards there go back to ${titleOf(definition.start)}.`);
  }
  // New cards that start in a holding zone aren't sorted until someone moves them to the sort: say so before it's confirmed.
  const first = definition.stages.find(one => one.id === definition.start);
  const sorter = definition.stages.find(one => one.kind === "sort");
  if (first?.kind === "inbox" && sorter !== undefined) terms.push(`New cards wait in ${first.title}, so ${sorter.title} only sorts the cards someone moves there.`);
  terms.push("Build and research steps become ordinary tasks, so your usual approvals and checks apply.");
  if (definition.stages.some(one => one.kind === "sort")) terms.push("Sort steps send each card's title, details and earlier notes to Jev through your OpenRouter account.");
  if (definition.stages.some(one => one.kind === "draft")) terms.push("Draft steps send each card's text to Claude through the lead chat's sign-in. Nothing a draft writes is sent until a later step sends it.");
  return terms;
}

const zone = (x: number, y: number, color: FlowColor, h = 300): FlowZone => ({ x, y, w: 260, h, color });
const stage = (id: string, title: string, kind: FlowStageKind, at: FlowZone, rest: Partial<FlowStage> = {}): FlowStage =>
  ({ id, title, kind, zone: at, instructions: null, planning: kind === "task" ? "auto" : null, approver: null, message: null, close: kind === "update" ? true : null, script: null, sort: null, next: null, onFail: null, ...rest });

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
        stage("go-ahead", "Go ahead?", "approval", zone(600, 0, "amber"), { toOwner: true, next: "build", onFail: "inbox" }),
        stage("build", "Build", "task", zone(900, 0, "blue"), {
          instructions: "{{card.title}}\n\n{{card.description}}\n\nTriage notes:\n{{stage.triage}}\n\nRequested changes (if any): {{note}}",
          next: "review",
        }),
        stage("review", "Review", "approval", zone(900, 380, "amber"), { toOwner: true, next: "announce", onFail: "build" }),
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
        stage("check", "Check", "approval", zone(600, 0, "amber"), { toOwner: true, next: "share", onFail: "research" }),
        stage("share", "Share", "notify", zone(900, 0, "green", 220), { message: "Answered: {{card.title}}", next: "done" }),
        stage("done", "Done", "done", zone(900, 250, "green", 220)),
      ],
    },
  },
  {
    id: "triage",
    label: "Issue triage",
    about: "Jev sorts new issues into bugs, feature ideas and questions, and says how urgent each is. Bugs get fixed; questions get researched and a reply drafted. The flow's owner approves both in their chat app.",
    definition: {
      version: 1,
      start: "sort",
      stages: [
        stage("sort", "Sort new issues", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "What kind of request is this?",
            answers: [
              { answer: "Bug", means: "Something is broken, crashes or behaves wrongly", to: "fix" },
              { answer: "Feature", means: "A request for something new, or to change how something works", to: "ideas" },
              { answer: "Question", means: "Someone asking how to do something, or asking for help", to: "answer" },
              { answer: "Something else", means: "Anything that isn't a bug, a feature request or a question", to: "by-hand" },
            ],
            sureAt: 0.8,
            notes: [{ id: "urgency", kind: "score", question: "How urgent is this?", levels: ["Routine: no deadline and nothing is blocked", "Soon: it hurts, but there's a workaround", "Now: something is blocked, broken for many people, or there's a deadline"] }],
          },
          onFail: "by-hand",
        }),
        stage("fix", "Fix it", "task", zone(420, 0, "blue"), { instructions: "{{card.title}}\n\n{{card.description}}\n\nChanges asked for (if any): {{note}}", next: "review" }),
        stage("review", "Review the fix", "approval", zone(840, 0, "amber"), { toOwner: true, next: "close", onFail: "fix" }),
        stage("close", "Close the issue", "update", zone(1260, 0, "green", 220), { message: "Fixed: {{card.title}}. Thanks for the report!", next: "done" }),
        stage("by-hand", "Sort by hand", "inbox", zone(0, 400, "slate")),
        stage("answer", "Answer it", "report", zone(420, 340, "violet"), {
          instructions: "Answer this question for the person who asked: clearly, briefly and in plain words, using what is in the repository.\n\nQuestion: {{card.title}}\n{{card.description}}\n\nFeedback to address (if any): {{note}}",
          next: "write-reply",
        }),
        stage("write-reply", "Write the reply", "draft", zone(840, 340, "violet"), {
          instructions: "Write a short, friendly reply to the person who asked, answering their question from the research notes. Plain words; say what to do next if anything.",
          next: "check-answer",
        }),
        stage("check-answer", "Check the reply", "approval", zone(1260, 340, "amber"), { toOwner: true, next: "reply", onFail: "write-reply" }),
        stage("reply", "Reply on the issue", "update", zone(1680, 340, "green", 220), { message: "{{stage.write-reply}}", next: "done" }),
        stage("ideas", "Feature ideas", "inbox", zone(420, 680, "slate")),
        stage("done", "Done", "done", zone(2100, 170, "green", 220)),
      ],
    },
  },
  {
    id: "spam-filter",
    label: "Spam filter",
    about: "Jev screens what a public form or webhook brings in. Genuine requests wait in Requests (another flow can start from there); spam and abuse are filtered out.",
    definition: {
      version: 1,
      start: "screen",
      stages: [
        stage("screen", "Screen", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "Is this a genuine request from a person?",
            answers: [
              { answer: "Genuine", means: "A real question, report or request from a person, even if it is short or badly written", to: "requests" },
              { answer: "Spam", means: "Advertising, SEO or crypto offers, lists of links, gibberish, or anything automated", to: "filtered" },
              { answer: "Abusive", means: "Harassment, threats, slurs or hateful content", to: "filtered" },
            ],
            sureAt: 0.9,
            notes: [],
          },
          onFail: "by-hand",
        }),
        stage("requests", "Requests", "inbox", zone(420, 0, "slate")),
        stage("by-hand", "Check by hand", "inbox", zone(0, 400, "amber")),
        stage("filtered", "Filtered out", "done", zone(420, 340, "rose", 220)),
      ],
    },
  },
  {
    id: "lead-routing",
    label: "Lead routing",
    about: "Jev sorts new enquiries by what they want and notes how ready they are to buy. New projects ping the team straight away.",
    definition: {
      version: 1,
      start: "sort",
      stages: [
        stage("sort", "Sort", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "What is this enquiry mainly about?",
            answers: [
              { answer: "New project", means: "They want something new built, designed or set up", to: "tell-team" },
              { answer: "Existing work", means: "A client asking about work that is already underway or delivered", to: "clients" },
              { answer: "Partnership", means: "A proposed partnership, referral or reselling arrangement", to: "partners" },
              { answer: "Not a fit", means: "Job seekers, vendors selling to us, students, or anyone who isn't a potential client", to: "not-a-fit" },
            ],
            sureAt: 0.8,
            notes: [
              { id: "ready", kind: "score", question: "How ready are they to buy?", levels: ["Just looking: no clear need yet", "Planning: a clear need, but no timeline or budget", "Ready: they name a budget, a date or a decision"] },
              { id: "when", kind: "yes-no", question: "Do they say when they need it?", levels: null },
            ],
          },
          onFail: "by-hand",
        }),
        stage("tell-team", "Tell the team", "notify", zone(420, 0, "green", 220), { message: "New project enquiry: {{card.title}}. {{stage.sort}}", next: "projects" }),
        stage("projects", "New projects", "inbox", zone(840, 0, "slate")),
        stage("by-hand", "Sort by hand", "inbox", zone(0, 400, "amber")),
        stage("clients", "Existing clients", "inbox", zone(420, 340, "slate")),
        stage("partners", "Partnerships", "inbox", zone(420, 680, "slate")),
        stage("not-a-fit", "Not a fit", "done", zone(420, 1020, "rose", 220)),
      ],
    },
  },
  {
    id: "effort-routing",
    label: "Effort routing",
    about: "Jev sends small, clear changes straight to a build, and big or unclear ones through a plan and a person first. When it isn't sure, it takes the careful path.",
    definition: {
      version: 1,
      start: "size",
      stages: [
        stage("size", "Size it", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "How much work is this change?",
            answers: [
              { answer: "Small", means: "A small, clear change in one or two places: a typo, a label, a setting or an obvious fix", to: "quick" },
              { answer: "Big", means: "Touches many places, needs design choices, changes stored data, or is unclear", to: "plan" },
            ],
            sureAt: 0.85,
            notes: [],
          },
          onFail: "plan",
        }),
        stage("quick", "Build it", "task", zone(420, 0, "blue"), { planning: "skip", instructions: "{{card.title}}\n\n{{card.description}}\n\nChanges asked for (if any): {{note}}", next: "check-quick" }),
        stage("check-quick", "Review", "approval", zone(840, 0, "amber"), { toOwner: true, next: "done", onFail: "quick" }),
        stage("plan", "Plan it", "report", zone(420, 340, "violet"), {
          instructions: "Investigate this change and write a short plan: what is asked, which files it touches, the risks, the open questions and a rough size.\n\nRequest: {{card.title}}\n{{card.description}}\n\nFeedback to address (if any): {{note}}",
          next: "go-ahead",
        }),
        stage("go-ahead", "Go ahead?", "approval", zone(840, 340, "amber"), { toOwner: true, next: "build", onFail: "plan" }),
        stage("build", "Build it carefully", "task", zone(1260, 340, "blue"), { planning: "required", instructions: "{{card.title}}\n\n{{card.description}}\n\nThe agreed plan:\n{{stage.plan}}\n\nChanges asked for (if any): {{note}}", next: "review" }),
        stage("review", "Review", "approval", zone(1680, 340, "amber"), { toOwner: true, next: "done", onFail: "build" }),
        stage("done", "Done", "done", zone(1680, 0, "green", 220)),
      ],
    },
  },
  {
    id: "exception-routing",
    label: "Exception routing",
    about: "Jev sorts customer problems (order changes, invoice problems, deliveries) to the team that owns each, and notes how urgent each is and whether they want money back.",
    definition: {
      version: 1,
      start: "sort",
      stages: [
        stage("sort", "Sort", "sort", zone(0, 0, "violet"), {
          sort: {
            question: "What kind of problem is this?",
            answers: [
              { answer: "Order change", means: "The customer wants to change, cancel or add to an order", to: "orders" },
              { answer: "Invoice problem", means: "A wrong amount, a duplicate charge, missing details or a disputed invoice", to: "billing" },
              { answer: "Delivery problem", means: "An order that is late, lost, damaged or wrong", to: "delivery" },
              { answer: "Something else", means: "Anything that isn't about an order, an invoice or a delivery", to: "by-hand" },
            ],
            sureAt: 0.8,
            notes: [
              { id: "urgency", kind: "score", question: "How urgent is it?", levels: ["Routine: no deadline", "Soon: the customer is waiting on it", "Now: money is at stake or a deadline is named"] },
              { id: "refund", kind: "yes-no", question: "Is the customer asking for money back?", levels: null },
            ],
          },
          onFail: "by-hand",
        }),
        stage("orders", "Orders team", "inbox", zone(420, 0, "blue"), { next: "done" }),
        stage("billing", "Billing team", "inbox", zone(420, 340, "amber"), { next: "done" }),
        stage("delivery", "Delivery team", "inbox", zone(420, 680, "green"), { next: "done" }),
        stage("by-hand", "Sort by hand", "inbox", zone(0, 400, "slate")),
        stage("done", "Done", "done", zone(840, 340, "green", 220)),
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

