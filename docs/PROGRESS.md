# Progress

The living ledger of what has actually shipped, against the milestones in
[`DESIGN.md`](DESIGN.md) §10. One row per milestone item: its state, the
commit that proved it, and the date. "Proved" means tests exist and pass —
an item no test exercises is *in progress* no matter what the code looks
like.

Updated in the same commit as the work it records. If this file and the
code disagree, the code is right and this file is a bug.

## M0 — useful before it is autonomous

Ships when: `npx nightorders` shows every branch, PR, and issue in flight.

| Item | State | Proof |
|---|---|---|
| Zero-config discovery (branches, PRs, issues) | **done** | `d1a21ee` — scan, pulls, remote |
| Graph-backend detection (`nightorders graph`) | **done** | `6037c96` |
| Setup guidance without setting anything up | **done** | `d828d36` |
| Adapters: built-in SQLite store | **done** | `62aaf26` |
| Adapters: beads · GitHub Issues, or refuse and say why | **done** | `f20c816` |
| BackendGrant — write access handed over deliberately | **done** | `915a5b9` |
| Claim/lease with fencing | **done** | `62aaf26` |
| Idempotency (`--key` replays the first answer) | **done** | `62aaf26` |
| Agent-first CLI (envelope, stable reasons, exit codes) | **done** | `86d0d6a` |
| npm publish (`npx nightorders`) | not started | — |

M0 is functionally complete except publishing. Publishing is deliberately
parked until M1 settles, so the first published version is one whose
unattended loop can be trusted.

## M1 — one task goes queued → branch → commit unattended — **complete 2026-08-11**

Ships when: exactly that, and it did — `src/tick.test.ts` proves it against
real git with only the agent stubbed. Every item below is done and tested;
the closing hardening round was driven by a Codex review of the finishing
plan, which found the mid-build liveness hole was really three holes
(provenance, fencing, and completion acceptance) and prescribed the shape
of the fixes.

The nightly shape: `nightorders reconcile && nightorders tick` from cron.
The sweep recovers what the last night left behind; the pass builds what is
ready and approved; a pull request stays a person's decision.

| Item | State | Proof |
|---|---|---|
| Runner registration, auth from the first commit | **done** | `c8d582b` — token hashed, shown once |
| Runner heartbeat + liveness | **done** | `c8d582b` |
| Worktree pool (treehouse semantics, native) | **done** | `c8d582b` — see scope note below |
| claude builder, gated four ways | **done** | `2f27659` |
| Builder fenced to the exact lease | **done** | `d088ef8` |
| Reconciliation: dead runner | **done** | `c8d582b` — `runner reap` |
| Reconciliation: duplicate completion | **done** | `62aaf26` — reconciled, not refused |
| Reconciliation: orphaned worktree | **done** | `nightorders reconcile` — fail-closed discovery (a failed git listing is an error, not an empty answer), adoption scoped to the pool root, E2E against real git |
| `tick` — the unattended pass | **done** | `d088ef8` — atomic ready-check claim, fenced completion, sorted refusals |
| Release provenance (`released_by`) | **done** | `5cb9357` — a reclaimed lease's late completion is fenced, not accepted as a duplicate |
| Atomic dead-runner recovery | **done** | `5cb9357` — death re-proved inside the transaction that acts on it |
| Heartbeat *during* a build | **done** | the pulse: lease extended + runner touched every beat, error latch, mandatory synchronous re-proof after the agent, post-agent branch recheck (`moved-branch` finally returned) |
| Default-branch protection by discovery | **done** | origin's HEAD, else the parent checkout's branch; if neither can be named, nothing builds — a gate that cannot name the branch it protects is not a gate |
| Durable run records | **done** | `run` table opened before the agent spends, finalized after; outcome NULL = cut down mid-flight; `task show` reports them |
| `tick` honors completion fences | **done** | a completion `completeFenced` refuses is reported `fenced`, never `built` |

