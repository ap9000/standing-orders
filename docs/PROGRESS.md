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

## M2 — fill one gap, three tasks start — **complete 2026-08-11**

Ships when: one supplied capability lets several blocked tasks dispatch —
and it does, executably: three tasks skipped naming their gap, the
capability supplied with the probe untouched, all three built on the next
pass (`tick.test.ts`). Plan Codex-reviewed 2026-08-11; its findings
reshaped the identity model (tasks carry a repo; requirements are
qualified `kind:name` keys; verification is stamped with whose
environment answered, and tick trusts only what it re-proves where it
stands) and scoped the outbox to episodes with receipts.

The morning shape: `nightorders reconcile && nightorders tick`, then
`nightorders brief` with coffee, and `outbox deliver` pointed at
whatever pings your phone.

| Item | State | Proof |
|---|---|---|
| Capability records + probes | **done** | `capability` table (a test asserts there is nowhere to put a value), `cap add/list/probe`, sh-probes with the probe's own words kept on failure, no manual verify — an assertion is less than a probe |
| Task placement + qualified requirements | **done** | `task_ref.repo`, `task add --repo`, `task require --cap kind:name` |
| Detection from disk (`cap scan`) | **done** | .env.example · .mcp.json · supabase/config.toml · workflow secrets; scanned content never becomes shell code (validated identifiers into fixed templates, or no probe at all); ci secrets are ci capabilities, not manufactured local gaps; scan proposes and never overwrites |
| Dispatch gate: unverified does not run | **done** | inside the claim transaction (a key that expired between survey and take is caught) *and* the builder (`nightorders build` cannot bypass it); tick probes at its own checkpoint and reports each gap by name |
| Fill one gap, three tasks start | **done** | executable in `tick.test.ts`: three tasks skipped naming the gap, the capability supplied with the probe untouched, all three built on the next pass |
| `gaps` ranked by what they unblock | **done** | derived view; a task waiting on two gaps counts toward neither's `unblocks` and both's `alsoBlocks`, so the ranking sends the operator to the right gap first |
| Morning briefing | **done** | `nightorders brief`: the overnight from the run table (cut-down attempts surfaced by name), BLOCKED = the gaps view, REVIEW distinguishes read-and-empty from *not read* (`--local` or a failed `gh`), OUTBOX count, DECIDE points at M3. No token/dollar line until something measures one |
| Notification outbox | **done** | durable rows enqueued in the same transaction as the run record they describe; dedupe keys are episode identities (a gap re-nags after it fills and recurs); delivery passes text as environment, never into the command line; receipts and failed attempts recorded. Quiet hours, escalation, deep links → M4 with the loop |
| Exit-code cleanup (deferred here from M1) | **done** | standalone `build` now exits 1 when the attempt broke (agent/timeout/git) and 3 only when a gate said no |

## M3 — a park renders as one screen, answerable on a phone — **complete 2026-08-11**

Ships when: exactly that, and it does, executably — `serve.test.ts`'s first
test parks, renders the one screen, answers it, and watches the hold lift;
`tick.test.ts` carries the answer into the resumed agent's brief against
real git. Plan Codex-reviewed 2026-08-11 (16 findings, 11 HIGH); the
findings reshaped the park lifecycle into fenced transactions, gave holds
owners, made decision identity the run alone, and kept the driver role
honestly unshipped until M4.

The morning shape now: `nightorders reconcile && nightorders tick` from
cron; `brief` with coffee; `decide` (or `serve`, from the phone) for the
questions; `outbox deliver` for the paging; `incident resolve` for the
parks that could not say what they wanted.

