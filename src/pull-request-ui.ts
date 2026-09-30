/** Settings → Projects → Pull requests: one project's pull-request setup, in plain words. Off shows what setup
 * found (or what to fix) and one Turn on; on shows where pull requests go and how they merge. Every change takes
 * the password; turning on restates the exact repository and branch that were checked. */
import type { MergeMethod, Publishing, PublishingPlan } from "./pull-request-flow.js";

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export type PullRequestSettingsView = {
  repo: string;
  name: string;
  csrf: string;
  canChange: boolean;
  publishing: Publishing;
  /** When off: what setup found — the plan to confirm, or what to fix first. */
  check: { ok: true; plan: PublishingPlan } | { ok: false; message: string } | null;
  said: string | null;
  problem: string | null;
};

const METHOD_WORDS: Record<MergeMethod, string> = { squash: "Squash and merge", merge: "Merge commit", rebase: "Rebase and merge" };

export function pullRequestSettingsHtml(view: PullRequestSettingsView): string {
  const hidden = (act: string) => `<input type="hidden" name="csrf" value="${escape(view.csrf)}"><input type="hidden" name="repo" value="${escape(view.repo)}"><input type="hidden" name="act" value="${act}">`;
  const password = `<label>Password<input type="password" name="password" autocomplete="current-password" required></label>`;
  const notes = [
    view.said === null ? "" : `<p class="notice" role="status">${escape(view.said)}</p>`,
    view.problem === null ? "" : `<p class="problem" role="alert">${escape(view.problem)}</p>`,
  ].join("");
  const head = `<p class="meta">${escape(view.name)} · <span class="mono">${escape(view.repo)}</span></p>${notes}`;
  const publishing = view.publishing;
  if (publishing.on) {
    const status = `<section class="card pr-settings"><p><strong>On</strong> · <span class="mono">${escape(publishing.githubRepo)}</span> into <span class="mono">${escape(publishing.base)}</span></p>` +
      `<p class="meta">${publishing.legacy ? "Every finished build opens a pull request (set up with publish grant)." : "Complete offers “Complete and open a pull request”."} Set up by ${escape(publishing.grantedBy)}.</p></section>`;
    if (!view.canChange) return head + status;
    const methods = (["squash", "merge", "rebase"] as const).map(method =>
      `<option value="${method}"${publishing.mergeMethod === method ? " selected" : ""}>${METHOD_WORDS[method]}${method === "squash" ? " (default)" : ""}</option>`).join("");
    return head + status +
      `<form method="post" action="/settings/pull-requests" class="card pr-settings">${hidden("settings")}` +
      `<h2>Merging</h2>` +
      `<label>Merge method<select name="method">${methods}</select></label>` +
      `<label class="row pr-check"><input type="checkbox" name="when-green" value="1"${publishing.mergeWhenGreen ? " checked" : ""}> Merge when checks pass</label>` +
      `<p class="meta">Off by default. When on, a pull request merges by itself once its checks pass on the completed commit. Branches are deleted after merging.</p>` +
      `${password}<button type="submit">Save</button></form>` +
      `<details class="settings-more"><summary>Turn off pull requests</summary>` +
      `<form method="post" action="/settings/pull-requests" class="card pr-settings">${hidden("off")}` +
      `<p class="meta">Nothing more is pushed. Open pull requests stay on GitHub.</p>${password}<button type="submit" class="danger">Turn off</button></form></details>`;
  }
  const check = view.check;
  if (check === null) return head + `<section class="card pr-settings"><p><strong>Off</strong></p><p class="meta">An approver can turn on pull requests.</p></section>`;
  if (!check.ok) {
    return head + `<section class="card pr-settings"><p><strong>Can’t turn on yet</strong></p><p>${escape(check.message)}</p>` +
      `<p><a class="button-link" href="/settings/pull-requests?repo=${encodeURIComponent(view.repo)}">Check again</a></p></section>`;
  }
  const plan = check.plan;
  return head +
    `<form method="post" action="/settings/pull-requests" class="card pr-settings">${hidden("on")}` +
    `<input type="hidden" name="github" value="${escape(plan.githubRepo)}"><input type="hidden" name="base" value="${escape(plan.base)}">` +
    `<p><strong>Ready to turn on</strong></p>` +
    `<ul class="pr-terms"><li>Pull requests open on <span class="mono">${escape(plan.githubRepo)}</span> into <span class="mono">${escape(plan.base)}</span>${plan.account === null ? "" : `, as ${escape(plan.account)}`}.</li>` +
    `<li>Complete offers “Complete and open a pull request”, from the exact completed commit. A flow's Pull request zone can open one too.</li>` +
    `<li>Merging squashes and deletes the branch. A person merges with their password; a flow merges only when its zone says so, after a person approved the card.</li></ul>` +
    `${password}<button type="submit">Turn on pull requests</button></form>`;
}

export const PULL_REQUEST_SETTINGS_CSS = `
  .pr-settings { display: grid; gap: .6rem; max-width: 40rem; }
  .pr-settings p, .pr-settings h2 { margin: 0; }
  .pr-settings label { display: grid; gap: .25rem; }
  .pr-settings label input[type=password], .pr-settings select { min-height: 44px; box-sizing: border-box; width: 100%; }
  .pr-settings .pr-check { display: flex; align-items: center; gap: .5rem; min-height: 44px; }
  .pr-settings button { min-height: 44px; justify-self: start; }
  .pr-terms { margin: 0; padding-left: 1.1rem; display: grid; gap: .25rem; }
  @media (max-width: 480px) { .pr-settings button { justify-self: stretch; } }
`;
