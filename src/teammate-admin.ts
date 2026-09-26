/**
 * Looking after AI teammates (v92): making one from a template or a soul
 * file, editing its soul (a new version each time), pausing or removing it,
 * telling it something, and the daily summary it sends its manager.
 *
 * Shared by the Teammates pages and the lead chat, so both do the same thing.
 */
import type { Store, TeammateRow } from "./store.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { handleOf, parseSoul, TEAMMATE_TEMPLATES, teammateLabel } from "./teammates.js";

export type Done = { ok: true; said: string; id?: number } | { ok: false; said: string };
export const TEAMMATE_MODELS = ["default", "sonnet", "opus", "haiku"] as const;

/** A soul file with a different name: the template's, renamed. */
export function renamedSoul(soul: string, name: string): string {
  return soul.replace(/^name:.*$/m, `name: ${name.replace(/[\r\n]/g, " ").trim()}`);
}

/** A new teammate in a project, from a template (optionally renamed) or a whole soul file. */
export function createTeammateFrom(store: Store, input: { repo: string; template?: string | null; name?: string | null; soul?: string | null; by: string }, now: Date): Done {
  const template = TEAMMATE_TEMPLATES.find(one => one.id === input.template);
  let soul = input.soul?.trim() ? input.soul : template?.soul ?? null;
  if (soul === null) return { ok: false, said: "Start from a template, or write a soul file." };
  if (input.name?.trim()) soul = renamedSoul(soul, input.name);
  const read = parseSoul(soul);
  if (!read.ok) return { ok: false, said: read.problem };
  const handle = handleOf(read.soul.name);
  if (store.teammateByHandle(input.repo, handle) !== null) return { ok: false, said: `There's already a teammate called ${read.soul.name} in this project. Give this one another name.` };
  const id = store.createTeammate({ repo: input.repo, handle, soul, model: null, manager: input.by, by: input.by }, now);
  store.addTeammateEvent({ teammate: id, kind: "note", said: `${input.by} brought ${read.soul.name} onto the team.`, by: input.by }, now);
  return { ok: true, said: `${teammateLabel(read.soul)} is on the team. Put ${read.soul.name} on a zone to start.`, id };
}

/** Save a new version of a teammate's soul file. Its name stays: zones name it by handle. */
export function saveSoul(store: Store, mate: TeammateRow, soul: string, by: string, now: Date): Done {
  const read = parseSoul(soul);
  if (!read.ok) return { ok: false, said: read.problem };
  if (handleOf(read.soul.name) !== mate.handle) return { ok: false, said: `Keep the name (zones find this teammate as ${mate.handle}); make a new teammate for another name.` };
  const saved = store.saveTeammateSoul(mate.id, soul.replace(/\r\n?/g, "\n").trim() + "\n", by, now);
  return { ok: true, said: saved ? `Saved. ${read.soul.name} works from version ${mate.version + 1} now.` : "No changes to save." };
}

/** Pause, resume or remove. Paused, its decisions go to people and the zones it handles wait. */
export function setTeammateState(store: Store, mate: TeammateRow, state: "active" | "paused" | "removed", by: string, now: Date): Done {
  const name = nameOf(mate);
  if (state === mate.state) return { ok: true, said: "No change." };
  if (state === "removed") {
    for (const question of store.openTeammateQuestions([mate.id])) store.dropTeammateQuestion(question.id, now);
    store.updateTeammate(mate.id, { state }, by, now);
    return { ok: true, said: `${name} is off the team. Zones that named ${name} go to people now.` };
  }
  store.updateTeammate(mate.id, { state }, by, now);
  store.addTeammateEvent({ teammate: mate.id, kind: state === "paused" ? "paused" : "resumed", said: state === "paused" ? `${by} paused ${name}.` : `${by} set ${name} working again.`, by }, now);
  return { ok: true, said: state === "paused" ? `${name} is paused. Its decisions go to people until you resume it.` : `${name} is working again.` };
}

/** Something for the teammate to keep in mind: every turn reads the latest ten. */
export function leaveNote(store: Store, mate: TeammateRow, note: string, by: string, now: Date): Done {
  const text = note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (text === "") return { ok: false, said: "Write what it should know." };
  if (text.length > 1000) return { ok: false, said: "Keep a note to 1,000 characters; put lasting rules in its soul file." };
  store.addTeammateEvent({ teammate: mate.id, kind: "note", said: text, by }, now);
  return { ok: true, said: `${nameOf(mate)} will keep that in mind.` };
}

