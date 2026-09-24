# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use
**Report a vulnerability** on the repository's Security tab (GitHub private
vulnerability reporting). Include what you found, how to reproduce it, and
the version or commit. You'll get an acknowledgement within a few days.

Only the latest release is supported with security fixes.

## Security model in brief

Standing Orders runs AI coding agents on your own computer, as your own
user. What it promises:

- **No agent approves its own work.** Approvals need your password on a
  screen that restates the exact terms, and the agent fence keeps your
  remembered login, runner tokens and the database out of agents' reach.
- **The agent fence.** Standing Orders' own secrets (the state folder beside
  the database, except the build's worktree, and `~/.standing-orders`) are
  denied to agents by the operating system: Codex through its own sandbox on
  every platform; Claude and Gemini through a sandbox on macOS. On Linux and
  Windows, Claude's file tools are fenced but its shell is not yet, and Gemini
  is not fenced. The README's "What an agent can reach" has the full table.
- **Secrets stay out of the database, URLs and logs,** in 0600 files.
- **Reviews** run with no tools, confined to their sealed files.

Known limits:

- In API-key mode, an agent's own provider key is in its environment.
  Subscription mode (the default) puts no key there.
- **Full access** lets an agent change files anywhere on your computer
  outside the fence. Use it only for repositories you trust.
- The console serves plain HTTP. Keep it on localhost or a private network
  such as Tailscale; don't expose it to the internet.
