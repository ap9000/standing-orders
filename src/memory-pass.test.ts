import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from './store.js';
import { addApprover } from './scope.js';
import { changeKnowledge, knowledgeView } from './project-knowledge.js';
import { listDecisions } from './project-memory.js';
import { analysisPrompt, claudeProjectDir, collectSessions, decideProposal, distillClaude, listProposals, memoryStatus, memorySurface, parseVerdict, runMemoryPass, type MemoryAnalyzer } from './memory-pass.js';
import { runMemoryCommand } from './memory-cli.js';

describe('the backward pass over project memory', () => {
  let root: string, repo: string, home: string, store: Store;
  const now = new Date('2026-09-21T23:00:00Z');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const line = (type: 'user' | 'assistant', content: unknown) => JSON.stringify({ type, cwd: repo, sessionId: 's', message: { role: type, content } });
  function claudeSession(name: string, lines: string[]) {
    const dir = claudeProjectDir(repo, home); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.jsonl`), lines.join('\n') + '\n');
  }
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-pass-'))); repo = join(root, 'repo'); home = join(root, 'home'); mkdirSync(repo); mkdirSync(home);
    git('init', '-q'); writeFileSync(join(repo, 'README.md'), 'seed\n'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'seed');
    store = openStore(join(root, 'test.db'));
    const user = addApprover(store, 'alex', now); if (!user.ok) throw Error('fixture');
    changeKnowledge(store, { repo, actor: 'alex', identity: knowledgeView(store, repo, 'alex').identity, revision: 0, action: 'instructions', draft: { instructions: 'Run the focused tests before handing off.\nNever rewrite the lockfile.' } }, now);
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  test('distillation keeps words, collapses tools, drops thinking and redacts a secret-bearing line', () => {
    claudeSession('one', [
      line('user', 'Please add the footer year.'),
      line('assistant', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Adding it now.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- footer' } }]),
      line('user', [{ type: 'tool_result', content: 'x'.repeat(500) }]),
      line('assistant', [{ type: 'text', text: 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked' }]),
    ]);
    const trace = distillClaude(join(claudeProjectDir(repo, home), 'one.jsonl'));
    expect(trace).toContain('user: Please add the footer year.');
    expect(trace).toContain('tool Bash: {"command":"npm test -- footer"}');
    expect(trace).not.toContain('private reasoning');
    expect(trace).not.toContain('sk-ant-api03');
    expect(trace).toContain('[redacted');
    expect(trace.split('\n').find(l => l.startsWith('result:'))!.length).toBeLessThan(220);
  });

  test('a verdict keeps only claims whose quote is in the trace, and the prompt names instructions by stable id', () => {
    const surface = memorySurface(store, repo, 'alex');
    expect(surface.instructions.map(i => i.id)).toEqual(['IN-001', 'IN-002']);
    expect(analysisPrompt(surface, [{ key: 'k1', mistake: 'forgot the year' }])).toContain('[IN-001] Run the focused tests before handing off.');
    const trace = 'user: ship it\nassistant: I skipped the tests and pushed.';
    const verdict = parseVerdict('```json\n' + JSON.stringify({ positive: [{ instruction: 'IN-001', effect: 'x', quote: 'not in trace at all here' }], negative: [{ instruction: 'IN-001', effect: 'skipped', class: 'non-compliance', quote: 'I skipped the tests and pushed.' }], gaps: [{ mistake: 'pushed without asking', proposedInstruction: 'Never push without an explicit request.', domain: 'project', quote: 'I skipped the tests and pushed.' }, { mistake: 'no quote', proposedInstruction: 'x', domain: 'project', quote: 'missing' }] }) + '\n```', trace, surface)!;
    expect(verdict.positive).toEqual([]);
    expect(verdict.negative).toHaveLength(1);
    expect(verdict.gaps.map(g => g.mistake)).toEqual(['pushed without asking']);
    expect(parseVerdict('no json here', trace, surface)).toBeNull();
  });

  test('the pass reads local sessions and plane runs, corroborates a gap across two sessions before proposing, caches per surface, remembers rejections, and accept writes through the knowledge store', async () => {
    claudeSession('a', [line('user', 'Fix the footer'), line('assistant', [{ type: 'text', text: 'I pushed to main directly to save time.' }])]);
    claudeSession('b', [line('user', 'Update the header'), line('assistant', [{ type: 'text', text: 'Pushed straight to main, no review needed.' }])]);
    const calls: string[] = [];
    const analyzer: MemoryAnalyzer = async input => {
      calls.push(input.kind);
      const quote = input.trace.includes('pushed to main directly') ? 'I pushed to main directly to save time.' : input.trace.includes('Pushed straight to main') ? 'Pushed straight to main, no review needed.' : null;
      if (quote === null) return { ok: true, text: JSON.stringify({ positive: [], negative: [], gaps: [] }) };
      return { ok: true, text: JSON.stringify({ positive: [], negative: [], gaps: [{ mistake: 'pushed to main without a pull request', proposedInstruction: 'Never push to main; open a pull request.', domain: 'project', quote, ...(input.openGaps[0] ? { matchesGap: input.openGaps[0].key } : {}) }] }) };
    };
    // First session alone: a gap on the books, no proposal yet.
    writeFileSync(join(claudeProjectDir(repo, home), 'b.jsonl'), '');
    let report = await runMemoryPass(store, { repo, actor: 'alex', analyzer, home, local: true }, now);
    expect(report).toMatchObject({ sessions: 2, analyzed: 1, gaps: 1, proposals: 0 });
    // The second session corroborates it.
    claudeSession('b', [line('user', 'Update the header'), line('assistant', [{ type: 'text', text: 'Pushed straight to main, no review needed.' }])]);
    report = await runMemoryPass(store, { repo, actor: 'alex', analyzer, home, local: true }, now);
    expect(report).toMatchObject({ sessions: 2, analyzed: 1, cached: 1, gaps: 1, proposals: 1 });
    const [proposal] = listProposals(store, repo);
    expect(proposal).toMatchObject({ kind: 'instruction-add', afterText: 'Never push to main; open a pull request.', sessions: 2 });
    expect(proposal!.evidence.map(e => e.quote).sort()).toEqual(['I pushed to main directly to save time.', 'Pushed straight to main, no review needed.']);
    // A third pass changes nothing: every session is cached under this surface.
    report = await runMemoryPass(store, { repo, actor: 'alex', analyzer, home, local: true }, now);
    expect(report).toMatchObject({ analyzed: 0, cached: 2, proposals: 0 });
    // Reject: remembered; the same corroboration does not re-propose.
    decideProposal(store, { repo, actor: 'alex', id: proposal!.id, decision: 'reject' }, now);
    expect(listProposals(store, repo)).toEqual([]);
    report = await runMemoryPass(store, { repo, actor: 'alex', analyzer, home, local: true }, now);
    expect(report.proposals).toBe(0);
    // A third distinct session lifts the corroboration above the rejection.
    claudeSession('c', [line('user', 'Change the nav'), line('assistant', [{ type: 'text', text: 'I pushed to main directly to save time.' }])]);
    report = await runMemoryPass(store, { repo, actor: 'alex', analyzer, home, local: true }, now);
    expect(report.proposals).toBe(1);
    const again = listProposals(store, repo)[0]!;
    expect(again.sessions).toBe(3);
    decideProposal(store, { repo, actor: 'alex', id: again.id, decision: 'accept' }, now);
    expect(knowledgeView(store, repo, 'alex').knowledge.instructions).toContain('Never push to main; open a pull request.');
    expect(knowledgeView(store, repo, 'alex').revision).toBe(2);
    // The surface changed: sessions are analysed again, the gap is retired as covered.
    const status = memoryStatus(store, repo, 'alex');
    expect(status.pending).toBe(0);
    expect(status.openGaps).toBe(0);
    expect(calls.every(kind => kind === 'claude')).toBe(true);
    expect(collectSessions(store, repo, { home, local: false })).toEqual([]);
  });

  test('harm from following an instruction proposes its removal; an over-budget addition becomes a decision proposal; the CLI drives it', async () => {
    const long = 'x'.repeat(3960);
    changeKnowledge(store, { repo, actor: 'alex', identity: knowledgeView(store, repo, 'alex').identity, revision: 1, action: 'instructions', draft: { instructions: `Never rewrite the lockfile.\n${long}` } }, now);
    for (const name of ['a', 'b']) claudeSession(name, [line('user', 'Upgrade the dependency'), line('assistant', [{ type: 'text', text: `Kept the stale lockfile as instructed and the build broke in session ${name}.` }])]);
    const analyzer: MemoryAnalyzer = async input => {
      const quote = /Kept the stale lockfile as instructed and the build broke in session [ab]\./.exec(input.trace)?.[0] ?? '';
      const lockfile = input.surface.instructions.find(i => i.text === 'Never rewrite the lockfile.');
      return { ok: true, text: JSON.stringify({ positive: [], negative: lockfile ? [{ instruction: lockfile.id, effect: 'the build broke', class: 'harm', quote }] : [], gaps: [{ mistake: 'a dependency upgrade needs the lockfile regenerated', proposedInstruction: 'Regenerate the lockfile when upgrading a dependency.', domain: 'project', quote }] }) };
    };
    const lines: string[] = [];
    const context = { store, write: (l: string) => lines.push(l), json: true, now, actor: 'alex', repos: [repo], analyzer, home };
    expect(await runMemoryCommand(['propose'], new Map([['repo', repo]]), context)).toBe(0);
    const report = JSON.parse(lines.at(-1)!).report;
    expect(report).toMatchObject({ sessions: 2, analyzed: 2, proposals: 2 });
    const proposals = listProposals(store, repo);
    expect(proposals.map(p => p.kind).sort()).toEqual(['decision-add', 'instruction-remove']);
    const removal = proposals.find(p => p.kind === 'instruction-remove')!, decision = proposals.find(p => p.kind === 'decision-add')!;
    expect(removal.beforeText).toBe('Never rewrite the lockfile.');
    expect(await runMemoryCommand(['apply', String(removal.id)], new Map([['repo', repo], ['decision', 'accept']]), context)).toBe(0);
    expect(knowledgeView(store, repo, 'alex').knowledge.instructions).not.toContain('Never rewrite the lockfile.');
    // The surface moved, so the remaining proposal is stale until the next pass.
    expect(await runMemoryCommand(['apply', String(decision.id)], new Map([['repo', repo], ['decision', 'accept']]), context)).toBe(1);
    expect(JSON.parse(lines.at(-1)!).message).toContain('changed since');
    expect(await runMemoryCommand(['propose'], new Map([['repo', repo]]), context)).toBe(0);
    const fresh = listProposals(store, repo).find(p => p.kind === 'decision-add')!;
    const code = await runMemoryCommand(['apply', String(fresh.id)], new Map([['repo', repo], ['decision', 'accept']]), context);
    expect([code, lines.at(-1)]).toEqual([0, lines.at(-1)]);
    expect(listDecisions(store, repo, 'alex').map(d => d.claim)).toEqual(['Regenerate the lockfile when upgrading a dependency.']);
    expect(await runMemoryCommand(['status'], new Map([['repo', repo]]), context)).toBe(0);
    expect(JSON.parse(lines.at(-1)!).status.pending).toBe(0);
    expect(await runMemoryCommand(['review'], new Map([['repo', repo], ['all', true]]), context)).toBe(0);
    expect(JSON.parse(lines.at(-1)!).proposals.length).toBeGreaterThanOrEqual(2);
  });
});
