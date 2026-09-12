# Live controller upgrade

## Current installation: schema 52

The subsequent schema-55 completion release is staged at
`~/Applications/Standing Orders Completion Preview.app`, with its exact runtime,
provider journeys, crash recovery and private migration rehearsal recorded in
[the completion/recovery result](COMPLETION_RECOVERY_2026-09-12.md). The live
controller has not been replaced: the existing macOS Documents-access gate
remains unresolved and live work is active. Use a fresh backup after that gate
passes and work drains; the rehearsal snapshot must not replace newer work.

At 2026-09-12 09:38:50 UTC, the installed desktop controller was upgraded to
schema 52 after [PR #2](https://github.com/ap9000/standing-orders/pull/2) merged
to main as `4c70a8c`. The production source is `82d0d28`; subsequent changes
only record certification and deployment. The installed executable hash is
`657506173dc5b16e20e7940adcd67d60594861631813bc5eed6de09c626257fa`, matching
both real-provider Stop/Resume certificates and the staged signed app.
[All six checks on the final PR head passed](https://github.com/ap9000/standing-orders/actions/runs/34686200623).

The existing controller was stopped with no active runs or claims. A fresh
private schema-51 backup and the previous app are retained under the normal
configuration backup directory. The actual migration preserved every historical
value across 93 tables; integrity and foreign-key checks passed before restart.
The modern `com.standing-orders.desktop` service is running on localhost:4180,
the legacy service remains unloaded, and the same three projects reconnect.
The fresh desktop challenge/HMAC and saved login passed. Authenticated desktop
and phone pages fit their viewports; a new post-deployment runner heartbeat and
zero open runs were confirmed at 09:40:15 UTC.

The private state directory now records `deployed-runtime.json`, including the
source, merge commit, executable hash, installation time and backup location.
Local verification artifacts are `output/task-control/installed-v52.json` and
`live-v52-migration.json`. [Certification and remaining process-containment
boundaries](STOP_RESUME_CERTIFICATION_2026-09-12.md) are recorded separately.
Unlocked native window/Keychain and physical login/reboot recovery checks remain
unverified; ordinary service health does not establish automatic OS recovery.

## Earlier schema-51 upgrade

The operator authorized upgrading the installed controller and pushing main on
2026-09-12. PR #1 merged as `7b9bebe`; main and origin/main agree. The six
Linux/macOS Node 22/24 and Windows baseline CI jobs passed on the reviewed head.

The installed legacy worker was already stopped, with no open runs and no
console listener. Its old LaunchAgent was unloaded. A private SQLite backup of
schema 49 was made before the official migration to schema 51. Integrity and
foreign-key checks passed. Every original table retained its row count and all
original column values; only the schema-version row intentionally changed.
Existing operator credentials still authenticate.

The macOS app was built, signature-verified, and installed at
`~/Applications/Standing Orders.app`. Its bundled executable hash is
`bb56ddbee14dec222d131fb65483d27aec51858ebb559571bfdd7bc38edc9d5c`, exactly the
runtime certified by both full provider handoff journeys and the 20-case pilot.
The native shell's existing `up` entry point now runs under the independent
`com.standing-orders.desktop` LaunchAgent, on localhost port 4180, reconnecting
the same three saved projects. The legacy worker is not also running.

The fresh desktop challenge/HMAC matched. The saved login opened authenticated
workbench and project pages. The repository-bound runner published fresh
heartbeats, with no orphan open runs at the initial health check. Local logs and
sanitized evidence are in the main checkout's `output/live-upgrade-*` files.
The pre-upgrade backup remains under the private configuration backup directory.

Native window and Keychain interaction still need a normal unlocked user
session; those checks are not implied by the successful service, bundle,
authenticated HTTP, and launchd checks. Closing the app window does not own the
worker lifecycle. The old reliability checkout and old service definition remain
available as rollback references; restoring an old database after new work must
first account for that new work.

The next distinct implementation wave is
[per-task stop and resume](../TASK_CONTROL_PLAN.md).

## First-use contention regression

Filing that task exposed a real failure after initial health checks: an
overlapping CLI write returned `database is locked`, and the watch subsequently
exited on the same error. The approved task remained queued with no open run.
An isolated two-process reproduction failed both at CLI schema opening and at
the non-migrating desktop connection's `BEGIN IMMEDIATE`.

All database opening paths now install SQLite's connection-local five-second
busy timeout before issuing statements. SQLite waits at its lock boundary; the
application never reruns a transaction body. A persistent lock still refuses in
finite time. Failed migrating opens close their connection, releasing any
remaining locks. This follows [SQLite's busy-handler semantics](https://www.sqlite.org/c3ref/busy_timeout.html).

Real-process regressions prove a short writer can finish, the waiting action
executes once, a persistent writer permits no partial action, and reporting
remains read-only. The actual built desktop helper also accepts a CLI filing
during contention and continues serving authenticated pages. The full gate
passes 133 test files, 2,511 tests and 12 existing skips, plus typecheck and build.

An isolated launchd probe in this session did not automatically relaunch its
deliberately failed process within 15 seconds. The same result occurred with
conditional and unconditional KeepAlive and Interactive process type. Explicit
kickstart worked. No speculative plist change was applied to the app, and no
automatic OS crash-restart claim is made from these checks. An unlocked-session
restart/login test remains a deployment certification gap.

The contention fix shipped to main as `60a10de`, passed all six CI jobs
(run `34681979691`), and replaced the installed bundle. After explicit startup,
the live controller admitted task `safe-task-stop-and-resume` as run #1520 on
that exact base commit. Authenticated desktop and phone captures fit their
viewports, and fresh runner heartbeats continued during real provider work.

The earlier merge's Windows Node 22 job had one graph-test timeout: its 15-second
test ceiling was shorter than discovery's sequential 10-second local and
20-second network ceilings. The same code subsequently passed on both Windows
versions. The test now allows those bounded operations to settle before fixture
cleanup, and the Windows gate includes the new real-process contention tests.
