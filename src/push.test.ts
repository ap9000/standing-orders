/**
 * The push engine: the RFC 8291 Appendix A vector byte-for-byte, VAPID
 * signatures verified with node's own verifier in P1363 mode, the endpoint
 * allow-list, the payload vocabulary, and a full pass over a fake push
 * service exercising the outcome table.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createECDH, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPushPayload,
  encryptWithMaterials,
  loadOrCreateVapidKeys,
  pushPass,
  safePushLink,
  validatePushEndpoint,
  vapidAuthorization,
  PUSH_WORDS,
  type PushFetch,
} from "./push.js";
import { openStore, type Store, type Notification } from "./store.js";
import { addApprover } from "./scope.js";

const T0 = new Date("2026-08-24T18:00:00Z");

describe("RFC 8291 Appendix A — byte-for-byte", () => {
  test("the complete example reproduces exactly", () => {
    const uaPublic = Buffer.from("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "base64url");
    const authSecret = Buffer.from("BTBZMqHH6r4Tts7J_aSIgg", "base64url");
    const asPrivate = Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url");
    const salt = Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url");
    const plaintext = Buffer.from("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24", "base64url");

    const asKeys = createECDH("prime256v1");
    asKeys.setPrivateKey(asPrivate);
    expect(asKeys.getPublicKey().toString("base64url")).toBe(
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    );

    const body = encryptWithMaterials(uaPublic, authSecret, asKeys, salt, plaintext);
    // RFC 8291 §5, the complete message body, line-unwrapped from the RFC text.
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
    // Header framing: salt, rs = 4096, idlen = 65.
    expect(body.subarray(0, 16).equals(salt)).toBe(true);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
  });

  test("oversized payloads and malformed subscriber material refuse", () => {
    const asKeys = createECDH("prime256v1");
    asKeys.generateKeys();
    const good = createECDH("prime256v1");
    good.generateKeys();
    expect(() =>
      encryptWithMaterials(good.getPublicKey(), Buffer.alloc(16), asKeys, Buffer.alloc(16), Buffer.alloc(3994)),
    ).toThrow(/3993/);
    expect(() => encryptWithMaterials(Buffer.alloc(65), Buffer.alloc(16), asKeys, Buffer.alloc(16), Buffer.from("x"))).toThrow();
  });
});

describe("VAPID (RFC 8292)", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "so-vapid-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("keys mint once, load stably, and refuse a doctored pair", () => {
    const first = loadOrCreateVapidKeys(dir);
    const again = loadOrCreateVapidKeys(dir);
    expect(again.publicKey).toBe(first.publicKey);
    const doctored = JSON.parse(readFileSync(join(dir, "vapid-keys.json"), "utf8")) as Record<string, string>;
    const other = createECDH("prime256v1");
    other.generateKeys();
    doctored["publicKey"] = other.getPublicKey().toString("base64url");
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(join(dir, "vapid-keys.json"), JSON.stringify(doctored));
    expect(() => loadOrCreateVapidKeys(dir)).toThrow(/mismatched/);
  });

  test("the authorization header carries a P1363 ES256 JWT node itself verifies", () => {
    const keys = loadOrCreateVapidKeys(dir);
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/x", keys, T0, "mailto:alex@example.com");
    const token = /t=([^,]+), k=/.exec(header)?.[1] ?? "";
    const [head = "", body = "", signature = ""] = token.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims["aud"]).toBe("https://fcm.googleapis.com");
    expect(Number(claims["exp"])).toBeLessThanOrEqual(Math.floor(T0.getTime() / 1000) + 24 * 3600);
    expect(claims["sub"]).toBe("mailto:alex@example.com");

    const point = Buffer.from(keys.publicKey, "base64url");
    const publicKey = createPublicKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
    });
    const verified = cryptoVerify(
      "sha256",
      Buffer.from(`${head}.${body}`, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    );
    expect(verified).toBe(true);
  });
});

describe("endpoint discipline", () => {
  test("known services pass; everything else refuses", () => {
    expect(validatePushEndpoint("https://fcm.googleapis.com/fcm/send/abc").ok).toBe(true);
    expect(validatePushEndpoint("https://web.push.apple.com/x").ok).toBe(true);
    expect(validatePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x").ok).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/x",
      "https://evil.example.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://10.0.0.1/x",
      `https://fcm.googleapis.com/${"a".repeat(1100)}`,
    ]) {
      expect(validatePushEndpoint(bad).ok).toBe(false);
    }
  });

  test("payload words are fixed and links are re-proved", () => {
    expect(safePushLink("decision", "/d/12")).toBe("/d/12");
    expect(safePushLink("decision", "/t/customer-secret-project")).toBe("/next");
    expect(safePushLink("merge", null)).toBe("/review");
    const fake = { id: 7, pushClass: "pick", link: "/contest/3" } as unknown as Notification;
    const payload = JSON.parse(buildPushPayload(fake)) as Record<string, unknown>;
    expect(payload["body"]).toBe(PUSH_WORDS.pick.body);
    expect(payload["url"]).toBe("/contest/3");
    expect(payload["tag"]).toBe("so-7");
  });
});

describe("the pass — outcome table over a fake push service", () => {
  let store: Store;
  let dir: string;
  beforeEach(() => {
    store = openStore(":memory:");
    dir = mkdtempSync(join(tmpdir(), "so-pushpass-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const later = (ms: number) => new Date(T0.getTime() + ms);

  const device = (endpoint: string) => {
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const keys = loadOrCreateVapidKeys(dir);
    return store.enrollPushSubscription(
      {
        endpoint,
        p256dh: browser.getPublicKey().toString("base64url"),
        auth: Buffer.from("BTBZMqHH6r4Tts7J_aSIgg", "base64url").toString("base64url"),
        approver: "alex",
        approverGeneration: 1,
        uaWords: "a phone",
        vapidFingerprint: keys.fingerprint,
      },
      T0,
    );
  };

  const fakeFetch = (answers: Record<string, number>): { calls: string[]; fetch: PushFetch } => {
    const calls: string[] = [];
    return {
      calls,
      fetch: async url => {
        calls.push(url);
        return { status: answers[url] ?? 201, headers: { get: () => null } };
      },
    };
  };

  test("accepted, gone, and retryable devices each settle by the table", async () => {
    device("https://fcm.googleapis.com/fcm/send/ok");
    device("https://fcm.googleapis.com/fcm/send/gone");
    device("https://fcm.googleapis.com/fcm/send/flaky");
    store.enqueueNotification({ dedupeKey: "d:1", kind: "decision", subject: "s", body: "b", pushClass: "decision", link: "/d/1" }, later(1_000));

    const { calls, fetch } = fakeFetch({
      "https://fcm.googleapis.com/fcm/send/ok": 201,
      "https://fcm.googleapis.com/fcm/send/gone": 410,
      "https://fcm.googleapis.com/fcm/send/flaky": 503,
    });
    const report = await pushPass(store, { configDir: dir, fetchImpl: fetch, clock: () => later(2_000) });
    expect(report).toMatchObject({ accepted: 1, retired: 1, rescheduled: 1 });
    expect(calls.length).toBe(3);
    // The flaky pair retries later; the gone device never does.
    const second = await pushPass(store, { configDir: dir, fetchImpl: fetch, clock: () => later(2 * 60_000 + 3_000) });
    expect(second.accepted).toBe(0); // flaky answered 503 again → rescheduled again
    expect(second.retired).toBe(0);
  });

  test("resolved facts are never transmitted; unstamped kinds never pair", async () => {
    device("https://fcm.googleapis.com/fcm/send/ok");
    store.enqueueNotification({ dedupeKey: "d:2", kind: "decision", subject: "s", body: "b", pushClass: "decision", link: "/d/2" }, later(1_000));
    store.resolveEpisodes("d", later(1_500));
    store.enqueueNotification({ dedupeKey: "chatty:1", kind: "build-failed", subject: "s", body: "b" }, later(1_600));
    const { calls, fetch } = fakeFetch({});
    const report = await pushPass(store, { configDir: dir, fetchImpl: fetch, clock: () => later(2_000) });
    expect(calls.length).toBe(0);
    expect(report.accepted).toBe(0);
  });

  test("401 opens ONE credential episode, does not retire devices, and a later 2xx closes it", async () => {
    device("https://fcm.googleapis.com/fcm/send/a");
    store.enqueueNotification({ dedupeKey: "d:3", kind: "decision", subject: "s", body: "b", pushClass: "decision", link: "/d/3" }, later(1_000));
    const refusing = fakeFetch({ "https://fcm.googleapis.com/fcm/send/a": 403 });
    const first = await pushPass(store, { configDir: dir, fetchImpl: refusing.fetch, clock: () => later(2_000) });
    expect(first.credentialProblem).toBe(true);
    expect(store.listPushSubscriptions("alex")[0]?.retiredAt).toBeNull();
    const episodes = store.listNotifications("all").filter(one => one.kind === "push-credentials");
    expect(episodes.length).toBe(1);
    expect(episodes[0]?.pushClass).toBeNull(); // never recursive

    const accepting = fakeFetch({});
    await pushPass(store, { configDir: dir, fetchImpl: accepting.fetch, clock: () => later(2 * 60_000 + 3_000) });
    expect(store.listNotifications("all").find(one => one.kind === "push-credentials")?.resolvedAt).not.toBeNull();
  });

  test("a demo store never pushes", async () => {
    const demoStore = openStore(":memory:");
    demoStore.stampDemo?.(T0);
    const { calls, fetch } = fakeFetch({});
    const report = await pushPass(demoStore, { configDir: dir, fetchImpl: fetch, clock: () => later(1_000) });
    expect(calls.length).toBe(0);
    expect(report.seeded).toBe(0);
  });
});
