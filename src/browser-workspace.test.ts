import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { openStore, type Store } from './store.js';
import { addApprover, approve, propose } from './scope.js';
import { mintCoordinator } from './coordinator.js';
import { assignmentOf, checkAssignment, claimAssignment, type AssignmentOwner } from './assignment.js';
import { assignmentStatusOf } from './assignment-ui.js';
import { taskWorkSummaryOf } from './work-summary.js';
import * as workIndex from './work-index.js';
import { storeEvidence } from './evidence.js';
import { requestResultChanges } from './result-actions.js';
import { BROWSER_CREW_LIMIT, browserCrewOf, browserNavigationOf, browserProjectsOf, browserWorkActionHref, serializeBrowserWorkspace, type BrowserWorkspace } from './browser-workspace.js';

const NOW = new Date('2026-09-20T10:00:00Z');
const REPO = '/repos/workspace';
const access = { principal: 'operator' as const, repos: [REPO] };

describe('admitted browser workspace projection', () => {
  let store: Store, dir: string, token: string, owner: AssignmentOwner;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'so-browser-workspace-'));
    store = openStore(join(dir, 'orders.db'));
    const approver = addApprover(store, 'operator', NOW);
    if (!approver.ok) throw Error('approver fixture');
    token = approver.token;
    for (const phase of ['build', 'plan'] as const) store.setPhaseConfig('installation', phase, 'claude', 'sonnet', 'operator', NOW);
    const lead = mintCoordinator(store, { name: 'lead', repos: [REPO], by: 'operator', now: NOW });
    if (!lead.ok) throw Error('lead fixture');
    owner = { kind: 'coordinator', id: lead.cid, label: 'lead' };
  });
  afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  function task(id: string, repo: string | null = REPO, at = NOW) {
    store.createTask({ id, title: `Keep ${id} available` }, at);
    const ref = store.lookupRef(id)!;
    if (repo !== null) store.placeTask(ref.id, repo);
    return ref.id;
  }
  function scopedTask(id: string) {
    task(id);
    propose(store, { taskId: id, goal: 'Keep the exact result available', acceptance: [
      { id: 'c1', statement: 'The saved result opens with the same task and run.', how: null, evidence: ['manual-review'] },
    ], now: NOW });
    expect(approve(store, id, 'operator', NOW, store.getScope(id)!.digest, token).ok).toBe(true);
    return id;
  }
  function built(id: string, outcome: 'built' | 'failed' = 'built') {
    const ref = store.lookupRef(id)!;
    const route = store.routeAuthorityFor(ref.id, 'builder');
    if (!route?.ok) throw Error('route fixture');
    const run = store.startRun({ taskRef: ref.id, runner: 'builder', leaseId: `lease-${id}`, branch: `so/${id}`, worktree: `/pool/${id}`, route: route.stamp, now: NOW });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: 'b'.repeat(40) });
    store.recordOutcomeFacts(run, { headRevision: 'a'.repeat(40), handoff: 'The exact saved result is available.' });
    store.finishRun(run, { outcome, committed: outcome === 'built', now: NOW });
    store.setTaskState(id, outcome === 'built' ? 'done' : 'failed', NOW);
    return run;
  }

  test('foreign and unplaced work cannot consume an admitted page or trigger detailed reads', () => {
    task('allowed');
    task('unplaced', null);
    for (let index = 0; index < 45; index++) task(`foreign-${index}`, '/private', new Date(NOW.getTime() + 1_000));
    const getTask = vi.spyOn(store, 'getTask');
    const families = vi.spyOn(store, 'taskFamiliesAdmitted');
    const page = vi.spyOn(workIndex, 'workIndexPage');
    expect(browserCrewOf(store, NOW, access, { limit: 1 })).toMatchObject({ crew: [{ id: 'allowed', project: REPO }], crewTruncated: false });
    expect(page).toHaveBeenCalledWith(store, NOW, access, { limit: 1, project: null });
    expect(families).not.toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();
    page.mockClear();
    expect(browserCrewOf(store, NOW, access, { project: '/private' })).toEqual({ crew: [], crewTruncated: false });
    expect(families).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();
    expect(browserCrewOf(store, NOW, { principal: 'coordinator', repos: [] })).toEqual({ crew: [], crewTruncated: false });
    expect(browserCrewOf(store, NOW, { principal: 'operator', repos: [], includeUnplaced: true }).crew.map(row => row.id)).toEqual(['unplaced']);
  });

  test('bounds the recent family list and reports whether more admitted work exists', () => {
    for (let index = 0; index < BROWSER_CREW_LIMIT + 1; index++) task(`item-${index}`);
    const index = vi.spyOn(workIndex, 'workIndexPage');
    const page = browserCrewOf(store, NOW, access, { limit: 10_000 });
    expect(page.crew).toHaveLength(BROWSER_CREW_LIMIT);
    expect(page.crewTruncated).toBe(true);
    expect(index).toHaveBeenCalledWith(store, NOW, access, { limit: BROWSER_CREW_LIMIT, project: null });
  });

  test('Ready and Complete match native assignment state without the browser writing anything', () => {
    const run = built(scopedTask('result'));
    expect(claimAssignment(store, 'result', owner, NOW, dir).ok).toBe(true);
    const read = () => {
      const native = assignmentOf(store, 'result', NOW, access, dir)!;
      const work = taskWorkSummaryOf(store, native.activeTaskId, NOW, access)!;
      const status = assignmentStatusOf(native, work.status);
      const before = store.handle.prepare('SELECT total_changes() AS changes').get();
      const crew = browserCrewOf(store, NOW, access, { evidenceRoot: dir }).crew[0]!;
      expect(store.handle.prepare('SELECT total_changes() AS changes').get()).toEqual(before);
      expect(crew).toMatchObject({ state: native.state, label: status.label, tone: status.tone,
        href: '/chat?task=result', resultHref: `/chat?task=result&result=${run}`,
        action: { label: native.primaryAction!.label, href: `/chat?task=result&result=${run}` } });
      return { native, crew };
    };
    const ready = read();
    expect(ready.crew).toMatchObject({ state: 'ready-to-check', label: 'Ready', tone: 'ready' });
    const runs = store.runsFor(store.lookupRef('result')!.id);
    expect(checkAssignment(store, 'result', ready.native.receipt!.digest, owner, NOW, dir).ok).toBe(true);
    expect(read().crew).toMatchObject({ state: 'complete', label: 'Complete', tone: 'done' });
    expect(store.runsFor(store.lookupRef('result')!.id)).toEqual(runs);
  });

  test('a revision is one crew family and its link names the receipt execution and run', () => {
    const original = built(scopedTask('original'));
    storeEvidence(store, dir, original, 'terminal-diff', 'changes.patch', Buffer.from('diff --git a/src/result.ts b/src/result.ts\n'), 'saved changes', NOW);
    const revision = requestResultChanges(store, dir, { run: original, batch: '', source: store.getScope('original')!.digest,
      actor: 'operator', repos: [REPO], note: 'Keep the original result accessible after revising it.', path: '', line: '', request: 'a'.repeat(32) }, NOW);
    expect(revision.ok).toBe(true);
    if (!revision.ok) throw Error(revision.message);
    expect(approve(store, revision.id, 'operator', NOW, store.getScope(revision.id)!.digest, token).ok).toBe(true);
    const run = built(revision.id);
    const unrelated = built(scopedTask('unrelated'));
    const page = browserCrewOf(store, NOW, access, { evidenceRoot: dir });
    expect(page.crew).toHaveLength(2);
    const row = page.crew.find(one => one.id === 'original')!;
    expect(row.href).toBe('/chat?task=original');
    expect(row.resultHref).toBe(`/chat?task=${encodeURIComponent(revision.id)}&result=${run}`);
    expect(row.resultHref).not.toContain(`result=${original}`);
    expect(row.resultHref).not.toContain(`result=${unrelated}`);
    expect(page.crew.some(one => one.id === revision.id)).toBe(false);
  });

  test('a failed attempt keeps its native recovery action and does not link to an unavailable result panel', () => {
    built(scopedTask('failed-attempt'), 'failed');
    const native = assignmentOf(store, 'failed-attempt', NOW, access, dir)!;
    const row = browserCrewOf(store, NOW, access, { evidenceRoot: dir }).crew[0]!;
    expect(row).toMatchObject({ state: 'needs-decision', resultHref: null,
      action: { label: native.primaryAction!.label } });
    expect(row.action!.href).not.toContain('&result=');
  });

  test('index action links retain exact decision, result, run and task owners and reject unsafe publication URLs', () => {
    task('root & original');
    const item = workIndex.workIndexPage(store, NOW, access).items[0]!;
    const action = (code: NonNullable<typeof item.primaryAction>['code'], decisionId: number | null = null) => ({
      ...item, primaryAction: { code, label: 'Open', target: { taskId: 'revision #2', runId: 42, decisionId }, access: 'read' as const, retry: 'read-again' as const },
    });
    expect(browserWorkActionHref(action('answer-decision', 13))).toBe('/d/13');
    expect(browserWorkActionHref(action('open-result'))).toBe('/chat?task=revision%20%232&result=42');
    expect(browserWorkActionHref(action('inspect-run'))).toBe('/r/42');
    expect(browserWorkActionHref(action('reconcile-run'))).toBe('/r/42');
    expect(browserWorkActionHref(action('inspect-decisions'))).toBe('/');
    const pr = action('open-pr');
    expect(browserWorkActionHref({ ...pr, publicationUrl: 'https://github.com/owner/repository/pull/42' })).toBe('https://github.com/owner/repository/pull/42');
    expect(browserWorkActionHref({ ...pr, publicationUrl: 'javascript:alert(1)' })).toBe('/review?result=revision%20%232&run=42&project=%2Frepos%2Fworkspace');
    const anchors = { 'approve-scope': '#approve', 'inspect-stop': '#task-control', 'resume-run': '#task-control', unhold: '#task-actions',
      'retry-task': '#task-actions', 'write-scope': '#scope', 'select-agent': '#scope', 'inspect-hold': '#holds',
      'start-worker': '#run-status', 'repair-dependency': '#run-status', 'inspect-task': '' } as const;
    for (const [code, anchor] of Object.entries(anchors)) expect(browserWorkActionHref(action(code as keyof typeof anchors))).toBe('/t/root%20%26%20original?version=revision%20%232' + anchor);
    expect(browserWorkActionHref({ ...item, primaryAction: null })).toBeNull();
  });
});

