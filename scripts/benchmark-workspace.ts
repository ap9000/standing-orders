/** Repeatable, isolated scale probe. No provider, integration or production DB.
 * Run: node --import tsx scripts/benchmark-workspace.ts
 * Optional SO_SCALE_SAMPLES controls repetitions (default 12).
 * Synthetic history intentionally has no artifact files: list/catch-up must
 * use recorded metadata and must not walk or hash those paths. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openStore } from '../src/store.js';
import { workIndexPage, workCountsByProject } from '../src/work-index.js';
import { assignmentCatchUp } from '../src/assignment-brief.js';
import { browserCrewOf } from '../src/browser-workspace.js';
import { addApprover } from '../src/scope.js';
import { createDecisionServer } from '../src/serve.js';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'so-scale-')));
const file = join(directory, 'orders.db');
const store = openStore(file);
let server: Server | undefined;
const now = new Date('2026-09-21T00:00:00.000Z');
const access = { principal: 'operator' as const, repos: null, includeUnplaced: true };
const samples = Number(process.env.SO_SCALE_SAMPLES ?? 12);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100) throw Error('Samples must be 1–100');
try {
  console.error('Seeding isolated 10,000-task history');
  const repos = Array.from({ length: 100 }, (_, index) => {
    const repo = join(directory, `project-${index}`); mkdirSync(repo); return repo;
  });
  const task = store.handle.prepare('INSERT INTO task(id,title,state,created_at,updated_at) VALUES(?,?,?,?,?)');
  const ref = store.handle.prepare("INSERT INTO task_ref(backend,external_id,repo) VALUES('built-in',?,?)");
  const run = store.handle.prepare("INSERT INTO run(task_ref,lease_id,runner,branch,worktree,started_at,finished_at,outcome,handoff) VALUES(?,?,'synthetic','synthetic','/synthetic/unread',?,?,'failed',?)");
  const artifact = store.handle.prepare("INSERT INTO artifact(run,kind,key,bytes_original,bytes_stored,sha256,capture,created_at) VALUES(?,'handoff',?,4096,4096,?,'synthetic benchmark; files deliberately absent',?)");
  store.transact(() => {
    for (let p=0; p<100; p++) store.handle.prepare('INSERT INTO project(path,name,added_at,last_opened_at) VALUES(?,?,?,?)').run(repos[p]!, `Synthetic project ${p}`, now.toISOString(), now.toISOString());
    for (let i=0; i<10_000; i++) {
      const id = `scale-${String(i).padStart(5,'0')}`;
      const time = new Date(now.getTime() - i * 1000).toISOString();
      task.run(id, `Synthetic task ${i}: preserve the saved result and its project context`, i%10===0 ? 'cancelled' : i%3===0 ? 'failed' : 'queued', time, time);
      const taskRef = ref.run(id, repos[i%100]!).lastInsertRowid;
      for (let attempt=0; attempt<3; attempt++) {
        const runId = run.run(taskRef, `${id}-${attempt}`, time, time, `Synthetic historical output ${'x'.repeat(4000)}`).lastInsertRowid;
        for (let part=0; part<3; part++) artifact.run(runId, `synthetic/${runId}-${part}`, '0'.repeat(64), time);
      }
    }
  });
  const reads = {
    all: () => workIndexPage(store, now, access),
    needsYou: () => workIndexPage(store, now, access, { view: 'needs-you' }),
    project: () => workIndexPage(store, now, access, { project: repos[1]! }),
    projectCounts: () => workCountsByProject(store, now, access),
    crew: () => browserCrewOf(store, now, access),
    catchUp: () => assignmentCatchUp(store, now, access, { limit: 6 }),
  };
  const timings: Record<string, unknown> = {};
  for (const [name, read] of Object.entries(reads)) {
    console.error(`Reading ${name} (${samples} samples)`);
    const values: number[] = [];
    let bytes=0;
    for (let i=0; i<samples; i++) {
      const start=performance.now(), result=read();
      values.push(performance.now()-start); bytes=Buffer.byteLength(JSON.stringify(result));
      console.error(`  ${name} ${i + 1}: ${Math.round(values.at(-1)!)} ms, ${bytes} bytes`);
    }
    const sorted=[...values].sort((a,b)=>a-b);
    timings[name]={coldMs:Math.round(values[0]!),p50Ms:Math.round(sorted[Math.floor(sorted.length*.5)]!),p95Ms:Math.round(sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]!),bytes,samples};
  }
  const first=workIndexPage(store, now, access);
  const next=workIndexPage(store, now, access, {cursor:first.nextCursor});
  if(first.items.length!==40 || next.items.length!==40 || first.totals.all!==10_000 || first.items.some(one=>next.items.some(two=>one.rootId===two.rootId))) throw Error('Pagination check failed');
  const restricted=workIndexPage(store,now,{principal:'coordinator',repos:[repos[1]!]});
  if(restricted.totals.all!==100 || restricted.items.some(one=>one.repo!==repos[1])) throw Error('Permission check failed');

  const operator = addApprover(store, 'benchmark', now);
  if (!operator.ok) throw Error('Benchmark account failed');
  let providerCalls = 0;
  const refuseProvider = async (): Promise<never> => { providerCalls++; throw Error('Benchmark must not use a provider'); };
  server = createDecisionServer({ store, evidenceRoot: join(directory, 'absent-evidence'), clock: () => now, repos,
    chatEnv: {}, chatFetcher: refuseProvider as typeof fetch, subscriptionChatRunner: refuseProvider });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw Error('Benchmark server failed');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ name: 'benchmark', token: operator.token }) });
  if (login.status !== 303) throw Error('Benchmark login failed');
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const request = (path: string, etag?: string) => fetch(base + path, {
    redirect: 'manual', headers: { cookie, ...(etag ? { 'if-none-match': etag } : {}) },
  });
  let chatTag: string | null = null;
  const http: Record<string, unknown> = {};
  for (const [name, path, conditional] of [
    ['chatFresh', '/chat?format=workspace', false],
    ['chatUnchanged', '/chat?format=workspace', true],
    ['workWorkspace', '/work?format=workspace', false],
    ['workHtml', '/work', false],
  ] as const) {
    console.error(`HTTP ${name} ${path} (${samples} samples)`);
    const values: number[] = []; let bytes = 0;
    for (let index = 0; index < samples; index++) {
      if (conditional && chatTag === null) throw Error('Fresh chat response has no validator');
      const start = performance.now();
      const response = await request(path, conditional ? chatTag! : undefined);
      const body = await response.text(); values.push(performance.now() - start);
      if (response.status !== (conditional ? 304 : 200)) throw Error(`Unexpected ${name} status ${response.status}`);
      bytes = Buffer.byteLength(body);
      console.error(`  ${name} ${index + 1}: ${response.status}, ${Math.round(values.at(-1)!)} ms, ${bytes} bytes`);
      if (conditional && bytes !== 0) throw Error('Unchanged response has a body');
      if (name === 'chatFresh') chatTag = response.headers.get('etag');
      if (!conditional && path.includes('format=workspace')) {
        const workspace = JSON.parse(body);
        if (workspace.crew.length !== 40 || !workspace.crewTruncated) throw Error(`${name} did not admit the seeded crew`);
      }
    }
    const sorted = [...values].sort((a, b) => a - b);
    http[name] = { status: conditional ? 304 : 200, coldMs: Math.round(values[0]!),
      p50Ms: Math.round(sorted[Math.floor(sorted.length * .5)]!),
      p95Ms: Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)]!), bytes, samples };
  }
  if (providerCalls !== 0) throw Error('Benchmark attempted a provider call');
  console.log(JSON.stringify({synthetic:true,projects:100,tasks:10_000,runs:30_000,artifacts:90_000,databaseBytes:statSync(file).size,pagination:'passed',permissions:'passed',providerCalls,timings,http},null,2));
} finally {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  store.close(); rmSync(directory,{recursive:true,force:true});
}
