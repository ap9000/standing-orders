# Phone status — local implementation checkpoint

Implemented on local main above `45ad5a7`, alongside the previously tested
desktop-signing/access changes. No production app, task queue, Telegram bot,
credentials, OS permissions, or publishing settings were changed for this work.

## Delivered slice

- `/status`, `/task <id>`, `/help`, and the `/start` help alias in the existing
  paired Telegram bridge. Same behavior in one-shot, follower, and embedded
  worker paths; no new scheduler or conversation engine.
- Existing dispatch diagnosis, source build proof, recorded acceptance, and
  publication observations drive the readout. Missing proof and unfinished
  review do not become completion; an opened PR does not become a merge.
- One bounded plain-text reply. The recent-task window and omitted rows are
  explicit; an older task remains directly addressable.
- Enrollment is loaded per request and applied before task reads. Pairing,
  sender, private chat, approver role and generation are checked; asynchronous
  reads recheck pairing before the task view and before sending.
- Existing decision-note and one-time callback behavior is retained. Commands
  cannot approve, dispatch, stop, resume, revise, publish, or spend model tokens.
- The public CLI counts successful status replies as activity. Read/send
  failures are visible without exposing raw errors. Consumed updates do not
  resend across restart; a fresh command is the explicit retry.

## Verification

Typecheck and the focused bridge/dispatch suite passed: 3 files, 57 tests,
including 26 new phone-status cases. Tests use a disposable real SQLite store,
the public CLI, the actual bridge/follower, and a scripted Telegram transport.
They include read-only row counts, auth/visibility refusals, replay after database
reopen, mid-read revocation, send failures, registry changes, weak evidence,
pending review, publication, and large histories.

The production build and full suite passed: **157 files, 2,707 tests, 23
platform skips** (2,730 total), 242.18 seconds. No failing tests or unhandled
test errors remained. The suite includes the previously local desktop changes.
This is assisted local implementation, not work executed by the installed
Standing Orders worker or a real-provider task. No live Telegram exchange or
phone screenshot is claimed.

## Remaining

Deploy only after the separately recorded Mac signing/access acceptance.
Then pair/use an actual bot and check the three commands, existing decision
buttons, and reply notes from the phone. Free-form requests/revisions should
reuse mate sessions and confirmations in a later bounded slice; screenshot
delivery should read verified evidence rather than arbitrary paths.

Usage and limits: [phone status](../PHONE_STATUS.md).
