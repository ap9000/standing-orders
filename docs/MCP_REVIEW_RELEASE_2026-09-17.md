# MCP review fixes: bounded release preparation

Verified main base: `ff46c0c`. Prepared implementation: `9392ea9d9eb8914e918013ab056a46cdcdbd2a38`.
The earlier 625-test run on the old review-learning checkout is historical only. The prepared main-based implementation passed typecheck, build via test setup, and 658 focused tests in 11 files. Current source hashes, captured check summary, 16 browser assertions and eight inspected synthetic images are in `evidence/mcp-review/`.

## Native task instructions

Start the task branch at the verified main base above. The authenticated steering note pins the final prepared evidence commit. Read this document from that commit with git show, then apply the full binary diff from the verified base to the prepared commit to the index and worktree WITHOUT committing or moving HEAD; the native machine owns the candidate commit. Preserve the whole-task base. Do not start the task at the prepared implementation or move its original base later.

This corrective evidence-only pass preserves native build 1763 and incomplete independent review 1764. Read evidence/mcp-review/review-followup.md and review-source-excerpts.json. No implementation changes are requested. Cite both files as changed-path supporting evidence for the relevant signed criteria so their actual bytes reach the independent reviewer. The follow-up includes bounded source excerpts for migration order, immutable placement, disguised-text checks and the synthetic fixture. Include all eight existing PNGs as real screenshot attachments; the independent reviewer must open them rather than rely on captions. Reuse valid unchanged source checks, but obtain a fresh native gate and review for this corrective candidate.

Inspect and preserve these bounded fixes:

- Iterative JSON depth checking accepts wide shallow input below the byte cap without argument-stack failure.
- The transactional cancellation floor validates nonblank, bounded, undisguised human reasons for coordinator-linked tasks. CLI and console pass the reason, refuse without writes, and retain correct retry and draft behavior. Ordinary tasks and typed machine cancellations keep their prior semantics.
- Real migration tests use the authentic v47 fixture and independent MCP connection, pause after the first DDL, and prove both reads and filing refuse before migration resumes.
- The gateway baseline document identifies the later reviewed extensions and the replacement-task recovery road for immutable repo-null scope placement.

Reuse the unchanged focused and UI evidence after verifying its source hashes. Do not duplicate the full test suite in the builder or reviewer. The final machine gate owns the unchanged approved command:

`npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build`

Return native proof for all three signed criteria and inventory every whole-task changed path. Include all eight PNGs listed in ui-report.json in the native screenshot selection. Include the evidence reports and this brief as supporting artifacts. If an evidence reference cannot be represented within native limits, report the gap rather than silently truncating or making it a pass. The source changes are already implemented; do not redesign the gateway, add new dependencies, migrate a database, modify signing/approval rules, or make unrelated changes. If a reproduced regression requires a scoped repair, preserve failed evidence and run fresh affected checks for that candidate.

The builder must not push, merge, publish, deploy, or approve work. An independent native review must uphold all signed criteria before the root operator considers merge/deployment.

## UI simplicity and evidence boundaries

Before: an armed cancellation button repeated an arbitrarily long task ID, and coordinator dismissal could omit a human reason. After: a concise Cancel task disclosure, one required Reason for cancellation field only where necessary, and one Confirm cancellation button. Empty input focuses the field, HTTP refusals retain the draft, and the short action fits on one line at desktop and phone sizes. The result-to-feedback-to-unapproved-revision flow was checked once per viewport with realistic feedback. These are isolated Chromium fixtures, not real customer output, physical-device acceptance, or live deployment evidence.

## Release boundaries

The currently installed browser worker/UI were identified as `e7a0779`, schema 66. This candidate also speaks schema 66. The native app remains parked; no signing, permissions, external URL, or deployment topology change is authorized by this release. The task is initially held for evidence/base preflight. Its exact scope requires explicit approval before dispatch.

After native verification and independent review, merge through normal GitHub checks. Deployment must package the exact verified tree, retain the existing service/runtime configuration, drain and freeze admission, verify a fresh private backup and compatibility rehearsal, prove old processes exited, then verify matching UI/worker identity, project leases and authenticated local/HTTPS health before reopening admission. Never restore stale task data over newer work or claim deployment from a merge alone.
