# Automatic update recovery — 2026-09-13

Implemented and verified locally; **not installed or published**. This closes
the previous controlled updater's dependency on reopening the window or pressing
Resume after process death. It is not a claim that arbitrary failures can be
repaired without permission, or that the whole orchestrator is release-qualified.

## What changed

One temporary, operation-bound macOS LaunchAgent supervises the approved update
from its private staged app. It is separate from the app being swapped and from
the task worker. The existing updater, service lifecycle, journal, SQLite
admission fence and atomic bundle exchange are reused; there is no second task
engine or provider loop.

- macOS can restart a killed recovery supervisor on a 15-second interval while
  logged in and awake. It does not need an open window or an extra kickstart.
- OS-held locks serialize recovery supervisors and update workers. Attempt
  counts are persisted before spawning; killing the supervisor cannot reset
  its budget. A stale operation ID cannot act on the next update.
- An updater that stops reporting progress for three minutes is killed through
  its owned child-process handle and retried from saved state. This is **not a
  time limit on running tasks**: draining keeps reporting progress.
- Three forward attempts are followed by a request to restore the previous
  app, with up to three restoration attempts. Transient service and SQLite
  contention errors can retry. Permanent trust/configuration failures stop
  with a reason; exhausted retries require a deliberate safe retry.
- An explicit Stop is durable and takes precedence over recovery. If the Stop
  receipt cannot be saved, the exact auxiliary OS job is disabled through the
  existing lifecycle before the ordinary service Stop continues.
- Recovery restores the app, **never an old database over newer task data**.
  Completion removes the exact temporary job; private backups and receipts
  remain. Damaged primary metadata is not replaced with a potentially stale
  retained receipt.
- Candidates must declare recovery protocol 1. The new optional launchd fields
  preserve the byte-for-byte ordinary service definition for older installations.

## Failure trials

Final native artifact: `Recovery C.app`, build
`612c10e1-04e9-4642-907f-b6a19d8ad110`, at
`/private/tmp/standing-orders-auto-recovery-8diPiJ/Recovery C.app`.
Previous app: build `a6617429-6152-47c3-bd5e-88e3a353f850`.
Both are separate ad-hoc-signed development bundles, not the user's installation.

| Failure / action | Verification | Result |
| --- | --- | --- |
| Recovery supervisor SIGKILL during drain | Real macOS job, final artifact | Automatic completion, 28.405 s |
| Updater SIGKILL after atomic swap | Real macOS job, final artifact | Automatic completion, 15.655 s; no second swap |
| Cancel while current work drains | Real macOS job, final artifact | Cancellation, 9.239 s; original app and work kept |
| Explicit Stop after atomic swap | Real macOS job, final artifact | Old app restored, 13.327 s; service stayed off |
| Updater SIGKILL during drain | Real macOS job, final artifact | Automatic completion, 8.810 s |
| Candidate fails health check | Real final-artifact services and swap; injected health result, direct updater | Previous app restored, 11.072 s; newer task data retained |
| Interruption at drain, backup, stop, install, verify and release | State-machine fault injection with service/swap seams | All six resume automatically, one forward swap |
| Crash between exchange and its completion receipt | State-machine fault injection | Recognizes installed build; does not exchange twice |
| Crash during restoration | State-machine fault injection | Continues restoring; does not restart rejected candidate |
| Repeated candidate crashes | State-machine fault injection | Three forward attempts, then previous app |
| Temporary old-service startup failure / SQLite busy error | Injected service exception / SQLite errcode 5 | Automatic retry succeeds |
| Hung updater | Real hanging Node child, accelerated 40 ms watchdog | Owned child exits; next attempt completes |
| Recovery unavailable repeatedly | State-machine fault injection | Six total attempts, then attention; supervisor restart cannot reset count |
| Changed settings / damaged primary receipt | Unit fixtures | No overwrite; automatic work suspended |
| OS activation refusal / Stop receipt cannot be saved | Stubbed OS lifecycle | Honest retry status / exact recovery job disabled |

Native times measure the entire test update from preview, not only time since
fault injection. They are observations, not recovery latency guarantees.
The crash tests never reopened the app, called Resume, or kickstarted the job
after the fault. **Zero manual rescues.** Completed paths verified retained task
and login data, backup integrity, installed path, fresh worker build/access and
resumed admission. Cancellation before backup correctly reports no backup;
explicit Stop correctly does not claim a running worker's health. Every final
OS-supervised case verified automatic job removal, followed by fixture-service
cleanup. No live queue, installation, Keychain item or privacy setting changed.

Machine-readable receipts are retained locally under `output/certification/`:

- `automatic-update-final-guardian-2026-09-13.json`
- `automatic-update-final-after-swap-2026-09-13.json`
- `automatic-update-final-cancel-2026-09-13.json`
- `automatic-update-final-stop-2026-09-13.json`
- `automatic-update-final-worker-2026-09-13.json`
- `automatic-update-final-health-2026-09-13.json`

These record exact build hashes, fixture state, attempt counts, fault identities,
cleanup and test limits. Private fixture backups are not source-controlled and
must not be posted publicly.

## Bugs found and regression results

The first native trials refused before pausing work: an extra whitespace line
in the normal launchd template made an unchanged installed service appear stale.
The default template is now byte-compatible, with a regression assertion. The
original failed `automatic-update-{worker,guardian,after-swap}-2026-09-13.json`
receipts were retained, not relabelled as passes.

Final full suite: **161 files passed, 2,782 tests passed, 23 platform skips**,
62.98 seconds. Typecheck, canary syntax, native compilation and strict/deep code
signature verification passed. The updater file now contains 45 tests.

An earlier full run concurrent with several native canaries had one failure
in the existing held-session transport test: an inherited tool PID was still
observable immediately after shutdown. The focused rerun passed **58 tests**
(held transport plus updater); the subsequent full rerun without simultaneous
native canaries passed. No assertion was weakened and no unrelated process
cleanup code was changed. **The initial failure's cause is not established**;
keep it as a load-sensitive process-custody investigation, not a proved fix.

## Reproduce

Build a new, separate development candidate with the documented native build
command. Do not replace the live installation. Then run, with two distinct
same-schema development builds:

```sh
node scripts/desktop-update-canary.mjs \
  --previous '/absolute/path/Previous.app' \
  --candidate '/absolute/path/Candidate.app' \
  --interrupt-guardian \
  --output output/certification/update-guardian.json
```

Choose one fault per disposable fixture: `--interrupt-worker`,
`--interrupt-guardian`, `--interrupt-after-swap`, `--cancel-draining`,
`--stop-after-swap`, or `--reject-health`. The health-rejection case uses an
internal health seam and runs the updater directly: service lifecycle, native
swap and data preservation are real, but it does **not** prove guardian restart.
No flag exercises the ordinary successful update. The script needs permission
to use loopback servers and register its unique disposable per-user OS jobs.

## Still required

1. Production Developer ID/notarization and two-build installed project-access
   persistence, including the native window and protected project locations.
2. Physical logout/login, sleep/wake and reboot acceptance. Per-user launchd
   evidence while logged in is not evidence of execution while asleep or logged
   out. Mac process containment remains observational.
3. Physical Windows qualification and a Windows-native update path.
4. Mixed real provider work with measured outcomes and manual-rescue rates;
   these updater fixtures do not exercise subscription exhaustion or provider
   quality. Investigate the held-transport observation if it recurs under load.

Unreadable records, disk failure, revoked OS permission, changed signatures or
operator settings are not permission to guess, restore stale data or retry
forever. A clear safe stop remains the correct outcome when trust is missing.
