# The mate — spec v2 (2026-09-02, after Codex round 1: fifteen findings)

One conversation, in the console and in the CLI, with an agent that can see
every project the operator may see and manage the fleet **by proposal**:
it files, prioritizes, reserves, holds, suggests answers, and reports; the
operator confirms with a tap, or a password where the digest demands it.
The plane never acts on the model's word. This is firstmate's "talk to one
agent, ship with a crew" on our authority model (docs/firstmate-assessment.md
§4).

## Round-1 rulings (folded below; the findings are the design)

1. **No model-driven write, ever.** `propose_task` no longer files; every
   propose-* tool writes a `mate_proposal` row and nothing else. Filing
   happens when the operator confirms — as the operator's own filing
   through `fileTaskProposal` (`filed_via: mate`), exactly like quick
   capture. The proposal row is the idempotency; `idempotency_key` is gone.
2. **A mate-written scope never auto-seals.** `task_scope` gains
   `proposed_via` (set-once per write, `mate` when a confirmed
   `propose_scope` wrote it); `sealScopeApproval(..., {kind: "mode"})`
   refuses `proposed_via = 'mate'` in the primitive — the same wall the
   coordinator quarantine uses. Only the password ceremony approves it.
3. **A branded principal.** `VerifiedApprover` (module-private maker in
   `src/approver.ts`, minted only by `authenticateApprover` or by the
   session layer after csrf + role + generation re-proof) is the only
   principal the mate's tools and confirmers accept; the shared tool module
   takes `VerifiedCoordinator | VerifiedApprover`, never a structural
   object. Confirmers run through `src/mate-doors.ts`, a service layer that
   re-authenticates transactionally and calls the store primitives with the
   same validations the HTTP handlers apply (ceiling, csrf at the edge,
   revision CAS, claimed/contest rechecks).
