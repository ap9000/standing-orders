# Never Stuck release certification

`npm run certify:provider` is the real-provider release canary. It creates a
disposable Git repository and isolated Standing Orders database, then drives
the public CLI through the same path as a real task:

1. create an approver and a repository-bound worker;
2. route planning, building, repair, and review to one exact provider/model;
3. approve a repository verification command;
4. file a task and ask the provider to inspect the repository and draft its
   scope and acceptance rubric;
5. approve that exact digest;
6. build in a leased worktree, commit on a non-default branch, rerun the
   approved check, and adjudicate the evidence;
7. require a `verified` criterion matrix;
8. with `--review`, request an independent review and require the resulting
   proof to remain verified, with every signed criterion independently upheld
   by the requested reviewer (missing, contradictory, and `cannot-tell`
   judgements fail this self-contained fixture);
9. prove a second dispatch is empty.

It does not push, open a pull request, mutate a real project, synthesize a
provider response, or accept `short`/`refuted` proof. A failed run keeps its
database, worktree, evidence, and live log and prints their location.

```sh
npm run certify:provider -- --provider claude --model sonnet --review
npm run certify:provider -- --provider codex --model gpt-5.6-sol --review
```

Use `--keep` to retain a passing sandbox and `--output <file>` to write the
machine-readable certificate. Version 3 records the source revision, a hash of
the built runtime and canary scripts, each CLI step's elapsed time and exit
status, and the participating run identities. Every CLI boundary rechecks the
runtime; changing the build during a canary prevents a passing certificate.
The exact changed-path set is also checked against the two requested files.
Version 2 only checked the completed reviewer and surviving machine verdict;
that was insufficient when a reviewer could not read its evidence. Version 3
requires actual upholding judgements. Codex review now receives sealed text
through stdin and real screenshot attachments while shell access stays disabled.
General reviews may still truthfully answer `cannot-tell`; that answer does not
certify this fixture.

The approver and approval are automated fixture setup inside the disposable
database. A passing result demonstrates this bounded workflow without a manual
rescue; it does not measure planning-policy quality across arbitrary projects.

## Contract handoff integration (2026-09-12 UTC)

Runtime source `1b3a2ba` passed the full regression suite (132 files, 2,507
passed, 12 skipped), typecheck/build, and two complete real-provider journeys:
detailed filing → planning → exact approval → build → independent review →
narrow revision → fresh approval → review of inherited code. Claude `opus` and
Codex `gpt-5.6-sol` preserved the high-risk/strict contract, left the helper
unchanged, upheld all three criteria after each build, and needed no rescue.
The subsequent broader pilot passed 20/20, with 44/44 criteria independently
upheld and eight screenshot artifacts verified. The executable hash stayed
`bb56ddbee14dec222d131fb65483d27aec51858ebb559571bfdd7bc38edc9d5c`.

See [the integration report](assessments/CONTRACT_HANDOFF_RESULT.md) and
[compact machine-readable evidence](assessments/evidence/contract-handoffs.json).
Implementation included operator-led hardening. The live controller was on
schema 49 at that checkpoint and has since been upgraded to schema 52; see
[the deployment record](assessments/LIVE_UPGRADE_2026-09-12.md) and
[the Stop/Resume certification](assessments/STOP_RESUME_CERTIFICATION_2026-09-12.md).
The earlier crash matrix below has a different runtime identity;
it has not been relabeled as a crash certificate for this integration.

## Earlier crash matrix and real-task pilot

Candidate `a9caf73` passed the September 11 macOS arm64 / Node 22.22.0 run:

| Gate | Result |
|---|---|
| Automated regression suite | 120 files; 2,361 passed; 12 existing skips |
| Actual watch-process SIGKILL matrix | 120/120; 20 each at planning, setup, building, after commit, verification, review |
| Real-provider pilot | 20/20; Claude `sonnet` 10/10 and Codex `gpt-5.6-sol` 10/10 |
| Independent acceptance | 44/44 criteria upheld; eight sealed desktop/mobile screenshots |
| Ownership and completion | Zero overlapping writers, orphan runs, duplicate dispatches, or manual rescues |

One malformed reviewer response was corrected automatically in its existing
session, with both review rows retaining the same watch ownership. The original
build was not repeated. The pilot's median total duration was 116s and p95 249s;
these include setup, checks, and review, without a direct-provider comparison.

The crash matrix took 596s and recorded unchanged runtime/input hash
`b6343447f624f83d54c328a2a0a5269bf7968535ab92b04de7384298b17d3523`.
The pilot recorded unchanged executable hash
`1c20903bfe1645eda0867489a32bb0def0a66860217fe4dabc9fe744ba760147`.
Local certificates are `output/certification/crash-certified-120.json` and
`pilot-20.json`; `validation-2026-09-11.md` contains the detailed report and
links to 169 copied, hash-verified artifacts in `pilot-evidence/`.

