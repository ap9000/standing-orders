# Quieter Telegram progress — 2026-09-16

Apply prepared commit `2acaf853e6b07060081c547e23a24faf37fdcc84` from verified installed base `9fcdbc08e8a39ee3028972544625b7da725cf0db`. This input commit contains the durable evidence; the prepared commit contains only the four implementation/test files named in the manifest. Apply it without importing unrelated files. Preserve the existing signing, independent review and final machine gate. Do not rerun the full suite in the builder or independent reviewer; the native final machine gate runs the unchanged approved command once for the final candidate. Focused checks are already recorded; repeat only if implementation changes.

## Problem and outcome

The user's Telegram screenshot shows four consecutive messages: built, review requested, review started, review finished. Every message repeats a long project/task identifier and the same Review result action. Routine immediate-mode lifecycle facts now update one confirmed message per builder result, including that result's root independent reviewer. The card leads with the readable task title, exact attempt number, saved build/check/review progress and one result link. The check fraction counts passing saved acceptance-matrix rows; it is not a percentage of work or an ETA.

Required and optional review stay distinct. An optional review does not become a new blocker. Missing checks, evidence gaps, uncertain/contradictory reviews, strict coverage shortfalls, stopped work, human acceptance and publication remain separate facts. Nothing in this change accepts, publishes, merges or installs work. Full evidence, risks and acceptance terms stay in the existing signed-in result screen and evidence packet.

## Delivery invariants

The existing outbox, destination receipts and confirmed outbound message history remain authoritative; there is no schema change or new scheduler. Reuse is limited to routine messages naming only this builder result and its root reviewer in the same pairing/generation. Mixed digests, decisions, images and other attempts cannot be overwritten. Confirmed history survives restart or a lost final acknowledgement. Uncertain edits and rate limits retry the same message; only a definitive missing/uneditable response allows a replacement. Access, pairing, generation, claim, project and order fences run before the network call and again before acknowledgement. Replies to the edited card normalize root reviewer provenance to its exact builder result, without losing the underlying event records. Digest cadence and its urgent flush remain as before. Decisions, failures and acceptance evidence keep their own alerts; those paths refresh an existing progress card without replacing the alert. Routine edits are quiet; this is not a new completion-paging or Telegram notification-settings system.

## Verification and simplicity pass

- Typecheck and build pass. The four focused suites passed 161 tests. The final affected lifecycle suite passed 26 tests after the last status wording change. Seven new regressions cover one message across build/review and restart, exact reply identity, uncertain/unchanged edits, deletion replacement, new attempt/pairing boundaries, rate limits and in-flight revocation, mixed digest and failure alerts, acceptance/evidence gaps, and optional versus required review. Existing tests were updated for shared message receipts; no test cases were deleted or skipped.
- Browser previews at 1440x900 and 390x844 cover reviewing, completed review, long title, missing evidence, failed evidence and stopped work. Exact generated messages are in `cards.json`. Every preview fits its viewport; the single link is 48px tall and keyboard reachable. The preview controls are test controls, not new product UI. Screenshots are visibly labelled synthetic.
- At both desktop and phone widths, followed a generated exact-result link into the existing console, inspected changes, saved realistic feedback, then requested a revision. Each returned to Needs your approval with its revision identity; neither approved nor dispatched it. The console files are unchanged from the verified base. Receipts and screenshots are committed here.
- Removed repeated failure wording and a redundant next-step sentence. Replaced the long task slug with a bounded, scrubbed human title; retained project and exact attempt identity. Remaining requirements and failures stay visible. No approval terms were shortened.

## Limits

These are browser previews of the Telegram text and its real console links, not captures of the native Telegram client. Physical iPhone/Safari layout, notifications and background behavior have not been tested. Do not describe these images as native Telegram proof. Live Telegram delivery can be confirmed by the operator after the candidate passes its normal machine gate/review and is installed. Prepared source hashes and every screenshot hash are recorded in `manifest.json`.

Telegram's official text-edit API reference: https://core.telegram.org/bots/api#editmessagetext . No new rich-message feature or version-specific capability is required.
