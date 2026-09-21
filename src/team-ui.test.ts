import { describe, expect, test } from 'vitest';
import { teamWorkspaceHtml } from './team-ui.js';
import type { TeamSnapshot } from './team-contract.js';
const snapshot: TeamSnapshot = { leads: [{ id: 'lead', name: 'Team lead', instructions: '', projects: ['/project'], revision: 1, status: 'active', createdBy: 'alex' }], conversations: [], selected: { id: 'room', leadId: 'lead', title: 'Settings page', visibility: 'team', projects: ['/project'], revision: 1, threadId: 1, createdBy: 'alex', follow: false }, participants: [], messages: [], canManage: true, canSend: true, cursor: 1, truncated: false, projects: ['/project'], accounts: ['alex'] };
describe('team conversation fallback', () => {
  test('keeps author and queued state visible without inventing completion', () => {
    const html = teamWorkspaceHtml({ ...snapshot, messages: [{ id: 1, author: 'Sam', role: 'operator', text: 'Keep the email field optional.', status: 'queued', revision: 1, createdAt: '', requestId: 'one', turnId: null, error: null }] });
    expect(html).toContain('Sam'); expect(html).toContain('Queued'); expect(html).toContain('Team · Team lead'); expect(html).toContain('/chat?private=1');
  });
  test('escapes model text, titles and real failures', () => {
    const html = teamWorkspaceHtml({ ...snapshot, selected: { ...snapshot.selected!, title: '<script>unsafe</script>' }, messages: [{ id: 1, author: '<img>', role: 'assistant', text: '<script>alert(1)</script>', status: 'failed', revision: 1, createdAt: '', requestId: null, turnId: null, error: 'Provider <offline>' }] });
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img>'); expect(html).toContain('Provider &lt;offline&gt;'); expect(html).toContain('role="alert"');
  });
});
