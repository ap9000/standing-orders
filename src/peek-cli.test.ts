import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { openLiveLog, renderTranscriptLines } from "./live.js";
import { composeFrame, elapsedWords, openInTmux, snapshotLiveRuns, stageWord } from "./peek-cli.js";
import { runOperate, EXIT } from "./operate.js";

const T0 = new Date("2026-09-03T01:00:00.000Z");

describe("peek: the terminal view over live agents", () => {
  let store: Store;
  let root: string;
  let db: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "standing-orders-peek-"));
    db = join(root, "queue.db");
    store = openStore(db);
    store.createTask({ id: "t-1", title: "Harden webhook retries" }, T0);
    store.createTask({ id: "t-2", title: "Find out why login flakes", deliverable: "report" }, T0);
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const openRun = (task: string, role: "builder" | "scout", provider = "claude"): number =>
    store.startRun({ taskRef: store.refFor("built-in", task).id, leaseId: `lease-${task}`, runner: "night-shift-1", role, provider, branch: `standing-orders/${task}`, worktree: `/pool/${task}`, now: T0 });

  test("every provider's stream renders transcript lines: text and the kind of tool, never contents", () => {
    expect(renderTranscriptLines({ type: "thread.started", thread_id: "x" })).toEqual(["the agent session started"]);
    expect(renderTranscriptLines({ type: "item.completed", item: { type: "agent_message", text: "Looking at the retry loop.\nIt never backs off." } })).toEqual(["Looking at the retry loop.", "It never backs off."]);
    expect(renderTranscriptLines({ type: "item.completed", item: { type: "command_execution", command: "rm -rf /" } })).toEqual(["→ running a command"]);
    expect(renderTranscriptLines({ type: "item.completed", item: { type: "file_change", path: "src/x.ts" } })).toEqual(["→ editing files"]);
    expect(renderTranscriptLines({ type: "message", role: "assistant", content: "Gemini says hi", delta: false })).toEqual(["Gemini says hi"]);
    expect(renderTranscriptLines({ type: "message", role: "assistant", content: "partial", delta: true })).toEqual([]);
    expect(renderTranscriptLines({ type: "tool_call", name: "Edit" })).toEqual(["→ editing files"]);
  });

  test("a snapshot names every open run with its stage, clock, and transcript tail; a finished run drops out", () => {
    const a = openRun("t-1", "builder");
    const b = openRun("t-2", "scout", "codex");
    const logA = openLiveLog(root, a);
    logA?.observe({ type: "system", subtype: "init", session_id: "s" });
    logA?.observe({ type: "assistant", message: { content: [{ type: "text", text: "Reading the retry code." }, { type: "tool_use", name: "Grep", input: { pattern: "AKIA" } }] } });
    logA?.close();
    store.setRunPhase(a, "agent-running");
    const now = new Date(T0.getTime() + 95_000);

    const panes = snapshotLiveRuns(store, root, now);
    expect(panes.map(one => one.runId)).toEqual([a, b]);
    expect(panes[0]).toMatchObject({ taskId: "t-1", title: "Harden webhook retries", runner: "night-shift-1", role: "builder", phase: "agent running", transcript: "live" });
    expect(panes[0]?.lines).toEqual(["the agent session started", "Reading the retry code.", "→ searching the code"]);
    expect(panes[1]).toMatchObject({ taskId: "t-2", role: "scout", phase: "preparing workspace", transcript: "not-yet", lines: [] });
    expect(elapsedWords(T0.toISOString(), now)).toBe("1m35s");
    expect(stageWord({ phase: null, model: null, providerStartedAt: "x" })).toBe("the agent is working");

    // The tail advances from its offset, never re-reading what it showed.
    const tails = new Map();
    snapshotLiveRuns(store, root, now, tails);
    const more = openLiveLog(root, 999);
    more?.close();
    const again = snapshotLiveRuns(store, root, now, tails);
    expect(again[0]?.lines).toHaveLength(3);

    store.finishRun(a, { outcome: "built", now });
    expect(snapshotLiveRuns(store, root, now).map(one => one.runId)).toEqual([b]);
  });

  test("the frame: one header per pane with digits to focus; focus shows one pane whole; no runs says so", () => {
    const a = openRun("t-1", "builder");
    openRun("t-2", "scout");
    const now = new Date(T0.getTime() + 60_000);
    const panes = snapshotLiveRuns(store, root, now);
    const frame = composeFrame(panes, { columns: 100, rows: 12 }, null, now);
    const lines = frame.split("\n");
    expect(lines).toHaveLength(12);
    expect(lines[0]).toContain(`1 · #${a} Harden webhook retries`);
    expect(lines[0]).toContain("night-shift-1 · builder · preparing workspace · 1m00s");
    expect(frame).toContain("2 · #");
    expect(lines[11]).toContain("2 live · 1-2 focus · a all · q leaves");
    const focused = composeFrame(panes, { columns: 100, rows: 12 }, 1, now);
    expect(focused).toContain("Find out why login flakes");
    expect(focused).not.toContain("Harden webhook retries");
    expect(composeFrame([], { columns: 60, rows: 6 }, null, now)).toContain("nothing to peek at");
  });

  test("--tmux opens one window per run through tmux and refuses without tmux", async () => {
    openRun("t-1", "builder");
    openRun("t-2", "scout");
    const panes = snapshotLiveRuns(store, root, T0);
    const calls: string[][] = [];
    const opened = await openInTmux(panes, ["/usr/bin/node", "/x/cli.js"], async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stderr: "" };
    });
    expect(opened).toEqual({ ok: true, windows: 2 });
    expect(calls[0]).toEqual(["tmux", "-V"]);
    expect(calls[1]?.slice(0, 6)).toEqual(["tmux", "new-session", "-d", "-s", "standing-orders", "-n"]);
    expect(calls[1]?.[7]).toContain("'peek'");
    expect(calls[2]?.[1]).toBe("new-window");
    const refused = await openInTmux(panes, ["node"], async () => ({ code: 127, stderr: "" }));
    expect(refused.ok).toBe(false);
  });

  test("outside a terminal `peek --json` is one enveloped snapshot; an unknown run refuses", async () => {
    const a = openRun("t-1", "builder");
    // The CLI derives its evidence root beside the database: <dir>/evidence.
    const log = openLiveLog(join(root, "evidence"), a);
    log?.observe({ type: "assistant", message: { content: [{ type: "text", text: "hello from the agent" }] } });
    log?.close();
    const lines: string[] = [];
    const code = await runOperate("peek", ["--json"], line => lines.push(line), { databaseFile: db, now: new Date(T0.getTime() + 5_000) });
    expect(code).toBe(EXIT.ok);
    const envelope = JSON.parse(lines.join("\n")) as { ok: boolean; runs: { runId: number; lines: string[] }[] };
    expect(envelope.ok).toBe(true);
    expect(envelope.runs).toHaveLength(1);
    expect(envelope.runs[0]?.lines).toEqual(["hello from the agent"]);
    const missing: string[] = [];
    const refused = await runOperate("peek", ["424242", "--json"], line => missing.push(line), { databaseFile: db, now: T0 });
    expect(refused).toBe(EXIT.refused);
  });
});
