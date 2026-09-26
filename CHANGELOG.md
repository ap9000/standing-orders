# Changelog

## Unreleased

- **Telegram pushes your messages.** With a public hooks address, Telegram
  delivers each message and tap to Standing Orders the moment you send it,
  signed with a secret, instead of Standing Orders asking for them. No other
  program can take your bot's messages meanwhile, and "Conflict" no longer
  fills the log when one tries.
- **A weekly report per teammate, and undo.** Every Monday its manager gets the
  week: what it did, its tool calls, what its turns cost, and what you
  overrode, each linked. Name an action's opposite (remove_label for
  add_label) and its receipts get an Undo that calls it with the same input,
  as you.
- **Message a teammate by name, and give it routines.** "@maya where's order
  2201?" in Telegram, Slack, Discord or Teams lands on Maya's desk, and the
  answer comes back to you there. Routines ("weekdays 09:00: look up
  yesterday's refunds") put a card on its desk on a schedule and report to
  its manager. A code change it's asked for is filed as an ordinary task
  under your approvals.
- **Teammates remember, and learn from you.** Each teammate keeps a memory:
  what you tell it, and short facts it keeps from the cards it works, read
  back when a later card is about the same thing. Search, edit or forget any
  of it. Approve the same kind of call five times in a row and it suggests
  the rule that lets it act alone; one tap accepts.
- **Teammates that act.** Let a teammate use your project's tools (a shop, a
  CRM, a mailbox) with a rule for each action: do it, do it up to a limit,
  ask first, or never. An ask-first call reaches you on the card and in your
  chat app exactly as it would be made; Approve makes that call, Deny doesn't.
  Every call is a receipt on the card and the teammate's page, and the lead
  can change a rule from plain words.
- **AI teammates.** Agents with a soul file you write (who they are, how they
  write, what they decide alone, what they ask first, what they never do)
  decide "Person decides" zones and handle their own zones, write replies,
  move cards on, and bring you what their rules say to ask about, in your chat
  app under their own name. A note for this week, a daily summary, a pause
  button, and templates for support, sales, ops and triage. Answer a
  teammate's question with a tap, or in your own words, in Telegram, Slack,
  Discord or Teams.
- **Wait for replies.** A Wait zone after a Send email zone waits for the
  person to answer. Their reply moves the card on and joins its discussion;
  with none in time, the card takes its no-reply path, like a nudge that stays
  in the same thread. Only replies from people the card wrote to count.
- **Time limits.** Any zone can remind whoever a card is waiting on after a
  while, and Holding and decision zones can move it on. New templates: Reply
  and follow up, and Decisions that don't stall.
- **Send-backs are planned again.** Sending a result back with a note has the
  planner update the plan with it; a note asking for more becomes a change
  you see and approve before anything builds.

## 0.5.0 — 2026-09-25

Flows: your process drawn as zones that cards move through, with agents doing
the work and people deciding.

- **Canvas and chat.** Draw flows on a canvas or describe them to the lead;
  every change is a card you confirm. Templates for coding, research, issue
  triage, spam filtering, lead, effort and exception routing, and email replies.
- **Triggers.** Buttons (and public forms), schedules, GitHub, Linear, other
  flows and webhooks start cards on their own.
- **People.** Owners, followers, @mentions, and a flow owner whom decisions
  go to, in their chat app.
- **Steps with and without AI.** Build and Research tasks; scripts with no AI;
  **Sort** with Jev (TypeSafe's decision model, through OpenRouter); **Draft**
  with Claude; web requests with secrets kept to headers; email through your
  own mail server; any of a project's MCP tools; updates to the GitHub or
  Linear issue a card came from.
- **Decisions from your phone.** Telegram, Slack, Discord and Teams
  messages carry the draft with Approve, Edit and Send back.
- **Email in.** An Email inbox trigger turns new mail into cards (IMAP, or
  a Google account signed in with Google), and replies to the sender stay
  in the thread. Automatic replies and your own mail never become cards.
- **Code in flows.** Scripts in Python, Node or shell (or a file in the
  project) get the card as data; what they print is passed on, a `goto:` line
  picks the next zone, saved secrets arrive as variables, and a schedule can
  run a script to make a card of each item it prints.
- **Chat in.** A Slack, Discord or Teams channel, or a Telegram group, feeds
  a flow after `flow 12` in it: each message is a card, replies in its thread
  join the discussion, and an Update zone answers in that thread.
- **Live canvas.** A flow open in several browsers changes in all of them
  the moment a card moves, and shows who else has it open and which card
  they're looking at.
- **Insights.** Where each flow breaks, how scripts do, how well sorting
  sorts, and every step's log.
- **Linux.** A one-command installer, and Claude and Gemini agents fenced
  with bubblewrap the way Seatbelt fences them on macOS.
- **First look.** `demo` now includes two flows mid-flight, and an empty
  Flows page offers a working example.
- **Settings.** An Email section, and "Check again" that really tests an
  API key.

Schema 90: the database upgrades itself on first start.
