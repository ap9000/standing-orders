/** Every reason a task, result or flow card can wait on a person, in one
 * place: the plain sentence it shows and the one action that resolves it
 * (task-status.ts reads it for every surface). A reason no person can act
 * on is not Needs you: it is a Waiting reason, worded as what it waits for.
 *
 * The words never name the machine's internals; `plainSentence` keeps a
 * recorded reason only when it is free of them. */

/** What a person is asked for. */
export type NeedKey =
  | "approval" | "card" | "answer" | "questions" | "sign-in" | "confirm-stopped" | "check-stopped" | "hold"
  | "choose-project" | "define-task" | "fix-request" | "choose-agent" | "fix-dependency" | "add-requirement"
  | "connect-builder" | "start-builder" | "vanished" | "review-result" | "rebuild" | "earlier-version" | "other";
/** What the work waits for when no person can act. */
export type WaitKey = "build-stopping" | "other-computer" | "card-reply" | "card-time" | "card-ci";

/** The action's code: the WorkAction that owns the act, or one of the acts a surface renders itself. */
export type NeedActionCode =
  | "approve-scope" | "approve-card" | "answer-decision" | "inspect-decisions" | "sign-in" | "confirm-stopped" | "inspect-hold"
  | "place-task" | "write-scope" | "select-agent" | "repair-dependency" | "repair-capability" | "start-worker" | "reconcile-run"
  | "open-result" | "retry-task" | "inspect-task";
export type NeedAction = { code: NeedActionCode; label: string };
/** `build`: the run a sentence names; `provider`: the agent that signed out. */
export type NeedContext = { build?: number | null; provider?: string | null };

/** `useReason`: which recorded reasons say what is needed better than the default words. */
type Need = { sentence: (context: NeedContext) => string; action: NeedAction; useReason?: (reason: string) => boolean;
  /** How a kept reason reads: by default the reason alone. */
  withReason?: (reason: string) => string };
const always = (): boolean => true;

const build = (context: NeedContext): string => context.build == null ? "the last build" : `build #${context.build}`;
const Build = (context: NeedContext): string => context.build == null ? "The last build" : `Build #${context.build}`;

