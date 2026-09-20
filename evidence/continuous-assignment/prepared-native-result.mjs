import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {openStore, SCHEMA_VERSION} from '/Users/alekseypelletier/Developer/standing-orders-assignment-release/src/store.ts';
import {assignmentOf, assignmentEvidenceIntact} from '/Users/alekseypelletier/Developer/standing-orders-assignment-release/src/assignment.ts';
const repo='/Users/alekseypelletier/Developer/standing-orders-assignment-release';
const copy=readFileSync('/tmp/so-assignment-prepared-result-copy.txt','utf8');
const store=openStore(copy);
try {
 const assignment=assignmentOf(store,'native-interface-ui-release-20260920',new Date(),{principal:'operator',repos:null,includeUnplaced:true});
 const receipt=assignment?.receipt;
 const result={kind:'isolated saved native prepared-candidate handoff canary',sourceDatabase:'Read-only backup; only isolated copy migrated',schema:SCHEMA_VERSION,sourceSha256:Object.fromEntries(['src/assignment.ts','src/store.ts','src/evidence.ts','src/verification-evidence.ts','src/review-context.ts'].map(f=>[f,createHash('sha256').update(readFileSync(repo+'/'+f)).digest('hex')])),task:assignment?.rootId,state:assignment?.state,completionKind:receipt?.completionKind,run:receipt?.runId,head:receipt?.head,base:receipt?.base,scopeDigest:receipt?.scopeDigest,artifacts:receipt?.artifacts.length,freshEvidenceIntact:receipt?assignmentEvidenceIntact(store,'/Users/alekseypelletier/.config/standing-orders/evidence',receipt):null};
 result.passed=result.state==='ready-to-check'&&result.completionKind==='verified-build'&&result.run===1907&&result.head==='7ee7a28a39c03ec08295468bdb82521c7ca85542'&&result.freshEvidenceIntact===true;
 console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}finally{store.close();}
