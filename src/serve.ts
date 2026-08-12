/**
 * The web decision view (§7): a park renders as one screen, answerable on a
 * phone. `nightorders serve` — node:http, no dependencies, no JavaScript in
 * the page. TLS is a proxy's job and the docs say so; what is not delegated
 * is everything else:
 *
 * **Authentication is required on every bind, localhost included.** The
 * credential is the approver's — the same name-and-token that approves a
 * scope and answers in the CLI — because `answered_by` must be an identity
 * somebody proved, not a string a request asserted. A browser logs in once
 * (POST /login) and carries an HttpOnly SameSite=Strict session cookie; an
 * API caller sends `Authorization: Bearer <name>:<token>` per request. The
 * token never travels in a URL, where it would land in history and logs.
 *
 * **Every request proves its Host** against the names this server was told
 * it answers as — a DNS-rebound page resolves to us with the attacker's
 * hostname in the Host header, and that request must die before routing.
 * Cookie-authenticated mutations additionally prove an allowed Origin and a
 * per-session CSRF nonce; Bearer mutations carry no cookie for a hostile
 * page to ride, so they skip the ceremony.
 *
 * **Everything rendered is escaped at the sink.** Decision text was
 * validated at park time (caps, control characters), but "printable" is not
 * "inert": an option label is still free to contain <script>. The CSP is
 * belt to that suspenders — no scripts, no frames, no external anything.
 *
 * **Evidence is streamed only through the decision's own artifact rows**,
 * after proving the file still lives under the evidence root, is a regular
 * file, and still hashes to what was recorded — and it is served as a
 * plain-text attachment, never sniffable inline content.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readVerifiedArtifact } from "./evidence.js";
import type { Artifact, Decision, Store } from "./store.js";
import { authenticateApprover } from "./scope.js";
import { loadBotToken, redactToken, saveBotToken, TOKEN_ENV, type TokenSource } from "./telegram.js";

export type ServeOptions = {
  store: Store;
  evidenceRoot: string;
  clock?: () => Date;
  /** Extra Host values this server answers as (a Tailscale name, a LAN ip:port). */
  allowedHosts?: readonly string[];
  /**
   * Where the Telegram bot token lives when set from here. Present = the
   * settings card renders; absent = no settings surface at all.
   */
  telegramTokenFile?: string;
};

const SESSION_COOKIE = "nightorders_session";
const BODY_CAP = 16 * 1024;
/** A cookie idles out after half a day and dies outright after a week. */
const SESSION_IDLE_MS = 12 * 60 * 60_000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;

type Session = {
  name: string;
  csrf: string;
  /** The approver generation at login: credential rotation kills the cookie. */
  generation: number;
  createdAt: number;
  lastSeen: number;
};

