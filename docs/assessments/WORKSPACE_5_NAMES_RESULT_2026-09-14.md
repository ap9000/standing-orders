# Package 5 pilot 3 — recognizable revision names

Human task titles now lead task details and navigation. Exact task ID, project and filing provenance are inside the existing, initially closed **Task options** disclosure. This revision addresses build #1581 comments 191/204, as explicitly triaged by comment 205. The reviewed deterministic naming implementation remains unchanged.

| Surface | Before this revision | After |
| --- | --- | --- |
| Task heading | A long technical ID appeared above the human title. | The human title is first, followed by the current status and primary action. |
| Desktop task navigation | Each name repeated its ID below it. | Each link shows one human name; its exact destination and selected state are unchanged. |
| Exact identity | Always displayed above the title. | Task options exposes the complete ID and filing provenance, opens and closes by keyboard, and wraps long IDs. |
| Revision source and consent | Source task/build links and exact feedback appeared in scope details and approval terms. | Those links, notes and approval terms remain intact. Each new revision still needs fresh approval. |
| Failures | Status, incidents and the property rail named failures. | These remain visible; the duplicate failed-attempt count was removed from the identity row. |

The existing title generator uses the human parent title plus one “ — revision” suffix for ordinary, annotated and mixed batches. Mixed and ordinary batches say “feedback”; annotation-only batches say “annotations” in the source detail. Canonical validation, whole-grapheme limits, repeated-suffix removal and deterministic missing-title fallback are unchanged. The existing legacy input to sealRevision still generates IDs; the display-title update remains within the enclosing store transaction. No IDs, historical rows, schema, lineage, routes or approval rules were changed.

## Signed acceptance

| ID | Statement (verbatim) | Evidence |
| --- | --- | --- |
| names | Ordinary, annotated and mixed-feedback revisions get the parent's human title with a correct source detail. mixed batches say feedback, not annotations. | The existing three-mode HTTP regression and browser journey check exact titles, source wording and links. Added assertions pin title-only navigation and initially collapsed identity. Production change: src/serve.ts. |
| limits | Titles respect the canonical Unicode-safe limits for repeated revisions (revision of a revision) and fall back deterministically when the parent title is missing. | Existing ASCII, astral, combining, repeated-suffix, blank and unavailable-title tests pass through three linked generations, including canonical validation and Unicode round trips. |
| lineage | Exactly-once retry and later-batch lineage are unchanged, with focused regression tests and desktop plus 390px screenshots of the named revision. | Existing retry, concurrent seal, later-batch, custody and fresh-approval tests pass. The reused browser journey exercises missed responses and later batches at 1400×900 and 390×844; named-child screenshots show the current UI. |

All three criteria are submitted as pending-verification: builder checks and inspection are complete; the unchanged approved full verifier belongs to the native final machine gate. It was not run by this builder.

## Checks and candidate

- npm run typecheck — passed.
- GIT_CEILING_DIRECTORIES="$PWD" TMPDIR="$PWD" npx vitest run src/serve.test.ts src/revision-terms.test.ts — 320 passed, zero failed. This runs the existing build setup. The final subsequent source change only increases the Task options summary target from 36px to 44px; unchanged behavioral evidence is reused in this session.
- npm run typecheck && npm run build — passed on the final source, supplying the fixture with current production code.
- GIT_CEILING_DIRECTORIES="$PWD" TMPDIR="$PWD" node scripts/workspace-result-proof.mjs --revision-names --strict --out output/playwright/workspace-5-names > output/names-browser.log 2>&1 — 110 passed, zero failed on the final source.
- git diff --check && git diff --exit-code HEAD -- src/store.ts src/task-text.ts src/scope.ts src/revision-terms.test.ts scripts/ui-polish-fixture.mjs — passed. Store, canonical validator, scope, revision-terms tests and fixture remain unchanged.

The updated task-page regression failed on the reviewed base because the ID still led the heading. The first browser pass found a 36px disclosure target; a local CSS adjustment made it 44px, and the same affected browser script passed on rerun. No assertion was removed or weakened. The first redirected browser launch required creating output/ before it could start. Initial browser output is retained separately under output/; no model run was involved.

Branch: standing-orders/revise-give-revisions-recognizable-names-from-15-annotat. Unmoved HEAD/base: 7c813e09cb0b55f2440c7c2c5172cba74e50f615. Implementation fingerprint: 08ebc4739f2c5040f904cf7cd22db88bee0c09772187b64b6d6725586727e3ab (SHA-256 of compact JSON containing sorted path/sha256 objects for src/serve.ts, src/serve.test.ts and scripts/workspace-result-proof.mjs). Documentation and protocol/evidence artifacts are excluded from that fingerprint. All changes remain uncommitted.

## Browser inspection and simplicity pass

The existing result proof script covers one desktop and one 390px journey: open the result from chat, inspect Changes and Checks, leave ordinary/annotated/mixed feedback, create revisions, inspect full terms and approve each child independently. It also checks chat/review draft recovery, consumed-feedback empty state, rejected-input recovery, long Unicode titles, source links and visible damaged evidence. No duplicate browser suite or new timeout was added.

Default task views now begin with a recognizable name, current state and **Review plan**. Task options is closed, exact identity is hidden, and desktop sidebar links show only their human titles. Keyboard activation reveals the complete ID with a visible focus outline; a second activation closes it. The disclosure target measures 44px. At 390px the ID wraps within 296px and the 182px-tall long title fits its 326px column without horizontal overflow. Short action labels stay on one line and primary revision/approval actions clear the fixed navigation. Existing sidebar ellipsis is confined to compact navigation; full titles remain available in the task and Work views.

Inspected actual viewport captures include collapsed and expanded named revisions, long-title details, Work cards, rejected-input forms, approval terms and damaged-evidence states. The failure explanation remains in the open. No new heading, explanatory paragraph or competing default action was added to the product.

Evidence: output/playwright/workspace-5-names/report.json and PNGs in that directory. The proof includes these eight images:

- desktop-named-revision.png and phone-named-revision.png — title-first mixed revision, identity collapsed, fresh approval required.
- desktop-named-revision-details.png and phone-named-revision-details.png — full unchanged task ID exposed by keyboard.
- desktop-long-named-revision.png and phone-long-named-revision.png — complete bounded Unicode heading.
- desktop-names-evidence-failure.png and phone-names-evidence-failure.png — visible evidence failures.

## Execution limits

All browser data is synthetic: an isolated SQLite fixture, throwaway repository, ephemeral approver and scripted runner. Screenshots are actual headless Chromium viewport captures, not generated images or physical-device tests. No native child build, Safari or unfamiliar-user testing is claimed.

Root retains native Opus review and actual result inspection; this builder does not claim those external steps occurred. There were no subagents, model calls, dependencies, new timeouts, commits to this worktree, branch switches, merge, push, deployment, signing or publication. No remaining builder gap was found in the signed criteria.
