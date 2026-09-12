# Final branch integration and desktop rollout — 2026-09-12

## Branch disposition

All three branches with commits outside the previous main (`ebe9d4b`) were
reviewed and integrated on `feat/finish-rollout`:

| Branch | Disposition |
| --- | --- |
| `standing-orders/standing-orders-natural-task-instructions` (`9f8a8a2`) | Retained the builder prompt fix, four regression tests, reproducible fixtures and before/after real-model evidence. Ordinary imperative requirements are accepted; execution-rule overrides remain ineffective and actual conflicts are reported specifically. |
| `standing-orders/nightly-deps-20260812-1534` (`f2f0985`) | Retained `docs/DEPS.md`, refreshed from both local manifests/lockfiles, and removed unverified upstream claims. No dependency changes. |
| `standing-orders/explainable-risk-aware-phase-routing-v1` (`c701b7f`) | Recorded an ancestry-only merge. Reviewed replacement `1d0fc90` already incorporated this implementation and its seven review corrections; main's exact-model approval and subsequent authority fixes remain intact. |

No other local task branch has unique commits outside this integration. No
existing open GitHub PR was found during the audit.

## Verification

- Typecheck and build passed.
- Full local suite: 150 files, 2,647 tests passed, 23 platform skips.
- `node scripts/natural-instructions-smoke.mjs verify` passed: the current
  generated briefs match the recorded real-model after-briefs, beyond nonces.
- The desktop preview rebuilt with the prompt fix; deep/strict code signature
  verification passed. Its executable tree SHA-256 is
  `b21be444ff26e4ed946240f8d71d5690ba27a826f63fb9ac67eefd5c35132b64`.
- The bundled official Node binary SHA-256 remains
  `913b144fdb40638b1acef7974ab3c33fbd527cc0974cb5da467ab1e6ac51b4d4`.

Local logs are under `output/certification/final-rollout-*`. Earlier completion,
provider and crash certificates remain in
[the completion/recovery record](COMPLETION_RECOVERY_2026-09-12.md); they certify
that earlier runtime, not a fresh physical reboot of this installation.

## Mac deployment gate

The live controller remains healthy on schema 52. No open runs were present at
21:13 UTC. Released claims must not be counted as active solely because their
expiration is in the future. The installed service and database were not replaced.

The unlocked-session Documents canary failed before its first healthy project
heartbeat. Settings shows **Documents Folder enabled** for Standing Orders
Completion Preview and Full Disk Access listed for Node. No permission setting
was changed. A separate diagnostic Node process stalled in a filesystem open;
that observation does not establish a missing permission or justify broadening
access.

The real launchd certificate also failed automatic relaunch after clean exit.
A retained diagnostic later failed initial heartbeat. The system log gives the
specific service-launch reason: `pending spawn, domain in on-demand-only mode`.
Software Update displays macOS Tahoe 26.6.2 ready at **Restart Now**, while the
installed version is 26.5.2. A pending update is consistent with
[Electron's independently documented launchd behavior](https://github.com/electron/electron/pull/51191):
this mode suppresses KeepAlive/RunAtLoad. No speculative service workaround was
installed and no automatic recovery certificate is claimed. Disposable services
were unloaded after diagnosis.

Computer-use tooling refused access to macOS UserNotificationCenter. System
Settings remained accessible. Any protected permission dialog must be handled
by the operator; the refusal was not worked around.

## Remaining sequence

1. Save open work and use the macOS **Restart Now** update action, then sign in.
   Settings estimates about 20 minutes. This is a physical OS operation, not
   something the controller certificate performs.
2. Rerun the exact staged app's Documents canary and real launchd certificate.
   Keep failure evidence if either still fails; resolve the actual cause before
   replacing the working controller.
3. Check open runs and unreleased, unexpired claims; drain work. Take a **fresh**
   private SQLite and app backup. The earlier migration rehearsal is never a
   replacement for newer live work.
4. Stop the exact modern service, migrate with the supported schema migration,
   compare historical rows/values and integrity/foreign keys, replace the bundle,
   and start it with the bundled Node runtime through the shared service API.
5. Verify the saved login, challenge/HMAC, native window/Keychain and fresh
   heartbeats for all three saved projects. Record the installed runtime receipt.
6. Prepare the restart certificate baseline for that installed runtime. A real
   logout/login or reboot followed by verification must establish recovery; the
   update restart before deployment does not certify the new controller.
