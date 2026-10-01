/** Quiet chat: a task's whole life is one chat message edited in place, and a
 * new message arrives only when a person is needed. Every transport (Telegram,
 * Slack, Discord, Teams) asks the same questions here: does this fact need a
 * person, what does the task's card say now, and what does the Ready ping say.
 * Delivery receipts, claims and retries stay with each transport; the
 * console's activity keeps every fact whatever a chat showed. */
import { assignmentOf } from "./assignment.js";
import { chatControlHref } from "./chat-controls.js";
import { telegramProgressCard, type ProgressEntity } from "./telegram-progress.js";
import { assignmentStatusFacts, headlineEmoji, taskStatusOf, type Headline } from "./task-status.js";
import { phoneText, projectLabel, type PhoneTaskLink } from "./telegram-status.js";
import { isLifecycleNotification, type Notification, type Run, type Store } from "./store.js";

export type QuietView = { text: string; entities: ProgressEntity[]; link: PhoneTaskLink };

/** What always makes a new message, even in quiet mode: a question or approval waiting, a failure or other
 * attention fact, a result Ready for review, a security alert or release, and anything addressed to one person
 * (a sign-in or plan-limit pause, an evening digest). */
const NEEDED_KINDS = new Set([
  "acceptance-ready", "acceptance-evidence", "flow-decision", "flow-card", "plan-ready", "report-ready",
  "stale-approval", "security-release", "secret-detected",
]);

export function needsPerson(row: Pick<Notification, "dedupeKey" | "kind" | "pushClass" | "recipient">): boolean {
  if (row.recipient !== null) return true;
  if (/^decision:\d+$/.test(row.dedupeKey)) return true;
  if (row.pushClass !== null && row.pushClass !== "progress") return true;
  if (NEEDED_KINDS.has(row.kind)) return true;
  // A built or unchanged result is Ready: the one lifecycle step that asks for a person.
  return isLifecycleNotification(row) && row.kind === "run-finished";
}

/** A fact about one placed task: in quiet mode it lands on that task's card. */
export function isTaskFact(row: Pick<Notification, "taskRef" | "taskId" | "project">): row is typeof row & { taskRef: number; taskId: string; project: string } {
  return row.taskRef !== null && row.taskId !== null && row.project !== null;
}

/** The attempt a task's card follows: its newest builder attempt, outside any contest. */
function cardRun(store: Store, taskRef: number): Run | null {
  return store.runsFor(taskRef).find(run => run.role === "builder" && run.contestant === null) ?? null;
}

/** Before any attempt starts, the card says where the task stands in the words of its last lifecycle fact. */
const before = (headline: Headline) => ({ icon: headlineEmoji(headline), status: headline });
const BEFORE_RUN: Record<string, { icon: string; status: string }> = {
  "task-filed": before("Queued"),
  "scope-approved": before("Queued"),
  "approval-withdrawn": before("Needs you"),
  "task-held": before("Stopped"),
  "task-released": before("Queued"),
  "task-queued": before("Queued"),
  "task-requeued": before("Queued"),
  "task-cancelled": before("Stopped"),
};

type TaskLine = { title: string; icon: string; status: string; project: string; view: QuietView };

function taskLine(store: Store, taskRef: number, now: Date, root?: string): TaskLine | null {
  const ref = store.refById(taskRef);
  if (ref === null || ref.repo === null) return null;
  const task = store.getTask(ref.externalId);
  const title = phoneText(task?.title ?? ref.externalId, 88);
  const run = cardRun(store, taskRef);
  if (run !== null) {
    const view = telegramProgressCard(store, run, ref.externalId, ref.repo, now, root);
    const heading = view.entities[1] === undefined ? "" : view.text.slice(view.entities[1].offset, view.entities[1].offset + view.entities[1].length);
    const split = heading.indexOf(" ");
    return { title, icon: heading.slice(0, split), status: heading.slice(split + 1), project: ref.repo, view };
  }
  const fact = store.latestTaskFact(taskRef);
  const words = task?.state === "cancelled" ? BEFORE_RUN["task-cancelled"]! : BEFORE_RUN[fact?.kind ?? ""] ?? BEFORE_RUN["task-filed"]!;
  const heading = `${words.icon} ${words.status}`;
  const text = [title, heading, "", `${projectLabel(ref.repo)} · ${ref.externalId}`].join("\n");
  return { title, icon: words.icon, status: words.status, project: ref.repo, view: {
    text, entities: [{ type: "bold", offset: 0, length: title.length }, { type: "bold", offset: title.length + 1, length: heading.length }],
    link: { label: "Open task", path: chatControlHref("task", ref.externalId) },
  } };
}

