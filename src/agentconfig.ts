/**
 * Phase-agent resolution: which provider and model a phase runs on, layer
 * by layer, with the layers written down (Codex provider review, Q8).
 *
 *   pinned task agent  — stamped by a fire transaction; NOTHING overrides it
 *   explicit flags     — this pass's operator, per field
 *   project override   — phase_config row scoped to the canonical repo
 *   installation       — phase_config row scoped 'installation'
 *   default            — claude, harness default model
 *
 * Config rows are COMPLETE pairs (provider required, model optional), so a
 * partial override cannot marry a codex model to an inherited claude
 * provider. Flags are per-field with one stated rule: `--model` alone
 * rides whatever provider resolves; `--provider` alone runs that
 * provider's default model — a lower layer's model never crosses onto a
 * flag-chosen provider it was not written for.
 *
 * The resolved pair is validated before anything is claimed or spent, and
 * the caller snapshots it into the run row.
 */

import { isProviderId, validateSpec, type AgentSpec, type Phase, type ProviderId } from "./provider.js";
import type { Store, TaskRef } from "./store.js";
import { CLAUDE_LIMITS, CODEX_SHAPED_LIMITS, GEMINI_LIMITS, type ExecutionProfile } from "./scope.js";

export const INSTALLATION_SCOPE = "installation";

export type PhaseFlags = { provider?: string | undefined; model?: string | undefined };

export type Resolution =
  | { ok: true; spec: AgentSpec; source: "pinned" | "flag" | "project" | "installation" | "default" }
  | { ok: false; problem: string };

export function resolvePhaseAgent(
  store: Store,
  phase: Phase,
  repo: string | null,
  flags: PhaseFlags,
  /** The task being dispatched, when one is — its pin is authoritative. */
  ref?: Pick<TaskRef, "agentProvider" | "agentModel">,
): Resolution {
  // The pin: a firing resolved under approved terms must not be re-routed
  // by anything later, flags included (Codex provider review, critical 1).
  if (ref !== undefined && ref.agentProvider !== null) {
    if (!isProviderId(ref.agentProvider)) {
      return { ok: false, problem: `the task is pinned to unknown provider \`${ref.agentProvider}\`` };
    }
    const spec: AgentSpec = { provider: ref.agentProvider, model: ref.agentModel };
    const valid = validateSpec(spec);
    return valid.ok ? { ok: true, spec, source: "pinned" } : { ok: false, problem: valid.problem };
  }

  if (flags.provider !== undefined) {
    if (!isProviderId(flags.provider)) {
      return { ok: false, problem: `unknown provider \`${flags.provider}\`` };
    }
    const spec: AgentSpec = { provider: flags.provider, model: flags.model ?? null };
    const valid = validateSpec(spec);
    return valid.ok ? { ok: true, spec, source: "flag" } : { ok: false, problem: valid.problem };
  }

  const project = repo === null ? null : store.phaseConfig(repo, phase);
  const installation = store.phaseConfig(INSTALLATION_SCOPE, phase);
  const row = project ?? installation;
  const source = project !== null ? ("project" as const) : installation !== null ? ("installation" as const) : ("default" as const);

  // A misconfigured row REFUSES instead of silently rerouting to claude
  // (foundations finding 3c): the operator wrote a provider; running a
  // different one is not a fallback, it is a substitution.
  if (row !== null && !isProviderId(row.provider)) {
    return { ok: false, problem: `the ${source} configuration names unknown provider \`${row.provider}\` — fix it with \`config set\`` };
  }
  const provider: ProviderId =
    row !== null && isProviderId(row.provider) ? row.provider : "claude";
  // --model alone rides the resolved provider; otherwise the pair comes
  // whole from the row that named the provider.
  const model = flags.model ?? (row !== null ? row.model : null);
  const spec: AgentSpec = { provider, model };
  const valid = validateSpec(spec);
  return valid.ok ? { ok: true, spec, source: flags.model !== undefined ? "flag" : source } : { ok: false, problem: valid.problem };
}

