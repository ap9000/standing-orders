import { createRequire } from 'node:module';

/** Keep native SQLite out of import-only UI/module graphs. Load the real
 * driver only when a database operation needs it, as the main store does. */
export function sqliteRuntime(): typeof import('node:sqlite') {
  return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
}
