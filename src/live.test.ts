/**
 * The live window's file discipline: created exclusively, appended through
 * a retained descriptor, sanitized line by line, capped with a marker, and
 * read back by byte offset in complete lines only. Display state, never
 * evidence — and never worth a build.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, symlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_CAP_MARKER,
  LIVE_FILE_CAP,
  LIVE_REDACTED_LINE,
  listLiveFiles,
  liveLogPath,
  openLiveLog,
  readLiveWindow,
  removeLiveFile,
  renderTranscriptLines,
  sanitizeTranscriptLine,
} from "./live.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "so-live-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const assistant = (text: string): Record<string, unknown> => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "text", text }] },
});

describe("rendering — the fixed vocabulary", () => {
  test("assistant text renders as the agent's words; tool use renders OUR phrase, never the name", () => {
    expect(renderTranscriptLines(assistant("working on the parser"))).toEqual(["working on the parser"]);
    const tooling: Record<string, unknown> = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "curl -H 'x-api-key: sk-…'" } },
          { type: "tool_use", name: "SomeFutureTool", input: {} },
        ],
      },
    };
    const lines = renderTranscriptLines(tooling);
    expect(lines).toEqual(["→ running a command", "→ using a tool"]);
    expect(lines.join("\n")).not.toContain("Bash");
    expect(lines.join("\n")).not.toContain("curl");
  });

  test("subagent chatter, tool results, and result events render nothing", () => {
    expect(renderTranscriptLines({ type: "assistant", parent_tool_use_id: "t-1", message: { content: [{ type: "text", text: "child words" }] } })).toEqual([]);
    expect(renderTranscriptLines({ type: "user", message: {} })).toEqual([]);
    expect(renderTranscriptLines({ type: "result", subtype: "success" })).toEqual([]);
  });

  test("a credential-shaped line is replaced WHOLE; controls are stripped", () => {
    expect(sanitizeTranscriptLine("the key is sk-ant-api03-" + "a".repeat(40))).toBe(LIVE_REDACTED_LINE);
    expect(sanitizeTranscriptLine("plain \x1b[31mred\x1b[0m words\x07")).toBe("plain red words");
  });
});

describe("the writer", () => {
  test("creates live/<runId>.log 0600 in a 0700 directory and appends sanitized lines", () => {
    const log = openLiveLog(root, 42);
    expect(log).not.toBeNull();
    log?.observe({ type: "system", subtype: "init" });
    log?.observe(assistant("hello from the agent"));
    log?.close();
    const path = liveLogPath(root, 42);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "live")).mode & 0o777).toBe(0o700);
    const content = readFileSync(path, "utf8");
    expect(content).toBe("the agent session started\nhello from the agent\n");
  });

  test("an existing name is refused, not appended to (O_EXCL)", () => {
    mkdirSync(join(root, "live"), { recursive: true, mode: 0o700 });
    writeFileSync(liveLogPath(root, 7), "planted\n", { mode: 0o600 });
    expect(openLiveLog(root, 7)).toBeNull();
  });

  test("the file cap ends the file with the marker and nothing after", () => {
    const log = openLiveLog(root, 9);
    const bigLine = "x".repeat(1500);
    for (let i = 0; i < 2000; i += 1) log?.observe(assistant(bigLine));
    log?.observe(assistant("after the cap"));
    log?.close();
    const content = readFileSync(liveLogPath(root, 9), "utf8");
    expect(content.length).toBeLessThanOrEqual(LIVE_FILE_CAP);
    expect(content.endsWith(`${LIVE_CAP_MARKER}\n`)).toBe(true);
    expect(content).not.toContain("after the cap");
  });
});

describe("the byte-offset reader", () => {
  test("returns complete lines only, then continues from nextOffset", () => {
    const log = openLiveLog(root, 5);
    log?.observe(assistant("first"));
    log?.observe(assistant("second"));
    const one = readLiveWindow(root, 5, 0);
    expect(one).toMatchObject({ ok: true, text: "first\nsecond\n" });
    if (one.ok) {
      const again = readLiveWindow(root, 5, one.nextOffset);
      expect(again).toMatchObject({ ok: true, text: "", eof: true });
    }
    log?.close();
  });

  test("an unterminated tail is withheld until the final drain asks for it", () => {
    const path = liveLogPath(root, 6);
    const log = openLiveLog(root, 6);
    log?.observe(assistant("done line"));
    log?.close();
    appendFileSync(path, "torn tail with no newline");
    const polling = readLiveWindow(root, 6, 0);
    expect(polling).toMatchObject({ ok: true, text: "done line\n" });
    const drained = readLiveWindow(root, 6, 0, true);
    if (drained.ok) expect(drained.text).toBe("done line\ntorn tail with no newline");
    expect(drained).toMatchObject({ ok: true, eof: true });
  });

  test("a shrunken file is `replaced`, never silently re-read", () => {
    const log = openLiveLog(root, 8);
    log?.observe(assistant("a line that will vanish"));
    log?.close();
    expect(readLiveWindow(root, 8, 10_000)).toEqual({ ok: false, reason: "replaced" });
  });

  test("a symlinked name or a bad offset is refused", () => {
    mkdirSync(join(root, "live"), { recursive: true, mode: 0o700 });
    symlinkSync("/etc/hosts", liveLogPath(root, 11));
    expect(readLiveWindow(root, 11, 0)).toMatchObject({ ok: false });
    expect(readLiveWindow(root, 12, -1)).toEqual({ ok: false, reason: "unreadable" });
    expect(readLiveWindow(root, 12, Number.MAX_SAFE_INTEGER + 2)).toEqual({ ok: false, reason: "unreadable" });
  });

  test("a missing file is `missing` — the region says the view has not started", () => {
    expect(readLiveWindow(root, 999, 0)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("the sweep listing", () => {
  test("names run files by id, flags strangers, and removal refuses traversal", () => {
    openLiveLog(root, 3)?.close();
    writeFileSync(join(root, "live", "stranger.txt"), "?");
    const listed = listLiveFiles(root);
    expect(listed.find(one => one.runId === 3)).toBeTruthy();
    expect(listed.find(one => one.fileName === "stranger.txt")?.runId).toBeNull();
    removeLiveFile(root, "../escape");
    removeLiveFile(root, "stranger.txt");
    expect(listLiveFiles(root).find(one => one.fileName === "stranger.txt")).toBeUndefined();
  });
});
