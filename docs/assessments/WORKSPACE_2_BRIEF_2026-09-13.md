# Package 2 — continuous chat, planning, and approval

User approved execution of package 2 on September 13, 2026. Start from the accepted workspace branch at `755b098d734709befd3f92c1aee0a03e41ab4c7c`, including the precise recovery CTA follow-up. Preserve packages 0/1, concise content, and all earlier fixes. The standing roadmap is `WORKSPACE_EXPERIENCE_PLAN_2026-09-13.md`.

## Outcome

Describe work, confirm the proposed task, review a concise plan, and approve its exact terms in the same conversation. New messages, proposals, and task status arrive without a page reload, draft loss, focus theft, or a reading-position jump. Ordinary forms remain usable without JavaScript. This is a focused enhancement of the existing server-rendered chat, not a new chat engine.

## Implementation boundaries

The following files are the allowed implementation surface:

- `src/serve.ts`, `src/serve.test.ts`
- `src/chat-continuity.ts`, `src/chat-continuity.test.ts`
- `src/mate.ts`, `src/mate-continuity.test.ts` only if a demonstrated request/context binding defect requires it
- `scripts/ui-polish-fixture.mjs`, `scripts/ui-polish-proof.mjs`, `scripts/workspace-proof.mjs`
- New bounded browser proof `scripts/workspace-chat-proof.mjs`
- Result note `docs/assessments/WORKSPACE_2_RESULT_2026-09-13.md`

Do not modify the store/schema, scheduler, providers, billing, permissions, publication authority, or global configuration. Do not edit this brief, the roadmap, installed files, live task data, or other worktrees. Root handles integration and live acceptance independently. No dependency additions, WebSockets, SPA/framework migration, new background service, or new live-preview host. No main merge, push, release, or installation update.

## 1. A continuous request-to-plan journey

- Retain the short empty-state copy and three contextual starters already completed. Keep direct form entry available; avoid a new questionnaire.
- A task proposal is still a proposal. Confirming it may create a task, not approve execution. After successful confirmation, make its actual created task/project and the next action obvious in the unified conversation. Reuse the existing confirmation outcome, never infer an ID from assistant prose or a title. Refused/replayed/unavailable results must remain honest.
- Offer concise plan information before the exact-terms ceremony: goal, intended changes/success checks, and important limits, using existing signed facts. One clear **Review plan** action, then the existing focused approval form with **Approve & start**. Avoid another long stacked form or multiple competing primary buttons.
- The expanded form retains all exact scope, exclusions, paths, criteria, agent route, permissions, budgets/race terms if applicable, revision lineage, digest, nonce, authentication and consent guards. Do not truncate or summarize away what is signed.
- Task focus is a lens over the unified conversation, not invented separate task transcripts. Keep visible task/project context aligned with the context submitted to the provider. Drafts remain associated with their original session and task when switching contexts.

## 2. Live updates over the existing read-only refresh path

- Extend the existing polling/status mechanism with bounded server-rendered transcript/action fragments and stable message/proposal/task identities. Share rendering with initial GET where sensible. Preserve the existing no-store/private policy and admission/role/session checks.
- Responses must be bound to the current authorized conversation, task focus, and project/admission context. Ignore late or mismatched responses after a navigation/session change; never merge another context into this one. A changed session must not automatically discard the visible unsent draft or silently authorize sending under a new session.
- Do not treat only the latest turn ID/state as sufficient for proposal, decision, scope, or progress updates. Refresh versions must reflect the actual displayed facts without churning on relative timestamps or newly minted tokens.
- Update safe regions only. Preserve the composer DOM node, text, caret/selection, focus, open disclosures, selected result and reading anchor. Use delegated/idempotent handlers for new cards so repeated refreshes cannot multiply submission handlers or requests.
- When the reader is above the latest message, leave their position alone and offer a small **New update** action. Only a user action should take them to unread content. At the bottom, follow new content without hiding it beneath fixed controls.
- Never replace a live password/approval form beneath a user. If signed terms change, show that the plan needs review again, prevent presenting the old form as current, and offer a user-initiated refresh/review of the secure terms. The server remains the final stale-approval authority; client blocking is not a substitute.
- Keep native POST fallback. If enhancing send, submit the existing endpoint once with the existing request receipt key and session binding, never automatically retry an uncertain POST. Clearing a sent draft requires an actual receipt and must not clear a newer edited draft. Prompt buttons preserve their submitted prompt and context.
- Distinguish connection loss, unconfirmed send, changed/expired/revoked session, and unavailable storage in concise language. Keep drafting available where safe, but disable sending under stale authority until an explicit reconnection. No promise of cloud draft sync or persistence beyond same-tab storage's existing expiry.

## 3. Acceptance and proof

Use synthetic data and the existing scripted subscription runner for browser checks. No real model calls or live DB mutations for tests. Record fixture provenance. Do not claim browser emulation proves physical iPhone Safari or Windows behavior.

Automated and browser checks must include:

1. Request → proposal confirmation → actual task focus → concise plan → exact approval → recorded eligible/running state, with creation and execution approval demonstrably separate. Repeated confirmation creates no duplicate task.
2. Receive a new reply/proposal while typing, with identical composer node, draft, caret and focus retained. Open details and reading anchor remain stable. New update works by keyboard; new cards remain actionable after multiple polls.
3. Send once, lose the response, reconnect, and reload: exactly one provider dispatch and task creation, with a durable receipt. A newer unsent edit survives acknowledgement of the older send.
4. Switch between two task contexts with distinct drafts and inspect submitted provider context. Late responses and receipts cannot populate, clear, or submit the other task's draft.
5. Edit scope while an approval/password form is open: old form/password are not swapped, stale submission is refused, and explicit review reveals the current exact digest before approval succeeds.
6. Expired/revoked session, changed admission, unavailable task, failed/malformed refresh, offline/online, storage denial and JavaScript disabled: no authority widening, draft loss, duplicate work, or misleading success.
7. Desktop 1440×900 and phone 390×844 (plus 320×740 overflow check): real viewport screenshots of a new task proposal, concise plan, expanded approval, and a live update while typing. No document overflow, composer overlap, hidden essential controls or added heavy motion/dependency.

Run focused continuity/mate/server tests and the new browser proof. Rerun existing workspace and UI proof suites, adapting only assertions intentionally superseded by this package; keep their behavioral/authority checks. The unchanged full serial repository verifier runs once in the normal machine-owned sealing gate and must pass before sign-off. Do not duplicate that full suite in the builder, lengthen its timeouts, skip checks, override proof, or mark pending verification as passed. Include concrete before/after behavior, test counts, exact screenshot paths and remaining limitations in the result note.
