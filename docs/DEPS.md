# Dependencies

Two independent dependency trees, each with its own lockfile: the root
CLI/control-plane (`package.json` / `package-lock.json`) and the design
system (`design/package.json` / `design/package-lock.json`). They are not
an npm workspace, so nothing is deduped or version-locked across the two.

This note records what's currently pinned and resolved, and flags the
upstream changes worth knowing about. **No version bumps here** — notes
only. Network access was unavailable when this was written (2026-09-03),
so "latest upstream" claims below come from prior knowledge, not a fresh
registry check — verify before acting on them.

## Root (`package.json`)

| Package | Declared | Resolved |
| --- | --- | --- |
| `@types/node` | `^26.2.0` | 26.2.0 |
| `happy-dom` | `^20.12.0` | 20.12.0 |
| `tsx` | `^4.23.12` | 4.23.12 |
| `typescript` | `^7.0.2` | 7.0.2 |
| `vitest` | `^4.1.10` | 4.1.10 |

All five are dev-only; there are no runtime dependencies at the root.

**Flag: TypeScript 7.** The root already tracks the TS7 line — the
native (Go-ported, "tsgo"/Corsa) compiler line that replaced the
JS-hosted `tsc` as the primary distribution. That's the single biggest
upstream shift touching this repo. Worth a periodic sanity check that
`tsc -p tsconfig.build.json` and `tsc --noEmit` still behave the way the
scripts in `package.json` expect — TS7's diagnostics and some edge-case
type-checking behavior differ from the TS5/6 line, and third-party
`.d.ts` files in the ecosystem are still catching up.

**Flag: Vitest 4.** Already on the current major; no action needed, just
noting it so a future pass doesn't assume 4.x is stale.

## Design system (`design/package.json`)

| Package | Declared | Resolved |
| --- | --- | --- |
| `class-variance-authority` | `^0.7.1` | 0.7.1 |
| `clsx` | `^2.1.1` | 2.1.1 |
| `radix-ui` | `^1.1.3` | 1.6.7 |
| `tailwind-merge` | `^2.6.0` | 2.6.1 |
| `@fontsource/ibm-plex-mono` | `^5.1.0` | 5.3.0 |
| `@fontsource/ibm-plex-sans` | `^5.1.0` | 5.3.0 |
| `@tailwindcss/cli` | `^4.0.0` | 4.3.3 |
| `@types/react` | `^18.3.0` | 18.3.31 |
| `react` (dev, peer `>=18`) | `^18.3.1` | 18.3.1 |
| `react-dom` | `^18.3.1` | 18.3.1 |
| `tailwindcss` | `^4.0.0` | 4.3.3 |
| `typescript` | `^5.6.0` | 5.9.3 |

**Flag: TypeScript version split across the two trees.** The root is on
the TS7 native compiler; `design` is still declared against `^5.6.0` and
resolves to 5.9.3 — the last of the JS-hosted 5.x line, one major behind
root. Not a bug (design's `tsconfig.json` build step doesn't share
anything with root's), but worth deciding deliberately rather than by
drift: either bring `design` onto the same TS7 line for consistency, or
document why it's staying on 5.x (e.g. plugin/tooling compatibility).

**Flag: React pinned to 18, peer range says `>=18`.** The `devDependency`
is locked to `^18.3.1` for local build/test, but the `peerDependency` is
just `>=18`, so nothing here actually exercises the design system against
React 19 (stable since Dec 2024) even though consumers on 19 are allowed
to install it. If any consumer has moved to 19, this package's own dev
loop wouldn't catch a breakage. Worth checking whether that's intentional
(deliberately conservative dev pin) or just never revisited.

**Flag: `radix-ui` unified package.** Declared range (`^1.1.3`) already
resolves well ahead (1.6.7) inside that range — this is the newer,
single-package `radix-ui` (superseding the old per-primitive
`@radix-ui/react-*` install pattern), so this repo is already on the
current approach. No action, just confirming it's not legacy.

**Flag: Tailwind CSS v4.** Already on the v4 line (Oxide engine, CSS-first
config) via both `tailwindcss` and `@tailwindcss/cli`. No action.

## Suggested cadence

Re-run this check periodically (or whenever `npm outdated` is available)
and compare against this file's "Resolved" columns — that tells you what
moved without needing registry access. Update the flags above rather than
appending new ones once a flagged item has been decided on.
