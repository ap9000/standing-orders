import { realpathSync } from 'node:fs';
import { CodingActionError, CodingWorkspace, type CodingActor, type CodingExpected } from './coding-workspace.js';
import { sessionDescriptor, validateSessionRequest, type SessionOperation, type SessionRequests, type SessionResponse, type SessionResult, type SessionView, type SessionNextAction } from './session-contract.js';
import { savedSessionBrief } from './session-brief.js';

type Options = {
  workspace: CodingWorkspace;
  /** Recheck the live account generation and installation-wide operator role. */
  authorized: (actor: CodingActor, repo?: string) => boolean;
  /** Resolve only an admitted project. Never accept an arbitrary filesystem path. */
  project: (actor: CodingActor, project: string) => string;
};
const mutationMessages = { start: 'Session started.', send: 'Message delivered.', stop: 'Stop requested.', resume: 'Session reconnected.', recover: 'Saved activity reconciled. Inspect the current state before continuing.' };
const expectedOf = (input: SessionRequests['stop']): CodingExpected => ({ revision: input.expectedRevision, nativeThreadId: input.expectedThreadId, turnId: input.expectedTurnId });

/** A narrow projection and operation boundary shared by authenticated adapters.
 * This object never opens a second catalog or starts a competing provider. */
export class SessionService {
  constructor(private readonly options: Options) {}

  private authorize(actor: CodingActor, repo?: string): void {
    if (!this.options.authorized(actor, repo)) throw new CodingActionError('This operation requires current operator access to the project.', 'rejected');
  }

  private view(actor: CodingActor, id: string): SessionView {
    const session = this.options.workspace.get(id, actor);
    this.authorize(actor, session.repo);
    return { id: session.id, repo: session.repo, title: session.title, status: session.status,
      nativeThreadId: session.nativeThreadId, turnId: session.turnId,
      revision: this.options.workspace.revision(id, actor), branch: session.branch, base: session.base,
      error: session.error, deliveryReviewRequired: session.deliveryReviewRequired === true, updatedAt: session.updatedAt };
  }

  private next(session?: SessionView): SessionNextAction[] {
    if (!session) return [{ operation: 'list', label: 'Inspect sessions' }];
    const sessionId = session.id;
    const read: SessionNextAction[] = [{ operation: 'show', label: 'Inspect session', sessionId }, { operation: 'changes', label: 'Review changes', sessionId }];
    if (session.deliveryReviewRequired || session.status === 'needs-input') return [{ operation: 'open-ui', label: session.deliveryReviewRequired ? 'Review uncertain delivery' : 'Answer in the workspace', sessionId }, ...read];
    if (session.status === 'uncertain') return [{ operation: 'recover', label: 'Reconcile saved activity', sessionId }, ...read];
    if (session.status === 'interrupted') return [{ operation: 'resume', label: 'Reconnect session', sessionId }, ...read];
    if (session.status === 'ready') return [{ operation: 'send', label: 'Continue session', sessionId }, ...read];
    if (session.status === 'working') return [...read, { operation: 'send', label: 'Send a follow-up', sessionId }, { operation: 'stop', label: 'Stop this turn', sessionId }];
    return read;
  }

  private inspect(session?: SessionView): SessionNextAction[] {
    if (!session) return [{ operation: 'list', label: 'Inspect saved sessions' }];
    const sessionId = session.id;
    const next: SessionNextAction[] = [{ operation: 'show', label: 'Inspect saved session', sessionId }, { operation: 'changes', label: 'Review changes', sessionId }];
    if (session.deliveryReviewRequired || session.status === 'needs-input') next.push({ operation: 'open-ui', label: session.deliveryReviewRequired ? 'Review uncertain delivery' : 'Answer in the workspace', sessionId });
    else if (session.status === 'uncertain') next.push({ operation: 'recover', label: 'Reconcile saved activity', sessionId });
    return next;
  }

  private result(actor: CodingActor, id: string, activity = false): SessionResult {
    const snapshot = this.options.workspace.snapshotBounded(id, actor), session = this.view(actor, id);
    // Keep recent context and explicitly label omitted history. Native history
    // remains authoritative; this bounded transport is not a memory rewrite.
    let remaining = 1_000_000;
    const items = [] as NonNullable<SessionResult['items']>;
    for (const item of snapshot.items.slice(-100).reverse()) {
      const bytes = Buffer.byteLength(JSON.stringify(item));
      if (bytes > remaining) break;
      items.unshift(item); remaining -= bytes;
    }
    const requests = snapshot.requests.slice(0, 50).map(({ id, kind, title, detail }) => ({ id, kind, title: title.slice(0, 1000), detail: detail.slice(0, 8000) }));
    const next = this.next(session)[0]?.label ?? 'Inspect session';
    const truncated = snapshot.truncated || items.length !== snapshot.items.length || requests.length !== snapshot.requests.length || snapshot.requests.some(request => request.title.length > 1000 || request.detail.length > 8000);
    return { session, ...(activity ? { items, requests } : {}), truncated, brief: savedSessionBrief(session, items, next, truncated) };
  }

