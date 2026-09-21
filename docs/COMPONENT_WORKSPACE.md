# Component workspace

The browser is a React client of Standing Orders' existing operations and local database. The lead conversation sits beside admitted crew tasks; opening a task preserves its exact result identity. On phones, selected work uses the full screen with a way back to the conversation.

## Delivered structure

- React 19 with a small esbuild bundle, shared controls, Radix dialogs, and adapted AI Elements conversation/workflow primitives. Pinned source and dependency licenses ship with the package.
- Shared navigation for Chat, Tasks, Projects, Knowledge and Settings. Existing project and knowledge forms remain available within the shell. Advanced installation tools retain their native pages.
- Cookie-authenticated workspace snapshots project the existing assignment/status services. They admit projects before reading crew details, cap crew at 40 families, and link to the named task and run. Browser code receives no CLI credential.
- The chat composer sends once. A lost response triggers a receipt read, never another submission. Drafts are scoped to the account, conversation and task, expire after 24 hours, and survive reload within the same browser tab. New edits are preserved when an earlier message's receipt arrives.
- Results retain the existing saved changes, checks, feedback and explicit revision operations. Native forms keep their exact signed terms and tokens. Refreshes preserve edited forms and disable an approval when its terms change. Mark complete uses the existing exact-result operation.

The lifecycle remains **Plan → approved work → Ready → Complete or explicit revision**. No automated reviewer, resubmission stage, provider adapter, database migration or new execution state is introduced by this UI change.

## Operating and extending it

`npm run build` compiles the server and bundles `src/browser/app.tsx` into `dist/browser`. Normal release packaging carries JavaScript, CSS and notices together. The installed server caches its own build's assets; use the normal checked deployment to replace the UI and worker together. Rebuilding source alone is not deployment.

`npm run typecheck` checks server and browser sources. The test build helper detects nested browser edits, removals and missing assets. Native HTML remains available if the bundle cannot load. Existing authenticated handlers and CSRF checks still own every mutation.

Keep expensive result rendering on demand behind the existing tabs and disclosures. Source previews, a richer knowledge search and recent-conversation navigation can be migrated individually using these primitives; they do not need another task system or model SDK. The current project and knowledge controls are retained native forms rather than a second React implementation.

Validation and screenshots for this candidate are recorded alongside the release assessment. Browser viewport checks do not establish physical-phone keyboard behavior.
