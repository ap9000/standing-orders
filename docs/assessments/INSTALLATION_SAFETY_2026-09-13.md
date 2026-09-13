# Installation and update safety — local checkpoint

## Outcome and boundary

The installation/update priority is active. This checkpoint closes concrete
failure paths; it is **not a 9–10/10 installed-release certificate**. Changes
are local on top of main `45ad5a7`, alongside the earlier uninstalled phone and
stable-access work. No installed bundle, production queue, Keychain item,
project location, or privacy grant was changed. No provider was invoked.

A fresh read-only check found **zero valid code-signing identities**. Signed
two-build permission persistence and physical restart acceptance remain gated
on a real Developer ID Application identity and an unlocked operator session.

## What changed

- **Building no longer means replacing an installation.** Release output
  defaults to a fresh artifact directory. All existing destinations, including
  old builds and symlinks, are refused. Compilation/signing/notarization finish
  before the reserved artifact receives its `Contents`. Failure never deletes
  the installed app; unexpected output changes are preserved. The old app is
  only a read-only signing-continuity reference (`--upgrade-from` supports a
  non-default installation).
- **Stop and Status work through database failures.** Those operations no
  longer open the task store first. Missing, older, newer, interrupted and
  damaged databases cannot prevent the ordinary service stop path. Start
  checks compatibility before changing launchd.
- **A missing database is not a new queue.** First-time setup records its
  initialization state. Subsequent opens, including legacy installations,
  refuse a disappeared database and retain configuration and login. Only a
  recorded first-time setup may initialize the database.
- **A new build at the same path is distinguishable.** A build ID is sealed
  in `runtime.json` and passed by the native shell into the shared service
  definition. An updated build changes the service digest; reopening the same
  build remains idempotent. No second service implementation was introduced.
- **Useful recovery UI.** File → Check installation works when ordinary
  startup cannot open the database. It reports database compatibility and
  responding-console status separately, links to service logs, and does not
  treat a supervisor PID as evidence that project work is ready.
- **Candidate preflight without installation.** The bundled helper's
  `database-status --state <existing-state>` uses a read-only connection and
  never bootstraps a missing state directory, starts a worker, reads a login,
  or migrates a database. Compatibility is not an integrity/permission verdict.

This is intentionally not a new updater framework. A controlled update still
requires draining work, verified private backups, schema rehearsal where
needed, deliberate bundle replacement, and fresh health/access checks. An
old database is never automatically restored over newer work. See the
[update checklist](../control-app.md#controlled-update-checklist).

## Verification

- Typecheck, TypeScript build, script syntax checks and `git diff --check` pass.
- Focused desktop/signing/artifact/access/lifecycle/daemon/supervisor tests:
  **7 files, 54 tests passed**, 10.65 seconds.
- Full regression: **160 files, 2,737 tests passed, 23 platform skips**,
  48.24 seconds. This includes the real isolated controller journey, worker
  access receipts and retained tasks; no native Windows acceptance is implied.
- The native development preview compiled and passed deep/strict signature
  verification, including after publishing `Contents` into its final location.
  No native window was opened or visually certified.
- Attempting to rebuild into the same preview was refused. Its executable
  remained byte-identical (SHA-256
  `33b3e603097cc5d183fecd9fed6ebe98c44e107631432381df467d6b3e32278f`).
- Restricted-context Node signature checks failed; the unchanged binaries
  passed normal-context verification. This was not treated as proof of a
  damaged runtime or bypassed by re-signing Node.
- A disposable launchd check using the preview inside Documents failed before
  any controller receipt or heartbeat. launchd reported a process, but the
  service log remained empty. The test label and process were removed. The
  failed receipt is retained at
  `output/certification/installation-safety-recovery-2026-09-13.json`.
  This is a failed launch certificate, not a passing recovery run. It is
  consistent with the protected-folder boundary; the exact OS cause is not
  asserted from a PID alone.
- The identical temporary-folder copy **passed** the real launchd/controller
  check: clean exit recovered in **1.744 seconds**, forced crash in **182.361
  seconds**, **zero manual rescues**. The latter includes the existing worker
  ownership/retry fences, not a new task-duration cap. Fresh access receipts
  came from replacement workers, the unsigned task was retained, and explicit
  stop removed the disposable service. Runtime SHA-256:
  `fc81155faeae14171d011c5072f2b721f4db7a76febad0048af2c018c6d8b65a`.
  Receipt:
  `output/certification/installation-safety-temporary-recovery-2026-09-13.json`.
  The matching development bundle is retained at
  `/private/tmp/standing-orders-installation-test-HWxsHa/Standing Orders Development.app`.
  This result does not substitute for signed/installed/protected-folder,
  native-window, provider, login or reboot acceptance.

The signed runtime manifest distinguishes build identity from the human-facing
package version. Release versioning should follow Apple's
[bundle-version guidance](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion?language=objc).

## What is required before calling this 9–10/10

1. Produce the actual intended Developer ID signed/notarized release. Review
   the native startup/recovery screens in an unlocked session.
2. Complete the [two-build access test](../control-app.md#release-acceptance-permission-persistence)
   in a disposable Mac account/VM: authorize once, update at the same path,
   close/reopen, logout/login or reboot, and obtain fresh worker access and
   authenticated console evidence **without a new grant**. Record observed
   prompts, not just successful health checks.
3. Prove denial/revocation, disconnected projects, damaged/missing databases,
   and an interrupted update never show false readiness or lose tasks. Verify
   recovery after the operator resolves the actual gate; keep rollback
   conditional on the current database's compatibility.
4. Upgrade the real installation using verified backups. Complete an approved
   task, retain its evidence, restart, and complete another with no manual
   queue repair. These changes are not live until that happens.
5. Qualify physical Windows installation/login/reboot/provider behavior
   separately. Report mixed-real-task completion and rescue rates after the
   platform installation gates, not a score inferred from test volume.

Unattended work cannot legitimately remove an OS permission requirement or
invent the publisher's signing identity. No Full Disk Access, Accessibility,
TCC reset, task time cap, or unbounded retry was added.
