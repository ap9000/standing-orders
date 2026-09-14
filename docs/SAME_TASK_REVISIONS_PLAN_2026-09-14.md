# Same task, successive results

## Outcome

One user-facing task owns its request, conversation, current work and result history. After reviewing a result, the user leaves feedback and chooses **Revise**. The task stays in place while the next version runs. Earlier results, notes and exact approval terms remain accessible. This is a presentation and routing change over existing linked execution records, not a new scheduler or a migration.

The verified Package 5 work was fast-forwarded into local main at `a355fe3`. Nothing has been pushed or installed by this body of work.

## Current state → end state

| Today | End state |
| --- | --- |
| Each feedback revision becomes another task card and URL. | Work and task navigation show one family card, rooted in the original task. Canonical task/chat links stay on that root. |
| Identical sibling revision names clutter the list. | Original task name stays stable. History distinguishes Original, Revision 1, Revision 2 and their actual state/result. |
| The original says done while a revision waits or runs elsewhere. | The card and focused chat reflect the relevant current execution, including approval, live work, hold, failure and evidence problems. Active revisions say Revising when actually running. |
| Chat follows an execution ID, making revision context fragmented. | One root task conversation retains existing family messages/drafts. Model context identifies the current execution for actions without broadening permission. |
| Positive reviewer notes offer another revision. | Plain user feedback and reviewer problems are actionable by default. Informational notes and questions remain visible as review detail; they do not automatically create work. |
| Long paths/hashes in inherited feedback overflow a phone. | Exact feedback wraps without clipping, omission or horizontal page overflow. |

## Boundaries and design

1. **Reuse lineage.** `revisionAncestryStatus`, `revisionSourceOf`, `revisionsFromRun` and the existing source-bound briefs remain authoritative. Keep task/run IDs, source commits, note batches, sealed artifacts and existing approval machinery unchanged. Never infer family membership from title strings. Do not update historical records just to simplify the display.
2. **One read projection.** Add the smallest bounded, permission-aware family/current-version lookup needed by Work, task navigation, focused chat and history. Admission must bind before pagination and grouping. Hidden projects or unrelated roots must not leak through counts, version selection, redirects or chat history. Missing/cyclic/cross-project lineage fails closed with a useful state; no arbitrary fallthrough to another task.
3. **Truthful current work.** Reuse the existing dispatch/status/receipt projection for the chosen execution, while using the root's user-facing identity. A new waiting/live/failed revision must not wear an old result's Done badge. Legacy sibling revisions may exist: retain all in history, use a deterministic current selection, and visibly acknowledge other active work rather than silently hiding it. This does not require serializing workers or changing scheduler policy.
4. **Stable navigation, exact mutations.** Root task/chat URLs are canonical; old child/run links still resolve to the right version. A compact History disclosure/version selector opens exact prior results, diffs, screenshots and reviews. Selecting an old result must not change the current task's action target. Forms keep exact execution/run/scope/batch identifiers and native stale-state checks. Do not redirect a stale POST to the newest execution or turn canonical routing into an authorization bypass.
5. **Conversation continuity.** Keep user/session/project isolation and retry receipts. Preserve the root draft across result/history navigation and revision creation. Existing child messages remain reachable in the same family conversation without modifying their stored content or duplicating messages. Chat actions and approvals clearly bind to the actual current execution; the unified fleet chat must not reintroduce duplicate family cards or claim an old result is current.
6. **Revise in place.** Normal feedback and diff annotations feed the existing exact-batch seal. Redirect to the same root context, showing the new version's approval/action. Display fresh exact terms inline when approval is required; existing explicitly authorized automatic modes retain their own rules. No inherited approval, silent escalation, scope broadening, extra password workaround or new permission default.
7. **Actionable feedback.** Keep reviewer observations and user feedback intact. Informational reviewer `note` and `question` entries should not produce the default Revise CTA/count or silently enter a requested-change batch. `problem` and user-requested feedback do. If the user deliberately wants a reviewer question turned into work, expose a clear small action/selection using existing mechanisms; never discard a finding or mark it resolved merely to remove a button. Preserve exactly-once seal/retry and later-batch behavior.
8. **Small UI.** Short title, current outcome, one primary action, History on demand. No second workflow/mode switch or introductory paragraph. Wrap long inherited note paths and hashes. Use 44px phone targets, intact short labels, visible focus and reduced-motion-compatible transitions already in the app.

## Implementation scope

- Prefer existing `store.ts`, `serve.ts`, `workspace-ui.ts`, their tests and current mate/result helpers. A small read-only helper is fine if it genuinely reduces duplication, but do not create a generic workflow framework.
- Reuse `scripts/workspace-result-proof.mjs` and `scripts/ui-polish-fixture.mjs` for the journey; extend the existing chat script only when a concrete uncovered interaction requires it. No overlapping browser suite.
- Leave public operational CLI task IDs and execution records intact. Task management UI must group families; diagnostic run/queue views may show individual executions when explicitly labeled as such.
- No database migrations, provider/permission changes, new agent time limits, dependencies, unrelated chat transport repair, publication or installation. Do not modify native evidence/reviewer code or weaken admission checks to make the UI pass.

## Acceptance and lean verification

Use one desktop (1400×900) and one phone (390×844) journey. Create a task/result, submit ordinary plus annotated feedback, create and run Revision 1, review it, then create and run Revision 2. Verify one root card/link and stable conversation; exact version-specific diffs/screenshots/notes; fresh approval; correct live/failure/completion state; immutable earlier results; and preserved drafts through Back/reload. Include long annotation paths/hashes, empty/actionable/informational feedback, a damaged screenshot and a held/failed revision. Label synthetic fixtures honestly.

Focused regressions must cover family grouping before limits, visibility and unrelated-version refusal, legacy sibling/current selection, revision-of-revision, exact mutation targets, lost-response replay and later feedback, and informational review notes not creating revisions. Reuse relevant tests; run typecheck plus changed-behavior tests during implementation. For a CSS-only adjustment, rerun its affected browser check, not all repository suites.

Only the native final gate runs the unchanged approved full command once for the committed candidate. Root will inspect screenshots/source, request native Opus review and exercise the actual result/revision flow. Do not claim those root steps or two live model-built revisions occurred until independently observed. Record any remaining gaps in `docs/assessments/SAME_TASK_REVISIONS_RESULT_2026-09-14.md`.