4. **Shared queries, distinct views.** The coordinator's DTOs keep their
   paths (its allowlist is its authority). The mate's tool results pass
   through `mateView()`: repos as opaque `rN` (v13's mapping), `touches`
   dropped, digests dropped, approver identities dropped, chain words
   dropped, consequences and recommendations dropped. A canary test greps
   every serialized tool result for a path, a digest, or a name.
5. **Durable accounting.** `mate_turn` (approver, session, thread, state
   `queued|running|answered|failed`, generation, reserved, settled, steps
   summary) with one `chat_turn` row per provider request as its steps
   (`kind = 'mate-step'`, `mate_turn` FK): the existing dispatch CAS,
   terminal CAS, and crash latch apply per request; the turn's reservation
   commits against the session AND the weekly ledger in one transaction
   before the first dispatch; one live mate_turn per approver serializes
   the console and the CLI; a crash mid-loop settles the steps that
   finished and latches the one in flight.
6. **A true worst case.** With S = `MATE_MAX_STEPS` (8), M =
   `MATE_MAX_CALLS_PER_STEP` (4), R = per-result cap (16 KiB), C = per-call
   cap (2 KiB), B = base prompt bytes, O = `MAX_OUTPUT_TOKENS`: reserve
   `Σ_{s=1..S} tokens(B + (s−1)·M·(R + C) + s·O) × price_in + S × O ×
   price_out`. `worstCaseForPrice` gains this triangular form; the loop
   refuses a response carrying more than M calls as `malformed-reply`.
7. **Atomic confirmation.** One transaction: re-prove the approver (brand,
   not revoked, generation equal); the proposal belongs to this approver's
   thread; its turn is `answered`; the session's ceiling digest equals the
   surface's; `pending → confirming` CAS; the door primitive; the outcome;
   `confirming → confirmed|refused`. A proposal is inert (`drafting`) until
   its turn finalizes. Concurrent confirms: one wins the CAS, the other
   sees the typed outcome.
8. **Every proposal carries its CAS material.** `propose_scope` carries
   `sawDigest`; `propose_next` and `propose_reserve` carry `queueRevision`
   and the position the mate saw; `propose_hold` carries nothing (a second
   operator hold is a no-op by primitive); `propose_unhold` carries the
   hold id; the doors refuse on mismatch with the typed reason.
9. **Ceiling-bound.** `mate_session`, `mate_thread`, and `mate_proposal`
   store the admitted-repo ceiling digest; a surface whose digest differs
   cannot continue the thread or confirm its proposals (it starts a new
   thread and says why).
10. **Delegated spend, done the mode way.** `mate_session` stores the
    approver generation and a terms digest (ceiling $, expiry, ceiling
    digest); every turn and confirm re-authenticates against the current
    approver row; `revokeApprover` closes the approver's mate sessions in
    its transaction; a running CLI REPL learns on its next turn and exits.
11. **Transcripts, ruled explicitly** (rule change #2): the thread stores
    operator text and assistant text only — never tool results, never
    provider payloads — for 24 hours, swept after; secrets are scanned out
    before storage; `--end` and revocation delete the thread. The first
    durable model text now precedes a filing; the password that minted the
    session is what backs it.
12. **The ceremonies as they are.** Irreversible answers take the existing
    `confirm=yes` second field; cancel is the existing arm-then-POST. The
    spec claims no password ceremony for either; propose_cancel renders the
    arm control, never a one-tap.
13. **No suggested answers in v1.** `propose_answer` is deferred: the mate
    sees no consequences or recommendations by rule, so it cannot choose
    safely, and the v13 prompt's no-recommendation rule stands. The mate
    points at open decisions (recap, `list_decisions`) and the operator
    answers on the decision page.
14. **Usage is integers.** The wrapper parser accepts token counts only as
    non-negative safe integers ≤ 10⁹; anything else is `malformed-reply`.
15. **Real-HTTP contracts** for every confirm door: ownership, csrf, role,
    ceiling re-proof, double-submit, ceremony redirects.

## 0. Hard boundaries

- **No new authority.** Every proposal executes through an existing door:
  `fileTaskProposal` (quarantined, scope unapproved), `POST /t/:id/next`,
  `/queue/move`, `/t/:id/hold|unhold`, `POST /d/:id/answer`, and the
  password ceremonies for scope approval, irreversible answers, and cancel.
  The mate has no tool that mutates state; it has tools that *propose*.
- **Fleet chat v13's transport stays.** Direct provider call over fetch, no
  CLI spawn, no filesystem, capped bodies, the strict wrapper parser, worst-
  case reservation against the weekly ceiling, the latch on unknown spend.
  The mate adds a bounded tool loop *inside* that contract (§3).
- **The v13 snapshot rules stay**: explicit repo list = the ceiling's
  admitted repos; admission inside every query before its LIMIT; repo paths
  never leave the process (opaque `r1..rN`); decision recaps, consequences,
  and recommendations excluded from anything sent to a provider; secrets
  scanned out of every outbound body.
- **One thread per approver**, project-agnostic, shared by the console and
  the CLI — that is what "unified" means. Threads are metadata plus text
  the approver typed and the model returned; tool results are stored as the
  typed JSON the plane produced, never as provider payloads.
- **Copy**: the mate "suggests", "proposes", "asks"; it never "did".

## 1. Principals

The mate runs **as the approver**, under the approver's session (console)
or credential (CLI) — not under a coordinator credential. Its reads are the
approver's reads (the ceiling), its proposals are the approver's proposals
in waiting. `filed_via` for anything it files is `mate` (display provenance,
inside the existing grammar); nothing carries `coordinator_cid`.

**The mate session** (the one rule change, flagged for review): today chat
takes the password with every message. A conversation cannot. A mate
session is a password ceremony once — restating "this session may spend up
to $X on chat until <time>" — that mints a signed, expiring row
(`mate_session`: approver, credential_key, ceiling_microusd, spent_microusd,
expires_at, revoked_at). Every turn debits it transactionally; exhaustion or
expiry ends it; any approver may revoke it from `/chat` or `standing-orders
chat --end`. The weekly chat ceiling still binds above it.

## 2. The tools (shared with MCP)

`src/coordinator-tools.ts` becomes the one module both `src/mcp.ts` and the
mate call: the existing `statusFor`, `listTasksFor`, `taskDetailFor`,
`list_repos`, `fileCoordinatorProposal` move there unchanged in behavior,
parameterized by a **principal** (`{ kind: "coordinator", cid, repos }` or
`{ kind: "approver", name, repos }`). New tools, all read or propose:

| tool | reads / proposes | executes through |
|---|---|---|
| `recap` | since-stamp: what waits (decisions, approvals, requeues), what runs, what finished; counts and ids, no recaps/consequences | read |
| `list_decisions` | open decisions: id, task, question, option ids and labels (no consequences), reversible flags, age | read |
| `queue` | a repo's columns and order (ids, titles, reservations) | read |
| `propose_task` | `{repo, title, goal, not, touches}` → row | confirm → the operator's own `fileTaskProposal` (`filed_via: mate`); unapproved, ordinary |
| `propose_next` | `{task, queueRevision, position}` → row | confirm → `moveTaskNext` with the revision CAS |
| `propose_reserve` | `{task, worker|null, queueRevision}` → row | confirm → `moveTask` with the revision CAS |
| `propose_hold` / `propose_unhold` | `{task, reason}` / `{task, holdId}` → row | confirm → the hold primitives |
| `propose_scope` | `{task, goal, not, touches, sawDigest}` → row | confirm → `proposeGuarded` with `proposed_via: mate`; mode coverage refuses it; the password ceremony approves it |
| `propose_cancel` | `{task, reason}` → row | renders the existing arm-then-POST control on the card; never a one-tap |
| `propose_answer` | — | deferred (ruling 13) |

`mate_proposal`: id, thread, turn, kind, payload_json (exact-key DTO, no
spread, CAS material included), ceiling_digest, state
(`drafting|pending|confirming|confirmed|refused|dismissed|expired`),
created_at, resolved_at, resolved_by, outcome_json. `drafting` until the
turn finalizes; expires with the thread (24h). Confirmation is one
transaction (ruling 7); a stale proposal is the door's typed refusal,
rendered in place. At most 5 proposals per turn.

The MCP gateway gains the same read tools (`recap`, `list_decisions`,
`queue`) for coordinators; the propose-* tools stay approver-only in v1
(coordinators file; steering by a foreign credential is a later ruling).

## 3. The turn

`runMateTurn(thread, message)`:

1. Reserve the triangular worst case (ruling 6) for the whole turn in one
   transaction against the mate session and the weekly ledger, opening the
   `mate_turn`; `TURN_WALL_CLOCK_MS` bounds the whole loop. Refuse before
   any dispatch when either ceiling cannot cover it.
2. Compose: system contract (§4), the thread's last N messages (capped by
   bytes), the data document (v13's `buildDataDocument`), the user message,
   and the tool schemas. Provider: Anthropic Messages `tools` /
   `tool_use`; OpenRouter's OpenAI-compatible `tools` / `tool_calls`. The
   wrapper parser gains a **tool-call branch** under the same caps and
   duplicate-key lexer; a call to an unknown tool, a malformed argument
   object, or a result over the cap ends the turn as `malformed-reply`.
3. Loop: each provider request is its own `chat_turn` step row (dispatch
   CAS, terminal CAS, crash latch); execute at most M tool calls per step
   in-process under the branded principal, pass results through
   `mateView()`, append, call again; stop on a text-only reply or at S
   steps (then the reply is the last text plus "stopped after 8 steps").
4. Settle: tokens in/out summed across steps; `settled = max(pinned,
   reported)`; debit the mate session and the weekly ledger; latch on
   unknown spend exactly as v13.
5. Persist: `mate_message` rows for the operator text and the assistant
   text only (ruling 11); tool activity is summarized in the assistant row
   as counts ("read 2 projects · 5 tasks"), never stored as results;
   `mate_proposal` rows move `drafting → pending` here. The console and the
   CLI render from these rows — one source.

## 4. The contract the model reads

Plain words, versioned, in `src/mate-contract.ts`: what the plane is, the
five statuses, that every act is a proposal the operator confirms, the
honesty rules (measured/unmeasured, never a percent), the copy rules
(suggest/propose/ask), when to ask instead of propose (any irreversible
choice, any cancel, anything outside the admitted repos), and the shape of
a good recap (what waits first, then what runs, then what finished, counts
before names). The model never sees paths, decision consequences, or
recommendations — the data document already hides them.

## 5. The console

`/chat` becomes the thread: messages in order; tool activity as quiet mono
lines ("looked at 2 projects · 5 tasks"); proposals as cards inside the
assistant's message, each a form with one button (`confirm`) posting to
`POST /chat/proposal/:id/confirm` with csrf — the handler executes the
door and renders the door's answer on the card (`filed t-42`, `moved to
the front`, or the typed refusal); irreversible answers and cancel link to
their ceremonies. `dismiss` is a second small form. The composer is one
field; the page keeps the v13 problems, the latch acknowledgement, the key
facts, and the spend line ("this session: $0.42 of $5 · this week $3.10 of
$20"). The thread polls its own fragment while a turn runs (regionScript,
form-free fragment: proposals render inert until the turn ends).

## 6. The CLI

`standing-orders chat [--as <you> --token <t>] [--end]`: a REPL over the
same thread. First run mints the mate session (the same restated terms,
the password typed once); turns print the assistant's text, tool activity
dimmed, and proposals numbered — `confirm 2`, `dismiss 2`, `open 2` (prints
the task). Confirming executes the same doors with the approver credential;
password-class proposals print the CLI ceremony command instead. `--json`
emits one envelope per turn for scripts. Non-interactive: `standing-orders
chat --say "…"` runs one turn and exits with the proposals listed.

## 7. Sequencing

1. `src/approver.ts` (the brand) + `src/mate-tools.ts` (shared queries,
   `mateView`, the read tools, `propose_task` as a row) + schema
   (`mate_session`, `mate_thread`, `mate_message`, `mate_proposal`,
   `mate_turn`, `chat_turn.kind/mate_turn`, `task_scope.proposed_via`) +
   the triangular reservation + `runMateTurn` with per-step ledgering +
   tests (fake provider: loop, caps, latch per step, crash mid-loop,
   canary on views, ceiling digest). **Codex review.**
2. The remaining propose-* tools + the confirm doors + the console thread
   page. Tests per door (a stale proposal is the typed refusal).
3. The CLI REPL, driving the same engine and doors under a
   `VerifiedApprover` minted by password; its tests use the fake provider,
   and every confirm door also has a real-HTTP contract (ruling 15).
4. MCP gains the read tools. **Codex review**, then the ledger entry.

## 8. Deferred

Scout tasks (report-shaped deliverable), Telegram digests, project-level
standing notes, propose-* over the MCP gateway for coordinators, voice.
