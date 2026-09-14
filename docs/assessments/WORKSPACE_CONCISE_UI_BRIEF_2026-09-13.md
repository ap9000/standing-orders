# Focused concise-content pass

User direction on September 13, 2026: make the UI less text-oriented, clean and concise. Do this after the package 1 query fix. It is a small content-density pass over the existing shell, not the rest of package 2 and not a new result/revision engine.

## Visible change

| Surface | Current friction | Intended presentation |
| --- | --- | --- |
| Work | Every row repeats a status, a long diagnosis, history and a verbose action. Few tasks fit on a phone. | Task title first, a compact truthful status and one existing next action. Secondary reason/history behind a keyboard-accessible Details disclosure. A necessary decision or failed state stays visible. |
| Chat | Repeated introductory guidance and composer reassurance compete with the conversation. | At most one useful sentence for the current state, concise contextual starters, and the existing composer. Preserve actual messages, drafts, pending sends and task focus. |
| Task / result | Status and result facts repeat in several introductory paragraphs. | One visually dominant current status/action and the actual result. Secondary mechanics, history, logs and detailed checks are disclosed, while failure/exception/missing evidence remains visible. Exact scope and approval controls are unchanged and accessible. |

## Rules

- Reuse existing typography, tokens, HTML details/summary, status projection, URLs and actions. No new dependency, animated layout, SPA, renderer architecture or transport.
- Remove redundant helper copy; do not merely make it smaller or lower-contrast.
- Never hide a blocker, required decision, failed check, evidence exception, stale approval or missing configuration behind a success-looking headline.
- Keep actual deliverables and user/assistant messages intact. Do not summarize away signed acceptance criteria, exclusions, file restrictions, permission terms, reviewer lineage or original feedback.
- Disclosures must work without JavaScript and by keyboard. Controls retain visible focus and usable phone targets. An action label must describe what its existing link/button really does.
- Preserve Chat / Work / Projects, the project selector, primary Add project affordances, selected older results, both revision paths and the completed listing fix.
- No new global settings, permissions, billing changes, data mutations for testing, installation update or publication.

## Proof

Use the same synthetic fixtures for before and after. Show exact viewport images of Work at 390×844 and 320×740, a populated focused chat, a fresh desktop chat, and a task/result with a failed check or pending review. Describe which visible helper text was removed or disclosed and the concrete change in vertical density; do not claim a percentage based only on raw HTML or hidden DOM text.

Run focused renderer/status tests, both existing strict browser exercises, and relevant draft/approval/revision regression tests. Update tests for intentional disclosure behavior without dropping their semantic assertions. The unchanged full repository verifier runs once through the normal machine-owned sealing gate and must pass before sign-off; do not duplicate it in the builder. Record what actually passed and what is still pending.

Likely files: `src/serve.ts`, focused serve/continuity/status tests only as needed, `scripts/ui-polish-proof.mjs`, `scripts/workspace-proof.mjs`, and a concise result note. Core database/authority/scheduler code is out of scope. No redesign of specialist/admin pages.
