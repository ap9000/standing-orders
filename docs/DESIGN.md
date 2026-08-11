# Muster — design v0.2

A control plane for fleets of coding agents.

**Status:** design, pre-M0. Nothing is built yet.
**Supersedes:** v0.1, after an adversarial review by Codex that falsified several of its claims. Changes are listed in the appendix.

---

## 1. What this is

Muster owns four things and deliberately nothing else:

| | |
|---|---|
| **Work graph** | tasks, dependencies, priority, holds, acceptance criteria |
| **Scheduler** | what runs, where, and whether it is safe to start |
| **Attention surface** | typed things waiting on a human — decisions and setup gaps |
| **Event log** | append-only; every view is a projection |

Worktrees, the review gate, credential storage, and the agents themselves are **not** owned. They are adapters over tools that already do those jobs well.

The daemon holds metadata. **Runners** on each machine hold the repositories, the credentials, and the execution. Runners pull work and push events; the control plane never reaches into a runner.

```
   web UI          muster CLI          (MCP bridge, later)
      └────────────────┼────────────────────┘
                       ▼
        ┌──── CONTROL PLANE ── muster serve ─────┐
        │  graph · scheduler · attention · log   │
        │  SQLite (single user) · Postgres (team)│
        └────┬──────────────────────────┬────────┘
             │  pull work / push events
      ┌──────▼────────┐        ┌────────▼───────┐
      │ runner @ mbp  │        │ runner @ linux │
      │ repos · creds │        │ repos · creds  │
      │ worktrees     │        │ worktrees      │
      │ agents · gate │        │ agents · gate  │
      └───────────────┘        └────────────────┘
```

---

## 2. Why a small core (corrected thesis)

**v0.1 claimed:** GUI-first orchestrators die; CLI-first primitives that own state survive.

**That claim is false**, and the v0.1 document's own data refuted it. Orca (41.8k★, desktop) and Agent Orchestrator (9.2k★, desktop) are both actively developed. cc-haha (14k★, desktop) shipped the same week. Meanwhile container-use and agentapi — both CLI/daemon primitives — had gone months without a push. Last-push age conflates shutdown, pivot, maintenance mode, slow-stable development, and repository migration. It is not a mortality signal.

**The corrected argument is about maintenance surface, not interface.**

opcode reached 22k★ and then stopped: a wide desktop surface tightly coupled to one fast-moving agent CLI produced a maintenance queue no one could drain. vibe-kanban's shutdown post cites commercial failure — thousands of daily users, almost all free — not obsolescence.

Both failures are about **surface you must maintain against a substrate you do not control**. The defence is not "be a CLI." It is:

1. Own durable state that agent CLIs have no interest in owning — a graph, a lease, a decision record.
2. Keep anything touching fast-moving vendors behind narrow, versioned, contract-tested adapters.
3. Ship no feature that a coding agent's own roadmap will obviously eat.

That argument still yields a small core. It just does not get to sneer at GUIs.

### Prior art this does not duplicate

| Tool | Owns | Relationship |
|---|---|---|
| `treehouse` | pooled worktrees with durable leases | adapter; **its lease semantics are copied wholesale** |
| `no-mistakes` | blocking review gate → PR | adapter |
| `beads` / `Backlog.md` | dependency-graph issue state | import source; overlaps — see §11 |
| `gnhf` | overnight loop, failure taxonomy | **state machine adopted, not reinvented** |
| `Orca` / `Agent Orchestrator` | desktop ADE, terminals, PR views | not competing |
| `sandcastle` | sandboxed orchestration, schema repair | mechanism borrowed |
| `axi` | agent-ergonomic CLI design | **the CLI conforms to it** |

Muster is not the first tool to pitch "sleep, wake to finished work" — gnhf's tagline is literally that, and Orca ships phone steering. v0.1 claimed otherwise; that was wrong.

**What is actually unclaimed:** a *typed, server-validated* record of what needs a human, separate from the transcript that produced it.

---

## 3. Data model

Every record carries `workspace_id` and `actor_id`. Every mutation takes an `idempotency_key` and is safe to retry.

**Task**
```
id · workspace · actor · repo · title · body
priority · state · acceptance_criteria[]
depends_on[]              -- edges are their own table, not an array column
hold { reason, kind, until }
zones[]                   -- protected-path hints ONLY; see §4
```

**Run**
```
id · task · runner · role          -- planner|builder|driver|reviewer|repair
base_revision · branch · worktree_path
provider · model · effort · tokens_in · tokens_out
state · parent_run · caused_by_event
started_at · ended_at
```

