/**
 * The daemon manager: the loop as a service, with no crontab in sight.
 *
 * `nightorders daemon install` writes the platform's own supervision unit —
 * a launchd LaunchAgent on macOS, a systemd user unit on Linux, a Task
 * Scheduler task on Windows, chosen by process.platform — pointed at
 * `nightorders watch`, and loads it. The OS keeps it alive across crashes
 * and reboots; watch's incarnation recovery is what makes those restarts
 * safe, so the two halves were built for each other.
 *
 * The runner token never enters the unit file. It is written 0600 to a
 * credential file beside the database (the same discipline as the Telegram
 * bot token), and the unit runs `watch --token-file <path>`. A unit file is
 * the kind of thing that ends up in a dotfiles repo; a credential file
 * beside the database is the kind of thing backup tooling already treats
 * as sensitive.
 *
 * Everything here is generation plus one supervisor invocation, both
 * injectable — the tests read the generated unit and script `launchctl`,
 * and never touch the machine's real supervision.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecResult, RunOptions } from "./exec.js";

export type SupervisorRunner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

export type DaemonPlan = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  unitPath: string;
  unitContent: string;
  logPath: string;
  tokenFile: string;
};

/** One service per repo, named so two repos' watches never collide. */
export function labelFor(repo: string): string {
  const slug = repo
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(-40);
  return `com.nightorders.watch.${slug === "" ? "root" : slug}`;
}

/**
 * Everything `install` would do, computed without doing it — the unit text,
 * where it goes, where logs land. `--dry-run` prints exactly this.
 */
