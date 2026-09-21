import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, openStoreNoMigrate, SCHEMA_VERSION, TEAM_TABLES, type Store } from './store.js';
import { TeamLeads } from './team-leads.js';
import type { TeamActor, TeamOperation, TeamResponse } from './team-contract.js';

const NOW=new Date('2026-09-21T18:00:00Z'),A='/repos/team-a',B='/repos/team-b';
describe('central team identity, scope and durable conversation admission',()=>{
  let dir:string,store:Store,team:TeamLeads;
  const alex:TeamActor={name:'alex',generation:1},sam:TeamActor={name:'sam',generation:1},viewer:TeamActor={name:'viewer',generation:1};
  beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'team-leads-'));store=openStore(join(dir,'orders.db'));for(const name of ['alex','sam','viewer'])store.saveApprover(name,`hash-${name}`,NOW);store.handle.prepare("UPDATE approver SET role='viewer' WHERE name='viewer'").run();team=new TeamLeads(store,()=>[A,B]);});
  afterEach(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  function call(operation:TeamOperation,args:Record<string,unknown>,actor=alex){return team.execute(actor,{operation,args},NOW);}
  function value<T>(r:TeamResponse):T{expect(r.ok,r.message).toBe(true);return r.result as T;}
  function lead(name='Team lead',projects=[A]){return value<{leadId:string}>(call('create-lead',{name,projects})).leadId;}
  function room(leadId:string,visibility='team',actor=alex){return value<{conversationId:string}>(call('create-conversation',{leadId,title:'Website',visibility,projects:[A]},actor)).conversationId;}
  function leadMember(leadId:string,account:string,memberRole='contributor',active=true){const revision=Number(store.handle.prepare('SELECT revision FROM team_lead WHERE id=?').get(leadId)?.['revision']);return call('member',{leadId,account,role:memberRole,active,expectedRevision:revision});}
  function participant(conversationId:string,account:string,memberRole='contributor',active=true){const revision=Number(store.handle.prepare('SELECT revision FROM team_conversation WHERE id=?').get(conversationId)?.['revision']);return call('member',{conversationId,account,role:memberRole,active,expectedRevision:revision});}
  function shared(){const l=lead(),c=room(l);value(leadMember(l,'sam'));value(participant(c,'sam'));return {l,c};}
  function send(conversationId:string,text:string,actor=alex,requestId=`request-${text}`){return value<{messageId:number}>(call('send',{conversationId,text,requestId},actor)).messageId;}

  test('two authors share history, serial admission and stable receipts across a reconnect',()=>{
    const {c}=shared(),first=send(c,'Build the settings page'),second=send(c,'Also include keyboard access',sam);
    const opened=openStoreNoMigrate(join(dir,'orders.db'));if(!opened.ok)throw new Error(opened.message);const runner2=new TeamLeads(opened.store,()=>[A,B]);
    try{
      const claim=team.claimNext('worker-a',NOW)!;expect(claim.messageId).toBe(first);expect(runner2.claimNext('worker-b',NOW)).toBeNull();
      expect(team.snapshot(sam,c).messages.map(m=>[m.author,m.status])).toEqual([['alex','running'],['sam','queued']]);
      expect(team.finish(claim,{status:'answered',text:'I saved the settings-page plan.'},NOW)).toBe(true);
      expect(team.finish(claim,{status:'answered',text:'Duplicate'},NOW)).toBe(false);
      expect(runner2.claimNext('worker-b',NOW)?.messageId).toBe(second);
      expect(send(c,'Build the settings page')).toBe(first);
      expect(call('send',{conversationId:c,text:'Changed payload',requestId:'request-Build the settings page'}).code).toBe('request-conflict');
      expect(team.snapshot(sam,c).messages.filter(m=>m.role==='assistant')).toHaveLength(1);
    }finally{runner2.store.close();}
  });
  test('queued edits win before admission; stale edits and withdrawals cannot change running work',()=>{
    const {c}=shared(),id=send(c,'Use the old title');
    expect(call('edit',{conversationId:c,messageId:id,expectedRevision:1,text:'Use a clear title'}).ok).toBe(true);
    expect(call('edit',{conversationId:c,messageId:id,expectedRevision:1,text:'Stale'}).code).toBe('conflict');
    const claim=team.claimNext('worker',NOW)!;expect(claim.text).toBe('Use a clear title');expect(claim.messageRevision).toBe(2);
    expect(call('withdraw',{conversationId:c,messageId:id,expectedRevision:2}).code).toBe('conflict');
    const second=send(c,'Withdraw me');expect(call('withdraw',{conversationId:c,messageId:second,expectedRevision:1}).ok).toBe(true);
    team.finish(claim,{status:'answered'},NOW);expect(team.claimNext('worker',NOW)).toBeNull();
  });
  test('adding a person grants lead and room membership atomically with both revision fences',()=>{
    const l=lead(),c=room(l);
    expect(call('member',{conversationId:c,account:'sam',role:'contributor',active:true,expectedRevision:1,joinLead:true,expectedLeadRevision:99}).code).toBe('conflict');
    expect(store.handle.prepare('SELECT 1 FROM team_lead_member WHERE lead=? AND account=?').get(l,'sam')).toBeUndefined();
    value(call('member',{conversationId:c,account:'sam',role:'contributor',active:true,expectedRevision:1,joinLead:true,expectedLeadRevision:1}));
    expect(team.snapshot(sam,c).canSend).toBe(true);
    value(leadMember(l,'sam','manager'));
    value(call('member',{conversationId:c,account:'sam',role:'viewer',active:true,expectedRevision:2,joinLead:true,expectedLeadRevision:3}));
    expect(store.handle.prepare('SELECT role FROM team_lead_member WHERE lead=? AND account=?').get(l,'sam')?.['role']).toBe('manager');
    expect(team.snapshot(sam,c).canSend).toBe(false);
  });
  test('claims cannot be reused across thread, requester or lead identities',()=>{
    const {c}=shared();send(c,'Saved instruction');const claim=team.claimNext('worker',NOW)!;
    expect(team.current({...claim,actor:sam})).toBe(false);expect(team.current({...claim,threadId:claim.threadId+1})).toBe(false);
    expect(team.finish({...claim,leadId:'another-lead'},{status:'answered',text:'Wrong room'},NOW)).toBe(false);
    expect(team.current(claim)).toBe(true);
  });
  test('a removed account can be removed from membership without deleting its messages',()=>{
    const {c}=shared();send(c,'My saved request',sam);
    store.handle.prepare("UPDATE approver SET revoked_at=? WHERE name='sam'").run(NOW.toISOString());
    expect(participant(c,'sam','contributor',false).ok).toBe(true);
    expect(team.snapshot(alex,c).messages[0]?.author).toBe('sam');
  });
  test('an audience must match the entire immutable project history; private messages are never shared',()=>{
    const l=lead('Engineering',[A,B]);value(leadMember(l,'sam'));
    const c=room(l,'private');send(c,'Private planning context');
    expect(team.snapshot(sam).conversations).toEqual([]);expect(call('show',{conversationId:c},sam).ok).toBe(false);
    expect(participant(c,'sam').code).toBe('private');
    expect(call('update-lead',{leadId:l,expectedRevision:2,projects:[A]}).code).toBe('fixed-scope');
    const sharedRoom=value<{conversationId:string}>(call('create-conversation',{leadId:l,title:'Both projects',visibility:'team',projects:[A,B]})).conversationId;
    store.handle.prepare('UPDATE approver SET projects_json=? WHERE name=?').run(JSON.stringify([A]),'sam');
    expect(participant(sharedRoom,'sam').ok).toBe(false);expect(team.snapshot(sam).messages).toEqual([]);
    expect(team.snapshot(alex,sharedRoom).messages).toEqual([]);
  });
  test('account viewers can read but membership cannot grant execution or sending authority',()=>{
    const {l,c}=shared();value(leadMember(l,'viewer','viewer'));value(participant(c,'viewer','viewer'));send(c,'Visible to the team');
    expect(team.snapshot(viewer,c).messages[0]?.text).toBe('Visible to the team');expect(team.snapshot(viewer,c).canSend).toBe(false);
    expect(call('send',{conversationId:c,text:'Approve this',requestId:'viewer-send'},viewer).ok).toBe(false);
    expect(participant(c,'viewer','contributor').code).toBe('read-only');
  });
  test('membership revoke and re-add never resurrect a queued request or old follow grant',()=>{
    const {c}=shared();send(c,'Queued under my old membership',sam);
    const thread=team.snapshot(sam,c).selected!.threadId;
    const session=store.mintTeamMateSession({approver:'sam',approverGeneration:1,thread,credentialKey:'key',ceilingMicrousd:1000,ceilingDigest:'cap',termsDigest:'signed'},NOW);
    expect(call('follow',{conversationId:c,enabled:true},sam).ok).toBe(true);expect(team.followGrants()).toHaveLength(1);
    value(participant(c,'sam','contributor',false));expect(team.cursor(sam,c)).toBeNull();expect(team.followGrants()).toHaveLength(0);
    value(participant(c,'sam'));expect(team.followGrants()).toHaveLength(0);expect(store.getMateSession(session)?.endedBy).toBe('membership-changed');expect(store.teamMateSession('sam',thread)).toBeNull();expect(team.claimNext('worker',NOW)).toBeNull();
    expect(team.snapshot(sam,c).messages[0]).toMatchObject({status:'cancelled',error:'Access changed before this message started.'});
  });
  test('revoked generation fences active work but shared history and current colleagues survive rotation',()=>{
    const {c}=shared();send(c,'Keep this history',sam);const claim=team.claimNext('worker',NOW)!;
    store.saveApprover('sam','replacement-hash',NOW);
    expect(team.current(claim)).toBe(false);expect(team.cursor(sam,c)).toBeNull();expect(team.finish(claim,{status:'answered',text:'Late old-generation reply'},NOW)).toBe(true);
    expect(team.snapshot(alex,c).messages).toHaveLength(1);expect(team.snapshot(alex,c).messages[0]?.status).toBe('cancelled');
    expect(team.snapshot({name:'sam',generation:2},c).messages[0]?.text).toBe('Keep this history');
    expect(store.getMateThread(team.snapshot(alex,c).selected!.threadId)?.closedAt).toBeNull();
  });
  test('revocation cannot hide an unconfirmed provider outcome or admit the next writer',()=>{
    const {c}=shared();send(c,'Pending provider outcome',sam);send(c,'Next request');
    const claim=team.claimNext('worker',NOW)!;value(participant(c,'sam','contributor',false));
    expect(team.finish(claim,{status:'uncertain',error:'Provider outcome unconfirmed.'},NOW)).toBe(true);
    expect(team.snapshot(alex,c).messages[0]?.status).toBe('uncertain');expect(team.claimNext('other-worker',NOW)).toBeNull();
  });
  test('dead workers are uncertain, never automatically resubmitted; recovery fences late results',()=>{
    const {c}=shared();send(c,'First request');send(c,'Second request');const claim=team.claimNext('old-worker',NOW)!;
    expect(team.activeRunners()).toEqual(['old-worker']);expect(team.recover('another-worker',NOW)).toBe(0);
    expect(team.claimNext('new-worker',new Date('2099-01-01'))).toBeNull();expect(team.recover('old-worker',NOW)).toBe(1);
    expect(team.current(claim)).toBe(false);expect(team.finish(claim,{status:'answered'},NOW)).toBe(false);expect(team.claimNext('new-worker',NOW)).toBeNull();
    expect(call('stop',{conversationId:c,messageId:claim.messageId}).ok).toBe(true);expect(team.claimNext('new-worker',NOW)?.text).toBe('Second request');
  });
  test.each([['answered','recover'],['failed','recover'],['answered','reconcile'],['failed','reconcile']] as const)('a saved %s receipt is handled by %s without repeating a turn',(status,method)=>{
    const {c}=shared(),id=send(c,'One exact turn'),claim=team.claimNext('old-worker',NOW)!,thread=claim.threadId;
    const session=store.mintTeamMateSession({approver:'alex',approverGeneration:1,credentialKey:'provider',ceilingMicrousd:1000000,ceilingDigest:'cap',termsDigest:'signed',thread},NOW);
    const admitted=store.openMateTurn({approver:'alex',session,thread,credentialKey:'provider',reservedMicrousd:100,dailyTurns:10,weeklyCeilingMicrousd:1000000,deadlineMs:60000},NOW);if(!admitted.ok)throw Error('admission');
    expect(team.bindTurn(claim,admitted.id)).toBe(true);const started=store.startMateTurn(admitted.id,NOW);if(!started.ok)throw Error('start');
    store.finalizeMateTurn(admitted.id,started.generation,{state:status,settledMicrousd:10,tokensIn:1,tokensOut:1,...(status==='answered'?{message:{text:'The saved reply',activity:'[]'}}:{failureReason:'provider-error'})},NOW);
    expect(method==='recover'?team.recover('old-worker',NOW):team.reconcileFinished(NOW)).toBe(1);expect(team.snapshot(alex,c).messages.find(m=>m.id===id)?.status).toBe(status);
    expect(team.claimNext('new-worker',NOW)).toBeNull();expect(store.handle.prepare('SELECT COUNT(*) AS n FROM mate_turn').get()?.['n']).toBe(1);
    expect(team.finish(claim,{status:'answered',text:'Duplicate reply'},NOW)).toBe(false);
    expect(team.snapshot(alex,c).messages.filter(m=>m.role==='assistant')).toHaveLength(status==='answered'?1:0);
  });
  test('a failed provider receipt with unknown spend stays uncertain after worker recovery',()=>{
    const {c}=shared();send(c,'One uncertain turn');const claim=team.claimNext('old-worker',NOW)!;
    const session=store.mintTeamMateSession({approver:'alex',approverGeneration:1,credentialKey:'provider',ceilingMicrousd:1000,ceilingDigest:'cap',termsDigest:'signed',thread:claim.threadId},NOW);
    const turn=store.openMateTurn({approver:'alex',session,thread:claim.threadId,credentialKey:'provider',reservedMicrousd:100,dailyTurns:10,weeklyCeilingMicrousd:1000,deadlineMs:60000},NOW);if(!turn.ok)throw Error('turn');
    team.bindTurn(claim,turn.id);const started=store.startMateTurn(turn.id,NOW);if(!started.ok)throw Error('start');
    const step=store.openMateStep({mateTurn:turn.id,generation:started.generation,approver:'alex',credentialKey:'provider',provider:'codex-subscription',model:'fixture',deadlineMs:60000},NOW);if(!step.ok)throw Error('step');
    store.finalizeMateTurn(turn.id,started.generation,{state:'failed',settledMicrousd:100,unknownSpend:true,tokensIn:0,tokensOut:0,failureReason:'timeout'},NOW);
    expect(team.deliveryUncertain(turn.id)).toBe(true);expect(team.reconcileFinished(NOW)).toBe(0);expect(team.current(claim)).toBe(true);
    store.handle.prepare("UPDATE chat_turn SET state='failed',unknown_spend=1 WHERE id=?").run(step.id);
    expect(team.reconcileFinished(NOW)).toBe(1);expect(team.snapshot(alex,c).messages[0]?.status).toBe('uncertain');expect(team.claimNext('new-worker',NOW)).toBeNull();
  });
  test('separate leads and conversations owned by one person admit independent writers',()=>{
    const l1=lead('Engineering'),l2=lead('Product'),c1=room(l1),c2=room(l2);send(c1,'Engineering request');send(c2,'Product request');
    const first=team.claimNext('worker1',NOW)!,second=team.claimNext('worker2',NOW)!;
    expect(first.conversationId).not.toBe(second.conversationId);expect(team.current(first)).toBe(true);expect(team.current(second)).toBe(true);
  });
  test('two turns per lead bound parallelism while human requests precede fresh automatic updates',()=>{
    const l=lead(),automatic=room(l),human=room(l),third=room(l);
    send(automatic,'Summarize saved task status',alex,'team-update:fixture:1');send(human,'A person needs an answer');send(third,'Another person needs an answer');
    const first=team.claimNext('worker1',NOW)!,second=team.claimNext('worker2',NOW)!;
    expect(first.conversationId).toBe(human);expect(second.conversationId).toBe(third);expect(team.claimNext('worker3',NOW)).toBeNull();
    team.finish(first,{status:'answered'},NOW);team.finish(second,{status:'answered'},NOW);
    const fresh=room(l);send(fresh,'A later request');const aged=team.claimNext('worker3',new Date(NOW.getTime()+61_000));
    expect(aged?.conversationId).toBe(automatic);
  });
  test('capacity waiting leaves the same request queued and cannot requeue an admitted turn',()=>{
    const {c}=shared(),id=send(c,'Keep my saved request');
    expect(team.claimNext('worker',NOW,()=>false)).toBeNull();expect(team.snapshot(alex,c).messages[0]?.status).toBe('queued');
    const first=team.claimNext('worker',NOW)!;expect(team.defer(first,'The daily allowance is used.',NOW)).toBe(true);
    expect(team.current(first)).toBe(false);expect(team.snapshot(alex,c).messages[0]).toMatchObject({id,status:'queued',error:'The daily allowance is used.'});
    const next=team.claimNext('worker',NOW)!;
    const session=store.mintTeamMateSession({approver:'alex',approverGeneration:1,credentialKey:'provider',ceilingMicrousd:1000,ceilingDigest:'cap',termsDigest:'signed',thread:next.threadId},NOW);
    const turn=store.openMateTurn({approver:'alex',session,thread:next.threadId,credentialKey:'provider',reservedMicrousd:100,dailyTurns:10,weeklyCeilingMicrousd:1000,deadlineMs:60000},NOW);if(!turn.ok)throw Error('turn');
    expect(team.bindTurn(next,turn.id)).toBe(true);expect(team.defer(next,'Try again',NOW)).toBe(false);
    expect(team.snapshot(alex,c).messages[0]?.status).toBe('running');
  });
  test('personal reads do not invalidate the shared projection or change another read cursor',()=>{
    const {c}=shared(),id=send(c,'Shared update'),before=team.cursor(alex,c);
    value(call('read',{conversationId:c,messageId:id},sam));expect(team.cursor(alex,c)).toBe(before);
    expect(store.handle.prepare('SELECT account,message FROM team_read').all()).toEqual([{account:'sam',message:id}]);
    expect(call('read',{conversationId:c,messageId:9999},sam).code).toBe('not-found');
  });
  test('secret-looking text and over-limit text never reach saved history',()=>{
    const {c}=shared();expect(call('send',{conversationId:c,text:'a'.repeat(2001),requestId:'long'}).ok).toBe(false);
    expect(call('send',{conversationId:c,text:'OPENAI_API_KEY=sk-'+ 'a'.repeat(48),requestId:'secret'}).code).toBe('secret-in-message');
    expect(team.snapshot(alex,c).messages).toEqual([]);
  });
  test('task ownership transfer uses a revision fence and preserves task/run identity',()=>{
    const l1=lead('Engineering'),l2=lead('Product'),c1=room(l1),c2=room(l2);store.createTask({id:'task-one',title:'Existing work'},NOW);store.placeTask(store.lookupRef('task-one')!.id,A);
    expect(team.recordTaskOwner('task-one',l1,c1,alex,NOW)).toBe(true);expect(team.recordTaskOwner('task-one',l2,c2,alex,NOW)).toBe(false);
    const before=store.handle.prepare('SELECT * FROM task').all();
    expect(call('transfer',{taskId:'task-one',leadId:l2,conversationId:c2,expectedRevision:1}).ok).toBe(true);
    expect(call('transfer',{taskId:'task-one',leadId:l1,expectedRevision:1}).code).toBe('conflict');expect(team.taskOwner('task-one')).toEqual({leadId:l2,revision:2,conversationId:c2});
    expect(store.handle.prepare('SELECT * FROM task').all()).toEqual(before);
  });
  test('team-bound spending sessions are explicit and cannot be replaced by a legacy creator session',()=>{
    const {c}=shared(),thread=team.snapshot(alex,c).selected!.threadId;
    const terms={approver:'alex',approverGeneration:1,credentialKey:'shared-provider',ceilingMicrousd:1000000,ceilingDigest:'explicit-chat-cap',termsDigest:'signed-terms'};
    const session=store.mintTeamMateSession({...terms,thread},NOW),session2=store.mintTeamMateSession({...terms,approver:'sam',thread},NOW);
    const turnArgs={approver:'alex',session,thread,credentialKey:'shared-provider',reservedMicrousd:100,dailyTurns:10,weeklyCeilingMicrousd:1000000,deadlineMs:60000};
    expect(store.openMateTurn(turnArgs,NOW).ok).toBe(true);expect(store.openMateTurn({...turnArgs,approver:'sam',session:session2},NOW)).toEqual({ok:false,reason:'concurrent'});
    const privateSession=store.mintMateSession(terms,NOW);expect(store.getMateSession(session)?.endedAt).toBeNull();expect(store.openMateTurn({...turnArgs,session:privateSession},NOW)).toEqual({ok:false,reason:'not-yours'});
    store.closeMateThreadsFor('alex',NOW);expect(store.getMateThread(thread)?.closedAt).toBeNull();
  });
  test('a stop affects its exact conversation only and prevents late queue delivery',()=>{
    const {c}=shared(),other=room(lead('Other')),first=send(c,'Stop this',sam);send(other,'Keep this');
    const one=team.claimNext('a',NOW)!,two=team.claimNext('b',NOW)!;
    expect(one.messageId).toBe(first);expect(call('stop',{conversationId:c,messageId:first}).ok).toBe(true);
    expect(team.current(one)).toBe(false);expect(team.current(two)).toBe(true);expect(team.claimNext('c',NOW)).toBeNull();
    expect(team.finish(one,{status:'answered',text:'Do not deliver me'},NOW)).toBe(true);expect(team.snapshot(alex,c).messages).toHaveLength(1);
  });
});

