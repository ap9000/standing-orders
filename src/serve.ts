/**
 * The web console (§7, grown per the console review): the whole built-in
 * queue, visible and operable from a phone. `nightorders serve` — node:http,
 * no dependencies, no JavaScript in the page. TLS is a proxy's job and the
 * docs say so; what is not delegated is everything else:
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
 * it answers as. Cookie-authenticated mutations additionally pass one
 * centralized gate — `authorizeMutation` — that proves content type, an
 * allowed Origin, and the per-session CSRF nonce, and refuses duplicated
 * security fields; a mutation route cannot forget a check it never wrote.
 * Bearer mutations carry no cookie for a hostile page to ride, so they skip
 * the cookie ceremony and nothing else.
 *
 * **Approval is step-up.** A session alone never approves a scope: the
 * approval form restates the goal, the exclusions, and the touches — the
 * three fields the digest binds — and requires the approver token typed
 * again, plus (for browsers) a single-use nonce minted when the form was
 * rendered, bound server-side to who saw which digest of which task. A
 * stolen cookie can read; it cannot agree to work.
 *
 * **GET never mutates.** Overdue-ness is derived at render time from the
 * deadline on the row; the durable expiry sweep belongs to the CLI's
 * surfaces and the loop, not to a crawler hitting a page.
 *
 * **Everything rendered is escaped at the sink**, and every identifier in an
 * href is URL-encoded first — HTML escaping does not make `a/b?x=1` a valid
 * path segment. The CSP is belt to those suspenders.
 *
 * **Evidence goes through one verified reader** (`readVerifiedArtifact`) and
 * membership is enforced by the lookup — a decision serves only its linked
 * artifacts, a run only its own rows, and when this server was scoped to a
 * repo, only runs whose task belongs to that repo (or to no repo yet).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readVerifiedArtifact } from "./evidence.js";
import {
  type Artifact,
  type Capability,
  type Decision,
  type Hold,
  type Incident,
  type Run,
  type Store,
  type Task,
  type TaskState,
  type WorktreeRow,
} from "./store.js";
import {
  approvalOf,
  approve as approveScope,
  authenticateApprover,
  proposeGuarded,
  type Scope,
} from "./scope.js";
import { hasForbiddenControls } from "./decision.js";
import type { Runner } from "./runner.js";
import { computeGaps, describeCapability, type Gap } from "./gaps.js";
import {
  authorizedProject,
  canonicalProject,
  isGitRepo,
  projectName,
  sameRepo,
  resolveCeiling,
  rowVisible,
} from "./project.js";
import { tally, spendLine } from "./summary.js";
import { classify } from "./board.js";
import type { BoardCard } from "./board.js";
import { approveRoutine, describeSchedule, fireRoutine, parseSchedule } from "./routine.js";
import type { Routine } from "./store.js";
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
  /**
   * The repo this console serves. Scopes run evidence to that repo's tasks
   * (and unplaced ones) and turns on the gaps and capabilities views —
   * without it those pages say so instead of guessing.
   */
  repo?: string;
  /**
   * The full authorization ceiling (v2 review, finding 1): `repos` this
   * server may show and operate on, plus `projectRoots` under which any git
   * repository qualifies. `repo` above is sugar for one entry in `repos`.
   * No configuration at all is the legacy unscoped mode — everything
   * visible, and stated as such where the code decides.
   */
  repos?: readonly string[];
  projectRoots?: readonly string[];
};

const SESSION_COOKIE = "nightorders_session";
const BODY_CAP = 16 * 1024;
/** A cookie idles out after half a day and dies outright after a week. */
const SESSION_IDLE_MS = 12 * 60 * 60_000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
/** An approval nonce is a rendered form, not a standing right — it ages out fast. */
const NONCE_TTL_MS = 15 * 60_000;
const NONCE_CAP = 500;
const RUNS_PAGE = 50;

const TASK_STATES: readonly TaskState[] = ["queued", "running", "done", "failed", "cancelled"];

type Session = {
  name: string;
  csrf: string;
  /** The approver generation at login: credential rotation kills the cookie. */
  generation: number;
  createdAt: number;
  lastSeen: number;
  /** The open project — a VIEW FILTER chosen inside the ceiling, never authorization. */
  project: string | null;
  /** Bumped on every open: stale tabs carry the revision they were rendered under. */
  projectRevision: number;
};

/** One rendered approval form: who saw which digest of which task, once. */
type ApprovalNonce = {
  name: string;
  taskId: string;
  digest: string;
  expiresAt: number;
};

type Who = { name: string; via: "cookie"; session: Session } | { name: string; via: "bearer" };

