import {writeFileSync, readFileSync, mkdirSync} from 'node:fs';
mkdirSync('output/telegram-progress',{recursive:true});
import {createServer} from 'node:http';
import {startFixture} from '../../scripts/ui-polish-fixture.mjs';
import {telegramProgressCard} from '../../dist/telegram-progress.js';
const fixture=await startFixture({sameTaskRevisions:true,longRequests:true});
const {store}=fixture;
const cards={};
// Deliberately synthetic success case; the other cases retain their failures.
const reviewedProof=store.proofVerdictFor(fixture.statusRuns.reviewing);
store.saveProofVerdict(fixture.statusRuns.reviewing,'verified',[],new Date(),reviewedProof.matrix.map(row=>({...row,state:'pass',detail:[],coverage:undefined,review:{judgement:'upholds',note:'Synthetic positive review example.',author:'reviewer:fixture'}})));
for (const [key,id] of Object.entries({...fixture.statusRuns,ready:fixture.runId})) {
  const run=store.getRun(id);
  if(run.role!=='builder')continue;
  const ref=store.refById(run.taskRef);
  cards[key]=telegramProgressCard(store,run,ref.externalId,ref.repo);
}
const reviewed=store.getRun(fixture.statusRuns.reviewing);
const currentReviewer=store.reviewRetryStateOf(reviewed.id)?.live;
if(currentReviewer) store.finishRun(currentReviewer.runId,{outcome:'no-change',reason:'Synthetic review complete',now:new Date()});
const reviewedRef=store.refById(reviewed.taskRef);
cards.complete=telegramProgressCard(store,reviewed,reviewedRef.externalId,reviewedRef.repo);
const long=store.getRun(fixture.runId);
store.handle.prepare('UPDATE task SET title=? WHERE id=?').run('Make acceptance review clearer across desktop and phone with evidence, readable requirements, and a concise next action for every saved result',fixture.tasks.done);
cards.long=telegramProgressCard(store,long,fixture.tasks.done,store.refById(long.taskRef).repo);
writeFileSync('output/telegram-progress/cards.json',JSON.stringify(cards,null,2));
const page=readFileSync(new URL('./preview.html',import.meta.url),'utf8').replace('CARDS_JSON',JSON.stringify(cards).replaceAll('<','\\u003c')).replace('FIXTURE_URL',fixture.url);
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(page)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
writeFileSync('output/telegram-progress/session.json',JSON.stringify({url,fixtureUrl:fixture.url,name:fixture.name,password:fixture.password,run:fixture.runId,task:fixture.tasks.done},null,2));
console.log(JSON.stringify({url,fixtureUrl:fixture.url,states:Object.keys(cards),synthetic:true}));
async function stop(){server.close();await fixture.stop();process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
