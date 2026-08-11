# Night Orders

**Standing orders for your agents. Wake me only for these.**

> **Status: design only.** No code yet. The architecture lives in [`docs/DESIGN.md`](docs/DESIGN.md) (v0.4).

A captain's night orders are the written standing instructions left for the officer of the watch: *proceed on this course without me, and wake me under exactly these conditions.* That is the product.

Night Orders is a control plane for coding agents, optimized for the case where **the operator is asleep**. It owns the scheduler, the attention surface — the typed queue of things waiting on a human — and an append-only event log.

It owns a deliberately small local task store, adapts richer trackers when they are already there, and owns no worktree pool, no review gate, and no agents. Those are adapters over [`beads`](https://github.com/gastownhall/beads), [`treehouse`](https://github.com/kunchenguid/treehouse), [`no-mistakes`](https://github.com/kunchenguid/no-mistakes), `claude`, and `codex`.

## Two claims

**Sixty seconds to first value.**

```sh
npx nightorders     # no init, no daemon start, no wizard, no OAuth app
```

It walks the filesystem for `.git` and reads branches, PRs, and open issues through the `git` and `gh` credentials already on your machine — then shows you everything in flight across every repo. No agent has run. Nothing has been configured. Every other tool in this space starts from an empty database it expects you to fill.

The same pass detects your work graph and picks one, rather than asking:

```
Work graph — detected in your repos
▸ beads          .beads/ in 2 repos · 47 open · native deps · runtime ok
  GitHub Issues  112 open across 6 repos · native deps · gh 2.67 too old
  built-in       local task store · nothing to install
Nothing is enrolled. `nightorders enroll <repo>` grants write access.
```

Detection is not authorization, and **nothing is ever installed for you** — `bd init` stages files and can create a commit, so Night Orders prints the command and its side effects and lets you run it.

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
