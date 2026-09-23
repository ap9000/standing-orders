/** Shared, exact-state actions. Models may prepare; only the existing human
 * confirmation door executes. Protected actions use a one-use review receipt. */
import { publicChatText } from "./chat-display.js";
import { createHash, randomBytes } from "node:crypto";
import { verifiedAuthor, type Store } from "./store.js";
import {
  isVerifiedApprover,
  reproveApprover,
  type VerifiedApprover,
} from "./principal.js";
import {
  changeSkills,
  importSkill,
  skillsView,
  skillsVersion,
  testSkill,
  validateSkill,
  type SkillFile,
} from "./project-skills.js";
import {
  changeKnowledge,
  knowledgeVersion,
  knowledgeView,
  type KnowledgeDraft,
} from "./project-knowledge.js";
import {
  approve,
  authenticateApprover,
  describeScope,
  scopeAuthorityOf,
  type ExecutionProfile,
} from "./scope.js";
import { readVerifiedArtifact, scanForSecrets } from "./evidence.js";
import { readAuthModeStrict } from "./keys.js";
import { parseProof } from "./proof.js";
import { assignmentOf, checkAssignmentAsOperator } from "./assignment.js";
import { getDecision, recordDecision, retireDecision } from "./project-memory.js";
import { resumeTaskStop, taskControlOf } from "./task-control.js";
import { addToolTo, catalogTool, projectToolsOf, removeToolFrom, toolCommandLine, validateToolSpec, type ToolSpec } from "./project-tools.js";

/** A tool from the lead's card: a common tool by its id, or the operator's own program or address. */
function toolSpecFromRequest(input: Record<string, unknown>): ToolSpec {
  if (input["catalog"] !== undefined) {
    const chosen = catalogTool(String(input["catalog"]));
    if (chosen === null) throw Error("Choose a tool from get_project_tools' common list.");
    const { label: _label, ...spec } = chosen;
    return spec;
  }
  const secrets = Array.isArray(input["secrets"]) ? input["secrets"].map((one) => String(one)) : [];
  const url = typeof input["url"] === "string" ? input["url"] : null;
  return validateToolSpec({
    name: input["name"], transport: url === null ? "stdio" : "http", command: input["command"], args: input["args"] ?? [], url,
    secrets: secrets.map((name) => ({ name, optional: false })), bearer: url === null ? null : secrets[0] ?? null, about: input["about"],
  });
}

export const CHAT_ACTIONS = {
  skill_import: { label: "Add skill", protected: true, password: false },
  skill_enable: { label: "Enable skill", protected: false, password: false },
  skill_disable: { label: "Disable skill", protected: false, password: false },
  skill_restore: { label: "Restore skills", protected: false, password: false },
  skill_test: { label: "Test skill", protected: false, password: false },
  knowledge_instructions: {
    label: "Save project instructions",
    protected: false,
    password: false,
  },
  knowledge_save: {
    label: "Save reference",
    protected: false,
    password: false,
  },
  knowledge_remove: {
    label: "Remove reference",
    protected: false,
    password: false,
  },
  knowledge_restore: {
    label: "Restore knowledge",
    protected: false,
    password: false,
  },
  // A tool runs on this computer for every build the operator approves from now on: the password screen, like an approval.
  tool_add: { label: "Add tool", protected: true, password: true },
  tool_remove: { label: "Remove tool", protected: false, password: false },
  decision_record: { label: "Record decision", protected: false, password: false },
  decision_retire: { label: "Retire decision", protected: false, password: false },
  scope_approve: { label: "Approve work", protected: true, password: true },
  result_accept: { label: "Mark complete", protected: true, password: false },
  task_cancel: { label: "Cancel task", protected: true, password: false },
  task_resume: { label: "Resume task", protected: true, password: true },
} as const;
export type ChatAction = keyof typeof CHAT_ACTIONS;
/** Protected actions a paired phone may confirm behind its own explicit
 * yes/cancel challenge instead of the console's secure screen. Password
 * actions and long or redacted terms never qualify. */
