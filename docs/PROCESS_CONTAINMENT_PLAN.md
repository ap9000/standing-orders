# OS process containment and login recovery

## Contract

The existing stop contract is observational: a double fork can reparent before
the 500 ms process scan. This wave adds an OS boundary where the OS supports it,
and makes the actual capability explicit. It must retain the existing signed
scope, exact-run ownership, stop/resume, held-session, retry and proof fences.
No global PID sweeps, PID-only recovery signals, second queue, or provider
fallback may be introduced.

The implementation is run through Standing Orders itself. The supervising
operator owns independent adversarial certification, integration and deployment;
the task builder must not install services, migrate the live database, push,
merge, reboot, log out, or modify another project.

## Native containment

Use a small, testable adapter at the shared spawn boundary, including buffered,
streaming and held provider execution and setup/verification subprocesses.
Containment must be established before the target can execute or fork. A native
helper or OS service may implement this; command strings must retain argv and
stdin/environment semantics. Missing helpers, missing permissions, unavailable
supervisors and failed attachment must never fall through to an uncontained
target when containment is required. Cancellation must reach only the current
invocation's OS object and wait for its empty state. Natural root exit and worker
death must clean up descendants too, including immediate double-fork/setsid
helpers. Do not depend on a scanner having first observed them.

Linux: prefer delegated cgroup v2 or systemd user transient services with
control-group cleanup and an explicit empty-state proof. Do not assume the user
has root, writable global cgroup paths or a systemd user bus. Windows: a Job
Object with kill-on-close, no breakaway, and suspended/atomic target assignment;
keep the controlling job handle outside the job. Test the native backend on CI.

macOS does not have a supported cgroup/Job Object equivalent. The local SDK
explicitly says NOTE_TRACK/NOTE_CHILD have been unsupported since 10.5, and
launchd AbandonProcessGroup=false only kills processes still in that group.
Retain the existing observational mode and report it accurately. Required native
containment must refuse on macOS and explain the VM/Linux-runner route. Do not
invent an unprivileged kernel guarantee, use private kernel APIs, or silently
mount a user's home or credentials into Docker. A VM-backed provider runtime is
a separate integration gate if needed. Existing macOS work remains operational.

Expose a coherent runner policy/capability (observed versus native/required),
with honest effective status and an actionable refusal. Preserve compatibility
for existing installations. Do not let child-supplied configuration or a corrupt
value turn required containment off. Record enough exact-run custody to keep
recovery and stop settlement fail-closed when the OS object cannot be proven
empty. Never treat a transport exit alone as an empty-container proof.

## Login/reboot recovery

Unify the desktop and CLI service definition/lifecycle where practical. An
installed always-on controller restarts after unexpected clean exit as well as
crash; explicit stop unloads/disables it. Reinstall must really load changed
runtime/configuration and must not kill a healthy service just because the app
window reopened. Avoid the pending-bootout/bootstrap race. Preserve private
login, identity, projects and database; never migrate automatically under a live
controller. Startup validation must distinguish a loaded definition from a fresh
working controller and give useful missing-runtime/disabled-service diagnostics.
Keep credentials out of argv, logs and unit contents.

Record a trustworthy OS boot identity for new process custody. After a verified
boot change on the same host, old processes cannot survive: pending stop/recovery
must not be blocked forever by an incomplete old spawn or reused PID. A missing
boot ID, legacy witness, foreign host or unverifiable state must retain the
conservative path. Boot recovery must preserve draft/commit, explicit paused
intent, unrelated holds, approval, review retry bounds and no-duplicate dispatch.
Do not use wall-clock comparisons as proof of a boot change.

macOS LaunchAgents resume at user login after reboot, not before FileVault
unlock/login. Linux user service behavior depends on login/linger. Windows
Task Scheduler logon trigger is not a boot service. Document these precise
boundaries and do not claim a physical reboot test that has not happened.

## Acceptance and independent certification

1. Required containment fails before target execution on unavailable/failed
   backends; all spawn transports preserve argv, input, env, cancellation and
   custody, including transient retries and held supervisors.
2. Native real-process tests cover immediate double fork/setsid, natural root
   exit, exact-run stop, worker death, parallel sibling survival and no writes
   after settlement. Windows native tests run on Windows; Linux native tests
   either execute with the needed facility or explicitly report unavailable.
3. Boot identity tests cover same boot, real changed boot identity, missing and
   malformed identity, foreign host, legacy/incomplete witnesses and PID reuse.
   Stop/resume/review/recovery authority and drafts remain intact.
4. Service generation and lifecycle tests cover clean/crash restart policy,
   disabled service, stale installed definition, missing Node/entry, fresh
   heartbeat verification, explicit stop, idempotent start and bounded reload.
5. A disposable macOS launchd certificate exercises actual automatic relaunch
   after both exit 0 and SIGKILL, plus bootout/bootstrap with fresh controller
   identity and no duplicate writers. No manual kickstart may rescue the
   automatic-relaunch assertion. Observe beyond throttle (at least 60 seconds).
6. Typecheck, build, focused/full regression and Linux/macOS/Windows CI pass.
   Capture runtime identity and honest skipped/physical-machine gates.
7. A restart certification command/checklist records a baseline and can verify
   post-login/reboot boot identity, service liveness, recovery and task completion
   against the same database without printing secrets or rebooting itself.

## Sources checked

- Local macOS 26 SDK `sys/event.h`: NOTE_TRACK unsupported since 10.5.
- Local `man launchd.plist`: KeepAlive, AbandonProcessGroup, ThrottleInterval.
- [Apple launchd source manual](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).
- [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html).
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

These describe the mechanisms; passing tests must establish this implementation.
