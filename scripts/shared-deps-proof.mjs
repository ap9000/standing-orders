#!/usr/bin/env node
// Shared dependencies, proved with real tools: for this repository and for
// ap9000/toolroll-example, a first checkout runs the real `npm ci` and its
// node_modules becomes the shared copy; a second checkout links it, and the
// typecheck, tests, build and a browser journey run in that second checkout
// through the link. Reports files and seconds per new checkout, before
// (its own `npm ci`) and after (the link), and checks the shared copy is
// byte-for-byte what it was when made. Build first (`npm run build`).
//
//   node scripts/shared-deps-proof.mjs [--example <path to toolroll-example>] [--only toolroll|example]
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { depsKey, linkedKey, linkInto, lockDigest, nodeIdentity, promoteInstall, readyCopy } from '../dist/shared-deps.js';

const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const here = resolve('.');
const example = resolve(arg('--example') ?? join(homedir(), 'Developer', 'toolroll-example'));
const only = arg('--only');
const out = resolve('evidence/shared-deps');
mkdirSync(out, { recursive: true });
const state = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-shared-deps-')));
const deps = join(state, 'deps');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.com', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.com' };

let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

/** Files under a folder, links not followed (a linked node_modules is one entry). */
function files(dir) {
  let count = 0;
  for (const one of readdirSync(dir, { withFileTypes: true })) {
    if (one.name === '.git') continue;
    count += one.isDirectory() ? files(join(dir, one.name)) : 1;
  }
  return count;
}
/** Every file in a tree with its bytes' hash: the shared copy must come out exactly as it went in. */
function treeHash(dir) {
  const hash = createHash('sha256');
  const walk = at => { for (const one of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(at, one.name);
    hash.update(path.slice(dir.length));
    if (one.isDirectory()) walk(path);
    else if (one.isSymbolicLink()) hash.update(`->${execFileSync('readlink', [path], { encoding: 'utf8' })}`);
    else hash.update(readFileSync(path));
  } };
  walk(dir);
  return hash.digest('hex');
}
const seconds = start => Math.round(performance.now() - start) / 1000;

/** A new checkout of the candidate as a lease makes it: tracked and new files of `source`, committed in a fresh repository. */
function checkoutOfWorkingTree(source, dest) {
  const listed = execFileSync('git', ['-C', source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of listed) {
    if (!existsSync(join(source, path)) || path.startsWith('STANDING-ORDERS-') || path === '.standing-orders-lease') continue;
    mkdirSync(dirname(join(dest, path)), { recursive: true });
    cpSync(join(source, path), join(dest, path), { verbatimSymlinks: true });
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dest });
  execFileSync('git', ['add', '.'], { cwd: dest });
  execFileSync('git', ['commit', '-qm', 'candidate'], { cwd: dest, env: gitEnv });
}
function checkoutOfClone(source, dest) {
  execFileSync('git', ['clone', '-q', source, dest]);
}

