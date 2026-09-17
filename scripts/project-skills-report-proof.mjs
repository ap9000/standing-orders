// Synthetic focused visual regression for native built/report-delivered receipts.
import {existsSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startFixture} from './ui-polish-fixture.mjs';
import {storeEvidence} from '../dist/evidence.js';
const out=resolve('evidence/project-skills-report-copy');mkdirSync(out,{recursive:true});
let pw;for(const d of readdirSync(join(homedir(),'.npm','_npx'))){const p=join(homedir(),'.npm','_npx',d,'node_modules/playwright/index.mjs');if(existsSync(p)){pw=await import(pathToFileURL(p));break;}}
if(!pw)throw Error('Playwright unavailable');
const browser=await pw.chromium.launch({channel:'chrome'}),fixture=await startFixture(),store=fixture.store,now=new Date(),ref=store.lookupRef(fixture.tasks.done);
const route=store.routeAuthorityFor(ref.id,'scout',null,{provider:'codex',model:'default'});if(!route.ok)throw Error('Fixture route unavailable');
const run=store.startRun({taskRef:ref.id,leaseId:'synthetic-report-copy',runner:'night-shift-1',role:'scout',branch:'synthetic-report-copy',worktree:fixture.repos.main,provider:'codex',model:'default',now,route:route.stamp});
const summary='Synthetic skill test: the update keeps publication unconfirmed and offers one action: View review progress.';
storeEvidence(store,join(fixture.repos.main,'..','evidence'),run,'report','report.json',Buffer.from(JSON.stringify({title:'Clear task update — synthetic sample',summary,report:'No model was invoked in this visual fixture. The real installed trial is recorded separately.',followUps:[]})),'synthetic native report shape',now);
store.finishRun(run,{outcome:'built',reason:'report-delivered',committed:false,now});store.setTaskState(fixture.tasks.done,'done',now);
const checks=[];
try{
 for(const [name,viewport]of[['desktop',{width:1440,height:900}],['phone',{width:390,height:844}]]){
  const context=await browser.newContext({viewport,reducedMotion:'reduce'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fixture.url+'/r/'+run);await page.getByLabel('username',{exact:true}).fill(fixture.name);await page.getByLabel('password',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'sign in',exact:true}).click();
  await page.goto(fixture.url+'/r/'+run);await page.getByRole('heading',{name:'Report saved',exact:true}).waitFor();
  const body=await page.locator('body').innerText(),overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(!body.includes(summary)||body.includes('without a concise handoff')||overflow||errors.length)throw Error(name+' report receipt failed');
  await page.screenshot({path:join(out,name+'-report.png')});checks.push({viewport,name,runShape:'scout, built/report-delivered, report artifact only',heading:'Report saved',verifiedReportSummary:true,overflow,errors});await context.close();
 }
 writeFileSync(join(out,'ui-report.json'),JSON.stringify({synthetic:true,checks},null,2)+'\n');console.log(JSON.stringify({checks:checks.length,passed:true,out}));
}finally{await browser.close();await fixture.stop();}
