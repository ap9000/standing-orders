# Telegram action parity

One row per mate tool in `MATE_TOOL_SCHEMAS`, sourced from
`TELEGRAM_ACTION_PARITY` in [telegram-mate.ts](../src/telegram-mate.ts).
`src/telegram-mate.test.ts` refuses a tool this table does not name and
checks every row below against that constant column for column — support,
how, and remaining gap — so the code and this document cannot drift apart
silently. A `direct` row whose action still ends with a step on the
computer names that step in its remaining gap.

Meaning of the support column:

- **direct** — the same engine tool runs during a phone turn, or the same
  `confirmMateProposal` door runs from a card's Confirm button, recorded
  with `via: telegram` on the proposal outcome (and on the decision or stop
  it wrote). Web and CLI show the same rows afterwards.
- **handoff** — an incomplete phone action: the phone names the existing
  authenticated control and the task; it does nothing itself and sends no
  link. Its remaining-gap column says so.
- **missing** — no phone path. None today; a new tool without a row fails
  the suite.

Fixture tests only: every row below was exercised against a scripted Bot
API and a scripted membership harness. This is not a live Telegram trial;
that waits for the operator's bot configuration and pairing.

| Tool | Support | How the phone reaches it | Test | Remaining gap |
| --- | --- | --- | --- | --- |
| `recap` | direct | Read by the model during a phone turn over the enrolled ceiling. | journey turn (`telegram-mate.test.ts`, first test) reads through the engine | none |
| `list_repos` | direct | Read during a turn; projects are r1..rN in enrollment order, as on the console. | ceiling digest equality with the console/CLI (first test) | none |
| `get_project_knowledge` | direct | Read during a turn. | engine read tools (`mate.test.ts`), same turn path | none |
| `list_tasks` | direct | Read during a turn. | engine read tools (`mate.test.ts`), same turn path | none |
| `get_task` | direct | Read during a turn; a reply to a result message pins the exact execution. | reply-to-result test | none |
| `get_agents` | direct | Read during a turn. | agents card test reads it before `propose_agents` | none |
| `list_decisions` | direct | Read during a turn. | engine read tools (`mate.test.ts`), same turn path | none |
| `get_decision` | direct | Read during a turn. | engine read tools (`mate.test.ts`), same turn path | none |
| `queue` | direct | Read during a turn. | engine read tools (`mate.test.ts`), same turn path | none |
| `get_result` | direct | Read during a turn; the phone card shows the verification verdict, never a local link. | reply-to-result test (`get_result` then `propose_review`) | Screenshots and secure remote evidence links are not delivered to the phone yet. |
| `get_controls` | direct | Read during a turn. | engine read tools (`mate.test.ts`), same turn path | none |
| `show_control` | handoff | The card names the control and the task; the operator opens it on the computer. No link is sent. | control card test: no button, no link, a forged tap changes nothing | Incomplete phone action: the control itself runs on the computer. |
| `propose_task` | direct | Card with Confirm/Dismiss through confirmMateProposal (filed as a mate proposal, via telegram). Scope approval stays on the computer. | first test: filed task, outcome `via: telegram`, replay does nothing twice | Scope approval (the password) stays on the computer. |
| `propose_scope` | direct | Confirm rewrites the scope through the shared door; the password approval that follows is a handoff. | scope card test | Approving the rewritten scope needs the password on the computer. |
| `propose_next` | direct | Confirm through the shared door with the queue revision it saw. | queue card test | none |
| `propose_reserve` | direct | Confirm through the shared door. | queue card test | none |
| `propose_agents` | direct | Confirm through the shared route-edit door; renewed approval stays on the computer. | agents card test (route override written) | Renewed approval after the route change happens on the computer. |
| `propose_hold` | direct | Confirm through the shared door. | hold/unhold card test | none |
| `propose_unhold` | direct | Confirm through the shared door. | hold/unhold card test | none |
| `propose_steer` | direct | Confirm through the shared door; the guidance is shown verbatim on the card. | steer card test | none |
| `propose_dependency_repair` | direct | Confirm retry/unlink/replace through the shared door with both projects re-checked. | repair card test (retry); unlink/replace share the door path proven in `mate-doors.test.ts` | none |
| `propose_task_action` | direct | stop, retry, plan, wait_for and stop_waiting confirm through the shared door (a stop is audited via telegram); resume confirms only the request and hands off to the password step. | task-action card test: retry, plan, wait_for, stop_waiting, stale refusal, stop (`run_stop.requested_via = telegram`); resume card copy | resume completes on the computer (incomplete phone action). |
| `propose_answer` | direct | Confirm answers through the shared door, audited via telegram; an irreversible option arms a second tap first. | answer card test: reversible, irreversible arm/cancel/yes, `answered_via = telegram` | none |
| `propose_review` | direct | note saves feedback; revise creates the same-family revision through the shared result service, honouring automatic approval settings. | reply-to-result test (revise, manual approval), automatic-approval journey test (revise under a signed mode), review note card test | Under manual approval the revision is approved on the computer; under a signed automatic-approval mode it runs unattended. |
| `propose_cancel` | handoff | The door refuses cancel from any card; the phone says to arm it on the task itself. | cancel card test: no button, no link, a forged tap changes nothing | Incomplete phone action: no phone path to cancel by design. |

## Boundaries every row shares

- Pairing is proved before any model call: private chat, immutable sender,
  bot, binding row and generation, approver role, and the enrolled ceiling.
  The engine re-proves the channel before every provider dispatch, after
  every provider wait and before every tool runs, re-reading account,
  session, thread and turn state after each awaited lookup; the bridge
  re-proves it before every outgoing part.
- Ordinary text is persisted before the poll cursor moves. The session a
  turn will run in is bound to the row before the first dispatch, and the
  engine's request receipt is derived from bot, binding and update, so a
  replay or a restart — even after that session was ended and replaced
  from the console — recovers the original turn instead of dispatching
  again.
- The reply and every card are persisted as parts before any send
  (schema v63). A part is sent only when Telegram confirmed a message id;
  a lost, aborted or malformed acknowledgement from the real HTTP adapter
  is counted uncertain and retried; Telegram's retry_after
  pauses every send bot-wide, the outbox included; a restart resumes from
  the first unsent part with no model call. A row is done only when every
  part is sent or moot.
- A Telegram-minted session only exists when the approver has none; an
  incompatible console or CLI session is refused, never ended from the phone.
- Passwords are never asked for. Approval of a scope, resume, cancellation,
  publication and every settings control stay on the computer.
- A direct-API chat configuration is never spent from the phone.
