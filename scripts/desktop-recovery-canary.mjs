#!/usr/bin/env node
/** Disposable macOS service/controller recovery; never logs out or reboots. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,statSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
function option(name){const at=args.indexOf(name);if(at===-1)return null;if(!args[at+1]||args[at+1].startsWith('--'))throw Error(`${name} needs a value`);return args[at+1];}
if(process.platform!=='darwin')throw Error('This certificate exercises macOS launchd.');
const output=resolve(option('--output')??join(source,'output/desktop-recovery.json'));
const app=option('--app');
let runtimeRoot=join(source,'dist'),node=process.execPath;
if(app){const resources=join(resolve(app),'Contents/Resources');const runtime=JSON.parse(readFileSync(join(resources,'runtime.json'),'utf8'));node=resolve(resources,runtime.node);runtimeRoot=join(resources,'dist');}
const {loadOrCreateDesktopConfig,writeDesktopConfig,openDesktopStore,pairDesktopLogin,addDesktopProjects}=await import(pathToFileURL(join(runtimeRoot,'desktop-host.js')));
const {runOperate}=await import(pathToFileURL(join(runtimeRoot,'operate.js')));
function hashTree(root){const hash=createHash('sha256');function walk(dir,prefix='dist'){for(const name of readdirSync(dir).sort((a,b)=>a.localeCompare(b))){const file=join(dir,name),relative=`${prefix}/${name}`;if(statSync(file).isDirectory())walk(file,relative);else hash.update(relative).update('\0').update(readFileSync(file)).update('\0');}}walk(root);return hash.digest('hex');}
const runtimeHash=hashTree(runtimeRoot);
const nodeHash=createHash('sha256').update(readFileSync(node)).digest('hex');
const root=realpathSync(mkdtempSync(join(tmpdir(),'standing-orders-controller-cert-')));
const state=join(root,'state');mkdirSync(state,{mode:0o700});
const projectParent=option('--project-parent');
const repo=projectParent?realpathSync(mkdtempSync(join(resolve(projectParent),'standing-orders-recovery-project-'))):join(root,'repo');if(!projectParent)mkdirSync(repo);
execFileSync('git',['init','-q',repo]);writeFileSync(join(repo,'README.md'),'Retained recovery fixture.\n');
execFileSync('git',['-C',repo,'add','README.md']);execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','baseline']);
const revision=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const config=loadOrCreateDesktopConfig(state,true);
const reservation=createServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done));config.port=reservation.address().port;await new Promise(done=>reservation.close(done));writeDesktopConfig(state,config);
const login={name:'recovery-fixture',password:randomBytes(24).toString('hex')};
let store=openDesktopStore(config.databaseFile);
pairDesktopLogin(store,join(state,'up-login.txt'),login);await addDesktopProjects(state,store,[repo]);store.close();
const filed=[];const code=await runOperate('task',['add','Retained unsigned task','--id','retained-restart-task','--db',config.databaseFile,'--repo',repo,'--json'],line=>filed.push(line));assert.equal(code,0);
const uid=process.getuid();const label='com.standing-orders.cert.'+randomBytes(8).toString('hex');const service=`gui/${uid}/${label}`;
const plist=join(root,`${label}.plist`);
const env={PATH:[dirname(node),'/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),XDG_CONFIG_HOME:join(root,'config')};
const {launchdPlist}=await import(pathToFileURL(join(runtimeRoot,'daemon.js')));
writeFileSync(plist,launchdPlist({label,command:[node,join(runtimeRoot,'desktop-host.js'),'serve','--state',state],workingDirectory:state,pathEnv:env.PATH,environment:env,logPath:join(root,'service.log')}),{mode:0o600});
const launch=(...a)=>execFileSync('/bin/launchctl',a,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:75000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={version:1,root,repo,service,runtimeHash,nodeHash,nodeVersion:execFileSync(node,['--version'],{encoding:'utf8'}).trim(),bootId:execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'}).trim(),scriptHash:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),sourceRevision:execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),startedAt:new Date().toISOString(),cases:[],manualRescues:0,limits:['Controller crash recovery under an already activated LaunchAgent.','Initial activation uses explicit kickstart; no claim of automatic launchd relaunch, login or physical reboot.','A retained unsigned task proves persistence; this fixture does not invoke a provider.']};
const statusFile=join(state,'controller-supervisor.json');
function status(){return JSON.parse(readFileSync(statusFile,'utf8'));}
function lease(){const db=openDesktopStore(config.databaseFile);try{return db.handle.prepare('SELECT owner,heartbeat_at,expires_at FROM watch_lease WHERE repo=?').get(repo);}finally{db.close();}}
async function health(){const challenge=randomBytes(32).toString('hex');const {createHmac}=await import('node:crypto');const expected=createHmac('sha256',Buffer.from(config.identity,'hex')).update(challenge).digest('hex');try{const response=await fetch(`http://127.0.0.1:${config.port}/desktop/health?challenge=${challenge}`,{signal:AbortSignal.timeout(1500)});return response.ok&&(await response.json()).proof===expected;}catch{return false;}}
async function waitFor(fn,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(error){last=error;}await sleep(200);}throw Error(`Recovery deadline exceeded${last?': '+last.message:''}`);}
function unchanged(){assert.equal(createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),report.scriptHash,'certificate script changed');assert.equal(hashTree(runtimeRoot),runtimeHash,'runtime changed during certification');assert.equal(createHash('sha256').update(readFileSync(node)).digest('hex'),nodeHash);assert.equal(execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),revision);const db=openDesktopStore(config.databaseFile);try{assert.equal(db.listTasks().find(x=>x.id==='retained-restart-task')?.state,'queued');assert.equal(db.handle.prepare('SELECT count(*) n FROM run').get().n,0);assert.equal(db.handle.prepare('SELECT count(*) n FROM watch_lease WHERE repo=? AND expires_at>?').get(repo,new Date().toISOString()).n,1);}finally{db.close();}}
let loaded=false;
try{
 launch('bootstrap',`gui/${uid}`,plist);loaded=true;launch('kickstart',service);
 await waitFor(async()=>existsSync(statusFile)&&status().phase==='running'&&lease()&&await health());
 const first=status();let beforeLease=lease();assert.equal(first.generation,1);unchanged();
 report.initial={supervisorPid:first.supervisorPid,controllerPid:first.controllerPid,lease:beforeLease};
 for(const signal of ['SIGTERM','SIGKILL']){
  const before=status();const parent=Number(execFileSync('/bin/ps',['-o','ppid=','-p',String(before.controllerPid)],{encoding:'utf8'}).trim());
  const servicePid=Number(/pid = (\d+)/.exec(launch('print',service))?.[1]);
  assert.equal(parent,first.supervisorPid,'fault injection requires current child ancestry');assert.equal(servicePid,first.supervisorPid,'fault injection requires the same active service');
  const at=Date.now();process.kill(before.controllerPid,signal);
  const after=await waitFor(async()=>{const current=status();const next=lease();return current.phase==='running'&&current.generation>before.generation&&current.supervisorPid===first.supervisorPid&&next&&next.owner!==beforeLease.owner&&Date.parse(next.heartbeat_at)>=at&&await health()?{status:current,lease:next}:null;},240000);
  unchanged();report.cases.push({fault:signal==='SIGTERM'?'clean-controller-exit':'controller-sigkill',elapsedMs:Date.now()-at,generation:after.status.generation,controllerPid:after.status.controllerPid,lease:after.lease});beforeLease=after.lease;console.log(JSON.stringify(report.cases.at(-1)));
 }
 launch('bootout',service);loaded=false;await waitFor(()=>status().phase==='stopped');assert.equal(await health(),false);report.explicitStop=true;report.passed=true;
}catch(error){report.passed=false;report.error=error instanceof Error?error.message:String(error);try{writeFileSync(join(root,"launchctl-failure.txt"),launch("print",service),{mode:0o600});}catch{}process.exitCode=1;}
finally{
 if(loaded){try{launch('bootout',service);}catch{}}
 report.finishedAt=new Date().toISOString();mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({passed:report.passed,output,root,error:report.error}));
}