export function teammateSettings(store: Store, mate: TeammateRow, change: { model?: string; dailyTurns?: number; manager?: string }, by: string, now: Date): Done {
  const model = change.model === undefined ? undefined : change.model === "default" ? null : TEAMMATE_MODELS.includes(change.model as typeof TEAMMATE_MODELS[number]) ? change.model : undefined;
  if (change.model !== undefined && model === undefined) return { ok: false, said: "Choose one of the models listed." };
  if (change.dailyTurns !== undefined && (!Number.isInteger(change.dailyTurns) || change.dailyTurns < 1 || change.dailyTurns > 2000)) return { ok: false, said: "A daily limit is 1 to 2,000 turns." };
  if (change.manager !== undefined && !store.accountCanAccess(change.manager, mate.repo)) return { ok: false, said: "Its manager must be someone on this project." };
  store.updateTeammate(mate.id, { ...(model === undefined ? {} : { model }), ...(change.dailyTurns === undefined ? {} : { dailyTurns: change.dailyTurns }), ...(change.manager === undefined ? {} : { manager: change.manager }) }, by, now);
  return { ok: true, said: "Saved." };
}

export const nameOf = (mate: TeammateRow) => { const read = parseSoul(mate.soul); return read.ok ? read.soul.name : mate.handle; };
export const labelOf = (mate: TeammateRow) => { const read = parseSoul(mate.soul); return read.ok ? teammateLabel(read.soul) : mate.handle; };

/** Every zone a teammate works, in every flow of its project. */
export function zonesOf(store: Store, mate: TeammateRow): { flow: number; flowName: string; zone: string; title: string; kind: "decides" | "handles" }[] {
  return store.listFlows([mate.repo]).flatMap(flow => (flowDefinitionOf(flow)?.stages ?? []).filter(one => one.teammate === mate.handle)
    .map(one => ({ flow: flow.id, flowName: flow.name, zone: one.id, title: one.title, kind: one.kind === "approval" ? "decides" as const : "handles" as const })));
}

/** What a teammate did since a time, in words its manager reads at a glance. */
export function summaryOf(store: Store, mate: TeammateRow, since: string | null): { said: string; quiet: boolean } {
  const name = nameOf(mate);
  const events = store.teammateEvents(mate.id, 500, since);
  const count = (kind: string) => events.filter(one => one.kind === kind).length;
  const decided = count("decided"), handled = count("handled"), handed = count("handed"), asked = count("asked"), failed = count("failed");
  const open = store.openTeammateQuestions([mate.id]).length;
  const quiet = decided + handled + handed + asked + failed === 0;
  const lines = [
    quiet ? `${name} had nothing to do${since === null ? " yet" : " today"}.` : `${name} decided ${decided}, handled ${handled}, handed ${handed} to people, and asked ${asked} question${asked === 1 ? "" : "s"}${failed > 0 ? `; ${failed} turn${failed === 1 ? "" : "s"} failed` : ""}.`,
    ...(open > 0 ? [`${open} question${open === 1 ? " is" : "s are"} waiting for an answer.`] : []),
    ...events.filter(one => one.kind === "handed" || one.kind === "failed").slice(0, 5).map(one => `• ${one.said}`),
  ];
  return { said: lines.join("\n"), quiet };
}

/** The daily summary, to each teammate's manager, once a day after 5 pm (this computer's time), or now when asked. */
export function sendTeammateSummaries(store: Store, repo: string, now: Date, only: number | null = null): number {
  const evening = new Date(now); evening.setHours(17, 0, 0, 0);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  let sent = 0;
  for (const mate of store.teammates([repo])) {
    if (only !== null ? mate.id !== only : mate.state !== "active" || now < evening || (mate.summaryAt !== null && mate.summaryAt >= evening.toISOString())) continue;
    const summary = summaryOf(store, mate, start.toISOString());
    store.updateTeammate(mate.id, { summaryAt: now.toISOString() }, "summary", now);
    if (summary.quiet && only === null) continue;
    store.enqueueNotification({ dedupeKey: `teammate-summary:${mate.id}:${now.toISOString().slice(0, only === null ? 10 : 19)}`, kind: "teammate-summary", recipient: mate.manager,
      subject: `${labelOf(mate)}: today`, body: summary.said, link: `/teammates/${mate.id}`, source: { project: repo } }, now);
    store.addTeammateEvent({ teammate: mate.id, kind: "summary", said: summary.said }, now);
    sent++;
  }
  return sent;
}