**Claim** *(new — the most important addition in v0.2)*
```
id · task · runner
lease_id                  -- immutable, per-acquisition, random
lease_generation          -- monotonic fencing token
expires_at · heartbeat_at
```
Dispatch is a compare-and-swap on `(task, lease_generation)`. Completion is rejected if the generation moved. A runner that dies holding a lease is reclaimed on expiry and its late completion is fenced out. Without this the scheduler is a race-condition generator — the sharpest finding in review.

**Decision**
```
id · run · urgency · kind · state    -- open|answered|expired|superseded
recap · question
options[] { option_id, label, consequence, reversible }
recommendation → option_id
evidence[] { kind, artifact_ref }
assignee · deadline · answer · answered_by · schema_version
```

**Capability** *(new)*
```
id · repo · kind                     -- env|mcp|cli|auth|quota
name · required_by[] · probe
status                               -- unknown|missing|present|expired|failing
last_verified_at · expires_at
```
**There is no value column, and there never will be.** See §6.

**SetupRequest** *(new)*
```
id · capability · blocks_count
instructions · verify_command · state
```
Deliberately *not* a Decision: no options, no recommendation, no evidence. A missing key is not a judgement call.

**Runner**
```
id · host · credential_hash · scopes[] · expires_at
repos[] · capacity · agents[] · quotas[] · last_heartbeat
```
Hashed credential and scopes — never a bearer token in a projection.

**Artifact** *(new)*
```
id · run · kind                      -- screenshot|log|diff|test-report
runner_ref · size · retention_until · redacted
```
Evidence lives on the runner; the control plane stores a reference and serves it through a signed, short-lived runner proxy. "Metadata only" was violated in v0.1 the moment screenshots appeared in a mockup — this is the honest fix.

**Event**
```
seq · event_id · at · actor · workspace
kind · aggregate · aggregate_version
causation_id · correlation_id · schema_version · payload
```

**Notification** *(new)*
```
id · subject · channel · dedupe_key
attempts · last_attempt_at · delivered_at · receipt
```

---

## 4. The scheduler

A task dispatches only when all of these hold:

1. **Dependencies satisfied** — every `depends_on` edge closed.
2. **No active hold** — holds carry a reason and optional expiry.
3. **Capacity exists** — a runner has this repo, a free slot, an adapter for the role's agent, **and remaining provider quota**. A free CPU slot against an exhausted Claude quota is not capacity.
4. **Capabilities verified** — every required `Capability` is `present` and freshly probed. See §6.
5. **Claim acquired** — compare-and-swap on the lease generation. Losing the CAS is normal, not an error.
6. **Attention budget** — if open decisions ≥ `--max-open-decisions` (default 5), stop dispatching work in zones whose historical park rate exceeds threshold. Measured from the event log, not predicted.

### What happened to glob-collision detection

v0.1 proposed refusing to dispatch tasks whose declared file globs overlapped an in-flight run. **Cut.** Tasks cannot honestly predict their file surface before exploring the codebase: broad globs serialize unrelated work, narrow ones miss generated files, lockfiles, shared types, snapshots, and migrations. Inferring them with a cheap model converts uncertainty into authoritative-looking bad data.

Replaced by three things that work:

- **Branch isolation is the concurrency boundary**, not a predicted write-set.
- **`zones[]` survive only as policy** — protected paths (migrations, auth, CI, lockfiles) route to a stricter gate and feed advisory scheduling scores.
- **Real overlap is computed after the fact**, via `git diff --name-only <base>...<branch>` across in-flight branches, surfaced before integration. Only possible because of §6's ingestion.

---

## 5. Role routing

Agent selection is two independent axes, and conflating them costs money.

**Tier is economics.** A park → decide → resume roundtrip costs roughly **30k tokens on a cheap driver against 200k on the builder**, because the builder holds 150–200k of context resent on every gate turn.

**Provider is correctness.** A reviewer from a different vendor catches a different bug distribution and spreads load across two subscriptions.

| Role | Provider | Tier | Context | Why |
|---|---|---|---|---|
| Planner | claude | Opus 5 | interactive | Interrogates the spec until ambiguity is gone |
| Builder | claude | Opus 5 | 150–200k | Builds, commits, emits `HANDOFF: INTENT` |
| Driver | claude | **Sonnet 5** | few-k | Runs the gate: many cheap turns, tiny context |
| Reviewer | codex | — | fresh | Cross-provider; reviewing in the authoring session inherits its blind spots |
| Repair | claude | Opus 5 | resumed | See below |

Config, not law. `Run` records resolved provider, model, and token counts, so role cost is measured rather than asserted.

**Correction from v0.1:** the doc said a builder "dies, never resumed." That over-stated the source. The real rule is narrower — a builder is never resumed *to drive the gate*, but **is** resumed when a finding needs real code fixes. Discarding the only context that can cheaply repair its own change is wasteful. Hence the `repair` role, with an explicit causal link to the finding that triggered it.