/**
 * The FILING resolver (foundations findings 13/15/19): the execution
 * profile a scope stores, resolved once, exactly, at filing. The model is
 * the exact string the argv will carry — the harness-default road refuses
 * here rather than floating (ruling 10). Repair precedence: the
 * --repair-model flag, else the repair phase-config row's MODEL (its
 * provider must equal the build provider — cross-provider repair does not
 * exist), else the literal "inherit". Callers that file scopes SAVE an
 * unresolved state on refusal (finding 19) — this function only says why.
 */
export type ProfileResolution =
  | { ok: true; profile: ExecutionProfile; provenance: { resolvedFrom: string; repairFrom: string } }
  | { ok: false; reason: "unknown-provider" | "no-model" | "repair-provider-mismatch"; problem: string };

export function resolveScopeProfile(
  store: Store,
  repo: string | null,
  ref: Pick<TaskRef, "agentProvider" | "agentModel"> | undefined,
  flags: PhaseFlags & { repairModel?: string | undefined },
): ProfileResolution {
  const build = resolvePhaseAgent(store, "build", repo, flags, ref);
  if (!build.ok) return { ok: false, reason: "unknown-provider", problem: build.problem };
  const { provider, model } = build.spec;
  if (model === null || model === "") {
    return {
      ok: false,
      reason: "no-model",
      problem:
        "approvals bind exact routing — name --model on the scope, or set a default once with `config set build --provider " +
        provider +
        " --model <model>`",
    };
  }

  let repairModel = "inherit";
  let repairFrom = "inherit";
  if (flags.repairModel !== undefined && flags.repairModel !== "") {
    repairModel = flags.repairModel;
    repairFrom = "flag";
  } else {
    const repairRow = (repo === null ? null : store.phaseConfig(repo, "repair")) ?? store.phaseConfig(INSTALLATION_SCOPE, "repair");
    if (repairRow !== null) {
      if (repairRow.provider !== provider) {
        return {
          ok: false,
          reason: "repair-provider-mismatch",
          problem: `the repair configuration names provider \`${repairRow.provider}\` but the build runs \`${provider}\` — cross-provider repair does not exist; fix the repair row or name --repair-model`,
        };
      }
      if (repairRow.model !== null && repairRow.model !== "") {
        repairModel = repairRow.model;
        repairFrom = "config";
      }
    }
  }

  const profile: ExecutionProfile =
    provider === "claude"
      ? {
          provider,
          model,
          // Phase 1 files acceptEdits ONLY (finding 22) — bypass arrives
          // with the attended authorization work, through its own ceremony.
          permissionArgv: "acceptEdits",
          maxTurns: CLAUDE_LIMITS.maxTurns,
          repairMaxTurns: CLAUDE_LIMITS.repairMaxTurns,
          timeoutSeconds: CLAUDE_LIMITS.timeoutSeconds,
          repairTimeoutSeconds: CLAUDE_LIMITS.repairTimeoutSeconds,
          repairModel,
        }
      : provider === "gemini"
        ? {
            provider,
            model,
            // Filing seals auto_edit ONLY — the acceptEdits parallel; yolo
            // is a ceremony-worded escalation, not a filing default.
            approvalArgv: "auto_edit",
            maxTurns: "unsupported",
            repairMaxTurns: "unsupported",
            timeoutSeconds: GEMINI_LIMITS.timeoutSeconds,
            repairTimeoutSeconds: GEMINI_LIMITS.repairTimeoutSeconds,
            repairModel,
          }
        : {
            provider,
            model,
            sandboxMode: "workspace-write",
            maxTurns: "unsupported",
            repairMaxTurns: "unsupported",
            timeoutSeconds: CODEX_SHAPED_LIMITS.timeoutSeconds,
            repairTimeoutSeconds: CODEX_SHAPED_LIMITS.repairTimeoutSeconds,
            repairModel,
          };
  return { ok: true, profile, provenance: { resolvedFrom: build.source, repairFrom } };
}
