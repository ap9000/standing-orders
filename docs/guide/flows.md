# Flows

A flow is your process drawn as zones on a canvas. Each card is one piece of
work moving through them. Open **Flows**, then **Edit flow** to draw.

## What a zone can do

| Zone | What happens |
|---|---|
| Holding | Cards wait until someone moves them. |
| Build | An agent does the work as an ordinary task, with its approvals and checks. |
| Research | An agent investigates and writes a report; no code changes. |
| Person decides | Someone approves, or sends the card back with a note. |
| Run a script | One of the project's scripts (Python, Node or shell) runs with the card, with no AI. What it prints is passed on, and it can pick where the card goes. See [Code in flows](code.md). |
| Sort | Jev picks where the card goes, in under a second. |
| Draft | Claude writes a reply, summary or note from the card. |
| Web request | Calls an API with the card's details. |
| Send email | Emails from your own address. |
| Use a tool | Calls one of the project's tools (MCP servers). |
| Update where it came from | Comments on (and can close) the GitHub or Linear issue the card came from, or answers in the chat thread it came from. |
| Message | Posts to the project's chat. |
| Wait | Waits for a reply to the card's email, or for a set time. |
| Done | The end. |

Each zone has a **Then** (where cards go next) and, where it can fail, an
**If it fails** path. A Sort zone has one arrow per answer instead, plus
**If it isn't sure**. See [Steps that reach outside](steps-outside.md) for
Sort, Draft, Web request, Send email and Use a tool.

## Waiting for replies and time limits

Put a **Wait** zone after a Send email zone to wait for the person to answer.
When they reply, the card moves on (**When they reply**), with their reply in
its discussion and in `{{stage.<wait zone>}}` for the zones after it. If no
reply comes within the time you set (up to 30 days), the card takes **If no
reply**: a follow-up email, say, or a person's decision. A follow-up stays in
the same email thread. A Wait zone can also just wait a set time, then move
on.

Only a reply from someone the card emailed counts, and out-of-office answers
never do. Replies are read from the inbox in Settings → Email, about once a
minute, while any card is waiting on one. An email inbox trigger on the same
mailbox hands replies to their card instead of starting a new one. A reply
that arrives when the card isn't waiting still joins its discussion, and its
owner hears about it.

Any other zone can have a **Time limit**: after that long, whoever the card
waits on is reminded once (the decider for a Person decides zone; otherwise
the card's owner, or the flow's). A Holding or Person decides zone can also
move the card on then, for example to a decision anyone can make.

Each waiting card shows when its wait or time limit runs out, in your own
time.

## Fill-ins

Text in a zone can use: `{{card.title}}`, `{{card.description}}`,
`{{card.email}}` (the first email address the card mentions), `{{note}}` (the
latest send-back note), and `{{stage.<zone id>}}` (what an earlier zone said:
a report, a draft, a sort, an API's answer).

## What starts cards

**Triggers** add cards on their own: a button (which can also be shared as a
public form), a schedule, GitHub (new issues, a label, new pull requests,
failed checks), Linear, another flow's cards reaching a zone, a webhook, an
**email inbox**, or a **chat channel**.

An email inbox trigger turns each new message in your mailbox into a card:
the subject is its title, and the sender and the new part of the message
(without quoted history or signature) are its details. You can limit it to
some senders or domains, or to subjects with a word in them. It reads the
account set up in Settings → Email, only reads (nothing is marked or moved),
and starts from the moment it's added. Out-of-office replies, bounces and
your own messages never become cards.

A **chat channel** in Slack, Discord, Teams or a Telegram group feeds a flow
once you connect it from the channel itself: where Standing Orders is, send
`flow 12` (the flow's number, from its address). Each new message there
becomes a card, the bot says so in the message's thread, and replies in that
thread join the card's discussion. `flow off` stops it. In Teams, mention
Standing Orders in each message; in a Telegram group, turn the bot's privacy
mode off in BotFather so it sees every message, not just commands.

## People

Every flow has an **owner**: whoever made it, until changed in **Edit flow**.
A Person decides zone can ask the owner, a named person, or anyone who
approves. The decision reaches them in their chat app with the draft in front
of them. Cards have owners, followers and a discussion with @mentions.

The canvas is live: when a card moves, or someone comments or decides,
everyone with the flow open sees it at once. Faces at the top show who else
is here, and a face on a card shows who has that card open.

## Templates

Coding, Research, Issue triage, Spam filter, Lead routing, Effort routing,
Exception routing, Email replies, Reply and follow up (a nudge in the same
thread after 3 days without an answer), Decisions that don't stall (a
reminder, then anyone can decide), and Blank.

## Insights

**Insights** on a flow shows where cards fail or get sent back, how long they
wait, how each script does, how well Sort zones sort (how often people moved
a sorted card elsewhere, by how sure Jev was), and every step's run log.

## From chat

The lead draws, edits and runs flows from plain words: "add a step that
emails the customer once I approve", "move the Stripe card to billing". Each
change is a card you confirm.
