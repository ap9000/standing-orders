import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryContext, repositoryContextRead } from './repository-context.js';

describe('optional repository context', () => {
  let root: string, repo: string, cacheRoot: string, head: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const put = (file: string, text: string) => writeFileSync(join(repo, file), text);
  const context = (query: string, options: Partial<Parameters<typeof repositoryContext>[0]> = {}) => repositoryContext({ repo, cacheRoot, query, ...options });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'so-repository-context-'))); repo = join(root, 'repo'); cacheRoot = join(root, 'cache'); mkdirSync(join(repo, 'src'), { recursive: true });
    git('init', '-q'); git('config', 'user.name', 'Context Test'); git('config', 'user.email', 'context@example.invalid');
    put('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/*'] }, module: 'NodeNext', moduleResolution: 'NodeNext' } }));
    put('src/session.ts', 'export function saveSession(name: string) { return { name }; }\n');
    put('src/client.ts', "import { saveSession as persist } from '@lib/session';\nexport function startSession() { return persist('demo'); }\n");
    put('src/index.ts', "export { startSession } from './client.js';\n");
    put('src/lazy.ts', "export async function loadSession() { return import('./session.js'); }\n");
    put('README.md', '# Sessions\nStore sessions locally.\n');
    git('add', '.'); git('commit', '-qm', 'fixture'); head = git('rev-parse', 'HEAD');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('ordinary search works before indexing and has source hashes and locations', async () => {
    const result = await context('saveSession');
    expect(result.index).toMatchObject({ status: 'missing', engine: 'text-search' });
    expect(result.checkout).toMatchObject({ repo, head, baseRevision: head });
    expect(result.excerpts).toContainEqual(expect.objectContaining({ file: 'src/session.ts', line: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), text: expect.stringContaining('saveSession') }));
    expect(readdirSync(root)).toEqual(['repo']);
  });

  test('native AST resolves TS aliases, ESM re-exports and literal dynamic imports', async () => {
    const result = await context('src/session.ts', { mode: 'impact', refresh: true });
    expect(result.index).toMatchObject({ status: 'ready', engine: 'typescript-ast', extractor: expect.stringContaining('6.0.3') });
    expect(result.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/client.ts', to: 'src/session.ts', kind: 'imports', provenance: 'explicit', line: 1 }),
      expect.objectContaining({ from: 'src/lazy.ts', to: 'src/session.ts', kind: 'dynamic-import' }),
      expect.objectContaining({ from: 'src/index.ts', to: 'src/client.ts', kind: 're-exports' }),
    ]));
    expect(result.excerpts.map(x => x.file)).toEqual(expect.arrayContaining(['src/client.ts', 'src/index.ts', 'src/lazy.ts']));
    const cached = await context('saveSession');
    expect(cached.index.generation).toBe(result.index.generation);
    expect(cached.excerpts.some(x => x.symbol === 'saveSession')).toBe(true);
  });

  test('a same-mtime dirty edit invalidates the cached map and supplies current text', async () => {
    const before = await context('saveSession', { refresh: true });
    put('src/session.ts', 'export function saveSession(name: string) { return { changed: name }; }\n');
    utimesSync(join(repo, 'src/session.ts'), new Date(0), new Date(0));
    const changed = await context('saveSession', { mode: 'impact' });
    expect(changed.index.status).toBe('stale'); expect(changed.relationships).toEqual([]);
    expect(changed.checkout!.sourceHash).not.toBe(before.checkout!.sourceHash);
    expect(changed.excerpts.find(x => x.file === 'src/session.ts')!.text).toContain('changed');
    expect(changed.warnings).toContain('These are text matches, not an impact analysis.');
  });

  test('deleted tracked files cannot leak retained index excerpts or relationships', async () => {
    await context('session', { refresh: true }); rmSync(join(repo, 'src/session.ts'));
    const result = await context('session');
    expect(result.index.status).toBe('stale'); expect(result.excerpts.some(x => x.file === 'src/session.ts')).toBe(false);
    expect(result.omissions.files).toBe(1);
  });

  test('separate worktrees never share a cache identity even at the same commit', async () => {
    await context('session', { refresh: true });
    const worktree = join(root, 'crew'); git('worktree', 'add', '--detach', '-q', worktree, head);
    const result = await context('session', { repo: worktree });
    expect(result.index.status).toBe('missing'); expect(result.checkout!.gitDir).not.toBe(join(repo, '.git'));
    expect(result.checkout!.repo).toBe(worktree);
  });

  test('base identity is exact and retained independently of current checkout head', async () => {
    put('README.md', '# Updated sessions\n'); git('add', '.'); git('commit', '-qm', 'advance');
    const result = await context('session', { baseRevision: head, refresh: true });
    expect(result.checkout!.baseRevision).toBe(head); expect(result.checkout!.head).not.toBe(head);
    expect((await context('session')).index.status).toBe('missing');
    expect((await context('session', { baseRevision: 'main; not a revision' })).checkout).toBeNull();
    expect(repositoryContextRead({ repo, query: 'session', audience: 'crew', baseRevision: head }).checkout).toBeNull();
  });

  test('a crew worktree must belong to the admitted project', () => {
    const other = join(root, 'other'); mkdirSync(other);
    execFileSync('git', ['-C', other, 'init', '-q']);
    const result = repositoryContextRead({ repo, project: other, query: 'session', audience: 'crew', baseRevision: head });
    expect(result.checkout).toBeNull(); expect(result.excerpts).toEqual([]);
  });

  test('corrupt cache is a visible ordinary-search fallback and explicit refresh repairs it', async () => {
    await context('session', { refresh: true });
    const path = join(cacheRoot, readdirSync(cacheRoot)[0]!); const previous = readFileSync(path, 'utf8');
    writeFileSync(path, previous.replace('saveSession', 'notSession'));
    const result = await context('saveSession'); expect(result.index.status).toBe('unavailable'); expect(result.excerpts.length).toBeGreaterThan(0);
    expect((await context('saveSession', { refresh: true })).index.status).toBe('ready');
  });

  test('symlinks, untracked files, sensitive files and oversized sources are excluded', async () => {
    writeFileSync(join(root, 'private.txt'), 'session PRIVATE OUTSIDE DATA'); symlinkSync(join(root, 'private.txt'), join(repo, 'private.txt'));
    put('untracked.txt', 'session UNTRACKED DATA');
    put('src/large.ts', '// session\n' + 'x'.repeat(256_000));
    put('src/secret.ts', 'const key = "AKIA1234567890ABCDEF"; // session\n'); git('add', 'private.txt', 'src/large.ts', 'src/secret.ts');
    const result = await context('session', { refresh: true });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE OUTSIDE DATA|UNTRACKED DATA|AKIA1234567890ABCDEF/);
    expect(result.omissions.files).toBeGreaterThanOrEqual(3);
  });

  test('ambiguous symbol impact does not invent a dependency path', async () => {
    put('src/duplicate.ts', 'export function saveSession() { return 2; }\n'); git('add', 'src/duplicate.ts');
    const result = await context('saveSession', { mode: 'impact', refresh: true });
    expect(result.warnings.some(w => w.includes('several files'))).toBe(true);
    expect(result.relationships).toEqual([]);
  });

  test('read and relationship output remains bounded with long Unicode source', async () => {
    put('src/session.ts', 'export function saveSession() { return "' + '文'.repeat(9000) + '"; }\n');
    const result = await context('session', { refresh: true, audience: 'crew', maxBytes: 4000 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4000);
    expect(result.omissions.excerpts).toBeGreaterThan(0);
    const longQuery=await context('文'.repeat(1000),{audience:'crew',maxBytes:3000});
    expect(Buffer.byteLength(JSON.stringify(longQuery))).toBeLessThanOrEqual(3000);
    expect(longQuery.warnings.some(w=>w.includes('shortened'))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(await context('文'.repeat(1000),{repo:join(root,'missing'),maxBytes:3000})))).toBeLessThanOrEqual(3000);
  });

  test('index write refusal does not prevent bounded source search', async () => {
    const result = await context('session', { refresh: true, cacheRoot: join(repo, '.context') });
    expect(result.index.status).toBe('unavailable'); expect(result.excerpts.length).toBeGreaterThan(0);
    expect(readdirSync(repo)).not.toContain('.context');
  });
});
