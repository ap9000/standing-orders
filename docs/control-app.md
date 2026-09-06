# macOS control app

The native app runs the shared web console in a macOS window. A separate
LaunchAgent owns the console and its workers, so closing or quitting the window
does not stop work. The CLI and browser continue to use the same approval,
lease, evidence, and publication operations.

## Build and open

On macOS 13 or newer, with Node 22.13 or newer and the Xcode command line tools:

```sh
npm ci
npm run desktop
open "$HOME/Applications/Standing Orders.app"
```

The build installs an ad-hoc signed app in `~/Applications`. It includes the
compiled console and uses the locally installed Node runtime. Git and the
chosen provider CLI must be installed separately. GitHub publication also needs
an authenticated `gh` CLI. This is a local prototype, not a notarized installer
or a self-contained runtime distribution.

1. Sign in or create your local operator account. The app stores the sign-in in
   macOS Keychain. An existing valid `up-login.txt` is imported and removed only
   after successful Keychain readback.
2. Use **Add projects** to select several Git project folders at once. Hold
   Command in the native folder picker, or select checkboxes in the browser.
   Browser selections are reviewed together before confirmation.
3. Open **Set up project** on a project card. Choose an assistant and model from the available
   choices. Project preparation is detected from dependency files; choose the
   detected option or **No preparation needed**. Custom commands and time limits
   are under **Advanced settings**. Review the choices and save setup in the app.
   These defaults apply to future tasks; existing approvals retain their terms.
4. Start the worker for that project. **Add project instructions** is optional
   and previews its file before saving. Starting the app does not start workers.
5. Create and approve a task, then follow it on its task page. **Stop build**
   interrupts that run and leaves the task paused. **Resume work** is a separate
   action after the agent exits.
6. Review the build diff. **Open pull request** reviews the accepted commit and
   the publication grant before asking for approval. A new grant covers future
   accepted builds under the displayed repository and branch prefix, creates
   draft PRs, and never authorizes merging.

Use **File → Stop background service** to stop the app's workers and console.
**File → Start background service** reconnects the window. After a service or
worker failure, check its status and start the affected worker explicitly.

## The same experience in a browser

Open the desktop service's address (by default `http://127.0.0.1:4187`) in a
browser to use the same setup screens, project settings, tasks, and workers.
The native app adds folder selection, Keychain sign-in, and service lifecycle;
it does not maintain a separate frontend or task database. Browser sessions
sign in separately.

A standalone scoped `serve` instance also offers worker start and pause buttons
for its authorized projects. Workers stop gracefully with that server. A worker
owned by a different service remains identified by its actual computer and is
managed from that service's console. No local button claims to control another
computer's process.

## Multiple projects

The app and browser open on **Overview**, which shows every available project,
including projects without tasks. Cards show the tasks that need input, active
work, the reason waiting tasks are paused, and each local worker's status.
Project cards refresh automatically. **Open project** selects its board;
**New task** includes an explicit project selector. Switching the view never
stops another project's worker.

An empty project leads with **Set up session**, then **Start session**. Setup
puts assistant selection and connection first; preparation commands and approval
preferences expand on demand. Once running, the project offers **New task**.
Empty counters and folder paths stay out of the main flow; paths and session
controls remain in **Project details**.

Task entry uses one description. Its first line supplies the task name, while
the full text becomes the saved proposal. Optional names, boundaries, research
mode, and dependencies are under **Options**. **Review task** saves a draft;
the next screen shows its description, assistant, permissions, and time limit
before approval. Technical limits remain available in **Run details**. Editing
opens the description directly and requires review of the changed terms.
Validation errors retain the draft, including when another tab switches projects.
Tasks saved before assistant setup link into setup and return to that same task.

Start or pause each project's worker directly from its card. Several workers
can run concurrently, each consuming only approved tasks for its own project.
Adding projects updates the running service without restarting workers or
invalidating browser sessions. In the browser, **Projects → Choose project
folders** keeps selections while browsing between locations. The local desktop
connection browses the user's home folder; other connections retain the folders
made available by their administrator. GitHub cloning retains its existing
single-repository preview flow.

## Recovery and settings

### Connect Telegram

