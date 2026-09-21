/** Isolated storage/API projection load probe; no model, process, or live DB.
 * Run: node --import tsx scripts/benchmark-team.ts
 * A 50-client burst is simulated sequentially on the central SQLite event loop.
 * These are domain timings, not network/browser or provider capacity claims. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openStore } from '../src/store.js';
import { TeamLeads } from '../src/team-leads.js';
import { workIndexPage } from '../src/work-index.js';
import type { TeamActor, TeamOperation } from '../src/team-contract.js';
const directory=realpathSync(mkdtempSync(join(tmpdir(),'so-team-scale-'))),file=join(directory,'orders.db');
const store=openStore(file),now=new Date('2026-09-21T18:00:00Z');
const projects=Array.from({length:100},(_,i)=>join(directory,`project-${i}`));
const team=new TeamLeads(store,()=>projects),actors:TeamActor[]=Array.from({length:20},(_,i)=>({name:`person-${i}`,generation:1}));
const rooms:{id:string;lead:string;projects:string[]}[]=[];
function command<T>(actor:TeamActor,operation:TeamOperation,args:Record<string,unknown>):T{const r=team.execute(actor,{operation,args},now);if(!r.ok)throw Error(`${operation}: ${r.message}`);return r.result as T;}
try{
  for(const p of projects)mkdirSync(p);
  for(const actor of actors)store.saveApprover(actor.name,'synthetic-unusable-login',now);
  const task=store.handle.prepare('INSERT INTO task(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)');
  const ref=store.handle.prepare("INSERT INTO task_ref(backend,external_id,repo) VALUES('built-in',?,?)");
  const run=store.handle.prepare("INSERT INTO run(task_ref,lease_id,runner,branch,worktree,started_at,finished_at,outcome,handoff) VALUES(?,?,'synthetic','synthetic','/synthetic/unread',?,?,'failed',?)");
  const artifact=store.handle.prepare("INSERT INTO artifact(run,kind,key,bytes_original,bytes_stored,sha256,capture,created_at) VALUES(?,'handoff',?,4096,4096,?,'synthetic; artifact files absent',?)");
  store.transact(()=>{
    for(const [i,p]of projects.entries())store.handle.prepare('INSERT INTO project(path,name,added_at,last_opened_at) VALUES(?,?,?,?)').run(p,`Synthetic project ${i}`,now.toISOString(),now.toISOString());
    for(let i=0;i<10000;i++){
      const id=`task-${String(i).padStart(5,'0')}`,stamp=new Date(now.getTime()-i*1000).toISOString();
      task.run(id,`Synthetic task ${i}: preserve project context and saved results`,i%10===0?'cancelled':i%3===0?'failed':'queued',stamp,stamp);
      const taskRef=ref.run(id,projects[i%100]!).lastInsertRowid;
      for(let j=0;j<3;j++){const runId=run.run(taskRef,`${id}-${j}`,stamp,stamp,`Synthetic previous output ${'x'.repeat(4000)}`).lastInsertRowid;for(let k=0;k<3;k++)artifact.run(runId,`absent/${runId}-${k}`,'0'.repeat(64),stamp);}
    }
  });
  for(let i=0;i<10;i++){
    const scope=projects.slice(i*10,i*10+10),lead=command<{leadId:string}>(actors[0]!,'create-lead',{name:`Lead ${i}`,projects:scope}).leadId;
    const room=command<{conversationId:string}>(actors[0]!,'create-conversation',{leadId:lead,title:`Shared project group ${i}`,visibility:'team',projects:scope}).conversationId;
    rooms.push({id:room,lead,projects:scope});
    for(let person=1;person<20;person++)command(actors[0]!,'member',{conversationId:room,account:actors[person]!.name,role:'contributor',active:true,expectedRevision:person,joinLead:true,expectedLeadRevision:person});
    for(let person=0;person<20;person++)command(actors[person]!,'send',{conversationId:room,text:'Synthetic acceptance: keep the saved result, include keyboard access, and use one clear action.',requestId:`seed-${i}-${person}`});
  }
  // Each task has exactly one stable lead. This fixture writes ownership
  // directly so setup does not conflate its own validation with read timings.
  store.transact(()=>{const insert=store.handle.prepare('INSERT INTO team_task_owner(task_ref,lead,conversation,changed_by,changed_at) VALUES(?,?,?,?,?)');for(const row of store.handle.prepare('SELECT id,repo FROM task_ref').all()){const room=rooms.find(r=>r.projects.includes(String(row['repo'])))!;insert.run(Number(row['id']),room.lead,room.id,actors[0]!.name,now.toISOString());}});
  const clients=Array.from({length:50},(_,i)=>({actor:actors[i%20]!,room:rooms[i%10]!}));
  const timings:Record<string,unknown>={};
  function measure(name:string,read:(client:typeof clients[number],iteration:number)=>unknown,passes=4){
    const values:number[]=[],bursts:number[]=[];let bytes=0;
    for(let pass=0;pass<passes;pass++){const burstStart=performance.now();for(const [i,c]of clients.entries()){const start=performance.now(),result=read(c,pass*clients.length+i);values.push(performance.now()-start);bytes=Buffer.byteLength(JSON.stringify(result));}bursts.push(performance.now()-burstStart);}
    const sorted=[...values].sort((a,b)=>a-b),rounded=(n:number)=>Math.round(n*100)/100;
    timings[name]={samples:values.length,clientCount:50,coldMs:rounded(values[0]!),p50Ms:rounded(sorted[Math.floor(sorted.length*.5)]!),p95Ms:rounded(sorted[Math.ceil(sorted.length*.95)-1]!),maxMs:rounded(sorted.at(-1)!),burst50Ms:bursts.map(rounded),lastResponseBytes:bytes};
  }
  measure('conversationSnapshot',c=>team.snapshot(c.actor,c.room.id));
  measure('conversationCursor',c=>team.cursor(c.actor,c.room.id));
  measure('leadTaskPage',c=>workIndexPage(store,now,{principal:'operator',repos:c.room.projects},{leadId:c.room.lead,limit:40}));
  measure('persistedMessageWithSnapshot',(c,i)=>team.execute(c.actor,{operation:'send',args:{conversationId:c.room.id,text:`Synthetic ${i}: include keyboard access in the saved acceptance criteria.`,requestId:`burst-${i}`}},now));
  const page=workIndexPage(store,now,{principal:'operator',repos:rooms[0]!.projects},{leadId:rooms[0]!.lead});
  if(page.totals.all!==1000||page.items.length!==40||page.items.some(t=>!rooms[0]!.projects.includes(t.repo!)))throw Error('Scoped page failed');
  if(store.handle.prepare('SELECT COUNT(*) AS n FROM mate_turn').get()?.['n']!==0)throw Error('Read/persistence probe started a turn');
  const report={synthetic:true,generatedAt:new Date().toISOString(),databaseBytes:statSync(file).size,fixture:{people:20,leads:10,conversations:10,clients:50,projects:100,tasks:10000,runs:30000,artifactMetadataRows:90000},providerCalls:0,agentTurns:0,scopeChecks:'passed',timings,limitations:['Domain/storage measurements on one central process, not an HTTP/browser concurrency test.','Clients run in short sequential bursts on the SQLite event loop; not independent OS processes or network clients.','Synthetic artifact metadata has no files and no provider executions.','Does not establish provider throughput, remote-network latency, UI rendering, or production capacity.']};
  mkdirSync('output/team',{recursive:true});writeFileSync('output/team/load-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{store.close();rmSync(directory,{recursive:true,force:true});}
