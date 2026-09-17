# Shared actions before Slack

A conversation can now propose the existing skill, knowledge and protected task
actions through one shared engine. Every proposal names the exact state being
reviewed. Confirmation saves the actual outcome on that same proposal. A link
being opened never counts as completion.

## Implemented contract

- `get_actions` lists the operations and input fields.
- `propose_action` prepares a saved proposal; it cannot execute an action.
- `confirmMateProposal` rechecks identity, current project access, the live
  conversation and the state used by the proposal before calling the existing
  domain service. Duplicate confirmations cannot repeat the change.
- `get_action_status` reads that proposal's persisted outcome across surfaces.
- `/chat/action/:id` shows the complete proposal to its signed-in owner. Scope
  approval and resume also require the existing password check. Other protected
  changes and content that is long or would be hidden in an external chat preview use the same complete review.
  The confirmation binds an expiring, single-use receipt, the saved state and
  the human's explicit confirmation. Passwords never enter model tools or the
  saved action payload.

| Feature | Shared action | Remaining channel step |
| --- | --- | --- |
| Skill library | Read, import pasted instructions, enable, disable, restore, create a test | Import uses complete secure review; folder and GitHub sourcing use the existing Skills screen |
| Project knowledge | Read instructions and references, save text, edit, remove, restore | Long content uses complete secure review; committed-file sourcing uses the existing Knowledge screen |
| Scope approval | Review the exact scope, agents, permissions, plan and revision evidence; approve | Secure review with password |
| Human result acceptance | Review exact result, machine and reviewer findings, evidence limitations and note; record acceptance | Secure review; machine verdicts remain unchanged |
| Independent review | Request a review through the existing bounded service | Existing review approval and retry limits still apply |
| Cancel and resume | Cancel the current task; resume the exact settled stop | Secure review; resume requires password and preserves other holds |
| Existing task work | Intake, scope edits, routes, steering, queue changes, holds, stops, decisions, feedback and revisions | Existing shared tools retain their permissions and confirmation rules |
| Action outcome | Read pending, confirmed, refused, dismissed or expired and the recorded outcome | A web completion does not yet automatically edit its old Telegram message |

Folder/GitHub imports, skill-test revisions, committed-file knowledge sourcing,
publication, deployment and installation settings remain available through their
existing screens or workflows. This change does not implement a generic MCP
manager, alter the operator's MCP installation, or add Slack, Discord or Teams.

## Evidence and simplicity pass

The isolated browser journey in `scripts/shared-chat-actions-proof.mjs` opens the
proposal, inspects the exact result, confirms acceptance, reads its outcome,
leaves realistic feedback and creates an unapproved revision. It also exercises
long instructions, a concurrent edit, a missing proposal and keyboard
confirmation. Desktop: 1440×900. Phone viewport: 390×844. These are synthetic
fixtures in Chromium, not a physical-phone or live Telegram trial.

Before: the new checkbox had a 21.5px label and acceptance repeated missing
review status beside every criterion. After: its label is at least 44px tall,
review status is stated once, the review shows full terms, and completion has
one primary next action. The inspected phone view has no horizontal overflow or
navigation overlap. A stale action names the problem and preserves the newer
saved content. Evidence and source hashes are in `evidence/shared-chat-actions`.

Focused regressions cover shared changes and receipts, state drift, import
review, history restoration, scope/password confirmation, corrupt plan evidence,
exact-result acceptance, normal review requests, settled-stop resume, access
changes, duplicate taps, CSRF/origin checks, persisted nonces, and schema upgrade.
The Telegram test uses a scripted transport and confirms the new ordinary
change and secure-review link against the same saved proposal.

Schema 66 widens only the shared proposal kind constraint. Its exact-shape
migration preserves old proposal and ceremony rows. A current database with an
older constraint, or an older database with an unknown shape, is refused.

## Release and Slack readiness

Prepared base: `8c7632d9e48134697e1a0cc69f7fd673be0eb1fc`. The installed UI and
worker were checked before this isolated journey and still ran the previous
verified build `11b59aaa1645b0b4fe8d9ae0359363d41b7eed95`, schema 65, with no open
runs. This document alone is not a release, merge or deployment receipt.

