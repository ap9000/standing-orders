# Package 5 — three real-work pilots

September 14, 2026. **Planned, not filed or running.** These are the first three tasks in Package 5, not a substitute for its broader release and unfamiliar-user acceptance. Run them sequentially through Standing Orders, starting with the released Package 4 source. Deployment of that source is a separate step; an older installed console is not evidence for the new UI.

## 1. Make long requests safe to revise

**Today:** the Package 3 revision failed because an existing CLI-authored scope exceeded the proposal form's 2,000-character goal limit. The feedback survived, but a manually filed follow-up was needed. `validateTaskText` in `src/proposal.ts` enforces the limit while the trusted CLI scope path accepts longer text.

**Outcome:** a valid existing task can become a normal or annotated revision without losing its request, exclusions, feedback, or original result.

**Boundaries:** repair the existing filing and `sealRevision` paths. Choose and document one coherent text-limit policy for new requests, including byte limits. Handle existing longer scopes explicitly. Never silently truncate signed terms, replace a revision with an unrelated task, or change the original approval. No new planner, storage engine, global permission change, or wholesale form redesign.

**Acceptance:**

- Reproduce the original long-scope failure in a disposable fixture, then file both revision types successfully under the chosen policy. Include a long exclusion and multi-byte text.
- The revision retains exact inherited terms and source/result identity; all new feedback is present. Its approval is evaluated against its own current terms, never copied from its parent.
- New CLI, chat-tool and web requests agree on validation. Rejected input stays editable with one concise, specific explanation.
- A missed response, double submission and later second feedback batch preserve existing exactly-once behavior. No dropped notes, extra child task or accidental approval.

**Likely files:** `src/proposal.ts`, `src/operate.ts`, `src/store.ts`, `src/serve.ts`, affected chat-tool/schema adapters and their existing tests. Confirm the minimal set before signing the task; do not approve a repository-wide path merely for convenience.

**End-to-end proof:** create the repair task in chat → review exact plan → approve → wait for the native result → inspect diff/checks → leave ordinary feedback and a line annotation → review and approve the resulting revision → observe its result. Separately use synthetic legacy long-scope data for the boundary cases; do not describe that fixture as a real model run.

## 2. Show one truthful status everywhere

**Today:** Work uses the dispatch explanation, but the task-detail header starts from raw task state plus stop controls. A task can therefore say **queued** while its main action is **Review plan**. The same split was visible during Package 4 validation: a live agent had raw state `queued` and a correct dispatch view of `Running now`.

**Outcome:** Chat, Work and task details agree on what is happening and what, if anything, the user needs to do.

**Boundaries:** reuse the existing dispatch, control and result projections. No second state machine, schema change, fabricated progress percentage, or extra status paragraph. Keep failed/missing evidence and stale approval visible.

**Acceptance:**

- The same task reads consistently before approval, after approval while waiting, during building/checks, on hold, after scope changes, and after failed or missing evidence.
- Each actionable state has one precise primary CTA, such as **Review plan**, **Remove hold**, or the specific dependency action. Ordinary queue waits do not pretend to require approval again.
- A refreshed status does not replace a draft, steal focus or silently send a message.
- Inspect the affected journey at desktop and 390px, with long titles and a failure. Keep labels concise, comfortable to tap, and free of horizontal overflow.

**Likely files:** `src/serve.ts`, `src/workspace-ui.ts`, existing dispatch/result helpers only where necessary, and focused tests. Reuse projections rather than copying their rules into markup.

**End-to-end proof:** run this UI task through the result of pilot 1. Capture the actual task in Chat, Work and Details at the relevant observed stages. Use fixture states only for failures/holds that did not naturally occur, clearly labeled. Request one genuine revision through the product if the independent inspection finds a concrete issue.

## 3. Give revisions recognizable names

**Today:** the feedback route generates titles such as `Revise <internal-task-id> from 2 annotations on build #1`, even when the batch includes ordinary notes (`src/serve.ts`, the `sealRevision` caller).

**Outcome:** the user recognizes the work immediately: for example, **Mobile project switcher — revision**. Source build identity and exact feedback remain available in the result details.

**Boundaries:** presentation and title generation only. Do not change task IDs, feedback seals, source lineage, request idempotency, approval policy or historical records. Use deterministic title generation, not another model call.

**Acceptance:**

- Use the human parent title for regular, annotated and mixed feedback. Use **feedback** when referring to a mixed batch.
- Long and multi-byte titles remain within canonical title limits without cutting invalid Unicode or losing the recognizable subject. Test repeated revisions and a missing/unavailable parent fallback.
- Retrying the same submission still returns the original child; later feedback creates a separate, correctly linked revision. Exact notes stay untouched.
- Phone and desktop task cards show one clear title and action; technical provenance is in details, not repeated in the headline.

**Likely files:** the existing revision title builders in `src/serve.ts` and focused revision tests. Only extract a shared helper if more than one existing route needs it.

**End-to-end proof:** submit this as a real chat task, inspect the result, then use both feedback modes together. Verify the child title and complete one approved revision. No fabricated feedback merely to inflate the number of tasks completed.

## Common execution contract

- Before starting each task, inspect and sign its exact goal, exclusions, file paths, acceptance criteria and actual agent route. Use the saved subscription-backed providers, not API billing. Target Astra for planning/building and Opus for independent review where connected and approved; record the actual route rather than implying project defaults already match. No silent model, budget or permission changes.
- Use the existing direct-build mode for a settled small scope, and plan-first only for a material unresolved choice. Do not add another orchestration layer or mandatory conversation round.
- A builder runs typecheck and affected tests; reuse existing regression suites. The unchanged approved full verifier runs once at the final machine gate for each candidate, not again inside independent review. A failed gate or changed candidate needs fresh verification.
- Independent review checks the actual diff, result and relevant desktop/phone journey. Feedback becomes a native linked revision with its own approval; do not conceal a manual rescue as self-healing.
- Keep a compact receipt per task: scope digest, task/run IDs, base/head, actual models and auth mode, first-attempt outcome, retries, manual interventions, final checks, screenshots and remaining gaps. Use viewport screenshots, not stitched long-page phone captures.
- If execution needs new authority or the result fails acceptance, show the exact problem and preserve work. No auto-merge, deployment, signing, new agent time limits or weakened checks under this plan.

## Completion standard and open issues

Success for this first cohort means three reviewable results, at least one completed linked revision, zero lost drafts/notes, no duplicate work or false verified result, and every failure accounted for. Report initial and final outcomes separately. Three tasks are useful product evidence, not enough to claim 95% unattended reliability or a product-wide 10/10.

Retain the wider Package 5 gates: physical-phone acceptance, controlled installation/update checks, unfamiliar-user sessions and the larger varied-task cohort. Physical Windows and signed-Mac acceptance remain deferred until those environments are available.

**Additional issue found during Package 4 finalization:** standalone CLI `build` stamps the approved Astra route but calls the builder without its provider, which defaults to Claude. Run 1557 refused before provider start with `stale-approval`; the normal queue route started Astra correctly. Keep this as a separate small CLI routing parity fix, with a focused non-default-provider regression. Do not weaken the route check or change an approval to disguise the mismatch.
