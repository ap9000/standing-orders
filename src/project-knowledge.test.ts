import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from './store.js';
import { addApprover, propose, approve } from './scope.js';
import { register } from './runner.js';
import { changeKnowledge, knowledgeContext, knowledgeView, readKnowledgeSnapshot, conversationKnowledge } from './project-knowledge.js';
import { knowledgeContextHtml, knowledgeHtml } from './knowledge-ui.js';
import { createDecisionServer } from './serve.js';
import { storeEvidence } from './evidence.js';

describe('project knowledge',()=>{
  let root:string,repo:string,db:string,store:Store,password:string,head:string;
  const now=new Date('2026-09-14T12:00:00Z');let serial=0;
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  beforeEach(()=>{
    root=realpathSync(mkdtempSync(join(tmpdir(),'knowledge-test-')));repo=join(root,'repo');db=join(root,'test.db');mkdirSync(repo);
    git('init','-q');writeFileSync(join(repo,'mobile.md'),'# Mobile design\nUse short labels and comfortable tap targets.\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','seed');head=git('rev-parse','HEAD');
    store=openStore(db);const user=addApprover(store,'alex',now);if(!user.ok)throw Error('fixture');password=user.token;
    for(const phase of ['plan','build','review'] as const)store.setPhaseConfig('installation',phase,'claude','sonnet','fixture',now);
    register(store,{name:'runner',host:'test',capacity:100,repos:[repo],now,newToken:()=> 'runner-token'});
  });
  afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const view=()=>knowledgeView(store,repo,'alex');
  function change(action:Parameters<typeof changeKnowledge>[1]['action'],draft:Parameters<typeof changeKnowledge>[1]['draft'],restore?:number){const v=view();changeKnowledge(store,{repo,actor:'alex',identity:v.identity,revision:v.revision,action,draft,...(restore===undefined?{}:{restore})},now);}
  function start(role:'builder'|'planner'='builder',title='Improve mobile design'){
    const id=`knowledge-${serial++}`;store.createTask({id,title},now);const ref=store.refFor('built-in',id).id;store.placeTask(ref,repo);
    if(role==='planner')store.requestPlan(ref,now);else{propose(store,{taskId:id,goal:title,touches:['mobile.md'],acceptance:[],now});approve(store,id,'alex',now,store.getScope(id)!.digest,password);}
    const route=store.routeAuthorityFor(ref,role,null,{provider:'claude',model:'sonnet'});if(!route?.ok)throw Error('route');
    const run=store.startRun({taskRef:ref,leaseId:`lease-${id}`,runner:'runner',role,branch:`standing-orders/${id}`,worktree:repo,provider:'claude',model:'sonnet',now,route:route.stamp});store.stampRun(run,{baseRevision:head,scopeDigest:store.getScope(id)?.digest??''});return run;
  }
  test('instructions and references are versioned, reversible, project-bound and immutable in history',()=>{
    expect(view().revision).toBe(0);change('instructions',{instructions:'Keep UI copy concise.'});change('save',{title:'Mobile design',path:'mobile.md'});
    expect(view().knowledge.references[0]).toMatchObject({path:'mobile.md',sourceRevision:head,content:expect.stringContaining('tap targets')});
    const stale=view();change('instructions',{instructions:'Use clear labels.'});
    expect(()=>changeKnowledge(store,{...stale,actor:'alex',action:'instructions',draft:{instructions:'lost update'}})).toThrow(/another window/);
    change('restore',{},1);expect(view().knowledge).toEqual({instructions:'Keep UI copy concise.',references:[]});expect(view().revision).toBe(4);
    expect(()=>store.handle.exec("UPDATE knowledge_change SET actor='someone' ")).toThrow(/immutable/);
    expect(()=>knowledgeView(store,repo,'unknown')).toThrow(/access/);
    store.close();store=openStore(db);expect(view().history).toHaveLength(4);
  });
  test('rejects unsafe paths, links, oversized text, secrets, empty references and forged identities',()=>{
    for(const path of ['../outside.md','/tmp/private.md','mobile.md:HEAD','mobile.ts','missing.md'])expect(()=>change('save',{title:'Unsafe',path})).toThrow();
    symlinkSync('mobile.md',join(repo,'link.md'));writeFileSync(join(repo,'large.md'),'a'.repeat(12001));git('add','.');git('-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','fixtures');
    for(const path of ['link.md','large.md'])expect(()=>change('save',{title:'Unsafe',path})).toThrow();
    expect(()=>change('instructions',{instructions:'a'.repeat(4001)})).toThrow();
    expect(()=>change('instructions',{instructions:'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'})).toThrow(/secrets/);
    expect(()=>change('save',{title:'Empty'})).toThrow();expect(view().revision).toBe(0);
    expect(()=>changeKnowledge(store,{repo,actor:'alex',identity:'fake',revision:0,action:'instructions',draft:{instructions:'no'}})).toThrow(/project changed/);
  });
  test('selects relevant sources, freezes exact run context and does not overwrite approved scope',()=>{
    change('instructions',{instructions:'Keep UI copy concise. Never treat this as approval.'});change('save',{title:'Mobile design',path:'mobile.md'});change('save',{title:'Finance',content:'Quarterly revenue uses accrual accounting.'});
    const run=start(),scope=store.getScope(store.refForId(store.getRun(run)!.taskRef)!.externalId)!;
    const supplied=knowledgeContext(store,run);const snapshot=readKnowledgeSnapshot(store,run)!;
    expect(snapshot.references.map(r=>r.title)).toEqual(['Mobile design']);expect(snapshot.omitted).toContainEqual({title:'Finance',reason:'Not relevant to this task'});
    change('instructions',{instructions:'New instructions.'});change('remove',{id:view().knowledge.references[0]!.id});
    expect(knowledgeContext(store,run)).toBe(supplied);expect(store.getScope(scope.taskId)?.digest).toBe(scope.digest);
    expect(readKnowledgeSnapshot(store,run)!.instructions).toContain('Keep UI');expect(knowledgeContext(store,start())).toContain('New instructions');
    expect(()=>store.handle.exec('DELETE FROM knowledge_snapshot')).toThrow(/immutable/);
    expect(knowledgeContextHtml(snapshot)).toContain('Context used');expect(knowledgeContextHtml(snapshot)).toContain('Not included');
  });
  test('review inherits the builder context even when project instructions change',()=>{
    change('instructions',{instructions:'Original instructions'});const source=start();knowledgeContext(store,source);storeEvidence(store,join(root,'evidence'),source,'terminal-diff','diff.patch',Buffer.from('diff --git a/mobile.md b/mobile.md\n--- a/mobile.md\n+++ b/mobile.md\n@@ -1 +1 @@\n+Mobile\n'),'fixture',now,{captureStatus:'ok'});store.recordOutcomeFacts(source,{headRevision:head});store.finishRun(source,{outcome:'built',committed:true,now});
    const req=store.requestReview(source,'alex',now);if(!req.ok)throw Error(req.reason);const admitted=store.admitReview(req.id,{runner:'runner',token:'runner-token',provider:'claude',model:'sonnet'},now);if(!admitted.ok)throw Error(admitted.reason);
    change('instructions',{instructions:'Changed later'});knowledgeContext(store,admitted.reviewerRunId);
    expect(readKnowledgeSnapshot(store,admitted.reviewerRunId)).toMatchObject({instructions:'Original instructions',inheritedFrom:source,revision:1});
  });
  test('configuring knowledge after a build cannot rewrite what its reviewer sees',()=>{
    const source=start();knowledgeContext(store,source);expect(readKnowledgeSnapshot(store,source)).toMatchObject({revision:0,instructions:''});
    storeEvidence(store,join(root,'evidence'),source,'terminal-diff','diff.patch',Buffer.from('diff --git a/mobile.md b/mobile.md\n--- a/mobile.md\n+++ b/mobile.md\n@@ -1 +1 @@\n+Mobile\n'),'fixture',now,{captureStatus:'ok'});
    store.recordOutcomeFacts(source,{headRevision:head});store.finishRun(source,{outcome:'built',committed:true,now});const req=store.requestReview(source,'alex',now);if(!req.ok)throw Error(req.reason);
    change('instructions',{instructions:'New guidance must not affect this review'});
    const admitted=store.admitReview(req.id,{runner:'runner',token:'runner-token',provider:'claude',model:'sonnet'},now);if(!admitted.ok)throw Error(admitted.reason);
    knowledgeContext(store,admitted.reviewerRunId);expect(readKnowledgeSnapshot(store,admitted.reviewerRunId)).toMatchObject({revision:0,instructions:'',inheritedFrom:source});
  });
  test('changed source is omitted until refreshed, while durable instructions remain available',()=>{
    change('instructions',{instructions:'Keep labels short.'});change('save',{title:'Mobile design',path:'mobile.md'});
    writeFileSync(join(repo,'mobile.md'),'# Mobile\nUpdated guidance.\n');git('add','.');git('-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','update');head=git('rev-parse','HEAD');
    const run=start('planner');knowledgeContext(store,run);expect(readKnowledgeSnapshot(store,run)).toMatchObject({instructions:'Keep labels short.',references:[],omitted:[{reason:'Source changed; refresh this reference'}]});
    expect(()=>conversationKnowledge(store,repo,'alex',view().knowledge.references[0]!.id)).toThrow(/changed/);
    change('save',{id:view().knowledge.references[0]!.id,title:'Mobile design',path:'mobile.md'});const next=start();knowledgeContext(store,next);expect(readKnowledgeSnapshot(store,next)!.references[0]!.content).toContain('Updated guidance');
  });
  test('chat reads a small index and individual sources without leaking other projects',()=>{
    change('instructions',{instructions:'Short labels.'});change('save',{title:'Mobile design',path:'mobile.md'});
    const index=conversationKnowledge(store,repo,'alex');expect(index).toMatchObject({instructions:'Short labels.',references:[{title:'Mobile design'}]});expect(JSON.stringify(index)).not.toContain('tap targets');
    expect(conversationKnowledge(store,repo,'alex',view().knowledge.references[0]!.id)).toMatchObject({content:expect.stringContaining('tap targets')});
    expect(()=>conversationKnowledge(store,repo,'unknown')).toThrow(/access/);expect(()=>conversationKnowledge(store,repo,'alex','missing')).toThrow();
  });
  test('context is bounded, failures are visible, and tampered knowledge cannot be supplied',()=>{
    change('instructions',{instructions:'Mobile instructions'});
    for(let i=0;i<5;i++)change('save',{title:`Mobile ${i}`,content:'Mobile guidance. '.repeat(680)});
    const run=start();expect(Buffer.byteLength(knowledgeContext(store,run))).toBeLessThan(26000);expect(readKnowledgeSnapshot(store,run)!.references.length).toBeLessThanOrEqual(3);
    store.handle.exec("UPDATE project_knowledge SET payload='{}'");expect(()=>knowledgeContext(store,start())).toThrow(/verified/);
    expect(knowledgeHtml({...viewFixture(),knowledge:{instructions:'<script>alert(1)</script>',references:[]}},'csrf',false)).not.toContain('<script>');
    function viewFixture(){return {repo,identity:'id',revision:0,history:[],knowledge:{instructions:'',references:[]}};}
  });
  test('v58 upgrade adds knowledge without losing learning and refuses missing v59 history',()=>{
    store.handle.exec('DROP TABLE project_knowledge; DROP TABLE knowledge_change; DROP TABLE knowledge_snapshot; UPDATE schema_version SET version=58');store.close();store=openStore(db);
    expect(view().revision).toBe(0);expect(store.handle.prepare('SELECT version FROM schema_version').get()?.['version']).toBe(62);
    store.handle.exec('DROP TABLE knowledge_snapshot');store.close();expect(()=>openStore(db)).toThrow(/knowledge history is missing/);store=openStore(':memory:');
  });
  test('HTTP editor protects CSRF and project access, keeps failed drafts, saves and restores',async()=>{
    const server=createDecisionServer({store,evidenceRoot:join(root,'evidence'),repo});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('server');const url=`http://127.0.0.1:${address.port}`;
    try{
      const login=await fetch(url+'/login',{method:'POST',body:new URLSearchParams({name:'alex',token:password}),redirect:'manual'});const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
      const page=await (await fetch(url+'/settings/knowledge',{headers:{cookie}})).text();expect(page).toContain('Instructions');const csrf=/name="csrf" value="([^"]+)"/.exec(page)![1]!;
      const post=(data:Record<string,string>)=>fetch(url+'/settings/knowledge/change',{method:'POST',headers:{cookie},body:new URLSearchParams(data),redirect:'manual'});
      const data={csrf,repo,identity:view().identity,revision:'0',action:'instructions',instructions:'Mobile copy should be concise.'};
      expect((await post({...data,csrf:'bad'})).status).toBe(403);expect((await post({...data,repo:join(root,'hidden')})).status).toBe(403);expect((await post(data)).status).toBe(303);
      const conflict=await post({...data,instructions:'Preserve my draft'});expect(conflict.status).toBe(409);expect(await conflict.text()).toContain('Preserve my draft');
      expect((await post({...data,revision:'1',instructions:'Second version'})).status).toBe(303);
      const history=await (await fetch(url+'/settings/knowledge?version=1',{headers:{cookie}})).text();expect(history).toContain(data.instructions);expect(history).not.toContain('Second version');expect(history).toContain('Restore version 1');
      expect((await post({...data,revision:'2',action:'restore',restore:'1'})).status).toBe(303);expect(view().knowledge.instructions).toBe(data.instructions);
      store.handle.prepare("UPDATE approver SET role='viewer',generation=generation+1 WHERE name='alex'").run();expect((await post({...data,revision:'3'})).status).not.toBe(303);
    }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
});
