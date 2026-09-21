import type { TeamSnapshot } from './team-contract.js';
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
/** Readable fallback uses the same admitted projection as the interactive UI. */
export function teamWorkspaceHtml(snapshot: TeamSnapshot): string {
  const selected = snapshot.selected;
  return `<section class="team-workspace"><h1>${escape(selected?.title ?? 'Team chat')}</h1>` +
    (selected ? `<p>${selected.visibility === 'team' ? 'Team' : 'Private'} · ${escape(snapshot.leads.find(lead => lead.id === selected.leadId)?.name ?? 'Lead')}</p>` : '') +
    (snapshot.messages.length ? snapshot.messages.map(message => `<article><strong>${escape(message.author)}</strong><p style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(message.text)}</p>${message.status === 'queued' || message.status === 'running' ? `<p>${message.status === 'queued' ? 'Queued' : 'Working'}</p>` : ''}${message.error ? `<p role="alert">${escape(message.error)}</p>` : ''}</article>`).join('') : '<p>Start a conversation with your team lead.</p>') +
    '<noscript>Enable JavaScript to send messages and manage team conversations.</noscript><p><a href="/chat?private=1">Previous private chat</a></p></section>';
}
