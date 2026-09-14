import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Only application-owned CSS belongs here. Never pass rendered HTML or
 * session data: this asset is public, immutable and compressed. */
export function styleAsset(css: string) {
  const body = Buffer.from(css);
  const digest = createHash("sha256").update(body).digest("hex");
  const path = `/assets/workspace-${digest}.css`;
  const zipped = gzipSync(body);
  return {
    path,
    serve(request: IncomingMessage, response: ServerResponse): void {
      const encodings = (request.headers["accept-encoding"] ?? "").split(",").map(value => {
        const [name, ...params] = value.trim().toLowerCase().split(";");
        const quality = params.find(p => p.trim().startsWith("q="));
        return { name, q: quality === undefined ? 1 : Number(quality.trim().slice(2)) };
      });
      const gzip = encodings.find(e => e.name === "gzip") ?? encodings.find(e => e.name === "*");
      const compressed = gzip !== undefined && gzip.q > 0 && gzip.q <= 1;
      const bytes = compressed ? zipped : body;
      const etag = `"${digest}${compressed ? "-gzip" : ""}"`;
      const headers = {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'",
        "X-Content-Type-Options": "nosniff",
        "Vary": "Accept-Encoding",
        "ETag": etag,
        ...(compressed ? { "Content-Encoding": "gzip" } : {}),
      };
      const matches = (request.headers["if-none-match"] ?? "").split(",").some(value => value.trim().replace(/^W\//, "") === etag || value.trim() === "*");
      if (matches) {
        response.writeHead(304, headers);
        response.end();
        return;
      }
      response.writeHead(200, { ...headers, "Content-Length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
    },
  };
}