export function createDecisionServer(options: ServeOptions): Server {
  const { store, evidenceRoot } = options;
  const clock = options.clock ?? (() => new Date());
  const sessions = new Map<string, Session>();
  const approvalNonces = new Map<string, ApprovalNonce>();

  // The ceiling, resolved once at startup. Paths that do not exist are
  // dropped here rather than silently failing every later check.
  const { ceiling } = resolveCeiling(
    [...(options.repo === undefined ? [] : [options.repo]), ...(options.repos ?? [])],
    options.projectRoots ?? [],
  );
  /** The project every fresh session opens with: the sole configured repo, else none. */
  const defaultProject = ceiling.repos.length === 1 && ceiling.roots.length === 0 ? ceiling.repos[0] as string : null;

  /** No ceiling configured at all: the legacy trust-everything mode, named. */
  const unscopedMode = ceiling.repos.length === 0 && ceiling.roots.length === 0;
  /** Per-row visibility under the ceiling — the authorization question for reads. */
  const visible = (repo: string | null): boolean => rowVisible(ceiling, repo);
  /** The task behind a resource, for the ceiling check; null = no ref (visible). */
  const taskRepoOf = (taskRef: number): string | null => store.refForId(taskRef)?.repo ?? null;

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (process.env["NIGHTORDERS_SERVE_DEBUG"] === "1") console.error("SERVE ERROR:", error);
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

  /**
   * The one gate every POST passes — parse elsewhere, authorize here. A
   * refusal names its status; null means proceed. Duplicated security fields
   * are refused outright: two `csrf` values in one body is not a preference,
   * it is a smuggling attempt.
   */
  function authorizeMutation(
    request: IncomingMessage,
    who: Who,
    body: URLSearchParams,
  ): { status: number; message: string } | null {
    const type = request.headers["content-type"] ?? "";
    if (!type.startsWith("application/x-www-form-urlencoded")) {
      return { status: 415, message: "forms only" };
    }
    for (const field of ["csrf", "token", "digest", "nonce", "confirm"]) {
      if (body.getAll(field).length > 1) {
        return { status: 400, message: `duplicated ${field} field` };
      }
    }
    if (who.via === "cookie") {
      const origin = request.headers.origin;
      if (typeof origin !== "string" || !allowedHost(origin.replace(/^https?:\/\//, ""))) {
        return { status: 403, message: "origin not allowed" };
      }
      if (body.get("csrf") !== who.session.csrf) {
        return { status: 403, message: "stale form — reload and try again" };
      }
    }
    return null;
  }

  function mintApprovalNonce(name: string, taskId: string, digest: string): string {
    const nonce = randomBytes(16).toString("hex");
    if (approvalNonces.size >= NONCE_CAP) {
      const oldest = approvalNonces.keys().next().value;
      if (oldest !== undefined) approvalNonces.delete(oldest);
    }
    approvalNonces.set(nonce, { name, taskId, digest, expiresAt: Date.now() + NONCE_TTL_MS });
    return nonce;
  }

  /** Single use, bound to who saw which digest of which task, and young. */
  function consumeApprovalNonce(nonce: string, name: string, taskId: string, digest: string): boolean {
    const held = approvalNonces.get(nonce);
    if (held === undefined) return false;
    approvalNonces.delete(nonce);
    return (
      held.name === name &&
      held.taskId === taskId &&
      held.digest === digest &&
      held.expiresAt >= Date.now()
    );
  }

  /**
   * The project a request views through — cookie sessions carry their open
   * project; bearer callers may name one per request, constrained by the
   * ceiling. Returns undefined when a named project is outside the ceiling:
   * that is a refusal, not a fallback.
   */
  function projectOf(who: Who, request: IncomingMessage): string | null | undefined {
    if (who.via === "cookie") return who.session.project;
    const header = request.headers["x-nightorders-project"];
    if (header === undefined) return defaultProject;
    if (Array.isArray(header)) return undefined;
    const canonical = canonicalProject(header);
    if (canonical === null || !visible(canonical)) return undefined;
    return canonical;
  }

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

    const method = request.method ?? "GET";
    // A fragment poll is the page keeping itself fresh, not a person acting.
    // It authenticates like any request but must not count as activity —
    // otherwise a board left open on a wall keeps its session alive forever
    // (Codex board review, finding 4).
    const touch = !(method === "GET" && url.searchParams.get("fragment") === "1");
    const who = identify(request, touch);

    if (url.pathname === "/login" && method === "GET") {
      return page(response, 200, loginPage(null));
    }
    if (url.pathname === "/login" && method === "POST") {
      const body = await form(request);
      const name = body.get("name");
      const token = body.get("token");
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
        project: defaultProject,
        projectRevision: 1,
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

    if (method === "GET") return handleGet(url, who, request, response);
    if (method === "POST") return handlePost(url, who, request, response);
    return respond(response, 405, "text/plain; charset=utf-8", "no such method here");
  }

  // ---- reads ---------------------------------------------------------------

  function handleGet(url: URL, who: Who, request: IncomingMessage, response: ServerResponse): void {
    const now = clock();
    const project = projectOf(who, request);
    if (project === undefined) {
      return refuse(response, who, 403, "that project is outside what this server was configured to show");
    }

    // Nothing open and more than one thing to choose: land on the opener.
    // Decisions and their evidence stay reachable — answering must never be
    // blocked by project state — and the opener itself must not loop.
    const needsProject =
      who.via === "cookie" && project === null && !unscopedMode &&
      !url.pathname.startsWith("/d/") && url.pathname !== "/projects" &&
      url.pathname !== "/settings" && url.pathname !== "/logout" &&
      !(url.pathname === "/board" && url.searchParams.get("scope") === "all");
    if (needsProject) return redirect(response, "/projects");

    if (url.pathname === "/projects") {
      return void projectsScreen(response, who, null, 200);
    }

    if (url.pathname === "/") {
      return page(
        response,
        200,
        inboxPage(chromeFor(project, "inbox"), {
          csrf: who.via === "cookie" ? who.session.csrf : "",
          decisions: store.listDecisionsScoped(project).slice(0, 10),
          approvals: store.scopesAwaitingApproval(project, 10),
          requeueables: store.listRequeueablesScoped(project, now, 10),
          cancelledBlockers: store.listCancelledBlockersScoped(project, 10),
          gaps: project === null ? [] : computeGaps(store, project, now).filter(gap => gap.unblocks.length > 0).slice(0, 10),
          now,
        }),
      );
    }

    // The board's old name; bookmarks keep working. A GET-only alias, so a
    // plain 302 — never the shared 303 helper, which belongs to POST landings.
    if (url.pathname === "/morning") {
      response.writeHead(302, { ...SAFETY, Location: "/activity" });
      response.end();
      return;
    }

    if (url.pathname === "/board") {
      // scope=all is the rolled-up view: every project this server was
      // allowed to serve, on one board. The ceiling still rules row by row
      // (rowVisible, the same predicate as every list) — a repo outside
      // the server's configuration never renders a card, whatever the
      // database holds. Unplaced work (repo NULL) appears: it dispatches
      // anywhere, so every board honestly owns it.
      const all = url.searchParams.get("scope") === "all";
      // Roll-up admission happens BEFORE the query limit when the ceiling
      // is an enumerable repo list — unauthorized rows must not consume
      // the page (Codex round 2, finding 11). Root-based ceilings cannot
      // be enumerated into SQL; they keep the post-filter alone.
      const admission =
        all && ceiling.roots.length === 0 && ceiling.repos.length > 0 ? [...ceiling.repos] : null;
      const snapshot = store.boardScoped(all ? null : project, now, 200, admission);
      const admitted = all
        ? snapshot.tasks.filter(facts => facts.repo === null || visible(facts.repo))
        : snapshot.tasks;
      const done = all
        ? snapshot.done.filter(row => row.repo === null || visible(row.repo))
        : snapshot.done;
      // A blocker may live in a repo this server must not speak about —
      // redact its state before the pure classifier composes a sentence
      // from it (Codex round 2, finding 12). The dependency's NAME stays:
      // the edge belongs to the visible task; the other project's live
      // status does not.
      const cards = admitted.map(facts =>
        classify(
          facts.blockerRepo !== null && !visible(facts.blockerRepo)
            ? { ...facts, blockerState: null }
            : facts,
          now,
        ),
      );
      const buildingCount = cards.filter(card => card.lane === "building").length;
      // Instances belong to their track row, not the main lanes — the board
      // is for one-off work; tracks are the heartbeat. The one exception is
      // attention: anything needing a person surfaces, wearing its routine.
      const laneCards = cards.filter(card => card.routineName === null || card.lane === "attention");
      const tracks = store
        .routineTracks(all ? null : project, now, admission)
        .filter(track => visible(track.routine.repo));
      const body = boardBody(
        { cards: laneCards, tracks, done, saturated: snapshot.saturated, now, all, project },
        pr => store.ciFailureObserved(pr),
      );
      if (url.searchParams.get("fragment") === "1") {
        // The live region alone — the in-page swapper's diet. Same auth,
        // same ceiling, no shell.
        return respond(response, 200, "text/html; charset=utf-8", body);
      }
      const nonce = randomBytes(16).toString("base64");
      return page(
        response,
        200,
        shell("board", body, {
          chrome: chromeFor(project, "board"),
          live: { everySeconds: buildingCount > 0 ? 10 : 30, nonce },
        }),
        nonce,
      );
    }

    if (url.pathname === "/activity") {
      const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
      return page(
        response,
        200,
        homePage(chromeFor(project, "activity"), {
          csrf: who.via === "cookie" ? who.session.csrf : "",
          taskCount: store.listTasksScoped(project, undefined, 1, null).length,
          repo: project,
          summary: tally(store.runsSinceScoped(since, project)),
          decisions: store.listDecisionsScoped(project),
          incidents: store.openIncidents(project),
          stranded: store.strandedTasks(project),
          gaps: project === null ? null : computeGaps(store, project, now),
          outboxPending: store.listNotifications("pending").length,
          settings: options.telegramTokenFile !== undefined,
          building: store.liveClaims(project, now),
          runners: store.listRunners(),
          worktrees: store
            .listWorktrees()
            .filter(one => project === null || sameRepo(one.repo, project)),
          episode: project === null ? null : store.latestWatchEpisode(project),
          now,
        }),
      );
    }

    if (url.pathname === "/done") {
      return page(
        response,
        200,
        donePage(chromeFor(project, "done"), store.listCompletedWorkScoped(project, 50), pr => store.ciFailureObserved(pr)),
      );
    }

    if (url.pathname === "/system") {
      const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
      void since;
      return page(
        response,
        200,
        systemPage(chromeFor(project, "system"), {
          building: store.liveClaims(project, now),
          runners: store.listRunners(),
          worktrees: store.listWorktrees().filter(one => project === null || sameRepo(one.repo, project)),
          episode: project === null ? null : store.latestWatchEpisode(project),
          outboxPending: store.listNotifications("pending").length,
          now,
        }),
      );
    }

    if (url.pathname === "/tasks") {
      const wanted = url.searchParams.get("state");
      if (wanted !== null && !TASK_STATES.includes(wanted as TaskState)) {
        return refuse(response, who, 400, "no such state", "/tasks");
      }
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      return page(
        response,
        200,
        tasksPage(
          chromeFor(project, "tasks"),
          store.listTasksScoped(project, wanted === null ? undefined : (wanted as TaskState), 200, null),
          wanted as TaskState | null,
          csrf,
          null,
          project,
        ),
      );
    }

    if (url.pathname === "/tasks/new") {
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const revision = who.via === "cookie" ? who.session.projectRevision : 0;
      return page(response, 200, newTaskPage(chromeFor(project, "tasks"), project, csrf, revision, null));
    }

    const task = matchTaskPath(url.pathname, "");
    if (task !== null) {
      return taskScreen(response, who, task.taskId, null, 200);
    }

    if (url.pathname === "/runs") {
      const raw = url.searchParams.get("before");
      let before: number | null = null;
      if (raw !== null) {
        if (!/^[1-9][0-9]{0,14}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
          return refuse(response, who, 400, "that cursor is not a page", "/runs");
        }
        before = Number(raw);
      }
      const rows = store.listRunsBefore(before, RUNS_PAGE, project);
      return page(response, 200, runsPage(chromeFor(project, "runs"), rows, rows.length === RUNS_PAGE ? rows[rows.length - 1]?.id ?? null : null));
    }

    const run = /^\/r\/([0-9]{1,15})$/.exec(url.pathname);
    if (run !== null) {
      const found = store.getRun(Number(run[1]));
      if (found === null || !runVisible(found)) {
        return refuse(response, who, 404, "no such run", "/runs");
      }
      const taskId = store.externalIdFor(found.taskRef) ?? "?";
      return page(
        response,
        200,
        runPage(chromeFor(project, "runs", runListPane(project, found.id)), found, taskId, store.artifactsFor(found.id)),
      );
    }

    const runArtifact = /^\/r\/([0-9]{1,15})\/evidence\/([0-9]{1,15})$/.exec(url.pathname);
    if (runArtifact !== null) {
      return runEvidence(response, Number(runArtifact[1]), Number(runArtifact[2]));
    }

    if (url.pathname === "/caps") {
      if (project === null) {
        return page(response, 200, capsPage(chromeFor(project, "caps"), null, [], ""));
      }
      return page(
        response,
        200,
        capsPage(chromeFor(project, "caps"), store.listCapabilities(project), computeGaps(store, project, now), project, now),
      );
    }

    if (url.pathname === "/routines") {
      // The ceiling row by row, exactly as everywhere: a routine placed in
      // a repo this server may not serve does not exist here.
      const tracks = store
        .routineTracks(project, now)
        .filter(track => visible(track.routine.repo));
      return page(response, 200, routinesPage(chromeFor(project, "routines"), tracks, now));
    }

    const routineScreen = /^\/routines\/([0-9]{1,15})$/.exec(url.pathname);
    if (routineScreen !== null) {
      const routine = store.getRoutine(Number(routineScreen[1]));
      if (routine === null || !visible(routine.repo)) {
        return refuse(response, who, 404, "no such routine", "/routines");
      }
      return routinePage(response, who, routine.id, null, 200);
    }

    if (url.pathname === "/settings" && options.telegramTokenFile !== undefined) {
      const existing = loadBotToken({}, options.telegramTokenFile);
      const hasEnv = process.env[TOKEN_ENV] !== undefined && process.env[TOKEN_ENV] !== "";
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      return page(response, 200, settingsPage(chromeFor(project, "settings"), existing, hasEnv, csrf, null));
    }

    const one = /^\/d\/([0-9]{1,15})$/.exec(url.pathname);
    if (one !== null) {
      const decision = store.getDecision(Number(one[1]));
      if (decision === null) return refuse(response, who, 404, "no such decision");
      const run = store.getRun(decision.run);
      if (run !== null && !visible(taskRepoOf(run.taskRef))) {
        return refuse(response, who, 404, "no such decision");
      }
      const taskId = taskOf(store, decision);
      return page(response, 200, decisionPage(chromeFor(project, "none"), decision, taskId, store.evidenceFor(decision.id), who, now));
    }

    const artifact = /^\/d\/([0-9]{1,15})\/evidence\/([0-9]{1,15})$/.exec(url.pathname);
    if (artifact !== null) {
      return decisionEvidence(response, Number(artifact[1]), Number(artifact[2]));
    }

    return respond(response, 404, "text/plain; charset=utf-8", "nothing here");
  }

  /** The badge cache: five seconds per project — mutations invalidate it. */
  const badgeCache = new Map<string, { at: number; count: number; saturated: boolean }>();
  const bustBadge = (): void => badgeCache.clear();

  /** The sidebar's facts for this request. */
  function chromeFor(
    project: string | null,
    active: Chrome["active"],
    listPane?: string,
  ): Chrome {
    const key = project ?? "";
    const cached = badgeCache.get(key);
    let badge = cached;
    if (badge === undefined || Date.now() - badge.at > 5_000) {
      const counted = store.countInboxScoped(project, clock());
      badge = { at: Date.now(), count: counted.count, saturated: counted.saturated };
      badgeCache.set(key, badge);
    }
    return {
      active,
      project,
      inboxCount: badge.count,
      inboxSaturated: badge.saturated,
      settings: options.telegramTokenFile !== undefined,
      ...(listPane === undefined ? {} : { listPane }),
    };
  }

  /** The compact task list for the master pane, the current row marked. */
  function taskListPane(project: string | null, currentId: string | null): string {
    const rows = store.listTasksScoped(project, undefined, 100, currentId);
    const items = rows
      .map(
        task =>
          `<a class="item${task.id === currentId ? " current" : ""}" href="${taskHref(task.id)}">` +
          `<span class="t">${escape(task.title)}</span>` +
          `<span class="m"><span class="mono">${escape(task.id)}</span>` +
          `<span class="badge badge-${escape(task.state)}">${escape(task.state)}</span></span></a>`,
      )
      .join("\n");
    return `<h2>tasks</h2>\n${items === "" ? `<p class="meta">none yet</p>` : items}`;
  }

  /** The compact recent-runs list for the master pane. */
  function runListPane(project: string | null, currentId: number | null): string {
    const rows = store.listRunsBefore(null, 50, project);
    const items = rows
      .map(
        run =>
          `<a class="item${run.id === currentId ? " current" : ""}" href="/r/${run.id}">` +
          `<span class="t">#${run.id} \u00b7 ${escape(run.taskId)}</span>` +
          `<span class="m"><span class="badge badge-${escape(run.outcome ?? "cut")}">${escape(run.outcome ?? "never finished")}</span>` +
          `<span class="mono">${escape(when(run.startedAt))}</span></span></a>`,
      )
      .join("\n");
    return `<h2>builds</h2>\n${items === "" ? `<p class="meta">none yet</p>` : items}`;
  }

  /**
   * The opener: every project inside the ceiling, most recently opened
   * first, plus repos the queue has seen — shown only when the ceiling
   * admits them — and an open-by-path field validated server-side. A
   * registry row never confers access; this page only offers what the
   * server was configured to allow.
   */
  async function projectsScreen(
    response: ServerResponse,
    who: Who,
    problem: string | null,
    status: number,
  ): Promise<void> {
    const recent = store.listProjects().filter(one => visible(one.path));
    const recentPaths = new Set(recent.map(one => one.path));
    const candidates = new Set<string>();
    for (const path of [...ceiling.repos, ...store.knownRepos()]) {
      const canonical = canonicalProject(path) ?? path;
      if (!recentPaths.has(canonical) && visible(canonical)) candidates.add(canonical);
    }
    const open = who.via === "cookie" ? who.session.project : null;
    const csrf = who.via === "cookie" ? who.session.csrf : "";
    return page(
      response,
      status,
      projectsPage(chromeFor(open, "projects"), recent, [...candidates], open, csrf, problem, unscopedMode),
    );
  }

  /** The task screen, shared by the GET and by every refusal that re-renders it. */
  function taskScreen(
    response: ServerResponse,
    who: Who,
    taskId: string,
    problem: string | null,
    status: number,
  ): void {
    const found = store.getTask(taskId);
    if (found === null) return respond(response, 404, "text/plain; charset=utf-8", "no such task");
    const ref = store.lookupRef(taskId);
    if (ref !== null && !visible(ref.repo)) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such task");
    }
    const now = clock();
    const scope = store.getScope(taskId);
    // The nonce is minted at render, per viewer, bound to the digest being
    // shown — the browser approval flow starts here and nowhere else.
    const nonce =
      who.via === "cookie" && scope !== null && !approvalOf(scope).approved
        ? mintApprovalNonce(who.name, taskId, scope.digest)
        : "";
    const paneProject = who.via === "cookie" ? who.session.project : null;
    return page(
      response,
      status,
      taskPage(chromeFor(paneProject, "tasks", taskListPane(paneProject, taskId)), {
        task: found,
        strikes: ref?.strikes ?? 0,
        plan: ref?.plan ?? null,
        planDocument: ref === null ? null : planDocumentOf(ref.id),
        repo: ref?.repo ?? null,
        holds: ref === null ? [] : store.activeHolds(ref.id, now),
        claimed: ref === null ? false : store.hasLiveClaim(ref.id, now),
        scope,
        runs: ref === null ? [] : store.runsFor(ref.id),
        decisions: ref === null ? [] : store.decisionsForTask(ref.id),
        incidents: ref === null ? [] : store.incidentsForTask(ref.id),
        csrf: who.via === "cookie" ? who.session.csrf : "",
        nonce,
        problem,
        now,
      }),
    );
  }

  /** The routine screen: the standing order restated, its verbs, its ledger. */
  function routinePage(
    response: ServerResponse,
    who: Who,
    routineId: number,
    problem: string | null,
    status: number,
  ): void {
    const routine = store.getRoutine(routineId);
    if (routine === null || !visible(routine.repo)) {
      return refuse(response, who, 404, "no such routine", "/routines");
    }
    const approved = routine.approvedAt !== null && routine.approvedDigest === routine.digest;
    // Same rule as scope approval: the nonce exists only where the exact
    // terms are restated, bound to who saw which digest of which order.
    const nonce =
      who.via === "cookie" && !approved
        ? mintApprovalNonce(who.name, `routine:${routine.id}`, routine.digest)
        : "";
    const paneProject = who.via === "cookie" ? who.session.project : null;
    return page(
      response,
      status,
      routineScreenPage(chromeFor(paneProject, "routines"), {
        routine,
        fires: store.routineFires(routine.id, 14),
        spend: store.routineSpend(routine.id, new Date(clock().getTime() - 7 * 24 * 60 * 60_000).toISOString()),
        blocker: store.routineBlocker(routine.id, clock()),
        csrf: who.via === "cookie" ? who.session.csrf : "",
        nonce,
        problem,
        now: clock(),
      }),
    );
  }

  /**
   * Routine verbs. The ceiling check is independent of authorizeMutation
   * (Codex round 2, finding 7): the routine's repository is resolved
   * server-side and proved against this server's configuration before any
   * verb runs, whatever the request named.
   */
  function routineMutation(
    response: ServerResponse,
    who: Who,
    routineId: number,
    verb: string,
    body: URLSearchParams,
    now: Date,
  ): void {
    const routine = store.getRoutine(routineId);
    if (routine === null || !visible(routine.repo)) {
      return refuse(response, who, 404, "no such routine", "/routines");
    }

    switch (verb) {
      case "approve": {
        // Step-up, identical to a scope's: the session got you here; only
        // the password agrees. The digest names what was seen.
        const digest = body.get("digest") ?? "";
        const token = body.get("token") ?? "";
        if (who.via === "cookie") {
          const nonce = body.get("nonce") ?? "";
          if (!consumeApprovalNonce(nonce, who.name, `routine:${routine.id}`, digest)) {
            return routinePage(response, who, routineId, "that approval form is stale — read it again", 409);
          }
        }
        if (token === "") {
          return routinePage(response, who, routineId, "approval requires your password, typed again", 400);
        }
        const approved = approveRoutine(store, routineId, who.name, now, digest, token);
        if (!approved.ok) {
          const status = approved.reason === "changed" ? 409 : 403;
          return routinePage(response, who, routineId, `not approved: ${approved.reason}`, status);
        }
        return redirect(response, `/routines/${routineId}`);
      }
      case "pause":
      case "resume": {
        store.setRoutinePaused(routineId, verb === "pause", now);
        return redirect(response, `/routines/${routineId}`);
      }
      case "run-now": {
        // Step-up (Codex Phase C review, M3): run-now is spend outside the
        // approved schedule, so a session alone cannot ask for it — the
        // password is typed again, like an approval. A bearer caller
        // re-proved its credential on this very request.
        if (who.via === "cookie") {
          const token = body.get("token") ?? "";
          if (token === "") {
            return routinePage(response, who, routineId, "run now requires your password, typed again", 400);
          }
          const authenticated = authenticateApprover(store, who.name, token);
          if (!authenticated.ok) {
            return routinePage(response, who, routineId, "that is not your password", 403);
          }
        }
        const outcome = fireRoutine(store, routineId, now, { manual: true });
        if (!outcome.ok) {
          return routinePage(response, who, routineId, `not fired: ${outcome.detail ?? outcome.reason}`, 409);
        }
        return redirect(response, `/routines/${routineId}`);
      }
      default:
        return respond(response, 404, "text/plain; charset=utf-8", "nothing here");
    }
  }

  // ---- mutations -----------------------------------------------------------

  async function handlePost(
    url: URL,
    who: Who,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await form(request);
    const denied = authorizeMutation(request, who, body);
    if (denied !== null) return refuse(response, who, denied.status, denied.message);
    const now = clock();
    // Any accepted mutation may change what the inbox owes; the badge
    // re-counts within five seconds either way, this just makes it exact.
    bustBadge();

    if (url.pathname === "/settings/telegram-token" && options.telegramTokenFile !== undefined) {
      const value = body.get("token") ?? "";
      const saved = saveBotToken(options.telegramTokenFile, value);
      if (!saved.ok) {
        const existing = loadBotToken({}, options.telegramTokenFile);
        const hasEnv = process.env[TOKEN_ENV] !== undefined && process.env[TOKEN_ENV] !== "";
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        return page(response, 400, settingsPage(chromeFor(who.via === "cookie" ? who.session.project : defaultProject, "settings"), existing, hasEnv, csrf, saved.message));
      }
      return redirect(response, "/settings");
    }

    if (url.pathname === "/projects/open") {
      // Sessions only: a bearer caller names its project per request and has
      // no session to mutate — refusing here keeps that boundary legible.
      if (who.via !== "cookie") {
        return refuse(response, who, 403, "opening a project is a browser session's act");
      }
      const asked = (body.get("path") ?? "").trim();
      const canonical = asked === "" ? null : canonicalProject(asked);
      if (canonical === null) {
        return void projectsScreen(response, who, "that path does not exist on this server", 400);
      }
      // Authorization is the ceiling, then the path must actually be a git
      // repository — validation with direct argv and a bound, never a shell.
      // Both checks apply even to configured repos: naming a directory in
      // config authorizes it; only being a repository makes it openable.
      if (!(await authorizedProject(ceiling, canonical))) {
        return void projectsScreen(response, who, "that path is outside what this server was configured to serve", 403);
      }
      if (!(await isGitRepo(canonical))) {
        return void projectsScreen(response, who, "that path is not a git repository", 400);
      }
      store.upsertProject(canonical, projectName(canonical), now);
      who.session.project = canonical;
      who.session.projectRevision++;
      return redirect(response, "/");
    }

    if (url.pathname === "/tasks/add") {
      const project = projectOf(who, request);
      if (project === undefined) {
        return refuse(response, who, 403, "that project is outside what this server was configured to show");
      }
      // Stale-tab guard: a form rendered under one open project must not
      // create into a different one switched-to since (finding 6).
      if (who.via === "cookie") {
        const seen = body.get("projectRevision");
        if (seen !== null && seen !== String(who.session.projectRevision)) {
          return refuse(response, who, 409, "the open project changed since this form was rendered — reload and try again", "/tasks");
        }
      }
      const id = (body.get("id") ?? "").trim();
      const title = body.get("title") ?? "";
      const repo = (body.get("repo") ?? "").trim() || (project ?? "");
      const goal = (body.get("goal") ?? "").trim();
      const made = store.createConsoleTask(
        { ...(id === "" ? {} : { id }), title, ...(repo === "" ? {} : { repo }), ...(goal === "" ? {} : { goal }) },
        now,
      );
      if (!made.ok) {
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        return page(
          response,
          made.reason === "backlog-full" ? 429 : 400,
          tasksPage(chromeFor(project, "tasks"), store.listTasksScoped(project, undefined, 200, null), null, csrf, made.reason, project),
        );
      }
      return redirect(response, taskHref(made.id));
    }

    const answer = /^\/d\/([0-9]{1,15})\/answer$/.exec(url.pathname);
    if (answer !== null) {
      const id = Number(answer[1]);
      const decision = store.getDecision(id);
      if (decision === null) return refuse(response, who, 404, "no such decision");
      const answeringRun = store.getRun(decision.run);
      if (answeringRun !== null && !visible(taskRepoOf(answeringRun.taskRef))) {
        return refuse(response, who, 404, "no such decision");
      }
      const choice = body.get("choice") ?? "";
      const chosen = decision.options.find(option => option.id === choice);
      // Irreversible options never ride one accidental tap: the form arms
      // them behind an explicit confirmation field, and the server checks —
      // the client rendering is convenience, this is the rule.
      if (chosen !== undefined && !chosen.reversible && body.get("confirm") !== "yes") {
        return refuse(response, who, 400, "an irreversible choice must be confirmed", `/d/${id}`);
      }
      const note = body.get("note");
      const answered = store.answerDecision(
        {
          id,
          choice,
          by: who.name,
          via: "web",
          ...(note === null || note === "" ? {} : { note }),
        },
        now,
      );
      if (!answered.ok) {
        const status = answered.reason === "bad-option" || answered.reason === "bad-note" ? 400 : 409;
        const why = answered.reason === "already-answered" ? "already answered — somebody got there first" : answered.reason;
        return refuse(response, who, status, why, `/d/${id}`);
      }
      return redirect(response, `/d/${id}`);
    }

    const act = matchTaskPath(url.pathname, "/(hold|unhold|requeue|cancel|scope|approve|plan)$");
    if (act !== null) {
      return taskMutation(response, who, act.taskId, act.verb, body, now);
    }

    const routineAct = /^\/routines\/([0-9]{1,15})\/(approve|pause|resume|run-now)$/.exec(url.pathname);
    if (routineAct !== null) {
      return routineMutation(response, who, Number(routineAct[1]), routineAct[2] as string, body, now);
    }

    const resolve = /^\/i\/([0-9]{1,15})\/resolve$/.exec(url.pathname);
    if (resolve !== null) {
      const id = Number(resolve[1]);
      // The ceiling applies to incident mutation exactly as to every other
      // resource (v3 review, finding 3): resolve incident → run → task, and
      // an incident outside this server's scope does not exist here. The
      // task id is captured BEFORE resolving — afterwards the incident is
      // no longer open and could not be found again.
      const openRow = store.openIncidents().find(one => one.id === id);
      const incidentRun = openRow === undefined ? null : store.getRun(openRow.run);
      if (openRow !== undefined && incidentRun !== null && !visible(taskRepoOf(incidentRun.taskRef))) {
        return refuse(response, who, 404, "no such incident");
      }
      const resolved = store.resolveIncident(id, who.name, now);
      if (!resolved) return refuse(response, who, 409, "already resolved, or never open");
      const back = body.get("return") === "inbox" ? "/" : openRow === undefined ? "/" : taskHref(openRow.taskId);
      return redirect(response, back);
    }

    return respond(response, 404, "text/plain; charset=utf-8", "nothing here");
  }

  function taskMutation(
    response: ServerResponse,
    who: Who,
    taskId: string,
    verb: string,
    body: URLSearchParams,
    now: Date,
  ): void {
    const ref = store.lookupRef(taskId);
    if (ref === null || store.getTask(taskId) === null) {
      return refuse(response, who, 404, "no such task", "/tasks");
    }
    if (!visible(ref.repo)) {
      return refuse(response, who, 404, "no such task", "/tasks");
    }

    switch (verb) {
      case "hold": {
        const reason = (body.get("reason") ?? "").trim() || "held from the console";
        if (reason.length > 200 || hasForbiddenControls(reason)) {
          return taskScreen(response, who, taskId, "that reason will not render, so it will not store", 400);
        }
        // Operator-owned only, always: the form supplies a reason, never an
        // owner. Decision, incident, and backoff holds are not reachable
        // from here, whatever a request claims.
        store.hold(ref.id, reason, null, now);
        return redirect(response, taskHref(taskId));
      }
      case "unhold": {
        store.unhold(ref.id);
        return redirect(response, taskHref(taskId));
      }
      case "requeue": {
        const requeued = store.requeueTask(taskId, who.name, now);
        if (!requeued.ok) {
          return taskScreen(response, who, taskId, `not requeued: ${requeued.reason}`, 409);
        }
        // Allow-listed return only — never an arbitrary URL from the form.
        return redirect(response, body.get("return") === "inbox" ? "/" : taskHref(taskId));
      }
      case "plan": {
        // The operator's explicit ask, refused transactionally when the
        // moment has passed — approved scope, live claim, or a plan
        // already under way (Codex planning review's requestPlan guard).
        const asked = store.requestPlan(ref.id, now);
        if (!asked.ok) {
          return taskScreen(response, who, taskId, `not planned: ${asked.reason}`, 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "cancel": {
        const cancelled = store.cancelTask(taskId, now);
        if (!cancelled.ok) {
          return taskScreen(response, who, taskId, `not cancelled: ${cancelled.reason}`, 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "scope": {
        const sawDigest = body.get("sawDigest");
        const proposed = proposeGuarded(store, {
          taskId,
          goal: body.get("goal") ?? "",
          outOfScope: body.get("not") ?? null,
          touches: (body.get("touches") ?? "").split(/[\n,]/),
          sawDigest: sawDigest === null || sawDigest === "" ? null : sawDigest,
          taskRef: ref.id,
          now,
        });
        if (!proposed.ok) {
          const status = proposed.reason === "changed" || proposed.reason === "claimed" ? 409 : 400;
          return taskScreen(response, who, taskId, `scope not saved: ${proposed.reason}`, status);
        }
        return redirect(response, taskHref(taskId));
      }
      case "approve": {
        // Step-up: the session got you here; only the token agrees. The
        // digest names what was seen; the nonce proves this exact form was
        // rendered to this approver and is spent either way.
        const digest = body.get("digest") ?? "";
        const token = body.get("token") ?? "";
        if (who.via === "cookie") {
          const nonce = body.get("nonce") ?? "";
          if (!consumeApprovalNonce(nonce, who.name, taskId, digest)) {
            return taskScreen(response, who, taskId, "that approval form is stale — read it again", 409);
          }
        }
        if (token === "") {
          return taskScreen(response, who, taskId, "approval requires your password, typed again", 400);
        }
        const approved = approveScope(store, taskId, who.name, now, digest, token);
        if (!approved.ok) {
          const status = approved.reason === "changed" ? 409 : 403;
          return taskScreen(response, who, taskId, `not approved: ${approved.reason}`, status);
        }
        return redirect(response, taskHref(taskId));
      }
      default:
        return respond(response, 404, "text/plain; charset=utf-8", "nothing here");
    }
  }

  // ---- identity ------------------------------------------------------------

  function identify(request: IncomingMessage, touch = true): Who | null {
    const bearer = /^Bearer (.+):(.+)$/.exec(request.headers.authorization ?? "");
    if (bearer !== null) {
      const authenticated = authenticateApprover(store, bearer[1] as string, bearer[2] as string);
      return authenticated.ok ? { name: bearer[1] as string, via: "bearer" } : null;
    }
    const cookies = request.headers.cookie ?? "";
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`).exec(cookies);
    if (match === null) return null;
    const session = lookupSession(match[1] as string, touch);
    return session === null ? null : { name: session.name, via: "cookie", session };
  }

  /**
   * Constant-time against the session table, small as it is — and every hit
   * is re-proved against time and the approver's credential generation. A
   * rotated credential kills its cookies the same way it kills its Telegram
   * bindings: authority derived from the old secret does not outlive it.
   */
  function lookupSession(candidate: string, touch = true): Session | null {
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
      if (touch) session.lastSeen = now;
      return session;
    }
    return null;
  }

  /** The newest plan document for a task, verified before a byte renders. */
  function planDocumentOf(taskRef: number): string | null {
    const artifact = store.latestPlanArtifact(taskRef);
    if (artifact === null) return null;
    try {
      const verified = readVerifiedArtifact(evidenceRoot, artifact);
      return verified.ok ? verified.content.toString("utf8") : null;
    } catch {
      return null;
    }
  }

  // ---- evidence ------------------------------------------------------------

  function decisionEvidence(response: ServerResponse, decisionId: number, artifactId: number): void {
    // The ceiling applies to decision evidence exactly as to run evidence
    // (v2 review, finding 2): a decision whose task belongs to a repo this
    // server may not serve does not exist here, and neither do its bytes.
    const decision = store.getDecision(decisionId);
    const decisionRun = decision === null ? null : store.getRun(decision.run);
    if (decisionRun !== null && !visible(taskRepoOf(decisionRun.taskRef))) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such evidence");
    }
    // Only through the decision's own relation — an artifact id from another
    // run simply is not in this list, whatever the URL claims.
    const linked = store.evidenceFor(decisionId).find(one => one.id === artifactId);
    if (linked === undefined) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such evidence");
    }
    return sendArtifact(response, linked);
  }

  function runEvidence(response: ServerResponse, runId: number, artifactId: number): void {
    const run = store.getRun(runId);
    if (run === null || !runVisible(run)) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such run");
    }
    // Membership is the lookup's own predicate — there is no way to check
    // the run and fetch the artifact as two separate acts here.
    const linked = store.artifactForRun(runId, artifactId);
    if (linked === null) {
      return respond(response, 404, "text/plain; charset=utf-8", "no such evidence");
    }
    return sendArtifact(response, linked);
  }

  /**
   * When this server is scoped to a repo, a run whose task belongs to a
   * different repo does not exist here — its evidence may hold that other
   * repo's diffs, and one console instance is one trust domain.
   */
  function runVisible(run: Run): boolean {
    return visible(taskRepoOf(run.taskRef));
  }

  function sendArtifact(response: ServerResponse, linked: Artifact): void {
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

// ---- path plumbing ---------------------------------------------------------

/**
 * Match `/t/<id>` (suffix "") or `/t/<id>/<verb>` — the id percent-decoded
 * exactly once, refused when it does not decode, is oversized, or carries
 * control characters. Legacy CLI-created ids are free-form; the URL is not.
 */
function matchTaskPath(pathname: string, suffixPattern: string): { taskId: string; verb: string } | null {
  const match = new RegExp(`^/t/([^/]+)${suffixPattern === "" ? "$" : suffixPattern}`).exec(pathname);
  if (match === null) return null;
  let taskId: string;
  try {
    taskId = decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
  if (taskId.length === 0 || taskId.length > 64 || hasForbiddenControls(taskId)) return null;
  return { taskId, verb: match[2] ?? "" };
}

function taskHref(taskId: string): string {
  return `/t/${encodeURIComponent(taskId)}`;
}

/** The spend line for a 7am reader: whole cents, "runs", the gap still named. */
function consoleSpend(summary: ReturnType<typeof tally<Run & { taskId: string }>>): string {
  if (summary.invoked.length === 0) return "nothing — no provider was invoked";
  const dollars = `$${summary.spend.toFixed(2)}`;
  const gap = summary.invoked.length - summary.measured.length;
  return `${dollars} across ${summary.invoked.length} run(s)${gap > 0 ? ` — ${gap} unmeasured` : ""}`;
}

/** ISO to the minute — "2026-08-12 17:56" — for anywhere a person reads a time. */
function when(iso: string | null): string {
  return iso === null ? "" : iso.slice(0, 16).replace("T", " ");
}

/** Overdue is derived at render — display never writes. */
function isOverdue(decision: Decision, now: Date): boolean {
  if (decision.state === "expired") return true;
  return (
    decision.state === "open" && decision.deadline !== null && decision.deadline <= now.toISOString()
  );
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

/**
 * A page response. With a nonce, this response's CSP admits exactly the one
 * inline script the shell stamped with the same value — generated per
 * response, never shared, never 'unsafe-inline' (Codex board review,
 * finding 9). Everything else keeps the constant script-free policy.
 */
function page(response: ServerResponse, status: number, html: string, nonce?: string): void {
  if (nonce === undefined) return respond(response, status, "text/html; charset=utf-8", html);
  response.writeHead(status, {
    ...SAFETY,
    "Content-Security-Policy":
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function redirect(response: ServerResponse, to: string): void {
  response.writeHead(303, { ...SAFETY, Location: to });
  response.end();
}

/**
 * A refusal that stays inside the console: same shell, a problem banner, and
 * a way back — the error path is the one place a console must not stop
 * being a console. Bearer callers still get plain text; they parse, not read.
 */
function refuse(
  response: ServerResponse,
  who: Who | null,
  status: number,
  message: string,
  backHref = "/",
): void {
  if (who === null || who.via === "bearer") {
    return respond(response, status, "text/plain; charset=utf-8", message);
  }
  return page(
    response,
    status,
    shell("refused", [
      `<h1>that did not happen</h1>`,
      `<div class="problem">${escape(message)}</div>`,
      `<p class="meta"><a href="${escape(backHref)}">\u2190 back</a></p>`,
    ].join("\n")),
  );
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

/**
 * shadcn/ui's design system — its zinc palette, radii, and component
 * shapes — as pure CSS on server-rendered HTML. Deliberately not the React
 * library: the console ships zero dependencies and zero page JavaScript
 * under a CSP that forbids scripts, and a look is not worth that posture.
 * Dark mode follows the device (`prefers-color-scheme`), tokens redefined
 * wholesale, exactly as shadcn's own theme variables do.
 */
const STYLE = `
  :root {
    color-scheme: light dark;
    --background: hsl(0 0% 100%);
    --foreground: hsl(240 10% 3.9%);
    --card: hsl(0 0% 100%);
    --muted: hsl(240 4.8% 95.9%);
    --muted-foreground: hsl(240 3.8% 42%);
    --border: hsl(240 5.9% 90%);
    --input: hsl(240 5.9% 90%);
    --primary: hsl(240 5.9% 10%);
    --primary-foreground: hsl(0 0% 98%);
    --secondary: hsl(240 4.8% 95.9%);
    --secondary-foreground: hsl(240 5.9% 10%);
    --accent: hsl(240 4.8% 95.9%);
    --destructive: hsl(0 72% 38%);
    --destructive-strong: hsl(0 74% 42%);
    --destructive-soft: hsl(0 86% 97%);
    --success: hsl(142 76% 26%);
    --success-soft: hsl(141 84% 93%);
    --warning: hsl(35 92% 28%);
    --warning-soft: hsl(48 96% 89%);
    --ring: hsl(240 5% 64.9%);
    --radius: 0.625rem;
    --shadow: 0 1px 2px 0 hsl(240 10% 3.9% / 0.05);
    --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: hsl(240 10% 3.9%);
      --foreground: hsl(0 0% 98%);
      --card: hsl(240 8% 6%);
      --muted: hsl(240 3.7% 15.9%);
      --muted-foreground: hsl(240 5% 64.9%);
      --border: hsl(240 3.7% 15.9%);
      --input: hsl(240 3.7% 17%);
      --primary: hsl(0 0% 98%);
      --primary-foreground: hsl(240 5.9% 10%);
      --secondary: hsl(240 3.7% 15.9%);
      --secondary-foreground: hsl(0 0% 98%);
      --accent: hsl(240 3.7% 15.9%);
      --destructive: hsl(0 84% 68%);
      --destructive-strong: hsl(0 72% 51%);
      --destructive-soft: hsl(0 50% 13%);
      --success: hsl(142 62% 62%);
      --success-soft: hsl(144 61% 11%);
      --warning: hsl(45 92% 60%);
      --warning-soft: hsl(36 50% 12%);
      --ring: hsl(240 4.9% 45%);
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  ::selection { background: color-mix(in srgb, var(--foreground) 18%, transparent); }
  body {
    margin: 0; background: var(--background); color: var(--foreground);
    caret-color: var(--foreground);
    font: 400 0.9375rem/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  .topbar {
    position: sticky; top: 0; z-index: 10;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--background) 86%, transparent);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  }
  .topbar-inner {
    max-width: 44rem; margin-inline: auto; padding: 0 1.25rem; height: 3.25rem;
    display: flex; align-items: center; gap: 1.25rem;
  }
  .brand { font-weight: 650; letter-spacing: -0.01em; color: var(--foreground); text-decoration: none;
           display: flex; align-items: center; height: 100%; }
  .brand .dot { color: var(--muted-foreground); }
  .topbar nav { display: flex; gap: .25rem; margin-left: auto; height: 100%; }
  .topbar nav a {
    color: var(--muted-foreground); text-decoration: none; font-size: 0.8125rem; font-weight: 500;
    display: flex; align-items: center; padding: 0 .625rem; transition: color .15s;
  }
  .topbar nav a:hover { color: var(--foreground); }
  main { max-width: 44rem; margin-inline: auto; padding: 1.75rem 1.25rem 4rem; }
  h1 { font-size: 1.375rem; font-weight: 650; letter-spacing: -0.025em; margin: 0 0 .25rem; }
  h1 .meta { font-weight: 400; letter-spacing: 0; }
  h2 {
    font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted-foreground); margin: 2.25rem 0 .625rem;
  }
  a { color: var(--foreground); text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; }
  a:hover { text-decoration-color: var(--muted-foreground); }
  p { margin: .4rem 0; }
  code { background: var(--muted); border-radius: .3rem; padding: .1rem .35rem; font-family: var(--font-mono); font-size: .8125rem; }
  .mono { font-family: var(--font-mono); font-size: .8125rem; font-variant-numeric: tabular-nums; }

  .meta { font-size: 0.8125rem; color: var(--muted-foreground); }
  .meta a { color: var(--muted-foreground); }
  .hint { font-size: 0.75rem; color: var(--muted-foreground); margin: -.375rem 0 .625rem; opacity: .8; }
  .num { font-variant-numeric: tabular-nums; }

  /* The ledger: the window's harvest as strong figures in a sentence,
     not a metric-card grid. */
  .ledger { font-size: 0.9375rem; color: var(--muted-foreground); margin: .875rem 0 0; line-height: 1.9; }
  .ledger b { font-weight: 650; font-size: 1.25rem; color: var(--foreground); font-variant-numeric: tabular-nums; padding-right: .1rem; }
  .ledger .good b { color: var(--success); }
  .ledger .bad b { color: var(--destructive); }

  .badge {
    display: inline-block; border: 1px solid var(--border); border-radius: 9999px;
    padding: .125rem .625rem; font-size: 0.75rem; font-weight: 500; line-height: 1.4;
    background: var(--secondary); color: var(--secondary-foreground); vertical-align: middle;
  }
  .badge-done, .badge-answered, .badge-verified, .badge-built { background: var(--success-soft); color: var(--success); border-color: transparent; }
  .badge-failed, .badge-cancelled, .badge-overdue { background: var(--destructive-soft); color: var(--destructive); border-color: transparent; }
  .badge-running, .badge-open, .badge-parked, .badge-cut { background: var(--warning-soft); color: var(--warning); border-color: transparent; }

  .card {
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--card);
    padding: 1rem 1.125rem; margin: .75rem 0; box-shadow: var(--shadow);
  }
  .problem {
    border: 1px solid color-mix(in srgb, var(--destructive) 35%, transparent);
    background: var(--destructive-soft); color: var(--destructive);
    border-radius: var(--radius); padding: .625rem .875rem; margin: .75rem 0; font-size: 0.8125rem;
  }
  .row {
    display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap;
    padding: .625rem .125rem; border-bottom: 1px solid var(--border);
    margin: 0;
  }
  .row:last-of-type { border-bottom: none; }
  .row .right { margin-left: auto; }
  a.row { text-decoration: none; }
  a.row:hover { background: color-mix(in srgb, var(--accent) 55%, transparent); }

  /* A parked decision is the page's reason to exist: it gets a card, a
     question in full weight, and the whole card is the tap target. */
  .decide-card {
    display: block; border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--card); padding: .875rem 1.125rem; margin: .625rem 0;
    text-decoration: none; box-shadow: var(--shadow); transition: border-color .15s;
  }
  .decide-card:hover { border-color: var(--ring); }
  .decide-card .q { font-weight: 600; margin: 0 0 .25rem; }

  button {
    font: 500 0.9375rem/1.4 inherit; cursor: pointer; border-radius: calc(var(--radius) - 2px);
    border: 1px solid var(--border); background: var(--background); color: var(--foreground);
    padding: .5rem .875rem; min-height: 2.5rem; box-shadow: var(--shadow);
    transition: background .15s, border-color .15s;
  }
  button:hover { background: var(--accent); }
  .approve-form button[type=submit] {
    background: var(--primary); color: var(--primary-foreground); border-color: var(--primary);
  }
  .approve-form button[type=submit]:hover { background: color-mix(in srgb, var(--primary) 88%, var(--background)); }
  button.danger { color: var(--destructive-strong); border-color: color-mix(in srgb, var(--destructive-strong) 40%, transparent); }
  button.danger:hover { background: var(--destructive-soft); }

  label { display: block; font-size: 0.8125rem; font-weight: 500; margin: .75rem 0 0; color: var(--foreground); }
  input[type=text], input[type=password], textarea {
    width: 100%; margin: .35rem 0 0; padding: .5rem .75rem; font: 400 0.9375rem/1.4 inherit;
    color: var(--foreground); background: transparent; min-height: 2.5rem;
    border: 1px solid var(--input); border-radius: calc(var(--radius) - 2px); box-shadow: var(--shadow);
  }
  input:focus-visible, textarea:focus-visible, button:focus-visible, a:focus-visible, summary:focus-visible {
    outline: 2px solid var(--ring); outline-offset: 1px;
  }
  ::placeholder { color: var(--muted-foreground); }

  .inline { display: inline-block; width: auto; margin: 0 .375rem .375rem 0; vertical-align: middle; }
  .inline input[type=text] { display: inline-block; width: auto; margin: 0 .375rem 0 0; vertical-align: middle; }
  .inline button { width: auto; }

  /* One option = one container: consequence first, then the act. */
  form.option {
    margin: .75rem 0; border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--card); padding: .875rem 1rem; box-shadow: var(--shadow);
  }
  form.option button {
    display: block; width: 100%; text-align: left; font-size: 0.9375rem; font-weight: 600;
    min-height: 2.75rem;
  }
  form.option.recommended { border-color: var(--foreground); box-shadow: 0 0 0 1px var(--foreground); }
  .consequence { font-size: 0.8125rem; color: var(--muted-foreground); margin: 0 0 .625rem; white-space: pre-wrap; }
  form.option input[type=text] { font-size: 0.8125rem; margin-top: .5rem; min-height: 2.25rem; }

  .recap { color: var(--muted-foreground); margin: .75rem 0; white-space: pre-wrap; }
  .question { font-size: 1.125rem; font-weight: 650; letter-spacing: -0.015em; margin: 1rem 0; white-space: pre-wrap; }
  .answered {
    border: 1px solid color-mix(in srgb, var(--success) 35%, transparent); background: var(--success-soft);
    border-radius: var(--radius); padding: .875rem 1rem; margin: 1rem 0;
  }
  details {
    margin: .75rem 0; border: 1px solid var(--border); border-radius: var(--radius);
    padding: .25rem .875rem; background: var(--card);
  }
  details[open] { padding-bottom: .875rem; }
  details.arm-danger { border-color: color-mix(in srgb, var(--destructive-strong) 30%, transparent); }
  summary { padding: .625rem 0; cursor: pointer; font-weight: 500; font-size: 0.8125rem; color: var(--muted-foreground); min-height: 2.25rem; }
  summary:hover { color: var(--foreground); }
  details form.option { border: none; box-shadow: none; padding: .25rem 0 0; margin: 0; }
  .evidence { margin-top: 1.5rem; font-size: 0.8125rem; }
  .evidence a { display: block; padding: .55rem 0; border-bottom: 1px solid var(--border); text-decoration: none; }
  .evidence a:hover { color: var(--muted-foreground); }
  .evidence strong { display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted-foreground); }

  .filters { font-size: 0.8125rem; color: var(--muted-foreground); }
  .filters a, .filters strong {
    display: inline-block; padding: .25rem .625rem; border-radius: 9999px; text-decoration: none;
    color: var(--muted-foreground); font-weight: 500;
  }
  .filters strong { background: var(--secondary); color: var(--secondary-foreground); }
  .filters a:hover { color: var(--foreground); }

  /* The workspace shell: sidebar + content, an optional list pane between.
     One grid, collapsing to the phone column below 760px — the answering
     flow keeps its single-column ritual. */
  .app { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
  .side {
    border-right: 1px solid var(--border); background: var(--card);
    padding: 1rem .875rem; display: flex; flex-direction: column; gap: .25rem;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
  }
  .side .brand { padding: .25rem .5rem .75rem; font-size: 1rem; height: auto; }
  .side-project {
    border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px);
    padding: .5rem .625rem; margin: 0 0 .75rem; background: var(--background);
  }
  .side-project .name { font-weight: 600; font-size: .875rem; display: block; }
  .side-project a { font-size: .75rem; }
  .side nav { display: flex; flex-direction: column; gap: .125rem; }
  .side nav a {
    display: flex; align-items: center; gap: .5rem; padding: .5rem .625rem; min-height: 2.25rem;
    border-radius: calc(var(--radius) - 2px); text-decoration: none;
    color: var(--muted-foreground); font-size: .875rem; font-weight: 500;
  }
  .side nav a:hover { background: var(--accent); color: var(--foreground); }
  .side nav a.active { background: var(--accent); color: var(--foreground); }
  .side nav a .count { margin-left: auto; }
  .side .grow { flex: 1; }
  .side .new-task {
    display: block; text-align: center; text-decoration: none; font-weight: 600; font-size: .875rem;
    background: var(--primary); color: var(--primary-foreground);
    border-radius: calc(var(--radius) - 2px); padding: .625rem; margin: .75rem 0 .25rem;
  }
  .side .new-task:hover { opacity: .9; }
  .content { min-width: 0; }
  .content > main { max-width: 52rem; margin: 0; padding: 1.75rem 2rem 4rem; }
  .split { display: grid; grid-template-columns: minmax(250px, 320px) minmax(0, 1fr); min-height: 100vh; }
  .list-pane {
    border-right: 1px solid var(--border); overflow-y: auto; height: 100vh;
    position: sticky; top: 0; padding: 1rem .75rem;
  }
  .list-pane h2 { margin-top: .25rem; }
  .list-pane a.item {
    display: block; padding: .5rem .625rem; border-radius: calc(var(--radius) - 2px);
    text-decoration: none; font-size: .8125rem; margin-bottom: .125rem;
  }
  .list-pane a.item:hover { background: var(--accent); }
  .list-pane a.item.current { background: var(--accent); }
  .list-pane a.item .t { display: block; font-weight: 550; color: var(--foreground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .list-pane a.item .m { display: flex; gap: .375rem; align-items: center; color: var(--muted-foreground);
    font-size: .75rem; margin-top: .125rem; }
  .split > .detail { min-width: 0; }
  .split > .detail > main { max-width: 52rem; padding: 1.75rem 2rem 4rem; }
  @media (max-width: 980px) { .split { grid-template-columns: 1fr; } .list-pane { display: none; } }
  @media (max-width: 760px) {
    .app { display: block; }
    .side { position: sticky; height: auto; flex-direction: row; align-items: center;
            border-right: none; border-bottom: 1px solid var(--border); padding: .5rem .75rem;
            gap: .375rem; z-index: 10; overflow-x: auto; overflow-y: hidden; }
    .side .brand { padding: 0 .375rem; }
    .side-project { margin: 0; padding: .25rem .5rem; }
    .side-project .name { font-size: .75rem; }
    .side-project a { display: none; }
    .side nav { flex-direction: row; }
    .side nav a { padding: .375rem .5rem; }
    .side .grow { display: none; }
    .side .new-task { margin: 0; padding: .375rem .625rem; white-space: nowrap; }
    .side .foot { display: none; }
    .content > main, .split > .detail > main { padding: 1.25rem 1.25rem 4rem; }
  }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr)); gap: .625rem; margin: .5rem 0; }
  .stat-card {
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--card);
    padding: .75rem .875rem; box-shadow: var(--shadow); min-width: 0;
  }
  .stat-card .k { font-weight: 600; font-size: .875rem; display: flex; align-items: center; gap: .4rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat-card .v { font-size: .75rem; color: var(--muted-foreground); margin-top: .25rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 9999px; flex: none; }
  .dot-ok { background: var(--success); }
  .dot-warn { background: var(--warning); }
  .dot-off { background: var(--muted-foreground); opacity: .5; }
  .dot-bad { background: var(--destructive-strong); }
  .pulse { animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }

  .login-shell { max-width: 22rem; margin: 14vh auto 0; padding: 0 1.25rem; }
  .login-shell h1 { text-align: center; margin-bottom: .25rem; }
  .login-shell .hint { text-align: center; margin-bottom: 1rem; }
  .login-shell button { width: 100%; margin-top: 1rem; background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }

  @media (max-width: 640px) {
    button, form.option button { min-height: 2.75rem; }
    .topbar nav a { padding: 0 .5rem; }
  }

  /* The board: lanes as columns, the pipeline left to right. The container
     owns the horizontal scroll so narrow screens pan the pipeline instead
     of crushing it. The reading measure is for prose — a five-lane
     pipeline gets the whole content pane. */
  .content > main:has(.board) { max-width: none; }
  .board {
    display: grid; grid-template-columns: repeat(5, minmax(15rem, 1fr));
    gap: .75rem; overflow-x: auto; padding-bottom: .75rem; align-items: start;
  }
  .lane {
    background: var(--muted); border: 1px solid var(--border);
    border-radius: .625rem; padding: .625rem; min-height: 12rem;
  }
  .lane h2 { margin: 0 0 .125rem; font-size: .8125rem; }
  .lane h2 a { color: inherit; text-decoration: none; }
  .lane .hint { margin-top: 0; }
  .lane-count { color: var(--muted-foreground); font-weight: 400; font-variant-numeric: tabular-nums; }
  .lane-attention { border-top: 2px solid var(--warning); }
  .lane-building { border-top: 2px solid var(--success); }
  .lane-card {
    display: block; text-decoration: none; color: inherit;
    background: var(--card); border: 1px solid var(--border);
    border-radius: .5rem; padding: .5rem .625rem; margin-top: .5rem;
  }
  .lane-card:hover { border-color: var(--ring); }
  .lane-card .t { display: block; font-size: .8125rem; font-weight: 500; }
  .lane-card .meta, .lane-card .mono { display: block; margin-top: .125rem; font-size: .75rem; }
  .lane-empty { margin: .75rem 0 .25rem; }
  .plan-doc { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .8125rem; max-height: 24rem; overflow-y: auto; }
  .lane-more { display: block; margin-top: .5rem; font-size: .75rem; }
  .tracks { margin-top: 1.5rem; }
  .tracks > .hint { margin-bottom: .75rem; }
  .track-row { margin-bottom: .6rem; }
  .track-strip { display: inline-flex; gap: .3rem; align-items: center; vertical-align: middle; }
  .fire {
    display: inline-block; width: .65rem; height: .65rem; border-radius: 50%;
    background: var(--muted);
  }
  .fire-ok { background: var(--success); }
  .fire-bad { background: var(--destructive-strong); }
  .fire-live { background: var(--success); animation: pulse 1.6s ease-in-out infinite; }
  .fire-skip { background: transparent; border: 1.5px solid var(--muted); }
`;

/** Everything the sidebar needs to draw itself for one request. */
type Chrome = {
  active: "inbox" | "board" | "work" | "done" | "activity" | "system" | "tasks" | "runs" | "caps" | "routines" | "projects" | "settings" | "none";
  project: string | null;
  /** The saturated inbox count — never a sum of unbounded list reads. */
  inboxCount: number;
  inboxSaturated: boolean;
  settings: boolean;
  /** A rendered list pane makes the page master-detail. */
  listPane?: string;
};

/**
 * The board's liveness: fetch this page's own fragment on a timer and swap
 * it in place — no flicker, no scroll reset, no long-lived stream to manage,
 * and correct by cadence rather than by trusting the scheduler's wake
 * sequence to narrate every UI-visible change (Codex board review, finding
 * 3 chose this over SSE). A redirect or auth failure navigates to /login
 * instead of ever inserting the login page into the region (finding 4).
 * The swapped markup is this server's own rendering of the same route —
 * escaped at the sink like every page, fetched same-origin — and the
 * nonce'd CSP refuses to execute anything the region could smuggle.
 */
function liveScript(everySeconds: number): string {
  const ms = Math.max(5, Math.floor(everySeconds)) * 1000;
  return (
    `(function(){var main=document.querySelector("main");if(!main)return;` +
    `function cycle(){var q=location.search?location.search+"&fragment=1":"?fragment=1";` +
    `fetch(location.pathname+q,{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t)main.innerHTML=t;})` +
    `.catch(function(){})` +
    `.then(function(){setTimeout(cycle,${ms});});}` +
    `setTimeout(cycle,${ms});})();`
  );
}

function shell(
  title: string,
  body: string,
  options: {
    nav?: boolean;
    chrome?: Chrome;
    refreshSeconds?: number;
    /** In-place fragment refresh — read-only pages only, one nonce per response. */
    live?: { everySeconds: number; nonce: string };
  } = {},
): string {
  const head = [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    // Live status with zero JavaScript: the page asks the browser to fetch
    // it again. Only ever on read-only briefing pages — a refresh on a page
    // with a form would eat what somebody was typing.
    ...(options.refreshSeconds === undefined
      ? []
      : [`<meta http-equiv="refresh" content="${Math.max(5, Math.floor(options.refreshSeconds))}">`]),
    // With the in-place swapper, the whole-page refresh survives only as
    // the no-JavaScript fallback.
    ...(options.live === undefined
      ? []
      : [`<noscript><meta http-equiv="refresh" content="${Math.max(5, Math.floor(options.live.everySeconds))}"></noscript>`]),
    `<title>${escape(title)}</title><style>${STYLE}</style></head><body>`,
  ].join("\n");
  const tail =
    options.live === undefined
      ? `</body></html>`
      : `<script nonce="${options.live.nonce}">${liveScript(options.live.everySeconds)}</script></body></html>`;

  if (options.chrome === undefined) {
    // Chromeless: the login page and refusal pages.
    return [head, `<main>`, body, `</main>`, tail].join("\n");
  }

  const chrome = options.chrome;
  const item = (key: Chrome["active"], href: string, label: string, count?: number): string =>
    `<a href="${href}"${chrome.active === key ? ' class="active"' : ""}>${label}` +
    `${count !== undefined && count > 0 ? ` <span class="count badge badge-open">${count}${key === "inbox" && chrome.inboxSaturated ? "+" : ""}</span>` : ""}</a>`;

  const side = [
    `<aside class="side">`,
    `<a class="brand" href="/">night<span class="dot">·</span>orders</a>`,
    `<div class="side-project">` +
      (chrome.project === null
        ? `<span class="name meta">no project open</span>`
        : `<span class="name">${escape(projectName(chrome.project))}</span>`) +
      `<a href="/projects">switch project</a></div>`,
    `<nav>`,
    item("inbox", "/", "inbox", chrome.inboxCount),
    item("board", "/board", "board"),
    item("routines", "/routines", "routines"),
    item("done", "/done", "done"),
    `</nav>`,
    `<a class="new-task" href="/tasks/new">+ new task</a>`,
    `<span class="grow"></span>`,
    `<nav class="foot">`,
    item("activity", "/activity", "activity"),
    item("work", "/tasks", "task list"),
    item("system", "/system", "system"),
    item("runs", "/runs", "builds"),
    item("caps", "/caps", "requirements"),
    ...(chrome.settings ? [item("settings", "/settings", "settings")] : []),
    `</nav>`,
    `</aside>`,
  ].join("\n");

  const content =
    chrome.listPane === undefined
      ? `<div class="content"><main>${body}</main></div>`
      : `<div class="content"><div class="split">` +
        `<div class="list-pane">${chrome.listPane}</div>` +
        `<div class="detail"><main>${body}</main></div>` +
        `</div></div>`;

  return [head, `<div class="app">`, side, content, `</div>`, tail].join("\n");
}


function loginPage(problem: string | null): string {
  return shell("night orders", [
    `<div class="login-shell">`,
    `<h1>night<span class="dot">\u00b7</span>orders</h1>`,
    `<p class="meta hint">users are added on the server: <code>nightorders approver add &lt;name&gt; --password &hellip;</code></p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    `<form method="post" action="/login">`,
    `<label>username<input type="text" name="name" autocomplete="username"></label>`,
    `<label>password<input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">sign in</button>`,
    "</form>",
    `</div>`,
  ].join("\n"), { nav: false });
}

