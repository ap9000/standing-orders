/**
 * The tools a teammate may use (v94), and its rule for each of their actions.
 *
 * A teammate never calls a tool itself. On its turn it may ask for one call
 * ("use_tool": which action, with what input, and why), and Standing Orders
 * checks the rule its manager set for that action:
 *
 * - do it: the call is made and its answer goes back to the teammate, whose
 *   turn goes on;
 * - ask first: the exact call goes to the zone's person, in their chat app
 *   and on the card. Approve makes exactly that call; Deny doesn't; words
 *   tell the teammate what to do instead;
 * - never: the action isn't offered at all.
 *
 * "Do it" can ask first above a number in the input ("refunds up to $50"),
 * so a limit holds in code, not only in the soul file's words. Every call,
 * made or not, is a receipt on the card and on the teammate's page.
 */
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import type { ToolCaller } from "./flow-actions.js";
import { scrubSecrets } from "./flow-secrets.js";
import { callProjectTool, listProjectToolActions, projectToolsOf, readToolSecrets, type ProjectTool, type ToolSpec } from "./project-tools.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import type { Store, TeammateCallRow, TeammateGrantRow, TeammateRow, ToolActionInfo, ToolRule } from "./store.js";

/** Lists what a tool offers; injectable so tests never start a server. */
export type ToolLister = (spec: ToolSpec, values: Record<string, string>) => Promise<{ ok: true; actions: ToolActionInfo[] } | { ok: false; problem: string }>;
export type ToolIo = { callTool?: ToolCaller; listTools?: ToolLister; toolHome?: string };

/** Actions whose names say they only read start as "do it"; everything else asks first until its manager says otherwise. */
export const READ_VERB = /^(get|list|search|find|read|fetch|lookup|look_up|query|show|describe|count|check|view|retrieve)([_.-]|$)/i;
export const defaultRule = (action: Pick<ToolActionInfo, "name" | "readOnly">): ToolRule => ({ use: action.readOnly || READ_VERB.test(action.name) ? "free" : "ask" });
/** How long a tool's listing is trusted before a turn lists it again. */
const LISTING_MS = 6 * 60 * 60_000;
const RESULT_CHARS = 6000;

type Done = { ok: true; said: string } | { ok: false; said: string };

/** How a turn names an action: "shop.refund_order". */
export const callName = (tool: string, action: string) => `${tool}.${action}`;

/** A fresh listing merged into a grant: rules already set are kept, new actions get the default, and gone ones drop out. */
export function withActions(rules: Record<string, ToolRule>, actions: readonly ToolActionInfo[]): { actions: ToolActionInfo[]; rules: Record<string, ToolRule> } {
  return { actions: [...actions], rules: Object.fromEntries(actions.map(one => [one.name, rules[one.name] ?? defaultRule(one)])) };
}

const numberOf = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value
  : typeof value === "string" && /^\s*-?\$?\d+(\.\d+)?\s*$/.test(value) ? Number(value.replace(/[$\s]/g, "")) : null;

/** The rule that applies to one call with this input, and why, in words. */
export function ruleFor(grant: Pick<TeammateGrantRow, "actions" | "rules">, action: string, input: Record<string, unknown>): { use: ToolRule["use"]; why: string } {
  const info = grant.actions.find(one => one.name === action);
  const rule = grant.rules[action] ?? (info === undefined ? { use: "never" as const } : defaultRule(info));
  if (info === undefined || rule.use === "never") return { use: "never", why: `The rules never allow ${action}.` };
  if (rule.use === "ask") return { use: "ask", why: `${action} needs a person's approval each time.` };
  if (rule.limit !== undefined) {
    const value = numberOf(input[rule.limit.field]);
    if (value === null) return { use: "ask", why: `${action} is free only up to ${rule.limit.field} ${rule.limit.over}, and this call gives no ${rule.limit.field}.` };
    if (value > rule.limit.over) return { use: "ask", why: `${rule.limit.field} ${value} is over the limit of ${rule.limit.over}.` };
  }
  return { use: "free", why: "" };
}

/** A rule in words, for the teammate's turn and its page. */
export function ruleWords(rule: ToolRule): string {
  if (rule.use === "never") return "never";
  if (rule.use === "ask") return "a person approves each call first";
  return rule.limit === undefined ? "use freely" : `use freely up to ${rule.limit.field} ${rule.limit.over}; above that, a person approves first`;
}

