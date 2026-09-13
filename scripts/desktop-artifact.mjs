import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** A build owns only a newly reserved, empty output. It never replaces an app. */
export function reserveDesktopArtifact(path) {
  const destination = resolve(path);
  if (!destination.endsWith('.app')) throw Error('Choose a new .app output path. Building never replaces an installed app.');
  mkdirSync(dirname(destination), { recursive: true });
  try { mkdirSync(destination); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('The output already exists. Choose a new .app path; the existing app and its running work are unchanged.');
    throw error;
  }
  const owned = lstatSync(destination);
  const stillOwned = () => {
    try { const now = lstatSync(destination); return now.isDirectory() && !now.isSymbolicLink() && now.ino === owned.ino && now.dev === owned.dev; }
    catch { return false; }
  };
  return {
    publish(stagedApp) {
      if (!stillOwned() || readdirSync(destination).length !== 0) throw Error('The reserved output changed during the build. Nothing was replaced; choose a new output path.');
      // Contents appears only after compilation/signing/notarization succeed.
      // No previous app or task database is moved or deleted by this operation.
      renameSync(join(stagedApp, 'Contents'), join(destination, 'Contents'));
    },
    release() {
      if (!stillOwned()) return;
      try { rmdirSync(destination); }
      catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; }
    },
  };
}
