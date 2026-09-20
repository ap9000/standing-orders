/** Assignment reads and delivery acknowledgments. These adapters never start
 * work, answer a decision, accept proof, or change an approval. */
import { readFileSync, statSync } from "node:fs";
import { authenticateCoordinator } from "./coordinator.js";
import { assignmentOf, assignmentUpdates, claimAssignment, checkAssignment, type AssignmentAccess, type AssignmentSnapshot } from "./assignment.js";
import { envelopeJson } from "./envelope.js";
import type { Store } from "./store.js";

export const ASSIGNMENT_ACTIONS = ["show", "updates", "claim", "check"] as const;
export type AssignmentOperation = typeof ASSIGNMENT_ACTIONS[number];
type Args = Record<string, unknown>;
type Failure = { ok: false; reason: string; message: string };
const failure = (reason: string, message: string): Failure => ({ ok: false, reason, message });
const reference = { type: "string", minLength: 1, maxLength: 64 };
const digest = { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export const ASSIGNMENT_TOOLS = [
  { name: "get_assignment", operation: "show", description: "Read one assignment's root, current execution, owner, exact result and handoff receipt. Approval, proof and deployment remain separate facts.", inputSchema: object({ ref: reference }, ["ref"]) },
  { name: "list_assignment_updates", operation: "updates", description: "Read durable assignment updates in your projects after a cursor. Save nextCursor after processing; repeated reads do not acknowledge or deliver anything.", inputSchema: object({ after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: "integer", minimum: 1, maximum: 100 } }) },
  { name: "claim_assignment", operation: "claim", description: "Record yourself as this assignment's lead. Repeating your claim is safe; another active owner cannot be replaced. This grants no approval or execution authority.", inputSchema: object({ ref: reference }, ["ref"]) },
  { name: "acknowledge_assignment", operation: "check", description: "Acknowledge the exact ready-to-check receipt as its lead, using the current receipt digest. This does not accept failed proof, answer decisions, approve work, publish or deploy.", inputSchema: object({ ref: reference, digest }, ["ref", "digest"]) },
] as const;

/** The CLI and MCP use the same bounded input contract. MCP also validates its
 * descriptor before dispatch; this check protects direct adapter callers. */
export function assignmentArgumentProblem(operation: AssignmentOperation, args: Args): string | null {
  if (!ASSIGNMENT_ACTIONS.includes(operation)) return "Choose show, updates, claim, or check.";
  const allowed = operation === "updates" ? ["after", "limit"] : operation === "check" ? ["ref", "digest"] : ["ref"];
  for (const key of Object.keys(args)) if (!allowed.includes(key)) return `Unknown argument: ${key}.`;
  if (operation !== "updates" && (typeof args["ref"] !== "string" || args["ref"].length < 1 || args["ref"].length > 64 || /[\u0000-\u001f\u007f]/.test(args["ref"]))) return "Choose a task id, 1–64 characters without control characters.";
  if (operation === "check" && (typeof args["digest"] !== "string" || !/^[a-f0-9]{64}$/.test(args["digest"]))) return "Use the exact 64-character receipt digest from assignment show.";
  for (const [name, min, max] of [["after", 0, Number.MAX_SAFE_INTEGER], ["limit", 1, 100]] as const) {
    const value = args[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)) return `${name} must be an integer from ${min} to ${max}.`;
  }
  return null;
}

function readAssignment(store: Store, operation: "show" | "updates", args: Args, now: Date, access: AssignmentAccess, root?: string) {
  if (operation === "updates") return { ok: true as const, body: assignmentUpdates(store, now, access, { after: Number(args["after"] ?? 0), limit: Number(args["limit"] ?? 50) }, root) };
  const assignment = assignmentOf(store, String(args["ref"]), now, access, root);
  return assignment === null ? failure("not-found", "No assignment with that task id is available in your projects.") : { ok: true as const, body: assignment };
}

