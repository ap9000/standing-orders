# Muster

A control plane for fleets of coding agents.

> **Status: design only.** No code yet. The architecture lives in [`docs/DESIGN.md`](docs/DESIGN.md) (v0.2).

Muster owns the **work graph**, the **scheduler**, the **attention surface** — the typed queue of things waiting on a human — and an append-only **event log**.

It does not own worktrees, the review gate, credential storage, or the agents. Those are adapters over tools that already do those jobs well: [`treehouse`](https://github.com/kunchenguid/treehouse), [`no-mistakes`](https://github.com/kunchenguid/no-mistakes), `claude`, `codex`.

The daemon holds metadata. **Runners** on each machine hold the repositories, the credentials, and the execution.

## The idea

Two things agents are bad at, that a control plane can be good at:

**Knowing when to stop and ask.** A parked decision is a validated record — recap, options with reversibility, a recommendation, evidence — not a transcript you have to read. It renders the same way every time and fits on a phone.

**Knowing it cannot start.** The most expensive overnight failure is a missing or expired credential found at 3am, after an agent has burned 40k tokens discovering it. Capabilities are probed before dispatch, and gaps rank by how many tasks they unblock.

## Where it is going

| | | |
|---|---|---|
| M0 | graph, leases, ingestion, CLI | `muster` shows what is in flight across every repo |
| M1 | runners, worktrees, first builder | one task goes queued → branch → commit unattended |
| M2 | capabilities, secrets, checkpoint UI | fill one gap, three tasks start |
| M3 | decisions, evidence, web view | a park renders as one screen |
| M4 | the overnight loop | queue twelve, sleep, wake to PRs |
| M5 | workspaces, Postgres, export | two people, one graph |

Done means one complete overnight loop that survives crashes, duplicate messages, exhausted quotas, malformed agent output, and a disconnected runner.

## Open before M0

- Whether the graph should be a projection over [`beads`](https://github.com/gastownhall/beads) rather than a competing store.
- License — MIT or Apache-2.0.
- The name. `muster` availability is unchecked.

## Credits

The workflow this formalizes comes from [Jason Ku's agentic engineering session](https://youtu.be/Ukju3maxbEQ) and his [`agents-md-snippets`](https://github.com/jasonku09/agents-md-snippets), plus Kun Chen's `treehouse`, `no-mistakes`, `gnhf`, and `axi`. The design was reviewed adversarially by Codex; §2 of the design doc exists because that review falsified the original thesis.
