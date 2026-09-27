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

## Sign in with your identity provider

**Settings → Sign-in** (instance operators) connects Standing Orders to
your organisation's identity provider: Okta, Microsoft Entra, Google,
Auth0, Keycloak or anything else that speaks OpenID Connect.

1. In the provider, create a web app (OpenID Connect, authorization code)
   and register the redirect address the Sign-in page shows
   (`https://your-address/login/sso/callback`). Have it put the person's
   groups in the ID token (the `groups` claim, or name another).
2. On the Sign-in page, enter the provider's address (its issuer), the
   client ID and secret, and which groups may sign in: each group is an
   Operator or a Viewer, in all projects or chosen ones. A person's first
   matching group decides, and it decides again at every sign-in, so
   moving someone between groups in the provider changes their access here.
   No matching group, no entry. `*` matches everyone.
3. Choose who may still use a password: everyone, or only instance
   operators (a way in if the provider is down).

The client secret is kept in `sign-in.json` beside the database (`0600`),
never in the database. People who sign in with the provider have no
password here: an approval or any other step-up is confirmed by their
provider sign-in in the last ten minutes, or by a **Confirm with …** link
that asks the provider to check them again. An existing account can be
linked to the provider from the Sign-in page. Every sign-in, account made,
access change and settings change is in the action ledger.

## Guessing a password gets nowhere

Five wrong passwords in a row lock that name for 15 minutes, doubling with
each further lock up to a day; the right password waits too. Every place a
password is typed counts: signing in, a request that carries one, and each
password step-up inside the console. One address trying many names runs out
of tries on its own. Locks are kept in memory, so restarting Standing Orders
clears them.

## Everything is on the record

**Workflows → Action ledger** keeps who did what, and when: work (runs,
decisions, approvals), console requests, account and access changes,
sign-ins (and refusals, locks and sign-outs), and policy changes with what
changed, like "Auto → Full access" for the permission default, a teammate's
tool rules, an agent choice or an operating mode. Filter it, open it as JSON,
or export it as CSV. It is append-only in the database; it doesn't copy
passwords, prompts or request bodies. A name typed at sign-in that isn't an
account is kept as "unknown account", in case it was a password in the wrong
box.

## Running it as a service

`/healthz` answers `{"status":"ok"}` (or 503) for a load balancer or
orchestrator, from any address, and says nothing else. Errors are always
logged; set `STANDING_ORDERS_LOG_FORMAT=json` for one JSON object per line.
Key-shaped text is blanked from log lines.

## Secrets never travel

Keys and passwords are entered only on the console's secure screens, never
in chat. They live in private files (`0600`) on this computer, never in the
database, a log, a card or a message. Key-shaped text is blanked from logs,
drafts and anything a step keeps.

A service you connect with one click is signed in on its own page. Standing
Orders registers itself with that service, and the code that comes back only
works with a one-time proof it kept (PKCE). The token it gets is kept like
any key.

## Outside steps are pinned

A web request's host is fixed in the zone, and card text is encoded in its
address, so a card can't redirect it. Email goes only to checked addresses,
and a password is sent to the mail server only over TLS.

## Public addresses

Webhooks and shared forms can be public (through Tailscale Funnel or a
reverse proxy) while the console itself stays private. Each webhook has its
own secret address, and GitHub and Linear deliveries are checked with their
signatures.
