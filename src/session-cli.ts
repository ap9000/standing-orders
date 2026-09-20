import { open } from 'node:fs/promises';
import { envelopeJson } from './envelope.js';
import {
  SESSION_DESCRIPTORS, SESSION_PROMPT_BYTES, SESSION_RESPONSE_BYTES,
  isSessionResponse, sessionCapabilities, sessionDescriptor, validateSessionRequest,
  type SessionDescriptor, type SessionOperation, type SessionRequest, type SessionResponse,
} from './session-contract.js';

export type SessionCliOptions = {
  fetch?: typeof fetch; env?: NodeJS.ProcessEnv; readStdin?: () => Promise<string>;
  stderr?: (line: string) => void;
};
const commonFlags = { url: 'value', as: 'value', 'token-env': 'value', 'token-file': 'value', json: 'flag', help: 'flag' } as const;
export const SESSION_CLI_ACTIONS = ['capabilities', ...SESSION_DESCRIPTORS.map(one => one.operation)] as const;
export function sessionCliFlags(spec: SessionDescriptor): Record<string, 'value' | 'flag'> {
  return { ...commonFlags, ...Object.fromEntries(Object.keys(spec.flags).map(name => [name, 'value' as const])), ...(spec.operation === 'start' || spec.operation === 'send' ? { file: 'value', stdin: 'flag' } : {}) };
}
function help(spec?: SessionDescriptor): string {
  if (!spec) return `standing-orders session <operation>\n\n${SESSION_DESCRIPTORS.map(one => `  ${one.operation.padEnd(12)} ${one.synopsis}`).join('\n')}\n  capabilities  Show this client's schemas and authority requirements\n\nUse session <operation> --help for required flags. Session controls require operator credentials. Chat is the separate coordinator conversation.`;
  const fields = spec.inputSchema.required.filter(one => !['version', 'sessionId', 'prompt'].includes(one));
  const required = fields.map(field => Object.entries(spec.flags).find(([, value]) => value.field === field)?.[0]).filter(Boolean);
  return `standing-orders session ${spec.operation}${'sessionId' in spec.inputSchema.properties ? ' <session-id>' : ''}\n${spec.synopsis}.\n\nRequired: --url <service-origin> --as <operator>\n  --token-env <variable-name> or --token-file <path>\n${required.map(name => `  --${name} <value>`).join('\n')}${'prompt' in spec.inputSchema.properties ? '\n  --file <path> or --stdin (complete prompt, up to 64 KB)' : ''}\n${'expectedRevision' in spec.inputSchema.properties ? '\nUse the revision, nativeThreadId and turnId from session show. Use none for a null thread or turn.\n' : ''}\nOptions: ${Object.keys(sessionCliFlags(spec)).map(name => `--${name}`).join(' ')}\nCredentials are sent only to the named HTTPS service or loopback HTTP. Redirects and automatic mutation retries are disabled.`;
}

type Parsed = { spec: SessionDescriptor; request: SessionRequest; url: string; account: string; token: string };
class UsageError extends Error {}
async function readBoundedFile(path: string, limit: number, label: string): Promise<string> {
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } catch { throw new UsageError(`${label} must be a readable UTF-8 regular file of at most ${limit} bytes.`); }
  finally { await file?.close(); }
}
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError('Pipe the complete prompt into --stdin, or use --file.');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > SESSION_PROMPT_BYTES) throw new UsageError('The prompt exceeds 64 KB.');
    chunks.push(buffer);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new UsageError('The prompt must be UTF-8 text.'); }
}
/** Credentials are never sent to a URL with embedded authority, an API path,
 * query, fragment or an insecure remote host. Fetch cannot follow redirects. */
