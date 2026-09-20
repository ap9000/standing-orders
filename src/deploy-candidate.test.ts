import { expect, test } from 'vitest';
import { deploymentCandidate } from '../scripts/deploy-candidate.mjs';

function fixture() {
  const head = 'a'.repeat(40), digest = 'b'.repeat(64);
  const run = { id: 12, role: 'builder', outcome: 'built', headRevision: head, taskRef: 7, scopeDigest: 'scope', worktree: '/work/candidate' };
  const scope = { digest: 'scope', approvedDigest: 'scope', acceptance: [{ id: 'c1' }] };
  const gate = { run: 12, head, scopeDigest: 'scope', command: { command: 'npm test' }, result: { ran: true, exitCode: 0 } };
  const assignment = { state: 'complete', receipt: { runId: 12, head, scopeDigest: 'scope', digest }, completion: { actor: 'operator:alex', at: '2026-09-20T21:00:00Z', digest } };
  // There is deliberately no model-review API: completion and the actual
  // project check are sufficient even when optional proof packaging is short.
  const store = { getRun: () => run, refById: () => ({ externalId: 'release', repo: '/repo' }),
    getScope: () => scope, liveVerifyCommand: () => ({ command: 'npm test' }),
    proofVerdictFor: () => ({ verdict: 'short' }), proofAcceptance: () => null };
  let available = true;
  const inspect = () => deploymentCandidate(store, { runId: 12, head, evidenceRoot: '/evidence', now: new Date() }, {
    assignmentOf: () => assignment,
    verificationEvidence: () => available ? { ok: true, bytes: JSON.stringify(gate), digest: 'gate' } : { ok: false, problem: 'The saved check changed' },
  });
  return { inspect, run, scope, gate, assignment, unavailable: () => { available = false; } };
}

test('deployment accepts the exact completed result with a passing approved check and no model review', () => {
  expect(fixture().inspect()).toMatchObject({ taskId: 'release', gateDigest: 'gate', proofVerdict: 'short', completion: { actor: 'operator:alex' } });
});

test.each(['failed', 'not-run', 'wrong-head', 'wrong-scope', 'wrong-command', 'unavailable'])('completion cannot authorize deployment when its check is %s', problem => {
  const f = fixture();
  if (problem === 'failed') f.gate.result.exitCode = 1;
  if (problem === 'not-run') f.gate.result.ran = false;
  if (problem === 'wrong-head') f.gate.head = 'c'.repeat(40);
  if (problem === 'wrong-scope') f.gate.scopeDigest = 'changed';
  if (problem === 'wrong-command') f.gate.command.command = 'true';
  if (problem === 'unavailable') f.unavailable();
  expect(f.inspect).toThrow(/native check/i);
});

test.each(['not-complete', 'stale-receipt', 'other-run', 'changed-approval'])('deployment refuses %s without requesting another reviewer', problem => {
  const f = fixture();
  if (problem === 'not-complete') f.assignment.state = 'ready-to-check';
  if (problem === 'stale-receipt') f.assignment.completion.digest = 'c'.repeat(64);
  if (problem === 'other-run') f.assignment.receipt.runId = 13;
  if (problem === 'changed-approval') f.scope.approvedDigest = 'old';
  expect(f.inspect).toThrow(/exact result complete|signed scope/);
});