/** The card's words now: one task's progress card, or one line per task when several were filed together. */
export function quietCardView(store: Store, taskRefs: readonly number[], now: Date, root?: string): QuietView | null {
  const lines = taskRefs.map(ref => taskLine(store, ref, now, root)).filter((one): one is TaskLine => one !== null);
  if (lines.length === 0) return null;
  if (lines.length === 1) return lines[0]!.view;
  const heading = `${lines.length} tasks`;
  const projects = [...new Set(lines.map(one => projectLabel(one.project)))];
  const text = [heading, ...lines.map(one => `${one.icon} ${phoneText(one.title, 60)} · ${one.status}`), "", projects.join(", ")].join("\n");
  return { text, entities: [{ type: "bold", offset: 0, length: heading.length }], link: { label: "Open tasks", path: "/tasks" } };
}

/** The one ping for a Ready result: its state and title, what to do next, and a link to that exact result. */
export function readyPingView(store: Store, run: Run, taskId: string, project: string, now: Date, root?: string): QuietView {
  const card = telegramProgressCard(store, run, taskId, project, now, root);
  const [title = "", shown = ""] = card.entities.map(one => card.text.slice(one.offset, one.offset + one.length));
  const heading = shown;
  const next = card.next;
  const first = `${heading} · ${title}`;
  return { text: next === "" ? first : `${first}\n${next}`, entities: [{ type: "bold", offset: 0, length: heading.length }], link: card.link };
}

// ---- the evening digest ----------------------------------------------------------

const FAILURE = /fail|exhausted|fenced/;
const pad = (n: number) => String(n).padStart(2, "0");
/** This computer's local day and time, which is what a person means by "the evening". */
export function localDay(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
export function localTime(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** One person's evening: what finished and what failed in the last day, and what waits for them now. Null when
 * nothing happened, so a quiet day sends nothing. */
export function eveningDigestText(store: Store, account: string, now: Date, root?: string): string | null {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const recent = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const visible = (row: Notification) => row.project !== null && store.accountCanAccess(account, row.project);
  const title = (taskId: string) => phoneText(store.getTask(taskId)?.title ?? taskId, 80);
  const finished = new Map<string, string>(), failed = new Map<string, string>(), waits = new Map<string, string>();
  const facts = store.taskFactsSince(recent).filter(visible);
  for (const row of facts) {
    if (row.createdAt < since || row.taskId === null) continue;
    if (isLifecycleNotification(row) && row.kind === "run-finished") finished.set(row.taskId, title(row.taskId));
    else if (FAILURE.test(row.kind)) failed.set(row.taskId, title(row.taskId));
  }
  for (const taskId of new Set(facts.map(row => row.taskId).filter((one): one is string => one !== null))) {
    let headline: Headline | null = null;
    try {
      const project = facts.find(row => row.taskId === taskId)!.project!;
      const assignment = assignmentOf(store, taskId, now, { principal: "operator", repos: [project] }, root);
      headline = assignment === null ? null : taskStatusOf(assignmentStatusFacts(assignment)).headline;
    } catch { headline = null; }
    if (headline === "Ready for review" || headline === "Needs you") waits.set(taskId, `${title(taskId)} · ${headline}`);
    else if (headline === "Failed") failed.set(taskId, title(taskId));
  }
  if (finished.size + failed.size + waits.size === 0) return null;
  const section = (name: string, items: Map<string, string>) => items.size === 0 ? [] : ["", `${name} (${items.size})`, ...[...items.values()].slice(0, 12).map(one => `• ${one}`), ...(items.size > 12 ? [`• and ${items.size - 12} more`] : [])];
  return [...section("Finished", finished), ...section("Waiting for you", waits), ...section("Failed", failed)].slice(1).join("\n");
}

/** Record each due evening digest once per person per local day, as one notification addressed to that person:
 * every chat they paired delivers it with the usual receipts, and the console keeps it. */
export function enqueueEveningDigests(store: Store, now: Date, root?: string): number {
  const day = localDay(now), time = localTime(now);
  let queued = 0;
  for (const person of store.eveningDigestPeople()) {
    if (person.digestAt > time || (person.digestOn !== null && person.digestOn >= day)) continue;
    store.transact(() => {
      if (!store.claimEveningDigestDay(person.account, day)) return;
      const body = eveningDigestText(store, person.account, now, root);
      if (body === null) return;
      if (store.enqueueNotification({ dedupeKey: `digest:evening:${person.account}:${day}`, kind: "evening-digest", subject: "Evening digest", body,
        link: "/tasks", source: { installation: true }, recipient: person.account }, now)) queued++;
    });
  }
  return queued;
}