export const NEEDS: Readonly<Record<NeedKey, Need>> = {
  approval: { sentence: () => "Review the plan and approve it to start.", action: { code: "approve-scope", label: "Approve plan" } },
  card: { sentence: () => "This card is waiting for your approval.", action: { code: "approve-card", label: "Approve card" } },
  answer: { sentence: () => "Answer the question so the work can continue.", action: { code: "answer-decision", label: "Answer the question" }, useReason: always },
  questions: { sentence: () => "Too many questions are open. Answer one so this task can start.", action: { code: "inspect-decisions", label: "Answer questions" } },
  "sign-in": { sentence: context => `${context.provider ?? "Your agent"} needs you to sign in again. The task starts on its own after.`, action: { code: "sign-in", label: "Sign in again" }, useReason: reason => /sign in|API key/i.test(reason) },
  "confirm-stopped": { sentence: context => `Toolroll can't confirm ${build(context)} stopped. Nothing from it is running.`, action: { code: "confirm-stopped", label: "Confirm it stopped" } },
  // Toolroll can't look at all: never "nothing is running"; the person checks, says so, then confirms.
  "check-stopped": { sentence: context => `Toolroll can't check whether ${build(context)} stopped. Make sure nothing from it is running, then confirm.`, action: { code: "confirm-stopped", label: "Confirm it stopped" } },
  hold: { sentence: () => "A hold is keeping this task from starting. Review it to release it.", action: { code: "inspect-hold", label: "Review hold" } },
  "choose-project": { sentence: () => "Choose a project so a builder can start.", action: { code: "place-task", label: "Choose a project" } },
  "define-task": { sentence: () => "Say what the task should do so it can be planned.", action: { code: "write-scope", label: "Define the task" } },
  "fix-request": { sentence: () => "The request can't be planned as written. Edit it so the planner can start.", action: { code: "write-scope", label: "Edit the request" } },
  "choose-agent": { sentence: () => "Choose an agent to build this.", action: { code: "select-agent", label: "Choose an agent" } },
  "fix-dependency": { sentence: () => "A task this one waits on didn't finish. Fix or remove it so this one can start.", action: { code: "repair-dependency", label: "Fix the required task" },
    useReason: reason => /didn't finish|did not finish|before it finished/i.test(reason), withReason: reason => `${reason.replace(/[.\s]*$/, ".")} Fix or remove it so this one can start.` },
  "add-requirement": { sentence: () => "This project is missing something the task needs. Add it so a builder can start.", action: { code: "repair-capability", label: "Add the requirement" } },
  "connect-builder": { sentence: () => "No builder works on this project yet. Connect one so the task can start.", action: { code: "start-worker", label: "Connect a builder" } },
  "start-builder": { sentence: () => "The builder for this project is offline. Start it and the task begins on its own.", action: { code: "start-worker", label: "Start the builder" } },
  vanished: { sentence: context => `${Build(context)} stopped without finishing. Check it, then retry.`, action: { code: "reconcile-run", label: "Check the build" } },
  "review-result": { sentence: () => "Check the result, then accept it or ask for changes.", action: { code: "open-result", label: "Review result" } },
  // Accepting it would not help: it was built to terms that are no longer the plan.
  rebuild: { sentence: context => `${Build(context)} was made to an earlier plan. Build it again to the current plan.`, action: { code: "retry-task", label: "Build again" } },
  "earlier-version": { sentence: () => "An earlier version of this task still needs you. Finish it first.", action: { code: "inspect-task", label: "Open earlier version" } },
  other: { sentence: () => "Open the task to see what it needs from you.", action: { code: "inspect-task", label: "Open the task" }, useReason: always },
};

/** What a waiting task asks of a person, in three kinds the Tasks list groups
 * by: a choice to make, a result to accept or send back, or something in the
 * way to clear. Decide comes first. */
export type Ask = "decide" | "review" | "unblock";
export const ASKS: readonly Ask[] = ["decide", "review", "unblock"];
export const ASK_LABEL: Readonly<Record<Ask, string>> = { decide: "Decide", review: "Review", unblock: "Unblock" };
export const NEED_ASK: Readonly<Record<NeedKey, Ask>> = {
  approval: "decide", card: "decide", answer: "decide", questions: "decide", "choose-project": "decide", "define-task": "decide",
  "fix-request": "decide", "choose-agent": "decide",
  "review-result": "review", rebuild: "review",
  "sign-in": "unblock", "confirm-stopped": "unblock", "check-stopped": "unblock", hold: "unblock", "fix-dependency": "unblock",
  "add-requirement": "unblock", "connect-builder": "unblock", "start-builder": "unblock", vanished: "unblock", "earlier-version": "unblock", other: "unblock",
};

export const WAITS: Readonly<Record<WaitKey, (context: NeedContext) => string>> = {
  "build-stopping": context => `Waiting for ${build(context)} to stop. Nothing is needed from you.`,
  "other-computer": context => `Waiting for the computer that ran ${build(context)} to confirm it stopped.`,
  "card-reply": () => "Waiting for a reply.",
  "card-time": () => "Waiting before moving on.",
  "card-ci": () => "Waiting for the pull request's checks.",
};

/** Words that name the machine's internals; no Needs you or Waiting sentence carries them. */
export const BANNED_WORDS = ["witness", "unproven", "quiescence", "quiescent", "digest", "scope digest"] as const;
const BANNED = new RegExp(`\\b(?:${BANNED_WORDS.join("|")})\\b`, "i");
export const hasInternalWords = (text: string): boolean => BANNED.test(text);

/** The sentence for a need: its recorded reason when the need keeps one and
 * it reads plainly, otherwise the need's own words. */
export function needSentence(key: NeedKey, reason: string | null, context: NeedContext = {}): string {
  const need = NEEDS[key];
  const plain = reason?.trim() || null;
  if (need.useReason === undefined || plain === null || !need.useReason(plain) || hasInternalWords(plain)) return need.sentence(context);
  return need.withReason === undefined ? plain : need.withReason(plain);
}

export function waitSentence(key: WaitKey | undefined, reason: string | null, context: NeedContext = {}): string {
  if (key !== undefined) return WAITS[key](context);
  const plain = reason?.trim() || null;
  return plain !== null && !hasInternalWords(plain) ? plain : "Waiting for the work to continue on its own.";
}

/** A finished run Toolroll can't prove stopped (store.stopQuiescenceFact):
 * a person can confirm it only when nothing of it may still be running.
 * `unknown`: Toolroll can't check, so the person confirms they checked. */
export function processNeedOf(fact: { run: number; kind: "open" | "alive" | "elsewhere" | "unprovable" | "unknown" } | null):
  { need: "confirm-stopped" | "check-stopped"; build: number } | { wait: WaitKey; build: number } | null {
  if (fact === null) return null;
  if (fact.kind === "unprovable") return { need: "confirm-stopped", build: fact.run };
  if (fact.kind === "unknown") return { need: "check-stopped", build: fact.run };
  return { wait: fact.kind === "elsewhere" ? "other-computer" : "build-stopping", build: fact.run };
}

/** Dispatch and work-index codes that wait on a person, as their need. */
export const CODE_NEED: Readonly<Record<string, NeedKey>> = {
  "signed-out": "sign-in", "needs-approval": "approval", "waiting-decision": "answer", "decision-queue": "answer",
  "needs-project": "choose-project", "needs-scope": "define-task", "planner-source": "fix-request", "needs-agent-profile": "choose-agent",
  "terminal-dependency": "fix-dependency", "missing-requirement": "add-requirement", "no-worker-registered": "connect-builder",
  "no-worker-online": "start-builder", "vanished-run": "vanished", "needs-verification": "review-result", "proof-refuted": "review-result",
  "no-build-record": "review-result", "verification-needed": "review-result", "evidence-mismatch": "review-result",
  "record-incomplete": "review-result", "evidence-damaged": "review-result",
};