/** Number fields an action's input declares: what a limit can be set on. */
export function numberFields(action: Pick<ToolActionInfo, "input">): string[] {
  const properties = (action.input?.["properties"] ?? {}) as Record<string, { type?: unknown }>;
  return Object.entries(properties).filter(([, one]) => one !== null && typeof one === "object" && (one.type === "number" || one.type === "integer")).map(([name]) => name).slice(0, 20);
}

/** What's wrong with an input, by what the action declares: its required fields and their simple types. */
export function inputProblem(action: Pick<ToolActionInfo, "input">, input: Record<string, unknown>): string | null {
  const schema = action.input;
  if (schema === null) return null;
  const properties = (schema["properties"] ?? {}) as Record<string, { type?: unknown }>;
  const required = Array.isArray(schema["required"]) ? (schema["required"] as unknown[]).filter((one): one is string => typeof one === "string") : [];
  const missing = required.filter(one => input[one] === undefined || input[one] === null || input[one] === "");
  if (missing.length > 0) return `It needs ${missing.join(", ")}.`;
  for (const [name, value] of Object.entries(input)) {
    const type = properties[name]?.type;
    const fits = type === undefined || typeof type !== "string" ? true
      : type === "string" ? typeof value === "string" : type === "number" ? numberOf(value) !== null : type === "integer" ? Number.isInteger(numberOf(value))
      : type === "boolean" ? typeof value === "boolean" : type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : true;
    if (!fits) return `${name} should be ${type === "integer" ? "a whole number" : `a ${type}`}.`;
  }
  return null;
}

/** A call in a few words: "shop → refund_order · order 1044 · amount 400". */
export function callWords(tool: string, action: string, input: Record<string, unknown>, cap = 300): string {
  const parts = Object.entries(input).map(([key, value]) => `${key} ${typeof value === "string" ? value.replace(/\s+/g, " ") : JSON.stringify(value)}`);
  const line = `${tool} → ${action}${parts.length === 0 ? "" : ` · ${parts.join(" · ")}`}`;
  return line.length <= cap ? line : `${line.slice(0, cap - 1)}…`;
}

/** An action as a turn is offered it. */
export type OfferedTool = { name: string; about: string; input: string; rule: string };

/** What a teammate may use now: its grants' actions on tools the project still has, "never" left out. */
export function offeredTools(store: Store, mate: TeammateRow): OfferedTool[] {
  const present = new Set(projectToolsOf(store, mate.repo).map(one => one.name));
  return store.teammateGrants(mate.id).filter(grant => present.has(grant.tool)).flatMap(grant => grant.actions.flatMap(action => {
    const rule = grant.rules[action.name] ?? defaultRule(action);
    if (rule.use === "never") return [];
    const input = action.input === null ? "any" : JSON.stringify({ properties: action.input["properties"] ?? {}, required: action.input["required"] ?? [] });
    return [{ name: callName(grant.tool, action.name), about: action.about, input: input.length > 1500 ? `${input.slice(0, 1499)}…` : input, rule: ruleWords(rule) }];
  })).slice(0, 40);
}

/** Before a turn: re-list tools whose listing is old (or never happened), so the turn sees what they offer today. A tool that can't be reached keeps its last listing. */
export async function refreshGrants(store: Store, mate: TeammateRow, now: Date, io: ToolIo): Promise<void> {
  const tools = projectToolsOf(store, mate.repo);
  for (const grant of store.teammateGrants(mate.id)) {
    if (grant.listedAt !== null && now.getTime() - Date.parse(grant.listedAt) < LISTING_MS) continue;
    const tool = tools.find(one => one.name === grant.tool);
    if (tool === undefined) continue;
    const listed = await listed_(tool, mate.repo, io);
    if (!listed.ok) continue;
    store.saveTeammateGrant({ teammate: mate.id, tool: grant.tool, ...withActions(grant.rules, listed.actions), listedAt: now.toISOString() }, grant.updatedBy, now);
  }
}

const listed_ = (tool: ProjectTool, repo: string, io: ToolIo) =>
  (io.listTools ?? ((spec, values) => listProjectToolActions(spec, values, { timeoutMs: 60_000, omitEnv: ALL_CREDENTIAL_ENV })))(tool.spec, readToolSecrets(repo, tool.name, io.toolHome));

/** Names only, from the tool's last test: what a grant starts with when it can't be listed right now. */
const namesOnly = (tool: ProjectTool): ToolActionInfo[] => (tool.lastTest?.tools ?? []).map(name => ({ name, about: "", input: null, readOnly: false }));

