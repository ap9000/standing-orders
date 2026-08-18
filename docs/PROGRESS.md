# Progress

**2026-08-17 — the live worktree peek (A2, v17): three Codex rounds, then
a native reader that executes nothing.** The attended track's blocked
item, unblocked the hard way. Round 1 (findings 13–24) killed the naive
design: ANY git spawned against an agent's checkout can execute
repo-configured clean/process filters, and even object-database reads at
poll time carry lazy-fetch/replace-refs/alternates execution surface.
Round 2 (25–36) accepted the pivot — no subprocess at observation time —
and rejected two overclaims. Round 3 (37–45) accepted the reclassified
trust story in principle and handed back an implementation checklist plus
four real walk defects, all now closed. What shipped: the base tree is
snapshotted ONCE per run in the pre-spawn window that computes the base
itself (`git ls-tree` against the project clone, never a worktree,
lazy-fetch and replace-refs disabled, env allowlisted), stored as an
enveloped `base-tree` artifact (binds repo+run+exact base OID; undecodable
paths refuse the WHOLE snapshot; capture failure disables the peek and
nothing else). A poll then runs pure Node: descriptor-DISCIPLINED walk
(O_NOFOLLOW|O_NONBLOCK opens, fstat-through-descriptor, regular-file and
same-device proofs before a byte is read, directories device-gated before
descent, symlink TARGETS compared by readlink+in-process git-blob sha1,
reads bounded to the accepted size with growth re-fstat'd, per-entry and
per-chunk deadlines, unreadable corners make the look PARTIAL and
suppress the deleted sweep), rendering NAMES AND COUNTS ONLY — changed /
deleted / new (aggregated, never suppressed, hard row cap groups
included) / explicitly UNCHECKED. The occupancy fence: worktree
lease_epoch, fresh randomness written atomically with every lease and
rotated on release — the peek proves the epoch before AND after the walk
and discards on mismatch; the fragment cache is keyed run:base:epoch,
LRU+byte bounded, re-guarded on every hit, byte-capped after escaping.
Locality is an ADMINISTRATOR ASSERTION (`serve --runner <name>`, off
without it) plus realpath containment in the pool root. Surface: the run
page's polled region (15 s, visibility-paused) + a task-page door;
cookie sessions only; Cache-Control: no-store; nothing durable ever.
Residuals stated in code where they live: same-UID is the product's
universal boundary (snapshot integrity = database integrity class), and
pathname traversal races remain a same-volume misdirection channel in a
names-only display until a sandboxed helper exists (named follow-up).
Schema v17: worktree.lease_epoch + artifact.kind admits 'base-tree' by
the recognized-exactly rebuild (doctored-db regression test; live console
migrated and verified). Suite 986.


**2026-08-17 — tournament stage 6 + the agent-count knob (v16, operator
request: "configure number of competing agents").** The count, three
ways: `task scope --race claude:claude-sonnet-5 --race-count 3`
replicates one named agent (a count that contradicts an explicit lineup
refuses — a count is never an instruction to invent agents); `config
set budgets --race-agents N` sets the installation default, applied
only where a filing names ONE agent and no count; and the console scope
form grew the whole tournament section — how many agents compete
(one/2/3/4), the competing model from the pinned price list, per-agent
and total dollars prefilled from defaults — plus the v15 budget field
it was owed. A console-filed race lands as terms beside the scope, the
approval card restates agents-and-dollars and binds the JOINT
fingerprint (finding 31 now holds on the web path too: one yes, both
documents, one transaction), and saving the form back to "one agent"
retracts the standing race. Routines gained their per-run ceiling:
`routine add --budget-usd N` is digest-bound (conditional inclusion —
existing routines digest unchanged) and lands in every instance's scope
as its own digest-bound budget term, enforced by the same native-cap
plumbing. Stage 6 housekeeping in the tick: sweepContestCleanup returns
DECIDED tournaments' checkouts to the pool — this runner's custody
only, winners and losers alike (branches and evidence survive), and a
checkout that will not release cleanly is marked attention and paged
once, never force-cleaned; escalateOverdueContests pages exactly once
at fourteen days (overdue_paged CAS), and never abandons anything on
its own. Schema v16: spend_defaults.race_agents,
routine.budget_per_run_microusd. Live console migrated and verified.
Suite 971.