**Scope note — "treehouse adapter".** The milestone named an adapter; what
shipped is the pool itself with treehouse's semantics copied wholesale, as
DESIGN.md's credits describe: untracked files count as dirty, in-use is
detected from the running process recorded in the lease marker, and
reconstructed state is leased-until-verified. There is no external
treehouse installation to drive, so an adapter would adapt to nothing.
Recorded here rather than silently reinterpreted.

## M2 — fill one gap, three tasks start

Ships when: one supplied capability lets several blocked tasks dispatch.
Plan Codex-reviewed 2026-08-11; its findings reshaped the identity model
(tasks carry a repo; requirements are qualified `kind:name` keys;
verification is stamped with whose environment answered, and tick trusts
only what it re-proves where it stands).

| Item | State | Proof |
|---|---|---|
| Capability records + probes | **done** | `capability` table (a test asserts there is nowhere to put a value), `cap add/list/probe`, sh-probes with the probe's own words kept on failure, no manual verify — an assertion is less than a probe |
| Task placement + qualified requirements | **done** | `task_ref.repo`, `task add --repo`, `task require --cap kind:name` |
| Detection from disk (`cap scan`) | **done** | .env.example · .mcp.json · supabase/config.toml · workflow secrets; scanned content never becomes shell code (validated identifiers into fixed templates, or no probe at all); ci secrets are ci capabilities, not manufactured local gaps; scan proposes and never overwrites |
| Dispatch gate: unverified does not run | **done** | inside the claim transaction (a key that expired between survey and take is caught) *and* the builder (`nightorders build` cannot bypass it); tick probes at its own checkpoint and reports each gap by name |
| Fill one gap, three tasks start | **done** | executable in `tick.test.ts`: three tasks skipped naming the gap, the capability supplied with the probe untouched, all three built on the next pass |
| `gaps` ranked by what they unblock | **done** | derived view; a task waiting on two gaps counts toward neither's `unblocks` and both's `alsoBlocks`, so the ranking sends the operator to the right gap first |
| Morning briefing | not started | run aggregation since a moment; REVIEW distinguishes "not read" from "zero" |
| Notification outbox | not started | durable, deduped by episode, receipts recorded |
| Exit-code cleanup (deferred here from M1) | not started | standalone `build` maps agent/timeout/git to 3; contract says 1 |

## Deliberately deferred (and to where)

| Gap | Why it waits | Lands with |
|---|---|---|
| Failed blockers freeze their dependents forever | needs the failure taxonomy to say *which* failures propagate | M4 (gnhf taxonomy) |
| No-op agent run counts as success | M1 treats "changed nothing" as a real answer; the taxonomy will call it a failure mode | M4 |
| Exit-code edges: some worktree/git breakage maps to 3, not 1 | reshaping `build`'s exit contract mid-M1 breaks callers for polish | M2, with the notification outbox |
| Capability probes before dispatch | M2 scope | M2 |
| `tick` loops / daemonizes | a pass is the M1 shape; the loop and its economics are the product | M4 |

## History

- **2026-08-11 (later)** — M1 completes. Release provenance + atomic
  dead-runner recovery (`5cb9357`); the pulse, post-agent rechecks, run
  records, and tick honoring completion fences (`5aab47d`); fail-closed
  default-branch naming (`d97a468`); `reconcile` with fail-closed orphan
  adoption. Both plans Codex-reviewed before implementation. Suite 468.
- **2026-08-11** — M1 unattended pass ships: `tick`, `acquireIfReady`,
  `completeFenced`, exact-lease fencing in the builder (`d088ef8`). Plan
  reviewed by Codex before implementation; its findings drove the
  atomicity and fencing work. E2E: 7 tests, real git. Suite 448.
- **2026-08-10 → 11** — M0 lands end to end: discovery, graph detection,
  grants, store, claim/fence, adapters, runners, worktrees, builder, CLI
  (`c54e59d` … `bb2c4f6`).
