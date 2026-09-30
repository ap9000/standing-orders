import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "./store.js";
import { updateAdmissionPaused, UPDATE_PAUSED } from "./desktop-update-gate.js";
import {
  checkProvenance, findSigstoreVerifier, lastCompletedUpdate, launchRuntimeUpdate, machineSystem, prepareRuntimeUpdate, pruneRuntimes, readRuntimeUpdate, releaseNotes, requestRuntimeUpdateCancel, resumeRuntimeUpdate, runtimeUpdateStatus, markWhatsNewSeen,
  startRuntimeRollback, startRuntimeUpdate, PROVENANCE_ISSUER, PROVENANCE_REPOSITORY, PROVENANCE_WORKFLOW, UPDATE_JOB_LABEL, UPDATE_STEPS, type RuntimePhase, type UpdateSystem,
} from "./toolroll-update.js";
import { REGISTRY, setUpdateChecks } from "./releases.js";
import { runUpdateCommand } from "./toolroll-update-cli.js";
import { updatesHtml } from "./toolroll-update-ui.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";

const TARBALL = new TextEncoder().encode("the toolroll 0.7.0 package bytes");
const sha512 = (bytes: Uint8Array) => createHash("sha512").update(bytes).digest();

// ---- a Sigstore bundle, as npm serves one: a DSSE envelope signed by a short-lived certificate ----
const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts), n = body.length;
  return Buffer.concat([Buffer.from([tag]), Buffer.from(n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]), body]);
};
const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [a! * 40 + b!];
  for (const n of rest) { const chunk = [n & 0x7f]; for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80); bytes.push(...chunk); }
  return der(0x06, Buffer.from(bytes));
};
const utf8 = (text: string) => der(0x0c, Buffer.from(text));
const extension = (id: string, value: Buffer) => seq(oid(id), der(0x04, value));
const SIGNING = generateKeyPairSync("ec", { namedCurve: "P-256" });
const OTHER_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" });
type Identity = { repository?: string; workflow?: string; issuer?: string };
/** A Fulcio-shaped signing certificate: the identity is in its extensions and subjectAltName. */
function signingCertificate(identity: Identity = {}, key: { publicKey: KeyObject; privateKey: KeyObject } = SIGNING): Buffer {
  const repository = identity.repository ?? PROVENANCE_REPOSITORY, workflow = `${repository}/${identity.workflow ?? PROVENANCE_WORKFLOW}@refs/tags/v0.7.0`, issuer = identity.issuer ?? PROVENANCE_ISSUER;
  const ecdsa = seq(oid("1.2.840.10045.4.3.2"));
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), ecdsa,
    seq(der(0x31, seq(oid("2.5.4.3"), utf8("sigstore-intermediate")))), seq(der(0x17, Buffer.from("260101000000Z")), der(0x17, Buffer.from("360101000000Z"))), seq(),
    key.publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(
      extension("2.5.29.17", seq(der(0x86, Buffer.from(workflow)))),
      extension("1.3.6.1.4.1.57264.1.1", Buffer.from(issuer)),
      extension("1.3.6.1.4.1.57264.1.8", utf8(issuer)),
      extension("1.3.6.1.4.1.57264.1.9", utf8(workflow)),
      extension("1.3.6.1.4.1.57264.1.12", utf8(repository)),
    )));
  return seq(tbs, ecdsa, der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, key.privateKey)])));
}

/** npm's attestations for a release. The statement always CLAIMS ap9000/toolroll's workflow; `certificate` is who
 * actually signed it, and `signer` the key that signed the envelope. */
