/** The browser consumes this contract with a type-only import. All HTML is
 * produced by the existing trusted server renderers, never by a model-supplied
 * fragment. These projections do not authenticate, mutate or grant authority. */
import type { TeamSnapshot } from './team-contract.js';
import type { AssignmentSnapshot } from './assignment.js';
import { browserCrewFromIndex } from './browser-crew.js';
export { browserCrewFromIndex, browserWorkActionHref } from './browser-crew.js';
import type { Store } from './store.js';
import type { WorkSummaryAccess } from './work-summary.js';
import { workIndexPage, type WorkIndexItem, type WorkIndexPage } from './work-index.js';
import type { StatusTone } from './workspace-ui.js';
import type { AssignmentCard } from './assignment-ui.js';

export type BrowserProject = { name: string; path: string; href: string; knowledgeHref: string };
/** count: tasks waiting on a person, shown beside Tasks when above zero. */
export type BrowserNavigationItem = { label: string; href: string; active: boolean; count?: number };
export type BrowserChatLink = { kind: 'project' | 'task'; title: string; href: string; at: string | null; active: boolean };
export type BrowserCrewItem = {
  id: string; title: string; project: string | null;
  state: AssignmentSnapshot['state']; label: string; tone: StatusTone;
  href: string; resultHref: string | null; action: { label: string; href: string } | null;
};
export type BrowserMessage = {
  id: number; role: 'operator' | 'assistant'; text: string; html: string;
  activity: string | null; createdAt: string; cardsHtml: string;
  /** The same cards as data, confirmed in place (chat cards). */
  cards?: BrowserActionCard[];
};
/** A card the lead proposed: what it would do (the server's own body) and
 * the one act it offers. Confirming posts to the card's own door. */
export type BrowserActionCard = {
  id: number; kind: string; label: string;
  state: 'drafting' | 'pending' | 'confirming' | 'confirmed' | 'refused' | 'dismissed' | 'expired';
  body: string;
  said: string | null;
  links: BrowserLink[];
  primary: { kind: 'confirm'; label: string; irreversible: boolean; native: boolean } | { kind: 'link'; label: string; href: string } | null;
  dismissable: boolean;
  note: string | null;
};
export type BrowserConversation = {
  sessionId: number; user: string; version: string; messages: BrowserMessage[];
  pendingTurnId: number | null; requestId: string; maxChars: number;
  taskId: string | null; resultRunId: number | null;
  /** A project's own thread (v77); absent or null for the lead conversation or a task. */
  project?: string | null;
};
/** A page rebuilt as React components (shadcn/ui). The server still renders
 * its HTML as the no-JavaScript fallback; forms post to the same routes. */
export type BrowserLink = { label: string; href: string };
export type BrowserTasksView = {
  kind: 'tasks';
  tabs: (BrowserLink & { count: number; active: boolean })[];
  rows: {
    id: string; title: string; href: string; project: string | null; age: string;
    status: { label: string; tone: StatusTone; token: string };
    action: BrowserLink | null; detail: string | null; problem: string | null; notes: string[];
  }[];
  empty: { text: string; action: BrowserLink | null } | null;
  pages: { first: string | null; next: string | null };
  tools: BrowserLink[];
  newTask: BrowserLink;
};
export type BrowserSettingsView = {
  kind: 'settings';
  said: string | null;
  tiles: BrowserLink[];
  theme: 'system' | 'light' | 'dark';
  permission: { mode: string; canManage: boolean; changed: string | null } | null;
  quality: { mode: string; canManage: boolean; changed: string | null } | null;
  providers: {
    provider: string; name: string; tone: 'ok' | 'warn' | 'off' | 'neutral'; words: string;
    connection: { words: string; facts: string; checkHref: string } | null;
    usage: string; envName: string; subscriptionCapable: boolean; mode: 'subscription' | 'api-key'; set: boolean;
  }[] | null;
  services: { configured: string[]; channel: string | null; implicit: boolean } | null;
  push: { available: boolean; devices: { id: number; words: string; state: string; removable: boolean }[] } | null;
  digest: { every: string; held: string | null } | null;
  telegram: { state: string; current: string };
  /** v87: the mail server Send email steps use (approvers only); the password is never shown back. */
  email?: { set: boolean; host: string; port: number; secure: boolean; user: string; from: string;
    /** v89: where Email inbox triggers read (IMAP), and a Google account connected instead of a mail server (`redirect`: the address to register with Google, when this page's address can take one). */
    imapHost: string; imapPort: number; google: { connected: string | null; clientId: string; redirect: string | null } } | null;
};
/** A fold on the task page. Its HTML is the server's own section body, so
 * forms, ids and page scripts are unchanged. */
