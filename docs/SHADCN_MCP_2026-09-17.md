# shadcn MCP for project agents

Adds the user-requested [shadcn MCP server](https://ui.shadcn.com/docs/mcp) to this project's Claude Code and Codex configuration. Both use `npx --yes shadcn@4.21.0 mcp`; keep the package version in `.mcp.json` and `.codex/config.toml` synchronized when updating.

This is the first connection intended for the proposed unified Library. It uses existing client configuration; the Library management screen is not implemented by this change. It does not install React components, initialize a new UI framework, add registry credentials, change the running Standing Orders application, or grant new task permissions. Private registries are not configured.

## Usage

Start a new agent session in a checkout containing these configuration files. Codex loads project configuration for trusted projects. Claude interactive sessions may ask to approve the project server; its normal headless worker sessions load project MCP configuration. Independent review and shared-chat isolation remain as implemented by Standing Orders and do not acquire this server.

Ask: **Find button components in the @shadcn registry.** Use the explicit `@shadcn` registry when the project has no `components.json`. Public registry search and the dedicated add-command tool were verified against this repository without creating that file or installing components. Installing a component later still requires a suitable target project and an authorized task.

## Observed evidence

The real stdio server completed initialization using MCP `2025-11-25`, exposed seven tools, and returned 33 matching button items with a three-item page. `get_add_command_for_items` returned `npx shadcn@latest add @shadcn/button`; that command was not executed. Shadcn 4.21.0 has an upstream display issue in search output: inline add-command previews say `[object Promise]`. Use the separate add-command tool; do not treat those previews as executable commands.

The saved evidence in `evidence/shadcn-mcp` contains actual server replies and the probe source. It proves initialization, discovery, search and command lookup, not component installation or actual model use. Codex's configuration reader recognized this project's server as enabled. Claude's interactive configuration reader identified the project entry and correctly reported its pending approval state; no global approval setting was changed.

## Release checks

Prepared at verified main `d54bb730222c079492d1452bca73161ba211fe6b`. Apply this prepared commit in a native task beginning at that base. Reuse the bounded live MCP evidence and focused checks for unchanged configuration. Preserve the original dirty checkout and all unrelated configuration. Let the native final machine gate run the unchanged approved typecheck/test/build command once for the candidate, followed by independent review. No application rebuild/deployment or database migration is needed to activate project configuration in new worker checkouts after publication.

Sources: [shadcn setup](https://ui.shadcn.com/docs/mcp), [Codex project MCP configuration](https://developers.openai.com/codex/mcp), [Claude project scope](https://code.claude.com/docs/en/mcp#project-scope).
