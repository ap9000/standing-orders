import { composerSchedule, scheduleEditorHtml, scheduleEditorScript } from "./task-composer.js";
import { parseRecipe, workflowSteps, recipeScheduleWords, type Recipe, type RecipeDocument, type WorkflowPreview, RecipeError } from "./recipes.js";
import { ACCEPTANCE_LIMITS, type AcceptanceCriterion } from "./scope.js";

const e = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const hidden = (name: string, value: string) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
const evidence = [["check", "Passing tests or commands"], ["changed-path", "Changed files"], ["screenshot", "Screenshot"], ["manual-review", "Reviewer assessment"]] as const;

export function recipeFromForm(body: URLSearchParams): RecipeDocument {
  for (const name of ["name", "description", "goal", "not", "touches", "planning", "deliverable", "cadence", "repeat", "time", "timezone", "weekday", "interval", "interval-unit", "ceiling", "source", "sourceRevision", "projectRevision", "repo", "preview"]) {
    if (body.getAll(name).length > 1) throw new RecipeError(`Choose one ${name} value.`);
  }
  if (!["once", "repeat"].includes(body.get("cadence") ?? "")) throw new RecipeError("Choose run once or repeat.");
  const schedule = body.get("cadence") === "once" ? { ok: true as const, schedule: null } : composerSchedule(body);
  if (!schedule.ok) throw new RecipeError(schedule.message);
  if (body.get("cadence") === "repeat" && schedule.schedule === null) throw new RecipeError("Choose a repeating schedule.");
  const acceptance: AcceptanceCriterion[] = [];
  for (let i = 0; i < ACCEPTANCE_LIMITS.criteria; i++) {
    for (const key of ["statement", "how", "id"]) if (body.getAll(`criterion-${i}-${key}`).length > 1) throw new RecipeError("A success check has duplicated fields.");
    const statement = (body.get(`criterion-${i}-statement`) ?? "").trim();
    const how = (body.get(`criterion-${i}-how`) ?? "").trim();
    if (!statement && !how) continue;
    acceptance.push({ id: body.get(`criterion-${i}-id`) || `c${i + 1}`, statement, how: how || null, evidence: body.getAll(`criterion-${i}-evidence`) as AcceptanceCriterion["evidence"] });
  }
  // Never silently omit submitted checks beyond the editor's bounded size.
  for (const key of body.keys()) if (/^criterion-/.test(key) && (!/^criterion-(?:[0-9]|1[01])-(?:statement|how|id|evidence)$/.test(key))) throw new RecipeError("A recipe supports at most 12 success checks.");
  const ceiling = (body.get("ceiling") ?? "").trim();
  return parseRecipe({ format: "standing-orders-recipe", version: 1, name: body.get("name") ?? "", description: body.get("description") ?? "", goal: body.get("goal") ?? "", outOfScope: body.get("not") || null,
    touches: (body.get("touches") ?? "").split(/[\n,]/).map(one => one.trim()).filter(Boolean), acceptance, planning: body.get("planning") ?? "auto", deliverable: body.get("deliverable") ?? "branch", schedule: schedule.schedule, costCeilingUsd: ceiling === "" ? null : Number(ceiling) });
}

export function recipeLibraryHtml(starters: Recipe[], saved: Recipe[], project: string | null, csrf: string, revision: number, recent: { name: string; href: string; state: string }[]): string {
  const cards = (recipes: Recipe[]) => `<div class="recipe-grid">${recipes.map(recipe => `<article class="recipe-card"><p class="recipe-kicker">${recipe.document.deliverable === "report" ? "Report" : recipe.document.schedule === null ? "One-time work" : "Recurring care"}</p><h3>${e(recipe.document.name)}</h3><p>${e(recipe.document.description)}</p><a class="recipe-card-link" href="/recipes/start?recipe=${e(recipe.id)}&revision=${recipe.revision}">Customize recipe <span aria-hidden="true">→</span></a></article>`).join("")}</div>`;
  return `<div class="recipe-heading"><p class="recipe-kicker">Workflows</p><h1>Good work, on repeat.</h1><p class="hint">Start with a proven recipe. Make it yours. See exactly what happens before it runs.</p><p><a href="/recipes/new" class="new-task">Create your own recipe</a> <a href="/routines">Manage scheduled work →</a></p></div>` +
    (project === null ? `<div class="card"><strong>Choose a project to get started.</strong><p>Browse recipes now; <a href="/projects">open a project</a> to customize, save, or run one.</p></div>` : "") +
    `<h2>Start here</h2>${cards(starters)}<h2>Your project’s recipes</h2>${saved.length >= 100 ? `<p class="meta">Showing the newest 100 saved recipes.</p>` : ""}${saved.length ? cards(saved) : `<p class="hint">Customize a starter and save it here. Teammates with project access can reuse it.</p>`}` +
    (recent.length ? `<h2>Recent workflows</h2><div class="card recipe-history">${recent.map(one => `<a href="${e(one.href)}"><strong>${e(one.name)}</strong><span>${e(one.state)} →</span></a>`).join("")}</div>` : "") +
    (project === null ? "" : `<details class="card"><summary>Import a shared recipe</summary><p class="hint">Paste exported recipe JSON. You’ll review it in this project before creating any work.</p><form method="post" action="/recipes/import">${hidden("csrf", csrf)}${hidden("repo", project)}${hidden("projectRevision", String(revision))}<label>Recipe JSON<textarea name="document" rows="7" required maxlength="32768" spellcheck="false"></textarea></label><button type="submit">Review imported recipe</button></form></details>`);
}

