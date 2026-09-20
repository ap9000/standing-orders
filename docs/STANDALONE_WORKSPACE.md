# Standing Orders as a coding workspace

Goal: open a project, ask an installed coding agent to change it, inspect the result,
give feedback in the same session, and ship through the existing verified release
path. This must work from the web console without another agent operating the
coordinator on the user's behalf.

## Evidence and direction

The implementation started from main at `9de2053` (PR #28). At the start of
this work, the installed UI and worker shared the verified PR #28 runtime
`f1f35d4`, with schema 69. The original Documents checkout is older and contains unrelated local edits.

`src/subscription-chat.ts` intentionally strips repository tools, rules and MCP
from the subscription chat harness. That is a coordinator conversation, so it
cannot provide the direct coding experience on its own. The build provider can
resume sessions, but only inside the task execution protocol.

The new coding workspace lets the native agent own its conversation and tools.
Standing Orders owns project access, isolated checkouts, durable session identity,
browser reconnection, approval presentation, and the path to verified delivery.
The unattended queue remains an explicit workflow; small interactive revisions
do not need to create another planner/build/review cycle.

Implementation research inspected source at HAPI commit
`2f72a8012ebe8632eb6a7ac697264ba970e7edde` and T3 Code commit
`7445aa733ada33e45289e5aa5055f79142556513`, alongside the installed Codex 0.154.0
app-server protocol and [official documentation](https://learn.chatgpt.com/docs/app-server).
HAPI's [native runtime](https://github.com/tiann/hapi/blob/2f72a8012ebe8632eb6a7ac697264ba970e7edde/cli/src/codex/shared/runtime.ts)
and [ownership registry](https://github.com/tiann/hapi/blob/2f72a8012ebe8632eb6a7ac697264ba970e7edde/cli/src/codex/shared/registry.ts)
separate browser attachment from process lifetime and bind native threads to a
verified process generation. Its [submission queue](https://github.com/tiann/hapi/blob/2f72a8012ebe8632eb6a7ac697264ba970e7edde/cli/src/codex/shared/queue.ts)
persists request identity before mutation, reconciles uncertain delivery, and
uses an expected turn ID for steering. Its [approval handling](https://github.com/tiann/hapi/blob/2f72a8012ebe8632eb6a7ac697264ba970e7edde/cli/src/codex/shared/permissions.ts)
correlates requests by generation and native thread, retiring requests answered
elsewhere. T3's [client state](https://github.com/pingdotgg/t3code/blob/7445aa733ada33e45289e5aa5055f79142556513/packages/client-runtime/src/state/threads.ts)
resumes from a coherent snapshot/cursor, and its [live coalescer](https://github.com/pingdotgg/t3code/blob/7445aa733ada33e45289e5aa5055f79142556513/apps/server/src/orchestration/ThreadLiveEventCoalescer.ts)
reduces intermediate tool updates without losing lifecycle boundaries. Its
[Codex runtime](https://github.com/pingdotgg/t3code/blob/7445aa733ada33e45289e5aa5055f79142556513/apps/server/src/provider/Layers/CodexSessionRuntime.ts)
settles pending approval requests before Stop to avoid blocking the transport.
These patterns inform session continuity, receipts, compact activity, and
recoverable controls. They are not copied indiscriminately: T3's queued Codex
follow-up differs from HAPI's immediate steering; T3 can fall back to a fresh
thread after selected resume errors; and HAPI's worktree helper uses current
HEAD and forced removal. Standing Orders must preserve its explicit base,
session-continuity, and work-preservation guarantees. This is source research,
not a hands-on benchmark or a claim about comparative memory use.

## Completion requirements

- A discoverable web coding workspace with project/session switching and a clear
  empty state. Existing project setup remains usable without a coordinator agent.
- Native coding sessions with real repository tools, instructions, skills and MCP;
  choose supported agents/models truthfully, with unavailable capabilities named.
- Isolated worktrees, stable native session identity, durable history, recoverable
  drafts, and continued work after the browser disconnects.
- Direct follow-up, truthful queued/steering behavior, approval and question
  controls, and stop/resume without duplicate turns or lost changes.
- Visible changes and relevant test activity, a usable result/preview path, and a
  concrete handoff into the existing verified shipping workflow.
- Direct coding is available only to installation operators. Authentication,
  ownership, project admission, revocation, native permission approvals and
  publication gates remain enforced.
- A focused regression set plus an actual desktop and phone journey: create,
  inspect, revise, reconnect, handle a failure, and finish. Real native execution
  must prove editing and same-session revision on an isolated sample project.
- The final candidate passes the unchanged native machine gate and independent
  review, then the UI and worker are deployed together through the normal drain,
  backup, compatibility and health checks. Deployment and shipping status must
  be reported separately from a built local candidate.

## Storage and lifecycle

The coding catalog is a separate SQLite file next to the configured orders DB.
It stores only coding-workspace state and never edits task proofs or approvals.
Native thread IDs remain the source identity; the catalog stores a browser view
of delivered events and submission receipts. Updates back up both databases and
preserve native agent session storage, captured skill files and worktrees in
place. A machine recovery backup must also include those external directories;
the catalog alone cannot restore their contents.

One server owns the coding catalog at a time. An uncertain submission is visible
and is not automatically retried. Browser reconnect reads persisted state; cold
native resume is an explicit action only after the prior process is gone.

The workspace uses the installed Codex login, repository instructions and MCP
configuration. It removes the invoking desktop app's transport and session
environment so a new owned provider does not inherit another conversation's
attachment. It never kills a different application's writer or breaks a native
thread lock. A writer conflict leaves the saved work available and asks the
operator to close the other attachment before resuming.

## Access boundary

Direct coding is a trusted installation capability. Selecting a project limits
which session worktree Standing Orders admits; it is not an operating-system
read boundary. Native `workspace-write` allows reads outside that worktree, and
configured local MCP servers retain their own host and connected-tool access.
The start form states this before the password confirmation. Project-scoped
accounts keep the existing queued Work experience and cannot access Code.

This was checked against installed Codex 0.154.0 and matching upstream commit
[`6b9826e3`](https://github.com/openai/codex/tree/6b9826e3aa83b1a5947db50f4332cb9c65f1b340):
[workspace-write read grants](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/protocol/src/permissions.rs#L790)
and [local MCP process launch](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/rmcp-client/src/stdio_server_launcher.rs#L255).
Deployments requiring isolation between mutually untrusted coding users need
separate execution roots, credentials and MCP processes before enabling Code.

## Using the workspace

Open **Code**, select a project, describe the change and start a session. The
agent edits a separate checkout. Follow up in the same conversation, inspect
**Changes**, or stop the current turn. Closing the browser does not stop work.
After a service restart, saved history remains readable and the next action
resumes the same native thread after verifying the checkout and process state.

Uncertain delivery keeps the draft and request identity. **Check saved session**
reconciles native history without replaying the message. If delivery still cannot
be established, the operator reviews the saved activity before explicitly
continuing; the old message is not sent again automatically.

To ship, ask the agent to commit the intended files, then open **Changes → Review
for shipping**. State the outcome and observable checks. The resulting review
task binds that exact committed candidate to the session's original base. It
uses the existing scope approval, final machine check and independent review;
creating the task does not approve or publish it. Further changes get another
review task rather than silently changing an approved result.

For visual review, the coding agent commits real screenshots with a small
`standing-orders.evidence.json` inventory. This is an agent-facing declaration,
not a test result or acceptance claim:

```json
{"version":1,"screenshots":[{"path":"evidence/phone.png","caption":"Phone result"}]}
```

Only `version`, `screenshots`, `path`, and `caption` are allowed. The machine
checks committed image bytes and the exact saved result, then carries the images
into its existing evidence flow. Missing required images stop the handoff before
verification. Checks and approval still come from the normal signed workflow.

Only Codex is supported in this first direct workspace. Other configured build
providers remain available in Work. Graphify is deferred until coding sessions
show a concrete retrieval gap.

## Status

The implementation has focused tests and an inspected desktop/phone journey;
see the accompanying web verification package for exact source hashes and
limitations. A real isolated cart-label session edited two files, ran three
affected tests, resumed its exact native thread across service restarts, and
created an unapproved task for its saved commit. That sample was not published.

The native foundation and web surface are separately scoped changes because the
combined patch exceeds the installed native evidence limit. Each retains its
original base and passes through the normal final gate and independent review.
The committed evidence package is preparation, not proof that either review,
merge or deployment has completed. The running installation must be checked
against its deployment receipt.

Unsent browser drafts are stored in the current browser session; they do not
synchronize across devices. Initial requests and accepted native conversation
history are durable on the server. Graphify and other direct coding providers
remain deferred. Resolve uncertain coding sessions before starting an update
drain; new recovery/continuation operations are blocked while admission is paused.