export function sessionServiceOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UsageError('--url must be an HTTPS or loopback HTTP service origin.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new UsageError('--url must contain only the service origin, with no credentials, path, query or fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new UsageError('--url requires HTTPS except for loopback HTTP.');
  return url.origin;
}
async function parseRequest(spec: SessionDescriptor, flags: Record<string, string | true>, positionals: string[], options: SessionCliOptions): Promise<Parsed> {
  const value = (name: string): string => typeof flags[name] === 'string' ? flags[name] as string : '';
  const url = sessionServiceOrigin(value('url'));
  const account = value('as');
  if (!account || account.length > 200 || /[\s:\x00-\x1f\x7f]/.test(account)) throw new UsageError('--as must name the operator account.');
  if (Boolean(flags['token-env']) === Boolean(flags['token-file'])) throw new UsageError('Choose exactly one credential source: --token-env <variable-name> or --token-file <path>.');
  let token: string;
  if (flags['token-env']) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value('token-env'))) throw new UsageError('--token-env must name an environment variable.');
    token = (options.env ?? process.env)[value('token-env')] ?? '';
  } else token = (await readBoundedFile(value('token-file'), 8192, 'The token file')).trim();
  if (!token || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token)) throw new UsageError('The selected credential is empty or invalid. Set the named variable or token file.');
  const request: Record<string, unknown> = { version: 1 };
  if ('sessionId' in spec.inputSchema.properties) {
    if (positionals.length !== 1) throw new UsageError('Name exactly one session ID.');
    request['sessionId'] = positionals[0];
  } else if (positionals.length) throw new UsageError('This operation takes no positional arguments.');
  for (const [name, field] of Object.entries(spec.flags)) {
    if (flags[name] === undefined) continue;
    const raw = value(name);
    if (field.kind === 'integer' && !/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number.`);
    request[field.field] = field.kind === 'integer' ? Number(raw) : field.kind === 'nullable-id' && raw === 'none' ? null : raw;
  }
  if ('prompt' in spec.inputSchema.properties) {
    if (Boolean(flags['file']) === Boolean(flags['stdin'])) throw new UsageError('Choose exactly one prompt source: --file <path> or --stdin.');
    request['prompt'] = flags['file'] ? await readBoundedFile(value('file'), SESSION_PROMPT_BYTES, 'The prompt file') : await (options.readStdin ?? readStdin)();
  }
  const validated = validateSessionRequest(spec.operation, request);
  if (!validated.ok) throw new UsageError(validated.message);
  return { spec, request: validated.request, url, account, token };
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > SESSION_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Response limit'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
function unconfirmed(spec: SessionDescriptor, request: SessionRequest): SessionResponse {
  const sessionId = 'sessionId' in request ? request.sessionId : undefined;
  return { version: 1, operation: spec.operation, ok: false, status: spec.mutation ? 'uncertain' : 'rejected',
    delivery: spec.mutation ? 'unknown' : 'not-sent', retry: spec.mutation ? 'inspect-first' : 'safe-read',
    reason: spec.mutation ? 'delivery-unknown' : 'service-unavailable',
    message: spec.mutation ? 'The service response could not be confirmed. Inspect the saved session before continuing; the request was not retried.' : 'The service response could not be read. Check the service address and connection.',
    nextActions: [{ operation: sessionId ? 'show' : 'list', label: sessionId ? 'Inspect session' : 'List sessions', ...(sessionId ? { sessionId } : {}) }] };
}
async function perform(parsed: Parsed, options: SessionCliOptions): Promise<SessionResponse> {
  const { spec, request, url, account, token } = parsed;
  try {
    const response = await (options.fetch ?? fetch)(`${url}/api/sessions/${spec.operation}`, {
      method: 'POST', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${account}:${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(request),
    });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return unconfirmed(spec, request); }
    // This marker belongs to the owner boundary. A bare gateway 503 or 404
    // cannot prove that an upstream mutation was never accepted.
    if ([401, 403, 404, 503].includes(response.status) && response.headers.get('x-standing-orders-session-delivery') === 'not-sent') {
      await response.body?.cancel();
      const reason = response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'session-unsupported' : 'session-unavailable';
      return { version: 1, operation: spec.operation, ok: false, status: 'rejected', delivery: 'not-sent', retry: spec.mutation ? 'never' : 'safe-read', reason,
        message: response.status === 401 || response.status === 403 ? 'The service refused these operator credentials. Check the account and its access.' : 'This service does not currently support the requested session operation. Check its installed build and readiness.', nextActions: [] };
    }
    const payload = await readResponse(response);
    if (!isSessionResponse(payload, spec.operation) || (payload.ok && !response.ok)) return unconfirmed(spec, request);
    if ('sessionId' in request && payload.result?.session && payload.result.session.id !== request.sessionId) return unconfirmed(spec, request);
    if (payload.ok && 'key' in request && payload.result?.receipt?.key !== request.key) return unconfirmed(spec, request);
    if (payload.ok && 'expectedThreadId' in request && request.expectedThreadId !== null && payload.result?.session?.nativeThreadId !== request.expectedThreadId) return unconfirmed(spec, request);
    return payload;
  } catch { return unconfirmed(spec, request); }
}
const terminalText = (value: string): string => value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
function render(response: SessionResponse): string {
  const result = response.result;
  const lines = response.ok && response.operation === 'show' && result?.brief ? [] : [response.message];
  for (const session of result?.sessions ?? []) lines.push(`${session.id}  ${session.status}  ${session.title}`);
  if (result?.session) {
    const session = result.session;
    lines.push(result?.brief?.summary ?? `${session.title} · ${session.status}`, `Session: ${session.id}`, `Revision: ${session.revision} · Thread: ${session.nativeThreadId ?? 'none'} · Turn: ${session.turnId ?? 'none'}`);
    if (session.error && !result?.brief) lines.push(session.error);
  }
  for (const item of result?.items ?? []) lines.push(`\n${item.type}: ${item.text}`);
  for (const request of result?.requests ?? []) lines.push(`\n${request.title}\n${request.detail}`);
  if (result?.changes) lines.push(result.changes.status, result.changes.diff, ...(result.changes.truncated ? ['Changes were truncated. Open the workspace for the full diff.'] : []));
  if (result?.truncated) lines.push('The response is shortened. Open the workspace for complete activity.');
  for (const action of response.nextActions) lines.push(`${action.label}: ${action.operation === 'open-ui' ? 'open the coding workspace' : `standing-orders session ${action.operation}${action.sessionId ? ` ${action.sessionId}` : ''}`}`);
  return terminalText(lines.join('\n'));
}

export async function runSessionCommand(argv: readonly string[], write: (line: string) => void, options: SessionCliOptions = {}): Promise<number> {
  const json = argv.includes('--json');
  const stderr = options.stderr ?? (line => process.stderr.write(`${line}\n`));
  const operation = argv[0]; const command = operation ? `session ${operation}` : 'session';
  const fail = (message: string): number => {
    const payload = { ok: false, command, reason: 'usage', status: 'rejected', delivery: 'not-sent', retry: 'never', message };
    if (json) write(envelopeJson(payload)); else stderr(message);
    return 2;
  };
  if (!operation || operation === '--help' || operation === '-h') {
    if (json) write(envelopeJson({ ok: true, command: 'session', ...sessionCapabilities() })); else write(help());
    return 0;
  }
  if (operation === 'capabilities') {
    if (argv.slice(1).some(arg => !['--json', '--help', '-h'].includes(arg))) return fail('session capabilities accepts only --json or --help.');
    write(json ? envelopeJson({ ok: true, command, ...sessionCapabilities() }) : help()); return 0;
  }
  const spec = sessionDescriptor(operation);
  if (!spec) return fail(`Unknown session operation. Use: ${SESSION_CLI_ACTIONS.join(', ')}.`);
  const allowed = sessionCliFlags(spec); const flags: Record<string, string | true> = {}; const positionals: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]!;
    if (!argument.startsWith('-')) { positionals.push(argument); continue; }
    const name = argument === '-h' ? 'help' : argument.startsWith('--') ? argument.slice(2) : '';
    if (!Object.hasOwn(allowed, name)) return fail(`Unknown option ${argument} for session ${operation}.`);
    if (Object.hasOwn(flags, name)) return fail(`Option --${name} was repeated.`);
    if (allowed[name] === 'flag') flags[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('-')) return fail(`--${name} requires a value.`);
      flags[name] = value;
    }
  }
  if (flags['help']) { write(json ? envelopeJson({ ok: true, command, descriptor: spec, help: help(spec) }) : help(spec)); return 0; }
  let parsed: Parsed;
  try { parsed = await parseRequest(spec, flags, positionals, options); }
  catch (error) { return fail(error instanceof UsageError ? error.message : 'The session request could not be prepared. Check the prompt and credential source.'); }
  const response = await perform(parsed, options);
  if (json) write(envelopeJson({ ...response, command, ...('key' in parsed.request ? { key: parsed.request.key } : {}) }));
  else if (response.ok) write(render(response)); else stderr(render(response));
  return response.ok ? 0 : response.status === 'uncertain' || response.reason === 'service-unavailable' ? 1 : 3;
}