export type BrowserTaskSection = { id: string; title: string; html: string; open: boolean; count: number | null };
export type BrowserTaskFact = { label: string; parts: (string | BrowserLink | { seal: string })[] };
export type BrowserTaskView = {
  kind: 'task';
  id: string; title: string; project: string | null; scout: boolean;
  tabs: (BrowserLink & { active: boolean })[];
  version: { label: string; current: BrowserLink } | null;
  /** The status card; `statusHtml` stands in when no assignment projection exists. */
  status: AssignmentCard | null;
  statusHtml: string;
  /** The approval ceremony or its updated terms, exactly as signed. */
  approval: string;
  /** Server cards that may need a person now (stop/resume, scope prompt, plan, live attempt). */
  lead: { key: string; html: string }[];
  questions: string;
  facts: BrowserTaskFact[];
  sections: BrowserTaskSection[];
  manage: BrowserTaskSection[];
  /** The armed cancel form; null once the task cannot be cancelled. */
  cancel: { html: string; open: boolean } | null;
};
/** One project on the Projects page; opening it is a POST to /projects/open. */
export type BrowserProjectRow = {
  name: string; path: string; shortPath: string; open: boolean;
  /** When it was last opened here; null for a project only seen in the queue. */
  openedAt: string | null;
  knowledgeHref: string;
  /** What waits, runs, queues or finished today; null when not scanned. */
  peek: { label: string; href: string; tone: 'attention' | 'info' | 'neutral' | 'success' }[] | null;
};
export type BrowserProjectsView = {
  kind: 'projects';
  /** Arrived from New task: choosing where the task belongs. */
  choosing: boolean;
  problem: string | null;
  returnTo: string;
  recent: BrowserProjectRow[];
  available: BrowserProjectRow[];
  /** The add roads; `html` carries the server's GitHub-link and exact-path forms. */
  add: { browse: string | null; github: string | null; html: string };
};
export type BrowserResultTab = 'summary' | 'changes' | 'checks';
export type BrowserResultChip = { tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; label: string; icon: 'check' | 'x' | null; title: string | null };
/** The shared result panel in parts. Each tab's content, the feedback
 * section and the learning card are the server's own HTML; the page script
 * binds to the same data attributes and ids (tabs, drafts, line notes). */
