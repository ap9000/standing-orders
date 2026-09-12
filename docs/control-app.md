# Desktop control app and guided setup

The macOS shell opens the existing Standing Orders console and supervises the
existing `up` command with launchd. There is one queue, one project registry,
one worker/recovery implementation, and the same approval controls in the
browser and desktop app. Closing the window leaves the service running.

## Build and run

The local build requires macOS 13 or later, the Swift compiler, and the Node
runtime required by this checkout. From the repository:

```sh
npm ci
npm run build:desktop
open "$HOME/Applications/Standing Orders.app"
```

The bundle contains the compiled controller and refers to the installed Node
binary; it is not a standalone Node distribution. Local builds are ad-hoc
signed and verified, not notarized releases. The build script stages the new
bundle before replacing an existing recognized Standing Orders bundle, refuses
symlink destinations, and preserves the old bundle if replacement fails.
Stop the background service before replacing a running installation.

The first launch imports a valid existing local login, or asks for an operator
account, then lets the operator choose Git projects. Sign-in is saved in
Keychain. The background controller uses its existing owner-only `up-login.txt`
restart credential. Pairing never replaces another valid remembered login.
Approval screens still require the operator's password and an exact preview.

File → Start background service starts or reconnects the launchd service.
File → Stop background service uses the controller's normal shutdown path.
The service stops new admission, allows its normal grace period, and uses
existing owned-process cleanup and recovery. This is a service control, not a
per-task instant stop/resume feature. File → Open service logs opens the state
directory.

State defaults to `~/Library/Application Support/Standing Orders`. The selected
control database follows the CLI's existing database selection. Opening an
existing database requires this build's exact schema version: the shell never
silently migrates an older running installation. Perform the documented
controller upgrade separately.

## Isolated preview

Use a separate output bundle and an explicit state directory:

```sh
npm run build:desktop -- output/Standing-Orders-Preview.app
open -n output/Standing-Orders-Preview.app --args --state /tmp/standing-orders-preview
```

A new custom state directory gets its own database, configuration, Keychain
account, and launchd label derived from the directory. Select its projects
explicitly; the service directory and source checkout are not implicitly
enrolled. Different previews still need different free ports, configured in
`desktop.json` before starting; the default is 4187. After testing, stop the
preview service and quit the app.

The native shell verifies a fresh HMAC challenge before submitting its login
on loopback. Its helper commands execute off the UI thread with bounded time
and output. No credential is passed in process arguments or service logs.

## Project setup

Open **Project setup** in the desktop toolbar, **Set up this project** in
Settings, or **set up** on a portfolio project card.

- Choose the default builder for new tasks. Codex suggestions come from its
  local visible model catalog; custom exact model ids remain possible. Claude
  uses its documented aliases rather than fixed version guesses.
- Check the provider's non-spending sign-in status. A saved API key is reported
  as present, not verified. Unknown CLI responses never become “Connected.”
  Sign-in status does not guarantee model access, quota, or runner readiness.
- Browse OpenRouter text models with search, context sizes, tool support, and
  reported input/output/cache prices. A saved key uses the account-filtered
  endpoint; keyless browsing uses the public catalog. Loading a catalog makes
  no generation request. Price and availability gaps remain explicit.
- Review a preparation command suggested by repository lockfiles. Saving does
  not run it. The approved preparation applies to subsequent runs, including
  already approved tasks; the builder default applies to new tasks. Clearing
  preparation is respected on later visits. Task scopes and signed routes are
  not rewritten.
- Preview and install the existing managed Standing Orders agent instructions.
  Linked paths and foreign instructions are refused; stale previews must be
  reviewed again. Installation writes only the managed skill file.

Setup approval uses the existing authenticated session, CSRF check, project
boundary, one-use approval nonce, password verification, and a fingerprint
binding the shown inputs to the current saved configuration. Changing the
project or configuration after preview requires a new review.

Planning, review, repair, routing tiers, fallback, verification, and chat
continue through the existing Fleet, Settings, task, and chat screens. Guided
setup does not invent alternative policies for them.

## Calendar schedules

The routines form supports daily, weekly, and custom interval schedules. Forms
work without JavaScript; scripts only hide irrelevant fields and suggest the
browser's local timezone for a fresh schedule. Validation failures retain the
operator's entries. Template schedules retain their original timezone.

The same parser is used by the CLI and approval digest:

```text
every:120
daily:03:30
daily:09:00@America/Los_Angeles
weekly:2:18:45@Asia/Kathmandu
```

Weekdays are 0 for Sunday through 6 for Saturday. Without an explicit timezone,
calendar schedules remain UTC. The timezone and weekday are signed terms.
A nonexistent local time during a clock change skips that occurrence; a repeated
time runs once at its first occurrence. Missed work follows the existing
single-flight and no-backfill rules.

Provider references checked during integration: [Claude model aliases](https://code.claude.com/docs/en/model-config),
[OpenRouter public model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties),
and [OpenRouter account-filtered catalog](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails).
