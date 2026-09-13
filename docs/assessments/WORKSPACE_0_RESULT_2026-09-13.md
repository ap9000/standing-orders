# Workspace package 0 — repository verifier discrepancy — 2026-09-13

> Revised after review of build 1542 (annotations 90 and 91 on head
> `6b125833475591ecb8aac02aa02225e19e16d913`). The measured evidence and the
> two approved-command runs below are build 1542's and are preserved as
> recorded; the cleanup is described in "Cleanup after review" at the end.

Seeded UI candidate `d12d776897e3d4a0bb329737e8f09f624285f467`. Builds 1540 and
1541 both failed the approved verifier command
(`npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build`)
on one assertion, `src/store-contention.test.ts:100`
(`a persistent lock refuses in finite time before the body, without partial writes`):
`expected 12165 to be less than 10000` and `expected 11894 to be less than 10000`.
Everything else in both retained check logs passed (160/161 files; 2784 and
2786 tests, 23 platform skips; 290.9 s and 295.8 s). This package diagnoses
that discrepancy and fixes it narrowly. The busy timeout stays 5000 ms, the
bounded-operation assertion stays `< 10000` ms, no test is skipped, no limit
is loosened, the approved command is unchanged, and nothing about the UI,
phone, recovery, installation, live database or `main` was touched.

## What was observed

Retained logs: `~/.config/standing-orders/evidence/1540/check-log.txt` and
`…/1541/check-log.txt`. Both are the serial verifier (`--no-file-parallelism`);
both overran by about 2.4× the configured five-second busy timeout.

Reproduction in the actual worker environment (this task's process tree:
`Standing Orders.app … desktop-host.js serve` → `serve-controller` → `claude`
→ shell; Node 22.22.0, SQLite 3.50.4, arm64, load average ~7 on 24 cores):

| Context | Measurement | Result |
| --- | --- | --- |
| Targeted Vitest, before the fix (`npx vitest run src/store-contention.test.ts`) | the same assertion | **failed**, `expected 12378 to be less than 10000` (12492 ms test) |
| Direct Node, no Vitest, `PRAGMA busy_timeout = 5000`, `BEGIN IMMEDIATE` against a writer held open in another process | monotonic / wall clock around the one SQLite call | 12321.5 ms / 12321 ms, `database is locked`, errcode 5 |
| Same, `busy_timeout = 1500` / `700` | monotonic | 4100 ms / 2117 ms (2.7× / 3.0×) |
| Same at 1000 ms across WAL and DELETE journal modes, `BEGIN IMMEDIATE`, `BEGIN EXCLUSIVE` and a bare `UPDATE`, with and without the writer having written | monotonic | 2741–3075 ms — the multiplier is in the wait itself, not in the statement or journal mode |

So the overrun is inside the SQLite call. The Vitest matcher is not the cause:
the targeted run failed too, and the raw call without Vitest took the same
12.3 s. The "targeted and parallel tests passed" reports attached to the
earlier builds could not be reproduced from this process tree; every run
descended from the desktop host's launchd job overran, and the only context
that did not is described next.

## Root cause

Two facts combine.

1. **SQLite's busy handler counts the sleep it asked for, not the time that
   passed.** `PRAGMA busy_timeout = N` installs `sqliteDefaultBusyCallback`,
   which sleeps in fixed steps (1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, then
   100 ms) and gives up when the *requested* steps add up to N. It never reads
   a clock. A 5000 ms timeout is ~60 sleeps, most of them 100 ms.

