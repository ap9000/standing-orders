#!/usr/bin/env node
/** Real-provider stop/resume through ordinary authenticated console forms.
 * No post-filing scope edits, draft repair, direct queue mutation or result override. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Window} from 'happy-dom';
import {taskControlFixture} from './fixtures/task-control-journey.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let provider='claude',output=resolve('output/certification/task-control-journey.json'),playwright=null,prepareOnly=false;
for(let i=2;i<process.argv.length;i++) {
  const arg=process.argv[i];
  if(arg==='--provider')provider=process.argv[++i];
  else if(arg==='--output')output=resolve(process.argv[++i]);
  else if(arg==='--playwright')playwright=resolve(process.argv[++i]);
  else if(arg==='--prepare-only')prepareOnly=true;
  else if(arg==='--help'){console.log('node scripts/task-control-journey.mjs --playwright /installed/playwright/index.mjs [--provider claude|codex] [--prepare-only] [--output file]');process.exit(0);}
  else throw Error('Unknown argument '+arg);
}
assert(['claude','codex'].includes(provider)&&playwright,'Choose a supported provider and installed Playwright module');
assert(process.platform!=='win32','This provider journey checks POSIX process liveness; Windows is a separate certification gate');
const model=provider==='claude'?'opus':'gpt-5.6-sol';
const {openStore}=await import(pathToFileURL(join(root,'dist/store.js')).href);
const {createDecisionServer}=await import(pathToFileURL(join(root,'dist/serve.js')).href);
const {acceptanceToLines}=await import(pathToFileURL(join(root,'dist/scope.js')).href);
const retainedAt=await realpath(await mkdtemp(join(tmpdir(),'standing-orders-task-control-')));
const repo=join(retainedAt,'repo'),db=join(retainedAt,'orders.db'),pool=join(retainedAt,'worktrees');
const password='stop-journey-'+randomUUID(),auth=['--as','journey','--token',password];
const record={version:1,provider,model,passed:false,prepared:false,manualInterventions:0,startedAt:new Date().toISOString(),retainedAt,steps:[],checks:{},screenshots:[]};
let runnerToken=null,store=null,server=null,base='',cookie='',browser=null,watch=null;
const redact=value=>String(value).replaceAll(password,'[redacted]').replaceAll(runnerToken??'NO_TOKEN','[redacted]');
const delay=ms=>new Promise(done=>setTimeout(done,ms));
function start(file,args,cwd=root,options={}) {
  const child=spawn(file,args,{cwd,stdio:['ignore','pipe','pipe'],...options});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const done=new Promise((resolveDone,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolveDone({code,signal,stdout,stderr}));});
  return {child,done};
}
async function run(file,args,cwd=root){return start(file,args,cwd).done;}
async function identity(){
  const hash=createHash('sha256');
  async function walk(dir,prefix){for(const e of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(dir,e.name),n=prefix+'/'+e.name;if(e.isDirectory())await walk(p,n);else hash.update(n).update('\0').update(await readFile(p)).update('\0');}}
  await walk(join(root,'dist'),'dist');
  const executableSha256=hash.copy().digest('hex');
  for(const file of ['scripts/task-control-journey.mjs','scripts/fixtures/task-control-journey.mjs'])hash.update(file).update('\0').update(await readFile(join(root,file))).update('\0');
  return {sourceCommit:(await run('git',['rev-parse','HEAD'])).stdout.trim(),executableSha256,sha256:hash.digest('hex')};
}
const runtime=await identity();record.runtime=runtime;
async function cli(label,args,accepted=[0]){
  assert.deepEqual(await identity(),runtime,'Runtime changed during certification');
  const began=Date.now(),r=await run(process.execPath,[join(root,'dist/bin.js'),...args,'--db',db,'--json']);
  record.steps.push({label,durationMs:Date.now()-began,exitCode:r.code});
  assert(accepted.includes(r.code),label+': '+redact(r.stdout+'\n'+r.stderr).slice(0,6000));return JSON.parse(r.stdout);
}
async function git(...args){const r=await run('git',args,repo);assert.equal(r.code,0,r.stderr);return r.stdout.trim();}
async function show(label){const value=await cli('read '+label,['task','show','draft']);await writeFile(join(retainedAt,label+'.json'),JSON.stringify(value,null,2));return value;}
async function until(predicate,timeout,label){const end=Date.now()+timeout;while(Date.now()<end){const value=await predicate();if(value)return value;if(watch?.child.exitCode!==null&&watch?.child.exitCode!==undefined)throw Error('Worker exited before '+label+': '+redact((await watch.done).stderr));await delay(200);}throw Error('Timed out waiting for '+label);}
function isAlive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function readAction(label,html){
  if(html===undefined){const response=await fetch(base+'/t/draft',{headers:{cookie}});assert.equal(response.status,200);html=await response.text();}
  const window=new Window();window.document.write(html);
  try{
    const form=[...window.document.querySelectorAll('form')].find(f=>[...f.querySelectorAll('button')].some(b=>b.textContent.trim().toLowerCase()===label.toLowerCase()));
    assert(form,'No ordinary '+label+' form on task');
    const body=new URLSearchParams();for(const e of form.querySelectorAll('input[name],textarea[name],select[name]')){if(['checkbox','radio'].includes(e.type)&&!e.checked)continue;body.set(e.name,e.type==='password'?password:e.value);}
    return {action:form.getAttribute('action'),body};
  }finally{window.close();}
}
async function submit(action){const response=await fetch(base+action.action,{method:'POST',headers:{cookie,origin:base},body:action.body,redirect:'manual'});return {status:response.status,location:response.headers.get('location'),body:await response.text()};}
async function screenshot(label){
  for(const [name,width,height]of [['desktop',1280,900],['phone',390,844]]){
    const page=await browser.newPage({viewport:{width,height}});
    try{
      await page.context().addCookies(cookie.split('; ').map(pair=>({name:pair.slice(0,pair.indexOf('=')),value:pair.slice(pair.indexOf('=')+1),url:base})));
      await page.goto(base+'/t/draft');assert.equal(new URL(page.url()).pathname,'/t/draft');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');
      if(await page.locator('#task-control').count())await page.locator('#task-control').scrollIntoViewIfNeeded();
      const path=join(retainedAt,`${label}-${name}.png`);await page.screenshot({path});
      record.screenshots.push({state:label,viewport:name,width,height,path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});
    }finally{await page.close();}
  }
}
function startWatch(){
  return start(process.execPath,[join(root,'dist/bin.js'),'watch','--runner','journey-worker','--token-file',join(retainedAt,'runner-token'),'--repo',repo,'--pool',pool,'--tick-every','200','--reconcile-every','500','--bridge-every','3600000','--stop-grace','1000','--for','1200000','--db',db,'--json'],repo);
}
async function stopWatch(){
  if(!watch)return;
  if(watch.child.exitCode===null&&watch.child.signalCode===null)watch.child.kill('SIGTERM');
  const result=await Promise.race([watch.done,delay(15_000).then(()=>null)]);
  if(result===null){watch.child.kill('SIGTERM');throw Error('Watch did not settle after its shutdown grace');}
  await writeFile(join(retainedAt,`watch-${record.steps.length}.json`),redact(JSON.stringify(result,null,2)));
  assert.equal(result.code,0,'Watch did not stop cleanly: '+redact(result.stdout+'\n'+result.stderr));watch=null;
}

try{
  await mkdir(repo);const fixture=taskControlFixture();
  for(const [name,body]of Object.entries(fixture.files))await writeFile(join(repo,name),body);
  await git('init','-q','-b','main');await git('config','user.name','Stop Journey');await git('config','user.email','journey@example.invalid');await git('add','.');await git('commit','-qm','seed immutable stop/resume fixture');
  const originalHead=await git('rev-parse','HEAD');record.originalHead=originalHead;
  await cli('bootstrap private operator',['approver','add','journey','--password',password]);
  runnerToken=(await cli('bind worker',['runner','register','journey-worker','--repo',repo,...auth])).token;
  await writeFile(join(retainedAt,'runner-token'),runnerToken,{mode:0o600});
  await cli('enable the private unsent chat composer',['config','set','chat','--provider','claude-subscription','--model','opus','--daily-turns','1',...auth]);
  for(const phase of ['build','plan','repair','review'])await cli('route '+phase,['config','set',phase,'--provider',provider,'--model',model,...auth]);
  await cli('approve fixed verification',['verify','set','--repo',repo,'--command','npm test','--timeout-seconds','120','--yes',...auth]);
  await cli('file draft',['task','add','Preserve a stopped draft','--id','draft','--repo',repo]);
  await cli('file exact contract',['task','scope','draft','--goal',fixture.goal,'--not',fixture.exclusions,'--touches','result.txt','--acceptance',acceptanceToLines(fixture.acceptance).join(';')]);
  const filed=await show('filed');await cli('approve exact contract',['task','approve','draft','--yes','--digest',filed.scope.digest,...auth]);
  if(prepareOnly)record.prepared=true;
  else{
    store=openStore(db);server=createDecisionServer({store,evidenceRoot:join(retainedAt,'evidence'),repo});await new Promise(done=>server.listen(0,'127.0.0.1',done));base='http://127.0.0.1:'+server.address().port;
    const login=await fetch(base+'/login',{method:'POST',redirect:'manual',body:new URLSearchParams({name:'journey',token:password})});assert.equal(login.status,303);cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    const {chromium}=await import(pathToFileURL(playwright).href);browser=await chromium.launch({headless:true});
    watch=startWatch();console.log(provider+': waiting for the real provider to leave an opaque draft');
    const taskRef=store.lookupRef('draft').id;
    const checkpoint=await until(()=>{const run=store.runsFor(taskRef).find(r=>r.role==='builder'&&r.outcome===null);if(!run?.worktree)return null;const path=join(run.worktree,'output/checkpoint.json');return existsSync(path)?{run,checkpoint:JSON.parse(readFileSync(path,'utf8'))}:null;},15*60_000,'first checkpoint');
    record.stoppedRun=checkpoint.run.id;record.checks.draftSha256=checkpoint.checkpoint.sha256;
    assert(isAlive(checkpoint.checkpoint.pid),'Checkpoint process was not alive');
    assert((await git('status','--porcelain')).length===0,'Default checkout changed');
    await screenshot('running');
    const chatPage=await browser.newPage({viewport:{width:1280,height:900}});
    await chatPage.context().addCookies(cookie.split('; ').map(pair=>({name:pair.slice(0,pair.indexOf('=')),value:pair.slice(pair.indexOf('=')+1),url:base})));
    await chatPage.goto(base+'/chat?task=draft');
    const composer=chatPage.locator('textarea[name="message"]');
    const unsent='Keep this unsent draft intact across Stop and Resume '+randomUUID();
    await composer.fill(unsent);
    const stop=await readAction('Stop'),requestedAt=Date.now();
    // Hold the known fixture worker at the intent/observation boundary so
    // both viewports can capture the durable pending state deterministically.
    watch.child.kill('SIGSTOP');
    try{
      assert.equal((await submit(stop)).status,303,'Stop action refused');
      assert.equal(store.stopOf(checkpoint.run.id).settledAt,null,'An unobserved stop was declared settled');
      await screenshot('stopping');
      await chatPage.waitForFunction(()=>document.querySelector('#task-chat-live')?.textContent.includes('Stopping'),{},{timeout:15_000});
      assert.equal(await composer.inputValue(),unsent,'Polling erased the unsent chat draft');
    }finally{watch.child.kill('SIGCONT');}
    await until(()=>store.getRun(checkpoint.run.id).outcome!==null,30_000,'durable stop settlement');
    await until(()=>!isAlive(checkpoint.checkpoint.pid),5000,'checkpoint descendant shutdown');
    record.checks.stopSettlementMs=Date.now()-requestedAt;
    const stopped=await show('stopped');const previous=stopped.runs.find(r=>r.id===checkpoint.run.id);
    assert(!['built','no-change'].includes(previous.outcome),'Stopped attempt accepted a terminal success');assert.notEqual(stopped.task.state,'done');
    assert.equal(stopped.scope.digest,filed.scope.digest);assert.equal(await readFile(join(checkpoint.run.worktree,'result.txt'),'utf8'),checkpoint.checkpoint.draft);
    const beat=await readFile(join(checkpoint.run.worktree,'output/heartbeat.log'),'utf8');await delay(1200);assert.equal(await readFile(join(checkpoint.run.worktree,'output/heartbeat.log'),'utf8'),beat,'Stopped descendant kept writing');
    await screenshot('paused');
    await chatPage.waitForFunction(()=>document.querySelector('#task-chat-live')?.textContent.includes('Resume'),{},{timeout:15_000});
    assert.equal(await composer.inputValue(),unsent,'Paused polling erased the unsent chat draft');
    record.checks.unsentChatDraftPreserved=true;await chatPage.close();
    await stopWatch();record.steps.push({label:'clean worker shutdown and restart between stop and resume'});
    const armed=await submit(await readAction('Resume'));assert.equal(armed.status,200,'Resume confirmation did not open');
    const resume=await readAction('resume run #'+checkpoint.run.id,armed.body);watch=startWatch();
    assert.equal((await submit(resume)).status,303,'Resume action refused');console.log(provider+': resuming the preserved draft through the ordinary form');
    const successor=await until(()=>store.runsFor(taskRef).find(r=>r.role==='builder'&&r.id!==checkpoint.run.id),30_000,'successor admission');
    record.resumedRun=successor.id;assert.equal(successor.parentRun,checkpoint.run.id,'Successor lost interrupted ancestry');
    const resumedStop=store.stopOf(checkpoint.run.id);
    const replay=await submit(resume);record.checks.resumeReplayStatus=replay.status;
    assert.equal(replay.status,409,'A spent confirmation was accepted');
    assert.deepEqual(store.stopOf(checkpoint.run.id),resumedStop,'Replay rewrote resume provenance');
    assert.equal(store.applicableStopFor(successor.id),null,'Stale resume infected its successor');
    await until(()=>store.getRun(successor.id).outcome!==null,15*60_000,'resumed result');
    const result=await show('result');const finished=result.runs.find(r=>r.id===successor.id);
    assert.equal(finished.outcome,'built');assert.equal(result.proofVerdict,'verified');assert.equal(result.task.state,'done');
    assert.equal(result.scope.digest,filed.scope.digest);assert.equal(finished.scopeDigest,filed.scope.digest);
    assert.equal(await readFile(join(successor.worktree,'result.txt'),'utf8'),checkpoint.checkpoint.draft+'Completed\n');
    assert.equal(await git('rev-parse','main'),originalHead,'Default branch changed');
    assert.equal(store.runsFor(taskRef).filter(r=>r.role==='builder'&&r.outcome==='built').length,1,'Duplicate successful attempt');
    assert(store.runsFor(taskRef).every(r=>r.outcome!==null),'An open run survived completion');
    await screenshot('completed');await stopWatch();
    const duplicate=await cli('duplicate dispatch',['tick','--runner','journey-worker','--token',runnerToken,'--repo',repo,'--pool',pool],[3]);assert.equal(duplicate.reason,'empty');
    record.checks.duplicateDispatch='refused-empty';record.checks.retainedDraft=true;record.checks.noLateWrites=true;record.checks.freshProof=result.proofVerdict;record.passed=true;
  }
}catch(error){record.error=redact(error.stack??error);}
finally{
  try{await stopWatch();}catch(error){record.cleanupError=redact(error);record.passed=false;}
  await browser?.close();if(server)await new Promise(done=>server.close(done));store?.close();
}
record.finishedAt=new Date().toISOString();record.runtimeUnchanged=JSON.stringify(await identity())===JSON.stringify(runtime);record.passed&&=record.runtimeUnchanged;
record.exclusions=['Physical Windows process-tree termination','macOS login/reboot','Production publication','Crash while a stop is pending'];
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(record,null,2)+'\n');
console.log((prepareOnly?'Prepared':record.passed?'PASS':'FAIL')+': '+output);if(record.error)console.log(record.error.split('\n')[0]);if(!(prepareOnly?record.prepared:record.passed))process.exitCode=1;