/**
 * The inbox (v3): only things stalling progress without a person, one card
 * per underlying stall, each with its verb inline or one step away. No
 * auto-refresh — approval links lead to the step-up screen, and a page
 * that might hold typed input never re-renders itself.
 */
function inboxPage(chrome: Chrome, data: {
  csrf: string;
  decisions: (Decision & { taskId: string })[];
  approvals: { taskId: string; title: string; goal: string; proposedAt: string }[];
  requeueables: { taskId: string; title: string; state: TaskState; strikes: number; incidentCount: number }[];
  cancelledBlockers: { blockerId: string; dependentCount: number; exampleDependent: string }[];
  gaps: Gap[];
  now: Date;
}): string {
  const empty =
    data.decisions.length + data.approvals.length + data.requeueables.length +
    data.cancelledBlockers.length + data.gaps.length === 0;

  const decisions =
    data.decisions.length === 0
      ? ""
      : `<h2>answer a question</h2><p class="hint">an agent stopped mid-build to ask — nothing proceeds until you answer</p>` +
        data.decisions
          .map(
            decision =>
              `<a class="decide-card" href="/d/${decision.id}">` +
              `<p class="q">${escape(decision.question)}</p>` +
              `<span class="mono meta">${escape(decision.taskId)}</span>` +
              `${isOverdue(decision, data.now) ? ` <span class="badge badge-overdue">overdue</span>` : ""}` +
              `</a>`,
          )
          .join("\n");

  const approvals =
    data.approvals.length === 0
      ? ""
      : `<h2>approve a scope</h2><p class="hint">work waiting for your yes — review exactly what it may become, then agree with your password</p>` +
        data.approvals
          .map(
            one =>
              `<a class="decide-card" href="${taskHref(one.taskId)}">` +
              `<p class="q">${escape(one.title)}</p>` +
              `<span class="meta">${escape(one.goal.length > 120 ? one.goal.slice(0, 120) + "\u2026" : one.goal)}</span><br>` +
              `<span class="mono meta">${escape(one.taskId)}</span> <span class="right meta">review &amp; approve \u2192</span>` +
              `</a>`,
          )
          .join("\n");

  const requeueables =
    data.requeueables.length === 0
      ? ""
      : `<h2>retry stalled work</h2><p class="hint">builds that gave up and now wait for a person — retry resolves the incidents, resets the strikes, and requeues</p>` +
        data.requeueables
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> ${escape(one.title)}` +
              `${one.incidentCount > 0 ? ` <span class="badge badge-failed">${one.incidentCount} incident${one.incidentCount > 1 ? "s" : ""}</span>` : ""}` +
              `${one.strikes > 0 ? ` <span class="meta">${one.strikes} failed attempt${one.strikes > 1 ? "s" : ""}</span>` : ""}` +
              `<span class="right"><form method="post" action="${taskHref(one.taskId)}/requeue" class="inline">` +
              `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
              `<input type="hidden" name="return" value="inbox">` +
              `<button type="submit">retry</button></form></span></p>`,
          )
          .join("\n");

  const cancelled =
    data.cancelledBlockers.length === 0
      ? ""
      : `<h2>repair a dependency</h2><p class="hint">these were cancelled, but other tasks still wait on them — re-create the blocker or remove the dependency</p>` +
        data.cancelledBlockers
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.blockerId)}">${escape(one.blockerId)}</a> ` +
              `<span class="meta">cancelled \u00b7 ${one.dependentCount} task${one.dependentCount > 1 ? "s" : ""} waiting (e.g. ${escape(one.exampleDependent)})</span></p>`,
          )
          .join("\n");

  const gaps =
    data.gaps.length === 0
      ? ""
      : `<h2>supply a requirement</h2><p class="hint">approved work is ready except for these — fill one and its tasks start</p>` +
        data.gaps
          .map(
            gap =>
              `<p class="row"><a href="/caps">${escape(gap.key)}</a> ` +
              `<span class="meta">frees ${gap.unblocks.length} task${gap.unblocks.length > 1 ? "s" : ""}</span>` +
              `<span class="right meta">how to fix \u2192</span></p>`,
          )
          .join("\n");

  return shell("inbox", [
    `<h1>inbox</h1>`,
    `<p class="meta">everything waiting on you \u2014 answer, approve, retry, repair, supply; when this is empty, the machine needs nothing</p>`,
    empty ? `<div class="card"><p><strong>Nothing needs you.</strong></p><p class="meta">The queue is either working or waiting on its own timers. <a href="/board">Watch the board</a> or <a href="/activity">read the activity report</a>.</p></div>` : "",
    decisions,
    approvals,
    requeueables,
    cancelled,
    gaps,
  ].join("\n"), { chrome });
}

