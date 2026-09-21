/** Shared central-team transport contract. Requests never establish actor identity. */
export type TeamActor = { name: string; generation: number };
export type TeamRole = 'viewer' | 'contributor' | 'manager';
export type TeamLead = { id: string; name: string; instructions: string; projects: string[]; revision: number; status: 'active' | 'paused'; createdBy: string };
export type TeamConversation = { id: string; leadId: string; title: string; visibility: 'private' | 'team'; projects: string[]; revision: number; threadId: number; createdBy: string; follow: boolean };
export type TeamParticipant = { account: string; role: TeamRole; active: boolean };
export type TeamMessage = { id: number; author: string; role: 'operator' | 'assistant'; text: string; status: 'queued' | 'running' | 'answered' | 'failed' | 'cancelled' | 'uncertain'; revision: number; createdAt: string; requestId: string | null; turnId: number | null; error: string | null };
export type TeamSnapshot = { leads: TeamLead[]; conversations: TeamConversation[]; selected: TeamConversation | null; participants: TeamParticipant[]; messages: TeamMessage[]; canManage: boolean; canSend: boolean; cursor: number; truncated: boolean; projects: string[]; accounts: string[] };
export const TEAM_OPERATIONS = ['list', 'show', 'create-lead', 'update-lead', 'create-conversation', 'member', 'send', 'edit', 'withdraw', 'read', 'follow', 'stop', 'transfer'] as const;
export type TeamOperation = typeof TEAM_OPERATIONS[number];
export type TeamRequest = { operation: TeamOperation; args: Record<string, unknown> };
export type TeamResponse = { version: 1; ok: boolean; code: string; message: string; result?: unknown; snapshot?: TeamSnapshot };
export type TeamExecute = (actor: TeamActor, request: TeamRequest) => Promise<TeamResponse>;
