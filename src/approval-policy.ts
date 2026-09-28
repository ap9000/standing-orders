/**
 * Separation of duties (v102): a project's approval rules. Two can be on at
 * once, and neither changes a thing until a project turns it on.
 *
 * - The person who filed a task can't approve it ("not the requester").
 * - Protected work (the whole project, or tasks that touch protected paths)
 *   needs two different people to approve the same exact scope, and an AI
 *   teammate or an operating mode can never decide it.
 *
 * The store enforces these at the one place every approval is sealed
 * (`Store.sealScopeApproval`); this module holds the pure parts.
 */

/** Who filed a task, as far as anyone can tell: a person (browser, chat, a
 * revision), a coordinator acting for the person who made it, an AI
 * teammate, or automation that names no person (a routine, the CLI, a flow
 * with no owner). The requester rule binds only a named person. */
export type FilerKind = "person" | "coordinator" | "teammate" | "automation";
export type Filer = { name: string | null; kind: FilerKind };

/** A filer from a name as the ledger writes it: an AI teammate's ends " (AI)"; a coordinator's starts "coordinator:"; none is automation. */
export function filerFor(name: string | null | undefined): Filer {
  if (name == null || name === "") return { name: null, kind: "automation" };
  if (name.endsWith(" (AI)")) return { name, kind: "teammate" };
  if (name.startsWith("coordinator:")) return { name, kind: "coordinator" };
  return { name, kind: "person" };
}

export type ApprovalRules = { notRequester: boolean; protectProject: boolean; protectedPaths: string[] };
export const NO_RULES: ApprovalRules = { notRequester: false, protectProject: false, protectedPaths: [] };

/** Who is sealing: a person at a ceremony, an operating mode, an AI teammate, or automation. */
export type ApproverKind = "person" | "mode" | "ai" | "automation";
export type ApprovalGate =
  | { verdict: "seal"; protectedWork: boolean }
  | { verdict: "vote"; have: number; need: 2; already: boolean }
  | { verdict: "refuse"; reason: "requester" | "person-required" };

const clean = (path: string) => path.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
const wild = /[*?[]/;
const literalPrefix = (glob: string) => { const at = glob.search(wild); return at === -1 ? glob : glob.slice(0, at); };
function globRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") { out += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|\\[\]]/g, "\\$&");
  }
  return new RegExp(`^${out}(?:/.*)?$`);
}

/** Whether a task that says it touches `touch` may touch something under
 * `protectedGlob`. Exact paths are matched; two patterns that could reach
 * the same files (one's literal start inside the other's) count as
 * overlapping, which errs toward protecting. */
export function touchesProtected(touch: string, protectedGlob: string): boolean {
  const a = clean(touch), b = clean(protectedGlob);
  if (a === "" || b === "") return b === "" ? false : true;
  if (!wild.test(a)) return globRegex(b).test(a);
  const pa = literalPrefix(a), pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** Whether a task's declared paths reach protected work. A task that
 * declares no paths can't show it stays clear, so it counts as protected. */
export function isProtectedWork(rules: ApprovalRules, touches: string[]): boolean {
  if (rules.protectProject) return true;
  if (rules.protectedPaths.length === 0) return false;
  if (touches.length === 0) return true;
  return touches.some(touch => rules.protectedPaths.some(glob => touchesProtected(touch, glob)));
}

/** Protected paths as a person types them: one per line or comma separated, trimmed, deduplicated, at most 50. */
export function parseProtectedPaths(raw: string): { ok: true; paths: string[] } | { ok: false; problem: string } {
  const paths = [...new Set(raw.split(/[\n,]/).map(clean).filter(one => one !== ""))];
  if (paths.length > 50) return { ok: false, problem: "Protect at most 50 paths." };
  const long = paths.find(one => one.length > 200);
  if (long !== undefined) return { ok: false, problem: "A protected path is 200 characters at most." };
  return { ok: true, paths };
}

/** The rules in a line, for the ledger's before → after. */
export function rulesWords(rules: ApprovalRules): string {
  const parts = [
    rules.notRequester ? "requester can't approve" : null,
    rules.protectProject ? "whole project protected" : rules.protectedPaths.length > 0 ? `protected: ${rules.protectedPaths.join(", ")}` : null,
  ].filter((one): one is string => one !== null);
  return parts.length === 0 ? "no rules" : parts.join("; ");
}

/** What a person reads when the rules stop an approval. */
export function gateWords(gate: Exclude<ApprovalGate, { verdict: "seal" }>): string {
  if (gate.verdict === "vote") return gate.already
    ? "You've already approved this. It needs a second approver."
    : `Your approval is recorded (${gate.have} of ${gate.need}). This work is protected, so a second person needs to approve it.`;
  return gate.reason === "requester"
    ? "You filed this task, and this project needs someone else to approve it."
    : "This work is protected: a person has to approve it, not an operating mode, a routine or an AI teammate.";
}