export const CHALLENGE_ACTIONS: ReadonlySet<ChatAction> = new Set<ChatAction>(["result_accept"]);
export function isChatAction(value: unknown): value is ChatAction {
  return typeof value === "string" && Object.hasOwn(CHAT_ACTIONS, value);
}
export type SharedAction = {
  operation: ChatAction;
  request: Record<string, unknown>;
  repo: string;
  title: string;
  terms: string[];
  stamp: string;
  state: Record<string, unknown>;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const CHAT_ACTION_FIELDS: Record<ChatAction, readonly string[]> = {
  skill_import: ["repo", "content", "files"],
  skill_enable: ["repo", "version"],
  skill_disable: ["repo", "version"],
  skill_restore: ["repo", "restore"],
  skill_test: ["repo", "version", "sample", "nonce"],
  knowledge_instructions: ["repo", "instructions"],
  knowledge_save: ["repo", "title", "content", "id"],
  knowledge_remove: ["repo", "id"],
  knowledge_restore: ["repo", "restore"],
  tool_add: ["repo", "catalog", "name", "command", "args", "url", "secrets", "about"],
  tool_remove: ["repo", "name"],
  decision_record: ["repo", "claim", "why", "supersedes", "source"],
  decision_retire: ["repo", "decision", "reason"],
  scope_approve: ["task"],
  result_accept: ["task", "run"],
  task_cancel: ["task"],
  task_resume: ["task", "run"],
};
const nonceHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function requireActor(store: Store, who: VerifiedApprover, repo: string) {
  if (!store.schemaCurrent())
    throw Error(
      "The running build changed. Reload before proposing an action.",
    );
  if (
    !isVerifiedApprover(who) ||
    !reproveApprover(store, who).ok ||
    !who.repos.includes(repo) ||
    !store.accountCanAccess(who.name, repo)
  )
    throw Error("This project is outside your current access.");
}
function text(
  input: Record<string, unknown>,
  key: string,
  cap: number,
  optional = false,
): string {
  const value = input[key];
  if (optional && value === undefined) return "";
  if (
    typeof value !== "string" ||
    (!optional && !value.trim()) ||
    value.length > cap ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufffd]/.test(
      value,
    ) ||
    scanForSecrets(value).length
  )
    throw Error(
      `Check the ${key} field. Credentials cannot be included in chat actions.`,
    );
  return value;
}
function integer(input: Record<string, unknown>, key: string): number {
  if (!Number.isSafeInteger(input[key]) || Number(input[key]) < 1)
    throw Error(`Choose a valid ${key}.`);
  return Number(input[key]);
}
function runtimeTerms(profile: ExecutionProfile): string {
  const permission =
    profile.provider === "claude"
      ? profile.permissionArgv === "bypassPermissions"
        ? "Full access: tools run without asking for permission (--dangerously-skip-permissions)."
        : profile.permissionArgv === "auto"
          ? "Auto permissions: routine commands and edits proceed; risky actions stop."
          : "Edits proceed; commands that ask for permission are denied."
      : profile.provider === "gemini"
        ? profile.approvalArgv === "yolo"
          ? "Full access: every tool is approved automatically (--approval-mode yolo)."
          : "Edits are approved automatically; other tools are refused."
        : profile.sandboxMode === "danger-full-access"
          ? "Full access: approvals and sandbox are bypassed (--dangerously-bypass-approvals-and-sandbox)."
          : "Commands use the workspace-write sandbox.";
  return `${profile.provider} · ${profile.model}\n${permission}\n${profile.timeoutSeconds} seconds ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}${profile.provider === "claude" ? `; at most ${profile.maxTurns} turns` : ""}. Repairs: ${profile.repairModel}, ${profile.repairTimeoutSeconds} seconds${profile.provider === "claude" ? `, at most ${profile.repairMaxTurns} turns` : ""}.`;
}
function resultOf(store: Store, task: string, run: number, repo: string) {
  const ref = store.lookupRef(task)!;
  const current = store
    .runsFor(ref.id)
    .find(
      (one) =>
        one.finishedAt !== null &&
        ["builder", "repair", "scout"].includes(one.role),
    );
  if (!current || current.id !== run || ref.repo !== repo)
    throw Error("This result changed. Review the current result.");
  return current;
}
/** No writes, including at preview. Store-derived snapshots are never accepted
 * from a model. Rebuilding the same request before execution catches changes. */
