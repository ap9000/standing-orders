# AI teammates

An AI teammate works your flows' cards the way an employee would, within
rules you write for it. It reads each card, decides, writes replies and moves
cards on, and it comes to you when its rules say to ask first. Open
**Teammates** (from the Flows page) to add one.

## Who a teammate is: its soul file

Each teammate is a soul file: a short Markdown document it reads every turn.

```markdown
---
name: Maya
role: Support
---

## Who you are
You look after this team's customers. You're warm, calm and quick.

## How you write
- Short, friendly, plain words. Sign off as "The team".

## What you know
- Refunds go back to the original payment method within 5 business days.

## Decide on your own
- Refunds and replacements up to $50.

## Ask first
- Refunds over $50, anything legal, or a threat to leave.

## Never
- Promise dates or discounts that aren't written here.
```

Start from a template (Support rep, Sales rep, Ops coordinator, Triage lead)
or a blank file, and make it yours on the teammate's page. Every save is a new
version, and **Download** gives you the file. Keep secrets out: a soul file
that looks like it holds a key is refused.

## Putting a teammate to work

- **On a decision:** in a flow, open a "Person decides" zone and choose the
  teammate under **Who decides**. It approves (sending the draft as written,
  or as it rewrote it), sends the card back with a note, or hands it to the
  flow's owner with what it would do and why. Your decision then arrives in
  your chat app as always, with the teammate's note.
- **On its own zone:** add a **Teammate handles it** zone. Say what to do there
  and list the answers it can pick, each leading to a zone. It picks one and
  writes what the next zones send (the email body is then
  `{{stage.<zone id>}}`). When its rules say to ask, it asks you a question
  and the card waits. Answer with a tap in your chat app (one button per
  option, plus **Answer in words**: reply to the prompt on Telegram, or send
  your next message in Slack, Discord or Teams), on the card, or through the
  lead. It carries on with your answer.

Every decision is written down with its reason: in the card's history ("Approved
by Maya (AI): within my $50 limit") and on the teammate's page.

## Talking to your teammates

- Its questions and hand-offs reach you in your chat app, under its name
  ("Maya · Support: …").
- **Tell Maya something** on its page passes on a note for the next turns ("this
  week, offer free shipping instead of a refund"). Lasting rules belong in the
  soul file.
- The lead chat can add teammates, change one section of a soul file ("Maya can
  approve refunds up to $100 now"), pause or resume one, pass on a note, or
  answer its question for you. Each is a card you confirm.
- Each teammate sends its manager a summary after 5 pm: what it decided,
  handled and handed over. **Send today's summary** sends one now.

## Limits

- Teammates do flow work only: they never approve a code task, a merge or
  spending. Those stay with people, or a signed hands-off mode.
- **Pause** stops a teammate: decisions it would make go to people, and zones
  it handles wait until you resume it.
- Each teammate has a daily limit of turns (200 by default, in **Settings** on
  its page); past it, its decisions go to people until tomorrow.
- A teammate reads each card through Claude on this computer's sign-in, with
  no tools, no files and no internet: it only decides, and Standing Orders does
  what it decided within the zone's choices. The card is data to it, never
  instructions, and a card that tries to change its rules is handed to a person.
