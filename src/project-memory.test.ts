import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from './store.js';
import { addApprover, propose, approve } from './scope.js';
import { register } from './runner.js';
import { changeKnowledge, knowledgeContext, knowledgeView, readKnowledgeSnapshot, conversationKnowledge } from './project-knowledge.js';
import { decisionHistory, decisionLines, getDecision, listDecisions, recordDecision, retireDecision, searchMemory } from './project-memory.js';
import { assignmentCatchUp } from './assignment-brief.js';
import { TeamLeads } from './team-leads.js';
import { decisionsHtml, memorySearchHtml } from './knowledge-ui.js';

describe('project memory: decisions and search', () => {
  let root: string, repo: string, store: Store, password: string;
  const now = new Date('2026-09-21T22:00:00Z');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-test-'))); repo = join(root, 'repo'); mkdirSync(repo);
    git('init', '-q'); writeFileSync(join(repo, 'footer.md'), '# Footer\nThe footer shows the current year.\n'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'seed');
    store = openStore(join(root, 'test.db'));
    const user = addApprover(store, 'alex', now); if (!user.ok) throw Error('fixture'); password = user.token;
    for (const phase of ['plan', 'build', 'review'] as const) store.setPhaseConfig('installation', phase, 'claude', 'sonnet', 'fixture', now);
    register(store, { name: 'runner', host: 'test', capacity: 100, repos: [repo], now, newToken: () => 'runner-token' });
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const decide = (claim: string, why: string, extra: Record<string, unknown> = {}) => recordDecision(store, { repo, actor: 'alex', draft: { claim, why, ...extra } }, now);

  test('a decision is recorded with its reason and source, superseded by a newer one, retired with a reason, and never deleted', () => {
    const first = decide('The footer shows the current year.', 'Legal asked for it in the launch review.', { sourceKind: 'conversation', sourceRef: 'conversation:abc' });
    expect(first).toMatchObject({ id: 1, status: 'active', decidedBy: 'alex', sourceKind: 'conversation', sourceRef: 'conversation:abc' });
    const second = decide('The footer shows the year and the build number.', 'Support needs the build number in screenshots.', { supersedes: 1 });
    expect(second.supersedes).toBe(1);
    expect(getDecision(store, repo, 'alex', 1)).toMatchObject({ status: 'superseded', revision: 2 });
    expect(listDecisions(store, repo, 'alex').map(d => d.id)).toEqual([2]);
    expect(listDecisions(store, repo, 'alex', { status: 'all' }).map(d => d.id)).toEqual([2, 1]);
    expect(() => decide('Again', 'x', { supersedes: 1 })).toThrow(/not active/);
    const retired = retireDecision(store, { repo, actor: 'alex', id: 2, reason: 'The build number moved to the about page.' }, now);
    expect(retired.status).toBe('retired');
    expect(decisionHistory(store, repo, 'alex', 2).map(h => h.action)).toEqual(['record', 'retired']);
    expect(() => store.handle.exec('DELETE FROM project_decision')).toThrow(/never deleted/);
    expect(() => store.handle.exec("UPDATE decision_change SET actor='x'")).toThrow(/immutable/);
    expect(() => decide('', 'why')).toThrow(/required/);
    expect(() => decide('Use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'why')).toThrow(/secrets/);
    const viewer = addApprover(store, 'sam', now, { name: 'alex', token: password });
    expect(viewer.ok).toBe(true);
    expect(store.setAccountProjects('sam', [], 'alex', now).ok).toBe(true);
    expect(() => listDecisions(store, repo, 'sam')).toThrow(/access/);
  });

  test('decisions ride the frozen run context one line each, and the lead brief and conversation index carry them', () => {
    decide('Payments use the sandbox gateway until launch.', 'The production keys are held by finance.');
    decide('The footer shows the current year.', 'Legal asked for it.');
    changeKnowledge(store, { repo, actor: 'alex', identity: knowledgeView(store, repo, 'alex').identity, revision: 0, action: 'instructions', draft: { instructions: 'Keep copy short.' } }, now);
    const id = 'footer-1'; store.createTask({ id, title: 'Show the year in the footer' }, now); const ref = store.refFor('built-in', id).id; store.placeTask(ref, repo);
    propose(store, { taskId: id, goal: 'Show the year in the footer', touches: ['footer.md'], acceptance: [], now }); approve(store, id, 'alex', now, store.getScope(id)!.digest, password);
    const route = store.routeAuthorityFor(ref, 'builder', null, { provider: 'claude', model: 'sonnet' }); if (!route?.ok) throw Error('route');
    const run = store.startRun({ taskRef: ref, leaseId: 'lease', runner: 'runner', role: 'builder', branch: `standing-orders/${id}`, worktree: repo, provider: 'claude', model: 'sonnet', now, route: route.stamp });
    store.stampRun(run, { scopeDigest: store.getScope(id)!.digest, baseRevision: git('rev-parse', 'HEAD') });
    const brief = knowledgeContext(store, run);
    expect(brief).toContain('decisions are settled choices');
    const snapshot = readKnowledgeSnapshot(store, run)!;
    expect(snapshot.decisions?.map(d => d.id)).toEqual([2, 1]);
    expect(JSON.stringify(snapshot.decisions)).not.toContain('Legal asked');
    // A decision recorded later never changes the frozen run record.
    decide('Buttons are blue.', 'Brand.');
    expect(readKnowledgeSnapshot(store, run)!.decisions?.length).toBe(2);
    expect(decisionLines(store, repo, 'footer year', { limit: 1 })).toEqual([{ id: 2, claim: 'The footer shows the current year.', decidedAt: now.toISOString() }]);
    const catchUp = assignmentCatchUp(store, now, { principal: 'operator', repos: [repo] });
    expect(catchUp.projects[0]?.knowledge.decisions.map(d => d.id)).toEqual([3, 2, 1]);
    const index = conversationKnowledge(store, repo, 'alex') as { decisions: { id: number; claim: string }[] };
    expect(index.decisions.map(d => d.claim)).toContain('Buttons are blue.');
    expect((conversationKnowledge(store, repo, 'alex', undefined, 1) as { decision: { why: string } }).decision.why).toContain('finance');
  });

  test('search spans decisions, references, lessons and the conversations a person may read, and never crosses audiences', () => {
    decide('The footer shows the current year.', 'Legal asked for it.');
    changeKnowledge(store, { repo, actor: 'alex', identity: knowledgeView(store, repo, 'alex').identity, revision: 0, action: 'save', draft: { title: 'Footer design', path: 'footer.md' } }, now);
    const sam = addApprover(store, 'sam', now, { name: 'alex', token: password }); if (!sam.ok) throw Error('sam');
    const domain = new TeamLeads(store, () => [repo]);
    const actor = (name: string) => ({ name, generation: store.accountOf(name)!.generation });
    const lead = domain.execute(actor('alex'), { operation: 'create-lead', args: { name: 'Engineering', instructions: 'Keep it simple.', projects: [repo] } }, now); if (!lead.ok) throw Error(lead.message);
    const made = domain.execute(actor('alex'), { operation: 'create-conversation', args: { leadId: (lead.result as { leadId: string }).leadId, title: 'Launch', visibility: 'team', projects: [repo] } }, now); if (!made.ok) throw Error(made.message);
    const thread = (made.result as { threadId: number }).threadId, conversation = (made.result as { conversationId: string }).conversationId;
    store.appendMateMessage({ thread, turn: null, role: 'operator', text: 'Remember the gateway sandbox until launch day.' }, now);
    const privateThread = store.openMateThread('alex', 'ceiling', now).thread.id;
    store.appendMateMessage({ thread: privateThread, turn: null, role: 'operator', text: 'My private note about the sandbox gateway.' }, now);
    const hits = (who: string, query: string) => searchMemory(store, { actor: who, repos: [repo], query });
    expect(hits('alex', 'footer year').map(h => h.kind).sort()).toEqual(['decision', 'reference']);
    expect(hits('alex', 'sandbox gateway').map(h => h.scope ?? h.kind)).toEqual(['conversation', 'conversation']);
    // sam is not in the conversation and has no private note: nothing.
    expect(store.setAccountProjects('sam', [repo], 'alex', now).ok).toBe(true);
    expect(hits('sam', 'sandbox gateway')).toEqual([]);
    expect(domain.execute(actor('alex'), { operation: 'member', args: { conversationId: conversation, account: 'sam', role: 'contributor', active: true, expectedRevision: 1, joinLead: true, expectedLeadRevision: 1 } }, now).ok).toBe(true);
    expect(hits('sam', 'sandbox gateway').map(h => h.title)).toEqual(['operator in a team conversation']);
    expect(memorySearchHtml(repo, 'footer', hits('alex', 'footer'))).toContain('decision #1');
    expect(decisionsHtml(repo, listDecisions(store, repo, 'alex'), 'csrf', true)).toContain('Retire');
  });
});
