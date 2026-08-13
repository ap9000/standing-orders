/**
 * UI-only chat mirrors: pages become messages with console links; acting
 * stays in the console. One-way by design — nothing here reads a chat.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { saveWebhook, saveConsoleUrl, loadWebhookTargets, loadConsoleUrl, linkFor, webhookPass } from "./webhooks.js";

const T0 = new Date("2026-08-13T22:00:00.000Z");

describe("the mirrors", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nightorders-webhooks-"));
    store = openStore(":memory:");
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("URLs are credentials: shape-checked, 0600 on disk, env wins", () => {
    expect(saveWebhook(dir, "slack", "https://evil.example/x")).toMatchObject({ ok: false });
    expect(saveWebhook(dir, "slack", "https://hooks.slack.com/services/T0/B0/xyz")).toMatchObject({ ok: true });
    expect(statSync(join(dir, "slack-webhook")).mode & 0o777).toBe(0o600);
    expect(saveWebhook(dir, "discord", "https://discord.com/api/webhooks/1/abc")).toMatchObject({ ok: true });

    const targets = loadWebhookTargets({}, dir);
    expect(targets.map(one => one.kind).sort()).toEqual(["discord", "slack"]);
    const overridden = loadWebhookTargets({ NIGHTORDERS_SLACK_WEBHOOK: "https://hooks.slack.com/services/ENV" }, dir);
    expect(overridden.find(one => one.kind === "slack")?.url).toContain("ENV");

    expect(saveConsoleUrl(dir, "http://server.tailae758.ts.net:4180/")).toMatchObject({ ok: true });
    expect(loadConsoleUrl({}, dir)).toBe("http://server.tailae758.ts.net:4180");
  });

  test("links land where acting lives: decisions on their screen, everything else on /next", () => {
    const base = "http://host:4180";
    const decision = { dedupeKey: "decision:42", kind: "decision", subject: "s", body: "b" };
    const gap = { dedupeKey: "gap:/repo:env:KEY", kind: "gap", subject: "s", body: "b" };
    expect(linkFor(base, decision as never)).toBe("http://host:4180/d/42");
    expect(linkFor(base, gap as never)).toBe("http://host:4180/next");
    expect(linkFor(null, decision as never)).toBeNull();
  });

  test("a pass claims, posts to every mirror, finalizes once — and never leaks the URL on failure", async () => {
    store.enqueueNotification({ dedupeKey: "decision:7", kind: "decision", subject: "t-1 parked a decision", body: "Q: open or closed?" }, T0);
    store.enqueueNotification({ dedupeKey: "gap:x", kind: "gap", subject: "env:KEY blocks work", body: "supply it" }, T0);

    const posts: { url: string; body: string }[] = [];
    const fetcher = (async (url: unknown, init?: { body?: unknown }) => {
      posts.push({ url: String(url), body: String(init?.body ?? "") });
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    const report = await webhookPass(store, {
      targets: [
        { kind: "slack", url: "https://hooks.slack.com/services/T/B/x" },
        { kind: "discord", url: "https://discord.com/api/webhooks/1/y" },
      ],
      consoleUrl: "http://host:4180",
      clock: () => T0,
      fetcher,
    });
    expect(report.sent).toBe(2);
    // Two notifications × two mirrors; slack wears mrkdwn links, discord content.
    expect(posts).toHaveLength(4);
    expect(posts.some(one => one.body.includes("<http://host:4180/d/7|open in nightorders>"))).toBe(true);
    expect(posts.some(one => one.body.includes('"content"'))).toBe(true);
    // Delivered rows do not re-send on the next pass.
    const again = await webhookPass(store, {
      targets: [{ kind: "slack", url: "https://hooks.slack.com/services/T/B/x" }],
      consoleUrl: null, clock: () => new Date(T0.getTime() + 120_000), fetcher,
    });
    expect(again.sent).toBe(0);

    // Failure reports the platform and status — never the URL.
    store.enqueueNotification({ dedupeKey: "decision:8", kind: "decision", subject: "s", body: "b" }, T0);
    const failing = (async () => ({ ok: false, status: 403 }) as unknown as Response) as typeof fetch;
    const failed = await webhookPass(store, {
      targets: [{ kind: "slack", url: "https://hooks.slack.com/services/SECRET" }],
      consoleUrl: null, clock: () => new Date(T0.getTime() + 240_000), fetcher: failing,
    });
    expect(failed.problems.join(" ")).toContain("slack answered 403");
    expect(failed.problems.join(" ")).not.toContain("SECRET");
  });
});
