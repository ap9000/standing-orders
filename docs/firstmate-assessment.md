# Standing Orders against firstmate — assessment (2026-09-02)

firstmate (kunchenguid/firstmate, 4.7k★, 521 commits, MIT) has become the
strongest statement of one idea: **talk to one agent, ship with a crew.** It
is an *agent distro* — `AGENTS.md`, skills, and bash tooling that turn a
general coding harness (Claude Code, Codex, Grok, Pi, OpenCode, Cursor) into
a "first mate" that spawns crewmates in isolated worktrees, supervises them
with a zero-token bash watcher, escalates only real decisions to the
"captain", and ships through explicit project modes. This document says
where we stand against it, what "coordinating work this way" would take, and
what we should not copy.

## 1. Where the two products agree

| Idea | firstmate | Standing Orders |
|---|---|---|
| Zero-token supervision | bash watcher + harness turn-end guards; `state/.wake-queue` | `tick`/`watch` passes, leases with fencing, dead-runner reconcile — the daemon never spends |
| Isolated work | pooled git worktrees (treehouse/Orca) per crewmate | leased worktrees per run (treehouse adapter), builds on `standing-orders/<task>` |
| Only real decisions reach the human | watcher classifies wakes; away-mode digests | typed decisions with options, consequences, reversibility; the attention budget |
| Explicit delivery authority | project modes: `no-mistakes`, `direct-PR`, `local-only`, `+yolo` | publication grants (push / open-PR / merge as independent fields), operating modes (automerge on green under a grant), no-mistakes as a gate adapter |
| Restart-proof state | tmux/herdr sessions + append-only status logs + `data/` | SQLite, append-only events, fenced completion, reconcile on start |
| Multiple machines | secondmates (child homes, SSH-reachable) | registered runners, fleet screen, per-runner queues and reservations |

Both refuse to guess: firstmate's spawn "refuses unless base matches" and
"missing … semantic state is unknown, never idle"; ours refuses claims
without an approved scope and fails closed on every ceiling.

## 2. Where we are stronger

- **Typed decisions.** A park is a record with options, consequences, and a
  `reversible` flag; an irreversible answer needs a second tap. firstmate
  escalates prose through chat and `/ahoy` orders it "in agent-judged impact
  order" — the judgement is the model's.
- **No LLM in any approval path.** Scope approval, publication, merge, and
  spend acknowledgement are password ceremonies bound to a digest. firstmate's
  hard rules live in `AGENTS.md` prose the model reads; `no-mistakes` is the
  one mechanical gate.
- **Money.** Every provider spawn is stamped before it spends; measured or
  unmeasured is said in words; daily rails and quotas bound the loop. firstmate
  has no ledger.
- **A phone surface.** The console, the decision page, Telegram both ways.
  firstmate's captain sits in a terminal (Relay to X/Discord and a voice
  relay exist, but the product is the harness session).
- **External trackers.** GitHub issues become scoped local tasks under a
  dispatch grant, bodies never imported. firstmate reads projects directly.

## 3. Where firstmate is stronger — the gaps

1. **One conversation is the whole interface.** You say "fix the flaky login
   test and add dark mode" to the mate; it reads the projects, decides the
   shape, spawns, supervises, and reports back in the same thread. We have
   three doors (console, CLI, Telegram) and a chat that only *drafts* — fleet
   chat (v13) is a no-tool API call that returns at most three task or routine
   proposals; it cannot recap, prioritize, answer, or report.
2. **Recap on demand.** `/ahoy` recaps what happened and walks the open
   decisions; `/bearings` is a fleet digest, `/bearings file` a dated status
   report. Our board has "since you last looked" and `/next` walks decisions,
   but nothing produces a spoken-word recap of the fleet.
3. **Scout tasks.** A task whose deliverable is an investigation report
   (`data/<id>/report.md`), never a branch. Our nearest is `plan first` (a
   planner proposes a scope) and the reviewer; there is no report-shaped task.
4. **Away mode.** `/afk` batches routine notifications into digests and
   escalates only captain-relevant events, with wedge alarms. Our Telegram
   bridge pages every decision; the outbox exists but has no digest cadence.
5. **Fleet memory.** `/stow` sweeps session knowledge into durable notes;
   project knowledge lives in the projects' own `AGENTS.md`. We have per-task
   steering notes and nothing at project level that rides every brief.
6. **The distro shape.** firstmate installs into the harness you already run.
   We are a daemon and a console; an agent can only reach us through the MCP
   gateway, whose six tools (`status`, `list_tasks`, `get_task`, `list_repos`,
   `get_contract`, `file_proposal`) let a coordinator *file*, not steer.

## 4. Coordinating "this way" — what it takes

The honest version of firstmate's promise on our plane: **a conversation
with an agent that proposes everything and decides nothing.** The mate reads
the fleet through the MCP gateway, proposes filings, priorities, reservations,
and *answers* to parked decisions with its evidence, and every proposal lands
in the existing ceremonies — a tap on the phone, a password where the digest
demands it. That keeps the one rule that separates us from every "yolo mode":
the plane never acts on an LLM's word.

Proposed arc — **the mate** (four slices, Codex review after 2 and 4):

1. **Coordinator surface over MCP.** Add proposal tools beside
   `file_proposal`: `recap` (read-only: what waits, what is live, what
   finished since a stamp — the `/ahoy` answer, typed), `propose_answer`
   (a decision id, an option, a rationale; renders on the decision page and
   in Telegram as "the mate suggests … because …", the human taps),
   `propose_priority` / `propose_reservation` (queue proposals, same
   quarantine), `propose_scope` (a rewrite of an unapproved scope, still
   password-sealed). All rate-limited under the coordinator credential, all
   `filed_via: mcp:<name>`, nothing new dispatches.
2. **The distro half.** Ship `skills/mate/` — an `AGENTS.md`-style contract
   plus a Claude Code / Codex skill — so `claude` in any directory with the
   `standing-orders` MCP configured *is* a first mate: intake, routing rules
   per repo, when to propose versus ask, how to report. This is the piece
   that makes "talk to one agent" true without moving authority.
3. **Scout tasks.** A task kind whose deliverable is a report artifact:
   no branch, no publication, the report rendered on the task page and the
   portfolio's ledger, answerable into a follow-up filing. Uses the existing
   evidence store and handoff protocol.
4. **Away mode and memory.** Telegram digests on a cadence (the outbox
   batching routine notifications, decisions still paged singly), and
   project-level standing notes that ride every brief (the `/stow` role),
   written only by an approver.

What not to copy: tmux-window liveness as the source of truth (our leases
already answer that), prose hard rules (ours are tables and transactions),
merge autonomy by flag (`+yolo`) rather than by signed grant, and the
"agent-judged impact order" of decisions — ours are ordered by how long
they have waited, which no model can misjudge.

## 5. Sources

- firstmate README and `docs/architecture.md`, read 2026-09-02.
- Standing Orders: README §"Steering a fleet", `docs/PROGRESS.md` (fleet chat
  v13, MCP gateway arc), `docs/mcp-gateway-spec.md`, `docs/DESIGN.md` §2 and §9b.
