# The Never Stuck contract

“Never stuck” does not mean an agent retries forever or hides a failure. It
means every accepted task always has one truthful lifecycle answer, and that
answer says what happens next.

| Condition | Meaning | Required next-step data |
|---|---|---|
| `running` | A live, fenced claim owns the task. | Current build and worker. |
| `retrying` | The machine can advance it without a person. | The known wake time when one exists, or the dispatch gate that will wake it. |
| `waiting` | A specific external action is required. | A typed reason and the nearest safe repair. |
| `terminal` | No more work will happen for this task. | Its result and proof, or the explicit cancelled/failed outcome. |

The stable `code` refines those four conditions: for example
`retry-scheduled`, `waiting-decision`, `terminal-dependency`,
`no-worker-online`, `provider-quota`, and `ready`. UI copy can improve without
breaking automation that branches on the code.

## Invariants

1. **One answer everywhere.** The task page, queue, CLI, and unified chat read
   the same typed dispatch diagnosis. They do not independently guess from a
   subset of scope, dependency, hold, capability, runner, capacity, or quota
   state.
2. **The claim is still authority.** Diagnosis is a read-side explanation,
   never permission. `acquireIfReady` re-proves task-local gates inside the
   same SQLite write transaction that grants the fenced lease.
3. **A terminal dependency is a repair.** A dependency on a failed or
   cancelled task cannot describe itself as ordinary waiting; it must name the
   blocker and offer retry, replacement, or unlinking.
4. **Automatic waits are bounded and visible.** Backoff and quota waits carry
   `nextAt` when the system knows it. Unknown reset times become operator work,
   not silent polling.
5. **Terminal means proven.** A successful terminal task links its immutable
   evidence and criterion verdict. Missing or contradictory evidence remains
   visible as needs verification.
6. **Crashes do not create duplicate authority.** Leases expire, generation
   fences reject late writers, and a replacement runner re-proves readiness
   before taking over.

## Acceptance scenarios

The contract is not complete unless automated tests prove at least these
paths:

- approved task → ready → claimed → running → terminal;
- failed attempt → timed backoff → eligible retry;
- question → waiting on a human → answer clears the hold;
- cancelled/failed dependency → `terminal-dependency` → claim refused;
- no registered or answering worker → one-command repair;
- full worker or exhausted provider quota → retrying with honest capacity or
  reset detail;
- completed UI work → criterion matrix plus screenshot/check/diff evidence.

`src/dispatch.test.ts` owns the compact lifecycle regression. The larger
claim, builder, proof, and unattended suites continue to prove fencing,
recovery, and evidence capture end to end.

## Cross-platform baseline

macOS and Linux run the full test suite on Node 22 and 24. Windows CI now runs
type-check, production build, native daemon/link behavior, and the Never Stuck
dispatch contract on both Node versions. That is a useful first gate, not a
claim of full parity: physical Task Scheduler installation and real Codex,
Claude, Git, and worktree executions on Windows remain the next bounded
portability slice. POSIX-only fake executables in the test harness should be
replaced deliberately rather than hidden behind blanket platform skips.

## Deliberate non-goals

- no second “watchdog agent” polling an agent;
- no unbounded retries;
- no LLM call while idle;
- no attempt to merge scheduler truth and authorization into one mutable
  status field;
- no platform abstraction framework beyond the few OS seams actually used.
