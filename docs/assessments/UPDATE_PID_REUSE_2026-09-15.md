# Deployment blocked by reused process IDs

Reproduced 2026-09-15, read-only. Current task admission counts are zero for
runs, claims, conversations, held sessions and unsettled stops. The existing
updater's `stopQuiescenceProblem` still refuses historical witnesses.

Forty retained witness rows referred to 37 currently existing PIDs. Every one
of those current processes started after its corresponding witness observation
according to macOS `ps -p PID -o lstart=`. Example: run 1523 recorded PID 87803
at 2026-09-12T16:53:59.658Z; the current process at that PID started on Sept 14.
Counts change as the OS creates/exits processes. No processes were signalled,
no witnesses marked exited, and no update guard removed.

`processMayBeAlive` uses signal zero against saved PID/PGID without birth
identity. A reused unrelated PID therefore blocks an otherwise idle update.
The native updater uses this function indirectly for every historical witness.

## Bounded repair

Use a conservative read-only birth-identity check on supported platforms when
the PID exists. Reject reuse only when OS evidence proves the current PID is
newer than the recorded observation. Preserve unknown/denied/invalid/ambiguous
cases as potentially live. Never let a newer group leader prove an existing
process group empty: a populated or unknown group must still block. Account
for timestamp precision and timezone, not a broad age timeout. No kill authority
comes from a historical PID. Unsupported platforms retain their existing safe
behavior until their corresponding check is implemented and tested.

Prefer the smallest change in process-liveness/store and focused tests. Do not
change schema, delete witnesses, reset history, weaken native containment or
boot checks, change execution permissions, or deploy from the builder. Use an
isolated checkout based on verified 93aa8449fb3eab98c04db736a67027466db43b1e;
never rebuild the active installation. Read-only diagnosis against real records
is useful evidence, but the native gate owns the one final full verifier.

Verify reused single PIDs and absent groups with recycled leader PIDs; genuinely
live processes/groups, unknown process identity, denied probes, missing birth
timestamps and unsupported platforms must remain protected. Include a real
read-only Mac sample and record limitations. A supported API fix must pass
normal review before it is used for the production update.

Related: [deployment checkpoint](ONE_ACTION_DEPLOYMENT_2026-09-15.md). The user
has now authorized keeping the installation current. Browser background access
passed for all three enrolled projects at 16:52:39 UTC; temporary probe service
was removed. Live schema/runtime remain unchanged until this guard can prove
the old work has ended.
