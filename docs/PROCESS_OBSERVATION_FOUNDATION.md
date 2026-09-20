# Process observation foundation

A failed final exit lookup should leave the known process unresolved, with a useful diagnostic. It should not invent a new unknown spawn that can remain blocked after the known process exits. This foundation makes that distinction and supplies read-only facts for later, separately reviewed recovery work.

This foundation starts at the independently verified assignment result e3e65a7248ee4f060203f66cdfe4b5c6d74c7919: native builder 1939 passed the unchanged full gate and reviewer 1940 upheld all eight criteria. The foundation itself still requires its own native gate and independent review. Its earlier development and 250-test checkpoint were prepared on unverified e64d5ad; those historical inputs remain explicit. All 21 foundation source files and listed build inputs are unchanged. The only inherited source difference is the prerequisite's corrected serve.test.ts assertion. The first task branch must start at this exact verified base; no dispatched task base was moved.

## Included behavior

- Final exit-only observation or exit-persistence failures retain each known PID witness. Sanitized phase/code/root-identity diagnostics reach the existing ledger and consumers. A later positive OS exit observation can settle that known witness through existing custody rules.
- Discovery gaps, failed descendant persistence, escaped descendants and true unknown spawns remain fenced. Malformed or denied observations never establish an exit. No callback error clears an unresolved identity.
- The native census owns and positively reaps its child. Complete process and coalition observations bind stable 64-bit identities, ancestry, membership and unchanged counters. Unreadable live membership, identity changes or an incomplete census refuse.
- The pure assessment requires independently authenticated pre-run identities and trusted external service identities. Wall-clock birth, process names, PID 1 and original-parent version numbers provide no authority. It does not authenticate caller-supplied provenance or clear witnesses.
- Read-only eligibility checks the exact current signed prepared scope, actual passing sealed gate and machine handoff, settled known witnesses and the absence of active producers or revoked authority. Its immutable digest is a prerequisite, not exit evidence.
- The read-only service anchor binds the audited installed runtime, saved watch incarnation, current registration, actual heartbeat renewal and stable native worker/supervisor identities. It supplies continuity facts; it does not establish historical coalition inheritance or permission to settle a process row.

The 21 included source files are copied byte-for-byte from committed recovery preparation 09f0af. The general pure-policy file is the pre-service version from that commit. This split excludes the coalition-assessment, legacy source-provenance, application-service ownership and settlement modules and tests. Those evolving pieces need a later integration and their own native verification.

## Evidence and limits

`evidence/process-observation-foundation/checks.json` binds all current changed-source SHA256 and Git blob identities. Its complete plaintext log records the source checkpoint, typecheck and the focused tests actually run. These checks do not replace the unchanged full native gate and independent review for the eventual exact candidate. Dependencies use an ordinary isolated `npm ci` installation; installed dependencies and runtime are untouched.

The prior public recovery document and four evidence files are preserved byte-for-byte in `history.tar.gz`, with member hashes in the manifest. This archive includes earlier failures and broader integration observations. They are history, not evidence that this smaller candidate performs recovery. The four inherited assignment screenshots and prior evidence remain unchanged history. This foundation explicitly sets its native screenshot inventory to empty; there is no current UI claim or browser journey.

No database schema, approval, budget, timeout, scheduler, CLI/UI entry point or deployment behavior changes. No live database is opened, no process rows are recovered and no provider is invoked by this preparation. Existing null-PID discovery uncertainty can still require separate authenticated provenance; this foundation does not claim to resolve it or authorize a reboot substitute by itself. Only the eventual independently verified integration can determine whether a particular historical case is safely recoverable.