/** System: the machinery — workers, background service, workspaces. */
function systemPage(chrome: Chrome, data: {
  building: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null }[];
  runners: Runner[];
  worktrees: WorktreeRow[];
  episode: { id: number; startedAt: string; endedAt: string | null; ticks: number; built: number; broke: number } | null;
  outboxPending: number;
  now: Date;
}): string {
  const nowMs = data.now.getTime();
  const runnerCards = data.runners
    .filter(one => one.retiredAt === null)
    .map(one => {
      const age = nowMs - new Date(one.heartbeatAt).getTime();
      const dot = age < 5 * 60_000 ? "dot-ok" : age < 60 * 60_000 ? "dot-warn" : "dot-off";
      const said = age < 5 * 60_000 ? "alive" : age < 60 * 60_000 ? `quiet ${Math.round(age / 60_000)}m` : "not heard from";
      const busy = data.building.filter(claim => claim.runner === one.name).length;
      return (
        `<div class="stat-card"><span class="k"><span class="dot ${dot}"></span>${escape(one.name)}</span>` +
        `<span class="v">worker \u00b7 ${said} \u00b7 ${busy}/${one.capacity} building</span></div>`
      );
    });
  const worktreeCards = data.worktrees.map(tree => {
    const leased = tree.leasedAt !== null && tree.releasedAt === null;
    const dot = leased ? "dot-ok" : tree.verified ? "dot-off" : "dot-warn";
    const state = leased ? "building" : tree.verified ? "free" : "needs review";
    const name = tree.path.split("/").pop() ?? tree.path;
    return (
      `<div class="stat-card"><span class="k"><span class="dot ${dot}${leased ? " pulse" : ""}"></span><span class="mono">${escape(name)}</span></span>` +
      `<span class="v">workspace \u00b7 ${escape(tree.branch)} \u00b7 ${state}</span></div>`
    );
  });
  const watchCard =
    data.episode === null
      ? ""
      : `<div class="stat-card"><span class="k"><span class="dot ${data.episode.endedAt === null ? "dot-ok pulse" : "dot-off"}"></span>background service</span>` +
        `<span class="v">${
          data.episode.endedAt === null
            ? `running since ${escape(when(data.episode.startedAt))}`
            : `last run: ${data.episode.built} built, ${data.episode.broke} broke \u00b7 ended ${escape(when(data.episode.endedAt))}`
        }</span></div>`;
  const cards = [...runnerCards, watchCard, ...worktreeCards].filter(one => one !== "");
  return shell("system", [
    `<h1>system</h1>`,
    `<p class="hint">workers execute builds; the background service starts them; each workspace is a temporary copy of your repo for one task</p>`,
    cards.length === 0
      ? `<p class="meta">no worker machine registered yet \u2014 <code>nightorders runner register &lt;name&gt;</code>, then <code>nightorders daemon install</code> keeps the background service running</p>`
      : `<div class="cards">${cards.join("")}</div>`,
    data.outboxPending > 0 ? `<p class="meta">outbox: ${data.outboxPending} notification(s) pending delivery</p>` : "",
  ].join("\n"), { chrome, refreshSeconds: data.building.length > 0 ? 10 : 60 });
}