  async execute<O extends SessionOperation>(actor: CodingActor, operation: O, value: unknown): Promise<SessionResponse> {
    const rejected = (message: string, reason: string): SessionResponse => ({ version: 1, operation, ok: false, status: 'rejected', delivery: 'not-sent', retry: 'never', message, reason, nextActions: [] });
    const validation = validateSessionRequest(operation, value);
    if (!validation.ok) return rejected(validation.message, 'invalid-request');
    const input = validation.request as SessionRequests[O];
    const workspace = this.options.workspace;
    let deliveryMayHaveOccurred = false;
    try {
      this.authorize(actor);
      if (operation === 'list') {
        const request = input as SessionRequests['list'];
        const repo = request.project ? this.options.project(actor, request.project) : undefined;
        const page = workspace.listBounded(actor, { limit: request.limit ?? 50, ...(repo === undefined ? {} : { repo }), authorized: project => this.options.authorized(actor, project) });
        const sessions = page.sessions.map(s => this.view(actor, s.id));
        return { version: 1, operation, ok: true, status: 'succeeded', delivery: 'confirmed', retry: 'safe-read', message: `${sessions.length} sessions${page.truncated ? ' shown; more may be available' : ''}.`, nextActions: [], result: { sessions, truncated: page.truncated } };
      }
      if (operation === 'show' || operation === 'changes') {
        const { sessionId } = input as SessionRequests['show'];
        this.view(actor, sessionId);
        const changes = operation === 'changes' ? await workspace.changes(sessionId, actor) : undefined;
        const result = this.result(actor, sessionId, operation === 'show' && (input as SessionRequests['show']).view === 'activity');
        if (changes) result.changes = changes;
        return { version: 1, operation, ok: true, status: 'succeeded', delivery: 'confirmed', retry: 'safe-read', message: 'Saved session loaded.', nextActions: this.next(result.session), result };
      }
      const request = input as SessionRequests['start'] | SessionRequests['send'] | SessionRequests['stop'];
      let repo: string | undefined;
      if (operation === 'start') {
        repo = realpathSync(this.options.project(actor, (request as SessionRequests['start']).project));
        this.authorize(actor, repo);
      } else this.view(actor, (request as SessionRequests['stop']).sessionId);
      // Stable field order makes a JSON field-order difference the same request.
      const fingerprint = JSON.stringify([operation, Object.keys(request).sort().map(k => [k, (request as unknown as Record<string, unknown>)[k]]), repo ?? null]);
      const receipt = await workspace.command(actor, request.key, fingerprint, () => this.authorize(actor, repo), async () => {
        const sessionId = operation === 'start' ? null : (request as SessionRequests['stop']).sessionId;
        try {
          this.authorize(actor, repo);
          if (sessionId) {
            this.view(actor, sessionId);
            workspace.assertExpected(sessionId, actor, expectedOf(request as SessionRequests['stop']));
          }
        } catch (error) { throw error instanceof CodingActionError ? error : new CodingActionError(error instanceof Error ? error.message : 'This session is unavailable.', 'rejected', sessionId ?? undefined); }
        deliveryMayHaveOccurred = true;
        if (operation === 'start') {
          const start = request as SessionRequests['start'];
          return (await workspace.start(actor, { repo: repo!, title: start.title, prompt: start.prompt, model: start.model ?? null, requestId: start.key })).id;
        }
        const expected = expectedOf(request as SessionRequests['stop']);
        if (operation === 'send') await workspace.send(sessionId!, actor, (request as SessionRequests['send']).prompt, request.key, expected);
        else if (operation === 'stop') await workspace.stop(sessionId!, actor, expected);
        else if (operation === 'resume') await workspace.resume(sessionId!, actor, expected);
        else if (operation === 'recover') await workspace.recover(sessionId!, actor, expected);
        return sessionId!;
      });
      // A replay reads a prior receipt without performing again. Losing access
      // or failing to project that result cannot prove the original was unsent.
      deliveryMayHaveOccurred ||= receipt.status !== 'rejected';
      const id = receipt.sessionId ?? (operation === 'start' ? undefined : (request as SessionRequests['stop']).sessionId);
      const result: SessionResult = { ...(id ? this.result(actor, id) : {}), receipt: { key: request.key, status: receipt.status } };
      const status = receipt.status === 'accepted' ? 'succeeded' : receipt.status === 'pending' && result.session ? 'pending' : receipt.status === 'rejected' ? 'rejected' : 'uncertain';
      const nextActions = status === 'pending' || status === 'uncertain' ? this.inspect(result.session) : this.next(result.session);
      if (result.brief && (status === 'pending' || status === 'uncertain')) result.brief = { ...result.brief, nextAction: nextActions[0]?.label ?? 'Inspect saved session' };
      return { version: 1, operation, ok: status === 'succeeded' || status === 'pending', status,
        delivery: status === 'rejected' ? 'not-sent' : status === 'uncertain' ? 'unknown' : 'confirmed', retry: 'inspect-first',
        message: receipt.message ?? (status === 'succeeded' ? mutationMessages[operation as keyof typeof mutationMessages] : 'Inspect saved activity before continuing. This request will not be sent again.'),
        nextActions, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The session operation could not finish.';
      if (deliveryMayHaveOccurred) return { version: 1, operation, ok: false, status: 'uncertain', delivery: 'unknown', retry: 'inspect-first', message, reason: 'unconfirmed-response', nextActions: [{ operation: 'list', label: 'Inspect saved sessions' }] };
      return rejected(message, sessionDescriptor(operation)?.mutation ? 'not-admitted' : 'unavailable');
    }
  }
}
