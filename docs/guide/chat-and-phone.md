# Chat and your phone

## The lead

**Chat** is a conversation with the lead: an assistant that reads your
projects, drafts tasks and flows, and proposes actions as cards you confirm.
It never changes anything without your confirmation, and never asks for a
password or key: those go on secure screens.

## Telegram

Settings → Telegram: paste a bot token from @BotFather, then send the bot the
`/pair` code shown. After that:

- Things that need you arrive as messages, and decisions have buttons.
- A flow decision shows the draft with **Approve**, **Edit** and **Send
  back**. Edit asks for your version as a reply; it replaces the draft and
  comes back to approve. Send back asks what should change.
- You can talk to the lead from the chat, and reply to a task's messages
  to talk about that task.

## Slack, Discord and Teams

Each can be connected under Settings and used to talk to the lead and
confirm its cards. Only one app sends alerts: the one you choose as primary
(Settings → Notifications).

A flow decision arrives there with the draft and **Approve**, **Edit** and
**Send back**, as on Telegram. Edit and Send back ask for your next message
in that chat: it becomes the new draft (which comes back to approve) or the
note the card goes back with. Send "cancel" to leave it; the question
lapses after 30 minutes.

## The phone itself

The console works on a phone browser. Add it to your Home Screen (iPhone) to
get notifications from Settings → Notifications → This device. To reach it
away from home, put it on your tailnet: `standing-orders up --host 0.0.0.0
--allow-host <your-machine>.ts.net:4180`.