/**
 * The board: the pipeline as lanes, position as meaning — attention, then
 * queued, then waiting, then building, then recently done. Read-only by
 * construction (every card is a link, no forms, no nonces), which is what
 * makes it safe to re-render itself while somebody watches.
 */
function boardBody(
  data: {
    cards: BoardCard[];
    tracks: Track[];
    done: ReturnType<Store["listCompletedWorkScoped"]>;
    saturated: boolean;
    now: Date;
    /** The rolled-up view: every project inside the ceiling at once. */
    all: boolean;
    project: string | null;
  },
  ciRed: (pr: number) => boolean,
): string {
  const chip = (repo: string | null): string =>
    !data.all || repo === null ? "" : ` <span class="badge">${escape(projectName(repo))}</span>`;
  const CAP = 30;
  const age = (iso: string): string => {
    const minutes = Math.max(1, Math.round((data.now.getTime() - new Date(iso).getTime()) / 60_000));
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / (24 * 60))}d`;
  };

  const lane = (
    key: "attention" | "queued" | "waiting" | "building",
    title: string,
    hint: string,
    renderOne: (card: BoardCard) => string,
  ): string => {
    const cards = data.cards.filter(card => card.lane === key);
    // The longest-stalled card leads the board: attention sorts by how
    // long it has waited, everything else stays newest-first.
    if (key === "attention") {
      cards.sort((a, b) =>
        (a.stalledSince ?? "9999").localeCompare(b.stalledSince ?? "9999"),
      );
    }
    const shown = cards.slice(0, CAP);
    const more = cards.length - shown.length;
    return (
      `<section class="lane lane-${key}"><h2>${title} <span class="lane-count">${cards.length}${
        data.saturated ? "+" : ""
      }</span></h2><p class="hint">${hint}</p>` +
      (shown.length === 0 ? `<p class="meta lane-empty">nothing here</p>` : shown.map(renderOne).join("")) +
      (more > 0 ? `<a class="lane-more" href="/tasks">+${more} more in the task list</a>` : "") +
      `</section>`
    );
  };

  const plain = (card: BoardCard): string =>
    `<a class="lane-card" href="${card.href}">` +
    `<span class="t">${escape(card.title)}</span>` +
    `<span class="meta">${escape(card.reason)}${
      card.routineName === null ? "" : ` <span class="badge">${escape(card.routineName)}</span>`
    }${chip(card.repo)}</span>` +
    `<span class="mono meta">${escape(card.taskId)}${
      card.stalledSince === null ? "" : ` \u00b7 waiting ${age(card.stalledSince)}`
    }</span></a>`;

  const building = (card: BoardCard): string => {
    const claim = card.claim;
    if (claim === null) return plain(card);
    const minutes = Math.max(1, Math.round((data.now.getTime() - new Date(claim.claimedAt).getTime()) / 60_000));
    const workspace = claim.worktree === null ? null : (claim.worktree.split("/").pop() ?? claim.worktree);
    return (
      `<a class="lane-card building" href="${card.href}">` +
      `<span class="t"><span class="dot dot-ok pulse"></span>${escape(card.title)}</span>` +
      `<span class="meta">${escape(claim.runner)} \u00b7 ${minutes}m elapsed${
        claim.model === null ? " \u00b7 preparing workspace" : ` \u00b7 ${escape(claim.model)}`
      }${card.attempt === null ? "" : ` \u00b7 attempt ${card.attempt}`}${chip(card.repo)}</span>` +
      (claim.branch === null
        ? ""
        : `<span class="mono meta">${escape(claim.branch)}${workspace === null ? "" : ` \u00b7 ${escape(workspace)}`}</span>`) +
      `</a>`
    );
  };

  const doneCards =
    data.done.length === 0
      ? `<p class="meta lane-empty">nothing finished yet</p>`
      : data.done
          .map(row => {
            const pr =
              row.prNumber === null
                ? ""
                : ` <span class="badge badge-open">PR #${row.prNumber}</span>` +
                  (ciRed(row.prNumber) ? ` <span class="badge badge-failed">CI failing</span>` : "");
            return (
              `<a class="lane-card" href="${taskHref(row.taskId)}">` +
              `<span class="t">${escape(row.title)}</span>` +
              `<span class="meta">${row.outcome === "no-change" ? "no change needed" : "built"}${
                row.ranMinutes === null ? "" : ` \u00b7 ran ${row.ranMinutes}m`
              }${row.costUsd === null ? "" : ` \u00b7 $${row.costUsd.toFixed(2)}`}${pr}</span>` +
              `${row.handoff === null ? "" : `<span class="meta">${escape(row.handoff.length > 120 ? row.handoff.slice(0, 120) + "\u2026" : row.handoff)}</span>`}` +
              `<span class="mono meta">${escape(row.taskId)}</span></a>`
            );
          })
          .join("");

  const toggle =
    data.project === null && !data.all
      ? ""
      : `<p class="meta board-scope">` +
        (data.all
          ? (data.project === null
              ? `<strong>all projects</strong>`
              : `<a href="/board">${escape(projectName(data.project))}</a> \u00b7 <strong>all projects</strong>`) +
            ` \u2014 every project this server serves, each card wearing its project`
          : `<strong>${escape(projectName(data.project as string))}</strong> \u00b7 <a href="/board?scope=all">all projects</a>`) +
        `</p>`;

  // The tracks: standing orders as rows under the lanes \u2014 the heartbeat
  // below the one-off pipeline. Only routines with something to say render;
  // the full list lives at /routines.
  const tracksSection =
    data.tracks.length === 0
      ? ""
      : `<section class="tracks"><h2><a href="/routines">routines</a></h2>` +
        `<p class="hint">standing orders \u2014 each dot one firing, oldest left; instances surface above only when they need you</p>` +
        data.tracks.map(track => trackRow(track, data.all)).join("\n") +
        `</section>`;

  return [
    `<h1>board</h1>`,
    `<p class="meta">the whole pipeline at a glance, updating in place \u2014 open the <a href="/">inbox</a> to act on what needs you</p>`,
    toggle,
    `<div class="board">`,
    lane("attention", "needs you", "answer, approve, or repair \u2014 these wait for a person", plain),
    lane("queued", "queued", "ready \u2014 starts when a worker has a free slot", plain),
    lane("waiting", "waiting", "paused on a timer, a dependency, or a missing requirement", plain),
    lane("building", "building", "live \u2014 each card is one agent in its own workspace", building),
    `<section class="lane lane-done"><h2><a href="/done">done recently</a></h2><p class="hint">the last few finished \u2014 the full ledger is under done</p>${doneCards}</section>`,
    `</div>`,
    tracksSection,
  ].join("\n");
}