Planning recovery safely awaits approval; interrupted review recovery safely
requires attention, and the review stage of the crash canary now continues
through one explicit `task review` retry (schema v50, bounded review retries):
the recovered attempt reads as attempt 1 of 3 needing attention, the retry is
admitted as attempt 2 under the same sealed route with every sealed input
re-verified, the fixture review lands, the source build and its commit are
unchanged, a further ask refuses (`already-reviewed`), and a further tick
dispatches nothing; before the explicit retry, the automatic producer is
replayed over the interrupted attempt and proven to queue nothing (explicit-only
retries). Automatic review retry does not exist and is not certified;
the explicit retry is certified with fixture providers only, never a real
model. The pilot used fixed scopes approved before dispatch, with the
exclusions described below. That earlier pilot did not upgrade main or the live
worker; the subsequent deployment is recorded in the links above.

## Earlier bounded provider baseline

The latest bounded integration certificate tested `cf328cb` on 2026-09-11,
macOS arm64 / Node 22.22.0. Both version-3 runs used the clean runtime hash
`a9500a300add097a48b4eab4b1155bdf056648fd8550d539e980cb4ff99b05af`:

| Provider | Model | Elapsed | Proof and independent review |
|---|---|---:|---|
| Claude subscription | `sonnet` | 149s | 3/3 verified and independently upheld; duplicate dispatch refused |
| Codex ChatGPT subscription | `gpt-5.6-sol` | 270s | 3/3 verified and independently upheld; duplicate dispatch refused |

The same revision passed 119 test files / 2,354 tests (12 existing skips) and
100/100 real-writer recovery fixtures in 26.5s. Local JSON certificates are in
`output/certification/reliability-{claude,codex,recovery}.json`. These bounded
workflows do not complete the broader pilot or Windows release gates.

## Earlier baseline

This is the September 8 baseline, not certification of every later change.
September 11 real work exposed additional recovery and handoff gaps. The
[unattended completion plan](UNATTENDED_PLAN.md) tracks their fixes and the
broader release pilot; those gates remain open alongside the Windows checks.

Certified on 2026-09-08 on macOS arm64, Node 22.22.0:

| Provider | Model | Result | Elapsed | Proof |
|---|---|---:|---:|---|
| Claude subscription | `sonnet` | pass | 74s | 3/3 criteria passed; duplicate dispatch refused |
| Codex ChatGPT subscription | `gpt-5.6-sol` | pass | 323s | 3/3 criteria passed; duplicate dispatch refused |

The first live Claude run exposed and fixed a real planner defect: Claude's
built-in `plan` permission mode diverted the required protocol handoff into
`~/.claude/plans`. The planner now permits its nonce-bound handoff file and
still rejects the result unless the leased worktree is otherwise untouched.
The first Codex result exposed overuse of `manual-review`; planning guidance
now reserves that evidence kind for claims checks, changed paths, or visual
proof cannot establish.

## Repeated local recovery checks

`npm run certify:crash -- --rounds 20 --concurrency 20 --output output/certification/crash-120.json`
drives actual public-CLI watch processes through six external-process barriers:
planning, dependency setup, building, immediately after commit, verification,
and review. It kills the supervisor with SIGKILL, refuses a replacement before
the normal 90-second watch lease expires, and attempts takeover while the old
subprocess survives. No injected clock or real model is used in this matrix.

Every case checks exclusive writing, terminal run accounting, and duplicate
dispatch. Build recovery must preserve the file contents and original commit,
run the approved verification, and produce verified proof without another
commit. Planning must produce a fresh draft awaiting approval. An interrupted
review must close as interrupted and show that attention is needed, and (since
v50) must then complete through exactly one explicit retry with one source
build, one commit, two reviewer roots, and no further review dispatch; this
does not certify an automatic review retry, which does not exist. Failed and
passing fixtures are retained with subprocess event logs, SQLite state, and
worker output.

The crash tests exposed planner checkout reclamation, verification-process
ownership, post-commit proof settlement, and claimless reviewer recovery bugs.
The fixes include schema v49: reviews and their correction children explicitly
belong to a watch incarnation. Older review rows remain unbound. POSIX process
group markers protect surviving descendants after a group leader exits;
detached descendants and physical Windows process trees remain separate gates.

### Real-provider task pilot

`node scripts/pilot.mjs --playwright /installed/playwright/index.mjs --output output/certification/pilot.json`
runs ten assignments through both subscription providers, split into two
successive batches with fresh sessions and repositories. Each fixed contract
is approved before unattended watch dispatch; the mode automatically requests
an independent review. The pilot never repairs a provider's checkout manually.

Assignments cover backend bugs, changes across multiple files, approved offline
dependency setup, revisions of existing behavior, and browser interactions.
The UI assignments execute Chromium at desktop and mobile sizes and capture
PNG evidence. Verification files and dependency definitions are seeded inputs;
the final diff must change only the approved implementation paths. A completed
case requires verified proof, every criterion independently upheld, and empty
duplicate dispatch. Every failed case remains in the report and retains evidence.

This pilot uses fixed scopes. Provider-authored planning is covered by the
separate provider canary; mid-flight human revisions, comparisons with direct
provider latency, real account exhaustion, and Windows remain separate gates.
The pilot records those limits, per-step durations, source/runtime identity,
run results, and intervention counts instead of claiming universal reliability.

