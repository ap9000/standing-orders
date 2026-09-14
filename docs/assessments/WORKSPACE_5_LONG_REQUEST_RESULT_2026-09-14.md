# Package 5 pilot 1 — long requests can be revised

Implemented on `standing-orders/workspace5-long-request-revisions-20260914`. All changes are uncommitted; HEAD remains the required base, `1a08e43688daeb35f8b4a1e26be2a4cf1c3b277f`. The native worker owns the commit and final repository gate. Proof criterion c5 is `pending-verification`.

## Exact before and after

The synthetic legacy regression seeds the same scope primitive the old CLI used, then approves it and stamps its source run. Its goal is 6,004 UTF-16 code units / 9,004 UTF-8 bytes; its exclusions are 7,504 units / 10,204 bytes. Both include Japanese, accented text, astral emoji, decomposed accents, newlines, and leading/trailing spaces.

Before the implementation, `npx vitest run src/revision-terms.test.ts -t 'legacy long Unicode'` failed both plain-note and annotated cases with `{ "ok": false, "reason": "bad-goal", "detail": "the revision task could not be filed: bad-goal" }`. This was an observed failure, not an inferred outcome. The permanent tests now require successful sealing, byte equality of the inherited goal prefix and exclusions, the entire appended repair, exact lineage, unchanged parent scope, and fresh child approval. They also exercise the no-comment CI repair through the same boundary.

| Boundary | Before | After |
| --- | --- | --- |
| New scope text | CLI scope edits bypassed the proposal limits; web edits checked fewer controls. | Filing, CLI scope, guarded web edits, chat tools, and coordinator proposals share task-text validation. |
| Linked revision | The combined inherited goal plus repair faced the new-request length cap; insertion trimmed the goal. | `sealRevision` proves source/run/digest, ancestry and brief custody, validates only the new title/repair, and uses a runtime-private insertion method to retain inherited bytes. |
| Exclusions | Old CLI exclusions could exceed the new-input cap; public store creation did not check exclusions. | New exclusions are checked; exactly inherited exclusions are retained without truncation or normalization inside the seal. |
| Rejection | Source inspection showed the web error response rebuilt the editor from stored terms and discarded submitted values. | Submitted goal, exclusions, paths, rubric and settings remain in the editor; the stored scope and approval card remain separate. The error appears once, beside the focused editor. |
| Unicode web transport | The 16 KiB encoded-body cap produced an observed HTTP 500 / `body too large` before field validation. | Only authenticated task creation/scope forms admit up to 256 KiB of encoded input; canonical field caps still apply. A 1,000-emoji goal plus 2,000 CJK exclusions files and edits successfully. |
| Revision approval action | Browser inspection found the action below the required 44px height. | The task approval button is 44px and its short label stays on one line. Approval semantics are unchanged. |

## Policy and custody

New goals and exclusions keep the existing 2,000-character policy, explicitly measured as JavaScript UTF-16 code units: 1,000 astral emoji fit; 1,001 do not. The separate 8,000-byte UTF-8 bound is retained. At this character cap it is redundant for ordinary Unicode strings, but remains an explicit storage check. The existing control/disguised-text predicates are unchanged; LF and tab remain allowed. Validation precedes trimming of new goal/exclusion input. Optional empty exclusions remain allowed. Existing chat credential checks still run.

There is no `legacy`, `inheritLegacy`, provenance-based, or other caller-selected validation exception. The public proposal and store creation doors validate all new text even if a caller supplies revision-looking metadata. The only less restrictive insertion method is a JavaScript `#` private method. `sealRevision` derives inherited terms from the source rows after the existing custody checks; its new repair remains subject to normal text limits. Acceptance validation, backlog admission, savepoint rollback, source/run binding, comment consumption, route resolution and approval handling are retained. No database schema, global configuration, permission, migration, or existing approval is rewritten.

## Checks and candidate

