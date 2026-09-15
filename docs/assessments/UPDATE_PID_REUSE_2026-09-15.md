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

The following repair-candidate section is the retained run1611 builder
assessment, including its original branch, checks, fingerprint and rubric.
Those are historical claims, not results for the recovery below. See
**Recovery attempt 1 of at most 3** for the current candidate and checks.

## Repair candidate — 2026-09-15

Starting HEAD is `dd7c633a83757b585ec6b052509dc64a1772c2a1`, the operator's
documentation-only descendant of verified baseline
`93aa8449fb3eab98c04db736a67027466db43b1e`. An ancestry check passed and the
initial diff against that baseline contained only this assessment. HEAD and
branch `standing-orders/update-pid-reuse-20260915` were left unchanged.

The product change is confined to `process-liveness.ts` and one store call.
After a successful PID existence probe, macOS reads `/bin/ps -p PID -o lstart=`
with `LC_ALL=C` and `TZ=UTC`. It validates the entire date, including weekday,
and treats the displayed second as the earliest possible birth time.
Apple's [ps implementation](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c#L648-L660)
formats the seconds field of the kernel start timestamp through local time;
it does not round microseconds into the next second.

A PID is reused only when this lower bound is strictly later than **both**
the canonical UTC millisecond witness observation and the owning run's finish
time. The second bound matters because `reserveRunProcess` records its time
before spawning. A legitimate delayed spawn during the run must not be
dismissed. Equal-second, missing, malformed, noncanonical, future birth,
unreadable and unsupported identity evidence all retain the blocker.

The existing group probe runs first. A populated group, denied group probe or
unknown group probe returns occupied without reading the leader's birth time.
Only `ESRCH` on the group allows the PID fallback. Native containment, boot,
host, owned-process, held-session and worktree-occupancy checks keep their
existing order and authority. Reading quiescence does not update witness rows
or grant authority to signal their PIDs. No schema or runtime policy changed.

### Read-only Mac sample

At `2026-09-15T17:15:47Z`, this worktree ran on macOS 26.5.2, build 25F84.
The assessment's existing example was rechecked with:

```sh
LC_ALL=C TZ=UTC /bin/ps -p 87803 -o pid=,pgid=,lstart=,comm=
```

Exit 0, output:

```text
87803 87719 Mon Sep 14 14:33:43 2026     /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl
```

The same PID with `LC_ALL=C TZ=America/Los_Angeles /bin/ps -p 87803 -o lstart=`
returned `Mon Sep 14 07:33:43 2026` (exit 0). The UTC birth lower bound
`2026-09-14T14:33:43.000Z` is strictly newer than run 1523's historical
observation `2026-09-12T16:53:59.658Z`. PGID 87719 is descriptive only; a
different leader or PGID does not prove historical group 87803 empty.

This diagnosis used `ps` only: no signals, live database access or witness
edits. It confirms the reported birth mismatch, not production-wide
quiescence. The original 40-row count and this run's finish timestamp were
not independently re-read. The new real-host regression additionally queries
its own process: an artificial 1970 witness is absent on macOS, while a current
observation remains live. This exercises the actual adapter without relying
on PID 87803 continuing to exist.

### Checks and exact candidate

The source-and-test candidate is baseline
`93aa8449fb3eab98c04db736a67027466db43b1e` plus the uncommitted `src` diff with
SHA-256 `7447f566e03dbe055c943b0f55585c25c8faf66a77c6cae9a01b7c175d903276`.
Reproduce that digest with:

```sh
git diff --binary 93aa8449fb3eab98c04db736a67027466db43b1e -- src | shasum -a 256
```

Checks actually run in this isolated worktree:

- `npm run typecheck`: exit 0. Production code was unchanged afterward.
- `npm exec -- vitest run src/process-liveness.test.ts src/task-control.test.ts src/desktop-update.test.ts src/containment.test.ts`: exit 0; 135 tests passed, four files, 24.56 seconds.
- `npm exec -- vitest run src/boot-identity.test.ts src/migration-v53-process-custody.test.ts src/task-control-adversarial.test.ts`: exit 0; 23 tests passed, three files, 2.87 seconds.
- `git diff --check`: exit 0.