/** Every read and mutation authenticates inside the same transaction as its
 * projection. A cached name/allowlist cannot keep a revoked identity alive. */
export function assignmentForCoordinator(store: Store, token: string, operation: AssignmentOperation, args: Args, now: Date, evidenceRoot?: string) {
  const problem = assignmentArgumentProblem(operation, args);
  if (problem !== null) return failure("usage", problem);
  return store.transact(() => {
    const authenticated = authenticateCoordinator(store, token);
    if (!authenticated.ok) return failure("unauthenticated", "The coordinator credential is unavailable or revoked.");
    const { who } = authenticated;
    if (operation === "show" || operation === "updates") return readAssignment(store, operation, args, now, { principal: "coordinator", repos: who.repos }, evidenceRoot);
    const owner = { kind: "coordinator" as const, id: who.cid, label: who.name };
    const result = operation === "claim"
      ? claimAssignment(store, String(args["ref"]), owner, now, evidenceRoot)
      : checkAssignment(store, String(args["ref"]), String(args["digest"]), owner, now, evidenceRoot);
    return result.ok ? { ok: true as const, body: result.assignment } : result;
  });
}

export type AssignmentCliContext = {
  store: Store;
  write: (line: string) => void;
  json: boolean;
  now: Date;
  evidenceRoot?: string;
  env?: NodeJS.ProcessEnv;
};

function assignmentLines(assignment: AssignmentSnapshot): string[] {
  const receipt = assignment.receipt;
  return [
    `${assignment.rootId} · ${assignment.state}`,
    assignment.detail,
    `Current task: ${assignment.activeTaskId}`,
    `Lead: ${assignment.owner === null ? "unclaimed" : `${assignment.owner.label}${assignment.owner.active ? "" : " (no longer has access)"}`}`,
    ...(receipt === null ? [] : [
      `Result: ${receipt.taskId} · run ${receipt.runId}`,
      `Result type: ${receipt.completionKind === "verified-build" ? "verified build" : receipt.completionKind === "research-report" ? "research report" : receipt.completionKind === "accepted-exception" ? "accepted exception" : "verification pending"}`,
      ...(receipt.proofAcceptance === null ? [] : [`Recorded acceptance: ${receipt.proofAcceptance.approver}${receipt.proofAcceptance.note === null ? "" : ` · ${receipt.proofAcceptance.note}`}`]),
      `Candidate: ${receipt.head ?? "not recorded"} (base ${receipt.base ?? "not recorded"})`,
      `Proof: ${receipt.proof?.verdict ?? "not recorded"} · evidence ${receipt.evidence}`,
      ...(receipt.proof === null ? [] : [`Criteria: ${receipt.proof.matrix.filter(row => row.state === "pass").length}/${receipt.proof.matrix.length} recorded as passed`]),
      ...receipt.caveats.map(one => `Recorded limitation: ${one}`),
      ...(receipt.agentReport === null ? [] : [`Agent report: ${receipt.agentReport}`]),
      `Receipt: ${receipt.digest}`,
    ]),
    ...assignment.attention.filter(one => one !== assignment.detail).map(one => `Attention: ${one}`),
    ...(assignment.primaryAction === null ? [] : [`Next: ${assignment.primaryAction.label} (${assignment.primaryAction.access})`]),
    `Publication: ${assignment.publication === null ? "not recorded" : assignment.publication.state}${assignment.publication?.prUrl ? ` · ${assignment.publication.prUrl}` : ""}`,
    "Deployment: not recorded",
  ];
}

