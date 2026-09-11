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
   blocker and offer retry, replacement, or unlinking. Retrying preserves the
   edge; replacement removes the old edge and adds the new one atomically;
   unlinking is always an explicit operator act. Every successful repair bumps
   the durable wake sequence so the worker loop reconsiders it immediately.
4. **Automatic waits are bounded and visible.** Backoff and quota waits carry
   `nextAt` when the system knows it. Unknown reset times become operator work,
   not silent polling.
5. **Environment recovery is explicit and bounded.** `verify set --self-heal`
   first previews the exact approved setup and its digest. Confirmation must
   echo it with `--setup-digest <shown> --yes`. Only when the project check
   cannot start because a required project executable is missing may the worker
   run that setup once and retry the exact check once. An ordinary failure,
   timeout, or executable that exists but cannot run does not trigger recovery.
   The combined check log records every step. Recovery stops if the setup or
   project check changes, setup fails, files change, the checkout moves,
   unchanged files cannot be confirmed, worker custody is lost, or the
   executable remains missing.
6. **Terminal means proven.** A successful terminal task links its immutable
   evidence and criterion verdict. Missing or contradictory evidence remains
   visible as needs verification.
7. **Crashes do not create duplicate authority.** Leases expire, generation
   fences reject late writers, and a replacement runner re-proves readiness
   before taking over.
8. **One recovery entrance, existing authority.** Operator surfaces derive
   **Get this task running** from the typed diagnosis and route to the nearest
   guarded action. The entrance never performs a second mutation, bypasses a
   confirmation, or converts diagnosis into permission.
9. **Structured-output recovery cannot rewrite intent.** Planner and reviewer
   replies receive conservative syntax-only normalization before strict
   validation. If validation still fails, the exact errors may be returned
   through at most two child runs in the same resumable session. Corrections may
   not invent scope or criteria, and every original and corrected reply remains
   sealed as `structured-output` evidence, including rejected replies. The planner re-proves
   branch, HEAD, and tree after each reply; the reviewer re-verifies its sealed
   scratch bundle. No resumable session means no correction. Provider,
   custody, or tamper failures use their own fail-closed paths, never this one.
10. **A dead runner's open runs close with its claims.** The reconcile pass
    (`tick`, `runner reap`) re-proves a runner dead inside one write
    transaction, releases its live claims and worktrees, and then settles its
    open runs through the same walk the takeover door uses
    (`recoverRunnerWork`): every run recorded against the runner with no
    outcome and no live held session finishes as `failed`/`interrupted`, and
    its task requeues only when no newer live lease owns it. The pass reports
    the run ids it finished even when there was no claim left to release.
    What this bounded recovery does **not** guarantee: it never touches a
    runner that is still heartbeating (a live runner's abandoned run — a
    restart that released its lease under the same name — is not this
    pass's business), never rewrites a finished outcome, never marks an
    interrupted attempt successful, never releases a successor's claim,
    run, worktree, or task state, and never closes a run under a live held
    session. A second pass over the same runner settles nothing.
11. **An existing database is repaired in place, additively.** A column the
    current writer needs that an older installation's table never gained —
    the `criterion_review` review binding columns (`scope_digest`,
    `head_sha`, `proof_artifact`, `proof_sha`, `check_log_artifact`,
    `check_log_sha`, `screenshots_json`), widened in the fresh DDL under
    an unchanged schema version — arrives on the next plain open through
    the same idempotent `addColumn` road every earlier additive migration
    used, exactly as the fresh DDL declares it. Existing rows keep every
    value; a row from before the hardening reads back unbound (NULL
    bindings, an empty screenshot list) and is never backfilled, because no
    evidence of what that reviewer was shown exists to bind. A reviewer
    ingest that failed on the old shape with "table criterion_review has no
    column named scope_digest" (run 1507) is not replayed by the machine:
    that source run's one review is spent, and the next build's review
    binds its own evidence on the repaired table.

## Acceptance scenarios

The contract is not complete unless automated tests prove at least these
paths:

- approved task → ready → claimed → running → terminal;
- failed attempt → timed backoff → eligible retry;
- missing project executable during verification → one approved setup replay →
  one verification retry → one combined evidence log → no duplicate build;
- setup replay changes files, the checkout moves, file safety cannot be
  confirmed, or the executable remains missing → recovery stops with missing
  evidence and a concrete reason;
- question → waiting on a human → answer clears the hold;
- failed dependency → repair card → retry blocker → edge preserved → claim still refused until the blocker completes;
- cancelled/failed dependency → repair card → atomic replace or explicit unlink → immediate readiness re-evaluation;
- no registered or answering worker → one-command repair;
- crashed worker with an open run → successor interrupts and recovers it → one
  evidence-backed completion → another dispatch proves no duplicate;
- dead worker whose lease was already released with its run still open →
  successor builds the task → the reconcile pass finishes the old run as
  interrupted, reports it, and leaves the successor's outcome, claim,
  worktree, and task state untouched; a heartbeat landing before the
  transaction saves the run, and a repeat pass changes nothing
  (`src/runner.test.ts`, `src/operate.test.ts`);
- full worker or exhausted provider quota → retrying with honest capacity or
  reset detail;
- malformed planner reply → syntax-only normalization or no more than two
  same-session correction children with exact validation errors → every reply
  sealed → worktree re-proved after each reply → one accepted plan/decision or
  the existing malformed terminal;
- malformed reviewer reply → the same bounded correction rule → sealed scratch
  re-verified after each reply → exact source-scope and criterion-matrix match →
  one accepted criterion review or the existing malformed terminal;
- missing session, provider failure, lost custody, or altered planner/reviewer
  inputs → no structured correction is attempted;
- completed UI work → criterion matrix plus screenshot/check/diff evidence.
- existing database whose `criterion_review` still has the original ten
  columns → plain open adds the binding columns, keeps every row, and a
  second open changes nothing → a real review ingests through a same-session
  correction child, and a revised scope or mismatched artifact binding still
  refuses with no partial comment or judgement
  (`src/migration-criterion-review-bindings.test.ts`; the reviewer suite's
  own stores open fresh and never carried the old shape).

`src/dispatch.test.ts` owns the compact lifecycle regression. The larger
claim, builder, proof, and unattended suites continue to prove fencing,
recovery, and evidence capture end to end.

## Cross-platform baseline

macOS and Linux run the full test suite on Node 22 and 24. Windows CI now runs
type-check, production build, native daemon/link behavior, and the Never Stuck
dispatch contract on both Node versions. Approved dependency setup and
post-build verification use the native command shell on all three platforms.
The real-provider canary in [CERTIFICATION.md](CERTIFICATION.md) proves Claude
and Codex planning, approval, worktree execution, evidence, and duplicate
dispatch protection on macOS and is ready to run unchanged on Windows. That is
a useful gate, not a claim of full parity: physical Task Scheduler installation,
post-reboot recovery, and the same real-provider canaries on Windows remain the
next bounded portability slice. POSIX-only fake executables in the broader test
harness should be replaced deliberately rather than hidden behind blanket
platform skips.

## Deliberate non-goals

- no second “watchdog agent” polling an agent;
- no unbounded retries;
- no LLM call while idle;
- no attempt to merge scheduler truth and authorization into one mutable
  status field;
- no platform abstraction framework beyond the few OS seams actually used.