export function prepareSharedAction(
  store: Store,
  who: VerifiedApprover,
  operation: ChatAction,
  input: Record<string, unknown>,
  root?: string,
  now = new Date(),
): SharedAction {
  if (!isChatAction(operation)) throw Error("Choose an available action.");
  const allowed = CHAT_ACTION_FIELDS[operation];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw Error("This action contains an unsupported field.");
  const task =
    operation.startsWith("skill_") || operation.startsWith("knowledge_") || operation.startsWith("decision_") || operation.startsWith("tool_")
      ? null
      : text(input, "task", 64);
  const repo =
    task === null ? text(input, "repo", 4096) : store.lookupRef(task)?.repo;
  if (!repo) throw Error("Choose an available project.");
  requireActor(store, who, repo);
  const request = structuredClone(input),
    terms: string[] = [];
  let state: Record<string, unknown>,
    title = CHAT_ACTIONS[operation].label as string;
  if (operation.startsWith("skill_")) {
    const view = skillsView(store, repo, who.name);
    state = {
      identity: view.identity,
      revision: view.revision,
      selection: view.selection,
      library: view.library.map((one) => one.sha),
    };
    if (operation === "skill_import") {
      if (input["files"] !== undefined && input["content"] !== undefined)
        throw Error("Choose one source for this skill.");
      const files =
        input["files"] === undefined
          ? [
              {
                path: "SKILL.md",
                base64: Buffer.from(text(input, "content", 12000)).toString(
                  "base64",
                ),
              },
            ]
          : (input["files"] as SkillFile[]);
      const skill = validateSkill(files, "Chat import");
      request["files"] = skill.files;
      delete request["content"];
      title = `Add ${skill.name}`;
      terms.push(
        "Adds this version to your library. It will not be enabled automatically.",
        ...skill.files.map(
          (file) =>
            `${file.path}\n${Buffer.from(file.base64, "base64").toString("utf8")}`,
        ),
      );
    } else if (operation === "skill_restore") {
      const restore = integer(input, "restore");
      const selection = skillsVersion(store, repo, who.name, restore);
      state["restore"] = selection;
      terms.push(
        `Restore skills version ${restore}. Future runs use this selection; existing runs keep their saved skills.`,
        ...Object.entries(selection).map(
          ([name, choice]) =>
            `${name}: ${choice.enabled ? "enabled" : "disabled"}\nVersion ${choice.sha}`,
        ),
      );
    } else {
      const version = text(input, "version", 64);
      const matches = /^[a-f0-9]{20,64}$/.test(version)
        ? view.library.filter((one) => one.sha.startsWith(version))
        : [];
      if (matches.length !== 1)
        throw Error("Choose an exact skill version from get_skills.");
      const skill = matches[0]!;
      request["version"] = skill.sha;
      title = `${CHAT_ACTIONS[operation].label}: ${skill.name}`;
      terms.push(
        `Version ${view.library.filter((one) => one.sha.startsWith(skill.sha.slice(0, 20))).length === 1 ? skill.sha.slice(0, 20) : skill.sha}`,
        operation === "skill_test"
          ? `Sample request:\n${text(input, "sample", 800)}\nCreates a report task under the existing approval rules.`
          : "Changes skills for future runs. Existing runs keep their saved versions.",
      );
      if (
        operation === "skill_test" &&
        !/^[a-f0-9-]{36}$/.test(text(input, "nonce", 36))
      )
        throw Error("This test request has no saved identity.");
    }
  } else if (operation.startsWith("tool_")) {
    // The staleness fence: the project's tools as the card saw them.
    const current = projectToolsOf(store, repo);
    state = { tools: current.map((one) => `${one.name}:${one.digest}`) };
    const project = repo.split(/[\\/]/).filter(Boolean).at(-1) ?? repo;
    if (operation === "tool_add") {
      const spec = toolSpecFromRequest(input);
      if (current.some((one) => one.name === spec.name))
        throw Error(`${project} already has a tool called ${spec.name}.`);
      // The request is rewritten to exactly what was checked, so confirming re-checks the same words.
      for (const key of ["name", "command", "args", "url", "secrets", "about"]) delete request[key];
      if (input["catalog"] === undefined) Object.assign(request, { name: spec.name, ...(spec.transport === "http" ? { url: spec.url } : { command: spec.command, args: spec.args }), secrets: spec.secrets.map((one) => one.name), about: spec.about });
      const needs = spec.secrets.filter((one) => !one.optional).map((one) => one.name);
      title = `Add ${spec.name} to ${project}`;
      terms.push(
        spec.about,
        `Starts: ${toolCommandLine(spec)}`,
        "It runs on this computer with the same access as your builds. Work you approve from now on can use it; tasks approved earlier need approving again to use it.",
        needs.length > 0
          ? `Needs ${needs.join(" and ")}. Set ${needs.length === 1 ? "it" : "them"} on the Tools page after adding, never in chat.`
          : "Test it on the Tools page after adding.",
      );
    } else {
      const name = text(input, "name", 40);
      if (!current.some((one) => one.name === name))
        throw Error(`${project} has no tool called ${name}.`);
      title = `Remove ${name} from ${project}`;
      terms.push("Builds stop using it right away. Its stored secrets are deleted.");
    }
  } else if (operation.startsWith("decision_")) {
    // The staleness fence: the newest decision id and the active count, so a
    // card drafted before a teammate recorded or retired one is refused.
    const stamp = store.handle.prepare("SELECT COALESCE(MAX(id),0) AS newest, COUNT(*) AS active FROM project_decision WHERE repo=? AND status='active'").get(repo);
    state = { newest: Number(stamp?.["newest"] ?? 0), active: Number(stamp?.["active"] ?? 0) };
    if (operation === "decision_record") {
      const claim = text(input, "claim", 240), why = text(input, "why", 2000);
      if (!claim || !why) throw Error("A decision needs the choice in one sentence and the reason.");
      terms.push(`Decision: ${claim}`, `Why: ${why}`);
      if (input["supersedes"] !== undefined) {
        const older = getDecision(store, repo, who.name, integer(input, "supersedes"));
        if (older === null || older.status !== "active") throw Error("The decision being replaced is not active.");
        terms.push(`Replaces decision ${older.id}: ${older.claim}`);
        state["supersedes"] = older.id;
      }
      if (input["source"] !== undefined) terms.push(`Source: ${text(input, "source", 200)}`);
      terms.push("Records a settled choice with its reason for everyone on this project. It is context, never an instruction or a permission.");
    } else {
      const older = getDecision(store, repo, who.name, integer(input, "decision"));
      if (older === null || older.status !== "active") throw Error("That decision is not active.");
      const reason = text(input, "reason", 500);
      if (!reason) throw Error("Say why this decision no longer holds.");
      terms.push(`Retire decision ${older.id}: ${older.claim}`, `Reason: ${reason}`, "The decision stays in history and stops being offered as context.");
      state["decision"] = older.id;
    }
  } else if (operation.startsWith("knowledge_")) {
    const view = knowledgeView(store, repo, who.name);
    state = {
      identity: view.identity,
      revision: view.revision,
      knowledge: view.knowledge,
    };
    if (operation === "knowledge_instructions")
      terms.push(
        `Project instructions:\n${text(input, "instructions", 4000, true)}`,
      );
    if (operation === "knowledge_save") {
      terms.push(
        `Reference: ${text(input, "title", 120)}\n${text(input, "content", 12000)}`,
      );
      if (
        input["id"] !== undefined &&
        !view.knowledge.references.some((one) => one.id === input["id"])
      )
        throw Error("That reference is no longer available.");
    }
    if (operation === "knowledge_remove") {
      const reference = view.knowledge.references.find(
        (one) => one.id === text(input, "id", 20),
      );
      if (!reference) throw Error("That reference is no longer available.");
      terms.push(`Remove ${reference.title}\n${reference.content}`);
    }
    if (operation === "knowledge_restore")
      terms.push(
        `Restore version ${integer(input, "restore")}:\n${JSON.stringify(knowledgeVersion(store, repo, who.name, Number(input["restore"])), null, 2)}`,
      );
    terms.push(
      "Changes project knowledge for future runs. Existing runs retain their saved context.",
    );
  } else {
    const ref = store.lookupRef(task!)!,
      row = store.getTask(task!)!,
      family = store.taskFamilyOf(task!, who.repos, false);
    if (!row || !family || family.problem || family.current.id !== task)
      throw Error("Choose the current task.");
    if (store.openContestFor(ref.id) !== null)
      throw Error("Wait for the agent comparison to finish.");
    const scope = store.getScope(task!);
    state = {
      task,
      updatedAt: row.updatedAt,
      taskState: row.state,
      scope,
      latest: store.runsFor(ref.id)[0]?.id ?? null,
    };
    title = `${CHAT_ACTIONS[operation].label}: ${row.title}`;
    if (operation === "scope_approve") {
      if (!scope || ref.plan === "requested")
        throw Error(
          "Wait for the exact work and plan to be ready for approval.",
        );
      if (scope.digest === scope.approvedDigest)
        throw Error("This work is already approved.");
      const authority = scopeAuthorityOf(scope, {
        authMode: readAuthModeStrict,
      });
      if (!authority.ok) throw Error(authority.problem);
      state["authMode"] = authority.authMode;
      const race = store.activeTournamentTerms(ref.id);
      state["race"] = race;
      terms.push(
        ...describeScope(scope)
          .filter((line) => !/^\s*(reference|approved)\s/.test(line))
          .map((line) =>
            line
              .trimStart()
              .replace(/^goal\s+/, "Work: ")
              .replace(/^not this\s+/, "Excluded: ")
              .replace(/^touches\s+/, "Allowed files: "),
          ),
        ...(
          authority.chain ?? [
            { profile: authority.profile, authMode: authority.authMode },
          ]
        ).map(
          (entry, index) =>
            `${index === 0 ? "Agent permissions and limits" : "Fallback " + index}\n${runtimeTerms(entry.profile)}\n${entry.authMode === "api-key" ? "Uses your API key; spend is charged to that account." : entry.authMode === "subscription" ? "Uses your subscription login." : ""}`,
        ),
      );
      if (race)
        terms.push(`Agent comparison terms:\n${JSON.stringify(race, null, 2)}`);
      const plan = store.latestPlanArtifact(ref.id),
        revision =
          ref.revisionBriefArtifact === null
            ? null
            : store.getArtifact(ref.revisionBriefArtifact);
      if (ref.plan === "drafted" && !plan)
        throw Error("The saved plan is missing.");
      if (ref.revisionBriefArtifact !== null && !revision)
        throw Error("The revision evidence is missing.");
      for (const artifact of [plan, revision])
        if (artifact) {
          if (!root) throw Error("The saved approval evidence is unavailable.");
          const read = readVerifiedArtifact(root, artifact);
          if (
            !read.ok ||
            artifact.truncated ||
            artifact.redacted ||
            artifact.captureStatus === "failed"
          )
            throw Error(
              "The saved approval evidence could not be verified in full.",
            );
          state[artifact.kind] = { id: artifact.id, sha: artifact.sha256 };
          terms.push(
            `${artifact.kind === "plan" ? "Plan" : "Requested changes"}:\n${read.content.toString("utf8")}`,
          );
        }
    } else if (operation === "task_resume") {
      const run = integer(input, "run"),
        control = taskControlOf(store, ref.id, now);
      if (control.kind !== "paused" || control.run !== run)
        throw Error("This attempt is not ready to resume.");
      state["stop"] = store.stopOf(run);
      terms.push(
        `Resume saved work from attempt #${run}. Only this stop's hold is released. Other holds and approval requirements still apply.`,
      );
    } else if (operation === "task_cancel") {
      if (row.state === "cancelled" || row.state === "done")
        throw Error("This task cannot be cancelled now.");
      terms.push(
        "Cancel this task. It will no longer be scheduled. Existing work and evidence are preserved.",
      );
    } else {
      const run = resultOf(store, task!, integer(input, "run"), repo);
      state["run"] = { id: run.id, head: run.headRevision };
      const assignment = assignmentOf(
        store,
        task!,
        now,
        { principal: "operator", repos: who.repos },
        root,
      );
      const receipt = assignment?.receipt ?? null;
      if (assignment === null || receipt === null || receipt.runId !== run.id)
        throw Error(
          "This result changed. Open the current result before marking it complete.",
        );
      if (assignment.state === "complete")
        throw Error("This result is already marked complete.");
      if (assignment.state !== "ready-to-check")
        throw Error(`This result is not ready to complete: ${assignment.detail}`);
      state["receipt"] = receipt.digest;
      terms.push(
        `Result #${run.id} · ${run.headRevision === null ? "no commit recorded" : `commit ${run.headRevision.slice(0, 12)}`}`,
        "Marks this exact result complete: you handled it. Recorded checks stay unchanged, and publication or deployment is separate.",
        `Checks: ${receipt.checks.detail}`,
      );
      if (receipt.proof !== null && receipt.proof.matrix.length > 0)
        terms.push(
          `Requirements: ${receipt.proof.matrix.filter((row) => row.state === "pass").length}/${receipt.proof.matrix.length} satisfied in the saved record.`,
        );
      for (const line of assignment.attention) terms.push(line);
      for (const caveat of receipt.caveats)
        if (!assignment.attention.includes(caveat)) terms.push(`Limitation: ${caveat}`);
    }
  }
  const stamp = hash({
    operation,
    request,
    repo,
    state,
    terms,
    actor: who.name,
    generation: who.generation,
    ceiling: who.ceilingDigest,
  });
  return { operation, request, repo, title, terms, stamp, state };
}
export function sharedActionPayload(
  value: Record<string, unknown>,
): SharedAction | null {
  return isChatAction(value["operation"]) &&
    typeof value["stamp"] === "string" &&
    typeof value["repo"] === "string" &&
    typeof value["title"] === "string" &&
    Array.isArray(value["terms"]) &&
    value["terms"].every((t) => typeof t === "string") &&
    value["request"] !== null &&
    typeof value["request"] === "object" &&
    !Array.isArray(value["request"]) &&
    value["state"] !== null &&
    typeof value["state"] === "object"
    ? (value as unknown as SharedAction)
    : null;
}
/** A shortened or redacted preview is not complete consent. This rule lives
 * in the shared door, so a forged transport callback cannot bypass it. */
