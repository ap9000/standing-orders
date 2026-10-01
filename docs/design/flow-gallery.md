# Flow gallery and sharing

*Design brief, 2026-10-01.*

## Today

Twelve templates (src/flows.ts FLOW_TEMPLATES): Coding, Issues to PRs, Research, Issue triage, Spam filter, Lead routing, Effort routing, Exception routing, Email replies, Reply and follow up, Decisions that don't stall, Blank; plus starters (Fix failing CI, Issues become tasks, Overnight queue, Morning plane review). Half are business workflows; the developer flows people would brag about are missing. A flow can't leave the installation it was made in.

## A gallery

Settings → Flows and Flows → New show templates as a gallery: grouped (Ship code, Keep it healthy, Hear from users, Operations), each card with a one-line promise, a small diagram of its zones, what it needs (GitHub, CI, a script, Telegram…) and "Use this". Using one asks only for what it needs (project, label, schedule, branch), previews in plain words what it will do and never do, then creates it, triggers included.

New templates (each built only from existing zone and trigger kinds):

- **Overnight bug bash**: issues labelled `bug` during the day → built after 22:00 → one morning digest of Ready results to review.
- **Fix failing CI**, **Morning plane review**, **Nightly real-model journeys**, **Weekly upkeep**: the starters and the flows that test Toolroll, generalised for any project (the journey and upkeep scripts become "your test command" and "npm/pip/cargo outdated" choices).
- **Flaky test hunter**: a failed check on main whose test passes on rerun → research which test and why → a fix or a quarantine, behind approval.
- **Dependency PR babysitter**: Dependabot/Renovate PRs with red CI → a fix on their branch, behind approval.
- **Release notes writer**: a tag or a merged release PR → a draft changelog and release notes from the merged PRs → a person approves → posted.
- **Docs follow the code**: a merged PR that changes a public API or CLI → a docs update task.
- **Error to fix**: a webhook from Sentry (or any error tracker) → sort by whether it's ours, new and frequent → research the cause → build the fix.
- **Feedback to feature**: messages in a Slack/Discord channel or GitHub discussions → sort (bug, idea, question) → research a short spec for ideas → a person decides.
- **PR second opinion**: pull requests opened by people → a research zone writes a review (risks, missing tests) → posted as a comment after a person approves.

## Export and import

- **Format:** a versioned, readable JSON file, `*.toolroll-flow.json`: `{ format: "toolroll-flow", version: 1, name, about, needs: [...], zones: [...], triggers: [...], scripts: [...] }` using the lead's step vocabulary (titles, kinds, next/ifFails, instructions), so a person can read and edit it.
- **Never exported:** secrets and their values, webhook addresses and hashes, tokens, people's names and chat bindings, card history. Triggers export with their settings but import switched off until a person confirms them; repository-specific values (GitHub repo, labels, branch) become parameters the import asks for.
- **CLI:** `toolroll flows export <id> [--out file]`, `toolroll flows import <file|url> --repo <p> [--yes]` (a URL may be a gist or raw GitHub file; preview first, always).
- **Console:** Export on a flow's menu (downloads the file); Import on Flows → New (file or URL), with the same preview as a template.
- **Templates are files too:** the gallery's built-ins are shipped in this format, so `export` of a template and `import` of the file round-trip exactly.
- **Safety:** imported instructions are untrusted text: shown in the preview, never run before a person confirms; scripts import as disabled until approved like any project script.

## Done when

The gallery shows the new templates, each creatable in under a minute; a flow exported here imports on another installation and produces the same zones and paths with triggers off; secrets never appear in an export (test with planted values); screenshots at 1440 and 390.
