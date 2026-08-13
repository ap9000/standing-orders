<div align="center">

# standing·orders

**Standing orders for your agents. Wake me only for these.**

Queue twelve tasks, walk away, come back to pull requests —
with near-zero token spend across every idle hour.

[![CI](https://github.com/ap9000/standing-orders/actions/workflows/ci.yml/badge.svg)](https://github.com/ap9000/standing-orders/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/standing-orders)](https://www.npmjs.com/package/standing-orders)
![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-brightgreen)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-blue)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<img src="docs/media/demo.svg" alt="Queue tasks, install the daemon, leave; a parked decision is answered from a phone and the tasks come back as pull requests." width="760">

</div>

```sh
npx standing-orders                    # what's in flight across your repos — read-only, zero config
npx standing-orders serve --repo .     # the whole queue, phone-first, on a local console
npx standing-orders daemon install …   # the unattended loop, as an OS service — no crontab
```

An agent that hits a judgement call **parks a typed decision instead of
guessing** — answer it from the terminal, the console, or a Telegram tap,
and the freed build resumes in seconds. Built work leaves only as a pushed
branch and a pull request, under a publication grant whose exact terms you
approved. **No LLM sits in any approval path, and an LLM never polls.**

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

**Every outcome is data.** `--json` returns the same envelope from every command, failures included: `{ ok, command, reason, message }`. `reason` is a stable token — `held`, `fenced`, `unknown-task` — because prose gets reworded and anything branching on it breaks silently.

**Exit codes separate "no" from "broken".** `0` got it · `1` something broke · `2` bad usage · `3` ran fine, the answer is no. Losing a claim race and finding the ready set empty are correct answers, not errors, and a loop that stops on them is as wrong as one that ignores real breakage.

**Every mutation takes `--key`.** An agent whose command succeeded but whose output was lost *will* retry. With a key that retry returns the first answer instead of queueing a second task or taking a second lease. Mutations that changed nothing are never recorded, so a refusal never becomes a permanent no.

**`fenced` means stop.** A runner whose machine slept, whose lease expired, and whose task was reclaimed will be told exactly that at its next heartbeat — long before it finishes work nobody will accept. Dispatch is a compare-and-swap on `(task, lease_generation)`, enforced by the database rather than by anything the caller remembers to check.

## The unattended pass

`standing-orders tick` is the loop above with nobody typing it, once per invocation:

```sh
standing-orders tick --runner builder-1 --token <t> --repo ~/code/thing --max 1
```

One pass: take the ready set, skip what nobody approved, claim what is left — re-proving readiness inside the same transaction as the claim, because the world moves between a list and a take — build each task in a leased worktree on `standing-orders/<task-id>`, and commit. **It never pushes**, and it cannot touch the default branch; a pull request is always the terminus, and opening one stays a person's decision at this milestone.

It is deliberately a pass and not a daemon: point cron at it and the fences make repetition safe — a second pass finds the first's work done and converges to `empty` (exit 3) instead of building anything twice. A broken build marks its task `failed` and the pass exits 1 even if other tasks succeeded, because exit 0 has to mean "nothing needs you". Refusals that are really a person's pending decision — a scope nobody approved, or one that changed after approval — leave the task queued and untouched.

## No crontab required

The loop manages itself as an OS service — launchd on macOS, systemd on
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

An honesty note for Windows: the scheduled-task definition follows the Task
Scheduler XML schema and every `schtasks` interaction is covered by scripted
tests, but it has not yet been exercised on a physical Windows machine —
if you are the first, `daemon install --dry-run` shows exactly what it
would register, and an issue report is very welcome.

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

A chat is not a person: pairing binds one private chat and one immutable
Telegram user id to one approver credential. Buttons carry opaque one-time
tokens whose meaning lives in the local database — a stolen bot token can
read what was sent and repaint keyboards, but it cannot mint a token,
answer as you, or arm an irreversible choice, which takes a second minted
confirmation tap. Rotating your approver credential strands the chat and
every outstanding button, and the bot token itself is stripped from every
agent's environment.

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
anything else. External-backend tasks (GitHub Issues and friends) appear
here when external dispatch ships; today this is the built-in queue's
console, and says so.

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

**Next in M0:** issues in the default report, and a materialised snapshot so a scheduler can read an external backend without a network call in its hot path.

**It survives the night, cheaply.** Work dispatches itself from a dependency graph, fails safely, and parks a *typed* decision — recap, options with reversibility, a recommendation, evidence — instead of guessing. Parking never stalls the loop; the blocked task steps aside and eleven others keep going.

And it costs nothing while idle. **An LLM never polls.** The daemon handles everything that needs no judgement — ticks, capability probes, lease reaping, CI polling, notifications — at zero token cost, and wakes an agent only on a real event. The target is a testable invariant: an eight-hour run with twelve tasks shows near-zero token spend across idle windows.

## What breaks overnight, and the answer

| Failure | Mechanism |
|---|---|
| Expired key found at 3am after 40k wasted tokens | capabilities probed *before* dispatch; gaps ranked by tasks unblocked |
| A runner dies holding a worktree | `Claim` with an immutable lease id and a fencing generation; late completions rejected |
| Agent guesses on an irreversible call | `reversible` is a schema field; irreversible options never auto-apply |
| You wake to five transcripts | one briefing: what ran, what is blocked, what needs deciding |
| Secrets on a shared server | the control plane stores metadata only; values stay in the runner's keychain |

## Status

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

## Credits

The workflow this formalizes comes from [Jason Ku's agentic engineering session](https://youtu.be/Ukju3maxbEQ) and his [`agents-md-snippets`](https://github.com/jasonku09/agents-md-snippets), plus Kun Chen's `treehouse`, `no-mistakes`, `gnhf`, `tasks-axi`, and `axi`. The design was reviewed adversarially by Codex; the appendix in `docs/DESIGN.md` lists every claim that review falsified, because the corrections are more useful than a clean spec would have been.
