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

  const provider: ProviderId =
    row !== null && isProviderId(row.provider) ? row.provider : "claude";
  // --model alone rides the resolved provider; otherwise the pair comes
  // whole from the row that named the provider.
  const model = flags.model ?? (row !== null ? row.model : null);
  const spec: AgentSpec = { provider, model };
  const valid = validateSpec(spec);
  return valid.ok ? { ok: true, spec, source: flags.model !== undefined ? "flag" : source } : { ok: false, problem: valid.problem };
}