export type BrowserResultPanel = {
  attributes: Record<string, string>;
  heading: string;
  outcome: string;
  verdict: { chips: BrowserResultChip[]; by: string | null } | null;
  reviewHistory: string | null;
  attention: string[];
  /** Storage limits on saved output (shortened logs or diffs): shown on request. */
  limits: string[];
  tabs: { key: BrowserResultTab; label: string; count: string; href: string; active: boolean }[];
  views: { key: BrowserResultTab; html: string }[];
  history: string;
  learning: string;
  request: string | null;
  /** A browser session may attach feedback to this result's sealed diff. */
  canRequest: boolean;
  /** The feedback section holds only the closed form (no notes, revisions or history). */
  requestQuiet: boolean;
};
export type BrowserResultView = {
  kind: 'result';
  results: { title: string; href: string; at: string; status: { label: string; tone: StatusTone } | null; notes: string[]; current: boolean; needsYou: boolean }[];
  /** How many results need a person; the list's cap when it is full. */
  attention: number;
  capped: number | null;
  missing: string | null;
  beyond: boolean;
  selected: {
    taskId: string; title: string; project: string | null; build: number | null;
    taskHref: string; chatHref: string;
    status: { label: string; tone: StatusTone; token: string };
    problem: string | null;
    next: { kind: string; title: string; detail: string; control: string } | null;
    complete: { action: string; receipt: string; run: number } | null;
    checks: { detail: string; problem: boolean; logHref: string | null } | null;
    /** The signed scope; null when none was filed. */
    intent: { approval: string; html: string } | null;
    noRun: string | null;
    panel: BrowserResultPanel | null;
    contest: string;
    notes: { author: string; at: string; note: string }[];
  } | null;
};
/** One zone on a flow's canvas: its step, where it leads, and where it sits. */
export type BrowserFlowStage = {
  id: string; title: string; kind: "inbox" | "task" | "report" | "approval" | "check" | "update" | "notify" | "sort" | "draft" | "request" | "email" | "tool" | "wait" | "teammate" | "done";
  zone: { x: number; y: number; w: number; h: number; color: string };
  instructions: string | null; planning: "auto" | "required" | "skip" | null; approver: string | null; message: string | null;
  /** An approval zone the flow's owner decides. */
  toOwner?: boolean;
  /** v87: a web request, an email, a project tool call. */
  request?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers: Record<string, string>; body: string | null };
  email?: { to: string; subject: string; body: string };
  tool?: { server: string; name: string; args: string };
  close: boolean | null; script: string | null;
  /** v90: a script zone runs in an empty folder or a copy of the card's work; the answers its "goto:" line picks; the saved secrets it gets. */
  runIn?: "folder" | "copy"; routes?: { answer: string; to: string }[]; secrets?: string[];
  /** A sort zone: Jev's question, its answers and where each goes, how sure it must be to act alone, and what else it notes. */
  sort: { question: string; answers: { answer: string; means: string; to: string }[]; sureAt: number; notes: { id: string; kind: "score" | "yes-no"; question: string; levels: string[] | null }[] } | null;
  /** v91: a Wait zone waits for a reply to the card's email (onFail: no reply in time) or a set time; any other zone may have a time limit. */
  wait?: { for: "reply" | "time"; minutes: number };
  limit?: { minutes: number; to: string | null } | undefined;
  /** v92: the AI teammate who decides (an approval zone) or handles (a teammate zone) it. */
  teammate?: string | undefined;
  /** v96: a teammate zone sends what the teammate writes back to whoever asked. */
  reply?: boolean | undefined;
  next: string | null; onFail: string | null;
};

/** One card: a piece of work, where it is, what it waits on, what zones said. */
export type BrowserFlowCard = {
  id: number; title: string; description: string | null; stage: string; state: "active" | "done" | "cancelled";
  waiting: string | null; task: { id: string; href: string } | null; createdBy: string; updatedAt: string;
  canDecide: boolean; outputs: { stage: string; title: string; text: string }[]; history: { text: string; at: string }[];
  /** Where a trigger found it: a GitHub or Linear issue, another flow's card, a button, a schedule. */
  source: { kind: string; label: string; url: string | null } | null;
  /** Who is responsible for it, who follows it, and whether the viewer does. */
  owner: string | null; watchers: string[]; watching: boolean;
  /** Owned by the viewer, followed by them, or waiting on their decision. */
  mine: boolean;
  /** What people said on it, oldest first; ownership changes read as history instead. */
  comments: { id: number; author: string; body: string; mentions: string[]; at: string }[];
  /** The latest sort: its short chip ("Bug · 94% · Now") and whether Jev was sure enough to act alone. */
  sorted: { chip: string; confident: boolean } | null;
  /** Waiting at a decision after a draft: the draft, which the person can edit before approving. */
  draft: { zone: string; title: string; text: string } | null;
  /** v91: when its Wait zone gives up or moves on, or its zone's time limit comes (shown in the viewer's own time). */
  deadline?: { at: string; label: string } | null;
  /** v92: a teammate's open question about this visit, and whether the viewer is the one asked. */
  question?: { id: number; from: string; question: string; options: { id: string; label: string }[]; askedOf: string; mine: boolean;
    /** v94: a tool call waiting for approval — why the teammate wants it, and why it needs approval. */
    call?: { why: string; rule: string } | null } | null;
  /** v92: what the teammate said when it handed this decision to a person. */
  handoff?: { from: string; note: string } | null;
  /** v94: every tool call teammates made or asked to make on this card, oldest first: the receipts. */
  calls?: { id: number; who: string; words: string; state: string; outcome: string; why: string; result: string | null; at: string }[];
};

