/**
 * The declared command guide (arc 5): the agent-facing surface as data,
 * dumped by `contract --commands`. This is DOCUMENTATION with a stable
 * shape, not authority — nothing executes from it, no verb consults it,
 * and the runtime envelope remains the truth. Its honest limits ride the
 * envelope itself as SURFACE_NOTES, because a source comment is invisible
 * to consumers (arc-5 review, finding 1).
 *
 * What the tests DO hold to the code: every root here is a routed verb
 * and every routed verb appears here; every declared flag lives in the
 * parser's global vocabulary with the declared arity; the subcommand
 * inventories for task/publish/config/approver/routine/contest match the
 * exported action lists their dispatchers consult; keyed mutations
 * declare --key; notableReasons come from DOCUMENTED_REASONS. What they
 * CANNOT prove — that a given flag is read by a given handler — is why
 * SURFACE_NOTES.flags says "intended".
 */

export type CommandFlag = {
  readonly name: string;
  readonly takesValue: boolean;
  readonly meaning: string;
};

export type CommandRow = {
  /** What you type after `standing-orders` (subcommands included). */
  readonly invocation: string;
  /** The `command` field the envelope answers with, where it differs
   * from the invocation (the no-verb report answers as "scan"). */
  readonly envelopeCommand?: string;
  readonly synopsis: string;
  /** Who this act belongs to. "operator" rows are ceremonies or
   * infrastructure: an agent must not invoke them even when credentials
   * are within reach — the credential IS the person. They carry no flag
   * detail on purpose: a schema is not permission. */
  readonly audience: "agent" | "operator";
  readonly agentMayInvoke: boolean;
  /** Truthful retry semantics, not a boolean:
   *  keyed — takes --key; same key returns the first answer.
   *  identity-idempotent — repeating it converges (same lease, same
   *    path, same managed file); no key needed.
   *  unkeyed — a mutation without replay protection: do not blind-retry.
   *  none — a read. */
  readonly mutation: "keyed" | "identity-idempotent" | "unkeyed" | "none";
  readonly positionals?: readonly { name: string; required: boolean; meaning: string }[];
  readonly flags?: readonly CommandFlag[];
  readonly notableReasons?: readonly string[];
};

/** The guide's limits, stated machine-readably in every dump. */
export const SURFACE_NOTES = {
  authority: "documentation — behavior and live --help are authoritative; nothing executes from this schema",
  flags: "intended per command; the parser's flag vocabulary is global, so presence here narrows by hand what the parser alone cannot",
  reasons: "curated, not exhaustive — the runtime `reason` field is the truth; ignore tokens you do not recognize",
} as const;

export const SURFACE_SCHEMA_VERSION = 1;

const jsonFlag: CommandFlag = { name: "json", takesValue: false, meaning: "answer with one machine envelope on stdout" };
const keyFlag: CommandFlag = { name: "key", takesValue: true, meaning: "idempotency key — retry with the same key to get the first answer back" };
const dbFlag: CommandFlag = { name: "db", takesValue: true, meaning: "path to the database file (defaults to the installation's)" };
const repoFlag: CommandFlag = { name: "repo", takesValue: true, meaning: "which repository (repeatable where a command watches several)" };

const operator = (invocation: string, synopsis: string): CommandRow => ({
  invocation,
  synopsis,
  audience: "operator",
  agentMayInvoke: false,
  mutation: "unkeyed",
});
const operatorRead = (invocation: string, synopsis: string): CommandRow => ({
  invocation,
  synopsis,
  audience: "operator",
  agentMayInvoke: false,
  mutation: "none",
});

