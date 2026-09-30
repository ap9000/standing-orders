/**
 * Starter flows: flows that are on from day one, each switched on with one yes from `toolroll onboard`,
 * Settings → Flows, a task's "Do this every time…" or chat. Switching one on makes an ordinary flow (its zones)
 * and its trigger, exactly as drawing them by hand would; it is on while that flow is. Each says in plain words
 * what it will do and what it never does: no starter merges or ships anything without a person.
 */
import { flowDefinitionOf } from "./flow-engine.js";
import { addFlowTriggerTo, githubRepoOf } from "./flow-triggers.js";
import { flowFromSteps, ISSUE_LABEL, type FlowStepInput } from "./flows.js";
import { publishingOf } from "./pull-request-flow.js";
import type { FlowRow, Store } from "./store.js";

export const STARTER_IDS = ["ci-fix", "issue-task", "overnight"] as const;
export type StarterId = (typeof STARTER_IDS)[number];

export type StarterFlow = {
  id: StarterId;
  /** The flow's name, and how the starter is called everywhere. */
  name: string;
  /** One line: what it's for. */
  summary: string;
  /** What switching it on does, in order. */
  does: (where: { github: string | null; branch: string }) => string[];
  /** What it never does. */
  never: string;
  github: boolean;
  steps: FlowStepInput[];
  trigger: (where: { branch: string }) => Record<string, unknown>;
};

export const STARTER_FLOWS: readonly StarterFlow[] = [
  {
    id: "ci-fix",
    name: "Fix failing CI",
    summary: "When CI fails on the main branch, a task to fix it is filed.",
    does: ({ github, branch }) => [`Watches checks on ${branch} in ${github ?? "your GitHub repository"}.`, "Files a task to fix each failure, under your usual approvals.", "Asks you to review the fix."],
    never: "Never merges or pushes to your branch. You decide what ships.",
    github: true,
    steps: [
      { id: "fix", title: "Fix it", kind: "task", instructions: "CI failed on the main branch: {{card.title}}\n\n{{card.description}}\n\nFind the cause and make the failing check pass without weakening it.\n\nChanges asked for (if any): {{note}}" },
      { id: "review", title: "Review the fix", kind: "approval", decider: "owner" },
    ],
    trigger: ({ branch }) => ({ kind: "github", watch: "checks", branch }),
  },
  {
    id: "issue-task",
    name: "Issues become tasks",
    summary: `A GitHub issue labelled “${ISSUE_LABEL}” becomes a task.`,
    does: ({ github }) => [`Watches issues labelled “${ISSUE_LABEL}” in ${github ?? "your GitHub repository"}, from people with write access.`, "Builds each one as a task, under your usual approvals.", "Asks you to review it, then comments on the issue."],
    never: "Never merges or closes anything without you.",
    github: true,
    steps: [
      { id: "build", title: "Build", kind: "task" },
      { id: "review", title: "Review", kind: "approval", decider: "owner" },
      { id: "comment", title: "Comment on the issue", kind: "update", message: "Done: {{card.title}}. The result is ready in Toolroll.", close: false },
    ],
    trigger: () => ({ kind: "github", watch: "issues", label: ISSUE_LABEL }),
  },
  {
    id: "overnight",
    name: "Overnight queue",
    summary: "Cards you add during the day start after 22:00; results wait for you in the morning.",
    does: () => ["Adds a “Queue for tonight” button.", "Holds each card until 22:00, then builds it as a task, under your usual approvals.", "Results wait for your review in the morning."],
    never: "Never merges or ships anything without you.",
    github: false,
    steps: [
      { id: "tonight", title: "Tonight", kind: "wait", waitFor: "hours", from: "22:00", until: "06:00" },
      { id: "build", title: "Build", kind: "task" },
      { id: "morning", title: "Morning review", kind: "approval", decider: "owner" },
    ],
    trigger: () => ({ kind: "button", label: "Queue for tonight", questions: ["What needs doing?", "Details"] }),
  },
];

export const starterOf = (id: string): StarterFlow | null => STARTER_FLOWS.find(one => one.id === id) ?? null;

/** The flow a starter made in a project, while it is on. */
export function starterFlowOf(store: Store, starter: StarterFlow, repo: string): FlowRow | null {
  return store.listFlows([repo]).find(one => one.name === starter.name && one.state === "active") ?? null;
}

export type StarterView = { id: StarterId; name: string; summary: string; does: string[]; never: string; on: { flow: number } | null; blocked: string | null };

/** Each starter for a project: what it does there, whether it's on, and why it can't be switched on when it can't. */
export function startersFor(store: Store, repo: string): StarterView[] {
  const github = githubRepoOf(repo);
  const publishing = publishingOf(store, repo);
  const branch = publishing.on ? publishing.base : "main";
  return STARTER_FLOWS.map(starter => {
    const flow = starterFlowOf(store, starter, repo);
    return { id: starter.id, name: starter.name, summary: starter.summary, does: starter.does({ github, branch }), never: starter.never,
      on: flow === null ? null : { flow: flow.id }, blocked: starter.github && github === null ? "This project isn't on GitHub, so this can't watch it." : null };
  });
}

export type SwitchedOn = { ok: true; flow: number; said: string; already: boolean } | { ok: false; said: string };

/** Switch a starter on in a project: its flow (zones) and its trigger, together or not at all. Once is enough. */
export function switchOnStarter(store: Store, starter: StarterFlow, repo: string, by: string, now: Date, dir: string | null): SwitchedOn {
  const had = starterFlowOf(store, starter, repo);
  if (had !== null) return { ok: true, flow: had.id, said: `${starter.name} is already on.`, already: true };
  if (starter.github && githubRepoOf(repo) === null) return { ok: false, said: "This project isn't on GitHub, so this can't watch it." };
  const publishing = publishingOf(store, repo);
  try {
    const flow = store.transact(() => {
      const id = store.createFlow({ repo, name: starter.name, definitionJson: JSON.stringify(flowFromSteps(starter.steps, null)), by }, now);
      const made = store.getFlow(id)!;
      const trigger = addFlowTriggerTo(store, made, { ...starter.trigger({ branch: publishing.on ? publishing.base : "main" }), zone: flowDefinitionOf(made)!.start }, by, now, dir);
      if (!trigger.ok) throw new Error(trigger.message);
      return id;
    });
    return { ok: true, flow, said: `${starter.name} is on.`, already: false };
  } catch (error) {
    return { ok: false, said: `${starter.name} couldn't be switched on: ${error instanceof Error ? error.message : "unknown"}` };
  }
}

/** The starter that would do a task's kind of work every time: fixing CI, an issue, or a queued job. */
export function starterForWork(text: string): StarterFlow {
  const id: StarterId = /\b(ci|checks?|build|pipeline|workflow)\b[^.\n]{0,60}\b(fail|failed|failing|failure|red|broken)\b|\b(fail|failed|failing|broken)\b[^.\n]{0,60}\b(ci|checks?|pipeline)\b/i.test(text) ? "ci-fix"
    : /github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+|\bissue\s*#?\d+|\bGitHub issue\b/i.test(text) ? "issue-task" : "overnight";
  return starterOf(id)!;
}

/** What switching a starter on means, for a chat card's terms. */
export function starterTerms(store: Store, starter: StarterFlow, repo: string): string[] {
  const view = startersFor(store, repo).find(one => one.id === starter.id)!;
  return [view.summary, ...view.does, view.never];
}
