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
   proof to remain verified;
9. prove a second dispatch is empty.

It does not push, open a pull request, mutate a real project, synthesize a
provider response, or accept `short`/`refuted` proof. A failed run keeps its
database, worktree, evidence, and live log and prints their location.

```sh
npm run certify:provider -- --provider claude --model sonnet --review
npm run certify:provider -- --provider codex --model gpt-5.6-sol --review
```

Use `--keep` to retain a passing sandbox and `--output <file>` to write the
machine-readable certificate. Version 2 records the source revision, a hash of
the built runtime and canary scripts, each CLI step's elapsed time and exit
status, and the participating run identities. Every CLI boundary rechecks the
runtime; changing the build during a canary prevents a passing certificate.
The exact changed-path set is also checked against the two requested files.

The approver and approval are automated fixture setup inside the disposable
database. A passing result demonstrates this bounded workflow without a manual
rescue; it does not measure planning-policy quality across arbitrary projects.

## Current real-provider baseline

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
