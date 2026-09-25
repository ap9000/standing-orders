/**
 * Steps that run outside a model (v84), in the worker's pass:
 *
 * - check  — runs one of the project's scripts (flow-scripts.ts) in a fresh
 *            copy of the card's latest result (or the base branch), after the
 *            project's approved setup, with the same bare environment setup
 *            and checks get, plus FLOW_* variables naming the card. Exit 0
 *            passes; anything else takes the failure path. The end of its
 *            output (64 KB, whole lines, keys blanked) is kept as the log.
 * - update — comments on the GitHub or Linear issue the card came from, and
 *            can close it (Linear: moves it to the team's done state), with
 *            the person's own `gh` login and Linear key.
 * - draft  — (v86) Claude writes from the card (flow-draft.ts); the draft
 *            is kept on the card for a person and later steps.
 * - sort   — (v85) asks Jev through OpenRouter which of the zone's answers
 *            fits the card (flow-sort.ts), and sends it where that answer
 *            leads, or down the not-sure path.
 *
 * One run per visit to the zone (flow_step_run): two workers never run it
 * twice. Trouble reaching a service is retried three times, 5 then 15
 * minutes apart; a check that fails is an answer, not trouble.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "./backend.js";
import { approvedCommandShell, redactSecretAssignments, SETUP_ENV_ALLOWLIST, SETUP_ENV_DENYLIST } from "./builder.js";
import { assignmentOf } from "./assignment.js";
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { cardFollowers, notifyPeople } from "./flow-people.js";
import { LINEAR_URL, readLinearKey } from "./flow-triggers.js";
import { fillFlowText, type FlowDefinition, type FlowStage } from "./flows.js";
import { askJev, readJevAnswers, sortLog, sortRequest, sortState, sortWords } from "./flow-sort.js";
import { claudeDraftRunner, DRAFT_TIMEOUT, draftPrompt, keptDraft, type DraftRunner } from "./flow-draft.js";
import { readProviderKey } from "./keys.js";
import type { FlowCardRow, FlowRow, FlowScriptRow, Store } from "./store.js";

export type StepIo = {
  /** `gh` for GitHub; git and the check's shell, both without a model. */
  gh: Runner; git: Runner; shell: Runner;
  fetch: typeof fetch;
  /** Beside the database: the Linear key. */
  dir: string | null;
  /** Where temporary copies of a card's work are made. */
  scratch: string;
  evidenceRoot?: string;
  /** The branch a card with no result yet is checked against. */
  base: string;
  /** The operator's OpenRouter key, for sort steps (default: the one stored in Settings → AI providers). */
  openRouterKey?: () => string | null;
  /** Writes a draft (default: Claude through this computer's sign-in, no tools). */
  draft?: DraftRunner;
};
export type StepPass = { ran: number; problems: string[] };
type Outcome = { state: "passed" | "failed" | "retry"; said: string; log?: string; exitCode?: number | null;
  /** sort: where the card goes (null: it waits here), and what was decided. */
  to?: string | null; decisionJson?: string; unsure?: boolean;
  /** What the card keeps from this step, when it isn't `said` (a draft's text). */
  output?: string };

const RETRY_MS = [5 * 60_000, 15 * 60_000];
const OUTPUT_CHARS = 3000;
/** How much of a step's output its run keeps as the log. */
const LOG_CHARS = 64_000;

