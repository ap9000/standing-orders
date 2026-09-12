# Per-task stop and resume certification

The production candidate `82d0d28` passed all six Linux/macOS Node 22/24 and
Windows baseline [CI jobs](https://github.com/ap9000/standing-orders/actions/runs/34685907416),
typecheck, build, and the local full suite: 138 files, 2,550 passing tests and
12 existing skips. Its executable hash is
`657506173dc5b16e20e7940adcd67d60594861631813bc5eed6de09c626257fa`.

Both real subscription providers, Claude Opus and Codex gpt-5.6-sol, passed the
ordinary authenticated console journey on that unchanged runtime. Each left an
opaque dirty draft, stopped through its exact-run form, retained the draft
across a clean worker restart, resumed through the password/nonce confirmation,
and produced one built result with new verified proof under the original scope.
Neither needed a scope edit, draft repair, result override, or other rescue.
A replayed confirmation returned 409 and changed no resume provenance. No
checkpoint descendant wrote after stop settlement. Browser polling preserved an
unsent chat message through Stopping and Paused. Desktop and phone captures had
no horizontal overflow.

The same frozen runtime passed seven real-process crash scenarios: planning,
setup, building, after commit, verification, review, and a stop recorded before
a building worker was killed. The latter left its provider alive through the
real 90-second lease expiry; recovery kept the stop pending and refused Resume.
Only after the orphan exited did ordinary reconciliation settle the stop and
permit an explicit resume. Review recovery retained the explicit bounded retry
contract. These crash fixtures use deterministic provider responses; they are
separate from the two real-provider journeys.

[The manifest and eight actual provider screenshots](../../evidence/task-control-certification/manifest.json)
record the checks and image hashes. The earlier
`evidence/safe-task-stop-and-resume` images remain the initial seeded UI evidence,
not certification of the final runtime. Raw logs, private fixture databases, and
full certificates remain in the operator checkout's `output/task-control`.

## Findings closed before release

Standing Orders build #1520 produced the initial implementation, and review
#1521 reviewed that original commit. Independent operator review then reproduced
and fixed cross-database process ownership collisions, a late-spawn cancellation
race, a gap between the stop check and terminal completion, orphan recovery
being mistaken for process exit, and review retry over a live orphan.

The real Claude journey exposed an additional failure that fixture-only tests
missed: its tool shell created a separate process group and survived the old
root-group cancellation. The final runtime observes descendant custody, freezes
and re-scans the live tree before cancellation, and shares that cancellation with
held supervisors. Separate real-process regressions cover the detached tool,
recovery after its harness dies, and rejected supervisor custody. No saved PID
is used as permission to send a signal during recovery.

A private schema 51-to-52 migration preview preserved every historical value
in 93 tables and passed SQLite integrity and foreign-key checks. Live deployment
requires a fresh backup after the existing controller is stopped; a preview is
not a substitute for validating the actual upgraded database.

## Remaining boundaries

This is process observation and cancellation, not kernel-enforced containment.
A deliberately daemonized process that reparents before observation can escape
ancestry discovery; cgroups or Job Objects and a macOS containment strategy need
their own implementation and certification. Unknown observed custody stays
blocked rather than being treated as process exit.

The Windows CI baseline now includes task-control domain, console, Git and
adversarial checks. Physical Windows provider-tree termination and a normal
unlocked macOS login/reboot recovery test remain unverified. No OS restart or
unconditional containment guarantee is claimed by these results.
