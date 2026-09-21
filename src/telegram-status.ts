import { publicChatText } from './chat-display.js';
import { manualReviewOnly } from "./proof.js";
/** Read-only phone views over the same dispatch and proof records as chat.
 * No provider calls, repository access, new workflow state, or inferred success. */
import { diagnoseTaskDispatch, withDispatchDiagnoses, type DispatchDiagnosis } from "./dispatch.js";
import type { Notification, Store } from "./store.js";
import { CHAT_CONTROLS, chatControlHref, chatResultHref, type ChatControl } from "./chat-controls.js";

export type PhoneCommand = { kind: "status" } | { kind: "help" } | { kind: "task"; id: string };

export function phoneCommand(text: string): PhoneCommand | null {
  // Slash forms everywhere; the bare words too, because Slack and Discord
  // keep unregistered slash text for themselves. Only a whole message that
  // is exactly the command counts — prose never is.
  const t = text.trim();
  if (/^\/?(?:help|start)$/i.test(t)) return { kind: "help" };
  if (/^\/?status$/i.test(t)) return { kind: "status" };
  const task = /^\/?task\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/i.exec(t);
  if (task !== null) return { kind: "task", id: task[1]! };
  // A mistyped slash command gets help, but arbitrary prose is not a command.
  return /^\/(?:status|task|help|start)(?:\s|$)/i.test(t) ? { kind: "help" } : null;
}

export const PHONE_HELP = [
  "Standing Orders in chat",
  "",
  "Send a message to talk with the same assistant as the console and the terminal. It proposes changes as cards; nothing changes until you tap Confirm.",
  "",
  "/status — recent work across your connected projects",
  "/task <id> — status, checks, and the next step for one task",
  "/team — the team conversations you can talk in; /team <number> to talk there, /team off for your private assistant",
  "/help — these commands",
  "",
  "The slash commands only read status. To answer an agent's question, tap its decision buttons; reply to that decision message to attach a note. Reply to a result message to ask for changes to that exact result, or ask for its screenshots to receive the saved images as files.",
  "",
  "Password approvals, cancelling and publishing happen in the Standing Orders console. A button that opens the console only takes you there — sign in, and nothing changes until you act. The computer and bridge must be awake and connected to reply.",
].join("\n");

/** A third-party transport receives a small display copy, not logs, paths,
 * credentials, or arbitrary markup. Scan BEFORE truncation/normalization. */
const plain = publicChatText;

/** The same display scrub for every phone-bound string a person or a model authored. */
export const phoneText = plain;

export function projectLabel(repo: string): string {
  return plain(repo.split(/[\\/]/).filter(Boolean).pop() ?? "project", 48);
}

function groupOf(d: DispatchDiagnosis): string {
  if (d.condition === "running") return "Working";
  if (d.code === "cancelled") return "Cancelled";
  if (d.code === "complete") return "Finished";
  if (d.code === "review-pending" || d.action === null) return "Waiting / next up";
  return "Needs attention";
}

function nextStep(d: DispatchDiagnosis): string {
  if (d.code === "review-pending") return "An older review request is on record; nothing runs for it. Open the saved result in the console.";
  switch (d.action) {
    case "open-result": return "Open this task's result in the console, inspect it, then mark it complete or request changes.";
    case "retry-task": return "Open this task in the console, review why it stopped, and use the available retry action.";
    case "place-task": return "Choose a project for this task in the console.";
    case "write-scope": return "Describe the goal and success checks in the console, or ask the planner to draft them.";
    case "select-agent": return "Open this task in the console and check its agent settings or provider availability.";
    case "approve-scope": return "Read the proposed work in the console and approve it if it is right.";
    case "answer-decision": return "Answer the waiting question using its decision buttons or the console.";
    case "unhold": return "Open this task in the console and release its hold when you want it to continue.";
    case "inspect-hold": return "Open this task in the console to see what must change before it can continue.";
    case "repair-dependency": return "Open this task in the console. Retry the required task, choose a different task to wait for, or explicitly stop waiting for it.";
    case "repair-capability": return "Open this task's requirements in the console and fix the named setup issue.";
    case "start-worker": return "Reopen Standing Orders on the computer and finish any project-access setup. Approved work can resume when the builder reconnects.";
    case "retry-review": return "Open the saved result in the console. Nothing reruns a review; mark the result complete or request changes.";
    case "resume-run": return "Open this task in the console and choose Resume after its stopped attempt has finished stopping.";
    case null: return d.condition === "running" ? "No action needed from you right now." : d.code === "cancelled" ? "Nothing else will run for this task." : "Standing Orders can reconsider this task when its waiting condition clears.";
  }
}

