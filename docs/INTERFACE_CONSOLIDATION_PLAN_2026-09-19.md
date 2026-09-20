# One product across the UI, CLI, and agents

Make each interface a client of the same operations and current-state views.
Prioritize consistent identity, next actions, and recovery before adding the
FirstMate session features. Preserve the native session foundation and existing
approval model; migrate one user journey at a time.

The original assessment below was recorded against main `9de2053` and the
matching verified runtime `f1f35d4`. Implementation is split into two bounded releases: exact result links and
a shared work summary first; guarded native-session CLI operations and
saved-context briefs second, on top of the standalone web candidate. The implementation and its
current checks are recorded in `INTERFACE_IMPLEMENTATION_2026-09-19.md`.
References below to missing commands and unfinished routes describe the original
baseline, not the current implementation. Release remains subject to the native
final gate, independent review, and matched UI/worker deployment.

## What is already working as a foundation

- `envelope.ts` gives the CLI versioned JSON, stable reason tokens, output files,
  capability discovery, and documented exit codes. `contract --commands --json`
  on the installed runtime returns 127 command entries, 49 marked agent-invocable.
  The current contract has no `session` or `code` command family.
- `surface.ts` describes command audiences and retry semantics. Its own notes
  correctly say the guide is advisory and the operating parser has global flags.
- `mcp.ts` already uses typed tool descriptors for input validation and discovery.
  Coordinator credentials deliberately permit reads and proposals, not operator
  approvals, publication, or unrestricted session control.
- `result-actions.ts`, `chat-actions.ts`, `chat-task-actions.ts`, task control,
  and coordinator proposals already share important operations. Extend these
  owners; do not introduce a competing general workflow engine.
- Native `CodingWorkspace` already owns thread identity, receipts, process
  custody, recovery, and persisted state. It enforces one live catalog owner.

The remaining problem is inconsistent coverage and presentation. `serve.ts`
contains about 20,900 lines and `operate.ts` about 11,700 at main. Size is a
maintenance signal, not proof of incorrect behavior. More concretely, unfinished
`/code/*` routes admit browser cookie operators and call the session owner;
matching CLI/MCP session adapters are not yet implemented. Chat currently gains
an **Open coding workspace** link, which is navigation, not a coding action.

## Observed user friction

Used the installed runtime's disposable, fenced `demo` command: synthetic data,
no model calls, no production mutations, and no remote operations. Inspected
Work and result-review screenshots at 1440×900 and 390×844 after navigation
settled. The demo was stopped and removed after inspection.

1. **A result link loses the destination.** In All projects → Work, clicking
   **Review for acceptance** for `confirm-empty-state-copy` opened Projects.
   Choosing `web-console` opened Inbox, rather than the requested result.
   The project was already known by the originating row.
2. **The same task offers different next actions.** Inbox exposed an open
   webhook-retry question. Work showed that task as **Builder disconnected →
   Check connection**. Both facts may be true, but the actionable question
   should remain available. `workRowOf` constructs dispatch/result/control facts;
   it does not currently include the open decision in that projection.
3. **Navigation and status repeat.** Desktop Work presents Work tools in both
   sidebar and page header. The result screen repeats review labels and build
   identity across the page, selected queue item, outcome, and result card.
   On the phone this pushes the actual result detail farther down the page.

These observations support targeted simplification. They do not establish a
complete accessibility audit: empty states, full keyboard flow, feedback/revision,
physical-phone behavior, and the unfinished Code UI were not exercised here.
Screenshots were inspected in the tool session, not committed as release evidence.

## Shared architecture

```text
Browser UI       Human CLI       Agent CLI / MCP       Chat adapters
     \              |                  |                   /
           typed queries, operations, and proposals
             access + exact identity + expected version
                 existing owning services
          task ledger / session catalog / approvals
```

Same behavior does not mean identical authority. Keep three explicit principals:
operator, scoped coordinator, and executing worker. A coordinator can propose
an action the operator can perform, without acquiring the operator's credential.
Do not grant session-transcript access merely because an agent can list a repo.

Keep task, run/result, and native session as separate durable identities. A task
may have multiple attempts; a session has a native thread; a shipping handoff
links a specific committed session result to a task. A unified screen should not
collapse those distinctions or resolve an old link to whichever result is newest.

## Implementation order

### 1. Fix navigation and share the next-action projection

Add the known project and exact result/run to canonical destinations. Selecting
a project may change view context after authorization, but must preserve the
requested destination and reject unsafe return URLs. Keep old links usable.

Extend existing workspace/status projections into a transport-neutral work
summary. Include open decisions, approval state, active attempt, process state,
delivery uncertainty, proof, publication, and available next actions with reasons.
UI, CLI, and chat should render this summary instead of choosing independently.
For the observed question, show **Answer question** with disconnected-worker
status as secondary information; never hide a failure or weaken an approval.

Add regressions for the two observed cases using existing workspace and server
tests. This first slice should deliver fewer navigation steps and the same next
action from CLI, Work, and chat before any large file split.

### 2. Finish native sessions across the interfaces

