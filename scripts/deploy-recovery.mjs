// What a browser deployment that ends in failure puts back. A refusal before
// the swap stopped anything only lifts this deployment's own pause. Once the
// old service is proved stopped, it is started again from its saved definition
// and the pause is lifted too, so a failure never leaves the plane down
// (Oct 2: two deploys over 0.9.11 stopped and stayed down until restored by
// hand). A stop that was not proved (old processes may still run) or a new
// service that may be running is left as it is, for a person to inspect.
export const PAUSED_BEFORE_SWAP = Object.freeze(["admission-paused", "frozen", "backup-verified", "rehearsed"]);
export const STOPPED_BEFORE_START = Object.freeze(["stopped", "migrating", "migrated"]);

/** effects: restoreService() starts the previous definition, removeGate() lifts
 * this deployment's own pause, mark(phase) journals the outcome. Returns the
 * words to show, or null when nothing was this function's to undo. */
export function recoverFailedDeployment(phase, effects) {
  if (PAUSED_BEFORE_SWAP.includes(phase)) {
    effects.removeGate();
    effects.mark("released");
    return "New work resumed: the deployment stopped before the swap and lifted its pause.";
  }
  const restoring = STOPPED_BEFORE_START.includes(phase);
  if (!restoring && phase !== "restored") return null;
  if (restoring) {
    effects.restoreService();
    effects.mark("restored");
  }
  effects.removeGate();
  effects.mark("released");
  return "The deployment failed after stopping the service: the previous service was started again and new work resumed.";
}
