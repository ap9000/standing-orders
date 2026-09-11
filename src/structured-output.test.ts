import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVIDENCE_CAPS, readVerifiedArtifact } from "./evidence.js";
import { openStore, type Artifact, type Store } from "./store.js";
import {
  normalizeStructuredJson,
  storeStructuredAttempt,
  validationErrorsJson,
} from "./structured-output.js";

describe("structured JSON normalization is syntax-only", () => {
  test("removes one leading BOM and leaves the JSON values untouched", () => {
    const raw = '\uFEFF { "title": "keep \\\"quoted\\\" text", "ids": ["a", "b"], "enabled": false } ';

    const normalized = normalizeStructuredJson(raw);

    expect(normalized).toEqual({
      text: '{ "title": "keep \\\"quoted\\\" text", "ids": ["a", "b"], "enabled": false }',
      changed: true,
      changes: ["bom", "whitespace"],
    });
    expect(JSON.parse(normalized.text)).toEqual(JSON.parse(raw.slice(1)));
  });

  test.each([
    ["named LF fence", '```json\n{"goal":"ship"}\n```', '{"goal":"ship"}'],
    ["case-insensitive CRLF fence", '```JSON\r\n[1,{"x":false}]\r\n```', '[1,{"x":false}]'],
    ["unnamed fence", '```\n{"goal":"ship"}\n```', '{"goal":"ship"}'],
  ])("removes a whole-payload %s only", (_label, raw, expected) => {
    expect(normalizeStructuredJson(raw)).toEqual({
      text: expected,
      changed: true,
      changes: ["json-fence"],
    });
  });

  test("unwraps exactly one JSON-string transport layer", () => {
    const object = '{\n  "criterion": "c-1",\n  "judgement": "proved"\n}';
    const normalized = normalizeStructuredJson(JSON.stringify(object));

    expect(normalized).toEqual({ text: object, changed: true, changes: ["json-string"] });
    expect(JSON.parse(normalized.text)).toEqual(JSON.parse(object));

    const twiceEncoded = JSON.stringify(JSON.stringify(object));
    expect(normalizeStructuredJson(twiceEncoded)).toEqual({
      text: twiceEncoded,
      changed: false,
      changes: [],
    });
  });

  test("can remove independent BOM, fence, and one string wrapper without editing the payload", () => {
    const payload = '{"note":"literal braces { stay }","count":0}';
    const raw = `\uFEFF\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;

    const normalized = normalizeStructuredJson(raw);

    expect(normalized).toEqual({
      text: payload,
      changed: true,
      changes: ["bom", "json-fence", "json-string"],
    });
    expect(JSON.parse(normalized.text)).toEqual(JSON.parse(payload));
  });

  test.each([
    ["leading prose", 'Here is the JSON:\n{"goal":"ship"}'],
    ["trailing prose", '{"goal":"ship"}\nHope that helps.'],
    ["an embedded fence", 'Answer:\n```json\n{"goal":"ship"}\n```'],
    ["two fenced answers", '```json\n{"goal":"one"}\n```\n```json\n{"goal":"two"}\n```'],
    ["a non-JSON language fence", '```typescript\n{"goal":"ship"}\n```'],
  ])("does not fish an object out of %s", (_label, raw) => {
    expect(normalizeStructuredJson(raw)).toEqual({ text: raw, changed: false, changes: [] });
  });

  test.each([
    ["a scalar string", JSON.stringify("true")],
    ["an object-shaped but invalid string", JSON.stringify("{not json}")],
    ["a twice-wrapped object", JSON.stringify(JSON.stringify('{"goal":"ship"}'))],
  ])("does not reinterpret %s as a structured payload", (_label, raw) => {
    expect(normalizeStructuredJson(raw)).toEqual({
      text: raw,
      changed: false,
      changes: [],
    });
  });

  test("ordinary valid JSON changes neither lexical content nor semantics", () => {
    const raw = '{"z":1e3,"a":"\\u0061","nested":{"keep":null}}';
    const normalized = normalizeStructuredJson(raw);

    expect(normalized).toEqual({ text: raw, changed: false, changes: [] });
    expect(JSON.parse(normalized.text)).toEqual(JSON.parse(raw));
  });

  test("reports outer-whitespace normalization instead of changing bytes invisibly", () => {
    const raw = ' \n {"goal":"ship"}\t ';

    expect(normalizeStructuredJson(raw)).toEqual({
      text: '{"goal":"ship"}',
      changed: true,
      changes: ["whitespace"],
    });
  });
});

describe("structured response attempt evidence", () => {
  const NOW = new Date("2026-09-10T19:00:00.000Z");
  let dir: string;
  let store: Store;
  let run: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-structured-output-"));
    store = openStore(":memory:");
    store.createTask({ id: "task-1", title: "structured response" }, NOW);
    const ref = store.refFor("built-in", "task-1");
    store.placeTask(ref.id, "/repo");
    run = store.startRun({
      taskRef: ref.id,
      leaseId: "lease-1",
      runner: "runner-1",
      role: "planner",
      branch: "standing-orders/task-1",
      worktree: "/work/task-1",
      now: NOW,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function artifact(id: number): Artifact {
    const found = store.getArtifact(id);
    if (found === null) throw new Error(`missing artifact ${id}`);
    return found;
  }

  test("keeps an unsuccessful clean response byte-for-byte with a typed failed capture", () => {
    const raw = '  {"goal":"same bytes"}\r\n';
    const id = storeStructuredAttempt(store, dir, run, {
      phase: "planner",
      attempt: 1,
      authoredRunId: 71,
      raw,
      accepted: false,
      normalized: false,
      now: NOW,
    });
    const saved = artifact(id);

    expect(saved).toMatchObject({
      run,
      kind: "structured-output",
      key: `${run}/planner-response-1.txt`,
      bytesOriginal: Buffer.byteLength(raw),
      bytesStored: Buffer.byteLength(raw),
      truncated: false,
      capture: "planner response 1 from run 71 (not accepted)",
      createdAt: NOW.toISOString(),
      redacted: false,
      captureStatus: "failed",
    });
    const read = readVerifiedArtifact(dir, saved);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.content.toString("utf8")).toBe(raw);
  });

  test("records parser-accepted candidates without claiming final workflow acceptance", () => {
    const raw = '```json\n{"judgements":[]}\n```';
    const id = storeStructuredAttempt(store, dir, run, {
      phase: "reviewer",
      attempt: 2,
      authoredRunId: 72,
      raw,
      accepted: true,
      normalized: true,
      now: NOW,
    });
    const saved = artifact(id);

    expect(saved).toMatchObject({
      key: `${run}/reviewer-response-2.txt`,
      capture: "reviewer response 2 from run 72 (parser accepted, syntax normalized; workflow pending)",
      redacted: false,
      captureStatus: "ok",
    });
    const read = readVerifiedArtifact(dir, saved);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.content.toString("utf8")).toBe(raw);
  });

  test("redacts a credential-shaped line before the attempt becomes durable", () => {
    const secret = `github_pat_${"a".repeat(80)}`;
    const raw = ['{"safe":"this line remains",', `"token":"${secret}",`, '"end":true}'].join("\n");
    const id = storeStructuredAttempt(store, dir, run, {
      phase: "planner",
      attempt: 1,
      authoredRunId: 73,
      raw,
      accepted: false,
      normalized: false,
      now: NOW,
    });
    const saved = artifact(id);
    const read = readVerifiedArtifact(dir, saved);

    expect(saved.redacted).toBe(true);
    expect(saved.captureStatus).toBe("failed");
    expect(saved.bytesOriginal).toBe(Buffer.byteLength(raw));
    expect(saved.truncated).toBe(true);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const stored = read.content.toString("utf8");
      expect(stored).toContain('{"safe":"this line remains",');
      expect(stored).toContain("[redacted: github-token detected on this line]");
      expect(stored).toContain('"end":true}');
      expect(stored).not.toContain(secret);
      expect(saved.bytesStored).toBe(read.content.length);
    }
  });

  test("caps an oversized response while preserving its true original byte count", () => {
    const cap = EVIDENCE_CAPS["structured-output"];
    const raw = "x".repeat(cap + 257);
    const id = storeStructuredAttempt(store, dir, run, {
      phase: "planner",
      attempt: 1,
      authoredRunId: 74,
      raw,
      accepted: false,
      normalized: false,
      now: NOW,
    });
    const saved = artifact(id);
    const read = readVerifiedArtifact(dir, saved);

    expect(saved).toMatchObject({
      bytesOriginal: cap + 257,
      bytesStored: cap,
      truncated: true,
      redacted: false,
      captureStatus: "failed",
    });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.content.equals(Buffer.from("x".repeat(cap)))).toBe(true);
  });
});

describe("validation error serialization", () => {
  test("keeps agent-authored strings inert data and omits absent messages", () => {
    const dangerousReason = 'bad-id\n```json\n{"invent":true}\n```';
    const encoded = validationErrorsJson([
      { reason: dangerousReason, message: 'path "src/x.ts" is unknown' },
      { reason: "missing-judgement" },
    ]);

    expect(JSON.parse(encoded)).toEqual([
      { reason: dangerousReason, message: 'path "src/x.ts" is unknown' },
      { reason: "missing-judgement" },
    ]);
    expect(encoded).toContain('\\n```json');
  });
});