| Item | State | Proof |
|---|---|---|
| Schema: rebuild migration (run CHECK + role, owned holds) | **done** | first versioned table-rebuild; proved against a real M2 fixture, not just fresh databases; `PRAGMA foreign_key_check` before commit |
| Decision / artifact / incident records | **done** | decision's identity is its run (UNIQUE, joined — never denormalized); evidence links refuse to cross runs in the INSERT itself; incidents never age out of a brief |
| `parseDecision` — the 422 rule as a library | **done** | fail-closed, every problem reported at once with stable reasons; reversibility stated or invalid, never defaulted; caps + C0/C1 rejection on every string, because payloads reach terminals, web pages, and later briefs |
| Park path (mailbox, finalizeParkFenced) | **done** | the brief's prose escape hatch is now a protocol: a nonce-named mailbox, ingested once through O_NOFOLLOW, quarantined when stale or cut down, never committed; the seal is one fenced transaction — decision, hold, run outcome, and outbox row exist together or, if the lease was superseded, not at all; a parked pass exits 0; E2E against real git |
| Bounded repair → incident | **done** | two resumed turns, each a `role='repair'` child run with its own model, outcome, and parentage — never called a driver; the compact error names every failure at once; a broken turn spends an attempt; each resume follows the forked session id; exhaustion is the fenced incident transaction; no session id, no repair — straight to the problems |
| Evidence capture (machine-collected) | **done** | base revision stamped before the agent spends; diff (ext-diff and textconv disabled) + porcelain inventory captured at park, hashed, bounded, with the capture command and exit recorded; a truncated or failed capture says so; files 0600 outside the worktree, keys relative to the evidence root beside the database |
| `decide` + brief DECIDE, authenticated answers | **done** | answering takes the approver credential — who decided is recorded, never asserted; one transaction for the CAS + hold + outbox episode; answered once (same choice replays, different refuses); expiry gets louder, never chooses, stays answerable; `incident list/resolve` is the authenticated act that frees a malformed-park task (`task unhold` deliberately cannot); brief DECIDE and INCIDENTS are real, and incidents ignore the briefing window |
| Resume (run_decision causation, attention budget) | **done** | answers attach to the resume run causally, snapshot included — a failed resume is handed them again, a built run is the terminus, never "newer than" timestamps; the resumed brief quotes question/option/note fenced before the rules and the trusted directive names only ids; §8's attention budget re-proved inside the claim transaction — measured parkers step aside over budget, first-timers pass, park_rate maintained where attempts conclude |
| Web decision view (`serve`) | **done** | node:http, zero dependencies, no page JavaScript; approver credential required on every bind, localhost included (cookie session HttpOnly SameSite=Strict, or Bearer name:token — never a URL); Host proved before routing, Origin + CSRF on cookie mutations; every string escaped at the sink under a default-src 'none' CSP; irreversible options confirm-armed and server-checked; evidence streamed only through the decision's relation, hash re-proved, as a plain-text attachment. The milestone sentence is `serve.test.ts`'s first test |
| Driver role | **deferred to M4** | the design's driver is the event-woken gate agent, which first exists with the loop; repair turns are recorded as `role='repair'` with parentage, because calling them a driver would make M4's cost data mean two things |

## M4 — the loop — in progress (2026-08-12)

Plan Codex-reviewed (37 findings, 24 HIGH; the findings are the spec).
Executed as M4a (accounting, failure semantics, capacity, watch recovery)
then M4b (publication, CI, briefing, packaging). Deferred post-M4, in
writing: quiet hours, unanswered-decision escalation, deep links,
multi-chat routing, the CI-repair driver, external-backend dispatch.

