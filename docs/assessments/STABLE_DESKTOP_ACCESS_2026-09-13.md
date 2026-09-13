# Stable desktop permission identity — implementation checkpoint

## Status

Implemented locally on top of main `45ad5a7`. The installed application,
production database, launchd definition, Keychain items and macOS permissions
were **not** changed during this implementation. The previous installed-app
access gate remains as recorded in [the rollout assessment](DESKTOP_ROLLOUT_2026-09-13.md).

Both restricted and normal-session read-only signing checks reported **zero
valid code-signing identities**. A Developer ID release, notarization and real
permission persistence across that release's updates are therefore pending.
No new ad-hoc build was substituted for a signed production release.

## Changes

- Release builds require a valid Developer ID Application certificate. Missing,
  ambiguous or invalid identities fail before building; there is no silent
  ad-hoc fallback. Signed updates retain the team and must satisfy the installed
  app's designated requirement. The first migration from the old ad-hoc app is
  identified as a possible one-time reauthorization.
- Optional Keychain-profile notarization waits for acceptance, staples and
  validates the ticket before replacement. Without a profile the output is
  explicitly signed but not notarized. No Apple account password or private key is
  embedded in arguments, source or configuration.
- Explicit development previews have their own bundle ID, default database,
  Keychain service and launchd label. They cannot replace a release identity.
- The existing launchd generator associates the desktop worker with its actual
  release/development app ID. CLI-only services do not pretend to be the app.
  Association changes participate in the existing service reload digest.
- The real controller owns bounded project-access probes and their private
  receipts. Probes read the project and round-trip a unique file in Git's
  common metadata; they do not touch tracked files or run providers. Checks
  occur at startup, selection changes and explicit rechecks, not every task.
- The native **Finish project access** panel offers **Open Privacy Settings**,
  **Check again**, and the existing project picker. It separates missing
  folders, unavailable Git, read-only drives, full disks and permission issues.
  Ready requires the current worker's receipt, live project watch leases and
  the identity-verified console. An old worker's success cannot become readiness.
- The macOS temporary-directory alias entry-point issue found during rollout
  is corrected; the real lifecycle test launches the helper through an alias.

No new execution engine, task permission policy, database migration, global
Full Disk Access grant, TCC reset, or automatic project relocation was added.
The access check is a readiness diagnostic, not a replacement for task scopes
or proof that every individual file/provider operation will succeed.

## Verification

- Typecheck passed.
- Full regression: 156 files, 2,681 tests passed, 23 platform skips (2,704
  total), 248.99 seconds. No failing tests or unhandled test errors remained.
- Focused desktop/lifecycle/supervisor regression: 6 files, 42 tests passed.
  The initial restricted run could not bind localhost; those unchanged tests
  passed with the required localhost test permission.
- The real build entry refused an unsigned release before creating its output.
- The final isolated native preview compiled and passed deep/strict signature
  verification; its bundle ID is `com.standing-orders.desktop.development`.
  Native-window visual review and the certificate-backed signing/notarization
  commands have not been exercised with a real signing identity yet.
- The exact preview passed the disposable launchd controller canary: clean
  exit recovered in 1.718 seconds; SIGKILL in 182.545 seconds; zero manual
  rescues; fresh access receipts from each replacement worker; preserved
  unsigned task; explicit stop. The crash delay includes the existing
  liveness fence and retry delay, not a new task runtime limit.
- Local receipt: `output/certification/stable-desktop-access-recovery-2026-09-13.json`.
  Runtime SHA-256:
  `e922164b7eb36873be6860bd25c7ae1cbef8237433eb9a8f65012809693ee6b7`.
  The receipt's source revision is the base commit; the runtime hash identifies
  the tested local changes. This is a temporary-project **development** test,
  not a Developer ID, Documents, native-window, real-provider or reboot certificate.

## Remaining release gate

1. Operator makes the intended Developer ID Application certificate available
   in the signing keychain, plus a notarization profile for distribution.
2. Build a signed release and complete the unlocked native-window review.
3. Run the [two-build permission persistence acceptance](../control-app.md#release-acceptance-permission-persistence)
   in a disposable Mac account/VM without regranting or resetting access.
4. Only then back up and upgrade the installed app, confirm its saved projects
   and login, and certify operator-controlled logout/login or reboot.

Windows unattended/native-containment certification remains separate. New
workspace-location defaults and migration of existing projects are not part
of this checkpoint.