---

## 6. Capabilities, environment, and secrets

The highest-frequency overnight failure is not a bad design decision. It is a missing or expired credential, discovered at 3am after an agent has burned 40k tokens flailing.

### Detect before dispatch

Capabilities are inferred from what is already on disk — `.env.example`, `.mcp.json`, `supabase/config.toml`, CI workflow `env:` blocks — and each carries a cheap liveness probe:

```
gh auth status                       auth
supabase projects list               api
mcp initialize <server>              mcp handshake
test -n "$STRIPE_SECRET_KEY"         env presence
```

**Presence is not enough.** An expired key is worse than a missing one, because the agent pays to discover it. Probes run at enrollment and at every checkpoint.

### Where values live

**The control plane stores metadata about secrets and never their values.**

- **Control plane:** name, scope, which repos need it, status, last-verified, expiry.
- **Values:** on the runner — OS keychain (Keychain / libsecret / Credential Manager), a gitignored `.env`, or an existing manager (`op read`, Doppler, `gh secret`).
- **The UI writes to the runner, not the database.** A value pasted in the browser travels over the local runner connection into the keychain. The control plane records only `present, verified at T`.

In team mode this is the difference between a shared backlog and a shared breach: a colleague's control plane must never see your keys. Event log and agent transcripts are redacted by the same rule.

**Boundary:** the human pastes credentials. Agents never do. Muster reports exactly what is missing and how to obtain it; it does not type keys on anyone's behalf.

### Repos are the easy part

Onboarding needs no OAuth app, client secret, or callback server, because `git` and `gh` are already authenticated on the machine. The whole discovery pass is read-only shell:

```sh
git worktree list --porcelain
git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads
gh repo list  --json name,defaultBranchRef,pushedAt
gh pr list    --json number,headRefName,statusCheckRollup
gh issue list --json number,title,labels
```

**Discovery is total and read-only; management is opt-in per repo.** Muster indexes everything it can see and drives only what you enrolled. Anything unenrolled is visible context it must not touch.

Adoption, not discovery, is the hard part — a dirty working tree, a worktree your terminal is sitting in, a branch with a live PR. treehouse's rules apply: untracked files count as dirty even when repo config hides them; in-use is detected from running processes; reconstructed state is marked leased-until-verified.

---

## 7. The checkpoint

One daily ritual, not two. Opening Muster shows three queues, and gaps rank by **how many tasks they unblock** — never alphabetically.

```
muster ── good morning ───────────────────────────
  overnight   7 PRs · 2 aborted · 412k tokens
  ▸ BLOCKED   1 gap unblocks 3 tasks
      SUPABASE_SERVICE_ROLE_KEY — oddcircle
      expired 2d ago   [paste] [verify]
  ▸ DECIDE    3 waiting
  ▸ REVIEW    7 PRs
```

Notifications are a **durable outbox**, not a fire-and-forget call: delivery attempts, dedupe keys, receipts, escalation, per-assignee routing, quiet hours, deep links to the exact decision. An inbox nobody opens is not an overnight control plane.

---

## 8. The overnight loop

**Parking never stalls the loop.** A blocked task steps aside and the scheduler returns to the ready set.

Failure handling is adopted from gnhf rather than reinvented, including the parts v0.1 omitted:

- agent-reported failure → next iteration immediately
- retryable infrastructure error → exponential backoff
- permanent error (exhausted credit, revoked auth) → abort, print run log
- **commit failure → preserve the work for repair**; do *not* `git reset --hard`
- complete no-op iteration → counts as a failure
- 3 consecutive failures → abort
- mid-iteration token cap, graceful stop, persisted notes, resume, permanent exit summary

Rollback proves worktree cleanliness and base revision first. A blanket `git reset --hard` leaves untracked files behind and can destroy repairable work.