| Item | State | Proof |
|---|---|---|
| Schema v4 | **done** | 'no-change' outcome, 'backoff' hold owner, stall/commit-failure incidents, strikes, claim incarnations, economics columns; one generic exact-DDL rebuild that refuses unknown shapes; proved on M2 and M3 fixtures |
| Invocation gateway | **done** | `invokeAgent` is the only door to the provider binary — an architecture test fails any new direct call; runs are stamped before the spawn (provider spawns == stamped runs, crash-honest); usage read off every completed process, nonzero exits included; unmeasured stays NULL, never $0.00 |
| Terminal handoff; the builder owns commits | **done** | agents no longer commit — post-agent HEAD must equal the base or it is `moved-head`, work preserved; every attempt ends with a typed handoff (completed / no-change / failed) or it is a `no-op` protocol failure; a stated no-change with a clean tree is a first-class successful outcome; agent-reported failure carries the agent's own words |
| Measured economics in the brief | **done** | dollars and tokens summed from run records, reported as "measured across M/N invocations" with the gap named — no unqualified totals |
| Fenced failure finalizer, backoff, strikes, stalls | **done** | one transaction: fenced release, typed run outcome, strike, doubling backoff hold (1-2-4-8-16m) or the three-strikes stall (incident + failed + held + paged once); commit-stage failures take neither road — an incident guards the preserved worktree, no strike; classification trusts only what the machine observed (timeout→retryable, protocol→no-op, everything else unknown with bounded retry); successes and parks reset the streak; authenticated `task requeue` undoes a stall in one transaction; STRANDED brief section names tasks behind terminally failed blockers |
| Capacity + quota gates | **done** | both inside the claim transaction with every other readiness fact: live claims counted where the claim lands (a free CPU against a full ledger is not capacity); quota keyed (runner, provider, scope) with lazy exhausted→half-open at the known reset, exactly one probe admitted and re-armed while it flies, success clears the stamp; nothing stamps quota from stderr prose — structured signals or an operator only, machinery ready for the provider adapter |
| watch (lease, incarnations, work-conserving, graceful stop) | **done** | one process composing the tested passes; watch+watch exclusive per (runner, repo), cron coexists via claims; every readiness-changing write bumps a durable wake sequence and the loop drains until refusals — a freed dependent builds in the same window, proved by a chain built under an hour-long interval; claims carry the incarnation UUID and a successor recovers exactly its predecessor's claims/runs/worktrees before dispatching (the crash liveness cannot see); signals stop admissions while the in-flight pass finishes under its own bounded timeouts and the lease keeps beating. Deferred with this note: hard kill of the provider process group on grace expiry |
| Telegram follower + event wake | **done** | one reusable long-poll actor (`followBridge`): bounded polls (25s, under the transport's 30s HTTP timeout — the client never aborts a poll Telegram is honestly holding), fenced lease renewal per cycle (a lapse takes the next generation and the cursor rides it, stranding the old poller's writes), exponential reconnect backoff, cancellation aborts the in-flight poll; standalone `bridge telegram --follow` AND embedded in watch by default when a token is configured (the timer pass remains the no-token fallback); answering already bumps the wake sequence, so a tap resumes the freed task in the same watch window — phone to build, no timer in between; a hot-spin floor pads instantly-returning transports |
| `daemon` — the loop as a service, no crontab (operator request 2026-08-12) | **done** | `daemon install/status/uninstall/logs`: writes launchd (macOS) or systemd --user (Linux) units running `watch --token-file`; the runner token lives 0600 beside the database, never in the unit; crash-only KeepAlive with throttle, restarts made safe by incarnation recovery; unsupported platforms refuse with instructions; supervisor calls scripted in tests; Windows added same day — Task Scheduler XML (logon trigger, restart-on-failure, IgnoreNew singleton, cmd log redirection) via schtasks, honestly noted as not yet exercised on physical Windows |
| Publication grant + durable push/PR intent | **done** | schema v5 (additive): an authenticated publication grant separate from tracker writes — `push-branch` and `open-pr` as distinct capabilities, exact GitHub repo/remote/head-prefix/base, task selector, draft mode, terms printed before `--yes`, revocation immediate; the intent is written **inside the fenced completion transaction** (claim's `inTransaction` now joins the store's reentrant transact) so "done" and "this must reach a PR" cannot come apart; the worker pushes the exact accepted SHA (`git push remote sha:refs/heads/head`), then adopts any existing PR on that head before daring to create (`gh pr list` → `create --body-file`, never `--body` — the body quotes an agent), every phase durable and crash-retryable, `MAX_PUBLISH_ATTEMPTS` then a durable failure that pages; the PR body regenerates byte-identical from run records (base/head SHA, answered decisions, conclusion fenced as prose so `Fixes #…` gains no semantics); `no-change` publishes nothing; CLI `publish [grant\|revoke\|status]`, and watch publishes in the same window it builds |
| CI observation + watch-episode briefing | **done** | `observeChecks` reads the structured rollup and exact head OID for every PR this plane opened (`gh pr view --json`), reusing the brief's passing/failing/running/none semantics plus not-read for transport failure; CI episodes keyed `ci:<pr>:<headOid>` — a red head pages once, resolves when that exact head turns green or a newer commit buries it, and `none`/`running`/not-read are never called green (an unread rollup neither pages nor resolves); watch observes on the reconcile cadence. The night is a row: `watch_episode` (repo, runner, incarnation, window, totals) written at start and sealed at exit — a crash leaves `ended_at` NULL, which is itself data; `brief --latest-watch` bounds the morning to exactly that episode's runner and window instead of "the last 24 hours" |
| Twelve-task E2E | **done** | night.test.ts — one fake-clocked night against real git, built-in backend only (stated; external dispatch deferred): clean builds, honest no-change, a park answered mid-night via `decide`, three strikes → attempts-exhausted → authenticated requeue → built, a timeout that backs off and recovers, a dependency chain, a scope approved while the night runs, duplicate empty passes refusing idempotently; the zero-token invariant asserted as arithmetic (provider spawns == stamped runs, exactly); eleven publications pushed and opened against scripted gh; the brief telling the same story from the same rows (12 built, no decisions, no incidents, nothing stranded) |
| Packaging (Node >=22.13 floor) | **done** | engines `>=22.13.0` (node:sqlite's floor — publishing `>=20` would ship a runtime that cannot open its own database); `files` allowlist ships dist + README + LICENSE + manifest only; LICENSE (MIT) added; the published build strips source maps (tsconfig.build.json); version 0.1.0; `npm pack --dry-run --json` inspected — 69 files, ~250KB, no tests, no maps, no databases, no evidence, no tokens; the exact tarball installed `--offline` in a clean temp project and its bin ran discovery and opened a database on Node v22.22 (the 22.13 exact-minimum run is noted as not yet performed — no such runtime on this machine) |
| Operator publish + registry verify + tag `m4` | **open — the operator's act** | `npm publish` is deliberately not the machine's to run. When Alex publishes: verify the registry tarball/version (`npm view nightorders`), install it once from the registry, and only then `git tag m4` and mark this row done. The tag follows the verification, never precedes it |

## Routines — standing orders as tracks (2026-08-13, Phase C; findings 4, 5, 9, 10 are its spec)

A routine is a pre-approved template for repeating work: goal, exclusions,
touches, requirements, schedule (`every:<minutes>` or `daily:<HH:MM>` UTC),
single-flight, and a rolling 7-day cost ceiling — every term under ONE
digest (schema v8: `routine`, the `routine_fire` ledger, and
`task_ref.routine_id`, all additive). Approving the template — CLI
`routine approve` or the console's step-up, both restating "each firing
builds WITHOUT asking" — is what makes instances legitimately automatic;
editing any term strands the yes. Firing is one store-owned transaction
(`fireRoutine`) that re-proves approval-digest equality, unpaused,
due-ness, single-flight, and budget before any write (finding 4): the
instance spawns as an ordinary task placed in the routine's repo, its
scope copied byte-for-byte from the row proven approved in that same
transaction and stamped with the template's approver — no caller supplies
approval fields. Budget FAILS CLOSED: a paid run with no recorded cost
blocks the track as "unmeasured" rather than counting as headroom
(finding 5). A due slot that cannot fire is recorded on the ledger —
unique `(routine_id, scheduled_for)` is the idempotency — and the
schedule advances aligned to cadence: one overdue firing after downtime,
never a backfill burst, never drift (finding 10). A blocking instance
pages once per instance (`routine-singleflight:<id>:<task>`), and a later
successful firing resolves the episode (finding 9). The pass (`tick`,
therefore `watch`) fires due routines before reading the ready set, so an
instance builds in the window that spawned it — proved end to end against
real git, including the stuck-instance-stops-the-track case. Surfaces:
`routine add/list/show/approve/pause/resume/run-now` (run-now is manual —
same proofs, refuses to your face, no ledger noise, schedule untouched);
`/routines` + the routine screen with the same verbs, every read and verb
proving the routine's repo against the ceiling independently of
authorizeMutation (finding 7); the board grows **track rows** under the
lanes — per routine: status, schedule, week's spend, and a run-history
strip of dots (green built · red failed · pulsing building · hollow
skipped), while instances stay OUT of the main lanes except attention,
where they surface wearing the routine's name. 750 tests.

## Planning mode (2026-08-13, Phase B; the round-2 findings are its spec)

`task plan <id>` (CLI, authenticated) or "plan first" (console) marks the
ask; the pass dispatches a **planner** — schema v7's third run role — into
a disposable workspace on its own branch namespace. Its role precondition
is re-proved inside the claim transaction (never an early return past the
capability/capacity/quota/attention gates; above the attention budget a
planner is refused outright), and the half-open quota probe is now
consumed only WITH the claim it admits — a refusal no longer re-arms the
quota with no probe in flight (findings 2–3, the latter a fix to shipped
M4 behavior). The planner's only endings are a parked question (the
existing decision surface — Telegram taps answer it, causal resume feeds
the answer back) or a NIGHTORDERS-PLAN handoff; both are ingested only
AFTER branch, HEAD, and clean tree are proven (finding 1 — the vandal
test smuggles a file and gets nothing ingested, question included). A
drafted plan lands as a PROPOSED scope plus a plan-document artifact; the
inbox and board flip to "review the plan"; the approve step-up is
unchanged and renders the document above the restated scope; the
builder's brief quotes the approved plan fenced-inert. Planner failures
take separate strikes and shorter backoff, malformed payloads go straight
to a durable `malformed-plan` incident whose hold blocks redispatch, and
exhaustion pages as `plan-attempts-exhausted` — builder strikes are never
spent by planning (finding 6). The whole negotiation is one E2E against
real git: ask → answer → draft → approve → build, with the plan in the
builder's brief and the planner's branch never an ancestor. 723 tests.

