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
  team?: TeamSnapshot;
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
