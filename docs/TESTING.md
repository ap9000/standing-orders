# Testing

Standing Orders is tested end to end: the real CLI, the real console and the
real worker, driven through a real browser with real Claude turns and real
builds. Unit tests are kept only where an end-to-end run can't be the guard.

## End to end (the main suite)

| Run | What it covers |
|---|---|
| `npm run e2e:flows` | Flows: the lead drawing flows and scripts from plain words, Jev sorting, Draft and the owner's decision, web requests, email and MCP tools, a card through a real build and a person's decision, failing scripts and Insights, public forms, webhooks, GitHub and schedule triggers, @mentions. |
| `npm run e2e:app` | Everything else: signing in and out, every page on desktop and phone, the CLI, a task filed in the console → planned by Claude → approved with a password → built → checked → marked complete, sent back with a note and rebuilt, sent back asking for more (the planner updates the plan and you approve the change), a build that stops to ask answered on the decision page, stopped and resumed; the lead answering and filing tasks; projects, knowledge, skills, tools, models, routines, theme, search; code steps in Python and Node with answers and secrets, a script schedule; a real email inbox (GreenMail in Docker) through to a threaded reply; two people on a live canvas; the demo. |
| `npm run e2e` | Both. |

Each run makes a throwaway world (`scripts/e2e-kit.mjs`) and writes
`output/e2e/<run>-<time>/report.md`, with screenshots and a picture of every
open page when a check fails. `--only <pattern>` runs just some checks;
`--keep` keeps the world to look at.

Needs: `npm run build`, `claude` signed in, `gh` signed in, git, sqlite3,
Playwright's Chromium (`npx playwright install chromium`), Docker for the
mail server, python3. An OpenRouter key in Settings → AI providers for Jev.
A run spends a few Claude turns and a few real builds (about 45 minutes for
both).

The release gate runs both before a build ships.

## Unit tests (`npm test`)

Only three kinds are kept, and only these kinds are added:

- **Migrations** (`migration-*.test.ts`): an upgrade never loses or bends
  what is already in someone's database.
- **Security rules**: secrets never reaching a card, a log or a page; the
  fence around agents and scripts; approvals, pairing and who may decide;
  sign-in and webhook signatures; proof and evidence.
- **A bug that was fixed**: the test that would have caught it.

A new feature gets an end-to-end check, not a unit test. A test that only
pins wording or layout doesn't belong in either.