/** Completed work: one row per done task, its final run and PR attached. */
function donePage(
  chrome: Chrome,
  rows: ReturnType<Store["listCompletedWorkScoped"]>,
  ciRed: (pr: number) => boolean,
): string {
  const list =
    rows.length === 0
      ? `<p class="meta">Nothing completed yet \u2014 finished tasks land here with their final build, cost, and pull request.</p>`
      : rows
          .map(row => {
            const pr =
              row.prNumber === null
                ? row.publicationState === null
                  ? ""
                  : ` <span class="badge">${escape(row.publicationState)}</span>`
                : ` <a href="${escape(row.prUrl ?? "#")}" class="badge badge-open">PR #${row.prNumber}</a>` +
                  (ciRed(row.prNumber) ? ` <span class="badge badge-failed">CI failing</span>` : "");
            return (
              `<div class="card"><p><a href="${taskHref(row.taskId)}"><strong>${escape(row.title)}</strong></a>` +
              `${row.outcome === "no-change" ? ` <span class="badge">no change needed</span>` : ""}${pr}</p>` +
              `${row.handoff === null ? "" : `<p class="meta">${escape(row.handoff.length > 200 ? row.handoff.slice(0, 200) + "\u2026" : row.handoff)}</p>`}` +
              `<p class="meta mono">${escape(row.taskId)} \u00b7 ${escape(when(row.completedAt))}${row.ranMinutes === null ? "" : ` \u00b7 ran ${row.ranMinutes}m`}${row.costUsd === null ? "" : ` \u00b7 $${row.costUsd.toFixed(2)}`}</p></div>`
            );
          })
          .join("\n");
  return shell("done", [
    `<h1>done</h1>`,
    `<p class="hint">completed work \u2014 each with its final build, the agent's conclusion, what it cost, and its pull request</p>`,
    list,
  ].join("\n"), { chrome });
}

/** One routine's board-facing snapshot — the store's routineTracks row. */
type Track = {
  routine: Routine;
  fires: ReturnType<Store["routineFires"]>;
  spend: { costUsd: number; unmeasuredRuns: number };
  blocker: { taskId: string; state: string } | null;
};

const routineHref = (id: number): string => `/routines/${id}`;

function routineStatus(routine: Routine): { text: string; badge: string } {
  const approved = routine.approvedAt !== null && routine.approvedDigest === routine.digest;
  if (routine.paused) return { text: "paused", badge: "badge" };
  if (!approved) {
    return {
      text: routine.approvedAt === null ? "awaiting approval" : "edited — approve again",
      badge: "badge badge-failed",
    };
  }
  return { text: "live", badge: "badge badge-open" };
}

/**
 * The run-history strip: the last firings as dots, oldest on the left like
 * a CI history. Fired slots wear their instance's fate; skipped slots are
 * hollow — recorded absence, not silence.
 */
function trackStrip(fires: Track["fires"]): string {
  const dots = [...fires].reverse().map(fire => {
    const slot = fire.scheduledFor.replace(/^manual:/, "");
    if (fire.outcome === "skipped") {
      return `<span class="fire fire-skip" title="${escape(slot)} — skipped: ${escape(fire.reason ?? "")}"></span>`;
    }
    const state = fire.instanceState;
    const kind =
      state === "done" ? "fire-ok" : state === "failed" || state === "cancelled" ? "fire-bad" : "fire-live";
    const title = `${slot} — ${fire.instanceTaskId ?? "instance"}${state === null ? "" : ` (${state})`}`;
    return fire.instanceTaskId === null
      ? `<span class="fire ${kind}" title="${escape(title)}"></span>`
      : `<a class="fire ${kind}" href="${taskHref(fire.instanceTaskId)}" title="${escape(title)}"></a>`;
  });
  return `<span class="track-strip">${dots.join("")}</span>`;
}

/** One track row — shared by the board's tracks section and /routines. */
function trackRow(track: Track, all: boolean): string {
  const { routine, fires, spend, blocker } = track;
  const status = routineStatus(routine);
  const schedule = parseSchedule(routine.schedule);
  const latest = fires.find(fire => fire.outcome === "fired");
  return (
    `<div class="card track-row">` +
    `<p><a href="${routineHref(routine.id)}"><strong>${escape(routine.name)}</strong></a> ` +
    `<span class="${status.badge}">${escape(status.text)}</span>` +
    `${all ? ` <span class="badge">${escape(projectName(routine.repo))}</span>` : ""}` +
    `<span class="right meta">${escape(schedule === null ? routine.schedule : describeSchedule(schedule))}</span></p>` +
    `<p class="meta">${escape(routine.goal.length > 110 ? routine.goal.slice(0, 110) + "…" : routine.goal)}</p>` +
    `<p>${trackStrip(fires)}` +
    `<span class="right meta">${spend.unmeasuredRuns > 0 ? `<strong>spend unmeasured</strong> · ` : ""}$${spend.costUsd.toFixed(2)} this week${routine.costCeilingUsd === null ? "" : ` of $${routine.costCeilingUsd.toFixed(2)}`}</span></p>` +
    (blocker !== null
      ? `<p class="meta">stopped behind <a href="${taskHref(blocker.taskId)}" class="mono">${escape(blocker.taskId)}</a> (${escape(blocker.state)})</p>`
      : latest?.instanceTaskId !== undefined && latest.instanceTaskId !== null
        ? `<p class="meta">latest: <a href="${taskHref(latest.instanceTaskId)}" class="mono">${escape(latest.instanceTaskId)}</a>${latest.instanceState === null ? "" : ` (${escape(latest.instanceState)})`}</p>`
        : "") +
    `</div>`
  );
}

function routinesPage(chrome: Chrome, tracks: Track[], now: Date): string {
  void now;
  const list =
    tracks.length === 0
      ? `<p class="meta">No standing orders${chrome.project === null ? "" : " in this project"}. File one from the terminal:</p>` +
        `<pre class="recap">nightorders routine add nightly-deps --repo &lt;path&gt; \\\n  --goal "Refresh the lockfile and note anything major" \\\n  --schedule daily:03:30</pre>` +
        `<p class="meta">then approve it here — approving a routine is what lets each firing build without asking.</p>`
      : tracks.map(track => trackRow(track, chrome.project === null)).join("\n");
  return shell("routines", [
    `<h1>routines</h1>`,
    `<p class="hint">standing orders — repeating work that fires on a schedule, each instance building alone in its own workspace; anything needing you bubbles to the inbox</p>`,
    list,
  ].join("\n"), { chrome });
}

function routineScreenPage(chrome: Chrome, data: {
  routine: Routine;
  fires: Track["fires"];
  spend: Track["spend"];
  blocker: Track["blocker"];
  csrf: string;
  nonce: string;
  problem: string | null;
  now: Date;
}): string {
  const { routine, fires } = data;
  const status = routineStatus(routine);
  const approved = routine.approvedAt !== null && routine.approvedDigest === routine.digest;
  const schedule = parseSchedule(routine.schedule);
  const scheduleSaid = schedule === null ? routine.schedule : describeSchedule(schedule);

  const terms =
    `<div class="card">` +
    `<p class="meta">goal</p><p class="recap" style="margin-top:0">${escape(routine.goal)}</p>` +
    `<p class="meta">not this</p><p class="recap" style="margin-top:0">${routine.outOfScope === null ? "<em>no exclusions</em>" : escape(routine.outOfScope)}</p>` +
    `<p class="meta">touches · ${routine.touches.length === 0 ? "anything" : routine.touches.map(one => escape(one)).join(", ")}</p>` +
    `<p class="meta">needs · ${routine.requirements.length === 0 ? "nothing beyond the repository" : routine.requirements.map(one => escape(one)).join(", ")}</p>` +
    `<p class="meta">schedule · ${escape(scheduleSaid)}</p>` +
    `<p class="meta">budget · ${routine.costCeilingUsd === null ? "no ceiling" : `$${routine.costCeilingUsd.toFixed(2)} per rolling 7 days`}</p>` +
    `<p class="meta">one at a time — a firing skips while the previous instance is unfinished</p>` +
    `</div>`;

  const approveForm = approved
    ? ""
    : [
        `<form method="post" action="${routineHref(routine.id)}/approve" class="card approve-form">`,
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
        `<input type="hidden" name="nonce" value="${escape(data.nonce)}">`,
        `<input type="hidden" name="digest" value="${escape(routine.digest)}">`,
        `<p><strong>approve this standing order:</strong></p>`,
        `<p class="recap">Each firing creates a task under exactly the terms above and BUILDS IT WITHOUT ASKING — ${escape(scheduleSaid)}, until you pause it. Questions and failures still reach you like any other work.</p>`,
        `<label>your password, typed again — a signed-in session alone cannot agree to standing work<input type="password" name="token" autocomplete="current-password"></label>`,
        `<button type="submit">approve this routine</button>`,
        `</form>`,
      ].join("\n");

  const verb = (name: string, label: string, danger = false): string =>
    `<form method="post" action="${routineHref(routine.id)}/${name}" class="inline">` +
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
    `<button type="submit"${danger ? ' class="danger"' : ""}>${label}</button></form>`;

  const runNowForm =
    approved && !routine.paused
      ? `<form method="post" action="${routineHref(routine.id)}/run-now" class="inline">` +
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
        `<input type="password" name="token" class="inline" placeholder="your password" aria-label="password for run now" style="width:11rem"> ` +
        `<button type="submit">run now</button></form>`
      : "";
  const acts =
    `<div class="card">` +
    (routine.paused ? verb("resume", "resume") : verb("pause", "pause")) +
    (runNowForm === "" ? "" : " " + runNowForm) +
    `<p class="meta">${routine.paused ? "resuming fires again at the next due slot" : "pausing stops firing instantly; a running instance finishes"}${runNowForm === "" ? "" : " · run now spawns an extra instance without touching the schedule — spend outside the schedule takes your password again"}</p>` +
    `</div>`;

  const ledger =
    fires.length === 0
      ? `<p class="meta">No firings yet${approved && routine.nextFireAt !== null ? ` — first at ${escape(when(routine.nextFireAt))}` : ""}.</p>`
      : fires
          .map(fire => {
            const said =
              fire.outcome === "fired"
                ? fire.instanceTaskId === null
                  ? "fired"
                  : `<a href="${taskHref(fire.instanceTaskId)}" class="mono">${escape(fire.instanceTaskId)}</a>${fire.instanceState === null ? "" : ` <span class="badge badge-${escape(fire.instanceState)}">${escape(fire.instanceState)}</span>`}`
                : `<span class="meta">skipped — ${escape(fire.reason ?? "")}</span>`;
            const slot = fire.scheduledFor.replace(/^manual:/, "");
            return `<p class="row">${said}<span class="right meta mono">${fire.reason === "manual" ? "run now · " : ""}${escape(when(slot))}</span></p>`;
          })
          .join("\n");

  return shell(`routine · ${routine.name}`, [
    `<h1>${escape(routine.name)} <span class="${status.badge}">${escape(status.text)}</span>` +
      `<span class="meta"> · ${escape(projectName(routine.repo))}</span></h1>`,
    data.problem === null ? "" : `<div class="problem">${escape(data.problem)}</div>`,
    `<p>${trackStrip(fires)}<span class="right meta">$${data.spend.costUsd.toFixed(2)} this week${data.spend.unmeasuredRuns > 0 ? " · <strong>some spend unmeasured</strong>" : ""}</span></p>`,
    data.blocker !== null
      ? `<div class="problem">stopped behind <a href="${taskHref(data.blocker.taskId)}" class="mono">${escape(data.blocker.taskId)}</a> (${escape(data.blocker.state)}) — the track resumes when it finishes or is cancelled</div>`
      : "",
    approved && !routine.paused && routine.nextFireAt !== null
      ? `<p class="meta">next fire ${escape(when(routine.nextFireAt))}</p>`
      : "",
    "<h2>the standing order</h2>",
    terms,
    approveForm,
    "<h2>acts</h2>",
    acts,
    "<h2>firings</h2>",
    ledger,
  ].join("\n"), { chrome });
}

