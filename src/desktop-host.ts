/** Entry point for the macOS shell. No account credential enters argv or logs. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { openStore, databasePath } from "./store.js";
import { authenticateApprover, hashPassword } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { DesktopWorkers, desktopRunnerName } from "./desktop-workers.js";
import { updateRepos, addRepos } from "./repos.js";
import { projectSelection } from "./project.js";
import type { Store } from "./store.js";

export type DesktopConfig = { version: 1; databaseFile: string; repos: string[]; port: number; identity: string };
export function readDesktopConfig(stateDir: string): DesktopConfig {
  const config = JSON.parse(readFileSync(join(stateDir, "desktop.json"), "utf8")) as DesktopConfig;
  if (config.version !== 1 || typeof config.databaseFile !== "string" || !Array.isArray(config.repos) || config.repos.some(repo => typeof repo !== "string") || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.identity)) throw new Error("Desktop configuration is invalid.");
  config.repos = [...new Set(config.repos.map(repo => {
    try { return realpathSync(repo); }
    catch (error) {
      // An unplugged volume or moved checkout must never reset the account,
      // database selection, or service identity. Keep it visible for recovery.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(repo);
      throw error;
    }
  }))];
  return config;
}
export function writeDesktopConfig(stateDir: string, config: DesktopConfig): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "desktop.json");
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

export async function addDesktopProjects(stateDir: string, store: Store, paths: string[], exact = false): Promise<DesktopConfig> {
  const repos = await projectSelection(paths);
  if (exact && JSON.stringify(repos) !== JSON.stringify(paths)) throw new Error("A selected project moved. Review the selection again.");
  const current = readDesktopConfig(stateDir);
  const enrolled = await updateRepos(join(dirname(current.databaseFile), "repos.json"), existing => addRepos(existing, repos));
  if (!enrolled.ok) throw new Error(enrolled.message);
  // Native helpers and the browser share this database lock. Read/merge/write
  // synchronously under it so simultaneous selections cannot lose a project.
  return store.transact(() => {
    const latest = readDesktopConfig(stateDir);
    latest.repos = [...new Set([...latest.repos, ...repos])];
    writeDesktopConfig(stateDir, latest);
    return latest;
  });
}
function loadOrCreate(stateDir: string): DesktopConfig {
  if (existsSync(join(stateDir, "desktop.json"))) return readDesktopConfig(stateDir);
  const config: DesktopConfig = { version: 1, databaseFile: databasePath(process.env, homedir()), repos: [], port: 4187, identity: randomBytes(32).toString("hex") };
  writeDesktopConfig(stateDir, config);
  return config;
}
async function readInput(): Promise<{ name: string; password: string }> {
  let input = "";
  for await (const part of process.stdin) {
    input += String(part);
    if (input.length > 8192) throw new Error("Credential input too large.");
  }
  const value: unknown = JSON.parse(input);
  if (typeof value !== "object" || value === null || !("name" in value) || !("password" in value) || typeof value.name !== "string" || typeof value.password !== "string") throw new Error("A username and password are required.");
  return { name: value.name, password: value.password };
}
function legacyLogin(file: string): { name: string; password: string } | null {
  try {
    const input = readFileSync(file, "utf8").trim();
    const index = input.indexOf(" ");
    return index < 1 ? null : { name: input.slice(0, index), password: input.slice(index + 1) };
  } catch { return null; }
}

export async function desktopMain(argv: string[]): Promise<void> {
  const stateArg = argv.indexOf("--state");
  const stateDir = resolve(stateArg >= 0 ? argv[stateArg + 1] ?? "" : join(homedir(), "Library", "Application Support", "Standing Orders"));
  let config = loadOrCreate(stateDir);
  const store = openStore(config.databaseFile);
  const legacyFile = join(dirname(config.databaseFile), "up-login.txt");
  if (argv[0] !== "serve") {
    try {
      if (argv[0] === "inspect") {
        const legacy = legacyLogin(legacyFile);
        console.log(JSON.stringify({ ...config, names: store.listApprovers().map(one => one.name), importable: legacy !== null && authenticateApprover(store, legacy.name, legacy.password).ok }));
      } else if (argv[0] === "import-login") {
        // Only the native helper's private stdout pipe receives this value.
        const legacy = legacyLogin(legacyFile);
        if (legacy === null || !authenticateApprover(store, legacy.name, legacy.password).ok) throw new Error("No valid remembered login is available.");
        console.log(JSON.stringify(legacy));
      } else if (argv[0] === "pair" || argv[0] === "remove-legacy") {
        const login = await readInput();
        if (argv[0] === "pair" && store.listApprovers().length === 0) {
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(login.name) || login.password.length < 8) throw new Error("Use a valid username and a password of at least eight characters.");
          // The shell saves to Keychain first. It can repeat this after a crash.
          store.bootstrapApproverIfNone(login.name, hashPassword(login.password), new Date());
        }
        if (!authenticateApprover(store, login.name, login.password).ok) throw new Error("This username and password do not match an active operator.");
        if (argv[0] === "remove-legacy") {
          const old = legacyLogin(legacyFile);
          if (old?.name === login.name && old.password === login.password) unlinkSync(legacyFile);
        }
        console.log(JSON.stringify({ ok: true }));
      } else if (argv[0] === "add-repo" || argv[0] === "add-repos") {
        config = await addDesktopProjects(stateDir, store, argv.slice(1, stateArg < 0 ? undefined : stateArg));
        console.log(JSON.stringify({ ok: true, repos: config.repos }));
      } else throw new Error("Unknown desktop operation.");
    } finally { store.close(); }
    return;
  }

  if (config.repos.length === 0) { store.close(); throw new Error("Choose a repository in the desktop app first."); }
  const workers = new DesktopWorkers(store, config.databaseFile, () => config.repos);
  const refreshConfig = () => {
    const next = readDesktopConfig(stateDir);
    if (next.databaseFile !== config.databaseFile || next.port !== config.port || next.identity !== config.identity) throw new Error("Restart the service to change its connection settings.");
    config = next;
    return config.repos;
  };
  const server = createDecisionServer({ store, evidenceRoot: join(dirname(config.databaseFile), "evidence"),
    telegramTokenFile: join(dirname(config.databaseFile), "telegram-token"),
    configDir: dirname(config.databaseFile), registryPath: join(dirname(config.databaseFile), "repos.json"), repos: config.repos,
    localRunner: "desktop", localRunners: config.repos.map(desktopRunnerName), poolRoot: join(dirname(config.databaseFile), "worktrees"),
    localControl: workers, desktopIdentity: config.identity,
    projectManager: { browseRoots: [homedir()], repos: refreshConfig,
      add: async repos => { config = await addDesktopProjects(stateDir, store, repos, true); } } });
  const listen = () => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); });
  await listen();
  console.log(`Standing Orders desktop console listening on 127.0.0.1:${config.port}. Workers are stopped until started in the console.`);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await workers.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  desktopMain(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : "Desktop service failed."); process.exitCode = 1; });
}