/** repos is the transport's explicit enrollment ceiling, never opened-project
 * history. This snapshot is intentionally bounded and advertises that bound. */
export function phoneStatus(store: Store, repos: readonly string[], now: Date): string {
  if (repos.length === 0) return "No connected projects are available to this bridge. Add a project in Standing Orders, then send /status again.";
  return store.transact(() => {
    const snapshot = withDispatchDiagnoses(store, store.chatSnapshot(repos, now), now);
    const lines = ["Recent work", `As of ${now.toISOString().replace("T", " ").slice(0, 19)} UTC · ${repos.length} project(s)`, ""];
    if (snapshot.tasksSaturated) lines.push("Newest 60 tasks only — older work may still need attention.", "");
    if (snapshot.tasks.length === 0) lines.push("No tasks are recorded in these projects.");
    for (const group of ["Needs attention", "Working", "Waiting / next up", "Finished", "Cancelled"]) {
      const rows = snapshot.tasks.filter(t => t.dispatch !== null && t.dispatch !== undefined && groupOf(t.dispatch) === group);
      if (rows.length === 0) continue;
      lines.push(`${group} · ${rows.length}${snapshot.tasksSaturated ? " in this snapshot" : ""}`);
      for (const task of rows.slice(0, 2)) {
        lines.push(`${plain(task.id, 64)} · ${projectLabel(repos[task.repoIndex]!)}`, `  ${plain(task.title, 64)} — ${plain(task.dispatch!.summary, 80)}`);
      }
      if (rows.length > 2) lines.push(`  +${rows.length - 2} more in the console`);
      lines.push("");
    }
    lines.push("Send /task <id> for the next step. Status is a snapshot, not a promise that the next attempt will succeed.");
    return lines.join("\n");
  });
}

/** A fixed console destination for one task, named beside its label; the origin joins it only on the wire. */
export type PhoneTaskLink = { label: string; path: string };
/** Where the rest lives when no button can say so: the closing line of an unlinked `/task`. */
export const PHONE_CONSOLE_FOOTER = "Read-only status. Saved files and full actions are in the console.";

/**
 * Where `/task`'s one button goes, from the recorded diagnosis: the exact
 * saved result's checks (a recorded verdict) or changes (none yet) for a
 * finished task; the approval control while the scope waits; the task's
 * own page for retry, hold, dependency and resume ceremonies; the task lens
 * otherwise (a worker that must be started is not a browser step, and the
 * lens says so). Only a task inside the phone's ceiling gets here.
 */
function taskLinkFor(id: string, d: DispatchDiagnosis, result: { run: number; verdict: boolean } | null): PhoneTaskLink {
  const control = (name: ChatControl): PhoneTaskLink => ({ label: CHAT_CONTROLS[name].label, path: chatControlHref(name, id) });
  if (result !== null) return result.verdict ? { label: "Open checks", path: chatResultHref(id, result.run, "checks") } : { label: "Open changes", path: chatResultHref(id, result.run, "changes") };
  switch (d.action) {
    case "approve-scope": return control("approval");
    case "retry-task": case "unhold": case "inspect-hold": case "repair-dependency": case "retry-review": case "resume-run": return control("recovery");
    default: return control("task");
  }
}

export function phoneTask(store: Store, repos: readonly string[], id: string, now: Date): string {
  return phoneTaskView(store, repos, id, now).text;
}