function homePage(chrome: Chrome, data: {
  csrf: string;
  taskCount: number;
  repo: string | null;
  building: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null }[];
  runners: Runner[];
  worktrees: WorktreeRow[];
  episode: { id: number; startedAt: string; endedAt: string | null; ticks: number; built: number; broke: number } | null;
  summary: ReturnType<typeof tally<Run & { taskId: string }>>;
  decisions: (Decision & { taskId: string })[];
  incidents: (Incident & { taskId: string })[];
  stranded: { id: string; blockedBy: string[] }[];
  gaps: Gap[] | null;
  outboxPending: number;
  settings: boolean;
  now: Date;
}): string {
  const { summary } = data;
  // The night's harvest is the page's reason to exist — strong figures in a
  // sentence, colored by what they mean, never a metric-card grid.
  const ledger =
    `<p class="ledger"><span class="good"><b>${summary.built.length}</b> built</span> · ` +
    `<span${summary.failed.length > 0 ? ' class="bad"' : ""}><b>${summary.failed.length}</b> failed</span> · ` +
    `<b>${summary.refused.length}</b> refused` +
    (summary.cutDown.length > 0 ? ` · <span class="bad"><b>${summary.cutDown.length}</b> cut down mid-flight</span>` : "") +
    `</p>`;

  const decide =
    data.decisions.length === 0
      ? `<p class="meta">Nothing waits on you. No decisions were parked.</p>`
      : data.decisions
          .map(
            decision =>
              `<a class="decide-card" href="/d/${decision.id}">` +
              `<p class="q">${escape(decision.question)}</p>` +
              `<span class="mono meta">${escape(decision.taskId)}</span>` +
              `${isOverdue(decision, data.now) ? ` <span class="badge badge-overdue">overdue</span>` : ""}` +
              `</a>`,
          )
          .join("\n");

  const incidents =
    data.incidents.length === 0
      ? ""
      : `<h2>incidents</h2><p class="hint">builds that stopped and need a person — resolve here, or open the task to retry it</p>` +
        data.incidents
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> — ${escape(one.kind)}` +
              `<span class="right"><form method="post" action="/i/${one.id}/resolve" class="inline">` +
              `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
              `<button type="submit">resolve</button></form></span></p>`,
          )
          .join("\n");

  const stranded =
    data.stranded.length === 0
      ? ""
      : `<h2>blocked tasks</h2><p class="hint">queued behind something that failed — fix or retry the blocker and these start</p>` +
        data.stranded
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.id)}">${escape(one.id)}</a> waits on ${one.blockedBy
                .map(blocker => `<a href="${taskHref(blocker)}">${escape(blocker)}</a>`)
                .join(", ")} <span class="right meta">open the blocker to retry it</span></p>`,
          )
          .join("\n");

  const gaps =
    data.gaps === null
      ? ""
      : data.gaps.length === 0
        ? ""
        : `<h2>missing requirements</h2><p class="hint">tools or credentials builds need — checked before any money is spent</p>` +
          data.gaps
            .map(gap => `<p class="row"><a href="/caps">${escape(gap.key)}</a> — ${escape(gap.state)}<span class="right meta">how to fix →</span></p>`)
            .join("\n") +
          ``;

  // Live at the fidelity the moment deserves: fast while something builds,
  // gentle when the page is just a briefing. GET-only, so refresh is safe.
  const refresh = data.building.length > 0 ? 10 : 60;

  // BUILDING RIGHT NOW: each live claim as a pulsing card — the one moment
  // an operator actually watches this page, so it re-renders itself.
  const building =
    data.building.length === 0
      ? ""
      : `<h2>building now</h2><p class="hint">live builds — this page refreshes itself every 10 seconds while anything runs</p><div class="cards">` +
        data.building
          .map(
            claim =>
              `<a class="stat-card" href="${taskHref(claim.taskId)}" style="text-decoration:none">` +
              `<span class="k"><span class="dot dot-ok pulse"></span>${escape(claim.taskId)}</span>` +
              `<span class="v">${escape(claim.runner)} \u00b7 ${Math.max(1, Math.round((data.now.getTime() - new Date(claim.claimedAt).getTime()) / 60_000))}m elapsed${claim.model === null ? "" : ` \u00b7 ${escape(claim.model)}`}</span></a>`,
          )
          .join("") +
        `</div>`;

  // THE FLEET: runners by heartbeat age, worktrees by lease state, the watch.
  const nowMs = data.now.getTime();
  const runnerCards = data.runners
    .filter(one => one.retiredAt === null)
    .map(one => {
      const age = nowMs - new Date(one.heartbeatAt).getTime();
      const dot = age < 5 * 60_000 ? "dot-ok" : age < 60 * 60_000 ? "dot-warn" : "dot-off";
      const said = age < 5 * 60_000 ? "alive" : age < 60 * 60_000 ? `quiet ${Math.round(age / 60_000)}m` : "not heard from";
      const busy = data.building.filter(claim => claim.runner === one.name).length;
      return (
        `<div class="stat-card"><span class="k"><span class="dot ${dot}"></span>${escape(one.name)}</span>` +
        `<span class="v">worker \u00b7 ${said} \u00b7 ${busy}/${one.capacity} building</span></div>`
      );
    });
  const worktreeCards = data.worktrees.map(tree => {
    const leased = tree.leasedAt !== null && tree.releasedAt === null;
    const dot = leased ? "dot-ok" : tree.verified ? "dot-off" : "dot-warn";
    const state = leased ? "building" : tree.verified ? "free" : "needs review";
    const name = tree.path.split("/").pop() ?? tree.path;
    return (
      `<div class="stat-card"><span class="k"><span class="dot ${dot}${leased ? " pulse" : ""}"></span><span class="mono">${escape(name)}</span></span>` +
      `<span class="v">workspace \u00b7 ${escape(tree.branch)} \u00b7 ${state}</span></div>`
    );
  });
  const watchCard =
    data.episode === null
      ? ""
      : `<div class="stat-card"><span class="k"><span class="dot ${data.episode.endedAt === null ? "dot-ok pulse" : "dot-off"}"></span>background service</span>` +
        `<span class="v">${
          data.episode.endedAt === null
            ? `running since ${escape(when(data.episode.startedAt))}`
            : `last window: ${data.episode.built} built, ${data.episode.broke} broke \u00b7 ended ${escape(when(data.episode.endedAt))}`
        }</span></div>`;
  const fleetCards = [...runnerCards, watchCard, ...worktreeCards].filter(one => one !== "");
  const fleet =
    fleetCards.length === 0
      ? `<h2>system status</h2><p class="hint">no worker machine registered yet \u2014 <code>nightorders runner register &lt;name&gt;</code>, then <code>nightorders daemon install</code> keeps the background service running</p>`
      : `<h2>system status</h2><p class="hint">workers execute builds; the background service starts them; each workspace is a temporary copy of your repo for one task</p><div class="cards">${fleetCards.join("")}</div>`;

  const startHere =
    data.taskCount === 0
      ? [
          `<div class="card">`,
          `<p><strong>Nothing is queued yet — here is the whole loop:</strong></p>`,
          `<p>1. <a href="/tasks">Add a task</a> — plain words for work you want done${data.repo === null ? "" : ` in <span class="mono">${escape(data.repo)}</span>`}.</p>`,
          `<p>2. Open it and write its scope — the goal, and what it must not become. Approve exactly that.</p>`,
          `<p>3. Leave <code>nightorders watch</code> (or the daemon) running. Approved tasks build unattended, each on its own branch.</p>`,
          `<p class="meta">When an agent is unsure it stops and asks — those questions land here, under \u201cwaiting on you\u201d.</p>`,
          `</div>`,
        ].join("\n")
      : "";

  return shell("activity", [
    `<h1>activity</h1>`,
    data.repo === null
      ? ""
      : `<p class="meta"><strong>${escape(projectName(data.repo))}</strong> — the last 24 hours, honestly labeled: a rolling window, whatever your hours are</p>`,
    startHere,
    ledger,
    `<p class="meta">spend: ${escape(consoleSpend(summary))}</p>`,
    data.outboxPending > 0 ? `<p class="meta">outbox: ${data.outboxPending} pending delivery</p>` : "",
    building,
    `<h2>needs your decision</h2><p class="hint">an agent stopped mid-build to ask — nothing proceeds until you answer</p>`,
    decide,
    incidents,
    stranded,
    gaps,
    fleet,
  ].join("\n"), { chrome, refreshSeconds: refresh });
}

function tasksPage(
  chrome: Chrome,
  tasks: Task[],
  state: TaskState | null,
  csrf: string,
  problem: string | null,
  repo: string | null = null,
): string {
  const filters = TASK_STATES.map(
    one => (one === state ? `<strong>${one}</strong>` : `<a href="/tasks?state=${one}">${one}</a>`),
  ).join(" · ");
  const rows =
    tasks.length === 0
      ? `<p class="meta">${
          state === null
            ? "The queue is empty \u2014 add the first task below. It builds once you approve its scope."
            : `Nothing is ${escape(state)}.`
        }</p>`
      : tasks
          .map(
            task =>
              `<a class="row" href="${taskHref(task.id)}"><span class="mono">${escape(task.id)}</span> ` +
              `${escape(task.title)} <span class="right badge badge-${escape(task.state)}">${escape(task.state)}</span></a>`,
          )
          .join("\n");
  return shell("tasks", [
    "<h1>tasks</h1>",
    `<p class="meta">work you want done${repo === null ? "" : ` in <span class="mono">${escape(repo)}</span>`} \u2014 a task builds unattended only after its scope is approved; open one to write or approve its scope</p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    `<p class="meta">filter: <a href="/tasks">all</a> · ${filters}</p>`,
    rows,
    `<h2>add a task</h2>`,
    `<form method="post" action="/tasks/add" class="card">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<label>id<input type="text" name="id" placeholder="fix-payout-guard"></label>`,
    `<label>title<input type="text" name="title"></label>`,
    `<label>repo <span class="meta">(optional)</span><input type="text" name="repo"></label>`,
    `<label>goal <span class="meta">(optional — creates an unapproved scope)</span><textarea name="goal" rows="3"></textarea></label>`,
    `<button type="submit">add</button>`,
    `</form></details>`,
  ].join("\n"), { chrome });
}

function projectsPage(
  chrome: Chrome,
  recent: { path: string; name: string; lastOpenedAt: string }[],
  candidates: string[],
  open: string | null,
  csrf: string,
  problem: string | null,
  unscopedMode: boolean,
): string {
  const openForm = (path: string, label: string): string =>
    [
      `<form method="post" action="/projects/open" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
      `<input type="hidden" name="path" value="${escape(path)}">`,
      `<button type="submit">${escape(label)}</button>`,
      `</form>`,
    ].join("");

  const rows = (paths: { path: string; name: string; note: string }[]): string =>
    paths
      .map(
        one =>
          `<p class="row"><strong>${escape(one.name)}</strong> <span class="mono meta">${escape(one.path)}</span>` +
          `${one.note === "" ? "" : ` <span class="meta">${escape(one.note)}</span>`}` +
          `<span class="right">${
            open !== null && open === one.path
              ? `<span class="badge badge-done">open</span>`
              : openForm(one.path, "open")
          }</span></p>`,
      )
      .join("\n");

  const recentRows = recent.map(one => ({ path: one.path, name: one.name, note: `last opened ${when(one.lastOpenedAt)}` }));
  const candidateRows = candidates.map(path => ({ path, name: projectName(path), note: "seen in the queue" }));

  return shell("projects", [
    `<h1>projects</h1>`,
    `<p class="meta">a project is a git repository this server was allowed to serve \u2014 open one to see its queue, its board, and its runs</p>`,
    unscopedMode
      ? `<p class="meta">this server was started without a project ceiling, so every path in the queue is visible \u2014 start serve with <code>--repo</code> or <code>--project-root</code> to scope it</p>`
      : "",
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    recentRows.length === 0 && candidateRows.length === 0
      ? `<div class="card"><p><strong>Nothing to open yet.</strong></p><p class="meta">Type the path of a git repository below \u2014 opening it registers it here for next time.</p></div>`
      : "",
    recentRows.length > 0 ? `<h2>recent</h2>${rows(recentRows)}` : "",
    candidateRows.length > 0 ? `<h2>available</h2>${rows(candidateRows)}` : "",
    `<h2>open by path</h2>`,
    `<form method="post" action="/projects/open" class="card">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<label>path on this server<input type="text" name="path" placeholder="/Users/you/code/your-repo"></label>`,
    `<button type="submit">open project</button>`,
    `</form>`,
  ].join("\n"), { chrome });
}

/**
 * Creating work is the product's first verb, so it gets a whole calm page:
 * a title, the goal that becomes the scope draft, and the project it lands
 * in — then straight to the approve card, which is the aha the flow serves.
 */
function newTaskPage(
  chrome: Chrome,
  project: string | null,
  csrf: string,
  projectRevision: number,
  problem: string | null,
): string {
  return shell("new task", [
    `<h1>new task</h1>`,
    `<p class="meta">plain words for work you want done${
      project === null ? "" : ` in <span class="mono">${escape(project)}</span>`
    } — it builds unattended once you approve its scope on the next screen</p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    `<form method="post" action="/tasks/add" class="card">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<input type="hidden" name="projectRevision" value="${projectRevision}">`,
    `<label>title<input type="text" name="title" placeholder="Add a sliding-window rate limiter to the public API"></label>`,
    `<label>goal <span class="meta">(becomes the scope you approve — what success looks like)</span>` +
      `<textarea name="goal" rows="4" placeholder="Sliding-window rate limiting on /api/public/*, returning 429 with Retry-After"></textarea></label>`,
    `<label>id <span class="meta">(optional — made from the title when blank)</span><input type="text" name="id"></label>`,
    `<button type="submit">create task</button>`,
    `</form>`,
  ].join("\n"), { chrome });
}

