import type { CodingHandoffPreview } from './coding-handoff.js';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** A reviewable handoff. The next screen retains the existing approval terms. */
export function codingShippingHtml(preview: CodingHandoffPreview, csrf: string, values?: URLSearchParams, error?: string): string {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escape(value)}">`;
  const goal = values?.get('goal') ?? preview.title;
  const criteria = values?.get('acceptance') ?? '';
  const notice = error?.startsWith('Review screenshots are not ready.')
    ? `<p class="coding-notice" role="alert">Screenshots needed. Ask Codex to capture and commit them, then try again.</p><details><summary>Technical details</summary><p>${escape(error)}</p></details>`
    : error ? `<p class="coding-notice" role="alert">${escape(error)}</p>` : '';
  return `<section class="coding-workspace coding-handoff" data-coding-session=""><h1>Review for shipping</h1><p>${escape(preview.title)}</p>${notice}<form method="post" action="/code/${escape(preview.sessionId)}/ship" class="coding-start">${hidden('csrf', csrf)}${hidden('base', preview.base)}${hidden('candidate', preview.candidate)}${hidden('title', preview.title)}<label>Outcome<textarea name="goal" rows="4" required maxlength="16000">${escape(goal)}</textarea></label><label>Checks for review<textarea name="acceptance" rows="4" required maxlength="16000" placeholder="One observable result per line">${escape(criteria)}</textarea></label><label class="coding-check"><input type="checkbox" name="visual" value="yes"${values?.get('visual') === 'yes' ? ' checked' : ''}>Include desktop and phone screenshots</label><details><summary>${preview.changedPaths.length} changed files · commit ${escape(preview.candidate.slice(0, 8))}</summary><ul>${preview.changedPaths.map(path => `<li><code>${escape(path)}</code></li>`).join('')}</ul><p class="coding-meta">Review covers the complete change from ${escape(preview.base)} to ${escape(preview.candidate)}.</p></details><p class="coding-terms">Verification and publication use this project’s existing approval process.</p><button type="submit">Create review task</button></form><p><a href="/code/${escape(preview.sessionId)}">Back to coding</a></p></section>`;
}

export const CODING_SHIPPING_CSS = `.coding-workspace.coding-handoff{display:block;max-width:780px}.coding-handoff h1{margin-bottom:12px}.coding-handoff>p{margin-top:12px}.coding-workspace .coding-check{display:flex;align-items:center;gap:10px;min-height:44px}.coding-workspace .coding-check input{width:20px;height:20px;flex:0 0 20px}`;
