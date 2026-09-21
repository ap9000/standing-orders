import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, openStoreNoMigrate, type Store } from './store.js';
import { assignmentOf } from './assignment.js';
import { workIndexPage, workCountsByProject } from './work-index.js';

const NOW = new Date('2026-09-20T10:00:00.000Z'), STAMP = NOW.toISOString(), REPO = '/repos/index';
const access = { principal: 'operator' as const, repos: [REPO] };
const DIGEST = 'a'.repeat(64);
let store: Store;
function task(id: string, repo: string | null = REPO, state = 'queued', at = STAMP) {
  store.createTask({ id, title: `Task ${id}` }, new Date(at));
  const ref = store.lookupRef(id)!.id;
  if (repo !== null) store.placeTask(ref, repo);
  store.handle.prepare('UPDATE task SET state=?,updated_at=? WHERE id=?').run(state, at, id);
  return ref;
}
function scope(id: string) {
  store.handle.prepare(`INSERT INTO task_scope(task_id,goal,proposed_at,digest,approved_at,approved_by,approved_digest)
    VALUES(?,?,?,?,?,?,?)`).run(id, 'Finish this task', STAMP, DIGEST, STAMP, 'operator', DIGEST);
}
function run(id: string, outcome: string | null = 'built', at = STAMP) {
  const ref = store.lookupRef(id)!.id;
  return Number(store.handle.prepare(`INSERT INTO run(task_ref,lease_id,runner,branch,worktree,started_at,finished_at,outcome,scope_digest,head_revision)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(ref, `lease-${id}`, 'runner', `so/${id}`, `/missing/index/${id}`, at, outcome === null ? null : at, outcome, DIGEST, 'b'.repeat(40)).lastInsertRowid);
}
function built(id: string) { task(id, REPO, 'done'); scope(id); return run(id); }
function claim(id: string, until = new Date(NOW.getTime() + 30_000).toISOString()) {
  store.handle.prepare(`INSERT INTO claim(lease_id,task_ref,lease_generation,runner,acquired_at,expires_at,heartbeat_at)
    VALUES(?,?,1,'runner',?,?,?)`).run(`lease-${id}`, store.lookupRef(id)!.id, STAMP, until, STAMP);
}
function checked(id: string, result: number, actor = 'operator:operator', at = STAMP) {
  const native = assignmentOf(store, id, NOW, access)!;
  expect(native.state).toBe('ready-to-check');
  store.recordAction({ at, actor, repo: REPO, taskId: native.rootId, runId: result,
    action: 'assignment handoff checked', outcome: native.receipt!.digest, source: 'work' });
}
function revision(parent: string, child: string, result: number) {
  task(child, REPO, 'done', new Date(NOW.getTime()+1).toISOString()); scope(child);
  const artifact = Number(store.handle.prepare(`INSERT INTO artifact(run,kind,key,bytes_original,bytes_stored,truncated,sha256,capture,created_at)
    VALUES(?,'revision-brief','brief',0,0,0,?,'test',?)`).run(result, 'c'.repeat(64), STAMP).lastInsertRowid);
  store.handle.prepare('UPDATE task_ref SET revision_of=?,revision_brief_artifact=? WHERE external_id=?').run(parent, artifact, child);
  return run(child);
}
beforeEach(() => {
  store = openStore(':memory:');
  store.handle.prepare(`INSERT INTO approver(name,credential_hash,added_at) VALUES('operator','unused',?)`).run(STAMP);
});
afterEach(() => { vi.restoreAllMocks(); store.close(); });

describe('indexed work families', () => {
  test('admits before family grouping, counts and keyset pages; foreign rows never consume the limit', () => {
    for (let i=0;i<8;i++) task(`allowed-${i}`);
    for (let i=0;i<20;i++) task(`foreign-${i}`, '/private');
    task('unplaced', null);
    const seen: string[]=[];
    let cursor: string|null=null;
    do {
      const page = workIndexPage(store, NOW, access, { limit: 3, cursor });
      expect(page.totals).toEqual({ all: 8, 'needs-you': 8, running: 0, completed: 0 });
      seen.push(...page.items.map(i=>i.rootId)); cursor=page.nextCursor;
    } while(cursor);
    expect(new Set(seen).size).toBe(8);
    const page = workIndexPage(store, NOW, access, { limit: 1 });
    expect(() => workIndexPage(store,NOW,{principal:'coordinator',repos:['/private']},{cursor:page.nextCursor})).toThrow(/cursor/);
    expect(workIndexPage(store,NOW,access,{project:'/private'}).totals.all).toBe(0);
    expect(workIndexPage(store,NOW,{principal:'coordinator',repos:[]}).items).toEqual([]);
    expect(workIndexPage(store,NOW,{principal:'operator',repos:[],includeUnplaced:true}).items.map(i=>i.rootId)).toEqual(['unplaced']);
  });
  test('Ready is distinct from historical completion; signer access changes do not reopen accepted work', () => {
    const result=built('done');
    expect(workIndexPage(store,NOW,access).items[0]).toMatchObject({assignmentState:'ready-to-check',resultRunId:result,status:{label:'Ready'}});
    checked('done',result);
    expect(workIndexPage(store,NOW,access).items[0]).toMatchObject({assignmentState:'complete',completion:{actor:'operator:operator'}});
    expect(assignmentOf(store,'done',NOW,access)!.state).toBe('complete');
    store.handle.prepare("UPDATE approver SET projects_json='[\"/private\"]' WHERE name='operator'").run();
    expect(workIndexPage(store,NOW,access).totals.completed).toBe(1);
    store.handle.prepare("UPDATE approver SET projects_json=NULL,revoked_at=? WHERE name='operator'").run(STAMP);
    expect(workIndexPage(store,NOW,access).totals.completed).toBe(1);
  });
  test('new exact results, changed scope approval and changed proof invalidate an older recorded completion', () => {
    const result=built('done');checked('done',result);
    store.saveProofVerdict(result,'short',['New missing check'],new Date(NOW.getTime()+1));
    expect(workIndexPage(store,NOW,access).totals.completed).toBe(0);
    store.handle.prepare('UPDATE task_scope SET approved_digest=? WHERE task_id=?').run('d'.repeat(64),'done');
    expect(workIndexPage(store,NOW,access).items[0]!.assignmentState).toBe('needs-decision');
    store.handle.prepare('UPDATE task_scope SET approved_digest=digest WHERE task_id=?').run('done');
    const newer=run('done');
    expect(workIndexPage(store,NOW,access).items[0]).toMatchObject({resultRunId:newer,assignmentState:'ready-to-check'});
  });
  test('groups validated revision edges and retains earlier live work and exact question targets', () => {
    const old=built('root');const current=revision('root','revision',old);
    claim('root');
    let page=workIndexPage(store,NOW,access);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({rootId:'root',activeTaskId:'revision',versionCount:2,earlierActiveCount:1,resultRunId:current,assignmentState:'needs-decision',primaryAction:{target:{taskId:'root'}}});
    expect(page.totals.running).toBe(1);
    store.handle.prepare('UPDATE claim SET released_at=?').run(STAMP);
    const q=store.saveDecision({run:old,urgency:'blocking',recap:'Question',question:'Use this approach?',options:[{id:'yes',label:'Yes',consequence:'Continue',reversible:true}],recommendation:'yes',deadline:new Date(NOW.getTime()-1).toISOString()},NOW);
    page=workIndexPage(store,NOW,access);
    expect(page.items[0]!.primaryAction).toMatchObject({code:'answer-decision',target:{taskId:'root',runId:old,decisionId:q}});
    expect(page.items[0]!.assignmentState).toBe('needs-decision');
  });
  test('borrowed and cross-project revision briefs stay separate and do not reveal foreign history', () => {
    const root=built('root');revision('root','revision',root);
    store.handle.prepare("UPDATE task_ref SET repo='/private' WHERE external_id='root'").run();
    const item=workIndexPage(store,NOW,access).items[0]!;
    expect(item).toMatchObject({rootId:'revision',activeTaskId:'revision',versionCount:1,assignmentState:'needs-decision'});
    expect(item.familyProblem).not.toBeNull();
    expect(JSON.stringify(item)).not.toContain('/private');
  });
  test('clock expiry moves live work to attention without a source mutation; holds retain native semantics', () => {
    task('live',REPO,'running');run('live',null);claim('live');
    expect(workIndexPage(store,NOW,access).items[0]!.status.views).toContain('running');
    const expired=workIndexPage(store,new Date(NOW.getTime()+30_000),access);
    expect(expired.items[0]).toMatchObject({assignmentState:'needs-decision',primaryAction:{code:'reconcile-run'}});
    expect(expired.totals.running).toBe(0);
    const ref=task('backoff');
    store.handle.prepare(`INSERT INTO hold(task_ref,owner_kind,owner_id,reason,held_at,until) VALUES(?,'backoff','b','Wait',?,?)`).run(ref,STAMP,new Date(NOW.getTime()+10_000).toISOString());
    const row=workIndexPage(store,NOW,access).items.find(i=>i.rootId==='backoff')!;
    expect(row).toMatchObject({assignmentState:'working',status:{label:'Retry scheduled'}});
    expect(row.status.views).not.toContain('needs-you');
    expect(workIndexPage(store,new Date(NOW.getTime()+10_000),access).items.find(i=>i.rootId==='backoff')!.status.views).toContain('needs-you');
  });
  test('a hidden prerequisite can block work without disclosing its identifier', () => {
    task('visible');task('private-prerequisite','/private','cancelled');
    store.handle.prepare('INSERT INTO task_edge(blocked,blocker) VALUES(?,?)').run('visible','private-prerequisite');
    const page=workIndexPage(store,NOW,access);
    expect(page.totals['needs-you']).toBe(1);
    expect(page.items[0]!.primaryAction?.code).toBe('repair-dependency');
    expect(JSON.stringify(page)).not.toContain('private-prerequisite');
    expect(page.items[0]!.status.detail).toBe('A required task did not finish.');
  });
  test('state filtering follows newest valid version and project totals count families once', () => {
    const result=built('old');revision('old','new',result);
    task('queued');task('cancelled',REPO,'cancelled');task('failed',REPO,'failed');
    expect(workIndexPage(store,NOW,access,{state:'done'}).totals.all).toBe(1);
    expect(workIndexPage(store,NOW,access,{state:'cancelled'}).items[0]!.assignmentState).toBe('cancelled');
    expect(workCountsByProject(store,NOW,access)).toEqual([{repo:REPO,totals:{all:4,'needs-you':3,running:0,completed:0},queued:1,doneRecently:1}]);
  });
  test('only the maximum claim generation is live, even when the newest row is released', () => {
    task('superseded',REPO,'running');run('superseded',null);claim('superseded');
    store.handle.prepare(`INSERT INTO claim(lease_id,task_ref,lease_generation,runner,acquired_at,expires_at,heartbeat_at,released_at)
      VALUES('newer',?,2,'runner',?,?,?,?)`).run(store.lookupRef('superseded')!.id,STAMP,new Date(NOW.getTime()+30_000).toISOString(),STAMP,STAMP);
    const page=workIndexPage(store,NOW,access);
    expect(page.totals.running).toBe(0);
    expect(page.items[0]).toMatchObject({liveRunId:null,assignmentState:'needs-decision',primaryAction:{code:'reconcile-run'}});
  });
  test('corrupt stored scope terms use the same validator as detail and never display Ready', () => {
    built('malformed');
    for(const rubric of ['[null]','[{"id":"x","statement":"Check","evidence":["invented"]}]','[{"id":"x","statement":"Check","evidence":["check"],"extra":true}]']) {
      store.handle.prepare('UPDATE task_scope SET acceptance_json=? WHERE task_id=?').run(rubric,'malformed');
      expect(store.getScope('malformed')!.termsProblem).not.toBeNull();
      expect(workIndexPage(store,NOW,access).items[0]!.assignmentState).toBe('needs-decision');
    }
  });
  test('known PID without a recorded exit requires inspection and cannot imply Running or Complete', () => {
    const result=built('custody');checked('custody',result);
    const process=Number(store.handle.prepare(`INSERT INTO run_process(run,pid,host,process_group,observed_at) VALUES(?,123456,'other-host',0,?)`).run(result,STAMP).lastInsertRowid);
    const page=workIndexPage(store,NOW,access);
    expect(page.totals).toMatchObject({running:0,completed:0,'needs-you':1});
    expect(page.items[0]!.status.detail).toContain('process exit is not recorded');
    store.handle.prepare('UPDATE run_process SET exited_at=? WHERE id=?').run(STAMP,process);
    expect(workIndexPage(store,NOW,access).items[0]!.assignmentState).toBe('complete');
  });
  test('recorded completion survives coordinator handoff and revocation, retaining original provenance', () => {
    const result=built('owned');
    for(const id of ['first','second']) store.handle.prepare(`INSERT INTO coordinator_credential(cid,name,credential_hash,repos,per_hour,created_by,created_at)
      VALUES(?,?,?, ?,10,'operator',?)`).run(id,id,'unused',JSON.stringify([REPO]),STAMP);
    const own=(id:string)=>store.recordAction({at:STAMP,actor:`coordinator:${id}`,repo:REPO,taskId:'owned',runId:null,action:'assignment claimed',outcome:'owner',source:'work'});
    own('first');checked('owned',result,'coordinator:first');
    expect(workIndexPage(store,NOW,access).totals.completed).toBe(1);
    own('second');expect(workIndexPage(store,NOW,access).totals.completed).toBe(1);
    expect(workIndexPage(store,NOW,access).items[0]?.completion?.actor).toBe('coordinator:first');
    expect(workIndexPage(store,NOW,access).totals.completed).toBe(1);
    store.handle.prepare("UPDATE coordinator_credential SET repos='{}',revoked_at=? WHERE cid IN ('first','second')").run(STAMP);
    expect(workIndexPage(store,NOW,access).totals.completed).toBe(1);
    expect(assignmentOf(store,'owned',NOW,access)?.state).toBe('complete');
    expect(workIndexPage(store,NOW,{principal:'coordinator',repos:[]}).totals.completed).toBe(0);
  });
  test('same-schema non-migrating readers work without optional indexes and do not create them', () => {
    const directory=mkdtempSync(join(tmpdir(),'so-work-index-legacy-')),file=join(directory,'orders.db');
    const writer=openStore(file);
    const missing=['work_open_decision','work_spawned_run','work_unsettled_custody','work_result'];
    let reader: Store | undefined;
    try {
      writer.createTask({id:'retained',title:'Retained task'},NOW);
      writer.placeTask(writer.lookupRef('retained')!.id,REPO);
      const expected=workIndexPage(writer,NOW,access);
      for(const index of missing) writer.handle.exec(`DROP INDEX ${index}`);
      const opened=openStoreNoMigrate(file);
      if(!opened.ok) throw Error(opened.message);
      reader=opened.store;
      const before=reader.handle.prepare('SELECT total_changes() AS count').get();
      expect(workIndexPage(reader,NOW,access)).toEqual(expected);
      expect(workCountsByProject(reader,NOW,access)).toEqual(expected.projects);
      expect(reader.handle.prepare('SELECT total_changes() AS count').get()).toEqual(before);
      expect(reader.handle.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN (?,?,?,?)").all(...missing)).toEqual([]);
    } finally {reader?.close();writer.close();rmSync(directory,{recursive:true,force:true});}
  });
  test('list reads no task details, artifacts or processes and caches connection setup before bounded page reads', () => {
    for(let i=0;i<60;i++) built(`result-${i}`);
    for (const method of ['getTask','getScope','getRun','runsFor','artifactsFor','stopQuiescenceProblem','taskFamilyOf'] as const)
      vi.spyOn(store,method).mockImplementation(()=>{throw Error(`forbidden list read: ${method}`);});
    const prepare=vi.spyOn(store.handle,'prepare');
    const page=workIndexPage(store,NOW,access,{limit:5});
    expect(page.items).toHaveLength(5);expect(page.totals.all).toBe(60);expect(prepare).toHaveBeenCalledTimes(2);
    prepare.mockClear();
    expect(workIndexPage(store,NOW,access,{limit:5})).toEqual(page);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(page.nextCursor).not.toBeNull();
  });
});