/** What starts cards in a flow on its own. */
export type BrowserFlowTrigger = {
  id: number; kind: string; words: string; name: string; detail: string; zone: string; zoneId: string; state: "active" | "paused" | "removed";
  status: string | null; statusAt: string | null; failing: boolean;
  button: { label: string; questions: string[] } | null;
  /** A webhook trigger: whether it can prove deliveries yet (Linear needs its signing secret pasted). */
  hook: { ready: boolean; needsSecret: boolean } | null;
  checkable: boolean;
  /** A button shared as a public form (its link works). */
  shared: boolean;
};

/** A flow's canvas: zones, cards, and what this person may change. */
export type BrowserFlowView = {
  kind: "flow";
  flow: { id: number; name: string; project: string; revision: number; href: string; owner: string };
  /** Opens the lead's chat with a message about this flow started for the person to finish. */
  chatHref: string;
  triggers: BrowserFlowTrigger[];
  /** What adding a trigger needs to know: this project's GitHub repository, whether a Linear key is saved, the public webhook address, other flows to follow. */
  triggerSetup: {
    kinds: { kind: string; label: string }[]; githubRepo: string | null; linearKey: boolean; hooksBase: string | null; hooksPath: string;
    /** v89: whether Email inbox triggers can read mail (Settings → Email), and whose mailbox it is. */
    mailbox: string | null;
    otherFlows: { id: number; name: string; zones: { id: string; title: string }[] }[];
  };
  /** A button trigger to open straight away (?start=). */
  startTrigger: number | null;
  /** Who is looking: their name, for "mine", owning and @mentions. */
  me: string;
  /** Whether sort zones can run: an OpenRouter key is saved in Settings → AI providers. */
  sortReady: boolean;
  /** v92: the project's AI teammates, to staff zones with. */
  teammates?: { handle: string; label: string; name: string; working: boolean; href: string }[];
  /** v87: whether email is set up (Settings → Email), the names of this project's request secrets, and its tools with what each can do. */
  emailReady: boolean;
  requestSecrets: string[];
  tools: { name: string; about: string; functions: string[]; ready: boolean }[];
  /** The project's scripts: reusable steps a "Run a script" zone runs with no AI. */
  /** v90: each script's language, and the project file it runs instead of a body. */
  scripts: { name: string; about: string; body: string; timeoutMinutes: number; version: number; savedBy: string; savedAt: string; usedHere: string[]; language: "shell" | "python" | "node"; file: string | null }[];
  start: string;
  stages: BrowserFlowStage[];
  cards: BrowserFlowCard[];
  selectedCard: number | null;
  /** Where the flow stands (v88): the live stream's nudge names it, and a page that already shows it doesn't read again. */
  live: string | null;
  canEdit: boolean;
  approvers: string[];
  kinds: { kind: BrowserFlowStage["kind"]; label: string; about: string }[];
  colors: string[];
};

