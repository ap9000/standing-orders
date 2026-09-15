# Result and feedback refinement

Scope: the shared result panel in chat, build details and review. No new dependencies, paid services, approval changes or deployment.

## References reviewed

The [linked post](https://x.com/heydetya/status/2099562601978220976) says seven tools but links six. X blocked direct retrieval; its public text was retrieved through FxTwitter, then the original resource sites were inspected.

| Resource | What informed this pass |
| --- | --- |
| [Interface Craft](https://interfacecraft.dev) | Its public **Refining a Task App Interface** walkthrough: consistent left edges, less toolbar framing, secondary controls left and the main action right. Public preview only, not the paid library. |
| [Devouring Details](https://devouringdetails.com), [Rauno's public essay](https://rauno.me/craft/interaction-design) | Comfortable targets, interruptible interactions, restraint for frequently repeated motion. Paid chapters were not accessed. |
| [Rams](https://www.rams.ai) | Public examples of competing CTAs, accessible labels, contrast and motion checks. No automated Rams score was requested or claimed. |
| [Kobra button](https://kobra.systems/components/button) | Public states and composition documentation. No paid source copied, no React/shadcn migration. |
| [Transitions](https://transitions.dev) | Reuse the existing native disclosure enhancement for result notes, build details and file attachment. |
| [Kinetics](https://kinetics.colorion.co) | Surveyed spring examples; did not add another animation system or decorative bounce. |

## Before → after

- Repeated saved/verification status and generic warning → shorter visible **Verification needed**, with the generic duplicate omitted only when the status already names it. Specific failures, missing/damaged records, caveats and approval safeguards remain. Checks still contains verification details.
- Feedback title, repeated prompt, tall stacked controls → one heading, an accessible input, file attachment left and **Save note** right. The existing 500-character counter remains.
- Muted result headings and uppercase feedback label → clear foreground headings and sentence case.
- 36–40px disclosure targets → 44px targets; consistent subtle disclosure motion, preserved drafts and reduced-motion support.
- “that line number is not a line number” → an explicit allowed range and the option to leave it blank. File-path error also names the constraint.

## Verification

Candidate: changes in the commit containing this document, based on `6c12fc1` on `codex/native-chat-flow` in the isolated checkout. The installed checkout/database were not changed.

- Typecheck and build passed.
- 35 distinct focused tests passed: result-review (12), workspace-motion (4), and 19 selected server tests. The latter include concise status, note limit/counter, shared evidence, damaged evidence, chat feedback, revisions, refusal recovery and applicable actions. Existing tests were reused; one concise-status regression was added. No full suite was run or waived.
- Real Chromium at 1400×900 and 390×844: inspect Changes, save feedback, request a same-task revision, arrive at Review plan with approval still required. Disposable database and synthetic build evidence; no real agent build or publication.
- Phone: 269-character note and file/line target survived an invalid-line refusal and the return link, then saved successfully. Long note wrapped; page width stayed 390px. Desktop page width stayed 1400px. Diff content scrolls inside its own viewport.
- Affected tabs, attachment summary and Save note measured 44px tall. ArrowRight switched result tabs. Reduced-motion and interrupted disclosure behavior covered by focused tests and browser inspection.
- Before/after screenshots are viewport captures, not stitched full-page images. Feedback now fits above the phone navigation in the empty-note state; desktop panel is shorter by roughly 100px in this fixture.

Evidence in `output/playwright/`: `resources-{desktop,phone}-{before,after}.png`, `resources-phone-feedback.png`, `resources-{desktop,phone}-revision.png`, `resources-phone-error.png` and `resources-phone-error-after.png`.

Limits: no physical phone, iOS keyboard/Safari or Windows check; no paid library audit or independent design score. Invalid input still uses the existing separate refusal page with a return link; inline validation is a possible later refinement. Existing chat-only action gaps are unchanged.
