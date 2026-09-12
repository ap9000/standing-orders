# Completion and recovery certification — 2026-09-12

The subsequent [final rollout record](FINAL_ROLLOUT_2026-09-12.md) supersedes
the deployment-gate status below and records the newer prompt-fix preview.

The project-access, action-ledger, CSV and bounded auto-approval wave merged in
[PR #4](https://github.com/ap9000/standing-orders/pull/4). The completion and
recovery follow-up is [PR #5](https://github.com/ap9000/standing-orders/pull/5).
Its certified implementation is `4352044e1e60d2e15515e00b8a43f099d52e5727`. Subsequent documentation changes
record the evidence without changing the executable runtime.

## Completion behavior

All held-session exit paths now share one bounded cleanup operation. The
supervisor records current descendants before asking the agent to exit, starts
cleanup when the root exits, and waits for both descendant settlement and the
output relay. A recorded descendant or unclosed inherited pipe cannot turn an uncertain hold
into a successful exit. Failure to establish cleanup returns code 126 and
records custody uncertainty before the exit callback. Recovery retains the
existing custody fences; it does not signal saved PIDs after ancestry is lost.

The deterministic regression tests fail on the previous implementations and
pass on the final implementation. An unrelated conversation-loop test now
waits for actual brief, decision, answer and completion states instead of
assuming asynchronous work finishes within fixed sleeps.

## Gates

| Gate | Result |
|---|---|
| Local regression suite | 150 files; 2,643 passed, 23 platform skips |
| Implementation CI | All eight Linux/macOS/Windows checks passed, including delegated cgroup v2 and Windows Job Object execution |
| Real Claude sonnet and Codex gpt-5.6-sol | 2/2 signed auto-approval journeys; four criteria independently upheld; no approval/review requests after planning began |
| Crash matrix | 12/12: two each at planning, setup, building, after commit, verification and review |
| Automatic planning recovery | 2/2: crash → lease/custody recovery → one mode approval → one commit → verified independent review |
| Persisted stop intent | 1/1: resume refused while the orphan lives; explicit resume preserves the draft after cleanup |
| Isolated desktop controller | Clean exit recovered in 1.761s; SIGKILL recovered in 182.912s; explicit stop verified |
| Migration rehearsal | Schema 52 → 55; all 345,510 historical rows across 94 tables preserved; integrity and foreign keys passed |

No crash case produced overlapping writers, an open recovered run or duplicate
dispatch. Baseline planning still waits for approval. An interrupted review
still requires its bounded explicit retry, and an intentional stop still
requires explicit resume. The new automatic-planning cases specifically prove
completion without those additional approval actions under the signed policy.
The crash fixtures use deterministic provider responses; the two real-provider
journeys do not kill a provider. These are separate claims.

[Sanitized machine-readable evidence](evidence/completion-recovery.json)
records source and executable hashes, gate results and raw certificate hashes.
Full local receipts are under `output/certification/`. Initial failures remain
recorded rather than being relabeled as passing certificates.

## Desktop deployment boundary

The signed staged bundle is
`~/Applications/Standing Orders Completion Preview.app`. Its executable tree
matches the certified CLI:

`b2683219f5570c5ae4c278f7c9883221c0d49dcccbff03e2784d38bb91e518a1`

The working live controller remains on schema 52. The existing macOS Documents
access gate has not been cleared, and live work was active during certification.
The migration rehearsal used a consistent private snapshot; it did not migrate
or stop the live controller. Private snapshots and their receipts remain under
`~/.config/standing-orders/staged-upgrades/`.

After that OS access gate is cleared, verify access with the staged runtime,
let active work drain, take a fresh backup, then replace the exact modern
service through the existing upgrade path. Verify saved login, challenge/HMAC
and fresh project heartbeats before recording deployment. The staged snapshot
is a rehearsal, not a replacement for that fresh backup.

The desktop canary uses a temporary project and explicitly activates an isolated
LaunchAgent. It proves recovery of the controller child under an already active
supervisor. It does not certify protected Documents access, automatic OS service
activation, a physical login/reboot, or macOS kernel process containment.
