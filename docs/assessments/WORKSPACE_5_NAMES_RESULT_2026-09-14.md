# Package 5 pilot 3 — recognizable revision names

New feedback revisions use the parent's human title with one ` — revision` suffix. Ordinary and mixed batches say `feedback` in the repair detail; batches containing only annotations say `annotations`. The source task, build, immutable brief and exact notes remain available in details. This is a presentation change in `src/serve.ts`, with no model call, dependency, storage-engine or schema change.

| Case | Before | After |
| --- | --- | --- |
| Ordinary feedback, parent “Mobile project switcher” | `Revise t-rev from 1 annotation on build #1` | `Mobile project switcher — revision`; detail says `apply the feedback recorded on build #1` |
| Annotated feedback | Same internal-ID headline | Same human title; detail says `apply the annotations recorded on build #1` |
| Mixed feedback | `Revise t-rev from 2 annotations on build #1` | Same human title; detail says `feedback` |
| Revision of a revision | Technical task IDs nest into the headline | The subject retains exactly one suffix, through three tested generations |
| Empty or unavailable human-title lookup | Internal task ID in the headline | Deterministic `Task — revision`; source identity remains intact |
| 200-unit parent title | No recognizable parent subject | Space reserved for the suffix; whole graphemes retained within the canonical limit |

The existing store slugs its input title to generate an ID. The route therefore passes the unchanged legacy title into `sealRevision`, then sets only the newly created row's validated display title inside that same transaction. It does not copy the ID algorithm, introduce another ID namespace, update historical rows, or change the early retry return. Exact ID and collision-suffix assertions cover the first and later batches. The source scope, comments, brief format, lineage and approval machinery are unchanged.

The new title reserves the suffix within `TASK_TEXT_LIMITS.title`, walks whole graphemes using built-in `Intl.Segmenter`, and passes `validateTaskText`, including its UTF-8 byte and hidden-character rules. Existing generated suffixes are removed before bounding the subject. HTTP regressions cover ASCII, astral emoji and combining marks, three actual linked generations, blank titles and a simulated unavailable title lookup. A valid source task/run is still required; the fallback bypasses no custody check.

## Signed acceptance

| ID | Statement (verbatim) | Builder evidence |
| --- | --- | --- |
| names | Ordinary, annotated and mixed-feedback revisions get the parent's human title with a correct source detail. mixed batches say feedback, not annotations. | Existing HTTP revision tests now cover all three batches, exact title and repair text, source links and unchanged IDs. Production change: `src/serve.ts`. |
| limits | Titles respect the canonical Unicode-safe limits for repeated revisions (revision of a revision) and fall back deterministically when the parent title is missing. | Six parameterized HTTP cases exercise three generations each; canonical validation and UTF-8 round-trip assertions pass. |
| lineage | Exactly-once retry and later-batch lineage are unchanged, with focused regression tests and desktop plus 390px screenshots of the named revision. | Existing retry, concurrent seal, later-batch, custody and fresh-approval tests pass. Real viewport captures show the named child at 1400×900 and 390×844. |

All three criteria are submitted as `pending-verification`: builder checks and evidence are complete; the unchanged approved full repository verifier belongs to the native final machine gate and was not run here.

## Checks and candidate

- `npm run typecheck && npm run build` — passed; supplied current production code to the fixture.
- `GIT_CEILING_DIRECTORIES="$PWD" TMPDIR="$PWD" npx vitest run src/serve.test.ts src/revision-terms.test.ts` — 320 passed, zero failed across the two existing affected suites.
- `GIT_CEILING_DIRECTORIES="$PWD" TMPDIR="$PWD" node scripts/workspace-result-proof.mjs --revision-names --strict --out output/playwright/workspace-5-names > output/names-browser.log 2>&1` — 86 passed, zero failed.
- `npm run typecheck && git diff --check && git diff --exit-code HEAD -- src/store.ts src/task-text.ts src/scope.ts && git rev-parse HEAD` — passed after the final source/test edits; the canonical validator, store and scope implementation are unchanged.

The nine new naming cases failed against the old implementation before the production edit. During verification, a test-fixture edit incorrectly assumed every source lookup existed; it was corrected to retain the original seal input and custody refusal test. Temporary directories inside this checkout also inherited its Git root; setting the Git discovery ceiling kept fixtures isolated without changing the test. The browser journey needed to open the current “Review plan” disclosure, select the specific scope error, and use the Work card's actual task link. Final checks above pass with these corrections; no test or approval safeguard was weakened.

Branch: `standing-orders/give-revisions-recognizable-names`. HEAD/base remains `bfa520bf3592d6155e1151dc57e7fff5498f8166`. Implementation fingerprint: `5e080cd2a1de95f2c3515881c9251834b7aafa3f91b74fa3260be074f7e81250` (SHA-256 of compact JSON containing sorted `{path, sha256}` entries for the five changed files in `src/` and `scripts/`; documentation and protocol/evidence artifacts excluded). All changes remain uncommitted for the native worker.

## Browser inspection and simplicity pass

The existing result proof script reuses its long-request journey under `--revision-names`; no second browser suite was added. One desktop and one 390px journey open the result from chat, inspect Changes and Checks, submit ordinary, annotated and mixed feedback, create linked revisions, review the exact terms and give each child fresh approval. Missed note and seal responses are retried; replaying an old seal leaves later notes live. Chat/review drafts, inherited Unicode terms, empty feedback after consumption and rejected-input recovery are checked.

The fixture also files a child from a 200-unit Unicode parent and checks its full title on task details, Chat and Work. At 390px, the full heading occupies 182px vertically inside its 326px column, with no horizontal overflow or clipped grapheme. The short title wraps to two lines, while “Review plan” remains a single clear primary action. Revision and approval buttons are 44px high and keyboard reachable; feedback actions stay above the fixed navigation. Existing sidebar ellipsis remains limited to its compact navigation preview; full titles are available in Work and task details.

Viewport images inspected include both named revisions, both long-title details and Work lists, both scope-error states, both damaged-evidence states, and the phone approval boundaries. Text is readable, titles wrap, exact approval terms remain available through normal vertical scrolling, and damaged evidence is named openly. No headings, explanatory paragraphs, controls or CSS were added to the product.

Evidence is under `output/playwright/workspace-5-names/`, with all measured assertions and capture captions in `report.json`. The proof attaches these eight captures:

- `desktop-named-revision.png` and `phone-named-revision.png` — mixed-feedback child, human title, fresh approval required.
- `desktop-long-named-revision.png` and `phone-long-named-revision.png` — bounded Unicode title in task details.
- `desktop-long-revision-work.png` and `phone-long-revision-work.png` — long title in Work.
- `desktop-names-evidence-failure.png` and `phone-names-evidence-failure.png` — visible evidence failure.

## Execution limits

All browser data is synthetic: an isolated SQLite fixture, throwaway repository, ephemeral approver and scripted runner, with no model call or native child build. Screenshot files are actual headless Chromium captures, not generated mockups. No physical device, Safari or unfamiliar-user testing is claimed.

Root still owns native Opus review and inspection of the actual result, including any genuine linked revision required by that review. This builder has not claimed that external work happened or inferred provider/auth facts from defaults; the native ledger owns task/run identity and actual route stamps. No subagents, added timeouts, merge, push, deployment, publication or changes to this worktree's Git history were used.