The native task must start at the prepared base, apply the prepared commit and
inspect the durable source and screenshots. Reuse unchanged focused checks and
browser evidence; let the final machine gate run its unchanged approved full
command once for the final candidate. Independent review must uphold the signed
criteria. Publication, merge and installation need their normal exact-candidate
checks; installation includes drain, backup, migration rehearsal and matching
UI/worker health checks.

Once verified, this is the contract for adding Slack. The Slack adapter should
bind workspace/channel/user/thread identity to current project access, deliver
messages and evidence through durable receipts, map buttons to the same proposal
door, and update one progress card from saved state. Secure actions need a
working HTTPS console URL. Acceptance of Slack itself requires a real workspace
trial across ordinary actions, evidence, feedback/revisions, secure review,
revocation, reconnects and duplicate delivery. Current Slack and Discord
webhooks remain outbound notifications only; Teams is not implemented.

A follow-up fixes incomplete external previews: any path, digest or other text
that the shared privacy display would hide forces full secure review. Ordinary
skill actions display an unambiguous 20-character version reference while
execution remains bound to the full immutable version.

Current evidence is in `evidence/shared-chat-actions/preview-fix`: 39 source
hashes, 507 distinct focused tests across six files, and 39 browser checks with
20 screenshots. The two current test batches overlap by 136 tests; the total
counts each test once. Earlier evidence remains in commit
`b44bd47102eb13ebeb04449ec2fe4af4d8b792f4` and sealed native run artifacts.
The previous default-budget chat and v59 migration fixture repairs remain intact.

## Fewer retries and clearer Telegram updates

Automatic review now waits when the configured project check is failed or missing,
or verification settings were approved after the build began. Explicit diagnostic
review remains available. An over-limit changed-file inventory no longer spends
agent turns on an impossible receipt correction. Verification timeouts are
reported as timeouts rather than a command that failed to start.

Routine build retries, operator holds and releases update the attempt’s existing
Telegram progress card. Holds are bound to the exact attempt when recorded;
delayed delivery cannot retarget a newer attempt. Decisions and urgent incidents
keep their separate alerts. Existing pairing, project access, retries, digest
preferences, message identity and reply routing still apply.

Messages use two bold headings, separate progress lines, one specific action,
and a short next step when it adds useful information. Internal paths and retry
codes stay on the task page. Automatic review policy is reflected even when no
acceptance checklist has been saved yet. Publication remains distinct from
merge and installation. Bold text uses Telegram entities with UTF-16 offsets;
user text is not parsed as markup ([Telegram API](https://core.telegram.org/bots/api#messageentity)).

The desktop and phone journey covers review, acceptance, feedback and an
unapproved revision. Four additional screenshots show synthetic Telegram
message previews, including blocked and missing-evidence states. They are not
Telegram client screenshots. The recovery button opens the real authenticated
task page. The current live Telegram card was updated and Telegram acknowledged
it; physical-phone rendering remains unverified.

Before: one failure produced a dense progress card, a raw retry message and a
separate hold message. After: routine failure and hold facts update one card
showing the blocker, the remaining stages and one recovery button.

The source is not yet released. An independent working copy under Developer
passed background Git access and native run 1755 passed the full machine gate.
Its terminal patch was truncated because the full structured focused-test log
exceeded the capture limit. That attempt and its evidence remain unchanged.

The complete focused log is now stored losslessly as `focused-tests.txt.gz`.
`checks.json` records both archive and decoded hashes and the decoded byte count.
Read it with `gzip -dc evidence/shared-chat-actions/preview-fix/focused-tests.txt.gz`.
No test result or application source was removed or changed. Preflight also
checks the complete base-to-candidate patch against the installed byte cap.
This new packaging candidate still needs its own native gate and review.


The Windows Node24 CI baseline hit different test and setup-hook timeouts on two
runs with two test files running concurrently. This candidate runs the same 18
baseline files sequentially, as the native full gate already does. No assertion,
within-test contention scenario, test timeout or job was removed or increased.
All other workflow jobs are unchanged. The changed workflow still requires a
fresh native gate, review and passing CI before release.
