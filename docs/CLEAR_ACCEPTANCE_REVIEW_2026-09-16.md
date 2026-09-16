# Clear acceptance review

A phone screenshot showed each approved requirement mixed with status badges, repeated reviewer judgments, long test commands, file references, and context diagnostics. Reading the actual requirement required picking it out of a wall of metadata.

Apply prepared patch `ed0fb4554290cdba6e509abb67388cfd0106ed31` with `git cherry-pick --no-commit`. This task's input commit starts at verified and installed base `f34957c1cfa0997c5b503c8e40cff05a88c62a6d`. Do not move the task's initial base. The host owns the final candidate commit.

The shared requirement renderer now shows the complete approved statement, its saved evidence status, and one **View evidence** disclosure. Commands, file and screenshot references, reviewer reasoning, evidence types, and IDs remain available inside it. Missing/failed evidence, reviewer disagreements or uncertainty, missing context, and strict review shortfalls remain visible. The requirement text is not summarized or rewritten. Machine verdicts and human acceptance are unchanged. A concise policy summary replaces repeated context warnings; criterion judgments are no longer listed again below the matrix.

The simplicity pass also found a long path widening the phone's **Review before accepting** notice from 390 to 502 pixels. The scoped wrapping repair preserves the complete path and brings page width back to 379 pixels. No interactions, endpoints, approval terms, authentication, stored data, chat actions, or Telegram transport change.

## Review and evidence

Inspect the prepared diff and `evidence/clear-acceptance/manifest.json`. The 14 committed screenshots are **synthetic fixtures**, captured and visually inspected in the same agent session at 1440×900 and 390×844. Dense statements came from run 1699; fixture warning/reviewer combinations are not new live judgments. The screenshot inside the seeded payout result is a labeled fixture placeholder.

Both journeys opened the result, inspected changed files, entered realistic feedback, and created an unapproved revision. Evidence disclosure toggled by keyboard with visible focus; its summaries measured 44 pixels high. An evidence link downloaded the saved fixture diff. Long commands wrapped without horizontal overflow. Missing evidence and failed evidence remained visible. After the small final CSS repair, the affected desktop and phone failure checks were rebuilt and repeated; unchanged evidence was reused.

The prepared code passed typecheck, build, and five existing focused `src/serve.test.ts` tests. The builder then found the prepared filter had matched `run evidence: own artifacts` instead of `evidence is labeled by source`, whose assertion still expected the removed `author: note` judgement line; that assertion now checks the visible reviewer warning and the author under **View evidence** (see `builder-checks.txt`). `src/serve.ts` is unchanged, so the screenshots are reused. Their added assertions cover unchanged terms, collapsed citations with valid links, visible failures and reviewer concerns, and separate saved evidence status versus incomplete required review. Logs and source hashes are committed in the evidence directory. Browser width assertions cover the reproduced CSS overflow using the existing long-path fixture. Physical iPhone/Safari behavior is unverified.

Reuse these valid screenshots when source hashes and affected behavior are unchanged. Suggested proof screenshot set (eight captures): `desktop-after-dark.png`, `phone-after.png`, `desktop-evidence.png`, `phone-evidence.png`, `desktop-revision.png`, `phone-revision.png`, `phone-failure.png`, and `phone-empty.png`, all under `evidence/clear-acceptance/`. Supporting before/after, feedback, and desktop failure/empty captures remain in the manifest. Do not claim these are live agent results or newly executed by the builder.

Inspect for concrete problems and fix only reproduced issues within this scope. Reuse focused evidence for unchanged code; if behavior changes, rerun its affected tests and browser checks. Do not run the full suite in the builder or independent reviewer. Let Standing Orders run the unchanged approved final command once for the final candidate:

`npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build`

Do not remove tests, add skips, bypass evidence/approval checks, change provider/budget/time limits, alter production data/configuration, send Telegram messages, deploy, merge main, or touch the original dirty checkout. The parent operator handles installation after exact native verification and independent review.
