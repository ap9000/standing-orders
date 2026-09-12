#!/usr/bin/env node
/**
 * The disposable service the launchd certificate supervises: beats a
 * heartbeat file every 200 ms with its pid and a per-incarnation id, exits
 * 0 when told to (the "unexpected clean exit" the supervisor must relaunch
 * after), and otherwise lives until killed. No network, no database.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const dir = process.env["SO_CERT_STATE"];
if (dir === undefined) { console.error("SO_CERT_STATE is required"); process.exit(2); }
const incarnation = randomUUID();
mkdirSync(join(dir, "writers"), { recursive: true });
const beat = () => {
  writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({ pid: process.pid, incarnation, at: Date.now() }));
  writeFileSync(join(dir, "writers", `${process.pid}-${incarnation}`), String(Date.now()));
};
beat();
setInterval(() => {
  beat();
  if (existsSync(join(dir, "exit-now"))) {
    try { unlinkSync(join(dir, "exit-now")); } catch { /* raced */ }
    process.exit(0);
  }
}, 200);
