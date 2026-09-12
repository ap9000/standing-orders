# Live controller upgrade

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
