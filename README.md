<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ap9000/standing-orders/main/docs/media/wordmark-dark.svg">
  <img src="https://raw.githubusercontent.com/ap9000/standing-orders/main/docs/media/wordmark-light.svg" alt="standing·orders — a control plane for unattended coding agents" width="480">
</picture>

**Queue twelve tasks, walk away, come back to pull requests —
interrupted only for decisions that genuinely need a human.**

[![CI](https://github.com/ap9000/standing-orders/actions/workflows/ci.yml/badge.svg)](https://github.com/ap9000/standing-orders/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/standing-orders)](https://www.npmjs.com/package/standing-orders)
![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-brightgreen)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-blue)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Design](docs/DESIGN.md) · [Never Stuck contract](docs/NEVER_STUCK.md) · [Priorities](docs/PRIORITIES.md) · [Ledger](docs/PROGRESS.md) · [Contributing](CONTRIBUTING.md) · [Issues](https://github.com/ap9000/standing-orders/issues) · [npm](https://www.npmjs.com/package/standing-orders)

<img src="https://raw.githubusercontent.com/ap9000/standing-orders/main/docs/media/ui/unified-chat.png" alt="Standing Orders unified chat showing a live portfolio overview across projects, active builds, decisions, and proposed next actions." width="920">

<sub>One conversation across every project, backed by durable tasks—not a chat-only copy of the work.</sub>

</div>

## One command center, the whole loop

Tell Standing Orders what outcome you want. Its planner reads the repository,
drafts the scope and proof rubric, and asks only when an answer would materially
change the work. You approve the exact contract once; long-running agents can
build, review, and repair it while the control plane handles queues, dependencies,
crashes, and decisions. The result comes back with the diff, checks, screenshots,
and a criterion-by-criterion verdict.

### Hand off in one prompt; approve exactly what will run

Project and quality stay close to the prompt; expert fields appear only when
you open them. Before execution, the approval card restates the goal,
boundaries, evidence requirements, model, and permissions.

<div align="center">
  <img src="https://raw.githubusercontent.com/ap9000/standing-orders/main/docs/media/ui/task-handoff-mobile.png" alt="Mobile chat-first task composer with one outcome prompt and progressive details." width="260">
  &nbsp;
  <img src="https://raw.githubusercontent.com/ap9000/standing-orders/main/docs/media/ui/scope-approval.png" alt="Desktop scope approval card showing the goal, boundaries, evidence requirement, model, permissions, and approval action." width="640">
</div>

### What is in the current build

- **Unified portfolio chat.** Read every project, prioritize queues, answer
  decisions, repair failed or cancelled dependencies, and confirm rich action
  cards from one conversation. The chat proposes; durable workflow state
  remains the source of truth.
- **Chat-first task handoff.** The default form is one outcome prompt. The
  repository-aware planner drafts the goal, boundaries, acceptance criteria,
  likely files, and a concise execution plan with milestones, dependencies,
  risks, and proof. Review or refine that plan before starting; approval locks
  the exact revision the builder receives. Expert controls remain under
  **Edit details**.
- **A plan that adapts without quietly widening what you signed.** While a
  build runs, it checkpoints which milestone is pending, in progress, done,
  or blocked — reported by the agent, never counted as completion proof. When
  the repository shows a stated dependency, risk, or approach was wrong, the
  builder can file one evidence-linked replacement plan and pause at a safe
  point. A plan-only refinement appends an immutable revision and resumes on
  its own; anything that would touch the goal, boundaries, touches,
  acceptance, permissions, quality, budget, or publication authority stays
  paused for your accept or reject. The task page and focused chat always
  show the same live progress, the same revision, and the same pending
  decision.
- **Structured handoffs repair their shape, not their meaning.** A malformed
  planner or reviewer reply gets conservative syntax normalization, then at
  most two correction turns in the same session with the exact validation
  errors. Corrections cannot invent scope or criteria; every reply is sealed
  for audit, including replies rejected by provider or session checks, and
  workspace or review-input integrity is re-proved
  after each turn.
- **Long-running, recoverable execution.** There is no arbitrary task
  countdown. Installed workers survive terminal closure and reboot, recover
  expired claims, and continue until a terminal result, a real decision, or a
  signed no-progress/runaway breaker.
- **Subscription-native agents.** Use the Codex and Claude logins already on
  the machine. Dollar caps are optional; subscription usage is labeled as an
  API-price equivalent, never presented as an API charge.
- **Per-task autonomy with a global default.** Choose **Auto** or **Full
  access** for the installation, then override it on any task. The exact
  provider permission mode is sealed into the approved scope.
- **Two quality paths.** **Default** returns deterministic proof quickly.
  **Strict / release** adds isolated semantic review and a bounded repair loop
  without silently widening scope or authority.
- **Evidence-backed completion.** Every signed criterion resolves to checks,
  changed paths, screenshots, or manual review. Missing or contradictory proof
  says **needs verification** instead of pretending the task is done.

<div align="center">
  <img src="https://raw.githubusercontent.com/ap9000/standing-orders/main/docs/media/ui/verified-result.png" alt="A verified Standing Orders result card with checks, follow-up notes, and evidence-backed completion details." width="720">
  <br>
  <sub>Completion is a proof bundle and a closed verdict—not an agent saying “done.”</sub>
</div>

## Install

Choose your projects folder the first time:

```sh
npx standing-orders up --project-root ~/Projects    # or: bunx standing-orders up
```

That is the install and the setup. It needs Node 22.13 or newer on the
machine (Bun's runtime has no `node:sqlite`; `bunx` hands the shebang to
Node, so it works too). `npm install -g standing-orders` gives you the
bare `standing-orders` command for later.

`up` prints your login once (and saves it beside the database as
`up-login.txt`), opens the app in your browser, and connects this machine as
the builder. Add an existing folder or a GitHub repository from **Projects**;
the builder and unified chat pick it up while the app keeps running. The
projects folder and every added repository are remembered. Later,
`standing-orders up` can be run from any directory and reconnects all of them.

To reach it from your phone over a tailnet:
`standing-orders up --host 0.0.0.0 --allow-host <your-machine>.ts.net:4180`.

If the inbox says **Builder disconnected**, reopen Standing Orders on the
machine where the projects live; queued work resumes automatically. You do not
run `up` separately in each project.

Advanced deployments can start the console alone with
`standing-orders serve --repo .`: with no account yet it
prints a six-digit setup code, and the login page offers **create the
first account** — enter the code, pick a username and password, and you are
in. A second person joins by invite link from the people page, never by
another setup code.

```sh
npx standing-orders demo               # a seeded sandbox — see it working in 90 seconds, zero spend
npx standing-orders                    # what's in flight across your repos — read-only, zero config
```

## Getting started

There is one normal road: keep one `standing-orders up` running on the machine.
It is the app and the builder for every saved project. The separate console,
worker, and OS service commands documented later are advanced deployment tools
for people splitting those parts across machines.

### In the console

1. **Sign in** with the login `up` printed. You land on the **inbox**:
   everything that waits on you, and nothing else.
2. **Describe the outcome** with **+ new task**. The normal path is one
   ChatGPT-style prompt: the planner inspects the open repository, drafts the
   goal, boundaries, acceptance rubric, and implementation approach, then asks
   only when a missing answer would materially change the work. Project and
   quality stay in the compact footer; **Edit details** reveals the full
   contract, research-only mode, permissions, dependencies, and expert fields.
3. **Review and approve the proposed scope.** A scope needs at least one
   criterion — a plain outcome statement and the evidence kind (check,
   screenshot, changed-path, or manual review) that will answer it — before it
   can be signed. The task page leads with a concise approval card; the full
   structured, editable execution plan and full contract remain one click
   away. It restates the exact scope AND rubric you are signing, the provider
   and model it will run on, and your password. Nothing spends a token until
   this yes.
4. **Watch it build.** The **board** moves the card to *building*; the
   card's own page shows the stage, the live transcript, and — once the
   agent checkpoints one — which milestone is pending, in progress, done,
   or blocked; **peek** (`/peek`, or *peek at the live ones →* on the builds
   page) shows every live agent at once. If the repository disproves a
   named dependency or risk, the task page shows the replacement plan with
   its evidence; a plan-only fix resumes on its own, while anything that
   would touch what you signed waits for your accept or reject, right
   there next to the plan.
5. **Answer when asked.** An agent that hits a judgement call parks a typed
   decision — question, options, consequences, which are reversible. It
   arrives in the inbox, on `/next`, and on your phone if Telegram is
   paired; one tap answers it and the build resumes.
6. **Collect the result.** A build lands in *done recently* with its diff,
   its evidence bundle — a matrix answering your signed rubric by exact
   criterion id, pass/missing/failed/manual-review, checks, screenshots
   for UI-facing work — and a closed verdict: *verified* when the repository's
   approved verification command passed, *attested* when none is
   configured and nothing contradicts the proof, *missing evidence* when
   a requirement lacks support, or *conflicting evidence* when an independent
   check contradicts the result. Neither
   state hides the work — the branch and diff stay reviewable, and you can
   accept with a recorded exception after reviewing it. A scout's report lands on its task page with follow-ups you can
   file in one tap. Publishing to a branch and a pull request happens only
   under a publication grant whose terms you approved on the **system**
   page.

   Verification can recover one common environment failure without hiding it.
   Run `standing-orders verify set ... --self-heal` without `--yes` first. The
   preview shows the exact approved setup and its digest; confirm only that
   preview by rerunning with `--setup-digest <shown> --yes`. If the project
   check cannot start because a required project executable is missing,
   Standing Orders may run that setup once and retry the exact check once. It
   does not recover ordinary test failures, timeouts, or an executable that
   exists but cannot run. Every step stays in the check log. Recovery stops if
   the setup or project check changes, setup fails, files change, the checkout
   moves, unchanged files cannot be confirmed, the worker loses custody, or
   the executable is still missing.
7. **Review it without the transcript.** The **review** view of builds is a
   cockpit over completed work: a queue ranked by *review priority* (a
   labeled, deterministic aid — conflicting or missing evidence, reviewer
   contradictions, and observed CI failures first; it never rewrites the
   stored verdict), and one selected result showing the approved goal and
   boundary, every signed criterion with its adjudicated state and the
   evidence it cited, the machine's re-run and the agent's own checks
   labeled apart, reviewer findings, validated screenshots, caveats, the
   sealed diff with changed files ordered by priority and flagged when they
   fall outside the signed touches (matched gitignore-style, so `src/**`
   with `/*.ts` covers nested files), and what the publication watcher
   actually saw. The queue shows the newest 100 completions; an older
   result still opens by its own link. The next act sits under the header: review evidence,
   annotate the diff and create a revision, compare a tournament, or
   open the pull request — each through the road that already owns it. A
   task marked done by hand, or built before proofs existed, says so
   plainly instead of pretending to a verdict.

Everything else is under **more**: the activity ledger, the review cockpit,
routines (standing orders that file themselves on a schedule), the fleet,
people (invite a second approver), the operating mode (a signed, expiring
envelope that pre-approves your own filings), and **chat** — the mate, one
conversation across every project, which only ever proposes.

### In the terminal

```sh
standing-orders task add "Give outbound webhooks a bounded retry policy" --id retries --repo .
standing-orders task scope retries --goal "Exponential backoff, dead-letter after 24h, no payload changes" \
  --acceptance "A failing webhook retries with exponential backoff and dead-letters after 24h.|check"
standing-orders task show retries --json          # the scope's digest is what you sign
standing-orders task approve retries --as you --digest <digest> --yes   # asks for your password

standing-orders peek                               # one pane per live agent; q leaves
standing-orders decide <id> --choose <option>      # answer a parked decision
standing-orders task show retries                  # attempts, outcome, where the branch is

standing-orders task add "Why does the login test flake?" --id flaky --report   # a scout
standing-orders chat --say "what is waiting on me across every project?"       # the mate
```

Every command takes `--json` and answers with one envelope; every mutation
takes `--key` so a retry never files twice. `standing-orders --help` and
`standing-orders skills get console` are the live references — the second
is what your coding agent reads when you ask it how something works.

An agent that hits a judgement call **parks a typed decision instead of
guessing** — answer it from the terminal, the console, or a Telegram tap,
and the freed build resumes in seconds. Built work leaves only as a pushed
branch and a pull request, under a publication grant whose exact terms you
approved.

## Unattended is not auto-accept

Every tool in this category has a mode where the agent stops asking —
usually named something like *auto-accept*, or worse. Here the boundaries
do not loosen when you leave the room:

| An agent here can never | Enforced by |
|---|---|
| touch a default branch | builds land on `standing-orders/<task>` in a leased worktree; push + PR happen only under a publication grant naming the exact repo, branch prefix, and base |
| approve its own work | approval nonces are minted only on screens that restate the digest-bound terms, and require your approver token typed again — **no LLM sits in any approval path** |
| act on an irreversible option | `reversible` is a schema field; irreversible choices never auto-apply, and answering one from a phone takes a second minted confirmation tap |
| see your credentials | bot tokens and API keys are stripped from every agent's environment; secrets live in 0600 files, never in the database, URLs, or logs |
| spend while idle | **an LLM never polls** — the daemon does every no-judgement chore at zero token cost and wakes an agent only on a real event |
| spend without being counted | every provider spawn is stamped *before* it spends, so cost is measured, never asserted |
| guess at a judgement call | it parks a typed decision — recap, options with reversibility, recommendation, evidence — and the other eleven tasks keep going |

The whole claim is executable: one test,
[`src/unattended.test.ts`](src/unattended.test.ts), queues twelve tasks,
walks away, and comes back to pull requests.

The name comes from a captain's night orders — the written standing instructions left for the officer of the watch: *proceed on this course without me, and wake me under exactly these conditions.* That is the product, and it is not about the hour: it is for **long-running work that outlasts your attention** — an afternoon of errands, a weekend, or yes, a night.

Standing Orders is a control plane for coding agents, optimized for the stretch where **nobody is watching**. It owns the scheduler, the attention surface — the typed queue of things waiting on a human — and an append-only event log.

It owns a deliberately small local task store, adapts richer trackers when they are already there, and owns no worktree pool, no review gate, and no agents. Those are adapters over [`beads`](https://github.com/gastownhall/beads), [`treehouse`](https://github.com/kunchenguid/treehouse), [`no-mistakes`](https://github.com/kunchenguid/no-mistakes), `claude`, and `codex`.

## Two claims

**Sixty seconds to first value.** No init, no daemon start, no wizard, no OAuth app.

```sh
npx standing-orders ~/code     # or: git clone … && npm install && npm run dev -- ~/code
```

It walks the filesystem for `.git` and reads every repo through the `git` credentials already on your machine, then shows what is in flight:

```
10 branches in flight across 24 repositories

vamarketplacenew                   main
  feat/wise-payouts                upstream gone       4d ago
  feature/public-api-v1            ahead 17            1mo ago
  api-pricing-impl                 behind 84           2mo ago

oddcircle                          redesign/instrumentation-cash-flag
  main                             ahead 3, behind 56  23d ago
```

No agent has run. Nothing has been configured, written, or installed. Every other tool in this space starts from an empty database it expects you to fill. `--json` emits the same thing as `{ scannedAt, roots, repos }`, because half the intended audience is an agent.

Reads are priced before they are made. Listing refs is O(refs) and finishes in milliseconds; `git status` is O(working tree) and was measured at over two minutes on a real repo, so it is off by default behind `--dirty`. Computing ahead/behind walks history — 22s cold on a 304MB repo — so it is bounded at 5s and degrades to a branch list that says what it withheld. Every call goes through `--no-optional-locks`, so a scan never takes the index lock from an editor you have open.

`standing-orders pulls` answers the narrower question of what is waiting on a person, and `standing-orders graph` says which work graph is already here:

```
Work graph — detected in your repos

▸ beads          2 repos · 47 ready · native deps · runtime ok (1.4.0)
  GitHub Issues  112 open · native deps · 2.67.0 too old, needs 2.94.0

Suggested: beads — the only work graph in your repos, and its runtime answers.
Nothing is enrolled, and detection grants nothing.
```

Backends are chosen by looking rather than asking, but **detection is not authorization** — finding a populated tracker says it exists, not that anyone wants an agent scheduling or closing what is in it. Data and runtime are detected separately, so a tracker whose binary is missing is reported as real work this machine cannot dispatch, which is a visible gap at 9am instead of a dead loop at 3am. Two populated trackers means neither is chosen: task count is not authority, and the biggest one may be the abandoned one. Where a fact is not established — Backlog.md's dependency edges, for instance — it is marked unverified and **fails closed**, because a private dependency graph other tools cannot see is shadow data.

**Nothing is ever installed for you.** `bd init` stages files, edits agent integrations, and can create a commit, so Standing Orders prints the command and its side effects and lets you run it.

## Queueing work, and taking it

The built-in store is the fallback backend, and the commands over it are written for an agent first — because the agent is what runs them ten thousand times while you are away.

```sh
standing-orders task add "migrate the payouts schema" --id schema
standing-orders task add "wire the payouts API" --id api
standing-orders task block api --on schema     # api waits for schema

standing-orders ready --json                   # what could be dispatched now
standing-orders claim schema --runner builder-1 --key dispatch-schema
standing-orders heartbeat <lease>              # still working
standing-orders release <lease>                # done holding it
```

Four properties make that loop safe to run unattended.

**Every outcome is data.** `--json` returns the same envelope from every command, failures included: `{ ok, command, reason, message }`. `reason` is a stable token — `held`, `fenced`, `unknown-task` — because prose gets reworded and anything branching on it breaks silently. The binary teaches its own surface: `contract --commands` dumps the declared command guide, and `skills get <name>` serves version-matched operating guides straight from the exact build an agent is driving — never a stale snapshot.

**Exit codes separate "no" from "broken".** `0` got it · `1` something broke · `2` bad usage · `3` ran fine, the answer is no. Losing a claim race and finding the ready set empty are correct answers, not errors, and a loop that stops on them is as wrong as one that ignores real breakage.

**Every mutation takes `--key`.** An agent whose command succeeded but whose output was lost *will* retry. With a key that retry returns the first answer instead of queueing a second task or taking a second lease. Mutations that changed nothing are never recorded, so a refusal never becomes a permanent no.

**`fenced` means stop.** A runner whose machine slept, whose lease expired, and whose task was reclaimed will be told exactly that at its next heartbeat — long before it finishes work nobody will accept. Dispatch is a compare-and-swap on `(task, lease_generation)`, enforced by the database rather than by anything the caller remembers to check.

## The unattended pass

`standing-orders tick` is the loop above with nobody typing it, once per invocation:

```sh
standing-orders tick --runner builder-1 --token <t> --repo ~/code/thing --max 1
```

One pass: take the ready set, skip what nobody approved, claim what is left — re-proving readiness inside the same transaction as the claim, because the world moves between a list and a take — build each task in a leased worktree on `standing-orders/<task-id>`, and commit. **Tick itself never pushes** and cannot touch the default branch; pushing and opening the pull request happen only under a publication grant whose exact repository, branch prefix, and base you approved — and merging stays yours, on GitHub.

It is deliberately a pass and not a daemon: point cron at it and the fences make repetition safe — a second pass finds the first's work done and converges to `empty` (exit 3) instead of building anything twice. A broken build marks its task `failed` and the pass exits 1 even if other tasks succeeded, because exit 0 has to mean "nothing needs you". Refusals that are really a person's pending decision — a scope nobody approved, or one that changed after approval — leave the task queued and untouched.

## Advanced: a separate background builder

Normal local use does not require this section: `standing-orders up` is the
product command. For a remote or split deployment, the builder loop can manage
itself as an OS service — launchd on macOS, systemd on
Linux, Task Scheduler on Windows, chosen automatically — so "set it
running" is one command, and reboots and crashes are the supervisor's
problem:

```sh
standing-orders daemon install --runner builder-1 --token <runner-token> --repo ~/code/thing
standing-orders daemon status      # running, as which pid, logs where
standing-orders daemon logs        # the file to tail
standing-orders daemon uninstall   # take it back off
```

Under the hood it runs `standing-orders watch`: a work-conserving loop that
composes the same passes cron would call — but wakes on events (a decision
answered from your phone dispatches the next build in seconds), recovers
its own predecessor's mid-flight work after a crash, and spends zero tokens
while idle. The runner token lives in a 0600 file beside the database; the
service unit never carries it. Cron remains first-class if you prefer it —
`reconcile && tick ; bridge telegram` on a schedule does the same jobs at
cron's cadence, and a stray cron tick alongside a watch is safe (ordinary
claims settle the race), it just is not needed.

An honesty note for Windows: every pull request now type-checks, builds, and
runs the native Task Scheduler/link tests plus the core dispatch contract on
Windows with Node 22 and 24. Approved setup and verification commands use
Windows' native command shell. The scheduled-task definition follows the Task
Scheduler XML schema and every `schtasks` interaction is covered by scripted
tests. A physical Windows install has not yet been certified; the exact
real-provider and post-reboot checklist is in the
[Never Stuck release certification](https://github.com/ap9000/standing-orders/blob/main/docs/CERTIFICATION.md).

### Unattended permissions

The console's **Settings → unattended permissions** control chooses the
starting policy for new tasks. **Auto** lets routine repository commands and
edits proceed while the provider may stop on a risky permission request.
**Full access** runs Claude with `--dangerously-skip-permissions`, Codex (and
its OpenRouter transport) with `--dangerously-bypass-approvals-and-sandbox`,
and Gemini with `--approval-mode yolo`, so permission prompts cannot pause work
while you are away. Use Full access only for repositories and setup commands
you trust.

Every new-task and task-scope form has the same two-choice control. A task's
choice is durable through planning rewrites and is sealed into the approved
execution profile; changing the installation default never broadens an
existing scope or approval.

### Quality modes

The console's **Settings → quality mode** control chooses how deeply new
tasks validate their output. **Default** is the streamlined path: the agent
builds once, returns the signed acceptance matrix, checks, screenshots, and
diff, and Standing Orders applies its deterministic verdict. A separately
signed operating mode can still request semantic review on this path.

**Strict / release** signs one additional promise into the task scope: after a
changed build completes, its hash-verified evidence bundle and sealed diff are
sent through the isolated reviewer. Reviewer findings are folded back into the
criterion matrix. A bounded repair task is drafted only when the separately
approved operating-mode terms authorize repair; Strict never silently expands
agent permissions or autonomy.

The same selector appears when a task is created and while its scope is still
editable. The concrete choice is stamped on every run, survives global setting
changes, and is visible on the task, approval, run-list, and run-detail views.

### Explainable phase routing

Which agent plans, builds, repairs, and reviews a task is decided once, from
signed facts, and written down with its reasons. The route reads the task's
declared **risk** (routine, elevated, high), its quality mode, what the
acceptance rubric demands (screenshots, manual review), how far a live
operating mode may carry the result unattended (an automerge mode strengthens
the reviewer), and the agents you configured for each phase. Strength is never
inferred from a model's name: the ordinary phase row is the routine tier, and
`config set <phase> --tier strong --provider <p> --model <m>` names the agent
high-risk, strict, screenshot-proof, and automerge routes reach for. With no
strong row, a demanding task keeps the default and says so.

```
standing-orders task scope <id> --goal … --acceptance … --risk high
standing-orders task route <id>                     # every leg, its reason, its readiness
standing-orders task route <id> --phase review --provider codex --model gpt-5-codex --as you --token <t>
standing-orders task route <id> --clear-phase review --as you --token <t>
standing-orders providers --report --runner <name> --token <t>   # this machine's readiness
```

Every leg is **exact**: approvals bind a provider *and* a model id for the
planner, builder, repair, and reviewer alike, so each phase names its model
once (`config set plan --provider claude --model <m>`, and the same for
`build` and `review`; repair inherits the build's model unless a same-provider
repair row names another). A phase without an exact model, a repair row on
another provider, or an unknown provider files the scope **unresolved** with
the words to fix it — nothing is guessed or substituted. Every override names
an exact model too, and a plan override becomes the planner pin.

Every override is recorded under the approver's name, in one transaction that
checks the scope you were reading is still the one on file (`--digest`, or the
form's own field). Approval seals the route — routine-shaped routes included —
together with any configured fallback chain, exactly as it seals the execution
profile; a later risk change or override re-files the scope and the old
approval reads stale, while a global configuration change can never rewrite a
sealed route. A row filed before routing existed is recognised by a durable
marker and stays governed by its sealed profile; a routed row whose route data
is missing or unreadable is refused everywhere until re-filed and approved
again. Repairs always stay on the build provider. Runners report provider
readiness without spending — at startup and with `providers --report`, never
on a timer — and the task page, the chat, and `task show` say **ready**,
**unavailable** (with the runner's own words), or **unknown** beside the
agents, outside what the approval signs; an unavailable provider halts before
any claim and is never substituted, except that an unavailable primary under
an approved fallback chain moves to the exact approved next entry (and only
under a live mode that allows paid fallback). Reviewer admission and fallback
admission re-check readiness and the exact leg inside their transactions.
Every run is stamped with its route and the actual provider and model at
admission — set once; a run that would spend as anything else refuses.

## The phone, both directions

The Telegram bridge closes the loop without a terminal: a parked decision
arrives as a message with one button per option, and a tap answers it
through the same authenticated path as the CLI and the web view — the hold
lifts, and the next pass resumes the task with the answer in the agent's
brief. No LLM is anywhere in this path.

Setup, once:

1. In Telegram, message **@BotFather**: `/newbot`, pick a name and a
   username. Copy the token it hands you.
2. `standing-orders bridge telegram token <that-token>` — stored in a 0600 file
   beside the database (or set `STANDING_ORDERS_TELEGRAM_TOKEN`, which wins;
   or paste it into `serve`'s settings card from your phone).
3. `standing-orders approver add you --password <yours>` if you have no
   sign-in yet — that name and password are the login for the console and
   every approving act. (Omit `--password` and a high-entropy one is
   minted and printed once instead — better for API/bearer use.)
4. `standing-orders bridge telegram pair --as you --token <approver-token>` —
   prints a one-time code, good for ten minutes.
5. From your phone, open your bot's chat, press Start, send
   `/pair <that-code>`, then run `standing-orders bridge telegram` once to
   complete it. The bot replies with who the chat now answers as.

Then cron the pass next to `tick`:

```sh
standing-orders bridge telegram        # sends pending, applies taps, exits
```

`bridge telegram status` shows the token source, the binding, and what is
waiting. For answers in seconds instead of at the next cron firing,
`standing-orders bridge telegram --follow` stays on the wire — one long-poll
actor holding the same poll lease, so a cron pass overlapping it simply
loses the race. `standing-orders watch` embeds the same follower automatically
when a bot token is configured: a tap on your phone answers the decision,
the answer wakes the loop, and the freed task resumes — phone to build,
no timer in between.

**Away mode.** `standing-orders bridge telegram digest --every 2h` (or
`--off`, or the console's settings card) holds routine facts — merges,
reports, retries, plans ready — and sends them as one digest on that
cadence. A decision, and anything that needs a person now (a stalled
task, a malformed payload, a gap that blocks work), still pages the
moment it lands. `bridge telegram status` says how many facts are held.

A chat is not a person: pairing binds one private chat and one immutable
Telegram user id to one approver credential. Buttons carry opaque one-time
tokens whose meaning lives in the local database — a stolen bot token can
read what was sent and repaint keyboards, but it cannot mint a token,
answer as you, or arm an irreversible choice, which takes a second minted
confirmation tap. Rotating your approver credential strands the chat and
every outstanding button, and the bot token itself is stripped from every
agent's environment.

## Peeking at the agents

```sh
standing-orders peek            # one pane per live run: stage, clock, what the agent is saying
standing-orders peek 42         # follow one run until it finishes
standing-orders peek --tmux     # a real tmux session, one window per run
```

The panes tail each run's live transcript, the same file the console's
run page follows: the text the agent said and the kind of tool it reached
for (editing files, running a command, searching the code), never file
contents or command lines, with credential-shaped lines redacted at
write. Digits focus one pane, `a` shows them all, `q` leaves. Outside a
terminal, or with `--json`, it prints one snapshot and exits.

## The mate, and the gateway

`/chat` in the console (or `standing-orders chat` in the terminal) is one
conversation across every project you serve. The mate reads the fleet
and **only proposes**: file a task (or a scout), move one to the front,
reserve it for a worker, hold it, rewrite a scope, retry/replace/unlink a
terminal dependency, guide a task's next attempt, cancel, or suggest an answer to a parked decision. Every
proposal is a card you confirm, with
every consequence and the builder's recommendation shown beside the
mate's pick; a scope the mate wrote never seals under an operating mode.
It never sees a path, a digest, or an account name. Direct API use spends
against a ceiling you set per conversation. The console keeps a live pulse for every
admitted project beside that shared thread, with one-click fleet questions
and a direct road to each project's board.

Every task has an **Overview / Ask** switch. **Ask** opens a focused companion
to that task without creating another conversation: Standing Orders attaches
the current task to each new message, keeps the live status beside the thread,
and offers plain-language starters for status, scope revision, steering, and
proof review. Proposed guidance is inert until you confirm its card, then it
reaches the next attempt without interrupting work already running.

New work starts the same way: describe the outcome once in ordinary language.
The mate infers a concise title, narrow scope, safe non-goals, and proof
criteria; it asks only when the project or outcome is genuinely ambiguous, or
when an irreversible or compatibility tradeoff changes what should be built.
Questions are grouped, carry a recommended default, and stop for reversible
choices when you say **use your judgment**. The task card says whether Standing
Orders will inspect the repository and draft a plan before asking you to
approve anything.

When a task finishes, both views lead with the same **result receipt**: what
shipped, proof level, acceptance pass count, sealed diff size, validated UI
screenshots, and any caveats. Open the full evidence ledger or discuss and
request changes from there; chat cannot rewrite the stored result.

The evidence page opens the sealed patch in a clean **View** mode. Switch to
**Annotate** only when you need a change: select the exact line, leave plain-
language feedback, and collect as many notes as needed. Creating a revision is
a separate, optional act that seals the exact annotation batch into one scoped
task for approval; ordinary result review never requires it.

The chat setup screen defaults to **Codex membership · default model**.
Run `codex login` once on the machine serving Standing Orders, choose that
provider, and there is no Standing Orders dollar maximum. The conversation
stays live until you end it; the daily turn limit and your plan's own upstream
limits still apply. Anthropic
membership works the same way after signing in with the `claude` CLI. Direct
`anthropic-api` and `openrouter-api` modes remain available; only those modes
ask for weekly and per-conversation dollar ceilings.

```sh
codex login
standing-orders config set chat --provider codex-subscription --as you --token <password>
standing-orders serve --repo /path/to/project-a --repo /path/to/project-b
# Open /chat, type your password once to start the conversation, then talk.
```

Coding agents you run elsewhere reach the same plane through the MCP
gateway: `standing-orders mcp` serves a coordinator credential you mint,
bound to named repositories, that can read the fleet, file quarantined
proposals, and propose the same guarded acts — `standing-orders proposals`
and the task page are where you confirm them. Both roads keep the one
rule: the plane never acts on a model's word.

## The console

`standing-orders serve --repo <path>` is no longer just the decision view — it
is the whole built-in queue, operable from a phone: an inbox of everything
waiting on you, a live activity report (run counts, measured spend,
decisions, incidents, stranded work, gaps), every task with its scope, holds, runs, decisions and
incidents on one screen, run pages with the economics and the agent's
concluding words, and read-only capabilities. Adding a task, holding,
requeuing, cancelling, and editing a scope all happen from the page — each
re-proved server-side, so a stale tab never erases what the world did in
the meantime, and a task a runner is building right now refuses to be
cancelled out from under it.

Approving a scope is deliberately heavier than a click: the form restates
the goal, the exclusions, and the touched paths — exactly the fields the
approval digest binds — and requires your approver token typed again. A
logged-in session alone can read everything and approve nothing.

Plain HTTP, so keep it on localhost or a tailnet and put TLS in front for
anything else.

## Steering a fleet, not just a task

Everything below ships in 0.4.0:

- **The queue screen** — every worker's up-next list as columns, like a
  music queue: drag to reorder, drag into a worker's column to reserve a
  task for it (each column wears an editable theme note), top is taken
  first. A worker drains its own column, then the shared queue. The
  reservation is enforced in the claim primitive itself — the wrong
  worker's claim gets a typed `reserved` refusal, however it asks.
- **Chains and "this one first"** — `task block/unblock` wires
  dependencies (cycles refused), "starts after" on the filing form,
  `task next` moves work to the front of its own queue. Scheduling,
  never authority: approvals are untouched by any of it.
- **Tournaments** — race 2–4 agents on one task under native dollar
  caps, compare their verified diffs side by side, and pick one through
  a password ceremony; the losers' branches and evidence are kept.
- **The live peek** — a running build's page shows what is changing in
  its checkout right now (names and counts, never contents), through a
  native reader that executes nothing — no git command ever runs
  against an agent-controlled worktree.
- **External dispatch** — enroll a GitHub repository with an explicit
  dispatch grant and its labeled issues become ordinary local tasks:
  scoped and approved HERE (issue bodies are never imported — a tracker
  anyone can write to is a prompt-injection surface), built unattended,
  answered back with a PR-link comment under exactly the write classes
  you granted. An issue closed mid-build can never publish: the
  completion transaction disowns it, keeps the branch as evidence, and
  says so. Done stays done — remote closure never regresses a completed
  dependency. Revisions ride review comments: mark up the finished
  diff (or let granted reviewers do it from the PR) and seal the batch
  into one new approval-bound task.
- **Operating modes** — a per-repository, password-signed, expiring
  envelope that pre-authorizes the SIGNER'S OWN future acts: your
  filings approve themselves the moment you file them, watched sessions
  start without retyping your password, merges fire themselves when CI
  is seen green on the exact authorized commit (only through a merge
  grant, never around one), and daily run/dollar rails bound the spend.
  Every term renders in words at the signing ceremony — including the
  sentence "your signed-in browser session becomes a spend credential
  for this repository" — and ending it all is one click, for any
  approver, at any moment. No mode signed means nothing changes: every
  act keeps its own ceremony, the default forever.
- **The reviewer** — an agent pass over a finished build's sealed diff,
  and nothing else: no worktree, no repository access — the patch is
  re-verified against its recorded hash, comments are proven
  patch-local, and they land beside your own for YOU to prune and seal
  into a revision task. One review per build, ever; a mode can run one
  on every finished build automatically.
- **People** — invite someone with a single-use link that pins their
  powers at mint (watch everything, or approve and act), see who is
  doing what, and remove access with one ceremony that actually severs:
  sessions, invites, and every mode they signed end together, while
  history stays attributed forever.
- **Watched sessions, plural** — run several attended sessions per
  worker under one signed ceiling, each with its own model and
  permission posture chosen at mint, the whole execution profile under
  the signature.
- **Scout tasks** — `task add … --report` (or the "scout" checkbox, or
  the mate's `propose_task` with `report: true`) files a task whose
  deliverable is a report, never a branch: once its scope is approved,
  a read-only session investigates the goal as a question and hands
  back a title, a summary, a document, and up to five follow-ups, each
  of which files as a task with one tap. The workspace is proven
  untouched before a byte of the report is read; a scout that changed
  anything gets nothing ingested.

## Writing to a tracker you already have

Detection tells you what is there; a grant is what lets anything be written to it.

```sh
standing-orders enroll . --backend github-issues --paths owner/name   # shows the terms
standing-orders enroll . --backend github-issues --paths owner/name --yes
standing-orders grants          # what has been granted, and to what
standing-orders revoke .        # take it back

standing-orders ready --backend github-issues     # reads need no grant
standing-orders task add "..." --backend beads    # writes do
```

The grant is not a boolean. It records which paths or repositories may be touched, which mutation classes are allowed, which tasks are covered, which credential scope applies, and whether the writes will turn up in `git status` — that last one asked of `git check-ignore` rather than assumed. Two defaults carry weight: only tasks Standing Orders created or was given, because enrolling a repo with four hundred open issues is not volunteering all four hundred; and `close` is withheld, because closing what somebody else filed is not the same act as transitioning your own task.

Every backend goes through the same contract, and the authorization wraps it rather than living inside each adapter — an adapter written later inherits the check instead of having to remember it.

**Edges are never emulated.** beads has native dependencies and they are used. This GitHub adapter has not confirmed the dependency endpoint against a live repository, so `addEdge` refuses rather than storing a graph only Standing Orders can see — one that would read as ready to every human on the repo. That is the design's rule, and the refusal says so.

The beads adapter is built to beads' own documentation and exercised against a stubbed runner; it has never run against a real installation, because `bd` was not present on the machine it was written on. Commands whose flags could not be established — a general status update, in particular — refuse rather than guess.

The materialised snapshot M0 promised shipped as **external dispatch**: a `sync` pass mirrors a tracker's nominated issues into the queue as ordinary local tasks (titles only, validated; bodies never), so the scheduler's hot path never touches the network — see below.

**It survives the night, cheaply.** Work dispatches itself from a dependency graph, fails safely, and parks a *typed* decision — recap, options with reversibility, a recommendation, evidence — instead of guessing. Parking never stalls the loop; the blocked task steps aside and eleven others keep going.

And it costs nothing while idle. **An LLM never polls.** The daemon handles everything that needs no judgement — ticks, capability probes, lease reaping, CI polling, notifications — at zero token cost, and wakes an agent only on a real event. The target is a testable invariant: an eight-hour run with twelve tasks shows near-zero token spend across idle windows.

## What breaks overnight, and the answer

| Failure | Mechanism |
|---|---|
| Expired key found at 3am after 40k wasted tokens | capabilities probed *before* dispatch; gaps ranked by tasks unblocked |
| A runner dies holding a worktree | `Claim` with an immutable lease id and a fencing generation; late completions rejected |
| A build fails, then fails the same way again | typed strikes with doubling backoff; three strikes stalls the task for a person, who exits it with `task requeue` |
| You wake to five transcripts | one briefing: what ran, what is blocked, what needs deciding |

## Status

**0.4.0 — schema v29, suite 1,369.** The M4 loop plus tournaments, the
live peek and live transcript, chains and queue ordering, per-worker
queue columns, external dispatch, merge grants with observed-green CI
and a fourteen-transition merge machine (per-merge human authorization
by default; a signed automerge mode may substitute for exactly that
yes, re-proved at the moment of firing), the phone PWA with
zero-dependency push, the attended core (governed live sessions:
signed terms, mid-session conversation, crash custody, continuation,
N parallel sessions per worker), the attested runtime (four providers
— Claude, Codex, OpenRouter, Gemini — the last admitted by versioned
conformance, never a registry row), labeled cross-runtime comparisons
with honest per-lane money, operating modes with their daily rails,
the artifact-only reviewer, and multi-user instances with invite
links, roles, and a People screen. Every arc shipped behind its own
adversarial review rounds; docs/PROGRESS.md records every finding.

**M4 built.** The whole loop runs: `standing-orders watch` (or `daemon
install` — no crontab) dispatches approved work, spends nothing while idle,
survives crashes by recovering exactly its own predecessor's claims, and
stops taking work on the first signal. Failures are typed — strikes,
doubling backoff, three-strike stalls a person exits with `task requeue` —
and every provider spawn is stamped before it spends, so cost is measured,
never asserted. CI on published PRs is watched as episodes that never call
silence green. The whole unattended stretch is one test,
[`src/unattended.test.ts`](src/unattended.test.ts): queue twelve, walk
away, come back to PRs. Architecture: [`docs/DESIGN.md`](docs/DESIGN.md);
the item-by-item ledger: [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Milestones

| | | |
|---|---|---|
| M0 | discovery, graph adapters, leases, CLI | `npx standing-orders` shows what is in flight — **useful before it is autonomous** |
| M1 | runners, worktrees, first builder | one task goes queued → branch → commit unattended |
| M2 | capability probes, secrets, briefing | fill one gap, three tasks start |
| M3 | decisions, evidence, web view | a park renders as one screen, answerable on a phone — **and it does, executably** |
| M4 | the loop | **queue twelve, sleep, wake to PRs — with near-zero idle spend** |

Deferred until M4 earns them: the spatial board, multiplayer, in-browser terminals, Postgres, RBAC.

M4 is the product. M0 is what makes anyone install it long enough to reach M4.

## Not competing with

[**agor**](https://github.com/preset-io/agor) owns the execution-plane category and does it well — browser UI, six runtimes, multiplayer, a spatial board. It optimizes for a team steering agents *live*; we optimize for nobody being awake. It is BSL 1.1; this is MIT.

[**firstmate**](https://github.com/kunchenguid/firstmate) proves the orchestrator role works as conventions plus tmux, with no UI and no schema. Its event-driven bash watcher is where the zero-token supervision rule came from. Our bet is that the same role is better with a typed decision record and a browser you can answer from.

## Contributing

The most useful surface is a **provider adapter** — `src/provider.ts` is
the only module that names an agent binary, and
[CONTRIBUTING.md](CONTRIBUTING.md) walks the contract. Bug reports want
`--json` output; the issue forms say what else. Every behavior lands with
a test — the suite is the specification.

## Credits

The workflow this formalizes comes from [Jason Ku's agentic engineering session](https://youtu.be/Ukju3maxbEQ) and his [`agents-md-snippets`](https://github.com/jasonku09/agents-md-snippets), plus Kun Chen's `treehouse`, `no-mistakes`, `gnhf`, `tasks-axi`, and `axi`. The design was reviewed adversarially by Codex; the appendix in `docs/DESIGN.md` lists every claim that review falsified, because the corrections are more useful than a clean spec would have been.

## License

[MIT](LICENSE).
