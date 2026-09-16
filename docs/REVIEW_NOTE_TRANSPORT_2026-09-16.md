# Keep review transport compatible with the native parser

## Reproduced failure

Telegram candidate8217f5579d02c4feed7dcdcc24c8e01ff8d35a71 passed its native
gate (3181 tests,23 existing skips). Independent Fable1656 read the evidence,
then Claude StructuredOutput exhausted five attempts because c3's final note
was251 ASCII characters and the transport schema allowed250. The existing
parseReview accepts that exact response under its unchanged500 UTF-16-unit
limit. This is an adapter mismatch, not a failed Telegram test or an accepted
review. Never import the raw response as an approved verdict.

## Bounded fix

The provider's comments/criteria note maxLength now uses the native500 limit,
so no native-valid note is rejected solely by the stricter250-point envelope.
JSON Schema counts code points, so some astral strings admitted by transport
will still exceed500 UTF-16 units. The existing strict parser rejects them and
the existing same-session correction remains responsible. It never truncates
a finding, changes a judgement, removes provenance or raises native limits.
Concise250-character guidance is a writing target, not a second hard contract.

Focused checks run on this patch: npm run typecheck; npx vitest run
src/provider.test.ts src/structured-output.test.ts src/reviewer.test.ts.
All190 tests passed. Existing provider regression now covers251/500 ASCII,
250 astral acceptance and251 astral rejection. git diff --check passed.
This is not yet a native final gate, independent acceptance or deployment.

## Completion requirements

Keep the implementation small: no new schema epoch, scheduler, retry mechanism,
provider installation, settings change, timeout or proof-limit expansion.
Preserve the existing root-object Claude schema and strict local mixed-payload,
rubric-ID, custody and evidence validation. This only addresses the reproduced
comments/criteria-note mismatch; other field limits are not silently relaxed.
Use Fable5.1 and the current subscription for native work and review.

After Telegram1655 has an actual accepted review, run this follow-up through
the normal native candidate gate and independent review. The unchanged approved
full command runs once for the changed candidate. Use the complete relevant
provider and structured-output sources/tests as review evidence. Do not label
unchanged source as a changed path; use supported context evidence.

Preserve1656's unaccepted observations for follow-up inspection: disabled
Telegram delivery may retry/log rows every poll; unknown-provenance task-bound
predecessors may hold later same-task updates; countRoutinePending may affect
non-Telegram callers. The new independent review must retain any substantive
finding. No successful review is rerun to obtain a different judgement.

Do not modify live runtime files or the database during implementation. Deploy
only an exact verified candidate using guarded drain, fresh backup, process
quiescence, migration validation and post-restart health checks.