The test bootstrap built this isolated worktree once with `npm run build`;
the installed project root was not rebuilt. An initial five-file focused run
had two boot-fixture failures: those fixtures paired today's real PID with a
backdated observation, unintentionally describing reuse. Their observation
now uses the actual current time. All existing assertions remain, and the
corrected boot suite passed. No test was deleted and no skip was added.
Migration and adversarial stop tests were included specifically to check
the surrounding custody behavior. Test fixtures use isolated databases and
owned child processes; the new regressions mock probes and assert signal zero
only, as well as byte-for-byte-equivalent retained rows after updater checks.

### Limits and final gate

Birth comparison is macOS-only and accepts only the timestamp format emitted
by the store. It uses recorded UTC wall-clock times, not a historical kernel
birth token. Same-second uncertainty and births during the owning run remain
blocked. This may deliberately retain some stale witnesses. The real sample
is a point-in-time diagnosis; it does not authorize an update or certify that
all process groups are empty.

The signed criterion **c4**, “Final native verifier passes on exact candidate
with no deleted tests or added skips and limitations recorded”, remains
unmet at builder handoff: the task rule reserves the approved full verification
command for the machine and forbids the builder from running it. The final
native gate must verify the machine's sealed candidate. No full suite,
deployment, live database mutation, approval change or network write was
performed. The handoff proof records the complete diff fingerprint and every
changed path from `9717d5939777a3366d9c27237c28bfe26ee06913`, including earlier
branch changes; the builder's focused checks cover this repair, not a fresh
full verification of those earlier changes.

## Recovery attempt 1 of at most 3 — 2026-09-15

The failed run1611 result is preserved. Its candidate
`f0986ae0cba3cb9fa86d5c9ca8763fcbbf62796f` reportedly passed 3044 tests and
failed two restart-certification cases at the native gate. The first review
also refused a diff pinned to `9717d5939777a3366d9c27237c28bfe26ee06913`:
unrelated UI commits exceeded its evidence limits. These outcomes are not
converted to successes and the recovery does not reset the retry count.

This prepared worktree stays on
`standing-orders/update-pid-reuse-proof-20260915` at unchanged HEAD
`dd7c633a83757b585ec6b052509dc64a1772c2a1`. The verified `93aa8449` ancestor
differs from that HEAD only by the original 46-line assessment. The exact
`dd7c633..f0986ae0` implementation diff was inspected and applied with
`git apply`, without committing, cherry-picking or moving HEAD. The new
test file has intent-to-add so ordinary `git diff` includes its full content;
all changes remain uncommitted.

### Changes and review

- The macOS `ps` birth lookup now has a 1000 ms subprocess timeout, a 1024-byte
  output cap and an uncatchable termination signal for that owned diagnostic
  child only. It imposes no task, agent or scheduler deadline and grants no
  signal authority over a saved PID/PGID. Timeout or overflow, even with
  plausible partial stdout, returns unknown and retains the blocker.
- Both boot-identity and restart-certification fixtures now anchor their
  entire timeline to a current `T0`, after the test process was born. Run
  start, observation, finish and heartbeat remain ordered using that same
  baseline. This replaces the earlier boot fixture's mixture of a Sept 12
  run and a current observation. All existing same-boot, pending-stop,
  verified-boot-change and recovery assertions remain unchanged.
- The mocked store/updater reuse regressions pin the diagnostic clock to
  Sept 15 along with their Sept 12 witnesses and Sept 14 OS births. Real-host
  checks keep real time and real process identity.
- Every product/test hunk was reviewed. Product changes remain the liveness
  adapter and one store argument. The boot/host/native-containment/owned-child/
  held-session/worktree gates retain their order. Populated, denied and unknown
  groups stop before birth lookup; an absent group alone permits the PID
  fallback. Unsupported platforms retain existing behavior. Store/updater
  regressions compare all retained witness columns before and after diagnosis.
  No tests were removed, no skips added, and no UI, schema, permission, artifact
  cap, verifier configuration or historical result was changed.

### Fresh read-only Mac evidence

At `2026-09-15T17:35:45Z`, `sw_vers` reported macOS 26.5.2, build 25F84.
`LC_ALL=C TZ=UTC /bin/ps -p 87803 -o pid=,pgid=,lstart=,comm=` exited 0:

