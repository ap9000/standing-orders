/**
 * Settings → Updates: the installed version, one of three ways to update
 * (behind the operator's password), the update's steps live while it runs,
 * and a one-time "What's new" card afterwards. The work itself is the
 * `toolroll update` command (toolroll-update.ts), started as its own job.
 */
import type { InstallMethod } from "./install-method.js";
import { STEP_WORDS, UPDATE_STEPS, runtimeUpdateTerminal, type RuntimeUpdateJournal, type UpdateStep } from "./toolroll-update.js";

const e = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clock = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export const UPDATES_CSS = `.updates{max-width:640px;min-width:0;overflow-wrap:anywhere}.updates .card{margin:0 0 16px}.updates h2{margin:0;font-size:1.0625rem}.updates .card>p{margin:4px 0 0}` +
  `.updates .update-actions{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0}.updates .update-actions button{white-space:nowrap}` +
  `.updates button.primary{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary);font-weight:600}` +
  `.updates .step-up{display:grid;gap:4px;font-size:.8125rem;margin:16px 0 0;max-width:20rem}.updates .step-up input{min-height:40px}` +
  `.updates ol.update-steps{list-style:none;padding:0;margin:14px 0 0;display:grid;gap:2px}.updates ol.update-steps li{display:grid;grid-template-columns:18px minmax(0,1fr);gap:0 10px;align-items:baseline;padding:5px 0;font-size:.875rem;color:var(--so-muted)}` +
  `.updates ol.update-steps li::before{content:"";width:8px;height:8px;border-radius:50%;border:1.5px solid var(--so-input-line);justify-self:center;transform:translateY(-1px)}` +
  `.updates ol.update-steps li[data-state=done]{color:var(--so-ink)}.updates ol.update-steps li[data-state=done]::before{background:var(--so-success);border-color:var(--so-success)}` +
  `.updates ol.update-steps li[data-state=now]{color:var(--so-ink);font-weight:600}.updates ol.update-steps li[data-state=now]::before{background:var(--so-info);border-color:var(--so-info);box-shadow:0 0 0 4px color-mix(in srgb,var(--so-info) 16%,transparent)}` +
  `.updates ol.update-steps li[data-state=failed]{color:var(--so-danger);font-weight:600}.updates ol.update-steps li[data-state=failed]::before{background:var(--so-danger);border-color:var(--so-danger)}` +
  `.updates ol.update-steps .step-detail{grid-column:2;font-weight:400;color:var(--so-muted);font-size:.8125rem;margin-top:2px}` +
  `.updates .whats-new ul{margin:10px 0 0;padding-left:18px}.updates .whats-new li{margin:4px 0}.updates .whats-new form{margin:14px 0 0}` +
  `.updates .update-problem{color:var(--so-danger)}.updates .stamp{margin:10px 0 0}.updates code{white-space:nowrap}` +
  `@media (prefers-reduced-motion:no-preference){.updates ol.update-steps li[data-state=now]::before{animation:update-pulse 1.6s ease-in-out infinite}}@keyframes update-pulse{50%{box-shadow:0 0 0 7px color-mix(in srgb,var(--so-info) 6%,transparent)}}` +
  `@media (max-width:600px){.updates .update-actions{display:grid}.updates .update-actions button{width:100%;min-height:44px}.updates .step-up{max-width:none}.updates .step-up input{min-height:44px}}`;

export type UpdatesView = {
  current: string;
  /** The newest release, why it is unknown, or not asked because update checks are off. */
  latest: { version: string } | { problem: string } | { off: true };
  method: InstallMethod;
  journal: RuntimeUpdateJournal | null;
  running: boolean;
  whatsNew: { version: string; notes: string[] } | null;
  /** The version `toolroll update --rollback` returns to: the last completed update's, while it is what runs. */
  rollbackTo: string | null;
  csrf: string;
};