describe('v71 team migration',()=>{
  test.each([70,-70])('authentic v%s keeps legacy chat private and leaves result identities unchanged',epoch=>{
    const dir=mkdtempSync(join(tmpdir(),'team-migration-')),file=join(dir,'orders.db');
    try{
      let store=openStore(file);store.saveApprover('alex','hash',NOW);const thread=store.openMateThread('alex','ceiling',NOW).thread;store.appendMateMessage({thread:thread.id,turn:null,role:'operator',text:'My private legacy history'},NOW);store.createTask({id:'history',title:'Completed work'},NOW);store.setTaskState('history','done',NOW);store.close();
      const raw=new DatabaseSync(file);for(const table of [...TEAM_TABLES].reverse())raw.exec(`DROP TABLE ${table}`);raw.prepare('UPDATE schema_version SET version=?').run(epoch);const tasks=raw.prepare('SELECT * FROM task').all(),messages=raw.prepare('SELECT * FROM mate_message').all();raw.close();
      expect(openStoreNoMigrate(file).ok).toBe(false);store=openStore(file);expect(store.handle.prepare('SELECT version FROM schema_version').get()?.['version']).toBe(SCHEMA_VERSION);expect(store.handle.prepare('SELECT * FROM task').all()).toEqual(tasks);expect(store.handle.prepare('SELECT * FROM mate_message').all()).toEqual(messages);expect(store.handle.prepare('SELECT * FROM team_conversation').all()).toEqual([]);expect(store.handle.prepare('PRAGMA foreign_key_check').all()).toEqual([]);store.close();
      store=openStore(file);expect(store.listMateMessages(thread.id,10)[0]?.text).toBe('My private legacy history');store.close();
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  test('a current database missing team history refuses before recreating it',()=>{
    const dir=mkdtempSync(join(tmpdir(),'team-corrupt-')),file=join(dir,'orders.db');try{const store=openStore(file);store.close();const raw=new DatabaseSync(file);raw.exec('DROP TABLE team_request');raw.close();expect(()=>openStore(file)).toThrow(/team history is missing/);const check=new DatabaseSync(file);expect(check.prepare("SELECT 1 FROM sqlite_master WHERE name='team_request'").get()).toBeUndefined();check.close();}finally{rmSync(dir,{recursive:true,force:true});}
  });
});
