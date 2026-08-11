# Night Orders

**Standing orders for your agents. Wake me only for these.**

> **Status: M0 in progress.** Discovery works today and is worth running. No agents run yet, and nothing is published to npm. The architecture lives in [`docs/DESIGN.md`](docs/DESIGN.md) (v0.5).

A captain's night orders are the written standing instructions left for the officer of the watch: *proceed on this course without me, and wake me under exactly these conditions.* That is the product.

Night Orders is a control plane for coding agents, optimized for the case where **the operator is asleep**. It owns the scheduler, the attention surface — the typed queue of things waiting on a human — and an append-only event log.

It owns a deliberately small local task store, adapts richer trackers when they are already there, and owns no worktree pool, no review gate, and no agents. Those are adapters over [`beads`](https://github.com/gastownhall/beads), [`treehouse`](https://github.com/kunchenguid/treehouse), [`no-mistakes`](https://github.com/kunchenguid/no-mistakes), `claude`, and `codex`.

## Two claims

**Sixty seconds to first value.** No init, no daemon start, no wizard, no OAuth app.

```sh
git clone https://github.com/ap9000/nightorders && cd nightorders
npm install && npm run dev -- ~/code      # `npx nightorders` once it ships
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

`nightorders pulls` answers the narrower question of what is waiting on a person, and `nightorders graph` says which work graph is already here:

```
Work graph — detected in your repos

▸ beads          2 repos · 47 ready · native deps · runtime ok (1.4.0)
  GitHub Issues  112 open · native deps · 2.67.0 too old, needs 2.94.0

Suggested: beads — the only work graph in your repos, and its runtime answers.
Nothing is enrolled, and detection grants nothing.
```

Backends are chosen by looking rather than asking, but **detection is not authorization** — finding a populated tracker says it exists, not that anyone wants an agent scheduling or closing what is in it. Data and runtime are detected separately, so a tracker whose binary is missing is reported as real work this machine cannot dispatch, which is a visible gap at 9am instead of a dead loop at 3am. Two populated trackers means neither is chosen: task count is not authority, and the biggest one may be the abandoned one. Where a fact is not established — Backlog.md's dependency edges, for instance — it is marked unverified and **fails closed**, because a private dependency graph other tools cannot see is shadow data.

**Nothing is ever installed for you.** `bd init` stages files, edits agent integrations, and can create a commit, so Night Orders prints the command and its side effects and lets you run it.

**Next in M0:** the operational overlay — `TaskRef`, `BackendGrant`, and the `Claim` lease with a fencing generation, which is the record that makes dispatch a compare-and-swap rather than a race — plus the built-in local task store as a fallback, and issues in the default report.

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

## Milestones

| | | |
|---|---|---|
| M0 | discovery, graph adapters, leases, CLI | `npx nightorders` shows what is in flight — **useful before it is autonomous** |
| M1 | runners, worktrees, first builder | one task goes queued → branch → commit unattended |
| M2 | capability probes, secrets, briefing | fill one gap, three tasks start |
| M3 | decisions, evidence, web view | a park renders as one screen, answerable on a phone |
| M4 | the loop | **queue twelve, sleep, wake to PRs — with near-zero idle spend** |

Deferred until M4 earns them: the spatial board, multiplayer, in-browser terminals, Postgres, RBAC.

M4 is the product. M0 is what makes anyone install it long enough to reach M4.

## Not competing with

[**agor**](https://github.com/preset-io/agor) owns the execution-plane category and does it well — browser UI, six runtimes, multiplayer, a spatial board. It optimizes for a team steering agents *live*; we optimize for nobody being awake. It is BSL 1.1; this is MIT.

[**firstmate**](https://github.com/kunchenguid/firstmate) proves the orchestrator role works as conventions plus tmux, with no UI and no schema. Its event-driven bash watcher is where the zero-token supervision rule came from. Our bet is that the same role is better with a typed decision record and a browser you can answer from.

## Credits

The workflow this formalizes comes from [Jason Ku's agentic engineering session](https://youtu.be/Ukju3maxbEQ) and his [`agents-md-snippets`](https://github.com/jasonku09/agents-md-snippets), plus Kun Chen's `treehouse`, `no-mistakes`, `gnhf`, `tasks-axi`, and `axi`. The design was reviewed adversarially by Codex; the appendix in `docs/DESIGN.md` lists every claim that review falsified, because the corrections are more useful than a clean spec would have been.