```text
87803 87719 Mon Sep 14 14:33:43 2026     /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl
```

`LC_ALL=C TZ=America/Los_Angeles /bin/ps -p 87803 -o lstart=` also exited 0
and returned `Mon Sep 14 07:33:43 2026`. This confirms the UTC conversion and
birth mismatch against the retained observation `2026-09-12T16:53:59.658Z`.
The fresh sample neither rereads the live database nor proves the run finish
bound or group emptiness. The earlier 40-row count was not remeasured. No
historical process was signalled and no live witness was edited.

The passing process-liveness suite additionally exercises the actual macOS
adapter against its own live PID with artificial 1970 and current witnesses:
only the old identity is dismissed. This durable test does not depend on
PID 87803 surviving. The timeout and overflow regressions use injected errors;
no live process was deliberately stalled or killed for diagnostic evidence.

### Current checks and candidate identity

The final source/test diff from `dd7c633` is 19206 bytes, SHA-256
`2b48c02b581f573af885be3e4597e9b3c4106a1dcc1b0c57dcd40cfb9136fe9e`.
Reproduce it with `git diff --binary dd7c633 -- src | shasum -a 256`.
The proof also records the complete eight-path source/test/assessment diff
fingerprint, without embedding its own digest in this document.

- `npm run typecheck`: exit 0 on the final source/test candidate.
- `npm exec -- vitest run src/process-liveness.test.ts src/task-control.test.ts src/desktop-update.test.ts src/boot-identity.test.ts src/restart-certification.test.ts src/containment.test.ts src/migration-v53-process-custody.test.ts`: exit 0; 156 tests passed across seven files, 24.36 seconds.
- `git diff --check`: exit 0. The complete diff includes only the eight expected
  paths, including the new process-liveness suite, and fits the unchanged
  256 KiB terminal-diff cap. The machine still owns sealed evidence capture.

Before correcting the clock, the restart suite reproduced both reported
failures (4 passed, 2 failed): it settled the stop before the simulated reboot
and reported no pending same-boot stop. Those original assertions now pass.
An intermediate affected run with `TMPDIR` forced into this long worktree path
passed 155 tests but failed one unchanged containment test because a 178-byte
socket path exceeded macOS's 103-byte limit. Restoring the test harness's
normal temporary-directory behavior produced the passing 156-test run above;
no socket limit or test assertion changed. The test bootstrap built only this
isolated worktree once. It did not rebuild the installed root.

### Remaining gate and limits

**c4 is not yet met at builder handoff.** Its requirement that the exact final
candidate pass the unchanged native full verifier cannot be completed by the
builder: the task rule says the configured verification command is run by the
machine itself, never by the builder. The native gate must run it once on the
sealed candidate, and independent review must inspect the machine's complete
diff. This attempt did not run the full verifier or change its command/caps.

Birth evidence remains macOS-only and uses canonical recorded wall-clock
times, not a retained kernel birth token. Same-second ambiguity, birth during
the owning run, unreadable identity and lookup failures deliberately retain
the blocker. The sample is a point-in-time diagnosis, not production-wide
quiescence or deployment approval. No runtime deployment, live database write,
witness rewrite, public push, API billing or history change occurred.

## Recovery attempt 2 of at most 3 — 2026-09-15

The remaining historical-process blockers are resolved by the bounded Darwin
identity extension below. At 18:14:29 UTC, the candidate's read-only diagnosis
returned no quiescence problems for 78 ended runs; the baseline had blocked 12
of those runs. This is not a completed update or installation-wide idle claim.

This worktree started and remains on `standing-orders/update-group-identity-20260915`
at `67c30b3232f024a8b13b72d693fe35ce0114c984`. The task reports that this preseeded
candidate passed 3048 tests and that Opus upheld four prior criteria; those
sealed outcomes were not independently rerun or rewritten here. This section
records attempt 2, including the explicitly authorized extension for **proven**
PGID reuse and independently readable birth after an EPERM existence probe.
The earlier sections remain historical assessments of narrower candidates.

### Primary-source reasoning

