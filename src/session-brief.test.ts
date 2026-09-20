import { expect, test } from 'vitest';
import { savedSessionBrief } from './session-brief.js';
import type { SessionView } from './session-contract.js';

test('briefs pin the saved revision and distinguish agent reports from checked outcomes', () => {
  const session: SessionView = { id: 'session-1', repo: '/repo', title: 'Improve welcome', status: 'ready', nativeThreadId: 'thread-1', turnId: null, revision: 14 };
  const brief = savedSessionBrief(session, [{ id: 'old', type: 'agentMessage', text: 'Earlier approach', status: null }, { id: 'request-2', type: 'userMessage', text: 'Use a shorter heading.', status: null }, { id: 'update-2', type: 'agentMessage', text: 'Updated the heading. Tests pass.', status: null }], 'Continue session', true);
  expect(brief).toMatchObject({ sourceRevision: 14, sourceItemIds: ['request-2', 'update-2'], partialHistory: true, nextAction: 'Continue session' });
  expect(brief.summary).toContain('Latest saved agent report: Updated the heading. Tests pass.');
  expect(brief.summary).not.toContain('Earlier approach');
});

test('uncertain delivery stays prominent with bounded reported context and its recovery action', () => {
  const session: SessionView = { id: 'session-1', repo: '/repo', title: 'Improve welcome', status: 'uncertain', nativeThreadId: 'thread-1', turnId: null, revision: 16, error: 'The message may have reached the agent. It will not be resent.' };
  const brief = savedSessionBrief(session, [{ id: 'large', type: 'agentMessage', text: 'Saved work. '.repeat(1000), status: null }], 'Inspect saved session', false);
  expect(brief.summary).toContain('Delivery needs review');
  expect(brief.summary).toContain('It will not be resent.');
  expect(brief.summary.length).toBeLessThan(1200);
  expect(brief.nextAction).toBe('Inspect saved session');
});
