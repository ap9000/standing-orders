import { test, expect } from "vitest";
import { createDecisionServer } from "./serve.js";
import { openStore } from "./store.js";
import { styleAsset } from "./style-asset.js";

test("one versioned CSS asset is public and compressed; HTML stays private and unknown paths do not serve CSS", async () => {
  const store = openStore(":memory:");
  const server = createDecisionServer({ store });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no fixture address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/login`);
    const html = await login.text();
    const path = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1];
    expect(path).toMatch(/^\/assets\/workspace-[a-f0-9]{64}\.css$/);
    expect(html).not.toContain("@font-face");
    expect(login.headers.get("cache-control")).toBe("no-store");
    expect(login.headers.get("content-encoding")).toBeNull();
    expect(login.headers.get("content-security-policy")).toContain("style-src 'self' 'unsafe-inline'");
    expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const plain = await fetch(base + path, { headers: { "accept-encoding": "identity" } });
    const css = await plain.text();
    expect(css).toContain("@font-face");
    expect(css).not.toContain('name="csrf"');
    expect(plain.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(plain.headers.get("x-content-type-options")).toBe("nosniff");
    expect(plain.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const zipped = await fetch(base + path, { headers: { "accept-encoding": "gzip" } });
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("vary")).toBe("Accept-Encoding");
    expect(Number(zipped.headers.get("content-length"))).toBeLessThan(Buffer.byteLength(css) * .3);
    expect(await zipped.text()).toBe(css);
    expect(zipped.headers.get("etag")).not.toBe(plain.headers.get("etag"));
    const cached = await fetch(base + path, { headers: { "accept-encoding": "gzip", "if-none-match": `W/${zipped.headers.get("etag")}` } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    const head = await fetch(base + path, { method: "HEAD", headers: { "accept-encoding": "gzip;q=0, *;q=1" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-encoding")).toBeNull();
    expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(css));
    expect(await head.text()).toBe("");
    const unknown = await fetch(`${base}/assets/workspace-wrong.css`, { redirect: "manual" });
    expect(unknown.headers.get("content-type") ?? "").not.toContain("text/css");
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    const token = await fetch(base + path + "?token=never", { redirect: "manual" });
    expect(token.status).toBe(400);
    expect(token.headers.get("cache-control")).toBe("no-store");
    expect(styleAsset("a{}").path).toBe(styleAsset("a{}").path);
    expect(styleAsset("a{}").path).not.toBe(styleAsset("b{}").path);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});
