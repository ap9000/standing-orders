import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runKnowledgeCommand } from './knowledge-cli.js';
import { mintCoordinator, revokeCoordinator } from './coordinator.js';
import { openStore, type Store } from './store.js';
import { main } from './cli.js';

describe('knowledge command source authority and public entry point', () => {
  let root: string, repo: string, db: string, store: Store, token: string, cid: string;
  const now = new Date('2026-09-20T20:00:00Z');
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'so-knowledge-cli-'))); repo = join(root, 'repo'); mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    git('init', '-q'); writeFileSync(join(repo, 'session.ts'), 'export function saveSession() { return 1; }\n'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
    db = join(root, 'orders.db'); store = openStore(db);
    const made = mintCoordinator(store, { name: 'source-reader', repos: [repo], by: 'operator', now });
    if (!made.ok) throw Error('fixture'); token = made.token; cid = made.cid;
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  async function run(args: string[], flags: Record<string, string | true> = {}, env: NodeJS.ProcessEnv = {}) {
    const lines: string[] = [];
    const code = await runKnowledgeCommand(args, new Map(Object.entries({ repo, json: true, ...flags })), { store, now, env, json: true, evidenceRoot: join(root, 'evidence'), write: line => lines.push(line) });
    expect(lines).toHaveLength(1); return { code, body: JSON.parse(lines[0]!), raw: lines[0]! };
  }
  test('local reads and admitted credential reads share a bounded typed response', async () => {
    const local = await run(['search', 'saveSession']);
    expect(local).toMatchObject({ code: 0, body: { envelopeVersion: 1, ok: true, result: { index: { engine: 'text-search' } } } });
    const admitted = await run(['search', 'saveSession'], { 'token-env': 'LEAD' }, { LEAD: token });
    expect(admitted.body.result.excerpts).toEqual(local.body.result.excerpts);
  });
  test('invalid, missing and revoked explicit credentials never become local reads', async () => {
    expect((await run(['search', 'saveSession'], { 'token-env': 'LEAD' })).body).toMatchObject({ ok: false, reason: 'unauthenticated' });
    expect((await run(['search', 'saveSession'], { 'token-env': 'LEAD' }, { LEAD: 'invalid' })).body).toMatchObject({ ok: false, reason: 'unauthenticated' });
    revokeCoordinator(store, cid, 'operator', now);
    const revoked = await run(['search', 'saveSession'], { 'token-env': 'LEAD' }, { LEAD: token });
    expect(revoked.code).toBe(3); expect(revoked.raw).not.toContain('return 1'); expect(revoked.raw).not.toContain(token);
  });
  test('foreign and absent paths are identically refused before any source reading', async () => {
    const foreign = join(root, 'private'); mkdirSync(foreign); writeFileSync(join(foreign, 'secret.ts'), 'PRIVATE DATA');
    const first = await run(['search', 'PRIVATE'], { repo: foreign, 'token-env': 'LEAD' }, { LEAD: token });
    const second = await run(['search', 'PRIVATE'], { repo: join(root, 'absent'), 'token-env': 'LEAD' }, { LEAD: token });
    expect(first.body).toEqual(second.body); expect(first.body).toMatchObject({ ok: false, reason: 'not-found' });
  });
  test('descriptors reject malformed arguments instead of accepting ignored flags', async () => {
    expect((await run(['search', 'session'], { yes: true })).code).toBe(2);
    expect((await run(['refresh', 'session'])).code).toBe(2);
    expect((await run(['impact', 'session'], { base: 'HEAD' })).code).toBe(2);
    expect((await run(['search', 'session'], { 'token-env': 'LEAD', 'token-file': 'file' })).code).toBe(2);
  });
  test('real CLI parser routes refresh and authenticated search through one JSON envelope', async () => {
    const tokenFile = join(root, 'lead.token'); writeFileSync(tokenFile, token, { mode: 0o600 });
    for (const args of [['refresh'], ['search', 'saveSession'], ['impact', 'session.ts']]) {
      const lines: string[] = [];
      expect(await main(['knowledge', ...args, '--repo', repo, '--token-file', tokenFile, '--json'], line => lines.push(line), { operate: { databaseFile: db, now } })).toBe(0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ envelopeVersion: 1, ok: true, command: `knowledge ${args[0]}`, result: { index: { status: 'ready' } } });
    }
  });
});