export function phoneTaskView(store: Store, repos: readonly string[], id: string, now: Date): { text: string; link: PhoneTaskLink | null } {
  return store.transact(() => {
    const ref = store.lookupRef(id);
    // Check admission before reading a title, run, proof, or diagnosis.
    const task = ref?.repo != null && repos.includes(ref.repo) ? store.getTask(id) : null;
    if (task === null || ref?.repo == null) return { text: "No such task in your connected projects. Send /status for task IDs.", link: null };
    const d = diagnoseTaskDispatch(store, id, now);
    if (d === null) return { text: "This task's status is unavailable. Open it in the console before retrying.", link: null };
    const lines = [plain(task.title, 140), `${plain(id, 64)} · ${projectLabel(ref.repo)}`, `As of ${now.toISOString().replace("T", " ").slice(0, 19)} UTC`, "", plain(d.summary, 160)];
    const blocker = d.blockerTaskId === null ? null : store.lookupRef(d.blockerTaskId);
    const hiddenDependency = blocker !== null && (blocker.repo === null || !repos.includes(blocker.repo));
    lines.push(hiddenDependency ? "A required task outside this phone view has not finished. Open the dependency in the console." : plain(d.detail, 650));
    if (d.nextAt !== null) lines.push(`Earliest recorded wake: ${plain(d.nextAt, 40)} (a connected worker is still required).`);

    const runs = store.runsFor(ref.id);
    const result = task.state === "done" ? runs.find(r => (r.role === "builder" || r.role === "scout") && (r.outcome === "built" || r.outcome === "no-change") && r.finishedAt !== null) : undefined;
    const latest = result ?? runs[0];
    if (latest !== undefined) {
      lines.push("", `${result === undefined ? "Latest recorded attempt" : "Saved result"}: #${latest.id} · ${plain(latest.provider, 40)}${latest.model === null ? "" : ` / ${plain(latest.model, 80)}`}`);
      // Terminal status wins; a leftover internal phase must never read as activity.
      if (latest.finishedAt !== null) lines.push(`Attempt ended: ${plain(latest.finishedAt, 40)}`);
      else if (d.condition === "running") {
        const checkpoint = store.latestCheckpointForRun(latest.id);
        lines.push(checkpoint === null ? "No milestone progress has been recorded for this attempt." : `Latest agent-reported milestone update: ${plain(checkpoint.createdAt, 40)} (not independent proof).`);
      }
    }
    let link: PhoneTaskLink | null = null;
    if (result !== undefined) {
      const proof = store.proofVerdictFor(result.id);
      link = taskLinkFor(id, d, { run: result.id, verdict: proof !== null });
      const accepted = store.proofAcceptance(result.id) !== null;
      const proofWords = { verified: "Checks passed at completion", attested: "Checks reported by the agent, not run by Standing Orders", short: "Required saved material is missing", refuted: "The saved result conflicts with the approved scope" };
      lines.push(`Checks: ${proof === null ? "No completion record saved" : manualReviewOnly(proof) ? accepted ? "Accepted by a person; the recorded checks are unchanged" : "A person must inspect this result; no recorded check failed" : proofWords[proof.verdict]}.`);
      if (manualReviewOnly(proof) && !accepted) lines.push('Reply “Send the result summary” for the checks, notes and screenshots.');
      if (proof !== null && proof.matrix.length > 0) lines.push(`Requirements: ${proof.matrix.filter(row => row.state === "pass").length}/${proof.matrix.length} satisfied in the saved record.`);
      if (accepted && !manualReviewOnly(proof)) lines.push("An operator accepted this result; that does not change its recorded checks.");
      const publication = store.publicationForRun(result.id);
      const delivery = publication?.remoteState === "MERGED" ? "Merge observed on GitHub" : publication?.remoteState === "CLOSED" ? "Pull request closed, not merged" : publication?.state === "opened" ? `Pull request #${publication.prNumber ?? "?"} opened; not recorded as merged` : publication?.state === "pushed" ? "Branch pushed; pull request not yet recorded" : publication?.state === "intended" ? "Publication queued; not yet confirmed" : publication?.state === "failed" ? "Publication failed; the local result is preserved" : result.role === "scout" ? "Report saved locally" : "Result saved locally; no publication recorded";
      lines.push(`Delivery: ${delivery}.`);
    }
    if (result === undefined) link = taskLinkFor(id, d, null);
    // Said once: the button is where; the sender adds the closing line when no button can ride.
    lines.push("", `Next: ${nextStep(d)}`);
    return { text: lines.join("\n"), link };
  });
}

/** Concise display only: authorization uses the stored full project identity. */
export function notificationIdentity(row: Pick<Notification, "project" | "taskId">): string {
  if (row.project === null) return "";
  return `${projectLabel(row.project)}${row.taskId === null ? "" : ` / ${plain(row.taskId, 64)}`} · `;
}
