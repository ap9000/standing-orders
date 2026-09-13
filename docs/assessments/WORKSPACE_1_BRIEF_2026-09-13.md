# Package 1: one navigation shell, truthful status

Implements package 1 of [the approved workspace experience plan](WORKSPACE_EXPERIENCE_PLAN_2026-09-13.md). Package 0's verified result must be the base. Preserve the completed UI polish and database-test fix. This brief is prepared before execution; it does not itself approve a task.

## Visible outcome

The same product becomes simpler to navigate and more honest about results. Three primary destinations on desktop and mobile: **Chat, Work, Projects**. Settings remains secondary. Task, run, and review pages stay functional and bookmarked URLs keep working.

### Navigation

- Work has All (default), Needs you, Running, and Completed views over existing records, not new persisted states. Display a clear active view and meaningful empty state. Keep queued, paused, failed, and cancelled tasks findable in All; do not silently truncate without a visible bound or pagination.
- Lead Work rows with the human-readable task title. Keep the stable task ID secondary or in details, rather than making a slug compete with the title. Show the project label when rows span multiple projects. Prefer clean rows and dividers over another grid of nested cards.
- Preserve board/list/order tools, recipes, routines, portfolio, and action ledger under a Work tools menu. Preserve fleet, requirements, people, operating mode, and system under Settings navigation, subject to the current role/project restrictions.
- Do not simply remove old navigation and leave the tools inaccessible. `/`, `/tasks`, `/board`, `/runs`, `/done`, `/review`, `/activity`, `/t/<id>`, `/r/<id>`, and task-focused chat must still work, including query parameters and selected-result anchors.
- The existing collapsed desktop rail, mobile project switcher, keyboard access, and prominent Add project CTA must survive.
- Independent 390px baseline screenshot `output/playwright/workspace-1-before-tasks-mobile.png` shows the task-list introduction overflowing on the raw repository path. Prefer the project label in ordinary copy and wrap any necessary technical paths; cover long repository names and paths without document overflow.
- Keep one project selector in the visible chrome. A filter does not expand admitted projects, change signed scope, or submit pending text.
- Observed on the installed baseline: a direct `/r/1542` link from All projects redirected to `/projects` until a project was selected. Cover this in regression tests and provide a coherent authorized deep-link path. Do not remove project authorization to make the redirect disappear.

### Truthful status

Reuse `taskViewData`, `taskChatFocus`, dispatch diagnoses, completion receipt facts, criterion matrix, and publication records. Use a shared pure display projection if needed. Do not add a second lifecycle or use the agent's narrative as evidence of success.

- Raw `task.state=done` with failed or missing proof must not show an unqualified Done/Verified/Shipped badge in the touched task, chat, Work, and review/result surfaces.
- Use precise plain English: Changes saved, but checks failed; Result saved—verification needed; Ready to review; Accepted with an exception; PR opened; Merge observed.
- Distinguish agent-reported evidence from independently verified checks. Explicit acceptance does not transform weak evidence into verified evidence.
- Do not call local changes shipped or deployed. Rename the existing unconditional What shipped receipt heading. Publication/merge is observed independently; deployment stays unconfirmed unless an actual record supports it.
- If a real reason is available, explain it in one sentence with the appropriate next action. Do not invent a root cause, an automatic repair, a retry time, or a completion percentage.
- Say checks failed only when machine/check evidence establishes that. A generic conflicting-evidence verdict can also mean invalid or mismatched evidence; do not translate every such verdict into a failed test claim.
- Completed must not silently treat unresolved failed/missing proof as success. Keep accepted exceptions visibly distinguished. Needs you should use the existing diagnosis/action semantics, not every queued task indiscriminately.

### Appearance and limits

Keep the current server-rendered implementation, typography, and useful tokens. Use restrained neutral status treatments, whitespace, and dividers rather than another stack of cards. Keep primary actions clear, the sidebar retractable, and phone controls well spaced. Do not redo the composer/approval/revision interaction architecture; those are later packages. No new runtime or animation dependency.

## File scope

Expected implementation: `src/serve.ts`, `src/dispatch.ts`, and a small `src/workspace-ui.ts` helper only if useful. Tests: `src/serve.test.ts`, `src/dispatch.test.ts`, `src/workspace-ui.test.ts`, and `src/telegram-status.test.ts` only when shared diagnosis copy changes require parity updates. Existing browser fixture/proof scripts may be extended; a dedicated `scripts/workspace-proof.mjs` is acceptable. Record results in `docs/assessments/WORKSPACE_1_RESULT_2026-09-13.md`. No store schema or authority changes.

## Required proof

1. Desktop and phone have only Chat/Work/Projects as primary destinations, while existing secondary tools remain reachable under the correct role/project ceiling.
2. Work views, counts, empty states, and active navigation are correct, including legacy deep links and multiple projects.
3. Same-run statuses agree across Work, task chat, Details, and Review for verified, failed-check, missing-proof, agent-attested, accepted-exception, queued, cancelled, and published fixtures. Old failed evidence is not overwritten by a newer result's display facts.
4. Full unchanged approved repository verifier passes. Keep prior approval, both revision modes, draft/duplicate-send, and mobile regression coverage. Update obsolete navigation-label assertions without dropping behavioral coverage.
5. Exact viewport screenshots: 1440×900 desktop and 390×844 phone, plus 320px overflow checks. Include populated Work, empty Work, Needs you, navigation/tools access, and a failed-verification result. Capture a new empty conversation independently at 1280×800 and 1440×900 to retain the previous composer fix.
6. Use the isolated seeded fixture for mutations, never real tasks for cancellation/approval UI testing. Label fixture data synthetic. Report screenshot paths, check commands, payload delta, limitations, and exact final revision. Preserve original failed checks when repairing the implementation.
7. Put generated browser reports and screenshots under ignored `output/playwright/`, and reference them through the normal proof artifact mechanism. Do not add generated evidence directories or extra helper programs to the source diff outside the agreed paths. The existing committed UI evidence remains historical; do not overwrite it.

Out of scope: publishing, deployment, installation changes, global settings/model/permission changes, authentication changes, new spending, schema migration, new agent engine, or full packages 2–5.
