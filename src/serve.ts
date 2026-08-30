/**
 * The web console (§7, grown per the console review): the whole built-in
 * queue, visible and operable from a phone. `standing-orders serve` — node:http,
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
import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync as rmFileSync, writeFileSync as writeFsFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { TEMPLATES, templateByName } from "./templates.js";
import { EVIDENCE_CAPS, readVerifiedArtifact, storeEvidence, writeEvidenceFile, scanForSecrets } from "./evidence.js";
import { PRICED_BUILD_MODELS } from "./pricing.js";
import {
  buildDataDocument,
  composeRequest,
  credentialKeyOf,
  parseAssistantEnvelope,
  performChatRequest,
  priceOf,
  priceForConfig,
  worstCaseForPrice,
  settleForPrice,
  fetchOpenRouterCatalog,
  plausibleChatKey,
  PRICED_MODELS,
  settleMicrousd,
  worstCaseMicrousd,
  CHAT_KEY_ENV,
  TURN_WALL_CLOCK_MS,
  type ChatDraft,
} from "./converse.js";
import { fileTaskProposal, fileRoutineProposal } from "./proposal.js";
import {
  type Artifact,
  type DiffComment,
  type ExternalMirror,
  type Publication,
  type Capability,
  type Decision,
  type Hold,
  type Incident,
  type Run,
  type Store,
  type Task,
  type TaskState,
  type WorktreeRow,
  type SessionTurn,
} from "./store.js";
import { attendedLivenessState } from "./liveness.js";
import {
  approvalOf,
  approve as approveScope,
  attendedDigestOf,
  attendedTermsJson,
  authenticateApprover,
  canonicalProfileJson,
  chainFromJson,
  profileDigestOf,
  proposeGuarded,
  type AttendedTerms,
  type Scope,
} from "./scope.js";
import { hasForbiddenControls, validateNote } from "./decision.js";
import { observeWorktree, parseBaseTreeSnapshot, aggregateNewNames, PEEK_LIMITS } from "./peek.js";
import { readLiveWindow } from "./live.js";
import { dirname } from "node:path";
import { loadOrCreateVapidKeys, validatePushEndpoint } from "./push.js";
import { parseGithubRepo, previewGithubRepo, cloneGithubRepo, isLargeRepo } from "./onboard.js";
import { verifiedAuthor } from "./store.js";
import { updateRepos, addRepos } from "./repos.js";
import { run as execRun } from "./exec.js";

/** A user agent, reduced to safe display words — never echoed raw. */
function oneLineUa(raw: string | string[] | undefined): string {
  const text = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  if (/iphone|ipad/i.test(text)) return "an iPhone or iPad";
  if (/android/i.test(text)) return "an Android device";
  if (/mac os/i.test(text)) return "a Mac";
  if (/windows/i.test(text)) return "a Windows machine";
  return "a device";
}
import { buildPickView, computePickPlan, finalizeContestPick, abandonContest, nonceHashOf, pickTupleDigest, planTournament, planComparison, contestNoun, jointApprovalDigest } from "./contest.js";
import type { AgentView } from "./contest.js";
import type { Runner } from "./runner.js";
import { register as registerRunner, isAlive as runnerAlive } from "./runner.js";
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
import { classify, holdOwnerWords } from "./board.js";
import type { BoardCard } from "./board.js";
import { approveRoutine, describeSchedule, fireRoutine, parseSchedule, routineDigestOf, validateRoutineTerms, ROUTINE_NAME, type RoutineTerms } from "./routine.js";
import { effectivePrimary, isMessagingChannel, savePrimary } from "./webhooks.js";
import { resolvePhaseAgent, INSTALLATION_SCOPE } from "./agentconfig.js";
import { isProviderId, reportsCost, PROVIDER_IDS } from "./provider.js";
import { authenticateAccount, hashPassword, modeFilingCoverage } from "./scope.js";
import { modeTermsFromJson, modeWords, presetTerms, modeTermsJson, modeDigestOf, MODE_MAX_DAYS, type ModeName, type ModeTerms } from "./modes.js";
import { PROVIDER_KEY_ENV, SUBSCRIPTION_CAPABLE, clearProviderKey, keyStatus, plausibleKey, readAuthMode, saveProviderKey, setAuthMode, verifyProviderKey, verdictWords, type AuthMode } from "./keys.js";
import type { Routine, ChatTurn, ChatProviderId, Contest, TournamentTerms, SteerNote, PushSubscription } from "./store.js";
import { loadBotToken, redactToken, saveBotToken, TOKEN_ENV, type TokenSource } from "./telegram.js";

export type ServeOptions = {
  store: Store;
  evidenceRoot: string;
  clock?: () => Date;
  /**
   * The console's canonical https origin, when TLS terminates in front
   * (arc 3 finding 2/16): EXACTLY an origin — no path, query, credentials.
   * The one trust anchor for secure-context features: it joins the allowed
   * hosts, its origin authorizes POSTs, cookies turn Secure, and the
   * install/push cards light up. X-Forwarded-* is never consulted.
   */
  publicUrl?: string;
  /** Where repos.json lives — every enrollment locks exactly this file. */
  registryPath?: string;
  /** This console fronts an `up` process: onboarding copy says how to watch. */
  upConsole?: boolean;
  /** Extra Host values this server answers as (a Tailscale name, a LAN ip:port). */
  allowedHosts?: readonly string[];
  /**
   * Where the Telegram bot token lives when set from here. Present = the
   * settings card renders; absent = no settings surface at all.
   */
  telegramTokenFile?: string;
  /** Where messaging config files live (beside the database) — enables the
   * primary-messenger selector on the settings screen. */
  configDir?: string;
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
  /** Injected by tests: the fetch chat turns use, and where chat keys are
   * read from (defaults to process.env). Chat never spawns anything. */
  chatFetcher?: typeof fetch;
  chatEnv?: Record<string, string | undefined>;
  /**
   * The live peek's locality ASSERTION (live-peek v3 §3): the administrator
   * who starts serve names the runner this machine owns. This is documented
   * as an assertion, not machine-bound credential enforcement — the product
   * has none anywhere. Absent = the peek is off, and says so.
   */
  localRunner?: string;
  /** The checkout pool root the peek confines itself to (realpath-proved). */
  poolRoot?: string;
  /**
   * Editor deep links (arc 6): a DEPLOYMENT capability, not an activation.
   * vscode:// links open on the BROWSER's machine, so links render only
   * when three statements align: the operator started serve with
   * --editor vscode AND --runner (this machine owns the worktrees), the
   * run belongs to that runner, and THIS session turned links on for
   * this device. "vscode" is the only value; the scheme is never data.
   */
  editorLinks?: "vscode";
  /**
   * The attended-mint capability (Phase 2E): present only on a co-located
   * `up` console, which alone can hold a session. `headOf` reads the
   * repository's CURRENT head — the exact commit the signed terms pin.
   */
  attended?: {
    runner: string;
    headOf: (repo: string) => Promise<string | null>;
    coordinator?: import("./held.js").HeldSessionCoordinator;
  };
  /** Injected by tests: the onboarding ceremony's gh-facing halves — the
   * ceremony's gating, nonce, and enrollment logic is what the HTTP tests
   * prove; gh itself is proved by onboard.test.ts. */
  ghPreview?: typeof previewGithubRepo;
  ghClone?: typeof cloneGithubRepo;
};

const SESSION_COOKIE = "standing-orders_session";
const BODY_CAP = 16 * 1024;
/** A cookie idles out after half a day and dies outright after a week. */
const SESSION_IDLE_MS = 12 * 60 * 60_000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
/** An approval nonce is a rendered form, not a standing right — it ages out fast. */
const NONCE_TTL_MS = 15 * 60_000;
const NONCE_CAP = 500;
const RUNS_PAGE = 50;

const TASK_STATES: readonly TaskState[] = ["queued", "running", "done", "failed", "cancelled"];

/** Read-only fragment polls that must never refresh session activity (arc 1). */
const NO_TOUCH_FRAGMENTS: ReadonlySet<string> = new Set(["1", "facts", "peek", "rail", "transcript"]);

// ---- the phone (arc 3): install assets, served BEFORE authentication — they
// contain nothing secret, and a background service-worker update that met a
// login redirect would fail MIME validation and unregister itself.
const PWA_ICON_192 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAB1klEQVR42u3bMQ0AIAxFwepgQgD+TSECPJSBQO/nKSA30lhmBwtPYAAZQAaQAWQGkAFkABlAZgAZQPY4oNaHagaQABJAAkgAASSABJAAEkAACSABJIAEEEACSAAJIAEEkAASQAJIAHlHgAASQAJIAAkggASQABJAAgggASSABJAAAkgACSABJIAAAgggASSAss3aAwgggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggORLK0AAASSABJAAEkAACSABJIAEEEACSAAJIAEEkAASQAJIAAEkgASQAHKV4SoDIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAJIfiR6R4AAEkACSAAJIIAEkAASQAIIIAEkgASQAAJIAAkgASSAAAIIIAEkgFxluMoACCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggACSH4kCCCABJIAEkAACSAAJIAEkgAASQAJIAAkggASQABJAAggggAASQAJIAAkggASQABJAAgggASSABJAAAkgACSB9BMgMIAPIADKAzAAygAwgA8gAMgPI7mwDbzYVUJcW7UcAAAAASUVORK5CYII=";
const PWA_ICON_512 = "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAJF0lEQVR42u3VwQ0AEBBFQXU4KUD/TW0R3JzcRLJhfqYCwivDzMy+XHEEZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmZgJgZmYCYGZmAmBmJgBmZiYAZmYmAGZmJgBmZiYAZmYmAGZmJgDb1dYBOCEAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACAIAAACAAAAgAAAIAgAAAIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACAIAAACAAAAgAAAIAgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIAAACAIAAACAAAAgAAAIAgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIAAACAIAAACAAAAgAAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACcF+Y5Z5HKgACIAAmAAgAAmACgAAgACYACAACYAKAACAAJgAIAAJgAoAAIAAmAAgAAmACIAACgP/FBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQABMABAAARAAEwAEAAEwAUAAEAATAAQAATABQAAQABMABAABMAFAABAAEwABEAAEwARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEQADMBEAABEAAzARAAARAAMwEQAAEAEAABABAAAQAQAAAEAAABAAAAQBAAAAQAAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAANwcgAAAIAAACAAAAgCAAAAgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIAgAAAIAAACAAAAgCAAAAgAAACIAC/C7Pc80gFQAAEwAQAAUAATAAQAATABAABQABMABAABMAEAAFAAEwAEAAEwAQAAUAATAAEQADwv5gACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgAkAAiAAAmACgAAgACYACAACYAKAACAAJgAIAAJgAoAAIAAmAAgAAmACIAACgACYAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAIgJkACIAACICZAAiAAAiAmQAIgAAACIAAAAiAAAAIAAACAIAAACAAAAgAAAIAgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAmwMQAAAEAAABAEAAABAAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAQAQAAEAEAABABAAAAQAAAEAAABAEAAABAAAASAJcxyzyMVAAEQABMABAABMAFAABAAEwAEAAEwAUAAEAATAAQAATABQAAQABMABAABMAEQAAHA/2ICIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgACYACIAACIAJAAKAAJgAIAAIgAkAAoAAmAAgAAiACQACgACYACAACIAJgAAIAAJgAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIgAGYCIAACIABmAiAAAiAAZgIgAAIAIAACACAAAgAgAAAIAAACAIAAACAAAAgAAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAAgAgAAIAIAACACAAbg5AAAAQAAAEAAABAEAAABAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAAQBAAAAQAAAEAAABAEAAABAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABEAAAARAAAAEQAAABcHkAAgCAAAAgAAAIAAACAIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgAAACIAAAAiAAAAIgJmZPT4BMDMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMxMAMzMTADMzEwAzMwEwMzMBMDMzATAzMwEwMzMBMDOzJzYBVJhD+Nnu218AAAAASUVORK5CYII=";
const PWA_ICON_APPLE = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAABqklEQVR42u3aMQ0AIAxFwepgQgD+TSECFHQiYWjv5ylobmwcs2ThBAaHwWFwGBwGh8FhcBgcBofBkW7MparBITgEh+AQHIJDcAgOwQEHHHDAAYfgEByCQ3AIDsEhOASHI8IBBxxwCA7BITgEh+AQHIJDcAgOOOCAQ3AIDsEhOASH4BAcguNPu9PggAMOOOCAAw444IADDjjggAMOOOCAAw444IADDjjggAMOOOCAAw44PPsIDsEhOASH4BAcgkNwCA444IADDjgEh+AQHIJDcAgOwSE44IDDg7EHYzjggAMOOOCAAw444IADDjjggAMOOOCAAw444IADDjjggAMOOOCAAw559hEcgkNwwAEHHHDAITgEh+AQHIJDcAgOwQEHHHDAAYfgEByCQ3B4MIYDDjjggAMOOOCAAw444IADDjjggAMOOOCAAw444IADDjjggAMOOODw7OPZBw7BITgEh+AQHIJDcAgOOOCAAw44BIfgEByCQ3AIDsEhOAQHHHDAITgEh+AQHIJDcAgOwSE44IADDjgecVjbwWFwGBwGh8FhcBgcBofBYeV3AaohX51oqNRKAAAAAElFTkSuQmCC";
const PWA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="6" y="6" width="88" height="88" rx="14" fill="#1a202c"/><rect x="28" y="28" width="44" height="8" rx="4" fill="#ebebeb"/><rect x="28" y="47" width="44" height="8" rx="4" fill="#ebebeb"/><rect x="28" y="66" width="44" height="8" rx="4" fill="#ebebeb"/></svg>`;
const PWA_MANIFEST = JSON.stringify({
  name: "standing orders",
  short_name: "standing orders",
  id: "/",
  scope: "/",
  start_url: "/",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#1a202c",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
});
// The service worker, DELIBERATELY MINIMAL: no fetch handler — no cache, no
// offline copy of authenticated pages, nothing intercepting requests. Push
// and the tap, only. notificationclick resolves ONLY allow-listed relative
// paths — the payload URL is data, revalidated, never handed raw to the
// browser (arc 3 finding 5).
const PWA_WORKER = `// standing orders — push only; deliberately NO fetch handler (no offline cache of an authenticated console).
const SHAPES = [/^\\/next$/, /^\\/review$/, /^\\/system$/, /^\\/routines$/, /^\\/routines\\/[0-9]+$/, /^\\/d\\/[0-9]+$/, /^\\/contest\\/[0-9]+$/, /^\\/r\\/[0-9]+$/];
self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var body = typeof data.body === "string" ? data.body : "the console needs you";
  var tag = typeof data.tag === "string" ? data.tag : "standing-orders";
  var url = typeof data.url === "string" && SHAPES.some(function (s) { return s.test(data.url); }) ? data.url : "/next";
  if (typeof data.waiting === "number" && data.waiting >= 0 && self.registration.setAppBadge) {
    // A count, never content. Honest no-op where unsupported.
    event.waitUntil(self.registration.setAppBadge(Math.floor(data.waiting)).catch(function () {}));
  }
  event.waitUntil(self.registration.showNotification("standing orders", { body: body, tag: tag, data: { url: url } }));
});
self.addEventListener("message", function (event) {
  // The page recomputes on load/focus and is authoritative over any stale
  // push: {badge: N} sets, {badge: 0} clears.
  var badge = event.data && typeof event.data.badge === "number" ? event.data.badge : null;
  if (badge === null || !self.registration.setAppBadge) return;
  if (badge <= 0 && self.registration.clearAppBadge) { self.registration.clearAppBadge().catch(function () {}); return; }
  self.registration.setAppBadge(Math.floor(badge)).catch(function () {});
});
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  if (self.registration.clearAppBadge) self.registration.clearAppBadge().catch(function () {});
  var url = event.notification.data && event.notification.data.url;
  var target = new URL(SHAPES.some(function (s) { return s.test(url); }) ? url : "/next", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window" }).then(function (open) {
    for (var i = 0; i < open.length; i++) { if (open[i].url === target && open[i].focus) return open[i].focus(); }
    return clients.openWindow(target);
  }));
});
`;

type Session = {
  name: string;
  csrf: string;
  /** v29: the account's standing at login — the central gate reads it;
   * the revocation cascade kills the session outright. */
  role: "approver" | "viewer";
  /** The approver generation at login: credential rotation kills the cookie. */
  generation: number;
  createdAt: number;
  lastSeen: number;
  /** The open project — a VIEW FILTER chosen inside the ceiling, never authorization. */
  project: string | null;
  /** Bumped on every open: stale tabs carry the revision they were rendered under. */
  projectRevision: number;
  /** Onboarding preview records (arc: repo onboarding, finding 14) —
   * session-held, swept at mint, at most 3, consumed exactly once. */
  onboard?: Map<string, { nameWithOwner: string; rootIndex: number; target: string; diskUsageKib: number | null; large: boolean; mintedAt: number }>;
  /** When this session last READ the board — the anchor for "since you
   * last looked". Full page loads move it; fragment polls never do. */
  sawBoardAt: number | null;
  /** Fleet chat (v13): drafts and the last reply live HERE and nowhere
   * durable — restart or logout loses them by design (v2 finding 12). */
  chat?: SessionChat;
  /** Editor links (arc 6): the SESSION's half of the activation — "this
   * browser runs on the machine that holds the worktrees" is a statement
   * only the person at the browser can make. Dies with the session. */
  editorLinks?: boolean;
};

type ChatCandidate = {
  key: string;
  draft: ChatDraft;
  /** Resolved server-side at parse time from the opaque repoId. */
  repoPath: string;
  provider: string;
  approver: string;
  /** Digest of the frozen explicit repo list at turn time — filing
   * re-proves it (v2 new finding 5). */
  ceilingDigest: string;
  createdAt: number;
  state: "pending" | "filing";
};

type SessionChat = {
  candidates: Map<string, ChatCandidate>;
  lastTurn: { id: number; reply: string | null; staticError: string | null; proposalsDiscarded: boolean } | null;
};

/** One rendered approval form: who saw which digest of which task, once. */
type ApprovalNonce = {
  name: string;
  taskId: string;
  digest: string;
  expiresAt: number;
};

type Who = { name: string; via: "cookie"; session: Session; role: "approver" | "viewer" } | { name: string; via: "bearer"; role: "approver" | "viewer" };

export function createDecisionServer(options: ServeOptions): Server {
  const { store, evidenceRoot } = options;
  const clock = options.clock ?? (() => new Date());
  const sessions = new Map<string, Session>();
  // The /join road's limiter (D6; Codex people round 1, finding 4):
  // PER-SOURCE buckets so one stranger cannot drain sign-up capacity for
  // everyone, under a global ceiling that bounds total KDF work. Spent
  // only by WELL-FORMED submissions — malformed requests are refused by
  // the shape guards for free. The per-invite attempt counter remains the
  // durable meter; these buckets only price the trying.
  const joinBySource = new Map<string, { tokens: number; refilledAt: number }>();
  /** The per-source key (round 2, finding 4): the direct peer — except
   * behind the documented same-host TLS proxy, where every client would
   * share the proxy's one bucket. A LOOPBACK peer is that proxy, and only
   * then is the forwarded chain believed, taking the LAST hop (the one
   * the trusted proxy itself appended; earlier entries are client-typed). */
  function joinSourceOf(request: IncomingMessage): string {
    const peer = request.socket.remoteAddress ?? "unknown";
    const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    if (!loopback) return peer;
    const forwarded = request.headers["x-forwarded-for"];
    const chain = Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "";
    const lastHop = chain.split(",").pop()?.trim() ?? "";
    return lastHop === "" ? peer : `fwd:${lastHop.slice(0, 64)}`;
  }
  let joinGlobal = { tokens: 30, refilledAt: Date.now() };
  function takeJoinAttempt(source: string): boolean {
    const at = Date.now();
    const globalRefill = Math.floor((at - joinGlobal.refilledAt) / 20_000);
    if (globalRefill > 0) joinGlobal = { tokens: Math.min(30, joinGlobal.tokens + globalRefill), refilledAt: at };
    if (joinBySource.size > 1000) {
      const oldest = joinBySource.keys().next().value;
      if (oldest !== undefined) joinBySource.delete(oldest);
    }
    const bucket = joinBySource.get(source) ?? { tokens: 10, refilledAt: at };
    const refill = Math.floor((at - bucket.refilledAt) / 60_000);
    const tokens = refill > 0 ? Math.min(10, bucket.tokens + refill) : bucket.tokens;
    if (tokens <= 0 || joinGlobal.tokens <= 0) {
      joinBySource.set(source, { tokens, refilledAt: refill > 0 ? at : bucket.refilledAt });
      return false;
    }
    joinGlobal.tokens -= 1;
    joinBySource.set(source, { tokens: tokens - 1, refilledAt: refill > 0 ? at : bucket.refilledAt });
    return true;
  }
  const approvalNonces = new Map<string, ApprovalNonce>();

  // The ceiling, resolved once at startup. Paths that do not exist are
  // dropped here rather than silently failing every later check.
  const { ceiling, unresolved: unresolvedRepos } = resolveCeiling(
    [...(options.repo === undefined ? [] : [options.repo]), ...(options.repos ?? [])],
    options.projectRoots ?? [],
  );
  /** The project every fresh session opens with: the sole configured repo, else none. */
  const defaultProject = ceiling.repos.length === 1 && ceiling.roots.length === 0 ? ceiling.repos[0] as string : null;

  /** No ceiling configured at all: the legacy trust-everything mode, named. */
  const unscopedMode = ceiling.repos.length === 0 && ceiling.roots.length === 0;
  /** Per-row visibility under the ceiling — the authorization question for reads. */
  const visible = (repo: string | null): boolean => rowVisible(ceiling, repo);
  /** The enumerable admission list for roll-up SQL: repos-only ceilings
   * enumerate themselves; root ceilings enumerate the STORED repos that
   * pass the ceiling (Codex roll-up review, finding 11); unscoped = null. */
  const admissionList = (): string[] | null =>
    unscopedMode ? null : ceiling.roots.length === 0 ? [...ceiling.repos] : store.knownRepos().filter(visible);
  /** The task behind a resource, for the ceiling check; null = no ref (visible). */
  const taskRepoOf = (taskRef: number): string | null => store.refForId(taskRef)?.repo ?? null;

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (process.env["STANDING_ORDERS_SERVE_DEBUG"] === "1") console.error("SERVE ERROR:", error);
      if (!response.headersSent) {
        respond(response, 500, "text/plain; charset=utf-8", "something broke");
      } else {
        response.end();
      }
    });
  });

  // --public-url (arc 3): validated to EXACTLY an https origin. Its host
  // joins the allowed set, its origin authorizes POSTs, and cookies turn
  // Secure. Anything malformed refuses at startup, loudly.
  const publicOrigin = (() => {
    if (options.publicUrl === undefined) return null;
    let parsed: URL;
    try {
      parsed = new URL(options.publicUrl);
    } catch {
      throw new Error("--public-url is not a URL");
    }
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || parsed.search !== "" || (parsed.pathname !== "/" && parsed.pathname !== "")) {
      throw new Error("--public-url is exactly an https origin — no path, query, or credentials");
    }
    return parsed;
  })();
  const cookieSecure = publicOrigin === null ? "" : "; Secure";

  /** The names this server answers as. Anything else is a rebind, refused. */
  const allowedHost = (host: string | undefined): boolean => {
    if (host === undefined) return false;
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : null;
    const locals =
      port === null ? [] : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
    return [...locals, ...(options.allowedHosts ?? []), ...(publicOrigin === null ? [] : [publicOrigin.host])].includes(host);
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
      // A PRESENT Origin must name this server. An ABSENT one is not a
      // forgery: iOS Safari and some in-app browsers omit Origin on
      // same-origin form posts, and refusing them locked the console on
      // the operator's own phone. The per-session CSRF token below is the
      // primary proof either way — a cross-site attacker can post, but
      // cannot read the token to include it.
      const origin = request.headers.origin;
      const referer = request.headers.referer;
      const named = typeof origin === "string" && origin !== "null" ? origin : typeof referer === "string" ? referer : null;
      if (named !== null && !allowedHost(named.replace(/^https?:\/\//, "").split("/")[0])) {
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
    const header = request.headers["x-standing-orders-project"];
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
    // The install assets (arc 3): pre-auth by design; nothing secret rides
    // them, and each carries nosniff + its own conservative caching/CSP.
    if (method === "GET") {
      const asset = (type: string, body: string | Buffer, csp?: string): void => {
        response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("cache-control", url.pathname === "/sw.js" ? "no-store" : "public, max-age=3600");
        if (csp !== undefined) response.setHeader("content-security-policy", csp);
        respond(response, 200, type, body as string);
      };
      if (url.pathname === "/manifest.webmanifest") return asset("application/manifest+json", PWA_MANIFEST);
      if (url.pathname === "/icon.svg") return asset("image/svg+xml", PWA_ICON_SVG);
      if (url.pathname === "/icon-192.png") return asset("image/png", Buffer.from(PWA_ICON_192, "base64"));
      if (url.pathname === "/icon-512.png") return asset("image/png", Buffer.from(PWA_ICON_512, "base64"));
      if (url.pathname === "/apple-touch-icon.png") return asset("image/png", Buffer.from(PWA_ICON_APPLE, "base64"));
      if (url.pathname === "/sw.js") return asset("text/javascript; charset=utf-8", PWA_WORKER, "default-src 'none'");
    }
    // A fragment poll is the page keeping itself fresh, not a person acting.
    // It authenticates like any request but must not count as activity —
    // otherwise a board left open on a wall keeps its session alive forever
    // (Codex board review, finding 4). EVERY named read-only fragment is
    // excluded, not just the board's (arc 1, live bug): a 2-second
    // transcript poll would otherwise hold a session open until the tab
    // closed, which is no idle expiry at all.
    const fragmentName = url.searchParams.get("fragment");
    const touch = !(method === "GET" && fragmentName !== null && NO_TOUCH_FRAGMENTS.has(fragmentName));
    const who = identify(request, touch);

    if (url.pathname === "/login" && method === "GET") {
      return page(response, 200, loginPage(null));
    }
    if (url.pathname === "/login" && method === "POST") {
      const body = await form(request);
      const name = body.get("name");
      const token = body.get("token");
      const authenticated =
        name !== null && token !== null ? authenticateAccount(store, name, token) : null;
      if (authenticated === null || !authenticated.ok) {
        return page(response, 403, loginPage("wrong username or password"));
      }
      const id = randomBytes(32).toString("hex");
      sessions.set(id, {
        name: name as string,
        csrf: randomBytes(32).toString("hex"),
        role: authenticated.role,
        generation: authenticated.generation,
        createdAt: Date.now(),
        sawBoardAt: null,
        lastSeen: Date.now(),
        project: defaultProject,
        projectRevision: 1,
      });
      response.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`,
      );
      return redirect(response, "/");
    }

    if (url.pathname === "/logout" && method === "POST") {
      const cookies = request.headers.cookie ?? "";
      const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`).exec(cookies);
      if (match !== null) sessions.delete(match[1] as string);
      response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecure}`);
      return redirect(response, "/login");
    }

    // THE JOIN ROAD (v29, D6/E3): a single-use invite is the only door
    // that creates an account from the outside. Cookie-free, script-free,
    // and every dead token shape — unknown, expired, revoked, consumed,
    // attempts spent — answers with ONE indistinguishable page. GET spends
    // nothing; a POST spends one metered attempt BEFORE the KDF runs.
    const joinToken = /^\/join\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname)?.[1];
    if (joinToken !== undefined && method === "GET") {
      return page(response, 200, store.inviteIsLive(joinToken, clock()) ? joinFormPage(joinToken, null, "") : joinDeadPage());
    }
    if (joinToken !== undefined && method === "POST") {
      // EXACT media type (Codex people round 2, finding 5): parameters may
      // follow a semicolon; a merely prefix-shaped type is not a form.
      const media = String(request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (media !== "application/x-www-form-urlencoded") {
        return respond(response, 415, "text/plain; charset=utf-8", "forms only");
      }
      let body: URLSearchParams;
      try {
        body = await form(request);
      } catch {
        return respond(response, 413, "text/plain; charset=utf-8", "body too large");
      }
      for (const field of ["name", "password"]) {
        if (body.getAll(field).length > 1) {
          return respond(response, 400, "text/plain; charset=utf-8", `duplicated ${field} field`);
        }
      }
      if (!takeJoinAttempt(joinSourceOf(request))) {
        return respond(response, 429, "text/plain; charset=utf-8", "too many sign-up attempts right now — try again in a few minutes");
      }
      const admitted = store.admitInviteAttempt(joinToken, clock());
      if (admitted === null) return page(response, 200, joinDeadPage());
      const name = (body.get("name") ?? "").trim();
      const password = body.get("password") ?? "";
      // Possession of a LIVE token earns real words (D6's disclosure
      // ruling) — the attempt is already spent either way (E3).
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) {
        return page(response, 400, joinFormPage(joinToken, "names are 1\u201340 characters \u2014 letters, digits, dots, dashes, underscores", name));
      }
      if (password.length < 8) {
        return page(response, 400, joinFormPage(joinToken, "the password needs at least 8 characters", name));
      }
      const made = store.consumeInviteAndCreateAccount({ tokenValue: joinToken, name, credentialHash: hashPassword(password) }, clock());
      if (!made.ok) {
        if (made.reason === "name-taken") {
          return page(response, 400, joinFormPage(joinToken, "that name is taken \u2014 pick another", name));
        }
        return page(response, 200, joinDeadPage());
      }
      // The cookie mints only AFTER the commit — same shape as login.
      const id = randomBytes(32).toString("hex");
      sessions.set(id, {
        name,
        csrf: randomBytes(32).toString("hex"),
        role: made.role,
        generation: 1,
        createdAt: Date.now(),
        sawBoardAt: null,
        lastSeen: Date.now(),
        project: defaultProject,
        projectRevision: 1,
      });
      response.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`,
      );
      return redirect(response, "/");
    }

    if (who === null) {
      return method === "GET"
        ? redirect(response, "/login")
        : respond(response, 401, "text/plain; charset=utf-8", "authenticate first");
    }

    if (method === "GET") return void (await handleGet(url, who, request, response));
    if (method === "POST") return handlePost(url, who, request, response);
    return respond(response, 405, "text/plain; charset=utf-8", "no such method here");
  }

  // ---- reads ---------------------------------------------------------------

  async function handleGet(url: URL, who: Who, request: IncomingMessage, response: ServerResponse): Promise<void> {
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
      url.pathname !== "/" &&
      !/^\/t\/[^/]+$/.test(url.pathname) &&
      !url.pathname.startsWith("/d/") && !url.pathname.startsWith("/contest/") &&
      url.pathname !== "/projects" &&
      url.pathname !== "/projects/browse" && url.pathname !== "/workbench" &&
      url.pathname !== "/fleet" &&
      url.pathname !== "/settings" && url.pathname !== "/logout" && url.pathname !== "/people" &&
      !(url.pathname === "/board" && url.searchParams.get("scope") === "all");
    if (needsProject) return redirect(response, "/projects");

    if (url.pathname === "/projects/browse") {
      // The filesystem browser (operator request): pick a project folder by
      // looking, not typing. CONFINED to exactly what opening allows —
      // explicit --repo mode has an enumerable list and gets no browser at
      // all; --project-root mode browses its roots; unscoped mode (trust-
      // everything, named as such) browses from the home directory.
      // Directory NAMES only, never file contents; symlinks are resolved
      // and re-checked so a link cannot walk out of the fence.
      if (who.via !== "cookie") return refuse(response, who, 403, "browsing feeds a browser session's act");
      const browseRoots =
        ceiling.roots.length > 0 ? [...ceiling.roots] : unscopedMode ? [realpathSync(homedir())] : [];
      if (browseRoots.length === 0) {
        return refuse(response, who, 404, "this server was configured with an explicit repo list — the openable projects are all on the projects page", "/projects");
      }
      const asked = url.searchParams.get("at") ?? browseRoots[0] as string;
      const canonical = canonicalProject(asked);
      const inside =
        canonical !== null &&
        browseRoots.some(root => canonical === root || canonical.startsWith(`${root}/`));
      if (canonical === null || !inside) {
        return refuse(response, who, 403, "that path is outside what this server may browse", "/projects/browse");
      }
      let entries: { name: string; path: string; git: boolean }[] = [];
      try {
        entries = readdirSync(canonical, { withFileTypes: true })
          .filter(one => one.isDirectory() || one.isSymbolicLink())
          .filter(one => !one.name.startsWith(".") && one.name !== "node_modules")
          .slice(0, 400)
          .map(one => {
            const path = join(canonical, one.name);
            // Resolve NOW so a symlink pointing outside the fence renders
            // as nothing rather than as a door.
            const resolved = canonicalProject(path);
            if (resolved === null || !browseRoots.some(root => resolved === root || resolved.startsWith(`${root}/`))) {
              return null;
            }
            return { name: one.name, path: resolved, git: existsSync(join(resolved, ".git")) };
          })
          .filter((one): one is { name: string; path: string; git: boolean } => one !== null)
          .sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name))
          .slice(0, 200);
      } catch {
        return refuse(response, who, 404, "that directory cannot be read", "/projects/browse");
      }
      const root = browseRoots.find(one => canonical === one || canonical.startsWith(`${one}/`)) as string;
      const parent = canonical === root ? null : canonical.slice(0, canonical.lastIndexOf("/")) || root;
      const csrf = who.session.csrf;
      return sendScreen(
        response,
        200,
        browsePage(chromeFor(who.session.project, "projects"), {
          at: canonical,
          root,
          roots: browseRoots,
          parent,
          entries,
          csrf,
        }),
      );
    }

    if (url.pathname === "/projects") {
      return void projectsScreen(response, who, null, 200);
    }

    if (url.pathname === "/") {
      // With no project open in scoped mode this is the ROLL-UP inbox:
      // admission binds inside the bounded queries, every row's repo is
      // re-proved here, and rows render as links only (Codex roll-up
      // review, findings 6–8). Gaps stay per-project — they are derived
      // against one repo's capabilities and roll up dishonestly.
      const rollup = project === null && !unscopedMode;
      const admission = rollup ? admissionList() : null;
      const cancelled = store
        .listCancelledBlockersScoped(project, 10, admission)
        .filter(one => visible(one.repo) && visible(one.blockerRepo));
      return sendScreen(
        response,
        200,
        inboxPage(chromeFor(project, "inbox"), {
          csrf: who.via === "cookie" ? who.session.csrf : "",
          revision: who.via === "cookie" ? who.session.projectRevision : 0,
          rollup,
          decisions: store.listDecisionsScoped(project).filter(one => visible(one.repo)).slice(0, 10),
          approvals: store.scopesAwaitingApproval(project, 10, admission).filter(one => visible(one.repo)),
          requeueables: store.listRequeueablesScoped(project, now, 10, admission).filter(one => visible(one.repo)),
          cancelledBlockers: cancelled,
          gaps: project === null ? [] : computeGaps(store, project, now).filter(gap => gap.unblocks.length > 0).slice(0, 10),
          wizard: wizardSteps(now),
          now,
        }),
      );
    }

    if (url.pathname === "/next") {
      // Triage: everything waiting on a person, one at a time, hardest-
      // blocked first — oldest question, then plans and scopes to approve,
      // then stalled work to retry, then requirement gaps. `skip` is a
      // bounded, session-free cursor of keys the operator set aside; every
      // act 303s back here, which is what makes it a flow and not a list.
      const skipped = new Set(
        (url.searchParams.get("skip") ?? "").split(",").filter(one => /^[darg]:[A-Za-z0-9._:-]{1,80}$/.test(one)).slice(0, 20),
      );
      const decisions = store.listDecisionsScoped(project).filter(one => one.state !== "answered");
      const approvals = store.scopesAwaitingApproval(project, 20);
      const requeueables = store.listRequeueablesScoped(project, now, 20);
      const gaps = project === null ? [] : computeGaps(store, project, now).filter(gap => gap.unblocks.length > 0);
      type Item =
        | { key: string; kind: "decision"; decision: (typeof decisions)[number] }
        | { key: string; kind: "approval"; approval: (typeof approvals)[number] }
        | { key: string; kind: "requeue"; stalled: (typeof requeueables)[number] }
        | { key: string; kind: "gap"; gap: (typeof gaps)[number] };
      const queue: Item[] = [
        ...decisions.map(decision => ({ key: `d:${decision.id}`, kind: "decision" as const, decision })),
        ...approvals.map(approval => ({ key: `a:${approval.taskId}`, kind: "approval" as const, approval })),
        ...requeueables.map(stalled => ({ key: `r:${stalled.taskId}`, kind: "requeue" as const, stalled })),
        ...gaps.map(gap => ({ key: `g:${gap.key.replace(/[^A-Za-z0-9._:-]/g, "_")}`, kind: "gap" as const, gap })),
      ];
      const remaining = queue.filter(one => !skipped.has(one.key));
      const item = remaining[0] ?? null;
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      if (item !== null && item.kind === "approval") {
        // The card restates the digest-bound terms, so the nonce may be
        // minted here — same rule as the task screen, same binding.
        const nonce = who.via === "cookie" ? mintApprovalNonce(who.name, item.approval.taskId, item.approval.digest) : "";
        const ref = store.lookupRef(item.approval.taskId);
        const scope = store.getScope(item.approval.taskId);
        return sendScreen(response, 200, nextPage(chromeFor(project, "inbox"), {
          item, scope,
          planDocument: ref !== null && ref.plan === "drafted" ? planDocumentOf(ref.id) : null,
          csrf, nonce, remaining: remaining.length, skipped: [...skipped], now,
        }));
      }
      return sendScreen(response, 200, nextPage(chromeFor(project, "inbox"), {
        item, scope: null, planDocument: null, csrf, nonce: "",
        remaining: remaining.length, skipped: [...skipped], now,
      }));
    }

    // The board's old name; bookmarks keep working. A GET-only alias, so a
    // plain 302 — never the shared 303 helper, which belongs to POST landings.
    if (url.pathname === "/morning") {
      response.writeHead(302, { ...SAFETY, Location: "/activity" });
      response.end();
      return;
    }

    if (url.pathname === "/workbench") {
      // The fleet under one gaze (attended A1): the rail rolls up the whole
      // ceiling regardless of the open project — watching is cross-project
      // by nature; acting happens on task screens that re-prove everything.
      const admission = admissionList();
      const snapshot = store.boardScoped(null, now, 200, admission);
      const rows = snapshot.tasks.filter(facts => facts.repo === null || visible(facts.repo));
      const cards = rows.map(facts =>
        classify(facts.blockerRepo !== null && !visible(facts.blockerRepo) ? { ...facts, blockerState: null } : facts, now),
      );
      const attention = cards.filter(card => card.lane === "attention").slice(0, 100);
      const building = cards.filter(card => card.lane === "building");
      const done = snapshot.done
        .filter(one => one.repo === null || visible(one.repo))
        .slice(0, 5)
        .map(one => ({ taskId: one.taskId, title: one.title, outcome: one.outcome }));
      const selected = url.searchParams.get("t");
      const rail = workbenchRail({ attention, building, done, selected, saturated: snapshot.saturated });
      if (url.searchParams.get("fragment") === "rail") {
        // The rail alone: same auth, same ceiling, no shell, no scripts.
        return respond(response, 200, "text/html; charset=utf-8", rail);
      }
      let detail = `<div class="card"><p><strong>Pick something on the left.</strong></p>` +
        `<p class="meta">the rail updates itself; whatever you select renders here in full — approvals, evidence, acts</p></div>`;
      if (selected !== null) {
        const view = taskViewData(selected, who, null);
        detail = view === null ? `<div class="card"><p class="meta">no such task — it may have been outside this console's view</p></div>` : taskBody(view);
      }
      return sendScreen(
        response,
        200,
        screen("workbench", detail, {
          chrome: chromeFor(
            project,
            "workbench",
            `<div id="wb-rail">${rail}</div><p class="meta" id="wb-rail-stamp"></p>`,
          ),
          functional: { script: regionScript("wb-rail", "rail", building.length > 0 ? 10 : 30), fetches: true },
        }),
      );
    }

    if (url.pathname === "/board") {
      // scope=all is the rolled-up view: every project this server was
      // allowed to serve, on one board. The ceiling still rules row by row
      // (rowVisible, the same predicate as every list) — a repo outside
      // the server's configuration never renders a card, whatever the
      // database holds. Unplaced work (repo NULL) appears: it dispatches
      // anywhere, so every board honestly owns it.
      const all = url.searchParams.get("scope") === "all";
      // Roll-up admission happens BEFORE the query limit (Codex round 2,
      // finding 11) — and root ceilings enumerate too, through the STORED
      // repos that pass the ceiling (attended review, finding 3); the
      // per-row visible() re-check below stays either way.
      const admission = all ? admissionList() : null;
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
      // "Since you last looked": what concluded between this session's
      // previous full board read and now. Fragment polls never move the
      // anchor — an open tab is not a person looking.
      let delta: { agoMinutes: number; built: number; failed: number; questions: number } | null = null;
      if (who.via === "cookie" && url.searchParams.get("fragment") !== "1") {
        const prev = who.session.sawBoardAt;
        if (prev !== null && now.getTime() - prev > 5 * 60_000) {
          const sinceIso = new Date(prev).toISOString();
          const runs = store.runsSinceScoped(sinceIso, all ? null : project).filter(one => all ? one.taskId !== "" : true);
          delta = {
            agoMinutes: Math.round((now.getTime() - prev) / 60_000),
            built: runs.filter(one => one.outcome === "built" || one.outcome === "no-change").length,
            failed: runs.filter(one => one.outcome === "failed").length,
            questions: store.listDecisionsScoped(all ? null : project).filter(one => one.createdAt >= sinceIso && one.state !== "answered").length,
          };
          if (delta.built === 0 && delta.failed === 0 && delta.questions === 0) delta = null;
        }
        who.session.sawBoardAt = now.getTime();
      }
      const buildingCount = cards.filter(card => card.lane === "building").length;
      // Instances belong to their track row, not the main lanes — the board
      // is for one-off work; tracks are the heartbeat. The one exception is
      // attention: anything needing a person surfaces, wearing its routine.
      const laneCards = cards.filter(card => card.routineName === null || card.lane === "attention");
      const tracks = store
        .routineTracks(all ? null : project, now, admission)
        .filter(track => visible(track.routine.repo));
      const body = boardBody(
        { cards: laneCards, tracks, done, saturated: snapshot.saturated, now, all, project, delta },
        pr => store.ciFailureObserved(pr),
      );
      if (url.searchParams.get("fragment") === "1") {
        // The live region alone — the in-page swapper's diet. Same auth,
        // same ceiling, no shell, no scripts (finding 2).
        return respond(response, 200, "text/html; charset=utf-8", body);
      }
      const regionBody = `<div id="board-region">${body}</div><p class="meta" id="board-region-stamp"></p>`;
      return sendScreen(
        response,
        200,
        screen("board", regionBody, {
          chrome: chromeFor(project, "board"),
          functional: { script: regionScript("board-region", "1", buildingCount > 0 ? 10 : 30), fetches: true },
        }),
      );
    }

    if (url.pathname === "/review") {
      // The review queue (M8.19): READ-ONLY merge-order advice. The plane
      // observes and recommends; the person merges on GitHub. Every row is
      // ceiling-checked like any other run resource, and CI claims stay
      // honest — an open episode is an OBSERVED failure, its absence is
      // "no failing observation", never a green the machine did not see.
      // Rank by what was OBSERVED (audit SD-4): passing first, silence in
      // the middle and labeled as silence, failing last. Green is a fact
      // the watcher saw, never an inference from quiet.
      const rankOf = (failing: boolean, checkState: string | null): number =>
        failing ? 2 : checkState === "passing" ? 0 : 1;
      const rows = store
        .openedPublications()
        .filter(one => visible(taskRepoOf(one.taskRef)))
        .map(one => ({
          publication: one,
          taskId: store.externalIdFor(one.taskRef) ?? "?",
          failing: one.prNumber === null ? false : store.hasOpenCiEpisode(one.githubRepo, one.prNumber),
        }))
        .sort((a, b) => {
          const rankA = rankOf(a.failing, a.publication.lastCheckState);
          const rankB = rankOf(b.failing, b.publication.lastCheckState);
          return rankA !== rankB ? rankA - rankB : a.publication.updatedAt.localeCompare(b.publication.updatedAt);
        });
      return sendScreen(response, 200, reviewPage(chromeFor(project, "review"), rows, now));
    }

    if (url.pathname === "/activity") {
      const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
      return sendScreen(
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
          heldSessions: new Map(store.openHeldSessions().reduce((by, one) => by.set(one.runner, (by.get(one.runner) ?? 0) + 1), new Map<string, number>())),
          worktrees: store
            .listWorktrees()
            .filter(one => project === null || sameRepo(one.repo, project)),
          episode: project === null ? null : store.latestWatchEpisode(project),
          now,
        }),
      );
    }

    if (url.pathname === "/done") {
      return sendScreen(
        response,
        200,
        donePage(chromeFor(project, "done"), store.listCompletedWorkScoped(project, 50), pr => store.ciFailureObserved(pr)),
      );
    }

    if (url.pathname === "/mode") {
      if (project === null) {
        return refuse(response, who, 409, "open a project first — a mode is signed per repository");
      }
      const live = store.activeMode(project, now);
      const liveTerms = live === null ? null : modeTermsFromJson(live.termsJson);
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const hasGrant = store.hasMergeCapableGrant(project, now);
      const current =
        live === null || liveTerms === null
          ? `<div class="card"><h2 style="margin-top:0">locked</h2><p class="meta">no mode is signed — every act keeps its own ceremony. That is the default, forever.</p></div>`
          : [
              `<div class="card">`,
              `<h2 style="margin-top:0">${escape(live.name)} <span class="meta">signed by ${personChip(live.signedBy)}</span></h2>`,
              modeWords(liveTerms)
                .map(words => `<p class="row">${escape(words)}</p>`)
                .join("\n"),
              who.role === "approver"
                ? `<form method="post" action="/mode/revoke" class="row">` +
                  `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
                  `<button type="submit">end this mode now</button>` +
                  `<span class="meta">one click — every act it covered falls back to its own ceremony</span></form>`
                : "",
              `</div>`,
            ].join("\n");
      const signForm =
        who.role !== "approver"
          ? ""
          : [
              `<div class="card">`,
              `<h2 style="margin-top:0">${live === null ? "sign a mode" : "replace it — a renewal is a new signature"}</h2>`,
              `<form method="post" action="/mode/confirm">`,
              `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
              `<label>preset<select name="name"><option value="standard">standard — safe defaults, reviews on</option><option value="hands-off">hands-off — your filings auto-approve, full permissions</option></select></label>`,
              `<label>days <span class="meta">(1\u2013${MODE_MAX_DAYS})</span><input type="number" name="days" value="1" min="1" max="${MODE_MAX_DAYS}"></label>`,
              `<label>merges<select name="publication">` +
                `<option value="notify">wait for me — even under a merge grant</option>` +
                (hasGrant ? `<option value="automerge">merge themselves when CI is green on the exact commit</option>` : "") +
                `</select></label>` +
                (hasGrant ? "" : `<span class="meta">self-merging needs a merge-capable publication grant first</span>`),
              `<label>my filings<select name="auto-approve">` +
                `<option value="">the preset's default (standard: wait for approval; hands-off: auto-approve)</option>` +
                `<option value="1">approve the moment I file them</option>` +
                `<option value="0">wait for their own approval</option>` +
                `</select></label>`,
              `<label>reviews<select name="review-auto">` +
                `<option value="">the preset's default (standard: on; hands-off: off)</option>` +
                `<option value="1">agent-review every finished build</option>` +
                `<option value="0">only when I ask</option>` +
                `</select></label>`,
              `<label>if a subscription runs out<select name="allow-paid-fallback">` +
                `<option value="">never switch to a paid API key on its own (the default, every preset)</option>` +
                `<option value="1">allow the approved fallback — spend moves to that account</option>` +
                `</select></label>`,
              `<button type="submit">read the full terms</button>`,
              `</form>`,
              `</div>`,
            ].join("\n");
      return sendScreen(
        response,
        200,
        screen("mode", [`<h1>operating mode</h1>`, current, signForm].join("\n"), { chrome: chromeFor(project, "menu") }),
      );
    }

    if (url.pathname === "/people") {
      // Approvers see everyone (D7's ceiling: every fact already passed
      // the process admission); a viewer sees exactly themselves (U3).
      const approverView = who.role === "approver";
      const accounts = store.accountFacts().filter(one => approverView || one.name === who.name);
      const lastSeenOf = (name: string): number | null => {
        let seen: number | null = null;
        for (const session of sessions.values()) {
          if (session.name === name && (seen === null || session.lastSeen > seen)) seen = session.lastSeen;
        }
        return seen;
      };
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const cards = accounts.map(one => {
        const seen = lastSeenOf(one.name);
        const attended = store.openAttendedOf(one.name);
        const acts = store.recentActsOf(one.name);
        const standing =
          one.revokedAt !== null
            ? `revoked ${escape(one.revokedAt.slice(0, 16).replace("T", " "))} by ${personChip(one.revokedBy ?? "?")}`
            : one.role === "approver"
              ? "approves"
              : "watches";
        return [
          `<div class="card">`,
          `<h2 style="margin-top:0">${personChip(one.name)} <span class="meta">${standing}</span></h2>`,
          `<p class="meta">${seen === null ? "not signed in right now" : `signed in \u2014 active ${escape(new Date(seen).toISOString().slice(11, 16))} UTC`} \u00b7 joined ${escape(one.addedAt.slice(0, 10))}</p>`,
          attended.length === 0
            ? ""
            : `<p class="row">watching now: ${attended.map(session => `<a href="/t/${escape(session.taskId)}">${escape(session.taskId)}</a>`).join(", ")}</p>`,
          acts.length === 0
            ? `<p class="meta">no recorded acts yet</p>`
            : acts.map(act => `<p class="row meta">${escape(act.kind)} ${escape(act.subject)} \u00b7 ${escape(act.at.slice(0, 16).replace("T", " "))}</p>`).join("\n"),
          approverView && one.revokedAt === null && one.name !== who.name
            ? `<form method="post" action="/people/revoke" class="row">` +
              `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="name" value="${escape(one.name)}">` +
              `<label>your password<input type="password" name="token" autocomplete="current-password"></label>` +
              `<button type="submit">remove ${escape(one.name)}'s sign-in</button>` +
              `<span class="meta">ends their access and everything it signed \u2014 history stays</span></form>`
            : "",
          `</div>`,
        ].join("\n");
      });
      const invites = approverView ? store.openInvites(now) : [];
      const inviteRows = invites.map(one =>
        `<p class="row">${escape(one.role)} invite \u00b7 from ${personChip(one.mintedBy)} \u00b7 expires ${escape(one.expiresAt.slice(0, 16).replace("T", " "))}${one.attempts > 0 ? ` \u00b7 ${one.attempts} failed attempt${one.attempts === 1 ? "" : "s"}` : ""}` +
        ` <form method="post" action="/people/invite-revoke" style="display:inline">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="id" value="${one.id}">` +
        `<label>password <input type="password" name="token" autocomplete="current-password" style="width:8rem"></label>` +
        `<button type="submit">cancel it</button></form></p>`,
      );
      const inviteCard = !approverView
        ? ""
        : [
            `<div class="card">`,
            `<h2 style="margin-top:0">invite someone</h2>`,
            inviteRows.length === 0 ? `<p class="meta">no open invites</p>` : inviteRows.join("\n"),
            `<form method="post" action="/people/invite" class="row">`,
            `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
            `<label>they can<select name="role"><option value="viewer">watch everything</option><option value="approver">approve and act</option></select></label>`,
            `<label>your password<input type="password" name="token" autocomplete="current-password"></label>`,
            `<button type="submit">make an invite link</button>`,
            `<span class="meta">single-use, expires in 72 hours</span>`,
            `</form>`,
            `</div>`,
          ].join("\n");
      return sendScreen(
        response,
        200,
        screen("people", [`<h1>people</h1>`, ...cards, inviteCard].join("\n"), {
          chrome: chromeFor(project, "people"),
        }),
      );
    }

    if (url.pathname === "/system") {
      const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
      void since;
      return sendScreen(
        response,
        200,
        systemPage(chromeFor(project, "system"), {
          agents: (["plan", "build", "repair", "review"] as const).map(phase => {
            const answer = resolvePhaseAgent(store, phase, project, {});
            const row =
              (project === null ? null : store.phaseConfig(project, phase)) ??
              store.phaseConfig(INSTALLATION_SCOPE, phase);
            return {
              phase,
              ...(answer.ok
                ? { provider: answer.spec.provider, model: answer.spec.model, source: answer.source }
                : { problem: answer.problem }),
              setBy: row?.updatedBy ?? null,
            };
          }),
          building: store.liveClaims(project, now),
          runners: store.listRunners(),
          heldSessions: new Map(store.openHeldSessions().reduce((by, one) => by.set(one.runner, (by.get(one.runner) ?? 0) + 1), new Map<string, number>())),
          worktrees: store.listWorktrees().filter(one => project === null || sameRepo(one.repo, project)),
          episode: project === null ? null : store.latestWatchEpisode(project),
          outboxPending: store.listNotifications("pending").length,
          // External work at a glance (arc 3 finding 24): every dispatch
          // grant with its blocked state, plus any open sync episode — the
          // page a sync-failed push deep-links to now shows the fact.
          externalWork: store
            .listGrants()
            .filter(one => one.dispatch === true && one.remoteRepo != null && visible(one.repo))
            .map(one => ({
              remoteRepo: String(one.remoteRepo),
              blocked: one.dispatchBlocked ?? null,
              openEpisode:
                store
                  .listNotifications("all")
                  .find(n => n.kind === "sync-failed" && n.resolvedAt === null && n.dedupeKey.startsWith(`sync:${one.remoteRepo}:`))?.subject ?? null,
            })),
          now,
        }),
      );
    }

    if (url.pathname === "/tasks") {
      const wanted = url.searchParams.get("state");
      if (wanted !== null && !TASK_STATES.includes(wanted as TaskState)) {
        return refuse(response, who, 400, "no such state", "/tasks");
      }
      // ?template=<name> pre-fills the add form from the shipped library —
      // a pre-filled form and nothing more; the submission path is the
      // same guarded handler either way.
      const fromTemplate = url.searchParams.get("template");
      const picked = fromTemplate === null ? null : templateByName(fromTemplate);
      const prefill =
        picked !== null && picked.kind === "task"
          ? { title: picked.title, goal: picked.goal, not: picked.outOfScope ?? "", touches: picked.touches.join(", ") }
          : null;
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      return sendScreen(
        response,
        200,
        tasksPage(
          chromeFor(project, "tasks"),
          store.listTasksScoped(project, wanted === null ? undefined : (wanted as TaskState), 200, null),
          wanted as TaskState | null,
          csrf,
          null,
          project,
          prefill,
        ),
      );
    }

    if (url.pathname === "/queue") {
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const revision = who.via === "cookie" ? who.session.projectRevision : 0;
      const tasks = store.queueScoped(project, clock());
      const owned = new Set(tasks.map(one => one.assignedRunner).filter((one): one is string => one !== null));
      // Columns: active workers, plus retired workers that still own tasks.
      const workers = store
        .listRunners()
        .filter(one => one.retiredAt === null || owned.has(one.name))
        .map(one => ({ name: one.name, retired: one.retiredAt !== null, note: one.queueNote ?? null }));
      const body = queueBody(tasks, workers, csrf, revision, store.queueRevision());
      if (url.searchParams.get("fragment") === "1") {
        return respond(response, 200, "text/html; charset=utf-8", body);
      }
      return sendScreen(
        response,
        200,
        screen("queue", [
          `<h1>queue</h1>`,
          `<p class="hint">every worker's up-next list — drag a card to reorder or to reserve it for a worker; top is taken first. The order applies at the next selection; work already being taken keeps its claim.</p>`,
          `<div id="queue-region">${body}</div>`,
          `<p class="meta" id="queue-region-stamp"></p>`,
        ].join("\n"), { chrome: chromeFor(project, "queue"), functional: { script: queueScript(), fetches: true } }),
      );
    }

    if (url.pathname === "/fleet") {
      // Cross-project by design: which agent is on which project is the
      // question, so this screen is a survey — reads are still filtered
      // through the ceiling before a card renders. No project needed.
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const queued = store.fleetQueue(clock());
      const building = store.liveClaims(null, clock());
      const owned = new Set(queued.map(one => one.assignedRunner).filter((one): one is string => one !== null));
      const runners = store.listRunners().filter(one => one.retiredAt === null || owned.has(one.name));
      const body = fleetBody(queued, building, runners, csrf, store.queueRevision(), visible);
      if (url.searchParams.get("fragment") === "1") {
        return respond(response, 200, "text/html; charset=utf-8", body);
      }
      const said = url.searchParams.get("said");
      const fleetScreen = screen(
        "fleet",
        [
          `<h1>fleet</h1>`,
          `<p class="hint">one lane per worker — building pins to the top, queued reservations below it, every card wearing its project. Drag a queued card onto another worker to re-reserve it. Registering and retiring a worker are the only acts here, and both take your password.</p>`,
          ...(said === null ? [] : [`<p class="meta">${escape(said)}</p>`]),
          `<div id="fleet-region">${body}</div>`,
          `<p class="meta" id="fleet-region-stamp"></p>`,
          `<h2>register a worker</h2>`,
          `<form method="post" action="/fleet/runner/register" class="card">` +
            `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
            `<label>name<input type="text" name="name" placeholder="builder-2" maxlength="60" required></label>` +
            `<label>capacity<input type="text" name="capacity" inputmode="numeric" value="1" aria-label="capacity"></label>` +
            `<label>your password, typed again<input type="password" name="token" autocomplete="current-password" required></label>` +
            `<button type="submit">register — its token is shown once</button></form>`,
          `<details class="arm-danger"><summary>retire a worker</summary>` +
            `<form method="post" action="/fleet/runner/retire" class="card">` +
            `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
            `<label>which worker<input type="text" name="name" placeholder="builder-1" required></label>` +
            `<label>your password, typed again<input type="password" name="token" autocomplete="current-password" required></label>` +
            `<button type="submit" class="danger">retire it</button></form></details>`,
        ].join("\n"),
        // The password fields make this screen sensitive: sendScreen strips
        // the chrome additions and keeps the reorder poller — the named
        // functional exception (it never reads the fields).
        { chrome: chromeFor(project, "fleet"), functional: { script: fleetScript(), fetches: true } },
      );
      return sendScreen(response, 200, fleetScreen);
    }

    if (url.pathname === "/tasks/new") {
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const revision = who.via === "cookie" ? who.session.projectRevision : 0;
      const chainable = store
        .listTasksScoped(project, undefined, 100, null)
        .filter(one => one.state !== "done" && one.state !== "cancelled" && visible(one.repo))
        .map(one => ({ id: one.id, title: one.title }));
      return sendScreen(response, 200, newTaskPage(chromeFor(project, "tasks"), project, csrf, revision, null, chainable));
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
      return sendScreen(response, 200, runsPage(chromeFor(project, "runs"), rows, liveRunIds(rows), rows.length === RUNS_PAGE ? rows[rows.length - 1]?.id ?? null : null));
    }

    if (url.pathname === "/menu") {
      // The phone's overflow drawer as an honest page: every destination
      // the bottom bar does not carry, one tap away, no JavaScript.
      const rows = (
        [
          ["/fleet", "fleet", "who is working, and on what"],
          ["/workbench", "workbench", "the rail and the selected task"],
          ["/routines", "routines", "scheduled tracks and their firings"],
          ["/done", "done", "what finished recently"],
          ["/activity", "activity", "the full ledger, newest first"],
          ["/review", "review queue", "published work waiting on review"],
          ["/tasks", "task list", "everything, filterable"],
          ["/system", "system", "workers, providers, and grants"],
          ["/caps", "requirements", "tools and credentials builds need"],
          ["/projects", "switch project", "open another enrolled repository"],
          ["/people", "people", "who can sign in, and what they have done"],
          ["/mode", "operating mode", "the signed posture this repository runs under"],
          ["/settings", "settings", "alerts, messaging, credentials"],
        ] as const
      )
        .map(
          ([href, label, hint]) =>
            `<a class="menu-row" href="${href}"><strong>${label}</strong><span class="meta">${hint}</span></a>`,
        )
        .join("\n");
      return page(
        response,
        200,
        shell("menu", [`<h1>everything else</h1>`, `<div class="menu-list">${rows}</div>`].join("\n"), {
          chrome: chromeFor(project, "menu"),
        }),
      );
    }

    const run = /^\/r\/([0-9]{1,15})$/.exec(url.pathname);
    if (run !== null) {
      const found = store.getRun(Number(run[1]));
      if (found === null || !runVisible(found)) {
        return refuse(response, who, 404, "no such run", "/runs");
      }
      const taskId = store.externalIdFor(found.taskRef) ?? "?";
      const running = runIsLive(found);
      if (url.searchParams.get("fragment") === "facts") {
        // The facts region alone — same auth and ceiling as the page; a
        // finished or no-longer-live run says so rather than growing forms
        // (finding 5; round-4 finding 15).
        return respond(response, 200, "text/html; charset=utf-8", runFactsFragment(found, taskId, running));
      }
      if (url.searchParams.get("fragment") === "peek") {
        // The live peek: cookie sessions only (v2 §3), never stored, never
        // cached by anything downstream.
        if (who.via !== "cookie") return respond(response, 403, "text/plain; charset=utf-8", "the live peek is a browser session's view");
        const peeked = await peekFragment(
          found.id,
          who.session.csrf,
          options.editorLinks !== undefined && found.runner === options.localRunner && who.session.editorLinks === true,
        );
        response.setHeader("cache-control", "no-store");
        if (peeked.retryAfter !== undefined) response.setHeader("retry-after", String(peeked.retryAfter));
        return respond(response, peeked.status, "text/html; charset=utf-8", peeked.body);
      }
      if (url.searchParams.get("fragment") === "transcript") {
        // The live transcript window (arc 1): raw sanitized TEXT as JSON —
        // the sink is textContent, never innerHTML. Guards, enumerated:
        // cookie session; run visible (proved above); this machine's
        // runner asserted; byte offsets validated; the file read through
        // its own descriptor with the exact numeric-id name. Display
        // state, not evidence — and never cached.
        response.setHeader("cache-control", "no-store");
        if (who.via !== "cookie") return respond(response, 403, "application/json", JSON.stringify({ error: "session" }));
        if (options.localRunner === undefined) {
          return respond(response, 200, "application/json", JSON.stringify({ error: "off" }));
        }
        const fromRaw = url.searchParams.get("from") ?? "0";
        const from = /^[0-9]{1,15}$/.test(fromRaw) ? Number(fromRaw) : Number.NaN;
        if (!Number.isSafeInteger(from) || from < 0) {
          return respond(response, 400, "application/json", JSON.stringify({ error: "offset" }));
        }
        const live = runIsLive(found);
        // The final drain: a finished run's tail — including a torn last
        // line — may be read until the sweep removes the file.
        const window = readLiveWindow(evidenceRoot, found.id, from, !live);
        if (!window.ok) {
          if (window.reason === "replaced") {
            return respond(response, 409, "application/json", JSON.stringify({ error: "replaced" }));
          }
          // Missing or unreadable: nothing to show. Final only when the
          // run can never write again.
          return respond(response, 200, "application/json", JSON.stringify({ text: "", nextOffset: from, final: !live }));
        }
        // Re-proof after the read (peek discipline): the run row still says
        // what admission said, or nothing is shown.
        const again = store.getRun(found.id);
        if (again === null || !runVisible(again)) {
          return respond(response, 200, "application/json", JSON.stringify({ text: "", nextOffset: from, final: true }));
        }
        return respond(
          response,
          200,
          "application/json",
          JSON.stringify({ text: window.text, nextOffset: window.nextOffset, final: !live && window.eof }),
        );
      }
      // Pollers exist only for a LIVE run — an orphaned null-outcome run
      // would otherwise be refetched forever (finding 15). The nonce is
      // sendScreen's business now.
      const artifacts = store.artifactsFor(found.id);
      return sendScreen(
        response,
        200,
        runPage(
          chromeFor(project, "runs", runListPane(project, found.id)),
          found,
          taskId,
          artifacts,
          terminalDiffView(artifacts, evidenceRoot),
          store.notesForRun(found.id),
          who.via === "cookie" ? who.session.csrf : "",
          store.liveDiffComments(found.id),
          (() => {
            const publication = store.publicationForRun(found.id);
            return publication !== null && publication.prNumber !== null && store.hasOpenCiEpisode(publication.githubRepo, publication.prNumber)
              ? { pr: publication.prNumber }
              : null;
          })(),
          !running
            ? undefined
            : regionScript("run-facts", "facts", 10) +
              (options.localRunner === undefined ? "" : regionScript("run-peek", "peek", 15)) +
              (options.localRunner === undefined || found.provider !== "claude" ? "" : transcriptScript()),
          options.localRunner !== undefined,
          running,
          // Editor links (arc 6): three statements align or nothing renders —
          // the deployment capability, THIS machine's runner owning the run,
          // and the session's own device-side yes.
          options.editorLinks !== undefined &&
          options.localRunner !== undefined &&
          found.runner === options.localRunner &&
          who.via === "cookie" &&
          who.session.editorLinks === true &&
          // A reviewer run (v29) never had a checkout — no files to open.
          found.worktree !== null
            ? { worktree: found.worktree }
            : null,
          options.editorLinks !== undefined &&
          options.localRunner !== undefined &&
          found.runner === options.localRunner &&
          who.via === "cookie"
            ? { on: who.session.editorLinks === true }
            : null,
          url.searchParams.get("noted") === "1",
          (() => {
            const held = store.heldSessionOf(found.id);
            if (held === null) return null;
            const authorization = store.readAuthorization(held.authorizationId);
            return {
              turns: store.sessionTurnsOf(found.id),
              open: held.endedAt === null && held.state === "open",
              state:
                authorization === null
                  ? "session record"
                  : attendedWatchWords(authorization.lastBeatAt, now, authorization.absoluteExpiry),
              cap: authorization?.maxSessionTurns ?? 0,
            };
          })(),
          options.attended !== undefined &&
          who.via === "cookie" &&
          !store.isDemo() &&
          (found.outcome === "built" || found.outcome === "no-change") &&
          store.openAuthorizationFor(found.taskRef) === null
            ? { taskId }
            : null,
        ),
      );
    }

    const runArtifact = /^\/r\/([0-9]{1,15})\/evidence\/([0-9]{1,15})$/.exec(url.pathname);
    if (runArtifact !== null) {
      return runEvidence(response, Number(runArtifact[1]), Number(runArtifact[2]));
    }

    const contestPath = /^\/contest\/([0-9]{1,15})$/.exec(url.pathname);
    if (contestPath !== null) {
      return contestScreen(response, who, Number(contestPath[1]), null, 200);
    }

    if (url.pathname === "/caps") {
      if (project === null) {
        return sendScreen(response, 200, capsPage(chromeFor(project, "caps"), null, [], ""));
      }
      return sendScreen(
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
      // ?template=<name> pre-fills the filing form from the shipped
      // library — a pre-filled form, same guarded submission path.
      const fromTemplate = url.searchParams.get("template");
      const picked = fromTemplate === null ? null : templateByName(fromTemplate);
      return sendScreen(response, 200, routinesPage(chromeFor(project, "routines"), tracks, {
        csrf: who.via === "cookie" ? who.session.csrf : "",
        revision: who.via === "cookie" ? who.session.projectRevision : 0,
        problem: null,
        prefill:
          picked !== null && picked.kind === "routine"
            ? {
                name: picked.routineName,
                goal: picked.goal,
                not: picked.outOfScope ?? "",
                touches: picked.touches.join(", "),
                schedule: picked.schedule,
              }
            : null,
      }));
    }

    if (url.pathname === "/chat") {
      // Cookie sessions only (Codex v3 review, change 7): drafts live in
      // THIS session's memory; a bearer caller has nowhere to keep them.
      if (who.via !== "cookie") return refuse(response, who, 403, "chat is a browser surface — it keeps your drafts in the session");
      store.sweepStaleChatTurns(now);
      sweepChatDrafts(Date.now());
      const enabled = chatEnablement();
      const pending = store.liveChatTurnFor(who.name);
      const latched = enabled.ok ? store.latchedChatTurns(enabled.credentialKey) : [];
      return sendScreen(
        response,
        200,
        chatPage(chromeFor(project, "chat"), {
          enabled,
          pending,
          latched,
          chat: who.session.chat ?? null,
          recent: store.recentChatTurns(who.name, 10),
          turnsToday: store.chatTurnsToday(who.name, now),
          weeklySpent: enabled.ok ? store.chatWeeklySpendMicrousd(enabled.credentialKey, now) : 0,
          repoLabels: ceiling.repos.map((repo, index) => ({ id: `r${index + 1}`, label: projectName(repo) })),
          config: store.getChatConfig(),
          keyFacts: (["anthropic-api", "openrouter-api"] as const).map(one => {
            const found = chatKeyFor(one);
            return {
              provider: one,
              state: found === null ? "none" : found.source,
              tail: found === null || found.source === "environment" ? null : redactToken(found.key),
            };
          }),
          openrouterModels: (await chatCatalog())?.map(one => one.id) ?? null,
          csrf: who.session.csrf,
          problem: url.searchParams.get("said"),
        }),
      );
    }

    const chatAck = /^\/chat\/ack\/([0-9]{1,15})$/.exec(url.pathname);
    if (chatAck !== null) {
      if (who.via !== "cookie") return refuse(response, who, 403, "acknowledgement is a browser ceremony");
      const turn = store.getChatTurn(Number(chatAck[1]));
      if (turn === null || !turn.unknownSpend || turn.acknowledgedAt !== null) {
        return refuse(response, who, 404, "no acknowledgement is waiting there", "/chat");
      }
      // The one nonce in chat — this screen restates exact financial terms
      // and re-enables spend, which is precisely what nonces are for.
      const nonce = mintApprovalNonce(who.name, `chat-ack-${turn.id}`, String(turn.reservedMicrousd));
      return sendScreen(response, 200, chatAckPage(chromeFor(project, "chat"), turn, nonce, who.session.csrf));
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
      const messaging =
        options.configDir === undefined
          ? null
          : effectivePrimary(process.env, options.configDir, loadBotToken(process.env, options.telegramTokenFile) !== null);
      const push = {
        // The card lights only where a secure context exists: the stated
        // public origin, or localhost development (arc 3 finding 2).
        available: options.publicUrl !== undefined || (request.headers.host ?? "").startsWith("localhost") || (request.headers.host ?? "").startsWith("127.0.0.1"),
        devices: who.via === "cookie" ? store.listPushSubscriptions(who.name) : [],
      };
      const providerKeys = who.role !== "approver"
        ? null
        : (PROVIDER_IDS as readonly string[]).map(provider => ({
            provider,
            envName: PROVIDER_KEY_ENV[provider as "claude"],
            ...keyStatus(provider as "claude"),
            ambient: (process.env[PROVIDER_KEY_ENV[provider as "claude"]] ?? "") !== "",
            mode: readAuthMode(provider as "claude"),
            subscriptionCapable: SUBSCRIPTION_CAPABLE[provider as "claude"],
          }));
      return sendScreen(
        response,
        200,
        settingsPage(chromeFor(project, "settings"), existing, hasEnv, csrf, url.searchParams.get("said"), messaging, push, providerKeys),
      );
    }

    if (url.pathname === "/push/key") {
      // Session-gated: the key is not secret, but strangers get nothing.
      if (who.via !== "cookie") return respond(response, 403, "application/json", JSON.stringify({ error: "session" }));
      const keys = loadOrCreateVapidKeys(dirname(options.telegramTokenFile ?? "."));
      response.setHeader("cache-control", "no-store");
      return respond(response, 200, "application/json", JSON.stringify({ key: keys.publicKey }));
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
      return sendScreen(response, 200, decisionPage(chromeFor(project, "none"), decision, taskId, store.evidenceFor(decision.id), who, now));
    }

    const artifact = /^\/d\/([0-9]{1,15})\/evidence\/([0-9]{1,15})$/.exec(url.pathname);
    if (artifact !== null) {
      return decisionEvidence(response, Number(artifact[1]), Number(artifact[2]));
    }

    return respond(response, 404, "text/plain; charset=utf-8", "nothing here");
  }

  /**
   * The first-run checklist (adoption track, step 3) — derived from live
   * state on every render, never a stored cursor, and retired PERMANENTLY
   * by the first-success installation fact (Codex adoption review,
   * finding 14). Every step is either something this console already has
   * authority for, or the exact command where the CLI owns the act — the
   * checklist instructs, it never gains authority (finding e).
   */
  function wizardSteps(now: Date): { done: boolean; title: string; detail: string }[] | null {
    if (store.firstSuccessAt(now) !== null) return null;
    const repos = admissionList() ?? [];
    const setupDone = repos.filter(one => store.liveWorktreeSetup(one) !== null).length;
    const skillDone = repos.filter(one =>
      existsSync(join(one, ".claude", "skills", "standing-orders", "SKILL.md")),
    ).length;
    const counted = (done: number): string =>
      repos.length <= 1 ? "" : ` (${done} of ${repos.length} repos)`;
    return [
      {
        done: !unscopedMode,
        title: "name what this console may see",
        detail: unscopedMode
          ? `no ceiling is configured — this server currently shows everything. Restart it naming the repos: <code>standing-orders serve --repo &lt;path&gt; --port …</code>`
          : repos.length === 0
            ? `the ceiling is configured but empty — no repository is visible here`
            : `ceiling: ${repos.map(one => escape(projectName(one))).join(", ")}`,
      },
      {
        // A fact about THIS DATABASE only: binaries and authentication live
        // on the worker's machine, which may not be this one — the console
        // never claims to have checked them (finding 15).
        done: store.hasPhaseConfig(),
        title: "route the spend to a provider",
        detail: store.hasPhaseConfig()
          ? `spend routing is configured in this database. Binary and authentication facts stay machine-side: run <code>standing-orders providers</code> where the workers run`
          : `nothing routes builds to a provider yet: <code>standing-orders config set build --provider claude --as &lt;you&gt; --token &lt;t&gt;</code> — then check <code>standing-orders providers</code> on the worker's machine (installed, configured, historically-successful, and authenticated are four separate facts there)`,
      },
      {
        done: repos.length > 0 && setupDone === repos.length,
        title: "say how a fresh checkout gets ready",
        detail:
          setupDone > 0
            ? `setup command set${counted(setupDone)}`
            : `agents build in throwaway workspaces; give them the preparation step: <code>standing-orders setup set --repo &lt;path&gt; --command "npm ci"</code>`,
      },
      {
        done: repos.length > 0 && skillDone === repos.length,
        title: "teach the repo's agents this queue exists",
        detail:
          skillDone > 0
            ? `skill installed${counted(skillDone)}`
            : `<code>standing-orders skills install --repo &lt;path&gt;</code> previews; add <code>--yes</code> to write the skill file`,
      },
      {
        done: store.hasAnyWork(),
        title: "file the first standing order",
        detail: store.hasAnyWork()
          ? `work is filed — approve its scope and the machine takes it from there`
          : `start from a template below, capture a one-off task underneath, or browse <a href="/routines">routines</a>`,
      },
    ];
  }


  // ---- fleet chat (v13) ----------------------------------------------------

  const chatFetcher = options.chatFetcher ?? fetch;
  const chatEnv = options.chatEnv ?? process.env;
  const CHAT_CANDIDATES_PER_APPROVER = 9;
  const CHAT_CANDIDATE_TTL_MS = 30 * 60_000;

  /** The frozen explicit repo list, digested canonically (sorted) — every
   * candidate binds to it and filing re-proves it (v2 new finding 5). */
  const chatCeilingDigest = (): string =>
    createHash("sha256").update([...ceiling.repos].sort().join("\n")).digest("hex");

  type ChatEnablement =
    | { ok: true; config: NonNullable<ReturnType<Store["getChatConfig"]>>; key: string; keySource: "environment" | "stored"; price: import("./converse.js").ModelPrice; credentialKey: string }
    | { ok: false; code: "demo" | "unscoped" | "roots" | "unresolved" | "empty" | "unconfigured" | "unpriced" | "no-key"; why: string };

  /** Every condition re-proved per request — the render and the POST each
   * ask again; nothing is cached into authority. */
  function chatEnablement(): ChatEnablement {
    if (store.isDemo()) return { ok: false, code: "demo", why: "this is a demo database — chat spends money and refuses it" };
    if (unscopedMode) return { ok: false, code: "unscoped", why: "chat needs an explicit ceiling: restart serve naming repos with --repo" };
    if (ceiling.roots.length > 0) return { ok: false, code: "roots", why: "chat refuses root-derived ceilings — name each repo explicitly with --repo" };
    if (unresolvedRepos.length > 0) return { ok: false, code: "unresolved", why: "a --repo path did not resolve at startup — fix it and restart before chat will run" };
    if (ceiling.repos.length === 0) return { ok: false, code: "empty", why: "the ceiling is empty — chat has nothing it may see" };
    const config = store.getChatConfig();
    if (config === null) return { ok: false, code: "unconfigured", why: "chat is not configured yet — set it up below, or from the terminal: standing-orders config set chat" };
    const price = priceForConfig(config);
    if (price === null) return { ok: false, code: "unpriced", why: `no pinned price for ${config.model} — re-save the configuration to pin one` };
    const key = chatKeyFor(config.provider);
    if (key === null) return { ok: false, code: "no-key", why: `no ${config.provider} key — paste one below (stored 0600 beside the database, never in it), or export ${CHAT_KEY_ENV[config.provider]} in the serve environment` };
    return { ok: true, config, key: key.key, keySource: key.source, price, credentialKey: credentialKeyOf(config.provider, key.key) };
  }

  /**
   * Where a chat key comes from, in priority order: the serve process
   * environment, then the 0600 key file under the config directory (the
   * Telegram bot-token precedent — settable from the console, never the
   * database, never echoed whole). The file exists so onboarding lives
   * in the UI; the environment exists so operators who prefer it keep it.
   */
  function chatKeyFor(provider: ChatProviderId): { key: string; source: "environment" | "stored" } | null {
    const fromEnv = chatEnv[CHAT_KEY_ENV[provider]];
    if (fromEnv !== undefined && fromEnv !== "") return { key: fromEnv, source: "environment" };
    if (options.configDir === undefined) return null;
    try {
      const read = readFileSync(join(options.configDir, `chat-key-${provider}`), "utf8").trim();
      return read === "" ? null : { key: read, source: "stored" };
    } catch {
      return null;
    }
  }

  function storeChatKey(provider: ChatProviderId, key: string): { ok: true } | { ok: false; message: string } {
    if (options.configDir === undefined) {
      return { ok: false, message: "this server has no config directory — export the key in the serve environment instead" };
    }
    if (!plausibleChatKey(provider, key)) {
      return { ok: false, message: "that does not look like an API key (expected sk-…) — nothing was stored" };
    }
    const file = join(options.configDir, `chat-key-${provider}`);
    writeFsFileSync(file, `${key.trim()}\n`, { mode: 0o600 });
    // writeFileSync applies the mode only on creation; assert it regardless.
    chmodSync(file, 0o600);
    catalogCache = null; // a new key may see a different catalog
    return { ok: true };
  }

  function forgetChatKey(provider: ChatProviderId): void {
    if (options.configDir === undefined) return;
    try {
      rmFileSync(join(options.configDir, `chat-key-${provider}`));
    } catch {
      // never stored — nothing to forget
    }
    catalogCache = null;
  }

  /** OpenRouter's live catalog, cached briefly: every selectable model
   * arrives WITH the price the config will pin (operator request — the
   * whole catalog, not a hand-pinned shortlist). null = no key or the
   * catalog is unreachable; callers fall back to the compiled table. */
  let catalogCache: { at: number; models: import("./converse.js").CatalogModel[] } | null = null;
  async function chatCatalog(): Promise<import("./converse.js").CatalogModel[] | null> {
    const key = chatKeyFor("openrouter-api")?.key;
    if (key === undefined) return null;
    if (catalogCache !== null && Date.now() - catalogCache.at < 600_000) return catalogCache.models;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const got = await fetchOpenRouterCatalog(key, chatFetcher, controller.signal);
      if (!got.ok) return null;
      catalogCache = { at: Date.now(), models: got.models };
      return got.models;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Session-memory hygiene: drafts age out; a filed or dead session frees
   * its bytes; the per-approver cap spans ALL that approver's sessions. */
  function sweepChatDrafts(nowMs: number): void {
    for (const session of sessions.values()) {
      if (session.chat === undefined) continue;
      for (const [key, candidate] of session.chat.candidates) {
        if (nowMs - candidate.createdAt > CHAT_CANDIDATE_TTL_MS) session.chat.candidates.delete(key);
      }
    }
  }

  function approverCandidateCount(approver: string): number {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.chat === undefined) continue;
      for (const candidate of session.chat.candidates.values()) {
        if (candidate.approver === approver) count++;
      }
    }
    return count;
  }

  function evictOldestCandidate(approver: string): void {
    let oldest: { session: Session; key: string; at: number } | null = null;
    for (const session of sessions.values()) {
      if (session.chat === undefined) continue;
      for (const candidate of session.chat.candidates.values()) {
        if (candidate.approver !== approver) continue;
        if (oldest === null || candidate.createdAt < oldest.at) {
          oldest = { session, key: candidate.key, at: candidate.createdAt };
        }
      }
    }
    if (oldest !== null) oldest.session.chat?.candidates.delete(oldest.key);
  }

  /** The one network call a turn makes, run detached from the request that
   * opened it. Every failure maps to the closed enum BEFORE anything can
   * log it; a turn that may have started but has no usable usage LATCHES
   * (unknown spend blocks the credential until acknowledged).  */
  async function runChatTurn(turnId: number, session: Session, enabled: ChatEnablement & { ok: true }, userMessage: string, dataDocument: string): Promise<void> {
    const started = store.startChatTurn(turnId, new Date());
    if (!started.ok) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_WALL_CLOCK_MS);
    let result: Awaited<ReturnType<typeof performChatRequest>>;
    try {
      result = await performChatRequest(
        {
          provider: enabled.config.provider,
          model: enabled.config.model,
          key: enabled.key,
          dataDocument,
          userMessage,
          signal: controller.signal,
        },
        chatFetcher,
      );
    } catch {
      result = { ok: false, problem: "network" };
    } finally {
      clearTimeout(timer);
    }
    const finish = (outcome: Parameters<Store["finalizeChatTurn"]>[2]): boolean =>
      store.finalizeChatTurn(turnId, started.generation, outcome, new Date());
    const tell = (reply: string | null, staticError: string | null, proposalsDiscarded = false): void => {
      const chat = session.chat ?? { candidates: new Map(), lastTurn: null };
      chat.lastTurn = { id: turnId, reply, staticError, proposalsDiscarded };
      session.chat = chat;
    };
    if (!result.ok) {
      if (result.problem.startsWith("status-")) {
        // The provider ANSWERED with an error: nothing billed.
        finish({ state: "failed", failureReason: "provider-error", settledMicrousd: 0 });
        tell(null, "the provider refused the request — nothing was billed");
      } else if (result.problem === "timeout") {
        finish({ state: "failed", failureReason: "timeout", settledMicrousd: null, unknownSpend: true });
        tell(null, "the turn timed out; its cost is unknown and chat is blocked until you acknowledge it");
      } else if (result.problem === "network") {
        finish({ state: "failed", failureReason: "provider-error", settledMicrousd: null, unknownSpend: true });
        tell(null, "the provider could not be reached after dispatch; cost unknown — acknowledge to re-enable chat");
      } else {
        // 200 with an unusable wrapper: billed, amount unproven.
        finish({ state: "failed", failureReason: "malformed-reply", settledMicrousd: null, unknownSpend: true });
        tell(null, "the provider's response was malformed and was discarded; cost unknown — acknowledge to re-enable chat");
      }
      return;
    }
    // The pinned math, or the provider's own reported charge when that is
    // HIGHER — the ledger never undercounts what actually left the wallet.
    const pinnedSettle = settleForPrice(enabled.price, result.answer.tokensIn, result.answer.tokensOut);
    const settled = Math.max(pinnedSettle, result.answer.reportedCostMicrousd ?? 0);
    const envelope = parseAssistantEnvelope(result.answer.text);
    if (!envelope.ok) {
      finish({
        state: "failed",
        failureReason: "malformed-reply",
        tokensIn: result.answer.tokensIn,
        tokensOut: result.answer.tokensOut,
        settledMicrousd: settled,
      });
      tell(null, "the model's answer was malformed and was discarded");
      return;
    }
    const chat = session.chat ?? { candidates: new Map<string, ChatCandidate>(), lastTurn: null };
    session.chat = chat;
    let kept = 0;
    for (const draft of envelope.envelope.proposals) {
      const repoIndex = Number(draft.repoId.slice(1)) - 1;
      const repoPath = ceiling.repos[repoIndex];
      if (repoPath === undefined) continue;
      while (approverCandidateCount(session.name) >= CHAT_CANDIDATES_PER_APPROVER) evictOldestCandidate(session.name);
      const key = randomBytes(16).toString("hex");
      chat.candidates.set(key, {
        key,
        draft,
        repoPath,
        provider: enabled.config.provider,
        approver: session.name,
        ceilingDigest: chatCeilingDigest(),
        createdAt: Date.now(),
        state: "pending",
      });
      kept++;
    }
    finish({
      state: "answered",
      tokensIn: result.answer.tokensIn,
      tokensOut: result.answer.tokensOut,
      settledMicrousd: settled,
      replyBytes: Buffer.byteLength(envelope.envelope.reply, "utf8"),
      candidateCount: kept,
    });
    tell(envelope.envelope.reply, null, envelope.proposalsDiscarded);
  }

  /**
   * The palette's server-rendered index (attended review, finding 4): a
   * non-executable JSON block on an already-authorized page — the same
   * titles the page itself may render, bounded, saturation declared.
   */
  function paletteIndexTag(project: string | null): string {
    const admitted = project === null && !unscopedMode ? admissionList() : null;
    const entries: { label: string; href: string }[] = [
      { label: "inbox", href: "/" },
      { label: "board", href: "/board?scope=all" },
      { label: "queue", href: "/queue" },
      { label: "workbench", href: "/workbench" },
      { label: "routines", href: "/routines" },
      { label: "done", href: "/done" },
      { label: "review queue", href: "/review" },
      { label: "task list", href: "/tasks" },
      { label: "fleet", href: "/fleet" },
      { label: "activity", href: "/activity" },
      { label: "system", href: "/system" },
      { label: "builds", href: "/runs" },
      { label: "requirements", href: "/caps" },
      { label: "projects", href: "/projects" },
      ...(options.telegramTokenFile !== undefined ? [{ label: "settings", href: "/settings" }] : []),
    ];
    const open = store.paletteTasks(project, 201, admitted).filter(one => one.repo === null || visible(one.repo));
    for (const one of open.slice(0, 200)) {
      entries.push({ label: `${one.id} — ${one.title}`, href: `/t/${encodeURIComponent(one.id)}` });
    }
    const saturated = open.length > 200;
    const json = JSON.stringify(saturated ? [...entries, { label: "… more in the task list", href: "/tasks" }] : entries)
      .replace(/</g, "\\u003c");
    return `<script type="application/json" id="palette-index">${json}</script>`;
  }

  /**
   * The palette cache (arc 4, finding 6), and its honest contract: a
   * render may be up to five seconds stale after OUT-OF-PROCESS changes;
   * an accepted in-process mutation invalidates immediately (bustBadge),
   * so "one query per five seconds" holds only between invalidations;
   * and an OPEN page keeps its navigation-time snapshot until the next
   * navigation — no refresh mechanism exists or is promised. The key
   * carries the one configuration bit the entries vary by.
   */
  const paletteCache = new Map<string, { at: number; tag: string }>();
  function paletteTagCached(project: string | null): string {
    const key = `${project ?? "(none)"} ${options.telegramTokenFile !== undefined}`;
    const hit = paletteCache.get(key);
    if (hit !== undefined && Date.now() - hit.at < 5000) return hit.tag;
    const tag = paletteIndexTag(project);
    paletteCache.set(key, { at: Date.now(), tag });
    return tag;
  }

  /**
   * Every chromed HTML response leaves through here (arc 4, findings
   * 5/18): one place owns the sensitivity call, the nonce, the palette
   * index, the shortcuts overlay, script composition, and the CSP —
   * at most one nonce-bearing script per response, connect-src only when
   * that script fetches. The named exception: /fleet and /settings keep
   * their FUNCTIONAL scripts beside credential fields (a poller and the
   * push enrollment — neither reads the fields); the chrome additions
   * are what sensitivity strips.
   */
  function sendScreen(response: ServerResponse, status: number, s: Screen): void {
    const sensitive =
      s.forceSensitive === true ||
      SENSITIVE_INPUT.test(s.body) ||
      (s.chrome?.listPane !== undefined && SENSITIVE_INPUT.test(s.chrome.listPane));
    const chromeLayer = !sensitive && s.chrome !== undefined;
    const functional = s.functional?.script ?? "";
    // Sensitive pages strip the palette and keys but keep the MINIMAL beat
    // (round-1 finding 3): reading a ceremony for a minute must not lapse
    // every other session. The beat reads no DOM and posts no parameters.
    // …except the one-time-secret pages (forceSensitive): those stay
    // script-free absolutely, and simply do not keep sessions alive.
    const sensitiveBeat = sensitive && s.forceSensitive !== true && s.chrome !== undefined ? beatScript() : "";
    const script = functional + (chromeLayer ? chromeScript() : sensitiveBeat);
    const nonce = script === "" ? undefined : randomBytes(16).toString("base64");
    const body = chromeLayer
      ? `${s.body}\n${paletteTagCached(s.chrome?.project ?? null)}\n${KBD_HELP}`
      : s.body;
    const html = shell(s.title, body, {
      ...(s.chrome === undefined ? {} : { chrome: s.chrome }),
      ...(s.refreshSeconds === undefined ? {} : { refreshSeconds: s.refreshSeconds }),
      ...(nonce === undefined ? {} : { live: { nonce, script, fallbackRefresh: s.functional?.fetches === true } }),
    });
    // v28: the chrome layer itself fetches (the attended beat), so any
    // page that ships it needs connect-src — not only pages whose own
    // functional script polls.
    return page(response, status, html, nonce, s.functional?.fetches === true || chromeLayer);
  }

  /** The badge cache: five seconds per project — mutations invalidate it. */
  const badgeCache = new Map<string, { at: number; count: number; saturated: boolean }>();
  const bustBadge = (): void => {
    badgeCache.clear();
    paletteCache.clear();
  };

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
      const counted = store.countInboxScoped(project, clock(), 100, project === null && !unscopedMode ? admissionList() : null);
      badge = { at: Date.now(), count: counted.count, saturated: counted.saturated };
      badgeCache.set(key, badge);
    }
    const liveMode = project === null ? null : store.activeMode(project, clock());
    const liveModeTerms = liveMode === null ? null : modeTermsFromJson(liveMode.termsJson);
    return {
      active,
      project,
      inboxCount: badge.count,
      inboxSaturated: badge.saturated,
      settings: options.telegramTokenFile !== undefined,
      ...(store.isDemo() ? { demo: true } : {}),
      ...(liveMode === null || liveModeTerms === null
        ? {}
        : {
            modeBanner: {
              name: liveMode.name,
              words: `${liveMode.name} mode until ${liveMode.absoluteExpiry.slice(0, 16).replace("T", " ")} UTC${
                liveModeTerms.autoApproveFiling ? ` — every scope ${liveMode.signedBy} files builds without further ceremony` : ""
              }${liveModeTerms.permissionDefault === "escalated" ? " — FULL permissions by default" : ""}${
                liveModeTerms.quickMint ? ` — ${liveMode.signedBy} starts watched sessions without a password` : ""
              }${liveModeTerms.publication === "automerge" ? " — merges fire themselves on green" : ""}`,
            },
          }),
      ...(!unscopedMode && ceiling.roots.length === 0 && ceiling.repos.length > 0 ? { chat: true } : {}),
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

  /**
   * The one liveness fact (round-4 findings 14/15): a run is being built
   * right now iff its outcome is null AND its lease is the task's current
   * live claim \u2014 maximum generation, unreleased, strictly unexpired. Every
   * "running" label, poller, and watch link derives from this; nothing
   * ever infers liveness from a null outcome alone.
   */
  function runIsLive(run: Pick<Run, "outcome" | "leaseId" | "taskRef">): boolean {
    return run.outcome === null && store.currentLiveLease(run.taskRef, clock()) === run.leaseId;
  }

  /** The live subset of a bounded run page \u2014 one indexed lookup per row. */
  function liveRunIds(rows: readonly (Pick<Run, "id" | "outcome" | "leaseId" | "taskRef">)[]): Set<number> {
    const live = new Set<number>();
    for (const run of rows) if (runIsLive(run)) live.add(run.id);
    return live;
  }

  /** The compact recent-runs list for the master pane. */
  function runListPane(project: string | null, currentId: number | null): string {
    const rows = store.listRunsBefore(null, 50, project);
    const live = liveRunIds(rows);
    const items = rows
      .map(
        run =>
          `<a class="item${run.id === currentId ? " current" : ""}" href="/r/${run.id}">` +
          `<span class="t">#${run.id} \u00b7 ${escape(run.taskId)}</span>` +
          `<span class="m">${runOutcomeBadge(run, live.has(run.id))}` +
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
    const now = clock();
    const recent = store.listProjects().filter(one => visible(one.path));
    const recentPaths = new Set(recent.map(one => one.path));
    const candidates = new Set<string>();
    for (const path of [...ceiling.repos, ...store.knownRepos()]) {
      const canonical = canonicalProject(path) ?? path;
      if (!recentPaths.has(canonical) && visible(canonical)) candidates.add(canonical);
    }
    const open = who.via === "cookie" ? who.session.project : null;
    const csrf = who.via === "cookie" ? who.session.csrf : "";
    // Onboarding availability (findings 2/28/32/39): a cookie session on a
    // root-configured, non-demo, POSIX serve gets the live card; everybody
    // else gets the card DISABLED with the reason in words.
    const onboardState =
      who.via !== "cookie"
        ? { enabled: false as const, why: "adding repositories is a browser session's act" }
        : store.isDemo()
          ? { enabled: false as const, why: "the sandbox never clones — this is demo data" }
          : process.platform === "win32"
            ? { enabled: false as const, why: "adding from GitHub is not supported on Windows yet" }
            : ceiling.roots.length === 0
              ? {
                  enabled: false as const,
                  why: `naming where repositories live takes --project-root — restart ${options.upConsole === true ? "`standing-orders up --project-root <dir>`" : "serve with --project-root <dir>"} and this card comes alive`,
                }
              : { enabled: true as const, roots: ceiling.roots, record: [...(who.session.onboard?.entries() ?? [])][0] ?? null };
    // A cheap peek per project for the switcher cards — one small set of
    // COUNTs each, scoped to the exact repo.
    const peekOf = (path: string) => {
      try {
        return store.projectPeek(path, now);
      } catch {
        return null;
      }
    };
    const peeks: Record<string, { waiting: number; queued: number; running: number; doneRecently: number } | null> = {};
    for (const one of recent) peeks[one.path] = peekOf(one.path);
    for (const path of candidates) peeks[path] = peekOf(path);
    return sendScreen(
      response,
      status,
      projectsPage(chromeFor(open, "projects"), recent, [...candidates], open, csrf, problem, unscopedMode, ceiling.roots.length > 0 || unscopedMode, onboardState, peeks),
    );
  }

  /** The task screen, shared by the GET and by every refusal that re-renders it. */
  /**
   * What a revision task's approval must restate (M6.8): the exact comment
   * batch, read back through the verified artifact path. A brief that no
   * longer verifies is a named problem on the screen — approving against
   * bytes nobody can prove is not approving anything.
   */
  function revisionViewOf(ref: ReturnType<Store["lookupRef"]>): RevisionView | null {
    if (ref === null || ref.revisionBriefArtifact === null) return null;
    const artifact = store.getArtifact(ref.revisionBriefArtifact);
    if (artifact === null) return { problem: "the revision brief is missing from this build's records" };
    const read = readVerifiedArtifact(evidenceRoot, artifact);
    if (!read.ok) return { problem: `the revision brief no longer verifies — ${read.problem}` };
    try {
      const parsed = JSON.parse(read.content.toString("utf8")) as {
        sourceTask?: unknown;
        sourceRun?: unknown;
        comments?: { path?: unknown; line?: unknown; note?: unknown; author?: unknown }[];
      };
      return {
        sourceTask: String(parsed.sourceTask ?? "?"),
        sourceRun: Number(parsed.sourceRun ?? 0),
        comments: (parsed.comments ?? []).slice(0, 100).map(one => ({
          path: one.path === null || one.path === undefined ? null : String(one.path),
          line: one.line === null || one.line === undefined ? null : Number(one.line),
          note: String(one.note ?? ""),
          author: String(one.author ?? "?"),
        })),
      };
    } catch {
      return { problem: "the revision brief did not parse" };
    }
  }

  /** The task view's facts, shared by the full screen and the workbench
   * pane (attended A1): one assembly, one authorization story. */
  function taskViewData(taskId: string, who: Who, problem: string | null): Parameters<typeof taskBody>[0] | null {
    const found = store.getTask(taskId);
    if (found === null) return null;
    const ref = store.lookupRef(taskId);
    if (ref !== null && !visible(ref.repo)) return null;
    const now = clock();
    const scope = store.getScope(taskId);
    const revision = revisionViewOf(ref);
    // A broken revision brief blocks the whole approval surface (audit
    // IV-3): no nonce is minted over a batch nobody can verify.
    const revisionBroken = revision !== null && "problem" in revision;
    // A tournament task's yes covers BOTH documents (finding 31): where
    // race terms are filed, the digest being shown — and bound by the
    // nonce — is the joint fingerprint, never the scope's alone.
    const raceTerms = ref === null ? null : store.activeTournamentTerms(ref.id);
    const approvalDigest =
      scope === null ? null : raceTerms === null ? scope.digest : jointApprovalDigest(scope.digest, raceTerms.raceDigest);
    // The nonce is minted at render, per viewer, bound to the digest being
    // shown — the browser approval flow starts here and nowhere else.
    const nonce =
      who.via === "cookie" && scope !== null && approvalDigest !== null && !approvalOf(scope).approved && !revisionBroken
        ? mintApprovalNonce(who.name, taskId, approvalDigest)
        : "";
    return {
        task: found,
        strikes: ref?.strikes ?? 0,
        plan: ref?.plan ?? null,
        planDocument: ref === null ? null : planDocumentOf(ref.id),
        revision,
        repo: ref?.repo ?? null,
        filedVia: store.filedViaOf(taskId),
        holds: ref === null ? [] : store.activeHolds(ref.id, now),
        contest: (() => {
          if (ref === null) return null;
          const open = store.contestNeedingOperator(ref.id);
          return open === null ? null : { id: open.id, state: open.state, agents: store.contestants(open.id).length, kind: open.kind };
        })(),
        claimed: ref === null ? false : store.hasLiveClaim(ref.id, now),
        // The chain, both directions of trust: blockers outside the ceiling
        // are named but wear no state and no link (same redaction the board
        // applies to blockerState).
        waitsFor: store.blockers(taskId).map(blockerId => {
          const blockerRef = store.lookupRef(blockerId);
          const admitted = blockerRef !== null && visible(blockerRef.repo);
          const blocker = admitted ? store.getTask(blockerId) : null;
          return { id: blockerId, state: blocker === null ? null : blocker.state, admitted };
        }),
        // Candidates a "wait for" select may offer: the OPEN project's own
        // open work, never itself. A projectless roll-up session gets no
        // select at all — the roll-up never lists across projects.
        waitCandidates:
          who.via !== "cookie" || (who.session.project === null && !unscopedMode)
            ? []
            : store
                .listTasksScoped(who.session.project, undefined, 100, null)
                .filter(one => one.id !== taskId && one.state !== "done" && one.state !== "cancelled" && visible(one.repo))
                .map(one => ({ id: one.id, title: one.title })),
        // The one liveness fact, computed here where the store is: the run
        // whose lease is the task's CURRENT claim — not merely the first
        // unfinished run (round-4 finding, A1).
        liveRunId: (() => {
          if (ref === null) return null;
          const found = store.runsFor(ref.id).find(one => runIsLive(one));
          return found === undefined ? null : found.id;
        })(),
        peekable: options.localRunner !== undefined,
        position: store.queuePosition(taskId),
        mirror: store.mirrorByTask(taskId),
        scope,
        raceTerms,
        approvalDigest,
        spendDefaults: store.getSpendDefaults(),
        publication: (() => {
          // The latest publication across this task's runs, with its
          // OBSERVED CI state (audit SD-5): the reviewer learns PR and CI
          // here instead of spelunking run pages.
          if (ref === null) return null;
          for (const one of store.runsFor(ref.id)) {
            const found = store.publicationForRun(one.id);
            if (found !== null) return found;
          }
          return null;
        })(),
        runs: ref === null ? [] : store.runsFor(ref.id),
        decisions: ref === null ? [] : store.decisionsForTask(ref.id),
        incidents: ref === null ? [] : store.incidentsForTask(ref.id),
        steering: ref === null ? [] : store.listSteerNotes(ref.id),
        csrf: who.via === "cookie" ? who.session.csrf : "",
        nonce,
        problem,
        attended: (() => {
          if (options.attended === undefined || ref === null || who.via !== "cookie" || store.isDemo()) return null;
          const open = store.openAuthorizationFor(ref.id);
          if (open !== null) {
            const spent = store.authorizationSpendMicrousd(open.id);
            const turnsUsed =
              open.attemptRun === null ? 0 : store.sessionTurnsOf(open.attemptRun).length;
            const state = attendedWatchWords(open.lastBeatAt, now, open.absoluteExpiry);
            return {
              canMint: false,
              open: {
                id: open.id,
                state,
                expiresAt: open.absoluteExpiry,
                turnsUsed,
                cap: open.maxSessionTurns,
                spentMicrousd: spent,
                budgetMicrousd: open.budgetMicrousd,
                running: open.attemptRun !== null,
              },
            };
          }
          const canMint =
            scope !== null &&
            !approvalOf(scope).approved &&
            scope.profileState === "resolved" &&
            (scope.profile?.provider ?? "") === "claude" &&
            ref.repo !== null &&
            store.activeTournamentTerms(ref.id) === null &&
            store.getTask(taskId)?.state === "queued";
          if (!canMint) return { canMint, open: null };
          const pinnedModel = scope?.profile?.provider === "claude" ? scope.profile.model : "";
          const configured = ["plan", "build", "repair", "review"]
            .map(phase => store.phaseConfig(INSTALLATION_SCOPE, phase))
            .filter((row): row is NonNullable<typeof row> => row !== null && row.provider === "claude" && row.model !== null)
            .map(row => row.model as string);
          const models = [...new Set([pinnedModel, ...configured])].filter(model => model !== "");
          const liveMode = ref.repo === null ? null : store.activeMode(ref.repo, now);
          const modeTerms = liveMode === null ? null : modeTermsFromJson(liveMode.termsJson);
          return {
            canMint,
            mint: {
              models,
              pinnedModel,
              posture: modeTerms?.permissionDefault === "escalated" ? ("bypassPermissions" as const) : ("acceptEdits" as const),
              quick: modeTerms?.quickMint === true && liveMode !== null && liveMode.signedBy === who.name,
            },
            open: null,
          };
        })(),
        now,
      };
  }

  function taskScreen(
    response: ServerResponse,
    who: Who,
    taskId: string,
    problem: string | null,
    status: number,
  ): void {
    const data = taskViewData(taskId, who, problem);
    if (data === null) return refuse(response, who, 404, "no such task", "/tasks");
    const paneProject = who.via === "cookie" ? who.session.project : null;
    return sendScreen(
      response,
      status,
      taskPage(
        paneProject === null && !unscopedMode
          ? chromeFor(paneProject, "tasks")
          : chromeFor(paneProject, "tasks", taskListPane(paneProject, taskId)),
        data,
      ),
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
    return sendScreen(
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


  // ---- the live peek (A2; three review rounds' findings are the spec) ----
  //
  // Names and counts only, never content; nothing durable, ever. The cache
  // holds finished ESCAPED fragments keyed by run:base:epoch — the epoch
  // rotates with every lease AND release, so a stale entry's key can never
  // be asked for again; hits still re-prove the whole guard list.
  const peekCache = new Map<string, { fragment: string; at: number }>();
  let peekCacheBytes = 0;
  const peekInFlight = new Map<string, Promise<string>>();
  const peekBySession = new Map<string, number>();
  const PEEK_CACHE_TTL_MS = 10_000;
  const PEEK_CACHE_ENTRIES = 8;
  const PEEK_CACHE_BYTES = 256 * 1024;
  const PEEK_FRAGMENT_BYTES = 32 * 1024;
  const PEEK_GLOBAL_INFLIGHT = 4;
  const PEEK_SESSION_INFLIGHT = 2;

  const peekEvict = () => {
    for (const [key, entry] of peekCache) {
      if (peekCache.size <= PEEK_CACHE_ENTRIES && peekCacheBytes <= PEEK_CACHE_BYTES) break;
      peekCache.delete(key);
      peekCacheBytes -= Buffer.byteLength(entry.fragment);
    }
  };

  /** One typed sentence inside the region — plain words, no raw errors.
   * `final` marks conditions that cannot heal for this run (finished,
   * superseded, wrong machine): the region poller reads the marker and
   * stops, instead of refetching a dead build every beat forever. */
  const peekSay = (message: string, final = false): string =>
    `<p class="meta"${final ? " data-region-stop" : ""}>${escape(message)}</p>`;

  /** The sanitize pipeline (finding 30/35): normalize → mask → escape. */
  const peekName = (path: string): string => {
    const normalized = path.replace(/[\u0000-\u001f\u007f]/g, "");
    const masked = scanForSecrets(normalized).length > 0 ? "[redacted: a credential-shaped name]" : normalized;
    return escape(masked);
  };

  type PeekAdmission = {
    run: Run;
    /** The run's checkout, PROVEN non-null by the guards: a reviewer run
     * (v29, artifact-only) is refused before admission ever forms. */
    worktree: string;
    epoch: string;
    entries: ReturnType<typeof parseBaseTreeSnapshot>;
  };

  /** The full guard list (v3 §4) — run on every request, hit or miss. */
  function peekGuards(runId: number): { ok: true; admit: PeekAdmission & { entries: NonNullable<PeekAdmission["entries"]> } } | { ok: false; message: string; final?: boolean } {
    if (options.localRunner === undefined || options.poolRoot === undefined) {
      return { ok: false, message: "live peek is off — start serve with --runner <name> naming this machine's runner", final: true };
    }
    const run = store.getRun(runId);
    if (run === null || !runVisible(run)) return { ok: false, message: "no such build", final: true };
    if (run.outcome !== null) return { ok: false, message: "this build has finished — the final diff below is the record", final: true };
    // The reviewer role (v29): artifact-only, honestly — there is no
    // checkout anywhere to watch, and there never was.
    if (run.worktree === null) {
      return { ok: false, message: "this run reviewed the sealed diff — no workspace existed to watch", final: true };
    }
    if (run.baseRevision === null) return { ok: false, message: "the build has not settled its starting point yet" };
    // The run's lease must be the task's CURRENT live lease — max generation,
    // unreleased, strictly unexpired. liveClaimByLease proves only that the
    // lease exists; a superseded lease would still pass it (round-4
    // finding 15), and superseded is forever, so the poller may stop.
    if (store.currentLiveLease(run.taskRef, clock()) !== run.leaseId) {
      return { ok: false, message: "the build is not actively running right now", final: true };
    }
    const row = store.getWorktree(run.worktree);
    if (row === null || row.taskRef !== run.taskRef) return { ok: false, message: "the checkout is not where the record says" };
    if (row.runner !== options.localRunner) {
      return { ok: false, message: "this build runs on another machine — open the console there to watch it", final: true };
    }
    // Adoption-path rows can carry no epoch (round-3 finding 37): no fence,
    // no peek — never a guess.
    if (row.leaseEpoch === null || row.leaseEpoch === undefined) {
      return { ok: false, message: "this checkout was set up before live watching existed — the next fresh build can be watched", final: true };
    }
    try {
      const real = realpathSync(run.worktree);
      const pool = realpathSync(options.poolRoot);
      if (real !== run.worktree || !(real === pool || real.startsWith(`${pool}/`)) || !lstatSync(run.worktree).isDirectory()) {
        return { ok: false, message: "the checkout is not inside this machine's pool" };
      }
    } catch {
      return { ok: false, message: "the checkout could not be found on this machine" };
    }
    // The snapshot: exactly one successful, untruncated base-tree artifact
    // whose envelope binds THIS run and THIS base (round-3 finding 42).
    const artifact = store.artifactsFor(runId).find(one => one.kind === "base-tree");
    if (artifact === undefined) return { ok: false, message: "no base snapshot was captured for this build" };
    if (artifact.captureStatus !== "ok" || artifact.truncated) {
      return { ok: false, message: "the base snapshot did not capture cleanly — this build cannot be watched live" };
    }
    const read = readVerifiedArtifact(evidenceRoot, artifact);
    if (!read.ok) return { ok: false, message: "the base snapshot no longer verifies" };
    const snapshot = parseBaseTreeSnapshot(read.content.toString("utf8"));
    if (snapshot === null || snapshot.run !== runId || snapshot.base !== run.baseRevision) {
      return { ok: false, message: "the base snapshot does not match this build" };
    }
    return { ok: true, admit: { run, worktree: run.worktree, epoch: row.leaseEpoch, entries: snapshot } };
  }

  async function peekFragment(runId: number, sessionKey: string, editorMode = false): Promise<{ status: number; body: string; retryAfter?: number }> {
    const guarded = peekGuards(runId);
    if (!guarded.ok) return { status: 200, body: peekSay(guarded.message, guarded.final === true) };
    const { run, worktree, epoch, entries } = guarded.admit;
    // The cache and the in-flight coalescer both vary by LINK MODE (arc 6,
    // finding 3): a linked fragment rendered for one session must never be
    // served to a session that has not activated links on its device.
    const key = `${runId}:${run.baseRevision}:${epoch}:${editorMode ? "links" : "plain"}`;
    const cached = peekCache.get(key);
    if (cached !== undefined && Date.now() - cached.at <= PEEK_CACHE_TTL_MS) {
      return { status: 200, body: cached.fragment };
    }
    if (cached !== undefined) {
      peekCache.delete(key);
      peekCacheBytes -= Buffer.byteLength(cached.fragment);
    }
    // Coalesce per run; bound per session and globally (finding 10).
    const flightKey = `${runId}:${editorMode ? "links" : "plain"}`;
    const inFlight = peekInFlight.get(flightKey);
    if (inFlight !== undefined) return { status: 200, body: await inFlight };
    if (peekInFlight.size >= PEEK_GLOBAL_INFLIGHT) return { status: 429, body: peekSay("the live view is busy — it retries by itself"), retryAfter: 10 };
    if ((peekBySession.get(sessionKey) ?? 0) >= PEEK_SESSION_INFLIGHT) {
      return { status: 429, body: peekSay("too many live views from this session"), retryAfter: 10 };
    }
    peekBySession.set(sessionKey, (peekBySession.get(sessionKey) ?? 0) + 1);
    const work = (async (): Promise<string> => {
      const seen = await observeWorktree(worktree, entries.entries, PEEK_LIMITS);
      // The fence, proved AGAIN after the walk (findings 16/28): the same
      // run still open, the same claim, the SAME epoch — or the whole
      // observation is discarded, never rendered, never cached.
      const after = peekGuards(runId);
      if (!after.ok || after.admit.epoch !== epoch) {
        return peekSay("the checkout changed hands mid-look — nothing is shown");
      }
      if (!seen.ok) return peekSay(seen.reason);
      const stamp = clock().toISOString().slice(11, 19);
      const parts: string[] = [
        `<p class="meta">best-effort look at ${escape(stamp)} UTC — files can change mid-read</p>`,
      ];
      const changed = seen.rows.filter(one => one.kind === "changed");
      const deleted = seen.rows.filter(one => one.kind === "deleted");
      const unchecked = seen.rows.filter(one => one.kind === "unchecked");
      const fresh = aggregateNewNames(seen.newPaths);
      if (changed.length === 0 && deleted.length === 0 && fresh.total === 0) {
        parts.push(`<p class="row">nothing has changed against the starting point yet</p>`);
      }
      // A name is linked ONLY when sanitize provably changed nothing (arc 6,
      // finding 3): a masked or normalized label must never carry an href
      // that discloses what the mask hid. Collapsed labels never link.
      const linkedName = (path: string): string => {
        const shown = peekName(path);
        if (!editorMode || shown !== escape(path)) return shown;
        const href = editorFileHref(worktree, path);
        return href === null ? shown : `<a href="${escape(href)}">${shown}</a>`;
      };
      const line = (row: { path: string; detail: string }, mark: string): string =>
        `<p class="row mono">${mark} ${linkedName(row.path)} <span class="meta">${escape(row.detail)}</span></p>`;
      for (const row of changed) parts.push(line(row, "~"));
      for (const row of deleted) parts.push(line(row, "−"));
      if (fresh.total > 0) {
        parts.push(`<p class="meta">new files · ${fresh.total}</p>`);
        for (const row of fresh.rows) {
          parts.push(
            row.collapsed
              ? `<p class="row mono">+ ${peekName(row.label)} <span class="meta">collapsed names — ${row.count} files</span></p>`
              : `<p class="row mono">+ ${peekName(row.label)}</p>`,
          );
        }
        if (fresh.renderedFiles < fresh.total) {
          parts.push(`<p class="meta">…and ${fresh.total - fresh.renderedFiles} more (${fresh.total} new files total)</p>`);
        }
      }
      if (unchecked.length > 0) {
        parts.push(`<p class="meta">not verified this look — absence above does not mean unchanged:</p>`);
        for (const row of unchecked) parts.push(line(row, "?"));
      }
      if (seen.partial !== null) parts.push(`<p class="meta">${escape(seen.partial)}</p>`);
      let fragment = parts.join("\n");
      if (Buffer.byteLength(fragment) > PEEK_FRAGMENT_BYTES) {
        // The byte cap is enforced AFTER escaping (finding 32): an oversize
        // rendering is replaced whole by its exact counts.
        fragment =
          `<p class="meta">best-effort look at ${escape(stamp)} UTC</p>` +
          `<p class="row">${changed.length} changed · ${deleted.length} deleted · ${fresh.total} new · ${unchecked.length} unverified — too much to render live; the final diff will hold the detail</p>`;
      }
      peekCache.set(key, { fragment, at: Date.now() });
      peekCacheBytes += Buffer.byteLength(fragment);
      peekEvict();
      return fragment;
    })();
    peekInFlight.set(flightKey, work);
    try {
      return { status: 200, body: await work };
    } finally {
      peekInFlight.delete(flightKey);
      const left = (peekBySession.get(sessionKey) ?? 1) - 1;
      if (left <= 0) peekBySession.delete(sessionKey);
      else peekBySession.set(sessionKey, left);
    }
  }

  /**
   * The tournament's comparison data: the pick view plus everything the
   * page states — the task behind it, per-agent question counts, and the
   * money totals. The ceiling is proved here, on the server-resolved repo,
   * whatever the request named.
   */
  function contestData(contestId: number): {
    view: NonNullable<ReturnType<typeof buildPickView>>;
    taskId: string;
    taskTitle: string;
    repo: string | null;
    refOrigin: string;
    questions: Map<number, number>;
    liveRuns: Set<number>;
    totalMicrousd: number;
    anyUnknown: boolean;
    rollups: Map<number, { costMicrousd: number; tokensIn: number; tokensOut: number; measuredRuns: number; totalRuns: number }>;
  } | null {
    const view = buildPickView(store, evidenceRoot, contestId);
    if (view === null) return null;
    const ref = store.refForId(view.contest.taskRef);
    if (ref === null || (ref.repo !== null && !visible(ref.repo))) return null;
    const found = store.getTask(ref.externalId);
    if (found === null) return null;
    // Question counts follow run lineage: every run belonging to the agent,
    // not just its final one — a parked question is part of its story.
    const byRun = new Map<number, number>();
    for (const one of store.runsFor(view.contest.taskRef)) {
      if (one.contestant !== null) byRun.set(one.id, one.contestant);
    }
    const questions = new Map<number, number>();
    for (const decision of store.decisionsForTask(view.contest.taskRef)) {
      const owner = byRun.get(decision.run);
      if (owner !== undefined) questions.set(owner, (questions.get(owner) ?? 0) + 1);
    }
    return {
      rollups: new Map(view.agents.map(agent => [agent.contestant.id, store.contestantSpendRollup(agent.contestant.id)])),
      view,
      taskId: ref.externalId,
      taskTitle: found.title,
      repo: ref.repo,
      refOrigin: ref.origin,
      questions,
      // An interrupted tournament's agents are STOPPED, not "still
      // working" — their run records stay unfinished, so the card must
      // prove liveness the same way every other surface does (round-4
      // finding 16).
      liveRuns: liveRunIds(view.agents.flatMap(agent => (agent.run === null ? [] : [agent.run]))),
      totalMicrousd: view.agents.reduce((sum, agent) => sum + agent.contestant.accountedMicrousd, 0),
      anyUnknown: view.agents.some(agent => agent.contestant.unknownSpend),
    };
  }

  function contestScreen(
    response: ServerResponse,
    who: Who,
    contestId: number,
    problem: string | null,
    status: number,
  ): void {
    const data = contestData(contestId);
    if (data === null) return refuse(response, who, 404, "no such tournament", "/board");
    const paneProject = who.via === "cookie" ? who.session.project : null;
    const diffs = new Map<number, TerminalDiffView | null>();
    for (const agent of data.view.agents) {
      if (agent.run !== null) diffs.set(agent.contestant.id, terminalDiffView(store.artifactsFor(agent.run.id), evidenceRoot));
    }
    return sendScreen(
      response,
      status,
      contestPage(chromeFor(paneProject, "tasks"), {
        ...data,
        diffs,
        csrf: who.via === "cookie" ? who.session.csrf : "",
        problem,
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
          const words =
            approved.reason === "profile-unresolved"
              ? "not approved: the routine cannot say exactly what would run — set a build model (config set build --model \u2026) and restate it"
              : `not approved: ${approved.reason}`;
          return routinePage(response, who, routineId, words, status);
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

  /** v28: the console-scoped liveness beat — see the route note in
   * handlePost. Supersedes v2 S2f's per-page id binding, reversed
   * KNOWINGLY: with parallel sessions one foregrounded tab per session is
   * impossible, and page-binding was attention theater over what was
   * always renewal-of-use. Approver-bound; never extends cookies, never
   * touches absolute expiry, never mints. */
  function attendedBeats(who: Who, request: IncomingMessage, response: ServerResponse, now: Date): void {
    if (who.via !== "cookie") return refuse(response, who, 403, "watching is a browser session's act");
    // Round-2 finding 2's named miss: renewal is an approver's act — a
    // viewer's open tab keeps nothing alive.
    if (who.role !== "approver") return refuse(response, who, 403, "your login can watch, not keep sessions alive");
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      return refuse(response, who, 403, "the beat only answers this console's own pages");
    }
    // Belt with the braces: a PRESENT Origin/Referer must also name this
    // server — the same allowlist the shared guard applies.
    const namedOrigin =
      typeof request.headers.origin === "string" && request.headers.origin !== "null"
        ? request.headers.origin
        : typeof request.headers.referer === "string"
          ? request.headers.referer
          : null;
    if (namedOrigin !== null && !allowedHost(namedOrigin.replace(/^https?:[/][/]/, "").split("/")[0])) {
      return refuse(response, who, 403, "origin not allowed");
    }
    const attendedRunner = options.attended?.runner;
    let beaten = 0;
    if (attendedRunner !== undefined) {
      for (const open of store.openAuthorizationsOf(attendedRunner)) {
        if (open.approver !== who.name) continue;
        if (Date.parse(open.absoluteExpiry) <= now.getTime()) continue;
        // Only terms SIGNED for console-wide renewal are renewed here
        // (round-1 finding 2): a legacy page-bound signature never
        // silently acquires the wider mode — it simply lapses.
        try {
          const signedMode = (JSON.parse(open.termsJson) as { attentionMode?: unknown }).attentionMode;
          if (signedMode !== "console-visible") continue;
        } catch {
          continue;
        }
        const beatRef = store.refForId(open.taskRef);
        if (beatRef === null || !visible(beatRef.repo)) continue;
        store.beatAuthorization(open.id, now);
        if (open.attemptRun !== null) options.attended?.coordinator?.poke(open.attemptRun);
        beaten++;
      }
    }
    return respond(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, beaten }));
  }

  async function handlePost(
    url: URL,
    who: Who,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await form(request);

    // The attended beat answers BEFORE the shared mutation guard (v28): it
    // carries no parameters, so there is no csrf token to check — its OWN
    // guard is complete and STRICTER for the browsers this console
    // supports: cookie session, form content-type (form() enforced it),
    // and `Sec-Fetch-Site: same-origin`, which cross-site POSTs cannot
    // send and same-origin fetch always does. Renewal-only: an attacker
    // who somehow posted could only keep the operator's OWN sessions from
    // lapsing — no mint, no spend, no read.
    if (url.pathname === "/session/attended-beats") {
      return attendedBeats(who, request, response, clock());
    }

    const denied = authorizeMutation(request, who, body);
    if (denied !== null) return refuse(response, who, denied.status, denied.message);

    // THE CENTRAL VIEWER GATE (modes chain, D2/E2): consequential POSTs
    // require ACTIVE approver standing — cookie and bearer alike — with
    // an EXACT allowlist of session-local acts, never a prefix. /login,
    // /logout and /join answer before this handler; the attended beat
    // guards itself (approver-only) above.
    if (who.role === "viewer") {
      const viewerAllowed = new Set(["/projects/select", "/session/editor-links"]);
      if (!viewerAllowed.has(url.pathname)) {
        return refuse(response, who, 403, "your login can watch, not act — ask an approver to upgrade you");
      }
    }
    const now = clock();
    // Any accepted mutation may change what the inbox owes; the badge
    // re-counts within five seconds either way, this just makes it exact.
    bustBadge();

    if (url.pathname === "/settings/messaging" && options.configDir !== undefined && options.telegramTokenFile !== undefined) {
      const wanted = (body.get("primary") ?? "").trim();
      const facts = effectivePrimary(process.env, options.configDir, loadBotToken(process.env, options.telegramTokenFile) !== null);
      // Only a CONFIGURED service may page — choosing silence is not a
      // selection, and an unconfigured primary would page nobody.
      if (!isMessagingChannel(wanted) || !facts.configured.includes(wanted)) {
        return refuse(response, who, 400, "primary must be one of the configured services");
      }
      savePrimary(options.configDir, wanted);
      return redirect(response, "/settings");
    }

    if (url.pathname === "/settings/provider-key" || url.pathname === "/settings/provider-key-clear") {
      // The central gate already required an ACTIVE approver; the value is
      // write-only from here — status pages say set/not-set, never bytes.
      const provider = body.get("provider") ?? "";
      if (!isProviderId(provider)) return refuse(response, who, 400, "unknown provider", "/settings");
      if (url.pathname === "/settings/provider-key-clear") {
        const cleared = clearProviderKey(provider);
        const clearedMode = readAuthMode(provider);
        return redirect(response, `/settings?said=${encodeURIComponent(
          !cleared
            ? "no stored key to remove"
            : clearedMode === "subscription"
              ? `the ${provider} key is removed — ${provider} uses its own login, so builds are unaffected`
              : `the ${provider} key is removed — an environment variable, if one exists, takes over`,
        )}`);
      }
      // Validate EVERYTHING before mutating anything (Codex round 5,
      // finding 2): an invalid key must never persist a mode change it
      // then hides, a mode equal to the current one is not a "change",
      // and an unchanged blank form does nothing.
      const wantedMode = body.get("auth-mode");
      const value = (body.get("value") ?? "").trim();
      const modeSelected = wantedMode === "subscription" || wantedMode === "api-key";
      const currentMode = readAuthMode(provider);
      if (!modeSelected && value === "") {
        return refuse(response, who, 400, "nothing to change — paste a key or pick a sign-in", "/settings");
      }
      // A selected-but-inapplicable mode (openrouter subscription) refuses
      // before any write.
      if (modeSelected && wantedMode === "subscription" && !SUBSCRIPTION_CAPABLE[provider]) {
        return refuse(response, who, 409, `${provider} has no subscription login — it is API-key only`, "/settings");
      }
      // A present key must be plausible BEFORE the mode is touched.
      if (value !== "" && !plausibleKey(value)) {
        return refuse(response, who, 400, "that does not look like an API key — check the paste and try again", "/settings");
      }
      // Apply the mode only when it actually differs.
      const modeChanged = modeSelected && wantedMode !== currentMode;
      if (modeChanged) setAuthMode(provider, wantedMode as AuthMode);
      const modeNote = modeChanged ? ` \u00b7 ${provider} now uses ${wantedMode === "api-key" ? "the API key" : "its own subscription / login"}` : "";
      if (value === "") {
        return redirect(response, `/settings?said=${encodeURIComponent(modeChanged ? `${provider} now uses ${wantedMode === "api-key" ? "the API key" : "its own subscription / login"}` : `no change — ${provider} already uses ${currentMode === "api-key" ? "the API key" : "its own subscription / login"}`)}`);
      }
      saveProviderKey(provider, value); // known plausible
      // Verify right now, so a paste gets an immediate yes/no instead of a
      // failed build later. A stored-but-unreachable key still says so.
      const verdict = await verifyProviderKey(provider, value);
      const stored = `the ${provider} key is stored`;
      return redirect(response, `/settings?said=${encodeURIComponent((verdict.ok ? `${stored} and verified — it works` : `${stored}. ${verdictWords(provider, verdict)}`) + modeNote)}`);
    }

    if (url.pathname === "/settings/telegram-token" && options.telegramTokenFile !== undefined) {
      const value = body.get("token") ?? "";
      const saved = saveBotToken(options.telegramTokenFile, value);
      if (!saved.ok) {
        const existing = loadBotToken({}, options.telegramTokenFile);
        const hasEnv = process.env[TOKEN_ENV] !== undefined && process.env[TOKEN_ENV] !== "";
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        return sendScreen(response, 400, settingsPage(chromeFor(who.via === "cookie" ? who.session.project : defaultProject, "settings"), existing, hasEnv, csrf, saved.message));
      }
      return redirect(response, "/settings");
    }

    if (url.pathname === "/projects/select") {
      // Session-only project switching (E2): reads the registry, writes
      // ONLY session.project — the durable upsert lives in /projects/open,
      // which stays an approver's act. This is the one project verb a
      // viewer may use.
      if (who.via !== "cookie") {
        return refuse(response, who, 403, "selecting a project is a browser session's act");
      }
      const askedPath = (body.get("path") ?? "").trim();
      const canonicalPick = askedPath === "" ? null : canonicalProject(askedPath);
      if (canonicalPick !== null && !(await authorizedProject(ceiling, canonicalPick))) {
        return refuse(response, who, 403, "that project is outside this console's reach");
      }
      who.session.project = canonicalPick;
      who.session.projectRevision += 1;
      return redirect(response, body.get("return") ?? "/");
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
      // The EFFECTIVE placement (repo onboarding, findings 15/35): the
      // trimmed, nonempty posted repo, else the open project — an empty
      // input falls through correctly. In root mode the effective path is
      // proved by authorizedProject EXACTLY as typed-then-canonicalized,
      // and [canonical] is the admitted list — a fresh clone under a root
      // must be able to receive its first task without waiting to appear
      // in any table.
      const repoGiven = (body.get("repo") ?? "").trim();
      const effective = repoGiven !== "" ? repoGiven : (project ?? "");
      // A scoped console refuses an EMPTY placement server-side (verification
      // finding 1): the form's `required` is a courtesy, not the guard — a
      // direct POST with no project open must not mint an unplaced task
      // under a ceiling. Unscoped mode keeps its historic unplaced filings.
      if (!unscopedMode && effective === "") {
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        return sendScreen(
          response,
          400,
          tasksPage(chromeFor(project, "tasks"), store.listTasksScoped(project, undefined, 200, null), null, csrf, "name a repository — no project is open, so the task must say where it belongs", project),
        );
      }
      let repo = effective;
      let admitted: string[] | null = unscopedMode ? null : admissionList() ?? [];
      const rootMode = !unscopedMode && ceiling.roots.length > 0;
      if (rootMode && effective !== "") {
        const canonical = (await authorizedProject(ceiling, effective)) ? canonicalProject(effective) : null;
        if (canonical === null || canonical === undefined) {
          const csrf = who.via === "cookie" ? who.session.csrf : "";
          return sendScreen(
            response,
            403,
            tasksPage(chromeFor(project, "tasks"), store.listTasksScoped(project, undefined, 200, null), null, csrf, `${effective} is outside what this server was configured to show`, project),
          );
        }
        repo = canonical;
        admitted = [canonical];
      }
      const goal = (body.get("goal") ?? "").trim();
      const notThis = (body.get("not") ?? "").trim();
      const touchesGiven = (body.get("touches") ?? "")
        .split(/[\n,]/)
        .map(one => one.trim())
        .filter(one => one !== "");
      // One filing door for every surface (Codex adoption review, finding 7).
      const made = fileTaskProposal(
        store,
        {
          ...(id === "" ? {} : { id }),
          title,
          ...(repo === "" ? {} : { repo }),
          ...(goal === "" ? {} : { goal }),
          outOfScope: notThis === "" ? null : notThis,
          touches: touchesGiven,
          filedVia: "console",
          ...(admitted === null ? {} : { admittedRepos: admitted }),
        },
        now,
      );
      if (!made.ok) {
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        return sendScreen(
          response,
          made.reason === "backlog-full" ? 429 : 400,
          tasksPage(chromeFor(project, "tasks"), store.listTasksScoped(project, undefined, 200, null), null, csrf, made.message, project),
        );
      }
      // A proved root-mode placement joins the project table (finding 15):
      // the new task's home is openable and admissible from now on.
      if (rootMode && repo !== "") store.upsertProject(repo, projectName(repo), now);
      // "starts after": a chain filed with the work. The task ALREADY
      // exists at this point, so a bad chain must not lose it — the new
      // task's page renders with the un-made wait named instead.
      const after = (body.get("after") ?? "").trim();
      if (after !== "") {
        const afterRef = store.lookupRef(after);
        const chained =
          store.getTask(after) !== null && afterRef !== null && visible(afterRef.repo)
            ? store.addEdge(made.id, after)
            : { ok: false as const, reason: "that task does not exist here" };
        if (!chained.ok) {
          return taskScreen(response, who, made.id, `the task was created, but could not be made to wait for ${after} — ${chained.reason}`, 200);
        }
      }
      return redirect(response, taskHref(made.id));
    }

    if (url.pathname === "/queue/move" || url.pathname === "/queue/note") {
      const project = projectOf(who, request);
      if (project === undefined) {
        return refuse(response, who, 403, "that project is outside what this server was configured to show");
      }
      // The note is a global runner label, not project-scoped work: the
      // fleet screen (project-less) posts it too, so the null-project gate
      // applies only to moves, which the task-level check below re-proves.
      if (url.pathname === "/queue/note") {
        const worker = (body.get("runner") ?? "").trim();
        const note = (body.get("note") ?? "").trim();
        if (note.length > 200 || hasForbiddenControls(note)) {
          return refuse(response, who, 400, "that note will not render, so it will not store", "/queue");
        }
        const set = store.setRunnerQueueNote(worker, note === "" ? null : note);
        if (!set.ok) return refuse(response, who, 404, "no such worker", "/queue");
        return redirect(response, body.get("from") === "fleet" ? "/fleet" : "/queue");
      }
      if (who.via === "cookie") {
        const seen = body.get("projectRevision");
        if (seen !== null && seen !== String(who.session.projectRevision)) {
          return refuse(response, who, 409, "the open project changed since this form was rendered — reload and try again", "/queue");
        }
      }
      // A drag posts in place (fetch) when it can; the page re-renders its
      // own fragment on success. A plain form still works with no script.
      const inPlace = body.get("respond") === "fragment";
      const fromFleet = who.via === "cookie" && body.get("projectRevision") === null;
      const respondMove = (status: number, message: string): void => {
        if (!inPlace) return status === 409 ? refuse(response, who, 409, message, "/queue") : redirect(response, "/queue");
        respond(response, status, "text/plain; charset=utf-8", message);
      };
      const moveReason = (reason: string): string =>
        reason === "stale"
          ? "the queue moved underneath you — it just reloaded"
          : reason === "claimed" || reason === "contest-open"
            ? "that task is being taken right now — it keeps its claim"
            : reason === "worker-retired"
              ? "that worker is retired — drag its work elsewhere, or register the name again"
              : reason === "no-such-worker"
                ? "no such worker"
                : "that task is not in this queue any more";
      const taskId = (body.get("task") ?? "").trim();
      const columnGiven = (body.get("column") ?? "").trim();
      const toRunner = columnGiven === "" || columnGiven === "anyone" ? null : columnGiven;
      const beforeGiven = (body.get("before") ?? "").trim();
      const revisionGiven = Number(body.get("queueRevision") ?? "");
      // The queue's own screen enforces the open project; the fleet screen
      // is cross-project, so the ceiling is the only wall it needs.
      const belongs = (id: string): boolean => {
        const ref = store.lookupRef(id);
        return ref !== null && visible(ref.repo) && (fromFleet || project === null || ref.repo === null || ref.repo === project);
      };
      if (!belongs(taskId) || (beforeGiven !== "" && !belongs(beforeGiven))) {
        return respondMove(404, "that task is not in this queue");
      }
      const moved = store.moveTask(
        {
          taskId,
          toRunner,
          beforeTaskId: beforeGiven === "" ? null : beforeGiven,
          ...(Number.isSafeInteger(revisionGiven) ? { queueRevision: revisionGiven } : {}),
        },
        clock(),
      );
      if (!moved.ok) {
        return respondMove(409, moveReason(moved.reason));
      }
      return respondMove(200, "moved");
    }

    // Runner lifecycle, brought in from the terminal behind the same
    // password step-up the console uses for every other credential-grade
    // act. Register mints a token that is shown ONCE and stored only as a
    // hash — the page that shows it renders no self-refreshing script, so
    // the token is never re-rendered.
    if (url.pathname === "/fleet/runner/register") {
      if (who.via !== "cookie") return refuse(response, who, 403, "runner registration is a browser surface");
      const token = body.get("token") ?? "";
      if (token === "" || !authenticateApprover(store, who.name, token).ok) {
        return refuse(response, who, 403, "registering a worker takes your password, typed again", "/fleet");
      }
      const name = (body.get("name") ?? "").trim();
      if (name === "" || name.length > 60 || /[\r\n\t]/.test(name) || hasForbiddenControls(name)) {
        return refuse(response, who, 400, "a worker's name is one short line, no control characters", "/fleet");
      }
      const capacity = Number((body.get("capacity") ?? "1").trim() || "1");
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) {
        return refuse(response, who, 400, "capacity is a whole number of tasks, 1 to 64", "/fleet");
      }
      const { token: minted } = registerRunner(store, { name, host: hostname(), capacity, now });
      const tokenScreen = screen(
        "fleet",
        [
          `<h1>fleet</h1>`,
          `<div class="card">`,
          `<h2 style="margin-top:0">${escape(name)} is registered</h2>`,
          `<p class="meta">its token — shown once, stored only as a hash, never recoverable:</p>`,
          `<p class="mono" style="overflow-wrap:anywhere">${escape(minted)}</p>`,
          `<p class="meta">keep it beside the worker (a 0600 file, a manager). If it is lost, register the name again — the old claims are taken back automatically.</p>`,
          `</div>`,
          `<p class="meta"><a href="/fleet">back to the fleet</a></p>`,
        ].join("\n"),
        // A one-time secret on screen: no script of any kind rides along.
        { chrome: chromeFor(projectOf(who, request) ?? null, "fleet"), forceSensitive: true },
      );
      return sendScreen(response, 200, tokenScreen);
    }

    if (url.pathname === "/mode/confirm" || url.pathname === "/mode/sign") {
      if (who.via !== "cookie") return refuse(response, who, 403, "signing a mode is a browser ceremony");
      const project = projectOf(who, request);
      if (project === null || project === undefined) {
        return refuse(response, who, 409, "open a project first — a mode is signed per repository", "/mode");
      }
      const name: ModeName = body.get("name") === "hands-off" ? "hands-off" : "standard";
      const days = Math.max(1, Math.min(MODE_MAX_DAYS, Math.floor(Number(body.get("days") ?? "1")) || 1));
      const expiry = new Date(now.getTime() + days * 24 * 60 * 60_000).toISOString();
      const preset = presetTerms(name, expiry);
      const terms: ModeTerms = {
        ...preset,
        autoApproveFiling: body.get("auto-approve") === "" || body.get("auto-approve") === null ? preset.autoApproveFiling : body.get("auto-approve") === "1",
        reviewAuto: body.get("review-auto") === "" || body.get("review-auto") === null ? preset.reviewAuto : body.get("review-auto") === "1",
        // The paid-fallback grant is NEVER a preset default (R8): unchecked
        // stays false on every preset — only the explicit box grants it.
        allowPaidFallback: body.get("allow-paid-fallback") === "1",
        publication: body.get("publication") === "automerge" ? "automerge" : "notify",
      };
      if (terms.publication === "automerge" && !store.hasMergeCapableGrant(project, now)) {
        return refuse(response, who, 409, "self-merging needs a merge-capable publication grant first — grant one, then sign", "/mode");
      }
      const digest = modeDigestOf(terms);

      if (url.pathname === "/mode/confirm") {
        // THE CEREMONY (M1): every resolved term in words, and the password
        // signs exactly this digest — a drifted form refuses at /mode/sign.
        const nonce = mintApprovalNonce(who.name, "mode-sign", digest);
        const bodyHtml =
          `<h1>sign the ${escape(name)} mode for ${escape(project)}</h1>` +
          `<form method="post" action="/mode/sign" class="card approve-form">` +
          `<input type="hidden" name="csrf" value="${escape(who.session.csrf)}">` +
          `<input type="hidden" name="nonce" value="${escape(nonce)}">` +
          `<input type="hidden" name="digest" value="${escape(digest)}">` +
          ["name", "days", "publication", "auto-approve", "review-auto", "allow-paid-fallback"]
            .map(field => `<input type="hidden" name="${field}" value="${escape(body.get(field) ?? "")}">`)
            .join("") +
          `<input type="hidden" name="expiry" value="${escape(expiry)}">` +
          `<p><strong>your password signs exactly this:</strong></p>` +
          modeWords(terms)
            .map(words => `<p class="recap" style="margin-top:.4rem">${escape(words)}</p>`)
            .join("") +
          `<label>your password, typed again<input type="password" name="token" autocomplete="current-password"></label>` +
          `<div class="sticky-actions"><button type="submit">sign it</button></div>` +
          `</form>` +
          `<p class="meta"><a href="/mode">back — sign nothing</a></p>`;
        return sendScreen(response, 200, screen("mode", bodyHtml, { chrome: chromeFor(project, "menu") }));
      }

      // /mode/sign: the fixed expiry rides the form; the digest is
      // RE-DERIVED from the posted fields — drift is a 409, never a guess.
      const fixedExpiry = body.get("expiry") ?? "";
      const signedTerms: ModeTerms = { ...terms, absoluteExpiry: fixedExpiry };
      const rederived = modeDigestOf(signedTerms);
      const nonce = body.get("nonce") ?? "";
      if (!consumeApprovalNonce(nonce, who.name, "mode-sign", body.get("digest") ?? "")) {
        return refuse(response, who, 409, "that form is stale — read the terms again", "/mode");
      }
      if (rederived !== (body.get("digest") ?? "") || Date.parse(fixedExpiry) <= now.getTime()) {
        return refuse(response, who, 409, "the terms moved while you were reading — read them again", "/mode");
      }
      const token = body.get("token") ?? "";
      if (token === "" || !authenticateApprover(store, who.name, token).ok) {
        return refuse(response, who, 403, "signing a mode takes your password, typed again", "/mode");
      }
      store.signMode(
        {
          repo: project,
          name: signedTerms.name,
          termsJson: modeTermsJson(signedTerms),
          digest: rederived,
          signedBy: who.name,
          absoluteExpiry: signedTerms.absoluteExpiry,
          publication: signedTerms.publication,
        },
        now,
      );
      return redirect(response, "/mode");
    }

    if (url.pathname === "/mode/revoke") {
      if (who.via !== "cookie") return refuse(response, who, 403, "ending a mode is a browser act");
      const project = projectOf(who, request);
      if (project === null || project === undefined) return refuse(response, who, 409, "open a project first", "/mode");
      // LOWERING authority is ONE CLICK for any approver (the v4 ruling):
      // csrf only, no password — the fastest possible off-switch.
      const ended = store.revokeMode(project, who.name, "operator", now);
      return redirect(response, ended ? "/mode?said=the%20mode%20is%20ended%20—%20every%20act%20falls%20back%20to%20its%20own%20ceremony" : "/mode");
    }

    if (url.pathname === "/people/invite") {
      if (who.via !== "cookie") return refuse(response, who, 403, "inviting is a browser surface");
      const token = body.get("token") ?? "";
      // RAISING authority is a password ceremony (the doctrine): adding a
      // person to the instance is exactly that.
      if (token === "" || !authenticateApprover(store, who.name, token).ok) {
        return refuse(response, who, 403, "making an invite takes your password, typed again", "/people");
      }
      const role = body.get("role") === "approver" ? ("approver" as const) : ("viewer" as const);
      const minted = store.mintInvite(role, who.name, now);
      const origin = options.publicUrl !== undefined ? options.publicUrl.replace(/\/$/, "") : `http://${request.headers.host ?? "this-console"}`;
      const linkScreen = screen(
        "people",
        [
          `<h1>people</h1>`,
          `<div class="card">`,
          `<h2 style="margin-top:0">the invite link \u2014 shown once</h2>`,
          `<p class="mono" style="overflow-wrap:anywhere">${escape(`${origin}/join/${minted.token}`)}</p>`,
          `<p class="meta">send it to ONE person. It works once, lets them ${role === "approver" ? "approve and act" : "watch everything"}, and dies ${escape(minted.expiresAt.slice(0, 16).replace("T", " "))} UTC. Cancel it any time from the people screen.</p>`,
          `</div>`,
          `<p class="meta"><a href="/people">back to people</a></p>`,
        ].join("\n"),
        // A one-time secret on screen: no script of any kind rides along.
        { chrome: chromeFor(projectOf(who, request) ?? null, "people"), forceSensitive: true },
      );
      return sendScreen(response, 200, linkScreen);
    }

    if (url.pathname === "/people/invite-revoke") {
      if (who.via !== "cookie") return refuse(response, who, 403, "inviting is a browser surface");
      const token = body.get("token") ?? "";
      if (token === "" || !authenticateApprover(store, who.name, token).ok) {
        return refuse(response, who, 403, "cancelling an invite takes your password, typed again", "/people");
      }
      const id = Number(body.get("id") ?? "");
      const revoked = Number.isInteger(id) && id > 0 && store.revokeInvite(id, now);
      return redirect(response, `/people?said=${encodeURIComponent(revoked ? "the invite is cancelled — its link is dead" : "that invite was already gone")}`);
    }

    if (url.pathname === "/people/revoke") {
      if (who.via !== "cookie") return refuse(response, who, 403, "removing a person is a browser surface");
      const token = body.get("token") ?? "";
      if (token === "" || !authenticateApprover(store, who.name, token).ok) {
        return refuse(response, who, 403, "removing a person takes your password, typed again", "/people");
      }
      const name = (body.get("name") ?? "").trim();
      const severed = store.revokeAccount(name, who.name, now);
      if (!severed.ok) {
        const words =
          severed.reason === "last-approver"
            ? "that is the last account that can approve — add another approver first"
            : severed.reason === "already-revoked"
              ? `${name} is already removed`
              : `no account \u0060${name}\u0060`;
        return refuse(response, who, severed.reason === "last-approver" ? 409 : 404, words, "/people");
      }
      return redirect(
        response,
        `/people?said=${encodeURIComponent(`${name} can no longer sign in — their sessions, invites, and signed modes ended with them; history stays`)}`,
      );
    }

    if (url.pathname === "/fleet/runner/retire") {
      if (who.via !== "cookie") return refuse(response, who, 403, "runner retirement is a browser surface");
      const token = body.get("token") ?? "";
      if (token === "" || !authenticateApprover(store, who.name, token).ok) {
        return refuse(response, who, 403, "retiring a worker takes your password, typed again", "/fleet");
      }
      const name = (body.get("name") ?? "").trim();
      const retired = store.retireRunner(name, now);
      if (!retired) return refuse(response, who, 404, `no worker \`${name}\``, "/fleet");
      return redirect(response, `/fleet?said=${encodeURIComponent(`${name} is retired — its queued work is still here, drag it elsewhere`)}`);
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
      return redirect(response, body.get("return") === "next" ? "/next" : `/d/${id}`);
    }

    const contestAct = /^\/contest\/([0-9]{1,15})\/(arm|pick|abandon)$/.exec(url.pathname);
    if (contestAct !== null) {
      const contestId = Number(contestAct[1]);
      const verb = contestAct[2] as "arm" | "pick" | "abandon";
      const data = contestData(contestId);
      if (data === null) return refuse(response, who, 404, "no such tournament", "/board");
      const { view } = data;

      if (verb === "arm") {
        // The ceremony's nonce is minted by THIS POST, never by a GET
        // (round-3 finding 30): a prefetched or crawled page must not mint
        // anything. The response is the ceremony form itself, carrying the
        // nonce value; its hash lives in a durable row bound to the exact
        // tuple digest being restated.
        const abandoning = body.get("act") === "abandon";
        if (abandoning) {
          if (!["pick-wait", "exhausted", "interrupted", "decision-wait"].includes(view.contest.state)) {
            return contestScreen(response, who, contestId, "this tournament is not in a state an operator can abandon", 409);
          }
          const digest = pickTupleDigest(view, { abandon: true }, { grant: null, head: null });
          const nonceValue = randomBytes(18).toString("base64url");
          const minted = store.mintCeremonyNonce(
            { hash: nonceHashOf(nonceValue), approver: who.name, subject: "contest-abandon", subjectId: contestId, digest, ttlMs: 15 * 60_000 },
            now,
          );
          if (!minted.ok) return contestScreen(response, who, contestId, "too many unfinished confirmations are open — finish or let them expire", 429);
          return sendScreen(response, 200, contestCeremonyPage(chromeFor(who.via === "cookie" ? who.session.project : null, "tasks"), {
            kind: "abandon", contestKind: view.contest.kind, contestId, taskId: data.taskId, taskTitle: data.taskTitle,
            agents: view.agents.length, totalMicrousd: data.totalMicrousd, anyUnknown: data.anyUnknown,
            nonceValue, csrf: who.via === "cookie" ? who.session.csrf : "",
          }));
        }
        if (view.contest.state !== "pick-wait") {
          return contestScreen(response, who, contestId, "this tournament is not waiting for a pick", 409);
        }
        const choice = Number(body.get("choice") ?? "");
        const plan = computePickPlan(store, view, choice, data.repo, data.refOrigin);
        if (!plan.ok) return contestScreen(response, who, contestId, plan.message, 409);
        const nonceValue = randomBytes(18).toString("base64url");
        const minted = store.mintCeremonyNonce(
          { hash: nonceHashOf(nonceValue), approver: who.name, subject: "contest-pick", subjectId: contestId, digest: plan.digest, ttlMs: 15 * 60_000 },
          now,
        );
        if (!minted.ok) return contestScreen(response, who, contestId, "too many unfinished confirmations are open — finish or let them expire", 429);
        return sendScreen(response, 200, contestCeremonyPage(chromeFor(who.via === "cookie" ? who.session.project : null, "tasks"), {
          kind: "pick", contestKind: view.contest.kind, contestId, taskId: data.taskId, taskTitle: data.taskTitle,
          agents: view.agents.length, totalMicrousd: data.totalMicrousd, anyUnknown: data.anyUnknown,
          chosen: plan.chosen,
          publication: plan.publishable && plan.grant !== null && plan.chosen.run.branch !== null ? { githubRepo: plan.grant.githubRepo, branch: plan.chosen.run.branch, draft: plan.grant.draft } : null,
          nonceValue, csrf: who.via === "cookie" ? who.session.csrf : "",
        }));
      }

      // pick and abandon: the password, typed again, plus the nonce the arm
      // POST minted. The store consumes the nonce conditionally inside the
      // same transaction that moves the tournament — replay finds it gone.
      const token = body.get("token") ?? "";
      if (token === "" || !authenticateApprover(store, who.name, token).ok) {
        return contestScreen(response, who, contestId, "that decision takes your password, typed again", 403);
      }
      const nonceValue = body.get("nonce") ?? "";
      if (nonceValue === "") return contestScreen(response, who, contestId, "that confirmation form was incomplete — start again", 400);

      if (verb === "pick") {
        const choice = Number(body.get("choice") ?? "");
        const picked = finalizeContestPick(store, {
          contestId, contestantId: choice, approver: who.name, nonceValue,
          evidenceRoot, repo: data.repo, taskId: data.taskId, refOrigin: data.refOrigin,
        }, now);
        if (!picked.ok) return contestScreen(response, who, contestId, picked.message, 409);
        return redirect(response, `/contest/${contestId}`);
      }

      const gone = abandonContest(store, { contestId, approver: who.name, nonceValue, evidenceRoot, taskId: data.taskId }, now);
      if (!gone.ok) return contestScreen(response, who, contestId, gone.message, 409);
      return redirect(response, `/contest/${contestId}`);
    }

    const attendAct = matchTaskPath(url.pathname, "/(attend-preview|attend|attend-revoke)$");
    if (attendAct !== null) {
      return attendMutation(response, who, attendAct.taskId, attendAct.verb, body, now);
    }

    const act = matchTaskPath(url.pathname, "/(hold|unhold|requeue|cancel|scope|approve|plan|block|unblock|next|reopen|steer)$");
    if (act !== null) {
      return taskMutation(response, who, act.taskId, act.verb, body, now);
    }

    if (url.pathname === "/projects/onboard-preview" || url.pathname === "/projects/onboard-confirm") {
      // Repo onboarding (findings 1-39): bearer and demo refuse BEFORE any
      // gh call; the console flow exists only on root-configured serves.
      if (who.via !== "cookie") return refuse(response, who, 403, "adding repositories is a browser session's act");
      if (store.isDemo()) return refuse(response, who, 403, "the sandbox never clones");
      if (process.platform === "win32") return refuse(response, who, 403, "adding from GitHub is not supported on Windows yet");
      if (ceiling.roots.length === 0) return projectsScreen(response, who, "naming where repositories live takes --project-root", 400);

      if (url.pathname === "/projects/onboard-preview") {
        const shape = parseGithubRepo(body.get("repo") ?? "");
        if (!shape.ok) return projectsScreen(response, who, shape.problem, 400);
        // Roots by INDEX (finding 13) — a posted path is never accepted.
        const rootIndex = Number(body.get("root") ?? "0");
        const rootRaw = Number.isInteger(rootIndex) ? ceiling.roots[rootIndex] : undefined;
        if (rootRaw === undefined) return projectsScreen(response, who, "pick one of the configured roots", 400);
        let root: string;
        try {
          root = realpathSync(rootRaw);
        } catch {
          return projectsScreen(response, who, "that projects root does not resolve right now", 400);
        }
        const previewed = await (options.ghPreview ?? previewGithubRepo)(shape.owner, shape.name);
        if (!previewed.ok) return projectsScreen(response, who, previewed.message, 400);
        const reparsed = parseGithubRepo(previewed.preview.nameWithOwner);
        if (!reparsed.ok) return projectsScreen(response, who, "GitHub named a repository shape this console refuses", 400);
        // The hook boundary is NORMALIZED like the real preview would be
        // (verification finding 2): a size that is not a nonnegative finite
        // number is unknown, and unknown is LARGE.
        const diskUsageKib =
          typeof previewed.preview.diskUsageKib === "number" && Number.isFinite(previewed.preview.diskUsageKib) && previewed.preview.diskUsageKib >= 0
            ? previewed.preview.diskUsageKib
            : null;
        const target = join(root, reparsed.name);
        if (dirname(target) !== root) return projectsScreen(response, who, "the target escaped its root — refused", 400);
        // The session-held record (finding 14): swept at mint, capped 3.
        const session = who.session;
        session.onboard ??= new Map();
        const cutoff = Date.now() - 10 * 60_000;
        for (const [key, record] of session.onboard) if (record.mintedAt < cutoff) session.onboard.delete(key);
        if (session.onboard.size >= 3) return projectsScreen(response, who, "three previews are already waiting — confirm or let one expire", 400);
        const nonce = randomBytes(16).toString("hex");
        session.onboard.set(nonce, {
          nameWithOwner: previewed.preview.nameWithOwner,
          rootIndex,
          target,
          diskUsageKib,
          large: isLargeRepo({ ...previewed.preview, diskUsageKib }),
          mintedAt: Date.now(),
        });
        return projectsScreen(response, who, null, 200);
      }

      // CONFIRM: password, then session liveness AGAIN via lookupSession
      // (finding 22/33) — the record is consumed from the RETURNED live
      // session, synchronously, before the first await.
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(store, who.name, password).ok) {
        return projectsScreen(response, who, "cloning takes your password, typed again", 403);
      }
      const cookieId = /(?:^|;\s*)standing-orders_session=([0-9a-f]{64})/.exec(request.headers.cookie ?? "")?.[1];
      const live = cookieId === undefined ? null : lookupSession(cookieId, false);
      if (live === null) return refuse(response, who, 403, "this session ended while the form was open — sign in again");
      const nonce = body.get("nonce") ?? "";
      const record = live.onboard?.get(nonce);
      if (record === undefined || record.mintedAt < Date.now() - 10 * 60_000) {
        live.onboard?.delete(nonce);
        return projectsScreen(response, who, "that preview expired or was already used — preview again", 400);
      }
      live.onboard?.delete(nonce); // consumed BEFORE the first await
      if (record.large && body.get("big-ok") !== "1") {
        return projectsScreen(response, who, "that repository is large (or its size is unknown) — tick the box to clone it anyway", 400);
      }
      const rootRaw = ceiling.roots[record.rootIndex];
      if (rootRaw === undefined) return projectsScreen(response, who, "the configured roots changed — preview again", 400);
      let root: string;
      try {
        root = realpathSync(rootRaw);
      } catch {
        return projectsScreen(response, who, "that projects root does not resolve right now", 400);
      }
      if (dirname(record.target) !== root) return projectsScreen(response, who, "the configured roots changed — preview again", 400);

      const cloned = await (options.ghClone ?? cloneGithubRepo)(record.nameWithOwner, root, async (cwd: string) => {
        const answer = await execRun("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15_000 });
        return { code: answer.code, stdout: answer.stdout };
      });
      if (!cloned.ok) return projectsScreen(response, who, cloned.message, 400);
      // The clone answer is BOUND to the record's exact target (verification
      // finding 2): whatever produced it — the real primitive or a test
      // hook — an answer naming any other path never enrolls or opens.
      if (cloned.target !== record.target) {
        return projectsScreen(response, who, "the clone answered with a different path than the preview promised — refused; nothing was enrolled", 400);
      }
      // authorizedProject AFTER the repository exists (finding 20).
      const proved = await authorizedProject(ceiling, cloned.target);
      const admitted = proved ? (canonicalProject(cloned.target) ?? cloned.target) : null;
      if (admitted === null) {
        return projectsScreen(response, who, `the clone landed at ${cloned.target} but did not prove under the ceiling — it was left in place; enroll it by hand`, 400);
      }
      if (options.registryPath !== undefined) {
        const enrolled = await updateRepos(options.registryPath, (repos: string[]) => addRepos(repos, [admitted]));
        if (!enrolled.ok) {
          return projectsScreen(response, who, `${cloned.target} is cloned but not enrolled — ${enrolled.message}`, 400);
        }
      }
      store.upsertProject(admitted, projectName(admitted), now);
      who.session.project = admitted;
      who.session.projectRevision += 1;
      return projectsScreen(
        response,
        who,
        options.upConsole === true
          ? `${admitted} is ready — restart \`standing-orders up\` adding --repo ${admitted} to watch it`
          : `${admitted} is ready and open`,
        200,
      );
    }

    if (url.pathname === "/push/subscribe") {
      // Enrolling a durable notification sink is a CEREMONY (arc 3 finding
      // 6): browser session + CSRF + the password typed again; bearer
      // identities are machines and are refused outright.
      if (who.via !== "cookie") return refuse(response, who, 403, "push enrollment is a browser session's act");
      if (store.isDemo()) return refuse(response, who, 403, "the sandbox never pushes");
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(store, who.name, password).ok) {
        return redirect(response, `/settings?said=${encodeURIComponent("enrolling this device takes your password, typed again")}`);
      }
      const endpoint = body.get("endpoint") ?? "";
      const p256dh = body.get("p256dh") ?? "";
      const auth = body.get("auth") ?? "";
      const checked = validatePushEndpoint(endpoint);
      if (!checked.ok) return redirect(response, `/settings?said=${encodeURIComponent(checked.problem)}`);
      const p256dhBytes = Buffer.from(p256dh, "base64url");
      const authBytes = Buffer.from(auth, "base64url");
      if (p256dhBytes.length !== 65 || p256dhBytes[0] !== 4 || authBytes.length !== 16) {
        return redirect(response, `/settings?said=${encodeURIComponent("that subscription's keys are not the shape a browser mints")}`);
      }
      const keys = loadOrCreateVapidKeys(dirname(options.telegramTokenFile ?? "."));
      const generation = store.approverGeneration(who.name) ?? 1;
      const enrolled = store.enrollPushSubscription(
        {
          endpoint,
          p256dh,
          auth,
          approver: who.name,
          approverGeneration: generation,
          uaWords: oneLineUa(request.headers["user-agent"]),
          vapidFingerprint: keys.fingerprint,
        },
        clock(),
      );
      if (!enrolled.ok) {
        return redirect(response, `/settings?said=${encodeURIComponent(enrolled.reason === "approver-cap" ? "five devices per person — remove one first" : "twenty devices per installation — remove one first")}`);
      }
      return redirect(response, `/settings?said=${encodeURIComponent("this device now gets a buzz when the plane needs a person")}`);
    }

    if (url.pathname === "/push/remove") {
      if (who.via !== "cookie") return refuse(response, who, 403, "push removal is a browser session's act");
      const id = Number(body.get("id") ?? "");
      const mine = store.listPushSubscriptions(who.name).find(one => one.id === id && one.retiredAt === null);
      if (mine === undefined) return redirect(response, `/settings?said=${encodeURIComponent("that device is not yours to remove, or it is already gone")}`);
      store.retirePushSubscription(mine.id, `removed by ${who.name}`, clock());
      return redirect(response, `/settings?said=${encodeURIComponent("removed — that device stops receiving pushes")}`);
    }

    if (url.pathname === "/chat/config") {
      // The console's own door into `config set chat` (operator request:
      // chat lives mainly in the web UI). Same ceremony weight as the CLI
      // verb: the password typed again authenticates the approver, the
      // write is audited under their name, and the KEY still never
      // touches a form or this database — environment only.
      if (who.via !== "cookie") return refuse(response, who, 403, "chat setup is a browser surface");
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(store, who.name, password).ok) {
        return redirect(response, `/chat?said=${encodeURIComponent("configuring chat spend takes your password, typed again")}`);
      }
      if (body.get("off") === "1") {
        store.clearChatConfig();
        return redirect(response, `/chat?said=${encodeURIComponent("chat is off — its settings were removed")}`);
      }
      const forget = body.get("forget-key") ?? "";
      if (forget === "anthropic-api" || forget === "openrouter-api") {
        forgetChatKey(forget);
        return redirect(response, `/chat?said=${encodeURIComponent("the stored key file is gone (an environment variable, if set, still applies)")}`);
      }
      const provider = body.get("provider") ?? "";
      const model = body.get("model") ?? "";
      const weekly = Number(body.get("weekly-usd") ?? "");
      const daily = (body.get("daily-turns") ?? "").trim() === "" ? 50 : Number(body.get("daily-turns"));
      if (provider !== "anthropic-api" && provider !== "openrouter-api") {
        return redirect(response, `/chat?said=${encodeURIComponent("pick a chat provider")}`);
      }
      // The key, when pasted, is stored FIRST (0600 file, Telegram-token
      // precedent) so the catalog fetch below can already use it. It never
      // touches the database and is never echoed back.
      const pastedKey = (body.get("key") ?? "").trim();
      if (pastedKey !== "") {
        const stored = storeChatKey(provider, pastedKey);
        if (!stored.ok) return redirect(response, `/chat?said=${encodeURIComponent(stored.message)}`);
      }
      // The pin: anthropic models come from the compiled table; openrouter
      // models come from OpenRouter's OWN catalog, priced by the authority
      // that will bill them. No price found anywhere = refused, not guessed.
      let pin = priceOf(model);
      if (provider === "openrouter-api") {
        const catalog = await chatCatalog();
        const hit = catalog?.find(one => one.id === model);
        if (hit !== undefined) pin = hit.price;
      }
      if (pin === null) {
        return redirect(response, `/chat?said=${encodeURIComponent(provider === "openrouter-api" ? "that model is not in OpenRouter's catalog (or the catalog is unreachable) — chat cannot reserve spend it cannot bound" : "that model has no pinned price — chat cannot reserve spend it cannot bound")}`);
      }
      if (!Number.isFinite(weekly) || weekly <= 0) {
        return redirect(response, `/chat?said=${encodeURIComponent("the weekly ceiling is a positive dollar amount — chat without one is unbounded, not configured")}`);
      }
      if (!Number.isInteger(daily) || daily <= 0 || daily > 1_000) {
        return redirect(response, `/chat?said=${encodeURIComponent("daily turns is a whole number between 1 and 1000")}`);
      }
      store.setChatConfig(
        {
          provider,
          model,
          dailyTurns: daily,
          weeklyCeilingMicrousd: Math.round(weekly * 1_000_000),
          priceInMicrousd: pin.inMicrousd,
          priceOutMicrousd: pin.outMicrousd,
        },
        who.name,
        now,
      );
      return redirect(response, "/chat");
    }

    if (url.pathname === "/chat") {
      if (who.via !== "cookie") return refuse(response, who, 403, "chat is a browser surface");
      const enabled = chatEnablement();
      if (!enabled.ok) return redirect(response, `/chat?said=${encodeURIComponent(enabled.why)}`);
      // The password, typed again, on EVERY message (v2 ruling 2): chat is
      // spend, and a seven-day cookie is not a spend credential.
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(store, who.name, password).ok) {
        return redirect(response, `/chat?said=${encodeURIComponent("chat spends — your password, typed again, with every message")}`);
      }
      const message = (body.get("message") ?? "").trim();
      if (message === "" || message.length > 2_000) {
        return redirect(response, `/chat?said=${encodeURIComponent("a message is 1 to 2000 characters")}`);
      }
      // Secrets refuse BEFORE any row or request exists — nothing stored,
      // nothing sent (v3 brief; scanForSecrets is the same high-confidence
      // set the evidence path trusts).
      if (scanForSecrets(message).length > 0) {
        return redirect(response, `/chat?said=${encodeURIComponent("that looks like a credential — chat never forwards or stores those")}`);
      }
      store.sweepStaleChatTurns(now);
      const snapshot = store.chatSnapshot(ceiling.repos, now);
      const { document } = buildDataDocument(snapshot);
      // The WHOLE outbound body is scanned — a token in a task title
      // refuses the turn exactly like one typed in the box (v2 ruling 4).
      const composed = composeRequest({
        provider: enabled.config.provider,
        model: enabled.config.model,
        key: "",
        dataDocument: document,
        userMessage: message,
      });
      if (scanForSecrets(composed.body).length > 0) {
        return redirect(response, `/chat?said=${encodeURIComponent("fleet context contains something credential-shaped — chat refuses to send it; find and remove it first")}`);
      }
      const reserved = worstCaseForPrice(enabled.price, Buffer.byteLength(composed.body, "utf8"));
      const opened = store.openChatTurn(
        {
          approver: who.name,
          credentialKey: enabled.credentialKey,
          provider: enabled.config.provider,
          model: enabled.config.model,
          reservedMicrousd: reserved,
          dailyTurns: enabled.config.dailyTurns,
          weeklyCeilingMicrousd: enabled.config.weeklyCeilingMicrousd,
          deadlineMs: TURN_WALL_CLOCK_MS + 10_000,
        },
        now,
      );
      if (!opened.ok) {
        const said =
          opened.reason === "latched"
            ? "a turn with unknown cost blocks this credential — acknowledge it below first"
            : opened.reason === "concurrent"
              ? "one turn at a time — this one is still running"
              : opened.reason === "daily-cap"
                ? "the daily turn cap is reached"
                : "the weekly spend ceiling would be exceeded";
        return redirect(response, `/chat?said=${encodeURIComponent(said)}`);
      }
      void runChatTurn(opened.id, who.session, enabled, message, document);
      return redirect(response, "/chat");
    }

    const chatFile = /^\/chat\/file\/([0-9a-f]{32})$/.exec(url.pathname);
    if (chatFile !== null) {
      if (who.via !== "cookie") return refuse(response, who, 403, "chat is a browser surface");
      const key = chatFile[1] as string;
      const chat = who.session.chat;
      const candidate = chat?.candidates.get(key);
      // The filing act creates durable rows from model text: password again.
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(store, who.name, password).ok) {
        return redirect(response, `/chat?said=${encodeURIComponent("filing a draft takes your password, typed again")}`);
      }
      if (chat === undefined || candidate === undefined) {
        return refuse(response, who, 404, "that draft is gone — drafts live in the session and do not survive restarts", "/chat");
      }
      // Single-use CAS with no await between check and claim (v2 new 3).
      if (candidate.state !== "pending") return refuse(response, who, 409, "that draft is already being filed", "/chat");
      candidate.state = "filing";
      const enabled = chatEnablement();
      if (!enabled.ok || candidate.approver !== who.name || candidate.ceilingDigest !== chatCeilingDigest()) {
        candidate.state = "pending";
        return refuse(response, who, 409, "the world changed since this draft was made — it cannot be filed", "/chat");
      }
      // Re-validated at the act: the door runs every field check again, and
      // the fields are scanned for secrets before they become durable.
      const fields = candidate.draft.kind === "task"
        ? [candidate.draft.title, candidate.draft.goal, candidate.draft.outOfScope ?? "", ...candidate.draft.touches]
        : [candidate.draft.name, candidate.draft.goal, candidate.draft.outOfScope ?? "", ...candidate.draft.touches];
      if (scanForSecrets(fields.join("\n")).length > 0) {
        chat.candidates.delete(key);
        return refuse(response, who, 400, "that draft contains something credential-shaped — discarded", "/chat");
      }
      const filedVia = `chat:${enabled.config.provider}`;
      if (candidate.draft.kind === "task") {
        const made = fileTaskProposal(
          store,
          {
            title: candidate.draft.title,
            repo: candidate.repoPath,
            goal: candidate.draft.goal,
            outOfScope: candidate.draft.outOfScope,
            touches: candidate.draft.touches,
            filedVia,
            admittedRepos: [...ceiling.repos],
          },
          now,
        );
        if (!made.ok) {
          candidate.state = "pending";
          return refuse(response, who, 400, `the door refused it: ${made.message}`, "/chat");
        }
        chat.candidates.delete(key);
        return redirect(response, taskHref(made.id));
      }
      const made = fileRoutineProposal(
        store,
        {
          name: candidate.draft.name,
          repo: candidate.repoPath,
          goal: candidate.draft.goal,
          outOfScope: candidate.draft.outOfScope,
          touches: candidate.draft.touches,
          requirements: [],
          schedule: candidate.draft.schedule,
          costCeilingUsd: null,
          filedVia,
          admittedRepos: [...ceiling.repos],
        },
        now,
      );
      if (!made.ok) {
        candidate.state = "pending";
        return refuse(response, who, 400, `the door refused it: ${made.message}`, "/chat");
      }
      chat.candidates.delete(key);
      return redirect(response, `/routines/${made.id}`);
    }

    const chatAckPost = /^\/chat\/ack\/([0-9]{1,15})$/.exec(url.pathname);
    if (chatAckPost !== null) {
      if (who.via !== "cookie") return refuse(response, who, 403, "acknowledgement is a browser ceremony");
      const turn = store.getChatTurn(Number(chatAckPost[1]));
      if (turn === null) return refuse(response, who, 404, "no such turn", "/chat");
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(store, who.name, password).ok) {
        return refuse(response, who, 403, "acknowledging unknown spend takes your password", "/chat");
      }
      const nonce = body.get("nonce") ?? "";
      if (!consumeApprovalNonce(nonce, who.name, `chat-ack-${turn.id}`, String(turn.reservedMicrousd))) {
        return refuse(response, who, 409, "this screen expired — reopen it and read the terms again", "/chat");
      }
      if (!store.acknowledgeChatTurn(turn.id, who.name, now)) {
        return refuse(response, who, 409, "already acknowledged", "/chat");
      }
      return redirect(response, "/chat");
    }

    if (url.pathname === "/routines/add") {
      // A standing order files into the OPEN project — never a typed path,
      // so the ceiling question never even arises — and lands on its own
      // screen where the approval step-up already lives: filing is cheap,
      // the yes is the ceremony.
      const project = projectOf(who, request);
      if (project === undefined || project === null) {
        return refuse(response, who, 403, "open a project first — a standing order lives somewhere specific");
      }
      if (who.via === "cookie") {
        const seen = body.get("projectRevision");
        if (seen !== null && seen !== String(who.session.projectRevision)) {
          return refuse(response, who, 409, "the open project changed since this form was rendered — reload and try again", "/routines");
        }
      }
      const name = (body.get("name") ?? "").trim();
      const ceilingGiven = (body.get("ceiling") ?? "").trim();
      // Root mode proves the CURRENT project exactly (repo onboarding,
      // finding 24): canonicalize, authorize, and pass [canonical] as the
      // admitted list — the same discipline as task filing, so a routine
      // can land in a fresh clone too.
      const routineRootMode = !unscopedMode && ceiling.roots.length > 0;
      let routineRepo = project;
      let routineAdmitted: string[] | null = unscopedMode ? null : admissionList() ?? [];
      if (routineRootMode) {
        const canonical = (await authorizedProject(ceiling, project)) ? canonicalProject(project) : null;
        if (canonical === null || canonical === undefined) {
          return refuse(response, who, 403, "the open project is outside what this server was configured to show", "/routines");
        }
        routineRepo = canonical;
        routineAdmitted = [canonical];
      }
      // One filing door for every surface (Codex adoption review, finding
      // 7): the service validates, canonicalizes, digests, and stamps
      // provenance; the admission list makes the ceiling explicit even
      // though `project` was already proved inside it.
      const created = fileRoutineProposal(
        store,
        {
          name,
          repo: routineRepo,
          goal: (body.get("goal") ?? "").trim(),
          outOfScope: (body.get("not") ?? "").trim() || null,
          touches: (body.get("touches") ?? "").split(/[\n,]/).map(one => one.trim()).filter(one => one !== ""),
          requirements: [],
          schedule: (body.get("schedule") ?? "").trim(),
          costCeilingUsd: ceilingGiven === "" ? null : Number(ceilingGiven),
          filedVia: "console",
          ...(routineAdmitted === null ? {} : { admittedRepos: routineAdmitted }),
        },
        now,
      );
      if (created.ok && routineRootMode) store.upsertProject(routineRepo, projectName(routineRepo), now);
      if (!created.ok) {
        const tracks = store.routineTracks(project, now).filter(track => visible(track.routine.repo));
        return sendScreen(response, created.reason === "duplicate" ? 409 : 400, routinesPage(chromeFor(project, "routines"), tracks, {
          csrf: who.via === "cookie" ? who.session.csrf : "",
          revision: who.via === "cookie" ? who.session.projectRevision : 0,
          problem: created.message,
        }));
      }
      return redirect(response, `/routines/${created.id}`);
    }

    const routineAct = /^\/routines\/([0-9]{1,15})\/(approve|pause|resume|run-now)$/.exec(url.pathname);
    if (routineAct !== null) {
      return routineMutation(response, who, Number(routineAct[1]), routineAct[2] as string, body, now);
    }

    const runNote = /^\/r\/([0-9]{1,15})\/note$/.exec(url.pathname);
    if (runNote !== null) {
      // An operator's verdict beside the machine's record (M6): immutable,
      // bounded by the same validator as decision notes, ceiling-checked
      // like every run resource. Ordinary authenticated mutation — no
      // nonce, because nothing here approves anything.
      const id = Number(runNote[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      const note = validateNote(body.get("note") ?? "");
      if (!note.ok) return refuse(response, who, 400, note.problem);
      store.addRunNote(id, who.name, note.note, now);
      return redirect(response, `/r/${id}`);
    }

    const diffComment = /^\/r\/([0-9]{1,15})\/comment$/.exec(url.pathname);
    if (diffComment !== null) {
      // A review comment on the IMMUTABLE terminal diff (M6.8): bound to
      // the exact artifact and its hash. Ordinary authenticated mutation —
      // the nonce belongs to the approval screen that later restates the
      // batch, never to the comment box.
      const id = Number(diffComment[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      const terminal = store.artifactsFor(id).find(one => one.kind === "terminal-diff");
      if (terminal === undefined) {
        return refuse(response, who, 400, "this run has no terminal diff to comment on", `/r/${id}`);
      }
      // The bytes must VERIFY before words attach to them (audit IV-10):
      // "a comment on the exact reviewed bytes" is a lie if the bytes are
      // gone or no longer hash to their record.
      const proven = readVerifiedArtifact(evidenceRoot, terminal);
      if (!proven.ok) {
        return refuse(response, who, 409, `the terminal diff no longer verifies (${proven.problem}) — nothing to comment on`, `/r/${id}`);
      }
      const note = validateNote(body.get("note") ?? "");
      if (!note.ok) return refuse(response, who, 400, note.problem, `/r/${id}`);
      const rawPath = (body.get("path") ?? "").trim();
      if (rawPath.length > 300 || hasForbiddenControls(rawPath)) {
        return refuse(response, who, 400, "that path is not a path", `/r/${id}`);
      }
      const rawLine = (body.get("line") ?? "").trim();
      const line = rawLine === "" ? null : Number(rawLine);
      if (line !== null && (!Number.isInteger(line) || line < 1 || line > 1_000_000)) {
        return refuse(response, who, 400, "that line number is not a line number", `/r/${id}`);
      }
      store.addDiffComment(
        { artifactId: terminal.id, runId: id, path: rawPath === "" ? null : rawPath, line, note: note.note, author: who.name },
        now,
      );
      // Land back AT the review card with the note field ready — writing
      // five comments in a row must cost five keystrokes of navigation,
      // not five scrolls (arc 6, finding 5/6: this REDUCES the unsent-note
      // hazard; the seal below remains the real batch operation).
      return redirect(response, `/r/${id}?noted=1#review`);
    }

    if (url.pathname === "/session/editor-links") {
      // The session half of the editor-link activation (arc 6, finding 1):
      // only the person at the browser can say "this device holds the
      // worktrees". Per-session, dies with the session, grants nothing —
      // it only lets already-authorized pages RENDER vscode links.
      if (who.via !== "cookie") return refuse(response, who, 403, "editor links are a browser session's choice");
      if (options.editorLinks === undefined) return refuse(response, who, 404, "editor links are not enabled on this server");
      who.session.editorLinks = body.get("on") === "1";
      const back = body.get("return") ?? "/";
      return redirect(response, /^\/[a-z0-9/_-]*$/i.test(back) ? back : "/");
    }

    const turnAct = /^\/r\/([0-9]{1,15})\/turn$/.exec(url.pathname);
    if (turnAct !== null) {
      // The operator's turn (Phase 2E, v2 S1g): cookie-only — a watching
      // person, never a bearer machine — and every hard gate (custody,
      // lease, cap, budget, open decision, single flight) re-proves
      // ATOMICALLY inside the recording transaction. Words here only map
      // the refusal tokens to sentences.
      if (who.via !== "cookie") return refuse(response, who, 403, "turns are a browser session's act");
      const id = Number(turnAct[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      const text = (body.get("text") ?? "").trim();
      if (text === "" || text.length > 500) {
        return refuse(response, who, 400, "a turn is 1 to 500 characters", `/r/${id}`);
      }
      const coordinator = options.attended?.coordinator;
      if (coordinator === undefined) return refuse(response, who, 409, "this console is not holding the session", `/r/${id}`);
      const injected = coordinator.injectOperatorTurn(id, who.name, text);
      if (!injected.ok) {
        const words: Record<string, string> = {
          "no-held-session": "the session is not held here anymore",
          fenced: "the session is winding down — nothing more reaches it",
          "turn-open": "the agent is still working on the last message — wait for it to settle",
          "turn-cap": "the session's message cap is reached — authorize a new session for more",
          "budget-exhausted": "the session's budget is spent",
          "decision-open": "answer the waiting question first — it is on this page",
          "write-failed": "the message could not reach the agent — it was not charged",
        };
        return refuse(response, who, 409, words[injected.reason] ?? injected.reason, `/r/${id}`);
      }
      return redirect(response, `/r/${id}`);
    }

    const revise = /^\/r\/([0-9]{1,15})\/revise$/.exec(url.pathname);
    if (revise !== null) {
      // Seal the live comment batch into ONE unapproved revision task with
      // an immutable brief (M6.8). Deterministic — no model reads anything
      // here — and every revision takes its own approval: comments can
      // semantically widen work, and no path check can prove they did not.
      const id = Number(revise[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      const comments = store.liveDiffComments(id);
      if (comments.length === 0) {
        return refuse(response, who, 400, "no live comments to turn into a revision", `/r/${id}`);
      }
      const sourceTaskId = store.externalIdFor(found.taskRef) ?? "?";
      const sourceScope = store.getScope(sourceTaskId);
      const repo = taskRepoOf(found.taskRef);
      const terminal = store.artifactsFor(id).find(one => one.kind === "terminal-diff");
      if (terminal !== undefined) {
        const proven = readVerifiedArtifact(evidenceRoot, terminal);
        if (!proven.ok) {
          return refuse(response, who, 409, `the reviewed diff no longer verifies (${proven.problem}) — the batch cannot seal against it`, `/r/${id}`);
        }
      }
      // The brief is serialized and size-checked BEFORE anything is created
      // (Codex M5-M8 audit, IV-3): a structured artifact must never pass
      // through byte truncation — truncated JSON is not a smaller brief,
      // it is no brief wearing one's name.
      const brief = {
        schema: 1 as const,
        sourceTask: sourceTaskId,
        sourceRun: id,
        head: found.headRevision,
        diffArtifactSha: terminal?.sha256 ?? null,
        comments: comments.map(one => ({
          id: one.id,
          path: one.path,
          line: one.line,
          note: one.note,
          author: one.author,
          createdAt: one.createdAt,
        })),
      };
      const briefBytes = Buffer.from(JSON.stringify(brief, null, 2), "utf8");
      if (briefBytes.length > EVIDENCE_CAPS["revision-brief"]) {
        return refuse(response, who, 400, "this batch is too large for one brief — seal it in parts", `/r/${id}`);
      }
      // The file first, under a nonce name — a file whose seal fails is an
      // orphan on disk, never authority. Then ONE transaction: task with
      // the source scope's limits INHERITED (audit IV-2 — a revision that
      // drops the exclusions is an approval screen telling a lie), the
      // artifact row, the relation, and exactly this comment batch.
      const briefName = `revision-brief-${randomBytes(6).toString("hex")}.json`;
      const key = writeEvidenceFile(evidenceRoot, id, briefName, briefBytes);
      // C1's revision arm: when the SEALER is the mode's signer and the
      // mode auto-approves their filings, the revision task approves
      // inside the same transaction, with mode provenance. Everything
      // else about the seal is unchanged; without coverage, the revision
      // keeps its own approval ceremony.
      const sealed = store.transact(() => {
        // Coverage first (cookie road only): its budget and escalated
        // posture ride the FILING so the digest binds them (surfaces
        // round 1, finding 2) — never a stamp after the fact.
        const coverage = who.via === "cookie" ? modeFilingCoverage(store, repo, who.name, now) : null;
        const result = store.sealRevision(
        {
          task: {
            title: `revise ${sourceTaskId}: ${comments.length} review comment(s) on build #${id}`,
            ...(repo === null ? {} : { repo }),
            goal:
              `${sourceScope?.goal ?? `revise ${sourceTaskId}`}` +
              ` — apply the review comments recorded on build #${id}; the revision brief carries the exact batch`,
            outOfScope: sourceScope?.outOfScope ?? null,
            touches: sourceScope?.touches ?? [],
            ...(coverage?.defaultBudgetMicrousd != null ? { budgetMicrousd: coverage.defaultBudgetMicrousd } : {}),
            ...(coverage?.escalated === true ? { posture: "escalated" as const } : {}),
          },
          artifact: {
            run: id,
            kind: "revision-brief",
            key,
            bytesOriginal: briefBytes.length,
            bytesStored: briefBytes.length,
            truncated: false,
            sha256: createHash("sha256").update(briefBytes).digest("hex"),
            capture: "machine-authored revision brief (exit 0)",
          },
          revisionOf: sourceTaskId,
          commentIds: comments.map(one => one.id),
          sourceRun: id,
        },
        now,
        );
        if (result.ok && coverage !== null) {
          // A scope whose profile could not resolve is unapprovable by the
          // human road (approve() refuses) — the mode road refuses too.
          const filedScope = store.getScope(result.id);
          if (filedScope?.profileState === "resolved") {
            store.sealScopeApproval(result.id, who.name, now, {}, { kind: "mode", modeDigest: coverage.digest });
          }
        }
        return result;
      });
      if (!sealed.ok) return refuse(response, who, 409, `could not seal the revision: ${sealed.reason}`, `/r/${id}`);
      return redirect(response, taskHref(sealed.id));
    }

    const draftRepair = /^\/r\/([0-9]{1,15})\/draft-repair$/.exec(url.pathname);
    if (draftRepair !== null) {
      // CI repair, suggestion-first (M8.18): a red episode never spawns an
      // agent by itself — it EARNS a button, and the button creates one
      // unapproved task through the same revision machinery as review
      // comments. Deterministic id = one draft per task/PR, ever.
      const id = Number(draftRepair[1]);
      const found = store.getRun(id);
      if (found === null || !visible(taskRepoOf(found.taskRef))) {
        return refuse(response, who, 404, "no such run");
      }
      const publication = store.publicationForRun(id);
      if (publication === null || publication.prNumber === null) {
        return refuse(response, who, 400, "this run published no pull request", `/r/${id}`);
      }
      if (!store.hasOpenCiEpisode(publication.githubRepo, publication.prNumber)) {
        return refuse(response, who, 400, "no failing CI is observed on this PR right now", `/r/${id}`);
      }
      const sourceTaskId = store.externalIdFor(found.taskRef) ?? "?";
      const sourceScope = store.getScope(sourceTaskId);
      const repo = taskRepoOf(found.taskRef);
      // The observed episode, not the click: the brief binds the head the
      // failure was SEEN on and when (audit C-2) — a PR that advanced since
      // is a different failure, and the click time is not an observation.
      const episode = store.latestOpenCiEpisode(publication.githubRepo, publication.prNumber as number);
      // Suffixes survive truncation (audit C-7): the prefix gives way, the
      // identity-bearing tail never does.
      const suffix = `-ci-${publication.prNumber}`;
      const draftId = `${sourceTaskId.slice(0, 64 - suffix.length)}${suffix}`;
      const brief = {
        schema: 1 as const,
        kind: "ci-repair" as const,
        sourceTask: sourceTaskId,
        sourceRun: id,
        pr: publication.prNumber,
        prUrl: publication.prUrl,
        publishedHeadSha: publication.headSha,
        observedFailingHead: episode?.headSha ?? null,
        observedAt: episode?.createdAt ?? null,
      };
      const briefBytes = Buffer.from(JSON.stringify(brief, null, 2), "utf8");
      const briefName = `ci-repair-brief-${randomBytes(6).toString("hex")}.json`;
      const key = writeEvidenceFile(evidenceRoot, id, briefName, briefBytes);
      const sealed = store.sealRevision(
        {
          task: {
            id: draftId,
            title: `repair ${sourceTaskId}: CI failing on PR #${publication.prNumber}`,
            ...(repo === null ? {} : { repo }),
            goal:
              `${sourceScope?.goal ?? `repair ${sourceTaskId}`}` +
              ` — repair the failing CI on PR #${publication.prNumber} (failing head ${(episode?.headSha ?? publication.headSha).slice(0, 12)}). ` +
              `Read the failing checks on GitHub before approving; this draft carries no log content.`,
            outOfScope: sourceScope?.outOfScope ?? null,
            touches: sourceScope?.touches ?? [],
          },
          artifact: {
            run: id,
            kind: "revision-brief",
            key,
            bytesOriginal: briefBytes.length,
            bytesStored: briefBytes.length,
            truncated: false,
            sha256: createHash("sha256").update(briefBytes).digest("hex"),
            capture: "machine-authored ci-repair brief (exit 0)",
          },
          revisionOf: sourceTaskId,
          commentIds: null,
          sourceRun: id,
        },
        now,
      );
      if (!sealed.ok) {
        return refuse(
          response,
          who,
          sealed.reason === "duplicate" ? 409 : 400,
          sealed.reason === "duplicate" ? `already drafted as ${draftId}` : `could not draft: ${sealed.reason}`,
          `/r/${id}`,
        );
      }
      // The merge blocker rides the SAME breath as the draft (merge grant,
      // findings 3/12/13): while this repair exists, the source PR merges
      // NOTHING — sticky until the operator's unblock act or the PR closes.
      store.createMergeBlocker(publication.id, sealed.id, now);
      return redirect(response, taskHref(sealed.id));
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

  /**
   * Assemble the LIVE rendered terms of one watched attempt, or say in
   * words why there are none (Phase 2E, ruling 12). Everything here is
   * re-read at confirm time — the digest is the proof the world held.
   */
  async function liveAttendedTerms(
    taskId: string,
    inputs: { minutes: number; turns: number; budgetMicrousd: number; expiry?: string; parent?: number; followup?: string; model?: string; posture?: string },
    now: Date,
  ): Promise<{ ok: true; terms: AttendedTerms } | { ok: false; problem: string }> {
    if (options.attended === undefined) return { ok: false, problem: "this console cannot hold a session — start it with `standing-orders up`" };
    const ref = store.lookupRef(taskId);
    if (ref === null) return { ok: false, problem: "no such task" };
    const scope = store.getScope(taskId);
    if (scope === null) return { ok: false, problem: "file a scope first — the terms come from it" };
    // CONTINUATION (A4): the parent attempt and the follow-up enter the
    // SIGNED terms; the head is the parent's accepted commit per outcome;
    // a moving publication blocks; failed parents are refused outright for
    // now (a dirty preserved tree cannot promise a clean continuation) —
    // stated, not hidden.
    let continuation: { parentRun: number; followup: string; head: string } | null = null;
    if (inputs.parent !== undefined) {
      const parent = store.getRun(inputs.parent);
      if (parent === null || parent.taskRef !== ref.id) return { ok: false, problem: "no such finished attempt on this task" };
      const followup = (inputs.followup ?? "").trim();
      if (followup === "" || followup.length > 2000) {
        return { ok: false, problem: "say what to do next — 1 to 2000 characters" };
      }
      if (parent.outcome !== "built" && parent.outcome !== "no-change") {
        return { ok: false, problem: "only a built or no-change attempt can be continued — for a failed one, file a follow-up task" };
      }
      const accepted = parent.outcome === "built" ? parent.headRevision : parent.baseRevision;
      if (accepted === null) return { ok: false, problem: "the attempt's accepted head was never recorded — file a follow-up task" };
      const blocked = store.continuationBlockOf(parent.id);
      if (blocked !== null) return { ok: false, problem: blocked };
      continuation = { parentRun: parent.id, followup, head: accepted };
    } else if (approvalOf(scope).approved) {
      return { ok: false, problem: "the scope is approved — it already dispatches unattended" };
    }
    let pinned = scope.profileState === "resolved" ? (scope.profile ?? null) : null;
    if (pinned === null) {
      return { ok: false, problem: "the scope cannot say exactly what runs — name a model (task scope --model, or config set build)" };
    }
    if (pinned.provider !== "claude") {
      return { ok: false, problem: `${pinned.provider} cannot hold a watched session yet — this road is claude-only for now` };
    }
    // THE MINT PICKER (P1/C7): a chosen model or posture rebuilds the
    // WHOLE ClaudeProfile — the digest signs the profile that actually
    // runs, never a partial edit. Absent choices keep the scope's pin.
    const chosenModel = (inputs.model ?? "").trim();
    const chosenPosture =
      inputs.posture === "bypassPermissions" ? ("bypassPermissions" as const) : inputs.posture === "acceptEdits" ? ("acceptEdits" as const) : null;
    if (chosenModel !== "" || chosenPosture !== null) {
      pinned = {
        ...pinned,
        ...(chosenModel === "" ? {} : { model: chosenModel }),
        ...(chosenPosture === null ? {} : { permissionArgv: chosenPosture }),
      };
    }
    if (store.activeTournamentTerms(ref.id) !== null) {
      return { ok: false, problem: "this task races a tournament — one attempt cannot authorize N racers" };
    }
    const repo = ref.repo;
    if (repo === null) return { ok: false, problem: "place the task in a repository first — the terms pin the exact head" };
    const head = continuation !== null ? continuation.head : await options.attended.headOf(repo);
    if (head === null) return { ok: false, problem: `the head of ${repo} cannot be read right now` };
    const minutes = Math.max(5, Math.min(240, Math.floor(inputs.minutes) || 60));
    const turns = Math.max(1, Math.min(100, Math.floor(inputs.turns) || 20));
    const budget = Math.max(100_000, Math.min(50_000_000, Math.floor(inputs.budgetMicrousd) || 2_000_000));
    return {
      ok: true,
      terms: {
        taskId,
        attentionMode: "console-visible",
        scopeDigest: scope.digest,
        profileDigest: profileDigestOf(pinned),
        profileJson: canonicalProfileJson(pinned),
        repo,
        runner: options.attended.runner,
        runnerGeneration: 0,
        head,
        maxSessionTurns: turns,
        budgetMicrousd: budget,
        turnTimeoutSeconds: pinned.timeoutSeconds,
        ...(continuation === null ? {} : { parentRun: continuation.parentRun, followup: continuation.followup }),
        // The expiry is FIXED at preview and carried through the confirm —
        // a timestamp recomputed at signing time would change the digest
        // every millisecond and make the proof unmatchable. The confirm's
        // bound check keeps a stale form honest.
        absoluteExpiry:
          inputs.expiry !== undefined &&
          Date.parse(inputs.expiry) > now.getTime() &&
          Date.parse(inputs.expiry) <= now.getTime() + 241 * 60_000
            ? inputs.expiry
            : new Date(now.getTime() + minutes * 60_000).toISOString(),
      },
    };
  }

  /** The signed form, rendered from EXACT terms — what you read is what the password signs. */
  function attendConfirmScreen(
    response: ServerResponse,
    who: Who,
    terms: AttendedTerms,
    inputs: { minutes: number; turns: number; budgetMicrousd: number; model?: string; posture?: string },
    digest: string,
    nonce: string,
    csrf: string,
  ): void {
    const scope = store.getScope(terms.taskId);
    // Quick mint (M4): the mode signature substitutes for the password —
    // the confirm screen still shows EVERY term; only the credential line
    // changes. The mint transaction re-proves the mode either way.
    const quickRef = store.lookupRef(terms.taskId);
    const quickMode = quickRef?.repo == null ? null : store.activeMode(quickRef.repo, clock());
    const quickTerms = quickMode === null ? null : modeTermsFromJson(quickMode.termsJson);
    const quick = quickTerms?.quickMint === true && quickMode !== null && quickMode.signedBy === who.name;
    const body =
      `<h1>run ${escape(terms.taskId)} once, while you watch</h1>` +
      `<form method="post" action="${taskHref(terms.taskId)}/attend" class="card approve-form">` +
      `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
      `<input type="hidden" name="nonce" value="${escape(nonce)}">` +
      `<input type="hidden" name="digest" value="${escape(digest)}">` +
      `<input type="hidden" name="minutes" value="${inputs.minutes}">` +
      `<input type="hidden" name="turns" value="${inputs.turns}">` +
      `<input type="hidden" name="budget" value="${inputs.budgetMicrousd}">` +
      `<input type="hidden" name="expiry" value="${escape(terms.absoluteExpiry)}">` +
      (inputs.model === undefined ? "" : `<input type="hidden" name="model" value="${escape(inputs.model)}">`) +
      (inputs.posture === undefined ? "" : `<input type="hidden" name="posture" value="${escape(inputs.posture)}">`) +
      (terms.parentRun == null ? "" : `<input type="hidden" name="parent" value="${terms.parentRun}">`) +
      (terms.followup == null ? "" : `<input type="hidden" name="followup" value="${escape(terms.followup)}">`) +
      `<p><strong>your password signs exactly this:</strong></p>` +
      `<p class="meta">goal</p><p class="recap" style="margin-top:0">${escape(scope?.goal ?? "")}</p>` +
      `<p class="meta">not this</p><p class="recap" style="margin-top:0">${scope?.outOfScope == null ? "<em>no exclusions</em>" : escape(scope.outOfScope)}</p>` +
      `<p class="meta">touches · ${scope === null || scope.touches.length === 0 ? "anything" : scope.touches.map(one => escape(one)).join(", ")}</p>` +
      (() => {
        const profile = (JSON.parse(terms.profileJson) as { profile?: { model?: string; permissionArgv?: string } }).profile;
        const posture =
          profile?.permissionArgv === "bypassPermissions"
            ? "FULL permissions — claude runs with --dangerously-skip-permissions; nothing asks"
            : "asks before edits outside the worktree (acceptEdits)";
        return `<p class="meta">runs on</p><p class="recap" style="margin-top:0">claude · ${escape(String(profile?.model ?? ""))} — ${posture}</p>`;
      })() +
      (terms.parentRun == null
        ? ""
        : `<p class="meta">continues</p><p class="recap" style="margin-top:0">attempt <a href="/r/${terms.parentRun}" class="mono">#${terms.parentRun}</a>, from exactly where it finished</p>` +
          `<p class="meta">the follow-up — this is the instruction</p><p class="recap" style="margin-top:0">${escape(terms.followup ?? "")}</p>`) +
      `<p class="meta">repository · head</p><p class="recap mono" style="margin-top:0">${escape(terms.repo)} @ ${escape(terms.head.slice(0, 12))}</p>` +
      `<p class="meta">worker</p><p class="recap" style="margin-top:0">${escape(terms.runner)} (this machine)</p>` +
      `<p class="meta">spending</p><p class="recap" style="margin-top:0">up to about $${(terms.budgetMicrousd / 1_000_000).toFixed(2)} — the agent stops as soon as its total crosses this; the final step may run a little past it</p>` +
      `<p class="meta">conversation</p><p class="recap" style="margin-top:0">at most ${terms.maxSessionTurns} messages to the agent, this whole session; each may work up to ${Math.round(terms.turnTimeoutSeconds / 60)} minutes — one that runs past that ends the whole session. If it needs a repair, the repair uses the same session, model, and clock.</p>` +
      `<p class="meta">while you watch — a signed term</p><p class="recap" style="margin-top:0">your console being open is what keeps it running — any page of it, this one included; close the console and the session winds down within a minute. Everything ends by ${escape(when(terms.absoluteExpiry))} regardless. One attempt; it never converts into unattended work.</p>` +
      (quick
        ? `<p class="meta">your signed mode covers this mint — no password; the mode is re-proved as you confirm, and the session is stamped with its signature</p>`
        : `<label>your password, typed again — a signed-in session alone cannot authorize work<input type="password" name="token" autocomplete="current-password"></label>`) +
      `<div class="sticky-actions"><button type="submit">run it while I watch</button></div>` +
      `</form>` +
      `<p class="meta"><a href="${taskHref(terms.taskId)}">back to the task</a></p>`;
    // The chrome binds to the AUTHORITY repository (surfaces round 1,
    // finding 5): the banner on this screen is the mode that would cover
    // a quick mint here, never the session's open-project filter.
    return sendScreen(response, 200, screen(`attend \u00b7 ${terms.taskId}`, body, { chrome: chromeFor(terms.repo, "tasks") }));
  }

  async function attendMutation(
    response: ServerResponse,
    who: Who,
    taskId: string,
    verb: string,
    body: URLSearchParams,
    now: Date,
  ): Promise<void> {
    const ref = store.lookupRef(taskId);
    if (ref === null || store.getTask(taskId) === null || !visible(ref.repo)) {
      return refuse(response, who, 404, "no such task", "/tasks");
    }
    if (who.via !== "cookie") return refuse(response, who, 403, "watching is a browser session's act");
    if (store.isDemo()) return refuse(response, who, 403, "the demo authorizes nothing");

    if (verb === "attend-revoke") {
      const open = store.openAuthorizationFor(ref.id);
      if (open === null) return refuse(response, who, 409, "nothing to revoke", taskHref(taskId));
      store.closeAuthorization(open.id, "revoked", now);
      if (open.attemptRun !== null) options.attended?.coordinator?.poke(open.attemptRun);
      return redirect(response, taskHref(taskId));
    }

    const parentGiven = body.get("parent");
    const followupGiven = body.get("followup");
    const inputs = {
      minutes: Number(body.get("minutes") ?? "60"),
      turns: Number(body.get("turns") ?? "20"),
      budgetMicrousd: Number(body.get("budget") ?? String(store.getScope(taskId)?.budgetMicrousd ?? 2_000_000)),
      ...(body.get("expiry") === null ? {} : { expiry: body.get("expiry") as string }),
      ...(parentGiven === null || parentGiven === "" ? {} : { parent: Number(parentGiven) }),
      ...(followupGiven === null ? {} : { followup: followupGiven }),
      ...(body.get("model") === null ? {} : { model: body.get("model") as string }),
      ...(body.get("posture") === null ? {} : { posture: body.get("posture") as string }),
    };
    if (store.openAuthorizationFor(ref.id) !== null) {
      return refuse(response, who, 409, "an authorization is already open — revoke it first", taskHref(taskId));
    }
    const live = await liveAttendedTerms(taskId, inputs, now);
    if (!live.ok) return refuse(response, who, 409, live.problem, taskHref(taskId));
    const digest = attendedDigestOf(live.terms);

    if (verb === "attend-preview") {
      const nonce = mintApprovalNonce(who.name, `attend-${taskId}`, digest);
      return attendConfirmScreen(response, who, live.terms, inputs, digest, nonce, who.session.csrf);
    }

    // attend: the yes. The nonce proves THIS form; the digest re-derived
    // from live state proves the world held between reading and signing.
    const nonce = body.get("nonce") ?? "";
    if (!consumeApprovalNonce(nonce, who.name, `attend-${taskId}`, body.get("digest") ?? "")) {
      return refuse(response, who, 409, "that form is stale — read it again", taskHref(taskId));
    }
    if (digest !== (body.get("digest") ?? "")) {
      return refuse(response, who, 409, "the world moved while you were reading (scope, model, or head) — read it again", taskHref(taskId));
    }
    const token = body.get("token") ?? "";
    let basis: { kind: "mode"; digest: string } | undefined;
    if (token === "") {
      // Quick mint (C2/M4): no password typed — valid ONLY when a live
      // mode with quickMint was signed by THIS session's person. The mint
      // transaction re-proves it; this pre-check only shapes the refusal.
      const mode = ref.repo === null ? null : store.activeMode(ref.repo, now);
      const modeTerms = mode === null ? null : modeTermsFromJson(mode.termsJson);
      if (mode === null || modeTerms === null || !modeTerms.quickMint || mode.signedBy !== who.name) {
        return refuse(response, who, 403, "authorizing takes your password, typed again", taskHref(taskId));
      }
      basis = { kind: "mode", digest: mode.digest };
    } else if (!authenticateApprover(store, who.name, token).ok) {
      return refuse(response, who, 403, "authorizing takes your password, typed again", taskHref(taskId));
    }
    const minted = store.mintAttendedAuthorization({
      id: randomUUID(),
      taskRef: ref.id,
      approver: who.name,
      runner: live.terms.runner,
      runnerGeneration: live.terms.runnerGeneration,
      compositeDigest: digest,
      termsJson: attendedTermsJson(live.terms),
      maxSessionTurns: live.terms.maxSessionTurns,
      budgetMicrousd: live.terms.budgetMicrousd,
      ...(live.terms.parentRun == null ? {} : { parentRun: live.terms.parentRun }),
      ...(live.terms.followup == null ? {} : { followup: live.terms.followup }),
      absoluteExpiry: live.terms.absoluteExpiry,
      ...(basis === undefined ? {} : { basis }),
      now,
    });
    if (!minted.ok) {
      return refuse(
        response,
        who,
        minted.reason === "mode-ended" ? 403 : 409,
        minted.reason === "mode-ended"
          ? "the mode that covered quick minting has ended — your password, typed again, still works"
          : "an authorization is already open — revoke it first",
        taskHref(taskId),
      );
    }
    // The first beat is the mint itself: the person is visibly here.
    store.beatAuthorization(minted.authorization.id, now);
    return redirect(response, taskHref(taskId));
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
      case "steer": {
        // Steering is a browser session's act, explicitly (arc 1 v2 §3):
        // identify() accepts bearer credentials generically, and those are
        // for machines — a person watching steers, cookie + CSRF only.
        if (who.via !== "cookie") {
          return refuse(response, who, 403, "steering is a browser session's act");
        }
        // The session IS the verified principal here — cookie + CSRF proved it.
        const filed = store.fileSteerNote(taskId, verifiedAuthor(who.name), body.get("note") ?? "", now);
        if (!filed.ok) {
          const said =
            filed.reason === "contest-open"
              ? "agents are racing on this task — steering waits until the tournament settles"
              : filed.reason === "task-finished"
                ? "this task is finished — a note has no next attempt to reach"
                : filed.reason === "invalid-note"
                  ? (filed.problem ?? "that note will not store")
                  : "no such task";
          return taskScreen(response, who, taskId, said, 400);
        }
        return redirect(response, taskHref(taskId));
      }
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
      case "block": {
        // Chains are scheduling, not authority (chains-and-next review,
        // finding 2): the edge decides WHEN the ready set admits the task;
        // approval still decides WHAT may build. Both ends are re-proved
        // here — existence, ceiling, and the tournament guard — and the
        // cycle refusal comes from the store's own closure check.
        const on = (body.get("on") ?? "").trim();
        const blocker = on === "" ? null : store.getTask(on);
        const blockerRef = on === "" ? null : store.lookupRef(on);
        if (blocker === null || blockerRef === null || !visible(blockerRef.repo)) {
          return taskScreen(response, who, taskId, "that task to wait for does not exist here", 404);
        }
        if (store.openContestFor(ref.id) !== null) {
          return taskScreen(response, who, taskId, "a tournament is running on this task — let it finish, then pick or abandon it", 409);
        }
        const added = store.addEdge(taskId, on);
        if (!added.ok) {
          return taskScreen(response, who, taskId, `could not make ${taskId} wait for ${on} — ${added.reason}`, 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "unblock": {
        const on = (body.get("on") ?? "").trim();
        if (store.openContestFor(ref.id) !== null) {
          return taskScreen(response, who, taskId, "a tournament is running on this task — let it finish, then pick or abandon it", 409);
        }
        const removed = store.removeEdge(taskId, on);
        if (!removed.ok) {
          return taskScreen(response, who, taskId, `${taskId} was not waiting on ${on}`, 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "next": {
        if (body.get("undo") !== null) {
          const cleared = store.clearTaskPriority(taskId);
          if (!cleared.ok) return taskScreen(response, who, taskId, "this task could not be put back in filing order", 409);
          return redirect(response, taskHref(taskId));
        }
        const moved = store.moveTaskNext(taskId, now);
        if (!moved.ok) {
          const said =
            moved.reason === "not-queued"
              ? "only queued work can move up — this task is not waiting in the queue"
              : moved.reason === "claimed"
                ? "this task is being built right now — it needs no place in line"
                : moved.reason === "contest-open"
                  ? "a tournament is running on this task — let it finish, then pick or abandon it"
                  : "the queue rank could not be raised";
          return taskScreen(response, who, taskId, said, 409);
        }
        return redirect(response, taskHref(taskId));
      }
      case "reopen": {
        // Authenticated like every approving act: the session alone may
        // read; resuming external work takes the password, typed again.
        const token = (body.get("token") ?? "").trim();
        const authenticated = token !== "" ? authenticateApprover(store, who.name, token) : null;
        if (authenticated === null || !authenticated.ok) {
          return taskScreen(response, who, taskId, "reopening takes your password, typed again", 403);
        }
        const reopened = store.reopenMirror(taskId, who.name, now);
        if (!reopened.ok) {
          const said: Record<string, string> = {
            "unknown-task": "this task is not external work",
            "not-latched": "the tracker never closed this — there is nothing to reopen",
            "not-seen-open": "the tracker has not been seen open again since the close — reopen it there first; the next sync notices",
            claimed: "this task is being built right now",
            "contest-open": "a tournament is open on this task — decide it first",
            held: "a hold stands — lift it first",
            "question-open": "an unanswered question stands — answer or close it first",
            "incident-open": "an unresolved incident stands — resolve it first",
            "bad-state": "this task is not in a state reopen can take",
          };
          return taskScreen(response, who, taskId, said[reopened.reason] ?? "the task could not be reopened", 409);
        }
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
        return redirect(response, body.get("return") === "inbox" ? "/" : body.get("return") === "next" ? "/next" : taskHref(taskId));
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
        // The optional per-attempt dollar cap (v15) rides the same form.
        const budgetGiven = (body.get("budget-usd") ?? "").trim();
        const budgetUsd = budgetGiven === "" ? null : Number(budgetGiven);
        if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
          return taskScreen(response, who, taskId, "the dollar cap is a positive amount", 400);
        }
        // The tournament controls (operator request): a count of 2–4 files
        // race terms BESIDE the scope — validated and priced BEFORE anything
        // saves, so a bad tournament never half-lands on a good scope.
        const raceCountGiven = (body.get("race-count") ?? "").trim();
        // The comparison lanes (slice B): any filled row files a comparison
        // INSTEAD of a tournament — planned and refused BEFORE the save,
        // filed INSIDE the same transaction (round-6 finding 5 discipline).
        const comparisonLanes = [1, 2, 3, 4]
          .map(lane => ({
            provider: (body.get(`compare-provider-${lane}`) ?? "").trim(),
            model: (body.get(`compare-model-${lane}`) ?? "").trim(),
          }))
          .filter(lane => lane.provider !== "" || lane.model !== "");
        let plannedComparison: ReturnType<typeof planComparison> | null = null;
        if (comparisonLanes.length > 0) {
          if (raceCountGiven !== "") {
            return taskScreen(response, who, taskId, "a tournament and a comparison are different ceremonies — file one or the other", 400);
          }
          if (store.mirrorByTask(taskId) !== null) {
            return taskScreen(response, who, taskId, "external work compares in a follow-up release — file the comparison on a local task", 409);
          }
          plannedComparison = planComparison({ agents: comparisonLanes });
          if (!plannedComparison.ok) {
            return taskScreen(response, who, taskId, `comparison not filed: ${plannedComparison.message}`, 400);
          }
        }
        let plannedRace: { agents: { provider: string; model: string; repairModel: string }[]; perAgentBudgetMicrousd: number; overrunReserveMicrousd: number; totalBudgetMicrousd: number; priceVersion: number; publicationPolicy: string; raceDigest: string } | null = null;
        if (raceCountGiven !== "") {
          const count = Number(raceCountGiven);
          const model = body.get("race-model") ?? "";
          if (!Number.isInteger(count) || count < 2 || count > 4) {
            return taskScreen(response, who, taskId, "a tournament races 2 to 4 agents", 400);
          }
          const perUsd = Number((body.get("race-per-usd") ?? "").trim());
          const totalUsd = Number((body.get("race-total-usd") ?? "").trim());
          const planned = planTournament({
            agents: Array.from({ length: count }, () => ({ provider: "claude", model })),
            perAgentBudgetUsd: perUsd,
            totalBudgetUsd: totalUsd,
          });
          if (!planned.ok) {
            return taskScreen(response, who, taskId, `tournament not filed: ${planned.message}`, 400);
          }
          plannedRace = planned.plan;
        }
        // Refusals that must hold ATOMICALLY with the save (round-6 finding
        // 5): a race request refused AFTER proposeGuarded would still have
        // rewritten the scope — so proposal, the attended exclusion, and
        // race-term filing share one transaction, and every refusal inside
        // it rolls the whole act back.
        if (plannedRace !== null && store.mirrorByTask(taskId) !== null) {
          return taskScreen(response, who, taskId, "external work races in a follow-up release — file the tournament on a local task", 409);
        }
        const saved = store.transact(():
          | { ok: true }
          | { ok: false; status: number; message: string } => {
          if ((plannedRace !== null || plannedComparison !== null) && store.openAuthorizationFor(ref.id) !== null) {
            return { ok: false, status: 409, message: "an attended authorization is open on this task — revoke it before filing a tournament or comparison" };
          }
          // C1/M3: the signer's own credentialed filing auto-approves —
          // coverage is asked INSIDE this transaction, the escalated
          // default and budget ride the filing, and the seal commits
          // atomically with it. Plain scopes only: a tournament or
          // comparison keeps its own human ceremony.
          // COOKIE ONLY (C1's channel table; surfaces round 1, finding 1):
          // bearer credentials are for machines, and a machine road must
          // never spend the signer's mode.
          const coverage =
            who.via === "cookie" && plannedRace === null && plannedComparison === null
              ? modeFilingCoverage(store, ref.repo, who.name, now)
              : null;
          const proposed = proposeGuarded(store, {
            taskId,
            goal: body.get("goal") ?? "",
            outOfScope: body.get("not") ?? null,
            touches: (body.get("touches") ?? "").split(/[\n,]/),
            ...(budgetUsd !== null
              ? { budgetMicrousd: Math.round(budgetUsd * 1_000_000) }
              : coverage?.defaultBudgetMicrousd != null
                ? { budgetMicrousd: coverage.defaultBudgetMicrousd }
                : {}),
            ...(coverage?.escalated === true ? { posture: "escalated" as const } : {}),
            sawDigest: sawDigest === null || sawDigest === "" ? null : sawDigest,
            taskRef: ref.id,
            now,
          });
          if (!proposed.ok) {
            return {
              ok: false,
              status: proposed.reason === "changed" || proposed.reason === "claimed" ? 409 : 400,
              message: `scope not saved: ${proposed.reason}`,
            };
          }
          if (coverage !== null) {
            const filedScope = store.getScope(taskId);
            if (filedScope?.profileState === "resolved") {
              store.sealScopeApproval(taskId, who.name, now, {}, { kind: "mode", modeDigest: coverage.digest });
            }
          }
          if (plannedComparison !== null && plannedComparison.ok) {
            store.fileTournamentTerms(
              {
                taskRef: ref.id,
                kind: "comparison",
                raceDigest: plannedComparison.plan.comparisonDigest,
                agents: plannedComparison.plan.agents,
                perAgentBudgetMicrousd: 0,
                overrunReserveMicrousd: 0,
                totalBudgetMicrousd: 0,
                priceVersion: 0,
                publicationPolicy: plannedComparison.plan.publicationPolicy,
              },
              now,
            );
            return { ok: true };
          }
          if (plannedRace === null) {
            // Switching back to "one agent" withdraws a standing race OR
            // comparison — the deactivated row survives as history, and
            // the approval card returns to the scope alone.
            store.retractTournamentTerms(ref.id);
            return { ok: true };
          }
          store.fileTournamentTerms(
            {
              taskRef: ref.id,
              raceDigest: plannedRace.raceDigest,
              agents: plannedRace.agents,
              perAgentBudgetMicrousd: plannedRace.perAgentBudgetMicrousd,
              overrunReserveMicrousd: plannedRace.overrunReserveMicrousd,
              totalBudgetMicrousd: plannedRace.totalBudgetMicrousd,
              priceVersion: plannedRace.priceVersion,
              publicationPolicy: plannedRace.publicationPolicy,
            },
            now,
          );
          return { ok: true };
        });
        if (!saved.ok) return taskScreen(response, who, taskId, saved.message, saved.status);
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
        // A revision approves ONLY against a brief that still verifies
        // (Codex M5-M8 audit, IV-3): the batch the screen restated must be
        // provably the batch on disk at the moment of the yes — a brief
        // deleted or corrupted between render and click blocks the
        // approval instead of silently approving comment-free work.
        const approvingRef = store.lookupRef(taskId);
        if (approvingRef !== null && approvingRef.revisionBriefArtifact !== null) {
          const view = revisionViewOf(approvingRef);
          if (view !== null && "problem" in view) {
            return taskScreen(response, who, taskId, `approval is blocked: ${view.problem}`, 409);
          }
        }
        // A tournament task's yes covers BOTH documents (finding 31): the
        // form bound the joint fingerprint, and the scope and race terms
        // approve together, in one transaction, or not at all.
        const raceTerms = store.activeTournamentTerms(ref.id);
        if (raceTerms !== null) {
          const scopeRow = store.getScope(taskId);
          if (scopeRow === null || digest !== jointApprovalDigest(scopeRow.digest, raceTerms.raceDigest)) {
            return taskScreen(response, who, taskId, "this task races a tournament — the form was stale; read it again", 409);
          }
          const both = store.transact(() => {
            const scopeApproved = approveScope(store, taskId, who.name, now, scopeRow.digest, token);
            if (!scopeApproved.ok) return scopeApproved;
            if (!store.approveTournamentTerms(raceTerms.id, who.name, raceTerms.raceDigest, now)) {
              throw new Error("the race terms changed while you were reading — nothing was approved");
            }
            return scopeApproved;
          });
          if (!both.ok) {
            const status = both.reason === "changed" ? 409 : 403;
            return taskScreen(response, who, taskId, `not approved: ${both.reason}`, status);
          }
          return redirect(response, body.get("return") === "next" ? "/next" : taskHref(taskId));
        }
        const approved = approveScope(store, taskId, who.name, now, digest, token);
        if (!approved.ok) {
          const status = approved.reason === "changed" ? 409 : 403;
          return taskScreen(response, who, taskId, `not approved: ${approved.reason}`, status);
        }
        return redirect(response, body.get("return") === "next" ? "/next" : taskHref(taskId));
      }
      default:
        return respond(response, 404, "text/plain; charset=utf-8", "nothing here");
    }
  }

  // ---- identity ------------------------------------------------------------

  function identify(request: IncomingMessage, touch = true): Who | null {
    const bearer = /^Bearer (.+):(.+)$/.exec(request.headers.authorization ?? "");
    if (bearer !== null) {
      const authenticated = authenticateAccount(store, bearer[1] as string, bearer[2] as string);
      return authenticated.ok ? { name: bearer[1] as string, via: "bearer", role: authenticated.role } : null;
    }
    const cookies = request.headers.cookie ?? "";
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`).exec(cookies);
    if (match === null) return null;
    const session = lookupSession(match[1] as string, touch);
    return session === null ? null : { name: session.name, via: "cookie", session, role: session.role };
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
  // The measured count rides the SAME clause as the total (Phase 3 A6):
  // a bare sum over a mixed fleet reads as complete, and is not.
  if (summary.measured.length === summary.invoked.length) {
    return `${dollars} across ${summary.invoked.length} run(s)`;
  }
  return `${dollars} measured across ${summary.measured.length} of ${summary.invoked.length} runs — the rest report tokens only`;
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
    "default-src 'none'; style-src 'unsafe-inline'; manifest-src 'self'; worker-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

function respond(response: ServerResponse, status: number, type: string, body: string): void {
  // A route that set its OWN policy (the service worker's default-src
  // 'none') keeps it — writeHead's headers would otherwise win.
  const own = response.getHeader("content-security-policy");
  response.writeHead(status, { ...SAFETY, ...(own === undefined ? {} : { "content-security-policy": own as string }), "Content-Type": type });
  response.end(body);
}

/**
 * A page response. With a nonce, this response's CSP admits exactly the one
 * inline script the shell stamped with the same value — generated per
 * response, never shared, never 'unsafe-inline' (Codex board review,
 * finding 9). Everything else keeps the constant script-free policy.
 */
function page(response: ServerResponse, status: number, html: string, nonce?: string, fetches?: boolean): void {
  if (nonce === undefined) return respond(response, status, "text/html; charset=utf-8", html);
  response.writeHead(status, {
    ...SAFETY,
    "Content-Security-Policy":
      `default-src 'none'; style-src 'unsafe-inline'; manifest-src 'self'; worker-src 'self'; img-src 'self'; script-src 'nonce-${nonce}'; ` +
      // connect-src only when the page's script actually fetches (a region
      // poller) — the chrome layer alone gets no network at all.
      `${fetches === true ? "connect-src 'self'; " : ""}form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
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

/**
 * A vscode://file href, or null (arc 6, finding 2): the link exists only
 * when every part is provably tame — an absolute, control-free worktree;
 * a relative, single-line path whose segments contain no empty, dot,
 * dot-dot, or backslash components (so lexical resolution stays below the
 * worktree); a line inside the same 1..1,000,000 range the comment form
 * enforces. Encoding failures return null — a file row degrades to plain
 * text, never to a 500. The scheme is a constant, never data.
 */
export function editorFileHref(worktree: string, path: string, line?: number | null): string | null {
  if (!worktree.startsWith("/") || /[\u0000-\u001f\u007f]/.test(worktree)) return null;
  if (path === "" || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith("/") || path.includes("\\")) return null;
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return null;
  const rootSegments = worktree.replace(/\/+$/, "").split("/");
  if (rootSegments.some(segment => segment === "." || segment === "..")) return null;
  try {
    const root = rootSegments.map(segment => encodeURIComponent(segment)).join("/");
    const file = segments.map(segment => encodeURIComponent(segment)).join("/");
    const at = line !== undefined && line !== null && Number.isInteger(line) && line >= 1 && line <= 1_000_000 ? `:${line}` : "";
    return `vscode://file${root}/${file}${at}`;
  } catch {
    return null;
  }
}

/** The execution profile in plain words (v24): what the password signs
 * says WHAT RUNS — provider, exact model, permissions, and the real
 * bounds — or says honestly that it cannot yet. */
function profileWords(scope: Pick<Scope, "profile" | "profileState" | "unresolvedReason" | "digestVersion">): string {
  if (scope.profileState === "unresolved") {
    return `<p class="meta"><strong>filed but unapprovable</strong> — ${escape(scope.unresolvedReason ?? "the scope cannot say exactly what would run")}. Restate the scope to fix it.</p>`;
  }
  const profile = scope.profile ?? null;
  if (profile === null) {
    return (scope.digestVersion ?? 1) < 2
      ? `<p class="meta">approved before routing was bound — pinned at upgrade to the configuration of that day</p>`
      : "";
  }
  const repair = profile.repairModel === "inherit" ? "same model" : profile.repairModel;
  return profile.provider === "claude"
    ? `<p class="meta">runs on <span class="mono">claude · ${escape(profile.model)}</span> — edits auto-accepted inside its leased worktree, ${profile.maxTurns} turns / ${Math.round(profile.timeoutSeconds / 60)} min per attempt; repairs on ${escape(repair)}, ${profile.repairMaxTurns} turns / ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`
    : profile.provider === "gemini"
      ? `<p class="meta">runs on <span class="mono">gemini · ${escape(profile.model)}</span> — ${profile.approvalArgv === "yolo" ? "EVERY tool auto-approved" : "edits auto-approved, other tools refused"}, no turn limit (the ${Math.round(profile.timeoutSeconds / 60)}-minute clock is the bound), spend reported in tokens only; repairs on ${escape(repair)}, ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`
      : `<p class="meta">runs on <span class="mono">${escape(profile.provider)} · ${escape(profile.model)}</span> — workspace-write sandbox, no turn limit (the ${Math.round(profile.timeoutSeconds / 60)}-minute clock is the bound); repairs on ${escape(repair)}, ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`;
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
    --brand: hsl(250 65% 48%);
    --brand-soft: hsl(250 80% 96%);
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
      --brand: hsl(250 80% 72%);
      --brand-soft: hsl(250 40% 16%);
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
  .brand .dot { color: var(--brand); }
  /* The one accent hue (arc 4): orientation and liveness only — where you
     are, what is alive. Never on verbs; buttons and the semantic colors
     (success/warning/destructive) are untouched. */
  :focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
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
  .wb-selected { background: var(--accent); border-radius: calc(var(--radius) - 4px); }
  .palette {
    position: fixed; top: 18vh; left: 50%; transform: translateX(-50%); width: min(32rem, 90vw);
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: 0 1px 2px hsl(240 10% 3.9% / .08), 0 16px 40px -16px hsl(240 10% 3.9% / .3);
    padding: .625rem; z-index: 50;
  }
  .palette input { width: 100%; margin: 0; }
  .palette ul { list-style: none; margin: .5rem 0 0; padding: 0; max-height: 40vh; overflow-y: auto; }
  .palette li { padding: .4375rem .625rem; border-radius: calc(var(--radius) - 4px); cursor: pointer; font-size: .875rem; }
  .palette li[aria-selected="true"] { background: var(--accent); box-shadow: inset 2px 0 0 var(--brand); }

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
  .side nav a.active { background: var(--accent); color: var(--foreground); box-shadow: inset 2px 0 0 var(--brand); }
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
  /* The phone shell (arc 4): the sidebar disappears; a top bar carries the
     project (one tap to switch) and quick capture; a bottom tab bar carries
     the four destinations a thumb actually visits, and everything else
     lives one tap away behind "more". Desktop is untouched. */
  .mobile-top, .tabbar { display: none; }
  @media (max-width: 760px) {
    .app { display: block; }
    .side { display: none; }
    .mobile-top {
      display: flex; align-items: center; gap: .5rem; position: sticky; top: 0; z-index: 30;
      background: var(--card); border-bottom: 1px solid var(--border);
      padding: .5rem .75rem calc(.5rem + env(safe-area-inset-top, 0rem) * 0);
    }
    .mobile-top .brand-mini { font-weight: 700; font-size: .9375rem; text-decoration: none; color: var(--foreground); }
    .mobile-top .project-pill {
      flex: 1; min-width: 0; display: flex; align-items: center; gap: .375rem;
      border: 1px solid var(--border); border-radius: 999px; background: var(--background);
      padding: .375rem .75rem; text-decoration: none; color: var(--foreground);
      font-size: .875rem; font-weight: 600;
    }
    .mobile-top .project-pill .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mobile-top .project-pill .chev { color: var(--muted-foreground); font-size: .75rem; flex: 0 0 auto; }
    .mobile-top .mobile-new {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      min-height: 2.5rem; padding: 0 .875rem; border-radius: 999px;
      background: var(--primary); color: var(--primary-foreground);
      font-weight: 600; font-size: .875rem; text-decoration: none;
    }
    .tabbar {
      display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
      background: var(--card); border-top: 1px solid var(--border);
      padding: .25rem .25rem calc(.25rem + env(safe-area-inset-bottom, 0rem));
    }
    .tabbar a {
      flex: 1; display: flex; flex-direction: column; align-items: center; gap: .125rem;
      padding: .375rem 0 .25rem; min-height: 3rem; text-decoration: none;
      color: var(--muted-foreground); font-size: .6875rem; font-weight: 600;
    }
    .tabbar a .glyph { font-size: 1.125rem; line-height: 1; }
    .tabbar a.active { color: var(--foreground); box-shadow: inset 0 2px 0 var(--brand); }
    .tabbar a.active .glyph { color: var(--brand); }
    .tabbar a .count { position: absolute; transform: translate(0.9rem, -0.35rem); }
    .tabbar a { position: relative; }
    .content > main { padding-bottom: calc(4.5rem + env(safe-area-inset-bottom, 0rem)); }
  }

  .menu-list { display: flex; flex-direction: column; gap: .375rem; margin-top: .75rem; }
  .menu-row {
    display: flex; flex-direction: column; gap: .125rem; text-decoration: none;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--card);
    padding: .75rem .875rem; color: var(--foreground); min-height: 44px; justify-content: center;
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
  .dot-ok.pulse { background: var(--brand); }
  @keyframes pulse { 50% { opacity: .35; } }

  .login-viewport { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem 1.25rem; }
  .login-shell { width: 100%; max-width: 23rem; }
  .login-shell h1 { text-align: center; margin: 0 0 .375rem; font-size: 1.75rem; letter-spacing: -0.02em; }
  .login-shell > .hint { text-align: center; margin: 0 0 2rem; font-size: 0.875rem; opacity: 1; }
  .login-card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 1.5rem 1.5rem 1.625rem;
    box-shadow: 0 1px 2px hsl(240 10% 3.9% / .06), 0 8px 24px -12px hsl(240 10% 3.9% / .18);
  }
  .login-card label:first-child { margin-top: 0; }
  .login-card .problem { margin: 0 0 1rem; }
  .login-shell button {
    width: 100%; margin-top: 1.25rem;
    background: var(--primary); color: var(--primary-foreground); border-color: var(--primary);
  }
  .login-shell button:hover { background: color-mix(in srgb, var(--primary) 88%, var(--background)); }
  .login-foot { text-align: center; margin: 1.5rem 0 0; font-size: 0.75rem; color: var(--muted-foreground); line-height: 1.9; }
  .login-foot code { background: none; padding: 0; color: var(--muted-foreground); overflow-wrap: anywhere; }

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
  /* The phone board (arc 4): a pager — swipe between lanes, needs-you
     first. The strip is viewport-bounded and sits in normal flow: the
     page still scrolls to the headline above it and the routines below
     it, while a deep lane scrolls INSIDE its own column. The sliver of
     the next lane is the affordance; the poller's swap restores both
     the lane you were on and where you were in it. */
  @media (max-width: 760px) {
    .board {
      display: flex; gap: .75rem; overflow-x: auto; overflow-y: hidden;
      scroll-snap-type: x mandatory; overscroll-behavior-x: contain;
      height: clamp(22rem, calc(100dvh - 11.5rem), 42rem); padding-bottom: 0;
    }
    .board .lane {
      /* 4.5rem reserved: a 1.5rem sliver of the neighboring lane on each
         side after the gap — the swipe affordance must be unmissable. */
      flex: 0 0 calc(100% - 4.5rem); scroll-snap-align: center;
      overflow-y: auto; min-height: 0; height: 100%;
    }
    .board .lane-attention { order: 0; }
    .board .lane-building { order: 1; }
    .board .lane-queued { order: 2; }
    .board .lane-waiting { order: 3; }
    .board .lane-done { order: 4; }
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

  /* Runner lanes (queue + fleet): one column per worker, so the grid is
     computed from how many workers there are — never the board's fixed
     five tracks. auto-fit collapses empty space: one worker spans wide,
     six wrap to a readable minimum instead of scrolling off the edge. */
  .content > main:has(.lanes) { max-width: none; }
  .lanes {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: .75rem; padding-bottom: .75rem; align-items: start;
  }
  @media (max-width: 40rem) {
    .lanes { display: flex; flex-direction: column; }
    .lanes .lane { min-height: 0; }
  }
  .lane .lane-live { border-top: 2px solid var(--success); }
  .runner-note { width: 100%; }
  /* Fleet/queue cards: a compact two-line block — title row, then the
     metadata row — so a card reads at a glance instead of stacking. */
  .queue-card p { margin: 0; }
  .queue-card .row + .row { margin-top: .125rem; border-bottom: none; }
  .queue-card p.row { padding: 0; border-bottom: none; }
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

/* the phone (arc 3): fingers, not cursors — tested at 320/390px */
input, select, textarea { font-size: 16px; }
button { min-height: 44px; }
@media (max-width: 40rem) {
  form.card button[type=submit], form > button[type=submit] { width: 100%; }
  input[type=text], input[type=password] { width: 100%; max-width: 100%; box-sizing: border-box; }
  main { padding-bottom: calc(1rem + env(safe-area-inset-bottom)); }
}

/* Motion (arc 4): only where a human caused the change — navigation,
   presses, overlays. Liveness swaps stay deliberately instant; the pulse
   dot is the one "alive" signal. Everything here dies under
   prefers-reduced-motion, and the auto-refresh pages opt out of the
   navigation cross-fade separately (see shell()). */
@view-transition { navigation: auto; }
::view-transition-old(root), ::view-transition-new(root) {
  animation-duration: 140ms; animation-timing-function: ease-out;
}
@media (prefers-reduced-motion: no-preference) {
  .tabbar a, .side nav a { transition: color .15s, background .15s; }
  button:active { transform: scale(.985); }
  .palette, .kbd-help { animation: rise 120ms ease-out; }
  @media (hover: hover) and (pointer: fine) {
    .lane-card, .decide-card, .menu-row { transition: border-color .15s, transform .15s, box-shadow .15s; }
    .lane-card:hover, .decide-card:hover, .menu-row:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 8px -2px hsl(240 10% 3.9% / .12);
    }
  }
}
@keyframes rise { from { opacity: 0; margin-top: 4px; } }
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*), ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
  .pulse, .fire-live { animation: none; }
  .palette, .kbd-help { animation: none; }
}

/* The shortcuts overlay (arc 4): display-only, toggled by the chrome
   layer, absent from sensitive pages. A centered card on desktop, a
   bottom sheet above the tab bar on phones. */
.kbd-help {
  position: fixed; top: 18vh; left: 50%; transform: translateX(-50%); width: min(26rem, 92vw);
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 1px 2px hsl(240 10% 3.9% / .08), 0 16px 40px -16px hsl(240 10% 3.9% / .3);
  padding: 1rem 1.25rem; z-index: 50;
}
.kbd-help h2 { margin: 0 0 .5rem; font-size: .9375rem; }
.kbd-help table { width: 100%; border-collapse: collapse; font-size: .8125rem; }
.kbd-help td { padding: .25rem 0; vertical-align: top; }
.kbd-help td:first-child { width: 7.5rem; color: var(--muted-foreground); white-space: nowrap; }
.kbd-help kbd {
  font-family: var(--font-mono); font-size: .75rem; background: var(--muted);
  border: 1px solid var(--border); border-radius: .3rem; padding: .05rem .35rem;
}
@media (max-width: 760px) {
  .kbd-help {
    top: auto; bottom: 0; left: 0; right: 0; transform: none; width: auto;
    border-radius: var(--radius) var(--radius) 0 0;
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0rem));
  }
}

/* The tournament comparison (arc 6): an at-a-glance table (one column per
   agent, scrolling in its own box on phones) and side-by-side cards on
   wide screens — single column below 1100px, stated explicitly. */
.scroll-x { overflow-x: auto; max-width: 100%; }
.contest-glance { border-collapse: collapse; font-size: .8125rem; min-width: 34rem; margin: .75rem 0; }
.contest-glance th, .contest-glance td { text-align: left; padding: .375rem .75rem .375rem 0; vertical-align: top; border-bottom: 1px solid var(--border); }
.contest-glance th { font-weight: 600; }
.contest-glance tr:last-child td { border-bottom: none; }
.contest-compare { display: grid; grid-template-columns: 1fr; gap: .75rem; align-items: start; }
@media (min-width: 1100px) {
  .content > main:has(.contest-compare) { max-width: none; }
  .contest-compare { grid-template-columns: repeat(auto-fit, minmax(24rem, 1fr)); }
}
.contest-compare .card { margin: 0; }

/* The per-file comment button (arc 6): a small real button beside a diff
   row — keyboard-reachable, never fighting the editor link for a click. */
button.pick-file { min-height: 1.5rem; padding: 0 .5rem; font-size: .6875rem; box-shadow: none; }

/* Sticky ceremony actions (arc 4): single-primary-action forms keep
   their submit within thumb reach on phones. Desktop: plain flow. */
@media (max-width: 760px) {
  .sticky-actions {
    position: sticky; bottom: calc(3.5rem + env(safe-area-inset-bottom, 0rem)); z-index: 20;
    background: var(--background); border-top: 1px solid var(--border);
    padding: .625rem 0; margin-top: .75rem;
  }
  .sticky-actions button { margin: 0; }
}
`;

/** Everything the sidebar needs to draw itself for one request. */
type Chrome = {
  active: "inbox" | "board" | "queue" | "fleet" | "workbench" | "work" | "done" | "activity" | "review" | "system" | "tasks" | "runs" | "caps" | "routines" | "projects" | "settings" | "chat" | "people" | "menu" | "none";
  project: string | null;
  /** The saturated inbox count — never a sum of unbounded list reads. */
  inboxCount: number;
  inboxSaturated: boolean;
  settings: boolean;
  /** This database is a demo sandbox: banner every page, spend fenced. */
  demo?: boolean;
  /** The active operating mode's banner (M1): rides every page scoped to
   * a repo with a live mode — a signed posture is never invisible. */
  modeBanner?: { words: string; name: string };
  /** The chat tab renders only where chat could ever be allowed. */
  chat?: boolean;
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
function regionScript(regionId: string, fragmentName: string, everySeconds: number): string {
  const ms = Math.max(5, Math.floor(everySeconds)) * 1000;
  // The named-region poller (attended review, finding 2): swaps exactly one
  // element, never a form-bearing pane. Failures are VISIBLE — a frozen
  // page must never look live (finding 6): the stamp says how old the
  // region is, retries back off exponentially, and a hidden tab stops
  // polling entirely. One poll in flight at a time.
  return (
    `(function(){var region=document.getElementById(${JSON.stringify(regionId)});if(!region)return;` +
    `var stamp=document.getElementById(${JSON.stringify(regionId)}+"-stamp");` +
    `var wait=${ms};var last=Date.now();var busy=false;` +
    // The swap must not steal what the reader was holding (arc 4,
    // findings 1/15/16): before replacing the region, remember the
    // focused row (roving set only), each scrolled lane's first visible
    // card, and which board lane was centered; put them back after —
    // scroll first, focus last with preventScroll so it cannot undo the
    // scroll pass. All coordinates come from bounding rects, never
    // offsetLeft against an unpositioned parent (finding 21).
    `function laneKey(l){var m=/(^|\\s)(lane-[a-z]+)(\\s|$)/.exec(l.className);return m?m[2]:null;}` +
    `function keep(){var data={lanes:[],focus:null,pager:-1};` +
    `var act=document.activeElement;` +
    `if(act&&region.contains(act)&&act.matches&&act.matches("a.row, a.lane-card"))data.focus=act.getAttribute("href");` +
    `var board=region.querySelector(".board");` +
    `if(board&&board.scrollLeft>0){var lanes=board.querySelectorAll(".lane");` +
    `var bc=board.getBoundingClientRect();var mid=bc.left+bc.width/2;var best=-1,bd=1e9;` +
    `for(var i=0;i<lanes.length;i++){var r=lanes[i].getBoundingClientRect();var d=Math.abs(r.left+r.width/2-mid);if(d<bd){bd=d;best=i;}}` +
    `data.pager=best;}` +
    `var ls=region.querySelectorAll(".lane");` +
    `for(var i=0;i<ls.length;i++){var l=ls[i];if(l.scrollTop<=0)continue;var key=laneKey(l);if(!key)continue;` +
    `var first=null,off=0;var cards=l.querySelectorAll("a.lane-card");var lr=l.getBoundingClientRect();` +
    `for(var j=0;j<cards.length;j++){var cr=cards[j].getBoundingClientRect();if(cr.bottom>lr.top){first=cards[j].getAttribute("href");off=cr.top-lr.top;break;}}` +
    `data.lanes.push({key:key,href:first,off:off,top:l.scrollTop});}` +
    `return data;}` +
    `function restore(data){` +
    `for(var i=0;i<data.lanes.length;i++){var d=data.lanes[i];var l=region.querySelector(".lane."+d.key);if(!l)continue;` +
    `var done=false;` +
    `if(d.href){var cards=l.querySelectorAll("a.lane-card");` +
    `for(var j=0;j<cards.length;j++){if(cards[j].getAttribute("href")===d.href){` +
    `l.scrollTop=Math.max(0,l.scrollTop+cards[j].getBoundingClientRect().top-l.getBoundingClientRect().top-d.off);done=true;break;}}}` +
    `if(!done)l.scrollTop=d.top;}` +
    `if(data.pager>=0){var board=region.querySelector(".board");` +
    `if(board){var lanes=board.querySelectorAll(".lane");var at=Math.min(data.pager,lanes.length-1);` +
    `if(at>=0){var br=board.getBoundingClientRect();var lr=lanes[at].getBoundingClientRect();` +
    `board.scrollLeft=board.scrollLeft+(lr.left+lr.width/2)-(br.left+br.width/2);}}}` +
    `if(data.focus!==null){var links=region.querySelectorAll("a.row, a.lane-card");` +
    `for(var i=0;i<links.length;i++){if(links[i].getAttribute("href")===data.focus){links[i].focus({preventScroll:true});break;}}}}` +
    `function tell(){if(!stamp)return;var s=Math.round((Date.now()-last)/1000);` +
    `stamp.textContent=wait>${ms}?"stale — retrying ("+s+"s old)":"updated "+s+"s ago";}` +
    `setInterval(tell,1000);` +
    `function cycle(){if(document.hidden||busy){setTimeout(cycle,wait);return;}busy=true;` +
    `var q=location.search?location.search+"&fragment="+${JSON.stringify(fragmentName)}:"?fragment="+${JSON.stringify(fragmentName)};` +
    `fetch(location.pathname+q,{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t){var kept=keep();region.innerHTML=t;restore(kept);last=Date.now();wait=${ms};}else{wait=Math.min(wait*2,${ms}*8);}})` +
    `.catch(function(){wait=Math.min(wait*2,${ms}*8);})` +
    // A fragment that marks itself final stops the poller: a finished or
    // abandoned build must not be fetched every beat forever.
    `.then(function(){busy=false;tell();if(region.querySelector("[data-region-stop]")){if(stamp)stamp.textContent="";return;}setTimeout(cycle,wait);});}` +
    `setTimeout(cycle,wait);})();`
  );
}

/**
 * The live transcript's DEDICATED poller (arc 1 §4): a JSON byte-offset
 * protocol, not an HTML fragment — the response is raw sanitized text and
 * the ONLY sink is textContent, so nothing here can become markup. One
 * request in flight, visibility-paused, stops on `final`, and a `replaced`
 * answer restarts from zero with a visible line — never a silent re-read.
 */
function transcriptScript(): string {
  return (
    `(function(){var out=document.getElementById("live-transcript");if(!out)return;` +
    `var from=0,busy=false,stopped=false;` +
    `function near(){return out.scrollHeight-out.scrollTop-out.clientHeight<40;}` +
    `function go(){if(stopped)return;if(busy||document.hidden){later();return;}busy=true;` +
    `fetch(location.pathname+"?fragment=transcript&from="+from,{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){stopped=true;return null;}` +
    `if(r.status===409)return{error:"replaced"};return r.ok?r.json():null;})` +
    `.then(function(d){busy=false;if(d===null){later();return;}if(stopped)return;` +
    `if(d.error==="replaced"){from=0;out.textContent="[the view restarted]\\n";later();return;}` +
    `if(d.error){stopped=true;return;}` +
    `var stick=near();` +
    `if(typeof d.text==="string"&&d.text!==""){out.appendChild(document.createTextNode(d.text));if(stick)out.scrollTop=out.scrollHeight;}` +
    `if(typeof d.nextOffset==="number"&&d.nextOffset>=from){from=d.nextOffset;}` +
    `if(d.final===true){stopped=true;var m=document.getElementById("live-transcript-state");` +
    `if(m)m.textContent="the agent finished — the record on this page is the story";return;}` +
    `later();})` +
    `.catch(function(){busy=false;later();});}` +
    `function later(){setTimeout(go,2000);}go();})();`
  );
}

/**
 * The attended chrome layer: the jump palette and elapsed tickers. Pure
 * navigation — no key ever posts, so the palette cannot approve anything;
 * ceremonies stay POST + password + CSRF, untouched. Reads its index from
 * a non-executable JSON script tag rendered by the same authorized page.
 */
/** The attended beat (v28): parameterless, cookie + same-origin proven
 * server-side, renewal-only — any console page keeps the signed-in
 * approver's own sessions live; a hidden tab pauses honestly. Cheap
 * no-op when nothing is open. Shipped ALONE on sensitive pages. */
function beatScript(): string {
  return (
    `(function(){var beat=function(){if(document.hidden)return;` +
    `fetch("/session/attended-beats",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:""}).catch(function(){});};` +
    `beat();setInterval(beat,15000);})();`
  );
}

function chromeScript(): string {
  return (
    beatScript() +
    `(function(){` +
    // The app-icon badge (Phase 2E): the page's server-rendered waiting
    // count is authoritative over any stale push — synced on every chrome
    // page load through the worker, cleared at zero, honest no-op where
    // push never enrolled.
    `try{var waiting=document.querySelector("[data-waiting]");` +
    `if(waiting&&navigator.serviceWorker&&navigator.serviceWorker.controller){` +
    `navigator.serviceWorker.controller.postMessage({badge:Number(waiting.getAttribute("data-waiting"))||0});}}catch(e){}` +
    // elapsed tickers: server timestamps, client arithmetic, display only
    `function tick(){var nodes=document.querySelectorAll("time[data-elapsed-since]");` +
    `for(var i=0;i<nodes.length;i++){var t=Date.parse(nodes[i].getAttribute("data-elapsed-since"));` +
    `if(!isFinite(t))continue;var s=Math.max(0,Math.floor((Date.now()-t)/1000));` +
    `var m=Math.floor(s/60);var h=Math.floor(m/60);` +
    `nodes[i].textContent=h>0?h+"h "+(m%60)+"m":m>0?m+"m "+(s%60)+"s":s+"s";}}` +
    `setInterval(tick,1000);tick();` +
    // the palette
    `var raw=document.getElementById("palette-index");if(!raw)return;` +
    `var index;try{index=JSON.parse(raw.textContent||"[]");}catch(e){return;}` +
    `var open=false,box=null,list=null,input=null,items=[];` +
    `function close(){if(!open)return;open=false;box.remove();box=null;}` +
    `function go(href){location.href=href;}` +
    `function render(filter){list.textContent="";items=[];var n=0;` +
    `for(var i=0;i<index.length&&n<12;i++){var e=index[i];` +
    `if(filter&&(e.label.toLowerCase().indexOf(filter.toLowerCase())===-1))continue;` +
    `var li=document.createElement("li");li.setAttribute("role","option");li.textContent=e.label;` +
    `li.setAttribute("data-href",e.href);if(n===0)li.setAttribute("aria-selected","true");` +
    `li.addEventListener("click",function(ev){go(ev.currentTarget.getAttribute("data-href"));});` +
    `list.appendChild(li);items.push(li);n++;}}` +
    `function pick(delta){var at=-1;for(var i=0;i<items.length;i++)if(items[i].getAttribute("aria-selected")==="true")at=i;` +
    `if(at>=0)items[at].removeAttribute("aria-selected");var next=Math.max(0,Math.min(items.length-1,at+delta));` +
    `if(items[next])items[next].setAttribute("aria-selected","true");}` +
    `function show(){if(open)return;open=true;` +
    `box=document.createElement("div");box.className="palette";box.setAttribute("role","dialog");box.setAttribute("aria-label","jump to");` +
    `input=document.createElement("input");input.type="text";input.placeholder="jump to\u2026";input.setAttribute("autocomplete","off");` +
    `list=document.createElement("ul");list.setAttribute("role","listbox");` +
    `box.appendChild(input);box.appendChild(list);document.body.appendChild(box);` +
    `input.addEventListener("input",function(){render(input.value);});` +
    `input.addEventListener("keydown",function(ev){` +
    `if(ev.key==="Escape"){close();ev.preventDefault();}` +
    `else if(ev.key==="ArrowDown"){pick(1);ev.preventDefault();}` +
    `else if(ev.key==="ArrowUp"){pick(-1);ev.preventDefault();}` +
    `else if(ev.key==="Enter"){for(var i=0;i<items.length;i++)if(items[i].getAttribute("aria-selected")==="true")go(items[i].getAttribute("data-href"));ev.preventDefault();}});` +
    `render("");input.focus();}` +
    // the shortcuts overlay: display-only; focus moves in on open and
    // back out on close; every other shortcut sleeps while it is up
    `var help=document.querySelector(".kbd-help");var helpBack=null;` +
    `function helpOpen(){return help!==null&&!help.hidden;}` +
    `function toggleHelp(){if(!help)return;` +
    `if(help.hidden){helpBack=document.activeElement;help.hidden=false;help.focus();}` +
    `else{help.hidden=true;if(helpBack&&helpBack.focus)helpBack.focus();helpBack=null;}}` +
    `document.addEventListener("click",function(ev){if(helpOpen()&&!help.contains(ev.target))toggleHelp();});` +
    // j/k: a roving focus over the page's rows — only from body or from
    // inside the set, clamped at the ends, preventDefault only on a real
    // move (finding 9); held keys may repeat
    `function rove(delta,ev){` +
    `var set=Array.prototype.slice.call(document.querySelectorAll("a.row, a.lane-card"));` +
    `if(set.length===0)return;` +
    `var cur=document.activeElement;var at=set.indexOf(cur);` +
    `if(cur&&cur!==document.body&&cur!==document.documentElement&&at===-1)return;` +
    `var next=at===-1?(delta>0?0:set.length-1):Math.max(0,Math.min(set.length-1,at+delta));` +
    `if(next===at)return;` +
    `set[next].focus();ev.preventDefault();}` +
    // key routing: never inside editable targets, no modifiers, no IME
    // composition (finding 4); repeats allowed only for j/k
    `var pending=null;` +
    `document.addEventListener("keydown",function(ev){` +
    `if(ev.isComposing||ev.metaKey||ev.ctrlKey||ev.altKey)return;` +
    `var t=ev.target;var tag=t&&t.tagName?t.tagName.toLowerCase():"";` +
    `if(tag==="input"||tag==="textarea"||tag==="select"||tag==="button"||(t&&t.isContentEditable))return;` +
    `if(ev.key==="Escape"){if(helpOpen()){toggleHelp();ev.preventDefault();return;}close();return;}` +
    `if(helpOpen())return;` +
    `if(ev.repeat&&ev.key!=="j"&&ev.key!=="k")return;` +
    `if(ev.key==="/"){show();ev.preventDefault();return;}` +
    `if(ev.key==="?"){toggleHelp();ev.preventDefault();return;}` +
    `if(ev.key==="j"||ev.key==="k"){rove(ev.key==="j"?1:-1,ev);return;}` +
    `if(pending==="g"){pending=null;` +
    `var map={b:"/board",i:"/",w:"/workbench",r:"/routines",d:"/done",q:"/queue",f:"/fleet",t:"/tasks",a:"/activity",p:"/projects"};` +
    `if(map[ev.key]){go(map[ev.key]);ev.preventDefault();}return;}` +
    `if(ev.key==="g"){pending="g";setTimeout(function(){pending=null;},800);}});` +
    `})();`
  );
}

/**
 * A page described, not yet rendered (arc 4): every chromed HTML route
 * returns one of these and ONE helper (sendScreen, inside the server)
 * owns the nonce, the palette index, the shortcuts overlay, script
 * composition, and the CSP. Renderers stopped calling shell() themselves
 * so those five things cannot drift apart per route.
 */
type Screen = {
  title: string;
  body: string;
  chrome?: Chrome;
  /** The page's own executable behavior (a region poller, the push
   * enrollment script). fetches: true when it calls fetch — connect-src
   * is granted only then. */
  functional?: { script: string; fetches?: boolean };
  refreshSeconds?: number;
  /** Render sensitive even when no password field is visible — one-time
   * secrets and judgment calls the classifier cannot see. */
  forceSensitive?: boolean;
};

function screen(
  title: string,
  body: string,
  options: Omit<Screen, "title" | "body"> = {},
): Screen {
  return { title, body, ...options };
}

/**
 * The sensitivity classifier (arc 4, findings 3/17): a body showing a
 * password input renders WITHOUT the chrome additions (palette, overlay,
 * global keys) — the page's own functional script still ships. Tolerant
 * of quoting, casing, and whitespace; `data-type="password"` and prose
 * mentioning passwords do not match. This is defense-in-depth over a
 * file whose only HTML producer is its own double-quoted template
 * convention — forceSensitive is the escape hatch for what a regex
 * cannot judge.
 */
export const SENSITIVE_INPUT = /<input\b[^>]*[\s"']type\s*=\s*["']?password/i;

/** The shortcuts overlay: display-only, toggled by the chrome layer,
 * absent from sensitive pages. Navigation help in plain words — no key
 * ever posts. */
const KBD_HELP =
  `<div class="kbd-help" hidden role="dialog" aria-label="keyboard shortcuts" tabindex="-1">` +
  `<h2>keyboard shortcuts</h2><table>` +
  `<tr><td><kbd>/</kbd></td><td>jump to a page or an open task</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>i</kbd></td><td>go to the inbox</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>b</kbd></td><td>go to the board</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>q</kbd></td><td>go to the queue</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>f</kbd></td><td>go to the fleet</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>w</kbd></td><td>go to the workbench</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>r</kbd></td><td>go to the routines</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>t</kbd></td><td>go to the task list</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>a</kbd></td><td>go to the activity view</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>p</kbd></td><td>go to the projects</td></tr>` +
  `<tr><td><kbd>g</kbd> then <kbd>d</kbd></td><td>go to what is done</td></tr>` +
  `<tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>move through the rows on this page</td></tr>` +
  `<tr><td><kbd>Escape</kbd></td><td>close this</td></tr>` +
  `</table></div>`;

function shell(
  title: string,
  body: string,
  options: {
    nav?: boolean;
    chrome?: Chrome;
    refreshSeconds?: number;
    /** The page's one nonce'd script: region pollers + the chrome layer,
     * composed by sendScreen. Read-only regions only; one nonce per
     * response. fallbackRefresh marks a page whose script POLLS — only
     * those earn the noscript meta-refresh (a chrome-layer-only page with
     * forms must never re-render what someone was typing). */
    live?: { nonce: string; script: string; fallbackRefresh?: boolean };
  } = {},
): string {
  const head = [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    // Live status with zero JavaScript: the page asks the browser to fetch
    // it again. Only ever on read-only briefing pages — a refresh on a page
    // with a form would eat what somebody was typing.
    // A page that reloads itself on a timer must not cross-fade every
    // beat — the navigation transition is for navigation someone chose.
    ...(options.refreshSeconds === undefined
      ? []
      : [
          `<meta http-equiv="refresh" content="${Math.max(5, Math.floor(options.refreshSeconds))}">`,
          `<style>@view-transition { navigation: none; }</style>`,
        ]),
    // With the in-place swapper, the whole-page refresh survives only as
    // the no-JavaScript fallback — and CSS view transitions run without
    // JavaScript, so the fallback carries its own opt-out.
    ...(options.live?.fallbackRefresh !== true
      ? []
      : [`<noscript><meta http-equiv="refresh" content="30"><style>@view-transition { navigation: none; }</style></noscript>`]),
    `<title>${escape(title)}</title><style>${STYLE}</style></head><body>`,
  ].join("\n");
  const tail =
    options.live === undefined
      ? `</body></html>`
      : `<script nonce="${options.live.nonce}">${options.live.script}</script></body></html>`;

  if (options.chrome === undefined) {
    // Chromeless: the login page and refusal pages.
    return [head, `<main>`, body, `</main>`, tail].join("\n");
  }

  const chrome = options.chrome;
  const item = (key: Chrome["active"], href: string, label: string, count?: number): string =>
    `<a href="${href}"${chrome.active === key ? ' class="active"' : ""}${key === "inbox" && count !== undefined ? ` data-waiting="${count}"` : ""}>${label}` +
    `${count !== undefined && count > 0 ? ` <span class="count badge badge-open">${count}${key === "inbox" && chrome.inboxSaturated ? "+" : ""}</span>` : ""}</a>`;

  const side = [
    `<aside class="side">`,
    `<a class="brand" href="/">standing<span class="dot">·</span>orders</a>`,
    `<div class="side-project">` +
      (chrome.project === null
        ? `<span class="name meta">no project open</span>`
        : `<span class="name">${escape(projectName(chrome.project))}</span>`) +
      `<a href="/projects">switch project</a></div>`,
    `<nav>`,
    item("inbox", "/", "inbox", chrome.inboxCount),
    item("board", "/board", "board"),
    item("queue", "/queue", "queue"),
    item("fleet", "/fleet", "fleet"),
    item("workbench", "/workbench", "workbench"),
    item("routines", "/routines", "routines"),
    item("done", "/done", "done"),
    `</nav>`,
    `<a class="new-task" href="/tasks/new">+ new task</a>`,
    `<span class="grow"></span>`,
    `<nav class="foot">`,
    item("activity", "/activity", "activity"),
    item("review", "/review", "review queue"),
    ...(chrome.chat === true ? [item("chat", "/chat", "chat")] : []),
    item("work", "/tasks", "task list"),
    item("system", "/system", "system"),
    item("runs", "/runs", "builds"),
    item("caps", "/caps", "requirements"),
    ...(chrome.settings ? [item("settings", "/settings", "settings")] : []),
    `</nav>`,
    `</aside>`,
  ].join("\n");

  // The sandbox banner: every page, no dismissal — a screenshot of a demo
  // must not pass as production (adoption review, finding 8; the FENCE is
  // the refuseDemo gate in operate.ts, this is the honest label).
  const demoBanner =
    (chrome.demo === true
      ? `<div style="background:hsl(45 90% 55% / .18);border-bottom:1px solid hsl(45 60% 45% / .5);padding:.4rem .9rem;font-size:.85rem">sandbox data \u2014 this is a demo database; nothing here spends money or reaches a remote</div>`
      : "") +
    (chrome.modeBanner === undefined
      ? ""
      : `<div style="background:hsl(265 60% 55% / .14);border-bottom:1px solid hsl(265 40% 50% / .45);padding:.4rem .9rem;font-size:.85rem">${escape(chrome.modeBanner.words)} \u00b7 <a href="/mode">the terms \u00b7 end it</a></div>`);
  const content =
    chrome.listPane === undefined
      ? `<div class="content">${demoBanner}<main>${body}</main></div>`
      : `<div class="content">${demoBanner}<div class="split">` +
        `<div class="list-pane">${chrome.listPane}</div>` +
        `<div class="detail"><main>${body}</main></div>` +
        `</div></div>`;

  // The phone chrome (arc 4): a top bar with the project one tap from
  // switching and quick capture, and a bottom tab bar with the four
  // destinations a thumb visits — everything else behind /menu. CSS shows
  // these only below 760px; desktop keeps the sidebar untouched.
  const mobileTop = [
    `<header class="mobile-top">`,
    `<a class="brand-mini" href="/">s·o</a>`,
    `<a class="project-pill" href="/projects"><span class="name">${
      chrome.project === null ? "no project open" : escape(projectName(chrome.project))
    }</span><span class="chev">▾</span></a>`,
    `<a class="mobile-new" href="/tasks/new">+ task</a>`,
    `</header>`,
  ].join("");
  const tab = (key: Chrome["active"], href: string, glyph: string, label: string, count?: number): string =>
    `<a href="${href}"${chrome.active === key ? ' class="active"' : ""}><span class="glyph">${glyph}</span>${label}` +
    `${count !== undefined && count > 0 ? `<span class="count badge badge-open">${count}</span>` : ""}</a>`;
  const tabbar = [
    `<nav class="tabbar">`,
    tab("inbox", "/", "◉", "inbox", chrome.inboxCount),
    tab("board", "/board", "▦", "board"),
    tab("queue", "/queue", "≡", "queue"),
    tab("runs", "/runs", "⚒", "builds"),
    tab("menu", "/menu", "⋯", "more"),
    `</nav>`,
  ].join("");

  return [head, `<div class="app">`, side, mobileTop, content, tabbar, `</div>`, tail].join("\n");
}


/** ONE way a person is named on any surface (U3): the same chip everywhere. */
function personChip(name: string): string {
  return `<span class="mono">${escape(name)}</span>`;
}

/** The invite's front door: cookie-free, script-free, sensitive by shape.
 * Rendered only for a LIVE token — everything dead gets joinDeadPage. */
function joinFormPage(token: string, problem: string | null, name: string): string {
  return shell("join", [
    `<div class="login-viewport"><div class="login-shell">`,
    `<h1>standing<span class="dot">\u00b7</span>orders</h1>`,
    `<p class="meta hint">you were invited \u2014 pick a name and a password to sign in</p>`,
    `<div class="login-card">`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    `<form method="post" action="/join/${escape(token)}">`,
    `<label>username<input type="text" name="name" autocomplete="username" value="${escape(name)}" autofocus></label>`,
    `<label>password<input type="password" name="password" autocomplete="new-password"></label>`,
    `<button type="submit">create my sign-in</button>`,
    "</form>",
    `</div>`,
    `<p class="login-foot">this link works once, for you.</p>`,
    `</div></div>`,
  ].join("\n"), { nav: false });
}

/** Unknown, expired, revoked, consumed, attempts spent: ONE page (D6). */
function joinDeadPage(): string {
  return shell("join", [
    `<div class="login-viewport"><div class="login-shell">`,
    `<h1>standing<span class="dot">\u00b7</span>orders</h1>`,
    `<div class="login-card">`,
    `<p>this invite link is not usable.</p>`,
    `<p class="meta">links work once and expire \u2014 ask the person who invited you for a fresh one.</p>`,
    `</div>`,
    `</div></div>`,
  ].join("\n"), { nav: false });
}

function loginPage(problem: string | null): string {
  return shell("standing-orders", [
    `<div class="login-viewport"><div class="login-shell">`,
    `<h1>standing<span class="dot">\u00b7</span>orders</h1>`,
    `<p class="meta hint">your fleet's control plane \u2014 sign in to see it</p>`,
    `<div class="login-card">`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    `<form method="post" action="/login">`,
    `<label>username<input type="text" name="name" autocomplete="username" autofocus></label>`,
    `<label>password<input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">sign in</button>`,
    "</form>",
    `</div>`,
    `<p class="login-foot">no account? one is created where the server runs:<br><code>standing-orders approver add &lt;name&gt; --password &hellip;</code></p>`,
    `</div></div>`,
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
  revision: number;
  /** No project open in scoped mode: every admitted project at once,
   * chips on every row, links only — acting means opening the project. */
  rollup: boolean;
  decisions: (Decision & { taskId: string; repo?: string | null })[];
  approvals: { taskId: string; title: string; goal: string; proposedAt: string; repo?: string | null }[];
  requeueables: { taskId: string; title: string; state: TaskState; strikes: number; incidentCount: number; repo?: string | null }[];
  cancelledBlockers: { blockerId: string; dependentCount: number; exampleDependent: string; repo?: string | null; blockerRepo?: string | null }[];
  gaps: Gap[];
  /** The first-run checklist; null once the installation has succeeded once. */
  wizard: { done: boolean; title: string; detail: string }[] | null;
  now: Date;
}): Screen {
  /** The row's project, worn openly in the roll-up — null is UNPLACED,
   * said as such, never a silent missing chip (finding 13). */
  const chip = (repo: string | null | undefined): string =>
    !data.rollup ? "" : repo === null || repo === undefined
      ? ` <span class="badge">unplaced</span>`
      : ` <span class="badge">${escape(projectName(repo))}</span>`;
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
              `<span class="mono meta">${escape(decision.taskId)}</span>${chip(decision.repo)}` +
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
              `<span class="mono meta">${escape(one.taskId)}</span>${chip(one.repo)} <span class="right meta">review &amp; approve \u2192</span>` +
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
              `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> ${escape(one.title)}${chip(one.repo)}` +
              `${one.incidentCount > 0 ? ` <span class="badge badge-failed">${one.incidentCount} incident${one.incidentCount > 1 ? "s" : ""}</span>` : ""}` +
              `${one.strikes > 0 ? ` <span class="meta">${one.strikes} failed attempt${one.strikes > 1 ? "s" : ""}</span>` : ""}` +
              (data.rollup
                ? `<span class="right meta">open its project to retry \u2192</span></p>`
                : `<span class="right"><form method="post" action="${taskHref(one.taskId)}/requeue" class="inline">` +
                  `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
                  `<input type="hidden" name="return" value="inbox">` +
                  `<button type="submit">retry</button></form></span></p>`),
          )
          .join("\n");

  const cancelled =
    data.cancelledBlockers.length === 0
      ? ""
      : `<h2>repair a dependency</h2><p class="hint">these were cancelled, but other tasks still wait on them — re-create the blocker or remove the dependency</p>` +
        data.cancelledBlockers
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.blockerId)}">${escape(one.blockerId)}</a>${chip(one.blockerRepo)} ` +
              `<span class="meta">cancelled \u00b7 ${one.dependentCount} task${one.dependentCount > 1 ? "s" : ""} waiting (e.g. ${escape(one.exampleDependent)})` +
              `${data.rollup && one.repo !== one.blockerRepo ? ` \u00b7 across projects${one.repo === null || one.repo === undefined ? "" : ` \u2014 waits in ${escape(projectName(one.repo))}`}` : ""}</span></p>`,
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

  // The first-run checklist replaces the empty-queue card while the
  // installation has never succeeded; each step is live state, and the
  // whole card retires permanently on the first successful run.
  const wizard =
    data.wizard === null
      ? ""
      : `<div class="card">` +
        `<p><strong>Getting started</strong> <span class="meta">\u2014 live state, not a saved step; this card retires itself after the first successful unattended run</span></p>` +
        `<p class="meta">or run <span class="mono">standing-orders up</span> in a repository \u2014 it starts the console and a worker and completes the first steps; the rest of this list still shows what remains.</p>` +
        data.wizard
          .map(
            step =>
              `<p class="row"><span class="mono">${step.done ? "\u2713" : "\u25cb"}</span> <strong>${escape(step.title)}</strong><br>` +
              `<span class="meta">${step.detail}</span></p>`,
          )
          .join("\n") +
        `<p class="meta">templates \u2014 edit, then approve; nothing a template files carries authority: ` +
        TEMPLATES.map(one =>
          one.kind === "routine"
            ? `<a href="/routines?template=${escape(one.name)}">${escape(one.name)}</a>`
            : one.kind === "task"
              ? `<a href="/tasks?template=${escape(one.name)}">${escape(one.name)}</a>`
              : `<span title="a recipe \u2014 walk it in the terminal: standing-orders template show ${escape(one.name)}">${escape(one.name)} (recipe)</span>`,
        ).join(" \u00b7 ") +
        `</p></div>`;

  return screen("inbox", [
    `<h1>inbox</h1>`,
    `<p class="meta">everything waiting on you \u2014 answer, approve, retry, repair, supply; when this is empty, nothing needs your attention</p>`,
    wizard,
    empty ? "" : `<p><a class="new-task" style="display:inline-block" href="/next">clear the queue \u2192 one thing at a time</a></p>`,
    empty && data.wizard === null ? `<div class="card"><p><strong>Nothing needs you.</strong></p><p class="meta">The queue is either working or waiting on its own timers. <a href="/board">Watch the board</a> or <a href="/activity">read the activity report</a>.</p></div>` : "",
    decisions,
    approvals,
    requeueables,
    cancelled,
    gaps,
    data.rollup
      ? `<p class="meta">requirement gaps are checked one project at a time \u2014 open a project to see and fill its gaps · <a href="/projects">open a project</a></p>`
      : "",
    // Quick capture: the shortest path from "I want this done" to the
    // approve card — title and goal here, the yes on the next screen. The
    // one-shot form posts to the same guarded handler as the full page.
    data.rollup ? "" : `<h2>capture new work</h2>`,
    data.rollup ? "" : `<form method="post" action="/tasks/add" class="card">`,
    ...(data.rollup
      ? []
      : [
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          `<input type="hidden" name="projectRevision" value="${data.revision}">`,
          `<label>what should get done<input type="text" name="title" placeholder="a title the board can wear" maxlength="200"></label>`,
          `<label>what success looks like <span class="meta">(becomes the scope you approve on the next screen)</span><textarea name="goal" rows="2"></textarea></label>`,
          `<button type="submit">queue it \u2192 approve its scope next</button>`,
          `</form>`,
        ]),
  ].join("\n"), { chrome });
}

/** System: the machinery — workers, background service, workspaces. */
function systemPage(chrome: Chrome, data: {
  agents: {
    phase: "plan" | "build" | "repair" | "review";
    provider?: string;
    model?: string | null;
    source?: "pinned" | "flag" | "project" | "installation" | "default";
    problem?: string;
    setBy: string | null;
  }[];
  building: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null }[];
  runners: Runner[];
  /** v28: open attended sessions per runner. */
  heldSessions?: Map<string, number>;
  worktrees: WorktreeRow[];
  episode: { id: number; startedAt: string; endedAt: string | null; ticks: number; built: number; broke: number } | null;
  outboxPending: number;
  externalWork?: { remoteRepo: string; blocked: string | null; openEpisode: string | null }[];
  now: Date;
}): Screen {
  const nowMs = data.now.getTime();
  const runnerCards = data.runners
    .filter(one => one.retiredAt === null)
    .map(one => {
      const age = nowMs - new Date(one.heartbeatAt).getTime();
      const dot = age < 5 * 60_000 ? "dot-ok" : age < 60 * 60_000 ? "dot-warn" : "dot-off";
      const said = age < 5 * 60_000 ? "alive" : age < 60 * 60_000 ? `quiet ${Math.round(age / 60_000)}m` : "not heard from";
      const busy = data.building.filter(claim => claim.runner === one.name).length;
      const sessions = data.heldSessions?.get(one.name) ?? 0;
      return (
        `<div class="stat-card"><span class="k"><span class="dot ${dot}"></span>${escape(one.name)}</span>` +
        `<span class="v">worker \u00b7 ${said} \u00b7 ${busy}/${one.capacity} building${sessions > 0 ? ` \u00b7 ${sessions} attended session${sessions === 1 ? "" : "s"} (uncapped by standing-orders — each is an agent + a supervisor process; OS limits apply)` : ""}</span></div>`
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
  const PHASE_SAID: Record<string, string> = {
    plan: "planning sessions ask questions and draft the plan you approve",
    build: "builds do the work, unattended, inside the approved scope",
    repair: "repair turns mend a malformed handoff in the same session",
  };
  const agentLines = data.agents
    .map(one => {
      if (one.problem !== undefined) {
        return `<p class="row"><span class="mono">${escape(one.phase)}</span> <span class="badge badge-failed">misconfigured</span> <span class="meta">${escape(one.problem)}</span></p>`;
      }
      const who =
        one.source === "project"
          ? `chosen for this project${one.setBy === null ? "" : ` by ${escape(one.setBy)}`}`
          : one.source === "installation"
            ? `set for the whole installation${one.setBy === null ? "" : ` by ${escape(one.setBy)}`}`
            : "the default — nothing configured";
      const dollars = one.provider === "claude" ? "" : ` · <span title="this provider reports tokens, not dollars — its runs land as unmeasured spend">no dollar costs</span>`;
      return (
        `<p class="row"><span class="mono">${escape(one.phase)}</span> ` +
        `<strong>${escape(one.provider ?? "")}</strong>` +
        `${one.model === null || one.model === undefined ? ` <span class="meta">(its default model)</span>` : ` · <span class="mono">${escape(one.model)}</span>`}` +
        `<span class="right meta">${who}${dollars}</span></p>` +
        `<p class="meta" style="margin-top:0">${PHASE_SAID[one.phase] ?? ""}</p>`
      );
    })
    .join("\n");
  const agentsCard =
    `<h2>agents</h2>` +
    `<p class="meta">which AI provider runs each phase — changed from the terminal with your credentials (<code>standing-orders config</code>), never by a browser click</p>` +
    `<div class="card">${agentLines}` +
    `<p class="meta">repair always stays on the provider that built — only its model can differ. A routine pins its agent the moment it fires; nothing after that can re-route it.</p>` +
    `</div>`;

  return screen("system", [
    `<h1>system</h1>`,
    `<p class="hint">workers execute builds; the background service starts them; each workspace is a temporary copy of your repo for one task</p>`,
    agentsCard,
    cards.length === 0
      ? `<p class="meta">no worker machine registered yet \u2014 <code>standing-orders runner register &lt;name&gt;</code>, then <code>standing-orders daemon install</code> keeps the background service running</p>`
      : `<div class="cards">${cards.join("")}</div>`,
    data.outboxPending > 0 ? `<p class="meta">notifications: ${data.outboxPending} pending delivery</p>` : "",
    (data.externalWork ?? []).length === 0
      ? ""
      : `<h2>external work</h2>` +
        (data.externalWork ?? [])
          .map(
            one =>
              `<p class="row"><span class="mono">${escape(one.remoteRepo)}</span> ` +
              (one.blocked !== null
                ? `<span class="badge badge-open">dispatch blocked</span> <span class="meta">the tracker connection needs repair — \`standing-orders sync\` says why</span>`
                : one.openEpisode !== null
                  ? `<span class="badge badge-open">sync failing</span> <span class="meta">${escape(one.openEpisode)}</span>`
                  : `<span class="meta">syncing normally</span>`) +
              `</p>`,
          )
          .join("\n"),
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
    delta: { agoMinutes: number; built: number; failed: number; questions: number } | null;
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
    renderOne: (card: BoardCard, index: number) => string,
  ): string => {
    const cards = data.cards.filter(card => card.lane === key);
    // The longest-stalled card leads the board: attention sorts by how
    // long it has waited, everything else stays newest-first — except the
    // queued lane, which reads in DISPATCH order: moved-up work first,
    // exactly as the next free worker will pick it.
    if (key === "attention") {
      cards.sort((a, b) =>
        (a.stalledSince ?? "9999").localeCompare(b.stalledSince ?? "9999"),
      );
    }
    if (key === "queued") {
      // Group: the shared queue first, then reserved columns by worker;
      // dispatch order (rank) within each — never a cross-column rank race.
      cards.sort((a, b) => {
        const ka = a.assignedRunner ?? "";
        const kb = b.assignedRunner ?? "";
        if (ka !== kb) return ka.localeCompare(kb);
        return b.priority - a.priority;
      });
    }
    const shown = cards.slice(0, CAP);
    const more = cards.length - shown.length;
    return (
      `<section class="lane lane-${key}"><h2>${title} <span class="lane-count">${cards.length}${
        data.saturated ? "+" : ""
      }</span></h2><p class="hint">${hint}</p>` +
      (shown.length === 0 ? `<p class="meta lane-empty">nothing here</p>` : shown.map((card, index) => renderOne(card, index)).join("")) +
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

  // The queued lane: ranks compare only within a COLUMN (queue-columns
  // review, finding 14), so the badge is per column head — the shared
  // queue's front card says "next up"; a reserved column's front card
  // says whose turn it is. No cross-column comparison is claimed.
  const queuedHeads = (() => {
    const heads = new Map<string, string>();
    for (const card of data.cards.filter(one => one.lane === "queued")) {
      const key = `${card.assignedRunner ?? ""}|${card.repo ?? ""}`;
      if (!heads.has(key)) heads.set(key, card.taskId);
    }
    return heads;
  })();
  const queuedCard = (card: BoardCard): string =>
    `<a class="lane-card" href="${card.href}">` +
    `<span class="t">${escape(card.title)}</span>` +
    `<span class="meta">${escape(card.reason)}${
      queuedHeads.get(`${card.assignedRunner ?? ""}|${card.repo ?? ""}`) === card.taskId
        ? ` <span class="badge">${card.assignedRunner === null ? "next up" : `next for ${escape(card.assignedRunner)}`}</span>`
        : ""
    }${
      card.assignedRunner === null ? "" : ` <span class="badge">reserved for ${escape(card.assignedRunner)}</span>`
    }${
      card.routineName === null ? "" : ` <span class="badge">${escape(card.routineName)}</span>`
    }${chip(card.repo)}</span>` +
    `<span class="mono meta">${escape(card.taskId)}</span></a>`;

  const building = (card: BoardCard): string => {
    const claim = card.claim;
    if (claim === null) return plain(card);
    const minutes = Math.max(1, Math.round((data.now.getTime() - new Date(claim.claimedAt).getTime()) / 60_000));
    const workspace = claim.worktree === null ? null : (claim.worktree.split("/").pop() ?? claim.worktree);
    // Chip copy: unknown phases show nothing rather than raw tokens.
    const phase = claim.phase === null ? undefined : PHASE_WORDS[claim.phase];
    return (
      `<a class="lane-card building" href="${card.href}">` +
      `<span class="t"><span class="dot dot-ok pulse"></span>${escape(card.title)}</span>` +
      `<span class="meta">${escape(claim.runner)} \u00b7 ${minutes}m elapsed${
        claim.model === null ? " \u00b7 preparing workspace" : ` \u00b7 ${escape(claim.model)}`
      }${claim.provider !== null && claim.provider !== "claude" ? ` \u00b7 ${escape(claim.provider)}` : ""}${
        phase === undefined ? "" : ` \u00b7 ${phase}`
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

  const ago = (minutes: number): string =>
    minutes < 60 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / (24 * 60))}d`;
  const deltaLine =
    data.delta === null
      ? ""
      : `<p class="meta"><strong>since you last looked</strong> (${ago(data.delta.agoMinutes)} ago): ` +
        [
          data.delta.built > 0 ? `<span class="good">${data.delta.built} built</span>` : "",
          data.delta.failed > 0 ? `<span class="bad">${data.delta.failed} failed</span>` : "",
          data.delta.questions > 0
            ? `${data.delta.questions} question${data.delta.questions > 1 ? "s" : ""} \u2014 <a href="/next">answer \u2192</a>`
            : "",
        ].filter(one => one !== "").join(" \u00b7 ") +
        `</p>`;

  return [
    `<h1>board</h1>`,
    deltaLine,
    `<p class="meta">the whole pipeline at a glance, updating in place \u2014 open the <a href="/">inbox</a> to act on what needs you</p>`,
    toggle,
    `<div class="board">`,
    lane("attention", "needs you", "answer, approve, or repair \u2014 these wait for a person", plain),
    lane("queued", "queued", "ready \u2014 starts when a worker has a free slot", queuedCard),
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
): Screen {
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
              `<p class="meta mono">${escape(row.taskId)} \u00b7 ${escape(when(row.completedAt))}${row.ranMinutes === null ? "" : ` \u00b7 ran ${row.ranMinutes}m`}${row.costUsd !== null ? ` \u00b7 $${row.costUsd.toFixed(2)}` : row.provider !== null && isProviderId(row.provider) && !reportsCost(row.provider) ? " \u00b7 tokens only" : ""}</p></div>`
            );
          })
          .join("\n");
  return screen("done", [
    `<h1>done</h1>`,
    `<p class="hint">completed work \u2014 each with its final build, the agent's conclusion, what it cost, and its pull request</p>`,
    list,
  ].join("\n"), { chrome });
}

/** One routine's board-facing snapshot — the store's routineTracks row. */
type Track = {
  routine: Routine;
  fires: ReturnType<Store["routineFires"]>;
  spend: { costUsd: number; unmeasuredRuns: number; totalRuns: number };
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
    `<span class="right meta">$${spend.costUsd.toFixed(2)} this week${spend.unmeasuredRuns > 0 ? ` — measured on ${spend.totalRuns - spend.unmeasuredRuns} of ${spend.totalRuns} builds` : ""}${routine.costCeilingUsd === null ? "" : ` of $${routine.costCeilingUsd.toFixed(2)}`}</span></p>` +
    (blocker !== null
      ? `<p class="meta">stopped behind <a href="${taskHref(blocker.taskId)}" class="mono">${escape(blocker.taskId)}</a> (${escape(blocker.state)})</p>`
      : latest?.instanceTaskId !== undefined && latest.instanceTaskId !== null
        ? `<p class="meta">latest: <a href="${taskHref(latest.instanceTaskId)}" class="mono">${escape(latest.instanceTaskId)}</a>${latest.instanceState === null ? "" : ` (${escape(latest.instanceState)})`}</p>`
        : "") +
    `</div>`
  );
}


function chatMoney(microusd: number | null): string {
  return microusd === null ? "unknown" : `$${(microusd / 1_000_000).toFixed(2)}`;
}

function chatPage(chrome: Chrome, data: {
  enabled: { ok: true } & Record<string, unknown> | { ok: false; why: string };
  pending: ChatTurn | null;
  latched: ChatTurn[];
  chat: { candidates: Map<string, { key: string; draft: ChatDraft; repoPath: string }>; lastTurn: { id: number; reply: string | null; staticError: string | null; proposalsDiscarded: boolean } | null } | null;
  recent: ChatTurn[];
  turnsToday: number;
  weeklySpent: number;
  repoLabels: { id: string; label: string }[];
  config: import("./store.js").ChatConfig | null;
  /** Where each provider's key comes from — never the key itself. */
  keyFacts: { provider: string; state: "environment" | "stored" | "none"; tail: string | null }[];
  /** OpenRouter's live catalog when the key is present and reachable. */
  openrouterModels: string[] | null;
  csrf: string;
  problem: string | null;
}): Screen {
  const configForm = (current: import("./store.js").ChatConfig | null): string => {
    const anthropicModels = PRICED_MODELS.filter(one => !one.includes("/"));
    const openrouterModels = data.openrouterModels ?? PRICED_MODELS.filter(one => one.includes("/"));
    const option = (model: string): string =>
      `<option value="${escape(model)}"${current?.model === model ? " selected" : ""}>${escape(model)}</option>`;
    return [
      `<form method="post" action="/chat/config" class="card">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<label>provider<select name="provider">`,
      `<option value="anthropic-api"${current?.provider === "anthropic-api" ? " selected" : ""}>anthropic-api (direct API)</option>`,
      `<option value="openrouter-api"${current?.provider === "openrouter-api" ? " selected" : ""}>openrouter-api (direct API)</option>`,
      `</select></label>`,
      `<label>model <span class="meta">(only models with a pinned price — chat reserves worst-case spend up front)</span><select name="model">`,
      `<optgroup label="anthropic-api">${anthropicModels.map(option).join("")}</optgroup>`,
      `<optgroup label="openrouter-api">${openrouterModels.map(option).join("")}</optgroup>`,
      `</select></label>`,
      data.openrouterModels === null
        ? `<p class="meta">with OPENROUTER_API_KEY in the serve environment, this list becomes OpenRouter's full live catalog — each model priced by the party that bills it</p>`
        : `<p class="meta">${data.openrouterModels.length} models live from OpenRouter's catalog; saving pins today's price — re-save to re-pin</p>`,
      `<label>weekly ceiling <span class="meta">(dollars per rolling 7 days — required; enforced before every turn)</span>` +
        `<input type="text" name="weekly-usd" inputmode="decimal" style="width:8rem" value="${current === null ? "" : (current.weeklyCeilingMicrousd / 1_000_000).toFixed(2)}"></label>`,
      `<label>daily turns <span class="meta">(default 50)</span>` +
        `<input type="text" name="daily-turns" inputmode="numeric" style="width:8rem" value="${current === null ? "" : String(current.dailyTurns)}"></label>`,
      `<label>API key <span class="meta">(${data.keyFacts
        .map(one =>
          one.state === "none"
            ? `${escape(one.provider)}: none yet`
            : one.state === "environment"
              ? `${escape(one.provider)}: from the environment`
              : `${escape(one.provider)}: stored ${escape(one.tail ?? "")}`,
        )
        .join(" · ")})</span>` +
        `<input type="password" name="key" placeholder="paste to set or replace — leave empty to keep" autocomplete="off"></label>`,
      `<label>your password <span class="meta">(this routes spend — typed again, like every spend act)</span>` +
        `<input type="password" name="token" autocomplete="current-password"></label>`,
      `<button type="submit">${current === null ? "turn chat on" : "save"}</button>`,
      `</form>`,
      `<p class="meta">a pasted key is written once to a mode-0600 file beside the database — never INTO the database, never shown again beyond its last characters; an environment variable (` +
        `<span class="mono">ANTHROPIC_API_KEY</span> / <span class="mono">OPENROUTER_API_KEY</span>) always wins when set</p>`,
    ].join("\n");
  };
  const parts: string[] = [
    "<h1>chat</h1>",
    `<p class="meta">ask about your fleet in plain language — it reads a limited summary of the projects this console serves and can draft work; drafts have no authority, live only in this browser session, and are filed and approved by you like everything else</p>`,
  ];
  if (data.problem !== null) parts.push(`<div class="problem">${escape(data.problem)}</div>`);
  if (!data.enabled.ok) {
    parts.push(`<div class="card"><p><strong>chat is off.</strong></p><p class="meta">${escape(data.enabled.why)}</p></div>`);
    // The ceiling refusals need a restart to fix; configuration does not —
    // it is a first-class act of this console (operator request).
    const code = (data.enabled as { code?: string }).code;
    if (code === "unconfigured" || code === "unpriced" || code === "no-key") {
      parts.push(`<h2>${code === "unconfigured" ? "set it up" : "reconfigure"}</h2>`, configForm(data.config));
    }
    return screen("chat", parts.join("\n"), { chrome });
  }
  const config = (data.enabled as unknown as { config: { provider: string; model: string; dailyTurns: number; weeklyCeilingMicrousd: number } }).config;
  parts.push(
    `<p class="meta">answering with <span class="mono">${escape(config.provider)} · ${escape(config.model)}</span>` +
      ` — ${data.turnsToday} of ${config.dailyTurns} turns today · ${chatMoney(data.weeklySpent)} of ${chatMoney(config.weeklyCeilingMicrousd)} this rolling week` +
      ` · repos: ${data.repoLabels.map(one => `<span class="mono">${escape(one.id)}</span> ${escape(one.label)}`).join(", ")}</p>`,
    `<p class="meta">what leaves this machine: task ids/titles/states, open questions and option labels, incident kinds, routine names/schedules, PR numbers and observed check states — deliberately, to the configured provider. Paths, branches, diffs, notes, decision details, and identities never do.</p>`,
  );
  for (const turn of data.latched) {
    parts.push(
      `<div class="problem"><strong>unknown spend blocks chat.</strong> turn #${turn.id} may have cost up to ${chatMoney(turn.reservedMicrousd)} — ` +
        `<a href="/chat/ack/${turn.id}">read and acknowledge it</a> to re-enable this credential.</div>`,
    );
  }
  if (data.pending !== null) {
    parts.push(`<div class="card"><p><strong>asking…</strong> <span class="meta">turn #${data.pending.id}, up to ${chatMoney(data.pending.reservedMicrousd)} reserved — this page refreshes itself</span></p></div>`);
    parts.push(`<p class="meta"><a href="/chat">refresh now</a></p>`);
    return screen("chat", parts.join("\n"), { chrome, refreshSeconds: 3 });
  }
  const last = data.chat?.lastTurn ?? null;
  if (last !== null) {
    if (last.staticError !== null) {
      parts.push(`<div class="card"><p class="meta">${escape(last.staticError)}</p></div>`);
    } else if (last.reply !== null) {
      parts.push(`<div class="card"><p style="white-space:pre-wrap">${escape(last.reply)}</p>` +
        (last.proposalsDiscarded ? `<p class="meta">a draft block in this answer was malformed and was discarded whole</p>` : "") +
        `</div>`);
    }
  }
  const candidates = data.chat === null ? [] : [...data.chat.candidates.values()];
  for (const one of candidates) {
    const draft = one.draft;
    parts.push(
      `<div class="card">` +
        `<p><strong>${draft.kind === "task" ? escape(draft.title) : escape(draft.name)}</strong> <span class="badge">draft ${escape(draft.kind)}</span></p>` +
        `<p class="meta">drafted by the model from fleet context — nothing is filed; drafts do not survive a restart</p>` +
        `<p style="white-space:pre-wrap">${escape(draft.goal)}</p>` +
        (draft.outOfScope === null ? "" : `<p class="meta">not: ${escape(draft.outOfScope)}</p>`) +
        (draft.touches.length > 0 ? `<p class="meta">touches: ${escape(draft.touches.join(", "))}</p>` : "") +
        (draft.kind === "routine" ? `<p class="meta">schedule: ${escape(draft.schedule)}</p>` : "") +
        `<p class="meta">repo: <span class="mono">${escape(projectName(one.repoPath))}</span></p>` +
        `<form method="post" action="/chat/file/${escape(one.key)}" class="inline">` +
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
        `<input type="password" name="token" placeholder="your password" autocomplete="current-password">` +
        `<button type="submit">file it — UNAPPROVED</button></form>` +
        `</div>`,
    );
  }
  parts.push(
    `<h2>ask</h2>`,
    `<form method="post" action="/chat" class="card">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    `<label>message<textarea name="message" rows="3" maxlength="2000"></textarea></label>`,
    `<label>your password <span class="meta">(every message — chat spends)</span><input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">ask</button>`,
    `</form>`,
  );
  parts.push(
    `<details><summary class="meta">chat settings</summary>`,
    configForm(data.config),
    `<form method="post" action="/chat/config" class="inline">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    `<input type="hidden" name="off" value="1">`,
    `<input type="password" name="token" placeholder="your password" autocomplete="current-password">`,
    `<button type="submit">turn chat off</button>`,
    `</form>`,
    data.keyFacts
      .filter(one => one.state === "stored")
      .map(
        one =>
          `<form method="post" action="/chat/config" class="inline">` +
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
          `<input type="hidden" name="forget-key" value="${escape(one.provider)}">` +
          `<input type="password" name="token" placeholder="your password" autocomplete="current-password">` +
          `<button type="submit">forget the stored ${escape(one.provider)} key</button></form>`,
      )
      .join("\n"),
    `</details>`,
  );
  if (data.recent.length > 0) {
    parts.push(`<h2>recent turns</h2>`);
    for (const turn of data.recent) {
      parts.push(
        `<p class="row"><span class="mono">#${turn.id}</span> ${escape(turn.state)}` +
          `${turn.failureReason === null ? "" : ` · ${escape(turn.failureReason)}`}` +
          ` <span class="right meta">${turn.tokensIn ?? "–"} in / ${turn.tokensOut ?? "–"} out · ${chatMoney(turn.settledMicrousd ?? turn.reservedMicrousd)}${turn.settledMicrousd === null ? " reserved" : ""}</span></p>`,
      );
    }
  }
  return screen("chat", parts.join("\n"), { chrome });
}

function chatAckPage(chrome: Chrome, turn: ChatTurn, nonce: string, csrf: string): Screen {
  return screen("chat", [
    `<h1>unknown spend</h1>`,
    `<div class="card">`,
    `<p>Turn <span class="mono">#${turn.id}</span> on <span class="mono">${escape(turn.provider)} · ${escape(turn.model)}</span> ` +
      `may have started before it failed (${escape(turn.failureReason ?? "crashed")}), and its cost could not be measured.</p>`,
    `<p><strong>Acknowledging charges the reserved worst case, ${chatMoney(turn.reservedMicrousd)}, to the ledger and re-enables chat on this credential.</strong></p>`,
    `<p class="meta">check the provider's own usage dashboard if you want the exact figure first; the ledger keeps whichever is known.</p>`,
    `<form method="post" action="/chat/ack/${turn.id}">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<input type="hidden" name="nonce" value="${escape(nonce)}">`,
    `<label>your password<input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">I own this charge — re-enable chat</button>`,
    `</form>`,
    `</div>`,
  ].join("\n"), { chrome });
}

function routinesPage(
  chrome: Chrome,
  tracks: Track[],
  form: {
    csrf: string;
    revision: number;
    problem: string | null;
    prefill?: { name: string; goal: string; not: string; touches: string; schedule: string } | null;
  },
): Screen {
  const fill = form.prefill ?? null;
  const capture =
    chrome.project === null
      ? ""
      : [
          `<h2>file a standing order</h2>`,
          form.problem === null ? "" : `<div class="problem">${escape(form.problem)}</div>`,
          `<form method="post" action="/routines/add" class="card">`,
          `<input type="hidden" name="csrf" value="${escape(form.csrf)}">`,
          `<input type="hidden" name="projectRevision" value="${form.revision}">`,
          fill === null
            ? `<p class="meta">start from a template: ${TEMPLATES.filter(one => one.kind === "routine")
                .map(one => `<a href="/routines?template=${escape(one.name)}">${escape(one.name)}</a>`)
                .join(" · ")}</p>`
            : `<p class="meta">pre-filled from a template — edit anything; nothing fires until you approve the standing order</p>`,
          `<label>name <span class="meta">(lowercase-with-dashes — it names each instance)</span><input type="text" name="name" placeholder="nightly-deps" maxlength="41" value="${fill === null ? "" : escape(fill.name)}"></label>`,
          `<label>goal <span class="meta">(what every firing is allowed to do)</span><textarea name="goal" rows="2">${fill === null ? "" : escape(fill.goal)}</textarea></label>`,
          `<label>not this <span class="meta">(optional)</span><input type="text" name="not" value="${fill === null ? "" : escape(fill.not)}"></label>`,
          `<label>touches <span class="meta">(paths, comma-separated, optional)</span><input type="text" name="touches" value="${fill === null ? "" : escape(fill.touches)}"></label>`,
          `<label>schedule <span class="meta">(every:&lt;minutes&gt; or daily:&lt;HH:MM&gt; UTC)</span><input type="text" name="schedule" placeholder="daily:03:30" value="${fill === null ? "" : escape(fill.schedule)}"></label>`,
          `<label>budget <span class="meta">(dollars per rolling 7 days, optional — needs a provider that reports cost)</span><input type="text" name="ceiling" inputmode="decimal" style="width:8rem"></label>`,
          `<button type="submit">file it \u2192 approve the standing order next</button>`,
          `<p class="meta">filing is cheap — nothing fires until you approve the template on the next screen, password and all</p>`,
          `</form>`,
        ].join("\n");
  const list =
    tracks.length === 0
      ? `<p class="meta">No standing orders${chrome.project === null ? " — open a project to file one" : " in this project yet — file one below; nothing fires until you approve it"}.</p>`
      : tracks.map(track => trackRow(track, chrome.project === null)).join("\n");
  return screen("routines", [
    `<h1>routines</h1>`,
    `<p class="hint">standing orders — repeating work that fires on a schedule, each instance building alone in its own workspace; anything needing you bubbles to the inbox</p>`,
    list,
    capture,
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
}): Screen {
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

  return screen(`routine · ${routine.name}`, [
    `<h1>${escape(routine.name)} <span class="${status.badge}">${escape(status.text)}</span>` +
      `<span class="meta"> · ${escape(projectName(routine.repo))}</span></h1>`,
    data.problem === null ? "" : `<div class="problem">${escape(data.problem)}</div>`,
    `<p>${trackStrip(fires)}<span class="right meta">$${data.spend.costUsd.toFixed(2)} this week${data.spend.unmeasuredRuns > 0 ? ` — measured on ${data.spend.totalRuns - data.spend.unmeasuredRuns} of ${data.spend.totalRuns} builds` : ""}</span></p>`,
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
  /** v28: open attended sessions per runner. */
  heldSessions?: Map<string, number>;
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
}): Screen {
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
      ? `<p class="meta">Nothing waits on you. No questions came up.</p>`
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
              `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> — ${escape(incidentWords(one.kind))}` +
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
      const sessions = data.heldSessions?.get(one.name) ?? 0;
      return (
        `<div class="stat-card"><span class="k"><span class="dot ${dot}"></span>${escape(one.name)}</span>` +
        `<span class="v">worker \u00b7 ${said} \u00b7 ${busy}/${one.capacity} building${sessions > 0 ? ` \u00b7 ${sessions} attended session${sessions === 1 ? "" : "s"} (uncapped by standing-orders — each is an agent + a supervisor process; OS limits apply)` : ""}</span></div>`
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
      ? `<h2>system status</h2><p class="hint">no worker machine registered yet \u2014 <code>standing-orders runner register &lt;name&gt;</code>, then <code>standing-orders daemon install</code> keeps the background service running</p>`
      : `<h2>system status</h2><p class="hint">workers execute builds; the background service starts them; each workspace is a temporary copy of your repo for one task</p><div class="cards">${fleetCards.join("")}</div>`;

  const startHere =
    data.taskCount === 0
      ? [
          `<div class="card">`,
          `<p><strong>Nothing is queued yet — here is the whole loop:</strong></p>`,
          `<p>1. <a href="/tasks">Add a task</a> — plain words for work you want done${data.repo === null ? "" : ` in <span class="mono">${escape(data.repo)}</span>`}.</p>`,
          `<p>2. Open it and write its scope — the goal, and what it must not become. Approve exactly that.</p>`,
          `<p>3. Leave <code>standing-orders watch</code> (or the daemon) running. Approved tasks build unattended, each on its own branch.</p>`,
          `<p class="meta">When an agent is unsure it stops and asks — those questions land here, under \u201cwaiting on you\u201d.</p>`,
          `</div>`,
        ].join("\n")
      : "";

  return screen("activity", [
    `<h1>activity</h1>`,
    data.repo === null
      ? ""
      : `<p class="meta"><strong>${escape(projectName(data.repo))}</strong> — the last 24 hours, honestly labeled: a rolling window, whatever your hours are</p>`,
    startHere,
    ledger,
    `<p class="meta">spend: ${escape(consoleSpend(summary))}</p>`,
    data.outboxPending > 0 ? `<p class="meta">notifications: ${data.outboxPending} pending delivery</p>` : "",
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
  prefill: { title: string; goal: string; not: string; touches: string } | null = null,
): Screen {
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
              `<a class="row" href="${taskHref(task.id)}">${taskDot(task.state)}<span class="mono">${escape(task.id)}</span> ` +
              `${escape(task.title)} <span class="right badge badge-${escape(task.state)}">${escape(task.state)}</span></a>`,
          )
          .join("\n");
  return screen("tasks", [
    "<h1>tasks</h1>",
    `<p class="meta">work you want done${repo === null ? "" : ` in <span class="mono">${escape(repo)}</span>`} \u2014 a task builds unattended only after its scope is approved; open one to write or approve its scope</p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    `<p class="meta">filter: <a href="/tasks">all</a> · ${filters}</p>`,
    rows,
    `<h2>add a task</h2>`,
    `<form method="post" action="/tasks/add" class="card">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    prefill === null
      ? ""
      : `<p class="meta">pre-filled from a template — edit anything; it files UNAPPROVED like every task</p>`,
    `<label>id<input type="text" name="id" placeholder="fix-payout-guard"></label>`,
    `<label>title<input type="text" name="title" value="${prefill === null ? "" : escape(prefill.title)}"></label>`,
    repo === null
      ? `<label>repo <span class="meta">(required — no project is open, so the task must say where it belongs)</span><input type="text" name="repo" required></label>`
      : `<label>repo <span class="meta">(optional — empty files into the open project)</span><input type="text" name="repo"></label>`,
    `<label>goal <span class="meta">(optional — creates an unapproved scope)</span><textarea name="goal" rows="3">${prefill === null ? "" : escape(prefill.goal)}</textarea></label>`,
    `<label>not this <span class="meta">(optional)</span><input type="text" name="not" value="${prefill === null ? "" : escape(prefill.not)}"></label>`,
    `<label>touches <span class="meta">(paths, comma-separated, optional)</span><input type="text" name="touches" value="${prefill === null ? "" : escape(prefill.touches)}"></label>`,
    `<button type="submit">add</button>`,
    `</form></details>`,
  ].join("\n"), { chrome });
}


function browsePage(chrome: Chrome, data: {
  at: string;
  root: string;
  roots: string[];
  parent: string | null;
  entries: { name: string; path: string; git: boolean }[];
  csrf: string;
}): Screen {
  const crumb = data.at === data.root ? projectName(data.root) : `${projectName(data.root)}${data.at.slice(data.root.length)}`;
  const openForm = (path: string): string =>
    [
      `<form method="post" action="/projects/open" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="path" value="${escape(path)}">`,
      `<button type="submit">open</button>`,
      `</form>`,
    ].join("");
  return screen("projects", [
    `<h1>choose a folder</h1>`,
    `<p class="meta">git repositories float to the top and can be opened; anything else can be entered — only folders under ${
      data.roots.length === 1 ? `<span class="mono">${escape(projectName(data.root))}</span>` : "the configured roots"
    } are visible here</p>`,
    data.roots.length > 1
      ? `<p class="meta">roots: ${data.roots.map(one => `<a href="/projects/browse?at=${encodeURIComponent(one)}" class="mono">${escape(projectName(one))}</a>`).join(" · ")}</p>`
      : "",
    `<p class="mono meta">${escape(crumb)}</p>`,
    data.parent === null
      ? ""
      : `<p class="row"><a href="/projects/browse?at=${encodeURIComponent(data.parent)}">\u2190 up one level</a></p>`,
    data.entries.length === 0
      ? `<p class="meta">no folders here</p>`
      : data.entries
          .map(
            one =>
              `<p class="row">` +
              `<a href="/projects/browse?at=${encodeURIComponent(one.path)}"><strong>${escape(one.name)}</strong></a>` +
              `${one.git ? ` <span class="badge badge-done">git</span>` : ""}` +
              `<span class="right">${one.git ? openForm(one.path) : `<a class="meta" href="/projects/browse?at=${encodeURIComponent(one.path)}">enter \u2192</a>`}</span>` +
              `</p>`,
          )
          .join("\n"),
    `<p class="meta"><a href="/projects">\u2190 back to projects</a></p>`,
  ].join("\n"), { chrome });
}


/**
 * The workbench rail (attended A1): needs-you first, then what is building
 * right now, then a short just-finished tail — the sit-and-watch complement
 * to the board's lanes. Links only; every act happens in the detail pane
 * or on the task's own screen. Selection is the URL, nothing else.
 */
function workbenchRail(data: {
  attention: BoardCard[];
  building: BoardCard[];
  done: { taskId: string; title: string; outcome: string | null }[];
  selected: string | null;
  saturated: boolean;
}): string {
  const row = (card: BoardCard, extra: string): string =>
    `<a class="row${card.taskId === data.selected ? " wb-selected" : ""}" href="/workbench?t=${encodeURIComponent(card.taskId)}"` +
    `${card.taskId === data.selected ? ` aria-current="true"` : ""}>` +
    `<strong>${escape(card.title)}</strong><br><span class="mono meta">${escape(card.taskId)}</span> ${extra}</a>`;
  const parts: string[] = [];
  parts.push(`<h2>needs you ${data.attention.length > 0 ? data.attention.length : ""}</h2>`);
  parts.push(
    data.attention.length === 0
      ? `<p class="meta">nothing — the fleet is running on its own</p>`
      : data.attention.slice(0, 100).map(card => row(card, `<span class="meta">${escape(card.reason)}</span>`)).join("\n"),
  );
  parts.push(`<h2>building ${data.building.length > 0 ? data.building.length : ""}</h2>`);
  parts.push(
    data.building.length === 0
      ? `<p class="meta">no builds running</p>`
      : data.building
          .map(card =>
            row(
              card,
              `<span class="meta">${escape(card.claim?.phase == null ? "working" : phaseWords(card.claim.phase))}` +
                `${card.claim?.provider ? ` · ${escape(card.claim.provider)}` : ""}` +
                `${card.claim?.claimedAt ? ` · <time data-elapsed-since="${escape(card.claim.claimedAt)}"></time>` : ""}</span>`,
            ),
          )
          .join("\n"),
  );
  if (data.done.length > 0) {
    parts.push(`<h2>just finished</h2>`);
    parts.push(
      data.done
        .map(
          one =>
            `<a class="row${one.taskId === data.selected ? " wb-selected" : ""}" href="/workbench?t=${encodeURIComponent(one.taskId)}">` +
            `<strong>${escape(one.title)}</strong><br><span class="mono meta">${escape(one.taskId)}</span> ` +
            `<span class="badge badge-${one.outcome === "built" || one.outcome === "no-change" ? "done" : "failed"}">${escape(one.outcome ?? "?")}</span></a>`,
        )
        .join("\n"),
    );
  }
  if (data.saturated) parts.push(`<p class="meta">more exists — this rail is capped; the <a href="/board?scope=all">board</a> holds the rest</p>`);
  return parts.join("\n");
}

/** Dollars for a screen: micro-USD stated as money, unknowables in words. */
function contestDollars(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

const CONTEST_STATE_WORDS: Record<string, string> = {
  dispatching: "the agents are being set up",
  racing: "the agents are working right now",
  "pick-wait": "every agent has finished — compare the results and pick one",
  "decision-wait": "an agent asked a question — answer it from the task screen and the tournament continues",
  picked: "decided — one result was picked",
  abandoned: "abandoned — nothing was picked; every agent's work is kept",
  interrupted: "interrupted — the machine running it went away; decide what happens next",
  exhausted: "finished with nothing to pick — decide what happens next",
};

/**
 * The comparison screen: every agent's result side by side — outcome, cost,
 * questions, conclusion, and the verified diff — with a pick button only on
 * results the evidence supports. Plain words throughout: tournament,
 * agents, results. The pick itself happens on a separate confirmation
 * screen whose form this page can only reach through a POST.
 */
function contestPage(chrome: Chrome, data: {
  view: { contest: Contest; agents: AgentView[] };
  taskId: string;
  taskTitle: string;
  questions: Map<number, number>;
  totalMicrousd: number;
  anyUnknown: boolean;
  rollups: Map<number, { costMicrousd: number; tokensIn: number; tokensOut: number; measuredRuns: number; totalRuns: number }>;
  diffs: Map<number, TerminalDiffView | null>;
  /** Runs whose lease is still the task's current live claim — "still
   * working" is said only of these; an interrupted agent's unfinished run
   * reads as stopped (round-4 finding 16). */
  liveRuns?: ReadonlySet<number>;
  csrf: string;
  problem: string | null;
}): Screen {
  const { contest, agents } = data.view;
  const picking = contest.state === "pick-wait";
  const abandonable = ["pick-wait", "exhausted", "interrupted", "decision-wait"].includes(contest.state);

  // ONE summary per agent (arc 6, finding 7): the at-a-glance table and the
  // cards below both render from this object, so the two can never tell a
  // pick two different stories. Every diff state keeps its own words —
  // verified-zero, changes, missing, and capture problems are not the same
  // fact and are never collapsed into "no diff".
  const summarize = (agent: AgentView) => {
    const { contestant, run } = agent;
    const outcome =
      run === null
        ? "never produced a finished attempt"
        : run.outcome === "built"
          ? "finished with changes"
          : run.outcome === "no-change"
            ? "concluded no change was needed"
            : run.outcome === "parked"
              ? "waiting on an answer"
              : run.outcome === null
                ? (data.liveRuns?.has(run.id) === true ? "still working" : "stopped without finishing")
                : run.outcome === "failed"
                  ? "failed"
                  : run.outcome === "refused"
                    ? "refused — a gate said no"
                    : "stopped";
    const minutes =
      run === null || run.finishedAt === null
        ? null
        : Math.max(1, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 60_000));
    const diff = data.diffs.get(contestant.id) ?? null;
    const diffWords =
      diff === null || diff.stat === null
        ? "no change summary"
        : "problem" in diff.stat
          ? "summary capture failed"
          : diff.stat.fileCount === 0
            ? "no changes, verified"
            : `${diff.stat.fileCount} file(s) · +${diff.stat.additions} −${diff.stat.deletions}`;
    return {
      agent,
      contestant,
      run,
      winner: contest.winnerContestant === contestant.id,
      outcome,
      minutes,
      asked: data.questions.get(contestant.id) ?? 0,
      // Money words are KIND words (slice B, E3): a comparison lane never
      // had a reservation, so reservation language would lie in both
      // directions — unmeasured lanes say tokens instead.
      cost: (() => {
        if (contest.kind !== "comparison") {
          return contestant.unknownSpend
            ? `${contestDollars(contestant.accountedMicrousd)} — the exact figure was unknowable, so the full reservation was charged`
            : contestDollars(contestant.accountedMicrousd);
        }
        // The WHOLE lineage speaks (Codex slice-B finding 6): main attempt,
        // resumes, and repairs — a newest-run read under-reports every
        // park cycle.
        const rollup = data.rollups.get(contestant.id) ?? { costMicrousd: 0, tokensIn: 0, tokensOut: 0, measuredRuns: 0, totalRuns: 0 };
        return contestant.unknownSpend
          ? `tokens only${rollup.tokensIn + rollup.tokensOut > 0 ? ` (${(rollup.tokensIn + rollup.tokensOut).toLocaleString()} across ${rollup.totalRuns} run${rollup.totalRuns === 1 ? "" : "s"})` : ""} — this harness reports no dollars`
          : `${contestDollars(rollup.costMicrousd)} measured${rollup.measuredRuns < rollup.totalRuns ? ` on ${rollup.measuredRuns} of ${rollup.totalRuns} runs` : ""}`;
      })(),
      diff,
      diffWords,
    };
  };
  const summaries = agents.map(summarize);

  // The at-a-glance table: one COLUMN per agent, the same derived facts as
  // the cards. Wide content scrolls in its own box (the arc-4 rule).
  const glance =
    summaries.length < 2
      ? ""
      : `<div class="scroll-x"><table class="contest-glance">` +
        `<tr><td></td>${summaries.map(one => `<th>agent ${one.contestant.ordinal}<span class="meta"> · ${escape(one.contestant.provider)} · ${escape(one.contestant.model)}</span>${one.winner ? ` <span class="badge badge-done">picked</span>` : ""}</th>`).join("")}</tr>` +
        `<tr><td class="meta">outcome</td>${summaries.map(one => `<td>${escape(one.outcome)}</td>`).join("")}</tr>` +
        `<tr><td class="meta">changed</td>${summaries.map(one => `<td>${escape(one.diffWords)}</td>`).join("")}</tr>` +
        `<tr><td class="meta">time</td>${summaries.map(one => `<td>${one.minutes === null ? "—" : `${one.minutes} min`}</td>`).join("")}</tr>` +
        `<tr><td class="meta">questions</td>${summaries.map(one => `<td>${one.asked}</td>`).join("")}</tr>` +
        `<tr><td class="meta">cost</td>${summaries.map(one => `<td>${escape(one.cost)}</td>`).join("")}</tr>` +
        `<tr><td></td>${summaries.map(one => `<td>${one.run === null ? "" : `<a href="/r/${one.run.id}">the build</a>`}</td>`).join("")}</tr>` +
        `</table></div>`;

  const agentCard = (summary: (typeof summaries)[number]): string => {
    const { contestant, run, winner, outcome, minutes, asked, cost, diff } = summary;
    const agent = summary.agent;
    const parts = [
      `<div class="card${winner ? " approve-form" : ""}">`,
      `<p><strong>agent ${contestant.ordinal}</strong> <span class="meta">${escape(contestant.provider)} · ${escape(contestant.model)}</span>` +
        `${winner ? ` <span class="badge badge-done">picked</span>` : ""}</p>`,
      `<p class="row">${escape(outcome)}` +
        `${minutes === null ? "" : ` <span class="meta">· ${minutes} min</span>`}` +
        `${asked > 0 ? ` <span class="meta">· asked ${asked} question${asked > 1 ? "s" : ""}</span>` : ""}` +
        `${run === null ? "" : ` <span class="meta">· <a href="/r/${run.id}">the build</a></span>`}</p>`,
      `<p class="row"><strong>cost</strong> ${escape(cost)}</p>`,
      run === null || run.handoff === null ? "" : `<p><strong>its own conclusion</strong></p><p class="recap">${escape(run.handoff)}</p>`,
      diff === null ? `<p class="meta">no diff was captured</p>` : terminalDiffCard(diff, run === null ? 0 : run.id),
    ];
    if (picking) {
      if (agent.pickable) {
        parts.push(
          `<form method="post" action="/contest/${contest.id}/arm" class="inline">`,
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          `<input type="hidden" name="choice" value="${contestant.id}">`,
          `<button type="submit">pick this result…</button>`,
          `</form>`,
          `<p class="meta">picking continues to a confirmation screen — nothing happens yet</p>`,
        );
      } else {
        parts.push(`<p class="meta">cannot be picked — ${escape(agent.unpickableReason ?? "")}</p>`);
      }
    }
    parts.push(`</div>`);
    return parts.filter(one => one !== "").join("\n");
  };

  return screen("tournament", [
    `<h1>${contestNoun(contest.kind)}</h1>`,
    `<p class="meta">${agents.length} agents raced on <a href="${taskHref(data.taskId)}">${escape(data.taskTitle)}</a> — ` +
      `only one result will be kept as the task's outcome; the rest stay archived with their evidence</p>`,
    data.problem === null ? "" : `<div class="problem">${escape(data.problem)}</div>`,
    `<p class="row"><strong>${escape((CONTEST_STATE_WORDS[contest.state] ?? "the tournament is in an unexpected state — the records have the detail").replace(/tournament/g, contestNoun(contest.kind)))}</strong></p>`,
    contest.pickedBy === null ? "" : `<p class="meta">picked by ${escape(contest.pickedBy)} at ${escape(when(contest.pickedAt ?? ""))}</p>`,
    contest.kind === "comparison"
      ? `<p class="row"><strong>spend</strong> ${escape(contestDollars(data.totalMicrousd))} measured on the lanes that report dollars` +
        `${data.anyUnknown ? ` <span class="meta">— the rest report tokens only</span>` : ""}</p>`
      : `<p class="row"><strong>charged so far</strong> ${escape(contestDollars(data.totalMicrousd))}` +
        `${data.anyUnknown ? ` <span class="meta">— includes at least one agent charged its full reservation because the exact figure was unknowable</span>` : ""}</p>`,
    glance,
    `<div class="contest-compare">${summaries.map(agentCard).join("\n")}</div>`,
    abandonable
      ? [
          `<div class="card">`,
          `<form method="post" action="/contest/${contest.id}/arm" class="inline">`,
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          `<input type="hidden" name="act" value="abandon">`,
          `<button type="submit">abandon the ${contestNoun(contest.kind)}…</button>`,
          `</form>`,
          `<p class="meta">abandoning picks nothing: the task is marked failed (it can be re-queued), and every agent's branch and evidence is kept</p>`,
          `</div>`,
        ].join("\n")
      : "",
  ].filter(one => one !== "").join("\n"), { chrome });
}

/**
 * The confirmation screen a POST minted: it restates, in full, exactly what
 * the password will authorize — the identified result, the money, and the
 * one publication consequence — over a single-use nonce bound to that
 * restatement. If anything shifts underneath before the yes, the pick
 * refuses rather than landing on the moved thing.
 */
function contestCeremonyPage(chrome: Chrome, data: {
  kind: "pick" | "abandon";
  contestKind: "race" | "comparison";
  contestId: number;
  taskId: string;
  taskTitle: string;
  agents: number;
  totalMicrousd: number;
  anyUnknown: boolean;
  chosen?: AgentView;
  publication?: { githubRepo: string; branch: string; draft: boolean } | null;
  nonceValue: string;
  csrf: string;
}): Screen {
  const back = `<p class="meta"><a href="/contest/${data.contestId}">back — decide nothing</a></p>`;
  if (data.kind === "abandon") {
    return screen("tournament", [
      `<h1>abandon this ${contestNoun(data.contestKind)}?</h1>`,
      `<div class="card">`,
      `<p class="row">${data.agents} agents ${data.contestKind === "comparison" ? "built independently" : "raced"} on <strong>${escape(data.taskTitle)}</strong>. Abandoning picks nothing:</p>`,
      `<p class="row">— the task is marked <strong>failed</strong> and can be re-queued later</p>`,
      `<p class="row">— every agent's branch and evidence is kept; nothing is deleted and nothing is published</p>`,
      data.contestKind === "comparison"
        ? `<p class="row">— the ${escape(contestDollars(data.totalMicrousd))} measured so far stays on the record</p>`
        : `<p class="row">— the ${escape(contestDollars(data.totalMicrousd))} already charged stays charged</p>`,
      `</div>`,
      `<form method="post" action="/contest/${data.contestId}/abandon" class="card approve-form">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="nonce" value="${escape(data.nonceValue)}">`,
      `<label>your password, typed again<input type="password" name="token" autocomplete="current-password"></label>`,
      `<button type="submit">yes — abandon the ${contestNoun(data.contestKind)}</button>`,
      `</form>`,
      back,
    ].join("\n"), { chrome });
  }
  const agent = data.chosen;
  if (agent === undefined || agent.run === null) return screen("tournament", `<p class="meta">nothing to confirm</p>`, { chrome });
  const run = agent.run;
  return screen("tournament", [
    `<h1>pick agent ${agent.contestant.ordinal}'s result?</h1>`,
    `<div class="card">`,
    `<p class="row"><strong>agent ${agent.contestant.ordinal}</strong> — ${escape(agent.contestant.provider)} · ${escape(agent.contestant.model)}</p>`,
    `<p class="row">its result becomes the outcome of <strong>${escape(data.taskTitle)}</strong> — the task is marked done, keyed to <a href="/r/${run.id}">this build</a></p>`,
    run.outcome === "no-change"
      ? `<p class="row">the result is a verified <strong>no change</strong> — the agent concluded nothing needed doing, and its checkout still matches the starting point</p>`
      : `<p class="row">the changes live on branch <span class="mono">${escape(run.branch ?? "?")}</span>` +
        `${run.headRevision === null ? "" : `, ending at <span class="mono">${escape(run.headRevision.slice(0, 12))}</span>`}</p>`,
    agent.diff === null
      ? ""
      : `<p class="row">the diff being picked: <span class="mono">${escape(agent.diff.sha256.slice(0, 12))}</span> · ${agent.diff.bytesStored} bytes, verified</p>`,
    data.publication === null || data.publication === undefined
      ? `<p class="row"><strong>nothing is published</strong> — the branch stays local to this machine</p>`
      : `<p class="row"><strong>a ${data.publication.draft ? "draft " : ""}pull request will be opened</strong> on ` +
        `<span class="mono">${escape(data.publication.githubRepo)}</span> from <span class="mono">${escape(data.publication.branch)}</span></p>`,
    data.contestKind === "comparison"
      ? `<p class="row">this agent's spend: ${agent.contestant.unknownSpend ? "unmeasured — its harness reports tokens, not dollars" : `${escape(contestDollars(agent.contestant.measuredMicrousd))} measured`}` +
        `; the comparison measured ${escape(contestDollars(data.totalMicrousd))} across the lanes that report dollars</p>`
      : `<p class="row">this agent was charged ${escape(contestDollars(agent.contestant.accountedMicrousd))}` +
        `${agent.contestant.unknownSpend ? " (its full reservation — the exact figure was unknowable)" : ""}` +
        `; the tournament charged ${escape(contestDollars(data.totalMicrousd))} in total</p>`,
    `<p class="row">the other ${data.agents - 1} agent${data.agents - 1 === 1 ? "'s result is" : "s' results are"} not used — their branches and evidence are kept for reference</p>`,
    `</div>`,
    `<form method="post" action="/contest/${data.contestId}/pick" class="card approve-form">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    `<input type="hidden" name="nonce" value="${escape(data.nonceValue)}">`,
    `<input type="hidden" name="choice" value="${agent.contestant.id}">`,
    `<label>your password, typed again<input type="password" name="token" autocomplete="current-password"></label>`,
    `<div class="sticky-actions"><button type="submit">yes — pick this result</button></div>`,
    `</form>`,
    back,
  ].filter(one => one !== "").join("\n"), { chrome });
}

type OnboardCardState =
  | { enabled: false; why: string }
  | { enabled: true; roots: readonly string[]; record: [string, { nameWithOwner: string; rootIndex: number; target: string; diskUsageKib: number | null; large: boolean; mintedAt: number }] | null };

type ProjectPeek = { waiting: number; queued: number; running: number; doneRecently: number };

function projectsPage(
  chrome: Chrome,
  recent: { path: string; name: string; lastOpenedAt: string }[],
  candidates: string[],
  open: string | null,
  csrf: string,
  problem: string | null,
  unscopedMode: boolean,
  browsable = false,
  onboard: OnboardCardState | null = null,
  peeks: Record<string, ProjectPeek | null> = {},
): Screen {
  // The onboarding card (repo onboarding, findings 1-39): preview first,
  // then a password-confirmed clone into a configured root. Disabled
  // states explain themselves in words (finding 28/39).
  const onboardCard =
    onboard === null
      ? ""
      : !onboard.enabled
        ? `<h2>add a repository</h2><p class="meta">${escape(onboard.why)}</p>`
        : [
            `<h2>add a repository</h2>`,
            `<p class="meta">paste a GitHub repository — you see what it is before anything is written. The clone acts as the serve process's ambient GitHub credential and lands under your projects root. Large-file (LFS) objects are not downloaded.</p>`,
            onboard.record === null
              ? [
                  `<form method="post" action="/projects/onboard-preview" class="card">`,
                  `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
                  `<label>repository <input type="text" name="repo" placeholder="owner/name or https://github.com/owner/name"></label>`,
                  onboard.roots.length > 1
                    ? `<label>into <select name="root">${onboard.roots.map((one, index) => `<option value="${index}">${escape(one)}</option>`).join("")}</select></label>`
                    : `<input type="hidden" name="root" value="0"><p class="meta">into ${escape(onboard.roots[0] ?? "")}</p>`,
                  `<button type="submit">preview</button>`,
                  `</form>`,
                ].join("\n")
              : [
                  `<div class="card">`,
                  `<p><strong>${escape(onboard.record[1].nameWithOwner)}</strong> <span class="meta">${
                    onboard.record[1].diskUsageKib === null ? "size unknown" : `${Math.max(1, Math.round(onboard.record[1].diskUsageKib / 1024))} MiB`
                  } — will land at ${escape(onboard.record[1].target)}</span></p>`,
                  `<form method="post" action="/projects/onboard-confirm">`,
                  `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
                  `<input type="hidden" name="nonce" value="${escape(onboard.record[0])}">`,
                  onboard.record[1].large
                    ? `<label class="row"><input type="checkbox" name="big-ok" value="1"> this is a large repository (or its size is unknown) — clone it anyway</label>`
                    : "",
                  `<label>your password, typed again <input type="password" name="token" autocomplete="current-password"></label>`,
                  `<div class="sticky-actions"><button type="submit">clone and open</button></div>`,
                  `</form>`,
                  `</div>`,
                ].join("\n"),
          ].join("\n");
  const openForm = (path: string, label: string): string =>
    [
      `<form method="post" action="/projects/open" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
      `<input type="hidden" name="path" value="${escape(path)}">`,
      `<button type="submit">${escape(label)}</button>`,
      `</form>`,
    ].join("");

  // A project switcher CARD (v30 UI): the name and path, an at-a-glance
  // peek — what waits on a person, what is queued or running, what built
  // in the last day — and the open action. A vertical stack that reads on
  // a phone, not a dense row.
  const peekChips = (peek: ProjectPeek | null): string => {
    if (peek === null) return `<span class="meta">not scanned</span>`;
    const bits: string[] = [];
    if (peek.waiting > 0) bits.push(`<span class="badge">${peek.waiting} waiting on you</span>`);
    if (peek.running > 0) bits.push(`<span class="badge badge-running">${peek.running} running</span>`);
    if (peek.queued > 0) bits.push(`<span class="badge">${peek.queued} queued</span>`);
    if (peek.doneRecently > 0) bits.push(`<span class="badge badge-done">${peek.doneRecently} built today</span>`);
    return bits.length === 0 ? `<span class="meta">quiet — nothing queued or waiting</span>` : bits.join(" ");
  };
  const projectCard = (one: { path: string; name: string; note: string; peek: ProjectPeek | null }): string =>
    [
      `<div class="card project-card">`,
      `<div class="row"><strong>${escape(one.name)}</strong>`,
      `<span class="right">${
        open !== null && open === one.path ? `<span class="badge badge-done">open now</span>` : openForm(one.path, "open \u2192")
      }</span></div>`,
      `<p class="meta mono" style="overflow-wrap:anywhere;margin:.2rem 0">${escape(one.path)}</p>`,
      `<p class="row" style="gap:.35rem;flex-wrap:wrap">${peekChips(one.peek)}</p>`,
      `<p class="meta">${escape(one.note)}</p>`,
      `</div>`,
    ].join("\n");
  const cards = (items: { path: string; name: string; note: string }[]): string =>
    items.map(one => projectCard({ ...one, peek: peeks[one.path] ?? null })).join("\n");

  const recentItems = recent.map(one => ({ path: one.path, name: one.name, note: `last opened ${when(one.lastOpenedAt)}` }));
  const candidateItems = candidates.map(path => ({ path, name: projectName(path), note: "seen in the queue" }));

  // The two ways to ADD a project, side by side and honest about what each
  // needs: browse this machine's filesystem, or paste a GitHub repo.
  const addCard = [
    `<div class="card">`,
    `<h2 style="margin-top:0">add a project</h2>`,
    browsable
      ? `<p class="row"><a class="badge" href="/projects/browse">\ud83d\uddc2 browse this machine's folders \u2192</a></p>`
      : `<p class="meta">folder browsing needs a scoped serve \u2014 start with <code>--project-root &lt;dir&gt;</code> or <code>--repo</code> and this lights up</p>`,
    onboardCard === "" ? "" : `<div style="margin-top:.5rem">${onboardCard}</div>`,
    `<details style="margin-top:.5rem"><summary class="meta">or type an exact path</summary>`,
    `<form method="post" action="/projects/open" class="card" style="margin-top:.4rem">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<label>path on this server<input type="text" name="path" placeholder="/Users/you/code/your-repo"></label>`,
    `<button type="submit">open project</button>`,
    `</form></details>`,
    `</div>`,
  ].join("\n");

  return screen("projects", [
    `<h1>projects</h1>`,
    `<p class="meta">a project is a git repository this server was allowed to serve \u2014 open one to see its queue, its board, and its runs</p>`,
    unscopedMode
      ? `<p class="meta">this server was started without a project list, so everything is visible \u2014 start serve with <code>--repo</code> or <code>--project-root</code> to scope it</p>`
      : "",
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    recentItems.length === 0 && candidateItems.length === 0
      ? `<div class="card"><p><strong>Nothing to open yet.</strong></p><p class="meta">Add one below \u2014 opening it registers it here for next time.</p></div>`
      : "",
    recentItems.length > 0 ? `<h2>recent</h2>${cards(recentItems)}` : "",
    candidateItems.length > 0 ? `<h2>available</h2>${cards(candidateItems)}` : "",
    addCard,
  ].join("\n"), { chrome });
}

/**
 * Creating work is the product's first verb, so it gets a whole calm page:
 * a title, the goal that becomes the scope draft, and the project it lands
 * in — then straight to the approve card, which is the aha the flow serves.
 */
/** One queue card. Taken work renders pinned — visible, never draggable. */
function queueCard(one: { id: string; title: string; approved: boolean; blockers: number; taken: boolean }, csrf: string, revision: number, queueRevision: number, workers: { name: string; retired: boolean }[], column: string): string {
  const chips =
    `${one.approved ? "" : ` <a class="badge" href="${taskHref(one.id)}">approve its scope</a>`}` +
    `${one.blockers > 0 ? ` <span class="badge">waits for ${one.blockers} task${one.blockers > 1 ? "s" : ""}</span>` : ""}` +
    `${one.taken ? ` <span class="badge">being taken — keeps its claim</span>` : ""}`;
  const hidden =
    `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
    `<input type="hidden" name="projectRevision" value="${revision}">` +
    `<input type="hidden" name="queueRevision" value="${queueRevision}">` +
    `<input type="hidden" name="task" value="${escape(one.id)}">`;
  const controls = one.taken
    ? ""
    : `<form method="post" action="/queue/move" class="inline">${hidden}` +
      `<input type="hidden" name="column" value="${escape(column)}">` +
      `<input type="hidden" name="before" value="__TOP__">` +
      `<button type="submit" aria-label="move to the front">▲</button></form>` +
      `<form method="post" action="/queue/move" class="inline">${hidden}` +
      `<select name="column" aria-label="reserve for">` +
      `<option value="anyone"${column === "anyone" ? " selected" : ""}>anyone</option>` +
      workers.filter(worker => !worker.retired).map(worker => `<option value="${escape(worker.name)}"${column === worker.name ? " selected" : ""}>${escape(worker.name)}</option>`).join("") +
      `</select><button type="submit">move</button></form>`;
  return (
    `<div class="card queue-card" data-task="${escape(one.id)}" data-taken="${one.taken ? "1" : "0"}">` +
    `<p class="row">${one.taken ? "" : `<span class="queue-handle" style="cursor:grab;user-select:none" aria-hidden="true">≡ </span>`}` +
    `<a href="${taskHref(one.id)}">${escape(one.title)}</a>${chips}</p>` +
    `<p class="row meta"><span class="mono">${escape(one.id)}</span> ${controls}</p>` +
    `</div>`
  );
}

/** The queue columns fragment — shared queue first, then each worker. */
function queueBody(
  tasks: ReturnType<Store["queueScoped"]>,
  workers: { name: string; retired: boolean; note: string | null }[],
  csrf: string,
  revision: number,
  queueRevision: number,
): string {
  const columnOf = (runner: string | null) => tasks.filter(one => one.assignedRunner === runner);
  const projectChips = (rows: typeof tasks) => {
    const repos = [...new Set(rows.map(one => one.repo).filter((one): one is string => one !== null))];
    return repos.map(repo => `<span class="badge">${escape(repo.split("/").pop() ?? repo)}</span>`).join(" ");
  };
  const shared = columnOf(null);
  const allWorkersBusy = workers.filter(one => !one.retired).length > 0 && workers.filter(one => !one.retired).every(one => columnOf(one.name).length > 0);
  const column = (title: string, key: string, head: string, rows: typeof tasks, empty: string): string =>
    `<section class="lane queue-column" data-column="${escape(key)}"><h2>${escape(title)}</h2>${head}` +
    `<p class="meta">${projectChips(rows)}</p>` +
    (rows.length === 0
      ? `<p class="meta lane-empty">${escape(empty)}</p>`
      : rows
          .map((one, index) =>
            index === 0 && key === "anyone" && allWorkersBusy && !one.taken
              ? queueCard(one, csrf, revision, queueRevision, workers, key).replace(
                  '</p>\n',
                  "</p>",
                ).replace(
                  `<p class="row meta">`,
                  `<p class="meta">every worker has reserved work — this waits until a column empties</p><p class="row meta">`,
                )
              : queueCard(one, csrf, revision, queueRevision, workers, key),
          )
          .join("\n")) +
    `</section>`;
  const noteForm = (worker: { name: string; retired: boolean; note: string | null }): string =>
    worker.retired
      ? `<p class="meta">this worker is retired — drag these elsewhere, or register the name again</p>`
      : `<form method="post" action="/queue/note" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<input type="hidden" name="projectRevision" value="${revision}">` +
        `<input type="hidden" name="runner" value="${escape(worker.name)}">` +
        `<input type="text" name="note" value="${worker.note === null ? "" : escape(worker.note)}" data-initial="${worker.note === null ? "" : escape(worker.note)}" placeholder="what this worker is working through" aria-label="column note" maxlength="200">` +
        `<button type="submit">save</button></form>` +
        `<p class="meta">takes from the shared queue when its own is empty</p>`;
  return (
    `<div class="lanes" data-queue-revision="${queueRevision}">` +
    column("shared queue", "anyone", `<p class="meta">any free worker takes from here, top first</p>`, shared, "nothing waiting — every task is reserved or running") +
    workers
      .map(worker => column(worker.name + (worker.retired ? " (retired)" : ""), worker.name, noteForm(worker), columnOf(worker.name), "nothing queued — this worker will take from the shared queue"))
      .join("\n") +
    `</div>`
  );
}

/**
 * The fleet screen — one lane per runner, and the work in front of it.
 * Building claims pin to the top of their worker's lane (live — never
 * draggable); queued reservations sit below it (draggable to another
 * worker, re-reserving them). Every card wears its project chip, which is
 * the whole point: which agent is on which project is the page's answer.
 * Form-free like the board, except the per-worker note, so the lane stack
 * can re-render itself while somebody watches.
 */
function fleetBody(
  queued: ReturnType<Store["fleetQueue"]>,
  building: ReturnType<Store["liveClaims"]>,
  runners: Runner[],
  csrf: string,
  queueRevision: number,
  visibleRepo: (repo: string | null) => boolean,
): string {
  const chip = (repo: string | null): string =>
    repo === null ? "" : ` <span class="badge">${escape(projectName(repo))}</span>`;
  const lanes = runners.map(runner => {
    const own = queued.filter(one => one.assignedRunner === runner.name && visibleRepo(one.repo));
    const live = building.filter(one => one.runner === runner.name);
    const retired = runner.retiredAt !== null;
    const head =
      retired
        ? `<p class="meta">this worker is retired — drag these elsewhere, or register the name again</p>`
        : `<form method="post" action="/queue/note" class="row">` +
          `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
          `<input type="hidden" name="from" value="fleet">` +
          `<input type="hidden" name="runner" value="${escape(runner.name)}">` +
          `<input type="text" name="note" class="runner-note" value="${runner.queueNote === null || runner.queueNote === undefined ? "" : escape(runner.queueNote)}" data-initial="${runner.queueNote === null || runner.queueNote === undefined ? "" : escape(runner.queueNote)}" placeholder="what this worker is working through" aria-label="column note" maxlength="200">` +
          `</form>` +
          `<p class="meta">${runnerAlive(runner, new Date()) ? "alive" : "quiet"} · ${live.length}/${runner.capacity} building</p>`;
    const buildingCards = live
      .map(
        claim =>
          `<div class="lane-card" data-taken="1"><p class="row"><span class="dot dot-ok pulse"></span> ${escape(claim.taskId)}</p>` +
          `<p class="row meta">building${chip(claim.repo ?? null)}${claim.model === null ? "" : ` · ${escape(claim.model)}`} · ${Math.max(1, Math.round((Date.now() - new Date(claim.claimedAt).getTime()) / 60_000))}m</p></div>`,
      )
      .join("\n");
    const queuedCards = own
      .map(
        one =>
          `<div class="lane-card queue-card" data-task="${escape(one.id)}" data-taken="${one.taken ? "1" : "0"}">` +
          `<p class="row">${one.taken ? "" : `<span class="queue-handle" style="cursor:grab;user-select:none" aria-hidden="true">≡ </span>`}` +
          `<a href="${taskHref(one.id)}">${escape(one.title)}</a></p>` +
          `<p class="row meta"><span class="mono">${escape(one.id)}</span>${chip(one.repo)}` +
          `${one.approved ? "" : ` <span class="badge">unapproved scope</span>`}` +
          `${one.blockers > 0 ? ` <span class="badge">waits for ${one.blockers}</span>` : ""}` +
          `${one.taken ? ` <span class="badge">being taken</span>` : ""}</p></div>`,
      )
      .join("\n");
    const empty =
      live.length === 0 && own.length === 0
        ? `<p class="meta lane-empty">${retired ? "nothing left" : "idle — will take from the shared queue"}</p>`
        : "";
    return (
      `<section class="lane queue-column${live.length > 0 ? " lane-live" : ""}" data-column="${escape(runner.name)}">` +
      `<h2>${escape(runner.name)}${retired ? " (retired)" : ""}</h2>${head}${buildingCards}${queuedCards}${empty}</section>`
    );
  });
  // The shared queue: anything reserved for nobody.
  const shared = queued.filter(one => one.assignedRunner === null && visibleRepo(one.repo));
  const sharedCards = shared
    .map(
      one =>
        `<div class="lane-card queue-card" data-task="${escape(one.id)}" data-taken="${one.taken ? "1" : "0"}">` +
        `<p class="row">${one.taken ? "" : `<span class="queue-handle" style="cursor:grab;user-select:none" aria-hidden="true">≡ </span>`}` +
        `<a href="${taskHref(one.id)}">${escape(one.title)}</a></p>` +
        `<p class="row meta"><span class="mono">${escape(one.id)}</span>${chip(one.repo)}` +
        `${one.approved ? "" : ` <span class="badge">unapproved scope</span>`}` +
        `${one.blockers > 0 ? ` <span class="badge">waits for ${one.blockers}</span>` : ""}` +
        `${one.taken ? ` <span class="badge">being taken</span>` : ""}</p></div>`,
    )
    .join("\n");
  const sharedLane =
    `<section class="lane queue-column" data-column="anyone"><h2>shared queue</h2>` +
    `<p class="meta">any free worker takes from here, top first</p>${sharedCards}` +
    (shared.length === 0 ? `<p class="meta lane-empty">nothing waiting — every task is reserved or running</p>` : "") +
    `</section>`;
  return (
    `<div class="lanes" data-queue-revision="${queueRevision}">` +
    sharedLane +
    lanes.join("\n") +
    `</div>`
  );
}

/** Identical drag mechanics to the queue — the pointer events land on the worker's column. */
function fleetScript(): string {
  return (
    `(function(){var region=document.getElementById("fleet-region");if(!region)return;` +
    `var stamp=document.getElementById("fleet-region-stamp");var dragging=null;` +
    `function dirty(){if(region.contains(document.activeElement)&&document.activeElement!==document.body)return true;` +
    `var inputs=region.querySelectorAll("input[type=text]");for(var i=0;i<inputs.length;i++){` +
    `if(inputs[i].value!==(inputs[i].getAttribute("data-initial")||""))return true;}` +
    `return false;}` +
    `function paused(){return dragging!==null||dirty();}` +
    `var wait=12000;var last=Date.now();var busy=false;` +
    `function tell(){if(!stamp)return;if(paused()){stamp.textContent="paused while you edit";return;}` +
    `stamp.textContent="updated "+Math.round((Date.now()-last)/1000)+"s ago";}setInterval(tell,1000);` +
    `function cycle(){if(document.hidden||busy||paused()){setTimeout(cycle,wait);return;}busy=true;` +
    `fetch("/fleet?fragment=1",{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}})` +
    `.catch(function(){})` +
    `.then(function(){busy=false;tell();setTimeout(cycle,wait);});}setTimeout(cycle,wait);` +
    `region.addEventListener("pointerdown",function(e){var handle=e.target.closest(".queue-handle");if(!handle)return;` +
    `var card=handle.closest(".queue-card");if(!card||card.getAttribute("data-taken")==="1")return;` +
    `e.preventDefault();dragging={task:card.getAttribute("data-task"),card:card};card.style.opacity="0.5";});` +
    `region.addEventListener("pointermove",function(e){if(!dragging)return;e.preventDefault();` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over)return;` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");` +
    `region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `if(target&&target!==dragging.card){target.style.outline="2px solid currentColor";}` +
    `else if(lane){lane.style.outline="2px dashed currentColor";}});` +
    `region.addEventListener("pointerup",function(e){if(!dragging)return;var drag=dragging;dragging=null;` +
    `drag.card.style.opacity="";region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over){tell();return;}` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");if(!lane){tell();return;}` +
    `var column=lane.getAttribute("data-column");var before=target&&target!==drag.card?target.getAttribute("data-task"):"";` +
    `if(target&&target.getAttribute("data-taken")==="1"){before="";}` +
    `var wrap=region.querySelector("[data-queue-revision]");` +
    `var fields={respond:"fragment",csrf:(region.querySelector("input[name=csrf]")||{value:""}).value,` +
    `queueRevision:wrap?wrap.getAttribute("data-queue-revision"):"",task:drag.task,column:column,before:before};` +
    `var post=new URLSearchParams();Object.keys(fields).forEach(function(k){post.append(k,fields[k]);});` +
    `fetch("/queue/move",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:post.toString(),redirect:"manual"})` +
    `.then(function(r){return r.ok?fetch("/fleet?fragment=1",{cache:"no-store"}).then(function(f){return f.ok?f.text():null;}):null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}else if(t===null){location.href="/fleet";}})` +
    `.catch(function(){})` +
    `.then(function(){tell();});});` +
    `})();`
  );
}

/** The /queue page's one nonce'd script: delegated pointer-event drag (it
 * survives every fragment swap — finding 17) plus a poller that re-checks
 * focus, dirty inputs, and an in-flight drag AT SWAP TIME, never only
 * before the fetch. Select dirtiness compares against data-initial
 * (finding 18); missing that, a select counts clean.
 */
function queueScript(): string {
  return (
    `(function(){var region=document.getElementById("queue-region");if(!region)return;` +
    `var stamp=document.getElementById("queue-region-stamp");var dragging=null;var ghost=null;` +
    `function dirty(){if(region.contains(document.activeElement)&&document.activeElement!==document.body)return true;` +
    `var inputs=region.querySelectorAll("input[type=text]");for(var i=0;i<inputs.length;i++){` +
    `if(inputs[i].value!==(inputs[i].getAttribute("data-initial")||""))return true;}` +
    `var selects=region.querySelectorAll("select");for(var j=0;j<selects.length;j++){` +
    `var base=selects[j].getAttribute("data-initial");if(base!==null&&selects[j].value!==base)return true;}` +
    `return false;}` +
    `function paused(){return dragging!==null||dirty();}` +
    // the poller: pause is re-checked at SWAP time
    `var wait=15000;var last=Date.now();var busy=false;` +
    `function tell(){if(!stamp)return;if(paused()){stamp.textContent="paused while you edit";return;}` +
    `stamp.textContent="updated "+Math.round((Date.now()-last)/1000)+"s ago";}setInterval(tell,1000);` +
    `function cycle(){if(document.hidden||busy||paused()){setTimeout(cycle,wait);return;}busy=true;` +
    `fetch("/queue?fragment=1",{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return null;}` +
    `return r.ok?r.text():null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}})` +
    `.catch(function(){})` +
    `.then(function(){busy=false;tell();setTimeout(cycle,wait);});}setTimeout(cycle,wait);` +
    // the drag: delegated from the stable region element
    `region.addEventListener("pointerdown",function(e){var handle=e.target.closest(".queue-handle");if(!handle)return;` +
    `var card=handle.closest(".queue-card");if(!card||card.getAttribute("data-taken")==="1")return;` +
    `e.preventDefault();dragging={task:card.getAttribute("data-task"),card:card};card.style.opacity="0.5";});` +
    `region.addEventListener("pointermove",function(e){if(!dragging)return;e.preventDefault();` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over)return;` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");` +
    `region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `if(target&&target!==dragging.card){target.style.outline="2px solid currentColor";}` +
    `else if(lane){lane.style.outline="2px dashed currentColor";}});` +
    `region.addEventListener("pointerup",function(e){if(!dragging)return;var drag=dragging;dragging=null;` +
    `drag.card.style.opacity="";region.querySelectorAll(".queue-card,.queue-column").forEach(function(n){n.style.outline="";});` +
    `var over=document.elementFromPoint(e.clientX,e.clientY);if(!over){tell();return;}` +
    `var target=over.closest(".queue-card");var lane=over.closest(".queue-column");if(!lane){tell();return;}` +
    `var column=lane.getAttribute("data-column");var before=target&&target!==drag.card?target.getAttribute("data-task"):"";` +
    `if(target&&target.getAttribute("data-taken")==="1"){before="";}` +
    `var wrap=region.querySelector("[data-queue-revision]");` +
    `var fields={respond:"fragment",csrf:(region.querySelector("input[name=csrf]")||{value:""}).value,projectRevision:(region.querySelector("input[name=projectRevision]")||{value:""}).value,` +
    `queueRevision:wrap?wrap.getAttribute("data-queue-revision"):"",task:drag.task,column:column,before:before};` +
    `var post=new URLSearchParams();Object.keys(fields).forEach(function(k){if(fields[k]!==""||k==="respond")post.append(k,fields[k]);});` +
    `fetch("/queue/move",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:post.toString(),redirect:"manual"})` +
    `.then(function(r){return r.ok?fetch("/queue?fragment=1",{cache:"no-store"}).then(function(f){return f.ok?f.text():null;}):null;})` +
    `.then(function(t){if(t&&!paused()){region.innerHTML=t;last=Date.now();}else if(t===null){location.href="/queue";}})` +
    `.catch(function(){})` +
    `.then(function(){tell();});});` +
    `})();`
  );
}

function newTaskPage(
  chrome: Chrome,
  project: string | null,
  csrf: string,
  projectRevision: number,
  problem: string | null,
  candidates: { id: string; title: string }[] = [],
): Screen {
  return screen("new task", [
    `<h1>new task</h1>`,
    `<p class="meta">plain words for work you want done${
      project === null ? "" : ` in <span class="mono">${escape(project)}</span>`
    } — it builds unattended once you approve its scope on the next screen</p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    `<form method="post" action="/tasks/add" class="card">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<input type="hidden" name="projectRevision" value="${projectRevision}">`,
    // No project open: the placement must be said (verification finding 1 —
    // the server refuses an empty one, this field is how you answer it).
    project === null
      ? `<label>repo <span class="meta">(required — no project is open, so the task must say where it belongs)</span><input type="text" name="repo" required></label>`
      : "",
    `<label>title<input type="text" name="title" placeholder="Add a sliding-window rate limiter to the public API"></label>`,
    `<label>goal <span class="meta">(becomes the scope you approve — what success looks like)</span>` +
      `<textarea name="goal" rows="4" placeholder="Sliding-window rate limiting on /api/public/*, returning 429 with Retry-After"></textarea></label>`,
    `<label>id <span class="meta">(optional — made from the title when blank)</span><input type="text" name="id"></label>`,
    candidates.length === 0
      ? ""
      : `<label>starts after <span class="meta">(optional — waits for that task to finish before a worker takes this one)</span>` +
        `<select name="after"><option value="">right away</option>` +
        candidates.map(one => `<option value="${escape(one.id)}">${escape(one.id)} — ${escape(one.title)}</option>`).join("") +
        `</select></label>`,
    `<button type="submit">create task</button>`,
    `</form>`,
  ].join("\n"), { chrome });
}

/** The revision batch a task's approval screen restates, or the named reason it cannot. */
type RevisionView =
  | { sourceTask: string; sourceRun: number; comments: { path: string | null; line: number | null; note: string; author: string }[] }
  | { problem: string };

function taskBody(data: {
  task: Task;
  strikes: number;
  plan: "requested" | "drafted" | null;
  planDocument: string | null;
  revision?: RevisionView | null;
  publication?: Publication | null;
  repo: string | null;
  /** Immutable filing provenance (v12) — the approver sees which door
   * filed this (console, cli, intake, template:<name>) at the yes. */
  filedVia?: string | null;
  holds: Hold[];
  contest?: { id: number; state: string; agents: number; kind: "race" | "comparison" } | null;
  claimed: boolean;
  /** What this task waits for — blockers outside this console's ceiling
   * are named but carry no state and no link. */
  waitsFor?: { id: string; state: string | null; admitted: boolean }[];
  /** Open tasks a "wait for" select may offer (this console's view only). */
  waitCandidates?: { id: string; title: string }[];
  /** The run whose lease is the CURRENT live claim — computed by the data
   * layer; the renderer never guesses liveness from a null outcome. */
  liveRunId?: number | null;
  /** Whether this serve asserted its runner — the live file view exists. */
  peekable?: boolean;
  /** Where the task stands in its own column, from the data layer. */
  position?: { position: number; total: number; column: string | null } | null;
  /** The tracker item this task stands for, when it is external work. */
  mirror?: ExternalMirror | null;
  scope: Scope | null;
  /** Filed race terms (v14) — the approval restates them; one yes covers both. */
  raceTerms?: TournamentTerms | null;
  /** What the approval nonce/digest bind: scope digest, or the joint fingerprint. */
  approvalDigest?: string | null;
  spendDefaults?: { buildPerRunMicrousd: number | null; racePerAgentMicrousd: number | null; raceTotalMicrousd: number | null; raceAgents: number | null } | null;
  runs: Run[];
  decisions: Decision[];
  incidents: Incident[];
  /** Operator steering notes (arc 1), delivery state included. */
  steering?: SteerNote[];
  csrf: string;
  nonce: string;
  problem: string | null;
  /** The attended road (Phase 2E): mint offer, or the open authorization. */
  attended?: {
    canMint: boolean;
    /** The mint picker (P1/C7): claude models to choose from, and the
     * permission posture default (escalated when the active mode says so). */
    mint?: { models: string[]; pinnedModel: string; posture: "acceptEdits" | "bypassPermissions"; quick: boolean };
    open: { id: string; state: string; expiresAt: string; turnsUsed: number; cap: number; spentMicrousd: number; budgetMicrousd: number; running: boolean } | null;
  } | null;
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

  // The live-peek door (A2, finding 10's selected-pane rule): the WATCHING
  // happens on the run page's own polled region — this is only the way in.
  // The link promises a live file view only where one exists; a serve that
  // never asserted its runner offers the running build without the promise
  // (round-4, A1).
  const liveRunId = data.liveRunId ?? null;
  const watchLink =
    liveRunId === null
      ? ""
      : data.peekable === true
        ? `<p class="row"><a href="/r/${liveRunId}">watch what is changing right now — build #${liveRunId}</a></p>`
        : `<p class="row"><a href="/r/${liveRunId}">open the running build — build #${liveRunId}</a></p>`;

  const contest = data.contest ?? null;
  const contestCard =
    contest === null
      ? ""
      : [
          `<div class="card">`,
          `<p><strong>${contestNoun(contest.kind)}</strong> <span class="meta">${contest.agents} agents on this task</span></p>`,
          `<p class="row">${escape((CONTEST_STATE_WORDS[contest.state] ?? "the tournament is in an unexpected state — the records have the detail").replace(/tournament/g, contestNoun(contest.kind)))}</p>`,
          `<p class="row"><a href="/contest/${contest.id}">${
            contest.state === "pick-wait" ? "compare the results and pick one" : `see the ${contestNoun(contest.kind)}`
          }</a></p>`,
          `</div>`,
        ].join("\n");

  // Operator steering (arc 1): notes for the agent, each wearing exactly
  // where it stands — waiting, attached, proven delivered, or superseded.
  const steering = data.steering ?? [];
  const steerState = (one: SteerNote): string =>
    one.authorshipState !== "verified"
      ? "recorded before steering required a credential — never delivered"
      : one.supersededAt !== null
      ? "the task ended before this landed"
      : one.deliveredAt !== null
        ? `reached build #${one.attachedRun}`
        : one.attachedRun !== null
          ? `attached to build #${one.attachedRun} — delivery not yet proven`
          : "waiting for the next attempt";
  const steerRows = steering
    .map(
      one =>
        `<p class="row"><span class="meta">${escape(one.author)} · ${escape(when(one.createdAt))} · ${escape(steerState(one))}</span> ` +
        `${escape(one.note)}</p>`,
    )
    .join("\n");
  const steerForm =
    data.csrf === "" || task.state === "done" || task.state === "cancelled" || (data.contest ?? null) !== null
      ? ""
      : `<form method="post" action="${taskHref(task.id)}/steer" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
        `<input type="text" name="note" placeholder="guidance for the next attempt" aria-label="steering note" style="width:100%;max-width:28rem">` +
        `<button type="submit">steer</button></form>` +
        `<p class="meta">lands when the next attempt starts — a running agent is not interrupted, and a note cannot widen the approved scope</p>`;
  const steeringCard =
    steerRows === "" && steerForm === "" ? "" : `<h2>steering</h2>${steerRows}${steerForm}`;

  const holds =
    data.holds.length === 0
      ? ""
      : `<h2>holds</h2>` +
        data.holds
          .map(
            hold =>
              `<p class="row">${escape(holdOwnerWords(hold.ownerKind))} — ${escape(hold.reason)}` +
              `${hold.until === null ? "" : ` <span class="meta">until ${escape(when(hold.until))}</span>`}</p>`,
          )
          .join("\n") +
        `<p class="meta">only your hold can be lifted here — waits caused by questions, incidents, or retry delays clear on their own</p>`;

  const approval = approvalOf(scope);
  const scopeCard =
    scope === null
      ? `<p class="meta">no scope proposed — nothing builds this until one is approved</p>`
      : [
          `<div class="card">`,
          `<p><strong>goal</strong></p><p class="recap">${escape(scope.goal)}</p>`,
          scope.outOfScope === null ? "" : `<p><strong>not this</strong></p><p class="recap">${escape(scope.outOfScope)}</p>`,
          scope.touches.length === 0 ? "" : `<p><strong>touches</strong> ${scope.touches.map(one => escape(one)).join(", ")}</p>`,
          // The fallback chain, on the card the yes reads (Layer F): the
          // digest binds the WHOLE chain, so every entry — credential
          // included — is said before anyone signs.
          (() => {
            const chain = chainFromJson(scope.proposedChainJson ?? null);
            if (chain === null || chain.length < 2) return "";
            return `<p><strong>if its subscription runs out</strong></p><p class="recap">${chain
              .slice(1)
              .map(
                one =>
                  `falls back to ${escape(one.profile.provider)} (${escape(one.profile.model)}) — ${
                    one.authMode === "api-key" ? "your API key; spend moves to that account" : "its subscription login"
                  }`,
              )
              .join("; ")}</p>`;
          })(),
          `<p class="meta">terms fingerprint <span class="mono">${shortDigest(scope.digest)}</span> — approval binds to this exact wording</p>`,
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

  // The revision batch (M6.8), restated on the SAME screen as the approval
  // it belongs to: the approver sees exactly the comments the brief carries.
  // A brief that cannot be verified is a named problem, never a blank.
  const revisionCard =
    data.revision === null || data.revision === undefined
      ? ""
      : "problem" in data.revision
        ? `<div class="card"><p><strong>revision brief</strong></p><p class="meta">${escape(data.revision.problem)}</p></div>`
        : [
            `<div class="card">`,
            `<p><strong>the review batch</strong> <span class="meta">this task revises ` +
              `<a href="${taskHref(data.revision.sourceTask)}" class="mono">${escape(data.revision.sourceTask)}</a>` +
              ` after review of <a href="/r/${data.revision.sourceRun}">build #${data.revision.sourceRun}</a> — approving the scope approves applying exactly these</span></p>`,
            ...data.revision.comments.map(
              one =>
                `<p class="row"><span class="meta">${escape(one.author)}</span> ` +
                `${one.path === null ? "" : `<span class="mono">${escape(one.path)}${one.line === null ? "" : `:${one.line}`}</span> `}` +
                `${escape(one.note)}</p>`,
            ),
            `</div>`,
          ].join("\n");

  // The approval form restates every field the digest binds — an operator
  // approves what is on this form, not what is elsewhere on the page — and
  // requires the token typed again. The session got you here; only the
  // token agrees.
  const approveForm =
    scope === null || approval.approved
      ? ""
      : data.revision !== null && data.revision !== undefined && "problem" in data.revision
        ? `<div class="card"><p><strong>approval is blocked</strong></p><p class="meta">${escape(data.revision.problem)} — a revision approves only against a brief that verifies</p></div>`
        : [
          `<form method="post" action="${taskHref(task.id)}/approve" class="card approve-form">`,
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          `<input type="hidden" name="nonce" value="${escape(data.nonce)}">`,
          `<input type="hidden" name="digest" value="${escape(data.approvalDigest ?? scope.digest)}">`,
          `<p><strong>approve exactly this:</strong></p>`,
          `<p class="meta">goal</p><p class="recap" style="margin-top:0">${escape(scope.goal)}</p>`,
          `<p class="meta">not this</p><p class="recap" style="margin-top:0">${scope.outOfScope === null ? "<em>no exclusions</em>" : escape(scope.outOfScope)}</p>`,
          `<p class="meta">touches \u00b7 ${scope.touches.length === 0 ? "anything" : scope.touches.map(one => escape(one)).join(", ")}</p>`,
          profileWords(scope),
          scope.budgetMicrousd === null
            ? ""
            : `<p class="meta">each build attempt may spend $${(scope.budgetMicrousd / 1_000_000).toFixed(2)} — the agent is stopped at this figure</p>`,
          // One yes covers BOTH documents (finding 31): the race terms are
          // restated on the same card the password signs, or they are not
          // approved at all.
          data.raceTerms === null || data.raceTerms === undefined
            ? ""
            : data.raceTerms.kind === "comparison"
              ? `<p><strong>and this comparison:</strong></p>` +
                `<p class="recap" style="margin-top:0">${data.raceTerms.n} agents build this independently — ` +
                `${data.raceTerms.agents.map(agent => `${escape(agent.provider)} · ${escape(agent.model)}`).join("  vs  ")}. ` +
                `No dollar caps exist on a comparison — each agent runs until it finishes or its clock ends it; ` +
                `spend lands measured only where the harness reports dollars (` +
                `${data.raceTerms.agents.filter(agent => agent.provider === "claude").length} of ${data.raceTerms.n} lanes here). ` +
                `You will compare the results and pick one.</p>`
              : `<p><strong>and this tournament:</strong></p>` +
                `<p class="recap" style="margin-top:0">${data.raceTerms.n} agents build this independently — ` +
                `${data.raceTerms.agents.map(agent => `${escape(agent.provider)} · ${escape(agent.model)}`).join("  vs  ")}. ` +
                `Each may spend $${(data.raceTerms.perAgentBudgetMicrousd / 1_000_000).toFixed(2)} plus a ` +
                `$${(data.raceTerms.overrunReserveMicrousd / 1_000_000).toFixed(2)} overrun reserve; the whole tournament is capped at ` +
                `$${(data.raceTerms.totalBudgetMicrousd / 1_000_000).toFixed(2)}. You will compare the results and pick one.</p>`,
          `<label>your password, typed again \u2014 a signed-in session alone cannot agree to work<input type="password" name="token" autocomplete="current-password"></label>`,
          `<div class="sticky-actions"><button type="submit">${data.raceTerms === null || data.raceTerms === undefined ? "approve this scope" : data.raceTerms.kind === "comparison" ? "approve scope and comparison — one yes covers both" : "approve scope and tournament — one yes covers both"}</button></div>`,
          `</form>`,
        ].join("\n");

  // The attended road (Phase 2E): beside the approval, never replacing it.
  // The mint button leads to the CONFIRM screen where every term renders
  // and the password signs; an open authorization shows its state, its
  // revoke, and — through the page script — the liveness beat that IS
  // "while you watch".
  const attended = data.attended ?? null;
  const attendedCard =
    attended === null
      ? ""
      : attended.open !== null
        ? [
            `<div class="card" data-attended="${escape(attended.open.id)}">`,
            `<p><strong>attended session</strong> <span class="meta">${escape(attended.open.state)}</span></p>`,
            `<p class="meta">${attended.open.running ? "the agent is running — your open console keeps it live" : "waiting to dispatch to this machine"} · ${attended.open.turnsUsed}/${attended.open.cap} messages · $${(attended.open.spentMicrousd / 1_000_000).toFixed(2)} of $${(attended.open.budgetMicrousd / 1_000_000).toFixed(2)} · everything ends by ${escape(when(attended.open.expiresAt))}</p>`,
            `<p class="meta">this page being open keeps it alive — close it and the session winds down within a minute</p>`,
            `<form method="post" action="${taskHref(task.id)}/attend-revoke" class="inline">`,
            `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
            `<button type="submit">revoke — stop the session</button>`,
            `</form>`,
            `</div>`,
          ].join("\n")
        : attended.canMint
          ? [
              `<form method="post" action="${taskHref(task.id)}/attend-preview" class="card">`,
              `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
              `<p><strong>or run it once while you watch</strong></p>`,
              `<p class="meta">no approval filed: one attempt, on this machine, only while this page is open. You will read every term before ${attended.mint?.quick === true ? "you confirm it" : "your password signs it"}.</p>`,
              attended.mint === undefined || attended.mint.models.length <= 1
                ? ""
                : `<label>model <span class="meta">(watched sessions run claude only)</span><select name="model">` +
                  attended.mint.models
                    .map(model => `<option value="${escape(model)}"${model === attended.mint?.pinnedModel ? " selected" : ""}>${escape(model)}</option>`)
                    .join("") +
                  `</select></label>`,
              attended.mint === undefined
                ? ""
                : `<label>permissions<select name="posture">` +
                  `<option value="acceptEdits"${attended.mint.posture === "acceptEdits" ? " selected" : ""}>asks before edits outside the worktree</option>` +
                  `<option value="bypassPermissions"${attended.mint.posture === "bypassPermissions" ? " selected" : ""}>full permissions — nothing asks</option>` +
                  `</select></label>`,
              `<button type="submit">read the terms</button>`,
              `</form>`,
            ].join("\n")
          : "";

  const scopeForm = [
    `<details${scope === null ? " open" : ""}><summary>${scope === null ? "write the scope" : "edit the scope"}${
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
    (() => {
      const defaults = data.spendDefaults ?? null;
      const budgetPrefill =
        scope?.budgetMicrousd != null
          ? (scope.budgetMicrousd / 1_000_000).toFixed(2)
          : defaults?.buildPerRunMicrousd != null
            ? (defaults.buildPerRunMicrousd / 1_000_000).toFixed(2)
            : "";
      return `<label>dollar cap per build attempt <span class="meta">(optional — the agent is stopped at this figure)</span>` +
        `<input type="number" name="budget-usd" step="0.01" min="0.01" value="${escape(budgetPrefill)}" placeholder="no cap beyond the installation backstop"></label>`;
    })(),
    (() => {
      // The tournament controls (operator request): how many agents compete,
      // on which model, under which dollars. "One agent" is the ordinary
      // path; anything more files race terms beside the scope, and the ONE
      // approval above restates and covers both.
      const defaults = data.spendDefaults ?? null;
      const terms = data.raceTerms ?? null;
      const selectedCount = terms !== null ? terms.n : defaults?.raceAgents ?? 0;
      const selectedModel = terms?.agents[0]?.model ?? "claude-sonnet-5";
      const perPrefill =
        terms !== null
          ? (terms.perAgentBudgetMicrousd / 1_000_000).toFixed(2)
          : defaults?.racePerAgentMicrousd != null
            ? (defaults.racePerAgentMicrousd / 1_000_000).toFixed(2)
            : "";
      const totalPrefill =
        terms !== null
          ? (terms.totalBudgetMicrousd / 1_000_000).toFixed(2)
          : defaults?.raceTotalMicrousd != null
            ? (defaults.raceTotalMicrousd / 1_000_000).toFixed(2)
            : "";
      return [
        `<label>how many agents compete <span class="meta">(a tournament builds the task independently N times — you compare and pick one)</span>` +
          `<select name="race-count">` +
          `<option value=""${selectedCount === 0 ? " selected" : ""}>one agent — no tournament</option>` +
          [2, 3, 4].map(count => `<option value="${count}"${selectedCount === count ? " selected" : ""}>${count} agents</option>`).join("") +
          `</select></label>`,
        `<label>competing model <select name="race-model">` +
          PRICED_BUILD_MODELS.map(model => `<option value="${escape(model)}"${model === selectedModel ? " selected" : ""}>${escape(model)}</option>`).join("") +
          `</select></label>`,
        `<label>each competing agent may spend ($)<input type="number" name="race-per-usd" step="0.01" min="0.01" value="${escape(perPrefill)}"></label>`,
        `<label>the whole tournament may spend ($)<input type="number" name="race-total-usd" step="0.01" min="0.01" value="${escape(totalPrefill)}"></label>`,
        // The comparison lanes (Phase 3 slice B): 2-4 rows, any registered
        // provider, exact model required — no dollar fields exist. Blank
        // rows are unused; filling any row files a comparison INSTEAD of a
        // tournament, and mixing the two refuses in words.
        `<p class="meta" style="margin-top:.75rem">or compare different agents side by side — no dollar caps; each agent's clock is its bound, and spend lands measured only where the harness reports dollars:</p>`,
        ...[1, 2, 3, 4].map(lane =>
          `<div class="row"><label>agent ${lane} <select name="compare-provider-${lane}">` +
            `<option value="">—</option>` +
            PROVIDER_IDS.map(provider => `<option value="${escape(provider)}">${escape(provider)}</option>`).join("") +
            `</select></label>` +
            `<label>its exact model<input type="text" name="compare-model-${lane}" placeholder="e.g. gemini-2.5-pro"></label></div>`,
        ),
      ].join("\n");
    })(),
    `<button type="submit">save scope</button>`,
    `</form></details>`,
  ].join("\n");

  // 41_237 → "41k": token counts read at a glance; exactness lives on the run page.
  const compactCount = (count: number): string =>
    count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);

  // The attempt ledger (M5.5): every attempt with its provider, duration,
  // tokens, and dollars — or the honest word "unmeasured" — so a retry
  // storm reads as the spike it is instead of hiding inside a total.
  const minutesOf = (run: Run): string | null => {
    if (run.finishedAt === null) return null;
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
    return ms >= 0 ? `${Math.max(1, Math.round(ms / 60_000))}m` : null;
  };
  const tokensOf = (run: Run): string | null =>
    run.tokensIn === null && run.tokensOut === null
      ? null
      : `${run.tokensIn === null ? "?" : compactCount(run.tokensIn)}/${run.tokensOut === null ? "?" : compactCount(run.tokensOut)} tok`;
  const runs =
    data.runs.length === 0
      ? ""
      : `<h2>attempts</h2>` +
        data.runs
          .map(run => {
            const bits = [
              run.provider,
              minutesOf(run),
              tokensOf(run),
              run.costUsd !== null ? `$${run.costUsd.toFixed(2)}` : run.tokensIn !== null || run.tokensOut !== null ? "unmeasured $" : null,
              run.parentRun !== null ? `↳ of #${run.parentRun}` : null,
            ].filter((bit): bit is string => bit !== null);
            return (
              `<p class="row">${runDot(run, run.id === liveRunId)}<a href="/r/${run.id}" class="mono">#${run.id}</a> ` +
              runOutcomeBadge(run, run.id === liveRunId) +
              `${run.reason === null ? "" : ` <span class="meta">${escape(reasonWords(run.reason))}</span>`}` +
              ` <span class="meta mono">${escape(bits.join(" · "))}</span>` +
              `<span class="right meta mono">${escape(when(run.startedAt))}</span></p>`
            );
          })
          .join("\n");

  // Spend by provider, from the same rows — dollars only where a provider
  // measured them, and the unmeasured said in words, never summed as $0.
  const spendCard = (() => {
    if (data.runs.length === 0) return "";
    const byProvider = new Map<string, { runs: number; tokensIn: number; tokensOut: number; costUsd: number; measured: number }>();
    for (const run of data.runs) {
      const entry = byProvider.get(run.provider) ?? { runs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, measured: 0 };
      entry.runs += 1;
      entry.tokensIn += run.tokensIn ?? 0;
      entry.tokensOut += run.tokensOut ?? 0;
      if (run.costUsd !== null) {
        entry.costUsd += run.costUsd;
        entry.measured += 1;
      }
      byProvider.set(run.provider, entry);
    }
    const lines = [...byProvider.entries()].map(([provider, spend]) => {
      const dollars =
        spend.measured === spend.runs
          ? `$${spend.costUsd.toFixed(2)}`
          : spend.measured === 0
            ? "dollar cost unmeasured"
            : `$${spend.costUsd.toFixed(2)} across ${spend.measured}/${spend.runs} measured`;
      return (
        `<p class="row"><span class="mono">${escape(provider)}</span> ` +
        `<span class="meta">${spend.runs} attempt(s) · ${compactCount(spend.tokensIn)} in / ${compactCount(spend.tokensOut)} out · ${escape(dollars)}</span></p>`
      );
    });
    return `<h2>spend</h2>` + lines.join("\n");
  })();

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
              ? `<p class="row">${escape(incidentWords(one.kind))} ` +
                `<form method="post" action="/i/${one.id}/resolve" class="inline">` +
                `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
                `<button type="submit">resolve</button></form></p>`
              : `<p class="row meta">${escape(incidentWords(one.kind))} — resolved by ${escape(one.resolvedBy ?? "?")}</p>`,
          )
          .join("\n");

  const stalled =
    task.state === "failed" || data.incidents.some(one => one.resolvedAt === null);

  // The chain: what this task waits for, editable in place. Blockers
  // outside this console's view are named without state or link — the same
  // redaction the board applies. Adding and removing are ordinary
  // re-proved POSTs; the loop refusal comes back as the problem banner.
  const waitsFor = data.waitsFor ?? [];
  const candidates = (data.waitCandidates ?? []).filter(one => !waitsFor.some(existing => existing.id === one.id));
  const waitRows = waitsFor
    .map(
      one =>
        `<p class="row">${
          one.admitted ? `<a href="${taskHref(one.id)}" class="mono">${escape(one.id)}</a>` : `<span class="mono">${escape(one.id)}</span>`
        }${one.state === null ? "" : ` <span class="badge badge-${escape(one.state)}">${escape(one.state)}</span>`}` +
        `<form method="post" action="${taskHref(task.id)}/unblock" class="inline">` +
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
        `<input type="hidden" name="on" value="${escape(one.id)}">` +
        `<button type="submit">stop waiting</button></form></p>`,
    )
    .join("\n");
  const waitAdd =
    data.csrf === "" || candidates.length === 0
      ? ""
      : `<form method="post" action="${taskHref(task.id)}/block" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
        `<select name="on" aria-label="task to wait for">` +
        candidates.map(one => `<option value="${escape(one.id)}">${escape(one.id)} — ${escape(one.title)}</option>`).join("") +
        `</select>` +
        `<button type="submit">wait for this</button>` +
        `<span class="meta"> — this task starts only after it finishes</span></form>`;
  const waitsForCard =
    waitRows === "" && waitAdd === ""
      ? ""
      : `<h2>waits for</h2>${waitRows === "" ? `<p class="meta">nothing — it starts when a worker is free</p>` : waitRows}${waitAdd}`;

  const acts = [
    `<h2>acts</h2>`,
    data.claimed
      ? `<p class="meta">a worker is building this right now — a hold prevents the <em>next</em> start; cancel and requeue wait for the current build to finish</p>`
      : "",
    `<div class="card">`,
    data.plan === null && !approval.approved && !data.claimed && task.state === "queued"
      ? act("plan", "plan first")
      : "",
    data.plan === null && !approval.approved && !data.claimed && task.state === "queued"
      ? `<p class="meta">plan first sends an agent to read the repository, ask you questions, and propose a scope \u2014 nothing builds until you approve it</p>`
      : "",
    // Queue rank is scheduling, never authority: moving up changes when
    // the next free worker looks, and approval is still required.
    task.state === "queued" && !data.claimed && (data.position?.position ?? 1) > 1 ? act("next", "build this next") : "",
    task.state === "queued" && (data.position?.position ?? 2) === 1 && task.priority > 0
      ? act("next", "back to filing order", `<input type="hidden" name="undo" value="1">`)
      : "",
    act("hold", "hold", `<input type="text" name="reason" class="inline" placeholder="why" aria-label="hold reason" style="width:12rem">`),
    data.holds.some(hold => hold.ownerKind === "operator") ? act("unhold", "unhold") : "",
    stalled ? act("requeue", "retry — branch and workspace kept") : "",
    stalled
      ? `<p class="meta">resolves the incidents, clears the failed attempts, and queues the task again; the preserved branch and workspace are NOT erased</p>`
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

  return [
    `<h1>${escape(task.id)} <span class="badge badge-${escape(task.state)}">${escape(task.state)}</span>` +
      `<span class="meta">${data.strikes > 0 ? ` ${data.strikes} failed attempt(s)` : ""}` +
      `${data.repo === null ? "" : ` · ${escape(data.repo)}`}` +
      `${data.filedVia === null || data.filedVia === undefined ? "" : ` · filed via ${escape(data.filedVia)}`}</span></h1>`,
    `<p>${escape(task.title)}</p>`,
    data.position !== null && data.position !== undefined && task.state === "queued"
      ? `<p class="meta">queue position ${data.position.position} of ${data.position.total}${data.position.column === null ? " in the shared queue" : ` in ${escape(data.position.column)}'s queue`} — <a href="/queue">the queue screen</a> reorders</p>`
      : "",
    // External work wears its tracker on the page: the link, the last
    // observed state, and — when the tracker closed it and has been seen
    // open again — the authenticated reopen act. Done + closed is display
    // only: completed here stays completed.
    (() => {
      const mirror = data.mirror ?? null;
      if (mirror === null) return "";
      const link =
        mirror.backend === "github-issues"
          ? `<a href="https://github.com/${escape(mirror.remoteRepo)}/issues/${escape(mirror.remoteId)}">${escape(mirror.remoteRepo)}#${escape(mirror.remoteId)}</a>`
          : `<span class="mono">${escape(mirror.remoteRepo)}#${escape(mirror.remoteId)}</span>`;
      const state =
        task.state === "done" && mirror.remoteState !== "open"
          ? "completed here; closed on the tracker"
          : mirror.remoteState === "open"
            ? mirror.dispatchOk
              ? "open on the tracker"
              : "seen open again — reopen below to resume"
            : mirror.remoteState === "closed"
              ? "closed on the tracker"
              : "gone from the tracker";
      const reopenable =
        mirror.remoteState === "open" && !mirror.dispatchOk && mirror.closeGeneration !== null &&
        mirror.syncGeneration > mirror.closeGeneration && ["cancelled", "failed", "queued"].includes(task.state) && data.csrf !== "";
      return (
        `<div class="card"><p><strong>external work</strong> <span class="meta">${link} · ${escape(state)}</span></p>` +
        (reopenable
          ? `<form method="post" action="${taskHref(task.id)}/reopen" class="row">` +
            `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
            `<input type="password" name="token" placeholder="your password" aria-label="your password" autocomplete="current-password">` +
            `<button type="submit">reopen — the approved scope stands, the next pass may take it</button></form>`
          : "") +
        `</div>`
      );
    })(),
    data.problem === null ? "" : `<div class="problem">${escape(data.problem)}</div>`,
    // The board sent them here saying "needs you" — the page must open by
    // saying WHY and pointing at the act, not read as a fact sheet
    // (operator finding: clicking a needs-you card landed with no context).
    scope === null && data.plan === null && task.state === "queued"
      ? `<div class="card"><p><strong>This task is waiting on you: it has no scope.</strong></p>` +
        `<p class="meta">A scope is the contract an agent builds against — the goal, what is off-limits, which paths it may touch. ` +
        `Nothing builds until one is written and approved. Write it in the open form below, or use <strong>plan first</strong> ` +
        `(under acts) to send an agent to read the repository and draft it for you.</p></div>`
      : "",
    scope !== null && !approval.approved && data.plan !== "requested" && task.state === "queued" && data.decisions.length === 0
      ? `<div class="card"><p><strong>This task is waiting on you: its scope needs your approval.</strong></p>` +
        `<p class="meta">Read the goal and limits below — approving is what lets an agent build this unattended.</p></div>`
      : "",
    // Evidence-first (M5.5): what needs you, then what happened — decisions
    // and incidents above the attempt ledger and spend, the mechanics
    // (scope, holds, acts) after. Only trustworthy facts moved up.
    contestCard,
    watchLink,
    decisions,
    incidents,
    data.publication === null || data.publication === undefined
      ? ""
      : `<p class="row"><span class="meta">published</span> ` +
        `${safePrUrl(data.publication.prUrl) === null ? `<span class="mono">PR #${data.publication.prNumber ?? "?"}</span>` : `<a href="${escape(safePrUrl(data.publication.prUrl) as string)}" class="mono">PR #${data.publication.prNumber ?? "?"}</a>`}` +
        ` <span class="meta">${escape(data.publication.state)}${
          data.publication.remoteState !== null ? ` · ${data.publication.remoteState.toLowerCase()} on GitHub` : ""
        }${
          data.publication.lastCheckState !== null
            ? ` · CI ${data.publication.lastCheckState} at last observation`
            : " · no checks observed"
        }</span></p>`,
    runs,
    spendCard,
    steeringCard,
    "<h2>scope</h2>",
    scopeCard,
    planCard,
    revisionCard,
    approveForm,
    attendedCard,
    scopeForm,
    waitsForCard,
    holds,
    acts,
  ].join("\n");
}

function taskPage(chrome: Chrome, data: Parameters<typeof taskBody>[0]): Screen {
  // The beat (Phase 2E): while an authorization is open, THIS page being
  // visible is what "while you watch" means — a 15-second durable beat
  // carrying the authorization id, paused exactly when the tab hides.
  // The beat moved to the chrome layer (v28): every console page keeps the
  // approver's sessions live; this page no longer carries its own.
  return screen(`task \u00b7 ${data.task.id}`, taskBody(data), { chrome });
}

/**
 * The review queue (M8.19): the field parallelizes generation and lets
 * review pile up; this page compresses it. Read-only by design — ranked
 * advice and deep links, no merge button, because the PR is the terminus
 * and the person merges on GitHub.
 */
/** Only an https github.com pull URL earns an anchor (audit IV-11) — a
 * corrupted row renders as text, never as navigation. */
function safePrUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return null;
    if (!/^\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(parsed.pathname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function reviewPage(
  chrome: Chrome,
  rows: { publication: Publication; taskId: string; failing: boolean }[],
  now: Date,
): Screen {
  const ageOf = (iso: string): string => {
    const hours = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 3_600_000));
    return hours < 1 ? "under an hour" : hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
  };
  const ready = rows.filter(one => !one.failing && one.publication.lastCheckState === "passing");
  const list =
    rows.length === 0
      ? `<p class="meta">No open pull requests from this plane. Built work appears here the moment its PR opens.</p>`
      : rows
          .map((one, index) => {
            const p = one.publication;
            return (
              `<div class="card">` +
              `<p><strong>${index === 0 && !one.failing && p.lastCheckState === "passing" ? "review next — " : ""}PR #${p.prNumber ?? "?"}</strong> ` +
              `<span class="mono">${escape(one.taskId)}</span>` +
              `<span class="meta"> · ${escape(p.githubRepo)} · open ${ageOf(p.updatedAt)}</span></p>` +
              `<p class="meta">${
                one.failing
                  ? "CI failing — observed; a repair can be drafted from the run page"
                  : p.lastCheckState === "passing"
                    ? `CI passing — observed ${escape(when(p.lastCheckAt ?? p.updatedAt))}`
                    : p.lastCheckState === "running"
                      ? "CI still running at the last observation"
                      : "no checks observed (the machine never calls silence green — verify on GitHub)"
              }</p>` +
              `<p class="row">${safePrUrl(p.prUrl) === null ? "" : `<a href="${escape(safePrUrl(p.prUrl) as string)}">review on GitHub →</a>`} ` +
              `<a href="/r/${p.run}">the build</a></p>` +
              `</div>`
            );
          })
          .join("\n");
  return screen("review queue", [
    `<h1>review queue</h1>`,
    `<p class="hint">what waits on your review, oldest reviewable first — this console recommends; merging stays yours, on GitHub. ${ready.length} reviewable, ${rows.length - ready.length} with failing CI.</p>`,
    list,
  ].join("\n"), { chrome });
}

/**
 * Plain words for the machine's own vocabulary — no internal token ever
 * reaches a page. Every map here has a generic fallback: a kind a newer
 * daemon invents degrades to honest generic prose, never to its raw name.
 */
const PHASE_WORDS: Record<string, string> = {
  "agent-running": "agent working",
  "validating-handoff": "checking the handoff",
  "capturing-evidence": "capturing evidence",
  committing: "committing",
};

function phaseWords(phase: string): string {
  return PHASE_WORDS[phase] ?? "the agent is working";
}

const REASON_WORDS: Record<string, string> = {
  agent: "the agent failed",
  "agent-reported": "the agent reported it could not finish",
  "no-op": "nothing changed when something should have",
  "moved-head": "the branch moved underneath the build",
  "moved-branch": "the branch moved underneath the build",
  timeout: "ran out of time",
  git: "a git step failed",
  "malformed-decision": "the agent's question was malformed",
  "malformed-plan": "the plan was malformed",
  fenced: "another worker took the task over",
  unapproved: "the scope was not approved",
  "scope-changed": "the scope changed after approval",
  capability: "a requirement was missing",
  setup: "the workspace preparation step failed",
  "provider-init": "the agent could not start",
  "commit-failure": "the commit failed",
  "protected-branch": "refused to touch a protected branch",
  "wrong-branch": "the checkout was on the wrong branch",
  "not-leased": "the lease was not valid",
  "no-claim": "the lease was not valid",
  "not-yours": "the lease was not valid",
  "no-run-record": "the run record was missing",
  "missing-mailbox": "the resume mailbox could not be read",
  "unreadable-mailbox": "the resume mailbox could not be read",
  "revision-brief": "the revision brief could not be read",
  "repaired-park": "resumed from a parked question",
  stopped: "stopped by the operator",
};

function reasonWords(reason: string): string {
  return REASON_WORDS[reason] ?? "stopped — the build records have the detail";
}

const INCIDENT_WORDS: Record<string, string> = {
  "malformed-decision": "the agent's question was malformed",
  "attempts-exhausted": "failed too many times in a row",
  "commit-failure": "the commit failed",
  "malformed-plan": "the plan was malformed",
  "plan-attempts-exhausted": "planning failed too many times",
};

function incidentWords(kind: string): string {
  return INCIDENT_WORDS[kind] ?? "something went wrong — the run records have the detail";
}

const EVIDENCE_WORDS: Record<string, string> = {
  diff: "the diff",
  status: "the build status",
  "park-payload": "the parked question's record",
  plan: "the plan",
  "terminal-diff": "the final diff",
  "diff-stat": "the change summary",
  "base-tree": "the starting-point file list",
  handoff: "the agent's conclusion",
  "revision-brief": "the revision brief",
};

function evidenceWords(kind: string): string {
  return EVIDENCE_WORDS[kind] ?? "a stored record";
}

/** A shortened fingerprint for display — enough to compare by eye; the
 * full value rides in the title attribute and in every form field. */
function shortDigest(digest: string): string {
  return digest.length <= 12 ? escape(digest) : `<span title="${escape(digest)}">${escape(digest.slice(0, 12))}…</span>`;
}

/** The badge for a run's outcome. A null outcome reads "running" ONLY when
 * the caller proved the run's lease is the task's current live claim — an
 * orphaned run keeps saying what actually became of it. */
function runOutcomeBadge(run: Run, live: boolean): string {
  return live
    ? `<span class="badge badge-running">running</span>`
    : `<span class="badge badge-${escape(run.outcome ?? "cut")}">${escape(run.outcome ?? "never finished")}</span>`;
}


/**
 * The state dot (Phase 2E, A5): one vocabulary everywhere — working
 * (brand pulse), waiting-on-you (warning), done (success), failed
 * (destructive), queued/idle (muted). Derived from EXISTING state fields
 * only; anything ambiguous is muted, never green.
 */
function taskDot(state: TaskState): string {
  const cls =
    state === "running" ? "dot-ok pulse" : state === "done" ? "dot-ok" : state === "failed" ? "dot-bad" : "dot-off";
  return `<span class="dot ${cls}" aria-hidden="true"></span> `;
}

function runDot(run: Run, live: boolean): string {
  const cls =
    run.outcome === null
      ? live
        ? "dot-ok pulse"
        : "dot-off"
      : run.outcome === "built" || run.outcome === "no-change"
        ? "dot-ok"
        : run.outcome === "parked"
          ? "dot-warn"
          : "dot-bad";
  return `<span class="dot ${cls}" aria-hidden="true"></span> `;
}

function runsPage(chrome: Chrome, rows: (Run & { taskId: string })[], liveIds: ReadonlySet<number>, nextCursor: number | null): Screen {
  const list =
    rows.length === 0
      ? `<p class="meta">No runs yet \u2014 a run is one unattended build attempt; they appear once the watch dispatches an approved task.</p>`
      : rows
          .map(
            run =>
              `<p class="row">${runDot(run, liveIds.has(run.id))}<a href="/r/${run.id}" class="mono">#${run.id}</a> ` +
              `<a href="${taskHref(run.taskId)}" class="mono">${escape(run.taskId)}</a> ` +
              runOutcomeBadge(run, liveIds.has(run.id)) +
              `${run.provider === "claude" ? "" : ` <span class="meta mono">${escape(run.provider)}</span>`}` +
              `<span class="right meta mono">${escape(when(run.startedAt))}` +
              `${
                run.costUsd !== null
                  ? ` \u00b7 $${run.costUsd.toFixed(2)}`
                  : run.tokensIn !== null || run.tokensOut !== null
                    ? " \u00b7 tokens only"
                    : run.providerStartedAt !== null
                      ? " \u00b7 unmeasured"
                      : ""
              }</span></p>`,
          )
          .join("\n");
  const older = nextCursor === null ? "" : `<p><a href="/runs?before=${nextCursor}">older →</a></p>`;
  return screen("builds", [`<h1>builds</h1><p class="hint">one build = one attempt by an agent to complete a task, on its own branch</p>`, list, older].join("\n"), { chrome });
}

/** What the run page shows of the terminal diff — verified bytes or a named problem, never silence. */
type TerminalDiffView = {
  patch: { text: string; truncated: boolean; artifactId: number } | { problem: string } | null;
  stat:
    | {
        base: string;
        head: string;
        fileCount: number;
        additions: number;
        deletions: number;
        binaryCount: number;
        filesTruncated: boolean;
        files: { path: string; additions: number | null; deletions: number | null; renamedFrom?: string }[];
      }
    | { problem: string }
    | null;
};

const CAPTURE_EXIT = /\(exit ([0-9]{1,4})\)\s*$/;

/**
 * Assemble the terminal-diff card's facts. Every branch names its state:
 * a failed capture (nonzero exit recorded in the capture string) reads as
 * the failure it is, unverifiable bytes read as their problem, and absence
 * returns null so old runs simply show nothing rather than a broken card.
 */
function terminalDiffView(artifacts: Artifact[], root: string): TerminalDiffView | null {
  const patchArtifact = artifacts.find(one => one.kind === "terminal-diff");
  const statArtifact = artifacts.find(one => one.kind === "diff-stat");
  if (patchArtifact === undefined && statArtifact === undefined) return null;

  const view: TerminalDiffView = { patch: null, stat: null };

  if (patchArtifact !== undefined) {
    const exit = CAPTURE_EXIT.exec(patchArtifact.capture);
    if (exit !== null && exit[1] !== "0") {
      view.patch = { problem: `capture failed — ${patchArtifact.capture}` };
    } else {
      const read = readVerifiedArtifact(root, patchArtifact);
      view.patch = read.ok
        ? { text: read.content.toString("utf8"), truncated: patchArtifact.truncated, artifactId: patchArtifact.id }
        : { problem: `stored but unverifiable — ${read.problem}` };
    }
  }

  if (statArtifact !== undefined) {
    const exit = CAPTURE_EXIT.exec(statArtifact.capture);
    if (exit !== null && exit[1] !== "0") {
      view.stat = { problem: `capture failed — ${statArtifact.capture}` };
    } else {
      const read = readVerifiedArtifact(root, statArtifact);
      if (!read.ok) {
        view.stat = { problem: `stored but unverifiable — ${read.problem}` };
      } else {
        try {
          const parsed = JSON.parse(read.content.toString("utf8")) as Record<string, unknown> | null;
          // Every field this page renders is type-proved (arc 6, finding 7):
          // "an object with a base key" was accepting any shape at all.
          const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
          const wellFormed =
            parsed !== null &&
            typeof parsed === "object" &&
            typeof parsed["base"] === "string" &&
            typeof parsed["head"] === "string" &&
            count(parsed["fileCount"]) &&
            count(parsed["additions"]) &&
            count(parsed["deletions"]) &&
            count(parsed["binaryCount"]) &&
            typeof parsed["filesTruncated"] === "boolean" &&
            Array.isArray(parsed["files"]) &&
            (parsed["files"] as unknown[]).every(
              one =>
                one !== null &&
                typeof one === "object" &&
                typeof (one as Record<string, unknown>)["path"] === "string" &&
                (count((one as Record<string, unknown>)["additions"]) || (one as Record<string, unknown>)["additions"] === null) &&
                (count((one as Record<string, unknown>)["deletions"]) || (one as Record<string, unknown>)["deletions"] === null),
            );
          view.stat = wellFormed
            ? (parsed as unknown as TerminalDiffView["stat"])
            : { problem: "stat is not the shape this page knows" };
        } catch {
          view.stat = { problem: "stat did not parse as JSON" };
        }
      }
    }
  }

  return view;
}

/** Render the terminal diff card: stat and capture health first, the bounded
 * patch beneath a fold. `editor` (arc 6) links file rows to vscode:// on the
 * reviewing device; `commentable` adds a per-file "comment" button the
 * page's prefill script reads — a real button, keyboard-reachable, separate
 * from the link so the two never fight over one click (finding 4). */
function terminalDiffCard(
  view: TerminalDiffView,
  runId: number,
  editor: { worktree: string } | null = null,
  commentable = false,
): string {
  const parts: string[] = ["<h2>what changed</h2>"];

  if (view.stat === null) {
    parts.push(`<p class="meta">no change summary was captured for this build</p>`);
  } else if ("problem" in view.stat) {
    parts.push(`<p class="meta">stat: ${escape(view.stat.problem)}</p>`);
  } else {
    const s = view.stat;
    const zero = s.fileCount === 0;
    parts.push(
      `<p class="row"><span class="mono">${escape(s.base.slice(0, 12))} → ${escape(s.head.slice(0, 12))}</span> — ` +
        (zero
          ? "no changes, verified"
          : `${s.fileCount} file(s) · +${s.additions} −${s.deletions}` +
            (s.binaryCount > 0 ? ` · ${s.binaryCount} binary` : "") +
            (s.filesTruncated ? " · file list cut, counts complete" : "")) +
        `</p>`,
    );
    if (!zero) {
      const fileName = (path: string): string => {
        const href = editor === null ? null : editorFileHref(editor.worktree, path);
        return href === null ? escape(path) : `<a href="${escape(href)}">${escape(path)}</a>`;
      };
      parts.push(
        `<div class="evidence">` +
          s.files
            .slice(0, 40)
            .map(
              file =>
                `<p class="row mono">${fileName(file.path)}${file.renamedFrom === undefined ? "" : ` (was ${escape(file.renamedFrom)})`} ` +
                `<span class="meta">${file.additions === null || file.deletions === null ? "binary" : `+${file.additions} −${file.deletions}`}</span>` +
                `${commentable ? ` <button type="button" class="pick-file" data-path="${escape(file.path)}">comment</button>` : ""}</p>`,
            )
            .join("\n") +
          (s.files.length > 40 ? `<p class="meta">…and ${s.files.length - 40} more file(s)</p>` : "") +
          `</div>`,
      );
      if (editor !== null) {
        parts.push(`<p class="meta">file links open in VS Code on THIS device — if the build's worktree is gone, a link opens nothing</p>`);
      }
    }
  }

  if (view.patch === null) {
    parts.push(`<p class="meta">the final diff was not captured for this build</p>`);
  } else if ("problem" in view.patch) {
    parts.push(`<p class="meta">patch: ${escape(view.patch.problem)}</p>`);
  } else if (view.patch.text.trim() === "") {
    parts.push(`<p class="meta">empty diff — captured successfully, nothing changed</p>`);
  } else {
    parts.push(
      `<details><summary>the patch${view.patch.truncated ? " (TRUNCATED — the raw record says how much was cut)" : ""}</summary>` +
        `<pre class="mono" style="overflow-x:auto">${escape(view.patch.text)}</pre></details>` +
        `<p class="meta"><a href="/r/${runId}/evidence/${view.patch.artifactId}">the raw patch record</a></p>`,
    );
  }

  return parts.join("\n");
}


/** The run's facts as rows — one renderer for the page and its live
 * fragment (A4). Elapsed ticks client-side while the run is open. */
function runFactsRows(run: Run, taskId: string, live: boolean): string {
  const facts: [string, string | null, boolean?][] = [
    ["task", taskId, true],
    ["role", run.role],
    ["outcome", live ? "running" : (run.outcome ?? "never finished")],
    ["phase", live && run.phase !== null ? phaseWords(run.phase) : null],
    ["reason", run.reason === null ? null : reasonWords(run.reason)],
    ["runner", run.runner, true],
    ["branch", run.branch, true],
    ["model", run.model, true],
    ["starting point", run.baseRevision === null ? null : `${run.baseRevision.slice(0, 12)}…`, true],
    ["ended at", run.headRevision === null ? null : `${run.headRevision.slice(0, 12)}…`, true],
    ["started", when(run.startedAt), true],
    ["finished", when(run.finishedAt), true],
    ["provider started", when(run.providerStartedAt), true],
    ["tokens in", run.tokensIn === null ? null : run.tokensIn.toLocaleString(), true],
    ["tokens out", run.tokensOut === null ? null : run.tokensOut.toLocaleString(), true],
    // The unmeasured is said in words (M5.6): tokens without dollars means
    // this provider reports no prices, and a hidden row would read as free.
    [
      "cost",
      run.costUsd !== null
        ? `$${run.costUsd.toFixed(2)}`
        : run.tokensIn !== null || run.tokensOut !== null
          ? "dollar cost unmeasured — this provider reports tokens, not prices"
          : null,
      run.costUsd !== null,
    ],
  ];
  const elapsed =
    live && run.startedAt !== null
      ? `<p class="row"><span class="meta" style="min-width:8.5rem">elapsed</span> <time class="mono" data-elapsed-since="${escape(run.startedAt)}"></time></p>`
      : "";
  return (
    facts
      .filter((fact): fact is [string, string, boolean?] => fact[1] !== null && fact[1] !== "")
      .map(
        ([label, value, mono]) =>
          `<p class="row"><span class="meta" style="min-width:8.5rem">${escape(label)}</span> ` +
          `<span${mono === true ? ` class="mono"` : ""}>${escape(value)}</span></p>`,
      )
      .join("\n") + elapsed
  );
}

function runPage(
  chrome: Chrome,
  run: Run,
  taskId: string,
  artifacts: Artifact[],
  terminal: TerminalDiffView | null = null,
  notes: { id: number; author: string; note: string; createdAt: string }[] = [],
  csrf = "",
  comments: DiffComment[] = [],
  ciRepair: { pr: number } | null = null,
  liveScript?: string,
  peekable = false,
  running = false,
  editor: { worktree: string } | null = null,
  editorToggle: { on: boolean } | null = null,
  noted = false,
  heldTurns: { turns: SessionTurn[]; open: boolean; state: string; cap: number } | null = null,
  continueOffer: { taskId: string } | null = null,
): Screen {
  const rows = runFactsRows(run, taskId, running);
  // The conversation (Phase 2E, v2 S1g): every stdin injection as the
  // ledger records it — author named for operator turns, machine turns
  // say so — and the TURN BOX while the session is held. An unconfirmed
  // turn says honestly that the agent may or may not have seen it.
  const turnWords = (turn: SessionTurn): string =>
    turn.state === "settled"
      ? ""
      : turn.state === "uncertain"
        ? " · unconfirmed — the agent may or may not have seen this; its cost is counted at worst case"
        : turn.state === "cancelled"
          ? " · never reached the agent"
          : " · the agent is working on this";
  const conversation =
    heldTurns === null
      ? ""
      : `<h2>conversation</h2>` +
        (heldTurns.turns.length === 0
          ? `<p class="meta">nothing said yet</p>`
          : heldTurns.turns
              .map(
                turn =>
                  `<p class="row"><span class="meta">${
                    turn.sourceKind === "operator"
                      ? escape(turn.author ?? "operator")
                      : turn.sourceKind === "brief"
                        ? "the brief"
                        : turn.sourceKind === "answer"
                          ? "your answer"
                          : "repair (machine)"
                  } · ${escape(when(turn.recordedAt))}${turnWords(turn)}</span> ${escape(oneLineOf(turn.text, 240))}</p>`,
              )
              .join("\n")) +
        (heldTurns.open && csrf !== ""
          ? `<form method="post" action="/r/${run.id}/turn" class="row">` +
            `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
            `<input type="text" name="text" maxlength="500" placeholder="say something to the agent — it reads this as its next instruction, inside the approved scope" aria-label="turn" style="width:100%;max-width:34rem">` +
            `<button type="submit">send</button></form>` +
            `<p class="meta">${escape(heldTurns.state)} · ${heldTurns.turns.length}/${heldTurns.cap} messages · a waiting question must be answered before free-form messages</p>`
          : heldTurns.open
            ? ""
            : `<p class="meta">the session has ended — the record above is complete</p>`);
  // The live peek region (A2): the poller fills it only on a serve that
  // asserted its runner. Without the assertion the section still appears
  // for a running build and says honestly why it is empty \u2014 a page that
  // silently lacked the region while the task screen promised a live view
  // read as broken (round-4, A1).
  const peek = !running
    ? ""
    : peekable
      ? `<h2>what is changing right now</h2>` +
        `<div id="run-peek"><p class="meta">watching\u2026 the first look lands within 15 seconds</p></div>` +
        `<p class="meta" id="run-peek-stamp"></p>`
      : `<h2>what is changing right now</h2>` +
        `<p class="meta">the live file view is off \u2014 start serve with ${escape("--runner <name>")} naming this machine's worker, and it appears here</p>`;
  // The live transcript (arc 1): the agent's own words, streamed to a file
  // beside the run and polled as raw text. Honesty stated on the surface:
  // this is display only, and the machine running the agent could alter it.
  const transcript = !running
    ? ""
    : !peekable
      ? `<h2>what the agent is saying</h2>` +
        `<p class="meta">the live transcript is off \u2014 start serve with ${escape("--runner <name>")} naming this machine's worker, and it appears here</p>`
      : run.provider !== "claude"
        ? `<h2>what the agent is saying</h2>` +
          `<p class="meta">the live transcript needs the claude harness for now \u2014 this build runs on ${escape(run.provider)}</p>`
        : `<h2>what the agent is saying</h2>` +
          `<p class="meta">display only \u2014 this is not evidence, and the machine running the agent could alter it</p>` +
          `<pre id="live-transcript" class="mono" style="max-height:24rem;overflow:auto;white-space:pre-wrap"></pre>` +
          `<p class="meta" id="live-transcript-state"></p>`;
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
              `<a href="/r/${run.id}/evidence/${artifact.id}">${escape(evidenceWords(artifact.kind))}` +
              `${artifact.truncated ? " (truncated)" : ""} · ${artifact.bytesStored} bytes</a>`,
          )
          .join("\n") +
        "</div>";
  // Review comments on the immutable terminal diff (M6.8): listed, added,
  // and sealed into ONE unapproved revision task. The seal is deliberately
  // plain — the ceremony lives on the revision task's approval screen,
  // which restates the batch; this button only creates the unapproved task.
  const hasTerminalDiff = terminal !== null && terminal.patch !== null && !("problem" in (terminal.patch as object));
  const commentPathWords = (path: string, line: number | null): string => {
    const shown = `${path}${line === null ? "" : `:${line}`}`;
    const href = editor === null ? null : editorFileHref(editor.worktree, path, line);
    return href === null
      ? `<span class="mono">${escape(shown)}</span> `
      : `<a class="mono" href="${escape(href)}">${escape(shown)}</a> `;
  };
  const commentRows = comments
    .map(
      one =>
        `<p class="row"><span class="meta">${escape(one.author)}</span> ` +
        `${one.path === null ? "" : commentPathWords(one.path, one.line)}` +
        `${escape(one.note)}</p>`,
    )
    .join("\n");
  const commentForm =
    csrf === "" || !hasTerminalDiff
      ? ""
      : `<form method="post" action="/r/${run.id}/comment" class="row" id="comment-form">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<input type="text" name="path" placeholder="file (optional)" aria-label="file" class="mono" style="width:14rem">` +
        `<input type="text" name="line" placeholder="line" aria-label="line" inputmode="numeric" style="width:4.5rem">` +
        `<input type="text" name="note" placeholder="what should change here" aria-label="review comment" style="width:100%;max-width:22rem"${noted ? " autofocus" : ""}>` +
        `<button type="submit">comment</button></form>`;
  // The device-side half of the editor-link activation (arc 6, finding 1):
  // rendered only when the server capability exists and this run belongs
  // to this machine's runner — the person at the browser flips it.
  const editorToggleForm =
    editorToggle === null || csrf === ""
      ? ""
      : `<form method="post" action="/session/editor-links" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<input type="hidden" name="on" value="${editorToggle.on ? "0" : "1"}">` +
        `<input type="hidden" name="return" value="/r/${run.id}">` +
        `<button type="submit">${editorToggle.on ? "stop opening files in VS Code from this device" : "open files in VS Code from this device"}</button>` +
        `<span class="meta"> — only useful when this browser runs on the machine that holds the worktrees</span></form>`;
  const reviseForm =
    csrf === "" || comments.length === 0
      ? ""
      : `<form method="post" action="/r/${run.id}/revise">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<button type="submit">turn ${comments.length} comment(s) into a revision task</button>` +
        `<span class="meta"> — creates one unapproved task carrying exactly this batch; you approve its scope before anything builds</span></form>`;
  // CI repair, suggestion-first (M8.18): the observed red episode earns a
  // button; the button drafts ONE unapproved task; a person approves it.
  const repairCard =
    ciRepair === null || csrf === ""
      ? ""
      : `<div class="card"><p><strong>CI is failing on PR #${ciRepair.pr}</strong> <span class="meta">observed by the episode watcher</span></p>` +
        `<form method="post" action="/r/${run.id}/draft-repair">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<button type="submit">draft a repair task</button>` +
        `<span class="meta"> — one unapproved task; you approve its scope before anything builds</span></form></div>`;

  const reviewCard =
    (commentRows === "" && commentForm === "" ? "" : `<h2 id="review">review</h2>${commentRows}${commentForm}${reviseForm}${editorToggleForm}`) + repairCard;

  const noteRows =
    notes.length === 0
      ? ""
      : notes
          .map(
            one =>
              `<p class="row"><span class="meta">${escape(one.author)} · ${escape(when(one.createdAt))}</span> ` +
              `${escape(one.note)}</p>`,
          )
          .join("\n");
  const noteForm =
    csrf === ""
      ? ""
      : `<form method="post" action="/r/${run.id}/note" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<input type="text" name="note" placeholder="a note for whoever reads this run next" aria-label="run note" style="width:100%;max-width:28rem">` +
        `<button type="submit">add note</button></form>`;
  const notesCard = noteRows === "" && noteForm === "" ? "" : `<h2>operator notes</h2>${noteRows}${noteForm}`;

  // Continuation (Phase 2E, A4): a finished attempt offers a watched
  // follow-up — the text you type here enters the SIGNED terms on the
  // confirm screen; nothing runs until your password agrees to exactly it.
  const continueCard =
    continueOffer === null || csrf === ""
      ? ""
      : `<form method="post" action="${taskHref(continueOffer.taskId)}/attend-preview" class="card">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<input type="hidden" name="parent" value="${run.id}">` +
        `<p><strong>continue this attempt while you watch</strong></p>` +
        `<p class="meta">picks up from exactly where this attempt finished — one watched session, your password signs every term including the follow-up below</p>` +
        `<label>what next<textarea name="followup" rows="2" maxlength="2000" placeholder="what should the agent do next, within the same scope"></textarea></label>` +
        `<button type="submit">read the terms</button>` +
        `</form>`;

  return screen(`build #${run.id}`, [
    `<h1>build #${run.id} <span class="meta"><a href="${taskHref(taskId)}">${escape(taskId)}</a></span></h1>`,
    `<div id="run-facts">${rows}</div>`,
    running ? `<p class="meta" id="run-facts-stamp"></p>` : "",
    conversation,
    transcript,
    peek,
    terminal === null ? "" : terminalDiffCard(terminal, run.id, editor, commentForm !== ""),
    reviewCard,
    continueCard,
    handoff,
    evidence,
    notesCard,
  ].join("\n"), {
    chrome,
    // One composed functional script (arc 4 contract): the pollers when the
    // run is live, the comment prefill when the form exists. Prefill alone
    // never fetches — it earns neither connect-src nor the noscript refresh.
    ...(liveScript === undefined && commentForm === ""
      ? {}
      : {
          functional: {
            script: (liveScript ?? "") + (commentForm === "" ? "" : prefillScript()),
            fetches: liveScript !== undefined,
          },
        }),
  });
}

/**
 * Click-to-prefill (arc 6, finding 4): client-side FORM mutation, named as
 * such — a "comment" button beside each changed file copies its path into
 * the comment form and focuses the note field. No fetch, no endpoint, no
 * submit; comments still leave through the same CSRF'd form POST. Reads a
 * data attribute, writes an input value — never markup.
 */
function prefillScript(): string {
  return (
    `(function(){var form=document.getElementById("comment-form");if(!form)return;` +
    `document.addEventListener("click",function(ev){` +
    `var button=ev.target&&ev.target.closest?ev.target.closest("button.pick-file"):null;if(!button)return;` +
    `var path=form.querySelector("[name=path]");var note=form.querySelector("[name=note]");` +
    `if(path)path.value=button.getAttribute("data-path")||"";` +
    `if(note)note.focus();});})();`
  );
}

/** The facts region alone, for the open-run poll (A4). A finished run's
 * fragment says so instead of quietly growing forms (finding 5), and a run
 * that stopped being the task's live claim says so too — both carry the
 * stop marker, so an open tab quits refetching a dead build (round-4
 * finding 15). */
export function runFactsFragment(run: Run, taskId: string, live: boolean): string {
  if (run.outcome !== null) {
    return `<p class="meta" data-region-stop>finished — <a href="/r/${run.id}">reload for the final record</a></p>`;
  }
  if (!live) {
    return `<p class="meta" data-region-stop>this build stopped without finishing — <a href="/r/${run.id}">reload for the record</a></p>`;
  }
  return runFactsRows(run, taskId, live);
}

function capsPage(chrome: Chrome, caps: Capability[] | null, gaps: Gap[], repo: string, now?: Date): Screen {
  if (caps === null) {
    return screen("requirements", [
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
  return screen("requirements", [
    `<h1>requirements</h1>`,
    `<p class="hint">tools and credentials builds need — each is probed on the worker before any build spends money; values never leave your machine</p>`,
    list,
    `<h2>missing, ranked by what filling them frees</h2>`,
    blocked,
    `<p class="meta">read-only here: checks are shell commands you wrote, and a web button that runs shell would need its own security review</p>`,
  ].join("\n"), { chrome });
}

function settingsPage(
  chrome: Chrome,
  existing: TokenSource | null,
  hasEnv: boolean,
  csrf: string,
  problem: string | null,
  messaging: { channel: string | null; implicit: boolean; configured: string[] } | null = null,
  push: { available: boolean; devices: PushSubscription[] } | null = null,
  providerKeys: { provider: string; envName: string; set: boolean; updatedAt: string | null; ambient: boolean; mode: "subscription" | "api-key"; subscriptionCapable: boolean }[] | null = null,
): Screen {
  const keysCard =
    providerKeys === null || csrf === ""
      ? ""
      : [
          "<h2>provider API keys</h2>",
          `<p class="meta">stored as private files on this machine — never shown back, never in the database. A key is handed to its provider's process ONLY when that provider's sign-in is set to "the API key"; in subscription mode the provider uses its own login and the key is kept but not handed over. Every other provider's process is stripped of it either way.</p>`,
          ...providerKeys.map(one =>
            [
              `<form method="post" action="/settings/provider-key" class="card">`,
              `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
              `<input type="hidden" name="provider" value="${escape(one.provider)}">`,
              `<p class="row"><strong>${escape(one.provider)}</strong> <span class="mono meta">${escape(one.envName)}</span> ` +
                `<span class="meta">${
                  one.mode === "subscription" ? "uses its own login" : "uses the API key"
                } \u00b7 ${
                  one.set
                    ? `key stored${one.updatedAt === null ? "" : ` ${escape(one.updatedAt.slice(0, 10))}`}`
                    : one.ambient
                      ? "key in this server's environment"
                      : "no key stored"
                }</span></p>`,
              one.subscriptionCapable
                ? `<label>sign-in<select name="auth-mode">` +
                  `<option value="subscription"${one.mode === "subscription" ? " selected" : ""}>use my ${escape(one.provider)} subscription / login</option>` +
                  `<option value="api-key"${one.mode === "api-key" ? " selected" : ""}>use the API key below</option>` +
                  `</select></label>`
                : "",
              `<label>API key <span class="meta">(kept as your fallback; saving replaces it)</span><input type="password" name="value" autocomplete="off"></label>`,
              `<button type="submit">save</button>`,
              one.set
                ? ` <button type="submit" formaction="/settings/provider-key-clear">remove the stored key</button>`
                : "",
              `</form>`,
            ].join("\n"),
          ),
        ].join("\n");
  const pushCard =
    push === null || csrf === ""
      ? ""
      : [
          "<h2>receives alerts on this device</h2>",
          push.available
            ? [
                `<p class="meta">a buzz when a decision, a tournament pick, or a pull request needs a person — fixed phrases only; task content never rides a notification. Notifications show on this device's lock screen, and tapping one opens whatever console session is signed in here.</p>`,
                `<p class="meta">on iPhone or iPad: add this console to the Home Screen first, then enable from inside it.</p>`,
                `<form method="post" action="/push/subscribe" id="push-form" class="card">`,
                `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
                `<input type="hidden" name="endpoint" value=""><input type="hidden" name="p256dh" value=""><input type="hidden" name="auth" value="">`,
                `<label>your password, typed again <input type="password" name="token" autocomplete="current-password"></label>`,
                `<button type="submit" id="push-enable">get alerts on this device</button>`,
                `<p class="meta" id="push-state"></p>`,
                `</form>`,
              ].join("\n")
            : `<p class="meta">alerts to this device need a secure address — put TLS in front (tailscale serve works) and start serve with --public-url https://…</p>`,
          ...push.devices
            .filter(one => one.retiredAt === null || one.retiredReason === "gone")
            .map(
              one =>
                `<p class="row">${escape(one.uaWords)} · since ${escape(when(one.createdAt))}` +
                `${one.retiredAt !== null ? ` · <span class="meta">expired</span>` : one.consecutiveFailures >= 20 ? ` · <span class="meta">failing</span>` : ""}` +
                (one.retiredAt === null
                  ? ` <form method="post" action="/push/remove" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="id" value="${one.id}"><button type="submit">remove</button></form>`
                  : "") +
                `</p>`,
            ),
        ].join("\n");
  // The enrollment behavior rides the ONE composed script (arc 4, finding
  // 18) — it fills the subscription fields the form posts; it never reads
  // the password field beside them (the named functional exception).
  const pushScript =
    push === null || !push.available || csrf === ""
      ? null
      : `(function(){` +
        `if(!("serviceWorker" in navigator)||!("PushManager" in window))return;` +
        `var link=document.createElement("link");link.rel="manifest";link.href="/manifest.webmanifest";document.head.appendChild(link);` +
        `navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(function(){});` +
        `var form=document.getElementById("push-form");if(!form)return;` +
        `form.addEventListener("submit",function(event){` +
        `if(form.dataset.ready==="1")return;` +
        `event.preventDefault();var state=document.getElementById("push-state");` +
        `Notification.requestPermission().then(function(granted){` +
        `if(granted!=="granted"){if(state)state.textContent="notifications are blocked for this site in the browser settings";return;}` +
        `return fetch("/push/key").then(function(r){return r.json();}).then(function(d){` +
        `return navigator.serviceWorker.ready.then(function(reg){` +
        `return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(d.key.replace(/-/g,"+").replace(/_/g,"/")),function(c){return c.charCodeAt(0);})});});` +
        `}).then(function(sub){var raw=sub.toJSON();` +
        `form.querySelector("[name=endpoint]").value=sub.endpoint;` +
        `form.querySelector("[name=p256dh]").value=(raw.keys.p256dh||"").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");` +
        `form.querySelector("[name=auth]").value=(raw.keys.auth||"").replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");` +
        `form.dataset.ready="1";form.submit();});` +
        `}).catch(function(){if(state)state.textContent="could not subscribe — the browser said no";});});` +
        `})();`;
  const messagingCard =
    messaging === null || messaging.configured.length === 0
      ? ""
      : [
          "<h2>connected messaging</h2>",
          `<p class="meta">alerts are sent through one service — the others stay quiet so you are never notified twice${
            messaging.implicit ? " · <strong>several are connected and none was chosen — pick one</strong>" : ""
          }</p>`,
          `<form method="post" action="/settings/messaging" class="card">`,
          `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
          ...messaging.configured.map(
            channel =>
              `<label style="display:flex;gap:.5rem;align-items:center"><input type="radio" name="primary" value="${escape(channel)}"${
                channel === messaging.channel ? " checked" : ""
              }> ${escape(channel)}${channel === messaging.channel ? ` <span class="meta">— receiving alerts now${messaging.implicit ? " (by default, not by choice)" : ""}</span>` : ""}${
                channel === "telegram" ? ` <span class="meta">· can carry answer buttons and reply-notes</span>` : ` <span class="meta">· messages with console links; acting stays here</span>`
              }</label>`,
          ),
          `<button type="submit">use this service</button>`,
          `</form>`,
          `<p class="meta">Telegram keeps accepting taps and replies even when another service delivers the alerts. Connect services from the terminal: <code>standing-orders webhook set slack|discord &lt;url&gt;</code>.</p>`,
        ].join("\n");
  const current =
    hasEnv
      ? `set in the environment (${escape(TOKEN_ENV)}) — that takes precedence over anything saved here`
      : existing === null
        ? "not set"
        : `saved: ${escape(redactToken(existing.token))} (bot ${escape(existing.botId)})`;
  return screen("settings", [
    "<h1>settings</h1>",
    pushCard,
    keysCard,
    messagingCard,
    "<h2>telegram bot token</h2>",
    `<p class="meta">current: ${current}</p>`,
    problem === null ? "" : `<p class="meta">${escape(problem)}</p>`,
    `<form method="post" action="/settings/telegram-token">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<label>token from @BotFather<input type="password" name="token" autocomplete="off"></label>`,
    `<button type="submit">save</button>`,
    "</form>",
    `<p class="meta">Written owner-only beside the database. Then pair your chat:`,
    ` <code>standing-orders bridge telegram pair --as you --token …</code> and send the code to your bot.</p>`,
  ].join("\n"), { chrome, ...(pushScript === null ? {} : { functional: { script: pushScript, fetches: true } }) });
}

/**
 * The triage flow: everything waiting on a person, one card at a time.
 * Full context ON the card, the act inline, and every act lands back here
 * — clearing the queue is taps, not navigation. Read state travels in the
 * URL (the bounded skip cursor), never in the session: two tabs cannot
 * fight, and a shared link shows the same queue.
 */
function nextPage(chrome: Chrome, data: {
  item:
    | { key: string; kind: "decision"; decision: Decision & { taskId: string } }
    | { key: string; kind: "approval"; approval: { taskId: string; title: string; goal: string; digest: string; proposedAt: string } }
    | { key: string; kind: "requeue"; stalled: { taskId: string; title: string; strikes: number; incidentCount: number } }
    | { key: string; kind: "gap"; gap: Gap }
    | null;
  scope: Scope | null;
  planDocument: string | null;
  csrf: string;
  nonce: string;
  remaining: number;
  skipped: string[];
  now: Date;
}): Screen {
  const { item } = data;
  if (item === null) {
    const held = data.skipped.length;
    return screen("next", [
      `<h1>all clear</h1>`,
      held > 0
        ? `<p>Nothing left except the ${held} you set aside. <a href="/next">Look at those again</a>, or come back later.</p>`
        : `<p>Nothing needs you. The machine is either working or waiting on its own clocks.</p>`,
      `<p class="meta"><a href="/board">the board</a> shows what is moving · <a href="/">the inbox</a> lists everything at once</p>`,
    ].join("\n"), { chrome });
  }

  const skipHref = `/next?skip=${encodeURIComponent([...data.skipped, item.key].join(","))}`;
  const header =
    `<p class="meta">${data.remaining === 1 ? "the last thing waiting on you" : `1 of ${data.remaining} waiting on you`}` +
    ` · <a href="${skipHref}">not now — next \u2192</a></p>`;

  let card = "";
  if (item.kind === "decision") {
    const { decision } = item;
    card =
      `<h1>${escape(decision.taskId)} <span class="meta">asked ${escape(when(decision.createdAt))}</span></h1>` +
      `<div class="recap">${escape(decision.recap)}</div>` +
      `<div class="question">${escape(decision.question)}</div>` +
      decisionOptionForms(decision, data.csrf, "next");
  } else if (item.kind === "approval") {
    const scope = data.scope;
    card =
      `<h1>${escape(item.approval.taskId)}</h1>` +
      `<p>${escape(item.approval.title)}</p>` +
      (data.planDocument === null
        ? ""
        : `<div class="card"><p><strong>the plan</strong> <span class="meta">drafted by a planning session</span></p><pre class="recap plan-doc">${escape(data.planDocument)}</pre></div>`) +
      `<form method="post" action="${taskHref(item.approval.taskId)}/approve" class="card approve-form">` +
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
      `<input type="hidden" name="nonce" value="${escape(data.nonce)}">` +
      `<input type="hidden" name="digest" value="${escape(item.approval.digest)}">` +
      `<input type="hidden" name="return" value="next">` +
      `<p><strong>approve exactly this:</strong></p>` +
      (scope === null ? "" : profileWords(scope)) +
      `<p class="meta">goal</p><p class="recap" style="margin-top:0">${escape(scope?.goal ?? item.approval.goal)}</p>` +
      `<p class="meta">not this</p><p class="recap" style="margin-top:0">${scope?.outOfScope == null ? "<em>no exclusions</em>" : escape(scope.outOfScope)}</p>` +
      `<p class="meta">touches · ${scope === null || scope.touches.length === 0 ? "anything" : scope.touches.map(one => escape(one)).join(", ")}</p>` +
      `<label>your password, typed again — a signed-in session alone cannot agree to work<input type="password" name="token" autocomplete="current-password"></label>` +
      `<div class="sticky-actions"><button type="submit">approve this scope</button></div>` +
      `</form>` +
      `<p class="meta"><a href="${taskHref(item.approval.taskId)}">open the full task</a> to edit the scope first</p>`;
  } else if (item.kind === "requeue") {
    card =
      `<h1>${escape(item.stalled.taskId)}</h1>` +
      `<p>${escape(item.stalled.title)}</p>` +
      `<p class="meta">stopped — ${item.stalled.incidentCount} incident(s)${item.stalled.strikes > 0 ? ` after ${item.stalled.strikes} attempt(s)` : ""}</p>` +
      `<form method="post" action="${taskHref(item.stalled.taskId)}/requeue" class="card">` +
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
      `<input type="hidden" name="return" value="next">` +
      `<p class="meta">requeue resolves the incidents, clears the failed attempts, and puts it back in line</p>` +
      `<button type="submit">retry this work</button>` +
      `</form>` +
      `<p class="meta"><a href="${taskHref(item.stalled.taskId)}">open the full task</a> to read the runs first</p>`;
  } else {
    const { gap } = item;
    card =
      `<h1>supply ${escape(gap.key)}</h1>` +
      `<p class="meta">${escape(gap.state)}</p>` +
      `<p>Filling this starts ${gap.unblocks.length} task(s): ${gap.unblocks.map(one => `<span class="mono">${escape(one)}</span>`).join(", ")}</p>` +
      `<div class="card"><p class="meta">prove it filled from the terminal:</p><pre class="recap">${escape(gap.verify)}</pre></div>`;
  }

  return screen("next", [header, card].join("\n"), { chrome });
}

/**
 * A decision's answer forms — one source of truth for the decision screen
 * and the triage flow. The consequence reads BEFORE the button that buys
 * it; irreversible options arm behind one deliberate tap AND the server
 * independently requires the confirm field. `returnTo` is allow-listed by
 * the answer handler, never an arbitrary URL.
 */
function decisionOptionForms(decision: Decision, csrf: string, returnTo: "next" | null): string {
  return decision.options
    .map(option => {
      const recommended = option.id === decision.recommendation;
      const inner = [
        `<form class="option${recommended ? " recommended" : ""}" method="post" action="/d/${decision.id}/answer">`,
        `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
        `<input type="hidden" name="choice" value="${escape(option.id)}">`,
        ...(returnTo === null ? [] : [`<input type="hidden" name="return" value="${returnTo}">`]),
        ...(option.reversible ? [] : [`<input type="hidden" name="confirm" value="yes">`]),
        recommended ? `<p class="meta" style="margin:0 0 .375rem"><span class="badge">recommended</span></p>` : "",
        `<p class="consequence">${escape(option.consequence)}</p>`,
        `<button type="submit">${escape(option.label)}${option.reversible ? "" : ` <span class="badge badge-overdue">irreversible</span>`}</button>`,
        `<input type="text" name="note" placeholder="optional note — travels with this answer" aria-label="optional note">`,
        `</form>`,
      ].join("\n");
      return option.reversible
        ? inner
        : `<details class="arm-danger"><summary>${escape(option.label)} — irreversible, tap to arm</summary>${inner}</details>`;
    })
    .join("\n");
}

function decisionPage(
  chrome: Chrome,
  decision: Decision,
  taskId: string,
  artifacts: Artifact[],
  who: Who,
  now: Date,
): Screen {
  const csrf = who.via === "cookie" ? who.session.csrf : "";
  const options = decisionOptionForms(decision, csrf, null);

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
              `<a href="/d/${decision.id}/evidence/${artifact.id}">${escape(evidenceWords(artifact.kind))}` +
              `${artifact.truncated ? " (truncated)" : ""} · ${artifact.bytesStored} bytes</a>`,
          )
          .join("\n") +
        "</div>";

  return screen(`decide \u00b7 ${taskId}`, [
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

/** Attended liveness in words for the task card — reads the durable clock. */
function attendedWatchWords(lastBeatAt: string | null, now: Date, absoluteExpiry: string): string {
  const state = attendedLivenessState(
    lastBeatAt === null ? null : Date.parse(lastBeatAt),
    now.getTime(),
    Date.parse(absoluteExpiry),
  );
  return state === "live" ? "watching" : state === "grace" ? "watching (a beat behind)" : state === "expired" ? "expired" : "not watching — reopen this page to resume";
}

/** One display line, bounded — turn text is data, never layout. */
function oneLineOf(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
}