In **Settings → Telegram**, open **BotFather** to create a bot and copy its
token. Paste the token, confirm your account password once, and choose
**Connect Telegram**. Then choose **Open Telegram** and tap **Start** in the
private bot chat. The setup page checks automatically and shows when the chat
is connected. No terminal command, pairing code to copy, or separate bridge
process is required. This is the same flow in the app and browser.

Connection links expire after ten minutes, work once, and are bound to the
chosen bot and the account's credential generation. Settings can create a new
link or disconnect a paired chat. The service remembers the enabled connection
and resumes it after restarting; closing the app window does not stop it.
Telegram uses the existing primary messenger preference for outgoing alerts.
If Telegram is unavailable, Settings shows the problem while the service
retries. Bot tokens stay in the existing private credential file, and the
browser never receives them back. The CLI pairing flow still works.

Once paired, send ordinary text questions or reply to an alert. The console
answers through the connected Claude Code account and the same conversation
shown in **Chat** in the app and browser. Recent delivered alerts provide
context; a direct reply identifies the particular alert. Answers distinguish
local commits, publication blocks, pushed branches, and pull requests using
recorded state. The assistant cannot inspect a credential or unpublished code
from an alert alone.

Questions never approve work or answer decision buttons. Proposed tasks appear
for review in Chat. To attach a note to a decision button explicitly, reply to
that decision with `/note your guidance`, then tap the choice. Workers and standalone bridge processes detect an enabled console connection
and queue conversational messages for that same console, whichever process
owns Telegram polling. They recheck after each long poll, so enabling chat
while a worker runs cannot discard a question. Without an enabled console,
the CLI bridge retains its existing decision-note behavior. If the account requires a password for approvals,
start the conversation in Chat once before continuing it in Telegram. Never
send passwords to the bot. Missing connections receive an actionable reply.
Queued questions and delivery progress survive service restarts; retrying an
unsent answer does not run the assistant again. As with Chat, transcripts and
pending question text are retained for at most 24 hours.

**Require a password for approvals** is available during project setup and in
**Settings → Approval preferences**. It starts on. Turning it off requires one
password confirmation, then work approvals use the signed-in browser session.
The choice is saved per account and applies across all projects in the app and
web console connected to that database. Review and confirmation still happen
for task approval, execution settings, setup, adding projects, routines,
comparison decisions, and publishing. Turning it back on takes effect in every
session immediately. Sign-in, account and access administration, and separate
chat spending or attended authorizations keep their existing password rules.
CLI and bearer credentials are unchanged.

Stops and incomplete completion records preserve tracked and untracked work in
the leased worktree. They pause the task without counting a no-progress strike.
Resuming reuses those files; a diff alone never counts as a successful build.
The evidence view retains bounded, redacted recovery snapshots; the worktree
retains the files themselves.

Under **Scope & settings → Execution settings**, change the model, time bound,
Claude turn bound, or supported permission settings and review the exact new
terms before approving them. Claude can receive named unattended tool rules
such as `Bash(npm test:*)` without enabling automatic scope approval. Tasks with
fallback chains, comparisons, or attended authorizations use their full terms
editor instead.

Task pages distinguish paused work, local builds, pushed branches, open PRs,
and merged results. Status polling updates the page while protecting unsaved
form input. Local Claude runs expose the existing live transcript; remote
transcripts and other harnesses remain outside this milestone.

## Local files and scope

- App settings and console log: `~/Library/Application Support/Standing Orders/`.
- Background service: `~/Library/LaunchAgents/com.standing-orders.desktop.plist`.
- Database: the existing Standing Orders database selected by the normal CLI
  defaults; its absolute path is recorded in `desktop.json`.
- Worker token files and logs: `desktop-workers/` beside that database. Tokens
  have mode `0600` and are passed by file path, never as command arguments.

The service binds only to `127.0.0.1`; the shell verifies its installation
identity before sending saved credentials. The native app does not add a remote
relay, provider account management, or cross-device worker controls. The existing
web console's separate remote deployment options continue to apply.

## Verification

The regression suite includes an HTTP journey using a real disposable Git
repository and fake provider/GitHub calls: approve, build, stop, reject premature
resume, preserve edits, resume, inspect the diff, and approve the exact PR commit.
Additional tests cover run ownership, stale leases, stop-versus-completion races,
missing handoffs, named tool arguments, and isolated worker shutdown. Native
checks cover sign-in, Keychain migration, navigation, and background service
persistence after closing the window.

