import { backup, DatabaseSync } from "node:sqlite";
import { openStore, type Store } from "../src/store.js";

/** Initialize an existing-installation fixture once without hundreds of
 * fresh-schema disk commits. Callers copy the closed seed into independent
 * files; production opens, transactions, WAL and locks still run normally. */
export async function writeStoreSeed(file: string, seed?: (store: Store) => void): Promise<void> {
  const memory = new DatabaseSync(":memory:");
  const store = openStore(":memory:", { connect: () => memory });
  try {
    seed?.(store);
    await backup(memory, file);
  } finally { store.close(); }
  const disk = new DatabaseSync(file);
  try { disk.exec("PRAGMA journal_mode = WAL"); }
  finally { disk.close(); }
  // Closing checkpoints all seed content before anyone copies the main file.
}