`npm run certify:recovery -- --rounds 100 --output output/certification/recovery.json`
uses disposable repositories and real writer processes without invoking a model.
It injects expiry of the controller's liveness and checks three cases: a partial
draft, a completed handoff, and an existing commit with a late writer. Every
case must refuse reuse while the writer lives, fence its stale completion, and
preserve the draft and commit when a successor takes custody after writer exit.

The certificate records each case and its source revision. A failure retains
the fixture; `--keep` also retains passing fixtures. This is narrower than
killing a real worker at every lifecycle boundary. Detached descendants,
interrupted verification reuse, native session recovery, and Windows reboot
remain separate gates.

## Automatic fallback is a separate claim

A successful canary proves that a provider is installed, authenticated, and
can complete this workflow now. It does not prove that the provider's real
subscription-exhaustion terminal is recognizable. `standing-orders providers`
reports `auto fallback` separately and currently says **not armed** for Claude
and Codex. The state machine fails closed until a real exhausted-account
terminal is captured, reviewed for its exact CLI version, and that version is
proven at spawn. See [fallback-fixtures.md](fallback-fixtures.md).

## OS containment and restart certificates

Bounded, disposable checks accompany the OS containment and login
recovery wave ([PROCESS_CONTAINMENT.md](PROCESS_CONTAINMENT.md)):

```sh
npm run test:native-containment                       # kernel-backed cgroup2 tests; explicit skip where the facility is missing
SO_EXPECT_NATIVE_CONTAINMENT=1 npm run test:native-containment   # a skip is a failure (what CI's delegated-cgroup job runs)
npm run certify:restart -- baseline --db ~/.config/standing-orders/orders.db --label com.standing-orders.watch.<slug> --runner <existing-runner> --task <must-complete-task>
#   … log out and in, or reboot — the tool never does — then:
npm run certify:restart -- verify --db ~/.config/standing-orders/orders.db --baseline output/certification/restart-baseline.json --expect reboot
npm run certify:launchd                               # tests actual OS relaunch; can fail when launchd defers it
node scripts/desktop-recovery-canary.mjs --app <bundle> # tests controller recovery under an activated disposable service
```

The restart certificate records boot identity (the kernel's own token),
runtime, service state, containment status and live custody without a
credential, and verifies a fresh heartbeat (a loaded service is not a
working controller), settlement of what the old boot left pending by the
controller's own rules, and completion of explicitly selected tasks. The v2
baseline binds the database file, code/runtime and service identity. Generic
recovery only proves interrupted attempts moved on. Its output lists the exact
limits: LaunchAgents resume at user login after a reboot, Linux user
services depend on login or linger, the Windows logon trigger is not a boot
service, and a reboot that did not happen is never claimed. The launchd
certificate installs a throwaway label and removes it; run it only where a
disposable install is acceptable. On the development host the OS deferred
relaunch beyond 90 seconds; the controller guard is tested separately and
cannot prove automatic OS job startup. Physical login/reboot and protected
project access remain installation gates. See the operator's wave assessment
for actual release evidence; unit tests with injected boot IDs are not a
physical reboot certificate.

## Physical Windows checklist

**Handoff status:** pending the physical Windows PC. The original pre-Windows
baseline passed: the same canary passes both subscription providers on macOS, and
Windows CI passes Task Scheduler/link/dispatch plus the native `cmd.exe`
command seam on Node 22 and 24.

Run this on the Windows PC from a normal PowerShell session, after installing
Git, Node 22 or 24, Claude Code, and Codex CLI and signing into both CLIs:

```powershell
npm ci
npm run typecheck
npm run build
npx vitest run src/daemon.test.ts src/link.test.ts src/dispatch.test.ts src/command-shell.test.ts

npm run certify:provider -- --provider claude --model sonnet --keep --output output/certification/windows-claude.json
npm run certify:provider -- --provider codex --model gpt-5.6-sol --keep --output output/certification/windows-codex.json
```

The builder now runs approved dependency setup and post-build verification
through the native command shell: `cmd.exe /d /s /c` on Windows and
`/bin/sh -c` on macOS/Linux. The canary's `node --test` verification therefore
exercises that Windows path rather than silently skipping it.

Then certify Task Scheduler with a real connected repository:

1. Start Standing Orders once and connect the repository.
2. Register a dedicated worker bound to that repository and write its token to
   a file with `runner register --token-file`.
3. Run `daemon install --runner <name> --token-file <file> --repo <repo>`.
4. Require `daemon status` to report running and a fresh worker heartbeat.
5. File and approve the same small canary task in the app, close the app and
   terminal, and confirm Task Scheduler finishes it with verified proof.
6. Reboot, confirm the scheduled worker returns, then run another small task.
7. Run `daemon uninstall --runner <name> --repo <repo>` when the test is done.

Those physical Task Scheduler and post-reboot checks remain outside the
automated and macOS real-provider baseline. Later reliability changes also
need the regression and unattended-work certification described above.

The separate automatic-fallback claim also remains intentionally unarmed until
a real exhausted-account terminal is captured for the exact installed CLI
version. That requires an actually exhausted subscription; ordinary successful
provider runs cannot safely synthesize it.
