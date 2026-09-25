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
| Run a script | One of the project's scripts runs on the card's work, with no AI. |
| Sort | Jev picks where the card goes, in under a second. |
| Draft | Claude writes a reply, summary or note from the card. |
| Web request | Calls an API with the card's details. |
| Send email | Emails from your own address. |
| Use a tool | Calls one of the project's tools (MCP servers). |
| Update the issue | Comments on, and can close, the GitHub or Linear issue the card came from. |
| Message | Posts to the project's chat. |
| Done | The end. |

Each zone has a **Then** (where cards go next) and, where it can fail, an
**If it fails** path. A Sort zone has one arrow per answer instead, plus
**If it isn't sure**. See [Steps that reach outside](steps-outside.md) for
Sort, Draft, Web request, Send email and Use a tool.

## Fill-ins

Text in a zone can use: `{{card.title}}`, `{{card.description}}`,
`{{card.email}}` (the first email address the card mentions), `{{note}}` (the
latest send-back note), and `{{stage.<zone id>}}` (what an earlier zone said:
a report, a draft, a sort, an API's answer).

## What starts cards

**Triggers** add cards on their own: a button (which can also be shared as a
public form), a schedule, GitHub (new issues, a label, new pull requests,
failed checks), Linear, another flow's cards reaching a zone, a webhook, or
an **email inbox**.

An email inbox trigger turns each new message in your mailbox into a card:
the subject is its title, and the sender and the new part of the message
(without quoted history or signature) are its details. You can limit it to
some senders or domains, or to subjects with a word in them. It reads the
account set up in Settings → Email, only reads (nothing is marked or moved),
and starts from the moment it's added. Out-of-office replies, bounces and
your own messages never become cards.

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
Exception routing, Email replies, and Blank.

## Insights

**Insights** on a flow shows where cards fail or get sent back, how long they
wait, how each script does, how well Sort zones sort (how often people moved
a sorted card elsewhere, by how sure Jev was), and every step's run log.

## From chat

The lead draws, edits and runs flows from plain words: "add a step that
emails the customer once I approve", "move the Stripe card to billing". Each
change is a card you confirm.
