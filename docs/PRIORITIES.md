# Product priorities

Current checkpoint (2026-09-13 UTC): main includes contract handoffs,
Stop/Resume, platform process containment, and workflow recipes through schema
57. The installed desktop reached that schema, but its selected Documents
projects remain behind the [recorded Mac access gate](assessments/DESKTOP_ROLLOUT_2026-09-13.md).
New [stable signing and worker-access checks](assessments/STABLE_DESKTOP_ACCESS_2026-09-13.md)
are implemented and tested locally, not installed or certified for permission
persistence. The operator is away; do not keep attempting permission changes.
The [mobile chatbot is the primary phone-control surface](PHONE_STATUS.md),
with read-only Telegram status as an optional shortcut. Conversation continuity
is implemented locally over the existing mate engine. Earlier milestone narratives below are
implementation history, not current deployment claims.

### Next sequence

1. **Active: dependable installation and updates.** Local hardening now stages
   separate artifacts, pins build identity in the service definition, keeps
   Stop/Status usable with a broken or incompatible database, and refuses to
   replace a disappeared database with an empty queue. See the
   [installation checkpoint](assessments/INSTALLATION_SAFETY_2026-09-13.md).
   The same-schema controlled update/recovery flow is now implemented locally:
   drain admission, verify a private backup, atomically swap apps, verify the
   new worker, and restore the app (never old task data) on health failure.
   Native File-menu controls expose progress, cancel and resumable recovery.
   See the [controlled-update record](assessments/CONTROLLED_UPDATE_2026-09-13.md).
   Automatic recovery now survives updater and recovery-supervisor crashes
   without reopening the app or pressing Resume. Real disposable macOS runs
   verified interruption after the atomic swap, cancellation and explicit Stop;
   retries are bounded and current task data is preserved. See the
   [failure-scenario results](assessments/AUTOMATIC_UPDATE_RECOVERY_2026-09-13.md).
   **Two distribution paths:** the npm/browser service does not require Apple
   publisher credentials. Official native Mac releases require centrally managed
   Developer ID signing/notarization; end users do not set up certificates.
   Do not make native signing a prerequisite for the npm path. The signed app
   still needs two-build access persistence and native-window/reboot acceptance.
   The September 13 npm candidate built, packed and installed in isolation,
   but the real background probe timed out on all three saved Documents projects.
   No live switch was attempted. Close that access gate in an unlocked session,
   verify one working controller, retained login/projects and fresh watch leases,
   then qualify restart/login recovery. Packaging alone does not grant folder
   access. See the [npm deployment preflight](assessments/NPM_DEPLOYMENT_2026-09-13.md).
   Physical Windows acceptance is separate; Mac passes cannot substitute for it.
2. **Qualify reliability on mixed real work — the next route to a credible 9.**
   After npm/browser installation acceptance, start with ten varied approved
   tasks, fix reproduced failures through the existing paths, then expand to
   30–50 tasks through Standing Orders with recorded
   outcomes, evidence, elapsed time and manual-rescue counts. Report actual
   completion and rescue rates, not a reliability rating inferred from a test
   count. Include UI and backend changes, tests, dependency setup, interrupted
   work, unavailable providers, a lost browser connection and a revision from
   the phone. Each successful task needs the requested behavior, passing checks,
   reviewable diff and appropriate evidence (viewport screenshots for UI work).
   Keep initial failures in the report even when a later version fixes them.
   Proposed acceptance: at least 95% of the defined task set completes without
   manual technical rescue; every remaining task identifies its gate and next
   action; zero lost work, duplicate dispatches or falsely verified results.
   Legitimate human decisions are not technical rescues. A small pilot is a
   release checkpoint, not a statistical guarantee across arbitrary projects.
   Test package-service update/recovery separately from native app swapping.