Move admission and operation handling out of the new browser route block into
explicit session operations. Keep request validation, authority, actor generation,
project admission, expected turn/revision, and idempotency at the owning boundary.
HTTP cookies and CSRF remain HTTP concerns; they must not become the core API.

The CLI must connect to the existing running service for session mutations.
Constructing a new `CodingWorkspace` in each CLI invocation would compete with
the browser's catalog owner. Add a narrow authenticated local transport to that
owner, with explicit operator authorization and revocation, rather than writing
the catalog directly or replaying browser form submissions. Do not start another
provider process or steal native thread locks to satisfy a CLI call.

Proposed command families, not available commands today:

| Capability | Human CLI | External agent |
| --- | --- | --- |
| List, inspect, read changes | `session list/show/changes` | Explicitly authorized reads, bounded and redacted |
| Start or continue | `session start/send` | Proposal or specifically delegated capability; never implicit operator identity |
| Observe updates | `session events --after <cursor>` | Resumable structured events, no transcript scraping |
| Stop, resume, reconcile delivery | `session stop/resume/recover` | Authority-checked proposal/control appropriate to the credential |
| Review a committed result for shipping | `session review` | Exact-candidate proposal; approval and publication remain separate |

Keep `chat` as coordinator conversation and `session` as direct native coding.
Explain this once at creation. Never silently switch modes when a prompt contains
code. Support complete text through files/stdin and return durable IDs, receipts,
current status, and the next permitted action. Unknown delivery must return an
inspect/reconcile action, not an automatic retry instruction.

### 3. Make capability discovery executable

For each touched operation, use a typed descriptor for its parser, help, input
schema, retry policy, and adapter availability. Reuse MCP's existing descriptor
pattern and migrate the advisory command guide gradually. Do not rewrite all
127 commands at once or replace owning services with a generic action dispatcher.

Preserve the current JSON envelope. Add machine-readable next actions and retry
guidance where absent. Distinguish succeeded, pending, needs approval, rejected,
and uncertain delivery without interpreting prose. Keep stdout structured,
diagnostics on stderr, and existing exit-code compatibility.

Provide targeted capability discovery so an agent loads only the relevant command
family. A request for result revision should not inject the entire CLI catalog.
Expose installed build identity and readiness by composing existing diagnostics;
do not add another monitoring daemon. Show unsupported agent operations as an
explicit proposal or operator handoff, not a fake completed action.

### 4. Simplify the UI around those capabilities

Keep Work as the place to find active and completed work, with Needs you, Running,
and Completed filters. Keep Projects and Settings as supporting destinations.
Chat can remain a shortcut to the same work context. New work should clearly
offer **Work with an agent** or **Hand off a task**, with one form appropriate to
the selected mode and advanced controls disclosed only when needed.

Use one canonical detail view for a selected session/task/result: concise state,
outcome, one primary next action, then Conversation, Changes, Checks, and History
as relevant. Approval terms stay fully available before consent. Remove repeated
review instructions and duplicate Work tools controls. Move legacy board,
portfolio, build, and activity views under tools until equivalent functionality
is proven, then redirect redundant routes while preserving exact identities.

Extract route handlers and presentation modules from `serve.ts` as each journey
is migrated. Similarly split command families from `operate.ts`. A framework
rewrite is not required to repair the observed behavior or support agents.

### 5. Add FirstMate session continuity

Implement the brief, handoff, and reviewed-memory ideas from
[the FirstMate plan](FIRSTMATE_SESSION_PLAN_2026-09-19.md) through these same
queries and operations. The brief then helps browser users and CLI agents
equally. Do not introduce a parallel supervisor or a browser-only memory system.

## Acceptance contract

- Every newly exposed action has an owning operation, a stable input/output
  contract, declared principals, replay behavior, and an explicit status on each
  relevant interface: supported, proposal-only, operator handoff, or unsupported.
- One cross-interface journey: create from an authorized CLI, inspect in UI,
  follow up through the same session, reconnect, inspect from CLI, then prepare
  exact-candidate shipping review. Show the same identities and receipts throughout.
- Coordinator reads/proposals cannot approve their own work. Test wrong project,
  revoked credentials, changed account generation, and stale turn/result IDs.
- Test lost responses and duplicate submissions: one native turn/revision, no
  false success, preserved drafts, and an explicit recovery action.
- One desktop and one phone acceptance journey opens the exact result, inspects
  changes, leaves realistic feedback, and creates a revision. Include affected
  empty, long-content, failure, and uncertain states; check keyboard access,
  contrast, tap targets, overflow, fixed controls, and short unbroken button labels.
- Run typecheck and affected regressions during implementation. If chat schemas
  change, run CLI and browser entry-point tests at current default spend ceilings.
  Commit and preflight exact evidence against the original task base, then let
  the unchanged full suite run once at the native final gate, followed by review
  and normal matched UI/worker deployment.

The original planning pass changed only documents. Checks performed then: installed command
discovery, source tracing, read-only runtime identity inspection, and the limited
synthetic browser review above. Implementation checks and remaining release
requirements are recorded separately in the implementation ledger.
