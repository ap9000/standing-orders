import type { CodingContext } from './coding-context.js';
export type CodingStatus = 'starting' | 'ready' | 'working' | 'needs-input' | 'stopping' | 'interrupted' | 'failed' | 'uncertain' | 'closed';
export type CodingSession = {
  id: string; owner: string; generation: number; repo: string; title: string;
  provider: 'codex'; model: string | null; branch: string; base: string; worktree: string;
  nativeThreadId: string | null; turnId: string | null; status: CodingStatus;
  error: string | null; createdAt: string; updatedAt: string;
  deliveryReviewRequired?: boolean;
  initialRequest?: { requestId: string; prompt: string };
  context?: CodingContext;
};
export type CodingItem = { id: string; type: string; text: string; status: string | null; clientId?: string };
export type CodingQuestion = { id: string; header: string; question: string; options: { label: string; description: string }[] };
export type CodingRequest = {
  id: string; kind: 'command' | 'files' | 'questions'; method: string;
  title: string; detail: string; questions: CodingQuestion[];
};
export type CodingSnapshot = { session: CodingSession; items: CodingItem[]; requests: CodingRequest[]; revision: number };
export type CodingChanges = { head: string; status: string; diff: string; truncated: boolean };
