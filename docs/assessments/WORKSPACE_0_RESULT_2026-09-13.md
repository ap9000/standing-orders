# Workspace package 0 — repository verifier discrepancy — 2026-09-13

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

2. **This process tree is scheduled in a tier where every blocking sleep is
   stretched by up to ~100 ms.** The desktop host's launch agent
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
   not lift the effect from inside the tree; only a job whose own plist says
   `Interactive` sleeps accurately.

The five-second promise therefore held in nominal sleep but not in real time,
and the test — correctly — measures real time.

## The fix

`src/store.ts`: `Store.transact()` now begins its write through
`beginWriteWithin(db, 5000)`. Each `BEGIN IMMEDIATE` attempt spends one short
slice (`PRAGMA busy_timeout = 100`, nominal) inside SQLite's busy handler, so a
brief competing writer still queues at the lock boundary without a round
trip; the five-second budget is charged by `performance.now()`, and the
refusal lands within the budget plus at most one slice in every scheduling
tier. Only the `BEGIN` itself is retried — a body never runs before its
connection holds the write lock, so nothing is partially written or replayed,
and a non-`SQLITE_BUSY` error is rethrown at once. The connection's own
`PRAGMA busy_timeout = 5000` is restored whichever way the loop ends, so every
other statement on the connection keeps exactly the wait it had. Every
connection-opening path is unchanged (`schema-epoch.test.ts`, which keys on
the exact `PRAGMA busy_timeout = 5000` text at open, still passes).

Observed after the change, same process tree: the raw handler still runs
3.08× its timeout (1000 → 3076 ms), and `Store.transact` refuses at 5590 ms
with zero body calls, `busy_timeout` back at 5000, and a write recovering
after release (`node scripts/busy-wait-diagnostic.mjs`, output below).

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

`scripts/busy-wait-diagnostic.mjs`: a bounded (~15 s) reproducer for any
machine — sleep calibration, the raw handler at 1000 ms, `Store.transact` at
its 5000 ms budget, recovery — exit 0 when the lock refuses and the write
recovers; the numbers are the report. Needs `dist/` (`npm run build`).

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
$ node scripts/busy-wait-diagnostic.mjs                # exit 0
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
- The scheduling tier is not a test artefact. The installed desktop host runs
  under the same launch agent, so in production its own SQLite busy waits —
  and any other blocking sleep in it or its children — run 2–4× longer than
  nominal, and its CPU and I/O are throttled. Declaring `ProcessType` in the
  generated launch agent is the durable remedy; it touches the installation
  and the live service, which this package does not, so it is left to the
  operator (see the handoff's follow-ups). This fix makes the write
  transaction's bound hold regardless.
- Statements that do not go through `Store.transact()` — autocommit writes and
  the migrating door's own `BEGIN IMMEDIATE`s — keep SQLite's unchanged
  5000 ms nominal wait, so under this tier they still wait ~12 s for a
  persistent lock. That is the behaviour the earlier builds shipped; only the
  transaction door, where every product write begins, is clock-bounded here.
- Numbers above are from one machine under a load average of ~7; they vary
  run to run by a few hundred milliseconds and are reported as observed.
