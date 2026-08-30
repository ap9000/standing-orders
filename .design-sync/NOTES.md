# design-sync notes — standing-orders

- The DS is **authored, not extracted**: the console itself is zero-dep server-rendered HTML in `src/serve.ts`. `design/` is a dev-only package (npm `files: ["dist"]` at repo root keeps it out of the published tarball). Source of visual truth: the "Standing Orders Console" Figma file (The Operations Ledger) + Alex's 2026-08-30 direction to build it as **custom shadcn**.
- shadcn primitives were vendored from the registry (`https://ui.shadcn.com/r/styles/new-york-v4/<name>.json`) into `design/src/components/ui/`, with `@/lib/utils` rewritten to relative `../../lib/utils.js`. They import the **unified `radix-ui` package**, not `@radix-ui/react-*`.
- Build is `tsc` + `@tailwindcss/cli` (Tailwind v4, CSS-first config in `design/src/globals.css`). `cssEntry` must stay the **compiled flat file** `styles/operations-ledger.css` — an `@import`-only stub ships verbatim and fails `[CSS_PLACEHOLDER]`/`[CSS_IMPORT_MISSING]`.
- No playwright chromium is installed on this Mac. The render check runs against system Chrome via `DS_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` (validate + capture + resync all honor it).
- Preview pattern: the theme is dark-committed, but capture screenshots composite on a white matte — every **ground-transparent** component's preview wraps its cells in `style={{ background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}`. Self-surfaced components (Card, Ledger, NavBar, AttentionCard, CeremonySurface) don't need it.
- Fonts ship via `cfg.extraFonts` from `@fontsource/ibm-plex-sans` (400/500/600/700) + `@fontsource/ibm-plex-mono` (400) in `design/node_modules`.
- `componentSrcMap` pins the lowercase shadcn filenames and null-excludes the Card sub-parts (they stay bundle exports for composition, no own cards).

## Known render warns

(none — 16/16 clean, 33 cells graded good on 2026-08-30)

## Re-sync risks

- **Upload never happened from the authoring session**: `/design-login` was unavailable over Remote Control. No `projectId` is pinned — the first desktop sync must create the Claude Design project (§1 fresh path) and record the pin. Until then the project-side anchor doesn't exist; a re-sync re-verifies everything (correct).
- Vendored shadcn sources drift from the upstream registry silently; re-vendor deliberately (same registry URLs), never as a side effect.
- Re-vendoring or `npm install` refreshing `design/node_modules` can move fontsource file paths/weights — `[FONT_MISSING]`/`[FONT_DANGLING]` would name it.
- The registry fetch and `npm install` need network; the build itself is offline-clean.
- Grades were written against the 2026-08-30 sheets; sources unchanged → carried forward (verified: final capture printed 16 carried forward, 0 cleared).