- `npm run typecheck` passed.
- `npm run typecheck && npx vitest run src/task-text.test.ts src/proposal.test.ts src/revision-terms.test.ts src/scope.test.ts src/operate.test.ts src/mate.test.ts src/mate-doors.test.ts src/coordinator-proposals.test.ts src/mcp.test.ts src/mcp-cli.test.ts src/serve.test.ts` passed: 557 tests in 11 affected suites.
- After the final editor-settings and error-contrast repair, `npm run typecheck && npx vitest run src/serve.test.ts` passed: 293 tests. The other tested implementation paths did not change.
- `node scripts/workspace-result-proof.mjs --long-requests --strict --out output/playwright/workspace-5-long-request` passed: 47 assertions, with one desktop (1440×900) and one phone (390×844) journey. The fixture is synthetic throughout.
- `git diff --check` passed. The approved full repository verifier was not run by this builder.

The final implementation fingerprint is `29be0466ca0110353dfdbc76fb4494b6f17858ee83bd2e684f250087122ed30b`: SHA-256 of compact JSON containing sorted `{path, sha256}` entries for the 19 changed/new files under `src/` and `scripts/`. This excludes this assessment and the protocol/evidence artifacts, avoiding a self-referential hash. The machine must bind its own gate to its committed candidate.

The durable regressions cover both feedback modes, exact Unicode terms, invalid new repairs despite a valid legacy source, public-door metadata smuggling, controls, character/byte boundaries, web draft recovery, and valid Unicode transport. HTTP tests replay both notes and seals, then replay an old seal after later feedback and seal that later batch separately. Existing custody, concurrent-seal, fresh-approval and chat/MCP boundary suites remain in the affected run.

## Browser and simplicity pass

Each viewport opens the result from chat, inspects Changes and Checks, retains an unsent chat draft, reloads a review draft, submits ordinary feedback, and creates/approves its linked revision. The later batch combines a new ordinary note with an annotation selected from the actual diff. Both note and seal responses are deliberately missed and retried. Each batch yields one child; the older seal leaves later notes live. The children retain the full approval terms and their own digest. No builder is run on these fixture children.

Empty feedback fields remain editable after consumption. Long notes, long inherited goals/exclusions, rejected authoring input, keyboard access, 44px revision/approval actions, fixed navigation and document overflow are checked. The rejection changed from a technical reason away from the draft to one field-specific sentence beside it: “Goal must be 2000 characters or fewer.” The error text uses the normal foreground for readable contrast. Rejected drafts are not labeled as templates, and correction saves normally. Full approval terms stay available before consent.

Eight real viewport screenshots are under `output/playwright/workspace-5-long-request/`: `desktop-long-result.png`, `desktop-long-feedback.png`, `desktop-long-approval.png`, `desktop-long-rejected.png`, and the corresponding four `phone-` files. `report.json` records the 47 assertions. Screenshots were inspected for wrapping, alignment, error visibility and navigation overlap; they are browser screenshots of synthetic data, not generated mockups or model-run evidence.

## Execution receipt and limits

This is the one isolated builder attempt. Local test/fixture corrections are recorded above; no subagents were used. The lease identifies runner `workspace5-pilot-20260914` and group `0774c645-ad9a-4d83-9efb-eca6506656c5`. The native ledger, rather than this assessment, owns the actual task/run ID, scope digest, provider/model/auth stamp and eventual commit SHA. No model or auth configuration was changed or inferred from project defaults.

The two earlier real chat drafting attempts failed before filing; root filed this task through the regular UI. This work does not claim autonomous chat success, repair chat transport, or claim an actual native child build result. Root still owns inspection of the actual result and the requested Opus review. The browser proof uses headless Chromium with a 390px viewport, not a physical phone or Safari; the broader pilot assessment's physical-device and unfamiliar-user gates remain outside this task. No merge, push, signing, deployment or network write was performed.
