# Send evidence for acceptance in chat

The operator asked to receive the actionable chat branch's acceptance evidence through chat integrations, especially Telegram. The prepared change gives the shared chat assistant a read-only evidence packet and automatically sends Telegram screenshots followed by a review summary and a secure acceptance link when independent review ends with only human review outstanding.

Start at this committed input, based on verified/deployed `e69c46ba84323083d0cdb422abeba0c6e801b3e6`. Apply `git cherry-pick --no-commit 1a280e8807d324aef2f5f1dfc1e6a901aa5d38b5`. The native host owns the final commit. Inspect the prepared change and correct reproduced issues within scope. Preserve the first-attempt base. Do not touch the dirty original checkout, production data, service, credentials, global packages, main or GitHub. The operator owns guarded installation after the exact native gate and independent review succeed.

## Required behavior

- Shared chat reads each requirement, machine verification, reviewer findings, caveats and current file health for an exact task/result. It separates the unchanged machine verdict from recorded human acceptance. Accepted results no longer count as waiting for verification. Conversation summaries disclose shortening; full acceptance terms remain on the signed-in result screen.
- On human-only review completion, the existing outbox sends a summary, up to eight verified screenshots as Telegram documents with separate receipts, then the evidence summary and exact-run acceptance link. Remaining images are disclosed and can be requested. Existing enrolled-project access, approver generation, pairing, retries and ordering remain enforced. Never upload unverified file bytes. Delivery or opening the link accepts nothing. Other shared chat surfaces can read the same packet and open the result; no new Slack or Discord transport is introduced.
- Acceptance links and submitted forms remain tied to the exact current result. A stale result gives a clear recovery screen. Human review says “Accept result” and “Accepted after human review”; evidence failures retain explicit exception wording. Review notes and new revisions stay recoverable and approval is still required before a revision runs.

## Evidence already inspected

The operator ran typecheck and six affected suites: 165 tests passed on the prepared patch (mate, Telegram mate, chat evidence, task notifications, phone status and workspace UI). The two focused server tests for review priority and acceptance actions also passed. Earlier server navigation/card and list-numbering checks passed. The focused transport tests cover immediate/digest delivery, partial upload failure, process restart and per-image receipts; existing evidence tests cover hash corruption, visibility, missing evidence and exact task/run boundaries. The evidence-reader regression shows reads do not accept and corruption remains explicit after an acceptance record.

Actual Chromium journeys at 1440x900 and 390x844 opened the saved result, inspected Summary and Changes, entered realistic feedback and created an unapproved revision. The phone journey also submitted a synthetic acceptance note and inspected the resulting “Accepted after human review” state. A long path and a 211-character feedback note stayed inside the phone layout; the short primary actions remained on one line, and the acceptance button measured 44 pixels high. The stale-link screen returned HTTP 409 at both sizes. See `evidence/chat-acceptance/manifest.json` and the supplied screenshots.

These are explicitly synthetic fixtures using the real local server and form handlers, not production agent output. The fixture image itself is a labelled placeholder. No physical phone, Telegram native-client rendering, reboot or live Bot API send is claimed by this evidence. The operator will validate the installed build and delivery separately.

Simplicity pass: the initial review queue called manual review “missing evidence”, and the result repeated the internal manual-review reason in its main callout. The patch changes the queue to “human review needed”, removes that repeated warning and keeps exact requirements under Checks. The acceptance form shows one note and one action, with its consequence visible before submission. Genuine evidence problems, caveats and exception terms remain visible.

## Native verification

Reuse these checks for unchanged code. Run typecheck and affected regressions only for any correction made here. Do not rerun the full suite in the builder or reviewer. Standing Orders runs the unchanged approved full command once at its final machine gate:

`npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build`

Never delete tests, add skips, weaken approval/evidence checks or raise spend limits. The shared prompt was compressed to keep the existing direct API budget regressions passing, without changing their limits. Cite the supplied actual viewport evidence in the native proof. The required review is independent; do not accept your own result or install it.
