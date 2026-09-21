import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { openStore, type Store } from './store.js';
import { TeamLeads } from './team-leads.js';
import { deliverTeamUpdates, startTeamUpdates, teamUpdateCursor } from './team-updates.js';
import { fileTaskProposal } from './proposal.js';
import { assignmentOf } from './assignment.js';
import { noteAssignmentStatus } from './assignment-status.js';
const NOW=new Date('2026-09-21T18:00:00Z'),P='/repo/product';
const alex={name:'alex',generation:1},sam={name:'sam',generation:1};
describe('shared lead status delivery',()=>{
  let store:Store,domain:TeamLeads,leadId:string,conversationId:string;
  beforeEach(()=>{
    store=openStore(':memory:');store.saveApprover('alex','a'.repeat(64),NOW);store.saveApprover('sam','b'.repeat(64),NOW);domain=new TeamLeads(store,()=>[P]);
    leadId=(domain.execute(alex,{operation:'create-lead',args:{name:'Lead',projects:[P]}},NOW).result as {leadId:string}).leadId;
    conversationId=(domain.execute(alex,{operation:'create-conversation',args:{leadId,title:'Shipping',projects:[P],visibility:'team'}},NOW).result as {conversationId:string}).conversationId;
    expect(domain.execute(alex,{operation:'member',args:{conversationId,account:'sam',role:'contributor',joinLead:true,expectedLeadRevision:1,expectedRevision:1}},NOW).ok).toBe(true);
    expect(fileTaskProposal(store,{id:'ship',title:'Ship the change',repo:P,filedVia:'cli'},NOW).ok).toBe(true);
    expect(domain.recordTaskOwner('ship',leadId,conversationId,alex,NOW)).toBe(true);
  });
  afterEach(()=>store.close());
  function follow(actor=alex){expect(domain.execute(actor,{operation:'follow',args:{conversationId,enabled:true}},NOW).ok).toBe(true);}
  function cancelled(){store.setTaskState('ship','cancelled',NOW);const a=assignmentOf(store,'ship',NOW,{principal:'operator',repos:[P]})!;expect(noteAssignmentStatus(store,a,NOW)).not.toBeNull();}
  test('idle delivery is empty and two observers cause only one queued response',()=>{
    follow();follow(sam);startTeamUpdates(store,conversationId,NOW);
    expect(deliverTeamUpdates(store,domain,()=>true,NOW)).toBe(0);cancelled();
    expect(deliverTeamUpdates(store,domain,()=>true,NOW)).toBe(1);
    const messages=domain.snapshot(alex,conversationId).messages;expect(messages).toHaveLength(1);expect(messages[0]?.text).toContain('ship');
    expect(deliverTeamUpdates(store,new TeamLeads(store,()=>[P]),()=>true,NOW)).toBe(0);expect(domain.snapshot(sam,conversationId).messages).toHaveLength(1);
  });
  test('a missing personal grant leaves the event pending and never sends it',()=>{
    follow();startTeamUpdates(store,conversationId,NOW);const before=store.serviceCursor(teamUpdateCursor(conversationId));cancelled();
    expect(deliverTeamUpdates(store,domain,()=>false,NOW)).toBe(0);expect(store.serviceCursor(teamUpdateCursor(conversationId))).toBe(before);
    expect(deliverTeamUpdates(store,domain,()=>true,NOW)).toBe(1);
  });
  test('an ownership transfer does not send the old event into the old conversation',()=>{
    follow();startTeamUpdates(store,conversationId,NOW);cancelled();
    store.handle.prepare('UPDATE team_task_owner SET conversation=NULL').run();
    expect(deliverTeamUpdates(store,domain,()=>true,NOW)).toBe(0);expect(domain.snapshot(alex,conversationId).messages).toHaveLength(0);
  });
  test('unreadable delivery remains visible in the saved stream instead of being acknowledged',()=>{
    follow();startTeamUpdates(store,conversationId,NOW);const before=store.serviceCursor(teamUpdateCursor(conversationId));
    store.recordAction({at:NOW.toISOString(),actor:`lead:${leadId}`,repo:P,taskId:'ship',runId:null,action:'assignment status observed',source:'work',outcome:'broken'});
    expect(deliverTeamUpdates(store,domain,()=>true,NOW)).toBe(0);expect(store.serviceCursor(teamUpdateCursor(conversationId))).toBe(before);
  });
  test('foreign malformed events and more than fifty unrelated events cannot block an admitted room',()=>{
    follow();startTeamUpdates(store,conversationId,NOW);
    expect(fileTaskProposal(store,{id:'elsewhere',title:'Private work elsewhere',repo:P,filedVia:'cli'},NOW).ok).toBe(true);
    for(let index=0;index<60;index++)store.recordAction({at:NOW.toISOString(),actor:`lead:${leadId}`,repo:P,taskId:'elsewhere',runId:null,action:'assignment status observed',source:'work',outcome:'private unreadable event'});
    cancelled();
    expect(deliverTeamUpdates(store,domain,()=>true,NOW)).toBe(1);
    const messages=domain.snapshot(alex,conversationId).messages;
    expect(messages).toHaveLength(1);expect(messages[0]!.text).toContain('ship');expect(messages[0]!.text).not.toContain('elsewhere');
  });
  test('a valid payload attached to the wrong task identity stays pending instead of leaking its content',()=>{
    follow();cancelled();startTeamUpdates(store,conversationId,NOW);const before=store.serviceCursor(teamUpdateCursor(conversationId));
    const row=store.handle.prepare("SELECT id,outcome FROM action_ledger WHERE action='assignment status observed' ORDER BY id DESC LIMIT 1").get()!;
    const event=JSON.parse(String(row['outcome']));event.assignment.rootId='other-private-task';event.assignment.title='Do not expose this';event.stateDigest=createHash('sha256').update(JSON.stringify(event.assignment)).digest('hex');
    store.recordAction({at:NOW.toISOString(),actor:`lead:${leadId}`,repo:P,taskId:'ship',runId:null,action:'assignment status observed',source:'work',outcome:JSON.stringify(event)});
    expect(deliverTeamUpdates(store,domain,()=>true,NOW)).toBe(0);
    expect(store.serviceCursor(teamUpdateCursor(conversationId))).toBe(before);expect(domain.snapshot(alex,conversationId).messages).toHaveLength(0);
  });
  test('a paid grant lost after selection leaves its source pending',()=>{
    follow();startTeamUpdates(store,conversationId,NOW);const before=store.serviceCursor(teamUpdateCursor(conversationId));cancelled();let checks=0;
    expect(deliverTeamUpdates(store,domain,()=>++checks===1,NOW)).toBe(0);
    expect(checks).toBe(2);expect(store.serviceCursor(teamUpdateCursor(conversationId))).toBe(before);expect(domain.snapshot(alex,conversationId).messages).toHaveLength(0);
  });
  test('pausing follow after selection cannot admit an automatic message',()=>{
    follow();startTeamUpdates(store,conversationId,NOW);const before=store.serviceCursor(teamUpdateCursor(conversationId));cancelled();
    expect(deliverTeamUpdates(store,domain,()=>{domain.execute(alex,{operation:'follow',args:{conversationId,enabled:false}},NOW);return true;},NOW)).toBe(0);
    expect(store.serviceCursor(teamUpdateCursor(conversationId))).toBe(before);expect(domain.snapshot(alex,conversationId).messages).toHaveLength(0);
  });
  test('a saved failed response is never submitted again by delivery',()=>{
    follow();follow(sam);startTeamUpdates(store,conversationId,NOW);cancelled();
    expect(deliverTeamUpdates(store,domain,()=>true,NOW)).toBe(1);
    const claim=domain.claimNext('test-runner',NOW)!;expect(claim).not.toBeNull();
    expect(domain.finish(claim,{status:'failed',error:'The provider failed.'},NOW)).toBe(true);
    expect(deliverTeamUpdates(store,new TeamLeads(store,()=>[P]),()=>true,NOW)).toBe(0);
    const messages=domain.snapshot(sam,conversationId).messages;expect(messages).toHaveLength(1);expect(messages[0]!.status).toBe('failed');
  });
});
