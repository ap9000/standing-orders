/** Shared setup views over the existing project configuration and approval doors. */
import type { ProviderId } from "./provider.js";
import type { ProviderConnection } from "./provider-connection.js";
import { ASSISTANTS, type ModelChoice } from "./setup-guide.js";
import type { SetupInputs } from "./control-setup.js";
import { openRouterPicker, type OpenRouterModels } from "./openrouter-models.js";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
export function hiddenFields(values: Record<string, string>): string {
  return Object.entries(values).map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("");
}
export function connectionWords(connection: ProviderConnection): string {
  return {
    connected: "Connected", "signed-out": "Not signed in", "not-installed": "CLI not installed",
    unverified: "Not verified", "key-present": "API key saved · not verified", "missing-key": "API key needed",
  }[connection.state];
}
export function connectionHtml(provider: ProviderId, connection: ProviderConnection, task = ""): string {
  const query = new URLSearchParams({ provider, ...(task ? { task } : {}) });
  return `<div class="card assistant-account"><p><strong>${escape(ASSISTANTS[provider].name)} · ${connectionWords(connection)}</strong></p>` +
    `<p class="meta">${[connection.email, connection.plan, connection.method].filter(Boolean).map(one => escape(one!)).join(" · ")}</p>` +
    `<p class="meta">Checked ${escape(new Date(connection.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }))} on the computer running this console. Sign-in does not prove model access or remaining quota.</p>` +
    `<a class="button-link" href="/control/connection?${escape(query.toString())}">${connection.state === "connected" ? "Manage connection" : "Connect account"}</a> · ` +
    `<a href="/control?${escape(query.toString())}&amp;check-connection=1">Check again</a></div>`;
}
export function controlSetupHtml(data: {
  repo: string; csrf: string; provider: ProviderId; inputs: SetupInputs; models: ModelChoice[];
  connection: ProviderConnection; catalog: OpenRouterModels | null; task?: string;
  preparation: { command: string; label: string; evidence: string } | null;
  instructions: { installed: boolean; message?: string };
}): string {
  const { provider, inputs, task = "" } = data;
  const query = new URLSearchParams({ provider, ...(task ? { task } : {}) });
  const model = data.catalog !== null
    ? openRouterPicker(data.catalog, inputs.model || null, `/control?${query}&refresh-models=1`)
    : `<label>Model<input type="text" name="model" value="${escape(inputs.model)}" list="setup-models" required autocomplete="off" placeholder="Exact model id or supported alias"></label>` +
      `<datalist id="setup-models">${data.models.map(one => `<option value="${escape(one.value)}">${escape(one.label)}</option>`).join("")}</datalist>`;
  return `<h1>Project setup</h1><p>${escape(data.repo)}</p>` +
    `<p class="meta">Choose the default builder for new tasks and the preparation command for this project.</p>` +
    `<nav class="assistant-picker row" aria-label="Choose provider">${(Object.keys(ASSISTANTS) as ProviderId[]).map(id => `<a class="button-link" href="/control?${escape(new URLSearchParams({ provider: id, ...(task ? { task } : {}) }).toString())}"${id === provider ? ' aria-current="page"' : ""}>${ASSISTANTS[id].name}</a>`).join(" ")}</nav>` +
    connectionHtml(provider, data.connection, task) +
    `<form method="post" action="/control/setup-preview" class="card">${hiddenFields({ csrf: data.csrf, repo: data.repo, provider, task })}` + model +
    `<details class="setup-advanced"><summary>Project preparation</summary>` +
    (data.preparation === null ? "" : `<p class="meta">Suggested from ${escape(data.preparation.evidence)}: ${escape(data.preparation.label)} — <code>${escape(data.preparation.command)}</code>. Review before approving.</p>`) +
    `<label>Preparation command<textarea name="command" rows="2" maxlength="2000">${escape(inputs.command)}</textarea></label>` +
    `<label>Preparation timeout in seconds<input name="seconds" type="number" min="1" max="3600" value="${escape(inputs.seconds)}" required></label>` +
    `<p class="meta">Preparation applies to subsequent runs, including already approved tasks. Saving setup does not execute it.</p></details>` +
    `<button type="submit">Review project setup</button></form>` +
    `<section class="card"><h2>Agent instructions</h2>` +
    (data.instructions.message ? `<p>${escape(data.instructions.message)}</p>` : data.instructions.installed ? `<p>Current Standing Orders instructions are installed.</p>` :
      `<p>Give the agent the project's Standing Orders handoff instructions.</p><form method="post" action="/control/instructions-preview">${hiddenFields({ csrf: data.csrf, repo: data.repo })}<button>Review instructions</button></form>`) +
    `</section><p><a href="/fleet">Configure planning, repair, and review agents</a> · <a href="/tasks/new">Describe a task</a></p>`;
}

export function setupPreviewHtml(inputs: SetupInputs, fields: Record<string, string>): string {
  return `<h1>Approve project setup</h1><div class="card"><p>${escape(fields.repo ?? "")}</p>` +
    `<p><strong>Builder:</strong> ${escape(inputs.provider)} · ${escape(inputs.model)}</p>` +
    `<p><strong>Preparation:</strong></p><pre class="recap">${escape(inputs.command || "No preparation command")}</pre>` +
    `<p>Preparation timeout: ${escape(inputs.seconds)} seconds.</p>` +
    `<p>The builder default applies to new tasks. Preparation applies to subsequent runs, including already approved tasks. Existing signed task settings and verification rules remain in force.</p>` +
    `<form method="post" action="/control/setup-approve">${hiddenFields({ ...fields, ...inputs })}` +
    `<label>Your password<input type="password" name="token" autocomplete="current-password" required></label>` +
    `<button>Approve project setup</button></form></div>`;
}
