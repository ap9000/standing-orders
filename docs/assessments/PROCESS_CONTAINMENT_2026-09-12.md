# Process containment and controller recovery — 2026-09-12

PR #3 integrates native process lifetime containment and schema 53 recovery.
The installed desktop is still the certified schema 52 release. A working
schema 53 preview app is staged in Applications; protected-project access
must pass before replacing the live installation.

## Runtime and evidence

The fixed source `2cda503cb997fe7993e98bf5bb3498f938d9e82d` produced executable
tree SHA-256 `6c207f33dfff2ec9f5bb00d0489281ef8b8574fc0318e7f9511914d956b650bf`.
The following Windows test correction changed no executable files. Subsequent
documentation records results; it does not retroactively certify an earlier
builder commit. Sanitized certificate receipts and original artifact hashes
are in [certificates.json](../../evidence/process-containment-2026-09-12/certificates.json).
Full local records are retained under `output/process-containment` in the main
checkout. No database, private desktop configuration or provider credential is
included in committed evidence.

| Check | Observed result |
| --- | --- |
| Full local integration suite | 146 files; 2,607 passed, 22 explicit skips. Final focused service/custody checks also passed. |
| Real Linux cgroup v2 | 42 focused tests in a private disposable container; delegated-cgroup CI also passed. Immediate C double fork retained stdio, then produced no writes after settlement. |
| Claude Opus Stop/Resume | Passed; stopped in 1,244 ms; draft and unsent chat retained, fresh verified proof, replay rejected, no duplicate dispatch or manual repair. |
| Codex gpt-5.6-sol Stop/Resume | Passed; stopped in 641 ms; same preservation, fresh-proof and no-duplicate checks; no manual repair. |
| Six crash stages plus stop-before-crash | Seven passed using actual workers, SQLite, Git and unmodified lease expiry; provider responses in this matrix are fixtures. |
| Bundled desktop under disposable launchd label | Passed; clean controller exit recovered in 1,746 ms; SIGKILL in 182,288 ms through normal runner/lease fences; one writer, retained task, no provider invocation, no manual rescue; explicit stop passed. |
| Schema 52→53 migration preview | All historical values across 95 tables preserved; integrity OK, zero foreign-key violations. Live database not migrated. |
| Native Windows | Passed all five tests on Windows in [CI 34708869428](https://github.com/ap9000/standing-orders/actions/runs/34708869428/job/103593825850), including detached-child cleanup, exact sibling stop, prompt input and recovery after worker death. Earlier failures exposed real bugs and were corrected. |

Phone paused and desktop completed states were visually inspected after the
real-provider browser journeys. The certificate also captures running/stopping
states at both sizes and checks for horizontal overflow.

## Independent findings integrated

- Linux target admission waits for durable custody and the cleanup guardian's
  readiness. Atomic `cgroup.kill` is required; a saved PID is never kill authority.
- Emptiness is bound to the original kernel cgroup mount, namespace and object
  identity. Ordinary files, missing mounts and malformed state remain unknown.
- Cleanup begins at root exit, avoiding a deadlock when a detached descendant
  retains stdout. Unknown cleanup refuses success across buffered, streaming
  and held transports, including failures writing the durable empty receipt.
- Windows helper parsing is compatible with PowerShell 5. It creates a named
  kill-on-close Job Object, starts suspended, assigns, then resumes. A duplex
  overlapped control pipe avoids blocked empty replies; a dedicated process
  exit avoids pending .NET IO delaying host shutdown. Recovery opens the named
  object with query permission only. Tests cover lifecycle, exact sibling
  ownership, worker death and the actual stdin-capable transport.
- Host and boot identity protect process and worktree custody. Held orphan
  recovery uses the same proof; foreign, legacy and unverifiable cases retain
  conservative fences.
- The desktop bundles the official signed Node runtime, retains the provider
  search path and a stable runner identity, and shares service lifecycle with
  the CLI. Status and install inspect the loaded launchd generation, so a
  rewritten plist cannot stand in for a successful reload.
- Restart certificate v2 binds the database file, runtime and service. It can
  require a named existing worker and explicit task completion; unrelated
  heartbeats and mere movement out of running cannot satisfy those checks.

## Self-hosted handoff provenance

Standing Orders dispatched task `os-process-containment-and-login-recovery`
(task ref 57, run 1523), scope digest `279c0ff3e8827b4d2ff80ad5efafe9ad`, high
risk, from `f64d678`. Claude produced `9079c941fad085b59fa57f5cebc93587d7a725a1`.
It remains the parent of integration merge `9f4a2aa`; the builder worktree was
not rewritten. The original dispatch remains **proof-refuted**: its original
full-suite claim did not pass, and final native Windows validation required
operator fixes. This assessment certifies the integrated runtime separately;
it does not change the original proof or signed scope.

The builder's `test/ensure-build.ts` helper rebuild check was outside its filed
`touches`. The operator reviewed and integrated that necessary test-support
change under the user's broader implementation authorization. The discrepancy
is retained here rather than silently amending the original contract. The
builder did not install/migrate the live controller, merge/push, or reboot.

## Remaining installation gates

1. **Protected project access.** A preview app in Applications started and
   recovered against a temporary project, but a Documents fixture was skipped
   as unavailable. Read-only fresh launchd probes with both existing NVM Node
   and bundled Node blocked at directory read. The cause is not established as
   a bundled-runtime defect. Unlock/resolve the OS folder-access prompt, then
   rerun the Documents canary and require a fresh real-project heartbeat. Do
   not stop the working controller before this gate is verified.
2. **Automatic OS job startup.** Disposable launchd probes requested KeepAlive
   and observed beyond 90 seconds; macOS deferred nondemand relaunch. The
   controller guard passed under an already activated service. It does not
   survive its own SIGKILL or prove OS startup after logout/reboot.
3. **Live deployment.** Once access passes: drain active work, stop the exact
   service, make a fresh private database/app/state backup, migrate 52→53 and
   compare all historical values, install the certified bundle, start through
   the shared service lifecycle, verify saved login and fresh heartbeats for
   every configured project, then write a new deployment receipt. The preview
   migration is not a substitute for this fresh backup.
4. **Physical login/reboot.** Record a v2 baseline from the installed schema 53
   runtime and actual database with the service label, existing runner and an
   explicit completion task. Only after the operator performs the requested
   login/reboot should verification run. No physical reboot or logout occurred
   in this wave; injected boot tests are not that evidence.

macOS remains observational and required native containment refuses there.
A VM/Linux runner integration is still needed for native containment of local
Mac work. Windows legacy custody has no trusted boot UUID in this build;
named Job Object custody has read-only kernel recovery. This is a process
lifetime boundary, not isolation from privileged code or external brokers.
