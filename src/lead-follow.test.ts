import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { openStore, type Store, type ChatConfig } from './store.js';
import { verifyApproverStanding } from './principal.js';
import { subscriptionCredentialKey } from './converse.js';
import { configureLeadFollow, leadFollowStatus, runLeadFollowPass } from './lead-follow.js';
import { leadContext, leadBriefHtml } from './lead-context.js';
import { assignmentCatchUp } from './assignment-brief.js';
import { propose } from './scope.js';

const repo = '/repo/lead-project', foreign = '/repo/private';
let store: Store, now: Date;
const config: ChatConfig = { provider: 'codex-subscription', model: 'default', dailyTurns: 50, weeklyCeilingMicrousd: 0,
  priceInMicrousd: null, priceOutMicrousd: null, updatedAt: '2026-09-20T00:00:00.000Z', updatedBy: 'owner' };
beforeEach(() => { store = openStore(':memory:'); now = new Date('2026-09-20T00:00:00.000Z'); store.saveApprover('owner', 'a'.repeat(64), now); });
afterEach(() => { vi.restoreAllMocks(); store.close(); });
function start() {
  const proof = verifyApproverStanding(store, 'owner', store.accountOf('owner')!.generation, [repo]); if (!proof.ok) throw Error('principal');
  const who = proof.who;
  const id = store.mintMateSession({ approver: who.name, approverGeneration: who.generation, credentialKey: subscriptionCredentialKey('codex-subscription'), ceilingMicrousd: 0, ceilingDigest: who.ceilingDigest, termsDigest: 't'.repeat(64) }, now);
  const session = store.getMateSession(id)!, thread = store.openMateThread(who.name, who.ceilingDigest, now).thread;
  expect(configureLeadFollow(store, who, session, thread, true, now)).toBe(true);
  return { who, session, thread };
}
function task(id: string, project = repo) { now = new Date(now.getTime() + 1000); store.createTask({ id, title: id }, now); store.placeTask(store.lookupRef(id)!.id, project); }
const answer = () => ({ ok: true as const, answer: { text: 'A saved task needs your decision.', calls: [], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null } });
const pass = (runner = vi.fn(async () => answer()), repos = [repo]) => runLeadFollowPass({ store, repos: () => repos, clock: () => now, evidenceRoot: '/missing-evidence', provider: () => ({ config, key: null }), subscriptionRunner: runner });

test('idle scans spend nothing; one meaningful update reaches the shared conversation once', async () => {
  const { thread } = start(), runner = vi.fn(async () => answer());
  await pass(runner); await pass(runner); expect(runner).not.toHaveBeenCalled();
  task('choose-policy'); task('PRIVATE-TITLE', foreign);
  const before = store.getTask('choose-policy');
  await pass(runner); await pass(runner);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(store.listMateMessages(thread.id, 20).at(-1)?.text).toContain('saved task');
  expect(JSON.stringify(runner.mock.calls)).not.toContain('PRIVATE-TITLE');
  expect(store.getTask('choose-policy')).toEqual(before);
  expect(store.handle.prepare('SELECT COUNT(*) AS n FROM run').get()?.n).toBe(0);
  expect(leadFollowStatus(store, 'owner').detail).toBe('Crew updates handled.');
});

test('a crash after a saved response but before acknowledgment does not invoke the model again', async () => {
  start(); task('choose-policy');
  const runner = vi.fn(async () => answer()), original = store.setServiceCursor.bind(store);
  const spy = vi.spyOn(store, 'setServiceCursor').mockImplementation((key, value, at) => {
    if (key.endsWith(':delivery')) throw Error('simulated process exit before ACK');
    return original(key, value, at);
  });
  await expect(pass(runner)).rejects.toThrow('simulated process exit');
  spy.mockRestore(); await pass(runner);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(leadFollowStatus(store, 'owner').detail).toBe('Crew updates handled.');
});