function taskPage(chrome: Chrome, data: {
  task: Task;
  strikes: number;
  plan: "requested" | "drafted" | null;
  planDocument: string | null;
  repo: string | null;
  holds: Hold[];
  claimed: boolean;
  scope: Scope | null;
  runs: Run[];
  decisions: Decision[];
  incidents: Incident[];
  csrf: string;
  nonce: string;
  problem: string | null;
  now: Date;
}): string {
  const { task, scope } = data;
  const act = (verb: string, label: string, extra = ""): string =>
    [
      `<form method="post" action="${taskHref(task.id)}/${verb}" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      extra,
      `<button type="submit">${escape(label)}</button>`,
      `</form>`,
    ].join("");

  const holds =
    data.holds.length === 0
      ? ""
      : `<h2>holds</h2>` +
        data.holds
          .map(
            hold =>
              `<p class="row">${escape(hold.ownerKind)} — ${escape(hold.reason)}` +
              `${hold.until === null ? "" : ` <span class="meta">until ${escape(when(hold.until))}</span>`}</p>`,
          )
          .join("\n") +
        `<p class="meta">only the operator hold lifts from here; decisions, incidents, and backoff lift themselves</p>`;

  const approval = approvalOf(scope);
  const scopeCard =
    scope === null
      ? `<p class="meta">no scope proposed — nothing builds this until one is approved</p>`
      : [
          `<div class="card">`,
          `<p><strong>goal</strong></p><p class="recap">${escape(scope.goal)}</p>`,
          scope.outOfScope === null ? "" : `<p><strong>not this</strong></p><p class="recap">${escape(scope.outOfScope)}</p>`,
          scope.touches.length === 0 ? "" : `<p><strong>touches</strong> ${scope.touches.map(one => escape(one)).join(", ")}</p>`,
          `<p class="meta">digest <span class="mono">${escape(scope.digest)}</span></p>`,
          approval.approved
            ? `<p class="meta">approved by ${escape(approval.by)} at ${escape(approval.at)}</p>`
            : `<p class="meta">not approved${approval.reason === "changed" ? " — approved once, then rewritten" : ""}</p>`,
          `</div>`,
        ].join("\n");

  // The plan a planner drafted, when one exists: rendered inert above the
  // approval it proposes. The scope stays the contract; this is the road.
  const planCard =
    data.planDocument === null
      ? data.plan === "requested"
        ? `<div class="card"><p><strong>planning requested</strong></p><p class="meta">a planner will read the repository and propose a scope \u2014 its questions reach you like any decision</p></div>`
        : ""
      : [
          `<div class="card">`,
          `<p><strong>the plan</strong> <span class="meta">drafted by a planning session \u2014 review it, then approve the scope it proposes</span></p>`,
          `<pre class="recap plan-doc">${escape(data.planDocument)}</pre>`,
          `</div>`,
        ].join("\n");

  // The approval form restates every field the digest binds — an operator
  // approves what is on this form, not what is elsewhere on the page — and
  // requires the token typed again. The session got you here; only the
  // token agrees.
  const approveForm =
    scope === null || approval.approved
      ? ""
      : [
          `<form method="post" action="${taskHref(task.id)}/approve" class="card approve-form">`,
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          `<input type="hidden" name="nonce" value="${escape(data.nonce)}">`,
          `<input type="hidden" name="digest" value="${escape(scope.digest)}">`,
          `<p><strong>approve exactly this:</strong></p>`,
          `<p class="meta">goal</p><p class="recap" style="margin-top:0">${escape(scope.goal)}</p>`,
          `<p class="meta">not this</p><p class="recap" style="margin-top:0">${scope.outOfScope === null ? "<em>no exclusions</em>" : escape(scope.outOfScope)}</p>`,
          `<p class="meta">touches \u00b7 ${scope.touches.length === 0 ? "anything" : scope.touches.map(one => escape(one)).join(", ")}</p>`,
          `<label>your password, typed again \u2014 a signed-in session alone cannot agree to work<input type="password" name="token" autocomplete="current-password"></label>`,
          `<button type="submit">approve this scope</button>`,
          `</form>`,
        ].join("\n");

  const scopeForm = [
    `<details><summary>${scope === null ? "propose a scope" : "edit the scope"}${
      approval.approved ? " (editing voids the approval)" : ""
    }</summary>`,
    `<form method="post" action="${taskHref(task.id)}/scope">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    `<input type="hidden" name="sawDigest" value="${escape(scope?.digest ?? "")}">`,
    `<label>goal<textarea name="goal" rows="3">${escape(scope?.goal ?? "")}</textarea></label>`,
    `<label>not this<textarea name="not" rows="2">${escape(scope?.outOfScope ?? "")}</textarea></label>`,
    `<label>touches <span class="meta">(one per line)</span><textarea name="touches" rows="2">${escape(
      (scope?.touches ?? []).join("\n"),
    )}</textarea></label>`,
    `<button type="submit">save scope</button>`,
    `</form></details>`,
  ].join("\n");

  const runs =
    data.runs.length === 0
      ? ""
      : `<h2>runs</h2>` +
        data.runs
          .map(
            run =>
              `<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> ` +
              `<span class="badge badge-${escape(run.outcome ?? "cut")}">${escape(run.outcome ?? "never finished")}</span>` +
              `${run.reason === null ? "" : ` <span class="meta">${escape(run.reason)}</span>`}` +
              `<span class="right meta mono">${escape(when(run.startedAt))}</span></p>`,
          )
          .join("\n");

  const decisions =
    data.decisions.length === 0
      ? ""
      : `<h2>decisions</h2>` +
        data.decisions
          .map(
            decision =>
              `<p class="row"><a href="/d/${decision.id}">${escape(decision.question)}</a> ` +
              `<span class="meta">${escape(decision.state)}${isOverdue(decision, data.now) ? " · overdue" : ""}</span></p>`,
          )
          .join("\n");

  const incidents =
    data.incidents.length === 0
      ? ""
      : `<h2>incidents</h2>` +
        data.incidents
          .map(one =>
            one.resolvedAt === null
              ? `<p class="row">${escape(one.kind)} ` +
                `<form method="post" action="/i/${one.id}/resolve" class="inline">` +
                `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
                `<button type="submit">resolve</button></form></p>`
              : `<p class="row meta">${escape(one.kind)} — resolved by ${escape(one.resolvedBy ?? "?")}</p>`,
          )
          .join("\n");

  const stalled =
    task.state === "failed" || data.incidents.some(one => one.resolvedAt === null);

  const acts = [
    `<h2>acts</h2>`,
    data.claimed
      ? `<p class="meta">a runner holds a live claim right now — holds prevent the <em>next</em> dispatch; cancel and requeue wait for the claim</p>`
      : "",
    `<div class="card">`,
    data.plan === null && !approval.approved && !data.claimed && task.state === "queued"
      ? act("plan", "plan first")
      : "",
    data.plan === null && !approval.approved && !data.claimed && task.state === "queued"
      ? `<p class="meta">plan first sends an agent to read the repository, ask you questions, and propose a scope \u2014 nothing builds until you approve it</p>`
      : "",
    act("hold", "hold", `<input type="text" name="reason" class="inline" placeholder="why" aria-label="hold reason" style="width:12rem">`),
    data.holds.some(hold => hold.ownerKind === "operator") ? act("unhold", "unhold") : "",
    stalled ? act("requeue", "requeue") : "",
    stalled
      ? `<p class="meta">requeue resolves the incidents, resets the strikes, and puts the task back in the queue</p>`
      : "",
    `</div>`,
    // Cancel gets the same ceremony as an irreversible answer: armed behind
    // one deliberate tap, styled as the destructive act it is.
    task.state === "queued" || task.state === "running" || task.state === "failed"
      ? [
          `<details class="arm-danger"><summary>cancel this task — tap to arm</summary>`,
          `<form method="post" action="${taskHref(task.id)}/cancel">`,
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          `<button type="submit" class="danger">cancel ${escape(task.id)}</button>`,
          `</form></details>`,
        ].join("")
      : "",
  ].join("\n");

  return shell(`task \u00b7 ${task.id}`, [
    `<h1>${escape(task.id)} <span class="badge badge-${escape(task.state)}">${escape(task.state)}</span>` +
      `<span class="meta">${data.strikes > 0 ? ` ${data.strikes} strike(s)` : ""}` +
      `${data.repo === null ? "" : ` · ${escape(data.repo)}`}</span></h1>`,
    `<p>${escape(task.title)}</p>`,
    data.problem === null ? "" : `<div class="problem">${escape(data.problem)}</div>`,
    "<h2>scope</h2>",
    scopeCard,
    planCard,
    approveForm,
    scopeForm,
    holds,
    acts,
    runs,
    decisions,
    incidents,
  ].join("\n"), { chrome });
}

function runsPage(chrome: Chrome, rows: (Run & { taskId: string })[], nextCursor: number | null): string {
  const list =
    rows.length === 0
      ? `<p class="meta">No runs yet \u2014 a run is one unattended build attempt; they appear once the watch dispatches an approved task.</p>`
      : rows
          .map(
            run =>
              `<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> ` +
              `<a href="${taskHref(run.taskId)}" class="mono">${escape(run.taskId)}</a> ` +
              `<span class="badge badge-${escape(run.outcome ?? "cut")}">${escape(run.outcome ?? "never finished")}</span>` +
              `<span class="right meta mono">${escape(when(run.startedAt))}` +
              `${run.costUsd === null ? "" : ` \u00b7 $${run.costUsd.toFixed(2)}`}</span></p>`,
          )
          .join("\n");
  const older = nextCursor === null ? "" : `<p><a href="/runs?before=${nextCursor}">older →</a></p>`;
  return shell("builds", [`<h1>builds</h1><p class="hint">one build = one attempt by an agent to complete a task, on its own branch</p>`, list, older].join("\n"), { chrome });
}

function runPage(chrome: Chrome, run: Run, taskId: string, artifacts: Artifact[]): string {
  // [label, value, mono?] — identifiers and figures read in the data face.
  const facts: [string, string | null, boolean?][] = [
    ["task", taskId, true],
    ["role", run.role],
    ["outcome", run.outcome ?? "never finished"],
    ["reason", run.reason],
    ["runner", run.runner, true],
    ["branch", run.branch, true],
    ["model", run.model, true],
    ["base", run.baseRevision, true],
    ["head", run.headRevision, true],
    ["started", when(run.startedAt), true],
    ["finished", when(run.finishedAt), true],
    ["provider started", when(run.providerStartedAt), true],
    ["tokens in", run.tokensIn === null ? null : run.tokensIn.toLocaleString(), true],
    ["tokens out", run.tokensOut === null ? null : run.tokensOut.toLocaleString(), true],
    ["cost", run.costUsd === null ? null : `$${run.costUsd.toFixed(2)}`, true],
  ];
  const rows = facts
    .filter((fact): fact is [string, string, boolean?] => fact[1] !== null && fact[1] !== "")
    .map(
      ([label, value, mono]) =>
        `<p class="row"><span class="meta" style="min-width:8.5rem">${escape(label)}</span> ` +
        `<span${mono === true ? ` class="mono"` : ""}>${escape(value)}</span></p>`,
    )
    .join("\n");
  const handoff =
    run.handoff === null
      ? ""
      : `<h2>conclusion</h2><p class="recap">${escape(run.handoff)}</p>`;
  const evidence =
    artifacts.length === 0
      ? ""
      : `<div class="evidence"><strong>evidence</strong>` +
        artifacts
          .map(
            artifact =>
              `<a href="/r/${run.id}/evidence/${artifact.id}">${escape(artifact.kind)}` +
              `${artifact.truncated ? " (truncated)" : ""} · ${artifact.bytesStored} bytes</a>`,
          )
          .join("\n") +
        "</div>";
  return shell(`build #${run.id}`, [
    `<h1>build #${run.id} <span class="meta"><a href="${taskHref(taskId)}">${escape(taskId)}</a></span></h1>`,
    rows,
    handoff,
    evidence,
  ].join("\n"), { chrome });
}

function capsPage(chrome: Chrome, caps: Capability[] | null, gaps: Gap[], repo: string, now?: Date): string {
  if (caps === null) {
    return shell("requirements", [
      `<h1>requirements</h1>`,
      `<p class="meta">open a project to see its requirements — <a href="/projects">projects</a></p>`,
    ].join("\n"), { chrome });
  }
  const list =
    caps.length === 0
      ? "<p>Nothing recorded.</p>"
      : caps
          .map(
            capability =>
              `<p class="row">${escape(capability.kind)}:${escape(capability.name)} — ` +
              `${escape(describeCapability(capability, now ?? new Date()))}</p>`,
          )
          .join("\n");
  const blocked =
    gaps.length === 0
      ? `<p class="meta">no gaps — everything recorded is verified</p>`
      : gaps
          .map(
            gap =>
              `<div class="card"><p>${escape(gap.key)} — ${escape(gap.state)}</p>` +
              `<p class="meta">${
                gap.unblocks.length > 0
                  ? `fills → ${gap.unblocks.length} task(s) start: ${gap.unblocks.map(one => escape(one)).join(", ")}`
                  : gap.alsoBlocks.length > 0
                    ? `part of what holds: ${gap.alsoBlocks.map(one => escape(one)).join(", ")}`
                    : "nothing queued needs it yet"
              }</p>` +
              `<p class="meta">verify: ${escape(gap.verify)}</p>` +
              `<p class="meta">${escape(gap.instructions)}</p></div>`,
          )
          .join("\n");
  return shell("requirements", [
    `<h1>requirements</h1>`,
    `<p class="hint">tools and credentials builds need — each is probed on the worker before any build spends money; values never leave your machine</p>`,
    list,
    `<h2>missing, ranked by what filling them frees</h2>`,
    blocked,
    `<p class="meta">read-only: probes are operator-authored shell, and a web button that runs shell is a different review</p>`,
  ].join("\n"), { chrome });
}

function settingsPage(
  chrome: Chrome,
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
  ].join("\n"), { chrome });
}

function decisionPage(
  chrome: Chrome,
  decision: Decision,
  taskId: string,
  artifacts: Artifact[],
  who: Who,
  now: Date,
): string {
  const csrf = who.via === "cookie" ? who.session.csrf : "";
  const options = decision.options
    .map(option => {
      const recommended = option.id === decision.recommendation;
      // The consequence reads BEFORE the button that buys it, and the
      // recommendation is a visible ring, not a parenthetical — a thumb at
      // 7am finds the default without reading every card.
      const inner = [
        `<form class="option${recommended ? " recommended" : ""}" method="post" action="/d/${decision.id}/answer">`,
        `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
        `<input type="hidden" name="choice" value="${escape(option.id)}">`,
        ...(option.reversible ? [] : [`<input type="hidden" name="confirm" value="yes">`]),
        recommended ? `<p class="meta" style="margin:0 0 .375rem"><span class="badge">recommended</span></p>` : "",
        `<p class="consequence">${escape(option.consequence)}</p>`,
        `<button type="submit">${escape(option.label)}${option.reversible ? "" : ` <span class="badge badge-overdue">irreversible</span>`}</button>`,
        `<input type="text" name="note" placeholder="optional note — travels with this answer" aria-label="optional note">`,
        `</form>`,
      ].join("\n");
      // An irreversible option hides its button behind one deliberate extra
      // tap — no script, just <details>. The server independently requires
      // the confirm field either way.
      return option.reversible
        ? inner
        : `<details class="arm-danger"><summary>${escape(option.label)} — irreversible, tap to arm</summary>${inner}</details>`;
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

  return shell(`decide \u00b7 ${taskId}`, [
    `<h1>${escape(taskId)} <span class="badge badge-${escape(decision.state)}">${escape(decision.state)}</span>${
      isOverdue(decision, now) ? ` <span class="badge badge-overdue">overdue</span>` : ""
    }${decision.deadline === null ? "" : ` <span class="meta">deadline ${escape(decision.deadline)}</span>`}</h1>`,
    `<div class="recap">${escape(decision.recap)}</div>`,
    `<div class="question">${escape(decision.question)}</div>`,
    decision.state === "answered" ? answered : options,
    evidence,
    `<p class="meta"><a href="/">← everything waiting</a></p>`,
  ].join("\n"), { chrome });
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
