/** Entry point for the macOS shell. No account credential enters argv or logs. */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { openStore, openStoreNoMigrate, databasePath } from "./store.js";
import { authenticateApprover, hashPassword } from "./scope.js";
import { runOperate, writeLoginFileDurably } from "./operate.js";
import { daemonStatus, installLaunchdService, planDesktopService, stopLaunchdService, type ServiceDefinition, type SupervisorRunner } from "./daemon.js";
import { run as execRun } from "./exec.js";
import { containmentStatus, effectiveContainment, parseContainmentPolicy, probeContainmentCapability, type ContainmentPolicy } from "./containment.js";
import { updateRepos, addRepos } from "./repos.js";
import { projectSelection } from "./project.js";
import type { Store } from "./store.js";
import { superviseController } from "./controller-supervisor.js";
import { normalizeRunnerName, validRunnerName } from "./runner.js";

export type DesktopConfig = { version: 1; databaseFile: string; repos: string[]; port: number; identity: string; runnerName?: string; containment?: ContainmentPolicy };
export function readDesktopConfig(stateDir: string): DesktopConfig {
  const config = JSON.parse(readFileSync(join(stateDir, "desktop.json"), "utf8")) as DesktopConfig;
  if (config.version !== 1 || typeof config.databaseFile !== "string" || !Array.isArray(config.repos) || config.repos.some(repo => typeof repo !== "string") || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.identity)) throw new Error("Desktop configuration is invalid.");
  if (config.runnerName !== undefined && (typeof config.runnerName !== "string" || !validRunnerName(config.runnerName))) throw new Error("Desktop worker identity is invalid.");
  if (config.containment !== undefined && (typeof config.containment !== "string" || !parseContainmentPolicy(config.containment).ok)) throw new Error("Desktop containment policy is invalid.");
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
export function loadOrCreateDesktopConfig(stateDir: string, isolated = false): DesktopConfig {
  if (existsSync(join(stateDir, "desktop.json"))) return readDesktopConfig(stateDir);
  const config: DesktopConfig = { version: 1, databaseFile: isolated ? join(stateDir, "orders.db") : databasePath(process.env, homedir()), repos: [], port: 4187, identity: randomBytes(32).toString("hex"), runnerName: normalizeRunnerName(hostname()) };
  writeDesktopConfig(stateDir, config);
  return config;
}
export function openDesktopStore(file: string): Store {
  if (!existsSync(file)) return openStore(file);
  const opened = openStoreNoMigrate(file);
  if (!opened.ok) throw new Error(`${opened.message} Stop and upgrade the existing controller before opening this desktop build.`);
  return opened.store;
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

/** Share `up`'s existing durable credential, without replacing another login. */
export function pairDesktopLogin(store: Store, file: string, login: { name: string; password: string }): void {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(login.name) || login.password.length < 8 || login.password.trim() !== login.password || /[\r\n\u0000]/.test(login.password)) throw new Error("Use a valid username and a password of at least eight characters without surrounding whitespace or line breaks.");
  const first = store.listApprovers().length === 0;
  if (!first && !authenticateApprover(store, login.name, login.password).ok) throw new Error("This username and password do not match an active operator.");
  const remembered = legacyLogin(file);
  if (remembered === null) {
    // File before row, as in `up`: a crashed bootstrap can adopt the same intent.
    writeLoginFileDurably(file, login.name, login.password);
  } else if (!(first && remembered.name === login.name && remembered.password === login.password) && !authenticateApprover(store, remembered.name, remembered.password).ok) {
    throw new Error("The existing up-login.txt is stale. Restore its valid login before starting the desktop service.");
  }
  if (first) store.bootstrapApproverIfNone(login.name, hashPassword(login.password), new Date());
  if (!authenticateApprover(store, login.name, login.password).ok) throw new Error("Another operator was created during setup. Sign in again.");
}

