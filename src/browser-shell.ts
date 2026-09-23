/** The browser bundle is a presentation client. Only these fixed public assets
 * are readable here; authenticated data stays in the existing page handlers. */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serializeBrowserWorkspace, type BrowserWorkspace } from './browser-workspace.js';

const assets = new Map<string, { body: Buffer; type: string }>();
function readAsset(name: 'workspace.js' | 'workspace.css' | 'THIRD_PARTY_NOTICES.txt'): Buffer | null {
  // Compiled installation first; the second location supports source-based
  // development/tests after the browser build. No request supplies a file path.
  for (const location of [new URL(`./browser/${name}`, import.meta.url), new URL(`../dist/browser/${name}`, import.meta.url)]) {
    try { return readFileSync(location); } catch { /* An unbuilt checkout retains the HTML surface. */ }
  }
  return null;
}
export function browserAssetsAvailable(): boolean {
  if (assets.size === 3) return true;
  for (const [name, type] of [['workspace.js', 'text/javascript; charset=utf-8'], ['workspace.css', 'text/css; charset=utf-8'], ['THIRD_PARTY_NOTICES.txt', 'text/plain; charset=utf-8']] as const) {
    const body = readAsset(name);
    if (body === null) return false;
    assets.set(`/assets/${name}`, { body, type });
  }
  return true;
}

export function serveBrowserAsset(request: IncomingMessage, response: ServerResponse, path: string): boolean {
  if (path !== '/assets/workspace.js' && path !== '/assets/workspace.css' && path !== '/assets/THIRD_PARTY_NOTICES.txt') return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }); response.end(); return true;
  }
  browserAssetsAvailable();
  const asset = assets.get(path);
  response.writeHead(asset ? 200 : 404, {
    'content-type': asset?.type ?? 'text/plain; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    ...(asset ? { 'content-length': asset.body.length } : {}),
  });
  response.end(request.method === 'HEAD' ? undefined : asset?.body ?? 'Browser assets are not built.');
  return true;
}

/** Retain the complete native document as the no-JavaScript/unloaded-bundle
 * fallback. React replaces its root only once the local module has loaded.
 * The data script is escaped for HTML parsing, not merely valid JSON. */
export function browserWorkspaceDocument(html: string, workspace: BrowserWorkspace, nonce: string, functionalScript: string): string {
  const initialize = `window.addEventListener('standing-orders:workspace-rendered',function initializeWorkspace(){window.removeEventListener('standing-orders:workspace-rendered',initializeWorkspace);${functionalScript}});`;
  return html
    .replace('</head>', '<link rel="stylesheet" href="/assets/workspace.css"></head>')
    .replace('<body>', '<body><div id="standing-orders-workspace">')
    .replace('</body>', `</div><script type="application/json" id="standing-orders-workspace-data" nonce="${nonce}">${serializeBrowserWorkspace(workspace)}</script><script nonce="${nonce}">${initialize}</script><script type="module" src="/assets/workspace.js" nonce="${nonce}"></script></body>`);
}

/** Signed-in pages share the workspace shell, so the app keeps one
 * navigation and one look. The coding workspace keeps its own full-screen
 * editor layout. Pages without chrome (sign-in, one-time secrets) never
 * reach the shell whatever this returns. */
export function supportsBrowserWorkspace(path: string): boolean {
  const pathname = path.split('?')[0]!;
  if (pathname === '/code' || pathname.startsWith('/code/')) return false;
  // Live operations pages still own their refresh, pollers and keyboard
  // palette in the console chrome; they share the palette until they move.
  return !LIVE_CONSOLE_PAGES.has(pathname);
}
const LIVE_CONSOLE_PAGES = new Set(['/system', '/board', '/inbox', '/next', '/done', '/workbench']);