/** The steps, each done, current, failed or waiting. Also the live region's fragment. */
export function updateStepsHtml(j: RuntimeUpdateJournal, running: boolean): string {
  const finished = runtimeUpdateTerminal(j.phase);
  const failed = ["restored", "refused", "needs-attention", "rolling-back"].includes(j.phase);
  const last = UPDATE_STEPS.indexOf([...j.steps].reverse().find(s => (UPDATE_STEPS as readonly string[]).includes(s.phase))?.phase as UpdateStep);
  const items = UPDATE_STEPS.map((step: UpdateStep, i) => {
    const state = j.phase === "complete" || i < last ? "done" : i > last ? "waiting" : failed ? "failed" : finished ? "waiting" : "now";
    // Only where it adds something: which work it waits for, or what went wrong.
    const detail = (state === "now" && step === "draining") || (state === "failed" && j.phase === "rolling-back") ? `<span class="step-detail">${e(j.detail)}</span>` : "";
    return `<li data-step="${step}" data-state="${state}">${e(STEP_WORDS[step])}${detail}</li>`;
  }).join("");
  const title = j.phase === "scheduled" ? `Update to ${e(j.to.version)} scheduled for ${e(clock(j.at ?? j.startedAt))}`
    : j.phase === "rolling-back" ? `Restoring ${e(j.from.version)}`
    : j.kind === "rollback" ? `Rolling back to ${e(j.to.version)}` : `Updating to ${e(j.to.version)}`;
  const stalled = !running && !finished ? `<p class="update-problem" role="alert">The updater stopped. Run <code>toolroll update --resume</code> to continue it.</p>` : "";
  return `<div id="update-live" data-phase="${e(j.phase)}" data-done="${finished ? 1 : 0}"><h2>${title}</h2>` +
    (j.phase === "scheduled" ? `<p class="meta">Running work finishes first. You can close this page.</p>` : `<ol class="update-steps" aria-label="Update steps">${items}</ol>`) + stalled + `</div>`;
}

function outcomeHtml(j: RuntimeUpdateJournal): string {
  if (j.phase === "complete") return j.kind === "rollback" ? `<div class="card" data-update-outcome="rolled-back"><h2>Back on ${e(j.to.version)}</h2><p class="meta">${e(j.detail)}</p></div>` : "";
  if (j.phase === "cancelled") return `<div class="card" data-update-outcome="cancelled"><h2>Update cancelled</h2><p class="meta">Nothing changed.</p></div>`;
  const title = j.phase === "refused" ? `Didn't update to ${e(j.to.version)}` : j.phase === "restored" ? `Update to ${e(j.to.version)} didn't finish` : "The update needs attention";
  return `<div class="card" data-update-outcome="${e(j.phase)}"><h2>${title}</h2><p class="${j.phase === "needs-attention" ? "update-problem" : ""}" role="alert">${e(j.detail)}</p>` +
    `<details><summary>Steps</summary>${updateStepsHtml(j, false).replace(/<h2>.*?<\/h2>/, "")}</details></div>`;
}

