# OS process containment and login recovery — what was built

The contract is [PROCESS_CONTAINMENT_PLAN.md](PROCESS_CONTAINMENT_PLAN.md).
This page records the implementation, the exact capability on each OS, how
an operator turns it on, and the boundaries nobody should read past.

## The policy, and what each machine really gets

`--containment observed|preferred|required` (or `STANDING_ORDERS_CONTAINMENT`)
is read ONCE per controller process — `up`, `watch`, `daemon install` bakes
it into the unit — and pinned. A corrupt value refuses to start; a pinned
`required` cannot be weakened by a later flag; nothing a child process
supplies is consulted. Absent, the policy is `observed`: exactly the
behaviour every existing installation had.

| policy      | Linux, delegated cgroup v2         | Windows, PowerShell + helper      | macOS / no facility                                  |
|-------------|------------------------------------|-----------------------------------|------------------------------------------------------|
| `observed`  | observed (500 ms tree scan)        | observed                          | observed                                             |
| `preferred` | native cgroup2                     | native Job Object                 | observed, **reported as a downgrade**                |
| `required`  | native cgroup2                     | native Job Object                 | **every provider/setup/check spawn refuses** before any target executes |

`standing-orders daemon status`, the `watch`/`up` opening line, the desktop
`service-status` verb and the restart certificate all print the same
effective status (`containment: native cgroup2 (required) — …`,
`containment: observed (preferred native, cgroup2 unavailable) — …`,
`containment: REQUIRED but unavailable — refusing spawns: …`).

The capability is established by doing, never by an environment variable:
on Linux a child cgroup is created and removed inside this process's own
cgroup (a v1 mount, an undelegated cgroup, an unreadable `/proc` each answer
unavailable with the reason and the route — `Delegate=yes`, or a leaf
chowned to the uid with the controller started inside it); on Windows the
helper and `powershell.exe` must exist. macOS answers unavailable with the
kernel facts: NOTE_TRACK/NOTE_CHILD unsupported since 10.5, launchd
`AbandonProcessGroup` covers a group only — run a Linux VM or Linux runner
with a delegated cgroup v2 for native containment. No private kernel API,
no unprivileged "guarantee", nothing mounted into a container.

## Where the OS object sits

One spawn road (`exec.ts spawnContained`) serves the buffered provider
transport, the three streaming transports, the builder's setup and
verification legs (they are `processGroup` spawns) and the held-session
supervisor. Per spawn:

- **Linux** — a leaf `so-<owner>-<random>` under the delegated root. The
  target is launched as `/bin/sh -c '<prelude>' so-contain <leaf> <file> <args…>`:
  the prelude writes its own pid into `cgroup.procs`, confirms on fd 3,
  closes it, and `exec`s the target with argv as positional parameters —
  never re-parsed, same pid, same stdin/stdout/stderr, same environment and
  cwd. A join that fails exits 126 before the target can run; the
  transport reports `containment: { refused }` and the target never
  existed. A detached janitor (`sh`, its stdin a pipe from the controller)
  kills and removes the leaf when the controller dies.
- **Windows** — `job-object-helper.ps1` runs OUTSIDE the job it owns:
  `CreateProcess(CREATE_SUSPENDED)` → `AssignProcessToJobObject` →
  `ResumeThread`, with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway
  flag. argv rides as one base64 JSON token and is re-quoted with libuv's
  rules; the target inherits the helper's std handles, environment and
  cwd. Control runs over a named pipe: `attached` / `failed <detail>` /
  `empty` from the helper, `kill` from the controller; the controller's
  death closes the pipe, and the helper terminates the job.
- **macOS** — no object. The observational tree scan and the SIGSTOP-then-
  kill stop stay exactly as before.