**2026-08-17 — tournament stage 5: the comparison screen and the pick.**
The payoff surface. `/contest/<id>` lays every agent's result side by
side — outcome, duration, questions asked, its own conclusion, the
verified diff, and the money in dollars (an unknowable figure said in
words, never $0.00) — and offers a pick button ONLY where the evidence
predicate allows: state built, a committed real change (or a verified
no-change whose head still equals the tournament's base), typed capture
verdicts 'ok' on both diff artifacts (the capture path now stamps
capture_status from the git exit codes it already had), bytes verifying
against their recorded hashes, nothing redacted, nothing truncated.
Everything else is labeled with its reason in plain words. The ceremony
is two POSTs: the first MINTS a durable single-use nonce (finding 30 —
a GET can never mint) bound to the contest-pick/v1 tuple digest — every
agent's identity/state/run/outcome/committed/head, every artifact's
hash/bytes/capture/redaction, the selection, and the exact publication
consequence — and answers with a confirmation screen restating all of
it; the second takes the password, and finalizeContestPick does the
whole thing in ONE transaction: nonce consumed against the REBUILT
digest (evidence tampered between screens = refusal), winner's bytes
proved again, state CAS'd by generation, winner stamped, all agents
marked cleanup-pending, the contest hold lifted, the task done, and the
publication intent created now-and-only-now under exactly the tick's
own predicate (committed, non-no-change, live grant, branch under the
grant's prefix, selector satisfied). Abandon gets the same ceremony
shape and fails the task requeueably with everything kept. The board
classifier reads tournaments before the generic branches (finding 6):
racing shows "tournament — N agents racing", pick-wait/exhausted/
interrupted are needs-you cards addressed at the comparison screen, and
the aggregate boundary pages once through the outbox. Also fixed:
contest.ts carried raw NUL bytes in digest separators (git saw binary);
now \u0000 escapes, byte-identical digests. Suite 965.


**2026-08-17 — dollar thresholds land at both layers (v15, operator
request: "selectable when creating the task or with a global setting").**
Per task: the scope gains an optional budget term — `task scope <id>
--budget-usd 3.50` — that is DIGEST-BOUND (editing it strands the
approval like any term; a scope without one digests exactly as before,
so no existing approval moved), restated by the scope description in
words ("$3.50 per build attempt — the agent is stopped at this figure"),
and enforced through the same native-cap plumbing tournaments use.
Globally: `config set budgets [--build-usd N] [--race-per-usd N]
[--race-total-usd N] --as <you> --token <t>` (authenticated, audited)
writes spend_defaults — new filings PRE-FILL from these (explicit flags
always win, and the digest binds the actual numbers wherever they came
from), tournament filings inherit per-agent/total defaults, and the
build default doubles as an installation-wide backstop: the ordinary
build path now caps every attempt at the SMALLER of the scope term and
the backstop. Ruling 3's fail-closed rule holds: a provider that cannot
hold a native dollar cap does not run capped work — the tick skips it
typed ('budget-unenforceable') instead of pretending. Schema v15:
task_scope.budget_microusd + the spend_defaults singleton. Suite 954.

**2026-08-17 — tournament stage 4: questions, answers, custody, and the
lineage meter.** A racing agent that parks now records CUSTODY of its
checkout (branch, exact head, which machine, whether dirty — round-3
finding 29) before the worktree goes back to the pool, and its question
reaches the operator tagged with its agent; the database enforces ONE
open question per agent by partial unique index (finding 28, living in
the post-migration block per the v11c lesson). Answers re-admit: the
tick's new resume pass finds decision-wait tournaments whose parked
agents have answered questions, and — on the ORIGINAL machine only,
after re-leasing the SAME checkout and proving its head matches custody
— reclaims the task, reserves one worker-process slot, opens a resume
run parented to the parked one, and builds with ONLY the remaining
budget as the native cap. A checkout that cannot be proved to be the one
the agent left stops that agent ('contest-custody') rather than
cold-starting against different history. Answers are lineage-filtered:
attachAnswers now matches the receiving run's agent, so a racing
agent's answer can never leak into a sibling's brief or an ordinary
build. The EXCLUDE ceremony (`contest exclude <id> <agent-number>`,
authenticated) closes a question nobody will answer with the typed
'excluded' reason — never a fake option — stops that agent, and
re-aggregates; `contest show` gives the machine-readable state and both
verbs join the envelope sweep. Interrupted-tournament recovery now
actually runs each tick. THE CATCH: the end-to-end test (park →
decision-wait → answer → resume → pick-wait, real tick, real git)
exposed that the spend meter used MAX semantics — the park's $0.10
vanished when the resume's $0.30 settled. The meter is now CUMULATIVE
across the lineage (each invocation settles once, the agent's total is
the sum), which is what the round-2 repair-budget finding demanded all
along. The e2e also proves the resumed brief carried the answer's exact
words, exactly one agent respawned, and every slot came home. Suite 952.

**2026-08-17 — tournament stage 3b: the dispatch — a whole race runs.**
The tick now recognizes an approved tournament on a claimed task and
sends N agents instead of one builder: admission (all-or-none, quota by
distinct key, slots bound to agents), the base commit frozen by SHA and
stamped with the live setup identity, a worktree leased per agent on its
own contest-unique branch, a run opened per agent CARRYING its agent
identity, the ready barrier crossed only when every agent is prepared —
and only then the concurrent builds, each under claude's NATIVE dollar
cap (`--max-budget-usd`, plumbed Invocation→adapter argv) with the
worker-process ledger recording each spawn's process-group id via the
new onSpawn callback (exec→builder→slot). Failures anywhere before the
barrier interrupt the WHOLE tournament — worktrees, slots, and the
claim all come home, nothing spawns. Completions route through the
child finalizers: run finished honestly (built/no-change/parked/
failed), evidence captured by the builder as for any run, money settled
from the provider's reported figure (or latched at the full reservation
if it went silent after starting), and the aggregate boundary crossed
exactly once. A parked agent's question reaches the operator tagged
with its agent (decision.contestant) — full decision-wait mechanics are
stage 4. THE PROOF: an end-to-end test drives a real tick against real
git — two claude agents race, both finish, the contest lands in
pick-wait with the "compare the results and pick one" hold, both
contest branches exist in the repository, both spawns carried
--max-budget-usd 5, terminal diffs exist per agent, measured spend
equals the provider's reported figure in micro-dollars, the parent
claim released exactly once, and every worker-process slot came home.
Suite 950.

**2026-08-17 — tournament stage 3a: filing, the one yes, admission,
children, recovery.** src/contest.ts is the orchestration: raceDigestOf
(order-sensitive, retries pinned at zero) and tournament-approval/v1 —
ONE approval hash over scope AND race terms (finding 31), so `task
approve` on a tournament task refuses the scope digest alone and names
the joint fingerprint; the interactive yes prints the agents, each
agent's dollar cap, and the tournament total before asking. planTournament
refuses ineligible providers in their own words (codex: turn-end-only
usage), refuses unpriced models, and refuses a total that does not cover
the TRUE worst case (each agent's budget plus its own overrun reserve —
the arithmetic finding 24 demanded). admitContest is one reentrant
transaction: open-contest check, digest re-derived from the stored terms
(the H1 rule), approval bound to that exact digest, quota grouped by
distinct key with doubled half-open keys refused, worker-process
capacity in 'processes' mode, then contest + agents + slots created with
every slot bound to its agent — a refusal persists NOTHING. Child
finalization (findings 1/17): an agent finishing writes its own row,
frees its slot, settles its money (or latches the FULL reservation when
the provider went silent), and asks inside the same transaction whether
the tournament just ended — the REGRESSION TEST proves the first
finisher leaves the parent claim alive and the last one releases it
exactly once, installing the contest-owned hold whose reason reads
"tournament finished — compare the results and pick one". Recovery
converts a dead-leased tournament to 'interrupted' by the same
generation CAS, latching only agents that actually reached provider
start — never-started ones stay at zero. Generic task state/requeue/
unhold refuse 'contest-open' while a tournament runs. Found and fixed
along the way: liveClaimByLease initially used SQL wall-clock time
against the codebase's injected clocks — caught by the fixed-timestamp
tests disagreeing with datetime('now') across midnight UTC. Stage 3b
(dispatch: worktrees for all N, the ready barrier, N concurrent builds
under the native budget cap, child wiring in the watch) is next. Suite
949.

**2026-08-17 — tournament stage 2: the v14 schema, in plain words.**
Five new tables (the internals keep technical names; every screen will
say "tournament", "agents", and "worker processes"): tournament_terms —
immutable approved-terms rows, one ACTIVE pointer per task, money as
integer micro-dollars with the overrun reserve held apart from the
spendable budget; contest — the running tournament, whose current lease
identity lives ON the row so aggregation, reaping, and crash recovery
all fence on the same facts; contestant — one racing agent, with money
deliberately split three ways (measured = what the provider reported,
monotonic; accounted = what the ledger charges, the FULL reservation
when unknowable; unknown_spend = the honest flag that they differ) plus
checkout-custody and cleanup columns; execution_slot — one row per
worker process with a reserved/running/released life and the process
group recorded so recovery can ask the OS before freeing capacity;
ceremony_nonce — durable, hashed, single-use, consumed inside the same
transaction as the act it authorizes. Columns: run.contestant,
decision.contestant (the one-open-question-per-agent rule becomes a
real index later), artifact.capture_status (typed 'ok'/'failed' — prose
never carries authority again), runner.capacity_mode ('tasks' stays
the default; 'processes' is the explicit opt-in — an upgrade never
silently changes what an operator's capacity number means). The hold
rule widens to admit tournament ownership via the recognized-exactly
rebuild — v14 is deliberately NOT purely additive and says so where it
happens. THE CATCH OF THE DAY: the migration tail initially failed to
land (a silent no-op text replacement) while the version stamp still
advanced — the live console caught it (v14 stamp, missing columns), the
tail was landed with an assertion, the live database was rolled back a
version and re-migrated correctly, and the suite gained a
doctored-database regression test that rebuilds a genuine pre-v14 hold
shape and proves the upgrade fires. Store methods shipped for every
table: filing/approval persistence, generation-CAS state moves for
contest and contestant, the single-live-run pointer, monotonic spend +
the unknown-spend latch, the slot lifecycle, and mint/consume/sweep for
ceremony nonces — all covered by tests. Suite 940.

**2026-08-17 — tournament builds: three design rounds to APPROVE WITH
CHANGES; stage 1 ships.** The A3 design arc ran v1 → redesign (13
findings: shared finalizers would release the parent claim; dollar
ceilings unenforceable, the waiver rejected) → v2 metered kill-switch →
redesign (findings 14–23: codex/openrouter report billable usage only at
turn end — tournament-INELIGIBLE; claude's own --max-budget-usd + a
reserved one-call tail is the enforcement; monotonic persisted spend
with an unknown-spend latch; a uniform execution-slot ledger; child
finalizers embedding aggregation; decision-wait; typed capture status;
durable ceremony nonces; co-approved tournament terms) → v3 adopting
every ruling verbatim → **approve with changes** (findings 24–31: the
tail must be bounded by a pinned request ENVELOPE — quantities, not just
rates; measured vs accounted spend kept apart; slots get
reserved/running/released with incarnation; dispatching-state recovery;
decision.contestant column for SQLite-valid uniqueness; workspace
CUSTODY through decision-wait; nonce minting off GET; a joint
scope+race approval digest). The findings files are the spec
(scratchpad codex-tournament-findings.md / -v2- / -v3-). STAGE 1
SHIPPED: src/pricing.ts — pinned build-model prices with the cache
token classes priced separately and the request envelope's quantity
bounds per model, so `oneCallTailMicrousd` is the worst LEGAL call
(dearest input class × the whole window) rather than a rate with no
quantity; `settleBuildMicrousd` itemizes cache classes and returns null
on missing totals (the caller latches, never guesses). provider.ts
gains MONEY_CAPABILITIES (incremental usage, native cap flag, usage
semantics, derived tournamentEligible with the refusal said in words)
and `probeBudgetCap` — resolves the exact executable, reads its
version, and proves the flag in THAT binary's help, fail closed.
Stages 2–6 (schema v14, finalizers, decision-wait, ceremonies, cleanup)
follow the approved order. Suite 932.

**2026-08-17 — the attended track ships its first slice (workbench,
palette, live substrate, deep links).** Roadmap
(scratchpad/roadmap-attended.md, seeded by the Orca competitive read) went
through Codex review — approve with changes, 13 findings
(codex-attended-findings.md = the spec), which INVERTED the build order:
the named-region liveness substrate first, because the old fragment
swapper could only replace the whole `<main>` and would have refreshed
form-bearing panes. Shipped: (1) `regionScript` — swaps exactly one named
element, visible freshness ("updated Ns ago"), stale-state wording,
exponential backoff, hidden-tab pause, one poll in flight (findings 2/5/
6); the board migrated onto it. (2) **/workbench** (A1): the sit-and-watch
screen — a polling rail of needs-you (cap 100) and building-now (live
claims with plain-words phase, provider, client-ticking elapsed) plus a
just-finished tail, with the SELECTED task's full detail (banners, forms,
acts — never polled) in the main pane via the master-detail split;
admission before every LIMIT + per-row visible() re-check (finding 3),
which also fixed two pre-existing board holes: rolled-up done rows now
join the admission set inside boardScoped, and root ceilings enumerate
through admissionList instead of post-filtering. (3) The jump palette
(finding 4's exact contract): `g b/i/w/r/d` + `/` filter over a
server-rendered non-executable JSON index (200 tasks, saturation
declared), navigation ONLY — no key posts, ceremonies untouched; ignores
editable targets, modifiers, repeats, IME; dialog/listbox semantics; CSP
script nonce per response (never confused with approval nonces). (4) A4:
run pages poll their facts region while the run is open — elapsed ticks,
phase updates; a finished run's fragment says "finished — reload for the
final record" instead of growing forms (finding 5). (5) A5: console-URL
validator parses with URL and refuses userinfo/query/fragment (finding
11); `task add` and `template apply --file` print the console link beside
the id and carry a structured `links` object in JSON. Verified in a real
browser: rail, freshness stamp, selection, palette. **A2 (live worktree
peek) is BLOCKED per finding 7** — git clean/process filters mean diffing
an agent-controlled worktree can execute repo-configured commands; it
ships only after a hermetic-capture design passes review (park capture
flagged for the same audit). A3 (tournament builds) awaits its own
authority-bearing brief (finding 12 enumerates what it must answer).
Suite 927.

**2026-08-14 — key onboarding joins the console (operator request:
"shouldn't the key entry be part of the onboarding on the ui").** The
chat setup card gains an API-key field, on the TELEGRAM BOT-TOKEN
PRECEDENT exactly: pasted once inside the authenticated (password-again)
save, shape-checked (a pasted password is refused loudly, not stored as
a "key"), written to a mode-0600 file beside the database
(chat-key-<provider> under serve's config dir), asserted 0600 even when
the file pre-existed, NEVER written into the database, and never echoed
beyond redactToken's tail. Resolution order is environment first —
ANTHROPIC_API_KEY / OPENROUTER_API_KEY always win when set — then the
stored file; the card names each provider's key source (environment /
stored …tail / none yet). A stored key is forgettable from the settings
block (password again); storing or forgetting invalidates the catalog
cache. The CLI serve passes configDir (beside the db) already, so the
whole chat onboarding — key, provider, model from the live catalog,
ceiling — now happens on one screen with one password. Suite 919.

**2026-08-14 — the whole OpenRouter catalog, priced by the party that
bills it (operator request).** With OPENROUTER_API_KEY in the serve
environment, the chat setup card's model list becomes OpenRouter's LIVE
/api/v1/models catalog (cached 10 min, 5s timeout, 4MB cap, fatal-decode)
— every model selectable, each arriving WITH its price. The spend
discipline the Codex v3 review demanded is preserved by moving the pin to
the authenticated save: chat_config now carries price_in/out_microusd
(v13b, additive), snapshotted at `save` from the catalog (openrouter) or
the compiled table (anthropic/CLI), so reservations stay fixed-price and
an upstream price change never silently moves the ledger — re-saving
re-pins, and the card says so. Excluded rather than guessed: dynamic
pricing (openrouter/auto advertises -1) and unparseable rows; sub-micro
prices round UP to 1 so a paid model never reads free. Settlement now
takes MAX(pinned math, OpenRouter's own reported usage.cost) — the
ledger never undercounts. FLAGGED for the next Codex audit round: the
price-pin authority moved from compile time to the authenticated config
act reading the biller's catalog over TLS — same trust as the billing
itself, but it deviates from the reviewed "compiled table" wording and
deserves adversarial eyes. Suite 917.

**2026-08-14 — chat setup lives in the console (operator request: "this
will likely be mainly in the webui").** /chat now carries its own setup
card when unconfigured (and a quiet settings block when configured):
provider, model (only pinned-price models, grouped per provider), the
required weekly dollar ceiling, daily turns — submitted with the
password typed again and written whole under the session's name, the
same ceremony weight as the CLI's `config set chat`. The refusals that
need a restart (unscoped/root/unresolved ceilings, demo) stay prose;
the ones configuration can fix render the form. The API key is still
environment-only and the form says so in as many words — no key field
exists, nothing credential-shaped can reach the database from this
screen. Suite 915.

**2026-08-14 — FLEET CHAT SHIPS (v13), three Codex rounds deep.** The
design went v1 → REDESIGN → v2 → REDESIGN → v3 → approve-with-changes,
and the ten required changes are built exactly (the findings files in the
session scratchpad are the specs). What shipped: chat is a DIRECT no-tool
API call (src/converse.ts — anthropic-api / openrouter-api over fetch,
zero deps; no CLI spawn means no filesystem, no inherited AGENTS.md, no
hooks, no argv leaks, and max_tokens as a hard budget by construction);
`chat_config` is its own installation-scoped singleton, deliberately NOT
a phase row (change 1), set by the authenticated
`config set chat --provider … --model … --weekly-usd …` which refuses
--repo and unpriced models; every turn is a `chat_turn` ledger row —
metadata only, closed failure enum, integer micro-dollar WORST-CASE
RESERVATION counted transactionally against the rolling 7-day ceiling
(changes 4/10), dispatched exactly once via generation-checked CAS; a
turn that may have started but has no provable cost LATCHES its
credential (timeout, network-after-dispatch, malformed wrapper, crash
sweep) until the nonce'd, digest-bound, password-taking acknowledgement
screen charges the reserved worst case to a named approver (changes 5/6
— the ONE nonce in chat, because that screen restates financial terms
and re-enables spend). The snapshot is dedicated SQL (store.chatSnapshot,
change 9): explicit non-empty --repo list required (unscoped, root-based,
and unresolved-at-startup ceilings all refuse), admission inside every
query before its LIMIT, repo-null rows excluded from rows AND aggregates,
opaque r1/r2 ids with paths never leaving the process, decision
recaps/consequences/recommendations excluded, canary tests grepping the
serialized document for forbidden content, and the /chat page states
plainly what DOES leave (intentional provider egress, not a leak-proof
summary). Two-layer parsing (change 2): stream-capped fatally-decoded
provider wrapper (one text block, usage required, tool calls rejected,
redirect:"error") then the strict assistant envelope — duplicate-key
lexer, depth cap, exact keys, model-only DTOs with opaque repoId (change
3), at most 3 proposals, all-or-nothing; transport failures render a
static line and no model text ever. Drafts are EPHEMERAL session memory
(change 7): random 128-bit keys, 9 per approver across sessions with LRU
eviction, 30-minute TTL, gone on restart — the first durable copy of any
model text is the unapproved task/routine the operator files with a
password through the proposal door (filed_via `chat:<provider>`, single-
use in-memory CAS with no await before the claim), and the approve
ceremony is byte-identical to manual filing. The password is typed again
on EVERY message and every filing (v2 ruling 2). Door validators gained
byte caps + disguised-text on touches/requirements (change 8). Chat keys:
ANTHROPIC_API_KEY is stripped from every child process env unless a
caller re-supplies it explicitly (change 10 — it would also silently
flip claude builds to API billing). Chat refuses demo databases and
bearer callers. Suite 914 (chatledger 8, converse 13, chatsnapshot 5,
serve chat 7, all over mock transports — no network in tests).

**2026-08-14 — the demo sandbox (adoption track, step 4; the track is
COMPLETE).** `standing-orders demo`: one mkdtemp directory holding two
tiny git repos, a database, and evidence; seeded mid-flight (an approval
waiting, a blocking decision, a live claim in agent-running phase, a
finished run whose terminal diff + stat + handoff VERIFY byte-for-byte,
a failed attempt, a dependency, a hold, an approved routine with a fire
and an honest single-flight skip, and an opened PR observed passing);
served on localhost with the throwaway login printed to the TTY and a
0600 file — NEVER the --json envelope (finding 9). The honesty contract
(finding 8): the `demo` installation fact is stamped BEFORE any row and
has no unset API; `refuseDemo` fails closed in tick, watch, build,
publish, reconcile, daemon, bridge, outbox deliver, and all gh-touching
intake actions (reason "demo-database"), proven by a test matrix — a KEPT
sandbox pointed at by a real worker refuses to spend, forever. seedDemo
itself refuses an unfenced database, so synthetic history cannot land
anywhere real. Every page wears the sandbox banner (decoration; the fence
is the enforcement). Ctrl-C tears down, --keep preserves. Booted live:
login, inbox with decision card, roll-up board, banner — all verified
over real HTTP. README quickstart leads with the demo. Suite 881.

**2026-08-14 — the first-run checklist (adoption track, step 3).** serve's
inbox, while the installation has never finished a run successfully,
replaces the empty-queue card with a checklist DERIVED FROM LIVE STATE on
every render — never a stored cursor (finding 14): ceiling named (or, in
unscoped mode, named AS unscoped with the exact `serve --repo` restart
line — the wizard instructs where the console lacks authority, finding e),
spend routing (a fact about THIS DATABASE only; binaries/auth are the
worker machine's four separate facts via `standing-orders providers` —
the console never claims to have checked them, finding 15), worktree setup
command, skill installed (filesystem check per ceiling repo), first
standing order. Retirement is PERMANENT: store.firstSuccessAt derives the
first built/no-change finish from run history once, stamps it as the
append-only `first-success-at` installation fact, and later pruning cannot
resurrect the card. Template picker: /routines?template=<name> and
/tasks?template=<name> pre-fill the EXISTING forms from the library —
same guarded submission paths, nothing new to approve through; the task
form gained the not-this/touches fields the full scope always had. Suite
867.

**2026-08-14 — templates (adoption track, step 2).** Six common use cases
ship as STATIC DATA (src/templates.ts): nightly-deps, test-coverage,
docs-drift (weekly via every:10080), lint-sweep — plus issue-intake and
ci-babysitter as RECIPES: show-only walkthroughs of the existing grant and
repair ceremonies, refused at apply (reason "recipe"), because a template
must never create a grant or arm autonomous repair (finding 10). `template
apply <name> --repo <path>` PREVIEWS the exact filing (exit 3, reason
"unconfirmed" — the skills-install convention); `--file` (NOT --yes, which
reads like approval — finding 11) files it through the one door with
provenance `template:<name>`, and the output says UNAPPROVED — NO
AUTHORITY GRANTED in so many words. Edits: --title/--name/--goal/--not/
--touches/--schedule/--ceiling override at apply; a filed draft is a COPY
— editing the library later changes nothing anybody filed. A library test
proves every applyable template passes the exact validators manual input
passes. `template` joins OPERATE_COMMANDS and the TG-3 sweep. Suite 862.

**2026-08-14 — the one filing door (adoption track, step 1).** The
adoption-track + fleet-chat briefs went through Codex review (16 findings,
scratchpad codex-adoption-chat-findings.md — the findings are the spec;
verdicts: adoption approve-with-changes, fleet chat REDESIGN). Step 1 is
finding 7: before this, each filing surface validated what it happened to
think of — the console checked controls but not disguised text, nothing
ceiling-checked a typed repo, nothing recorded who filed what. Now
src/proposal.ts is the one door: `fileTaskProposal` / `fileRoutineProposal`
with an exact field allowlist (no spread — a template or model object
CANNOT smuggle approval metadata into scope rows), disguised-text refusal
on every field an approver reads, best-effort canonicalization with an
explicit-ceiling membership check (an EMPTY ceiling refuses every repo —
fail closed; an absent one is the CLI's honest none), digests computed
inside the door, and immutable `filed_via` provenance (schema v12:
task_ref.filed_via + routine.filed_via, set-once by construction — no
update API exists). Wired through: CLI `task add` (same text rules via
validateTaskText + provenance stamp, replay idempotency untouched), CLI
`routine add`, console quick capture, console routine form, intake run
(filedVia "intake"), revision seals ("revision"). Also v12:
`installation_fact` — append-only set-once markers (INSERT OR IGNORE is
the whole API) that the demo stamp and the wizard's retirement milestone
will both rest on. Suite 852.

**2026-08-13 — front-page pass two, against the field.** Studied ten front
pages (vite/bun/vhs/zod/ollama; OpenHands/aider/opencode/claude-squad/
agor). The finding that mattered: nobody in the agent category presents
their containment model with confidence — it's red warning boxes
(OpenHands), buried bullets (agor), silence (opencode), or a feature
literally named "yolo mode" (claude-squad). So trust leads here:
"Unattended is not auto-accept" is now the first section — a
can-never/enforced-by table (default branch, self-approval, irreversible
options, credentials, idle spend, unmeasured spend, guessing), closed by
the executable claim (unattended.test.ts). Also per the study: wordmark
with dark/light variants, ≤7-word category tagline, nav row, absolute
raw.githubusercontent media URLs (relative images break on npm's
renderer), Contributing/License tail, overnight-failure table de-duped
against the boundaries table. package.json: version 0.1.1, category-first
description, 15 keywords — awaiting the operator's republish so the
registry page catches up.

**2026-08-13 — the repo is the product too.** Pre-publish front-door pass:
GitHub Actions CI (ubuntu + macos × node 22/24: typecheck, build, the full
suite) with badges; CONTRIBUTING.md (fail-closed rules, the adapter
contract as the contribution surface); issue forms that ask for `--json`
output and warn against pasting tokens; repo topics; and a README
restructure — hero with an animated SVG of the unattended stretch
(docs/media/demo.svg, hand-built, no GIF tooling), a three-line npx
quickstart, and the status wall moved to its own section above Milestones
so the first screen is proof, not prose. npm publish remains the
operator's act; the README now ships as the registry front page when it
happens.

**2026-08-13 — the product is `standing-orders`.** The tagline was the
brand all along ("Standing orders for your agents"): the rename drops the
last night-shaped thing before anything is published, keeps the naval
lineage (a night order IS a standing order), and costs almost nothing at
this exact moment — the npm name was still unclaimed. Swept: package
name and bin, every command example and console surface (the brand reads
standing·orders), env vars (STANDING_ORDERS_*), branch namespaces
(standing-orders/<task>). SECOND PASS same day, per the operator ("all
under one name"): the protocol markers are STANDING-ORDERS-PARK/DONE/
PLAN-* (the worktree sweep still recognizes pre-rename NIGHTORDERS-*
leftovers — cleanup has no vintage), unattended.test.ts carries the E2E
(née night.test.ts), and the working folder itself is
~/Documents/standing-orders. Continuity: databasePath, evidenceRoot, and repos.json all fall back to
their nightorders-named homes when no new-name file exists — the rename
orphans nobody. Earlier entries below keep the old name: they are
history, and history happened under it.

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
| npm publish (`npx standing-orders`) | **done** — 2026-08-13 | published as `standing-orders@0.1.0`; see the M4 operator-publish row |

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
| Twelve-task E2E | **done** | unattended.test.ts — one fake-clocked night against real git, built-in backend only (stated; external dispatch deferred): clean builds, honest no-change, a park answered mid-night via `decide`, three strikes → attempts-exhausted → authenticated requeue → built, a timeout that backs off and recovers, a dependency chain, a scope approved while the night runs, duplicate empty passes refusing idempotently; the zero-token invariant asserted as arithmetic (provider spawns == stamped runs, exactly); eleven publications pushed and opened against scripted gh; the brief telling the same story from the same rows (12 built, no decisions, no incidents, nothing stranded) |
| Packaging (Node >=22.13 floor) | **done** | engines `>=22.13.0` (node:sqlite's floor — publishing `>=20` would ship a runtime that cannot open its own database); `files` allowlist ships dist + README + LICENSE + manifest only; LICENSE (MIT) added; the published build strips source maps (tsconfig.build.json); version 0.1.0; `npm pack --dry-run --json` inspected — 69 files, ~250KB, no tests, no maps, no databases, no evidence, no tokens; the exact tarball installed `--offline` in a clean temp project and its bin ran discovery and opened a database on Node v22.22 (the 22.13 exact-minimum run is noted as not yet performed — no such runtime on this machine) |
| Operator publish + registry verify + tag `m4` | **done** — 2026-08-13 | Alex ran `npm publish` (with the 2FA the registry demanded). The first attempt was refused and thereby caught a shipping bug: npm's normalizer silently deletes a `./`-prefixed bin path, which would have published a package `npx` could not invoke — fixed in `e0a75c3` before anything reached the registry. Verified after: `npm view standing-orders` shows 0.1.0 with `bin = { 'standing-orders': 'dist/cli.js' }`, and a cold `npx -y standing-orders@0.1.0 --help` from the registry in a scratch directory with its own npm cache printed the real usage screen. `git tag m4` follows this verification, in this same commit's push |

## M5 — foundations + see the work (2026-08-13, the competitive round: two research passes + Codex review; scratchpad roadmap-m5-final.md + codex-roadmap-findings.md ARE the spec)

The strategy Codex endorsed: the field optimizes live steering; unattended
with phone check-ins is the blind spot and we hold six of its seven
requirements. Close the see-the-work table stakes, surface what is already
recorded, keep every invariant. Notable rulings absorbed: reportsCost stays
claude-only (tokens are not dollars — flipping it would fake a dollar
ceiling); merge-when-green is out (a standing grant cannot make a merge
reversible, and the plane executing merges would end PR-as-terminus) —
replaced by a read-only review queue; the v1 diff is the immutable terminal
diff, because during the agent turn HEAD must equal base by design.

| Item | State | Proof |
|---|---|---|
| Envelope contract — one versioned machine shape | **done** | src/envelope.ts: `envelopeJson` stamps `envelopeVersion` 1 ahead of `ok`/`command`; all ~35 emission sites in operate.ts + cli.ts route through it (the sed left zero `JSON.stringify({ ok` — enforced by a source-rule test); scan/pulls/graph joined the envelope (pulls' bare array and graph's naked object were pre-1.0 wire breaks taken deliberately, empty-repo cases now fail as `no-repositories` instead of printing `[]`); `standing-orders contract` states the version + bounded capability tokens (envelope/1, stable-reasons, idempotency-keys, exit-codes/0-1-2-3, output-file), consumers told to ignore unknowns; `-o <file>` at the entry point tees the captured envelope to a file (requires --json, refused as usage otherwise) so an agent reads its answer from a path, not scrollback; envelope.test.ts (8) sweeps success/failure envelopes across eight subsystems |
| Provider audit + init-failure gating | **done** | provider.ts `auditOf`: per-provider facts — transport, resume support, init signal, the hermetic flag we deliberately do NOT pass (`--ephemeral` breaks resume and the audit says so; `--bare`'s resume interplay marked unvalidated), and the user-global config surface that can reach an unattended run; `enforced: false` is a literal — REPORT BEFORE ENFORCEMENT, per the Codex ruling. `providers` renders it (transport/resume/isolation/config surface) and carries it in the envelope. Init gating: ParsedEnvelope.initObserved (codex: thread.started seen; claude buffered: null — absence proves nothing and is never flagged), invokeAgent.initFailed only when the init signal exists, was not seen, AND the turn has nothing to show (a renamed event on a working turn must not read as broken; timeout/notFound excluded), builder + repair + planner return typed `provider-init`, classified retryable-infra — a broken environment never counts as three strikes of bad agent work. invoke.test.ts +4, provider.test.ts +2 |
| Immutable terminal diff per run | **done** | schema v11 (artifact.kind admits 'terminal-diff' + 'diff-stat', same recognized-exactly CHECK-widening recipe as v7); evidence.ts `captureTerminalDiff` — the exact base→accepted-head patch captured while the worktree still exists, under the park capture's execution posture (--no-ext-diff --no-textconv --no-color, bounded bytes, hash, capture command + exit recorded; a failed capture stores the failure); `parseNumstat` reads `--numstat -z` NUL-delimited — filenames never guessed from patch headers, binary counts null never zero, renames carried, file list bounded at 400 with counts complete; a no-change run stores the EXPLICIT zero (base against base) because "no artifact" must never be how no-change reads; run page leads with the stat + capture-health card (base→head named, empty/failed/truncated visibly distinct) and folds the bounded patch under &lt;details&gt; with a raw-artifact link — no JS, no per-file endpoints, no nonce. Bycatch: the builder test harness's empty-string worktree was landing handoff files in the process cwd — the repo-root protocol-file museum finally explained; per-test worktrees now, debris swept |
| Machine-phase activity chip | **done** | run.phase (v11 additive), a CLOSED four-value vocabulary the control plane stamps at its own state-machine boundaries — agent-running / validating-handoff / capturing-evidence / committing — never parsed from a provider stream (the Codex slice: machine phases first, normalized provider events later, post-audit). setRunPhase refuses unknown values and leaves a finished run's phase as history; building cards wear the phase in plain words ("agent working", "checking the handoff") via the board's EXISTING refresh — zero new polling, zero provider invocations, unknown values from a newer daemon show nothing rather than raw tokens; run pages show phase only while open. Bounded writes by construction: four values, each boundary passed once |
| Evidence-first screens + attempt ledger | **done** | task page reordered: decisions and incidents (what needs you), then the attempt ledger — every run with provider, duration, tokens, dollars-or-"unmeasured $", repair parentage — then spend, THEN the mechanics (scope, holds, acts). A retry storm now reads as the spike it is instead of hiding in a total. Only trustworthy facts moved up; the agent's conclusion stays labeled the agent's, on the run page, last |
| Cost surfaced honestly (tokens ≠ dollars) | **done** | spend-by-provider card on the task page (dollars only where measured; "dollar cost unmeasured" and "$X across M/N measured" as first-class states — never a fabricated $0); run page cost fact says "dollar cost unmeasured — this provider reports tokens, not prices" instead of hiding the row; /runs rows carry non-claude provider + "unmeasured $". reportsCost stays claude-only per the Codex ruling — routines keep failing closed on unmeasured providers |
| Per-repo approved worktree setup | **done** | the table stake every rival worktree tool fumbled at launch. worktree_setup (v11): one live row per repo enforced by a partial unique index, command TEXT stored (secret values never), digest bound over repo+command+timeout, revoked-not-deleted. `standing-orders setup set` restates the exact terms and refuses without --yes; set/clear take the approver credential (an approved command runs unattended in every future worktree — that is authority); commands with control/bidi characters refused. Enforcement in the builder after every refusal gate, BEFORE any agent spawn: /bin/sh -c under the setup's own timeout with the agent's scrubbed environment (an approved `npm ci` is not an approved read of the bot token); failure returns typed `setup` → retryable-infra, and the agent never spawns in a checkout whose setup failed; success stamps worktree.setup_digest so one digest never runs twice in one checkout. Deferred, named: lockfile-keyed cache invalidation, Windows shell |

## M6 — steer from review (2026-08-13, same Codex-reviewed roadmap as M5; the findings file is the spec)

| Item | State | Proof |
|---|---|---|
| Diff comments → revision briefs | **done** | Vibe Kanban's one great feature, rebuilt ceremony-preserving. diff_comment (v11b): comments bind to the IMMUTABLE terminal diff — artifact id AND its sha (words on exact bytes), path/line optional, note through the shared validator, immutable with supersede + consumed columns; addDiffComment refuses any artifact that is not that run's terminal diff. "Turn N comments into a revision task" seals the live batch deterministically: ONE unapproved built-in task (createConsoleTask — original goal carried, repo placed before scope per the placeTask guard), an immutable revision-brief artifact on the SOURCE run, task_ref.revision_of + revision_brief_artifact stamped, comments consumed by task id in the same store call so a second click 400s instead of minting a duplicate. EVERY revision requires its own approval (comments can semantically widen work; no path check can prove they did not; an LLM deciding would be an LLM in an approval path) — the task screen restates the batch beside the approval form, read back through the VERIFIED artifact path, unverifiable briefs a named problem. The builder quotes the brief fenced, after the scope, before the rules: "a comment cannot widen the scope, and if one seems to, park and say so". No live chat into a running agent — steering stays queue-shaped |
| Session registry + narrow warm resume | **done** | 6a: the session id is stamped the MOMENT the stream announces it (exec onSessionId on thread.started → stampRun first-write-wins, set by the invocation gateway) — a daemon that dies mid-turn no longer loses the id it paid for; structured facts only, never a stored resume command (argv derives through the adapter, per the Codex ruling). 6b: warm resume ONLY when everything re-proves at build time — same task/provider/branch via the candidate query, no newer accepted build (superseded parks resume nothing), answers actually attached, and the branch still at the parked run's EXACT base: a moved base means the session's memory is stale, and a cold start is honest where a stale resume lies about the present. parent_run stamped before the spawn — causal parentage whatever happens next. 6c, adapted honestly: no typed session-absent signal exists yet, so instead of prose-sniffing stderr the rule is ONE warm try per park (`tried` = any builder child exists) — a dead session costs one strike, and the second attempt goes cold carrying the same answers; never three resume failures into a stall. Dirty-WIP resume stays deferred with the custody design named |
| Freshness-stamped handoff artifacts | **done** | artifact kind 'handoff' (v11b widening — recognizes both the pre-v11 shape and a database that opened at v11 earlier the same day; 'revision-brief' pre-provisioned in the same rebuild); storeHandoffArtifact writes the machine's own statement of where a finished run left the world: workspace/branch identity, exact base and head, provider + session id, decision ids the brief actually carried (causal, from run_decision), the agent's conclusion positioned as agent-reported, and a freshness stamp (currentAsOf = the accepted head) a successor PROVES against the branch before spending a token — a provider session is memory, not a freshness proof (the research's 42–63% handoff saving belongs to context-bearing handoffs, and this is the context). Written for built and no-change runs beside the terminal diff; parked runs already hand off through the mailbox |
| Operator note + honest requeue label | **done** — late entry, shipped in 8dbdbba | run_note (v11 additive): immutable, bounded by the decision-note validator (500u/2000B, control/bidi refused), ordinary authenticated mutation with CSRF — NO nonce, nothing here approves anything; ceiling-checked like every run resource; rendered beside the machine's record. The requeue act now says what it keeps: "retry — branch and workspace kept", because runs and evidence are audit history and nothing destructive hides behind one tap. Fresh-retry-from-clean-base stays a future designed workflow with branch generations, per the Codex cut |
| Deterministic hard stop | **done** — late entry, shipped in 719f2d0 | providers spawn detached in their own process group, set by the invocation gateway and nowhere else; the streaming AND buffered transports both register live providers and both kill the GROUP on timeout (the execFile path detours through spawn when a group is required, same contract: output caps, overflow≠timeout, ENOENT). Watch: first signal graceful + starts --stop-grace (default 30s); expiry or a second signal SIGKILLs every live group via terminateLiveProviders. Runs finalize as failures, worktrees preserved, fences keep late output out of commits. The test spawns a grandchild and proves the corpse: kill(pid, 0) must throw |

## The M5–M8 post-build audit (2026-08-13, Codex: 0 critical, 6 high IV, 10 bugs, 6 deviations, 10 test gaps — scratchpad codex-m5m8-audit.md is the full report)

**Fixed this pass** (audit ids): IV-2 revisions and CI repairs INHERIT the
source scope's outOfScope and touches (createConsoleTask takes a full
scope draft; the approval screen stops claiming "no exclusions" over work
that had them). IV-3 revision approval FAILS CLOSED: no nonce and no
approve form over a brief that does not verify, the POST re-proves the
brief at the moment of the yes, briefs are size-checked BEFORE any task
exists (structured JSON is never byte-truncated), and the builder refuses
typed `revision-brief` instead of silently building comment-free. C-3
sealing is ONE transaction (store.sealRevision: task + artifact + relation
+ exactly the expected comment batch or rollback; the brief file is
written first under a nonce name — an orphan file is not authority). IV-4
the planner brief fences its inputs (inert(): controls collapse, protocol
prefixes break, fences cannot terminate — GitHub issue titles reach the
planner as quoted data). IV-5 partial: setup runs under an extended
denylist, setup stderr is REDACTED and bounded before touching SQLite or
the outbox, and `setup set` refuses credential-shaped commands (a `$VAR`
reference passes; a literal value does not). IV-6 Windows kills the tree
via taskkill /T /F (stated untested on physical Windows, like the
daemon). IV-8 `-o` writes 0600, never through a symlink or onto a
non-regular file. IV-9 PR bodies neutralize agent text (inline prose
flattens newlines; conclusions ride INDENTED, which no backtick can
terminate; template v2). IV-10 comments, seals, and PR-comment ingestion
all VERIFY the diff bytes before words attach to them. IV-11 only an
https github.com pull URL earns an anchor. C-1 watch --json sends every
progress line to stderr — stdout is one envelope. C-2 CI episodes are
keyed repo+PR+head (PR #55 in repo A can no longer light repo B's repair
button); repair briefs bind the OBSERVED failing head and its observation
time, never the click. C-6 merged/closed PRs leave the watch and the
review queue (publication.remote_state, additive). C-5 pr-comments
requires publication.githubRepo === grant.github, paginates, validates
the array, matches logins case-insensitively. C-7 deterministic ids
truncate the prefix, never the identity-bearing suffix. C-8 initFailed
requires finalMessage === null — a failed turn WITH words is an agent
failure. C-9 source_key races land in ON CONFLICT DO NOTHING. C-10 skills
ownership = exact header + mark; damaged AGENTS.md blocks refuse typed
instead of false-success. IV-1 partial: Context.shouldStop fences routine
fires and every claim admission mid-pass, and a stopping watch publishes
nothing more. Tests: +IV-2/IV-3 revision integrity E2E, +same-day-v11
migration fixture (the exact e2a08c5 shape), +C-8 nonzero-with-message.

**Deferrals closed in the follow-up pass (840 tests)**: IV-1 COMPLETED —
the stop fence rides into the builder (BuildRequest.shouldStop) and is
re-proved at the LAST gate before the commit: an operator's stop beats an
agent's finish, the work stays uncommitted and preserved; typed `stopped`
→ retryable-infra; tick test proves a fenced pass admits nothing and
spawns nothing. IV-7 COMPLETED — high-confidence secret scan (private-key
PEM, AKIA, gh tokens, slack, npm _authToken, sk- keys; deliberately NO
generic password= shapes — a detector that cries wolf trains people to
approve wolves) runs on every terminal diff: hit lines are redacted in
the stored artifact, the row says redacted, a page names the branch, and
publishPass REFUSES to push a redacted run — the branch holds the real
bytes and a person rewrites it. IV-5 COMPLETED — setup shells run under
an explicit ALLOWLIST (PATH/HOME/locale/temp; exec gains envAllowlist,
resolved in one place), the terms restate it. SD-2 COMPLETED — the
handoff is finally CONSUMED: cold successors read the latest handoff
verified, and include it ONLY when freshness proves (same branch, branch
exactly at the stamped head) — stale context is omitted because context
spent as stale truth costs more than none; warm resumes skip it, the
session remembers better than a summary of itself. SD-4 CORE —
publications persist the last OBSERVED check state + time; /review ranks
observed-passing → silence (labeled as silence) → failing, and "review
next" goes only to an observed pass. SD-5 partial — the task page carries
its publication line (PR, local+remote state, observed CI). TG-1-lite,
secret-scan, and observed-ranking tests added.

**TG-3 CLOSED (2026-08-13, prioritized as the top remaining deferral —
the machine contract is the spine of agent usability, and it is the gap
C-1 escaped through)**: the full envelope sweep — every routed command
invoked with --json (successes, refusals, and usage failures alike,
because an agent's parser meets all three) and proven to answer with
EXACTLY one versioned envelope; a drift guard reads OPERATE_COMMANDS
from source, so a new command cannot ship without joining the sweep or
being exempted by name. The sweep earned its keep on its first run:
`ready --json` on an empty queue answered ok:false with NO stable reason
token (fixed: reason "empty"), and `repos` ignored --json entirely and
printed prose (fixed: enveloped across list/add/remove). serve is swept
through its throwing path — the catch-all envelopes it, which is itself
part of the contract now proven.

**Still deferred, named**: SD-1 comment side/context + supersede-on-edit
(schema + UI round). SD-3 repo+runner setup scoping (authority-model
change). SD-6 intake selector/mutation classes (ditto). SD-4 dependency/
conflict ordering (needs mergeability observation). TG-1's
subprocess-level signal tests, remaining TG matrices. Windows:
code-complete, physically untested — as the README already says.

## M7 — agent citizenship · M8 — the outer loop (2026-08-13, same roadmap)

| Item | State | Proof |
|---|---|---|
| `skills install` | **done** | src/skills.ts + `standing-orders skills install`: writes the Agent Skills entry (.claude/skills/standing-orders/SKILL.md — the cross-vendor layout claude/codex/gemini/opencode all read) whose description is the routing contract (use for queue/status/briefs; NOT for pushing, merging, approving) and whose body carries the machine contract (envelope, stable reasons, exit-code quartet, idempotency keys, -o file, untrusted-output hygiene) while deferring to live --help as authoritative — a skill that duplicates the manual drifts from it. Preview by default (exit 3, nothing written), --yes to apply, --repo to aim, --write-context for the AGENTS.md managed block (marker-fenced, replaced only between its own markers, host prose never rewritten; without the flag the snippet prints for the operator to place). A skill file the installer did not write is REFUSED, never eaten. skills.test.ts (7) |
| Hook packs | **deferred, named** | shippable Stop/TaskCompleted hook configs would have foreign agent sessions REPORTING INTO the queue — an ingestion surface for unauthenticated writes that needs its own identity/review round, exactly like acting-from-Slack did. Not smuggled in as config files |
| MCP facade | deferred (roadmap ruling) | thin wrapper over the same envelope if demand shows; CLIs + skills won the local-tool layer |
| GitHub issue intake, preview-first | **done** | `standing-orders intake`: an explicit grant (intake_grant, one live row per repo, authenticated + terms restated before --yes) binds the exact GitHub repo AND label — detection is not authorization, and 400 open issues are not volunteered by enrolling. `preview` lists candidates read-only; `run` creates LOCAL UNAPPROVED proposals with deterministic ids (ghi-owner-name-N — existence IS the dedupe, a second run is a no-op), each awaiting its own scope approval. Issue titles are untrusted: control/bidi disguises REFUSE the candidate (new shared hasDisguisedText — also upgraded the setup command), and the issue BODY is never imported at all — the proposal links to GitHub where a person reads it. Nothing remote is ever written; external-backend dispatch remains unshipped and the command does not pretend otherwise. gh is reachable only under a grant, injected in tests |
| PR review-comment intake | **done** | `intake pr-comments`: own PRs ONLY (the publication table is the list of ours), reviewers named in the grant only (a grant without reviewers keeps this off — refused typed), the GitHub comment id the idempotency key (diff_comment.source_key, v11c, unique where present — a second pass reports duplicates, ingests nothing), every body through the shared validator (control/bidi refuse), paths disguise-checked, authorship recorded as github:<login>. Ingested comments land as ordinary diff comments bound to the run's terminal diff — they wait on the run page for the SAME one-tap seal and the SAME scope approval as comments typed in the console; no comment authorizes a spawn |
| CI-repair, suggestion-first | **done** | a red episode never spawns an agent — it EARNS a button. The run page shows "draft a repair task" only while an OBSERVED failing episode is open on that run's PR; the button creates ONE unapproved task through the revision machinery (deterministic id <task>-ci-<pr> — the second click is a 409, not a twin), brief carries pr/head/observedAt and deliberately NO log content ("read the failing checks on GitHub before approving") because external logs are injection-capable and failing-check retrieval is a later, named slice. Autonomous repair stays behind a future digest-bound standing term |
| Review-backpressure queue | **done** | /review, READ-ONLY: every open PR this plane published (ceiling-checked), reviewable-first then oldest, the top one marked "review next"; CI honesty preserved — an open episode reads "CI failing — observed", absence reads "no failing observation (the machine never calls silence green — verify on GitHub)"; deep links to the PR and the build; NOT ONE form on the page, because merge-when-green was ruled out (irreversible-never-auto-applies + PR-as-terminus) and the person merges on GitHub. The field's loudest skeptic refrain — the bottleneck is review, not parallelism — answered with the page that compresses review |

## The primary messenger (2026-08-13, the operator's ask: "ask which service… allow selection of primary")

Exactly ONE service carries the pages. `effectivePrimary` resolves it:
the explicit choice when its service is actually configured (a primary
pointing at nothing falls through rather than silencing every page),
else Telegram when present (it can hold buttons), else the sole mirror —
and the `implicit` flag is what every surface uses to say "several are
set up and none was chosen". The ASK happens at the moment multiplicity
first appears: `webhook set` adding a second service prompts
interactively (non-interactive prints the command instead), and the
console settings screen gains a "who pages you" radio — configured
services only, POSTed behind authorizeMutation, written to the same
0600 file the CLI writes. Telegram keeps draining taps and replies even
when another service pages (`deliver:false` threads through bridgePass
AND the embedded follower): answering is its job whether or not paging
is. Non-primary services stay silent — nothing pages twice. 793 tests.

## Slack and Discord, UI-only (2026-08-13, the operator's scoping — "can be ui only")

Chat mirrors, deliberately one-way: every page becomes a message with a
deep link into the console (decisions to their screen, everything else to
/next), and the ACTING stays in the console behind its own
authentication and step-ups. No bot, no pairing, no inbound events — an
outbound webhook is not an authentication surface, which is exactly what
made this cheap; the day acting-from-Slack is wanted it gets the Telegram
treatment (its own review, its own identity model), never a shortcut
through this module. Webhook URLs are CREDENTIALS: shape-checked, 0600
files beside the database or environment variables, never a column,
never in an error (a failure names the platform and status only —
proven). Delivery rides the SAME claim/finalize discipline as every
deliverer, so a mirror and a bridge can never both own one row; mirrors
deliver when Telegram is not configured, and stay quiet when a paired
chat (which can carry buttons) does the paging. `nightorders webhook
set slack|discord|console-url · status · test · clear`; the watch loop
mirrors on the bridge cadence. Node 22's global fetch — still zero
runtime deps. 792 tests.

## Free-text answers from Telegram (2026-08-13, Codex security review: verdict "safe with conditions" — the conditions ARE the build)

Reply to a decision message with prose and it becomes the answer's NOTE;
choosing stays TAP-ONLY forever (finding 2: mapping prose to an option is
never safe). The reply is accepted only as an authenticated thread: live
binding, private chat, exact chat AND user ids, a reply_to that maps
through the new outbound-message→decision table (every sent part
recorded; a lost record fails closed — never routed by recency), the
decision still unanswered, and direct initial plain text — forwards,
media, captions, bots, edits, and channel identities are silence, and so
is everything else wrong (a correction is an oracle). The note passes ONE
shared validator (500 units / 2000 bytes / controls AND bidi-invisibles
refused) before persisting as an IMMUTABLE, expiring draft — one live per
decision, superseded only by a GREATER update_id — and the bot echoes the
exact captured text back, line-prefixed, so editing the original message
cannot rewrite the audit. A tap consumes the live draft WITH the answer
in one transaction; duplicate success now requires the whole tuple
(choice AND note — a racing web answer without the note is
already-answered, never a silent success, finding 4); an EXPIRED draft
never silently drops (the tap is refused once, token unconsumed, and says
so). Irreversible confirms bind the note's digest: the challenge displays
the note it would travel with, and a newer note, expiry, or cancel
strands the armed yes (finding 3). The agent-facing fence now collapses
Unicode line separators, breaks quoted NIGHTORDERS- prefixes visibly, and
a trusted rule bounds the note to refining the CHOSEN option — never
choosing, widening, or overriding (finding 5). Schema v10. 789 tests.

## The unblock-first push (2026-08-13, Alex's three criteria; five phases)

Criteria: simple to understand and action · accelerates the work · keeps
the operator unblocking and creating. Phase A ships **/next — the triage
flow**: everything waiting on a person, ONE card at a time, hardest-
blocked first (oldest question → plans/scopes to approve → stalled work
to retry → requirement gaps), full context on the card (recap + question
with the answer buttons inline; the restated scope and plan document with
the password step-up inline — the nonce may mint here because the card
restates the digest-bound terms, the same rule as the task screen), and
every act 303s back to /next: clearing four items is four acts, not four
navigations. "Not now" is a bounded URL cursor (never session state — two
tabs cannot fight, a shared link shows the same queue) and the all-clear
remembers what was set aside. The decision answer forms were extracted to
ONE builder shared by /d and /next; return paths stay allow-listed. The
inbox offers "clear the queue →" only when something waits. Phases B–E
followed the same day — ALL FIVE SHIPPED. **B, the roll-up inbox**
(Codex pre-implementation review: 13 findings, its prescriptions built
exactly): with no project open, `/` is the overall inbox — every store
read either binds a repo-list admission BEFORE its LIMIT or returns
unbounded with the row's repo projected, serve re-proves every row with
rowVisible, the badge's union admits inside every branch (and gained the
cancelled-blocker branch it silently omitted), the cancelled-blocker
aggregate joins BOTH refs so a cross-project edge cannot leak a foreign
project's cancelled state, roll-up rows are LINKS ONLY (no forms, no
nonces, no capture), unplaced work wears an explicit chip, and the
needsProject exemption is exact-path `/`. **C**: below 40rem the board
stacks needs-you → building → queued → waiting. **D**: "since you last
looked" on the board — built/failed/asked since this session's previous
full read, fragment polls never move the anchor. **E**: quick capture on
the project inbox — title + goal straight to the approve step-up, two
steps, through the same guarded handler. 786 tests.

## Providers + phase configuration (2026-08-13, Codex plan review: 1 crit, 6 high — its prescriptions ARE the spec)

Three harnesses behind the one door. `provider.ts` is the only module that
may name a binary: **claude** (dialect unchanged, byte-identical, the
whole suite proves it), **codex** (`exec --json`, sandbox
workspace-write, resume as a subcommand, `login status` as the one cheap
identity probe; wall clocks clamped below claude's because codex has no
turn bound), and **openrouter** — the codex harness pointed at OpenRouter
through constant `-c` overrides (keys never caller-supplied, values
TOML-quoted, model ids validated against an argv-safe charset that still
admits `/ . : -`), the API key read from the runner's environment and
EXCLUDED from every shell the model itself launches. Codex JSONL rides a
new streaming transport retaining only load-bearing lines — the buffered
runner would overflow at 8 MiB and lose the terminal usage of a paid run.
`invokeAgent` takes a semantic request, refuses a run opened for a
different provider (repair inherits its parent structurally — a session
resumed across harnesses is not a session), and quota is keyed to the
resolved provider. The architecture rule reads IMPORTS, not string
literals. Schema v9: `run.provider` across all three canonical shapes
(default 'claude' — truthful history), the task agent pin, `phase_config`.

**Configuration**, layered and stated: pinned task agent (nothing
overrides it) > pass flags (`--provider/--model`,
`--plan-provider/--plan-model`, `--repair-model`; per-field — `--model`
rides the resolved provider, `--provider` runs its own default) > project
override > installation > default. Config rows live IN THE DATABASE as
complete pairs, written only by authenticated, audited verbs
(`nightorders config set/clear … --as --token`) — spend routing is
authority, and a 0600 file under the agents' own UID is not a boundary.
Routine firings resolve the instance agent inside the fire transaction
and PIN it (the review's critical finding: approved-terms firings must
not be re-routed by later flags), and a cost ceiling against a provider
that reports no dollars skips the slot with a page instead of deadlocking
on the second firing. `nightorders providers` keeps four claims apart:
installed / configured / historically successful / currently
authenticated (codex only — claude has no non-spending probe, and the
report says so; an OpenRouter key's presence "is not authorization").
Codex/openrouter runs land honestly UNMEASURED in dollars.

Deferred, named: an explicit digest-bound `agent` term on routine
templates (the fire-time pin already carries the safety; the term adds
the operator's explicit choice at approval), console surfacing of
provider/config state (system page card, board provider chips), per-task
one-off override, an agent-reviewer role (its own design round). 777
tests.

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
where they surface wearing the routine's name.

A post-build Codex review of the implementation (0 critical, 2 high, 4
medium, 1 low; migration and XSS declared clean) drove a hardening round,
each with a regression test: the fire AND approval transactions re-derive
the digest from the stored terms rather than trusting the column (H1 — a
store caller smuggling edited terms under the approved digest fires
nothing); a live claim blocks single-flight regardless of the task's
state string (H2 — `task state <id> done` over a running build cannot
conjure a twin); manual firings take their own `manual:` ledger identity
and a stale scheduled pointer heals by advancing (M1 — run-now on the
exact due instant can no longer strand the schedule); the budget window
anchors to `provider_started_at`, the stamp money actually moves on (M2);
console run-now is a password step-up like approval — spend outside the
schedule re-proves the approver secret (M3); `singleFlight: false` is
refused at validation so the ceremony's "one at a time" is always true
(M4); and blocked-track pages are episodes — an open one never nags
twice, a recurrence after recovery pages again (L1). 757 tests.

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
markers (`NIGHTORDERS-*`), and `unattended.test.ts` deliberately keep their
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