function criterionHtml(index: number, criterion?: AcceptanceCriterion, values?: URLSearchParams): string {
  const prefix = `criterion-${index}-`;
  const value = (name: string, fallback: string) => values?.get(prefix + name) ?? fallback;
  const selected = values ? values.getAll(prefix + "evidence") : criterion?.evidence ?? ["check"];
  return `<fieldset class="recipe-criterion"><legend>${criterion ? `Success check ${index + 1}` : "Additional success check (optional)"}</legend>${hidden(prefix + "id", value("id", criterion?.id ?? `c${index + 1}`))}<label>What should be true?<textarea name="${prefix}statement" rows="2" maxlength="300">${e(value("statement", criterion?.statement ?? ""))}</textarea></label><div class="recipe-evidence">${evidence.map(([id, label]) => `<label><input type="checkbox" name="${prefix}evidence" value="${id}"${selected.includes(id) ? " checked" : ""}>${label}</label>`).join("")}</div><label>How to check it <span class="meta">optional; command or review instructions</span><input type="text" name="${prefix}how" value="${e(value("how", criterion?.how ?? ""))}" maxlength="500"></label></fieldset>`;
}
export function recipeEditorHtml(recipe: Recipe, repo: string, csrf: string, revision: number, problem: string | null = null, values?: URLSearchParams): string {
  const d = recipe.document;
  const value = (name: string, fallback: string) => values?.get(name) ?? fallback;
  const cadence = value("cadence", d.schedule === null ? "once" : "repeat");
  const planning = value("planning", d.planning), deliverable = value("deliverable", d.deliverable);
  const count = values ? Math.min(ACCEPTANCE_LIMITS.criteria, Math.max(d.acceptance.length + 1, ...[...values.keys()].map(key => Number(/^criterion-(\d+)-statement$/.exec(key)?.[1] ?? -1) + 1))) : Math.min(ACCEPTANCE_LIMITS.criteria, d.acceptance.length + 1);
  return `<a href="/recipes" class="meta">← All recipes</a><div class="recipe-heading"><p class="recipe-kicker">1 · Choose → 2 · Customize → 3 · Preview</p><h1>Make this workflow yours</h1><p class="hint">${e(repo.split(/[\\/]/).pop() || repo)} · Choose the outcome, boundaries, and proof you want back.</p></div>` +
    (problem === null ? "" : `<p role="alert" class="card recipe-error">${e(problem)}</p>`) +
    `<form method="post" action="/recipes/preview" class="recipe-editor">${hidden("csrf", csrf)}${hidden("repo", repo)}${hidden("projectRevision", String(revision))}${hidden("source", recipe.id)}${hidden("sourceRevision", String(recipe.revision))}` +
    `<section class="card"><h2>The outcome</h2><label>Workflow name<input type="text" name="name" value="${e(value("name", d.name))}" maxlength="200" required></label><label>Short description<input type="text" name="description" value="${e(value("description", d.description))}" maxlength="400"></label><label>What should the agent do?<textarea name="goal" rows="5" maxlength="2000" required>${e(value("goal", d.goal))}</textarea></label><label>What should it leave alone?<textarea name="not" rows="3" maxlength="2000">${e(value("not", d.outOfScope ?? ""))}</textarea></label><label>Allowed files or folders <span class="meta">optional; one per line</span><textarea name="touches" rows="2" placeholder="src/&#10;tests/">${e(value("touches", d.touches.join("\n")))}</textarea></label><p class="meta">Blank allows work across this project. Add paths to keep the workflow focused.</p></section>` +
    `<section class="card"><h2>What does success look like?</h2><p class="hint">Give each outcome the evidence you want to see. The workflow checks these before calling the work done.</p><div data-recipe-criteria>${Array.from({ length: count }, (_, i) => criterionHtml(i, d.acceptance[i], values)).join("")}</div><button type="button" data-add-criterion hidden>Add another success check</button><template data-criterion-template>${criterionHtml(11).replaceAll("criterion-11-", "criterion-INDEX-").replaceAll('value="c12"', 'value="cNEXT"')}</template></section>` +
    `<section class="card"><h2>How it should run</h2><div class="recipe-options"><label>Result<select name="deliverable"><option value="branch"${deliverable === "branch" ? " selected" : ""}>Code change with evidence</option><option value="report"${deliverable === "report" ? " selected" : ""}>Report without code changes</option></select></label><label>Planning<select name="planning">${[["auto", "Plan when helpful"], ["required", "Always plan first"], ["skip", "Use this scope directly"]].map(([id, label]) => `<option value="${id}"${planning === id ? " selected" : ""}>${label}</option>`).join("")}</select></label></div><p class="meta">Report work investigates directly. Repeating work reuses its approved scope; plan-first workflows run once.</p><label>Frequency<select name="cadence" data-recipe-cadence><option value="once"${cadence === "once" ? " selected" : ""}>Run once</option><option value="repeat"${cadence === "repeat" ? " selected" : ""}>Repeat on a schedule</option></select></label><div data-recipe-recurring>${scheduleEditorHtml(d.schedule, values)}<label>Weekly spending limit <span class="meta">optional, USD</span><input type="number" name="ceiling" min="0.01" step="0.01" value="${e(value("ceiling", d.costCeilingUsd === null ? "" : String(d.costCeilingUsd)))}"></label><p class="meta">One instance at a time. A spending limit requires an agent that reports dollar costs; approval checks this.</p></div></section>` +
    `<div class="sticky-actions"><button type="submit">Preview workflow →</button><p class="meta">Previewing runs no agents. You’ll see the approval and scheduling steps next.</p></div></form>`;
}

