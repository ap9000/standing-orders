# Changelog

## Unreleased

- **Stream it out.** Settings → Monitoring sends what Standing Orders does
  to the tools a company already watches. The audit stream delivers every
  sealed ledger entry, in order and at least once (retried, never skipped),
  to a webhook, each request signed with a secret shown once
  (`x-standing-orders-signature: t=…,v1=<HMAC-SHA256 of "t.body">`), and/or
  a folder of JSON Lines files; each batch carries the chain head, so the
  receiver keeps its own copy of the checkpoints. Traces send each run as an
  OpenTelemetry span (OTLP over HTTP) under its task's trace: timings,
  model, tokens and cost, never a prompt or code. `/metrics` serves
  Prometheus metrics to an instance operator's API token.
  `standing-orders monitoring` shows how each destination is doing.
  Schema 104.

- **Storage kept in check.** Standing Orders used to keep every build
  checkout and every staged release forever (78 GB here after a week). Now
  the worker removes a finished task's clean checkout two days after it was
  let go (a result marked complete, or a release candidate, a week after,
  since a deploy installs the build in its checkout). Its branch and commits stay; a checkout with
  anybody's changes, or commits on no branch, is never touched, nor is
  anything an unfinished or unplaced task works on. Each removal is in the
  action ledger. A deploy keeps the release it installed, the one before,
  the newest few and any a service or the CLI runs from; older ones go with
  the database backups they hold. `standing-orders storage` shows where
  the disk goes.

- **Audit you can prove.** The action ledger is now a hash chain: each entry
  is sealed with the one before it, and the ledger page (or `ledger verify`)
  says whether it still verifies, or the first entry that was changed,
  removed or added. Instance operators make checkpoints to copy off the
  machine (`ledger checkpoint`); `ledger verify --checkpoint` compares one,
  and is what proves history before it wasn't rewritten.
  Every task has an evidence pack, as a printable page and JSON: who filed
  it, the approved terms and approvers, the rules in force, agents and
  cost, changed files, checks, completion, publication and its sealed
  ledger entries (`task evidence <id>`). The ledger page's Audit export (or
  `ledger export --from --to`) downloads a date range with a pack for each
  task. AI teammates' tool calls (and who approved or undid them) and new
  coordinators are in the ledger now too. Schema 103.

- **Separation of duties.** Every task records who filed it (the person, or
  the person a coordinator acts for). Settings → Approval rules (or
  `project rules`) lets an instance operator turn on, per project,
  "someone other than the requester approves" and protected work: the whole
  project, or paths like `infra/**`, need two different people to approve
  the same scope ("1 of 2" until the second; a changed scope starts over),
  and never an operating mode, a routine, a watched run or an AI teammate.
  Whoever wrote the scope or made a standing order counts as a requester,
  and a result whose actual diff reaches protected files on a one-person
  approval completes only by someone else. Everything is off until a
  project turns it on. Schema 102.

- **Sessions and API tokens.** Settings → Sessions & tokens lists where
  you're signed in and signs any of it out; sessions now survive a restart.
  API tokens (read, or act as you, never approve) replace passwords on
  requests for scripts and CI, expire in 30 to 365 days, are shown once and
  named in the ledger on every request. Coordinator credentials expire (90
  days unless `--days`), and runner tokens a year after registering.
  Schema 101.

- **Sign in with your identity provider.** Settings → Sign-in connects Okta,
  Microsoft Entra, Google or any OpenID Connect provider. People sign in
  there; their groups make their account and set its role (Operator or
  Viewer) and projects again at each sign-in. Approvals are confirmed by
  that sign-in (within ten minutes, or "Confirm with …"), not a password.
  Passwords can be kept for instance operators only, as a way in if the
  provider is down, and an existing account can be linked. Schema 100.

- **Hardening for teams.** Five wrong passwords lock a name for 15 minutes,
  on every road a password takes (signing in, a request, a step-up), and one
  address guessing across names runs out of tries. The action ledger now
  records sign-ins and policy changes with what changed (the permission
  default "Auto → Full access", a teammate's tool rules, an agent choice, an
  operating mode), and shows installation events to instance operators. A
  person's coordinators end with their standing. `/healthz` answers a probe,
  errors are always logged (`STANDING_ORDERS_LOG_FORMAT=json` for JSON
  lines), and more key shapes (Stripe, Google, GitLab, Telegram and Discord
  tokens, passwords in URLs) are blanked. Schema 99.

- **One look on every page.** Board, Inbox, Next, Done, System, Portfolio,
  Code and Settings → Tools now sit in the same workspace as everything else,
  with the same navigation and search. Live pages (System, Activity) refresh
  themselves inside it without disturbing a form you're filling in. Sign-in,
  invites, error pages and "not found" share the look too, and a one-time
  secret (a worker token, an invite link, a pairing code) gets a focused page
  in the same style, still with no script on it.
- **Connect a service with one click.** Stripe, Notion, Linear, Sentry, Jira,
  Intercom, Attio and ten more connect by signing in on the service's own
  page: no key to copy. The sign-in stays in the tool's secrets file and is
  renewed before it runs out. A starter kit's Connect also lets its teammate
  use the tool. The lead points you to the right tile instead of asking for a
  key.
- **Starter kits.** Support desk, Bug triage, Sales follow-up and Ops
  requests each set up a teammate, the flow it works and its buttons in one
  click. The kit's page lists what's left (email, the tools it uses) and
  **Try it** puts a sample card in front of the teammate so you see it work.
  The lead can set one up too.
- **Smoother page changes.** Moving between pages fades the old one out
  before the new one arrives, so text never overlaps mid-change, and the
  sidebar holds still.

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
