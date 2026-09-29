# Getting started

## Install

On macOS or Linux, with Node.js 22.13 or newer and git:

```sh
curl -fsSL https://raw.githubusercontent.com/ap9000/standing-orders/main/install.sh | sh
```

It installs the `toolroll` command and starts it with your projects in
`~/Projects`. `standing-orders`, the older name, still works. You can also run
it without installing: `npx standing-orders up`.

The first start prints your login and saves it in
`~/.config/standing-orders/up-login.txt`, then opens the console at
http://127.0.0.1:4180.

To look around first, `npx standing-orders demo` opens a throwaway sandbox
with tasks and two flows already mid-flight. It never spends and never
reaches outside.

## Your first project

Open **Projects** and add a folder or a GitHub repository. Any repository you
put in the projects folder later connects by itself.

Agents need a coding CLI signed in on this computer: Claude Code (`claude`),
Codex (`codex`) or Gemini. Settings → AI providers shows which are connected.

## Your first task

Open **Chat** and say what you want in plain words. The lead drafts a task
with a goal, boundaries and checks for you to approve. Nothing is built until
you approve it, and every result waits for you to accept it.

## Start from a kit

**Starter kits** (linked from an empty chat, Flows and Teammates) set up a
working team in one click: an AI teammate, the flow it works, and its
buttons. Each kit's page is a checklist of what's left, with the next step on
each line: connect email, connect the tools the teammate uses, and **Try it**,
which puts a sample card in front of the teammate so you see it work.

- **Support desk:** Maya drafts a reply to each customer email and you approve
  it before it goes out; anything it can't answer comes to you.
- **Bug triage:** Theo sorts each new issue into bug, question or noise,
  answers questions, and turns real bugs into fix tasks you approve. It can
  bring in your GitHub issues.
- **Sales follow-up:** Leo writes back to each new lead, you approve the
  email, and it follows up when there's no answer in three days.
- **Ops requests:** Ada approves routine requests under $200 without you and
  brings you everything else.

Setting a kit up twice changes nothing; its page opens instead. You can
also ask the lead: "Set up the support desk kit in shop".

## Your first flow

Open **Flows**. With no flows yet, **Try an example** makes one: Claude
drafts a reply to a sample customer question, and you approve or edit it. Or
pick a template under **New flow**, or ask the lead: "Make a flow where Jev
sorts new support emails into billing, bugs and questions".

## On your phone

Settings → Telegram connects a Telegram bot you make with @BotFather. Pair
your chat with the `/pair` code it shows, and decisions arrive with buttons.
See [Chat and your phone](chat-and-phone.md).

## Updating

`npm install -g standing-orders@latest`, then start it again. Your database
upgrades itself on the first start; back it up first if you like:
`sqlite3 ~/.config/standing-orders/orders.db ".backup orders-backup.db"`.