/** Let a teammate use one of the project's tools. Its actions start at their defaults: reading is free, everything else asks first. */
export async function grantTool(store: Store, mate: TeammateRow, tool: string, by: string, now: Date, io: ToolIo = {}): Promise<Done> {
  const found = projectToolsOf(store, mate.repo).find(one => one.name === tool);
  if (found === undefined) return { ok: false, said: `This project has no tool called ${tool}. Add it on the Tools page first.` };
  if (store.teammateGrant(mate.id, tool) !== null) return { ok: true, said: `It can already use ${tool}.` };
  const listed = await listed_(found, mate.repo, io);
  return grantListed(store, mate, found, listed.ok ? listed.actions : null, by, now);
}

/** A grant from what the tool offers (or, not reachable now, the names its last test found). */
export function grantListed(store: Store, mate: TeammateRow, tool: ProjectTool, actions: ToolActionInfo[] | null, by: string, now: Date): Done {
  const offered = actions ?? namesOnly(tool);
  if (offered.length === 0) return { ok: false, said: `${tool.name} didn't say what it can do. Test it on the Tools page, then try again.` };
  store.saveTeammateGrant({ teammate: mate.id, tool: tool.name, ...withActions({}, offered), listedAt: actions === null ? null : now.toISOString() }, by, now);
  const free = offered.filter(one => defaultRule(one).use === "free").length;
  return { ok: true, said: `It can use ${tool.name} now: ${free} of its ${offered.length} action${offered.length === 1 ? "" : "s"} freely (the ones that only read), and the rest after a person approves each call. Change that under Tools.` };
}

export function revokeTool(store: Store, mate: TeammateRow, tool: string): Done {
  for (const call of store.teammateCallsOf(mate.id, 200).filter(one => one.tool === tool && one.state === "asked")) {
    store.moveTeammateCall(call.id, ["asked"], { state: "refused", result: `It can't use ${tool} any more.` }, new Date());
    const question = store.teammateQuestionForCall(call.id);
    if (question !== null) store.dropTeammateQuestion(question.id, new Date());
  }
  return store.dropTeammateGrant(mate.id, tool) ? { ok: true, said: `It can't use ${tool} any more.` } : { ok: true, said: `It wasn't using ${tool}.` };
}

/** Check one rule: an action the tool offers, a known use, and a limit on one of its number fields. */
export function checkRule(grant: Pick<TeammateGrantRow, "tool" | "actions">, action: string, rule: { use: unknown; limit?: { field: unknown; over: unknown } | null }): { ok: true; rule: ToolRule } | { ok: false; said: string } {
  const info = grant.actions.find(one => one.name === action);
  if (info === undefined) return { ok: false, said: `${grant.tool} has no action called ${action}. Its actions: ${grant.actions.map(one => one.name).join(", ")}.` };
  if (rule.use !== "free" && rule.use !== "ask" && rule.use !== "never") return { ok: false, said: "Choose do it, ask first or never." };
  if (rule.use !== "free" || rule.limit === undefined || rule.limit === null) return { ok: true, rule: { use: rule.use } };
  const field = String(rule.limit.field ?? "");
  const over = numberOf(rule.limit.over);
  if (field === "") return { ok: false, said: `Choose which number of ${action} the limit is on.` };
  if (info.input !== null && !numberFields(info).includes(field)) return { ok: false, said: `${action} has no number called ${field}.` };
  if (over === null || over < 0 || over > 1e12) return { ok: false, said: "A limit is a number, 0 or more." };
  return { ok: true, rule: { use: "free", limit: { field, over } } };
}

/** Set the rules for some of a granted tool's actions; the others keep theirs. */
export function setToolRules(store: Store, mate: TeammateRow, tool: string, changes: Record<string, { use: unknown; limit?: { field: unknown; over: unknown } | null }>, by: string, now: Date): Done {
  const grant = store.teammateGrant(mate.id, tool);
  if (grant === null) return { ok: false, said: `It doesn't use ${tool}. Let it use ${tool} first.` };
  const rules = { ...grant.rules };
  for (const [action, change] of Object.entries(changes)) {
    const checked = checkRule(grant, action, change);
    if (!checked.ok) return { ok: false, said: checked.said };
    rules[action] = checked.rule;
  }
  store.saveTeammateGrant({ teammate: mate.id, tool, actions: grant.actions, rules }, by, now);
  return { ok: true, said: "Saved. Its next turn uses these rules." };
}

