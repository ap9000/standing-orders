# Desktop rollout — 2026-09-13 UTC

## Current state: installed, project access blocked

The desktop app now contains main `45ad5a70e1c4b4435d663066e3c9d7c329513c00`
(schema 57), which matched GitHub main at the release check. Installation is
complete; operational verification is **not** complete. At 01:33:51 UTC the
correct LaunchAgent supervisor was running, but localhost:4180 did not answer
and none of the three saved projects had a fresh watch heartbeat. There were
no open runs. Do not interpret the supervisor's running state as a healthy
controller.

The installed app had previously contained schema-52 code while the live
database was already schema 57. That old service repeatedly refused to start.
This rollout repaired the version mismatch; it did not migrate an old snapshot
over newer work. The current service reports all three Documents repositories
unavailable. A test of the same new bundle in Documents caused an explicit
macOS `kTCCServiceSystemPolicyDocumentsFolder` prompt. Computer-use tooling
reported the Mac locked and could not inspect or handle the native UI. No
privacy permissions were changed or bypassed. The exact installed app still
needs an unlocked-session access check; the test prompt alone does not prove
which prompt is currently visible for the installation.

## Completed checks

- Typecheck passed. Full current-main regression: 154 test files, 2,673 tests
  passed, 23 platform skips (2,696 total).
- The post-reboot launchd certificate passed automatic relaunch after exit 0
  and SIGKILL, explicit stop/stays-down/start, one writer and idempotent start.
  This supersedes the earlier `on-demand-only` startup failure.
- The exact new bundle passed the separate temporary-project recovery test:
  clean exit recovered in 1.750 seconds and SIGKILL in 181.950 seconds, with
  no manual rescue, preserved unsigned work and successful explicit stop.
  The forced-crash interval includes the existing runner-liveness fence and
  supervisor retry delay; it is not a provider work-duration cap. This test
  does not certify Documents access, real provider completion or reboot.
- A new standalone desktop bundle was built and deep/strict signature-verified.
  It bundles official Node v22.22.0 instead of requiring the nvm Node path to
  remain installed. The provider search path remains separately configured.
- With zero open runs and zero unreleased, unexpired claims, the old service
  was stopped. A fresh private SQLite backup, app, service definition, desktop
  configuration and remembered login were retained before replacement.
- Rehearsal and live database comparisons both preserved every original row
  and column value across 99 historical tables. SQLite integrity passed and
  there were zero foreign-key violations. The database was already schema 57.
- The exact installed executable tree SHA-256 is
  `d2a72b862cfe54241bd74ba44c22a1f2f65f34e4e340fbc1d93e67117bafa18a`.
  Bundled Node SHA-256 is
  `913b144fdb40638b1acef7974ab3c33fbd527cc0974cb5da467ab1e6ac51b4d4`.

## Evidence and recovery

Local, sanitized evidence is under `output/certification/`:

- `post-reboot-launchd-2026-09-13.json`: automatic service lifecycle pass.
- `post-reboot-desktop-v57-2026-09-13.json`: initial test exited before startup
  because the `/var` alias did not match the helper's canonical entry path.
- `post-reboot-desktop-v57-canonical-2026-09-13.json`: corrected canonical path;
  failed initial Documents-project access. This is a retained failure, not a
  crash-recovery pass.
- `post-reboot-desktop-v57-runtime-2026-09-13.json`: separate runtime recovery
  pass using a disposable temporary project, not Documents or real providers.
- `desktop-rollout-v57-2026-09-13.json`: installed hash and private backup
  location, with the rollout explicitly awaiting health verification.
- `installed-v57-project-health-2026-09-13.json`: exact installed service
  configuration, unanswered health challenge and missing project heartbeats.

The private backup is named
`pre-desktop-v57-2026-09-13T01-32-05.276Z` under the database's `backups`
directory. Its old app and schema-57 database are preservation copies, **not**
a known-working downgrade pair. Do not restore an older database over new work.
The earlier completion preview is untouched.

## Resume from here

1. Unlock the Mac and inspect Standing Orders' Documents-access prompt/settings.
   Ask the operator to handle any protected permission prompt; do not broaden
   access speculatively or request unrelated Accessibility permission.
2. Recheck the installed service and all three saved project heartbeats. Verify
   the existing login and native window/Keychain. No new task is needed merely
   to establish service health. Do not rerun the installer or use a rehearsal
   database just to repeat verification.
3. Retest the installed bundle's Documents recovery using its canonical path.
   Runtime recovery outside Documents does not certify protected-folder access.
4. Only after those checks pass, record a new restart baseline for the installed
   runtime. Verify it after an operator-controlled physical login/reboot; the
   reboot before installation does not certify this installed release.

Real Windows unattended/native-containment certification remains separate.
This record does not claim a new real-provider completion certificate.