## Card accretion (2026-08-13, Codex round 2: 13 findings; Phase A of three)

The card now answers the question you would ask at its stage. Needs-you
cards carry the actual question and how long they have stalled ("waiting
7h"), and the lane sorts oldest-first — truthfully: the snapshot fetches
an oldest-stalls page alongside the newest page inside one transaction,
so an old stall cannot fall off a saturated board (finding 11). Queued
cards show the approved goal — the promise, not "ready". Waiting cards
name what the blocker is doing ("waits on schema-cleanup — building
now"), with the state redacted when the blocker lives outside the
ceiling (finding 12) — the edge's name belongs to the visible task; the
other project's status does not. Building cards say "attempt 2" when
strikes exist. Done cards quote the agent's conclusion. Roll-up
admission now bounds the SQL page itself, not just the render. Phases B
(planning mode) and C (routines/tracks) are specced with the same
review's findings as their spec — see the session plan addendum. 718
tests.

## The board + the long-running reframe (2026-08-13, Codex-reviewed: 12 findings)

The operator's directives: figure out the spatial work board; get rid of
the night-specific thinking — this plane is for long-running work,
whenever it runs; and dependencies are now allowed where they buy UX.

**The board** (`/board`, primary nav): the pipeline as lanes — needs you ·
queued · waiting · building · done recently. One exhaustive precedence-
ordered classifier (`board.ts`) over one transactional snapshot
(`boardScoped`), so a parked task is attention exactly once and an
unscoped task cannot vanish from every lane (findings 1–2); orphaned
`running` rows get a repair card; queued claims only task-local readiness
(finding 6); building cards carry worker · model · elapsed · branch ·
workspace, with honest "preparing workspace" before a run exists
(finding 7). Read-only by construction: every card a link, no forms, no
nonces. **Liveness without SSE** (finding 3 killed the wake-seq-driven
stream): a ~15-line first-party script — per-response nonce'd CSP, never
unsafe-inline (finding 9) — fetches the page's own fragment on a timer
and swaps it in place; `<noscript>` falls back to meta refresh; fragment
polls authenticate but never touch `lastSeen`, so an open board cannot
keep a session alive (finding 4). **The roll-up**: `/board?scope=all`
shows every project the ceiling admits on one board, each card wearing
its project chip, enforced row-by-row with the same `rowVisible`
predicate — a repo outside the server's configuration never renders.

**De-night**: `/morning` → 302 → `/activity`; `overnight()` →
`tally()` and the `--json` envelope key `overnight` → `tally` (a wire
break made exactly while the package is unpublished, finding 10); brief/
reconcile/decide/opener/task prose reframed ("builds unattended", "last
window", "No decisions were parked"); README and DESIGN now position for
long-running work nobody is watching — the captain's night orders stay
as the name's origin, one paragraph, not the frame. Brand, protocol
markers (`NIGHTORDERS-*`), and `night.test.ts` deliberately keep their
names. 714 tests.

## Console v3 — workflow tabs (2026-08-13, Codex-reviewed)

Navigation reorganized by workflow stage per a second Codex IA review:
`/` = **inbox** (one card per stall: decisions, scopes awaiting approval as
links to the step-up screen — never forms or nonces in lists, and the
inbox never auto-refreshes; inline retry per stalled task with allow-listed
return; cancelled-blocker repair cards; gaps that actually free work;
saturated cached badge); **work** = active queue; **done** = one row per
completed task with final build, conclusion, cost, PR, observed-only CI
state; ledger → /morning ("last 24 hours", honestly a rolling window);
machinery → /system (live-refreshing); builds/requirements demoted to
footer with deep links kept. The review also caught and fixed a ceiling
bypass in inline incident resolution. 697 tests.

## Console v2 — the workspace (2026-08-12, Codex-reviewed: 11 findings)

The user asked for a standalone multi-pane interface with project
onboarding. The review's spine: selection is never authorization. Shipped:
three-pane shell (sidebar with project switcher, waiting-on-you count, +
new task; master list panes on task/run detail; collapses to the phone
column so answering never regresses); /projects opener offering only what
the server ceiling admits (--repo list + --project-root, canonicalized,
narrowing on resolve failure, git-validated with direct argv); session-
carried open project as a view filter with a stale-tab revision; the
ceiling enforced on tasks, runs, decisions, answers, and BOTH evidence
paths (decision evidence was previously unscoped — pre-existing hole
closed); bearer X-Nightorders-Project constrained identically; placement
immutable once scoped (an approval cannot be re-aimed); atomic slugged
task creation landing on the approve card; schema v6 project registry.
Negative matrix: cross-project bypasses, stale revisions, canonical
aliases (/var vs /private/var caught live), v5→v6 migration. 695 tests.

## Toward the operations console (2026-08-12, Codex-reviewed: 21 findings)

The user asked for a web UI over all the work. The review's verdict:
authority and transactions before templates. Landed so far:

| Item | State | Proof |
|---|---|---|
| Session lifecycle | **done** | idle (12h) and absolute (7d) expiry re-proved per request; approver-generation check — credential rotation kills cookies the way it kills Telegram bindings; `POST /logout` |
| Transactional console mutations | **done** | `cancelTask` refuses under a live claim (a runner's completion can no longer overwrite a cancellation); `requeueTask` re-proves stalled-and-unclaimed server-side (a stale button erases nothing); `createConsoleTask` — atomic create+place+scope, backlog admission cap, caps and control rules on every string it will later render; `resolveIncident` owns its transaction |
| Bounded read model | **done** | `listRunsBefore` — cursor pagination, newest first, safe-integer or nothing, page size clamped in the store; `decisionsForTask`/`incidentsForTask` (resolved included: history, not attention); `computeGaps` extracted to `gaps.ts` so CLI and console rank gaps with the same function |
| Descriptor-safe evidence reads | **done** | `readVerifiedArtifact` in evidence.ts — key shape validated, realpath containment, `O_NOFOLLOW` open, fstat on the same descriptor, size == record, bounded read, SHA-256 verified before a byte leaves; serve's decision-evidence route now goes through it; `artifactForRun` enforces membership in the lookup, not route choreography |
| Routes, pages, step-up approval | **done** | the **built-in-queue console** (named honestly — external-backend tasks join when external dispatch does): home = the brief live (overnight counts, measured spend via shared `summary.ts`, DECIDE/INCIDENTS/STRANDED/gaps), `/tasks` + add, `/t/<id>` with hold/unhold (operator-owned only), requeue, cancel, guarded scope edit (`sawDigest`, refused under a live claim, voids approval visibly), `/runs` cursor-paginated, `/r/<id>` with economics + conclusion + repo-scoped evidence, `/caps` read-only. One `authorizeMutation` gate (content type, Origin, CSRF, duplicated-field refusal). **Approval is step-up**: token re-entry + single-use nonce bound to {approver, task, digest}, form restates all three digest-bound fields; `approve()` authenticates inside its transaction. GET never mutates — overdue derived at render. Ids URL-encoded in every href, decoded once. Table-driven inert-render sweep over every DB-derived string |
| Out of scope for v1, stated | — | probe execution, grant/cap editing, task-title edits, dependency editing, runner/claim/worktree/quota admin, outbox history, publication/CI views (M4b), immediate in-flight kill on cancel (cooperative only), live updates/charts/spatial board |

## Toward M4 — the Telegram bridge (shipped early, 2026-08-11)

The operator asked for the back-and-forth channel before M4: decisions to a
phone, answers back, the loop resuming — with no LLM anywhere in the path.
Plan Codex-reviewed (16 findings, 10 HIGH); the findings ARE the design.

| Item | State | Proof |
|---|---|---|
| Bot token: CLI + web settable, never a column | **done** | env `NIGHTORDERS_TELEGRAM_TOKEN` wins; else a 0600 file beside the database, written by `bridge telegram token` or serve's authenticated settings card; never echoed whole; scrubbed from every error and receipt; **stripped from every agent invocation** (`omitEnv`), repair turns included |
| Pairing: a chat is not a person | **done** | 128-bit one-time codes, hashed; consumed in one transaction with the binding; private chats only; both chat id AND immutable user id required on every tap; one live binding per bot (partial unique index); wrong codes get silence, not an oracle |
| Revocation | **done** | bindings are revoked, never deleted; approver credential rotation strands the binding, its codes, and its buttons in the same transaction; `unpair` kills outstanding actions |
| Outbound: whole context, then buttons | **done** | recap, question, every option's consequence sent plain-text (no parse_mode, no entities, previews off) across as many parts as needed; the keyboard rides the last part only; buttons carry opaque 128-bit tokens whose meaning lives in `telegram_action`, unreadable and unmintable by a stolen bot token |
| Shared delivery claiming | **done** | the bridge and `outbox deliver --cmd` claim rows before sending — one page per fact, whoever gets there first; receipts name bot, chat, and message |
| Inbound: per-update transactions | **done** | `telegram_update` PRIMARY KEY is the idempotency; effects (acks, edits) retry-or-drop outside and never hold the cursor hostage; the poll lease (owner + generation + monotonic cursor) makes overlapping pollers lose loudly (`bridge-busy`), and passes hand it back on exit |
| Irreversible two-step | **done** | one tap arms — minting fresh one-time confirm/cancel tokens — and only the minted confirm answers; cancel kills its sibling challenge and re-arms the choices; a forged or replayed confirm is a stale button |
| Migration | **done** | `answered_via` CHECK widened by the second table rebuild, exact-DDL recognition (an unknown shape refuses rather than guesses), proved against an M3-shaped fixture with answered rows, relations, and the next autoincrement id |
| `--follow` (long-poll daemon mode) | **deferred to M4** | a persistent service is loop work — leases, backoff, shutdown, observability — and Codex's verdict was to ship the cron pass first; the pass is the shape until the loop earns the daemon |
| Free-text notes over Telegram | **deferred** | needs its own injection review; the answered message names `decide --note` and the serve link |
| Multi-chat routing / escalation | **deferred to M4** | one bound chat in v1, enforced by the schema, not by hope |

## Deliberately deferred (and to where)

| Gap | Why it waits | Lands with |
|---|---|---|
| Failed blockers freeze their dependents forever | needs the failure taxonomy to say *which* failures propagate | M4 (gnhf taxonomy) |
| No-op agent run counts as success | M1 treats "changed nothing" as a real answer; the taxonomy will call it a failure mode | M4 |
| Exit-code edges: some worktree/git breakage maps to 3, not 1 | reshaping `build`'s exit contract mid-M1 breaks callers for polish | M2, with the notification outbox |
| Capability probes before dispatch | M2 scope | M2 |
| `tick` loops / daemonizes | a pass is the M1 shape; the loop and its economics are the product | M4 |

## History

- **2026-08-11 (M3)** — M3 completes: the decision schema and its
  rebuild migration (`0049c1c`), the park with machine-captured evidence
  (`3da88e4`), bounded repair as parented repair runs (`03b3393`),
  authenticated `decide` + incidents (`0cc0549`), the causal resume and
  the attention budget (`4102cd0`), and `serve` — the milestone sentence
  as a test (`04a60ef`). Plan Codex-reviewed before implementation; its
  16 findings drove the fenced park transaction, owned holds, run-only
  decision identity, the mailbox discipline, and web auth. Driver role
  recorded honestly as deferred to M4. Suite 575.

- **2026-08-11 (M2)** — M2 completes in one sitting: capabilities +
  probes (`65f0381`), the gate in the claim transaction and the builder
  with the acceptance sentence executable (`b699b56`), gaps (`f0ff397`),
  cap scan (`a055a2d`), the outbox (`d0f07a3`), the briefing and the
  build exit-code cleanup. Plan Codex-reviewed before implementation;
  its identity/authority findings drove the schema. Suite 503.

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
