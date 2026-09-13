/** Isolated phone-chat visual fixture. No live DB, workers, keys, or model
 * calls. Build first, run this file, then open the printed local URL. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../dist/store.js';
import { addApprover } from '../dist/scope.js';
import { createDecisionServer } from '../dist/serve.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'standing-orders-phone-fixture-')));
const store = openStore(':memory:');
const now = new Date();
const login = addApprover(store, 'phone-fixture', now);
if (!login.ok) throw new Error('fixture login failed');
store.setChatConfig({ provider: 'codex-subscription', model: 'default', dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, 'phone-fixture', now);
for (const phase of ['plan', 'build', 'review']) store.setPhaseConfig('installation', phase, 'codex', 'default', 'fixture', now);
const task = store.createConsoleTask({ id: 'mobile-navigation', title: 'Polish mobile navigation', repo: root, goal: 'Make mobile navigation clear and comfortable.', acceptance: [{ id: 'phone', statement: 'Navigation fits a phone viewport.', evidence: ['manual-review'] }], filedVia: 'cli' }, now);
if (!task.ok) throw new Error(`fixture task: ${task.reason}`);
let requests = 0;
const server = createDecisionServer({ store, evidenceRoot: root, repo: root, chatEnv: {},
  subscriptionChatRunner: async () => {
    requests++;
    if (requests === 1) {
      await new Promise(resolve => setTimeout(resolve, 45000));
      return { ok: true, answer: { text: 'I’ll prepare that change for you.', calls: [{ id: 'hold-phone', name: 'propose_hold', args: { task: 'mobile-navigation', reason: 'Review mobile spacing before the next attempt.' } }], tokensIn: 100, tokensOut: 20, reportedCostMicrousd: null } };
    }
    return { ok: true, answer: { text: 'I’ve prepared a pause for **Polish mobile navigation**. Confirm the card below to keep its next attempt from starting while you review the spacing.', calls: [], tokensIn: 100, tokensOut: 30, reportedCostMicrousd: null } };
  },
});
server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ fixture: true, url: `http://127.0.0.1:${server.address().port}/chat`, name: 'phone-fixture', password: login.token }));
});
function stop() { server.closeAllConnections(); server.close(() => { store.close(); rmSync(root, { recursive: true, force: true }); process.exit(0); }); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
