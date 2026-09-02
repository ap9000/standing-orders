# The mate — spec v1 (2026-09-02)

One conversation, in the console and in the CLI, with an agent that can see
every project the operator may see and manage the fleet **by proposal**:
it files, prioritizes, reserves, holds, suggests answers, and reports; the
operator confirms with a tap, or a password where the digest demands it.
The plane never acts on the model's word. This is firstmate's "talk to one
agent, ship with a crew" on our authority model (docs/firstmate-assessment.md
§4).

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
| `propose_task` | `{repo, title, intent, idempotency_key}` | `fileTaskProposal` now (quarantined, `filed_via: mate`) — filing is already a proposal |
| `propose_answer` | `{decision, option, rationale}` → a `mate_proposal` row | operator tap → `POST /d/:id/answer`; irreversible options render the existing second-tap ceremony |
| `propose_next` | `{task}` → row | tap → `POST /t/:id/next` |
| `propose_reserve` | `{task, worker|null}` → row | tap → `POST /queue/move` (column, no `before`) |
| `propose_hold` / `propose_unhold` | `{task, reason}` → row | tap → `POST /t/:id/hold|unhold` |
| `propose_scope` | `{task, goal, not, touches}` → row | tap → `POST /t/:id/scope` (rewrites; approval still the password ceremony) |
| `propose_cancel` | `{task, reason}` → row | the existing arm-to-cancel ceremony, never a tap |

`mate_proposal`: id, thread, turn, kind, payload_json (exact-key DTO, no
spread), state (`pending|confirmed|dismissed|expired|refused`), created_at,
resolved_at, resolved_by, outcome_json. Pending proposals expire with the
turn's thread window (24h). Confirming re-validates everything the door
validates (revision CAS, claimed/contest rechecks, ceiling) — a stale
proposal is the door's typed refusal, rendered in place. At most 5
proposals per turn.

The MCP gateway gains the same read tools (`recap`, `list_decisions`,
`queue`) for coordinators; the propose-* tools stay approver-only in v1
(coordinators file; steering by a foreign credential is a later ruling).

## 3. The turn

`runMateTurn(thread, message)`:

1. Reserve the worst case for the whole turn: `steps × (prompt bytes +
   tool budget) × price`, with `MATE_MAX_STEPS = 8`, `MATE_TOOL_RESULT_CAP
   = 16 KiB` per result, `MAX_OUTPUT_TOKENS` per step, `TURN_WALL_CLOCK_MS`
   for the whole loop. Refuse before dispatch when the mate session or the
   weekly ceiling cannot cover it.
2. Compose: system contract (§4), the thread's last N messages (capped by
   bytes), the data document (v13's `buildDataDocument`), the user message,
   and the tool schemas. Provider: Anthropic Messages `tools` /
   `tool_use`; OpenRouter's OpenAI-compatible `tools` / `tool_calls`. The
   wrapper parser gains a **tool-call branch** under the same caps and
   duplicate-key lexer; a call to an unknown tool, a malformed argument
   object, or a result over the cap ends the turn as `malformed-reply`.
3. Loop: execute tool calls in-process against the store under the
   principal, append results, call again; stop on a text-only reply or at
   the step cap (then the reply is the last text plus "stopped after 8
   tool calls").
4. Settle: tokens in/out summed across steps; `settled = max(pinned,
   reported)`; debit the mate session and the weekly ledger; latch on
   unknown spend exactly as v13.
5. Persist: `mate_message` rows for the user text, each tool call (name +
   exact args), each tool result (the typed JSON), and the assistant text;
   `mate_proposal` rows for proposals. The console and the CLI render from
   these rows — one source.

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

1. `coordinator-tools` extraction + `mate_session`, `mate_thread`,
   `mate_message`, `mate_proposal` + `runMateTurn` with the read tools and
   `propose_task` + tests (turn loop with a fake provider, caps, latch,
   proposal expiry). **Codex review.**
2. The remaining propose-* tools + the confirm doors + the console thread
   page. Tests per door (a stale proposal is the typed refusal).
3. The CLI REPL. E2E over real HTTP is not needed: both surfaces share the
   engine; the CLI tests drive the engine with the fake provider.
4. MCP gains the read tools. **Codex review**, then the ledger entry.

## 8. Deferred

Scout tasks (report-shaped deliverable), Telegram digests, project-level
standing notes, propose-* over the MCP gateway for coordinators, voice.
