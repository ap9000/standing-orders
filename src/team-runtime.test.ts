import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openStore, type ChatConfig, type Store } from './store.js';
import { createTeamRuntime } from './team-runtime.js';
import type { TeamActor, TeamOperation } from './team-contract.js';

const NOW=new Date('2026-09-21T18:00:00Z'),PROJECT='/repo/team';
const CONFIG:ChatConfig={provider:'anthropic-api',model:'claude-sonnet-5',dailyTurns:50,weeklyCeilingMicrousd:25_000_000,priceInMicrousd:3,priceOutMicrousd:15,updatedAt:NOW.toISOString(),updatedBy:'alex'};
const alex:TeamActor={name:'alex',generation:1},sam:TeamActor={name:'sam',generation:1};
const answer=()=>new Response(JSON.stringify({type:'message',content:[{type:'text',text:'The saved plan is ready.'}],usage:{input_tokens:10,output_tokens:10}}),{status:200,headers:{'content-type':'application/json'}});
describe('central queued chat runtime',()=>{
  let store:Store,runtime:ReturnType<typeof createTeamRuntime>,bodies:string[],gate:Promise<void>|null,release:()=>void,config:ChatConfig;
  beforeEach(()=>{
    store=openStore(':memory:');store.saveApprover('alex','a'.repeat(64),NOW);store.saveApprover('sam','s'.repeat(64),NOW);
    bodies=[];gate=null;release=()=>{};config={...CONFIG};
    runtime=createTeamRuntime({store,repos:()=>[PROJECT],evidenceRoot:'/no-evidence',clock:()=>NOW,provider:()=>({config,key:'sk-ant-test-key'}),
      fetcher:(async(_url,init)=>{bodies.push(String(init?.body));if(gate)await gate;return answer();}) as typeof fetch});
  });
  afterEach(async()=>{release();await runtime.close();store.close();});
  async function call(operation:TeamOperation,args:Record<string,unknown>,actor=alex){return runtime.execute(actor,{operation,args});}
  async function room(){const l=await call('create-lead',{name:'Product lead',projects:[PROJECT]});const leadId=(l.result as {leadId:string}).leadId;
    const c=await call('create-conversation',{leadId,title:'Launch',visibility:'team',projects:[PROJECT]});const id=(c.result as {conversationId:string}).conversationId;
    const v=await call('show',{conversationId:id});
    expect((await call('member',{conversationId:id,account:'sam',role:'contributor',active:true,expectedRevision:v.snapshot!.selected!.revision,joinLead:true,expectedLeadRevision:v.snapshot!.leads.find(l=>l.id===leadId)!.revision})).ok).toBe(true);
    return id;
  }
  async function authorize(id:string,actor=alex){const view=await call('show',{conversationId:id},actor);const out=await call('authorize',{conversationId:id,termsDigest:view.snapshot!.chatAuthorization!.termsDigest},actor);expect(out.ok,out.message).toBe(true);}
  async function settle(id:string){for(let n=0;n<30;n++){await runtime.pass();await new Promise<void>(resolve=>setImmediate(resolve));const state=runtime.domain.snapshot(alex,id);if(state.messages.every(m=>!['queued','running'].includes(m.status)))return state;}throw Error('Queue did not settle: '+JSON.stringify(runtime.domain.snapshot(alex,id).messages));}
  test('idle checks and reads never call a model or authorize spend',async()=>{
    const id=await room();await runtime.pass();await call('show',{conversationId:id});
    expect((await call('send',{conversationId:id,text:'Make a plan',requestId:'one'})).code).toBe('grant-needed');
    expect(bodies).toHaveLength(0);expect(store.listMateMessages(runtime.domain.snapshot(alex,id).selected!.threadId,40)).toHaveLength(0);
  });
  test('current provider terms need deliberate consent and grants are personal',async()=>{
    const id=await room();const old=(await call('show',{conversationId:id})).snapshot!.chatAuthorization!;
    config={...config,dailyTurns:20};expect((await call('authorize',{conversationId:id,termsDigest:old.termsDigest})).code).toBe('terms-changed');
    await authorize(id);expect((await call('show',{conversationId:id},sam)).snapshot!.chatAuthorization!.enabled).toBe(false);
  });
  test('a shared queued message is consumed once, with the actual author and no future message leaking into history',async()=>{
    const id=await room();await authorize(id);await authorize(id,sam);
    await call('send',{conversationId:id,text:'First request',requestId:'first'});
    await call('send',{conversationId:id,text:'Future message canary',requestId:'second'},sam);
    const view=await settle(id);expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('alex');expect(bodies[0]).not.toContain('Future message canary');expect(bodies[1]).toContain('sam');
    expect(view.messages.filter(m=>m.role==='operator').map(m=>[m.author,m.status])).toEqual([['alex','answered'],['sam','answered']]);
    expect(view.messages.filter(m=>m.role==='assistant')).toHaveLength(2);
    expect((await call('send',{conversationId:id,text:'First request',requestId:'first'})).ok).toBe(true);
    await runtime.pass();expect(bodies).toHaveLength(2);
  });
  test('one writer per conversation and concurrent conversations do not block each other',async()=>{
    const one=await room(),two=await room();await authorize(one);await authorize(two);
    gate=new Promise<void>(resolve=>{release=resolve;});
    await call('send',{conversationId:one,text:'First',requestId:'a'});await call('send',{conversationId:one,text:'Second',requestId:'b'});
    await call('send',{conversationId:two,text:'Other conversation',requestId:'c'});await runtime.pass();
    await new Promise<void>(resolve=>setImmediate(resolve));expect(bodies).toHaveLength(2);
    expect(runtime.domain.snapshot(alex,one).messages.map(m=>m.status)).toEqual(['running','queued']);
    release();gate=null;await settle(one);await settle(two);expect(bodies).toHaveLength(3);
  });
  test('withdrawn and edited messages preserve the queue without a second attempt',async()=>{
    const id=await room();await authorize(id);
    const sent=await call('send',{conversationId:id,text:'Withdraw this',requestId:'w'});const messageId=(sent.result as {messageId:number}).messageId;
    expect((await call('withdraw',{conversationId:id,messageId,expectedRevision:1})).ok).toBe(true);
    await runtime.pass();expect(bodies).toHaveLength(0);
    await call('send',{conversationId:id,text:'Use this instead',requestId:'new'});expect((await settle(id)).messages.at(-1)?.role).toBe('assistant');
    expect(bodies[0]).not.toContain('Withdraw this');
  });
  test('daily limits preserve queued messages without repeated attempts or model calls',async()=>{
    config={...config,dailyTurns:1};const id=await room();await authorize(id);
    await call('send',{conversationId:id,text:'First',requestId:'daily-first'});
    await call('send',{conversationId:id,text:'After the limit changes',requestId:'daily-second'});
    for(let n=0;n<8;n++){await runtime.pass();await new Promise<void>(resolve=>setImmediate(resolve));}
    expect(bodies).toHaveLength(1);
    expect(runtime.domain.snapshot(alex,id).messages.filter(m=>m.role==='operator').map(m=>m.status)).toEqual(['answered','queued']);
    expect((await call('show',{conversationId:id})).snapshot!.chatAuthorization!.waitingReason).toContain('daily');
    config={...config,dailyTurns:2};await runtime.pass();expect(bodies).toHaveLength(1);
    await authorize(id);await settle(id);expect(bodies).toHaveLength(2);
  });
  test('changing spending terms while a provider is working discards stale output',async()=>{
    const id=await room();await authorize(id);gate=new Promise<void>(resolve=>{release=resolve;});
    await call('send',{conversationId:id,text:'Check the plan',requestId:'changed-budget'});await runtime.pass();
    config={...config,dailyTurns:5};release();gate=null;const saved=await settle(id);
    expect(bodies).toHaveLength(1);expect(saved.messages.filter(m=>m.role==='assistant')).toHaveLength(0);
    expect((await call('show',{conversationId:id})).snapshot!.chatAuthorization!.enabled).toBe(false);
  });
  test('removing a participant during a turn discards the response and never starts their next message',async()=>{
    const id=await room();await authorize(id,sam);gate=new Promise<void>(resolve=>{release=resolve;});
    await call('send',{conversationId:id,text:'From Sam',requestId:'running'},sam);await runtime.pass();await new Promise<void>(resolve=>setImmediate(resolve));
    const view=runtime.domain.snapshot(alex,id);
    expect((await call('member',{conversationId:id,account:'sam',role:'contributor',active:false,expectedRevision:view.selected!.revision})).ok).toBe(true);
    release();gate=null;const saved=await settle(id);expect(saved.messages.filter(m=>m.role==='assistant')).toHaveLength(0);
    expect(saved.messages[0]?.status).toBe('cancelled');expect(bodies).toHaveLength(1);
  });
});