export function planDaemon(args: {
  platform: NodeJS.Platform;
  bin: string;
  binArgs: readonly string[];
  runner: string;
  repo: string;
  configDir: string;
  watchFlags: readonly string[];
  home?: string;
}): DaemonPlan | { error: string } {
  const { platform, bin, binArgs, runner, repo, configDir, watchFlags } = args;
  const home = args.home ?? homedir();
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return {
      error: `no supervisor template for ${platform} — run \`nightorders watch\` under your own service manager`,
    };
  }

  const label = labelFor(repo);
  const logDir = join(configDir, "logs");
  const logPath = join(logDir, `${label}.log`);
  const tokenFile = join(configDir, "runner-token");

  const command = [
    bin,
    ...binArgs,
    "watch",
    "--runner",
    runner,
    "--token-file",
    tokenFile,
    "--repo",
    repo,
    ...watchFlags,
  ];

  if (platform === "darwin") {
    const escaped = command.map(part => `    <string>${xml(part)}</string>`).join("\n");
    const unitContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${escaped}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
    return {
      platform,
      label,
      unitPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
      unitContent,
      logPath,
      tokenFile,
    };
  }

  if (platform === "win32") {
    // Task Scheduler is Windows' launchd: a logon-triggered task, restarted
    // on failure, created from an XML definition — no admin, no Service
    // wrapper. schtasks does not redirect output, so the action runs
    // through cmd with an append redirection into the same log file the
    // other platforms use.
    const inner = [quoteWin(bin), ...binArgs.map(quoteWin), "watch",
      "--runner", quoteWin(runner), "--token-file", quoteWin(tokenFile),
      "--repo", quoteWin(repo), ...watchFlags.map(quoteWin)].join(" ");
    const cmdArguments = `/c "${inner} >> ${quoteWin(logPath)} 2>&1"`;
    const unitContent = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>nightorders watch — ${xml(repo)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${xml(cmdArguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
    return {
      platform,
      label,
      unitPath: join(configDir, "daemon", `${label}.xml`),
      unitContent,
      logPath,
      tokenFile,
    };
  }

  const unitContent = `[Unit]
Description=nightorders watch — ${repo}

[Service]
ExecStart=${command.map(systemdEscape).join(" ")}
Restart=on-failure
RestartSec=15
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
  return {
    platform,
    label,
    unitPath: join(home, ".config", "systemd", "user", `${label}.service`),
    unitContent,
    logPath,
    tokenFile,
  };
}

/** Write the token 0600 and the unit, then hand the unit to the supervisor. */
export async function installDaemon(
  plan: DaemonPlan,
  token: string,
  run: SupervisorRunner,
): Promise<{ ok: true } | { ok: false; message: string }> {
  writeFileSync(plan.tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(plan.tokenFile, 0o600);
  mkdirSync(join(plan.logPath, ".."), { recursive: true });
  mkdirSync(join(plan.unitPath, ".."), { recursive: true });
  writeFileSync(plan.unitPath, plan.unitContent, { mode: 0o644 });

  if (plan.platform === "darwin") {
    // Modern first, legacy fallback: `bootstrap` replaced `load` but older
    // macOS answers only to the old verb.
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    const modern = await run("launchctl", ["bootstrap", `gui/${uid}`, plan.unitPath]);
    if (modern.code === 0) return { ok: true };
    const legacy = await run("launchctl", ["load", "-w", plan.unitPath]);
    if (legacy.code === 0) return { ok: true };
    return {
      ok: false,
      message: `launchctl refused the unit: ${firstLine(modern.stderr) || firstLine(legacy.stderr) || `exit ${legacy.code}`}`,
    };
  }

  if (plan.platform === "win32") {
    // /F replaces an existing definition, so re-install is idempotent; the
    // task starts immediately rather than waiting for the next logon.
    const created = await run("schtasks", ["/Create", "/TN", plan.label, "/XML", plan.unitPath, "/F"]);
    if (created.code !== 0) {
      return { ok: false, message: `schtasks /Create failed: ${firstLine(created.stderr) || `exit ${created.code}`}` };
    }
    const started = await run("schtasks", ["/Run", "/TN", plan.label]);
    if (started.code !== 0) {
      return { ok: false, message: `created, but schtasks /Run failed: ${firstLine(started.stderr)}` };
    }
    return { ok: true };
  }

  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    return { ok: false, message: `systemctl daemon-reload failed: ${firstLine(reload.stderr)}` };
  }
  const enable = await run("systemctl", ["--user", "enable", "--now", plan.label]);
  if (enable.code !== 0) {
    return { ok: false, message: `systemctl enable failed: ${firstLine(enable.stderr)}` };
  }
  return { ok: true };
}

export async function uninstallDaemon(
  plan: DaemonPlan,
  run: SupervisorRunner,
): Promise<{ ok: true; existed: boolean }> {
  if (plan.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    const modern = await run("launchctl", ["bootout", `gui/${uid}/${plan.label}`]);
    if (modern.code !== 0) await run("launchctl", ["unload", plan.unitPath]);
  } else if (plan.platform === "win32") {
    await run("schtasks", ["/End", "/TN", plan.label]);
    await run("schtasks", ["/Delete", "/TN", plan.label, "/F"]);
  } else {
    await run("systemctl", ["--user", "disable", "--now", plan.label]);
  }
  let existed = true;
  try {
    rmSync(plan.unitPath);
  } catch {
    existed = false;
  }
  return { ok: true, existed };
}

export async function daemonStatus(
  plan: DaemonPlan,
  run: SupervisorRunner,
): Promise<{ state: "running" | "loaded" | "not-installed"; pid: number | null; detail: string }> {
  if (plan.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    const answer = await run("launchctl", ["print", `gui/${uid}/${plan.label}`]);
    if (answer.code !== 0) return { state: "not-installed", pid: null, detail: "launchd does not know the label" };
    const pid = /pid = (\d+)/.exec(answer.stdout)?.[1];
    return pid === undefined
      ? { state: "loaded", pid: null, detail: "loaded, not currently running" }
      : { state: "running", pid: Number(pid), detail: `running as pid ${pid}` };
  }
  if (plan.platform === "win32") {
    const answer = await run("schtasks", ["/Query", "/TN", plan.label, "/FO", "LIST", "/V"]);
    if (answer.code !== 0) {
      return { state: "not-installed", pid: null, detail: "the scheduler does not know the task" };
    }
    const running = /Status:\s*Running/i.test(answer.stdout);
    return running
      ? { state: "running", pid: null, detail: "running (Task Scheduler does not expose the pid)" }
      : { state: "loaded", pid: null, detail: "installed, not currently running" };
  }

  const answer = await run("systemctl", ["--user", "is-active", plan.label]);
  const active = answer.stdout.trim() === "active";
  if (answer.code !== 0 && !active) {
    return { state: "not-installed", pid: null, detail: answer.stdout.trim() || "inactive" };
  }
  const pidAnswer = await run("systemctl", ["--user", "show", "--property=MainPID", plan.label]);
  const pid = Number(/MainPID=(\d+)/.exec(pidAnswer.stdout)?.[1] ?? 0);
  return active
    ? { state: "running", pid: pid > 0 ? pid : null, detail: "active" }
    : { state: "loaded", pid: null, detail: "installed, inactive" };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** cmd.exe quoting: wrap anything with spaces; embedded quotes are not survivable in cmd — refuse them upstream by construction (paths and flags here never carry them). */
function quoteWin(part: string): string {
  return /[\s&|<>^]/.test(part) ? `"${part}"` : part;
}

function systemdEscape(part: string): string {
  return /[\s"'\\]/.test(part) ? `"${part.replace(/(["\\])/g, "\\$1")}"` : part;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