export function updatesHtml(view: UpdatesView, notice: { said?: string | null; problem?: string | null }): string {
  const note = notice.problem ? `<p class="update-problem" role="alert">${e(notice.problem)}</p>` : notice.said ? `<p role="status">${e(notice.said)}</p>` : "";
  const j = view.journal;
  const active = j !== null && !runtimeUpdateTerminal(j.phase);
  const csrf = `<input type="hidden" name="csrf" value="${e(view.csrf)}">`;
  const whatsNew = view.whatsNew === null ? "" : `<div class="card whats-new" data-whats-new="${e(view.whatsNew.version)}"><h2>What’s new in ${e(view.whatsNew.version)}</h2>` +
    (view.whatsNew.notes.length > 0 ? `<ul>${view.whatsNew.notes.map(line => `<li>${e(line)}</li>`).join("")}</ul>` : "") +
    `<p class="meta"><a href="https://github.com/ap9000/toolroll/releases/tag/v${e(view.whatsNew.version)}" rel="noreferrer">Full release notes</a></p>` +
    `<form method="post" action="/settings/updates/seen">${csrf}<button type="submit">Got it</button></form></div>`;
  if (active) {
    const cancel = ["scheduled", "draining"].includes(j.phase) ? `<form method="post" action="/settings/updates/cancel" class="update-actions">${csrf}<button type="submit">Cancel update</button></form>` : "";
    return `<section class="updates">${note}<div class="card" id="update-region">${updateStepsHtml(j, view.running)}${cancel}</div><p class="meta stamp" id="update-region-stamp"></p></section>`;
  }
  const latest = "version" in view.latest ? view.latest.version : null;
  const newer = latest !== null && newerThan(latest, view.current);
  const state = view.method.kind === "npx" ? `<h2>Toolroll ${e(view.current)}</h2><p class="meta">npx runs the latest release each time, so this is current.</p>`
    : view.method.kind === "source" ? `<h2>Toolroll ${e(view.current)}</h2><p class="meta">This runs from a source checkout. Update it with git.</p>`
    : newer && view.method.kind === "desktop" ? `<h2>Toolroll ${e(latest)} is available</h2><p class="meta">You have ${e(view.current)}. Update it from the Toolroll app.</p>`
    : newer ? `<h2>Toolroll ${e(latest)} is available</h2><p class="meta">You have ${e(view.current)}. Running work finishes first, and your current version is kept so you can go back.</p>`
    : "off" in view.latest ? `<h2>Toolroll ${e(view.current)}</h2><p class="meta">Update checks are off.</p><form method="get" action="/settings/updates" class="update-actions"><input type="hidden" name="check" value="now"><button type="submit">Check now</button></form>`
    : latest === null ? `<h2>Toolroll ${e(view.current)}</h2><p class="meta">Couldn’t check for a newer release: ${e("problem" in view.latest ? view.latest.problem : "")}</p>`
    : `<h2>Toolroll ${e(view.current)} is up to date</h2>`;
  const form = newer && !["npx", "source", "desktop"].includes(view.method.kind)
    ? `<form method="post" action="/settings/updates">${csrf}<input type="hidden" name="version" value="${e(latest)}">` +
      `<label class="step-up">Your Toolroll password<input type="password" name="password" autocomplete="current-password" required></label>` +
      `<div class="update-actions"><button type="submit" name="when" value="now" class="primary">Update now</button>` +
      `<button type="submit" name="when" value="when-idle">When idle</button><button type="submit" name="when" value="tonight">Tonight (03:00)</button></div></form>`
    : "";
  const rollback = view.rollbackTo !== null ? `<p class="meta">To go back to ${e(view.rollbackTo)}: <code>toolroll update --rollback</code></p>` : "";
  return `<section class="updates">${note}${whatsNew}${j ? outcomeHtml(j) : ""}<div class="card" data-update-state="${newer ? "available" : "current"}">${state}${form}${rollback}</div></section>`;
}

export function newerThan(a: string, b: string): boolean {
  const [x, y] = [a, b].map(v => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) > (y![i] ?? 0);
  return false;
}

/** Polls the steps every two seconds, keeps trying while the console
 * restarts, and reloads once the update has finished. */
export function updatesScript(): string {
  return `(function(){var region=document.getElementById("update-region");if(!region)return;var stamp=document.getElementById("update-region-stamp");var misses=0;` +
    `function tick(){if(document.hidden){setTimeout(tick,2000);return;}fetch("/settings/updates?fragment=steps",{credentials:"same-origin",cache:"no-store"}).then(function(r){if(!r.ok)throw 0;return r.text();}).then(function(html){misses=0;if(stamp)stamp.textContent="";` +
    `var live=region.querySelector("#update-live");if(live)live.outerHTML=html;var now=region.querySelector("#update-live");if(now&&now.getAttribute("data-done")==="1"){location.reload();return;}setTimeout(tick,2000);})` +
    `.catch(function(){misses++;if(stamp)stamp.textContent=misses>2?"Reconnecting while Toolroll restarts…":"";setTimeout(tick,Math.min(10000,2000*misses));});}setTimeout(tick,2000);})();`;
}
