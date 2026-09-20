import type { SessionBrief, SessionResult, SessionView } from './session-contract.js';

export type SavedSessionBrief = SessionBrief & { sourceItemIds: string[]; partialHistory: boolean };
const states: Record<string, string> = {
  starting: 'Starting', ready: 'Ready to continue', working: 'Working', 'needs-input': 'Waiting for your answer',
  stopping: 'Stopping the current turn', interrupted: 'Saved; reconnect to continue', failed: 'Stopped with an error',
  uncertain: 'Delivery needs review', closed: 'Closed; saved work is preserved',
};
const excerpt = (text: string, limit: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one;
};

/** FirstMate-style bearings from saved facts, without another model call or
 * supervisor. Agent text is explicitly a report, never verification evidence. */
export function savedSessionBrief(session: SessionView, items: NonNullable<SessionResult['items']>, nextAction: string, partialHistory: boolean): SavedSessionBrief {
  const request = [...items].reverse().find(one => one.type === 'userMessage');
  const update = [...items].reverse().find(one => one.type === 'agentMessage');
  const lines = [`${session.title} — ${states[session.status] ?? session.status}.`];
  if (request) lines.push(`Latest saved request: ${excerpt(request.text, 280)}`);
  if (update) lines.push(`Latest saved agent report: ${excerpt(update.text, 600)}`);
  if (session.error) lines.push(excerpt(session.error, 400));
  return { summary: lines.join('\n'), nextAction, sourceRevision: session.revision,
    sourceItemIds: [request?.id, update?.id].filter((id): id is string => id !== undefined), partialHistory };
}
