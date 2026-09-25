# Security

## You approve what runs

A task's scope (goal, boundaries, checks, the agent and model) is shown in
full and approved before anything is built, and the approval is bound to
exactly those terms. Results wait for a person to accept them. Releases pass
the project's own check command before they can be deployed.

## Agents can't read Standing Orders' secrets

Agents run as your own user, so without a fence they could read your saved
login, keys or the database and approve their own work. The fence closes that
at the operating system:

| Agent | macOS | Linux |
|---|---|---|
| Codex | its own sandbox profile | its own sandbox profile |
| Claude | Seatbelt sandbox | bubblewrap (install `bubblewrap`) |
| Gemini | Seatbelt sandbox | bubblewrap |

Each run records how it was fenced. Without bubblewrap on Linux, Claude is
held back only by its own file-tool rules; install it.

## Secrets never travel

Keys and passwords are entered only on the console's secure screens, never
in chat. They live in private files (`0600`) on this computer, never in the
database, a log, a card or a message. Key-shaped text is blanked from logs,
drafts and anything a step keeps.

## Outside steps are pinned

A web request's host is fixed in the zone, and card text is encoded in its
address, so a card can't redirect it. Email goes only to checked addresses,
and a password is sent to the mail server only over TLS.

## Public addresses

Webhooks and shared forms can be public (through Tailscale Funnel or a
reverse proxy) while the console itself stays private. Each webhook has its
own secret address, and GitHub and Linear deliveries are checked with their
signatures.
