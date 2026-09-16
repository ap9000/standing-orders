/**
 * UI-only chat mirrors: pages become messages with console links; acting
 * stays in the console. One-way by design — nothing here reads a chat.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { saveWebhook, saveConsoleUrl, loadWebhookTargets, loadConsoleUrl, linkFor, webhookPass, effectivePrimary, savePrimary, clearWebhook, phoneOrigin, CONSOLE_URL_ENV } from "./webhooks.js";

const T0 = new Date("2026-08-13T22:00:00.000Z");

describe("the mirrors", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-webhooks-"));
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
    const overridden = loadWebhookTargets({ STANDING_ORDERS_SLACK_WEBHOOK: "https://hooks.slack.com/services/ENV" }, dir);
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
    expect(posts.some(one => one.body.includes("<http://host:4180/d/7|open in standing-orders>"))).toBe(true);
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

describe("the primary — one service pages, chosen or sensibly implied", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-primary-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("implicit until chosen; explicit wins only while its service is configured", () => {
    // Nothing configured: nobody pages, nothing implicit.
    expect(effectivePrimary({}, dir, false)).toMatchObject({ channel: null, implicit: false });

    // Telegram alone: it pages, no ambiguity.
    expect(effectivePrimary({}, dir, true)).toMatchObject({ channel: "telegram", implicit: false });

    // Telegram + slack, nothing chosen: telegram pages BY DEFAULT and the
    // status is flagged implicit — the "pick one" moment.
    saveWebhook(dir, "slack", "https://hooks.slack.com/services/T/B/x");
    expect(effectivePrimary({}, dir, true)).toMatchObject({ channel: "telegram", implicit: true });

    // The choice sticks.
    savePrimary(dir, "slack");
    expect(effectivePrimary({}, dir, true)).toMatchObject({ channel: "slack", implicit: false });

    // A primary pointing at a service that is no longer configured falls
    // through instead of silencing every page.
    clearWebhook(dir, "slack");
    expect(effectivePrimary({}, dir, true)).toMatchObject({ channel: "telegram" });
  });
});

describe("the console URL is parsed, not pattern-matched (attended A5)", () => {
  test("credentials, queries, fragments, and odd schemes refuse; a clean base normalizes", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "console-url-"));
    try {
      expect(saveConsoleUrl(dir, "http://user:secret@host:4180")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "http://host:4180/?q=1")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "http://host:4180/#frag")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "ftp://host:4180")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "not a url")).toMatchObject({ ok: false });
      expect(saveConsoleUrl(dir, "http://host:4180/base/")).toMatchObject({ ok: true });
      expect(loadConsoleUrl({}, dir)).toBe("http://host:4180/base");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the phone origin: the same console-url setting, held to an https origin and re-read every time", () => {
  test("only a clean https origin qualifies; http, credentials, path, query, fragment, loopback and a removed setting give no link; a co-hosted --public-url must match exactly", () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-origin-"));
    try {
      expect(phoneOrigin({}, dir)).toBeNull();
      expect(saveConsoleUrl(dir, "https://console.example:8443/")).toMatchObject({ ok: true });
      expect(phoneOrigin({}, dir)).toBe("https://console.example:8443");
      // The generic mirror setting keeps accepting http and a path prefix (unrelated consumers rely on it); the phone refuses both.
      expect(saveConsoleUrl(dir, "http://console.example:8443")).toMatchObject({ ok: true });
      expect(loadConsoleUrl({}, dir)).toBe("http://console.example:8443");
      expect(phoneOrigin({}, dir)).toBeNull();
      expect(saveConsoleUrl(dir, "https://console.example/base/")).toMatchObject({ ok: true });
      expect(loadConsoleUrl({}, dir)).toBe("https://console.example/base");
      expect(phoneOrigin({}, dir)).toBeNull();
      // The environment wins over the file and is parsed to the same rule — nothing the setter refused can arrive through it either.
      // Loopback under every spelling the parser canonicalises: dotted, IPv6, and an IPv4 mapped or embedded in IPv6.
      for (const bad of ["https://user:pw@console.example", "https://console.example/?q=1", "https://console.example/#frag", "https://localhost:4180", "https://127.0.0.1:4180", "https://127.1.2.3", "https://0.0.0.0", "https://[::1]:4180", "https://[::]:4180", "https://[::ffff:127.0.0.1]", "https://[::ffff:7f00:1]", "https://[0:0:0:0:0:ffff:127.0.0.1]:4180", "https://[::ffff:0.0.0.0]", "https://[::127.0.0.1]", "https://app.localhost", "ftp://console.example", "console.example", "not a url", "   "]) {
        expect(phoneOrigin({ [CONSOLE_URL_ENV]: bad }, dir), bad).toBeNull();
      }
      expect(phoneOrigin({ [CONSOLE_URL_ENV]: "https://Console.Example:443/" }, dir)).toBe("https://console.example");
      // A public address embedded the same way is not loopback, and neither is a routable literal.
      expect(phoneOrigin({ [CONSOLE_URL_ENV]: "https://[::ffff:203.0.113.9]" }, dir)).toBe("https://[::ffff:cb00:7109]");
      expect(phoneOrigin({ [CONSOLE_URL_ENV]: "https://[2001:db8::10]:8443" }, dir)).toBe("https://[2001:db8::10]:8443");
      // Co-hosted with a stated public origin: equal or nothing.
      expect(saveConsoleUrl(dir, "https://console.example")).toMatchObject({ ok: true });
      expect(phoneOrigin({}, dir, { serverOrigin: "https://console.example" })).toBe("https://console.example");
      expect(phoneOrigin({}, dir, { serverOrigin: "https://console.example/" })).toBe("https://console.example");
      expect(phoneOrigin({}, dir, { serverOrigin: "https://elsewhere.example" })).toBeNull();
      expect(phoneOrigin({}, dir, { serverOrigin: "https://console.example:8443" })).toBeNull();
      expect(phoneOrigin({}, dir, { serverOrigin: "not a url" })).toBeNull();
      expect(phoneOrigin({}, dir, { serverOrigin: null })).toBe("https://console.example");
      // Removed: the very next read is null — nothing was cached.
      rmSync(join(dir, "console-url"));
      expect(phoneOrigin({}, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
