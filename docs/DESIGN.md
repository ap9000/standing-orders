# Night Orders — design v0.3

**Standing orders for your agents. Wake me only for these.**

Status: design, pre-M0.
v0.3 repositions around two axes after finding [agor](https://github.com/preset-io/agor). v0.2's architecture survives; its scope does not.

---

## 1. The bet

A captain's night orders are written standing instructions for the officer of the watch: *proceed on this course without me, and wake me under exactly these conditions.* The name is the specification.

Two claims, and everything else serves them:

**Sixty seconds to first value.** You run one command and immediately see every branch, PR, and open issue in flight across every repo on the machine — before configuring anything, before an agent runs.

**It survives the night.** Work dispatches itself from a dependency graph, fails safely, and parks a typed decision instead of guessing. In the morning you read a briefing, not a transcript.

Everything below is downstream of those two.

---

## 2. Positioning

[agor](https://github.com/preset-io/agor) (preset-io, TypeScript, BSL 1.1) already owns the execution-plane category: self-hosted daemon, browser UI, six interchangeable agent runtimes, branches with isolated dev environments, MCP-native self-driving sessions, multiplayer with branch-scoped RBAC, per-user credentials, per-prompt token *and dollar* accounting. It is well built and shipping.

**We do not compete on that surface.** Specifically deferred, and not because they are bad ideas:

- the spatial board / zones canvas — agor's signature, and expensive to match
- live multiplayer cursors and comments
- in-browser terminals and dev-server management

What agor does *not* do, from its own documentation:

| | agor | Night Orders |
|---|---|---|
| Getting started | `init` → `daemon start` → `open` → add repo → wizard | one command, zero config, reads what is already on disk |
| Dispatch | manual — drag a branch into a zone to fire a prompt | automatic — dependency graph with a ready-query |
| Unattended | `schedules` fire prompts on a timer | a loop with a failure taxonomy, leases, and rollback |
| Blocked on a human | conversation history | typed, validated decision record |
| Missing credential | per-user env vars you set in advance | probed before dispatch; gaps ranked by tasks unblocked |

Two products can share an architecture and still differ entirely in what they optimize. Agor optimizes for a team steering many agents *live*. Night Orders optimizes for one person who is asleep.

**Licence: MIT.** agor is BSL 1.1 — source-available, not open source. A permissively-licensed tool in this slot has room theirs structurally cannot occupy.

### What we still delegate

`treehouse` (worktree pool + lease semantics, copied wholesale) · `no-mistakes` (review gate) · `beads` / `Backlog.md` / GitHub Issues (graph import — see §9) · `gnhf` (failure taxonomy, adopted not reinvented) · `sandcastle` (schema repair) · `axi` (CLI shape).

---

## 3. Onboarding

The wedge. Everything here is read-only and uses credentials that already exist — `git` and `gh` are authenticated on the machine, so there is **no OAuth app, no client secret, no callback server, no token to store.**

```sh
npx nightorders            # no init, no daemon start, no wizard
```

First run walks the filesystem for `.git`, then for each repo:

```sh
git worktree list --porcelain
git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads
git diff --name-only <base>...<branch>
gh pr list    --json number,headRefName,statusCheckRollup
gh issue list --json number,title,labels
```

and prints what is in flight. **No agent has run. Nothing has been configured.** That output alone is worth installing for — it is the thing no dashboard gives you today, because every other tool starts from an empty database it expects you to fill.

**Discovery is total and read-only; management is opt-in per repo.** Night Orders indexes everything it can see and drives only what you enroll. Anything unenrolled is visible context it must not touch.

Adoption is the hard part, not discovery. A dirty tree, a worktree your terminal is sitting in, a branch with a live PR. treehouse's rules apply: untracked files count as dirty even when repo config hides them; in-use is detected from running processes; reconstructed state is marked leased-until-verified.

### Capability preflight

The most expensive overnight failure is a missing or expired credential found at 3am, after an agent has burned 40k tokens discovering it.

Capabilities are inferred from what is already on disk — `.env.example`, `.mcp.json`, `supabase/config.toml`, CI `env:` blocks — and each carries a cheap liveness probe:

```
gh auth status · supabase projects list · mcp initialize <server> · test -n "$KEY"
```

**Presence is not enough**; an expired key costs more than a missing one. Probes run at enrollment and at every checkpoint, and a task whose capabilities are not *verified* does not dispatch.

### Secrets

**The control plane stores metadata about secrets and never their values.**

- Control plane: name, scope, which repos need it, status, last-verified, expiry.
- Values: on the runner — OS keychain, a gitignored `.env`, or an existing manager (`op read`, Doppler, `gh secret`).
- The UI writes to the runner, not the database. A value pasted in the browser travels over the local runner connection into the keychain; the control plane records only `present, verified at T`.

The human pastes credentials. Agents never do.

---

## 4. The night

### The loop

Parking never stalls it. A blocked task steps aside and the scheduler returns to the ready set.

```
tick ─► gates ─► claim ─► lease worktree
                            │
                   BUILDER (Opus, 150–200k)
                   spec → failing test → implement → verify
                   commit · HANDOFF: INTENT
                            │
                   DRIVER (Sonnet, few-k, fresh)
                   runs the gate adapter
              ┌─────────────┼─────────────┐
         auto-fixable   needs a human    green
         apply          PARK → briefing  open PR
              └─────────► tick ◄─────────┘
```

### Surviving it

Adopted from gnhf rather than reinvented, including the parts most tools omit:

- agent-reported failure → next iteration immediately
- retryable infrastructure error → exponential backoff
- permanent error (exhausted credit, revoked auth) → abort, print run log
- **commit failure → preserve the work for repair**; never blanket-reset
- complete no-op iteration → counts as a failure
- three consecutive failures → abort
- mid-iteration token cap · graceful stop · persisted notes · resume · permanent exit summary

Rollback proves worktree cleanliness and base revision first. `git reset --hard` leaves untracked files behind and can destroy repairable work.

**Malformed agent output gets bounded repair, not an instant 422.** On schema failure the adapter resumes the same session with a compact error so the agent re-emits only the bad payload (sandcastle's mechanism), twice, then emits `malformed_decision`.

**Irreversible options never auto-apply**, regardless of stated confidence. `reversible` is a field, so the scheduler enforces it.

### The morning

One ritual. Gaps rank by **how many tasks they unblock** — never alphabetically.

```
nightorders ── good morning ──────────────────────
  overnight    7 PRs · 2 aborted · 412k tokens · $18.40
  ▸ BLOCKED    1 gap unblocks 3 tasks
       SUPABASE_SERVICE_ROLE_KEY — oddcircle
       expired 2d ago    [paste] [verify]
  ▸ DECIDE     3 waiting
  ▸ REVIEW     7 PRs
```

Notifications are a **durable outbox** — attempts, dedupe keys, receipts, escalation, quiet hours, deep links. An inbox nobody opens is not an overnight control plane.

---

## 5. The decision record

The convention agents drift from in prose becomes a schema the server validates. `POST /runs/:id/park` returns **422** without a recap, options, and a recommendation.

```json
{
  "urgency": "blocking",
  "recap": "Tightening the onboarding form. The agent added a migration
            dropping `signup_source`, which analytics reads.",
  "question": "Drop the column, or keep it and backfill?",
  "options": [
    { "label": "Keep + backfill", "reversible": true,
      "consequence": "Analytics unaffected. +1 migration." },
    { "label": "Drop it", "reversible": false,
      "consequence": "3 dashboards break silently." }
  ],
  "recommendation": 0,
  "evidence": [{ "kind": "diff" }, { "kind": "screenshot" }, { "kind": "test" }]
}
```

Because it is a typed record rather than a transcript, it renders identically every time and fits on a phone. `reversible` being a *field* is what lets the scheduler refuse to auto-apply it.

A missing credential is **not** this. `SetupRequest` has its own, simpler shape — what is missing, what it blocks, how to supply it, how we verify. No options, no recommendation. A missing key is not a judgement call.

---

## 6. Data model

Every record carries `workspace_id` and `actor_id`. Every mutation takes an `idempotency_key`.

| Record | Carries |
|---|---|
| **Task** | repo · title · body · priority · state · acceptance_criteria[] · depends_on (own table) · hold{reason,until} · zones[] |
| **Run** | task · runner · role · base_revision · branch · provider · model · tokens · parent_run · caused_by_event |
| **Claim** | task · runner · `lease_id` (immutable) · `lease_generation` (fencing) · expires_at · heartbeat_at |
| **Decision** | run · urgency · state · recap · question · options[{id,label,consequence,reversible}] · recommendation · evidence[] · assignee · deadline |
| **Capability** | repo · kind · name · required_by[] · probe · status · last_verified_at · expires_at — **no value column, ever** |
| **SetupRequest** | capability · blocks_count · instructions · verify_command |
| **Runner** | host · credential_hash · scopes[] · repos[] · capacity · agents[] · quotas[] · heartbeat |
| **Artifact** | run · kind · runner_ref · retention_until · redacted |
| **Event** | seq · event_id · actor · aggregate · aggregate_version · causation_id · correlation_id · schema_version |
| **Notification** | subject · channel · dedupe_key · attempts · delivered_at · receipt |

**Claim is the one that matters.** Dispatch is a compare-and-swap on `(task, lease_generation)`; completion is rejected if the generation moved. A runner that dies holding a lease is reclaimed on expiry and its late completion fenced out. Without it there is no scheduler, only a race.

Evidence lives on the runner; the control plane stores a reference and serves it via a signed, short-lived runner proxy.

---

## 7. Dispatch gates

1. **Dependencies satisfied** — every `depends_on` edge closed.
2. **No active hold.**
3. **Capacity** — a runner has this repo, a free slot, the role's agent, **and remaining provider quota.** A free CPU slot against an exhausted quota is not capacity.
4. **Capabilities verified** — §3.
5. **Claim acquired** — CAS on the lease generation. Losing is normal, not an error.
6. **Attention budget** — above `--max-open-decisions` (default 5), stop dispatching work in zones whose measured park rate exceeds threshold.

**Cut from v0.2:** refusing dispatch on predicted file-glob overlap. Tasks cannot honestly predict their file surface before exploring, and inferring it converts uncertainty into authoritative-looking bad data. Branch isolation is the concurrency boundary; `zones[]` survive only as protected-path policy and advisory scoring; real overlap is computed after the fact from `git diff --name-only` across in-flight branches, before integration.

---

## 8. Role routing

Two independent axes, and conflating them costs money. **Tier is economics** — a park → decide → resume roundtrip is ~30k tokens on a cheap driver against ~200k on the builder, which holds 150–200k of context resent every gate turn. **Provider is correctness** — a different vendor catches a different bug distribution.

| Role | Provider | Tier | Context |
|---|---|---|---|
| Planner | claude | Opus 5 | interactive |
| Builder | claude | Opus 5 | 150–200k |
| Driver | claude | **Sonnet 5** | few-k |
| Reviewer | codex | — | fresh |
| Repair | claude | Opus 5 | resumed |

Config, not law. `Run` records the resolved provider, model, and tokens, so role cost is measured rather than asserted — and the morning briefing reports real dollars.

A builder is never resumed *to drive the gate*, but **is** resumed when a finding needs real code fixes. Discarding the only context that can cheaply repair its own change is wasteful.

---

## 9. Milestones

Re-cut around the two claims in §1. One person working with agents.

| | Scope | Ships when |
|---|---|---|
| **M0** | Zero-config discovery, graph, dependency edges, **Claim/lease with fencing**, idempotency, SQLite, AXI CLI. No agents run. | `npx nightorders` shows every branch, PR, and issue in flight. **Useful before it is autonomous.** |
| **M1** | Runner registration **with auth from the first commit**, heartbeat, treehouse adapter, claude builder, reconciliation for dead runner / orphaned worktree / duplicate completion. | one task goes queued → branch → commit unattended |
| **M2** | Capability probes, SetupRequest, secrets-on-runner, morning briefing, notification outbox. | fill one gap, three tasks start |
| **M3** | Decision schema, validation, bounded schema repair, driver role, evidence artifacts, web decision view. | a park renders as one screen, answerable on a phone |
| **M4** | The loop: gnhf failure taxonomy, quota-aware scheduling, survives crash / duplicate / disconnect. | **queue twelve, sleep, wake to PRs and a short briefing** |
| — | *deferred:* spatial board and zones, multiplayer, in-browser terminals, Postgres, RBAC, export | after M4 earns them |

M4 is the product. M0 is what makes anyone install it long enough to reach M4.

Done means one complete SQLite overnight loop that survives crashes, duplicate messages, exhausted quotas, malformed agent output, and a disconnected runner.

---

## 10. Open before M0

1. **beads.** It already does dependency-graph work state with a ready-query and branch-aware sync, at 26k★. Is our graph a projection over it rather than a competing store? That would remove roughly a third of M0 and buy instant interop — at the cost of not owning the state. **Decide before writing schema.**
2. **Does agor already have an approval primitive?** If so the decision record is a PR to them, not a feature here.
3. **Does the loop ever push to `main`?** Recommendation: never. A PR terminus is the only reason the gate is trustworthy.
4. **CLI alias.** `nightorders` is twelve characters and `no` is unusable as a shell alias.

---

## Appendix — history

**v0.3** repositions on onboarding + unattended operation after finding agor; explicitly defers the spatial board, multiplayer, RBAC, and Postgres; makes MIT a stated differentiator against agor's BSL 1.1; promotes zero-config discovery from a feature to the wedge.

**v0.2** followed an adversarial Codex review that falsified v0.1's thesis. Removed: "every GUI-first orchestrator has stalled" (contradicted by the doc's own table — Orca and Agent Orchestrator are desktop and thriving); "no other tool is pitching that" (gnhf and Orca both do); "every adapter ships with a fallback"; "every record carries workspace_id"; "the schema already supports all of it"; "builder dies, never resumed" (over-stated — repair resumption is correct); glob-collision as a dispatch gate. Added: Claim/lease with fencing, Capability, SetupRequest, Artifact, Notification outbox, secrets-on-runner, ingestion, role routing, quota-aware capacity, schema repair, gnhf taxonomy, runner auth at M1.

The corrected argument for a small core is **maintenance surface**, not interface. opcode reached 22k★ and stopped because a wide desktop surface coupled to one fast-moving agent CLI produced an undrainable maintenance queue. Own durable state agent CLIs do not want; keep vendor-facing surface behind narrow, contract-tested adapters; ship nothing an agent CLI's roadmap will obviously eat.

**Sources.** Codex design review (default model/effort, read-only, 2026-08-10). Landscape figures from the GitHub API, 2026-08-10/11, point-in-time. Workflow patterns from Jason Ku's *A Meta Engineer's Agentic Engineering Workflow* and `agents-md-snippets`, plus `no-mistakes`, `treehouse`, `gnhf`, `tasks-axi`, `axi`. Agor capabilities are from its README, not hands-on use.