const blank = (text: string) => redactSecretLines(text, scanForSecrets(text));

/**
 * Make one call now: a free one, or one a person approved (exactly as they
 * saw it). What the tool said is kept on the receipt, secrets scrubbed; a
 * tool that says it failed is an answer the teammate reads, not trouble.
 */
export async function makeCall(store: Store, call: TeammateCallRow, repo: string, io: ToolIo, now: Date): Promise<TeammateCallRow> {
  // Its rules are read again at the moment of the call: a tool taken away, or an action set to never, since it was approved stops it.
  const grant = store.teammateGrant(call.teammate, call.tool);
  if (grant === null || ruleFor(grant, call.action, call.input).use === "never") {
    store.moveTeammateCall(call.id, ["approved", "running"], { state: "refused", result: "Its rules changed before the call was made." }, now);
    return store.teammateCall(call.id)!;
  }
  if (call.state !== "running" && !store.moveTeammateCall(call.id, ["approved"], { state: "running" }, now)) return store.teammateCall(call.id)!;
  const tool = projectToolsOf(store, repo).find(one => one.name === call.tool);
  if (tool === undefined) {
    store.moveTeammateCall(call.id, ["running"], { state: "failed", result: `There's no tool called ${call.tool} in this project any more.` }, now);
    return store.teammateCall(call.id)!;
  }
  const values = readToolSecrets(repo, tool.name, io.toolHome);
  let answer;
  try {
    answer = await (io.callTool ?? ((spec, secrets, name, given) => callProjectTool(spec, secrets, name, given, { timeoutMs: 120_000, omitEnv: ALL_CREDENTIAL_ENV })))(tool.spec, values, call.action, call.input);
  } catch (error) {
    answer = { ok: false as const, problem: error instanceof Error ? error.message : "It couldn't be reached." };
  }
  const text = answer.ok ? blank(scrubSecrets(answer.text, values)).trim() : answer.problem;
  const kept = text.length <= RESULT_CHARS ? text : `${text.slice(0, RESULT_CHARS - 1)}…`;
  store.moveTeammateCall(call.id, ["running"], { state: answer.ok && !answer.isError ? "done" : "failed", result: kept || (answer.ok ? "(no answer)" : "It couldn't be reached.") }, now);
  return store.teammateCall(call.id)!;
}

/** A receipt in words: what happened to the call. */
export function callOutcome(call: TeammateCallRow): string {
  switch (call.state) {
    case "asked": return "waiting for approval";
    case "approved": return `${call.decidedBy} approved it; making it`;
    case "running": return "making it";
    case "done": return call.decidedBy === null ? "done" : `${call.decidedBy} approved it; done`;
    case "failed": return call.decidedBy === null ? "failed" : `${call.decidedBy} approved it; it failed`;
    case "denied": return `${call.decidedBy ?? "A person"} denied it`;
    default: return "not made";
  }
}

/** A receipt as a person reads it on the card: what happened, and who decided. */
export function receiptWords(store: Store, call: TeammateCallRow): string {
  switch (call.state) {
    case "asked": { const question = store.teammateQuestionForCall(call.id); return `Waiting for ${question?.askedOf ?? "a person"} to approve`; }
    case "approved": case "running": return call.decidedBy === null ? "Making it now" : `${call.decidedBy} approved · making it now`;
    case "done": return call.decidedBy === null ? "Done" : `${call.decidedBy} approved · done`;
    case "failed": return call.decidedBy === null ? "Failed" : `${call.decidedBy} approved · failed`;
    case "denied": { const said = store.teammateQuestionForCall(call.id)?.answer; return `${call.decidedBy ?? "A person"} said no${said ? `: ${said}` : ""}`; }
    default: return `Not made: ${call.result ?? "outside its rules"}`;
  }
}

/** The Tools section's form, read into rule changes: every action the grant knows. */
export function rulesFromForm(grant: Pick<TeammateGrantRow, "actions">, field: (key: string) => string | null): Record<string, { use: unknown; limit?: { field: unknown; over: unknown } }> {
  return Object.fromEntries(grant.actions.flatMap(action => {
    const use = field(`use.${action.name}`);
    if (use === null) return [];
    return [[action.name, use === "limit" ? { use: "free", limit: { field: field(`field.${action.name}`) ?? "", over: field(`over.${action.name}`) ?? "" } } : { use }]];
  }));
}