3. **Phone conversation: use the existing mobile Chat/Ask experience.** Free-form
   requests, task revisions, confirmation cards, and recorded results already
   share the mate engine. Local improvements now preserve tab drafts, prevent
   duplicate sends across restart, keep a pending composer available, and show
   reconnect state without repeated full-page refreshes. Verify the installed
   phone-to-real-result journey after the native access gate is resolved.
   Free-form Telegram conversation and media delivery remain optional later
   adapters, not prerequisites for conversational phone control. No second
   engine, approval policy, or polling agent.
   The optional `/status`, `/task <id>`, and `/help` Telegram shortcut is also
   implemented locally; delivery still needs the updated runtime and paired bot.
4. **After that: small, provenance-backed project learning.** Reuse verified
   commands and repository conventions with visible sources and reset controls.
   Start with proven facts, not a general memory platform.

Keep real exhausted-subscription fallback certification fail-closed. No new
task-duration caps, unlimited repair loops, or mandatory extra reviewer stages
are required for these steps.

Standing Orders should be the place where a person can hand off an outcome,
leave, and return to a result they can trust. These priorities are ordered by
the weakest link in that promise: execution first, proof second, breadth third.

## 1. Never Stuck

The current reliability follow-up is the
[Unattended work completion plan](UNATTENDED_PLAN.md). September 11 real runs
exposed restart ownership, review recovery, runtime-readiness, and proof-handoff
gaps beyond the earlier certification baseline. Close and recertify those
before expanding the orchestration feature set.

A filed and approved task either starts, names the exact gate preventing it, or
fails with a repair path. “Queued” is not an explanation.

Done means:

- the worker survives terminal closure, crashes, login, and reboot;
- installation verifies that the worker process is actually running;
- task and inbox views distinguish human approval, dependency, capability,
  worker-liveness, and active-run gates;
- every blocked state gives one concrete next action;
- an end-to-end check files, approves, runs, and reaches a terminal outcome.

The first bounded self-healing path is intentionally smaller than a general
repair agent. `standing-orders verify set --self-heal` previews the exact
approved setup and its digest; confirmation must echo it with
`--setup-digest <shown> --yes`. When a project check cannot start because a
required project executable is missing, the worker may run that setup once and
retry that exact check once. Ordinary failures, timeouts, and executables that
exist but cannot run do not trigger recovery. The combined check log is
evidence of every step. A changed setup or project check, failed setup, file
changes, a moved checkout, inability to confirm unchanged files, lost custody,
or a still-missing executable stops recovery as missing evidence rather than
claiming the product failed.

Structured planner and reviewer replies have their own narrow recovery path.
Standing Orders normalizes transport syntax only, then—when a resumable session
exists—returns the exact validation errors through at most two correction child
runs in that same session. A correction cannot invent scope or criteria; every
attempt, including a rejected reply, is retained as sealed `structured-output`
evidence.
Planner worktree proof and reviewer scratch proof are repeated after each reply.
Provider, custody, and tamper failures stop normally rather than being presented
to the model as formatting work.

### Certification handoff

The earlier implementation passed its pre-Windows certification baseline. Real Claude
and Codex subscription canaries pass planning → approval → build → verified
proof → duplicate-dispatch refusal on macOS; Windows CI passes the native
Task Scheduler/link/dispatch seam and `cmd.exe` setup/verification on Node 22
and 24.

Two environment-dependent checks remain, explicitly tracked rather than
blocking the next product priority:

