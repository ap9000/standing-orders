# Dependencies

Two independent package trees have separate lockfiles: the root CLI/control plane and `design/`. They are not an npm workspace. This inventory was refreshed from the checked-in manifests and lockfiles on 2026-09-12. It makes no claim about the latest registry releases and changes no dependency versions.

## Root

| Package | Kind | Declared | Resolved |
| --- | --- | --- | --- |
| `@types/node` | development | `^26.2.0` | 26.2.0 |
| `happy-dom` | development | `^20.12.0` | 20.12.0 |
| `tsx` | development | `^4.23.12` | 4.23.12 |
| `typescript` | development | `^7.0.2` | 7.0.2 |
| `vitest` | development | `^4.1.10` | 4.1.10 |

## Design system

| Package | Kind | Declared | Resolved |
| --- | --- | --- | --- |
| `class-variance-authority` | runtime | `^0.7.1` | 0.7.1 |
| `clsx` | runtime | `^2.1.1` | 2.1.1 |
| `radix-ui` | runtime | `^1.1.3` | 1.6.7 |
| `tailwind-merge` | runtime | `^2.6.0` | 2.6.1 |
| `@fontsource/ibm-plex-mono` | development | `^5.1.0` | 5.3.0 |
| `@fontsource/ibm-plex-sans` | development | `^5.1.0` | 5.3.0 |
| `@tailwindcss/cli` | development | `^4.0.0` | 4.3.3 |
| `@types/react` | development | `^18.3.0` | 18.3.31 |
| `react` | development | `^18.3.1` | 18.3.1 |
| `react-dom` | development | `^18.3.1` | 18.3.1 |
| `tailwindcss` | development | `^4.0.0` | 4.3.3 |
| `typescript` | development | `^5.6.0` | 5.9.3 |

## Maintenance boundaries

The root has no runtime dependencies. Its compiler and the design compiler resolve to different major versions; validate each package with its own build command when updating either tree.

The design package declares React `>=18` as a peer but its development lockfile uses React 18.3.1. That local build does not establish compatibility with every version allowed by the peer range. Add consumer-version validation when expanding the supported release matrix.

For an upgrade, query the registry at that time, review release notes, update the relevant lockfile, and run the affected build and tests. Refresh this inventory from the resulting lockfiles.