Independently read Apple's pinned
[forkproc allocator](https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/bsd/kern/kern_fork.c#L950-L1007).
Its non-exec allocation loop rejects numbers present in the PID, process-group
or session hash; allocation and insertion hold `proc_list_lock`. Exec copies
the existing PID, and the same file
[preserves its original birth time](https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/bsd/kern/kern_fork.c#L1131-L1140).
Separately, [group lookup](https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/bsd/kern/kern_proc.c#L2711-L2739)
checks the group hash under that lock;
[group deletion](https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/bsd/kern/kern_proc.c#L3107-L3116)
asserts an empty member list before removing the hash entry.

**Inference:** if the current process whose **PID equals the historical PGID**
has a proven later birth, the historical group had ended before that number
could be allocated again. A group occupying the number now is a later group.
This does not claim the current group is empty or authorize signalling it.
A newer member with a different PID gives no evidence about the group's age.
A missing leader also proves nothing: orphan children keep their group alive.
Exec of the original leader cannot manufacture a later birth for this proof.

The [source commit](https://github.com/apple-oss-distributions/xnu/commit/ac9718fb1af618d5ce8678d0dc6e8a58f252216f)
is the `xnu-12377.121.6` import. `uname -a` reports this Mac's kernel as
`xnu-12377.121.10~1/RELEASE_ARM64_T6020` (Darwin 25.5.0); `sw_vers` reports
macOS 26.5.2, build 25F84. Apple's GitHub matching-refs query for
`tags/xnu-12377.121` returned only `.6` during this review. The exact `.10`
tag was unavailable: this is source-backed inference from `.6`, not an audit
of the installed kernel binary or an assertion that the versions are identical.

### Bounds, boot identity and conservative outcomes

The existing `/bin/ps -p PID -o lstart=` adapter remains unchanged: `LC_ALL=C`,
`TZ=UTC`, one-second diagnostic timeout and 1024-byte output cap. Apple's
[lstart formatter](https://github.com/apple-oss-distributions/adv_cmds/blob/6bed8737a34dbb54782a18f47dccf933a9967a12/ps/print.c#L680-L693)
uses the kernel start timestamp's seconds field through local time. The
displayed UTC second is a lower bound, not microseconds rounded upward.
It must be strictly after both the canonical millisecond observation and run
finish. Equal seconds, birth during the run, future/invalid dates, malformed
or missing witness times and all failed/partial birth reads remain occupied.
This retains the prior wall-clock comparison: no historical monotonic birth
token or clock-step history was recorded, so independent reconstruction of
past clock adjustments is unavailable. Elapsed age is never evidence.

The allocator argument works within a boot; it does not require a reboot.
Run 1548's recorded boot UUID matches the current normalized kernel UUID,
`0774c645-ad9a-4d83-9efb-eca6506656c5`, yet its numeric group was reused.
Runs 1523 and 1525 have legacy NULL boot IDs. No boot-change proof is invented
for them: the existing local birth comparison still applies. If an old group
was from another boot it cannot survive; if from this boot, the allocator
exclusion applies. Boot time arithmetic is not substituted for the boot UUID.

The store's existing order is unchanged: an open run, owned child or held
supervisor blocks first; verified boot change remains a separate proof;
foreign hosts, incomplete/native containment custody and worktree occupancy
retain their guards. No store or boot/restart fixture edit was necessary.
Only successful or EPERM signal-zero probes gain the bounded Darwin birth
check. Other probe errors, unsupported systems, original live groups and
orphan groups without a readable proven-new exact-number PID stay occupied.
EPERM itself is not proof; denial of the independent birth lookup still blocks.

### Fresh live read-only results

Both diagnoses opened `~/.config/standing-orders/orders.db` with
`DatabaseSync(..., { readOnly: true })`, set `PRAGMA query_only=ON`, and used a
read transaction with `new Store(db).stopQuiescenceProblem(runId)` for every
distinct ended run with an unexited witness. They did not call a store opener
that creates/migrates the database, settle a stop, or run the updater. A wrapper
rejected any requested nonzero signal. Only signal-zero probes and bounded
`ps`/boot-identity reads were used against existing processes.

- Baseline at `2026-09-15T18:11:08.770Z`: 78 ended runs checked, 12 blocked
  (1523, 1525, 1535, 1542, 1546, 1548, 1550, 1555, 1565, 1572, 1598, 1604).
  25,631 signal-zero calls; SQLite `total_changes()` was zero.
- Candidate at `2026-09-15T18:14:29.952Z`: the same 78 ended runs checked,
  zero problems. Including the explicit samples below, 36,260 signal-zero
  calls encountered 12 EPERM results. The snapshot had 31,686 retained rows
  across 79 runs, including the current open builder run 1616.
- All `run_process` columns, ordered by ID, hashed identically before and
  after the candidate diagnosis inside its read transaction: SHA-256
  `50ee35dea1bb7fa34a491cd09e64c7f4ebc5831e7047beb8a4a84d1965ca197b`.
  SQLite `total_changes()` was zero. The live controller can independently
  add records between snapshots; this hash does not assert global inactivity.

Re-resolved sample rows and UTC birth lower bounds:

| Run / row | PID / historical PGID | Observation | Run finished | Current birth | Signal-zero result |
| --- | --- | --- | --- | --- | --- |
| 1523 / 616 | PID 65949 | 2026-09-12T16:53:20.424Z | 2026-09-12T17:07:14.824Z | 2026-09-13T19:31:22.000Z | PID: EPERM |
| 1525 / 2919 | PGID 65058 | 2026-09-12T18:48:12.284Z | 2026-09-12T19:22:17.385Z | 2026-09-15T05:07:32.000Z | PID and group: present |
| 1548 / 15992 | PGID 31964 | 2026-09-14T00:28:37.547Z | 2026-09-14T00:53:45.504Z | 2026-09-15T00:21:28.000Z | PID and group: present |

`LC_ALL=C TZ=UTC /bin/ps -p 65058,31964 -o pid=,pgid=,lstart=,comm=` exited 0.
The exact per-PID reads in the candidate sample also exited 0: 65058 was
`VTDecoderXPCService`, 31964 was `OneDrive Sync Service`, and denied PID 65949
was `/usr/sbin/cfprefsd`. All three current PGIDs equalled their PIDs. All
three historical identities returned `false` from `processMayBeAlive`.
Names and present membership are descriptive, not inputs to the proof.

The live database reports schema 58; the checkout expects 60. Direct read-only
use of the compatible quiescence queries above neither certifies the updater's
schema gate nor bypasses it in production. No schema was changed. This active
builder also prevents an installation-wide idle claim. A later updater must
repeat its own admission, schema, process and containment checks.

### Focused verification and review patch

The product change is confined to `src/process-liveness.ts`; tests extend the
existing process, task-control and updater suites. The original PID/group
cases remain, with the explicitly extended reuse outcomes updated. Negative
birth cases now cover successful and EPERM probes for both PID and PGID;
orphan tests ensure only the exact historical number can supply identity.
The two live PGID observations are retained as deterministic regression inputs.
Updater regressions cover successful reuse, EPERM reuse, original and orphan
groups, unreadable birth and same-second ambiguity. Store and updater tests
compare every retained witness column and assert signal zero only.

- `npm run typecheck`: exit 0.
- `npm exec -- vitest run src/process-liveness.test.ts src/task-control.test.ts src/desktop-update.test.ts src/boot-identity.test.ts src/restart-certification.test.ts`: exit 0; 144 tests, five files, 28.40 seconds.
- `npm exec -- vitest run src/desktop-update.test.ts`: exit 0; 56 tests,
  26.43 seconds, after distinguishing the original-birth fixture from the
  same-second fixture. Typecheck also passed again on the final source/tests.
- `git diff --check`: exit 0.

Source/test diff SHA-256 from unchanged HEAD:
`562e106d5a529546027f03c927fc7061ea5ab866d0e2c36914a78f6367c67d3a`.
Reproduce with `git diff --binary HEAD -- src | shasum -a 256`. The handoff
proof records the complete five-path diff fingerprint, including this appended
assessment. Review covered every hunk; no prior assessment text was rewritten.
The test bootstrap built only this isolated worktree. No tests were removed,
skips added, or verifier, schema, artifact cap, approval or containment policy
changed. HEAD was not moved and all edits remain uncommitted.

The unchanged native full verifier and independent review remain the machine's
next steps on its sealed candidate; the builder did not run that full gate.
There was no deployment, installed-root rebuild, live database/witness write,
nonzero signal to an existing process, network write, paid API or scheduler change.
