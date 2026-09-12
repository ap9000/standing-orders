/** A real provider leaves an opaque dirty draft before the operator stops it.
 * The next invocation must retain that draft, not recreate a known answer. */
export function taskControlFixture() {
  const goal = 'Create result.txt with first line "Draft ready". Before completing, run node checkpoint.mjs. Its FIRST invocation appends an opaque draft line, records a checkpoint and waits for the operator to stop this attempt. This wait is an intentional stop/resume certification barrier: do not bypass it or complete while it waits. A resumed attempt must keep every existing line of result.txt, run node checkpoint.mjs again (it then verifies the preserved draft and exits), and append "Completed" on its own final line. Run npm test and submit this attempt\'s fresh handoff and proof. Only result.txt may change. Keep the filed goal, exclusions and rubric intact.';
  const acceptance = [
    { id: 'preserved', statement: 'The resumed result retains the opaque draft line appended by the first checkpoint.', evidence: ['check'] },
    { id: 'completed', statement: 'result.txt begins with Draft ready and ends with Completed on its own line.', evidence: ['check', 'changed-path'] },
    { id: 'fresh-check', statement: 'npm test passes after the resumed attempt proves draft retention at the second checkpoint.', evidence: ['check'] },
  ];
  const checkpoint = `import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
const state='output/checkpoint.json';mkdirSync('output',{recursive:true});
if(!existsSync(state)) {
 const before=readFileSync('result.txt','utf8');assert.equal(before,'Draft ready\\n');
 const line='Preserved draft '+randomUUID();appendFileSync('result.txt',line+'\\n');
 const draft=readFileSync('result.txt','utf8');
 writeFileSync(state,JSON.stringify({pid:process.pid,draft,line,sha256:createHash('sha256').update(draft).digest('hex')}));
 const beat=()=>{appendFileSync('output/heartbeat.log','beat\\n');console.log('Waiting for the operator stop/resume checkpoint');};
 beat();setInterval(beat,1000);
} else {
 const original=JSON.parse(readFileSync(state,'utf8'));
 assert(readFileSync('result.txt','utf8').startsWith(original.draft),'The original dirty draft was replaced');
 writeFileSync('output/resumed.json',JSON.stringify({pid:process.pid,originalSha256:original.sha256}));
 console.log('PASS: original opaque draft retained by a new checkpoint process');
}
`;
  const verify = `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const original=JSON.parse(readFileSync('output/checkpoint.json','utf8'));
const resumed=JSON.parse(readFileSync('output/resumed.json','utf8'));
const result=readFileSync('result.txt','utf8');
assert.equal(resumed.originalSha256,original.sha256);
assert.notEqual(resumed.pid,original.pid);
assert.equal(result,original.draft+'Completed\\n');
console.log('PASS: original opaque draft retained, second checkpoint completed, result finalized');
`;
  return { goal, acceptance, exclusions: 'Do not modify checkpoint.mjs, verify.mjs, package.json, README.md or .gitignore. Do not bypass the first checkpoint wait, replace the opaque draft, change scope, publish, or add dependencies.', files: {
    'package.json': JSON.stringify({name:'standing-orders-task-control-fixture',private:true,type:'module',scripts:{test:'node verify.mjs'}},null,2)+'\n',
    '.gitignore':'output/\nnode_modules/\n',
    'README.md':'# Stop/resume certification\n\nOnly result.txt changes. Follow the filed checkpoint sequence.\n',
    'checkpoint.mjs':checkpoint,
    'verify.mjs':verify,
  }};
}
