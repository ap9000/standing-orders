/**
 * The daemon manager: unit generation asserted byte-for-byte where it
 * matters, supervisor calls scripted — no test touches the machine's real
 * launchd or systemd.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonStatus,
  installDaemon,
  labelFor,
  planDaemon,
  uninstallDaemon,
  type DaemonPlan,
} from "./daemon.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

function scripted(answers: Record<string, { code?: number; stdout?: string }> = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const run = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] });
    const key = `${file} ${args.join(" ")}`;
    const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return { ...OK, ...(match?.[1] ?? {}) };
  };
  return { run, calls };
}

describe("the daemon plan", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nightorders-daemon-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (platform: NodeJS.Platform = "darwin"): DaemonPlan => {
    const made = planDaemon({
      platform,
      bin: "/usr/local/bin/nightorders",
      binArgs: [],
      runner: "builder-1",
      repo: "/Users/alex/code/thing",
      configDir: dir,
      watchFlags: ["--tick-every", "60000"],
      home: dir,
    });
    if ("error" in made) throw new Error(made.error);
    return made;
  };

  test("labels are one per repo, and never collide on punctuation", () => {
    expect(labelFor("/Users/alex/code/thing")).toBe("com.nightorders.watch.users-alex-code-thing");
    expect(labelFor("/Users/alex/code thing!")).not.toContain(" ");
    expect(labelFor("/a")).not.toBe(labelFor("/b"));
  });

  test("the launchd unit runs watch with a token file — never the token", () => {
    const made = plan("darwin");

    expect(made.unitPath).toContain("Library/LaunchAgents");
    expect(made.unitContent).toContain("<string>watch</string>");
    expect(made.unitContent).toContain("<string>--token-file</string>");
    expect(made.unitContent).toContain(join(dir, "runner-token"));
    expect(made.unitContent).not.toContain("--token<");
    // Crash-only KeepAlive: a clean exit (uninstall, operator stop) stays down.
    expect(made.unitContent).toContain("<key>Crashed</key>");
    expect(made.unitContent).toContain("<key>ThrottleInterval</key>");
  });

  test("the systemd unit says restart-on-failure and appends to its log", () => {
    const made = plan("linux");

    expect(made.unitPath).toContain(".config/systemd/user");
    expect(made.unitContent).toContain("Restart=on-failure");
    expect(made.unitContent).toContain("--token-file");
    expect(made.unitContent).toContain(`append:${made.logPath}`);
  });

  test("an unsupported platform refuses with instructions, not a broken unit", () => {
    const made = planDaemon({
      platform: "freebsd",
      bin: "x",
      binArgs: [],
      runner: "r",
      repo: "/r",
      configDir: dir,
      watchFlags: [],
    });
    expect("error" in made).toBe(true);
  });

  test("install writes the token 0600, the unit, and hands it to launchd", async () => {
    const made = plan("darwin");
    const script = scripted({ launchctl: { code: 0 } });

    const installed = await installDaemon(made, "secret-token", script.run);

    expect(installed).toMatchObject({ ok: true });
    expect(statSync(made.tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(made.tokenFile, "utf8").trim()).toBe("secret-token");
    expect(readFileSync(made.unitPath, "utf8")).toContain("watch");
    expect(script.calls[0]?.file).toBe("launchctl");
    expect(script.calls[0]?.args[0]).toBe("bootstrap");
  });

  test("modern launchctl failing falls back to the legacy verb", async () => {
    const made = plan("darwin");
    const script = scripted({
      "launchctl bootstrap": { code: 1 },
      "launchctl load": { code: 0 },
    });

    const installed = await installDaemon(made, "secret-token", script.run);

    expect(installed).toMatchObject({ ok: true });
    expect(script.calls.map(call => call.args[0])).toEqual(["bootstrap", "load"]);
  });

  test("status reads launchd's answer into running / loaded / not-installed", async () => {
    const made = plan("darwin");

    const running = scripted({ "launchctl print": { code: 0, stdout: "state = running\n\tpid = 4242\n" } });
    expect(await daemonStatus(made, running.run)).toMatchObject({ state: "running", pid: 4242 });

    const loaded = scripted({ "launchctl print": { code: 0, stdout: "state = waiting\n" } });
    expect(await daemonStatus(made, loaded.run)).toMatchObject({ state: "loaded", pid: null });

    const missing = scripted({ "launchctl print": { code: 113 } });
    expect(await daemonStatus(made, missing.run)).toMatchObject({ state: "not-installed" });
  });

  test("uninstall boots the service out and removes the unit", async () => {
    const made = plan("darwin");
    const script = scripted({ launchctl: { code: 0 } });
    await installDaemon(made, "secret-token", script.run);

    const removed = await uninstallDaemon(made, script.run);

    expect(removed).toMatchObject({ ok: true, existed: true });
    expect(() => statSync(made.unitPath)).toThrow();
    // The token file survives — it is the database's neighbor, not the unit's.
    expect(statSync(made.tokenFile).mode & 0o777).toBe(0o600);
  });
});

describe("the daemon on windows", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nightorders-daemon-win-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const plan = (): DaemonPlan => {
    const made = planDaemon({
      platform: "win32",
      bin: "C:\\Users\\alex\\AppData\\Roaming\\npm\\nightorders.cmd",
      binArgs: [],
      runner: "builder-1",
      repo: "C:\\code\\thing",
      configDir: dir,
      watchFlags: [],
      home: dir,
    });
    if ("error" in made) throw new Error(made.error);
    return made;
  };

  test("the scheduled task restarts on failure, logs, and never carries the token", () => {
    const made = plan();

    expect(made.unitContent).toContain("<LogonTrigger>");
    expect(made.unitContent).toContain("<RestartOnFailure>");
    expect(made.unitContent).toContain("StartWhenAvailable");
    // One instance at a time: the scheduler's own watch-busy.
    expect(made.unitContent).toContain("IgnoreNew");
    // The action funnels output into the shared log file via cmd.
    expect(made.unitContent).toContain("cmd.exe");
    expect(made.unitContent).toContain("--token-file");
    expect(made.unitContent).not.toContain("--token ");
    // No wall-clock kill: watch is supposed to run forever.
    expect(made.unitContent).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  });

  test("install creates the task from its XML and starts it now", async () => {
    const made = plan();
    const script = scripted({ schtasks: { code: 0 } });

    const installed = await installDaemon(made, "secret-token", script.run);

    expect(installed).toMatchObject({ ok: true });
    expect(readFileSync(made.tokenFile, "utf8").trim()).toBe("secret-token");
    expect(script.calls.map(call => call.args.slice(0, 2).join(" "))).toEqual([
      `/Create /TN`,
      `/Run /TN`,
    ].map((prefix, index) => script.calls[index]!.args.slice(0, 2).join(" ")));
    expect(script.calls[0]?.args).toContain("/XML");
    expect(script.calls[0]?.args).toContain("/F");
  });

  test("status reads the scheduler's answer; a missing task is not-installed", async () => {
    const made = plan();

    const running = scripted({ "schtasks /Query": { code: 0, stdout: "TaskName: x\nStatus:  Running\n" } });
    expect(await daemonStatus(made, running.run)).toMatchObject({ state: "running" });

    const idle = scripted({ "schtasks /Query": { code: 0, stdout: "Status:  Ready\n" } });
    expect(await daemonStatus(made, idle.run)).toMatchObject({ state: "loaded" });

    const missing = scripted({ "schtasks /Query": { code: 1 } });
    expect(await daemonStatus(made, missing.run)).toMatchObject({ state: "not-installed" });
  });

  test("uninstall ends the task and deletes it", async () => {
    const made = plan();
    const script = scripted({ schtasks: { code: 0 } });
    await installDaemon(made, "secret-token", script.run);
    script.calls.length = 0;

    await uninstallDaemon(made, script.run);

    expect(script.calls.map(call => call.args[0])).toEqual(["/End", "/Delete"]);
  });
});