export function workflowPreviewHtml(preview: WorkflowPreview, csrf: string, revision: number, now: Date, readiness: { title: string; detail: string; href?: string }[], auto: boolean): string {
  const d = preview.document;
  const common = hidden("csrf", csrf) + hidden("repo", preview.repo) + hidden("projectRevision", String(revision)) + hidden("preview", preview.token);
  const target = preview.taskId === null ? preview.routineId === null ? null : `/routines/${preview.routineId}` : `/t/${encodeURIComponent(preview.taskId)}`;
  return `<a href="/recipes/edit?preview=${preview.token}" class="meta">← Edit this workflow</a><div class="recipe-heading"><p class="recipe-kicker">3 · Preview</p><h1>${e(d.name)}</h1><p class="hint">${e(d.description)}</p></div>` +
    `<div class="recipe-preview-grid"><div><section class="card"><h2>What will happen</h2><ol class="recipe-steps">${workflowSteps(d).map(step => `<li><strong>${e(step.title)}</strong><p>${e(step.detail)}</p></li>`).join("")}</ol></section><section class="card"><h2>The agreed work</h2><p class="recap">${e(d.goal)}</p><h3>Leave alone</h3><p class="recap">${e(d.outOfScope ?? "No additional exclusions.")}</p><h3>Allowed paths</h3><p>${d.touches.length ? d.touches.map(e).join(", ") : "This project"}</p><h3>Success checks</h3><ul>${d.acceptance.map(c => `<li><strong>${e(c.statement)}</strong><p class="meta">${c.evidence.map(kind => e(evidence.find(([id]) => id === kind)?.[1] ?? kind)).join(" · ")}${c.how ? ` · ${e(c.how)}` : ""}</p></li>`).join("")}</ul></section></div>` +
    `<aside><section class="card"><h2>Before it starts</h2>${readiness.map(one => `<p><strong>${e(one.title)}</strong><br><span class="meta">${e(one.detail)}${one.href ? ` <a href="${e(one.href)}">Open settings →</a>` : ""}</span></p>`).join("")}<p class="meta">These checks describe current setup. Agent availability and approval are checked again when work starts.</p></section><section class="card"><h2>Schedule & control</h2><p>${e(recipeScheduleWords(d, now))}</p><p>${d.costCeilingUsd === null ? "Uses existing project and agent budget controls." : `Up to $${d.costCeilingUsd.toFixed(2)} per rolling seven days.`}</p><p>${d.schedule !== null ? "Approve the routine once on the next screen. Pause it any time from scheduled work." : auto ? "Your signed project policy will be evaluated when you create this workflow." : "Review and approve on the task page. You can stop or resume there."}</p></section></aside></div>` +
    `<div class="card recipe-launch"><div>${target ? `<a class="new-task" href="${target}">Open created workflow →</a>` : `<form method="post" action="/recipes/launch">${common}<button type="submit">${d.schedule !== null ? "Create scheduled workflow" : auto ? "Create workflow" : "Create task for approval"}</button></form>`}<p class="meta">${d.schedule !== null ? "Nothing repeats until the routine is approved." : "A matching signed policy may start work automatically."} Creating this workflow twice returns the same work.</p></div><div>${preview.savedId ? `<a href="/recipes/start?recipe=${preview.savedId}&revision=${preview.savedRevision}">Recipe saved · reuse it →</a>` : `<form method="post" action="/recipes/save">${common}<button type="submit" class="quiet">Save as a project recipe</button></form>`}<a href="/recipes/export?preview=${preview.token}">Export recipe JSON</a><p class="meta">Save or export without running anything. Sharing includes the work definition, never project access or approvals.</p></div></div>`;
}