2. **In this process tree every blocking sleep was observed stretched by up
   to ~100 ms.** The desktop host's launch agent
   (`~/Library/LaunchAgents/com.standing-orders.desktop.plist`) sets no
   `ProcessType`; `launchd.plist(5)` says that when it is unspecified "the
   system will apply light resource limits to the job, throttling its CPU
   usage and I/O bandwidth". Part of that tier is background timer
   coalescing (`kern.timer_coalesce_bg_ns_max = 100000000`, i.e. 100 ms of
   leeway). The worker, this agent, and the verifier's Vitest processes all
   inherit it. Measured with a 20-iteration C loop from this shell:

   | Primitive, 25 ms nominal | Observed per call |
   | --- | --- |
   | `nanosleep` | 121–161 ms |
   | `usleep` | 152 ms |
   | `select` | 162 ms |
   | `mach_wait_until` | 155 ms |
   | `pthread_cond_timedwait` | 158 ms |
   | Node `setTimeout` (kqueue, not a blocking sleep) | 23.5 ms |

   And a 100 ms `nanosleep` took 233–240 ms. Sixty sleeps × ~+120 ms ≈ +7 s,
   which is exactly the 12.2 s observed for a 5000 ms timeout.

   The same binaries under temporary launchd jobs (bootstrapped and booted
   out again under throwaway labels, nothing installed):

   | `ProcessType` | 25 ms `nanosleep` | 100 ms `nanosleep` | SQLite handler, 1000 ms timeout |
   | --- | --- | --- | --- |
   | `Interactive` | 31.8 ms | 106 ms | 1098 ms (1.1×) |
   | `Standard` | 157 ms | 243 ms | 2791 ms (2.8×) |
   | `Adaptive` | 212 ms | 279 ms | 4324 ms (4.3×) |
   | `Background` | 215 ms | 270 ms | 4281 ms (4.3×) |
   | unspecified (the desktop host's job, this tree) | 140–161 ms | 233–240 ms | 2879–3075 ms (2.9–3.1×) |

   `taskpolicy -c/-l/-t/-d/-g` and `taskpolicy -B -p <pid>` on a child did
   not lift the effect from inside the tree; of the jobs tried, only the one
   whose own plist said `Interactive` slept close to nominal. These are
   observations from one machine on one day, not a characterisation of
   every scheduling tier.

The five-second promise therefore held in nominal sleep but not in real time,
and the test — correctly — measures real time.

## The fix

`src/store.ts`: `Store.transact()` now begins its write through
`beginWriteWithin(db, 5000)`. Each `BEGIN IMMEDIATE` attempt spends one short
slice (`PRAGMA busy_timeout = 100`, nominal) inside SQLite's busy handler, so a
brief competing writer still queues at the lock boundary without a round
trip; the five-second budget is accounted in elapsed `performance.now()`
time — the loop stops retrying once the budget has elapsed — so the refusal
lands within the budget plus the *actual* latency of one attempt. This is
elapsed-time accounting, not a hard deadline: one attempt is a blocking
SQLite call, and if the OS suspends or stretches it (sleep, heavy
throttling) the refusal can arrive later than budget + one nominal slice.
In the measurements here the last attempt cost a few hundred milliseconds,
which is why the refusal landed at 5590 ms rather than 5000. Only the `BEGIN`
itself is retried — a body never runs before its
connection holds the write lock, so nothing is partially written or replayed,
and a non-`SQLITE_BUSY` error is rethrown at once. The connection's own
`PRAGMA busy_timeout = 5000` is restored whichever way the loop ends, so every
other statement on the connection keeps exactly the wait it had. Every
connection-opening path is unchanged (`schema-epoch.test.ts`, which keys on
the exact `PRAGMA busy_timeout = 5000` text at open, still passes).

Coverage: only the `Store.transact()` entry is clock-accounted. Autocommit
statements and the other `BEGIN IMMEDIATE`s in `src/store.ts` (`migrate` and
the per-version table rebuilds) keep SQLite's plain 5000 ms nominal wait —
see the caveats.

Observed after the change, same process tree: the raw handler still ran
3.08× its timeout (1000 → 3076 ms), and `Store.transact` refused at 5590 ms
with zero body calls, `busy_timeout` back at 5000, and a write recovering
after release (historical diagnostic output below).

## Regression coverage

`src/store-contention.test.ts`:

- The persistent-lock test times the SQLite call alone — the matcher runs
  afterwards, outside both clocks — and asserts the refusal on the monotonic
  and the wall clock (`< 10000` ms on both, unchanged bound), that the full
  five-second budget was spent (`>= 5000` ms monotonic, so the wait cannot be
  quietly shortened), that the body never ran, that nothing was written, that
  `busy_timeout` is back at 5000, and that a write recovers after release.
  Its failure message carries both clock readings and a calibration of how
  far this process stretches a 25 ms sleep, so a future overrun says which
  clock moved and whether the tier did it.
- Two tests that do not depend on the OS tier, through a `connect` double
  whose `BEGIN IMMEDIATE` costs 400 ms of real time per attempt (the 4× stretch
  in miniature) and refuses with `SQLITE_BUSY`: the refusal arrives after
  5000–10000 ms and at most 14 attempts (nominal accounting would have taken
  ~20 s); and a non-busy error (`SQLITE_READONLY`) is not retried, refuses in
  under a second, and leaves `busy_timeout` restored.

Historical diagnostic (not shipped): build 1542 also carried a one-off
script, `scripts/busy-wait-diagnostic.mjs`, that measured sleep calibration,
the raw handler at 1000 ms, `Store.transact` at its 5000 ms budget, and
recovery in this process tree. It was outside package 0's approved touches
and its IPC waits on the writer child had no timeouts, so review annotation
90 removed it from the integration candidate. Its already-observed output is
kept below as evidence of what was measured on 2026-09-13; nothing in the
repository reproduces it, and no bounded reproducer is claimed to ship.

## Commands and results

Before the change (this process tree):

```
$ npx vitest run src/store-contention.test.ts
× a persistent lock refuses in finite time before the body, without partial writes 12492ms
AssertionError: expected 12378 to be less than 10000
```

After the change:

```
$ npm run typecheck                                   # exit 0
$ npx vitest run src/store-contention.test.ts src/schema-epoch.test.ts
Test Files  2 passed (2) / Tests  8 passed (8)         # persistent lock: 6357 ms
$ node scripts/busy-wait-diagnostic.mjs                # exit 0 (historical; script since removed)
{"phase":"sleep calibration","nominalMs":25,"observedMs":93}
{"phase":"SQLite busy handler alone","busyTimeoutMs":1000,"monotonicMs":3076,"wallMs":3077,"error":"database is locked","ratio":3.08}
{"phase":"Store.transact, clock-bounded","budgetMs":5000,"monotonicMs":5590,"wallMs":5590,"error":"database is locked","bodyCalls":0,"busyTimeoutAfter":5000}
{"phase":"recovery after release","recovered":true}
```

## Approved command, twice consecutively

Same process tree as every measurement above, after the final change, one
run started as soon as the previous finished
(`npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build`):

| Run | Typecheck | Serial full suite | Build | Exit | Wall time |
| --- | --- | --- | --- | --- | --- |
| 1 | passed | 161 files passed (161); 2789 tests passed, 23 skipped (2812); 284.34 s | passed | 0 | 286 s |
| 2 | passed | 161 files passed (161); 2789 tests passed, 23 skipped (2812); 287.35 s | passed | 0 | 288 s |

The 23 skips are the pre-existing platform skips (Linux cgroup and Windows
Job Object facilities) that builds 1540 and 1541 also reported; nothing new
is skipped. The test count grew by exactly two from build 1541 (2810 → 2812):
the two tier-independent regression tests above. The persistent-lock test is
one test, as before.

## Caveats

- The earlier builds' reports that targeted and parallel runs passed were not
  reproducible here: in this process tree the targeted test failed before the
  fix in the same way as the serial verifier. Those earlier runs presumably
  happened in an interactively scheduled context (a terminal, or a job with
  `ProcessType=Interactive`), where the handler's five seconds are ~5.5 s.
- The stretch is not a test artefact. The installed desktop host runs under
  the same launch agent, so in production its own SQLite busy waits — and any
  other blocking sleep in it or its children — were measured 2–4× longer
  than nominal on this machine. Declaring `ProcessType` in the generated
  launch agent is a *separate, untested* installation option: the throwaway
  launchd jobs above suggest `Interactive` sleeps closer to nominal, but
  that was never tried on the installed service, it touches the installation
  and the live service, and it is not a guaranteed remedy. It is left to the
  operator as a follow-up, not relied on. This fix does not depend on it:
  the `Store.transact` write wait is accounted in elapsed time, so the
  refusal lands within the budget plus the actual latency of one attempt —
  not a hard deadline against OS suspension.
- Statements that do not go through `Store.transact()` — autocommit writes and
  the migrating door's own `BEGIN IMMEDIATE`s — keep SQLite's unchanged
  5000 ms nominal wait, so under this tier they still wait ~12 s for a
  persistent lock. That is the behaviour the earlier builds shipped; only the
  `Store.transact` entry is clock-accounted here — not every write.
- Numbers above are from one machine under a load average of ~7; they vary
  run to run by a few hundred milliseconds and are reported as observed.

## Cleanup after review

Lineage: this section revises the package after the operator reviewed build
1542 (source task `workspace-0-verifier-20260913`, head
`6b125833475591ecb8aac02aa02225e19e16d913`, scope digest
`44461243aa89a575268b604f078bafda`), which itself followed builds 1540 and
1541. Two annotations were applied, and nothing else:

- Annotation 90 (`scripts/busy-wait-diagnostic.mjs`): the script was removed.
  It was outside package 0's approved touches and its IPC waits on the writer
  child had no timeouts. Its already-observed output is kept above as
  historical diagnostics from 2026-09-13; no bounded reproducer ships.
- Annotation 91 (`src/store.ts`): only the `beginWriteWithin` doc comment
  changed. It, and this document, now say that the wait is elapsed-time
  accounting plus the actual latency of one attempt — not a hard deadline,
  and one that OS suspension can exceed; that only the `Store.transact` entry
  is covered, not every write; and that a `ProcessType` change is a separate,
  untested installation option rather than a guaranteed remedy.

Unchanged: every executable line of `src/store.ts` (`beginWriteWithin`,
`isDatabaseBusy`, `WRITE_WAIT_SLICE_MS`, `CONCURRENT_WRITER_WAIT_MS`,
`Store.transact`), `src/store-contention.test.ts` and its assertions, the
5000 ms busy timeout, the `< 10000` ms bound, the approved command, the
installation, the live service and the live database. The two approved-command
runs recorded above remain build 1542's evidence as measured. No new
diagnostics were added.

Checks for this cleanup, same process tree:

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run src/store-contention.test.ts src/schema-epoch.test.ts` | exit 0; 2 files, 10 tests passed (persistent-lock and stretched-writer tests included) |
| `npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build` (once) | exit 0; 161 files passed (161); 2789 tests passed, 23 skipped (2812); 288.14 s suite, ~290 s wall |

The 23 skips are the same pre-existing platform skips as in builds 1540–1542,
and the test count is unchanged from build 1542 (2812).
