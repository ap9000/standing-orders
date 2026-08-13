/**
 * The verified artifact reader: every proof runs against the descriptor the
 * bytes actually come from, and nothing unverified ever leaves the function.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVerifiedArtifact, writeEvidenceFile } from "./evidence.js";
import type { Artifact } from "./store.js";

describe("reading evidence back, believing nothing", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "standing-orders-evidence-"));
    outside = mkdtempSync(join(tmpdir(), "standing-orders-outside-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const record = (key: string, content: Buffer, overrides: Partial<Artifact> = {}): Artifact => ({
    id: 1,
    run: 1,
    kind: "diff",
    key,
    bytesOriginal: content.length,
    bytesStored: content.length,
    truncated: false,
    sha256: createHash("sha256").update(content).digest("hex"),
    capture: "git diff (exit 0)",
    createdAt: "2026-08-12T00:00:00.000Z",
    redacted: false,
    ...overrides,
  });

  test("a file that is exactly its record comes back whole", () => {
    const content = Buffer.from("diff --git a/x b/x\n");
    const key = writeEvidenceFile(root, 1, "diff.patch", content);

    const read = readVerifiedArtifact(root, record(key, content));

    expect(read).toMatchObject({ ok: true });
    if (read.ok) expect(read.content.equals(content)).toBe(true);
  });

  test("a traversal key never reaches the filesystem", () => {
    // The interesting failure is a *record* gone wrong — a row whose key
    // points outside the root must die on shape alone.
    writeFileSync(join(outside, "loot"), "secret");
    for (const key of ["../loot", "1/../../loot", "/etc/hosts", "1//x", "1/.", "a\\b"]) {
      const read = readVerifiedArtifact(root, record(key, Buffer.from("secret")));
      expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("not a normalized") });
    }
  });

  test("a symlink out of the root is refused even though the key looks clean", () => {
    writeFileSync(join(outside, "loot"), "secret");
    const content = Buffer.from("secret");
    writeEvidenceFile(root, 1, "anchor", Buffer.from("x")); // creates root/1/
    symlinkSync(join(outside, "loot"), join(root, "1", "link"));

    const read = readVerifiedArtifact(root, record("1/link", content));

    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("outside the evidence root") });
  });

  test("tampered bytes are refused — the hash check is not decorative", () => {
    const content = Buffer.from("original");
    const key = writeEvidenceFile(root, 1, "diff.patch", content);
    writeFileSync(join(root, key), "originaX"); // same length, different bytes

    const read = readVerifiedArtifact(root, record(key, content));

    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("no longer hashes") });
  });

  test("a grown file is refused before hashing — the read is bounded by the record", () => {
    const content = Buffer.from("original");
    const key = writeEvidenceFile(root, 1, "diff.patch", content);
    appendFileSync(join(root, key), ".".repeat(1024));

    const read = readVerifiedArtifact(root, record(key, content));

    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("size no longer matches") });
  });

  test("a record claiming more than its kind may store is refused unread", () => {
    const content = Buffer.from("x");
    const key = writeEvidenceFile(root, 1, "status.txt", content);

    const read = readVerifiedArtifact(
      root,
      record(key, content, { kind: "status", bytesStored: 10 * 1024 * 1024 }),
    );

    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("more bytes than its kind") });
  });

  test("a missing file is a calm refusal, not a throw", () => {
    const read = readVerifiedArtifact(root, record("1/never-written", Buffer.from("x")));
    expect(read).toMatchObject({ ok: false, problem: expect.stringContaining("gone or unresolvable") });
  });
});