export function recipeScript(): string {
  return scheduleEditorScript() + `(function(){
    document.querySelectorAll('[data-recipe-cadence]').forEach(function(choice){var root=choice.form.querySelector('[data-recipe-recurring]');function update(){root.hidden=choice.value!=='repeat';root.querySelector('[name=ceiling]').disabled=choice.value!=='repeat';}choice.addEventListener('change',update);update();});
    var button=document.querySelector('[data-add-criterion]');if(button){button.hidden=false;button.addEventListener('click',function(){var root=document.querySelector('[data-recipe-criteria]'),index=root.children.length;if(index>=12)return;var html=document.querySelector('[data-criterion-template]').innerHTML.replaceAll('criterion-INDEX-','criterion-'+index+'-').replaceAll('value="cNEXT"','value="c'+(index+1)+'"');root.insertAdjacentHTML('beforeend',html);root.lastElementChild.querySelector('textarea').focus();button.hidden=index>=11;});}
  })();`;
}
export const RECIPE_CSS = `
.recipe-heading { margin: .5rem 0 1.75rem; max-width: 46rem; }
.recipe-heading h1 { font-size: clamp(1.65rem,3vw,2.5rem); letter-spacing:-.035em; margin:.35rem 0 .6rem; }
.recipe-kicker { font-size:.7rem; text-transform:uppercase; letter-spacing:.12em; color:var(--muted-foreground); }
.recipe-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.8rem; margin:1rem 0 2rem; }
.recipe-card { border:1px solid var(--border); border-radius:.75rem; padding:1.1rem; background:var(--card); display:flex; flex-direction:column; gap:.5rem; }
.recipe-card h3 { font-size:1.05rem; margin:0; letter-spacing:-.015em; }
.recipe-card p { color:var(--muted-foreground); margin:.2rem 0; font-size:.85rem; line-height:1.5; }
.recipe-card-link { margin-top:auto; padding-top:.75rem; display:flex; justify-content:space-between; }
.recipe-editor { max-width:52rem; }.recipe-editor h2 { margin-top:0; }
.recipe-criterion { border:1px solid var(--border); border-radius:.5rem; padding:.8rem; margin:.8rem 0; }
.recipe-evidence { display:flex; flex-wrap:wrap; gap:.5rem 1rem; }.recipe-evidence label { display:flex; align-items:center; gap:.4rem; font-size:.8rem; }.recipe-evidence input { width:auto; margin:0; }
.recipe-options { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
.recipe-preview-grid { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(16rem,1fr); gap:1rem; }
.recipe-steps { padding-left:1.4rem; }.recipe-steps li { padding:.4rem 0 .6rem .3rem; }.recipe-steps p { margin:.3rem 0 0; font-size:.85rem; color:var(--muted-foreground); }
.recipe-launch { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }.recipe-launch form { margin:0 0 .6rem; }
.recipe-history a { display:flex; justify-content:space-between; gap:1rem; padding:.6rem 0; border-bottom:1px solid var(--border); }.recipe-history span { color:var(--muted-foreground); }
.recipe-error { border-color:var(--destructive); }
@media(max-width:1000px){.recipe-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }}
@media(max-width:760px){.recipe-grid,.recipe-options,.recipe-preview-grid,.recipe-launch { grid-template-columns:1fr; }.recipe-heading { margin-bottom:1rem; }.recipe-history a { flex-direction:column; gap:.2rem; }}
`;
