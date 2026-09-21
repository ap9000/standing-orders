/** The browser consumes this contract with a type-only import. All HTML is
 * produced by the existing trusted server renderers, never by a model-supplied
 * fragment. These projections do not authenticate, mutate or grant authority. */
import type { AssignmentSnapshot } from './assignment.js';
import { chatControlHref, chatResultHref } from './chat-controls.js';
import type { Store } from './store.js';
import type { WorkSummaryAccess } from './work-summary.js';
import { workIndexPage, type WorkIndexItem, type WorkIndexPage } from './work-index.js';
import type { StatusTone } from './workspace-ui.js';

export type BrowserProject = { name: string; path: string; href: string; knowledgeHref: string };
export type BrowserNavigationItem = { label: string; href: string; active: boolean };
export type BrowserCrewItem = {
  id: string; title: string; project: string | null;
  state: AssignmentSnapshot['state']; label: string; tone: StatusTone;
  href: string; resultHref: string | null; action: { label: string; href: string } | null;
};
export type BrowserMessage = {
  id: number; role: 'operator' | 'assistant'; text: string; html: string;
  activity: string | null; createdAt: string; cardsHtml: string;
};
export type BrowserConversation = {
  sessionId: number; user: string; version: string; messages: BrowserMessage[];
  pendingTurnId: number | null; requestId: string; maxChars: number;
  taskId: string | null; resultRunId: number | null;
};
export type BrowserWorkspace = {
  version: 1; path: string; title: string; user: string; csrf: string; sensitive: boolean;
  refreshUrl: string; receipt: { request: string; received: boolean } | null;
  projects: BrowserProject[]; crew: BrowserCrewItem[]; crewTruncated: boolean;
  conversation: BrowserConversation | null;
  focus: { id: string; title: string; html: string } | null;
  result: { runId: number; html: string } | null;
  catchUpHtml: string; controlsHtml: string; notices: string[]; pageHtml: string | null;
  navigation: BrowserNavigationItem[];
};

/** Safe inside a script[type=application/json] element. JSON escaping alone
 * does not stop the HTML parser from closing that element at </script>. */
export function serializeBrowserWorkspace(workspace: BrowserWorkspace): string {
  return JSON.stringify(workspace).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export const BROWSER_CREW_LIMIT = 40;
export type BrowserCrewOptions = { evidenceRoot?: string; limit?: number; project?: string | null };

/** The index is navigation only. Controls retain their exact owning task, run,
 * decision and approval ceremony; opening a result keeps its saved execution. */
export function browserWorkActionHref(item: WorkIndexItem): string | null {
  const action = item.primaryAction;
  if (action === null) return null;
  const { taskId, runId, decisionId } = action.target;
  if (decisionId !== null) return `/d/${decisionId}`;
  if (action.code === 'inspect-decisions') return '/';
  if (action.code === 'open-result' && runId !== null) return chatResultHref(taskId, runId);
  if (action.code === 'open-pr' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(item.publicationUrl ?? '')) return item.publicationUrl!;
  if (runId !== null && (action.code === 'open-pr' || action.code === 'retry-review')) {
    return `/review?result=${encodeURIComponent(taskId)}&run=${runId}${item.repo === null ? '' : '&project=' + encodeURIComponent(item.repo)}`;
  }
  if (runId !== null && (action.code === 'inspect-run' || action.code === 'reconcile-run')) return `/r/${runId}`;
  const anchor = action.code === 'approve-scope' ? '#approve'
    : action.code === 'inspect-stop' || action.code === 'resume-run' ? '#task-control'
    : action.code === 'unhold' || action.code === 'retry-task' ? '#task-actions'
    : action.code === 'write-scope' || action.code === 'select-agent' ? '#scope'
    : action.code === 'inspect-hold' ? '#holds'
    : action.code === 'start-worker' || action.code === 'repair-dependency' ? '#run-status' : '';
  return `/t/${encodeURIComponent(item.rootId)}?version=${encodeURIComponent(taskId)}` + anchor;
}

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

/** Render an already-admitted page without repeating its database query. */
export function browserCrewFromIndex(page: WorkIndexPage): { crew: BrowserCrewItem[]; crewTruncated: boolean } {
  const rows = page.items.map(summary => {
    const status = summary.status;
    const resultHref = summary.resultRunId === null || summary.resultTaskId === null || (summary.resultOutcome !== 'built' && summary.resultOutcome !== 'no-change')
      ? null : chatResultHref(summary.resultTaskId, summary.resultRunId);
    const href = chatControlHref('task', summary.rootId);
    const action = summary.primaryAction;
    const actionHref = browserWorkActionHref(summary);
    const item: BrowserCrewItem = {
      id: summary.rootId, title: summary.title, project: summary.repo,
      state: summary.assignmentState, label: status.label, tone: status.tone, href, resultHref,
      action: action === null || actionHref === null ? null : { label: action.label, href: actionHref },
    };
    return { item, rank: status.rank };
  });
  // Stable ordering retains recency within each shared presentation rank.
  rows.sort((a, b) => a.rank - b.rank);
  return { crew: rows.map(row => row.item), crewTruncated: page.nextCursor !== null };
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

export function browserNavigationOf(path: string, project: string | null = null): BrowserNavigationItem[] {
  const pathname = path.split('?')[0]!.split('#')[0]!;
  const knowledge = pathname === '/settings/knowledge' || pathname.startsWith('/settings/knowledge/');
  return [
    { label: 'Chat', href: '/chat', active: pathname === '/chat' },
    { label: 'Tasks', href: `/work${project === null ? '' : `?project=${encodeURIComponent(project)}`}`,
      active: pathname === '/work' || pathname === '/tasks' || pathname.startsWith('/t/') },
    { label: 'Projects', href: '/projects', active: pathname === '/projects' },
    { label: 'Knowledge', href: `/settings/knowledge${project === null ? '' : `?repo=${encodeURIComponent(project)}`}`, active: knowledge },
    { label: 'Settings', href: '/settings', active: !knowledge && (pathname === '/settings' || pathname.startsWith('/settings/')) },
  ];
}