function resultLines(body: AssignmentSnapshot | ReturnType<typeof assignmentUpdates>): string[] {
  if ("rootId" in body) return assignmentLines(body);
  return [
    ...(body.events.length === 0 ? ["No new assignment updates."] : body.events.flatMap(event => [
      `Update ${event.id}${event.superseded ? " (superseded; inspect the current assignment)" : ""}`,
      `${event.assignment.rootId} · ${event.assignment.state}`,
      event.assignment.detail,
      `Current task: ${event.assignment.activeTaskId}`,
      `Read: assignment show ${event.assignment.rootId}`,
    ])),
    `Next cursor: ${body.nextCursor}${body.hasMore ? " · more updates available" : ""}`,
  ];
}

/** Explicit secret source only. Never print secret values or discover default
 * files. A bad explicit credential must not fall back to a local read. */
function coordinatorToken(flags: Map<string, string | true>, env: NodeJS.ProcessEnv): { token: string | null } | Failure {
  const envName = flags.get("token-env"), path = flags.get("token-file");
  if (envName !== undefined && path !== undefined) return failure("usage", "Choose either --token-env NAME or --token-file PATH.");
  if (envName === undefined && path === undefined) return { token: null };
  let raw: string | undefined;
  if (typeof envName === "string") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) return failure("usage", "--token-env names an environment variable.");
    raw = env[envName];
  } else if (typeof path === "string") {
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size > 16_384) return failure("usage", "The explicit token file must be a regular file no larger than 16 KiB.");
      raw = readFileSync(path, "utf8");
    } catch { return failure("unauthenticated", "The explicit token file could not be read."); }
  }
  const token = raw?.trim();
  if (!token || token.length > 4096 || /\s/.test(token)) return failure("unauthenticated", "The explicit credential source must contain one coordinator token.");
  return { token };
}

export function runAssignmentCommand(positional: readonly string[], flags: Map<string, string | true>, context: AssignmentCliContext): number {
  const operation = positional[0] as AssignmentOperation;
  const command = ASSIGNMENT_ACTIONS.includes(operation) ? `assignment ${operation}` : "assignment";
  const emit = (result: { ok: true; body: AssignmentSnapshot | ReturnType<typeof assignmentUpdates> } | Failure): number => {
    if (context.json) context.write(envelopeJson(result.ok ? { ok: true, command, result: result.body } : { ...result, command }));
    else if (!result.ok) context.write(result.message);
    else context.write(resultLines(result.body).join("\n"));
    return result.ok ? 0 : result.reason === "usage" ? 2 : 3;
  };
  if (!ASSIGNMENT_ACTIONS.includes(operation)) return emit(failure("usage", "Use assignment show <task>, updates, claim <task>, or check <task> --digest <receipt>."));
  const allowed = new Set(["json", "db", "token-env", "token-file", ...(operation === "updates" ? ["after", "limit"] : operation === "check" ? ["digest"] : [])]);
  for (const flag of flags.keys()) if (!allowed.has(flag)) return emit(failure("usage", `--${flag} is not an assignment ${operation} option.`));
  if (positional.length !== (operation === "updates" ? 1 : 2)) return emit(failure("usage", operation === "updates" ? "assignment updates takes no task argument; use --after and --limit." : `assignment ${operation} takes exactly one task id.`));
  const args: Args = operation === "updates" ? {} : { ref: positional[1] };
  for (const flag of ["after", "limit", "digest"]) {
    const value = flags.get(flag);
    if (value !== undefined) args[flag] = flag === "digest" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  }
  const problem = assignmentArgumentProblem(operation, args);
  if (problem !== null) return emit(failure("usage", problem));
  const credential = coordinatorToken(flags, context.env ?? process.env);
  if ("ok" in credential) return emit(credential);
  if (credential.token !== null) return emit(assignmentForCoordinator(context.store, credential.token, operation, args, context.now, context.evidenceRoot));
  if (operation === "claim" || operation === "check") return emit(failure("unauthenticated", "Use --token-env NAME or --token-file PATH with your coordinator credential to claim or acknowledge an assignment."));
  return emit(readAssignment(context.store, operation, args, context.now, { principal: "operator", repos: null, includeUnplaced: true }, context.evidenceRoot));
}
