# Models

Settings → Models shows which AI tools are installed and lets you pick a model for each role from lists that stay current.

## Where the lists come from

| Provider | Source | Prices |
| --- | --- | --- |
| Claude | Anthropic models in OpenRouter's public list, mapped to the ids the Claude CLI and API use (`anthropic/claude-opus-5.5` → `claude-opus-5-5`) | OpenRouter list price |
| Codex | The Codex CLI's own list for your account (`~/.codex/models_cache.json`) | OpenRouter's `openai/…` price when listed |
| Gemini | Google text models in OpenRouter's public list | OpenRouter list price |
| OpenRouter | OpenRouter's full public list, filtered to models that support tool calling | OpenRouter list price |

The public list needs no key, and nothing about you or your projects is sent. Each check is saved in `orders.db` (schema 76), so pickers, chat pricing and notices all use the same snapshot. A model that disappears from its source is no longer offered, but saved choices keep their name.

## Short names follow the newest release

For Claude, `opus`, `sonnet` and `haiku` always run the newest model in that family. The page shows what each one currently means, e.g. "Opus · latest (Opus 5.5)". Choose an exact id such as `claude-opus-5-5` to stay on one version.

## Default agents

Planner, Builder, Reviewer and Repair set the installation defaults, the same rows as `standing-orders config set <phase>`. New tasks use them. Approved tasks keep the agents they were approved with.

A few rules still apply:

- Gemini cannot review.
- Repair must use the builder's provider. When you change the builder to another provider, Repair goes back to following the builder.

## CLI updates

The page compares `claude --version`, `codex --version` and `gemini --version` with the npm registry. If a CLI is behind and was installed with its native installer (`claude update`) or with `npm -g`, you'll see an **Update** button. It runs only when no task, chat turn or session is in progress, then reads the version again. Anything already running keeps the version it started with.

## Automatic checks and notices

Checks are off until an approver turns them on (Models page → Automatic checks, or `standing-orders models watch on`). While on, the service checks every 6 hours and sends one message per event through your usual channel (Telegram, Slack, Discord or Teams):

- **New model:** e.g. "Claude Opus 5.5 ($4 / $20 per 1M tokens). Agents set to "opus" use it from now on." Each model is announced once. The first check only records the current list and announces nothing.
- **CLI update:** e.g. "Codex 0.156.0 is available". Each version is announced once.

Opening the Models page also refreshes the lists if the last check is more than an hour old.

## Chat

When you choose a direct-API chat model (Anthropic API or OpenRouter), spend is reserved at the live list price, rounded up to whole micro-dollars per token. If the catalog has never been fetched, the built-in price table is used instead. The chat model box suggests the live Claude and Codex lists with their prices.

Leads can read all of this with the `get_models` tool: each default agent and the exact model it runs, CLI versions and updates, and models from the last two weeks. Changes are made on the Models page.

## Terminal

```
standing-orders models status          # CLI versions, updates, new models, automatic checks
standing-orders models list --provider claude|codex|gemini|openrouter
standing-orders models check           # fetch the lists and check versions now
standing-orders models update codex    # only while nothing is running
standing-orders models watch on|off
```