**Malformed agent output gets bounded repair, not an instant 422.** On schema failure the adapter resumes the same session with a compact error so the agent re-emits only the bad payload (sandcastle's mechanism), up to two attempts, then emits a distinct `malformed_decision` failure. A typed inbox that hard-fails on first malformed park is aspirational rather than operational.

**Irreversible options never auto-apply**, regardless of stated confidence. `reversible` is a field, so the scheduler enforces it.

---

## 9. Interfaces

### CLI is primary, and it is an AXI

Not "the same API for everyone" — the same *service*, with a surface shaped for each caller. Per `axi`: TOON output by default, 3–4 field default schemas, truncation with `--full`, precomputed aggregates, definitive empty states, idempotent writes, structured errors, contextual next-step hints.

```sh
muster                      # content-first: ready work, active runs, blockers
muster ready --runner mbp
muster show oc-42 --full
muster park run_7f3 --recap-file r.md --option "Keep + backfill" \
                    --option "Drop it:irreversible" --recommend 0
muster done oc-42 --pr https://github.com/ap9000/muster/pull/12
```

`--json` remains the automation escape hatch.

**MCP is deferred past M4.** For agents with shell access an AXI-style CLI is cheaper, easier to debug, and less adapter surface. MCP returns later as a thin bridge if users ask. (v0.1 also claimed the MCP client "speaks the same HTTP + SSE API" — it does not; it speaks MCP to a bridge.)

### Web UI

Three views: **checkpoint** (home), **board**, **graph**. It exists for the two jobs a terminal genuinely cannot do well — rendering a decision with visual evidence, and pasting/verifying credentials across several repos.

---

## 10. Milestones

For one person working with agents. v0.1 claimed ~7 weeks for all six; that was fantasy, principally at M5.

| | Scope | Ships when |
|---|---|---|
| **M0** | Graph, dependency edges, **Claim/lease with fencing**, idempotency keys, SQLite store, AXI CLI, **repo + branch + PR + issue ingestion**. No agents run. | `muster` shows what is in flight across every repo |
| **M1** | Runner registration **with auth from the first commit**, heartbeat, treehouse lease adapter, claude builder, reconciliation for dead runner / orphaned worktree / duplicate completion. | one task goes queued → branch → commit unattended |
| **M2** | Capability probes, SetupRequest, secrets-on-runner, checkpoint UI, notification outbox. | you fill one gap and three tasks start |
| **M3** | Decision schema + validation + schema repair, driver role, evidence artifacts, web decision view. | a park renders as one screen, answerable on a phone |
| **M4** | Overnight loop, gnhf failure taxonomy, quota-aware scheduling, crash/duplicate/disconnect survival. | queue twelve, sleep, wake to PRs and a short checkpoint |
| **M5** | Workspace / Actor / Membership / Role records, Postgres store, export–import. | two people, one graph |

M5 is not "UI and policy" — v0.1 said the schema already supported it, which was untrue. There were no Workspace, Actor, Membership, or Role records at all.

**Export–import lands with M5 at the latest.** vibe-kanban had to bolt export on at shutdown. A state moat without an exit is lock-in to an experimental daemon.

The honest definition of done for v1: **one complete SQLite overnight loop that survives crashes, duplicate messages, exhausted quotas, malformed agent output, and a disconnected runner.** Everything else earns its way back after that.

---

## 11. Open questions

1. **Overlap with beads.** beads (26k★) already does dependency-graph work state with branch-aware sync. Is Muster's graph a thin projection over an existing tracker rather than a competing store? Resolving this before M0 could remove a third of the build.
2. **Does the loop ever push to `main`?** Recommendation: never — a PR terminus is the only reason the gate is trustworthy.
3. **License.** MIT matches orca, no-mistakes, cc-haha; Apache-2.0 matches agent-orchestrator and adds patent cover.
4. **Name.** `muster` availability on npm and GitHub is unchecked. Alternates: `marshal`, `blockpost`, `signalbox`.

---

## Appendix — changes from v0.1

**Falsified and removed**

- "Every GUI-first orchestrator has stalled" — contradicted by the doc's own table.
- "No other tool is pitching that" — gnhf and Orca both do.
- "Every adapter ships with a fallback" — the builder row had none.
- "Every record carries workspace_id and actor_id" — only Task did.
- "The schema already supports all of it" (M5) — no such records existed.
- "You review evidence, never a raw diff" — evidence prioritizes review, it does not replace it.
- "Builder dies, never resumed" — over-stated; repair resumption is correct.
- Glob-collision as a hard dispatch gate — unimplementable as specified.
- "Sixteen projects" over a table of fourteen.

**Added**

Claim/lease with fencing · idempotency keys · dependency edges as a table · Capability · SetupRequest · Artifact · Notification outbox · secrets-on-runner · repo/branch/PR ingestion · role routing by tier and provider · quota-aware capacity · schema-repair retries · gnhf failure taxonomy · repair role · export–import · runner auth at M1 · event causality and versioning.

**Sources.** Design review by Codex (default model and effort, read-only, 2026-08-10). Landscape figures gathered 2026-08-10 via the GitHub API and are point-in-time. Workflow patterns from Jason Ku's *A Meta Engineer's Agentic Engineering Workflow* and the `agents-md-snippets`, `no-mistakes`, `treehouse`, `gnhf`, `tasks-axi`, and `axi` repositories. Several review citations — a vibe-kanban shutdown post, HumanLayer PR #646, agentapi v0.12.2 dates — are Codex's and have not been independently verified.
