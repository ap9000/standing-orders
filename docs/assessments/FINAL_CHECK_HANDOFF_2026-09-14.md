# Final-check handoff

Run 1555 exposed a timing gap: the agent honestly marked c6 `not-met` while
the machine-owned final check was pending. That check later passed (2,856
tests), but the immutable answer still kept the result incomplete.

The fix adds `pending-verification` to the proof receipt. It means the agent
has completed and checked its part; only the final repository check remains.
It is valid only for a signed criterion requiring check evidence. The agent
still cites its actual focused checks, never an invented final-check result.

Adjudication resolves this state using the current run's successful approved
check, without editing the saved receipt or asking for another model turn.
Exact scope, valid references, passing focused checks, artifact integrity,
screenshots, caveats and manual-review requirements continue to apply.
Missing or failing verification cannot resolve it. Existing `not-met` and
`not-checked` answers are never inferred to mean pending or rewritten.

The builder instructions explain the distinction and reserve the final suite
to the machine. This is an additive receipt change, not a new scheduler,
retry loop, database migration, approval exception or broader permission.

Verification: focused parser/adjudicator/preflight tests and builder-level
handoff checks cover success, failure, no configured check, lost custody,
invalid or unsigned references, failed focused checks, caveats, missing
artifacts and required manual review. The builder check confirms one final
command, one agent call, and unchanged original proof bytes.

Local results: typecheck and build passed; 94 proof/preflight checks passed,
plus two targeted builder handoff cases (success and failure). No test was
deleted or disabled; the builder command selected only those two cases.
The full repository suite was not duplicated during development.

Run 1555 remains an accurate historical record of the old behavior. This fix
does not retroactively certify it. The change needs normal final verification
and installation before new production attempts can use the new state.