test('a failed response is visible and never automatically resubmitted', async () => {
  const { thread } = start(); task('choose-policy');
  const runner = vi.fn(async () => ({ ok: false as const, problem: 'provider-error' as const }));
  await pass(runner as unknown as Parameters<typeof pass>[0]); await pass(runner as unknown as Parameters<typeof pass>[0]);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(store.listMateMessages(thread.id, 20).at(-1)?.text).toContain('crew work was not rerun');
  expect(store.getTask('choose-policy')?.state).toBe('queued');
});

test('pause, project removal and ended sessions prevent background provider calls', async () => {
  const { who, session, thread } = start(); task('choose-policy'); const runner = vi.fn(async () => answer());
  await pass(runner, []); expect(runner).not.toHaveBeenCalled();
  expect(configureLeadFollow(store, who, session, thread, false, now)).toBe(true);
  await pass(runner); expect(runner).not.toHaveBeenCalled();
  expect(configureLeadFollow(store, who, session, thread, true, now)).toBe(true);
  store.endMateSession(session.id, who.name, now);
  await pass(runner); expect(runner).not.toHaveBeenCalled();
});

test('configuration rejects a foreign live session or thread hidden behind an owned snapshot', () => {
  const { who, session, thread } = start();
  store.saveApprover('other', 'b'.repeat(64), now);
  const foreignSession = store.mintMateSession({ approver:'other',approverGeneration:store.accountOf('other')!.generation,
    credentialKey:session.credentialKey,ceilingMicrousd:0,ceilingDigest:who.ceilingDigest,termsDigest:session.termsDigest },now);
  const foreignThread = store.openMateThread('other',who.ceilingDigest,now).thread;
  expect(configureLeadFollow(store,who,{...session,id:foreignSession},thread,true,now)).toBe(false);
  expect(configureLeadFollow(store,who,session,{...thread,id:foreignThread.id},true,now)).toBe(false);
});

test('credential rotation turns off the visible follow status and prevents background calls', async () => {
  start();task('choose-policy');const runner=vi.fn(async()=>answer());
  store.handle.prepare("UPDATE approver SET generation=generation+1 WHERE name='owner'").run();
  expect(leadFollowStatus(store,'owner').enabled).toBe(false);
  await pass(runner);expect(runner).not.toHaveBeenCalled();
});

test('a new scope decision before the first scan is delivered even when the task timestamp is old', async () => {
  task('existing-task');const updatedAt=store.getTask('existing-task')!.updatedAt;
  now=new Date(now.getTime()+1000);start();
  now=new Date(now.getTime()+1000);
  propose(store,{taskId:'existing-task',goal:'Choose a new scope.',acceptance:[],now});
  expect(store.getTask('existing-task')!.updatedAt).toBe(updatedAt);
  const runner=vi.fn(async()=>answer());await pass(runner);await pass(runner);
  expect(runner).toHaveBeenCalledTimes(1);
});

test('unchanged tasks that predate following establish a baseline without a provider call', async () => {
  task('old-task');now=new Date(now.getTime()+1000);start();
  const runner=vi.fn(async()=>answer());await pass(runner);await pass(runner);
  expect(runner).not.toHaveBeenCalled();
});

test('lead catch-up reads scoped DB work without mutation or a provider', () => {
  task('Visible task'); task('PRIVATE-TITLE', foreign);
  const before = store.handle.prepare('SELECT total_changes() AS n').get()?.n;
  const context = JSON.parse(leadContext(store, [repo], now));
  expect(context.source).toBe('local-database');
  expect(JSON.stringify(context)).toContain('Visible task');
  expect(JSON.stringify(context)).not.toContain('PRIVATE-TITLE');
  const html = leadBriefHtml(assignmentCatchUp(store, now, { principal: 'operator', repos: [repo] }));
  expect(html).toContain('Needs you'); expect(html).toContain('/chat?task=Visible%20task');
  expect(store.handle.prepare('SELECT total_changes() AS n').get()?.n).toBe(before);
});