### Shared interface

The desktop window and web app render the same interface. Overview presents
all projects with their current status, tasks, next steps, and worker controls.
The main sidebar keeps daily navigation visible; **More** holds administration
and diagnostic screens and opens automatically on those pages.

The project dropdown combines switching projects, **Add projects**, and
**Manage projects** in the desktop window and web app. Its actions stay visible
while a long project list scrolls. The native **File → Add projects…** shortcut
also remains available.

Settings groups **Approvals**, **Telegram**, **Notifications**, and **AI providers**.
Section links work without JavaScript, including direct links to
`/settings#telegram`. Connected Telegram chats show their account and status;
a single selected notification service needs no extra selection or save action.
With multiple services, radio rows and **Save notification service** preserve the
existing preference. A saved bot token alone is shown as incomplete setup.
Provider sign-in details are expandable; credentials remain write-only.

Setup and AI provider settings check the selected sign-in automatically. Claude
Code's non-spending `auth status --json` check supplies a Connected badge,
account email, and plan when available; Codex uses its login status check.
**Manage connection** replaces **Connect account** after confirmation.
**Check again** refreshes the result after signing in or out elsewhere. Checks
are cached for 30 seconds and shared while in flight. A missing CLI, a failed
check, and a signed-out account have distinct states; a saved API key is never
treated as proof of a subscription sign-in. Status refers to the computer
running the console, and never starts an agent task.

**New task** and **Routines** share one composer: describe the outcome, choose
**Once**, **Daily**, **Weekly**, or **Custom interval**, then review. A name is
generated automatically. **Options** holds a custom name, exclusions, file
restrictions, and recurring spending limits. Template suggestions preserve their
exact descriptions and boundaries in editable fields.

Daily and weekly tasks use a time picker and a visible IANA timezone, initially
detected from the browser or native web view. With JavaScript unavailable, UTC
is shown explicitly. Existing templates retain their original UTC or interval
schedule. Calendar schedules follow local clock changes: a nonexistent time
skips that occurrence; a repeated time runs once at the first occurrence.
Legacy `daily:HH:MM` schedules remain UTC; the stored calendar forms also accept
`daily:HH:MM@Area/City` and `weekly:0:HH:MM@Area/City` (Sunday = 0).

Recurring drafts stay unapproved until **Enable recurring task**. The review
shows the exact description, schedule, timezone, assistant, and limits. Editing
an unapproved draft preserves its identity and any requirements or per-run
limits it already carried; changing terms invalidates an older approval screen.
Failed submissions retain the entered text and schedule choices.

Controls, typography, focus states, and light/dark colors are shared across
setup, projects, task details, boards, builds, and settings. Narrow layouts keep
task content ahead of its property panel, with navigation at the bottom.

Navigation and key panels use lightly tinted glass with fine edge highlights
and soft shadows. Inputs and dense task rows retain solid surfaces for reading.
Light and dark appearances share this treatment, with opaque fallbacks when
blur is unavailable or the system requests reduced transparency or more contrast.


## Unified project chat

Chat is available in both the desktop sidebar and the mobile web navigation.
It uses the Claude Code account already connected on the server's computer.
With approval passwords off, open Chat and send a message; no extra session
setup is needed. All projects is the default. Project chips change focus
without clearing the conversation.

The assistant can summarize recorded project status and propose tasks. Review
task files a draft and opens compact inline review in Chat: the exact scope,
execution settings, and the same approval door as the task page, including
your approval-password preference. Approving binds that digest; asking another
question does not. Publication stays on the task page. Queued, running, needs
input, and built-locally states update in the conversation with links to the
build, question, or result. Draft messages survive approval and project
changes in the same tab. Plans, revisions, and comparison terms use the full
task page so all terms are visible. Builders change project code only after
task approval. API chat remains available under its settings fold.

The local conversation window lasts 12 hours and the thread has the existing
24-hour retention limit. Ending the conversation deletes its history. Usage
figures reported by Claude Code are estimates, not subscription charges;
unreported usage is marked. These details live in Conversation settings.
