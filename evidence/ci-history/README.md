# CI history evidence (2026-09-16)

Companion to `docs/CI_HISTORY_2026-09-16.md`: the `test` job checkout in `.github/workflows/ci.yml` now fetches full history so the historical delivery-manifest test has its Git objects.

- `shallow-clone-repro.txt` — temporary `--depth 1` clone of this branch: unchanged `node scripts/delivery-manifest-check.mjs` fails with `bad object ba101e69…` (exit 1), then passes all 23 paths, hashes and the digest after `git fetch --unshallow` (exit 0). `$TMP` stands for the mktemp directory, removed afterwards.
- `workflow-parse.txt` — YAML parse of `ci.yml`: only the `test` job checkout sets `fetch-depth: 0`; the other three jobs keep the default.
- `typecheck.txt` — `npm run typecheck`, exit 0.
- `focused-manifest-test.txt` — existing `src/provider.test.ts` manifest test, 1 passed.
- `final-gate-window.txt` — run 1715 gate receipt (`exit 124 · timed out` at 600 s, no failing test), the operator's temporary 900 s window for the same command (grant 4), GitHub run 35158288446 passing all eight checks at this head, and the implementation checks re-run in fix-1.

The unchanged approved full command belongs to the native final gate for this candidate and was not run here.
