// Coding catalog support for the browser deployer. The installed runtime owns
// its catalog format and shutdown checks; a legacy runtime is safe only when
// the installation has no coding catalog at all.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function exists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function loadCodingDeploymentRuntime(dist) {
  const path = join(dist, 'coding-update.js');
  if (!exists(path)) return null;
  // Do not interpret a broken installed module or a missing dependency as a
  // legacy installation and silently skip its custody requirements.
  const runtime = await import(pathToFileURL(path).href);
  for (const method of ['backupCodingCatalog', 'assertCodingUpdateStopped']) {
    if (typeof runtime[method] !== 'function') throw Error('The installed coding update support is incomplete. Deployment remains paused.');
  }
  return runtime;
}

function catalog(runtime, database) {
  const path = `${database}.coding.sqlite`;
  if (!exists(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('The coding catalog is linked or not a regular database. Deployment remains paused.');
  if (!runtime) throw Error('A coding catalog exists but the installed runtime cannot safely back it up or verify agent shutdown. Deployment remains paused.');
  return path;
}

// Callers persist the record before awaiting any backup, shutdown or health
// operation. Presence is monotonic: a later absence is never a legacy upgrade.
export function observeCodingDeployment(runtime, database, record) {
  if (record.codingCatalogExpected !== undefined && typeof record.codingCatalogExpected !== 'boolean') throw Error('The recorded coding catalog presence is invalid. Deployment remains paused.');
  if (exists(`${database}.coding.sqlite`)) record.codingCatalogExpected = true;
  const path = catalog(runtime, database);
  if (path === null && (record.codingCatalogExpected || record.codingBackupPath !== undefined || record.codingBackupHash !== undefined)) throw Error('The live coding catalog disappeared during deployment. Deployment remains paused.');
  if (path !== null) record.codingCatalogExpected = true;
  else if (record.codingCatalogExpected === undefined) record.codingCatalogExpected = false;
  return path;
}

export function verifyCodingDeploymentBackup(runtime, database, stageDir, record) {
  const path = observeCodingDeployment(runtime, database, record);
  const target = join(stageDir, 'coding.backup.sqlite');
  if (record.codingBackupPath !== undefined || record.codingBackupHash !== undefined) {
    if (record.codingBackupPath !== target || !/^[a-f0-9]{64}$/.test(record.codingBackupHash ?? '')) throw Error('The retained coding backup identity is invalid. Deployment remains paused.');
    const stat = exists(target) ? lstatSync(target) : null;
    if (!stat?.isFile() || stat.isSymbolicLink() || hash(target) !== record.codingBackupHash) throw Error('The retained coding backup is missing, linked or changed. It was not overwritten; deployment remains paused.');
  } else if (path) throw Error('The coding catalog has no verified deployment backup. Deployment remains paused.');
}

export async function backupCodingDeployment(runtime, database, stageDir, record) {
  const path = observeCodingDeployment(runtime, database, record);
  if (record.codingBackupPath !== undefined || record.codingBackupHash !== undefined) {
    verifyCodingDeploymentBackup(runtime, database, stageDir, record);
    return;
  }
  if (path === null) return;
  const target = join(stageDir, 'coding.backup.sqlite');
  if (resolve(target) === resolve(path) || exists(target)) throw Error('The coding backup destination already exists. Preserve it and use a fresh deployment staging directory.');
  await runtime.backupCodingCatalog(path, target, record.id);
  observeCodingDeployment(runtime, database, record);
  record.codingBackupPath = target;
  record.codingBackupHash = hash(target);
}

export function assertCodingDeploymentStopped(runtime, database, orders, record = {}) {
  const path = observeCodingDeployment(runtime, database, record);
  if (path !== null) runtime.assertCodingUpdateStopped(orders);
}
