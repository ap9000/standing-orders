# Independent concise-UI review

Source: Standing Orders build 1548, task `workspace-concise-ui-20260913`.
The observations were made during the draft and retained against sealed
head `2ebfbd659e1d9620fec2f10abbc38d8083350505`. They do not change the
source builder's signed scope or authorize concurrent edits. Four actual
annotations were sealed into the normal native revision
`revise-workspace-concise-ui-20260913-from-4-annotations-`; its explicit
finishing scope is `1b63ec975cfbfd9c0f31ae9f57b4165d`.

## Open Work tools menu overflows a phone

An isolated fixture of the 1548 draft was opened in a real Chromium browser
at 390×844. The reviewer used the Work tools control, not a hidden element.
Its menu measured **left 265.5, right 441.5, width 176 px**; the document
widened to **442 px** on a **390 px** viewport. Moving the compact header's
tools control to the right left its mobile menu anchored at `left: 0`.

Correct the anchor so the entire opened menu stays within the viewport at
320 and 390 px (also check desktop). Preserve the compact header, every
destination, keyboard operation and visible focus. Add an explicit
open-menu regression check; closed-page overflow checks cannot prove this.

## Items still being reviewed

- The draft changes `src/chat-continuity.ts` only to shorten the connected
  status string. That file is not in 1548's declared touched-path list.
  Reconcile this openly before acceptance; do not report it as an in-scope
  source change or change the running run's sealed authority after the fact.
- The initial failed-task phone viewport still appears to repeat the same
  failed-check headline in the page title, status box and receipt before
  the result. Verify the final before/after evidence against the requested
  reduction in repeated task/result introduction, not just Work and Chat.

## Density must exclude fixed navigation

The draft proof reports 5 complete Work rows at 390×844 by comparing row
bottoms to `innerHeight`. The bottom navigation covers y=787–844. An
independent check of the same selected main-project fixture finds **4**
whole rows between the fixed header (bottom y=91) and bottom navigation
(top y=787), with the fourth ending at y=670. The fifth is not wholly
readable above the navigation. Before/after density must use the actually
unobscured content region, and approximate character/line sampling must
be labeled as an estimate. The page genuinely is more compact; an
overstated measurement is not needed to show that.

Keyboard review of the draft passed: clicking a Details summary opens its
diagnosis, Space closes it, and Enter opens it again with focus remaining
on SUMMARY. Document width remained 390 px in both disclosure states.

## Independent finishing-candidate checks

The build 1549 candidate was checked in a fresh isolated browser fixture:

| Open-menu viewport | Menu horizontal bounds | Page width | Destinations visible and inside viewport |
| --- | --- | --- | --- |
| 390×844 | 198–374 px | 390 px | 8/8 |
| 320×740 | 128–304 px | 320 px | 8/8 |
| 1440×900 | 880–1056 px | 1440 px | 8/8 |

Opening Work Details exposes the exact ID `Task csv-parser-matrix`, and
Space closes it again without widening the 390px page. The failed-task
page's heading is now only `Escape quotes in the CSV writer`. Its status
box still says `Changes saved, but checks failed` and names exit 1; the
receipt agrees and `Review the failed check` remains available. The
document remains 390px wide. These measurements were made independently
of the builder's browser script.

The root also reran all five synthetic listing boundary cases against the
built 1549 candidate; all passed. The expanded browser report passes 227
checks, including open-menu pointer/keyboard tests and measured bounds.
Its revised metrics correctly report four fully visible Work rows between
y=91 and y=787 at 390×844, versus three in pre-concise base `a626e87`.
The same function was used to remeasure the pre-concise base, source 1548,
and final candidate; sampled text counts are explicitly estimates.

Final source `aa736caeef5ff7fbae1e57a68376db5532ccb40b` passed its normal
machine-owned verifier at 01:18:09 UTC: 2,813 tests passed, 23 existing
skips, 163 files, 292.30 seconds, plus typecheck and build, exit 0. This
review therefore accepts the concise UI as a local candidate. Physical
Safari keyboard behavior, Windows device acceptance and release
installation are not tested here. Build 1548's original path variance is
retained in the record; follow-up 1549 has no undeclared changed path.

The live database, installed console and primary checkout's product files
were not changed by this review.