test('workspace JSON cannot close its script or create HTML and retains the exact strings', () => {
  const hostile = '</script><img src=x onerror=alert(1)>\u2028line\u2029<!--';
  const workspace: BrowserWorkspace = {
    version: 1, path: '/chat', title: hostile, user: 'operator', csrf: 'csrf', sensitive: false,
    refreshUrl: '/chat?format=workspace', receipt: null, projects: [], crew: [], crewTruncated: false,
    conversation: null, focus: { id: 'task', title: hostile, html: `<p>${hostile}</p>` }, result: null,
    catchUpHtml: '', controlsHtml: '', notices: [hostile], pageHtml: null, navigation: [],
  };
  const json = serializeBrowserWorkspace(workspace);
  expect(json).not.toMatch(/[<\u2028\u2029]/);
  expect(JSON.parse(json)).toEqual(workspace);
  const window = new Window();
  window.document.body.innerHTML = `<script id="workspace" type="application/json">${json}</script>`;
  expect(window.document.body.children).toHaveLength(1);
  expect(JSON.parse(window.document.getElementById('workspace')!.textContent!)).toEqual(workspace);
  expect(window.document.querySelector('img')).toBeNull();
  window.happyDOM.abort();
});

test('project and knowledge navigation preserve exact admitted paths and only one settings selection', () => {
  const path = '/repos/Research & planning#1';
  const projects = browserProjectsOf([{ name: 'Research', path }, { name: 'Duplicate', path }]);
  expect(projects).toEqual([{ name: 'Research', path,
    href: '/work?project=%2Frepos%2FResearch%20%26%20planning%231',
    knowledgeHref: '/settings/knowledge?repo=%2Frepos%2FResearch%20%26%20planning%231' }]);
  const navigation = browserNavigationOf('/settings/knowledge?repo=something', path);
  expect(navigation.filter(one => one.active).map(one => one.label)).toEqual(['Knowledge']);
  expect(navigation.find(one => one.label === 'Knowledge')!.href).toBe(projects[0]!.knowledgeHref);
});
