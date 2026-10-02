import { test, expect } from 'vitest';
import { recoverFailedDeployment } from '../scripts/deploy-recovery.mjs';

/** The effects a failed browser deployment may take, recorded in order. */
function effects() {
  const done: string[] = [];
  return { done, restoreService: () => { done.push('restore service'); }, removeGate: () => { done.push('remove gate'); }, mark: (phase: string) => { done.push(`mark ${phase}`); } };
}

test('a deploy that fails after proving the old service stopped starts it again and lifts its own pause', () => {
  // Oct 2: two deploys over 0.9.11 failed after the bootout and left the plane down until restored by hand.
  for (const phase of ['stopped', 'migrating', 'migrated']) {
    const e = effects();
    expect(recoverFailedDeployment(phase, e)).toMatch(/previous service was started again and new work resumed/);
    expect(e.done).toEqual(['restore service', 'mark restored', 'remove gate', 'mark released']);
  }
  // The new service failed and the previous one was already started again: only the pause is left to lift.
  const e = effects();
  expect(recoverFailedDeployment('restored', e)).toMatch(/new work resumed/);
  expect(e.done).toEqual(['remove gate', 'mark released']);
});

test('a refusal before the swap only lifts the pause; an unproven stop or a starting service is left for a person', () => {
  for (const phase of ['admission-paused', 'frozen', 'backup-verified', 'rehearsed']) {
    const e = effects();
    expect(recoverFailedDeployment(phase, e)).toMatch(/stopped before the swap/);
    expect(e.done).toEqual(['remove gate', 'mark released']);
  }
  for (const phase of ['stopping', 'starting', 'started', 'healthy', 'deployed', 'released', 'preparing']) {
    const e = effects();
    expect(recoverFailedDeployment(phase, e)).toBeNull();
    expect(e.done).toEqual([]);
  }
});

test('a restore that cannot load the previous service keeps the pause and says so', () => {
  const e = { ...effects(), restoreService: () => { throw Error('launchctl bootstrap failed'); } };
  expect(() => recoverFailedDeployment('stopped', e)).toThrow('launchctl bootstrap failed');
  expect(e.done).toEqual([]);
});