/** Run every due check and update in one project, then move each card on. */
export async function runFlowSteps(store: Store, repo: string, now: Date, io: StepIo): Promise<StepPass> {
  const pass: StepPass = { ran: 0, problems: [] };
  // A step left running long past any time limit had its worker stop: it may try again.
  for (const stale of store.staleFlowSteps(new Date(now.getTime() - 75 * 60_000))) store.finishFlowStep(stale.card, stale.entry, { state: "waiting", result: "Interrupted; trying again.", nextAt: now.toISOString() }, now);
  const flows = new Map<number, { flow: FlowRow; definition: FlowDefinition | null }>();
  for (const card of store.activeFlowCards(repo)) {
    let known = flows.get(card.flow);
    if (known === undefined) { const flow = store.getFlow(card.flow)!; known = { flow, definition: flowDefinitionOf(flow) }; flows.set(card.flow, known); }
    const stage = known.definition?.stages.find(one => one.id === card.stage);
    if (stage === undefined || (stage.kind !== "check" && stage.kind !== "update" && stage.kind !== "sort" && stage.kind !== "draft")) continue;
    const key = stage.kind === "sort" ? (io.openRouterKey ?? (() => readProviderKey("openrouter")))() : null;
    if (stage.kind === "sort" && key === null) {
      const waiting = "Sorting needs an OpenRouter key. Add one in Settings → AI providers.";
      if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
      continue;
    }
    const script = stage.kind === "check" && stage.script !== null ? store.flowScript(repo, stage.script) : null;
    if (stage.kind === "check" && script === null) {
      const waiting = `There's no script called ${stage.script ?? "(none)"} in this project. Make it on the flow's Scripts panel.`;
      if (card.waiting !== waiting) store.updateFlowCard(card.id, { waiting }, now);
      continue;
    }
    if (!store.claimFlowStep({ card: card.id, entry: card.entry, stage: stage.id, kind: stage.kind, script: script?.name ?? null, scriptVersion: script?.version ?? null }, now)) continue;
    pass.ran++;
    store.updateFlowCard(card.id, { waiting: stage.kind === "check" ? "Running its check…" : stage.kind === "sort" ? "Sorting…" : stage.kind === "draft" ? "Writing the draft…" : "Updating the issue…" }, now);
    let outcome: Outcome;
    const started = Date.now();
    try {
      outcome = stage.kind === "check" ? await runCheck(store, known.flow, script!, card, now, io)
        : stage.kind === "sort" ? await sortCard(known.definition!, stage, card, key!, io)
        : stage.kind === "draft" ? await draftCard(store, known.definition!, stage, card, io)
        : await updateSource(stage, card, io);
    } catch (error) {
      outcome = { state: "retry", said: error instanceof Error ? error.message : "It couldn't run." };
    }
    settle(store, known.definition!, stage, store.getFlowCard(card.id)!, outcome, now, Date.now() - started);
    if (outcome.state === "retry") pass.problems.push(`flow card ${card.id}: ${outcome.said}`);
  }
  return pass;
}

