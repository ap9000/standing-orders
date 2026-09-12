/** Reusable work definitions. Recipes carry scope, never credentials or grants.
 * A preview freezes the exact copy to file; its durable receipt makes a retry
 * after a lost response return the same task/routine, even after a restart. */
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "./store.js";
import { TEMPLATES } from "./templates.js";
import { hasDisguisedText, hasForbiddenControls } from "./decision.js";
import { parseAcceptanceCriteria, type AcceptanceCriterion } from "./scope.js";
import { validateTaskText, fileTaskProposal, fileRoutineProposal } from "./proposal.js";
import { parseSchedule, firstFireAt, describeSchedule, validateRoutineTerms } from "./routine.js";
import { applyModeToNewFiling } from "./plan-auto.js";
import { canonicalProject } from "./project.js";
import { resolve } from "node:path";

export const RECIPE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_recipe (
  id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  repo TEXT NOT NULL, document TEXT NOT NULL, digest TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(id, revision)
);
CREATE INDEX IF NOT EXISTS workflow_recipe_project ON workflow_recipe(repo, id, revision DESC);
CREATE TRIGGER IF NOT EXISTS workflow_recipe_no_update BEFORE UPDATE ON workflow_recipe
BEGIN SELECT RAISE(ABORT, 'recipe revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS workflow_recipe_no_delete BEFORE DELETE ON workflow_recipe
BEGIN SELECT RAISE(ABORT, 'recipe revisions are immutable'); END;
CREATE TABLE IF NOT EXISTS workflow_preview (
  token TEXT PRIMARY KEY, actor TEXT NOT NULL, repo TEXT NOT NULL,
  document TEXT NOT NULL, digest TEXT NOT NULL, source TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  task_id TEXT REFERENCES task(id), routine_id INTEGER REFERENCES routine(id),
  saved_id TEXT, saved_revision INTEGER,
  CHECK(task_id IS NULL OR routine_id IS NULL),
  FOREIGN KEY(saved_id, saved_revision) REFERENCES workflow_recipe(id, revision)
);
CREATE INDEX IF NOT EXISTS workflow_preview_project ON workflow_preview(repo, created_at DESC);
`;

export type RecipeDocument = {
  format: "standing-orders-recipe";
  version: 1;
  name: string;
  description: string;
  goal: string;
  outOfScope: string | null;
  touches: string[];
  acceptance: AcceptanceCriterion[];
  planning: "auto" | "required" | "skip";
  deliverable: "branch" | "report";
  schedule: string | null;
  costCeilingUsd: number | null;
};
export type Recipe = { id: string; revision: number; repo: string | null; document: RecipeDocument; digest: string; author: string };
export type WorkflowPreview = { token: string; actor: string; repo: string; document: RecipeDocument; digest: string; source: string; expiresAt: string; taskId: string | null; routineId: number | null; savedId: string | null; savedRevision: number | null };
export class RecipeError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
const keys = ["format", "version", "name", "description", "goal", "outOfScope", "touches", "acceptance", "planning", "deliverable", "schedule", "costCeilingUsd"];
const honest = (text: string) => !hasForbiddenControls(text) && !hasDisguisedText(text);
const recipeProject = (repo: string) => canonicalProject(repo) ?? resolve(repo);

/** Reject unknown fields, including approval/provider settings, on import. */
export function parseRecipe(input: unknown): RecipeDocument {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new RecipeError("Choose a recipe document.");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 32_768) throw new RecipeError("A recipe must be at most 32 KB.");
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(raw, key))) throw new RecipeError("Recipe fields do not match version 1. Recipes contain work definitions, not permissions, credentials, or agent settings.");
  if (raw.format !== "standing-orders-recipe" || raw.version !== 1) throw new RecipeError("This recipe format/version is not supported.");
  if (typeof raw.name !== "string" || typeof raw.description !== "string" || typeof raw.goal !== "string" || (raw.outOfScope !== null && typeof raw.outOfScope !== "string") || !Array.isArray(raw.touches) || raw.touches.some(path => typeof path !== "string")) throw new RecipeError("Name, goal, exclusions, and allowed paths must be readable text.");
  if (raw.description.length > 400 || !honest(raw.description)) throw new RecipeError("Keep the description within 400 characters, without hidden text.");
  const bad = validateTaskText({ title: raw.name, goal: raw.goal, outOfScope: raw.outOfScope, touches: raw.touches as string[] });
  if (bad !== null) throw new RecipeError(bad.message);
  if (!["auto", "required", "skip"].includes(String(raw.planning)) || !["branch", "report"].includes(String(raw.deliverable))) throw new RecipeError("Choose a supported planning and result type.");
  if (raw.schedule !== null && (typeof raw.schedule !== "string" || parseSchedule(raw.schedule) === null)) throw new RecipeError("Choose a valid schedule.");
  if (raw.costCeilingUsd !== null && (typeof raw.costCeilingUsd !== "number" || !Number.isFinite(raw.costCeilingUsd) || raw.costCeilingUsd <= 0)) throw new RecipeError("The weekly budget must be a positive dollar amount.");
  if (raw.schedule === null && raw.costCeilingUsd !== null) throw new RecipeError("A weekly budget applies to a repeating workflow. One-time work uses the project's task budget.");
  if (raw.deliverable === "report" && raw.schedule !== null) throw new RecipeError("Report recipes run once. Repeating workflows currently produce code changes.");
  if (raw.schedule !== null && raw.planning === "required") throw new RecipeError("Plan-first recipes run once. Repeating workflows reuse their approved scope; choose direct execution or run once.");
  if (!Array.isArray(raw.acceptance) || raw.acceptance.some(one => typeof one !== "object" || one === null || Object.keys(one).some(key => !["id", "statement", "how", "evidence"].includes(key)))) throw new RecipeError("Success checks have unsupported fields.");
  const parsed = parseAcceptanceCriteria(raw.acceptance);
  if (parsed.problems.length > 0 || parsed.criteria.length === 0) throw new RecipeError(parsed.problems.map(one => one.message).join("; ") || "Add at least one success check.");
  const document: RecipeDocument = { format: "standing-orders-recipe", version: 1, name: raw.name.trim(), description: raw.description.trim(), goal: raw.goal.trim(), outOfScope: raw.outOfScope?.trim() || null,
    touches: [...raw.touches as string[]], acceptance: parsed.criteria, planning: raw.planning as RecipeDocument["planning"], deliverable: raw.deliverable as RecipeDocument["deliverable"], schedule: raw.schedule as string | null, costCeilingUsd: raw.costCeilingUsd as number | null };
  if (document.schedule !== null) {
    const problems = validateRoutineTerms({ repo: "/recipe-preview", ...document, requirements: [], schedule: document.schedule, singleFlight: true });
    if (problems.length) throw new RecipeError(problems.map(one => `${one.field}: ${one.problem}`).join("; "));
  }
  return document;
}
export function importRecipe(text: string): RecipeDocument {
  if (Buffer.byteLength(text, "utf8") > 32_768) throw new RecipeError("A recipe must be at most 32 KB.");
  let value: unknown; try { value = JSON.parse(text); } catch { throw new RecipeError("That is not valid recipe JSON."); }
  return parseRecipe(value);
}
export const recipeDigest = (document: RecipeDocument): string => createHash("sha256").update(JSON.stringify(document)).digest("hex");
export const exportRecipe = (document: RecipeDocument): string => JSON.stringify(parseRecipe(document), null, 2) + "\n";

const titles: Record<string, string> = { "nightly-deps": "Keep dependencies current", "test-coverage": "Test one overlooked module", "docs-drift": "Keep documentation accurate", "lint-sweep": "Clean up lint and types" };
export function starterRecipes(): Recipe[] {
  const recipes: Recipe[] = TEMPLATES.filter(one => one.kind !== "recipe").map(one => {
    const document = parseRecipe({ format: "standing-orders-recipe", version: 1, name: titles[one.name] ?? one.name, description: one.purpose, goal: one.goal, outOfScope: one.outOfScope, touches: one.touches, acceptance: one.acceptance,
      planning: "skip", deliverable: "branch", schedule: one.kind === "routine" ? one.schedule : null, costCeilingUsd: null });
    return { id: one.name, revision: 1, repo: null, document, digest: recipeDigest(document), author: "Standing Orders" };
  });
  for (const [id, document] of [
    ["small-feature", { name: "Ship a small feature", description: "Turn one clear outcome into a plan, a reviewed change, and evidence.", goal: "Implement one small feature. Describe the desired behavior here, including who uses it and what success looks like.", outOfScope: "No unrelated refactoring, dependency upgrades, deployment, or changes to existing public behavior.", planning: "required", deliverable: "branch", acceptance: [{ id: "c1", statement: "The requested behavior works and relevant regression tests pass.", how: null, evidence: ["check", "changed-path"] }] }],
    ["project-tour", { name: "Understand this project", description: "A useful first run: get a source-backed report before changing anything.", goal: "Map the project's entry points, major components, build and test commands, and one bounded improvement worth doing next. Cite the source paths behind each claim and distinguish confirmed facts from unknowns.", outOfScope: "No code or configuration changes, dependency installation, or publication.", planning: "skip", deliverable: "report", acceptance: [{ id: "c1", statement: "The report explains the entry points, components, build/test commands, and next improvement with source references and explicit unknowns.", how: null, evidence: ["manual-review"] }] }],
  ] as const) {
    const parsed = parseRecipe({ format: "standing-orders-recipe", version: 1, ...document, touches: [], schedule: null, costCeilingUsd: null });
    recipes.unshift({ id, revision: 1, repo: null, document: parsed, digest: recipeDigest(parsed), author: "Standing Orders" });
  }
  return recipes;
}

function access(store: Store, actor: string, repo: string, write = false): void {
  if (!store.accountCanAccess(actor, repo) || (write && store.accountOf(actor)?.role !== "approver")) throw new RecipeError("This project is outside your current access.", 403);
}
function readRecipe(row: Record<string, unknown>): Recipe {
  const document = importRecipe(String(row.document));
  if (recipeDigest(document) !== row.digest) throw new RecipeError("The saved recipe does not match its recorded version.", 409);
  return { id: String(row.id), revision: Number(row.revision), repo: String(row.repo), document, digest: String(row.digest), author: String(row.author) };
}
export function savedRecipes(store: Store, actor: string, repo: string): Recipe[] {
  repo = recipeProject(repo);
  access(store, actor, repo);
  return store.handle.prepare(`SELECT r.* FROM workflow_recipe r WHERE repo=? AND revision=(SELECT MAX(revision) FROM workflow_recipe WHERE id=r.id) ORDER BY created_at DESC, id LIMIT 100`).all(repo).map(readRecipe);
}
export function findRecipe(store: Store, actor: string, repo: string | null, id: string, revision?: number): Recipe | null {
  const starter = starterRecipes().find(one => one.id === id);
  if (starter !== undefined) return revision === undefined || revision === starter.revision ? starter : null;
  if (repo === null) return null;
  repo = recipeProject(repo);
  access(store, actor, repo);
  const row = revision === undefined ? store.handle.prepare("SELECT * FROM workflow_recipe WHERE repo=? AND id=? ORDER BY revision DESC LIMIT 1").get(repo, id)
    : store.handle.prepare("SELECT * FROM workflow_recipe WHERE repo=? AND id=? AND revision=?").get(repo, id, revision);
  return row === undefined ? null : readRecipe(row);
}
export function createWorkflowPreview(store: Store, actor: string, repo: string, document: RecipeDocument, source: string, now: Date): WorkflowPreview {
  repo = recipeProject(repo);
  const parsed = parseRecipe(document);
  if (!/^[a-z0-9-]{1,48}$/.test(source)) throw new RecipeError("Unknown recipe source.");
  return store.transact(() => {
    access(store, actor, repo, true);
    store.handle.prepare("DELETE FROM workflow_preview WHERE actor=? AND expires_at<? AND task_id IS NULL AND routine_id IS NULL AND saved_id IS NULL").run(actor, now.toISOString());
    const count = store.handle.prepare("SELECT COUNT(*) n FROM workflow_preview WHERE actor=? AND expires_at>? AND task_id IS NULL AND routine_id IS NULL AND saved_id IS NULL").get(actor, now.toISOString());
    if (Number(count?.n) >= 30) throw new RecipeError("You have 30 open previews. Use one or let it expire before making another.", 429);
    const token = randomBytes(16).toString("hex");
    store.handle.prepare("INSERT INTO workflow_preview(token,actor,repo,document,digest,source,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(token, actor, repo, JSON.stringify(parsed), recipeDigest(parsed), source, now.toISOString(), new Date(now.getTime() + 30 * 60_000).toISOString());
    return workflowPreview(store, actor, repo, token)!;
  });
}
export function workflowPreview(store: Store, actor: string, repo: string, token: string): WorkflowPreview | null {
  repo = recipeProject(repo);
  access(store, actor, repo);
  const row = store.handle.prepare("SELECT * FROM workflow_preview WHERE token=? AND actor=? AND repo=?").get(token, actor, repo);
  if (row === undefined) return null;
  const document = importRecipe(String(row.document));
  if (recipeDigest(document) !== row.digest) throw new RecipeError("This preview has changed. Make a fresh preview.", 409);
  return { token, actor, repo, document, digest: String(row.digest), source: String(row.source), expiresAt: String(row.expires_at), taskId: row.task_id as string | null, routineId: row.routine_id as number | null, savedId: row.saved_id as string | null, savedRevision: row.saved_revision as number | null };
}
function currentPreview(store: Store, actor: string, repo: string, token: string): WorkflowPreview {
  access(store, actor, repo, true);
  const preview = workflowPreview(store, actor, repo, token);
  if (preview === null) throw new RecipeError("No preview in this project. Preview the workflow again.", 404);
  return preview;
}
export function launchWorkflow(store: Store, actor: string, repo: string, token: string, now: Date, operatorFiling: boolean): { taskId: string | null; routineId: number | null } {
  repo = recipeProject(repo);
  return store.transact(() => {
    const preview = currentPreview(store, actor, repo, token);
    if (preview.taskId !== null || preview.routineId !== null) return { taskId: preview.taskId, routineId: preview.routineId };
    if (preview.expiresAt <= now.toISOString()) throw new RecipeError("This preview expired. Preview it again before creating work.", 409);
    const d = preview.document;
    const provenance = `recipe:${preview.savedId ?? preview.source}`;
    let taskId: string | null = null, routineId: number | null = null;
    if (d.schedule === null) {
      const made = fileTaskProposal(store, { id: `workflow-${token}`, title: d.name, repo, goal: d.goal, outOfScope: d.outOfScope, touches: d.touches, acceptance: d.acceptance, planning: d.planning, deliverable: d.deliverable, filedVia: provenance, admittedRepos: [repo] }, now);
      if (!made.ok) throw new RecipeError(made.message, made.reason === "backlog-full" ? 429 : 400);
      taskId = made.id;
      if (operatorFiling) applyModeToNewFiling(store, taskId, actor, now);
    } else {
      const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workflow";
      const made = fileRoutineProposal(store, { name: `${slug}-${token.slice(0, 8)}`, repo, goal: d.goal, outOfScope: d.outOfScope, touches: d.touches, acceptance: d.acceptance, requirements: [], schedule: d.schedule, costCeilingUsd: d.costCeilingUsd, filedVia: provenance, admittedRepos: [repo] }, now);
      if (!made.ok) throw new RecipeError(made.message);
      routineId = made.id;
    }
    store.handle.prepare("UPDATE workflow_preview SET task_id=?,routine_id=? WHERE token=?").run(taskId, routineId, token);
    store.recordAction({ at: now.toISOString(), actor, repo, taskId, runId: null, action: "workflow created", outcome: routineId === null ? "task" : "routine", source: "work" });
    return { taskId, routineId };
  });
}
export function saveWorkflowRecipe(store: Store, actor: string, repo: string, token: string, now: Date): Recipe {
  repo = recipeProject(repo);
  return store.transact(() => {
    const preview = currentPreview(store, actor, repo, token);
    if (preview.savedId !== null) return findRecipe(store, actor, repo, preview.savedId, preview.savedRevision!)!;
    if (preview.expiresAt <= now.toISOString()) throw new RecipeError("This preview expired. Preview it again before saving.", 409);
    const id = randomBytes(12).toString("hex");
    store.handle.prepare("INSERT INTO workflow_recipe(id,revision,repo,document,digest,author,created_at) VALUES (?,1,?,?,?,?,?)").run(id, repo, JSON.stringify(preview.document), preview.digest, actor, now.toISOString());
    store.handle.prepare("UPDATE workflow_preview SET saved_id=?,saved_revision=1 WHERE token=?").run(id, token);
    store.recordAction({ at: now.toISOString(), actor, repo, taskId: null, runId: null, action: "recipe saved", outcome: "saved", source: "work" });
    return findRecipe(store, actor, repo, id, 1)!;
  });
}
export function workflowSteps(document: RecipeDocument): { title: string; detail: string }[] {
  return [
    { title: "Authorize", detail: document.schedule === null ? "Your project policy applies. Without a matching policy, review and approve the scope first." : "Approve the repeating scope and exact agents once. New recipes start inactive." },
    ...(document.deliverable === "report" ? [{ title: "Investigate", detail: "Inspect the project and return a source-backed report." }] : [
      ...(document.schedule === null && document.planning !== "skip" ? [{ title: "Plan", detail: document.planning === "required" ? "Inspect the repository and plan before building." : "Plan first when the scope calls for repository discovery." }] : []),
      { title: "Build", detail: "Work in an isolated branch within the agreed scope." },
      { title: "Verify", detail: "Check each success criterion and retain its evidence." },
    ]),
    { title: "Review result", detail: "See the report or change, evidence, and unresolved questions. Agent review follows your project policy; publishing requires separate authority." },
  ];
}
export function recipeScheduleWords(document: RecipeDocument, now: Date): string {
  if (document.schedule === null) return "Once, after its approval and readiness gates pass";
  const schedule = parseSchedule(document.schedule)!;
  return `${describeSchedule(schedule)}. If approved now, first due ${firstFireAt(schedule, now)}. Missed slots run once; unfinished work prevents overlap.`;
}
