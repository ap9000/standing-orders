# One clear way to request changes

Candidate: the commit containing this document, based on `faec3c9`, on `codex/native-chat-flow`. Installed checkout and database unchanged; not deployed.

## Interaction

Previously: type feedback → Save note → find a second form → Request changes.

Now: type a change → **Request changes**. The same form includes any saved notes displayed above it, then opens the existing same-task revision/approval flow. **Save for later** is a quiet secondary action that saves only the typed note and starts no work. It never consumes the saved list.

- One “What should change?” heading. No repeated feedback prompt, separate note-count action card or instructional footer.
- Main action on the right; secondary action on its left. Both have 44px targets and single-line labels. Empty actions are disabled; saved notes enable Request changes without requiring more text.
- File/line targeting stays in its native disclosure, using the existing interruptible motion and reduced-motion handling.
- The upper result link is a quiet jump to the form, not another filled CTA.
- Chat cards use “Request changes” and “Save for later” too. The chat contract now explicitly proposes a revision for a request to change finished work, saves only when asked to defer, and asks when intent is ambiguous. This is prompt guidance, not a claim of perfect model interpretation.

## References applied

[Interface Craft](https://interfacecraft.dev)'s public task-app walkthrough informed aligned controls, removing toolbar weight and placing the main action on the right. [Rams](https://www.rams.ai)'s public examples informed a single primary action and accessible states. [Devouring Details / Rauno](https://rauno.me/craft/interaction-design) informed restraint and usable targets. Existing [Transitions](https://transitions.dev) behavior was reused. No library installation, new animation framework or paid source was needed. See the preceding resource-pass document for the full six-resource survey.

## Safety and verification

The combined action uses the same revision service as chat and existing saved-note submissions. Typed text is stored and sealed in a savepoint: refusal leaves neither a new note nor a revision. Request identity, exact displayed saved-note ids, source terms and verified diff remain binding. Repeated submissions create one revision; later notes from another tab are not silently included. Successful drafts clear only when the server records that exact request; conflicting edits survive and receive a new identity on retry. Approval/automatic-approval policy is unchanged.

- Typecheck and build passed.
- 65 focused tests passed: 53 across result-review, workspace-motion and mate; 12 selected server tests. Added one combined-action regression and one draft/action-state regression, extending existing tests for the changed labels. No full verification suite run or waived.
- Actual Chromium 1400×900: open Changes, type a change, submit directly, arrive at the same task's approval step. Phone 390×844: save a long note for later, add another change, submit both as one revision. Reopening the result showed both submitted notes in history and an empty draft.
- Phone invalid-line request: refused without partial saving, full draft and target restored through the back link, corrected request succeeded. The existing separate refusal page remains; this pass did not introduce inline validation.
- Browser chat with scripted subscription responses: “Save for later” confirmation writes the shared result note; “Request changes” then creates the same-task revision and opens its approval step. Provider interpretation was not tested against a live model.
- Measured page widths stayed 1400 and 390; action heights were 44px, labels unbroken. Primary foreground/background were #fafafa/#171717. Disabled actions visibly dim. Long notes and the empty state were inspected.
- Final filled/empty screenshots cover the final CSS. Behavioral journeys were completed before the last disabled-opacity-only tweak; no behavior changed in that tweak.

Evidence: `output/playwright/clear-changes-desktop.png`, `clear-changes-phone.png`, `clear-changes-phone-empty.png`, `clear-changes-{desktop,phone}-revision.png`, `clear-changes-phone-error.png`. Prior comparison: `resources-{desktop,phone}-after.png`.

No physical iPhone/Safari/Windows test, paid agent build, merge, publication or deployment was performed. No quality score is asserted.