export function createDecisionServer(options: ServeOptions): Server {
  const { store, evidenceRoot } = options;
  const clock = options.clock ?? (() => new Date());
  const sessions = new Map<string, Session>();

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        respond(response, 500, "text/plain; charset=utf-8", "something broke");
      } else {
        response.end();
      }
    });
  });

  /** The names this server answers as. Anything else is a rebind, refused. */
  const allowedHost = (host: string | undefined): boolean => {
    if (host === undefined) return false;
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : null;
    const locals =
      port === null ? [] : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
    return [...locals, ...(options.allowedHosts ?? [])].includes(host);
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!allowedHost(request.headers.host)) {
      return respond(response, 421, "text/plain; charset=utf-8", "wrong host");
    }

    const url = new URL(request.url ?? "/", "http://placeholder");
    // A token in a URL is a token in history, logs, and referers. Refused
    // outright rather than ignored, so nobody learns the habit works.
    if (url.searchParams.has("token")) {
      return respond(response, 400, "text/plain; charset=utf-8", "credentials never travel in URLs");
    }

    store.expireOverdueDecisions(clock());

    const method = request.method ?? "GET";
    const who = identify(request);

    if (url.pathname === "/login" && method === "GET") {
      return page(response, 200, loginPage(null));
    }
    if (url.pathname === "/login" && method === "POST") {
      const body = await form(request);
      const name = first(body, "name");
      const token = first(body, "token");
      const authenticated =
        name !== null && token !== null ? authenticateApprover(store, name, token) : null;
      if (authenticated === null || !authenticated.ok) {
        return page(response, 403, loginPage("that is not an approver, or the token does not match"));
      }
      const id = randomBytes(32).toString("hex");
      sessions.set(id, {
        name: name as string,
        csrf: randomBytes(32).toString("hex"),
        generation: store.approverGeneration(name as string) ?? 1,
        createdAt: Date.now(),
        lastSeen: Date.now(),
      });
      response.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`,
      );
      return redirect(response, "/");
    }

    if (url.pathname === "/logout" && method === "POST") {
      const cookies = request.headers.cookie ?? "";
      const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`).exec(cookies);
      if (match !== null) sessions.delete(match[1] as string);
      response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return redirect(response, "/login");
    }

    if (who === null) {
      return method === "GET"
        ? redirect(response, "/login")
        : respond(response, 401, "text/plain; charset=utf-8", "authenticate first");
    }

    if (url.pathname === "/" && method === "GET") {
      return page(
        response,
        200,
        listPage(store.listDecisions("unanswered"), options.telegramTokenFile !== undefined),
      );
    }

    // The settings card: the Telegram bot token, settable from a phone. The
    // token is written to the same 0600 file the CLI writes — never echoed
    // back in full, never a database column, and POST-only behind the same
    // session + Origin + CSRF discipline as answering.
    if (url.pathname === "/settings" && method === "GET" && options.telegramTokenFile !== undefined) {
      const existing = loadBotToken({}, options.telegramTokenFile);
      const hasEnv = process.env[TOKEN_ENV] !== undefined && process.env[TOKEN_ENV] !== "";
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      return page(response, 200, settingsPage(existing, hasEnv, csrf, null));
    }
    if (url.pathname === "/settings/telegram-token" && method === "POST" && options.telegramTokenFile !== undefined) {
      if (who.via === "cookie") {
        const origin = request.headers.origin;
        if (typeof origin !== "string" || !allowedHost(origin.replace(/^https?:\/\//, ""))) {
          return respond(response, 403, "text/plain; charset=utf-8", "origin not allowed");
        }
      }
      const body = await form(request);
      if (who.via === "cookie" && first(body, "csrf") !== who.session.csrf) {
        return respond(response, 403, "text/plain; charset=utf-8", "stale form — reload and try again");
      }
      const value = first(body, "token") ?? "";
      const saved = saveBotToken(options.telegramTokenFile, value);
      if (!saved.ok) {
        const existing = loadBotToken({}, options.telegramTokenFile);
        const hasEnv = process.env[TOKEN_ENV] !== undefined && process.env[TOKEN_ENV] !== "";
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        return page(response, 400, settingsPage(existing, hasEnv, csrf, saved.message));
      }
      return redirect(response, "/settings");
    }

    const one = /^\/d\/(\d+)$/.exec(url.pathname);
    if (one !== null && method === "GET") {
      const decision = store.getDecision(Number(one[1]));
      if (decision === null) return respond(response, 404, "text/plain; charset=utf-8", "no such decision");
      const taskId = taskOf(store, decision);
      return page(response, 200, decisionPage(decision, taskId, store.evidenceFor(decision.id), who));
    }

    const answer = /^\/d\/(\d+)\/answer$/.exec(url.pathname);
    if (answer !== null && method === "POST") {
      // Cookie sessions prove Origin + nonce; Bearer requests carry no
      // cookie a hostile page could ride, so the ceremony proves nothing.
      if (who.via === "cookie") {
        const origin = request.headers.origin;
        if (typeof origin !== "string" || !allowedHost(origin.replace(/^https?:\/\//, ""))) {
          return respond(response, 403, "text/plain; charset=utf-8", "origin not allowed");
        }
      }
      const body = await form(request);
      if (who.via === "cookie" && first(body, "csrf") !== who.session.csrf) {
        return respond(response, 403, "text/plain; charset=utf-8", "stale form — reload and try again");
      }

      const id = Number(answer[1]);
      const decision = store.getDecision(id);
      if (decision === null) return respond(response, 404, "text/plain; charset=utf-8", "no such decision");
      const choice = first(body, "choice") ?? "";
      const chosen = decision.options.find(option => option.id === choice);
      // Irreversible options never ride one accidental tap: the form arms
      // them behind an explicit confirmation field, and the server checks —
      // the client rendering is convenience, this is the rule.
      if (chosen !== undefined && !chosen.reversible && first(body, "confirm") !== "yes") {
        return respond(response, 400, "text/plain; charset=utf-8", "an irreversible choice must be confirmed");
      }
      const note = first(body, "note");
      const answered = store.answerDecision(
        {
          id,
          choice,
          by: who.name,
          via: "web",
          ...(note === null || note === "" ? {} : { note }),
        },
        clock(),
      );
      if (!answered.ok) {
        const status = answered.reason === "bad-option" || answered.reason === "bad-note" ? 400 : 409;
        return respond(response, status, "text/plain; charset=utf-8", answered.reason);
      }
      return redirect(response, `/d/${id}`);
    }

    const artifact = /^\/d\/(\d+)\/evidence\/(\d+)$/.exec(url.pathname);
    if (artifact !== null && method === "GET") {
      return evidence(response, Number(artifact[1]), Number(artifact[2]));
    }

    return respond(response, 404, "text/plain; charset=utf-8", "nothing here");
  }

  function identify(
    request: IncomingMessage,
  ): { name: string; via: "cookie"; session: Session } | { name: string; via: "bearer" } | null {
    const bearer = /^Bearer (.+):(.+)$/.exec(request.headers.authorization ?? "");
    if (bearer !== null) {
      const authenticated = authenticateApprover(store, bearer[1] as string, bearer[2] as string);
      return authenticated.ok ? { name: bearer[1] as string, via: "bearer" } : null;
    }
    const cookies = request.headers.cookie ?? "";
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`).exec(cookies);
    if (match === null) return null;
    const session = lookupSession(match[1] as string);
    return session === null ? null : { name: session.name, via: "cookie", session };
  }

  /**
   * Constant-time against the session table, small as it is — and every hit
   * is re-proved against time and the approver's credential generation. A
   * rotated credential kills its cookies the same way it kills its Telegram
   * bindings: authority derived from the old secret does not outlive it.
   */
  function lookupSession(candidate: string): Session | null {
    const bytes = Buffer.from(candidate, "utf8");
    for (const [id, session] of sessions) {
      const stored = Buffer.from(id, "utf8");
      if (stored.length !== bytes.length || !timingSafeEqual(stored, bytes)) continue;
      const now = Date.now();
      if (now - session.lastSeen > SESSION_IDLE_MS || now - session.createdAt > SESSION_ABSOLUTE_MS) {
        sessions.delete(id);
        return null;
      }
      if (store.approverGeneration(session.name) !== session.generation) {
        sessions.delete(id);
        return null;
      }
      session.lastSeen = now;
      return session;
    }
    return null;
  }

  function evidence(response: ServerResponse, decisionId: number, artifactId: number): void {
    // Only through the decision's own relation — an artifact id from another
    // run simply is not in this list, whatever the URL claims.
    const linked = store.evidenceFor(decisionId).find(one => one.id === artifactId);
    if (linked === undefined) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such evidence");
    }
    // Verified on the very descriptor the bytes come from — a file that no
    // longer hashes to its record is not the evidence the decision showed,
    // and serving it would put unrecorded bytes under a recorded name.
    const read = readVerifiedArtifact(evidenceRoot, linked);
    if (!read.ok) {
      return respond(response, 410, "text/plain; charset=utf-8", "the evidence no longer matches its record");
    }
    response.writeHead(200, {
      ...SAFETY,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="evidence-${linked.id}.txt"`,
    });
    response.end(read.content);
  }

  return server;
}

