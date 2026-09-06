import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { approve, authenticateApprover, canonicalProfileJson, digestOf, profileFromJson, proposeGuarded, type ExecutionProfile } from "./scope.js";
import { resolveScopeProfile } from "./agentconfig.js";
import { validateSpec } from "./provider.js";

export type ExecutionInputs = { model: string; turns: string; minutes: string; posture: string; tools: string };

/** A read-only preview; configuration and old approvals are untouched. */
export function previewExecutionChange(store: Store, taskId: string, inputs: ExecutionInputs, now: Date) {
  const scope = store.getScope(taskId);
  const ref = store.lookupRef(taskId);
  if (scope === null || ref === null) return { ok: false as const, message: "Write the task scope first." };
  if (store.hasLiveClaim(ref.id, now)) return { ok: false as const, message: "Stop the current build before changing its settings." };
  if (scope.proposedChainJson != null || store.activeTournamentTerms(ref.id) !== null || store.openAuthorizationFor(ref.id) !== null) {
    return { ok: false as const, message: "This task has a fallback chain, comparison, or attended authorization. Update its full terms before changing execution settings." };
  }
  const resolved = scope.profile == null ? resolveScopeProfile(store, ref.repo, ref, { model: inputs.model.trim() }) : { ok: true as const, profile: scope.profile };
  if (!resolved.ok) return { ok: false as const, message: resolved.problem };
  const original = resolved.profile;
  const valid = validateSpec({ provider: original.provider, model: inputs.model.trim() });
  if (!valid.ok) return { ok: false as const, message: valid.problem };
  const minutes = Number(inputs.minutes);
  const turns = Number(inputs.turns);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240 || (original.provider === "claude" && (!Number.isInteger(turns) || turns < 1 || turns > 2000))) {
    return { ok: false as const, message: "Use 1–240 minutes and, for Claude, 1–2000 turns." };
  }
  if (!["safe", "escalated"].includes(inputs.posture)) return { ok: false as const, message: "Choose a permission setting." };
  if (inputs.posture === "escalated" && original.provider !== "claude" && original.provider !== "gemini") return { ok: false as const, message: "This provider keeps its existing permission settings." };
  const tools = [...new Set(inputs.tools.split(/\r?\n/).map(one => one.trim()).filter(Boolean))];
  if (original.provider !== "claude" && tools.length > 0) return { ok: false as const, message: "Additional tool rules are supported for Claude builds." };
  const edited: ExecutionProfile = original.provider === "claude"
    ? { ...original, model: inputs.model.trim(), maxTurns: turns, timeoutSeconds: minutes * 60, permissionArgv: inputs.posture === "escalated" ? "bypassPermissions" : "acceptEdits", allowedTools: tools }
    : original.provider === "gemini"
      ? { ...original, model: inputs.model.trim(), timeoutSeconds: minutes * 60, approvalArgv: inputs.posture === "escalated" ? "yolo" : "auto_edit" }
      : { ...original, model: inputs.model.trim(), timeoutSeconds: minutes * 60 };
  const profile = profileFromJson(canonicalProfileJson(edited));
  if (profile === null) return { ok: false as const, message: "Execution settings contain an invalid model, limit, or tool rule." };
  const digest = digestOf(scope, profile);
  const fingerprint = createHash("sha256").update(JSON.stringify({ taskId, before: scope.digest, after: digest })).digest("hex");
  return { ok: true as const, scope, profile, digest, fingerprint };
}

/** The exact preview is re-proven and signed in one transaction. */
export function approveExecutionChange(store: Store, args: { taskId: string; inputs: ExecutionInputs; fingerprint: string; by: string; token: string; resume: boolean; now: Date }) {
  return store.transact(() => {
    const preview = previewExecutionChange(store, args.taskId, args.inputs, args.now);
    if (!preview.ok) return preview;
    if (preview.fingerprint !== args.fingerprint) return { ok: false as const, message: "The scope changed. Review the settings again." };
    // Authenticate BEFORE rewriting; a rejected password must change nothing.
    const actor = authenticateApprover(store, args.by, args.token);
    if (!actor.ok) return { ok: false as const, message: "Sign in with your operator credential to approve these settings." };
    const proposed = proposeGuarded(store, { taskId: args.taskId, taskRef: store.lookupRef(args.taskId)?.id ?? null,
      goal: preview.scope.goal, outOfScope: preview.scope.outOfScope, touches: preview.scope.touches,
      budgetMicrousd: preview.scope.budgetMicrousd, profile: preview.profile, sawDigest: preview.scope.digest, now: args.now });
    if (!proposed.ok) return { ok: false as const, message: `The scope could not be updated: ${proposed.reason}.` };
    const approved = approve(store, args.taskId, args.by, args.now, preview.digest, args.token);
    if (!approved.ok) throw new Error(`Approval failed: ${approved.reason}`);
    if (args.resume) store.unhold(store.lookupRef(args.taskId)!.id);
    return { ok: true as const };
  });
}