Cancellation (an operator stop, a timeout, the watch's hard stop) reaches
the current invocation's object only — `cgroup.kill` (or pid-by-pid on
kernels before 5.14), `TerminateJobObject` — and the transport's
settlement WAITS for the OS's empty state (`cgroup.events populated 0`, the
helper's `empty`), bounded. The root's natural exit runs the same
settlement: members that outlived it (a setsid'd helper, a double fork) are
killed, then emptiness is proven. A transport exit is never the proof.

## Custody (schema v53)

`run_process` gains `boot_id`, `containment`, `container`,
`container_empty_at` — additive, nullable, NULL on every historical row.
The witness names the object at the spawn (before the target executes) and
is marked empty only on the OS's word. `stopQuiescenceProblem` — the one
fence behind stop settlement, resume, review-retry admission and recovery —
reads a native witness with no empty proof as still occupied unless the
object can be proven empty now (populated flag 0, or a cgroup directory
that is gone: only an empty one can be removed); a job whose helper is gone
without its `empty` word stays unproven. Fail-closed, as the plan asks.

## Boot identity

`boot-identity.ts` reads the kernel's per-boot token (`/proc/sys/kernel/random/boot_id`,
`sysctl kern.bootsessionuuid`; Windows: none this build trusts → unknown),
validates it as a UUID, and stamps it on every new witness and on the
worktree occupancy note. The one rule: a witness is proven dead by boot
change only when it names THIS host, carries a well-formed id, this host's
current id is well-formed and known, and the two differ. Then an incomplete
old spawn, a reused pid and an unproven native object all settle. Same
boot, a legacy witness, a foreign host, a malformed or unknown id — each
keeps the PID probe or the refusal it had. No wall-clock comparison
anywhere. Drafts, holds, approvals, review-retry bounds and no-duplicate
dispatch are untouched: the rule only decides whether a process can still
exist.

## Services

`daemon.ts` is now the one lifecycle for the CLI daemon and the desktop
controller (the Swift shell calls `desktop-host.js service-start|service-stop|service-status`
instead of writing its own plist):

- launchd `KeepAlive=true` (relaunch after crash AND unexpected clean
  exit, throttled 15 s), systemd `Restart=always`, a `cmd` restart loop
  under Task Scheduler (whose `RestartOnFailure` alone covers crashes);
- idempotent start: a loaded, unchanged definition is `kickstart`ed
  without `-k` — a healthy running controller is never killed because the
  installer or the app window ran again;
- a changed definition (runtime, entry, flags) is booted out, its label's
  disappearance awaited (`launchctl print` until it fails — the pending-
  bootout/bootstrap race), then bootstrapped; systemd restarts an active
  unit only when the unit changed; `schtasks /End` + `/Run` likewise;
- explicit stop = `bootout` + `disable` (Linux `disable --now`; Windows
  `/End` + `/Delete`); install re-enables;
- status: `running` / `loaded` / `disabled` / `not-installed`, with
  `problems` naming a missing runtime or entry and `stale` when the
  installed unit differs from what this build would write. `daemon
  install` and the certificate demand a FRESH runner heartbeat — a loaded
  service is not a working controller; the desktop `service-status` verb
  additionally answers the identity challenge on the configured port.

Private login, identity, projects and the database are untouched by any of
this; the desktop's `serve` still opens the database through the
non-migrating door.

## Certification

- `npm run test:native-containment` — the kernel-backed tests; they report
  the exact reason and skip where the facility is missing, and
  `SO_EXPECT_NATIVE_CONTAINMENT=1` turns a skip into a failure (CI:
  `linux-native-containment` delegates a leaf to the runner and runs them;
  `windows-baseline` runs the Job Object tests).
- `npm run certify:restart -- baseline --db <file> [--label <label>]` then,
  after YOU log out/in or reboot, `… verify --db <file> --baseline <file>
  --expect reboot|login`: boot identity as the OS reports it, runtime,
  service state with a fresh heartbeat, settlement of what the old boot left
  pending by the controller's own rules, task completion. Never a
  credential in its output; never a reboot, logout or service restart of
  its own. Its report lists the limits below.
- `npm run certify:launchd` — a DISPOSABLE LaunchAgent under a throwaway
  label: automatic relaunch after exit 0 and after SIGKILL with no manual
  kickstart, explicit stop staying down beyond the throttle, start with a
  fresh incarnation and one writer, observed ≥ 60 s; then removed. Run it
  only where an operator decided a disposable install is acceptable.

## Boundaries

- macOS LaunchAgents resume at user login after a reboot, not before
  FileVault unlock/login. Linux user services depend on a login session or
  `loginctl enable-linger`. The Windows Task Scheduler logon trigger is a
  logon trigger, not a boot service.
- A physical reboot that has not happened is not claimed anywhere: the
  restart certificate's `bootChanged` is the OS's word, and `unknown` stays
  unknown.
- Windows boot identity is unknown in this build (no unprivileged per-boot
  UUID is trusted), so post-reboot custody there keeps the conservative
  PID road.
- The Windows helper is exercised by CI on Windows; it has not been run on
  a physical Windows machine by this wave.
- A VM-backed provider runtime for macOS is a separate integration gate,
  as the plan states; nothing here mounts a home directory or credentials
  into a container.