// ---- rendering -------------------------------------------------------------

const SAFETY = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

function respond(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { ...SAFETY, "Content-Type": type });
  response.end(body);
}

function page(response: ServerResponse, status: number, html: string): void {
  respond(response, status, "text/html; charset=utf-8", html);
}

function redirect(response: ServerResponse, to: string): void {
  response.writeHead(303, { ...SAFETY, Location: to });
  response.end();
}

/** Every character that could open a tag or an attribute, dead at the sink. */
function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 17px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 1rem;
         max-width: 40rem; margin-inline: auto; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  .recap { opacity: .85; margin: .75rem 0; white-space: pre-wrap; }
  .question { font-size: 1.25rem; font-weight: 650; margin: 1rem 0; white-space: pre-wrap; }
  form.option { margin: .6rem 0; }
  button { display: block; width: 100%; padding: .9rem 1rem; font-size: 1.05rem;
           border-radius: .75rem; border: 1px solid #8884; cursor: pointer; text-align: left; }
  .recommended button { border: 2px solid #4a7; }
  .consequence { font-size: .9rem; opacity: .8; margin: .25rem 0 0; white-space: pre-wrap; }
  details { margin: .6rem 0; border: 1px dashed #b66; border-radius: .75rem; padding: .5rem; }
  summary { padding: .4rem; cursor: pointer; font-weight: 600; }
  .evidence { margin-top: 1.25rem; font-size: .9rem; }
  .evidence a { display: block; padding: .35rem 0; }
  input[type=text], input[type=password] { width: 100%; padding: .6rem; font-size: 1rem;
           margin: .3rem 0 .8rem; box-sizing: border-box; }
  .meta { font-size: .85rem; opacity: .7; }
  .answered { border: 1px solid #4a7; border-radius: .75rem; padding: .75rem; margin: 1rem 0; }
`;

function shell(title: string, body: string): string {
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escape(title)}</title><style>${STYLE}</style></head><body>`,
    body,
    "</body></html>",
  ].join("\n");
}

function loginPage(problem: string | null): string {
  return shell("night orders", [
    "<h1>night orders</h1>",
    problem === null ? "" : `<p class="meta">${escape(problem)}</p>`,
    `<form method="post" action="/login">`,
    `<label>who are you<input type="text" name="name" autocomplete="username"></label>`,
    `<label>approver token<input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">sign in</button>`,
    "</form>",
  ].join("\n"));
}

function listPage(decisions: (Decision & { taskId: string })[], settings: boolean): string {
  const rows =
    decisions.length === 0
      ? "<p>Nothing waits on you. The night parked no decisions.</p>"
      : decisions
          .map(
            decision =>
              `<p><a href="/d/${decision.id}">${escape(decision.taskId)} — ${escape(decision.question)}</a>` +
              `${decision.state === "expired" ? ' <strong>overdue</strong>' : ""}</p>`,
          )
          .join("\n");
  const footer = settings ? `<p class="meta"><a href="/settings">settings</a></p>` : "";
  return shell("decisions", `<h1>waiting on you</h1>\n${rows}\n${footer}`);
}

function settingsPage(
  existing: TokenSource | null,
  hasEnv: boolean,
  csrf: string,
  problem: string | null,
): string {
  const current =
    hasEnv
      ? `set in the environment (${escape(TOKEN_ENV)}) — that takes precedence over anything saved here`
      : existing === null
        ? "not set"
        : `saved: ${escape(redactToken(existing.token))} (bot ${escape(existing.botId)})`;
  return shell("settings", [
    "<h1>settings</h1>",
    "<h2>telegram bot token</h2>",
    `<p class="meta">current: ${current}</p>`,
    problem === null ? "" : `<p class="meta">${escape(problem)}</p>`,
    `<form method="post" action="/settings/telegram-token">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<label>token from @BotFather<input type="password" name="token" autocomplete="off"></label>`,
    `<button type="submit">save</button>`,
    "</form>",
    `<p class="meta">Written owner-only beside the database. Then pair your chat:`,
    ` <code>nightorders bridge telegram pair --as you --token …</code> and send the code to your bot.</p>`,
    `<p class="meta"><a href="/">← everything waiting</a></p>`,
  ].join("\n"));
}

function decisionPage(
  decision: Decision,
  taskId: string,
  artifacts: Artifact[],
  who: { via: "cookie"; session: Session } | { via: "bearer" } | { name: string; via: string },
): string {
  const csrf = "session" in who ? (who as { session: Session }).session.csrf : "";
  const options = decision.options
    .map(option => {
      const marks = [
        option.id === decision.recommendation ? "recommended" : "",
        option.reversible ? "" : "irreversible",
      ]
        .filter(mark => mark !== "")
        .join(" · ");
      const inner = [
        `<form class="option" method="post" action="/d/${decision.id}/answer">`,
        `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
        `<input type="hidden" name="choice" value="${escape(option.id)}">`,
        ...(option.reversible ? [] : [`<input type="hidden" name="confirm" value="yes">`]),
        `<button type="submit">${escape(option.label)}${marks === "" ? "" : ` <span class="meta">(${escape(marks)})</span>`}</button>`,
        `<p class="consequence">${escape(option.consequence)}</p>`,
        `<input type="text" name="note" placeholder="optional note — travels with this answer">`,
        `</form>`,
      ].join("\n");
      // An irreversible option hides its button behind one deliberate extra
      // tap — no script, just <details>. The server independently requires
      // the confirm field either way.
      return option.reversible
        ? inner
        : `<details><summary>${escape(option.label)} — irreversible, tap to arm</summary>${inner}</details>`;
    })
    .join("\n");

  const answered =
    decision.state === "answered"
      ? `<div class="answered">Answered: <strong>${escape(decision.choice ?? "")}</strong> by ${escape(
          decision.answeredBy ?? "",
        )}${decision.note === null ? "" : ` — ${escape(decision.note)}`}</div>`
      : "";

  const evidence =
    artifacts.length === 0
      ? ""
      : `<div class="evidence"><strong>evidence</strong>` +
        artifacts
          .map(
            artifact =>
              `<a href="/d/${decision.id}/evidence/${artifact.id}">${escape(artifact.kind)}` +
              `${artifact.truncated ? " (truncated)" : ""} · ${artifact.bytesStored} bytes</a>`,
          )
          .join("\n") +
        "</div>";

  return shell(`${taskId}`, [
    `<h1>${escape(taskId)} <span class="meta">${escape(decision.state)}${
      decision.deadline === null ? "" : ` · deadline ${escape(decision.deadline)}`
    }</span></h1>`,
    `<div class="recap">${escape(decision.recap)}</div>`,
    `<div class="question">${escape(decision.question)}</div>`,
    decision.state === "answered" ? answered : options,
    evidence,
    `<p class="meta"><a href="/">← everything waiting</a></p>`,
  ].join("\n"));
}

function taskOf(store: Store, decision: Decision): string {
  const run = store.getRun(decision.run);
  return run === null ? "?" : store.externalIdFor(run.taskRef) ?? "?";
}

// ---- request plumbing ------------------------------------------------------

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > BODY_CAP) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function first(body: URLSearchParams, name: string): string | null {
  return body.get(name);
}