function sharedActionContentNeedsReview(action: SharedAction): boolean {
  const content = [action.title, ...action.terms];
  return (
    action.terms.join("\n").length > 1200 ||
    content.some(
      (value, index) =>
        publicChatText(value, index === 0 ? 200 : 1200) !==
        value.replace(/\s+/g, " ").trim(),
    )
  );
}
export function sharedActionNeedsReview(action: SharedAction): boolean {
  return (
    CHAT_ACTIONS[action.operation].protected ||
    sharedActionContentNeedsReview(action)
  );
}
/** Whether a paired phone may confirm this protected action behind its own
 * explicit challenge: the action is on the challenge list, needs no
 * password, and every term fits the card unshortened. */
export function sharedActionAllowsChallenge(action: SharedAction): boolean {
  const config = CHAT_ACTIONS[action.operation];
  return (
    CHALLENGE_ACTIONS.has(action.operation) &&
    config.protected &&
    !config.password &&
    !sharedActionContentNeedsReview(action)
  );
}
export function sharedActionReviewPath(id: number): string {
  return `/chat/action/${id}`;
}
function savedActionContext(
  store: Store,
  who: VerifiedApprover,
  id: number,
  state: "pending" | "confirming",
) {
  if (!isVerifiedApprover(who) || !reproveApprover(store, who).ok)
    throw Error("Your access changed. Sign in again.");
  const proposal = store.getMateProposal(id),
    payload =
      proposal?.kind === "action"
        ? sharedActionPayload(proposal.payload)
        : null;
  const shared=proposal&&store.handle.prepare('SELECT id FROM team_conversation WHERE thread=?').get(proposal.thread);
  const session = shared&&proposal ? store.teamMateSession(who.name,proposal.thread) : store.activeMateSession(who.name),
    turn = proposal ? store.getMateTurn(proposal.turn) : null;
  if (
    !proposal ||
    !payload ||
    proposal.state !== state ||
    (shared ? !store.canUseTeamMateThread(who.name,who.generation,proposal.thread) : store.getMateThread(proposal.thread)?.approver !== who.name)
  )
    throw Error("This action is no longer waiting for your review.");
  if (
    !session ||
    session.approverGeneration !== who.generation ||
    session.ceilingDigest !== who.ceilingDigest ||
    proposal.ceilingDigest !== who.ceilingDigest ||
    (!shared && turn?.session !== session.id) ||
    turn?.state !== "answered"
  )
    throw Error(
      "This conversation ended or its project access changed. Ask for a fresh proposal.",
    );
  requireActor(store, who, payload.repo);
  return payload;
}
export function mintSharedActionReview(
  store: Store,
  who: VerifiedApprover,
  id: number,
  root: string,
  now: Date,
) {
  const payload = savedActionContext(store, who, id, "pending");
  const live = prepareSharedAction(
    store,
    who,
    payload.operation,
    payload.request,
    root,
    now,
  );
  if (live.stamp !== payload.stamp)
    throw Error("This action changed. Ask for a fresh proposal.");
  const nonce = randomBytes(24).toString("hex");
  if (
    !store.mintCeremonyNonce(
      {
        hash: nonceHash(nonce),
        approver: who.name,
        subject: "chat-action",
        subjectId: id,
        digest: payload.stamp,
        ttlMs: 10 * 60_000,
      },
      now,
    ).ok
  )
    throw Error(
      "Too many reviews are open. Close older reviews and try again.",
    );
  return { payload: live, nonce };
}
export type SharedActionOptions = {
  via: "web" | "cli" | "telegram" | "slack" | "discord" | "teams";
  root?: string;
  review?: { nonce: string; password: string };
  confirm?: boolean;
};
/** Called inside the proposal door's transaction, after ownership and session
 * checks. No password or review receipt is ever part of a saved proposal. */