1. On the physical Windows PC, run both real-provider canaries, install the
   scheduled worker, prove a task finishes after the app and terminal close,
   reboot, and prove a second task finishes. The exact commands and teardown
   are in [CERTIFICATION.md](CERTIFICATION.md#physical-windows-checklist).
2. Automatic provider fallback stays fail-closed until a real exhausted
   subscription response is captured and reviewed for each exact CLI version.
   A successful normal canary cannot prove that terminal. Readiness remains
   visible through `standing-orders providers`.

## 2. Verified Done

Completion is an evidence bundle, not an agent assertion. Each task should show
its acceptance criteria, commands and checks run, changed files, diff summary,
screenshots for UI work, and any caveats. A run without required proof is
“needs verification,” not done.

## 3. Chat to Result

The unified chat should cover the whole loop: inspect the portfolio, clarify an
outcome, draft or revise a plan, approve, watch execution, answer decisions,
review evidence-rich results, request revisions, and publish. Rich cards should
remain views of durable workflow state rather than chat-only copies.

## 4. Outcome-oriented planning

Planning should turn a goal into an explicit dependency graph with acceptance
criteria, risks, likely files, verification steps, and decision points. Plans
should adapt when repository evidence invalidates an assumption without quietly
widening the approved scope.

## 5. Review cockpit

Make review faster than reading an agent transcript: intent-to-diff mapping,
risk-weighted file order, visual proof, test evidence, unresolved caveats, and
one-click accept, revise, compare, or publish actions.

The first slice has landed as the `/review` cockpit: a master/detail over the
existing completion records. The queue ranks visible completed tasks by a
labeled *review priority* (refuted or unaccepted-short proofs, reviewer
contradictions, and observed CI failures first; manual completions, legacy
results, and pending manual-review criteria next), bounded to the newest 100
completions and saying so, with a stable `?result=<task>` deep link that
resolves an older completion directly. The selected result joins the approved scope and
plan to the stored criterion matrix and sealed diff: changed-path citations
anchor into the matching file of the parsed patch, files outside non-empty
signed touches are flagged, and every evidence source — the plane's re-run,
the agent's checks, the reviewer's judgements and findings, validated
screenshots, caveats, publication and CI observations — is labeled and says
plainly when it is missing or truncated. The primary act is chosen from the
state and posts to the endpoint that already owns it (accept-proof, comment,
revise, draft-repair) or links to the comparison screen and the pull
request. No review-state schema, agent stage, or authority was added; the
priority order never changes the persisted verdict or the downloadable patch.

## 6. Adaptive routing and project learning

Route planning, building, repair, and review independently by task risk and
provider availability. Learn stable repository facts—commands, conventions,
failure patterns, ownership, and preferred models—from verified outcomes, with
visible provenance and an operator-controlled reset.

The routing half has landed as explainable, risk-aware phase routing: one pure,
table-driven policy recommends plan, build, repair, and review agents from the
declared risk, quality mode, acceptance evidence needs, publication authority,
runner-reported provider readiness, and the configured routine and strong
candidate tiers, with plain-English reasons per leg — every leg an exact
provider and model id. Approvers override per phase with attribution in one
digest-checked transaction; approval seals the route and any explicit fallback
chain; task-level route edits stale the approval while global configuration
never rewrites a sealed route; a routed row with unreadable route data fails
closed; an unavailable provider halts rather than being substituted, moving
only to an explicitly approved fallback entry. Its authority is now closed end
to end: run admission proves every route stamp — shape, phase against role,
exact provider and model, and provenance against the sealed route, the
approved fallback chain, or a proven pre-routing row — before a run row
exists; a routine's approval freezes an exact four-role snapshot that every
firing copies verbatim; task, chat, and triage approvals restate one concise
line of exact agents before the password, with each risk level explained; the
console offers only configured, role-valid agent choices; and chat reads the
route and proposes confirmation-gated changes through the same authenticated
edit. The remaining authority gaps closed on top of that: a routed task never
opens an unstamped run and the store dictates nothing — every planner,
builder, reviewer, fallback, and repair run presents the exact authority it
holds or no row opens; chain custody (base, parked-resume, fallback, repair)
is proved and written in the run's own insert and rolls back when it cannot
be; fallback admission re-proves the task, live cycle, approved chain, index,
entry digest, provider, model, auth mode, repair model, and `fallback`
provenance, consuming no edge on a mismatch; profile, chain, route, fallback,
auth, and numeric parsing is strict and corrupt data cannot approve, admit,
spawn, or shrink authority; one integrity projection gates every routine
surface and act, a corrupt approved snapshot is never live, refresh withdraws
it even under unchanged working data, and an authentic or interrupted v47
upgrade re-runs no older data pass and approves nothing; a legacy routine or
scope gets a plain refresh/re-file road instead of a password on the task,
chat, inbox, and routine surfaces; Codex resumes carry their sandbox as an
override so a structured correction is no longer an immediately doomed turn,
and a protocol failure on a resume is retried as a fresh planner root — all
proved on a real Codex plan-first run and a real subscription-backed chat
rather than seeded demo turns. The learning half (project memory) is not
started.

## Current focus

The current work order is the dated sequence at the top of this document.
The [contract handoff body](CONTRACT_HANDOFF_PLAN.md) is integrated and has its
own bounded real-provider certification. That closes the earlier planner,
revision-term, and inherited-review-context defects; it does not close the
installed Mac's project-access gate or physical Windows acceptance.

Priority 1 is active again under the [unattended completion plan](UNATTENDED_PLAN.md).
The earlier pre-Windows gates passed, but subsequent real work exposed gaps
that now need closure and broader certification. Physical-machine and real
account-exhaustion checks also remain. Its structured planner/reviewer recovery is bounded:
syntax-only normalization, no more than two same-session corrections, sealed
attempt evidence, and fresh workspace or scratch proof after every reply.
Priority 2's proof contract, independent review, concise
result receipt, and annotated revision flow have landed, and Priority 5's first
slice — the review cockpit over completed work — is in.

The first Priority 3 slice closes the focused chat's request-to-result loop
without introducing a second workflow engine. A confirmed task proposal now
continues directly into its task conversation. That conversation shows one
server-derived journey from requested → planned → approved → building → result,
offers the existing digest-bound, password-step-up approval inline, refreshes
live execution state without replacing the composer or losing typed text,
answers durable blocking decisions and returns to the same chat, and lands on
the evidence-backed result receipt with review, annotation, and revision
controls. Approval nonces, decision rows, dispatch diagnoses, publications,
and proof artifacts remain the same records used by the task and run pages;
chat is a cohesive control surface over them, not a chat-only copy. A scope
that changes during live polling asks for a secure page refresh instead of
injecting a password form into an already-running document.

The second Priority 3 slice makes intake conversational. One plain-language
outcome is sufficient: the mate infers routine task fields and acceptance
criteria, leaves file discovery to the planner, and asks only about ambiguity
or a consequential tradeoff that can materially change the result. It groups
at most three questions, recommends a safe default, and honors “use your
judgment” for reversible choices. The proposal card makes the inferred
planning posture visible; confirmation either starts the existing repository
planner or leads to scope approval using the same filing door. No chat-only
intake record or second planning engine was added.

The third Priority 3 slice turns the planner's handoff into a durable execution
plan. New plans have one compact, validated structure—approach, ordered
milestones, dependencies, risks and mitigations, and proof mapped to every
signed acceptance id—and render as the same rich card on task, chat, and
triage surfaces. The operator can refine the plan before starting; stale edits
and stale approvals refuse, approval locks the exact verified artifact hash,
and the builder receives that stable version. The existing plan artifact is
still the only source of truth, with safe fallback rendering for older plans.

The fourth Priority 3 slice lets that plan adapt while a build runs, without
becoming a second workflow engine. A running build checkpoints durable
milestone state—pending, current, completed, blocked—against the exact plan
revision its brief named; older attempts with no checkpoint stay readable.
When repository evidence invalidates a named dependency, risk, or approach,
the builder files one bounded, evidence-linked replacement plan and pauses at
a safe point rather than guessing or grinding on a false premise. A plan-only
refinement inside the signed scope appends an immutable revision and resumes
on its own; any change to goal, boundaries, touches, acceptance, permissions,
quality, budget, or publication authority invalidates approval and stays
paused until a person accepts or rejects it. The task page and focused chat
render one shared projection—current revision, live milestones, and any
pending decision—so the two surfaces can never disagree. Milestone progress
is the agent's own report and is labeled as such; it never substitutes for
the proof contract's own adjudicated verdict. The running-task hierarchy is
progress first; an approved plan folds behind one plain disclosure, while an
unapproved plan remains fully visible for review. Revision decisions use
outcome language (“Approve changes & continue” / “Keep current plan”), and the
checked-in desktop and mobile proof images are true viewport captures rather
than misleading full-page composites.

The first three Priority 2 slices landed already:
completion carries a typed, hash-addressed proof the plane
adjudicates against evidence it captured itself, rather than an agent's own
assertion; as of Acceptance Contract v2, that proof answers a rubric the
*operator* signed before the build ever started, not one the agent invented
after seeing what it built; and, as of evidence review v1, a structurally
well-formed proof is no longer the last word — an independent reviewer
judges whether the diff actually does what each signed criterion says, and
a bounded loop can draft (never dispatch unattended, absent a freshly
signed grant) exactly one fix naming what remains unmet.

The current Priority 2 slice turns those records into one concise result
receipt on both the task overview and its focused chat: what shipped, proof
level, acceptance pass count, sealed diff size, validated screenshots,
caveats, and direct paths to the full evidence or a revision conversation.
It is a projection of the existing sealed artifacts, not a parallel result
store or another agent stage. The full-evidence road now renders the sealed
patch as a responsive structured diff. Normal viewing is the default; an
optional Annotate mode targets exact old or new lines, collects feedback, and
then seals the chosen batch into one unapproved, scope-inheriting revision.
This improves the existing review path without making review or revision a
mandatory workflow stage.

The first Priority 1 slice now pins the worker service to the installed Node
runtime, requires a fresh worker heartbeat before installation reports success,
and shows the exact dispatch gate on every task. A second slice gives every
actionable gate one **Get this task running** entrance on the task page and in
focused chat, derived from that same diagnosis and routed to the nearest
existing guarded repair. The builder-liveness path distinguishes a project
that has never been connected from a known builder that disconnected:
first-time setup teaches the single normal lifecycle command
(`standing-orders up`), while reconnection says to reopen Standing Orders and
that the existing task resumes automatically. Split console, worker, and OS
service commands stay advanced plumbing rather than normal UI choices. A
real-Git successor certification now proves that a stale
worker is interrupted, exactly one successor completes with typed proof and
terminal diff evidence, and a later dispatch cannot duplicate the result.
The normal foreground service is now machine-wide rather than per-project:
one saved projects folder defines the boundary, every added local or GitHub
repository connects to the live worker without a restart, and later starts
reconnect the full registry from any directory. The project rail and unified
chat follow that same live set.
Unattended permissions are now
an installation default plus a durable per-task choice: `auto` keeps the guarded
provider classifier, while Full access seals Claude's
`--dangerously-skip-permissions`, Codex's combined approval/sandbox bypass, or
Gemini's `yolo` into that task's approval so permission prompts cannot strand it
while the operator is away. Changing
the default never broadens existing approvals.

The first Priority 2 slice: a builder may write one nonce-bound proof
manifest — acceptance criteria, checks with exit codes, changed paths,
caveats, and screenshot paths for UI-facing work — alongside its terminal
handoff. The plane validates every claimed screenshot as a bounded PNG or
JPEG by signature, validates claimed changed paths against the sealed
diff, and re-runs one operator-approved per-repository verification
command (`standing-orders verify set`) in the leased worktree, never a
model-authored one. From this it computes one closed verdict — *verified*,
*attested*, *short*, or *refuted* — once, at completion, and every surface
(task, run, done, builds, board, `task show`, `brief`) speaks the same
words. A `short` or `refuted` verdict reads "needs verification," not
done, until an operator explicitly accepts it (`task accept`, or the
console's accept button); the branch and diff stay exactly as reviewable
either way — missing or malformed proof never destroys committed work.

The second Priority 2 slice, Acceptance Contract v2 (schema v39): the
rubric a build is judged against is now a *signed term*, not an assertion.
A scope carries an ordered list of acceptance criteria — a stable id, an
outcome statement, and the evidence kinds (`check`, `screenshot`,
`changed-path`, `manual-review`) required to answer it — folded into the
same digest the operator's password signs, restated above the seal on
every approval surface. `how` rides alongside each criterion as advisory
guidance only; it is never part of what is signed. Every scope-producing
road — the planner, the task editor, new-task filing, chat and mate
proposals, coordinator filings, routines, templates, and the demo — now
requires at least one criterion before a scope can be proposed through it;
a scope already approved before this migration keeps its digest and its
approval exactly as they were. The builder's brief quotes the signed
rubric verbatim and requires the proof to answer every criterion by its
exact id, with typed evidence references into the same proof's checks,
screenshots, and changed paths — never a self-declared verdict alone.
Adjudication treats an unanswered criterion, an evidence reference that
does not resolve, or a criterion still needing a human's `manual-review`,
as *short* — the same bucket, so a signed rubric can never read
*verified* or *attested* on the strength of a row nobody has actually
looked at; an operator clears it with the same accept-anyway act a
short/refuted proof already offers. A proof that alters a signed
criterion's statement is *refuted*, the same severity as any other
altered term. The claimed changed-path set is checked against the
sealed diff GLOBALLY — every criterion, whether or not any of them cite
`changed-path` evidence — for exact equality in both directions: a
claimed path absent from the diff is *refuted* (a lie about presence), a
diff path never claimed is *short* (a gap), and an unavailable or
truncated diff-stat is *short* outright, never silently skipped. A
screenshot answering a criterion must be a real PNG or JPEG of meaningful
byte size and at least 320×200 pixels, read from the file's own header,
never a claim. One shared criterion-to-evidence matrix — pass, missing,
failed, or manual-review, per criterion, each row naming the proof's own
answered evidence references (linked to the underlying artifact where
one resolves) — renders identically on the task, run, done, builds,
board, inbox, and chat surfaces, and in `task show`.

The third Priority 2 slice, evidence review v1 (schema v40): a signed
rubric being well-formed evidence is not the same claim as the diff doing
what it says, and this closes that gap without a second agent invocation
or a second review mechanism — it extends the existing reviewer pass
(v29). The reviewer sees the same sealed artifacts it always has, plus,
when this run signed a rubric, that rubric and the builder's own
re-serialized proof — never the repository, never a second opinion
dressed up as machine verification. It judges every signed criterion by
exact id as *upholds*, *contradicts*, or *cannot-tell*; the fold can only
LOWER the structural verdict, never raise it: a contradiction refutes,
`cannot-tell` never moves anything, and `upholds` can never turn a
*short* proof *verified*. A `short`/`refuted` run with named unresolved
criteria gets at most one durable revision draft, inheriting the signed
rubric verbatim and naming exactly the unmet ids — filed unapproved by
default, with zero unattended spend and no new authority, consistent with
the suggestion-first doctrine the CI-repair button already established.
A newly signed mode term (`repairAuto`, `repairMaxAttempts` 0–3 — never
inherited from a legacy signature) can authorize auto-approving that
draft, bounded by a signed attempt cap, a no-progress stop (two
consecutive attempts that fail to shrink what remains unmet), an
integrity stop (a refutation that is a lie about the signed terms, not a
gap, is never handed back to the same machine unattended), and the
existing spend and run rails — the chain closes the instant any attempt
reaches *verified* or *attested*, and the operator's own act
(`standing-orders task repair <run-id> --yes`, or the console) is still
the only road to unattended-cap-free approval.

### Control-app integration (2026-09-12 UTC)

The operator prioritized assessing and integrating the older control-app branch.
[The integration record](CONTROL_APP_INTEGRATION.md) distinguishes added desktop,
setup, provider/model-discovery, and calendar features from superseded engines
and remaining stop/resume and Telegram forward ports. Contract fidelity remains
the next quality milestone; no second worker or conversation engine is needed.
