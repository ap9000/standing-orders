/** A passwordless confirmation exists only inside one authenticated browser POST. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Store } from "./store.js";
import { isVerifiedApprover, reproveApprover, type VerifiedApprover } from "./principal.js";

const current = new AsyncLocalStorage<{ store: Store; who: VerifiedApprover; active: boolean }>();

export function sessionApprovalAllowed(store: Store, name: string): boolean {
  const context = current.getStore();
  return context !== undefined && context.active && context.store === store && context.who.name === name &&
    reproveApprover(store, context.who).ok && !store.approvalPasswordRequired(name);
}

export async function withSessionApproval<T>(store: Store, who: VerifiedApprover, action: () => Promise<T>): Promise<T> {
  if (!isVerifiedApprover(who) || !reproveApprover(store, who).ok || store.approvalPasswordRequired(who.name)) throw new Error("This session cannot confirm approvals.");
  const context = { store, who, active: true };
  try { return await current.run(context, action); }
  finally { context.active = false; }
}

/** Account administration and authentication have their own password policy. */
export function isWorkApprovalPath(path: string): boolean {
  // Starting a conversation is a work approval like any other: it delegates
  // the operator's own standing for a window, and the preference that
  // relaxes retyping for the rest of the console governs it too.
  return ["/control/setup-approve", "/control/instructions-approve", "/projects/add-confirm", "/projects/onboard-confirm", "/chat/mate/mint"].includes(path) ||
    /^\/t\/[^/]+\/(approve|settings-approve|publish-confirm|reopen)$/.test(path) ||
    /^\/routines\/[0-9]+\/(approve|run-now)$/.test(path) ||
    /^\/contest\/[0-9]+\/(pick|abandon)$/.test(path);
}