export type BrowserView = BrowserTasksView | BrowserSettingsView | BrowserTaskView | BrowserProjectsView | BrowserResultView | BrowserFlowView;

export type BrowserWorkspace = {
  version: 1; path: string; title: string; user: string; csrf: string; sensitive: boolean;
  refreshUrl: string; receipt: { request: string; received: boolean } | null;
  projects: BrowserProject[]; crew: BrowserCrewItem[]; crewTruncated: boolean;
  conversation: BrowserConversation | null;
  team?: TeamSnapshot;
  focus: { id: string; title: string; html: string } | null;
  result: { runId: number; html: string } | null;
  catchUpHtml: string; controlsHtml: string; notices: string[]; pageHtml: string | null;
  navigation: BrowserNavigationItem[];
  /** This person's recent project and task conversations (v77), newest first. */
  chats?: BrowserChatLink[];
  view?: BrowserView | null;
};

/** Safe inside a script[type=application/json] element. JSON escaping alone
 * does not stop the HTML parser from closing that element at </script>. */
export function serializeBrowserWorkspace(workspace: BrowserWorkspace): string {
  return JSON.stringify(workspace).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export const BROWSER_CREW_LIMIT = 40;
export type BrowserCrewOptions = { evidenceRoot?: string; limit?: number; project?: string | null };

/** A bounded recent family list. The caller supplies its already admitted
 * access; an optional project can only narrow it. Admission and family grouping
 * happen before the SQL limit and before reading questions or saved evidence. */
export function browserCrewOf(store: Store, now: Date, access: WorkSummaryAccess, options: BrowserCrewOptions = {}): {
  crew: BrowserCrewItem[]; crewTruncated: boolean;
} {
  const project = options.project ?? null;
  if (project !== null && access.repos !== null && !access.repos.includes(project)) return { crew: [], crewTruncated: false };
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(BROWSER_CREW_LIMIT, Math.floor(options.limit!))) : BROWSER_CREW_LIMIT;
  const page = workIndexPage(store, now, access, { limit, project });
  return browserCrewFromIndex(page);
}

/** Navigation input must already be admitted by the caller. No extra project
 * discovery belongs in a browser projection. Keep exact paths in every link. */
export function browserProjectsOf(projects: readonly { name: string; path: string }[]): BrowserProject[] {
  const seen = new Set<string>();
  return projects.flatMap(project => {
    if (seen.has(project.path)) return [];
    seen.add(project.path);
    return [{ name: project.name, path: project.path, href: `/work?project=${encodeURIComponent(project.path)}`,
      knowledgeHref: `/settings/knowledge?repo=${encodeURIComponent(project.path)}` }];
  });
}

export function browserNavigationOf(path: string, project: string | null = null, needsYou = 0): BrowserNavigationItem[] {
  const pathname = path.split('?')[0]!.split('#')[0]!;
  const knowledge = pathname === '/settings/knowledge' || pathname.startsWith('/settings/knowledge/');
  return [
    { label: 'Chat', href: '/chat', active: pathname === '/chat' },
    { label: 'Tasks', href: `/work${project === null ? '' : `?project=${encodeURIComponent(project)}`}`,
      active: pathname === '/work' || pathname === '/tasks' || pathname.startsWith('/t/') || pathname.startsWith('/r/'),
      ...(needsYou > 0 ? { count: needsYou } : {}) },
    { label: 'Flows', href: '/flows', active: pathname === '/flows' || pathname.startsWith('/flows/') },
    { label: 'Projects', href: '/projects', active: pathname === '/projects' },
    { label: 'Knowledge', href: `/settings/knowledge${project === null ? '' : `?repo=${encodeURIComponent(project)}`}`, active: knowledge },
    { label: 'Settings', href: '/settings', active: !knowledge && (pathname === '/settings' || pathname.startsWith('/settings/')) },
  ];
}