/** Runs one command in a checkout, foreground; records its exit and time. */
function check(cwd, label, command, args, env = {}) {
  const start = performance.now();
  const done = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
  const result = { label, command: [command, ...args].join(' '), exit: done.status, seconds: seconds(start), tail: `${done.stdout ?? ''}\n${done.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n') };
  console.log(`  ${done.status === 0 ? 'pass' : 'FAIL'}  ${label} (${result.seconds}s)`);
  if (done.status !== 0) console.log(result.tail);
  return result;
}

async function prove({ name, source, materialize, setup, checks, journey }) {
  console.log(`\n${name}`);
  const first = join(state, `${name}-first`), second = join(state, `${name}-second`);
  materialize(source, first);
  const node = nodeIdentity();
  const lock = lockDigest(first);
  if (node === null || lock === null) throw Error(`${name}: no node or no shareable lockfile`);
  const key = depsKey(name, 'proof-setup', lock, node);

  // Before: the checkout installs its own copy, as every checkout did.
  const installStart = performance.now();
  execFileSync('npm', setup, { cwd: first, stdio: 'inherit' });
  const before = { seconds: seconds(installStart), files: files(first), nodeModulesFiles: files(join(first, 'node_modules')) };
  if (promoteInstall({ root: deps, repo: name, worktree: first, key, lock, node, setupDigest: 'proof-setup', now: new Date() }) !== 'link') throw Error(`${name}: the first install did not become the shared copy`);
  const shared = readyCopy(deps, key);
  const sharedBefore = treeHash(shared);

  // After: a new checkout links the shared copy.
  materialize(source, second);
  const linkStart = performance.now();
  const wanted = depsKey(name, 'proof-setup', lockDigest(second), nodeIdentity());
  const how = linkInto(second, readyCopy(deps, wanted));
  const after = { seconds: seconds(linkStart), files: files(second), how };
  if (how !== 'link' || linkedKey(second, deps) !== key || !lstatSync(join(second, 'node_modules', '.package-lock.json')).isSymbolicLink()) throw Error(`${name}: the new checkout did not link the shared copy`);
  const gitStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: second, encoding: 'utf8' }).trim();
  console.log(`  before: own npm ci ${before.seconds}s, ${before.files} files (${before.nodeModulesFiles} in node_modules)`);
  console.log(`  after:  linked in ${after.seconds}s, ${after.files} files`);

  const results = checks.map(([label, command, args, env]) => check(second, label, command, args, env));
  results.push(await journey(second));
  const sharedAfter = treeHash(shared);
  const unchanged = sharedAfter === sharedBefore;
  console.log(`  ${unchanged ? 'pass' : 'FAIL'}  shared copy unchanged after every check`);
  return { name, key, node, before, after, gitStatusClean: gitStatus === '', checks: results, sharedUnchanged: unchanged, sharedBytesOnDisk: Number(execFileSync('du', ['-sk', shared], { encoding: 'utf8' }).split('\t')[0]) * 1024 };
}

/** A browser on the example's own built site through `vite preview`: the list renders, search filters it. */
async function exampleJourney(checkout) {
  const start = performance.now();
  const port = 4700 + Math.floor(Math.random() * 200);
  const preview = spawn(join(checkout, 'node_modules', '.bin', 'vite'), ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: checkout, stdio: 'ignore' });
  const browser = await pw.chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    for (let tries = 0; ; tries++) {
      try { await page.goto(`http://127.0.0.1:${port}/`); break; } catch (error) { if (tries > 50) throw error; await new Promise(done => setTimeout(done, 200)); }
    }
    await page.locator('#books li').first().waitFor();
    const all = await page.locator('#books li').count();
    await page.getByLabel('Search').fill('le guin');
    const found = await page.locator('#books li h2').allTextContents();
    await page.screenshot({ path: join(out, 'example-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(out, 'example-phone.png') });
    const ok = all === 6 && [...found].sort().join('|') === 'The Dispossessed|The Left Hand of Darkness';
    console.log(`  ${ok ? 'pass' : 'FAIL'}  browser journey: ${all} books, search "le guin" shows ${found.length}`);
    return { label: 'browser journey (vite preview + Chrome)', exit: ok ? 0 : 1, seconds: seconds(start), tail: `${all} books; search: ${found.join(', ')}` };
  } finally {
    await browser.close();
    preview.kill();
  }
}

/** This repository's flow gallery journey (a real console in Chrome, desktop and phone; no network, no model) in the linked checkout. */
function toolrollJourney(checkout) {
  const result = check(checkout, 'browser journey (scripts/flow-gallery-proof.mjs)', 'node', ['scripts/flow-gallery-proof.mjs'], { REAL_HOME: process.env.REAL_HOME ?? homedir() });
  const shots = join(checkout, 'evidence', 'flow-gallery');
  if (existsSync(shots)) for (const name of readdirSync(shots).filter(one => one.endsWith('.png')).slice(0, 1)) cpSync(join(shots, name), join(out, `toolroll-${name}`));
  return result;
}

const npmCi = ['ci', '--prefer-offline', '--no-audit', '--no-fund'];
const report = { at: new Date().toISOString(), node: nodeIdentity(), projects: [] };
if (only !== 'example') report.projects.push(await prove({
  name: 'toolroll', source: here, materialize: checkoutOfWorkingTree, setup: npmCi, journey: toolrollJourney,
  checks: [
    ['typecheck', 'npm', ['run', 'typecheck']],
    ['build', 'npm', ['run', 'build']],
    ['vitest (affected suites)', 'npx', ['vitest', 'run', 'src/shared-deps.test.ts', 'src/checkout-cleanup.test.ts', 'src/worktree.test.ts', 'src/builder.test.ts', 'src/proof.test.ts']],
  ],
}));
if (only !== 'toolroll') report.projects.push(await prove({
  name: 'toolroll-example', source: example, materialize: checkoutOfClone, setup: npmCi, journey: exampleJourney,
  checks: [
    ['typecheck', 'npx', ['tsc', '--noEmit']],
    ['npm test', 'npm', ['test']],
    ['build', 'npm', ['run', 'build']],
  ],
}));
writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const failed = report.projects.some(one => !one.sharedUnchanged || !one.gitStatusClean || one.checks.some(c => c.exit !== 0));
console.log(`\n${failed ? 'FAILED' : 'All passed'}; report in ${join(out, 'report.json')}; scratch in ${state}`);
process.exit(failed ? 1 : 0);
