# Chat and UI actions

Implemented in the native-chat-flow branch, based on 189e3d7. Not deployed.

## What changed

| Request | Before | Now |
| --- | --- | --- |
| Save feedback on finished work | Result form only | Chat confirmation writes the same result comment |
| Revise a result | Separate note/seal flow | One chat card can combine new feedback with selected saved notes and create a same-task revision |
| Retry, plan, add/remove a dependency | Task controls | Confirmable chat actions using the existing store/approval functions |
| Other controls | Assistant could only explain where to go | Fixed, labelled buttons to existing task, project, workflow and settings controls |
| “Request changes” at the top of a result | Only scrolled to Feedback | “Leave feedback”; “Request changes” remains the revision action |

Already available: task creation, scope changes, agent choices, priority, worker
assignment, holds, next-attempt guidance, dependency repair and decision answers.
These remain on their existing confirmation paths.

The chat and result form now share createResultRevision. Comments, revision
history, scope inheritance and approval coverage remain in the existing store.
There is no parallel chat-only task state. Chat reads feedback added in the
result UI; confirmed chat feedback appears on the result, run and review screens.
The board continues to show one task across its revisions.

## Boundaries and remaining parity

- Chat proposal cards still require confirmation. Revision approval is separate,
  unless an existing signed automatic-approval mode covers it.
- Cancellation, active-session stop/resume, publication, credentials, project
  management, workflows and installation-wide settings currently open their
  existing controls. They are **not** new direct conversational mutations.
- Knowledge editing and learning administration likewise open their existing
  settings pages. No password or API key belongs in conversation.
- Same-page confirmations refresh the affected screen. Existing task/thread/board
  pollers still run; arbitrary open settings/result tabs are not a new universal
  realtime-sync system.
- To finish native-chat parity, bring the remaining controls into contextual
  chat forms one family at a time, retaining their existing authorization
  ceremonies. Do not substitute generic model execution for those ceremonies.

## Safety and simplicity

- Server-captured result identity and feedback selection; read-before-propose.
- Visible result context travels with the chat message.
- Only explicitly selected saved notes enter a revision. Later notes stay saved.
- Stale terms, newer revisions, damaged evidence and inaccessible projects refuse.
- Failed combined note/revision actions roll back their tentative comments.
- Repeated confirmation creates neither duplicate notes nor duplicate revisions.
- Fixed control destinations: no model-supplied URLs or commands.
- Schema 60 widens only the chat proposal kinds; the v59 migration preserves
  cards, ids and sequence and checks foreign keys.
- Prompt/tool descriptions were reduced from 21,288 to 15,836 combined bytes
  during implementation after detecting a default-$5 API reservation regression.
  Caps and reservation accounting were not loosened.
- AGENTS.md now requires chat/UI consistency for future user actions.

## Evidence

Typecheck and build pass. Final broad focused pass: 99 tests across chat engine,
CLI, confirmation doors, migration, result/continuity and motion; 21 selected
server tests. Subsequent access/input validation changes reran their three
affected task-action/review tests. No full release/machine gate was run.

Browser journeys used real routes and disposable SQLite/evidence, with a scripted
subscription transport, not a paid provider or a real build:

- Desktop 1400×900: chat → save feedback → result panel shows note → request
  revision in chat → same task and unapproved revision.
- Phone 390×844: inspect diff → annotate mobile.md:2 → save note in result UI →
  return to chat → request revision using saved feedback → same task and
  approval form.
- Page widths matched viewports. Phone actions measured 44px tall; short labels
  stayed on one line. Long feedback wrapped within its card.
- Missing verification remained visible. Stale/tampered-result failures were
  checked in focused server tests, not exercised as a separate phone session.
- Real iOS/Android keyboards, Safari, Windows and live-model interpretation were
  not tested. The fixture's overlapping sample feedback is not evidence of an
  actual model's editorial judgement.

Viewport screenshots (local, ignored test output):

- output/playwright/chat-actions-desktop-before.png
- output/playwright/chat-actions-phone-result.png
- output/playwright/chat-actions-phone-card.png

The prior motion pass is included in this candidate. The visual UI was inspected
before the final prompt and input-validation tightening; those changes do not
alter layout. All runtime work stayed in the isolated checkout; the installed
worker, real database and main branch were not changed.