/** The desktop service definition the shell asks for: the shared launchd contract, labelled by the shell. */
export function desktopServiceDefinition(stateDir: string, args: { node: string; helper: string; label: string; home?: string; providerBin?: string; containment?: ContainmentPolicy }): ServiceDefinition {
  const runtimeDir = dirname(args.node);
  const home = args.home ?? homedir();
  return planDesktopService({
    node: args.node,
    helper: args.helper,
    stateDir,
    label: args.label,
    home,
    environment: { STANDING_ORDERS_CONTAINMENT: args.containment ?? "observed" },
    pathEnv: [runtimeDir, ...(args.providerBin ? [args.providerBin] : []), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  });
}

export type DesktopLiveness = { alive: true; port: number } | { alive: false; port: number; problem: string };

/** The fresh-liveness check: the controller answers its identity challenge on the configured port. */
export async function verifyDesktopLiveness(config: DesktopConfig, fetchImpl: typeof fetch = fetch): Promise<DesktopLiveness> {
  const challenge = randomBytes(32).toString("hex");
  try {
    const response = await fetchImpl(`http://127.0.0.1:${config.port}/desktop/health?challenge=${challenge}`, { signal: AbortSignal.timeout(2_000) });
    if (response.status !== 200) return { alive: false, port: config.port, problem: `the controller answered ${response.status} on port ${config.port}` };
    const body = (await response.json()) as { proof?: unknown };
    const expected = createHmac("sha256", Buffer.from(config.identity, "hex")).update(challenge).digest("hex");
    if (body.proof !== expected) return { alive: false, port: config.port, problem: `something on port ${config.port} is not this installation's controller` };
    return { alive: true, port: config.port };
  } catch (error) {
    return { alive: false, port: config.port, problem: `no controller answered on port ${config.port} (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** `service-start | service-stop | service-status --node <path> --helper <path> --label <label>`: the shell's service verbs, on the shared lifecycle. */
export async function desktopServiceCommand(verb: string, stateDir: string, config: DesktopConfig, argv: string[], supervise: SupervisorRunner = execRun): Promise<Record<string, unknown>> {
  const read = (name: string): string => {
    const at = argv.indexOf(`--${name}`);
    const value = at >= 0 ? argv[at + 1] : undefined;
    if (value === undefined || value.startsWith("--")) throw new Error(`${verb} needs --${name}.`);
    return value;
  };
  const parsed = parseContainmentPolicy(config.containment ?? process.env["STANDING_ORDERS_CONTAINMENT"]);
  if (!parsed.ok) throw new Error(parsed.problem);
  const providerAt = argv.indexOf("--provider-bin");
  const definition = desktopServiceDefinition(stateDir, { node: read("node"), helper: read("helper"), label: read("label"), containment: parsed.policy, ...(providerAt >= 0 ? { providerBin: read("provider-bin") } : {}) });
  if (verb === "service-start") {
    if (config.repos.length === 0) throw new Error("Choose a repository in the desktop app first.");
    // The log stays private: the service writes into the state directory only.
    if (!existsSync(definition.logPath)) writeFileSync(definition.logPath, "", { mode: 0o600 });
    const started = await installLaunchdService(definition, supervise);
    if (!started.ok) throw new Error(started.message);
    return { ok: true, action: started.action, changed: started.changed, label: definition.label, unit: definition.unitPath };
  }
  if (verb === "service-stop") {
    const stopped = await stopLaunchdService(definition, supervise);
    if (!stopped.ok) throw new Error(stopped.message);
    return { ok: true, wasLoaded: stopped.wasLoaded, label: definition.label };
  }
  if (verb === "service-status") {
    const status = await daemonStatus(definition, supervise);
    const liveness = status.state === "running" ? await verifyDesktopLiveness(config) : null;
    return { ok: true, ...status, label: definition.label, liveness, containment: containmentStatus(effectiveContainment(parsed.policy, probeContainmentCapability())) };
  }
  throw new Error("Unknown desktop service operation.");
}

export async function desktopMain(argv: string[]): Promise<void> {
  const stateArg = argv.indexOf("--state");
  if (stateArg >= 0 && !argv[stateArg + 1]) throw new Error("--state needs a directory.");
  const defaultState = join(homedir(), "Library", "Application Support", "Standing Orders");
  const stateDir = resolve(stateArg >= 0 ? argv[stateArg + 1]! : defaultState);
  let config = loadOrCreateDesktopConfig(stateDir, stateDir !== defaultState);
  if (argv[0] === "serve") {
    const stopping = new AbortController();
    const stop = (): void => stopping.abort();
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    try {
      await superviseController({ file: process.execPath, argv: [fileURLToPath(import.meta.url), "serve-controller", "--state", stateDir], signal: stopping.signal,
        onState: state => {
          const path = join(stateDir, "controller-supervisor.json");
          const temp = `${path}.${process.pid}.tmp`;
          writeFileSync(temp, JSON.stringify({ version: 1, supervisorPid: process.pid, updatedAt: new Date().toISOString(), ...state }), { mode: 0o600 });
          renameSync(temp, path);
          if (state.phase === "backoff") console.error(`Controller exited (${state.exit?.signal ?? state.exit?.code ?? "unknown"}); restart in ${state.retryMs} ms.`);
        },
      });
    } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
    return;
  }
  // Inspection and launch must never migrate another running controller.
  const store = openDesktopStore(config.databaseFile);
  const legacyFile = join(dirname(config.databaseFile), "up-login.txt");
  if (argv[0] !== "serve-controller") {
    try {
      if (argv[0] === "inspect") {
        const legacy = legacyLogin(legacyFile);
        console.log(JSON.stringify({ ...config, names: store.listApprovers().map(one => one.name), importable: legacy !== null && authenticateApprover(store, legacy.name, legacy.password).ok }));
      } else if (argv[0] === "import-login") {
        // Only the native helper's private stdout pipe receives this value.
        const legacy = legacyLogin(legacyFile);
        if (legacy === null || !authenticateApprover(store, legacy.name, legacy.password).ok) throw new Error("No valid remembered login is available.");
        console.log(JSON.stringify(legacy));
      } else if (argv[0] === "pair") {
        const login = await readInput();
        pairDesktopLogin(store, legacyFile, login);
        console.log(JSON.stringify({ ok: true }));
      } else if (argv[0] === "add-repo" || argv[0] === "add-repos") {
        config = await addDesktopProjects(stateDir, store, argv.slice(1, stateArg < 0 ? undefined : stateArg));
        console.log(JSON.stringify({ ok: true, repos: config.repos }));
      } else if (argv[0] === "containment") {
        const parsed = parseContainmentPolicy(argv[1]);
        if (!argv[1] || !parsed.ok) throw new Error("containment needs observed, preferred, or required.");
        store.transact(() => { const latest = readDesktopConfig(stateDir); latest.containment = parsed.policy; writeDesktopConfig(stateDir, latest); });
        console.log(JSON.stringify({ ok: true, containment: parsed.policy, restartRequired: true }));
      } else if (argv[0] === "service-start" || argv[0] === "service-stop" || argv[0] === "service-status") {
        console.log(JSON.stringify(await desktopServiceCommand(argv[0], stateDir, config, argv.slice(1))));
      } else throw new Error("Unknown desktop operation.");
    } finally { store.close(); }
    return;
  }

  if (config.repos.length === 0) { store.close(); throw new Error("Choose a repository in the desktop app first."); }
  // Persist the legacy default once, under the same lock as project edits.
  // Explicit identity makes a restart await its predecessor's real liveness
  // fences instead of creating hostname-2 and stranding the old worker's work.
  if (config.runnerName === undefined || config.containment === undefined) {
    config = store.transact(() => {
      const latest = readDesktopConfig(stateDir);
      if (latest.runnerName === undefined) latest.runnerName = normalizeRunnerName(hostname());
      if (latest.containment === undefined) {
        const parsed = parseContainmentPolicy(process.env["STANDING_ORDERS_CONTAINMENT"]);
        if (!parsed.ok) throw new Error(parsed.problem);
        latest.containment = parsed.policy;
      }
      writeDesktopConfig(stateDir, latest);
      return latest;
    });
  }
  store.close();
  // Reuse the same registry supervisor, worker, custody, and recovery paths as
  // the CLI. The service parent owns this controller; closing the web view
  // owns nothing here. `serve-controller` is its child entry, never a new engine.
  const remembered = legacyLogin(legacyFile);
  const exit = await runOperate("up", ["--db", config.databaseFile, ...(remembered === null ? [] : ["--as", remembered.name]),
    "--runner", config.runnerName!, "--containment", config.containment!, "--host", "127.0.0.1", "--port", String(config.port), "--no-open", "--json"], line => console.log(line), {
      desktopIdentity: config.identity, inferProjectFromCwd: false, openDatabase: openDesktopStore,
      additionalProjectRepos: () => readDesktopConfig(stateDir).repos,
    });
  if (exit !== 0) throw new Error("The local controller could not start. Review the service log.");

}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  desktopMain(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : "Desktop service failed."); process.exitCode = 1; });
}
