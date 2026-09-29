/** Codex's plan limits, read from its app server (v105): kept apart from provider-limits.ts so the run pipeline that
 * notes Claude's readings never loads Codex's transport. */
import { spawn } from "node:child_process";
import { codingEnvironment } from "./coding-provider.js";
import { codexLimitsOf, record, type LimitReading } from "./provider-limits.js";
import { billingOf } from "./spend.js";
import type { Store } from "./store.js";

/** Ask Codex for its limits: its app server over stdio, one read, then gone. Null when Codex isn't installed, isn't
 * signed in with a plan, or doesn't answer in time. */
export function readCodexLimits(options: { command?: string; timeoutMs?: number } = {}): Promise<LimitReading | null> {
  return new Promise(resolve => {
    const env = codingEnvironment();
    // Its plan's limits: a key in the environment would make it an API account.
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY"]) delete env[key];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.command ?? "codex", ["app-server", "--listen", "stdio://"], { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let buffered = "";
    const finish = (reading: LimitReading | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      resolve(reading);
    };
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 15_000);
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
    child.stdin?.on("error", () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 256 * 1024) return finish(null);
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message: Record<string, unknown> | null = null;
        try { message = record(JSON.parse(line)); } catch { continue; }
        if (message?.["id"] === 1) {
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" })}\n`);
        } else if (message?.["id"] === 2) {
          finish(message["error"] === undefined ? codexLimitsOf(message["result"]) : null);
        }
      }
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "standing-orders", version: "1" } } })}\n`);
  });
}

/** The loop beside the console: Codex's limits every five minutes while Codex runs on its plan (a key has none). */
export function startCodexLimits(store: Store, everyMs = 5 * 60_000): () => void {
  // Tests never start a real Codex.
  if (process.env["VITEST"] !== undefined) return () => {};
  let stopped = false, busy = false;
  const pass = async () => {
    if (stopped || busy || billingOf("codex") !== "subscription") return;
    busy = true;
    try {
      const reading = await readCodexLimits();
      if (reading !== null && !stopped) store.recordProviderLimits(reading, new Date());
    } catch {
      // The next pass tries again.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void pass(), everyMs);
  timer.unref?.();
  const first = setTimeout(() => void pass(), 10_000);
  first.unref?.();
  return () => { stopped = true; clearInterval(timer); clearTimeout(first); };
}