export function executeSharedAction(
  store: Store,
  who: VerifiedApprover,
  id: number,
  payload: SharedAction,
  now: Date,
  options: SharedActionOptions,
):
  | { ok: true; said: string; taskId: string | null }
  | { ok: false; reason: "needs-confirm" | "stale" | "refused"; said: string } {
  const refuse = (
    reason: "needs-confirm" | "stale" | "refused",
    said: string,
  ) => ({ ok: false as const, reason, said });
  if (store.isDemo()) return refuse("refused", "The demo authorizes nothing.");
  let live: SharedAction;
  try {
    const saved = savedActionContext(store, who, id, "confirming");
    if (hash(saved) !== hash(payload))
      return refuse(
        "refused",
        "This action does not match the saved proposal.",
      );
    live = prepareSharedAction(
      store,
      who,
      saved.operation,
      saved.request,
      options.root,
      now,
    );
    if (live.stamp !== saved.stamp)
      return refuse("stale", "This action changed. Ask for a fresh proposal.");
  } catch (error) {
    return refuse(
      "stale",
      error instanceof Error
        ? error.message
        : "This action is no longer available.",
    );
  }
  payload = live;
  const config = CHAT_ACTIONS[live.operation],
    req = live.request;
  const challenged =
    options.via !== "web" &&
    options.via !== "cli" &&
    options.confirm === true &&
    sharedActionAllowsChallenge(payload);
  if (sharedActionNeedsReview(payload) && !challenged) {
    if (options.via !== "web" || !options.review || options.confirm !== true)
      return refuse(
        "needs-confirm",
        "Review the complete action in the secure confirmation screen.",
      );
    if (
      !store.consumeCeremonyNonce(
        nonceHash(options.review.nonce),
        who.name,
        "chat-action",
        id,
        payload.stamp,
        now,
      )
    )
      return refuse(
        "needs-confirm",
        "This confirmation expired or was already used. Open the review again.",
      );
    if (
      config.password &&
      !authenticateApprover(
        store,
        who.name,
        options.review.password,
        payload.repo,
      ).ok
    )
      return refuse(
        "needs-confirm",
        "Confirm with your password in the secure screen.",
      );
  }
  try {
    return store.savepoint(() => {
      const task = typeof req["task"] === "string" ? req["task"] : null,
        repo = payload.repo,
        actor = who.name;
      let taskId = task;
      if (payload.operation === "skill_import")
        importSkill(
          store,
          repo,
          actor,
          req["files"] as SkillFile[],
          "Chat import",
          now,
        );
      else if (payload.operation === "skill_test")
        taskId = testSkill(
          store,
          {
            repo,
            actor,
            sha: String(req["version"]),
            sample: String(req["sample"]),
            nonce: String(req["nonce"]),
          },
          now,
        ).id;
      else if (payload.operation.startsWith("skill_"))
        changeSkills(
          store,
          {
            repo,
            actor,
            identity: String(payload.state["identity"]),
            revision: Number(payload.state["revision"]),
            action: payload.operation.slice(6) as
              "enable" | "disable" | "restore",
            ...(req["version"] === undefined
              ? {}
              : { sha: String(req["version"]) }),
            ...(req["restore"] === undefined
              ? {}
              : { restore: Number(req["restore"]) }),
          },
          now,
        );
      else if (payload.operation === "tool_add") {
        const added = addToolTo(store, repo, toolSpecFromRequest(req), req["catalog"] === undefined ? "the lead, confirmed by you" : "the common tools list", actor, now);
        if (!added.ok) throw Error(added.message);
      } else if (payload.operation === "tool_remove") {
        if (!removeToolFrom(store, repo, String(req["name"]), actor, now)) throw Error("That tool was already removed.");
      }
      else if (payload.operation === "decision_record")
        recordDecision(store, { repo, actor, draft: { claim: String(req["claim"]), why: String(req["why"]), sourceKind: "conversation",
          ...(req["source"] === undefined ? {} : { sourceRef: String(req["source"]) }), ...(payload.state["supersedes"] === undefined ? {} : { supersedes: Number(payload.state["supersedes"]) }) } }, now);
      else if (payload.operation === "decision_retire")
        retireDecision(store, { repo, actor, id: Number(payload.state["decision"]), reason: String(req["reason"]) }, now);
      else if (payload.operation.startsWith("knowledge_"))
        changeKnowledge(
          store,
          {
            repo,
            actor,
            identity: String(payload.state["identity"]),
            revision: Number(payload.state["revision"]),
            action: payload.operation.slice(10) as
              "instructions" | "save" | "remove" | "restore",
            draft: Object.fromEntries(
              ["instructions", "title", "content", "id"]
                .filter((k) => req[k] !== undefined)
                .map((k) => [k, req[k]]),
            ) as KnowledgeDraft,
            ...(req["restore"] === undefined
              ? {}
              : { restore: Number(req["restore"]) }),
          },
          now,
        );
      else if (payload.operation === "scope_approve") {
        const scope = store.getScope(task!)!,
          race = store.activeTournamentTerms(store.lookupRef(task!)!.id);
        const result = approve(
          store,
          task!,
          actor,
          now,
          scope.digest,
          options.review!.password,
        );
        if (!result.ok) throw Error(`Approval refused: ${result.reason}.`);
        if (
          race &&
          !store.approveTournamentTerms(race.id, actor, race.raceDigest, now)
        )
          throw Error("The comparison terms changed. Nothing was approved.");
      } else if (payload.operation === "result_accept") {
        const completed = checkAssignmentAsOperator(
          store,
          task!,
          String(payload.state["receipt"] ?? ""),
          who,
          now,
          options.root,
        );
        if (!completed.ok) throw Error(completed.message);
      } else if (payload.operation === "task_cancel") {
        const result = store.cancelTask(task!, now);
        if (!result.ok)
          throw Error(`Task was not cancelled: ${result.reason}.`);
      } else if (payload.operation === "task_resume") {
        const result = resumeTaskStop(
          store,
          {
            taskId: task!,
            runId: Number(req["run"]),
            by: verifiedAuthor(actor),
            via: "web",
          },
          now,
        );
        if (!result.ok) throw Error(result.detail);
        return {
          ok: true as const,
          taskId,
          said: `Stop released. ${result.gate ? "Other requirements still prevent the next attempt." : "The next attempt may start."}`,
        };
      }
      const said =
        payload.operation === "skill_test"
          ? "Skill test created. Existing approval rules apply."
          : payload.operation === "result_accept"
              ? "Marked complete. The recorded checks are unchanged."
              : payload.operation === "scope_approve"
                ? "The exact work is approved."
                : payload.operation === "task_cancel"
                  ? "Task cancelled."
                  : payload.operation === "skill_import"
                    ? "Skill added to the library."
                    : payload.operation === "skill_enable"
                      ? "Skill enabled for future runs."
                      : payload.operation === "skill_disable"
                        ? "Skill disabled for future runs."
                        : payload.operation === "skill_restore"
                          ? "Saved skills restored."
                          : payload.operation === "decision_record"
                            ? "Decision recorded for this project."
                            : payload.operation === "decision_retire"
                              ? "Decision retired; its history stays."
                          : payload.operation === "tool_add"
                            ? "Tool added for work you approve from now on. Set any secrets it needs and test it on the Tools page."
                          : payload.operation === "tool_remove"
                            ? "Tool removed from every build."
                          : payload.operation === "knowledge_remove"
                            ? "Reference removed."
                            : payload.operation === "knowledge_restore"
                              ? "Saved project knowledge restored."
                              : "Project knowledge saved.";
      return { ok: true as const, taskId, said };
    });
  } catch (error) {
    return refuse(
      "refused",
      error instanceof Error
        ? error.message
        : "The action could not be completed.",
    );
  }
}
