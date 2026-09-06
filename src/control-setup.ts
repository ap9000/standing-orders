import { createHash } from "node:crypto";
import { hasDisguisedText } from "./decision.js";
import type { Store } from "./store.js";
import { authenticateApprover } from "./scope.js";
import { isProviderId, validateSpec } from "./provider.js";

export type SetupInputs = { provider: string; model: string; command: string; seconds: string };
export function previewSetup(store: Store, repo: string, inputs: SetupInputs) {
  if (!isProviderId(inputs.provider)) return { ok: false as const, message: "Choose an installed provider." };
  const spec = validateSpec({ provider: inputs.provider, model: inputs.model.trim() });
  if (!spec.ok) return { ok: false as const, message: spec.problem };
  const command = inputs.command.trim();
  if (command.length > 2000 || hasDisguisedText(command)) return { ok: false as const, message: "Use a setup command under 2000 characters without control characters." };
  if (/([A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api_key|authorization|bearer|credential)[A-Za-z0-9_-]*\s*[=:]\s*)(?![$"']?\$)\S+/i.test(command) || /\/\/[^\s/@]+:[^\s/@]+@/.test(command)) return { ok: false as const, message: "Remove literal credentials from the setup command." };
  const seconds = Number(inputs.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) return { ok: false as const, message: "Setup timeout must be 1–3600 seconds." };
  const fingerprint = createHash("sha256").update(JSON.stringify({ repo, inputs, beforeSetup: store.liveWorktreeSetup(repo), beforeConfig: store.phaseConfig(repo, "build") })).digest("hex");
  return { ok: true as const, fingerprint, command, seconds, provider: inputs.provider, model: inputs.model.trim() };
}

export function approveSetup(store: Store, repo: string, inputs: SetupInputs, fingerprint: string, by: string, token: string, now: Date) {
  return store.transact(() => {
    if (!authenticateApprover(store, by, token).ok) return { ok: false as const, message: "Your operator credential is required." };
    const preview = previewSetup(store, repo, inputs);
    if (!preview.ok) return preview;
    if (preview.fingerprint !== fingerprint) return { ok: false as const, message: "Setup changed. Review it again." };
    store.setPhaseConfig(repo, "build", preview.provider, preview.model, by, now);
    if (preview.command === "") store.clearWorktreeSetup(repo, by, now);
    else store.setWorktreeSetup({ repo, command: preview.command, timeoutMs: preview.seconds * 1000, approvedBy: by }, now);
    return { ok: true as const };
  });
}
