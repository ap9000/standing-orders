# Isolated status-reply replay

Recorded 2026-09-16 using product candidate 7cd90572f7a7399089d48cb2e1ec13ed50c67403 (patches 51ef811, d2cd926, 7cd9057) based on deployed 2a630907e12c8f6e1b522cce4c32367a755bd838.

This is an isolated snapshot of existing work, with the configured shared chat model. It is not a production Telegram conversation. No workers, Telegram sends, confirmations or live task changes occurred. Three read-only navigation proposals were created. The prompt asked what is open in Standing Orders and highest priority to unblock, with up to three actions and more on request. The recorded reply is one model trial; exact future wording and selections can vary.

Before: the supplied user reply guessed r3, listed long IDs and internal status codes, and offered to draft a next step. After: the model identified Standing Orders using admitted display metadata and returned three checked tasks, explaining why each needs attention and attaching a real result control. Partial counts remained explicit.

Inspected browser viewports: phone 390×844 and desktop 1440×900. Numbering stays 1, 2, 3 across blank lines. Long titles fit without horizontal overflow. Phone controls measured 44 px high, with one short label and a task-specific accessible name. Scrolling exposes all three above the fixed composer. A phone tap opened the first task's failed-check result; desktop keyboard focus and Enter opened the second task's missing-evidence result. Important warnings remain visible. Navigation cards no longer say pending/proposed or duplicate their action heading. Actual change proposals retain confirmation controls (focused regression).

The result/feedback/revision engine is unchanged; reuse the accepted mobile-settings release journey evidence for it. Physical iPhone and Telegram-client rendering were not independently retested. The response is appreciably shorter but still uses existing technical task titles; title quality remains a limitation rather than inventing task identities.

Checks already run: typecheck; 99 mate/Telegram tests before final contract wording; four focused contract/privacy/label tests and two focused serve tests after their final edits. Label and navigation regressions failed against the previous implementation and passed with the patch. Native candidate must rerun affected tests; unchanged full verification belongs to the final native machine gate.