function provenance(options: { version?: string; bytes?: Uint8Array; certificate?: Identity; signer?: KeyObject; chain?: boolean } & Identity = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/toolroll@${options.version ?? "0.7.0"}`, digest: { sha512: sha512(options.bytes ?? TARBALL).toString("hex") } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: { buildDefinition: { externalParameters: { workflow: { ref: "refs/tags/v0.7.0", repository: PROVENANCE_REPOSITORY, path: PROVENANCE_WORKFLOW } } } },
  };
  const payload = Buffer.from(JSON.stringify(statement)), payloadType = "application/vnd.in-toto+json";
  const sig = sign("sha256", Buffer.concat([Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${payload.length} `), payload]), options.signer ?? SIGNING.privateKey).toString("base64");
  const rawBytes = signingCertificate({ repository: options.repository, workflow: options.workflow, issuer: options.issuer, ...options.certificate }).toString("base64");
  return { attestations: [
    { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: { dsseEnvelope: { payload: "" } } },
    { predicateType: "https://slsa.dev/provenance/v1", bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: options.chain ? { x509CertificateChain: { certificates: [{ rawBytes }] }, tlogEntries: [] } : { certificate: { rawBytes }, tlogEntries: [] },
      dsseEnvelope: { payloadType, payload: payload.toString("base64"), signatures: [{ keyid: "", sig }] },
    } },
  ] };
}
function fixture(options: { coding?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-update-"))), stateDir = join(root, "state");
  mkdirSync(stateDir);
  const databaseFile = join(stateDir, "orders.db");
  const store = openStore(databaseFile);
  const at = new Date().toISOString();
  store.raw().prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES('T-1','Keep my work','queued',?,?)").run(at, at);
  store.close();
  const codingFile = `${databaseFile}.coding.sqlite`;
  if (options.coding) {
    const d = new DatabaseSync(codingFile);
    d.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE coding_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), token TEXT NOT NULL, pid INTEGER NOT NULL, native_pid INTEGER, clean INTEGER NOT NULL);
      CREATE TABLE coding_session (id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, repo TEXT NOT NULL, document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE coding_item (session TEXT NOT NULL, id TEXT NOT NULL, position INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, UNIQUE(session,id));
      CREATE TABLE coding_request (token TEXT PRIMARY KEY, session TEXT NOT NULL, rpc_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE coding_submission (session TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, error TEXT, PRIMARY KEY(session,key));
      INSERT INTO coding_owner VALUES(1,'',0,NULL,1);
      INSERT INTO coding_session(id,owner,generation,repo,document) VALUES('coding-before','fixture',1,'/repo','{"status":"ready"}');
      INSERT INTO coding_item(session,id,payload) VALUES('coding-before','item-before','{}');`);
    d.close();
  }
  const oldDist = join(root, "global", "lib", "node_modules", "toolroll", "dist");
  mkdirSync(oldDist, { recursive: true }); writeFileSync(join(oldDist, "bin.js"), "// 0.6.0");
  const bin = join(root, "bin"); mkdirSync(bin);
  const links = ["toolroll", "standing-orders"].map(name => { const path = join(bin, name); symlinkSync(join(oldDist, "bin.js"), path); return path; });
  const unit = join(root, "com.toolroll.browser.plist");
  const unitText = `<plist><string>${oldDist}/controller-service.js</string><string>${oldDist}/cli.js</string></plist>`;
  writeFileSync(unit, unitText);
  const calls: string[] = [], phases: RuntimePhase[] = [], sigstoreChecked: { issuer: string; identity: string }[] = [];
  let clock = Date.parse("2026-09-29T20:00:00Z");
  // The service: running until stopped, with one process that exits when it stops.
  let serviceRunning = true;
  const system: UpdateSystem = {
    now: () => new Date(clock),
    sleep: async ms => { clock += ms; },
    release: async version => ({ version, tarball: `https://registry.npmjs.org/toolroll/-/toolroll-${version}.tgz`, integrity: `sha512-${sha512(TARBALL).toString("base64")}`, attestations: `https://registry.npmjs.org/-/npm/v1/attestations/toolroll@${version}` }),
    download: async () => TARBALL,
    attestations: async () => provenance(),
    install: async (runtime: string) => {
      const dist = join(runtime, "node_modules", "toolroll", "dist");
      mkdirSync(dist, { recursive: true }); writeFileSync(join(dist, "bin.js"), "// 0.7.0");
      writeFileSync(join(runtime, "node_modules", "toolroll", "CHANGELOG.md"), "# Changelog\n\n## 0.7.0 — 2026-10-01\n\n- **Updates from the console.** Details.\n\n- **Faster chat.** More.\n\n## 0.6.0\n\n- **Old.**\n");
      calls.push("install"); return dist;
    },
    rehearse: async (_dist, copy) => { calls.push("rehearse"); const db = new DatabaseSync(copy); try { db.exec("CREATE TABLE IF NOT EXISTS added_by_new_version(x)"); } finally { db.close(); } },
    sigstore: async (_bundle, identity) => { sigstoreChecked.push(identity); },
    commands: () => links,
    serviceUnit: from => readFileSync(unit, "utf8").includes(from.dist) ? unit : null,
    watchUnits: () => [],
    servicePids: async () => serviceRunning ? [4242] : [],
    serviceLoaded: async () => true,
    restartService: async () => { calls.push("restart"); serviceRunning = true; },
    stopService: async () => { calls.push("stop"); serviceRunning = false; },
    processAlive: () => serviceRunning,
    healthy: async () => { calls.push("health"); return true; },
    healthTimeoutMs: 3000,
    checkpoint: phase => { phases.push(phase); },
  };
  const db = () => new DatabaseSync(databaseFile);
  const ledger = () => { const d = db(); try { return d.prepare("SELECT action, outcome, detail, actor FROM action_ledger WHERE action LIKE 'toolroll %' ORDER BY id").all() as { action: string; outcome: string; detail: string; actor: string }[]; } finally { d.close(); } };
  const tasks = (file = databaseFile) => { const d = new DatabaseSync(file); try { return d.prepare("SELECT id FROM task ORDER BY id").all().map(r => String(r["id"])); } finally { d.close(); } };
  const coding = (sql: string) => { const d = new DatabaseSync(codingFile); try { return d.prepare(sql).all().map(r => Object.values(r).join(",")); } finally { d.close(); } };
  const gates = () => [...coding("SELECT name FROM sqlite_master WHERE type='trigger'"), ...(() => { const d = db(); try { return d.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_*update_*'").all().map(r => String(r["name"])); } finally { d.close(); } })()];
  const paused = () => { const d = db(); try { return updateAdmissionPaused(d as never); } finally { d.close(); } };
  const current = { version: "0.6.0", dist: oldDist };
  const start = (overrides: Partial<UpdateSystem> = {}, when: "now" | "when-idle" | "at" = "when-idle", at: string | null = null, actor = "ada") =>
    startRuntimeUpdate({ stateDir, databaseFile, current, actor, version: "0.7.0", when, at }, { ...system, ...overrides });
  const startRun = () => {
    const d = db();
    try {
      d.exec("INSERT INTO task_ref(backend,external_id) VALUES('built-in','T-1')");
      const ref = d.prepare("SELECT id FROM task_ref WHERE external_id='T-1'").get()!["id"];
      return Number(d.prepare("INSERT INTO run(task_ref,lease_id,runner,role,started_at) VALUES(?,'lease','fixture','reviewer',?)").run(ref as number, at).lastInsertRowid);
    } finally { d.close(); }
  };
  const finishRun = (id: number) => { const d = db(); try { d.prepare("UPDATE run SET outcome='interrupted', finished_at=? WHERE id=?").run(new Date().toISOString(), id); } finally { d.close(); } };
  const write = (id: string, file = databaseFile) => { const d = new DatabaseSync(file); try { d.prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES(?,?,'queued','x','x')").run(id, id); } finally { d.close(); } };
  return { root, stateDir, databaseFile, codingFile, oldDist, links, unit, unitText, calls, phases, sigstoreChecked, system, db, ledger, tasks, coding, gates, write, paused, current, start, startRun, finishRun, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("c1: a scripted update runs verify, drain, backup, rehearse, switch, restart and health in order", async () => {
  const f = fixture();
  try {
    const outcome = await f.start();
    expect(outcome.ok).toBe(true);
    const j = outcome.journal!;
    expect(j.phase).toBe("complete");
    expect(j.steps.map(s => s.phase)).toEqual([...UPDATE_STEPS, "complete"]);
    expect(f.phases.filter(p => (UPDATE_STEPS as readonly string[]).includes(p)).filter((p, i, all) => all.indexOf(p) === i)).toEqual([...UPDATE_STEPS]);
    expect(f.calls).toEqual(["install", "stop", "rehearse", "restart", "health"]);
    // Staged beside the current runtime, never over it.
    expect(j.to.dist.startsWith(join(f.stateDir, "staged-upgrades"))).toBe(true);
    expect(readFileSync(join(f.oldDist, "bin.js"), "utf8")).toBe("// 0.6.0");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(j.to.dist, "bin.js"));
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText.replaceAll(f.oldDist, j.to.dist));
    expect(j.package).toMatchObject({ repository: PROVENANCE_REPOSITORY, workflow: PROVENANCE_WORKFLOW });
    expect(j.rehearsal?.rows).toBeGreaterThan(0);
    expect(existsSync(j.backupPath!)).toBe(true);
    expect(f.paused()).toBe(false);
    expect(f.ledger()).toEqual([{ action: "toolroll updated", outcome: "complete", detail: "0.6.0 → 0.7.0", actor: "ada" }]);
    expect(runtimeUpdateStatus(f.stateDir).whatsNew).toEqual({ version: "0.7.0", notes: ["Updates from the console", "Faster chat"] });
    markWhatsNewSeen(f.stateDir);
    expect(runtimeUpdateStatus(f.stateDir).whatsNew).toBeNull();
  } finally { f.close(); }
});

test("c1: a failed health check restores the previous runtime and database on its own", async () => {
  const f = fixture();
  try {
    const outcome = await f.start({
      // The new service writes to the database, then never becomes healthy.
      restartService: async () => { f.calls.push("restart"); if (f.calls.filter(c => c === "restart").length > 1) return; const d = f.db(); try { d.prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES('T-new','Written by 0.7.0','queued',?,?)").run("x", "x"); } finally { d.close(); } },
      healthy: async () => { f.calls.push("health"); return false; },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.phase).toBe("restored");
    expect(outcome.message).toMatch(/did not pass its health check.*0\.6\.0 and its database were restored/);
    expect(outcome.journal!.steps.map(s => s.phase)).toEqual([...UPDATE_STEPS, "rolling-back", "restored"]);
    expect(f.calls.slice(-2)).toEqual(["stop", "restart"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.paused()).toBe(false);
    expect(f.ledger().map(e => [e.action, e.outcome])).toEqual([["toolroll update failed", "restored"]]);
  } finally { f.close(); }
});

test("c1: an updater that dies at any step resumes from its journal and finishes", async () => {
  for (const crashAt of ["draining", "backing-up", "switching", "restarting", "health"] as const) {
    const f = fixture();
    try {
      await expect(f.start({ checkpoint: phase => { if (phase === crashAt) throw Object.assign(Error("crash"), { simulatedCrash: true }); } })).rejects.toThrow("crash");
      expect(readRuntimeUpdate(f.stateDir)?.phase).toBe(crashAt);
      const outcome = await resumeRuntimeUpdate(f.stateDir, f.system);
      expect(outcome.phase).toBe("complete");
      expect(f.paused()).toBe(false);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(outcome.journal!.to.dist, "bin.js"));
      expect(readFileSync(f.unit, "utf8")).toBe(f.unitText.replaceAll(f.oldDist, outcome.journal!.to.dist));
    } finally { f.close(); }
  }
});

test("c2: a wrongly attributed package is refused before anything changes", async () => {
  for (const wrong of [{ repository: "https://github.com/someone/toolroll" }, { workflow: ".github/workflows/other.yml" }, { bytes: new TextEncoder().encode("other bytes") }, { version: "0.6.9" }]) {
    const f = fixture();
    try {
      const before = readFileSync(f.databaseFile);
      const outcome = await f.start({ attestations: async () => provenance(wrong) });
      expect(outcome.phase).toBe("refused");
      expect(outcome.message).toMatch(/Nothing was changed/);
      expect(f.calls).toEqual([]);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
      expect(f.paused()).toBe(false);
      expect(existsSync(join(outcome.journal!.stageDir, "runtime"))).toBe(false);
      expect(outcome.journal!.backupPath).toBeUndefined();
      expect(f.ledger().map(e => [e.action, e.outcome])).toEqual([["toolroll update refused", "refused"]]);
      expect(before.length).toBeGreaterThan(0);
    } finally { f.close(); }
  }
});

test("c2: an unverifiable package is refused: no provenance, wrong checksum, or no signatures", async () => {
  const cases: Partial<UpdateSystem>[] = [
    { release: async version => ({ version, tarball: "https://registry.npmjs.org/x.tgz", integrity: `sha512-${sha512(TARBALL).toString("base64")}`, attestations: null }) },
    { attestations: async () => ({ attestations: [] }) },
    { download: async () => new TextEncoder().encode("tampered") },
    { install: async () => { throw Object.assign(new (class Refusal extends Error {})("npm could not verify the package signatures. Nothing was changed.")); } },
  ];
  for (const overrides of cases) {
    const f = fixture();
    try {
      const outcome = await f.start(overrides);
      expect(outcome.ok).toBe(false);
      expect(["refused"]).toContain(outcome.phase);
      expect(f.calls).not.toContain("restart");
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
      expect(f.paused()).toBe(false);
      expect(f.ledger()).toHaveLength(1);
    } finally { f.close(); }
  }
  expect(() => checkProvenance(provenance(), "0.7.0", sha512(TARBALL).toString("hex"))).not.toThrow();
  expect(() => checkProvenance(provenance({ repository: "https://github.com/ap9000/toolroll-fork" }), "0.7.0", sha512(TARBALL).toString("hex"))).toThrow(/not ap9000\/toolroll/);
});

test("a rehearsal that would change historical rows is refused and new work resumes", async () => {
  const f = fixture();
  try {
    const outcome = await f.start({ rehearse: async (_dist, copy) => { const d = new DatabaseSync(copy); try { d.exec("UPDATE task SET title='rewritten'"); } finally { d.close(); } } });
    expect(outcome.phase).toBe("refused");
    expect(outcome.message).toMatch(/would change saved history in task/);
    expect(f.paused()).toBe(false);
    // The service stopped for the backup starts again, unchanged.
    expect(f.calls).toEqual(["install", "stop", "restart"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
  } finally { f.close(); }
});

test("c3: --now refuses while work runs and names it; a ledger entry records the refusal", async () => {
  const f = fixture();
  try {
    f.startRun();
    const outcome = await f.start({}, "now");
    expect(outcome.phase).toBe("refused");
    expect(outcome.message).toMatch(/Work is running: running T-1 \(Keep my work\)/);
    expect(f.calls).toEqual(["install"]);
    expect(f.paused()).toBe(false);
    expect(f.ledger().map(e => [e.action, e.outcome])).toEqual([["toolroll update refused", "refused"]]);
  } finally { f.close(); }
});

test("c3: --when-idle pauses new work, waits for running work, then updates", async () => {
  const f = fixture();
  try {
    const run = f.startRun();
    const waits: string[] = [];
    const outcome = await f.start({ sleep: async () => {
      waits.push(readRuntimeUpdate(f.stateDir)!.detail);
      expect(f.paused()).toBe(true);
      const d = f.db(); try { expect(() => d.exec("INSERT INTO claim(task_ref, lease_id) VALUES (1, 'x')")).toThrow(UPDATE_PAUSED); } finally { d.close(); }
      if (waits.length === 2) f.finishRun(run);
    } }, "when-idle");
    expect(waits).toHaveLength(2);
    expect(waits[0]).toMatch(/New work is paused\. Waiting for running T-1/);
    expect(outcome.phase).toBe("complete");
    expect(f.ledger().map(e => e.action)).toEqual(["toolroll updated"]);
  } finally { f.close(); }
});

test("c3: --at waits for its time, and a scheduled update can be cancelled", async () => {
  const f = fixture();
  try {
    let slept = 0;
    const outcome = await f.start({ sleep: async () => { slept++; if (slept === 1) expect(requestRuntimeUpdateCancel(f.stateDir)).toMatch(/Cancelling/); } }, "at", "03:00");
    expect(outcome.phase).toBe("cancelled");
    expect(f.calls).toEqual([]);
    expect(f.ledger().map(e => e.action)).toEqual(["toolroll update scheduled", "toolroll update cancelled"]);
  } finally { f.close(); }
});

test("c3: --rollback returns to the previous runtime and its backup, keeping a copy of the current database", async () => {
  const f = fixture();
  try {
    const update = await f.start();
    expect(update.phase).toBe("complete");
    const d = f.db(); try { d.prepare("INSERT INTO task(id,title,state,created_at,updated_at) VALUES('T-2','After the update','queued','x','x')").run(); } finally { d.close(); }
    const outcome = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(outcome.phase).toBe("complete");
    expect(outcome.journal!.steps.map(s => s.phase)).toEqual([...UPDATE_STEPS, "complete"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
    expect(f.tasks()).toEqual(["T-1"]);
    const safety = new DatabaseSync(outcome.journal!.backupPath!, { readOnly: true });
    try { expect(safety.prepare("SELECT count(*) n FROM task WHERE id='T-2'").get()!["n"]).toBe(1); } finally { safety.close(); }
    expect(f.paused()).toBe(false);
    // The pre-update backup has no update entries; the rollback records itself afterwards.
    expect(f.ledger().map(e => [e.action, e.detail])).toEqual([["toolroll rolled back", "0.7.0 → 0.6.0 (back)"]]);
    expect(runtimeUpdateStatus(f.stateDir).whatsNew).toBeNull();
    const again = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", when: "when-idle" }, f.system);
    expect(again.message).toBe("There is no completed update to roll back.");
  } finally { f.close(); }
});

test("toolroll update: npx is current, previews change nothing, --now and --when-idle choose the mode", async () => {
  const f = fixture();
  try {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const deps = { system: f.system, current: f.current, databaseFile: f.databaseFile, latest: async () => ({ version: "0.7.0" }) };
    expect(await runUpdateCommand([], write, { ...deps, method: { kind: "npx", updateCommand: "npx toolroll@latest" } })).toBe(0);
    expect(lines.pop()).toMatch(/npx runs the latest Toolroll each time, so this one is current/);
    expect(await runUpdateCommand([], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(0);
    expect(lines.join("\n")).toMatch(/Update Toolroll 0\.6\.0 → 0\.7\.0[\s\S]*Add --yes to update/);
    expect(f.calls).toEqual([]);
    expect(await runUpdateCommand(["--now", "--at", "03:00"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(2);
    f.startRun();
    expect(await runUpdateCommand(["--yes", "--now"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(1);
    expect(lines.pop()).toMatch(/Work is running: running T-1/);
    expect(await runUpdateCommand(["--yes", "--version", "0.6.0"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(0);
    expect(lines.pop()).toBe("Toolroll 0.6.0 is current.");
    expect(await runUpdateCommand(["--yes", "--version", "0.5.0"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(1);
    expect(lines.pop()).toBe("Toolroll 0.5.0 is older than 0.6.0. Add --allow-downgrade to go back to it.");
    expect(await runUpdateCommand(["--rollback"], write, { ...deps, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" } })).toBe(1);
  } finally { f.close(); }
});

test("release notes are the version's changelog headlines", () => {
  expect(releaseNotes("## Unreleased\n\n## 0.7.0 — x\n\n- **One.** a\n- **Two** b\n\n## 0.6.0\n- **Old.**", "0.7.0")).toEqual(["One", "Two"]);
  expect(releaseNotes("## 0.6.0\n- **Old.**", "0.7.0")).toEqual([]);
});

test("Settings → Updates: three buttons behind the password, --now refused while work runs, live steps, then What's new once", async () => {
  const f = fixture();
  const store = openStore(f.databaseFile);
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("alex");
  const launched: { databaseFile: string; id: string }[] = [];
  const configDir = join(f.root, "config"); mkdirSync(configDir); setUpdateChecks(configDir, true);
  const checksEnv = process.env["TOOLROLL_NO_UPDATE_CHECK"]; delete process.env["TOOLROLL_NO_UPDATE_CHECK"];
  const server = createDecisionServer({ store, evidenceRoot: join(f.root, "evidence"), configDir, updates: {
    latest: async () => ({ version: "0.7.0" }), method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" }, current: "0.6.0", dist: f.oldDist,
    // The job resumes the journal the console prepared, by id.
    launch: async args => { launched.push(args); await resumeRuntimeUpdate(f.stateDir, f.system, args.id); },
  } });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const get = async (path = "/settings/updates") => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
    let page = await get();
    expect(page).toContain("Toolroll 0.7.0 is available");
    for (const label of ["Update now", "When idle", "Tonight (03:00)"]) expect(page).toContain(`>${label}</button>`);
    expect(page).toContain('type="password" name="password"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const post = async (fields: Record<string, string>, path = "/settings/updates") => decodeURIComponent((await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, version: "0.7.0", ...fields }), redirect: "manual" })).headers.get("location") ?? "");
    expect(await post({ when: "now", password: "wrong" })).toContain("problem=Enter your Toolroll password");
    const run = f.startRun();
    expect(await post({ when: "now", password: alex.token })).toMatch(/problem=Work is running: running T-1 \(Keep my work\)/);
    expect(launched).toEqual([]);
    f.finishRun(run);
    expect(await post({ when: "now", password: alex.token, version: "0.5.0" })).toContain("problem=Toolroll 0.5.0 is not newer than 0.6.0");
    expect(launched).toEqual([]);
    expect(await post({ when: "now", password: alex.token })).toContain("said=Updating to 0.7.0.");
    expect(launched[0]).toMatchObject({ databaseFile: f.databaseFile, id: readRuntimeUpdate(f.stateDir)!.id });
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ when: "now", actor: "alex", to: { version: "0.7.0" } });
    page = await get();
    expect(page).toContain("What’s new in 0.7.0");
    expect(page).toContain("<li>Updates from the console</li>");
    expect(await get("/settings/updates?fragment=steps")).toMatch(/data-done="1".*data-step="health" data-state="done"/s);
    await post({}, "/settings/updates/seen");
    expect(await get()).not.toContain("What’s new in 0.7.0");
    expect(f.ledger().map(e => [e.action, e.actor])).toEqual([["toolroll updated", "alex"]]);
  } finally {
    if (checksEnv !== undefined) process.env["TOOLROLL_NO_UPDATE_CHECK"] = checksEnv;
    await new Promise<void>(done => server.close(() => done()));
    store.close(); f.close();
  }
}, 30_000);

// ---- the rework: coding catalog, the one-off job, stopping, provenance, kept writes, refusals, Settings ----

test("c1: a failed update leaves the coding catalog ungated and restored with the database", async () => {
  const f = fixture({ coding: true });
  try {
    let restarts = 0;
    const outcome = await f.start({
      restartService: async () => {
        f.calls.push("restart");
        if (++restarts > 1) return;
        // The new version writes to both files while it runs, then fails its health check.
        f.write("T-new");
        const d = new DatabaseSync(f.codingFile); try { d.exec("INSERT INTO coding_item(session,id,payload) VALUES('coding-before','item-new','{}')"); } finally { d.close(); }
      },
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("restored");
    const j = outcome.journal!;
    expect(j.codingBackupPath && existsSync(j.codingBackupPath)).toBe(true);
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.coding("SELECT id FROM coding_item ORDER BY id")).toEqual(["item-before"]);
    expect(f.gates()).toEqual([]);
    expect(f.paused()).toBe(false);
  } finally { f.close(); }
});

test("c1: a rollback restores the coding catalog with the database and leaves it ungated", async () => {
  const f = fixture({ coding: true });
  try {
    const update = await f.start();
    expect(update.phase).toBe("complete");
    expect(f.gates()).toEqual([]);
    const d = new DatabaseSync(f.codingFile); try { d.exec("INSERT INTO coding_session(id,owner,generation,repo,document) VALUES('coding-after','fixture',1,'/repo','{}')"); } finally { d.close(); }
    const outcome = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(outcome.phase).toBe("complete");
    expect(f.coding("SELECT id FROM coding_session ORDER BY id")).toEqual(["coding-before"]);
    expect(f.gates()).toEqual([]);
    // The rollback's own backup keeps the catalog as it was, coding-after included.
    const kept = new DatabaseSync(outcome.journal!.codingBackupPath!, { readOnly: true });
    try { expect(kept.prepare("SELECT count(*) n FROM coding_session WHERE id='coding-after'").get()!["n"]).toBe(1); } finally { kept.close(); }
  } finally { f.close(); }
});

test("c1: a rollback that fails its health check puts the catalog back as it was before the rollback, ungated", async () => {
  const f = fixture({ coding: true });
  try {
    const update = await f.start();
    const d = new DatabaseSync(f.codingFile); try { d.exec("INSERT INTO coding_session(id,owner,generation,repo,document) VALUES('coding-after','fixture',1,'/repo','{}')"); } finally { d.close(); }
    const outcome = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, { ...f.system, healthy: async () => false });
    expect(outcome.phase).toBe("restored");
    expect(f.coding("SELECT id FROM coding_session ORDER BY id")).toEqual(["coding-after", "coding-before"]);
    expect(f.gates()).toEqual([]);
  } finally { f.close(); }
});

test("c2: the one-off update job has no RunAtLoad, starts by kickstart, and resumes only its journal id", async () => {
  const f = fixture();
  try {
    const launchctl: string[][] = [];
    const run = async (file: string, args: readonly string[]) => { if (file === "launchctl") launchctl.push([...args]); return { code: args[0] === "print" ? 113 : 0, stdout: "", stderr: "", timedOut: false }; };
    const home = join(f.root, "home");
    const id = randomUUID();
    await launchRuntimeUpdate({ databaseFile: f.databaseFile, id, dist: f.oldDist }, { home, run: run as never, platform: "darwin" });
    const plist = readFileSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`), "utf8");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
    expect(plist).toContain(`<string>--resume</string>\n    <string>--id</string>\n    <string>${id}</string>`);
    expect(plist).not.toContain("--yes");
    expect(plist).not.toContain("--version");
    expect(launchctl.map(args => args[0])).toEqual(["print", "enable", "bootstrap", "kickstart"]);
    // Run at a login with no saved update: the job starts nothing and removes its own definition.
    const lines: string[] = [];
    expect(await runUpdateCommand(["--resume", "--id", id, "--db", f.databaseFile], line => lines.push(line), { system: f.system, current: f.current, home })).toBe(0);
    expect(lines).toEqual(["The update this job was started for is no longer the saved one. Nothing was changed."]);
    expect(f.calls).toEqual([]);
    expect(readRuntimeUpdate(f.stateDir)).toBeNull();
    expect(existsSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`))).toBe(false);
  } finally { f.close(); }
});

test("c2: a rolled-back release is not re-applied when its job runs again", async () => {
  const f = fixture();
  try {
    const prepared = prepareRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", version: "0.7.0", when: "now" }, f.system.now());
    if ("refused" in prepared) throw Error(prepared.refused);
    const home = join(f.root, "home"); mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    const job = () => runUpdateCommand(["--resume", "--id", prepared.id], () => {}, { system: f.system, current: f.current, databaseFile: f.databaseFile, home });
    expect(await job()).toBe(0);
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ id: prepared.id, phase: "complete" });
    const rollback = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: readRuntimeUpdate(f.stateDir)!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(rollback.phase).toBe("complete");
    const calls = f.calls.length;
    // The same job, started again (a login, a stray kickstart): the saved record is the rollback, so nothing runs.
    writeFileSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`), `<plist><string>${prepared.id}</string></plist>`);
    expect(await job()).toBe(0);
    expect(f.calls).toHaveLength(calls);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ kind: "rollback", phase: "complete" });
    expect(existsSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`))).toBe(false);
    // And a finished update's job does nothing either.
    expect((await resumeRuntimeUpdate(f.stateDir, f.system, readRuntimeUpdate(f.stateDir)!.id)).message).toBe("No update is in progress.");
  } finally { f.close(); }
});

/** A scripted launchctl: bootout returns before the label is gone, as it does on a real Mac. */
function scriptedLaunchctl() {
  const state = { loaded: true, pid: 4242, pendingPrints: 0, log: [] as string[] };
  const run = async (_file: string, args: readonly string[]) => {
    state.log.push(args[0]!);
    const ok = { code: 0, stdout: "", stderr: "", timedOut: false };
    if (args[0] === "print") {
      if (state.pendingPrints > 0 && --state.pendingPrints === 0) state.loaded = false;
      return state.loaded ? { ...ok, stdout: `com.toolroll.browser = {\n\tstate = running\n\tpid = ${state.pid}\n}` } : { ...ok, code: 113 };
    }
    if (args[0] === "bootout") state.pendingPrints = 2;
    if (args[0] === "bootstrap") { state.loaded = true; state.pid = 5151; state.pendingPrints = 0; }
    return ok;
  };
  return { state, run };
}

test("c3: restoreDatabase runs only after the stopped service's process is gone (scripted launchctl)", async () => {
  const f = fixture();
  try {
    const launchctl = scriptedLaunchctl();
    let exitsAfter = 0, checkedWhileAlive = 0, stops = 0;
    const machine = machineSystem(join(f.root, "home"), {}, { run: launchctl.run as never, alive: pid => {
      if (pid !== 4242 && pid !== 5151) return false;
      // Each stop leaves its process running for a few more checks; the database must not change meanwhile.
      if (exitsAfter-- > 0) { checkedWhileAlive++; if (stops > 1) expect(f.tasks()).toContain("T-new"); return true; }
      return false;
    } });
    const outcome = await f.start({
      servicePids: machine.servicePids,
      stopService: async unit => { stops++; exitsAfter = 3; await machine.stopService(unit); },
      restartService: async unit => { await machine.restartService(unit); if (stops === 1) f.write("T-new"); },
      processAlive: machine.processAlive,
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("restored");
    expect(checkedWhileAlive).toBe(6);
    expect(f.tasks()).toEqual(["T-1"]);
    expect(launchctl.state.log.filter(verb => verb !== "print")).toEqual(["disable", "bootout", "enable", "bootstrap", "kickstart", "disable", "bootout", "enable", "bootstrap", "kickstart"]);
    // The waits happened at the launchd boundary too: print was polled until the label disappeared.
    expect(launchctl.state.log.filter(verb => verb === "print").length).toBeGreaterThanOrEqual(6);
  } finally { f.close(); }
});

test("c3: a service process that never exits is never written under: the database is not replaced", async () => {
  const f = fixture();
  try {
    const launchctl = scriptedLaunchctl();
    let stops = 0;
    const machine = machineSystem(join(f.root, "home"), {}, { run: launchctl.run as never, alive: pid => stops > 1 && pid === 5151 });
    const outcome = await f.start({
      servicePids: machine.servicePids, processAlive: machine.processAlive, exitTimeoutMs: 5000,
      stopService: async unit => { stops++; await machine.stopService(unit); },
      restartService: async unit => { await machine.restartService(unit); if (stops === 1) f.write("T-new"); },
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("needs-attention");
    expect(outcome.message).toMatch(/still running \(process 5151\) after it was stopped\. Nothing was replaced/);
    expect(f.tasks()).toEqual(["T-1", "T-new"]);
  } finally { f.close(); }
});

test("c3: every rename is fsynced first, and its directory after (update, restore and rollback)", async () => {
  const f = fixture({ coding: true });
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
  const paths = new Map<number, string>(), events: { kind: "fsync" | "rename"; path: string; to?: string }[] = [];
  fs.openSync = ((path: string, ...rest: unknown[]) => { const fd = (real.openSync as (...a: unknown[]) => number)(path, ...rest); paths.set(fd, String(path)); return fd; }) as typeof fs.openSync;
  fs.fsyncSync = ((fd: number) => { events.push({ kind: "fsync", path: paths.get(fd) ?? "?" }); real.fsyncSync(fd); }) as typeof fs.fsyncSync;
  fs.renameSync = ((from: string, to: string) => { events.push({ kind: "rename", path: String(from), to: String(to) }); real.renameSync(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    expect((await f.start({ healthy: async () => false })).phase).toBe("restored");
    const update = await f.start();
    expect((await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system)).phase).toBe("complete");
    const renames = events.map((event, i) => ({ event, i })).filter(({ event }) => event.kind === "rename" && event.path.startsWith(f.root));
    expect(renames.map(({ event }) => event.to)).toEqual(expect.arrayContaining([f.databaseFile, f.codingFile, f.unit, ...f.links]));
    for (const { event, i } of renames) {
      const before = events[i - 1]!, after = events[i + 1]!;
      expect(before.kind).toBe("fsync");
      expect([event.path, dirname(event.path)]).toContain(before.path);
      expect(after).toEqual({ kind: "fsync", path: dirname(event.to!) });
    }
  } finally {
    Object.assign(fs, real); syncBuiltinESMExports();
    f.close();
  }
});

/** npm, scripted: installs the named release from the registry, writes its lockfile, and reports its signatures. */
function scriptedNpm(options: { integrity?: string; audit?: { status: number; stdout: string } } = {}) {
  const calls: { args: string[]; spec: unknown }[] = [];
  const exec = (_command: string, args: string[], opts: { cwd?: string } = {}) => {
    const cwd = opts.cwd!;
    calls.push({ args, spec: (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies });
    if (args[0] === "install") {
      const dist = join(cwd, "node_modules", "toolroll", "dist"); mkdirSync(dist, { recursive: true }); writeFileSync(join(dist, "bin.js"), "// 0.7.0");
      writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ packages: { "node_modules/toolroll": { version: "0.7.0", resolved: `${REGISTRY}/toolroll/-/toolroll-0.7.0.tgz`, integrity: options.integrity ?? `sha512-${sha512(TARBALL).toString("base64")}` } } }));
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "audited 1 package in 1s\n\n1 package has a verified registry signature\n\n1 package has a verified attestation\n", stderr: "", ...options.audit };
  };
  return { exec, calls };
}

test("c4: the release is installed from the registry under npm's signature check, and a tampered or wrong-repository package is refused before anything changes", async () => {
  const good = fixture();
  try {
    const npm = scriptedNpm();
    const outcome = await good.start({ install: machineSystem(join(good.root, "home"), {}, { exec: npm.exec }).install });
    expect(outcome.phase).toBe("complete");
    // By name from the registry, never a local tarball npm would not check; then npm audit signatures on it.
    expect(npm.calls.map(call => call.args.slice(0, 2))).toEqual([["install", "--omit=dev"], ["audit", "signatures"]]);
    expect(npm.calls[0]!.spec).toEqual({ toolroll: "0.7.0" });
    expect(npm.calls[0]!.args).toContain(`--registry=${REGISTRY}/`);
  } finally { good.close(); }
  const tampered: [string, Partial<UpdateSystem>, RegExp][] = [
    ["installed bytes differ", { install: machineSystem(tmpdir(), {}, { exec: scriptedNpm({ integrity: "sha512-c29tZXRoaW5nIGVsc2U=" }).exec }).install }, /npm installed different bytes than the verified Toolroll 0\.7\.0/],
    ["no verified attestation", { install: machineSystem(tmpdir(), {}, { exec: scriptedNpm({ audit: { status: 0, stdout: "1 package has a verified registry signature\n" } }).exec }).install }, /did not verify Toolroll 0\.7\.0's provenance attestation/],
    ["a bad signature", { install: machineSystem(tmpdir(), {}, { exec: scriptedNpm({ audit: { status: 1, stdout: "1 package has an invalid registry signature" } }).exec }).install }, /could not verify the package signatures/],
    ["a tampered tarball", { download: async () => new TextEncoder().encode("tampered") }, /does not match the registry's checksum/],
    ["another repository", { attestations: async () => provenance({ repository: "https://github.com/someone/toolroll" }) }, /built by https:\/\/github.com\/someone\/toolroll/],
  ];
  for (const [label, overrides, message] of tampered) {
    const f = fixture();
    try {
      const outcome = await f.start(overrides);
      expect(outcome.phase, label).toBe("refused");
      expect(outcome.message, label).toMatch(message);
      expect(outcome.message, label).toMatch(/Nothing was changed/);
      expect(f.calls.filter(call => call !== "install"), label).toEqual([]);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
      expect(f.paused()).toBe(false);
      expect(outcome.journal!.backupPath, label).toBeUndefined();
    } finally { f.close(); }
  }
});

test("c4: verification adds no runtime dependency: the updater uses Node's own modules and npm", () => {
  const source = readFileSync(join(dirname(new URL(import.meta.url).pathname), "toolroll-update.ts"), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]!);
  expect(imports.filter(spec => !spec.startsWith("node:") && !spec.startsWith("./"))).toEqual([]);
  const manifest = JSON.parse(readFileSync(join(dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(Object.keys(manifest.dependencies).filter(name => /sigstore|tuf|in-toto|x509|asn1/i.test(name))).toEqual([]);
});

test("c5: nothing written before the stop is lost, and what the new version wrote during health is kept and named", async () => {
  const f = fixture();
  try {
    let restarts = 0;
    const outcome = await f.start({
      // The old service's last write as it shuts down: before the backup, so the restore keeps it.
      stopService: async () => { f.calls.push("stop"); if (f.calls.filter(c => c === "stop").length === 1) f.write("T-late"); },
      restartService: async () => { f.calls.push("restart"); if (++restarts === 1) f.write("T-new"); },
      healthy: async () => false,
      processAlive: () => false,
    });
    expect(outcome.phase).toBe("restored");
    expect(f.calls.indexOf("stop")).toBeLessThan(f.calls.indexOf("rehearse"));
    expect(f.tasks()).toEqual(["T-1", "T-late"]);
    const kept = outcome.journal!.keptAside!;
    expect(outcome.message).toContain(`Anything written since the backup is kept in ${kept}.`);
    expect(f.tasks(kept)).toEqual(["T-1", "T-late", "T-new"]);
  } finally { f.close(); }
});

test("c5: a retried restore never puts the backup back twice: what was written between attempts survives", async () => {
  const f = fixture();
  try {
    let restarts = 0;
    const flaky = {
      stopService: async () => { f.calls.push("stop"); },
      // 1: the new version starts (and writes); 2: the restore's restart fails, as launchd's "Bootstrap failed: 5" can.
      restartService: async () => { f.calls.push("restart"); restarts++; if (restarts === 1) f.write("T-new"); if (restarts === 2) throw new Error("Bootstrap failed: 5"); },
      healthy: async () => false,
      processAlive: () => false,
    };
    const first = await f.start(flaky);
    expect(first.phase).toBe("needs-attention");
    expect(first.journal!.restoredDatabase).toBe(true);
    // The restored version's own CLI writes while the person reads the message.
    f.write("T-between");
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, ...flaky, restartService: async () => { f.calls.push("restart"); } });
    expect(resumed.phase).toBe("restored");
    expect(f.tasks()).toContain("T-between");
    expect(f.tasks()).not.toContain("T-new");
  } finally { f.close(); }
});

test("c5: a foreground toolroll up blocks an update, with or without a service", async () => {
  for (const service of [true, false]) {
    const f = fixture();
    try {
      const d = f.db(); try { d.prepare("INSERT INTO watch_lease(runner,repo,owner,generation,started_at,expires_at,heartbeat_at) VALUES('laptop','/code/app','fg',1,'x','2999-01-01T00:00:00Z','x')").run(); } finally { d.close(); }
      const outcome = await f.start(service ? {} : { serviceUnit: () => null });
      expect(outcome.phase).toBe("refused");
      expect(outcome.message).toMatch(/toolroll up is running for \/code\/app \(laptop\)\. Stop it first/);
      // With a service it was stopped for the check and started again, unchanged.
      expect(f.calls).toEqual(service ? ["install", "stop", "restart"] : ["install"]);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      expect(f.paused()).toBe(false);
    } finally { f.close(); }
  }
});

test("c5: a shimmed or foreign toolroll on PATH refuses the update before anything changes", async () => {
  const f = fixture();
  try {
    const shim = join(f.root, "shims", "toolroll"); mkdirSync(dirname(shim)); writeFileSync(shim, "#!/bin/sh\nexec node /elsewhere/toolroll \"$@\"\n");
    const other = join(f.root, "other", "standing-orders"); mkdirSync(dirname(other)); mkdirSync(join(f.root, "elsewhere")); writeFileSync(join(f.root, "elsewhere", "bin.js"), ""); symlinkSync(join(f.root, "elsewhere", "bin.js"), other);
    const env = { PATH: [dirname(f.links[0]!), dirname(shim), dirname(other)].join(":") };
    const found = machineSystem(join(f.root, "home"), env).commands(f.current);
    expect(found).toEqual([...f.links, shim, other]);
    for (const [commands, message] of [[[...f.links, shim], /shims\/toolroll is not a link Toolroll can switch/], [[...f.links, other], /other\/standing-orders runs a different Toolroll/]] as const) {
      const outcome = await f.start({ commands: () => [...commands] });
      expect(outcome.phase).toBe("refused");
      expect(outcome.message).toMatch(message);
      expect(f.calls).toEqual(["install"]);
      expect(f.paused()).toBe(false);
      for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
      f.calls.length = 0;
    }
  } finally { f.close(); }
});

test("c6: a downgrade is refused unless asked for, and only two release runtimes are kept", async () => {
  const f = fixture();
  try {
    const refused = await startRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", version: "0.5.0", when: "now" }, f.system);
    expect(refused).toMatchObject({ ok: false, phase: "refused" });
    expect(refused.message).toMatch(/0\.5\.0 is not newer than 0\.6\.0.*--allow-downgrade/);
    expect(f.calls).toEqual([]);
    // Two earlier release runtimes, a deploy-browser runtime and a rollback record already on disk.
    const staged = join(f.stateDir, "staged-upgrades");
    for (const [name, startedAt] of [["release-0.6.8-aaaaaaaa", "2026-01-01T00:00:00Z"], ["release-0.6.9-bbbbbbbb", "2026-02-01T00:00:00Z"], ["browser-abc-123", ""], ["rollback-0.6.8-cccccccc", ""]] as const) {
      mkdirSync(join(staged, name), { recursive: true }); if (startedAt) writeFileSync(join(staged, name, "update.json"), JSON.stringify({ startedAt }));
    }
    const outcome = await f.start();
    expect(outcome.phase).toBe("complete");
    const left = readdirSync(staged).sort();
    expect(left.filter(name => name.startsWith("release-"))).toEqual(["release-0.6.9-bbbbbbbb", basename(outcome.journal!.stageDir)].sort());
    expect(left).toEqual(expect.arrayContaining(["browser-abc-123", "rollback-0.6.8-cccccccc"]));
    // What a rollback needs is never pruned, however old.
    expect(pruneRuntimes(f.stateDir, [join(staged, "release-0.6.9-bbbbbbbb", "runtime", "dist")])).toEqual([]);
  } finally { f.close(); }
});

test("c6: Settings → Updates asks npm nothing while update checks are off, until Check now", async () => {
  const f = fixture();
  const store = openStore(f.databaseFile);
  const alex = addApprover(store, "alex", new Date());
  if (!alex.ok) throw new Error("alex");
  const configDir = join(f.root, "config"); mkdirSync(configDir); setUpdateChecks(configDir, false);
  const checksEnv = process.env["TOOLROLL_NO_UPDATE_CHECK"]; delete process.env["TOOLROLL_NO_UPDATE_CHECK"];
  let asked = 0;
  const server = createDecisionServer({ store, evidenceRoot: join(f.root, "evidence"), configDir, updates: {
    latest: async () => { asked++; return { version: "0.7.0" }; }, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" }, current: "0.6.0", dist: f.oldDist, launch: async () => {},
  } });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alex.token }), redirect: "manual" }))
      .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
    const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
    const off = await get("/settings/updates");
    expect(asked).toBe(0);
    expect(off).toContain("Update checks are off.");
    expect(off).toContain('<input type="hidden" name="check" value="now"><button type="submit">Check now</button>');
    expect(off).not.toContain("Update now");
    const checked = await get("/settings/updates?check=now");
    expect(asked).toBe(1);
    expect(checked).toContain("Toolroll 0.7.0 is available");
    await get("/settings/updates");
    expect(asked).toBe(1);
  } finally {
    if (checksEnv !== undefined) process.env["TOOLROLL_NO_UPDATE_CHECK"] = checksEnv;
    await new Promise<void>(done => server.close(() => done()));
    store.close(); f.close();
  }
}, 30_000);

// ---- 0.8.0 re-review follow-ups: provenance identity and the recovery paths ----

test("r1: provenance is accepted only from a certificate naming ap9000/toolroll, its publish workflow and GitHub Actions, whatever the statement claims", async () => {
  const hex = sha512(TARBALL).toString("hex");
  expect(checkProvenance(provenance(), "0.7.0", hex)).toMatchObject({ repository: PROVENANCE_REPOSITORY, workflow: PROVENANCE_WORKFLOW, issuer: PROVENANCE_ISSUER, identity: `${PROVENANCE_REPOSITORY}/${PROVENANCE_WORKFLOW}@refs/tags/v0.7.0` });
  // The older bundle shape carries the certificate as a one-element chain.
  expect(() => checkProvenance(provenance({ chain: true }), "0.7.0", hex)).not.toThrow();
  // Every statement below claims ap9000/toolroll's publish workflow; only the certificate counts.
  for (const [certificate, message] of [
    [{ repository: "https://github.com/someone/toolroll" }, /built by https:\/\/github\.com\/someone\/toolroll\/\.github\/workflows\/publish\.yml/],
    [{ workflow: ".github/workflows/other.yml" }, /built by .*other\.yml.*not ap9000\/toolroll/],
    [{ issuer: "https://gitlab.com" }, /signed in by https:\/\/gitlab\.com/],
  ] as const) expect(() => checkProvenance(provenance({ certificate }), "0.7.0", hex)).toThrow(message);
  // A certificate that did not sign the statement vouches for nothing.
  expect(() => checkProvenance(provenance({ signer: OTHER_KEY.privateKey }), "0.7.0", hex)).toThrow(/not signed by the certificate it carries/);
  // Only Toolroll itself: a statement for another package (a dependency) is not Toolroll's.
  expect(() => checkProvenance(provenance({ version: "0.6.9" }), "0.7.0", hex)).toThrow(/different bytes/);

  const f = fixture();
  try {
    // The update hands the certificate's own identity to npm's Sigstore verifier.
    expect((await f.start()).phase).toBe("complete");
    expect(f.sigstoreChecked).toEqual([{ issuer: PROVENANCE_ISSUER, identity: `${PROVENANCE_REPOSITORY}/${PROVENANCE_WORKFLOW}@refs/tags/v0.7.0` }]);
  } finally { f.close(); }
  const refused = fixture();
  try {
    const outcome = await refused.start({ sigstore: async () => { throw new (class Refusal extends Error {})("Sigstore did not verify Toolroll's provenance: certificate chain. Nothing was changed."); } });
    expect(outcome.phase).toBe("refused");
    expect(refused.calls).toEqual([]);
  } finally { refused.close(); }
});

test("r1: the attestations must come from the npm registry's own host", async () => {
  for (const url of ["https://registry.npmjs.org.evil.example/-/npm/v1/attestations/toolroll@0.7.0", "http://registry.npmjs.org/-/npm/v1/attestations/toolroll@0.7.0", "https://evil.example/-/npm/v1/attestations/toolroll@0.7.0"]) {
    const f = fixture();
    try {
      let fetched = 0;
      const outcome = await f.start({
        release: async version => ({ version, tarball: `${REGISTRY}/toolroll/-/toolroll-${version}.tgz`, integrity: `sha512-${sha512(TARBALL).toString("base64")}`, attestations: url }),
        attestations: async () => { fetched++; return provenance(); },
      });
      expect(outcome.phase, url).toBe("refused");
      expect(outcome.message).toMatch(/not served by the npm registry/);
      expect(fetched).toBe(0);
    } finally { f.close(); }
  }
});

test("r1: the machine checks the bundle with the Sigstore verifier npm ships, for the certificate's identity, and adds no dependency", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-sigstore-")));
  try {
    // A stand-in for npm's own sigstore package, run by the real node as the machine runs it.
    const verifier = join(root, "npm", "node_modules", "sigstore"); mkdirSync(verifier, { recursive: true });
    writeFileSync(join(verifier, "package.json"), JSON.stringify({ name: "sigstore", main: "index.js" }));
    writeFileSync(join(verifier, "index.js"), `exports.verify = async (bundle, options) => { if (!bundle.dsseEnvelope || options.certificateIssuer !== ${JSON.stringify(PROVENANCE_ISSUER)} || options.certificateIdentityURI !== ${JSON.stringify(`${PROVENANCE_REPOSITORY}/${PROVENANCE_WORKFLOW}@refs/tags/v0.7.0`)}) throw new Error("certificate identity mismatch"); };`);
    const ran: string[][] = [];
    const exec = (command: string, args: string[], options: { input?: string; timeout?: number } = {}) => {
      ran.push([command, ...args.slice(0, 3)]);
      if (command === "npm") return { status: 0, stdout: `${root}\n`, stderr: "" };
      const done = spawnSync(command, args, { encoding: "utf8", input: options.input ?? "" });
      return { status: done.status, stdout: done.stdout, stderr: done.stderr };
    };
    // No npm on PATH and none beside this node: the global root is the last place looked.
    const machine = machineSystem(join(root, "home"), {}, { exec, execPath: join(root, "no-node", "bin", "node") });
    const bundle = checkProvenance(provenance(), "0.7.0", sha512(TARBALL).toString("hex"));
    await expect(machine.sigstore(bundle.bundle, { issuer: bundle.issuer, identity: bundle.identity })).resolves.toBeUndefined();
    expect(ran[0]).toEqual(["npm", "root", "--global", "--no-color"]);
    await expect(machine.sigstore(bundle.bundle, { issuer: bundle.issuer, identity: "https://github.com/someone/toolroll/.github/workflows/publish.yml@refs/tags/v0.7.0" })).rejects.toThrow(/Sigstore did not verify.*certificate identity mismatch/);
    // No verifier where npm keeps its own: refused, never skipped.
    rmSync(verifier, { recursive: true });
    await expect(machine.sigstore(bundle.bundle, { issuer: bundle.issuer, identity: bundle.identity })).rejects.toThrow(/could not find the Sigstore verifier/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("h1: npm's verifier is found from npm itself when the global prefix is custom (npm's fix for permission errors)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "toolroll-npm-prefix-")));
  try {
    // node and npm as the nodejs.org installer or nvm lays them out; global packages under ~/.npm-global.
    const npm = join(root, "node", "lib", "node_modules", "npm");
    mkdirSync(join(npm, "bin"), { recursive: true }); mkdirSync(join(npm, "node_modules", "sigstore"), { recursive: true });
    writeFileSync(join(npm, "package.json"), JSON.stringify({ name: "npm" }));
    writeFileSync(join(npm, "bin", "npm-cli.js"), "");
    writeFileSync(join(npm, "node_modules", "sigstore", "package.json"), JSON.stringify({ name: "sigstore" }));
    mkdirSync(join(root, "node", "bin")); symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", join(root, "node", "bin", "npm"));
    const custom = join(root, ".npm-global"); mkdirSync(join(custom, "bin"), { recursive: true }); mkdirSync(join(custom, "lib", "node_modules"), { recursive: true });
    const npmRoot = () => join(custom, "lib", "node_modules");
    const verifier = join(npm, "node_modules", "sigstore");
    // The global root alone would miss it: npm does not live under the custom prefix.
    expect(existsSync(join(npmRoot(), "npm", "node_modules", "sigstore"))).toBe(false);
    expect(findSigstoreVerifier({ path: `${join(custom, "bin")}:${join(root, "node", "bin")}`, execPath: "/nowhere/bin/node", npmRoot })).toBe(verifier);
    // No npm on PATH: the npm beside node.
    expect(findSigstoreVerifier({ path: "", execPath: join(root, "node", "bin", "node"), npmRoot })).toBe(verifier);
    // Nowhere at all: none, so the update is refused rather than unchecked.
    expect(findSigstoreVerifier({ path: join(custom, "bin"), execPath: "/nowhere/bin/node", npmRoot })).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("m1: an update completed by 0.8.0 (no .last.json) survives a refused attempt: --rollback still returns from it", async () => {
  const f = fixture();
  try {
    const update = await f.start();
    expect(update.phase).toBe("complete");
    // As 0.8.0 left it: the completed update is only in the journal.
    rmSync(join(f.stateDir, "toolroll-update.last.json"), { force: true });
    const refused = await startRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", version: "0.8.0", when: "now" }, f.system);
    expect(refused.phase).toBe("refused");
    expect(lastCompletedUpdate(f.stateDir)).toMatchObject({ id: update.journal!.id, phase: "complete" });
    const rollback = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(rollback.phase).toBe("complete");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
  } finally { f.close(); }
});

test("r2: a failed restore stop never leaves the commands on the failed version", async () => {
  const f = fixture();
  try {
    let stops = 0;
    const outcome = await f.start({
      stopService: async () => { f.calls.push("stop"); if (++stops === 2) throw new Error("launchctl did not stop com.toolroll.browser; the service is still loaded. Nothing was replaced."); },
      processAlive: () => false,
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("needs-attention");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
  } finally { f.close(); }
});

test("r3: a command folder that cannot be written refuses the update before anything changes", async () => {
  const f = fixture();
  const bin = dirname(f.links[0]!);
  try {
    fs.chmodSync(bin, 0o555);
    const outcome = await f.start();
    expect(outcome.phase).toBe("refused");
    expect(outcome.message).toMatch(new RegExp(`${bin} cannot be written.*Nothing was changed`));
    expect(f.calls).toEqual(["install"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(f.paused()).toBe(false);
  } finally { fs.chmodSync(bin, 0o755); f.close(); }
});

test("r3: a link the restore cannot write is skipped and named; the database is restored and the service restarted", async () => {
  const f = fixture();
  const bin = dirname(f.links[0]!);
  try {
    let restarts = 0;
    const outcome = await f.start({
      restartService: async () => { f.calls.push("restart"); if (++restarts === 1) f.write("T-new"); },
      healthy: async () => { fs.chmodSync(bin, 0o555); return false; },
    });
    expect(outcome.phase).toBe("needs-attention");
    expect(outcome.message).toMatch(/and its database were restored/);
    expect(outcome.message).toContain(`${f.links[0]} (`);
    expect(outcome.message).toMatch(/could not be pointed back at 0\.6\.0.*toolroll update --resume/);
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.calls.slice(-2)).toEqual(["stop", "restart"]);
    expect(readFileSync(f.unit, "utf8")).toBe(f.unitText);
    // Once the folder can be written, --resume finishes pointing the commands back, without restoring again.
    fs.chmodSync(bin, 0o755); f.write("T-after");
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, healthy: async () => false });
    expect(resumed.phase).toBe("restored");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    expect(f.tasks()).toEqual(["T-1", "T-after"]);
  } finally { fs.chmodSync(bin, 0o755); f.close(); }
});

test("r4: a live database that cannot be read is left aside whole, and the backup restored anyway", async () => {
  const f = fixture();
  try {
    let restarts = 0;
    const outcome = await f.start({
      restartService: async () => {
        f.calls.push("restart");
        if (++restarts > 1) return;
        for (const suffix of ["-wal", "-shm"]) rmSync(f.databaseFile + suffix, { force: true });
        writeFileSync(f.databaseFile, "this is not a database any more");
      },
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("restored");
    const j = outcome.journal!;
    expect(j.keptAsideUnreadable).toBe(true);
    expect(outcome.message).toContain(`The live database could not be read, so it was left as it was at ${j.keptAside}.`);
    expect(readFileSync(j.keptAside!, "utf8")).toBe("this is not a database any more");
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.paused()).toBe(false);
  } finally { f.close(); }
});

/** The new version writes T-new, and then (optionally) leaves the live database unreadable, and is never healthy. */
const failingHealth = (f: ReturnType<typeof fixture>, unreadable = false) => {
  let restarts = 0;
  return {
    restartService: async () => {
      f.calls.push("restart");
      if (++restarts > 1) return;
      f.write("T-new");
      if (!unreadable) return;
      for (const suffix of ["-wal", "-shm"]) rmSync(f.databaseFile + suffix, { force: true });
      writeFileSync(f.databaseFile, "this is not a database any more");
    },
    healthy: async () => false,
  };
};

test("f1: a live database that is only busy is never moved aside: the restore stops with it in place, and a resume finishes", async () => {
  const f = fixture();
  let holder: DatabaseSync | null = null;
  try {
    const failing = failingHealth(f);
    const outcome = await f.start({
      ...failing,
      processAlive: () => false,
      stopService: async () => {
        f.calls.push("stop");
        if (f.calls.filter(c => c === "stop").length !== 2) return;
        // Something outside the service holds the database exclusively while the restore runs.
        holder = new DatabaseSync(f.databaseFile);
        holder.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO task(id,title,state,created_at,updated_at) VALUES('T-held','held','queued','x','x'); COMMIT;");
      },
    });
    expect(outcome.phase).toBe("needs-attention");
    expect(outcome.message).toContain("could not be copied aside before the restore");
    expect(outcome.journal!.kept ?? []).toEqual([]);
    expect(outcome.journal!.restoredDatabase).toBeUndefined();
    (holder as DatabaseSync | null)?.close(); holder = null;
    expect(f.tasks()).toEqual(["T-1", "T-held", "T-new"]);
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, ...failing });
    expect(resumed.phase).toBe("restored");
    expect(f.tasks()).toEqual(["T-1"]);
    expect(f.tasks(resumed.journal!.keptAside!)).toEqual(["T-1", "T-held", "T-new"]);
  } finally { (holder as DatabaseSync | null)?.close(); f.close(); }
});

test("f1: a changed backup or too little room stops the restore before the unreadable live database moves", async () => {
  for (const problem of ["backup changed", "no room"] as const) {
    const f = fixture();
    try {
      const outcome = await f.start({
        ...failingHealth(f, true),
        ...(problem === "no room" ? { freeBytes: () => 1024 } : {}),
        checkpoint: phase => { if (phase === "rolling-back" && problem === "backup changed") writeFileSync(readRuntimeUpdate(f.stateDir)!.backupPath!, "tampered"); },
      });
      expect(outcome.phase).toBe("needs-attention");
      expect(outcome.message).toMatch(problem === "backup changed" ? /backup changed\. Nothing was put back; the live database is as it was/ : /free and the restore needs .* Nothing was put back/);
      expect(readFileSync(f.databaseFile, "utf8")).toBe("this is not a database any more");
      expect(outcome.journal!.kept ?? []).toEqual([]);
    } finally { f.close(); }
  }
});

test("f1: a backup that cannot be put back after the live database moved aside puts the live database back", async () => {
  const f = fixture();
  try {
    let blocked = true;
    const failing = failingHealth(f, true);
    const outcome = await f.start({
      ...failing,
      checkpoint: phase => { if (phase === "kept-aside" && blocked) fs.chmodSync(readRuntimeUpdate(f.stateDir)!.backupPath!, 0o000); },
    });
    expect(outcome.phase).toBe("needs-attention");
    // Never empty and never a fresh database: the live path holds what it held.
    expect(readFileSync(f.databaseFile, "utf8")).toBe("this is not a database any more");
    expect(outcome.journal!.kept ?? []).toEqual([]);
    blocked = false; fs.chmodSync(outcome.journal!.backupPath!, 0o600);
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, ...failing, checkpoint: () => {} });
    expect(resumed.phase).toBe("restored");
    expect(f.tasks()).toEqual(["T-1"]);
    expect(resumed.journal!.kept).toEqual([{ path: resumed.journal!.keptAside, unreadable: true }]);
    expect(readFileSync(resumed.journal!.keptAside!, "utf8")).toBe("this is not a database any more");
  } finally { f.close(); }
});

test("f1: every copy kept aside stays named: a resumed restore adds one and keeps the pointer to the first", async () => {
  const f = fixture();
  try {
    const failing = failingHealth(f);
    let attempts = 0;
    const first = await f.start({ ...failing, checkpoint: phase => { if (phase === "kept-aside" && ++attempts === 1) throw Error("The disk went away."); } });
    expect(first.phase).toBe("needs-attention");
    const [earlier] = first.journal!.kept!;
    expect(f.tasks(earlier!.path)).toEqual(["T-1", "T-new"]);
    // A 0.8.1 journal names only its newest copy: it is carried into the list.
    const saved = JSON.parse(readFileSync(join(f.stateDir, "toolroll-update.json"), "utf8"));
    delete saved.kept; writeFileSync(join(f.stateDir, "toolroll-update.json"), JSON.stringify(saved));
    const resumed = await resumeRuntimeUpdate(f.stateDir, { ...f.system, ...failing });
    expect(resumed.phase).toBe("restored");
    expect(resumed.journal!.kept!.map(one => one.path)).toEqual([earlier!.path, resumed.journal!.keptAside]);
    expect(resumed.message).toContain(`kept in ${earlier!.path} and ${resumed.journal!.keptAside}`);
  } finally { f.close(); }
});

test("r5: the stop waits as long as toolroll up takes to exit, and a stop that times out leaves the label enabled", async () => {
  const f = fixture();
  try {
    const launch = (printsUntilGone: number) => {
      const log: string[] = []; let pending = -1;
      const run = async (_file: string, args: readonly string[]) => {
        log.push(args[0]!);
        if (args[0] === "bootout") pending = printsUntilGone;
        if (args[0] === "print") return pending === 0 ? { code: 113, stdout: "", stderr: "", timedOut: false } : (pending > 0 && pending--, { code: 0, stdout: "state = running\n\tpid = 4242\n", stderr: "", timedOut: false });
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      };
      return { log, run };
    };
    // A watch daemon's up takes 30 s to exit: longer than the 5 s launchd default, within 45 s.
    const slow = launch(300);
    await expect(machineSystem(join(f.root, "home"), {}, { run: slow.run as never, sleep: async () => {} }).stopService(f.unit)).resolves.toBeUndefined();
    const never = launch(Number.MAX_SAFE_INTEGER);
    await expect(machineSystem(join(f.root, "home"), {}, { run: never.run as never, sleep: async () => {} }).stopService(f.unit)).rejects.toThrow(/did not stop/);
    expect(never.log.filter(verb => verb !== "print")).toEqual(["disable", "bootout", "enable"]);
    expect(never.log.filter(verb => verb === "print").length).toBe(450);
  } finally { f.close(); }
});

test("r6: each repo's watch daemon is stopped, switched and restarted with the service, and put back on a failure", async () => {
  for (const healthy of [true, false]) {
    const f = fixture();
    try {
      const watch = join(f.root, "com.toolroll.watch.app-1234.plist"), watchText = `<plist><string>${f.oldDist}/controller-service.js</string><string>${f.oldDist}/bin.js</string><string>watch</string></plist>`;
      writeFileSync(watch, watchText);
      const units: string[] = [];
      const outcome = await f.start({
        watchUnits: from => readFileSync(watch, "utf8").includes(from.dist) ? [watch] : [],
        stopService: async unit => { units.push(`stop ${basename(unit)}`); },
        restartService: async unit => { units.push(`restart ${basename(unit)}`); },
        processAlive: () => false,
        healthy: async () => healthy,
      });
      const j = outcome.journal!;
      expect(outcome.phase).toBe(healthy ? "complete" : "restored");
      expect(units.slice(0, 4)).toEqual(["stop com.toolroll.browser.plist", "stop com.toolroll.watch.app-1234.plist", "restart com.toolroll.browser.plist", "restart com.toolroll.watch.app-1234.plist"]);
      expect(readFileSync(watch, "utf8")).toBe(healthy ? watchText.replaceAll(f.oldDist, j.to.dist) : watchText);
      if (!healthy) expect(units.slice(4)).toEqual(units.slice(0, 4));
    } finally { f.close(); }
  }
});

test("f9: a watch daemon the person had unloaded is switched but never stopped or started by the update", async () => {
  for (const healthy of [true, false]) {
    const f = fixture();
    try {
      const watches = ["app-1", "app-2"].map(name => join(f.root, `com.toolroll.watch.${name}.plist`));
      for (const watch of watches) writeFileSync(watch, `<plist><string>${f.oldDist}/bin.js</string><string>watch</string></plist>`);
      const units: string[] = [];
      const outcome = await f.start({
        watchUnits: from => watches.filter(watch => readFileSync(watch, "utf8").includes(from.dist)),
        serviceLoaded: async unit => !unit.includes("app-2"),
        stopService: async unit => { units.push(`stop ${basename(unit)}`); },
        restartService: async unit => { units.push(`restart ${basename(unit)}`); },
        processAlive: () => false,
        healthy: async () => healthy,
      });
      expect(outcome.phase).toBe(healthy ? "complete" : "restored");
      expect(units.filter(one => one.includes("app-2"))).toEqual([]);
      expect(units).toContain("restart com.toolroll.watch.app-1.plist");
      expect(outcome.journal!.watches!.map(w => [w.unit, w.loaded])).toEqual([[watches[0], true], [watches[1], false]]);
      if (healthy) expect(readFileSync(watches[1]!, "utf8")).toContain(outcome.journal!.to.dist);
    } finally { f.close(); }
  }
});

test("r6: a toolroll up started while the new version ran keeps the restore from putting the database back under it", async () => {
  const f = fixture();
  try {
    let restarts = 0;
    const outcome = await f.start({
      restartService: async () => {
        f.calls.push("restart");
        if (++restarts > 1) return;
        f.write("T-new");
        const d = f.db(); try { d.prepare("INSERT INTO watch_lease(runner,repo,owner,generation,started_at,expires_at,heartbeat_at) VALUES('laptop','/code/app','fg',1,'x','2999-01-01T00:00:00Z','x')").run(); } finally { d.close(); }
      },
      healthy: async () => false,
    });
    expect(outcome.phase).toBe("needs-attention");
    expect(outcome.message).toMatch(/toolroll up is running for \/code\/app \(laptop\)\. The database was not put back under it/);
    expect(f.tasks()).toEqual(["T-1", "T-new"]);
    expect(outcome.journal!.restoredDatabase).toBeUndefined();
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
  } finally { f.close(); }
});

test("r7: a refused attempt after a completed update leaves --rollback working", async () => {
  const f = fixture();
  try {
    const update = await f.start();
    expect(update.phase).toBe("complete");
    // A later attempt is refused (its provenance is for 0.7.0, not 0.8.0) and becomes the saved journal.
    const refused = await startRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", version: "0.8.0", when: "now" }, f.system);
    expect(refused.phase).toBe("refused");
    expect(readRuntimeUpdate(f.stateDir)).toMatchObject({ phase: "refused", to: { version: "0.8.0" } });
    const lines: string[] = [];
    expect(await runUpdateCommand(["--rollback"], line => lines.push(line), { system: f.system, current: update.journal!.to, databaseFile: f.databaseFile, method: { kind: "managed", updateCommand: "toolroll update" } })).toBe(0);
    expect(lines[0]).toMatch(/^Roll back 0\.7\.0 → 0\.6\.0/);
    const rollback = await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(rollback.phase).toBe("complete");
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
    // Rolled back: there is nothing left to roll back.
    expect((await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: f.current, actor: "ada", when: "when-idle" }, f.system)).message).toBe("There is no completed update to roll back.");
  } finally { f.close(); }
});

test("f8: Settings → Updates offers --rollback from the last completed update, even after a refused attempt", async () => {
  const f = fixture();
  try {
    const update = await f.start();
    await startRuntimeUpdate({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", version: "0.8.0", when: "now" }, f.system);
    const status = runtimeUpdateStatus(f.stateDir);
    expect(status.journal!.phase).toBe("refused");
    expect(status.lastUpdate).toEqual({ from: "0.6.0", to: "0.7.0" });
    const html = updatesHtml({ current: "0.7.0", latest: { version: "0.7.0" }, method: { kind: "npm", updateCommand: "npm install -g toolroll@latest" }, journal: status.journal, running: false, whatsNew: null, rollbackTo: status.lastUpdate!.from, csrf: "x" }, {});
    expect(html).toContain("To go back to 0.6.0: <code>toolroll update --rollback</code>");
    // Rolled back: nothing is offered.
    await startRuntimeRollback({ stateDir: f.stateDir, databaseFile: f.databaseFile, current: update.journal!.to, actor: "ada", when: "when-idle" }, f.system);
    expect(runtimeUpdateStatus(f.stateDir).lastUpdate).toBeNull();
  } finally { f.close(); }
});

test("r8: the console's update job looks for toolroll where it is usually linked", async () => {
  const f = fixture();
  try {
    const run = async (_file: string, args: readonly string[]) => ({ code: args[0] === "print" ? 113 : 0, stdout: "", stderr: "", timedOut: false });
    const home = join(f.root, "home");
    await launchRuntimeUpdate({ databaseFile: f.databaseFile, id: randomUUID(), dist: f.oldDist }, { home, run: run as never, platform: "darwin", npmBin: async () => "/Users/a/.npm-global/bin" });
    const plist = readFileSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`), "utf8");
    const path = /<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)![1]!.split(":");
    expect(path).toEqual(expect.arrayContaining([dirname(process.execPath), "/Users/a/.npm-global/bin", join(home, ".local", "bin"), join(home, "bin"), join(home, "Library", "pnpm"), "/usr/local/bin", "/opt/homebrew/bin"]));
  } finally { f.close(); }
});

test("r9: the job asks npm for its global folder without blocking the console", async () => {
  const f = fixture();
  try {
    const asked: string[][] = [];
    const run = async (file: string, args: readonly string[]) => {
      asked.push([file, ...args]);
      return { code: args[0] === "print" ? 113 : 0, stdout: file === "npm" ? "/Users/b/.npm-prefix\n" : "", stderr: "", timedOut: false };
    };
    const home = join(f.root, "home");
    await launchRuntimeUpdate({ databaseFile: f.databaseFile, id: randomUUID(), dist: f.oldDist }, { home, run: run as never, platform: "darwin" });
    expect(asked[0]).toEqual(["npm", "prefix", "--global", "--no-color"]);
    const plist = readFileSync(join(home, "Library", "LaunchAgents", `${UPDATE_JOB_LABEL}.plist`), "utf8");
    expect(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)![1]!.split(":")).toContain("/Users/b/.npm-prefix/bin");
  } finally { f.close(); }
});

test("--cancel with no updater running lifts the pause and cancels", async () => {
  const f = fixture();
  try {
    f.startRun();
    // The updater dies while it waits for running work, leaving new work paused.
    await expect(f.start({ sleep: async () => { throw Object.assign(Error("crash"), { simulatedCrash: true }); } }, "when-idle")).rejects.toThrow("crash");
    expect(f.paused()).toBe(true);
    expect(requestRuntimeUpdateCancel(f.stateDir)).toBe("Cancelled the update to 0.7.0. Nothing was switched; new work resumes.");
    expect(f.paused()).toBe(false);
    expect(readRuntimeUpdate(f.stateDir)?.phase).toBe("cancelled");
    expect(f.ledger().map(e => e.action)).toEqual(["toolroll update cancelled"]);
    for (const link of f.links) expect(readlinkSync(link)).toBe(join(f.oldDist, "bin.js"));
  } finally { f.close(); }
});

test("f3: --cancel reads the update again under the lock, and leaves one that moved on or was replaced alone", async () => {
  for (const change of ["moved on", "replaced", "finished"] as const) {
    const f = fixture();
    try {
      f.startRun();
      await expect(f.start({ sleep: async () => { throw Object.assign(Error("crash"), { simulatedCrash: true }); } }, "when-idle")).rejects.toThrow("crash");
      const file = join(f.stateDir, "toolroll-update.json");
      const staged = readRuntimeUpdate(f.stateDir)!;
      mkdirSync(join(staged.stageDir, "runtime"), { recursive: true });
      const words = requestRuntimeUpdateCancel(f.stateDir, new Date(), {
        // Between the first read and the lock, an updater carried on (or another update replaced this one).
        locked: () => writeFileSync(file, JSON.stringify(change === "replaced" ? { ...staged, id: randomUUID() } : { ...staged, phase: change === "moved on" ? "switching" : "complete" })),
      });
      expect(words).toBe(change === "moved on" ? "The update to 0.7.0 is past the point it can be cancelled (switching); it will finish or restore on its own."
        : change === "replaced" ? "A different update was saved while cancelling. Nothing was cancelled." : "No update is in progress.");
      expect(readRuntimeUpdate(f.stateDir)!.phase).toBe(change === "moved on" ? "switching" : change === "replaced" ? "draining" : "complete");
      expect(existsSync(join(staged.stageDir, "runtime"))).toBe(true);
      expect(existsSync(join(staged.stageDir, "cancel-request.json"))).toBe(false);
      expect(f.paused()).toBe(true);
      expect(f.ledger()).toEqual([]);
    } finally { f.close(); }
  }
});

test("pruning never deletes a folder holding a kept-aside database", () => {
  const f = fixture();
  try {
    const staged = join(f.stateDir, "staged-upgrades");
    for (const [name, startedAt] of [["release-0.6.7-aaaaaaaa", "2026-01-01T00:00:00Z"], ["release-0.6.8-bbbbbbbb", "2026-02-01T00:00:00Z"], ["release-0.6.9-cccccccc", "2026-03-01T00:00:00Z"]] as const) {
      mkdirSync(join(staged, name), { recursive: true }); writeFileSync(join(staged, name, "update.json"), JSON.stringify({ startedAt }));
    }
    writeFileSync(join(staged, "release-0.6.7-aaaaaaaa", "orders.kept.1a2b3c4d.db"), "what 0.6.7 wrote");
    expect(pruneRuntimes(f.stateDir, [])).toEqual([]);
    expect(existsSync(join(staged, "release-0.6.7-aaaaaaaa", "orders.kept.1a2b3c4d.db"))).toBe(true);
  } finally { f.close(); }
});

test("npm's output is read without colour, so a verified attestation is recognised", async () => {
  const f = fixture();
  try {
    const npm = scriptedNpm();
    // npm colours "verified" unless told not to.
    const exec = (command: string, args: string[], options: { cwd?: string } = {}) => {
      const answer = npm.exec(command, args, options);
      return args[0] === "audit" && !args.includes("--no-color") ? { ...answer, stdout: answer.stdout.replaceAll("verified", "\u001b[1mverified\u001b[22m") } : answer;
    };
    const outcome = await f.start({ install: machineSystem(join(f.root, "home"), {}, { exec }).install });
    expect(outcome.phase).toBe("complete");
    for (const call of npm.calls) expect(call.args).toContain("--no-color");
  } finally { f.close(); }
});

test("the Toolroll app is never offered an npm update", async () => {
  const f = fixture();
  try {
    const lines: string[] = [];
    expect(await runUpdateCommand(["--yes"], line => lines.push(line), { system: f.system, current: f.current, databaseFile: f.databaseFile, latest: async () => ({ version: "0.7.0" }), method: { kind: "desktop", updateCommand: "Update from the Toolroll app" } })).toBe(1);
    expect(lines).toEqual(["This Toolroll is the Toolroll app, which updates as a whole app. Update it from the Toolroll app."]);
    expect(f.calls).toEqual([]);
    expect(readRuntimeUpdate(f.stateDir)).toBeNull();
  } finally { f.close(); }
});
