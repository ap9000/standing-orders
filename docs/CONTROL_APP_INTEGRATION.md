# Control-app branch assessment and integration

Assessed 2026-09-12 UTC. Source: `origin/codex/control-app` at
`15a1d9cb1779908d21d010facb46f7f323e6b31c`, including `cdcee38`. Integration began
on current main `639bdc3`. The source forked at `dbf37bf` and changed 84 files;
a direct merge conflicted in 22 files, including execution, approval, and store
code. This integration ports useful additions onto current main and records the
source ancestry without replacing newer implementations.

## Feature disposition

| Source work | Integration decision |
| --- | --- |
| Native macOS shell and build script | Added, with isolated preview state, schema fencing, private restart credentials, a fresh challenge before login, asynchronous bounded helpers, independent preview service labels, and recoverable bundle replacement. |
| Separate desktop worker supervisor | Replaced with the existing `up` controller. Dynamic project additions enter through the native picker's exact authorized paths; enrollment-list edits alone grant nothing. The console sees only projects the controller has admitted. |
| Guided setup and project instructions | Adapted to current project boundaries, default configuration, existing managed instructions, and password/nonce approvals. Never rewrites existing signed scopes. Preparation's effect on subsequent runs is shown explicitly. |
| Provider connection facts | Added normalized non-spending checks, bounded output, credential stripping, request coalescing, refresh, and authentication-mode-aware caching. Subscription and API-key states remain distinct. |
| OpenRouter catalog and pricing | Added account/public discovery, bounded responses, credential-specific caching, precise small prices, explicit unknown/conditional prices, search, and saved-choice preservation. |
| Daily/weekly/local-time schedules | Added to the existing routine parser, digests, scheduler, CLI guidance, and form. Retained interval, single-flight, downtime, and approval behavior. |
| Alternative task composer, project overview, delivery buttons | Kept current main's newer composer, board, plan/review views, publication controls, and execution policy. Added setup entry points to existing screens. No parallel page hierarchy. |
| Local Claude-only chat session, investigation/context engine, chat preferences | Kept current `mate` and `subscription-chat` implementation, which already covers durable conversation and multiple subscription providers. Did not add a second engine or silently expand retention to the old branch's 90-day default. |
| Passwordless approval sessions and old control terms | Kept current password/nonce ceremony, signed routing, raw-authority validation, and publication gates. The native Keychain copy signs in; it does not fill approval passwords automatically. |
| Per-task stop/resume and interruption settlement | Distinct useful work, not ported in this integration. The old patch changes schema, lease settlement, proof/review completion, and timeout interpretation beneath newer recovery code. It needs a bounded forward port with stop-vs-completion races and crash certification. Existing holds and service shutdown remain available; neither is advertised as this feature. |
| Telegram conversational queue, media, progress, confirmation cards | Distinct useful work, not ported as a competing chat service. Its implementation depends on the discarded chat engine and old authority tables. Reimplement the transport over current `mate` sessions, confirmations, and bridge leases. Existing Telegram notification/decision behavior remains. |
| Source store migrations and executor changes | Retained current schema 50 and current execution/reliability stack. No older migration numbers, alternate proof settlement, absolute-timeout policy, or publication bypass was imported. |

The last two feature gaps remain explicit roadmap items, not claims of parity
with every experiment on the source branch. The source commits remain available
for reference after their merge ancestry is recorded.

## Verification

Final typecheck passed. The full regression run passed **127 files and 2,422
tests**, with 12 existing skips (2,434 total). Earlier integration failures
were corrected before this gate. No live-provider release pilot was claimed.

The integration adds tests for setup approval tampering, stale configuration,
wrong credentials, nonce replay, cross-project attempts, managed instructions,
foreign/symlink paths, provider facts, catalog failures, price display, daylight
changes, and native database/credential isolation.

A built-helper lifecycle test runs the actual desktop entry point and current
`up` controller with a disposable database: authenticated startup, selected
projects only, adding a second project without restart, rejection of an
unselected registry entry, no tasks or model work, and clean worker retirement.
The macOS bundle compiles and passes ad-hoc code-signature verification.

Chromium checks cover setup preview/approval, invalid timezone correction with
retained Tuesday/time selection, the exact weekly approval summary, model search
that preserves the selection, and mobile layout. Artifacts and command logs are
under the integration worktree's `output/` directory.

Native window interaction and the Keychain/launchd UI journey remain unverified:
macOS was locked during the visual check. The direct controller lifecycle test
is not a substitute for that final packaging check. No production app was
installed and the live schema-49 controller/database was not upgraded.

## Subsequent delivery

The handoff milestone is merged on main as `7b9bebe` and its certified runtime
now runs in the installed desktop service. The live database migrated from
49 to 51 with preserved data. See [the deployment record](assessments/LIVE_UPGRADE_2026-09-12.md).
The next wave is [per-task stop and resume](TASK_CONTROL_PLAN.md). The original
verification section above records what was checked at integration time.

## Original sequence

The next quality milestone remains [contract fidelity through every handoff](CONTRACT_HANDOFF_PLAN.md):
retain filed requirements in planning, retain risk/quality/budgets/permissions in
revision creation, and give reviewers verifiable inherited context. It addresses
observed dogfood failures rather than duplicating existing features.

After that, forward-port per-task stop/resume, then mobile conversation/media
over the existing chat engine. A stop must target one exact owned run, preserve
work, prevent late success/publication after acknowledgement, survive a crash,
and require fresh authority when resuming changed terms. Telegram must share
session identity, spend limits, proof visibility, and confirmation rules with
the web console. Neither milestone calls for another worker or chat engine.