/** Record what a step did and move the card: on for a pass, down its failure path for a fail, or wait to try again. */
function settle(store: Store, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, outcome: Outcome, now: Date, durationMs: number): void {
  const run = store.flowStepRun(card.id, card.entry);
  const kept = { log: outcome.log === undefined ? null : keptLog(outcome.log), exitCode: outcome.exitCode ?? null, durationMs, ...(outcome.decisionJson === undefined ? {} : { decisionJson: outcome.decisionJson }) };
  if (outcome.state === "retry") {
    const attempts = run?.attempts ?? 1;
    if (attempts <= RETRY_MS.length) {
      store.finishFlowStep(card.id, card.entry, { state: "waiting", result: outcome.said, nextAt: new Date(now.getTime() + RETRY_MS[attempts - 1]!).toISOString(), ...kept }, now);
      store.updateFlowCard(card.id, { waiting: `${outcome.said} Trying again in ${attempts === 1 ? 5 : 15} minutes.` }, now);
      return;
    }
    outcome = { state: "failed", said: `${outcome.said} It didn't work after three tries.` };
  }
  store.finishFlowStep(card.id, card.entry, { state: outcome.state === "passed" ? "passed" : "failed", result: outcome.said, ...kept }, now);
  store.updateFlowCard(card.id, { outputs: { ...card.outputs, [stage.id]: outcome.output ?? outcome.said }, waiting: null }, now);
  const titleOf = (id: string | null) => definition.stages.find(one => one.id === id)?.title ?? "another zone";
  if (outcome.state === "passed") {
    // A sort names where the card goes; one it isn't sure about is a person's to place.
    const to = outcome.to !== undefined ? outcome.to : stage.next;
    if (outcome.unsure === true) {
      const people = card.owner === null ? cardFollowers(store, card) : [card.owner];
      notifyPeople(store, card, people, null, { key: `unsure:${card.entry}`, subject: `${stage.title} wasn't sure about “${card.title}”`, body: `${outcome.said}${to === null ? " Move it to the right zone." : ` It's in ${definition.stages.find(one => one.id === to)?.title ?? "another zone"} for a person to place.`}`, attention: true }, now);
    }
    if (to === null) { store.updateFlowCard(card.id, { waiting: outcome.to !== undefined ? `${outcome.said} Move it to the right zone.` : "Finished here. Move the card on when you're ready." }, now); return; }
    store.moveFlowCard(card.id, { to, outcome: "ok", actor: "flow", expectEntry: card.entry }, now);
    return;
  }
  if (stage.onFail === null) {
    store.updateFlowCard(card.id, { waiting: `${outcome.said} Fix it, then move the card to try again.` }, now);
  } else {
    store.moveFlowCard(card.id, { to: stage.onFail, outcome: "fail", actor: "flow", note: outcome.said, expectEntry: card.entry }, now);
  }
  const people = card.owner === null ? cardFollowers(store, card) : [card.owner];
  notifyPeople(store, card, people, null, { key: `step-failed:${card.entry}`, subject: `${stage.title} didn't pass for “${card.title}”`, body: `${outcome.said}${stage.onFail === null ? "" : `\n\nIt's back in ${titleOf(stage.onFail)}.`}`, attention: true }, now);
}

/** A run's log: the end of its output in whole lines, where failures show, with key-shaped lines replaced and credential-looking values blanked. */
function keptLog(text: string): string {
  const end = text.length <= LOG_CHARS ? text : text.slice(-LOG_CHARS).replace(/^[^\n]*\n/, "");
  return redactSecretAssignments(redactSecretLines(end, scanForSecrets(end)));
}

/** The end of a command's output, without anything that looks like a key. */
function tail(text: string): string {
  const end = text.trim().slice(-OUTPUT_CHARS);
  return scanForSecrets(end).length > 0 ? "(Its output held something that looked like a key, so it isn't shown.)" : end;
}

/** A draft: Claude writes what the zone asks, from the card, with the lead chat's Claude model; the text stays on the card. */
async function draftCard(store: Store, definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, io: StepIo): Promise<Outcome> {
  const config = store.getChatConfig();
  const model = config?.provider === "claude-subscription" ? config.model : "default";
  const answer = await (io.draft ?? claudeDraftRunner())({ model, prompt: draftPrompt(stage, card, definition), timeoutMs: DRAFT_TIMEOUT });
  if (!answer.ok) return { state: "retry", said: answer.said };
  const text = keptDraft(answer.text);
  if (text === "") return { state: "retry", said: "Claude's draft came back empty." };
  const words = text.split(/\s+/).filter(Boolean).length;
  return { state: "passed", said: `Drafted ${words} word${words === 1 ? "" : "s"}.`, output: text, log: `Claude (${model}) · ${(answer.ms / 1000).toFixed(1)} s\n\n${text}` };
}

/** A sort: Jev picks one of the zone's answers for the card; the answer (or the not-sure path) says where it goes. */
async function sortCard(definition: FlowDefinition, stage: FlowStage, card: FlowCardRow, key: string, io: StepIo): Promise<Outcome> {
  const index = definition.stages.findIndex(one => one.id === stage.id);
  const earlier = definition.stages.filter((one, at) => at !== index && card.outputs[one.id] !== undefined).map(one => ({ id: one.id, title: one.title }));
  const asked = await askJev(io.fetch, key, sortRequest(stage.sort!, sortState(card, earlier)));
  if (!asked.ok) return { state: "retry", said: asked.said };
  const decision = readJevAnswers(stage, asked.body, asked.ms);
  if ("problem" in decision) return { state: "retry", said: decision.problem };
  return { state: "passed", said: sortWords(decision), log: sortLog(stage, decision), to: decision.to, decisionJson: JSON.stringify(decision), unsure: !decision.confident };
}

/** A script step: a fresh detached copy at the card's latest result (or the base branch), the approved setup, then the script. */
async function runCheck(store: Store, flow: FlowRow, script: FlowScriptRow, card: FlowCardRow, now: Date, io: StepIo): Promise<Outcome> {
  const task = card.primaryTask ?? card.task;
  const receipt = task === null ? null : assignmentOf(store, task, now, { principal: "operator", repos: [flow.repo] }, io.evidenceRoot)?.receipt ?? null;
  const commit = receipt?.head ?? null;
  const where = commit === null ? io.base : `commit ${commit.slice(0, 7)}`;
  const path = join(io.scratch, `flow-check-${card.id}-${card.entry}`);
  const file = join(io.scratch, `flow-check-${card.id}-${card.entry}.sh`);
  mkdirSync(io.scratch, { recursive: true });
  rmSync(path, { recursive: true, force: true });
  const added = await io.git("git", ["-C", flow.repo, "worktree", "add", "--detach", path, commit ?? io.base], { timeoutMs: 120_000 });
  if (added.code !== 0) return { state: "retry", said: `Couldn't make a copy of ${where}: ${added.stderr.trim().split("\n")[0]?.slice(0, 160) ?? "git refused"}.` };
  try {
    const bare = { envAllowlist: SETUP_ENV_ALLOWLIST, omitEnv: SETUP_ENV_DENYLIST, processGroup: true } as const;
    const setup = store.liveWorktreeSetup(flow.repo);
    let log = "";
    if (setup !== null) {
      const shell = approvedCommandShell(setup.command);
      const prepared = await io.shell(shell.file, shell.args, { cwd: path, timeoutMs: setup.timeoutMs, ...bare });
      log += `$ ${setup.command}\n${prepared.stdout}${prepared.stderr}\n`;
      if (prepared.code !== 0) return { state: "failed", said: `The project's setup failed before ${script.name} ran (exit ${prepared.code}).\n${tail(`${prepared.stdout}\n${prepared.stderr}`)}`, log, exitCode: prepared.code };
    }
    writeFileSync(file, `${script.body}\n`, { mode: 0o700 });
    chmodSync(file, 0o700);
    // The script knows which card and which work it is checking.
    const env = { FLOW_NAME: flow.name, FLOW_CARD_ID: String(card.id), FLOW_CARD_TITLE: card.title, FLOW_COMMIT: commit ?? "", FLOW_SCRIPT: script.name };
    const ran = await io.shell("/bin/sh", [file], { cwd: path, timeoutMs: script.timeoutMinutes * 60_000, ...bare, env });
    log += `$ ${script.name} (version ${script.version})\n${ran.stdout}${ran.stderr}`;
    if (ran.timedOut) return { state: "failed", said: `${script.name} ran out of time after ${script.timeoutMinutes} minutes on ${where}.`, log, exitCode: null };
    if (ran.notFound) return { state: "failed", said: `${script.name} couldn't start: no shell was found.`, log, exitCode: null };
    return ran.code === 0
      ? { state: "passed", said: `${script.name} passed on ${where}.`, log, exitCode: 0 }
      : { state: "failed", said: `${script.name} failed (exit ${ran.code}) on ${where}.\n${tail(`${ran.stdout}\n${ran.stderr}`)}`, log, exitCode: ran.code };
  } finally {
    await io.git("git", ["-C", flow.repo, "worktree", "remove", "--force", path], { timeoutMs: 60_000 }).catch(() => undefined);
    rmSync(path, { recursive: true, force: true });
    rmSync(file, { force: true });
  }
}

/** An update: a comment on the issue the card came from, and closing it if the zone says so. */
async function updateSource(stage: FlowStage, card: FlowCardRow, io: StepIo): Promise<Outcome> {
  const source = card.source;
  const text = fillFlowText(stage.message ?? "Done: {{card.title}}", { title: card.title, description: card.description, note: card.note, outputs: card.outputs });
  if (scanForSecrets(text).length > 0) return { state: "failed", said: "The comment looked like it held a key or password, so nothing was posted." };
  const github = source?.kind === "github" && source.url !== null ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)$/.exec(source.url) : null;
  if (github !== null) {
    const [, repo, what, number] = github;
    const commented = await io.gh("gh", ["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${text}`], { timeoutMs: 20_000 });
    if (commented.code !== 0) return { state: "retry", said: `GitHub didn't take the comment: ${(commented.stderr || commented.stdout).trim().split("\n")[0]?.slice(0, 160)}.` };
    if (stage.close === true && what === "issues") {
      const closed = await io.gh("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/${number}`, "-f", "state=closed", "-f", "state_reason=completed"], { timeoutMs: 20_000 });
      if (closed.code !== 0) return { state: "retry", said: `Commented, but GitHub didn't close it: ${(closed.stderr || closed.stdout).trim().split("\n")[0]?.slice(0, 160)}.` };
      return { state: "passed", said: `Commented on and closed ${source!.label}.` };
    }
    return { state: "passed", said: `Commented on ${source!.label}.` };
  }
  const linear = source?.kind === "linear" ? /^Linear ([A-Z][A-Z0-9]*-\d+)$/.exec(source.label)?.[1] ?? null : null;
  if (linear !== null) {
    const key = readLinearKey(io.dir);
    if (key === null) return { state: "failed", said: "Needs a Linear API key to update the issue. Add it on the flow's Triggers panel." };
    const ask = async (query: string, variables: Record<string, unknown>) => {
      const response = await io.fetch(LINEAR_URL, { method: "POST", headers: { "content-type": "application/json", authorization: key }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
      const body = await response.json() as { data?: Record<string, unknown>; errors?: { message?: string }[] };
      if (!response.ok || (body.errors?.length ?? 0) > 0) throw new Error(`Linear said: ${(body.errors?.[0]?.message ?? `status ${response.status}`).slice(0, 160)}.`);
      return body.data ?? {};
    };
    try {
      const found = await ask("query FlowIssue($id: String!) { issue(id: $id) { id team { states(filter: { type: { eq: \"completed\" } }) { nodes { id name } } } } }", { id: linear });
      const issue = found["issue"] as { id: string; team: { states: { nodes: { id: string; name: string }[] } } } | null;
      if (issue === null || issue === undefined) return { state: "failed", said: `Linear has no issue ${linear} this key can see.` };
      await ask("mutation FlowComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", { input: { issueId: issue.id, body: text } });
      if (stage.close === true) {
        const done = issue.team.states.nodes[0];
        if (done === undefined) return { state: "passed", said: `Commented on ${linear}; its team has no done state to move it to.` };
        await ask("mutation FlowDone($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: issue.id, input: { stateId: done.id } });
        return { state: "passed", said: `Commented on ${linear} and moved it to ${done.name}.` };
      }
      return { state: "passed", said: `Commented on ${linear}.` };
    } catch (error) {
      return { state: "retry", said: error instanceof Error ? error.message : "Couldn't reach Linear." };
    }
  }
  return { state: "passed", said: "Nothing to update: this card didn't come from a GitHub or Linear issue." };
}
