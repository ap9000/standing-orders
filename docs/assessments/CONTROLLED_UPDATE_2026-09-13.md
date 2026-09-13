# Controlled app update and recovery — 2026-09-13

Historical checkpoint: the subsequent [automatic-recovery implementation and
failure trials](AUTOMATIC_UPDATE_RECOVERY_2026-09-13.md) close the no-window
updater-crash recovery gap described below. Its canary now uses automatic
recovery for `--interrupt-worker`; the explicit-Resume results here describe
the earlier implementation, not the current script. Signed installation,
physical reboot and Windows acceptance remain open.

Implemented locally, not deployed to the operator's installation. This closes
the same-schema app-update implementation, not the remaining signed release,
permission-persistence, physical reboot or Windows acceptance gates.

## What the operator gets

**File → Install app update** previews the two builds and starts a durable
background operation. **File → Update status** provides progress, cancellation,
safe retry, retained files and reopening the updated app. Closing the window
does not stop an update; reopening can resume an interrupted non-error operation.
The ordinary service's previously stopped state is preserved, including the
explicit Reopen updated app action.

The flow pauses new work, drains current work, verifies a private SQLite
backup, stops the existing service, atomically swaps the app, and verifies the
candidate's actual background worker before reopening admission. Current task
work has no new time limit. The readiness check is bounded; failed readiness
restores and checks the prior app while preserving the current database.

The implementation reuses the existing database, process-custody checks,
launchd lifecycle, worker-access receipts and authenticated console health.
There is no second task engine, automatic schema migration, new reviewer stage,
provider call or permission bypass.

## Safety boundaries

- SQLite admission triggers survive updater death and reject racing claims,
  root runs and new chat requests. Existing claimed/owned work can finish.
  Final freezing and the empty-work check share a write transaction.
- Open runs, unreleased claims, active conversation/session/stop records and
  unproven process exits keep the update waiting. Other controllers sharing
  the app or database are refused; unknown processes are never killed.
- Private receipts record intent before the app swap. Bundle hashes identify
  which side is installed after interruption. The native `RENAME_SWAP` helper
  uses a same-volume atomic exchange, without a two-rename fallback.
- An OS-held lock prevents duplicate updater execution; an installation lock
  prevents different state directories updating the same app simultaneously.
  A short status probe cannot strand the only worker by winning that lock.
- Changed settings or unrecognized/tampered app/backup state fail closed.
  Cancellation and recovery remember whether the service was already stopped,
  including after a resumed drain/backup pass.
- Production bundles must retain the signed identity/team and designated
  requirement, pass Gatekeeper and validate their notarization ticket. The
  development identity is separate. Schema mismatch and legacy bundles without
  update protocol metadata stop at preflight.
- A backup is evidence and a separately controlled recovery resource. The
  updater never restores an older database over newer work. Keychain and OS
  privacy grants are not modified.

## Verification

- TypeScript typecheck/build passed. Native Swift app and atomic-swap helper
  compiled, and each development bundle passed strict deep code verification.
- Full regression suite: **161 files, 2,761 tests passed, 23 platform skips**
  in **60.27 seconds** after the status-lock fix. A final additional shutdown-
  recovery regression was added; the final focused desktop suite passed
  **47 tests across 5 files** in **11.62 seconds**, including **25 updater tests**.
  The focused suite required loopback networking; the restricted attempt's
  two server tests failed with `listen EPERM`, then passed with that access.
- Updater tests cover backup/data preservation, failed health, cancellation,
  interrupted phases, crash immediately after swap, duplicate starts,
  cross-installation contention, a real cross-process status-lock race,
  changed settings, stopped-service preservation and live process witnesses.
- Initial actual app update completed in **7.188 seconds**. Actual launchd,
  detached updater, native atomic swap, retained login/task and fresh worker
  project access were checked—not only stubbed service responses.
- A deliberately rejected candidate health check automatically restored the
  prior app in **11.327 seconds**, retaining a task edit made *after* backup.
- The first forced-updater-death test failed: a status probe briefly acquired
  the worker lock, causing Resume's worker to exit. That failed receipt is
  retained. The fix waits through a brief probe and rereads the journal after
  acquisition; a cross-process regression reproduces the original contention.
  The next real SIGKILL → explicit Resume → verified update passed in
  **11.587 seconds** without an out-of-band rescue.
- Final artifact `a6617429-6152-47c3-bd5e-88e3a353f850` passed both real
  acceptance cases again: forced updater death → explicit Resume → verified
  update in **8.461 seconds**; rejected health → verified old app with newer
  task data retained in **11.114 seconds**. Both test services were removed.

Local JSON receipts are under `output/certification/`:

- `controlled-update-2026-09-13-first.json` — first real update.
- `controlled-update-2026-09-13-recovery.json` — first actual app restoration.
- `controlled-update-2026-09-13-resume.json` — original failed interruption run.
- `controlled-update-2026-09-13-resume-fixed.json` — successful interruption retest.
- Final-build acceptance is recorded separately in
  `controlled-update-2026-09-13-final-resume.json` and
  `controlled-update-2026-09-13-final-recovery.json`.

The receipt records build hashes/IDs, timings, retained-data checks and its
private fixture path. Test LaunchAgents are stopped and removed after each
case. The failed fixture's admission gate was subsequently cancelled through
the supported recovery API; its failure was not relabelled as a pass.
Private app/database backups remain available for inspection. The installed
app, production service/database and OS permissions were not changed.

## Reproduce and remaining release gates

Build two separate development artifacts, then run:

```sh
node scripts/desktop-update-canary.mjs \
  --previous /absolute/path/Old.app --candidate /absolute/path/New.app \
  --interrupt-worker --output output/certification/update-resume.json
```

Use `--reject-health` instead of `--interrupt-worker` for app-only recovery.
The failure is injected at the health boundary; app verification, backup,
launchd, atomic swaps and prior-worker verification remain real. Without
either flag the canary performs the ordinary successful update. It requires
an unlocked macOS service session, writes only disposable state plus a unique
test LaunchAgent, and does not invoke providers or open UI.

Still required before claiming unattended release readiness:

1. Developer ID signing/notarization with an available release certificate.
2. Two signed builds at the installed path: native-window journey, retained
   login/projects and project access without repeatedly granting permission.
3. Actual logout/login and physical reboot acceptance. Explicit Resume after
   a killed updater is proven; automatic updater recovery with no window ever
   reopened is not certified or claimed.
4. Physical Windows acceptance and a Windows-native installer/update path.
5. Mixed real provider work qualification. These disposable updater fixtures
   contain retained unsigned tasks and do not establish a 9/10 orchestration
   reliability score.

See [operator instructions](../control-app.md#install-an-app-update) and
[current priorities](../PRIORITIES.md#next-sequence).