export const COMMAND_GUIDE: readonly CommandRow[] = [
  // ---- reports (reads) ----
  {
    invocation: "",
    envelopeCommand: "scan",
    synopsis: "report what is in flight (the no-verb default; scans below the working directory or the connected repositories)",
    audience: "agent",
    agentMayInvoke: true,
    mutation: "none",
    positionals: [{ name: "path", required: false, meaning: "directories to scan instead of the connected set" }],
    flags: [jsonFlag,
      { name: "all", takesValue: false, meaning: "ignore connected repos; scan everything discoverable" },
      { name: "local", takesValue: false, meaning: "branches only — no network" }],
  },
  { invocation: "pulls", synopsis: "report what is waiting on a person", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag] },
  { invocation: "graph", synopsis: "report which work graph is already here", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag] },
  { invocation: "repos", synopsis: "list connected repositories", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag] },
  operator("repos add", "connect a repository to the installation"),
  operator("repos remove", "disconnect a repository"),
  operator("repos add-from-github", "preview, clone from GitHub, and connect - the console onboarding ceremony as a CLI verb"),
  { invocation: "contract", synopsis: "the machine contract: envelope version + capability tokens; --commands dumps this guide", audience: "agent", agentMayInvoke: true, mutation: "none",
    flags: [jsonFlag, { name: "commands", takesValue: false, meaning: "dump the declared command guide" }] },
  { invocation: "skills list", synopsis: "name the guides this exact binary serves", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag] },
  { invocation: "skills get", synopsis: "print one guide's markdown (raw on stdout; --json wraps it)", audience: "agent", agentMayInvoke: true, mutation: "none",
    positionals: [{ name: "name", required: true, meaning: "a guide name from `skills list`" }],
    flags: [jsonFlag], notableReasons: ["unknown-skill", "usage"] },
  operator("skills install", "write the Agent Skills entry (and optional AGENTS.md block) into a repository — previewed, --yes to apply"),
  operator("link", "put standing-orders on PATH"),
  operator("unlink", "take it off PATH"),
  operator("demo", "a seeded throwaway sandbox"),

  // ---- the queue (agent surface) ----
  { invocation: "ready", synopsis: "what could be dispatched right now (rows carry reservedFor)", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "brief", synopsis: "the standing brief: what happened, what waits", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "gaps", synopsis: "requirement gaps blocking dispatch", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag, repoFlag] },
  { invocation: "grants", synopsis: "list authority grants", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "sync", synopsis: "refresh external-tracker mirrors and deliver write-backs — safe to run; fails closed", audience: "agent", agentMayInvoke: true, mutation: "identity-idempotent",
    flags: [jsonFlag, dbFlag, repoFlag], notableReasons: ["no-op", "external"] },

  { invocation: "task add", synopsis: "queue work", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "title", required: true, meaning: "one line of what to do" }],
    flags: [jsonFlag, dbFlag, keyFlag,
      { name: "id", takesValue: true, meaning: "choose the task id" },
      { name: "repo", takesValue: true, meaning: "which repository the task belongs to" }],
    notableReasons: ["duplicate", "usage"] },
  { invocation: "task list", synopsis: "every task, or one state", audience: "agent", agentMayInvoke: true, mutation: "none",
    flags: [jsonFlag, dbFlag, { name: "state", takesValue: true, meaning: "queued|running|done|failed|cancelled" }] },
  { invocation: "task show", synopsis: "one task in full", audience: "agent", agentMayInvoke: true, mutation: "none",
    positionals: [{ name: "id", required: true, meaning: "the task" }], flags: [jsonFlag, dbFlag], notableReasons: ["unknown-task"] },
  operator("task state", "set a task's state by hand — an operator correction, not a workflow step"),
  { invocation: "task block", synopsis: "make one task wait for another", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the waiting task" }],
    flags: [jsonFlag, dbFlag, keyFlag, { name: "on", takesValue: true, meaning: "the blocker's id" }],
    notableReasons: ["unknown-task", "contest-open"] },
  { invocation: "task unblock", synopsis: "stop waiting", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the waiting task" }],
    flags: [jsonFlag, dbFlag, keyFlag, { name: "on", takesValue: true, meaning: "the blocker's id" }],
    notableReasons: ["unknown-task"] },
  { invocation: "task next", synopsis: "move a task to the front of ITS queue (scheduling only; approval still required)", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the task" }],
    flags: [jsonFlag, dbFlag, keyFlag, { name: "undo", takesValue: false, meaning: "back to filing order" }],
    notableReasons: ["unknown-task", "claimed", "contest-open"] },
    operator("task steer", "one credentialed note read before the task's next attempt — steering speaks with the operator's voice"),
  { invocation: "task assign", synopsis: "reserve a task for one worker, or return it to the shared queue", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the task" }],
    flags: [jsonFlag, dbFlag, keyFlag,
      { name: "runner", takesValue: true, meaning: "the worker to reserve for" },
      { name: "anyone", takesValue: false, meaning: "back to the shared queue" }],
    notableReasons: ["unknown-task", "claimed"] },
  { invocation: "task scope", synopsis: "state what success is; approval binds to this exact statement", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the task" }],
    flags: [jsonFlag, dbFlag, keyFlag,
      { name: "goal", takesValue: true, meaning: "what success is" },
      { name: "not", takesValue: true, meaning: "explicitly out of scope" },
      { name: "touches", takesValue: true, meaning: "comma-separated paths this may change" },
      { name: "budget-usd", takesValue: true, meaning: "spend ceiling for the build" }],
    notableReasons: ["unknown-task", "contest-open"] },
  { invocation: "task plan", synopsis: "ask for a plan document (a planning session drafts; a person approves)", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the task" }],
    flags: [jsonFlag, dbFlag, keyFlag,
      { name: "provider", takesValue: true, meaning: "pin which provider plans THIS task (plan phase only)" },
      { name: "model", takesValue: true, meaning: "the pinned plan model, riding --provider" }],
    notableReasons: ["unknown-task"] },
  { invocation: "task hold", synopsis: "park a task with a reason", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the task" }],
    flags: [jsonFlag, dbFlag, keyFlag,
      { name: "reason", takesValue: true, meaning: "why it waits" },
      { name: "until", takesValue: true, meaning: "ISO time to resurface" }],
    notableReasons: ["unknown-task", "held"] },
  { invocation: "task unhold", synopsis: "release a hold", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the task" }],
    flags: [jsonFlag, dbFlag, keyFlag], notableReasons: ["unknown-task", "not-yours"] },
  { invocation: "task require", synopsis: "name the capabilities a task needs before dispatch", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the task" }],
    flags: [jsonFlag, dbFlag, keyFlag, { name: "require", takesValue: true, meaning: "comma-separated capability keys" }],
    notableReasons: ["unknown-task"] },
  operator("task approve", "the yes — nothing builds without one; binds to the scope digest"),
  operator("task requeue", "exit a stall: incidents resolved, strikes cleared, queued again"),
  operator("task review", "ask an agent to review a finished run's sealed diff — its comments land for you to prune and seal"),
  operator("task reopen", "resume external work its tracker closed and has been SEEN open again"),

  // ---- leases (runner surface) ----
  { invocation: "claim", synopsis: "take one ready, approved task; answers with a lease", audience: "agent", agentMayInvoke: true, mutation: "keyed",
    positionals: [{ name: "id", required: true, meaning: "the task" }],
    flags: [jsonFlag, dbFlag, keyFlag,
      { name: "runner", takesValue: true, meaning: "your registered worker name" },
      { name: "token", takesValue: true, meaning: "the worker's token" },
      { name: "ttl", takesValue: true, meaning: "lease seconds" }],
    notableReasons: ["held", "fenced", "unapproved", "reserved", "external", "contest-open", "claimed", "not-ready"] },
  { invocation: "heartbeat", synopsis: "still working; extends the lease", audience: "agent", agentMayInvoke: true, mutation: "identity-idempotent",
    positionals: [{ name: "lease", required: true, meaning: "the lease id" }],
    flags: [jsonFlag, dbFlag], notableReasons: ["not-leased", "fenced"] },
  { invocation: "release", synopsis: "done with it; fenced if superseded", audience: "agent", agentMayInvoke: true, mutation: "identity-idempotent",
    positionals: [{ name: "lease", required: true, meaning: "the lease id" }],
    flags: [jsonFlag, dbFlag], notableReasons: ["not-leased", "fenced"] },
  { invocation: "reap", synopsis: "release every lease that ran out", audience: "agent", agentMayInvoke: true, mutation: "identity-idempotent", flags: [jsonFlag, dbFlag] },
  { invocation: "tick", synopsis: "one unattended pass: claim, build in a leased worktree, commit to a branch — never pushes", audience: "agent", agentMayInvoke: true, mutation: "unkeyed",
    flags: [jsonFlag, dbFlag, repoFlag,
      { name: "runner", takesValue: true, meaning: "your registered worker name" },
      { name: "token", takesValue: true, meaning: "the worker's token" },
      { name: "max", takesValue: true, meaning: "tasks this pass (default 1)" },
      { name: "base", takesValue: true, meaning: "base ref for first attempts" }],
    notableReasons: ["empty", "fenced"] },
  { invocation: "build", synopsis: "build one claimed task directly (the piece tick automates)", audience: "agent", agentMayInvoke: true, mutation: "unkeyed",
    positionals: [{ name: "id", required: true, meaning: "the task" }],
    flags: [jsonFlag, dbFlag, repoFlag], notableReasons: ["not-leased", "unapproved"] },
  { invocation: "reconcile", synopsis: "recover what the last stretch left behind — safe to repeat", audience: "agent", agentMayInvoke: true, mutation: "identity-idempotent", flags: [jsonFlag, dbFlag, repoFlag] },

  // ---- reads over shared machinery ----
  { invocation: "runner list", synopsis: "registered workers", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "approver list", synopsis: "who can say yes (names only)", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "cap list", synopsis: "recorded capabilities", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag, repoFlag] },
  { invocation: "outbox list", synopsis: "queued notifications", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "incident list", synopsis: "open incidents", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "routine list", synopsis: "standing orders (scheduled routines)", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "routine show", synopsis: "one routine in full", audience: "agent", agentMayInvoke: true, mutation: "none",
    positionals: [{ name: "id", required: true, meaning: "the routine" }], flags: [jsonFlag, dbFlag] },
  { invocation: "config show", synopsis: "phase and spend configuration", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag, repoFlag] },
  { invocation: "setup show", synopsis: "installation setup", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "intake show", synopsis: "intake configuration", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "providers", synopsis: "which agent providers this binary can drive, and their transports", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag] },
  { invocation: "template list", synopsis: "routine templates", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "template show", synopsis: "one template", audience: "agent", agentMayInvoke: true, mutation: "none",
    positionals: [{ name: "name", required: true, meaning: "the template" }], flags: [jsonFlag, dbFlag] },
  { invocation: "contest show", synopsis: "a tournament's state and results", audience: "agent", agentMayInvoke: true, mutation: "none",
    positionals: [{ name: "id", required: true, meaning: "the contest" }], flags: [jsonFlag, dbFlag] },
  { invocation: "webhook status", synopsis: "connected messaging services", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },
  { invocation: "publish status", synopsis: "publication and merge-grant state", audience: "agent", agentMayInvoke: true, mutation: "none", flags: [jsonFlag, dbFlag] },

  // ---- operator ceremonies and infrastructure (listed, detail-free) ----
  operator("approver add", "mint the credential that lets a person say yes"),
  operator("runner register", "register a worker; its token is shown once"),
  operator("runner retire", "retire a worker"),
  operator("cap add", "record a capability"),
  operator("outbox deliver", "deliver queued notifications"),
  operator("incident resolve", "resolve an incident"),
  operator("decide", "read and ANSWER parked decisions — answering is a person's act"),
  operator("routine add", "file a standing order"),
  operator("routine approve", "approve a standing order"),
  operator("routine pause", "pause a standing order"),
  operator("routine resume", "resume a standing order"),
  operator("routine run-now", "run a standing order immediately"),
  operatorRead("keys status", "which provider API keys are stored — never the values"),
  operator("keys set", "store a provider's API key as a private file — piped or --key-file, never on the command line"),
  operator("keys clear", "remove a stored provider key; an environment variable takes over if one exists"),
  operatorRead("keys verify", "check a stored key against its provider live — spends no tokens"),
  operator("keys auth", "choose subscription vs API key for a provider (subscription is the default; the key is kept as fallback)"),
  operatorRead("people list", "everyone who can sign in, their standing, and the open invites"),
  operator("people invite", "mint a single-use sign-in link for one person — their powers are pinned when you mint, never after"),
  operator("people revoke", "end a person's access — their sessions, invites, and signed modes end with them; history stays"),
  operatorRead("mode show", "the repository's operating mode, in full — or 'locked' when none is signed"),
  operator("mode set", "sign a per-repository operating mode (password ceremony; standard or hands-off, always expiring)"),
  operator("publish merge", "say yes to ONE waiting merge — it fires only when CI is seen green on the exact commit you authorized"),
  operator("publish refire", "recover a merge whose issued call went silent — re-enters the full merge road, never auto-retried"),
  operator("mode revoke", "revoke a repository's mode — one click, every act it covered falls back to its own ceremony"),
  operator("config set", "set phase or spend configuration"),
  operator("config clear", "clear phase or spend configuration"),
  operator("setup clear", "clear installation setup"),
  operator("intake grant", "grant an intake source"),
  operator("intake run", "run intake now"),
  operator("intake preview", "preview what intake would file"),
  operator("intake pr-comments", "intake review comments from a pull request"),
  operator("intake clear", "clear intake configuration"),
  operator("contest exclude", "exclude a contestant from a tournament"),
  operator("webhook primary", "choose which service receives alerts"),
  operator("webhook test", "send a test message"),
  operator("bridge", "the Telegram bridge (pairing, tokens, the follower)"),
  operator("enroll", "grant a repository authority (backends, dispatch) — its own explicit yes"),
  operator("revoke", "take an authority grant back"),
  operator("publish", "the publication pass: push built branches, open pull requests, sweep merges"),
  operator("publish grant", "grant publication or auto-merge authority"),
  operator("publish revoke", "take a publication grant back"),
  operator("publish unblock", "lift a repair's merge hold"),
  operator("publish rearm", "re-arm a refused merge after fixing the named cause"),
  operator("serve", "the operations console (HTTP)"),
  operator("watch", "the unattended loop, kept running"),
  operator("up", "console + worker + browser, one command"),
  operator("daemon", "install the loop under the OS service manager"),
];
