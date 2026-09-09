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

import { listCoordinators } from "./coordinator.js";
import { diagnoseTaskDispatch, withDispatchDiagnoses, type DispatchDiagnosis } from "./dispatch.js";
import { PLEX_SANS_400, PLEX_SANS_500, PLEX_SANS_600, PLEX_MONO_400, PLEX_MONO_500, PLEX_MONO_600 } from "./fonts.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, openSync, opendirSync, readFileSync, readSync, readdirSync, realpathSync, rmSync as rmFileSync, writeFileSync as writeFsFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { TEMPLATES, templateByName } from "./templates.js";
import { EVIDENCE_CAPS, readVerifiedArtifact, readVerifiedReport, readVerifiedProofForRun, storeEvidence, writeEvidenceFile, scanForSecrets, type ReportView } from "./evidence.js";
import { verdictWords as proofVerdictWords, dispatchStatusToken, passFraction, type ProofVerdict, type CriterionMatrixRow, type CriterionEvidenceRef } from "./proof.js";
import { PRICED_BUILD_MODELS } from "./pricing.js";
import {
  buildDataDocument,
  composeRequest,
  credentialKeyOf,
  isDirectChatProvider,
  isSubscriptionChatProvider,
  parseAssistantEnvelope,
  performChatRequest,
  priceOf,
  priceForConfig,
  worstCaseForPrice,
  settleForPrice,
  subscriptionCredentialKey,
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
  acceptanceLinesToInput,
  acceptanceToLines,
  acceptanceWords,
  parseAcceptanceCriteria,
  type AcceptanceCriterion,
  type AttendedTerms,
  type Scope,
  type UnattendedPermissionMode,
} from "./scope.js";
import { isQualityMode, qualityModeTitle, type QualityMode } from "./quality.js";
import { hasForbiddenControls, validateNote } from "./decision.js";
import { observeWorktree, parseBaseTreeSnapshot, aggregateNewNames, PEEK_LIMITS } from "./peek.js";
import { readLiveWindow } from "./live.js";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { loadOrCreateVapidKeys, validatePushEndpoint } from "./push.js";
import { parseGithubRepo, previewGithubRepo, cloneGithubRepo, listGithubRepos, isLargeRepo, type ListOutcome } from "./onboard.js";
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
import { tally, spendLine, runCostWords } from "./summary.js";
import { classify, holdOwnerWords, attentionCardForUnverifiedDone } from "./board.js";
import type { BoardCard } from "./board.js";
import { approveRoutine, describeSchedule, fireRoutine, parseSchedule, routineDigestOf, validateRoutineTerms, ROUTINE_NAME, type RoutineTerms } from "./routine.js";
import { effectivePrimary, isMessagingChannel, savePrimary } from "./webhooks.js";
import { resolvePhaseAgent, INSTALLATION_SCOPE } from "./agentconfig.js";
import { isProviderId, reportsCost, PROVIDER_IDS, validModelId } from "./provider.js";
import { authenticateAccount, hashPassword, modeFilingCoverage } from "./scope.js";
import { modeTermsFromJson, modeWords, presetTerms, modeTermsJson, modeDigestOf, MODE_MAX_DAYS, type ModeName, type ModeTerms } from "./modes.js";
import { PROVIDER_KEY_ENV, SUBSCRIPTION_CAPABLE, clearProviderKey, keyStatus, plausibleKey, readAuthMode, saveProviderKey, setAuthMode, verifyProviderKey, verdictWords, type AuthMode } from "./keys.js";
import type { Routine, PublicationGrant, ChatTurn, ChatProviderId, Contest, TournamentTerms, SteerNote, PushSubscription, RepairChainRow } from "./store.js";
import type { ChatConfig, ChatSnapshot, DirectChatProviderId, SubscriptionChatProviderId } from "./store.js";
import { loadBotToken, redactToken, saveBotToken, TOKEN_ENV, type TokenSource } from "./telegram.js";
import type { CoordinatorProposal, MateMessage, MateProposal, MateSession, MateTurn } from "./store.js";
import { verifyApproverByPassword, verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { runMateTurn, MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";
import { confirmCoordinatorProposal, confirmMateProposal, dismissCoordinatorProposal, dismissMateProposal } from "./mate-doors.js";

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
   * The first-account road (setup review): while NO approver exists, the
   * login page offers "create the first account", gated by this code —
   * printed once by the process that started the server, never stored.
   * Five wrong codes close the road until the server restarts. The moment
   * an approver exists, the page is the ordinary sign-in.
   */
  setupCode?: string;
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
  /** Repositories the co-located `up` process has proved and is watching.
   * Kept as a callback so projects added after startup appear immediately
   * without turning the durable registry itself into an authorization source. */
  currentRepos?: () => readonly string[];
  /** Injected by tests: the fetch direct-API chat turns use, and where chat
   * keys are read from (defaults to process.env). */
  chatFetcher?: typeof fetch;
  /** Subscription-backed mate transport; injected in tests so no real
   * Codex or Claude membership turn is consumed. */
  subscriptionChatRunner?: SubscriptionMateRunner;
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
  ghList?: typeof listGithubRepos;
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
/** The typefaces by route: exact names only, served pre-auth like the icons. */
const FONT_FILES: Record<string, string> = {
  "/fonts/plex-sans-400.woff2": PLEX_SANS_400,
  "/fonts/plex-sans-500.woff2": PLEX_SANS_500,
  "/fonts/plex-sans-600.woff2": PLEX_SANS_600,
  "/fonts/plex-mono-400.woff2": PLEX_MONO_400,
  "/fonts/plex-mono-500.woff2": PLEX_MONO_500,
  "/fonts/plex-mono-600.woff2": PLEX_MONO_600,
};
const PWA_MANIFEST = JSON.stringify({
  name: "standing orders",
  short_name: "standing orders",
  id: "/",
  scope: "/",
  start_url: "/",
  display: "standalone",
  background_color: "#0b0c0e",
  theme_color: "#0b0c0e",
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
  /** Wrong setup codes left before the first-account road closes. */
  let setupAttemptsLeft = 5;
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
  /** The explicit, currently proved project list. The callback is supplied
   * only by `up`, after it has independently checked git-ness and the root
   * ceiling; this server still filters every row through its own ceiling. */
  const managedRepos = (): string[] => {
    const seen = new Set<string>();
    const repos: string[] = [];
    for (const path of [...ceiling.repos, ...(options.currentRepos?.() ?? [])]) {
      const canonical = canonicalProject(path) ?? path;
      if (seen.has(canonical) || !visible(canonical)) continue;
      seen.add(canonical);
      repos.push(canonical);
    }
    return repos;
  };
  /** The enumerable admission list for roll-up SQL: repos-only ceilings
   * enumerate themselves; root ceilings enumerate the STORED repos that
   * pass the ceiling (Codex roll-up review, finding 11); unscoped = null. */
  const admissionList = (): string[] | null =>
    unscopedMode
      ? null
      : [...new Set([...managedRepos(), ...(ceiling.roots.length === 0 ? [] : store.knownRepos().filter(visible))])];
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
      if (url.pathname === "/favicon.ico") return asset("image/png", Buffer.from(PWA_ICON_APPLE, "base64"));
      if (url.pathname === "/icon.svg") return asset("image/svg+xml", PWA_ICON_SVG);
      if (url.pathname === "/icon-192.png") return asset("image/png", Buffer.from(PWA_ICON_192, "base64"));
      if (url.pathname === "/icon-512.png") return asset("image/png", Buffer.from(PWA_ICON_512, "base64"));
      if (url.pathname === "/apple-touch-icon.png") return asset("image/png", Buffer.from(PWA_ICON_APPLE, "base64"));
      if (url.pathname === "/sw.js") return asset("text/javascript; charset=utf-8", PWA_WORKER, "default-src 'none'");
      // The typefaces: exact-allowlisted like the icons — nothing dynamic
      // rides the path, unknown names fall through to the router's refusal.
      const font = FONT_FILES[url.pathname];
      if (font !== undefined) return asset("font/woff2", Buffer.from(font, "base64"));
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
      if (options.setupCode !== undefined && store.listApprovers().length === 0) {
        return page(response, 200, signupPage(null, setupAttemptsLeft));
      }
      return page(response, 200, loginPage(null));
    }
    if (url.pathname === "/signup" && method === "POST") {
      // Only while the table is empty, only with the printed code, only
      // five tries: the bootstrap door underneath is atomic, so two first
      // visitors serialize to one owner.
      if (options.setupCode === undefined || store.listApprovers().length > 0) {
        return page(response, 409, loginPage("an account already exists — sign in"));
      }
      if (setupAttemptsLeft <= 0) {
        return page(response, 403, signupPage("too many wrong codes — restart the server to get a fresh code", 0));
      }
      const body = await form(request);
      const code = (body.get("code") ?? "").trim();
      const name = (body.get("name") ?? "").trim();
      const password = body.get("password") ?? "";
      const given = Buffer.from(code.padEnd(64, " "), "utf8");
      const wanted = Buffer.from(options.setupCode.padEnd(64, " "), "utf8");
      if (code === "" || !timingSafeEqual(given, wanted)) {
        setupAttemptsLeft -= 1;
        return page(response, 403, signupPage("that is not the setup code the server printed", setupAttemptsLeft));
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        return page(response, 400, signupPage("a username is letters, digits, dots, dashes — up to 64", setupAttemptsLeft));
      }
      if (password.length < 8) {
        return page(response, 400, signupPage("a password is at least 8 characters", setupAttemptsLeft));
      }
      const made = store.bootstrapApproverIfNone(name, hashPassword(password), clock());
      if (!made.ok) return page(response, 409, loginPage("an account already exists — sign in"));
      const authenticated = authenticateAccount(store, name, password);
      if (authenticated === null || !authenticated.ok) return page(response, 500, loginPage("the account was created but could not sign in — try again"));
      const id = randomBytes(32).toString("hex");
      sessions.set(id, {
        name,
        csrf: randomBytes(32).toString("hex"),
        role: authenticated.role,
        generation: authenticated.generation,
        createdAt: Date.now(),
        sawBoardAt: null,
        lastSeen: Date.now(),
        project: defaultProject,
        projectRevision: 1,
      });
      response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${cookieSecure}`);
      return redirect(response, "/");
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

    const requestFacts = {
      csrf: who.via === "cookie" ? who.session.csrf : "",
      returnTo: safeReturn(url.pathname + url.search),
    };
    if (method === "GET") return void (await requestContext.run(requestFacts, () => handleGet(url, who, request, response)));
    if (method === "POST") return requestContext.run(requestFacts, () => handlePost(url, who, request, response));
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
      url.pathname !== "/projects/browse" && url.pathname !== "/projects/github" && url.pathname !== "/workbench" &&
      url.pathname !== "/fleet" &&
      url.pathname !== "/chat" &&
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

    if (url.pathname === "/projects/github") {
      // The signed-in gh account's repositories, OFFERED instead of typed
      // (operator request): read-only listing through the same hardened gh
      // runner onboarding uses, every identity re-parsed strictly, and each
      // row carries exactly ONE honest action — open (already a project
      // here), add (a clone under a root this server may serve, never yet
      // opened), or the EXISTING preview-and-password clone ceremony.
      // Approver only: a viewer has no business enumerating private
      // repository names.
      if (who.via !== "cookie") return refuse(response, who, 403, "listing repositories feeds a browser session's act");
      if (who.role !== "approver") return refuse(response, who, 403, "your login can watch — adding projects is an approver's act");
      if (store.isDemo()) return refuse(response, who, 403, "the sandbox never talks to GitHub");
      const listed = await (options.ghList ?? listGithubRepos)();
      // What this machine already has, matched by the clone's own recorded
      // origin — registered projects first, then the immediate children of
      // the configured roots. Identities are compared case-insensitively
      // (GitHub's rule); the FIRST match wins.
      const localByIdentity = new Map<string, string>();
      const registered = new Set<string>();
      for (const project of store.listProjects()) {
        if (!visible(project.path)) continue;
        registered.add(project.path);
        const identity = githubIdentityOf(originUrlOf(project.path) ?? "");
        if (identity !== null && !localByIdentity.has(identity.toLowerCase())) {
          localByIdentity.set(identity.toLowerCase(), project.path);
        }
      }
      // Roots are walked ONLY when there are listed repos to match against
      // (finding 1), through an iterator that stops at 400 entries — a
      // directory with a million children costs 400 stats, not a scan.
      if (listed.ok && listed.repos.length > 0) {
        for (const root of ceiling.roots) {
          const children: string[] = [];
          try {
            const dir = opendirSync(root);
            try {
              for (let seen = 0; seen < 400; seen++) {
                const entry = dir.readSync();
                if (entry === null) break;
                if (entry.isDirectory()) children.push(join(root, entry.name));
              }
            } finally {
              dir.closeSync();
            }
          } catch {
            // an unreadable root offers nothing
          }
          for (const child of children) {
            if (!existsSync(join(child, ".git"))) continue;
            const identity = githubIdentityOf(originUrlOf(child) ?? "");
            if (identity !== null && !localByIdentity.has(identity.toLowerCase())) {
              localByIdentity.set(identity.toLowerCase(), child);
            }
          }
        }
      }
      return sendScreen(
        response,
        200,
        githubReposPage(chromeFor(who.session.project, "projects"), {
          listed,
          local: localByIdentity,
          registered,
          csrf: who.session.csrf,
          cloneReady: ceiling.roots.length > 0,
          openProject: who.session.project ?? null,
        }),
      );
    }

    if (url.pathname === "/projects") {
      return void projectsScreen(response, who, url.searchParams.get("said"), 200);
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
          interactive: project !== null,
          decisions: store.listDecisionsScoped(project).filter(one => visible(one.repo)).slice(0, 10),
          approvals: store.scopesAwaitingApproval(project, 10, admission).filter(one => visible(one.repo)),
          requeueables: store.listRequeueablesScoped(project, now, 10, admission).filter(one => visible(one.repo)),
          needsVerification: store
            .listCompletedWorkScoped(project, 10, admission)
            .filter(one => visible(one.repo) && (one.proofVerdict === "short" || one.proofVerdict === "refuted") && !one.proofAccepted)
            .map(one => ({
              taskId: one.taskId,
              title: one.title,
              verdict: one.proofVerdict as "short" | "refuted",
              repo: one.repo,
              matrix: one.proofMatrix,
              repairChain: one.runId === null ? null : store.repairChainFor(one.runId),
            })),
          cancelledBlockers: cancelled,
          gaps: project === null ? [] : computeGaps(store, project, now).filter(gap => gap.unblocks.length > 0).slice(0, 10),
          wizard: wizardSteps(now),
          worker: (() => {
            // The one fact the inbox must never hide (install review): with
            // no worker answering, nothing here will ever build, and every
            // approval below is a promise nobody is there to keep.
            const runners = store.listRunners().filter(one => one.retiredAt === null);
            const answering = runners.filter(one => runnerAlive(one, now));
            const lastHeard = runners.map(one => one.heartbeatAt).sort().at(-1) ?? null;
            return { answering: answering.length, registered: runners.length, lastHeard };
          })(),
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
          deliverable: ref?.deliverable ?? "branch",
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
      const waiting = cards.filter(card => card.lane === "waiting");
      const queued = cards.filter(card => card.lane === "queued");
      const done = snapshot.done
        .filter(one => one.repo === null || visible(one.repo))
        .slice(0, 5)
        .map(one => ({ taskId: one.taskId, title: one.title, outcome: one.outcome, repo: one.repo }));
      const selected = url.searchParams.get("t");
      const rail = workbenchRail({ attention, building, waiting, queued, done, selected, saturated: snapshot.saturated });
      if (url.searchParams.get("fragment") === "rail") {
        // The rail alone: same auth, same ceiling, no shell, no scripts.
        return respond(response, 200, "text/html; charset=utf-8", rail);
      }
      // The portfolio overview (arc slice 1a). All-scope hygiene throughout:
      // admission binds inside every bounded SQL read, and every unlimited
      // feed's rows pass visible() BEFORE they render or tally — a hidden
      // project must not leak into a row, a count, or a dollar.
      const sinceIso = new Date(now.getTime() - 24 * 3_600_000).toISOString();
      const decisions = store
        .listDecisionsScoped(null)
        .filter(one => visible(one.repo ?? null))
        .slice(0, 10);
      const approvals = store.scopesAwaitingApproval(null, 10, admission).filter(one => visible(one.repo ?? null));
      const requeueables = store.listRequeueablesScoped(null, now, 10, admission).filter(one => visible(one.repo ?? null));
      const cancelledBlockers = store
        .listCancelledBlockersScoped(null, 10, admission)
        .filter(one => visible(one.repo ?? null) && visible(one.blockerRepo ?? null));
      const runs24 = store.runsSinceScoped(sinceIso, null).filter(run => visible(taskRepoOf(run.taskRef)));
      const live = store.liveClaims(null, now).filter(one => visible(one.repo));
      const ledger = store
        .portfolioLedgerScoped(null, sinceIso, 30, admission)
        .filter(row => visible(row.repo));
      // Gaps stay project-relative (the roll-up inbox's rule): computed for
      // the OPEN project only — there is no scope-safe road to another
      // project's /caps.
      const gaps = project === null ? [] : computeGaps(store, project, now).filter(gap => gap.unblocks.length > 0).slice(0, 10);
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      let detail = portfolioOverview({
        attention, building, waiting, queued, done, saturated: snapshot.saturated,
        decisions, approvals, requeueables, cancelledBlockers, gaps,
        gapsProject: project, runs24, live, ledger, csrf, now,
      }) +
        `<div class="workbench-mobile-rail">${rail}</div>`;
      if (selected !== null) {
        const view = taskViewData(selected, who, null);
        detail = view === null
          ? `<p class="workbench-mobile-back"><a href="/workbench">← all work</a></p><div class="card"><p class="meta">no such task — it may have been outside this console's view</p></div>`
          : `<p class="workbench-mobile-back"><a href="/workbench">← all work</a></p>${taskBody({ ...view, degraded: "pane" })}`;
      }
      return sendScreen(
        response,
        200,
        screen("portfolio", detail, {
          chrome: chromeFor(
            project,
            "workbench",
            `<div id="wb-rail">${rail}</div><p class="meta" id="wb-rail-stamp"></p>`,
            "all",
          ),
          functional: {
            // The decision enhancement rides ONLY the overview: a selected
            // task's pane may carry a password ceremony, and sensitive
            // pages gain no new scripts (commit-1 review, finding 1).
            script:
              regionScript("wb-rail", "rail", building.length > 0 ? 10 : 30) +
              (selected === null && decisions.length > 0 ? decisionAnswerScript() : ""),
            fetches: true,
          },
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
      // A completed task whose proof is short or refuted and not yet
      // accepted (Priority 2) reads "needs verification", not done — the
      // board's once-and-only-once rule holds because this split is the
      // ONE place a done row becomes either lane; the done-lane render
      // below never sees the rows filtered out here.
      const unverifiedDone = done.filter(
        row => (row.proofVerdict === "short" || row.proofVerdict === "refuted") && !row.proofAccepted,
      );
      const verifiedDone = done.filter(row => !unverifiedDone.includes(row));
      const unverifiedCards = unverifiedDone.map(row => {
        // v40: the SAME chip gains one more word when a repair chain
        // exists for this row's own run — never a second card.
        const chain = row.runId === null ? null : store.repairChainFor(row.runId);
        const repairChain =
          chain === null
            ? null
            : {
                attempt: chain.attempt,
                outcome: chain.outcome,
                approved: chain.draftTask !== null && (store.getScope(chain.draftTask)?.approvedAt ?? null) !== null,
              };
        return attentionCardForUnverifiedDone({
          taskId: row.taskId,
          title: row.title,
          repo: row.repo,
          completedAt: row.completedAt,
          proofVerdict: row.proofVerdict as "short" | "refuted",
          proofMatrix: row.proofMatrix,
          repairChain,
        });
      });
      // Instances belong to their track row, not the main lanes — the board
      // is for one-off work; tracks are the heartbeat. The one exception is
      // attention: anything needing a person surfaces, wearing its routine.
      const laneCards = [...cards.filter(card => card.routineName === null || card.lane === "attention"), ...unverifiedCards];
      const tracks = store
        .routineTracks(all ? null : project, now, admission)
        .filter(track => visible(track.routine.repo));
      const body = boardBody(
        { cards: laneCards, tracks, done: verifiedDone, saturated: snapshot.saturated, now, all, project, delta },
        pr => store.ciFailureObserved(pr),
      );
      if (url.searchParams.get("fragment") === "1") {
        // The live region alone — the in-page swapper's diet. Same auth,
        // same ceiling, no shell, no scripts (finding 2).
        return respond(response, 200, "text/html; charset=utf-8", body);
      }
      if (url.searchParams.get("view") === "order") {
        // The board's ORDER view (operator request): the same screen, flipped
        // to dispatch order with the queue's drag handles. Reordering and
        // reserving are scheduling, not authority, so this is the one view
        // where a drag does anything; the state view stays a view.
        const csrf = who.via === "cookie" ? who.session.csrf : "";
        const revision = who.via === "cookie" ? who.session.projectRevision : 0;
        const region = queueRegionFor(project, csrf, revision, now);
        return sendScreen(
          response,
          200,
          screen("board", [
            `<h1>board</h1>`,
            `<p class="meta board-view"><a href="/board">state</a> \u00b7 <strong>order</strong> <span class="meta">\u2014 drag to reorder, or onto a worker to reserve; the state view is where cards move on their own</span></p>`,
            `<div id="queue-region">${region}</div>`,
            `<p class="meta" id="queue-region-stamp"></p>`,
          ].join("\n"), { chrome: chromeFor(project, "board"), functional: { script: queueScript(), fetches: true } }),
        );
      }
      const regionBody = `<div id="board-region">${body}</div><p class="meta" id="board-region-stamp"></p>`;
      return sendScreen(
        response,
        200,
        screen("board", regionBody, {
          chrome: chromeFor(project, "board", undefined, all ? "board-all" : undefined),
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
      return sendScreen(response, 200, reviewPage(chromeFor(project, "runs"), rows, now));
    }

    if (url.pathname === "/activity") {
      const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
      return sendScreen(
        response,
        200,
        homePage(chromeFor(project, "runs"), {
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
        donePage(chromeFor(project, "runs"), store.listCompletedWorkScoped(project, 50), pr => store.ciFailureObserved(pr)),
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
          ? `<div class="card"><h2>locked</h2><p class="meta">no mode is signed — every action asks for your password. That is the default.</p></div>`
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
              `<label>a short or refuted run's drafted repair<select name="repair-auto">` +
                `<option value="">wait for my approval (the default, every preset)</option>` +
                `<option value="1">auto-approve it, within the attempt cap below</option>` +
                `</select></label>`,
              `<label>repair attempt cap <span class="meta">(0–3, only while repair auto-approves)</span><input type="number" name="repair-max-attempts" value="1" min="0" max="3"></label>`,
              `<button type="submit">read the full terms</button>`,
              `</form>`,
              `</div>`,
            ].join("\n");
      return sendScreen(
        response,
        200,
        screen("mode", [`<h1>operating mode</h1>`, current, signForm].join("\n"), { chrome: chromeFor(project, "mode") }),
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
      // Coordinators (MCP spec v6): the machine principals beside the
      // human ones — name, immutable fingerprint, what they may file
      // into, their rate, and the revoke road. Approver eyes only.
      const coordinatorCard = !approverView
        ? ""
        : (() => {
            const rows = listCoordinators(store);
            if (rows.length === 0) return "";
            return [
              `<div class="card">`,
              `<h2 style="margin-top:0">coordinators</h2>`,
              `<p class="meta">agents holding the MCP filing credential — they may propose work; only you admit it</p>`,
              ...rows.map(one =>
                `<p class="row">` +
                `<span class="mono">${escape(`${one.name}#${one.cid.slice(0, 4)}`)}</span> ` +
                (one.revokedAt !== null
                  ? `<span class="meta">revoked ${escape(one.revokedAt.slice(0, 10))}</span>`
                  : `<span class="meta">${one.perHour}/hour · files into ${one.repos.map(repo => escape(repo)).join(", ")} · last filed ${one.lastFiledAt === null ? "never" : escape(one.lastFiledAt.slice(0, 16).replace("T", " "))}</span>`) +
                `</p>`,
              ),
              `<p class="meta">revoke: \`standing-orders coordinator revoke &lt;cid&gt; --as you\`</p>`,
              `</div>`,
            ].join("\n");
          })();
      return sendScreen(
        response,
        200,
        screen("people", [`<h1>people</h1>`, ...cards, coordinatorCard, inviteCard].join("\n"), {
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
          ? {
              title: picked.title, goal: picked.goal, not: picked.outOfScope ?? "", touches: picked.touches.join(", "),
              acceptance: acceptanceToLines(picked.acceptance).join("\n"),
            }
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
          store.permissionDefault().mode,
          store.qualityDefault().mode,
        ),
      );
    }

    if (url.pathname === "/queue") {
      const csrf = who.via === "cookie" ? who.session.csrf : "";
      const revision = who.via === "cookie" ? who.session.projectRevision : 0;
      // Column headers read one thing beyond the queue snapshot: live claims
      // in THIS project, per worker (the capacity is global; attended claims
      // may exceed it), so the header names both and never a ratio.
      if (url.searchParams.get("fragment") === "1") {
        return respond(response, 200, "text/html; charset=utf-8", queueRegionFor(project, csrf, revision, clock()));
      }
      // The queue is the board's order view (reduction pass §1): the URL
      // keeps answering, as a redirect, so nothing anyone bookmarked 404s.
      return redirect(response, QUEUE_VIEW);
    }

    if (url.pathname === "/peek") {
      // The multiplexer in the console (peek): one pane per live run the
      // ceiling admits, each fed by the run page's own transcript poller
      // (the byte-offset JSON protocol — text into textContent, never
      // markup). The pane SET is re-checked on a slow cadence; when it
      // changes the page reloads rather than swapping pollers mid-flight.
      const live = store.liveRuns(clock()).filter(run => runVisible(run));
      if (url.searchParams.get("fragment") === "1") {
        return respond(response, 200, "application/json", JSON.stringify({ runs: live.map(run => run.id) }));
      }
      const now = clock();
      const panes = live.map(run => {
        const window = options.localRunner === undefined ? null : readLiveWindow(evidenceRoot, run.id, 0);
        const tail = window !== null && window.ok ? window.text.split("\n").filter(one => one !== "").slice(-40).join("\n") : "";
        const stage = run.phase !== null ? run.phase.replace(/-/g, " ") : run.providerStartedAt === null ? "preparing workspace" : "the agent is working";
        return [
          `<section class="card peek-pane" data-run="${run.id}">`,
          `<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> <a href="${taskHref(run.taskId)}"><strong>${escape(run.title)}</strong></a>${projectChip(run.repo)} ` +
            `<span class="right meta mono">${escape(run.runner)} \u00b7 ${escape(run.role)} \u00b7 ${escape(stage)} \u00b7 ${escape(relativeAge(run.startedAt, now))}</span></p>`,
          options.localRunner === undefined
            ? `<p class="meta">the transcript is readable on the machine that runs the worker \u2014 start the console there with <code>standing-orders up</code></p>`
            : `<pre class="recap plan-doc live-pane" id="live-transcript-${run.id}" data-initial-offset="0">${escape(tail)}</pre><p class="meta" id="live-transcript-${run.id}-state"></p>`,
          `</section>`,
        ].join("\n");
      });
      const script =
        (options.localRunner === undefined ? "" : live.map(run => transcriptScript(`/r/${run.id}`, `live-transcript-${run.id}`)).join("")) +
        `(function(){var seen=${JSON.stringify(live.map(run => run.id))};function check(){if(document.hidden){setTimeout(check,12000);return;}` +
        `fetch("/peek?fragment=1",{redirect:"manual",cache:"no-store"}).then(function(r){return r.ok?r.json():null;})` +
        `.then(function(d){if(d&&Array.isArray(d.runs)&&JSON.stringify(d.runs)!==JSON.stringify(seen)){location.reload();return;}setTimeout(check,12000);})` +
        `.catch(function(){setTimeout(check,12000);});}setTimeout(check,12000);})();`;
      return sendScreen(
        response,
        200,
        screen(
          "peek",
          [
            `<h1>peek</h1>`,
            panes.length === 0
              ? `<p class="meta">no agent is working right now \u2014 this page follows them the moment one starts</p>`
              : panes.join("\n"),
          ].join("\n"),
          { chrome: chromeFor(project, "runs"), functional: { script, fetches: true } },
        ),
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
          `<p class="hint">one lane per worker — drag a queued card onto another worker to re-reserve it</p>`,
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
        { chrome: chromeFor(project, "fleet", undefined, "all"), functional: { script: fleetScript(), fetches: true } },
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
      return sendScreen(response, 200, newTaskPage(chromeFor(project, "tasks"), project, csrf, revision, null, chainable, store.permissionDefault().mode, store.qualityDefault().mode));
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
      const verdicts = store.proofVerdictsFor(rows.map(one => one.id));
      const accepted = new Set(rows.filter(one => store.proofAcceptance(one.id) !== null).map(one => one.id));
      return sendScreen(response, 200, runsPage(chromeFor(project, "runs"), rows, liveRunIds(rows), rows.length === RUNS_PAGE ? rows[rows.length - 1]?.id ?? null : null, verdicts, accepted));
    }

    if (url.pathname === "/menu") {
      // The phone's overflow drawer as an honest page: every destination
      // the tab bar does not carry, one tap away, no JavaScript — grouped
      // under the same workflows/admin headings as the rail's accordion,
      // with settings last, outside both.
      const chrome = chromeFor(project, "menu");
      const section = (label: string, rows: NavRow[]): string =>
        `<h2 class="menu-group-label">${label}</h2><div class="menu-list">` +
        rows.map(row => `<a class="menu-row" href="${row.href}"><strong>${row.label}</strong><span class="meta">${row.hint}</span></a>`).join("\n") +
        `</div>`;
      const settingsSection = chrome.settings
        ? section("settings", [{ key: "settings" as const, href: "/settings", label: "settings", hint: "agent defaults, alerts, credentials" }])
        : "";
      return page(response, 200, shell("menu", [
        `<h1>more</h1>`,
        section("workflows", workflowsRows()),
        section("admin", adminRows()),
        settingsSection,
      ].join("\n"), { chrome }));
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
              (options.localRunner === undefined ? "" : transcriptScript()),
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
          structuredHandoffView(artifacts, evidenceRoot),
          proofBundleView(store, found, artifacts, evidenceRoot),
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
                acceptance: acceptanceToLines(picked.acceptance).join("\n"),
              }
            : null,
      }));
    }

    if (url.pathname === "/chat") {
      // Cookie sessions only (Codex v3 review, change 7): drafts live in
      // THIS session's memory; a bearer caller has nowhere to keep them.
      if (who.via !== "cookie") return refuse(response, who, 403, "chat is a browser surface — it keeps your drafts in the session");
      store.sweepStaleChatTurns(now);
      store.sweepStaleMateTurns(now);
      store.sweepCoordinatorProposals(now);
      sweepChatDrafts(Date.now());
      const requestedTask = url.searchParams.get("task");
      const focusTask = taskChatFocus(requestedTask, now, who);
      const focusProblem = requestedTask !== null && focusTask === null
        ? "That task is not available in this workspace."
        : null;
      // Pending cards, and the recently answered ones so the door's words are read (last 30).
      const repos = managedRepos();
      const allCoordinatorRows = who.role === "approver" ? store.listCoordinatorProposals({ repos, states: ["pending", "confirmed", "refused"], limit: 30 }) : [];
      const coordinatorRows = focusTask === null
        ? allCoordinatorRows
        : allCoordinatorRows.filter(one => one.payload["task"] === focusTask.id);
      const enabled = chatEnablement();
      const pending = store.liveChatTurnFor(who.name);
      const latched = enabled.ok ? store.latchedChatTurns(enabled.credentialKey) : [];
      // The mate (mate arc §5): while a mate session is live, /chat IS the
      // thread — the same rows the CLI reads. Without one, fleet chat as
      // before, plus the card that mints a session.
      const mateSession = enabled.ok && who.role === "approver" ? store.activeMateSession(who.name) : null;
      const principal = enabled.ok && who.role === "approver" ? matePrincipal(who) : null;
      // A session under another ceiling is not continuable from here; a GET
      // writes nothing (slice-2 review, finding 7) — the mint card below
      // starts a new conversation, and minting ends the old session.
      const ceilingStale = enabled.ok && mateSession !== null && principal !== null && mateSession.ceilingDigest !== principal.ceilingDigest;
      const chatProjects = repos.map((repo, index) => {
        let peek: ProjectPeek | null = null;
        try {
          peek = store.projectPeek(repo, now);
        } catch {
          // The project rail is orientation, like chrome's project peek: a
          // failed count must not make the conversation itself disappear.
        }
        return { id: `r${index + 1}`, label: projectName(repo), path: repo, peek };
      });
      let fleetSnapshot: ChatSnapshot | null = null;
      if (repos.length > 0) {
        try {
          fleetSnapshot = withDispatchDiagnoses(store, store.chatSnapshot(repos, now), now);
        } catch {
          // The project rail already degrades each pulse independently.
          // A failed briefing query must not make the conversation vanish.
        }
      }
      if (enabled.ok && mateSession !== null && principal !== null && !ceilingStale) {
        {
          const opened = store.openMateThread(who.name, principal.ceilingDigest, now);
          const said = takeMateNote(who.session.csrf, mateSession.id);
          return sendScreen(
            response,
            200,
            matePage(chromeFor(null, "chat", undefined, "all"), {
              session: mateSession,
              messages: store.listMateMessages(opened.thread.id, 40),
              proposals: store.listMateProposals(opened.thread.id),
              decisions: decisionsFor(store, [...store.listMateProposals(opened.thread.id), ...coordinatorRows]),
              coordinatorProposals: coordinatorRows,
              pending: store.liveMateTurnFor(who.name),
              latched,
              recent: store.recentMateTurns(who.name, 5),
              config: enabled.config,
              turnsToday: store.chatTurnsToday(who.name, now),
              weeklySpent: store.chatWeeklySpendMicrousd(enabled.credentialKey, now),
              projects: chatProjects,
              fleetSnapshot,
              focusTask,
              csrf: who.session.csrf,
              problem: url.searchParams.get("said") ?? focusProblem ?? said,
              now,
            }),
          );
        }
      }
      return sendScreen(
        response,
        200,
        chatPage(chromeFor(null, "chat", undefined, "all"), {
          enabled,
          pending,
          latched,
          chat: who.session.chat ?? null,
          recent: store.recentChatTurns(who.name, 10),
          turnsToday: store.chatTurnsToday(who.name, now),
          weeklySpent: enabled.ok ? store.chatWeeklySpendMicrousd(enabled.credentialKey, now) : 0,
          projects: chatProjects,
          fleetSnapshot,
          focusTask,
          canManage: who.role === "approver",
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
          problem:
            url.searchParams.get("said") ??
            focusProblem ??
            (ceilingStale ? "the admitted projects changed since your mate session was minted — start a new conversation below; that ends the old one" : null) ??
            takeMateNote(who.session.csrf, null),
          ...(enabled.ok && who.role === "approver" ? { mateMint: mateMintCard(who.session.csrf, enabled, focusTask === null ? "/chat" : taskChatHref(focusTask.id)) } : {}),
          ...(who.role === "approver" ? { coordinatorProposals: coordinatorProposalsSection(coordinatorRows, decisionsFor(store, coordinatorRows), who.session.csrf, now, true, focusTask === null ? null : taskChatHref(focusTask.id)) } : {}),
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
      const telegramConfigured = loadBotToken(process.env, options.telegramTokenFile) !== null;
      const digest = telegramConfigured
        ? (() => {
            const cadence = store.telegramDigest();
            return { everyMs: cadence.everyMs, lastSentAt: cadence.lastSentAt, held: store.countRoutinePending() };
          })()
        : null;
      return sendScreen(
        response,
        200,
        settingsPage(chromeFor(project, "settings"), existing, hasEnv, csrf, url.searchParams.get("said"), messaging, push, providerKeys, digest, {
          ...store.permissionDefault(),
          canManage: who.role === "approver",
        }, {
          ...store.qualityDefault(),
          canManage: who.role === "approver",
        }),
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
      const decisionReturn = url.searchParams.get("return");
      const back = decisionReturn === null ? null : safeChatReturn(decisionReturn);
      return sendScreen(response, 200, decisionPage(chromeFor(project, "none"), decision, taskId, store.evidenceFor(decision.id), who, now, back));
    }

    if (url.pathname === "/chat/task-status") {
      if (who.via !== "cookie") return respond(response, 403, "text/plain; charset=utf-8", "sign in to see this task");
      const focus = taskChatFocus(url.searchParams.get("task"), now, who);
      if (focus === null) return respond(response, 404, "text/plain; charset=utf-8", "this task is not available in this workspace");
      response.setHeader("cache-control", "no-store");
      return respond(response, 200, "text/html; charset=utf-8", taskChatLiveRegion(focus, who.session.csrf, true));
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
  /** The mate's last non-answer per BROWSER session (keyed by its csrf —
   * never by name, so two browsers on one account do not read each other's
   * notes), bound to the mate turn it came from so a note from a session
   * that has since ended never shows; bounded; read once. */
  const mateSaid = new Map<string, { turn: number | null; message: string }>();
  function noteMate(csrf: string, turn: number | null, message: string): void {
    if (mateSaid.size >= 500) {
      const oldest = mateSaid.keys().next().value;
      if (oldest !== undefined) mateSaid.delete(oldest);
    }
    mateSaid.set(csrf, { turn, message });
  }
  function takeMateNote(csrf: string, liveSession: number | null): string | null {
    const noted = mateSaid.get(csrf);
    if (noted === undefined) return null;
    mateSaid.delete(csrf);
    if (noted.turn === null) return noted.message;
    const turn = store.getMateTurn(noted.turn);
    return turn !== null && turn.session === liveSession ? noted.message : null;
  }
  /** The session-layer principal (ruling 3): cookie, csrf, and role were
   * proved at the edge; the row and the generation are re-proved here. */
  function matePrincipal(who: Who & { via: "cookie" }): VerifiedApprover | null {
    const verified = verifyApproverStanding(store, who.name, who.session.generation, managedRepos());
    return verified.ok ? verified.who : null;
  }
  const CHAT_CANDIDATES_PER_APPROVER = 9;
  const CHAT_CANDIDATE_TTL_MS = 30 * 60_000;

  /** The frozen explicit repo list, digested canonically (sorted) — every
   * candidate binds to it and filing re-proves it (v2 new finding 5). */
  const chatCeilingDigest = (repos: readonly string[] = managedRepos()): string =>
    createHash("sha256").update([...repos].sort().join("\n")).digest("hex");

  type ChatEnablement =
    | { ok: true; billing: "metered"; config: ChatConfig & { provider: DirectChatProviderId }; key: string; keySource: "environment" | "stored"; price: import("./converse.js").ModelPrice; credentialKey: string }
    | { ok: true; billing: "subscription"; config: ChatConfig & { provider: SubscriptionChatProviderId }; key: null; keySource: null; price: null; credentialKey: string }
    | { ok: false; code: "demo" | "unscoped" | "roots" | "unresolved" | "empty" | "unconfigured" | "unpriced" | "no-key"; why: string };

  /** Every condition re-proved per request — the render and the POST each
   * ask again; nothing is cached into authority. */
  function chatEnablement(): ChatEnablement {
    if (store.isDemo()) return { ok: false, code: "demo", why: "this is a demo database — chat cannot contact an external model" };
    if (unscopedMode) return { ok: false, code: "unscoped", why: "chat needs at least one added project" };
    if (options.currentRepos === undefined && unresolvedRepos.length > 0) {
      return { ok: false, code: "unresolved", why: "a configured project path did not resolve at startup — fix it and restart before chat will run" };
    }
    if (managedRepos().length === 0) return { ok: false, code: "empty", why: "add a project first — chat will include it automatically" };
    const config = store.getChatConfig();
    if (config === null) return { ok: false, code: "unconfigured", why: "chat is not configured yet — set it up below, or from the terminal: standing-orders config set chat" };
    if (isSubscriptionChatProvider(config.provider)) {
      return {
        ok: true,
        billing: "subscription",
        config: config as ChatConfig & { provider: SubscriptionChatProviderId },
        key: null,
        keySource: null,
        price: null,
        credentialKey: subscriptionCredentialKey(config.provider),
      };
    }
    const price = priceForConfig(config);
    if (price === null) return { ok: false, code: "unpriced", why: `no pinned price for ${config.model} — re-save the configuration to pin one` };
    const key = chatKeyFor(config.provider);
    if (key === null) return { ok: false, code: "no-key", why: `no ${config.provider} key — paste one below (stored 0600 beside the database, never in it), or export ${CHAT_KEY_ENV[config.provider]} in the serve environment` };
    return { ok: true, billing: "metered", config: config as ChatConfig & { provider: DirectChatProviderId }, key: key.key, keySource: key.source, price, credentialKey: credentialKeyOf(config.provider, key.key) };
  }

  /**
   * Where a chat key comes from, in priority order: the serve process
   * environment, then the 0600 key file under the config directory (the
   * Telegram bot-token precedent — settable from the console, never the
   * database, never echoed whole). The file exists so onboarding lives
   * in the UI; the environment exists so operators who prefer it keep it.
   */
  function chatKeyFor(provider: DirectChatProviderId): { key: string; source: "environment" | "stored" } | null {
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

  function storeChatKey(provider: DirectChatProviderId, key: string): { ok: true } | { ok: false; message: string } {
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

  function forgetChatKey(provider: DirectChatProviderId): void {
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
  async function runChatTurn(
    turnId: number,
    session: Session,
    enabled: Extract<ChatEnablement, { ok: true; billing: "metered" }>,
    userMessage: string,
    dataDocument: string,
    turnRepos: readonly string[],
  ): Promise<void> {
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
      const repoPath = turnRepos[repoIndex];
      if (repoPath === undefined) continue;
      while (approverCandidateCount(session.name) >= CHAT_CANDIDATES_PER_APPROVER) evictOldestCandidate(session.name);
      const key = randomBytes(16).toString("hex");
      chat.candidates.set(key, {
        key,
        draft,
        repoPath,
        provider: enabled.config.provider,
        approver: session.name,
        ceilingDigest: chatCeilingDigest(turnRepos),
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
      { label: "queue", href: QUEUE_VIEW },
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
    const sensitiveChrome = sensitive && s.forceSensitive !== true && s.chrome !== undefined
      ? beatScript() + sidebarScript()
      : "";
    const script = functional + (chromeLayer ? chromeScript() : sensitiveChrome);
    const nonce = script === "" ? undefined : randomBytes(16).toString("base64");
    const body = chromeLayer
      ? `${s.body}\n${paletteTagCached(s.chrome?.project ?? null)}\n${KBD_HELP}`
      : s.body;
    const html = shell(s.title, body, {
      ...(s.chrome === undefined ? {} : { chrome: s.chrome }),
      ...(sensitive ? { sensitive: true } : {}),
      ...(s.chrome !== undefined && s.forceSensitive !== true ? { sidebarToggle: true } : {}),
      ...(s.refreshSeconds === undefined ? {} : { refreshSeconds: s.refreshSeconds }),
      ...(nonce === undefined ? {} : { live: { nonce, script, fallbackRefresh: s.functional?.fetches === true } }),
    });
    // v28: the chrome layer itself fetches (the attended beat), so any
    // page that ships it needs connect-src — not only pages whose own
    // functional script polls.
    return page(response, status, html, nonce, s.functional?.fetches === true || chromeLayer || sensitiveChrome !== "");
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
    scope?: Chrome["scope"],
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
    let projectPeek: ProjectPeek | null | undefined = project === null ? null : undefined;
    if (project !== null) {
      try {
        projectPeek = store.projectPeek(project, clock());
      } catch {
        // Chrome is orientation, never a reason to fail the actual screen.
        projectPeek = undefined;
      }
    }
    const facts = requestContext.getStore();
    return {
      active,
      project,
      ...(projectPeek === undefined ? {} : { projectPeek }),
      // Enrolled projects first (most recently opened), then the repos this
      // server was told to serve that nobody has opened yet — the switcher
      // lists every project it is allowed to show, each exactly once.
      projects: (() => {
        const seen = new Set<string>();
        const rows: { path: string; name: string }[] = [];
        for (const one of [
          ...store.listProjects().map(one => ({ path: one.path, name: one.name })),
          ...managedRepos().map(path => ({ path, name: projectName(path) })),
        ]) {
          if (seen.has(one.path) || !visible(one.path)) continue;
          seen.add(one.path);
          rows.push(one);
        }
        return rows;
      })(),
      ...(facts === undefined ? {} : { csrf: facts.csrf, returnTo: facts.returnTo }),
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
      ...(!unscopedMode && managedRepos().length > 0 ? { chat: true } : {}),
      ...(listPane === undefined ? {} : { listPane }),
      ...(scope === undefined ? {} : { scope }),
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
    for (const path of [...managedRepos(), ...store.knownRepos()]) {
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
                  why: options.upConsole === true
                    ? "choose a projects folder once with `standing-orders up --project-root <dir>` — it is remembered on later starts"
                    : "choose which folder this server may use with --project-root <dir>",
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
      who.via === "cookie" && scope !== null && approvalDigest !== null && !approvalOf(scope).approved && !revisionBroken && ref?.plan !== "requested"
        ? mintApprovalNonce(who.name, taskId, approvalDigest)
        : "";
    const runs = ref === null ? [] : store.runsFor(ref.id);
    const completion = (() => {
      // v40 fix: a reviewer run finishes AFTER the build it reviews and
      // carries no proof verdict of its own — without this filter, its
      // "no-change" outcome would hijack the task's own completion card
      // the instant a review lands, showing "proof missing" for a proof
      // that is right there on the builder's run.
      const latest = runs.find(one => one.finishedAt !== null && one.role !== "reviewer");
      if (latest === undefined) return null;
      const artifacts = store.artifactsFor(latest.id);
      const verdict = store.proofVerdictFor(latest.id);
      return {
        runId: latest.id,
        outcome: latest.outcome,
        hasTerminalDiff: artifacts.some(one => one.kind === "terminal-diff"),
        hasHandoff: artifacts.some(one => one.kind === "handoff"),
        // The closed machine-authored verdict (Priority 2), computed once
        // at completion by adjudicate() and never re-inferred here — null
        // only for a run that predates the proof system.
        proofVerdict: verdict?.verdict ?? null,
        machineVerdict: verdict?.machineVerdict ?? null,
        proofReasons: verdict?.reasons ?? [],
        proofMatrix: verdict?.matrix ?? [],
        proofMatrixLinks: evidenceLinksFor(artifacts),
        proofAccepted: store.proofAcceptance(latest.id) !== null,
        // Either direction: the ORIGINAL task's page finds the chain by
        // its own latest run (the one that triggered a draft); a DRAFT
        // task's page finds the SAME chain by being named as the draft.
        repairChain: store.repairChainFor(latest.id) ?? store.repairChainForDraft(taskId),
        receipt:
          latest.outcome === "built" || latest.outcome === "no-change"
            ? completionReceiptView(store, latest, artifacts, evidenceRoot)
            : null,
      };
    })();
    return {
        task: found,
        dispatch: diagnoseTaskDispatch(store, taskId, now),
        strikes: ref?.strikes ?? 0,
        plan: ref?.plan ?? null,
        planDocument: ref === null ? null : planDocumentOf(ref.id),
        deliverable: ref?.deliverable ?? "branch",
        report: ref === null ? null : readVerifiedReport(store, evidenceRoot, ref.id),
        revision,
        // v40: the fallback for a task page with no completed run yet (a
        // freshly drafted, unapproved repair) — completion's own branches
        // cover every case once a run exists.
        repairChain: completion !== null ? null : store.repairChainForDraft(taskId),
        repo: ref?.repo ?? null,
        filedVia: store.filedViaOf(taskId),
        coordinator: (() => {
          const who = store.coordinatorProvenanceOf(taskId);
          if (who === null) return null;
          // RELATIVE age (round-2 finding 5): "12m ago" reads at a glance;
          // an absolute stamp makes the operator do arithmetic.
          const ago =
            who.filedAt === null
              ? null
              : (() => {
                  const minutes = Math.max(0, Math.round((now.getTime() - new Date(who.filedAt).getTime()) / 60_000));
                  if (minutes < 60) return `${minutes}m ago`;
                  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
                  return `${Math.round(minutes / (60 * 24))}d ago`;
                })();
          return { label: who.label, filedAgo: ago };
        })(),
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
          return { id: blockerId, title: blocker === null ? null : blocker.title, state: blocker === null ? null : blocker.state, admitted };
        }),
        // Candidates a "wait for" or replacement select may offer: this
        // TASK's own project, even when the sidebar is in all-project mode.
        // That keeps repair complete without ever mixing unrelated projects.
        waitCandidates: (() => {
          if (who.via !== "cookie") return [];
          const candidateRepo = ref?.repo ?? who.session.project;
          return candidateRepo === null
            ? []
            : store
                .listTasksScoped(candidateRepo, undefined, 100, null)
                .filter(one => one.id !== taskId && (one.state === "queued" || one.state === "running") && visible(one.repo))
                .map(one => ({ id: one.id, title: one.title }));
        })(),
        // The one liveness fact, computed here where the store is: the run
        // whose lease is the task's CURRENT claim — not merely the first
        // unfinished run (round-4 finding, A1).
        liveRunId: (() => {
          if (ref === null) return null;
          const found = store.runsFor(ref.id).find(one => runIsLive(one));
          return found === undefined ? null : found.id;
        })(),
        worker: (() => {
          const runners = store.listRunners().filter(one => one.retiredAt === null);
          const eligible = ref?.repo === null || ref?.repo === undefined
            ? []
            : runners.filter(one => one.repos.includes(ref.repo as string));
          const answering = eligible.filter(one => runnerAlive(one, now));
          return {
            answering: answering.length,
            registered: eligible.length,
            totalRegistered: runners.length,
            lastHeard: eligible.map(one => one.heartbeatAt).sort().at(-1) ?? null,
          };
        })(),
        gaps:
          ref?.repo === null || ref?.repo === undefined
            ? []
            : computeGaps(store, ref.repo, now).filter(one =>
                one.unblocks.includes(taskId) || one.alsoBlocks.includes(taskId),
              ),
        peekable: options.localRunner !== undefined,
        position: store.queuePosition(taskId),
        mirror: store.mirrorByTask(taskId),
        scope,
        raceTerms,
        approvalDigest,
        spendDefaults: store.getSpendDefaults(),
        permissionDefault: store.permissionDefault().mode,
        permissionMode: ref?.permissionMode ?? null,
        qualityDefault: store.qualityDefault().mode,
        qualityMode: ref?.qualityMode ?? null,
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
        runs,
        completion,
        decisions: ref === null ? [] : store.decisionsForTask(ref.id),
        incidents: ref === null ? [] : store.incidentsForTask(ref.id),
        coordinatorProposals: (() => {
          if (ref === null || ref.repo === null || who.role !== "approver") return null;
          store.sweepCoordinatorProposals(now);
          const rows = store.listCoordinatorProposals({ repos: [ref.repo], taskId });
          return { rows, decisions: decisionsFor(store, rows), now };
        })(),
        steering: ref === null ? [] : store.listSteerNotes(ref.id),
        // "publishes as" reads ONLY publicationGrantFor(repo) — the grant
        // the publisher would act under — never listGrants(), which is
        // dispatch authority (slice 1c).
        grant: ref === null || ref.repo === null ? null : store.publicationGrantFor(ref.repo),
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
              posture: modeTerms?.permissionDefault === "escalated" ? ("bypassPermissions" as const) : ("auto" as const),
              quick: modeTerms?.quickMint === true && liveMode !== null && liveMode.signedBy === who.name,
            },
            open: null,
          };
        })(),
        now,
      };
  }

  /** Resolve a task-scoped chat lens without trusting its query string.
   * Only an admitted task becomes model context or visible page copy. */
  function taskChatFocus(taskId: string | null, now: Date, who?: Who): TaskChatFocus | null {
    if (taskId === null || taskId.length === 0 || taskId.length > 64 || hasForbiddenControls(taskId)) return null;
    const task = store.getTask(taskId);
    const ref = store.lookupRef(taskId);
    if (task === null || ref === null || !visible(ref.repo)) return null;
    const scope = store.getScope(taskId);
    // The focused chat is a lens over the task page's own assembled facts.
    // Reusing that projection keeps approval nonces, joint race digests,
    // revision verification, decisions, and result evidence on one source
    // of truth instead of growing a chat-only lifecycle.
    const view = who === undefined ? null : taskViewData(taskId, who, null);
    const runs = view?.runs ?? store.runsFor(ref.id);
    const latest = runs.find(one => one.finishedAt !== null && one.role !== "reviewer") ?? null;
    const approval = approvalOf(scope);
    const live = runs.find(one => runIsLive(one)) ?? null;
    return {
      id: task.id,
      title: task.title,
      state: task.state,
      project: ref.repo === null ? null : projectName(ref.repo),
      now,
      dispatch: diagnoseTaskDispatch(store, taskId, now),
      scope: scope === null ? "none" : approval.approved ? "approved" : "needs approval",
      plan: ref.plan,
      claimed: view?.claimed ?? store.hasLiveClaim(ref.id, now),
      liveRun: live === null ? null : { id: live.id, runner: live.runner, startedAt: live.startedAt, phase: live.phase },
      approval:
        view === null || who?.role !== "approver" || scope === null || approval.approved
          ? null
          : {
              scope,
              nonce: view.nonce,
              digest: view.approvalDigest ?? scope.digest,
              planDocument: view.planDocument,
              deliverable: view.deliverable ?? "branch",
              raceTerms: view.raceTerms ?? null,
              revision: view.revision ?? null,
              coordinator: view.coordinator ?? null,
            },
      decisions: (view?.decisions ?? store.decisionsForTask(ref.id))
        .filter(one => one.state === "open" || one.state === "expired")
        .map(one => ({ ...one, taskId: task.id, repo: ref.repo })),
      publication: view?.publication ?? null,
      result:
        view?.completion?.receipt !== undefined && view.completion.receipt !== null
          ? view.completion.receipt
          : latest === null || (latest.outcome !== "built" && latest.outcome !== "no-change")
          ? null
          : completionReceiptView(store, latest, store.artifactsFor(latest.id), evidenceRoot),
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

    if (url.pathname === "/settings/permission-default" && options.telegramTokenFile !== undefined) {
      const wanted = body.get("permission-mode");
      if (wanted !== "auto" && wanted !== "bypassPermissions") {
        return refuse(response, who, 400, "permissions must be Auto or Full access", "/settings");
      }
      store.setPermissionDefault(wanted, who.name, now);
      return redirect(
        response,
        `/settings?said=${encodeURIComponent(
          wanted === "bypassPermissions"
            ? "new tasks now default to Full access — existing scopes and approvals are unchanged"
            : "new tasks now default to Auto — existing scopes and approvals are unchanged",
        )}`,
      );
    }

    if (url.pathname === "/settings/quality-default" && options.telegramTokenFile !== undefined) {
      const wanted = body.get("quality-mode");
      if (!isQualityMode(wanted)) {
        return refuse(response, who, 400, "quality must be Default or Strict / release", "/settings");
      }
      store.setQualityDefault(wanted, who.name, now);
      return redirect(
        response,
        `/settings?said=${encodeURIComponent(
          wanted === "strict"
            ? "new tasks now default to Strict / release — existing scopes and approvals are unchanged"
            : "new tasks now default to Default quality — existing scopes and approvals are unchanged",
        )}`,
      );
    }

    if (url.pathname === "/settings/telegram-digest" && options.telegramTokenFile !== undefined) {
      // The cadence is a closed list of minutes — never a free number from
      // a form; "off" clears it. Any approver session may set it.
      const wanted = (body.get("every") ?? "").trim();
      const allowed: Record<string, number | null> = { off: null, "30": 30, "60": 60, "240": 240, "720": 720, "1440": 1440 };
      if (!(wanted in allowed)) return refuse(response, who, 400, "the digest cadence is one of the listed choices", "/settings");
      const minutes = allowed[wanted] ?? null;
      store.setTelegramDigest(minutes === null ? null : minutes * 60_000, who.name, now);
      return redirect(response, `/settings?said=${encodeURIComponent(minutes === null ? "digest off — every fact pages as it lands" : `digest every ${minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`} — decisions still page at once`)}`);
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
        return sendScreen(response, 400, settingsPage(chromeFor(who.via === "cookie" ? who.session.project : defaultProject, "settings"), existing, hasEnv, csrf, saved.message, null, null, null, null, {
          ...store.permissionDefault(),
          canManage: who.role === "approver",
        }));
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
      return redirect(response, safeReturn(body.get("return")));
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
      // Opening an allowed repository enrolls it in this machine's durable
      // project list. A co-located `up` notices that list and connects its
      // builder; there is no separate restart or runner-binding step.
      if (options.registryPath !== undefined) {
        const enrolled = await updateRepos(options.registryPath, repos => addRepos(repos, [canonical]));
        if (!enrolled.ok) {
          return void projectsScreen(response, who, `that project is valid, but it could not be added — ${enrolled.message}`, 400);
        }
      }
      store.upsertProject(canonical, projectName(canonical), now);
      who.session.project = canonical;
      who.session.projectRevision++;
      // The switcher (board pass) opens a project from any screen and
      // returns there — a same-site path only, never an off-site road.
      return redirect(response, safeReturn(body.get("return")));
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
          tasksPage(chromeFor(project, "tasks"), store.listTasksScoped(project, undefined, 200, null), null, csrf, "name a repository — no project is open, so the task must say where it belongs", project, null, store.permissionDefault().mode, store.qualityDefault().mode),
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
            tasksPage(chromeFor(project, "tasks"), store.listTasksScoped(project, undefined, 200, null), null, csrf, `${effective} is outside what this server was configured to show`, project, null, store.permissionDefault().mode, store.qualityDefault().mode),
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
      const scout = body.get("scout") === "1";
      const permissionMode = body.get("permission-mode");
      if (permissionMode !== null && permissionMode !== "auto" && permissionMode !== "bypassPermissions") {
        return refuse(response, who, 400, "permissions must be Auto or Full access", "/tasks/new");
      }
      const qualityMode = body.get("quality-mode");
      if (qualityMode !== null && !isQualityMode(qualityMode)) {
        return refuse(response, who, 400, "quality must be Default or Strict / release", "/tasks/new");
      }
      // One filing door for every surface (Codex adoption review, finding 7).
      const made = fileTaskProposal(
        store,
        {
          ...(id === "" ? {} : { id }),
          title,
          ...(repo === "" ? {} : { repo }),
          ...(goal === "" ? {} : { goal, acceptance: acceptanceLinesToInput((body.get("acceptance") ?? "").split("\n")) }),
          outOfScope: notThis === "" ? null : notThis,
          touches: touchesGiven,
          ...(permissionMode === null ? {} : { permissionMode }),
          ...(qualityMode === null ? {} : { qualityMode }),
          ...(scout ? { deliverable: "report" as const } : {}),
          planning:
            scout
              ? "skip"
              : body.get("planning-policy") === "choice"
                ? body.get("plan-first") === "1" ? "required" : "skip"
                : "auto",
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
          tasksPage(chromeFor(project, "tasks"), store.listTasksScoped(project, undefined, 200, null), null, csrf, made.message, project, null, store.permissionDefault().mode, store.qualityDefault().mode),
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
          return refuse(response, who, 400, "that note will not render, so it will not store", QUEUE_VIEW);
        }
        const set = store.setRunnerQueueNote(worker, note === "" ? null : note);
        if (!set.ok) return refuse(response, who, 404, "no such worker", QUEUE_VIEW);
        return redirect(response, body.get("from") === "fleet" ? "/fleet" : QUEUE_VIEW);
      }
      if (who.via === "cookie") {
        const seen = body.get("projectRevision");
        if (seen !== null && seen !== String(who.session.projectRevision)) {
          return refuse(response, who, 409, "the open project changed since this form was rendered — reload and try again", QUEUE_VIEW);
        }
      }
      // A drag posts in place (fetch) when it can; the page re-renders its
      // own fragment on success. A plain form still works with no script.
      const inPlace = body.get("respond") === "fragment";
      const fromFleet = who.via === "cookie" && body.get("projectRevision") === null;
      const respondMove = (status: number, message: string): void => {
        if (!inPlace) return status === 409 ? refuse(response, who, 409, message, QUEUE_VIEW) : redirect(response, QUEUE_VIEW);
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
      if (!belongs(taskId) || (beforeGiven !== "" && beforeGiven !== QUEUE_FRONT && !belongs(beforeGiven))) {
        return respondMove(404, "that task is not in this queue");
      }
      // The no-script "move to the front" button cannot name the front: the
      // front of a task's partition is decided by the store's exact repo AND
      // assignment, and the page's snapshot is bounded — so the sentinel is
      // resolved HERE, against a fresh snapshot, into a real task id (slice
      // 1b, fix 1). It is honored only within the task's own column; a
      // cross-column front is not provable from a bounded snapshot.
      let beforeTaskId: string | null = beforeGiven === "" ? null : beforeGiven;
      if (beforeGiven === QUEUE_FRONT) {
        const ref = store.lookupRef(taskId);
        if (ref === null) return respondMove(404, "that task is not in this queue");
        if (ref.assignedRunner !== toRunner) {
          return respondMove(409, "move to the front works inside a task's own column — drag it across to reserve it elsewhere");
        }
        const now = clock();
        const snapshot = store.queueScoped(ref.repo, now);
        const self = snapshot.find(one => one.id === taskId);
        // A claim or a contest can land after the form rendered WITHOUT
        // bumping queueRevision, so the snapshot — not the form — decides
        // whether the card is still free. A taken or vanished card is the
        // typed refusal, never a silent no-op that would skip moveTask()'s
        // own claimed/contest recheck.
        if (self === undefined) return respondMove(409, moveReason("unknown-task"));
        if (self.taken) return respondMove(409, moveReason("claimed"));
        const partition = snapshot.filter(
          one => one.repo === ref.repo && one.assignedRunner === ref.assignedRunner && !one.taken,
        );
        const front = partition[0];
        if (front === undefined) return respondMove(409, moveReason("unknown-task"));
        if (front.id === taskId) {
          // Already the front: a no-op, but only against the revision the
          // form was rendered with — this branch never reaches moveTask()'s
          // CAS, so the check is made here.
          if (!Number.isSafeInteger(revisionGiven) || revisionGiven !== store.queueRevision()) {
            return respondMove(409, moveReason("stale"));
          }
          return respondMove(200, "already at the front");
        }
        beforeTaskId = front.id;
      }
      const moved = store.moveTask(
        {
          taskId,
          toRunner,
          beforeTaskId,
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
        // The repair-auto grant is the SAME rule (v40): unchecked stays
        // false on every preset — only the explicit box grants it, and the
        // attempt cap it carries is meaningless without it.
        repairAuto: body.get("repair-auto") === "1",
        repairMaxAttempts: body.get("repair-auto") === "1" ? Math.max(0, Math.min(3, Math.floor(Number(body.get("repair-max-attempts") ?? "0")) || 0)) : 0,
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
          ["name", "days", "publication", "auto-approve", "review-auto", "allow-paid-fallback", "repair-auto", "repair-max-attempts"]
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
        return sendScreen(response, 200, screen("mode", bodyHtml, { chrome: chromeFor(project, "mode") }));
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
      const requestedReturn = body.get("return");
      const decisionBack = requestedReturn === "next"
        ? "/next"
        : requestedReturn === null
          ? `/d/${id}`
          : safeChatReturn(requestedReturn);
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
        return refuse(response, who, 400, "an irreversible choice must be confirmed", requestedReturn === null ? `/d/${id}` : `/d/${id}?return=${encodeURIComponent(decisionBack)}`);
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
        return refuse(response, who, status, why, requestedReturn === null ? `/d/${id}` : decisionBack);
      }
      return redirect(response, decisionBack);
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

    const act = matchTaskPath(url.pathname, "/(hold|unhold|requeue|cancel|scope|approve|plan|block|unblock|repair-dependency|next|reopen|steer|follow-up|accept-proof)$");
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
          ? `${projectName(admitted)} is ready — the builder is connecting automatically`
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
      const back = safeChatReturn(body.get("return"));
      const password = body.get("token") ?? "";
      if (password === "" || !authenticateApprover(store, who.name, password).ok) {
        return redirect(response, chatReturnWithSaid(back, "configuring chat spend takes your password, typed again"));
      }
      if (body.get("off") === "1") {
        store.clearChatConfig();
        return redirect(response, chatReturnWithSaid(back, "chat is off — its settings were removed"));
      }
      const forget = body.get("forget-key") ?? "";
      if (forget === "anthropic-api" || forget === "openrouter-api") {
        forgetChatKey(forget);
        return redirect(response, chatReturnWithSaid(back, "the stored key file is gone (an environment variable, if set, still applies)"));
      }
      const provider = body.get("provider") ?? "";
      const requestedModel = (body.get("model") ?? "").trim();
      const weeklyText = (body.get("weekly-usd") ?? "").trim();
      const weekly = Number(weeklyText);
      const daily = (body.get("daily-turns") ?? "").trim() === "" ? 50 : Number(body.get("daily-turns"));
      if (provider !== "anthropic-api" && provider !== "openrouter-api" && provider !== "claude-subscription" && provider !== "codex-subscription") {
        return redirect(response, chatReturnWithSaid(back, "pick a chat provider"));
      }
      const subscription = isSubscriptionChatProvider(provider);
      const model = requestedModel === "" && subscription ? "default" : requestedModel;
      if (!validModelId(model)) {
        return redirect(response, chatReturnWithSaid(back, "the model id must be 1–128 letters, digits, dots, slashes, colons, underscores, or dashes"));
      }
      // The key, when pasted, is stored FIRST (0600 file, Telegram-token
      // precedent) so the catalog fetch below can already use it. It never
      // touches the database and is never echoed back.
      const pastedKey = (body.get("key") ?? "").trim();
      if (pastedKey !== "") {
        if (subscription) return redirect(response, chatReturnWithSaid(back, "subscription chat uses the CLI's cached login — do not paste an API key"));
        const stored = storeChatKey(provider as DirectChatProviderId, pastedKey);
        if (!stored.ok) return redirect(response, chatReturnWithSaid(back, stored.message));
      }
      // The pin: anthropic models come from the compiled table; openrouter
      // models come from OpenRouter's OWN catalog, priced by the authority
      // that will bill them. No price found anywhere = refused, not guessed.
      let pin = subscription ? { inMicrousd: 0, outMicrousd: 0 } : priceOf(model);
      if (provider === "openrouter-api") {
        const catalog = await chatCatalog();
        const hit = catalog?.find(one => one.id === model);
        if (hit !== undefined) pin = hit.price;
      }
      if (!subscription && pin === null) {
        return redirect(response, chatReturnWithSaid(back, provider === "openrouter-api" ? "that model is not in OpenRouter's catalog (or the catalog is unreachable) — chat cannot reserve spend it cannot bound" : "that model has no pinned price — chat cannot reserve spend it cannot bound"));
      }
      if (!subscription && (!Number.isFinite(weekly) || weekly <= 0)) {
        return redirect(response, chatReturnWithSaid(back, "the weekly ceiling is a positive dollar amount — chat without one is unbounded, not configured"));
      }
      if (!Number.isInteger(daily) || daily <= 0 || daily > 1_000) {
        return redirect(response, chatReturnWithSaid(back, "daily turns is a whole number between 1 and 1000"));
      }
      store.setChatConfig(
        {
          provider,
          model,
          dailyTurns: daily,
          weeklyCeilingMicrousd: subscription ? 0 : Math.round(weekly * 1_000_000),
          priceInMicrousd: pin!.inMicrousd,
          priceOutMicrousd: pin!.outMicrousd,
        },
        who.name,
        now,
      );
      return redirect(response, back);
    }

    // ---- the mate (mate arc §5) ------------------------------------------
    if (url.pathname === "/chat/mate/mint") {
      if (who.via !== "cookie") return refuse(response, who, 403, "the mate is a browser surface");
      const back = safeChatReturn(body.get("return"));
      const enabled = chatEnablement();
      if (!enabled.ok) return redirect(response, chatReturnWithSaid(back, enabled.why));
      // The one password ceremony of a conversation (§1): it restates the
      // terms — this spend ceiling, over these projects — and mints the
      // session every later turn debits without asking again.
      const ceilingText = (body.get("ceiling-usd") ?? "").trim();
      const ceilingUsd = enabled.billing === "subscription" ? 0 : Number(ceilingText);
      if (enabled.billing === "metered" && (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0 || ceilingUsd > 1_000)) {
        return redirect(response, chatReturnWithSaid(back, "the session ceiling is a dollar amount between 0 and 1000"));
      }
      const verified = verifyApproverByPassword(store, who.name, body.get("token") ?? "", managedRepos());
      if (!verified.ok) return redirect(response, chatReturnWithSaid(back, "minting a session takes your password, typed again"));
      const ceilingMicrousd = Math.round(ceilingUsd * 1_000_000);
      const termsDigest = createHash("sha256").update(`${ceilingMicrousd}\n${verified.who.ceilingDigest}`).digest("hex");
      store.mintMateSession(
        { approver: who.name, approverGeneration: verified.who.generation, credentialKey: enabled.credentialKey, ceilingMicrousd, ceilingDigest: verified.who.ceilingDigest, termsDigest },
        now,
      );
      store.openMateThread(who.name, verified.who.ceilingDigest, now);
      mateSaid.delete(who.session.csrf);
      return redirect(response, back);
    }
    if (url.pathname === "/chat/mate/end") {
      if (who.via !== "cookie") return refuse(response, who, 403, "the mate is a browser surface");
      const back = safeChatReturn(body.get("return"));
      // Ending spend and forgetting the thread takes no password: any
      // approver may revoke (§1), and the thread is theirs to drop (ruling 11).
      store.failLiveMateTurnsFor(who.name, "ended", now);
      store.endMateSessionsFor(who.name, who.name, now);
      store.closeMateThreadsFor(who.name, now);
      mateSaid.delete(who.session.csrf);
      return redirect(response, back);
    }
    if (url.pathname === "/chat/mate/stop") {
      if (who.via !== "cookie") return refuse(response, who, 403, "the mate is a browser surface");
      const back = safeChatReturn(body.get("return"));
      const wanted = Number(body.get("turn") ?? "");
      const live = store.liveMateTurnFor(who.name);
      if (!Number.isInteger(wanted) || live === null || live.id !== wanted) {
        noteMate(who.session.csrf, null, "that turn has already finished");
        return redirect(response, chatReturnWithLatest(back));
      }
      // A stopped direct-API turn is conservatively charged its reserved
      // worst case: dispatch may already have happened. Membership turns
      // reserve zero. The conversation itself stays live.
      store.failLiveMateTurnsFor(who.name, "stopped", now);
      noteMate(who.session.csrf, live.id, "stopped — the conversation is still open");
      return redirect(response, chatReturnWithLatest(back));
    }
    const mateProposal = /^\/chat\/proposal\/([0-9]{1,15})\/(confirm|dismiss)$/.exec(url.pathname);
    if (mateProposal !== null) {
      if (who.via !== "cookie") return refuse(response, who, 403, "the mate is a browser surface");
      const back = safeChatReturn(body.get("return"));
      const principal = matePrincipal(who);
      if (principal === null) return refuse(response, who, 403, "your approver standing changed — sign in again", back);
      const id = Number(mateProposal[1]);
      if (mateProposal[2] === "dismiss") {
        if (!dismissMateProposal(store, principal, id, now)) noteMate(who.session.csrf, null, "that proposal was already acted on");
        return redirect(response, chatReturnWithLatest(back));
      }
      const outcome = confirmMateProposal(store, principal, id, now, { confirm: body.get("confirm") === "yes", via: "web" });
      if (!outcome.ok && (outcome.reason === "not-yours" || outcome.reason === "standing")) {
        return refuse(response, who, outcome.reason === "standing" ? 403 : 404, outcome.said, back);
      }
      if (!outcome.ok && outcome.reason === "needs-confirm") noteMate(who.session.csrf, null, outcome.said);
      return redirect(response, chatReturnWithLatest(back));
    }
    // Coordinator proposals (mate arc v3): confirmed by any approver whose
    // ceiling admits the repo; the card lives on /chat and on the task.
    const coordinatorProposal = /^\/proposals\/([0-9]{1,15})\/(confirm|dismiss)$/.exec(url.pathname);
    if (coordinatorProposal !== null) {
      if (who.via !== "cookie") return refuse(response, who, 403, "proposals are confirmed from the browser or the CLI");
      const principal = matePrincipal(who);
      if (principal === null) return refuse(response, who, 403, "your approver standing changed — sign in again", "/chat");
      const id = Number(coordinatorProposal[1]);
      store.sweepCoordinatorProposals(now);
      const back = body.get("return") === null ? "/chat" : safeReturn(body.get("return"));
      if (coordinatorProposal[2] === "dismiss") {
        dismissCoordinatorProposal(store, principal, id, now);
        return redirect(response, back);
      }
      const outcome = confirmCoordinatorProposal(store, principal, id, now, { confirm: body.get("confirm") === "yes", via: "web" });
      if (!outcome.ok && (outcome.reason === "not-yours" || outcome.reason === "standing")) {
        return refuse(response, who, outcome.reason === "standing" ? 403 : 404, outcome.said, back);
      }
      return redirect(response, outcome.ok || outcome.reason !== "needs-confirm" ? back : `${back}${back.includes("?") ? "&" : "?"}said=${encodeURIComponent(outcome.said)}`);
    }

    if (url.pathname === "/chat") {
      if (who.via !== "cookie") return refuse(response, who, 403, "chat is a browser surface");
      const requestedTask = body.get("task");
      const focusTask = taskChatFocus(requestedTask, now);
      if (requestedTask !== null && focusTask === null) {
        return redirect(response, chatReturnWithSaid("/chat", "That task is not available in this workspace."));
      }
      const back = focusTask === null ? "/chat" : taskChatHref(focusTask.id);
      const enabled = chatEnablement();
      if (!enabled.ok) return redirect(response, chatReturnWithSaid(back, enabled.why));
      // A live mate session: the message is a mate turn — no password, the
      // session's ceremony already covered it (§1); the engine refuses on
      // its own terms and the thread shows why.
      const mateSession = who.role === "approver" ? store.activeMateSession(who.name) : null;
      if (mateSession !== null) {
        const principal = matePrincipal(who);
        if (principal === null) return refuse(response, who, 403, "your approver standing changed — sign in again", back);
        const message = (body.get("message") ?? "").trim();
        if (message === "" || message.length > MATE_MESSAGE_MAX_CHARS) {
          return redirect(response, chatReturnWithSaid(back, `a message is 1 to ${MATE_MESSAGE_MAX_CHARS} characters`));
        }
        const opened = store.openMateThread(who.name, principal.ceilingDigest, now);
        void runMateTurn({ store, who: principal, session: mateSession, thread: opened.thread, config: enabled.config, key: enabled.key, message, ...(focusTask === null ? {} : { context: `Current task: ${focusTask.id}. Read it with get_task before answering or proposing changes. Keep this turn about that task unless the operator explicitly asks to broaden it.` }), fetcher: chatFetcher, ...(options.subscriptionChatRunner === undefined ? {} : { subscriptionRunner: options.subscriptionChatRunner }), clock, evidenceRoot })
          .then(outcome => {
            if (!outcome.ok) noteMate(who.session.csrf, "turn" in outcome ? outcome.turn : null, outcome.message);
          })
          .catch(() => noteMate(who.session.csrf, null, "the turn failed unexpectedly"));
        return redirect(response, chatReturnWithLatest(back));
      }
      if (focusTask !== null) {
        return redirect(response, chatReturnWithSaid(back, "Start the conversation first, then ask about this task without another password prompt."));
      }
      if (enabled.billing === "subscription") {
        return redirect(response, `/chat?said=${encodeURIComponent("start the conversation first — the one password ceremony opens the subscription-backed session")}`);
      }
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
      const turnRepos = managedRepos();
      const snapshot = withDispatchDiagnoses(store, store.chatSnapshot(turnRepos, now), now);
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
      void runChatTurn(opened.id, who.session, enabled, message, document, turnRepos);
      return redirect(response, "/chat#latest");
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
      const acceptanceFields = candidate.draft.acceptance.flatMap(c => [c.statement, ...(c.how === null ? [] : [c.how])]);
      const fields = candidate.draft.kind === "task"
        ? [candidate.draft.title, candidate.draft.goal, candidate.draft.outOfScope ?? "", ...candidate.draft.touches, ...acceptanceFields]
        : [candidate.draft.name, candidate.draft.goal, candidate.draft.outOfScope ?? "", ...candidate.draft.touches, ...acceptanceFields];
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
            acceptance: candidate.draft.acceptance,
            filedVia,
            admittedRepos: managedRepos(),
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
          acceptance: candidate.draft.acceptance,
          requirements: [],
          schedule: candidate.draft.schedule,
          costCeilingUsd: null,
          filedVia,
          admittedRepos: managedRepos(),
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
          acceptance: acceptanceLinesToInput((body.get("acceptance") ?? "").split("\n")),
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
        return refuse(response, who, 400, "add at least one annotation before creating a revision", `/r/${id}`);
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
            title: `Revise ${sourceTaskId} from ${comments.length} annotation${comments.length === 1 ? "" : "s"} on build #${id}`,
            ...(repo === null ? {} : { repo }),
            goal:
              `${sourceScope?.goal ?? `revise ${sourceTaskId}`}` +
              ` — apply the annotations recorded on build #${id}; the revision brief carries the exact batch`,
            outOfScope: sourceScope?.outOfScope ?? null,
            touches: sourceScope?.touches ?? [],
            acceptance: sourceScope !== null && sourceScope.acceptance.length > 0
              ? sourceScope.acceptance
              : [{ id: "c1", statement: "The operator has reviewed this revision and written a real rubric before approving it.", how: null, evidence: ["manual-review"] as const }],
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
            // A false answer here is the coordinator quarantine (review
            // finding 7): the revision stays honestly unapproved and the
            // task page it redirects to says so in the quarantine words.
            void store.sealScopeApproval(result.id, who.name, now, {}, { kind: "mode", modeDigest: coverage.digest });
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
            acceptance: sourceScope !== null && sourceScope.acceptance.length > 0
              ? sourceScope.acceptance
              : [{ id: "c1", statement: "The operator has reviewed this revision and written a real rubric before approving it.", how: null, evidence: ["manual-review"] as const }],
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
      inputs.posture === "bypassPermissions"
        ? ("bypassPermissions" as const)
        : inputs.posture === "auto"
          ? ("auto" as const)
          : inputs.posture === "acceptEdits"
            ? ("acceptEdits" as const)
            : null;
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
            : profile?.permissionArgv === "auto"
              ? "safe unattended permissions — routine project commands and edits proceed; risky acts stop"
              : "legacy acceptEdits — edits proceed, commands that ask are denied unattended";
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
      case "repair-dependency": {
        const blocker = (body.get("blocker") ?? "").trim();
        const operation = (body.get("operation") ?? "").trim();
        const blockerTask = blocker === "" || !store.blockers(taskId).includes(blocker) ? null : store.getTask(blocker);
        if (blockerTask === null || (blockerTask.state !== "failed" && blockerTask.state !== "cancelled")) {
          return taskScreen(response, who, taskId, "what this task waits for changed — refresh the page and choose again", 409);
        }
        if (store.openContestFor(ref.id) !== null) {
          return taskScreen(response, who, taskId, "a tournament is running on this task — let it finish before changing its dependencies", 409);
        }
        if (operation === "retry") {
          const blockerRef = store.lookupRef(blocker);
          if (blockerTask.state !== "failed" || blockerRef === null || !visible(blockerRef.repo)) {
            return taskScreen(response, who, taskId, "that failed task cannot be tried again here — wait for a different task or continue without it", 409);
          }
          const retried = store.requeueTask(blocker, who.name, now);
          if (!retried.ok) return taskScreen(response, who, taskId, `that task could not be queued again — ${retried.reason}`, 409);
          return redirect(response, taskHref(taskId));
        }
        if (operation === "unlink") {
          const removed = store.removeEdge(taskId, blocker);
          if (!removed.ok) return taskScreen(response, who, taskId, "what this task waits for changed — refresh the page and choose again", 409);
          return redirect(response, taskHref(taskId));
        }
        if (operation === "replace") {
          const replacement = (body.get("replacement") ?? "").trim();
          const replacementTask = replacement === "" ? null : store.getTask(replacement);
          const replacementRef = replacement === "" ? null : store.lookupRef(replacement);
          if (
            replacementTask === null ||
            replacementRef === null ||
            !visible(replacementRef.repo) ||
            (replacementTask.state !== "queued" && replacementTask.state !== "running")
          ) {
            return taskScreen(response, who, taskId, "choose another unfinished task from a project you can manage", 409);
          }
          const replaced = store.replaceEdge(taskId, blocker, replacement);
          if (!replaced.ok) return taskScreen(response, who, taskId, `this task could not wait for the selected work — ${replaced.reason}`, 409);
          return redirect(response, taskHref(taskId));
        }
        return taskScreen(response, who, taskId, "choose whether to try that task again, wait for a different task, or continue without it", 400);
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
      case "follow-up": {
        // A scout's proposed follow-up, filed by the operator's tap (mate
        // arc §10): the ONE filing door, this task's repository, the scope
        // text stamped as the scout's — mode coverage never seals it.
        const indexRaw = body.get("index") ?? "";
        if (!/^[0-9]{1,2}$/.test(indexRaw)) return taskScreen(response, who, taskId, "which follow-up?", 400);
        const view = readVerifiedReport(store, evidenceRoot, ref.id);
        if (view === null || !view.ok) return taskScreen(response, who, taskId, "this task has no report to file from", 409);
        const followUp = view.report.followUps[Number(indexRaw)];
        if (followUp === undefined) return taskScreen(response, who, taskId, "the report proposes no such follow-up", 409);
        if (ref.repo === null) return taskScreen(response, who, taskId, "this task has no repository — file the follow-up by hand", 409);
        if (!visible(ref.repo)) return taskScreen(response, who, taskId, "that repository is outside what this server shows", 403);
        // Idempotent by construction (v4 review, finding 10): the filing's
        // id is derived from the source task, the report's run, and the
        // follow-up's place — a retried POST lands on the task the first
        // one filed instead of minting a twin.
        const followUpId = `${taskId.slice(0, 40)}-r${view.run}-f${Number(indexRaw) + 1}`;
        if (store.getTask(followUpId) !== null) return redirect(response, taskHref(followUpId));
        const filed = fileTaskProposal(
          store,
          {
            id: followUpId,
            title: followUp.title,
            repo: ref.repo,
            goal: followUp.goal,
            // v39: the scout's report format does not yet draft a rubric
            // per follow-up — a placeholder names the operator's own
            // review as the outstanding work, the same posture a
            // coordinator's bare intent takes.
            acceptance: [
              { id: "c1", statement: "The operator has reviewed this follow-up and written a real rubric before approving it.", how: null, evidence: ["manual-review"] },
            ],
            filedVia: "console",
            proposedVia: "scout",
            ...(unscopedMode ? {} : { admittedRepos: admissionList() ?? [] }),
          },
          now,
        );
        if (!filed.ok) {
          if (filed.reason === "duplicate") return redirect(response, taskHref(followUpId));
          return taskScreen(response, who, taskId, `not filed: ${filed.message}`, filed.reason === "backlog-full" ? 429 : 400);
        }
        return redirect(response, taskHref(filed.id));
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
        const permissionGiven = body.get("permission-mode");
        if (permissionGiven !== null && permissionGiven !== "" && permissionGiven !== "auto" && permissionGiven !== "bypassPermissions") {
          return taskScreen(response, who, taskId, "permissions must be Auto or Full access", 400);
        }
        const permissionMode: UnattendedPermissionMode =
          permissionGiven === "bypassPermissions"
            ? "bypassPermissions"
            : permissionGiven === "auto"
              ? "auto"
              : ref.permissionMode ?? store.permissionDefault().mode;
        const qualityGiven = body.get("quality-mode");
        if (qualityGiven !== null && qualityGiven !== "" && !isQualityMode(qualityGiven)) {
          return taskScreen(response, who, taskId, "quality must be Default or Strict / release", 400);
        }
        const qualityMode: QualityMode =
          qualityGiven === "strict"
            ? "strict"
            : qualityGiven === "default"
              ? "default"
              : ref.qualityMode ?? store.qualityDefault().mode;
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
            permissionMode,
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
            agents: Array.from({ length: count }, () => ({ provider: "claude", model, permissionMode })),
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
            acceptance: acceptanceLinesToInput((body.get("acceptance") ?? "").split("\n")),
            permissionMode,
            qualityMode,
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
              const sealedUnderMode = store.sealScopeApproval(taskId, who.name, now, {}, { kind: "mode", modeDigest: coverage.digest });
              // The quarantine speaks at the caller (review finding 7).
              if (!sealedUnderMode) {
                return { ok: false, status: 200, message: "scope saved — coordinator-filed: mode coverage cannot admit it; sign the scope" };
              }
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
        const requestedReturn = body.get("return");
        const approvalBack = requestedReturn === "next"
          ? "/next"
          : requestedReturn === null
            ? taskHref(taskId)
            : safeChatReturn(requestedReturn);
        const approvalProblem = (message: string, status: number): void => {
          if (requestedReturn !== null && requestedReturn !== "next") {
            return redirect(response, chatReturnWithSaid(approvalBack, message));
          }
          return taskScreen(response, who, taskId, message, status);
        };
        const approvingRef = store.lookupRef(taskId);
        if (approvingRef?.plan === "requested") {
          return approvalProblem(
            "approval is blocked while planning is in progress — review the drafted plan first",
            409,
          );
        }
        // Step-up: the session got you here; only the token agrees. The
        // digest names what was seen; the nonce proves this exact form was
        // rendered to this approver and is spent either way.
        const digest = body.get("digest") ?? "";
        const token = body.get("token") ?? "";
        if (who.via === "cookie") {
          const nonce = body.get("nonce") ?? "";
          if (!consumeApprovalNonce(nonce, who.name, taskId, digest)) {
            return approvalProblem("that approval form is stale — read it again", 409);
          }
        }
        if (token === "") {
          return approvalProblem("approval requires your password, typed again", 400);
        }
        // A revision approves ONLY against a brief that still verifies
        // (Codex M5-M8 audit, IV-3): the batch the screen restated must be
        // provably the batch on disk at the moment of the yes — a brief
        // deleted or corrupted between render and click blocks the
        // approval instead of silently approving comment-free work.
        if (approvingRef !== null && approvingRef.revisionBriefArtifact !== null) {
          const view = revisionViewOf(approvingRef);
          if (view !== null && "problem" in view) {
            return approvalProblem(`approval is blocked: ${view.problem}`, 409);
          }
        }
        // A tournament task's yes covers BOTH documents (finding 31): the
        // form bound the joint fingerprint, and the scope and race terms
        // approve together, in one transaction, or not at all.
        const raceTerms = store.activeTournamentTerms(ref.id);
        if (raceTerms !== null) {
          const scopeRow = store.getScope(taskId);
          if (scopeRow === null || digest !== jointApprovalDigest(scopeRow.digest, raceTerms.raceDigest)) {
            return approvalProblem("this task races a tournament — the form was stale; read it again", 409);
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
            return approvalProblem(`not approved: ${both.reason}`, status);
          }
          return redirect(response, approvalBack);
        }
        const approved = approveScope(store, taskId, who.name, now, digest, token);
        if (!approved.ok) {
          const status = approved.reason === "changed" ? 409 : 403;
          return approvalProblem(`not approved: ${approved.reason}`, status);
        }
        return redirect(response, approvalBack);
      }
      case "accept-proof": {
        // Accepting is a person's act, like approving a scope (Priority
        // 2): a cookie session only, never a bearer credential.
        if (who.via !== "cookie") {
          return refuse(response, who, 403, "accepting a proof is a browser session's act");
        }
        // v40 fix: a reviewer run is never the attempt whose proof is
        // being accepted.
        const latest = store.runsFor(ref.id).find(one => one.finishedAt !== null && one.role !== "reviewer");
        if (latest === undefined) {
          return taskScreen(response, who, taskId, "this task has no finished attempt to accept", 404);
        }
        const rawNote = (body.get("note") ?? "").trim();
        let note: string | null = null;
        if (rawNote !== "") {
          const validated = validateNote(rawNote);
          if (!validated.ok) {
            return taskScreen(response, who, taskId, validated.problem, 400);
          }
          note = validated.note;
        }
        store.acceptProof(latest.id, verifiedAuthor(who.name), note, now);
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

  /** The queue as a region: dispatch order per column, drag handles and
   * all — the /queue page's body, and the board's "order" view (the one
   * place dragging exists, because reordering and reserving are scheduling,
   * never authority). */
  function queueRegionFor(project: string | null, csrf: string, revision: number, now: Date): string {
    const tasks = store.queueScoped(project, now).map(one => ({
      ...one,
      dispatch: diagnoseTaskDispatch(store, one.id, now),
    }));
    const owned = new Set(tasks.map(one => one.assignedRunner).filter((one): one is string => one !== null));
    const building = new Map<string, number>();
    for (const claim of store.liveClaims(project, now)) {
      building.set(claim.runner, (building.get(claim.runner) ?? 0) + 1);
    }
    const workers = store
      .listRunners()
      .filter(one => one.retiredAt === null || owned.has(one.name))
      .map(one => ({
        name: one.name,
        retired: one.retiredAt !== null,
        note: one.queueNote ?? null,
        capacity: one.capacity,
        building: building.get(one.name) ?? 0,
      }));
    return queueBody(tasks, workers, csrf, revision, store.queueRevision());
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
    // A validated screenshot is the one evidence kind meant to render
    // inline (thumbnails, full-image links) — every other kind stays a
    // downloaded text record, exactly as before.
    if (linked.kind === "screenshot") {
      const imageType = linked.key.endsWith(".png") ? "image/png" : linked.key.endsWith(".jpg") ? "image/jpeg" : null;
      if (imageType !== null) {
        response.writeHead(200, { ...SAFETY, "Content-Type": imageType, "Cache-Control": "private, max-age=31536000, immutable" });
        response.end(read.content);
        return;
      }
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
  if (summary.measured.some(run => run.authMode === "subscription")) return spendLine(summary);
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
    "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; manifest-src 'self'; worker-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;

function respond(response: ServerResponse, status: number, type: string, body: string): void {
  // A route that set its OWN policy (the service worker's default-src
  // 'none') or its own caching (the pre-auth assets) keeps it —
  // writeHead's headers would otherwise win.
  const own = response.getHeader("content-security-policy");
  const cache = response.getHeader("cache-control");
  response.writeHead(status, {
    ...SAFETY,
    ...(own === undefined ? {} : { "content-security-policy": own as string }),
    ...(cache === undefined ? {} : { "Cache-Control": cache as string }),
    "Content-Type": type,
  });
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
      `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; manifest-src 'self'; worker-src 'self'; img-src 'self'; script-src 'nonce-${nonce}'; ` +
      // connect-src only when the page's script actually fetches (a region
      // poller, the full chrome beat, or the minimal sensitive-page beat).
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
      `<h1>request refused</h1>`,
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
/** The state badges the criterion-to-evidence matrix renders with — one
 * shared vocabulary, so a "failed" row reads the same shade of trouble on
 * the task page, the run page, the board, done, builds, the inbox, and
 * chat (v39, extending Priority 2's "one surface, six places" rule from
 * the verdict word to the per-criterion state). */
function matrixStateBadge(state: CriterionMatrixRow["state"]): string {
  const cls = state === "pass" ? "badge-done" : state === "failed" ? "badge-failed" : state === "missing" ? "badge-failed" : "badge-manual-review";
  const word = state === "pass" ? "pass" : state === "missing" ? "missing" : state === "failed" ? "failed" : "manual review";
  return `<span class="badge ${cls}" data-matrix-state="${escape(state)}">${escape(word)}</span>`;
}

/** v40: the bounded repair chain's own line — one card, one chain, the
 * criterion-by-criterion trajectory named plainly. Renders on the task
 * page and the run page identically (the shared-surface rule, extended). */
function repairChainHtml(chain: RepairChainRow | null): string {
  if (chain === null) return "";
  const basisWords = chain.basis === "mode" ? "a signed mode auto-approved" : "awaiting your approval";
  const unresolvedWords = chain.unresolved.length === 0 ? "" : ` (${chain.unresolved.join(", ")})`;
  const outcomeWords =
    chain.outcome === "drafted"
      ? `attempt ${chain.attempt}, ${chain.draftTask === null ? "no draft" : basisWords}`
      : chain.outcome === "resolved"
        ? `resolved at attempt ${chain.attempt} — the chain is closed`
        : chain.outcome === "attempts-spent"
          ? `stopped: the signed attempt cap is spent at attempt ${chain.attempt}`
          : chain.outcome === "no-progress"
            ? `stopped: two consecutive attempts made no progress (attempt ${chain.attempt})`
            : `stopped: attempt ${chain.attempt} refused automatic repair — an altered term, not a gap; a human should look`;
  const link = chain.draftTask === null ? "" : ` <a href="${taskHref(chain.draftTask)}">${escape(chain.draftTask)}</a>`;
  return `<div class="card repair-chain" data-repair-outcome="${escape(chain.outcome)}"><p class="row"><strong>repair chain</strong> — ${escape(outcomeWords)}${escape(unresolvedWords)}${link}</p></div>`;
}

/** v40: the independent reviewer's own judgement on one criterion — a
 * SECOND badge beside the machine's own matrixStateBadge, never a
 * replacement for it, so a render can say "the machine attested it;
 * reviewer:codex contradicted c2" instead of pretending the machine
 * always disagreed. Reuses the matrix's own three badge colors (done /
 * failed / manual-review) rather than inventing a fourth vocabulary —
 * `contradicts` reads exactly as alarming as `failed` already does. */
function reviewJudgementBadge(review: CriterionMatrixRow["review"]): string {
  if (review === null) return "";
  const cls = review.judgement === "upholds" ? "badge-done" : review.judgement === "contradicts" ? "badge-failed" : "badge-manual-review";
  const word = review.judgement === "upholds" ? "upheld" : review.judgement === "contradicts" ? "contradicted" : "uncertain";
  return ` <span class="badge ${cls}" data-review-judgement="${escape(review.judgement)}" title="${escape(review.author)}: ${escape(review.note)}">reviewer: ${escape(word)}</span>`;
}

/** A one-line summary of the matrix for list rows too dense for the full
 * table (done, builds, board, inbox) — "2/3 criteria", plus a worst-state
 * badge so trouble is visible without opening the row. `[]` renders
 * nothing. */
function criterionMatrixSummary(matrix: readonly CriterionMatrixRow[]): string {
  if (matrix.length === 0) return "";
  const { passed, total } = passFraction(matrix);
  const worst = matrix.some(row => row.state === "missing" || row.state === "failed")
    ? "failed"
    : matrix.some(row => row.state === "manual-review")
      ? "manual-review"
      : "pass";
  return worst === "pass"
    ? ` <span class="badge badge-done">${passed}/${total} criteria</span>`
    : `${matrixStateBadge(worst)} <span class="badge">${passed}/${total} criteria</span>`;
}

/** Where a criterion's own typed evidence ref resolves to a stored
 * artifact, keyed `${kind}:${ref}` — built once per run from its
 * artifacts (v39 review finding: "link artifacts where possible"). A
 * `changed-path` ref never gets its own per-file artifact, so every one of
 * those shares the single terminal-diff patch, under the wildcard key. A
 * `manual-review` ref never resolves — it names nothing machine-checkable. */
type EvidenceLinkMap = ReadonlyMap<string, number>;
const CHECK_LOG_CAPTURE = /^sh -c "(.+)" \(exit \d+(?:, timed out)?\)$/;
function evidenceLinksFor(artifacts: readonly Artifact[]): EvidenceLinkMap {
  const map = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.kind === "screenshot") {
      const path = SCREENSHOT_CAPTURE.exec(artifact.capture)?.[1];
      if (path !== undefined) map.set(`screenshot:${path}`, artifact.id);
    } else if (artifact.kind === "check-log") {
      const command = CHECK_LOG_CAPTURE.exec(artifact.capture)?.[1];
      if (command !== undefined) map.set(`check:${command}`, artifact.id);
    } else if (artifact.kind === "terminal-diff") {
      map.set("changed-path:*", artifact.id);
    }
  }
  return map;
}

/** The shared criterion-to-evidence matrix — one table, rendered
 * identically everywhere a build's result appears (v39). `[]` renders
 * nothing: a grandfathered run's result card is unchanged. `compact`
 * drops the per-row detail line, for surfaces that only have room for a
 * summary (board, inbox, chat, builds list). Each row also names the
 * proof's OWN answered evidence refs, not only the required kinds (review
 * finding) — linked to the underlying artifact when `runId`/`links` are
 * given and a link resolves; plain text otherwise. */
function criterionMatrixHtml(
  matrix: readonly CriterionMatrixRow[],
  options: { compact?: boolean; runId?: number; links?: EvidenceLinkMap } = {},
): string {
  if (matrix.length === 0) return "";
  const compact = options.compact === true;
  const answeredHtml = (row: CriterionMatrixRow): string => {
    const answered = row.answered ?? [];
    if (answered.length === 0) return "";
    const items = answered.map((a: CriterionEvidenceRef) => {
      const text = `${escape(a.kind)}: ${escape(a.ref)}`;
      const artifactId = options.links?.get(`${a.kind}:${a.ref}`) ?? (a.kind === "changed-path" ? options.links?.get("changed-path:*") : undefined);
      return artifactId !== undefined && options.runId !== undefined
        ? `<a href="/r/${options.runId}/evidence/${artifactId}">${text}</a>`
        : text;
    });
    return ` <span class="meta">[answered: ${items.join(", ")}]</span>`;
  };
  return (
    `<div class="result-section criterion-matrix"><strong>acceptance</strong><ul>` +
    matrix
      .map(
        row =>
          `<li>${matrixStateBadge(row.state)}${reviewJudgementBadge(row.review)} <code>${escape(row.id)}</code> ${escape(row.statement)}` +
          ` <span class="meta">[requires: ${row.requiredEvidence.map(escape).join(", ")}]</span>` +
          answeredHtml(row) +
          (compact || row.detail.length === 0 ? "" : `<br><span class="meta">${row.detail.map(escape).join("; ")}</span>`) +
          `</li>`,
      )
      .join("") +
    `</ul></div>`
  );
}

/** The rubric, restated above the seal (v39) — the same claim the digest
 * line already makes ("approval binds to this exact wording") extended to
 * the acceptance terms: an id in Plex Mono (a machine fact the proof must
 * answer by), a statement in Plex Sans, the signed evidence kinds after
 * it. `how` never renders here — it is advisory, never signed. Empty
 * renders nothing: a grandfathered scope's ceremony is unchanged. */
function acceptanceCeremonyHtml(criteria: readonly AcceptanceCriterion[]): string {
  if (criteria.length === 0) return "";
  return (
    `<p class="meta">acceptance</p><ul class="recap acceptance-rubric">` +
    criteria
      .map(
        c =>
          `<li><code>${escape(c.id)}</code> ${escape(c.statement)} <span class="meta">[requires: ${c.evidence.map(escape).join(", ")}]</span></li>`,
      )
      .join("") +
    `</ul>`
  );
}

function profileWords(scope: Pick<Scope, "profile" | "profileState" | "unresolvedReason" | "digestVersion" | "proposedChainJson">): string {
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
  const base =
    profile.provider === "claude"
      ? `<p class="meta">runs on <span class="mono">claude · ${escape(profile.model)}</span> — ${
          profile.permissionArgv === "bypassPermissions"
            ? "FULL permissions; claude runs with --dangerously-skip-permissions and nothing asks"
            : profile.permissionArgv === "auto"
              ? "safe unattended permissions; routine project commands and edits proceed, risky acts stop"
              : "legacy acceptEdits; edits proceed, commands that ask are denied unattended"
        }, ${profile.maxTurns}-turn runaway breaker, ${Math.round(profile.timeoutSeconds / 60)} min ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}; repairs on ${escape(repair)}, ${profile.repairMaxTurns} turns / ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`
      : profile.provider === "gemini"
        ? `<p class="meta">runs on <span class="mono">gemini · ${escape(profile.model)}</span> — ${profile.approvalArgv === "yolo" ? "Full access via --approval-mode yolo; every tool auto-approved" : "Auto via --approval-mode auto_edit; edits auto-approved, other tools refused"}, no turn limit (${Math.round(profile.timeoutSeconds / 60)} min ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}), spend reported in tokens only; repairs on ${escape(repair)}, ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`
        : `<p class="meta">runs on <span class="mono">${escape(profile.provider)} · ${escape(profile.model)}</span> — ${profile.sandboxMode === "danger-full-access" ? "FULL permissions via --dangerously-bypass-approvals-and-sandbox; nothing asks" : "workspace-write sandbox"}, no turn limit (${Math.round(profile.timeoutSeconds / 60)} min ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}); repairs on ${escape(repair)}, ${Math.round(profile.repairTimeoutSeconds / 60)} min</p>`;
  // The fallback chain rides EVERY surface these words sign (F+G review,
  // finding 2): the digest binds the whole chain, so the password form —
  // task page and /next alike — states every entry, credential included.
  const chain = chainFromJson(scope.proposedChainJson ?? null);
  const chainLine =
    chain === null || chain.length < 2
      ? ""
      : `<p class="meta">if its subscription runs out: ${chain
          .slice(1)
          .map(
            one =>
              `falls back to <span class="mono">${escape(one.profile.provider)} · ${escape(one.profile.model)}</span> — ${
                one.authMode === "api-key" ? "your API key; spend moves to that account" : "its subscription login"
              }`,
          )
          .join("; ")}</p>`;
  return base + chainLine;
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
 * The Operations Ledger: the design system Alex approved in Figma and the
 * design/ shadcn package, carried as pure CSS on server-rendered HTML.
 * Deliberately not the React library: the console ships zero dependencies
 * and zero page JavaScript under a CSP that forbids scripts, and a look is
 * not worth that posture. The same semantic tokens render both system light
 * and dark themes.
 */
const STYLE = `
/* The Console — the design system, v3 (2026-09-06). Quiet operational density
   now sits on a softer, glass-backed shell: translucent layers, generous
   radii, and light caught only at the edges. Amber still means "waits on you"
   and nothing else; blue means live. Zero dependencies, zero page JS beyond
   the nonce'd chrome layer. IBM Plex stays the product's own voice. */
  @font-face {
    font-family: "IBM Plex Sans"; font-style: normal; font-weight: 400;
    font-display: swap; src: url("/fonts/plex-sans-400.woff2") format("woff2");
  }
  @font-face {
    font-family: "IBM Plex Sans"; font-style: normal; font-weight: 500;
    font-display: swap; src: url("/fonts/plex-sans-500.woff2") format("woff2");
  }
  @font-face {
    font-family: "IBM Plex Sans"; font-style: normal; font-weight: 600;
    font-display: swap; src: url("/fonts/plex-sans-600.woff2") format("woff2");
  }
  @font-face {
    font-family: "IBM Plex Mono"; font-style: normal; font-weight: 400;
    font-display: swap; src: url("/fonts/plex-mono-400.woff2") format("woff2");
  }
  @font-face {
    font-family: "IBM Plex Mono"; font-style: normal; font-weight: 500;
    font-display: swap; src: url("/fonts/plex-mono-500.woff2") format("woff2");
  }
  @font-face {
    font-family: "IBM Plex Mono"; font-style: normal; font-weight: 600;
    font-display: swap; src: url("/fonts/plex-mono-600.woff2") format("woff2");
  }
  :root {
    color-scheme: light dark;
    /* Dark: the after-hours scene. A true neutral ramp with a whisper of
     * cool, Vercel's grays with Linear's temperature. */
    --background: #0b0c0e;
    --foreground: #ededef;
    --card: #121316;
    --muted: #1a1c20;
    --muted-foreground: #8b919c;
    --border: #24272d;
    --input: #3a3e46;
    --primary: #ededef;
    --primary-foreground: #0b0c0e;
    --secondary: #1a1c20;
    --secondary-foreground: #ededef;
    --accent: #1a1c20;
    --destructive: #f06a5e;
    --destructive-strong: #f06a5e;
    --destructive-soft: color-mix(in srgb, #f06a5e 12%, transparent);
    --success: #3ecf8e;
    --success-soft: color-mix(in srgb, #3ecf8e 12%, transparent);
    --warning: #f5a524;
    --warning-soft: color-mix(in srgb, #f5a524 12%, transparent);
    --running: #52a8ff;
    --running-soft: color-mix(in srgb, #52a8ff 12%, transparent);
    --ring: #52a8ff;
    /* amber — the one accent; it marks what waits on a person, only. */
    --brand: #f5a524;
    --brand-foreground: #201503;
    --brand-soft: color-mix(in srgb, #f5a524 12%, transparent);
    --radius: 0.875rem;
    --glass: rgb(18 20 25 / .72);
    --glass-strong: rgb(20 22 28 / .9);
    --glass-border: rgb(255 255 255 / .085);
    --glass-highlight: rgb(255 255 255 / .045);
    --ambient-one: rgb(113 92 255 / .14);
    --ambient-two: rgb(50 145 255 / .09);
    --user-message: #292c35;
    --surface: var(--glass);
    --ok: var(--success);
    --danger: var(--destructive);
    --fg-muted: var(--muted-foreground);
    --shadow: 0 1px 2px rgb(0 0 0 / .18), 0 10px 30px -22px rgb(0 0 0 / .8);
    --shadow-overlay: 0 18px 70px -28px rgb(0 0 0 / .8), 0 1px 0 var(--glass-highlight) inset;
    --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root {
      /* Light: a phone in daylight, a laptop by a window. Paper ground,
       * white surfaces, the same names; every status hue re-picked to hold
       * 4.5:1 as text on white. */
      --background: #fafafa;
      --foreground: #171717;
      --card: #ffffff;
      --muted: #f1f2f4;
      --muted-foreground: #64697a;
      --border: #e4e5e9;
      --input: #c4c7cf;
      --primary: #171717;
      --primary-foreground: #fafafa;
      --secondary: #f1f2f4;
      --secondary-foreground: #171717;
      --accent: #f1f2f4;
      --destructive: #d1332e;
      --destructive-strong: #d1332e;
      --destructive-soft: color-mix(in srgb, #d1332e 10%, transparent);
      --success: #118a4f;
      --success-soft: color-mix(in srgb, #118a4f 10%, transparent);
      --warning: #a15c00;
      --warning-soft: color-mix(in srgb, #f5a524 14%, transparent);
      --running: #0b6fd6;
      --running-soft: color-mix(in srgb, #0b6fd6 10%, transparent);
      --ring: #0b6fd6;
      --brand: #a15c00;
      --brand-foreground: #ffffff;
      --brand-soft: color-mix(in srgb, #f5a524 16%, transparent);
      --glass: rgb(255 255 255 / .72);
      --glass-strong: rgb(255 255 255 / .9);
      --glass-border: rgb(23 23 23 / .09);
      --glass-highlight: rgb(255 255 255 / .75);
      --ambient-one: rgb(115 88 255 / .10);
      --ambient-two: rgb(45 141 255 / .08);
      --user-message: #202124;
      --shadow: 0 1px 2px rgb(0 0 0 / .04), 0 12px 32px -24px rgb(21 24 36 / .24);
      --shadow-overlay: 0 18px 60px -28px rgb(28 33 48 / .3), 0 1px 0 var(--glass-highlight) inset;
    }
  }
  * { box-sizing: border-box; }
  ::selection { background: color-mix(in srgb, var(--running) 30%, transparent); }
  ::placeholder { color: var(--muted-foreground); }
  body {
    margin: 0; color: var(--foreground);
    background:
      radial-gradient(circle at 20% -10%, var(--ambient-one), transparent 30rem),
      radial-gradient(circle at 86% 18%, var(--ambient-two), transparent 34rem),
      var(--background);
    background-attachment: fixed;
    caret-color: var(--foreground);
    font: 400 0.875rem/1.5 var(--font-sans);
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

  /* Scrollbars belong to the theme, not the platform default. */
  * { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }

  .topbar {
    position: sticky; top: 0; z-index: 10;
    border-bottom: 1px solid var(--border); background: var(--background);
  }
  .topbar-inner {
    max-width: 44rem; margin-inline: auto; padding: 0 1.25rem; height: 3.25rem;
    display: flex; align-items: center; gap: 1.25rem;
  }
  .brand { font-weight: 600; letter-spacing: -0.01em; color: var(--foreground); text-decoration: none;
           display: flex; align-items: center; height: 100%; }
  .brand .dot { color: var(--muted-foreground); }
  .topbar nav { display: flex; gap: .25rem; margin-left: auto; height: 100%; }
  .topbar nav a {
    color: var(--muted-foreground); text-decoration: none; font-size: 0.8125rem; font-weight: 500;
    display: flex; align-items: center; padding: 0 .625rem; transition: color .15s;
  }
  .topbar nav a:hover { color: var(--foreground); }
  main { max-width: 44rem; margin-inline: auto; padding: 1.75rem 1.25rem 4rem; }
  h1 { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 .25rem; line-height: 1.3; }
  h1 .meta { font-weight: 400; letter-spacing: 0; }
  /* Section headers speak in the human voice (mono is for machine facts
     only): small, semibold, dim — Linear's "In Progress 5" register. */
  h2 {
    font-size: 0.8125rem; font-weight: 600; letter-spacing: -0.005em;
    color: var(--muted-foreground); margin: 2rem 0 .5rem; font-family: var(--font-sans);
  }
  a { color: var(--foreground); text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; }
  a:hover { text-decoration-color: var(--muted-foreground); }
  p { margin: .4rem 0; }
  code { background: var(--muted); border-radius: .3rem; padding: .1rem .35rem; font-family: var(--font-mono); font-size: .8125rem; }
  .mono { font-family: var(--font-mono); font-size: .8125rem; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }

  .meta { font-size: 0.8125rem; color: var(--muted-foreground); }
  .meta a { color: var(--muted-foreground); }
  .hint { font-size: 0.75rem; color: var(--muted-foreground); margin: -.375rem 0 .625rem; }
  .eyebrow {
    display: block; color: var(--muted-foreground); font-size: .625rem;
    font-weight: 500; letter-spacing: .08em; line-height: 1.3; text-transform: uppercase;
    font-family: var(--font-mono);
  }
  .num { font-variant-numeric: tabular-nums; }

  /* Utility classes replacing the old inline style= attributes. */
  .tight { margin-top: 0; }
  .card > h2:first-child, .card > h3:first-child { margin-top: 0; }
  .w-xs { width: 4.5rem; } .w-sm { width: 8rem; } .w-md { width: 12rem; } .w-lg { width: 14rem; }
  .field-cap { width: 100%; max-width: 28rem; }
  .field-cap-sm { width: 100%; max-width: 22rem; }
  .field-cap-lg { width: 100%; max-width: 34rem; }
  .prewrap { white-space: pre-wrap; }
  .wrap-any { overflow-wrap: anywhere; }
  .grab { cursor: grab; user-select: none; }

  .palette {
    position: fixed; top: 18vh; left: 50%; transform: translateX(-50%); width: min(32rem, 90vw);
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow-overlay);
    padding: .625rem; z-index: 50;
  }
  .palette input { width: 100%; margin: 0; }
  .palette ul { list-style: none; margin: .5rem 0 0; padding: 0; max-height: 40vh; overflow-y: auto; }
  .palette li { padding: .4375rem .625rem; border-radius: calc(var(--radius) - 4px); cursor: pointer; font-size: .875rem; }
  .palette li[aria-selected="true"] { background: var(--muted); }

  /* The ledger: the window's harvest as strong figures in a sentence. */
  .ledger { font-size: 0.9375rem; color: var(--muted-foreground); margin: .875rem 0 0; line-height: 1.9; }
  .ledger b { font-weight: 600; font-size: 1.25rem; color: var(--foreground); font-variant-numeric: tabular-nums; padding-right: .1rem; font-family: var(--font-mono); }
  .ledger .good b { color: var(--success); }
  .ledger .bad b { color: var(--destructive); }

  /* Status labels are quiet metadata, not decoration. Their words carry
     the meaning; the restrained tint only speeds scanning. Count badges
     remain round so a number cannot be confused with a state. */
  .badge {
    display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: .375rem;
    padding: .0625rem .4rem; font-size: 0.6875rem; font-weight: 500; line-height: 1.45;
    background: color-mix(in srgb, var(--card) 58%, transparent); color: var(--muted-foreground); vertical-align: middle;
    font-family: var(--font-sans); font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .badge-done, .badge-answered, .badge-verified, .badge-built {
    background: color-mix(in srgb, var(--muted) 58%, var(--card)); color: var(--foreground);
    border-color: var(--border);
  }
  .badge-failed {
    background: color-mix(in srgb, var(--muted) 58%, var(--card));
    color: color-mix(in srgb, var(--destructive) 68%, var(--foreground)); border-color: var(--border);
  }
  .badge-overdue {
    background: color-mix(in srgb, var(--muted) 58%, var(--card)); color: var(--foreground);
    border-color: var(--border);
  }
  /* The criterion matrix's fourth state (v39): neither a pass nor a
     failure — evidence resolved everywhere except a manual-review kind,
     which by design nothing here can machine-verify. Quieter than
     badge-failed; still visibly distinct from a plain pass. */
  .badge-manual-review {
    background: color-mix(in srgb, var(--muted) 58%, var(--card));
    color: color-mix(in srgb, var(--muted-foreground) 80%, var(--foreground)); border-color: var(--border);
  }
  /* "open" and "parked" are neutral facts (an open PR, a parked decision);
     the AMBER form is the attention count — the number that waits on you.
     One accent, two places (reduction pass §3): the needs-you count and
     the act that resolves the screen. Cards, frames, and seals are neutral. */
  .badge-open, .badge-parked { color: var(--foreground); }
  .count {
    min-width: 1.25rem; padding-inline: .35rem; border-radius: 9999px;
  }
  .count.badge-open {
    background: var(--brand-soft); color: var(--brand);
    border-color: color-mix(in srgb, var(--brand) 24%, var(--border));
  }
  .badge-running {
    background: color-mix(in srgb, var(--muted) 58%, var(--card));
    color: color-mix(in srgb, var(--running) 72%, var(--foreground)); border-color: var(--border);
  }
  .badge-cut { background: var(--muted); }

  .card {
    border: 1px solid var(--glass-border); border-radius: var(--radius); background: var(--glass);
    padding: 1rem 1.125rem; margin: .75rem 0; box-shadow: var(--shadow), 0 1px 0 var(--glass-highlight) inset;
    -webkit-backdrop-filter: blur(18px) saturate(125%); backdrop-filter: blur(18px) saturate(125%);
  }
  .problem {
    border: 1px solid color-mix(in srgb, var(--destructive) 35%, transparent);
    background: var(--destructive-soft); color: var(--destructive);
    border-radius: var(--radius); padding: .625rem .875rem; margin: .75rem 0; font-size: 0.8125rem;
  }
  /* A row is 2.25rem of quiet: hairline below, hover fills, nothing else. */
  .row {
    display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap;
    padding: .5rem .375rem; min-height: 2.25rem; border-bottom: 1px solid var(--border);
    margin: 0; border-radius: calc(var(--radius) - 4px);
  }
  .row:last-of-type { border-bottom: none; }
  .row .right { margin-left: auto; }
  a.row { text-decoration: none; }
  a.row:hover { background: var(--muted); }

  /* A parked decision: the question in full weight, the whole card the
     tap target, the neutral border — the "needs you" header above it
     carries the colour for every card beneath. */
  .decide-card {
    display: block; border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card); padding: .875rem 1.125rem; margin: .625rem 0;
    text-decoration: none; transition: border-color .15s;
  }
  .decide-card:hover { border-color: color-mix(in srgb, var(--border) 55%, var(--muted-foreground)); }
  .decide-card .q { font-weight: 600; margin: 0 0 .25rem; }

  /* Buttons: secondary by default (surface + hairline); a form's one
     submit is primary (ink on paper, paper on ink); the approve act is
     amber; danger is red and outlined. 2.25rem at a desk, 2.75rem to a thumb. */
  button {
    font: 500 0.8125rem/1.4 var(--font-sans); cursor: pointer; border-radius: calc(var(--radius) - 3px);
    border: 1px solid var(--glass-border); background: var(--glass-strong); color: var(--foreground);
    padding: .4rem .8rem; min-height: 2.375rem; box-shadow: var(--shadow), 0 1px 0 var(--glass-highlight) inset;
    transition: transform .15s ease, background .15s, border-color .15s, box-shadow .15s;
  }
  button:hover { background: color-mix(in srgb, var(--muted) 84%, var(--foreground)); border-color: var(--input); transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  form.card > button[type=submit], .sticky-actions button[type=submit], form.card .sticky-actions button {
    background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600;
  }
  form.card > button[type=submit]:hover, .sticky-actions button[type=submit]:hover {
    background: color-mix(in srgb, var(--primary) 85%, var(--background)); border-color: color-mix(in srgb, var(--primary) 85%, var(--background));
  }
  /* The approve act is the one amber verb: it resolves what waits on you.
     The ceremony's frame is neutral so the button is the only warm thing
     in it; a danger act stays red even inside one. */
  .approve-form button[type=submit], .approve-form .sticky-actions button[type=submit] {
    background: var(--brand); color: var(--brand-foreground); border-color: var(--brand); font-weight: 600;
  }
  .approve-form button[type=submit]:hover, .approve-form .sticky-actions button[type=submit]:hover { background: color-mix(in srgb, var(--brand) 85%, var(--foreground)); border-color: color-mix(in srgb, var(--brand) 85%, var(--foreground)); }
  button.danger, .approve-form button[type=submit].danger {
    color: var(--destructive); border-color: color-mix(in srgb, var(--destructive) 50%, transparent);
    background: transparent; font-weight: 500;
  }
  button.danger:hover, .approve-form button[type=submit].danger:hover { background: var(--destructive-soft); }

  label { display: block; font-size: 0.8125rem; font-weight: 500; margin: .75rem 0 0; color: var(--foreground); }
  input[type=text], input[type=password], input[type=number], input[type=url], input[type=email], textarea, select {
    width: 100%; margin: .35rem 0 0; padding: .5rem .7rem; font: 400 0.875rem/1.4 var(--font-sans);
    color: var(--foreground); background: color-mix(in srgb, var(--glass-strong) 90%, transparent); min-height: 2.375rem;
    border: 1px solid var(--input); border-radius: calc(var(--radius) - 3px);
    transition: border-color .15s, box-shadow .15s;
  }
  input:hover, textarea:hover, select:hover { border-color: var(--muted-foreground); }
  input[type=number] { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  input[type=radio], input[type=checkbox] { accent-color: var(--ring); }
  .permission-field { border: 0; padding: 0; margin: 1rem 0 0; min-width: 0; }
  .permission-field legend { padding: 0; font-size: .8125rem; font-weight: 600; }
  .permission-toggle { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; margin-top: .5rem; }
  .permission-choice {
    display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .6rem; align-items: start;
    margin: 0; padding: .72rem .78rem; border: 1px solid var(--glass-border);
    border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--card) 66%, transparent);
    cursor: pointer; transition: border-color .15s, background .15s, box-shadow .15s;
  }
  .permission-choice:hover { background: var(--muted); }
  .permission-choice:has(input:checked) {
    border-color: color-mix(in srgb, var(--foreground) 42%, var(--border));
    background: var(--card); box-shadow: 0 0 0 1px color-mix(in srgb, var(--foreground) 8%, transparent), var(--shadow);
  }
  .permission-choice input { margin: .14rem 0 0; }
  .permission-choice strong, .permission-choice small { display: block; }
  .permission-choice strong { font-size: .8125rem; }
  .permission-choice small { margin-top: .16rem; color: var(--muted-foreground); font-size: .6875rem; font-weight: 400; line-height: 1.35; }
  .permission-note { margin: .55rem 0 0; }
  .scope-editor .permission-toggle { grid-template-columns: 1fr; }
  /* New work starts like a conversation, not a configuration sheet. The
     planner turns the one intent into the detailed, signed contract; these
     controls expose the uncommon overrides without making them the door. */
  main:has(.task-intake) { max-width: 68rem; }
  .task-intake { width: min(100%, 50rem); margin: clamp(1rem, 5vh, 4rem) auto 0; }
  .task-intake-hero { text-align: center; margin: 0 auto 1.35rem; max-width: 38rem; }
  .task-intake-mark {
    display: grid; place-items: center; width: 3rem; height: 3rem; margin: 0 auto .85rem;
    border: 1px solid var(--glass-border); border-radius: 1rem;
    background: linear-gradient(145deg, color-mix(in srgb, var(--running) 18%, var(--glass-strong)), var(--glass));
    box-shadow: 0 18px 45px -28px var(--running), 0 1px 0 var(--glass-highlight) inset;
    font: 600 .72rem/1 var(--font-mono); letter-spacing: -.05em;
  }
  .task-intake-hero h1 { margin: 0; font-size: clamp(1.65rem, 4vw, 2.2rem); letter-spacing: -.045em; }
  .task-intake-hero p { margin: .45rem 0 0; color: var(--muted-foreground); }
  .task-composer { padding: .75rem; border-radius: 1.45rem; box-shadow: var(--shadow-overlay), 0 1px 0 var(--glass-highlight) inset; }
  .task-prompt { margin: 0; font-size: 0; }
  .task-prompt textarea {
    min-height: 8.5rem; max-height: 18rem; margin: 0; padding: .9rem 1rem; resize: vertical;
    border: 0; background: transparent; box-shadow: none; font-size: 1.05rem; line-height: 1.55;
  }
  .task-prompt textarea:hover, .task-prompt textarea:focus-visible { border: 0; box-shadow: none; }
  .task-repo { margin: .25rem .45rem .7rem; }
  .task-composer-footer { display: flex; align-items: center; gap: .5rem; padding: .25rem; }
  .task-context { display: flex; align-items: center; gap: .4rem; flex: 1 1 auto; min-width: 0; }
  .task-context-chip {
    display: inline-flex; align-items: center; min-height: 2rem; max-width: 13rem; padding: .25rem .65rem;
    border: 1px solid var(--glass-border); border-radius: 999px; color: var(--muted-foreground);
    background: color-mix(in srgb, var(--glass) 76%, transparent); font-size: .72rem; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .task-quality { margin: 0; flex: none; font-size: 0; }
  .task-quality select {
    width: auto; min-height: 2rem; margin: 0; padding: .25rem 1.75rem .25rem .65rem;
    border-radius: 999px; color: var(--muted-foreground); font-size: .72rem; background-color: var(--glass);
  }
  .task-submit {
    flex: none; min-height: 2.45rem; padding: .45rem .95rem; border-radius: 999px;
    background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600;
  }
  .task-submit:hover { background: color-mix(in srgb, var(--primary) 85%, var(--background)); border-color: transparent; }
  details.task-options {
    margin: .65rem .25rem 0; padding: .15rem .5rem 0; border: 0; border-top: 1px solid var(--glass-border);
    border-radius: 0; background: transparent;
  }
  details.task-options[open] { padding-bottom: .25rem; }
  .task-options > summary { display: flex; align-items: center; gap: .5rem; list-style: none; }
  .task-options > summary::-webkit-details-marker { display: none; }
  .task-options > summary::after {
    content: ""; width: .4rem; height: .4rem; margin-left: auto; margin-right: .25rem;
    border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground);
    transform: rotate(45deg) translateY(-.1rem); transition: transform .15s;
  }
  .task-options[open] > summary::after { transform: rotate(225deg) translateY(-.1rem); }
  .task-options > summary small { color: var(--muted-foreground); font-weight: 400; }
  .task-options-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 .8rem; padding: 0 .25rem .5rem; }
  .task-options-grid .wide, .task-options-grid .permission-field { grid-column: 1 / -1; }
  .task-check { display: flex; gap: .55rem; align-items: flex-start; }
  .task-check input { margin-top: .2rem; }
  .task-check > span { display: grid; gap: .1rem; }
  .task-check small { display: block; font-weight: 400; line-height: 1.45; }
  .task-agent-note { text-align: center; max-width: 42rem; margin: .85rem auto 0; }
  .visually-hidden {
    position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important;
    margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important;
    white-space: nowrap !important; border: 0 !important;
  }
  input[type=password] { font-family: var(--font-mono); }
  input:focus-visible, textarea:focus-visible, select:focus-visible {
    outline: none; border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 25%, transparent);
  }
  button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

  .inline { display: inline-block; width: auto; margin: 0 .375rem .375rem 0; vertical-align: middle; }
  .inline input[type=text] { display: inline-block; width: auto; margin: 0 .375rem 0 0; vertical-align: middle; }
  .inline button { width: auto; }

  /* One option = one container: consequence first, then the act. */
  form.option {
    margin: .75rem 0; border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--card); padding: .875rem 1rem;
  }
  form.option button {
    display: block; width: 100%; text-align: left; font-size: 0.9375rem; font-weight: 600;
    min-height: 2.75rem;
  }
  /* Recommended is a suggestion, not attention: neutral emphasis, no amber. */
  form.option.recommended { border-color: color-mix(in srgb, var(--foreground) 30%, var(--border)); }
  form.option.recommended .badge { background: var(--muted); color: var(--foreground); }
  .consequence { font-size: 0.8125rem; color: var(--muted-foreground); margin: 0 0 .625rem; white-space: pre-wrap; }
  form.option input[type=text] { font-size: 0.8125rem; margin-top: .5rem; min-height: 2.25rem; }

  .recap { color: var(--muted-foreground); margin: .75rem 0; white-space: pre-wrap; }
  .result-card {
    margin: 1.25rem 0; border-color: color-mix(in srgb, var(--success) 32%, var(--glass-border));
    background: linear-gradient(145deg, color-mix(in srgb, var(--success-soft) 52%, var(--glass-strong)), var(--glass));
    box-shadow: var(--shadow-card), 0 1px 0 var(--glass-highlight) inset;
  }
  .result-card h2 { margin: 0; }
  .completion-receipt {
    position: relative; overflow: hidden; margin: 1rem 0 1.25rem; padding: 1.15rem;
    border-color: color-mix(in srgb, var(--foreground) 13%, var(--glass-border));
    background: linear-gradient(145deg, color-mix(in srgb, var(--glass-strong) 88%, transparent), var(--glass));
    box-shadow: var(--shadow-card), 0 1px 0 var(--glass-highlight) inset;
  }
  .completion-receipt::after {
    content: ""; position: absolute; width: 11rem; height: 11rem; right: -5rem; top: -7rem;
    border-radius: 50%; background: color-mix(in srgb, var(--running) 9%, transparent); filter: blur(4px); pointer-events: none;
  }
  .receipt-head { position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
  .receipt-head h2 { margin: .15rem 0 0; font-size: 1.15rem; }
  .receipt-proof { display: inline-flex; align-items: center; gap: .4rem; flex: none; color: var(--muted-foreground); font-size: .75rem; font-weight: 600; }
  .receipt-proof i { width: .48rem; height: .48rem; border-radius: 50%; background: var(--muted-foreground); box-shadow: 0 0 0 3px color-mix(in srgb, var(--muted-foreground) 12%, transparent); }
  .receipt-proof[data-proof-state="verified"] { color: var(--success); }
  .receipt-proof[data-proof-state="verified"] i { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 13%, transparent); }
  .receipt-proof[data-proof-state="attested"] { color: var(--running); }
  .receipt-proof[data-proof-state="attested"] i { background: var(--running); box-shadow: 0 0 0 3px color-mix(in srgb, var(--running) 13%, transparent); }
  .receipt-proof[data-proof-state="problem"] { color: var(--warning); }
  .receipt-proof[data-proof-state="problem"] i { background: var(--warning); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning) 13%, transparent); }
  .receipt-summary { position: relative; z-index: 1; max-width: 43rem; margin: .75rem 0 1rem; font-size: 1rem; line-height: 1.55; }
  .receipt-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .55rem; }
  .receipt-facts > span { min-width: 0; padding: .7rem .75rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--glass-strong) 64%, transparent); }
  .receipt-facts strong, .receipt-facts small { display: block; overflow-wrap: anywhere; }
  .receipt-facts strong { font-size: .78rem; font-weight: 600; }
  .receipt-facts small { margin-top: .18rem; color: var(--muted-foreground); font-size: .68rem; line-height: 1.35; }
  .receipt-visuals { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: .55rem; margin-top: .75rem; }
  .receipt-shot { display: grid; gap: .35rem; color: var(--muted-foreground); font-size: .7rem; text-decoration: none; }
  .receipt-shot img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: var(--muted); }
  .receipt-shot:hover { color: var(--foreground); }
  .receipt-caveats { margin-top: .8rem; padding: .7rem .8rem; border-left: 2px solid var(--warning); border-radius: 0 calc(var(--radius) - 3px) calc(var(--radius) - 3px) 0; background: color-mix(in srgb, var(--warning-soft) 52%, transparent); font-size: .78rem; }
  .receipt-caveats ul { margin: .3rem 0 0; padding-left: 1.15rem; }
  .receipt-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem 1rem; margin-top: .9rem; }
  .receipt-actions > a:not(.button-link) { font-size: .78rem; font-weight: 550; }
  .diff-review {
    overflow: hidden; margin: .8rem 0 .5rem; border: 1px solid var(--glass-border);
    border-radius: var(--radius); background: color-mix(in srgb, var(--card) 82%, transparent);
    box-shadow: 0 1px 0 var(--glass-highlight) inset;
  }
  .diff-review-bar {
    display: flex; align-items: center; justify-content: space-between; gap: .75rem;
    min-height: 2.8rem; padding: .4rem .55rem .4rem .85rem;
    border-bottom: 1px solid var(--glass-border); background: color-mix(in srgb, var(--glass-strong) 68%, transparent);
  }
  .diff-modes { display: inline-flex; padding: .18rem; border: 1px solid var(--glass-border); border-radius: 999px; background: var(--muted); }
  .diff-modes button {
    min-height: 1.75rem; padding: .2rem .7rem; border: 0; border-radius: 999px;
    background: transparent; box-shadow: none; color: var(--muted-foreground); font-size: .7rem;
  }
  .diff-modes button:hover { transform: none; color: var(--foreground); }
  .diff-modes button[aria-pressed="true"] { background: var(--card); color: var(--foreground); box-shadow: 0 1px 3px color-mix(in srgb, var(--background) 20%, transparent); }
  .diff-review-help {
    margin: 0; padding: .62rem .85rem; border-bottom: 1px solid var(--glass-border);
    background: color-mix(in srgb, var(--running) 7%, transparent); color: var(--muted-foreground); font-size: .75rem;
  }
  .diff-review[data-mode="view"] .diff-review-help { display: none; }
  .diff-file { margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  .diff-file + .diff-file { border-top: 1px solid var(--glass-border); }
  .diff-file[open] { padding-bottom: 0; }
  .diff-file > summary {
    display: flex; align-items: center; gap: .7rem; min-height: 2.75rem; padding: .45rem .85rem;
    list-style: none; color: var(--foreground); background: color-mix(in srgb, var(--glass) 55%, transparent);
  }
  .diff-file > summary::-webkit-details-marker { display: none; }
  .diff-file > summary::before {
    content: ""; flex: none; width: .35rem; height: .35rem;
    border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground);
    transform: rotate(-45deg); transition: transform .15s ease;
  }
  .diff-file[open] > summary::before { transform: rotate(45deg) translateY(-.1rem); }
  .diff-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 .75rem/1.4 var(--font-mono); }
  .diff-file-counts { display: inline-flex; gap: .45rem; flex: none; margin-left: auto; font: 500 .68rem/1 var(--font-mono); }
  .diff-file-counts b { color: var(--success); font-weight: 500; }
  .diff-file-counts i { color: var(--destructive); font-style: normal; }
  .diff-rename { margin: 0; padding: .4rem .85rem; border-top: 1px solid var(--glass-border); }
  .diff-hunk + .diff-hunk { border-top: 1px solid var(--glass-border); }
  .diff-hunk-head {
    overflow-x: auto; padding: .42rem .85rem; border-top: 1px solid var(--glass-border); border-bottom: 1px solid var(--glass-border);
    background: color-mix(in srgb, var(--running) 8%, var(--card)); color: color-mix(in srgb, var(--running) 72%, var(--foreground));
    font: 500 .68rem/1.4 var(--font-mono); white-space: pre;
  }
  .diff-lines { max-width: 100%; overflow-x: auto; background: color-mix(in srgb, var(--background) 48%, var(--card)); }
  .diff-line {
    display: grid; grid-template-columns: 2rem 3.2rem 3.2rem minmax(max-content, 1fr); align-items: stretch;
    min-width: max-content; min-height: 1.8rem; font: 400 .72rem/1.55 var(--font-mono);
  }
  .diff-line:hover { background: color-mix(in srgb, var(--foreground) 4%, transparent); }
  .diff-line code { display: flex; min-width: 0; padding: .3rem .75rem .3rem .6rem; color: inherit; white-space: pre; }
  .diff-line code b { display: inline-block; width: 1rem; flex: none; font-weight: 500; opacity: .72; }
  .diff-gutter {
    display: flex; align-items: flex-start; justify-content: flex-end; min-width: 0; padding: .3rem .45rem;
    border-right: 1px solid color-mix(in srgb, var(--border) 72%, transparent); color: var(--muted-foreground); user-select: none;
  }
  .diff-addition { background: color-mix(in srgb, var(--success) 10%, transparent); color: color-mix(in srgb, var(--success) 38%, var(--foreground)); }
  .diff-deletion { background: color-mix(in srgb, var(--destructive) 9%, transparent); color: color-mix(in srgb, var(--destructive) 38%, var(--foreground)); }
  .diff-meta { color: var(--muted-foreground); }
  .diff-annotate, .diff-annotate-space {
    position: sticky; left: 0; z-index: 1; display: grid; place-items: center; width: 2rem; min-width: 2rem; min-height: 1.8rem;
    border: 0; border-right: 1px solid color-mix(in srgb, var(--border) 72%, transparent); border-radius: 0;
  }
  .diff-annotate { padding: 0; background: color-mix(in srgb, var(--card) 94%, transparent); color: var(--muted-foreground); box-shadow: none; opacity: .35; }
  .diff-annotate svg { width: .78rem; height: .78rem; }
  .diff-annotate:hover { transform: none; background: color-mix(in srgb, var(--running) 15%, var(--card)); color: var(--running); opacity: 1; }
  .diff-annotate-space { background: color-mix(in srgb, var(--card) 94%, transparent); }
  .diff-review[data-mode="view"] .diff-line { grid-template-columns: 0 3.2rem 3.2rem minmax(max-content, 1fr); }
  .diff-review[data-mode="view"] .diff-annotate,
  .diff-review[data-mode="view"] .diff-annotate-space { visibility: hidden; width: 0; min-width: 0; overflow: hidden; border: 0; pointer-events: none; }
  .diff-review[data-mode="annotate"] .diff-annotate { opacity: .72; }
  .diff-cut { margin: 0; padding: .65rem .85rem; border-top: 1px solid var(--glass-border); color: var(--warning); font-size: .75rem; }
  .diff-comments { display: grid; gap: .5rem; margin: .7rem 0; }
  .diff-comment {
    position: relative; padding: .7rem .8rem .7rem 1rem; border: 1px solid var(--glass-border);
    border-radius: calc(var(--radius) - 2px); background: color-mix(in srgb, var(--glass) 76%, transparent);
  }
  .diff-comment-pin { position: absolute; left: -.2rem; top: .75rem; width: .38rem; height: 1.2rem; border-radius: 999px; background: var(--running); }
  .diff-comment p { margin: 0 0 .25rem; overflow-wrap: anywhere; }
  .diff-comment .meta { font-size: .68rem; }
  .diff-comment-form { display: grid; gap: .65rem; margin: .75rem 0; padding: .85rem; }
  .diff-comment-target { display: grid; grid-template-columns: minmax(0, 1fr) 5.5rem; gap: .6rem; }
  .diff-comment-form label { margin: 0; color: var(--muted-foreground); font-size: .68rem; font-weight: 550; }
  .diff-comment-form input, .diff-comment-form textarea { margin-top: .28rem; }
  .diff-comment-form button { justify-self: start; }
  .revision-from-comments {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    margin: .75rem 0; padding: .85rem; border-color: color-mix(in srgb, var(--running) 24%, var(--glass-border));
    background: linear-gradient(145deg, color-mix(in srgb, var(--running) 6%, var(--glass-strong)), var(--glass));
  }
  .revision-from-comments > div { display: grid; gap: .15rem; }
  .revision-from-comments > div > span { display: block; }
  .revision-from-comments button { flex: none; }
  .result-section { margin-top: .875rem; }
  .result-section > strong {
    display: block; font: 600 .6875rem/1.3 var(--font-mono); color: var(--muted-foreground);
    letter-spacing: .06em; text-transform: uppercase;
  }
  .result-section ul { margin: .375rem 0 0; padding-left: 1.25rem; }
  .result-section li { margin: .25rem 0; }
  .question { font-size: 1.125rem; font-weight: 600; letter-spacing: -0.01em; margin: 1rem 0; white-space: pre-wrap; }
  .answered {
    border: 1px solid color-mix(in srgb, var(--success) 35%, transparent); background: var(--success-soft);
    border-radius: var(--radius); padding: .875rem 1rem; margin: 1rem 0;
  }
  details {
    margin: .75rem 0; border: 1px solid var(--border); border-radius: var(--radius);
    padding: .25rem .875rem; background: var(--card);
  }
  details[open] { padding-bottom: .875rem; }
  details.arm-danger { border-color: color-mix(in srgb, var(--destructive) 30%, transparent); }
  summary { padding: .5rem 0; cursor: pointer; font-weight: 500; font-size: 0.8125rem; color: var(--muted-foreground); min-height: 2.25rem; }
  summary:hover { color: var(--foreground); }
  details form.option { border: none; padding: .25rem 0 0; margin: 0; }
  .evidence { margin-top: 1.5rem; font-size: 0.8125rem; }
  .evidence a { display: block; padding: .55rem 0; border-bottom: 1px solid var(--border); text-decoration: none; }
  .evidence a:hover { color: var(--muted-foreground); }
  .evidence strong { display: block; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted-foreground); font-family: var(--font-mono); }

  .filters { font-size: 0.8125rem; color: var(--muted-foreground); }
  .filters a, .filters strong {
    display: inline-block; padding: .25rem .625rem; border-radius: 9999px; text-decoration: none;
    color: var(--muted-foreground); font-weight: 500;
  }
  .filters strong { background: var(--muted); color: var(--foreground); }
  .filters a:hover { color: var(--foreground); }

  /* A picked tournament result: marked in the built green, not amber. */
  .card.picked { border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
  .seal {
    display: inline-block; font-family: var(--font-mono); font-size: .75rem;
    background: var(--muted); border: 1px solid var(--border);
    color: var(--foreground); border-radius: calc(var(--radius) - 4px); padding: .25rem .625rem;
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
  }

  /* The workspace shell: sidebar + content, an optional list pane between. */
  .app { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; transition: grid-template-columns .18s ease; }
  .side {
    border-right: 1px solid var(--glass-border);
    background: color-mix(in srgb, var(--glass-strong) 88%, transparent);
    padding: 1rem .875rem 1.125rem; display: flex; flex-direction: column; gap: .175rem;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
    -webkit-backdrop-filter: blur(24px) saturate(135%); backdrop-filter: blur(24px) saturate(135%);
    box-shadow: 1px 0 0 var(--glass-highlight) inset;
  }
  .side-head { display: flex; align-items: center; gap: .25rem; min-height: 2.5rem; margin-bottom: .45rem; }
  .side .brand { flex: 1; min-width: 0; padding: .25rem .625rem; font-size: 1rem; height: auto; letter-spacing: -.025em; }
  .brand-short { display: none; font-family: var(--font-mono); letter-spacing: -.06em; }
  .side-toggle {
    display: grid; place-items: center; flex: 0 0 2rem; width: 2rem; min-height: 2rem; padding: 0;
    border-color: transparent; background: transparent; color: var(--muted-foreground); box-shadow: none;
  }
  .side-toggle:hover { background: var(--glass); color: var(--foreground); transform: none; }
  .side-toggle svg { width: 1rem; height: 1rem; }
  /* The scope bar: one hairline row, the single scope truth on every
   * screen; its name is the switcher. Amber never appears here except
   * the needs-you count. */
  .scope-bar {
    display: flex; align-items: baseline; gap: .625rem; flex-wrap: wrap;
    position: sticky; top: 0; z-index: 20;
    padding: .625rem 2rem; border-bottom: 1px solid var(--glass-border);
    background: color-mix(in srgb, var(--glass-strong) 88%, transparent); font-size: .8125rem;
    -webkit-backdrop-filter: blur(20px) saturate(130%); backdrop-filter: blur(20px) saturate(130%);
  }
  .scope-bar .eyebrow { font-size: .6875rem; font-weight: 500; color: var(--muted-foreground); }
  .scope-bar .name { font-weight: 600; }
  /* The switcher: a folded menu of enrolled projects under the scope's name. */
  .switcher { position: relative; }
  .switcher > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: .25rem; }
  .switcher > summary::-webkit-details-marker { display: none; }
  .switcher .chevron { width: .875rem; height: .875rem; color: var(--muted-foreground); transition: transform .15s; }
  .switcher[open] > summary .chevron { transform: rotate(180deg); }
  .switcher-menu {
    position: absolute; top: calc(100% + .375rem); left: 0; z-index: 40; min-width: 15rem; max-width: 22rem;
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow-overlay); padding: .375rem; display: flex; flex-direction: column; gap: .125rem;
  }
  .switcher-menu form { margin: 0; }
  .switcher-menu button {
    display: flex; align-items: center; gap: .5rem; width: 100%; text-align: left; margin: 0;
    background: transparent; border: 0; min-height: 2.5rem; padding: 0 .75rem;
    border-radius: calc(var(--radius) - 4px); font: inherit; font-size: .875rem; color: var(--foreground);
  }
  .switcher-menu button.current { font-weight: 600; }
  .switcher-menu button.current::after {
    content: ""; margin-left: auto; width: .375rem; height: .625rem; flex: none;
    border-right: 1.75px solid var(--foreground); border-bottom: 1.75px solid var(--foreground);
    transform: rotate(45deg) translateY(-.125rem);
  }
  .switcher-menu button:hover { background: var(--muted); }
  .switcher-menu .manage {
    display: block; margin-top: .25rem; padding: .625rem .75rem; border-top: 1px solid var(--border);
    font-size: .75rem; color: var(--muted-foreground); text-decoration: none;
  }
  .scope-status {
    display: flex; gap: .5rem; flex-wrap: wrap;
    color: var(--muted-foreground); font-size: .6875rem; font-variant-numeric: tabular-nums;
    font-family: var(--font-mono);
  }
  .scope-status .hot { color: var(--brand); font-weight: 500; }
  .scope-status a { color: inherit; text-decoration: none; }
  .scope-status a:hover { text-decoration: underline; }
  /* A project card's name and counts are forms or links dressed as text and chips. */
  .project-card button.project-name, .project-card a.project-name {
    all: unset; cursor: pointer; font-weight: 600; color: var(--foreground);
  }
  .project-card a.project-name:hover, .project-card button.project-name:hover { text-decoration: underline; }
  .project-card button.badge { min-height: auto; box-shadow: none; cursor: pointer; }
  .project-card button.badge:hover, .project-card a.badge:hover { border-color: var(--input); }
  /* Adding a project is the page's primary job, not badge-sized metadata.
   * Two roomy action tiles make both roads obvious on a desk and give each
   * one a generous thumb target on a phone. The manual path stays tertiary. */
  .project-add-card { margin-top: 1.25rem; padding: 1.25rem; }
  .project-add-card h2.project-add-title {
    margin: 0; color: var(--foreground); font-size: 1.0625rem; line-height: 1.35;
    letter-spacing: -.015em;
  }
  .project-add-intro { margin: .25rem 0 0; max-width: 36rem; }
  .project-add-actions {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: .625rem; margin-top: 1rem;
  }
  .project-add-action {
    display: grid; grid-template-columns: 2.75rem minmax(0, 1fr) auto;
    align-items: center; gap: .75rem; min-height: 5rem; padding: .75rem .875rem;
    border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 1px);
    background: color-mix(in srgb, var(--glass-strong) 82%, transparent);
    color: var(--foreground); text-decoration: none;
    box-shadow: 0 1px 0 var(--glass-highlight) inset;
    transition: transform .15s ease, background .15s, border-color .15s, box-shadow .15s;
  }
  .project-add-action:hover {
    border-color: color-mix(in srgb, var(--border) 50%, var(--muted-foreground));
    background: var(--card); text-decoration: none; transform: translateY(-1px);
    box-shadow: var(--shadow), 0 1px 0 var(--glass-highlight) inset;
  }
  .project-add-action:active { transform: translateY(0); }
  .project-add-icon {
    display: grid; place-items: center; width: 2.75rem; height: 2.75rem;
    border: 1px solid var(--border); border-radius: .75rem;
    background: var(--muted); color: var(--foreground);
  }
  .project-add-icon svg { width: 1.125rem; height: 1.125rem; }
  .project-add-copy { min-width: 0; }
  .project-add-copy strong { display: block; font-size: .9375rem; line-height: 1.35; }
  .project-add-copy small {
    display: block; margin-top: .175rem; color: var(--muted-foreground);
    font-size: .75rem; font-weight: 400; line-height: 1.4;
  }
  .project-add-arrow { color: var(--muted-foreground); font-size: 1rem; }
  .project-add-more { margin-top: .875rem; border-top: 1px solid var(--border); }
  .project-add-more > summary {
    display: flex; align-items: center; min-height: 2.75rem; width: fit-content;
    color: var(--muted-foreground); cursor: pointer; font-size: .8125rem; font-weight: 500;
  }
  .project-add-more > summary:hover { color: var(--foreground); }
  .project-add-more > .card { margin: 0 0 .25rem; }
  .side nav { display: flex; flex-direction: column; gap: .125rem; }
  /* Inline decision options: neutral buttons — the card's amber outline is
   * the attention signal; recommendation is a neutral badge, never amber. */
  .decide-options { margin-top: .5rem; display: flex; flex-direction: column; gap: .375rem; }
  .decide-option { margin: 0; display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
  .decide-option button { margin: 0; }
  .decide-option .meta { flex: 1 1 12rem; }
  /* The rail's two accordion groups (sidebar rework): collapsed by
   * default, the active page's group open, opening one closes the other
   * (client toggle in chromeScript). Native <details>/<summary> carries
   * the expanded state and keyboard operation for free — the same pattern
   * the switcher already uses. */
  .side .nav-groups { display: flex; flex-direction: column; gap: .125rem; margin-top: .375rem; }
  .nav-group > summary {
    display: flex; align-items: center; justify-content: space-between; gap: .5rem;
    list-style: none; cursor: pointer; padding: .4375rem .625rem; min-height: 2.125rem;
    border-radius: calc(var(--radius) - 3px); text-decoration: none;
    color: var(--muted-foreground); font-size: .6875rem; font-weight: 500;
    font-family: var(--font-sans);
  }
  .nav-group > summary::-webkit-details-marker { display: none; }
  .nav-group > summary:hover { background: var(--glass); color: var(--foreground); }
  .nav-group > summary .chevron { width: .875rem; height: .875rem; flex: none; transition: transform .15s; }
  .nav-group[open] > summary .chevron { transform: rotate(180deg); }
  .nav-group .nav-group-items { display: flex; flex-direction: column; gap: .125rem; margin: .125rem 0 .25rem; }
  .side .nav-settings { margin-top: .375rem; }
  .side nav a {
    position: relative;
    display: flex; align-items: center; gap: .625rem; padding: .4375rem .625rem; min-height: 2.125rem;
    border-radius: calc(var(--radius) - 3px); text-decoration: none;
    color: var(--muted-foreground); font-size: .8125rem; font-weight: 500;
    transition: color .15s, background .15s, transform .15s;
  }
  .side nav a .glyph { display: inline-flex; width: 1rem; height: 1rem; color: var(--muted-foreground); flex: none; }
  .side nav a .glyph svg { width: 1rem; height: 1rem; }
  .side nav a:hover { background: var(--glass); color: var(--foreground); transform: translateX(2px); }
  .app.sidebar-collapsed { grid-template-columns: 64px minmax(0, 1fr); }
  .app.sidebar-collapsed .side { padding-inline: .625rem; }
  .app.sidebar-collapsed .side-head { flex-direction: column; gap: .2rem; margin-bottom: .55rem; }
  .app.sidebar-collapsed .side .brand { flex: none; padding: .2rem 0; font-size: .75rem; }
  .app.sidebar-collapsed .brand-long { display: none; }
  .app.sidebar-collapsed .brand-short { display: block; }
  .app.sidebar-collapsed .side-toggle svg { transform: rotate(180deg); }
  .app.sidebar-collapsed .side nav a {
    justify-content: center; gap: 0; min-height: 2.5rem; padding: .5rem; font-size: 0;
  }
  .app.sidebar-collapsed .side nav a .glyph { width: 1.125rem; height: 1.125rem; }
  .app.sidebar-collapsed .side nav a .glyph svg { width: 1.125rem; height: 1.125rem; }
  .app.sidebar-collapsed .side nav a .count {
    position: absolute; top: .15rem; right: .05rem; min-width: 1rem; padding: 0 .25rem; font-size: .55rem;
  }
  .app.sidebar-collapsed .side .new-task { min-height: 2.5rem; padding: .4rem 0; font-size: 0; }
  .app.sidebar-collapsed .side .new-task::after { content: "+"; font-size: 1rem; }
  .app.sidebar-collapsed .side .nav-groups { display: none; }
  .side nav a.active {
    background: linear-gradient(135deg, color-mix(in srgb, var(--running) 14%, var(--glass)), var(--glass));
    color: var(--foreground); box-shadow: 0 1px 0 var(--glass-highlight) inset, 0 8px 22px -18px var(--running);
  }
  .side nav a.active .glyph { color: var(--foreground); }
  .side nav a .count { margin-left: auto; }
  .side .grow { flex: 1; }
  .side .new-task {
    display: block; text-align: center; text-decoration: none; font-weight: 600; font-size: .8125rem;
    background: var(--primary); color: var(--primary-foreground);
    border: 1px solid var(--primary);
    border-radius: calc(var(--radius) - 3px); padding: .525rem; margin: .75rem 0 .125rem;
    box-shadow: 0 10px 28px -18px rgb(255 255 255 / .5);
  }
  .side .new-task:hover { background: color-mix(in srgb, var(--primary) 85%, var(--background)); }
  /* The same action link outside the sidebar reads as a real button. */
  .content .new-task {
    display: inline-block; text-decoration: none; font-weight: 500; font-size: .8125rem;
    background: var(--secondary); color: var(--foreground); border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px); padding: .5rem .875rem;
  }
  .content .new-task:hover { background: color-mix(in srgb, var(--secondary) 70%, var(--border)); }
  .content { min-width: 0; }
  .content > main { max-width: 54rem; margin: 0; padding: 2rem 2.5rem 4rem; }

  /* Banners: honest labels, quiet strips. */
  .banner {
    border-bottom: 1px solid var(--glass-border); background: var(--glass);
    padding: .375rem .9rem; font-size: .8125rem; color: var(--muted-foreground);
    -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
  }
  .banner .badge { margin-right: .5rem; }
  .banner a { color: var(--muted-foreground); }

  .split { display: grid; grid-template-columns: minmax(250px, 320px) minmax(0, 1fr); min-height: 100vh; }
  .list-pane {
    border-right: 1px solid var(--border); overflow-y: auto; height: 100vh;
    position: sticky; top: 0; padding: 1rem .75rem;
  }
  .list-pane h2 { margin-top: .25rem; }
  .list-pane a.item {
    display: block; padding: .5rem .625rem; border-radius: calc(var(--radius) - 4px);
    text-decoration: none; font-size: .8125rem; margin-bottom: .125rem;
  }
  .list-pane a.item:hover { background: var(--card); }
  .list-pane a.item.current { background: var(--muted); }
  .list-pane a.item .t { display: block; font-weight: 500; color: var(--foreground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .list-pane a.item .m { display: flex; gap: .375rem; align-items: center; color: var(--muted-foreground);
    font-size: .75rem; margin-top: .125rem; }
  .split > .detail { min-width: 0; }
  .split > .detail > main { max-width: 52rem; padding: 1.5rem 2rem 4rem; }
  .split:has(#wb-rail) { grid-template-columns: minmax(320px, 360px) minmax(0, 1fr); }
  .list-pane:has(#wb-rail) { padding: 0; background: var(--background); }
  #wb-rail { padding: 1rem .75rem 1.5rem; }
  #wb-rail-stamp { padding: 0 .75rem; }
  .workbench-mobile-rail, .workbench-mobile-back { display: none; }
  /* The task page (slice 1c): main column beside a rail; one column narrow. */
  .task-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(16rem, 19rem); gap: 0 2rem; align-items: start; }
  /* The task page (task page pass): eyebrow, title, the acts in one row,
     then folding sections; the rail is the property list. */
  .task-eyebrow { margin: 0 0 .25rem; }
  .task-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .task-title-row .task-main-title { min-width: 0; margin-bottom: .85rem; }
  .task-view-switch {
    display: inline-grid; grid-template-columns: repeat(2, auto); flex: none; padding: .2rem;
    border: 1px solid var(--glass-border); border-radius: .72rem; background: color-mix(in srgb, var(--glass) 82%, transparent);
    box-shadow: 0 1px 0 var(--glass-highlight) inset;
  }
  .task-view-switch a {
    min-width: 4.6rem; padding: .4rem .72rem; border-radius: .52rem; color: var(--muted-foreground);
    font-size: .72rem; font-weight: 550; text-align: center; text-decoration: none;
  }
  .task-view-switch a:hover { color: var(--foreground); background: color-mix(in srgb, var(--muted) 70%, transparent); }
  .task-view-switch a.active { color: var(--foreground); background: var(--glass-strong); box-shadow: 0 1px 5px rgb(0 0 0 / .1), 0 1px 0 var(--glass-highlight) inset; }
  .acts-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: .75rem 0 .25rem; }
  .acts-bar form.inline { margin: 0; display: inline-flex; align-items: center; gap: .375rem; }
  .acts-bar form.inline button { width: auto; }
  .acts-bar .primary button { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
  .acts-bar .primary button:hover { background: color-mix(in srgb, var(--primary) 85%, var(--background)); }
  .acts-bar .act-hold input[type=text] { width: 10rem; min-height: 2.25rem; margin: 0; font-size: .8125rem; }
  .acts-why { margin: 0 0 .5rem; }
  .dispatch-status { padding: .8rem .9rem; border-radius: var(--radius); overflow: hidden; }
  .dispatch-copy { display: flex; align-items: baseline; flex-wrap: wrap; gap: .2rem .35rem; min-width: 0; }
  .dispatch-copy .meta { min-width: 0; }
  .dispatch-action-link { margin-top: .65rem; }
  details.dispatch-recovery { margin-top: .65rem; border: 0; padding: 0; background: transparent; box-shadow: none; }
  details.dispatch-recovery > summary {
    display: inline-flex; align-items: center; min-height: 2.25rem; padding: 0 .875rem; list-style: none;
    border: 1px solid var(--primary); border-radius: calc(var(--radius) - 2px); cursor: pointer;
    background: var(--primary); color: var(--primary-foreground); font-size: .8125rem; font-weight: 600;
  }
  details.dispatch-recovery > summary::-webkit-details-marker { display: none; }
  .dispatch-recovery-body { margin-top: .65rem; padding: .7rem .75rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: var(--glass); color: var(--foreground); }
  .dispatch-recovery-body p { margin: 0; }
  .dispatch-recovery-body p + p { margin-top: .5rem; }
  .dispatch-recovery-command { display: block; margin-top: .45rem; padding: .55rem .65rem; overflow-wrap: anywhere; border-radius: .5rem; background: var(--muted); }
  .dispatch-status[data-dispatch-status="no-worker-registered"],
  .dispatch-status[data-dispatch-status="no-worker-online"] {
    color: var(--foreground); border-color: color-mix(in srgb, var(--warning) 30%, var(--border));
    background: color-mix(in srgb, var(--warning-soft) 48%, var(--glass));
  }
  .dispatch-status[data-dispatch-status="no-worker-registered"] .dispatch-copy > strong,
  .dispatch-status[data-dispatch-status="no-worker-online"] .dispatch-copy > strong { color: color-mix(in srgb, var(--warning) 72%, var(--foreground)); }
  .builder-notice { border-color: color-mix(in srgb, var(--warning) 30%, var(--border)); background: color-mix(in srgb, var(--warning-soft) 48%, var(--glass)); }
  .builder-notice strong { color: color-mix(in srgb, var(--warning) 72%, var(--foreground)); }
  .dispatch-status[data-dispatch-status="terminal-dependency"] {
    color: var(--foreground); border-color: color-mix(in srgb, var(--warning) 42%, var(--border));
    background: color-mix(in srgb, var(--warning-soft) 72%, var(--glass));
  }
  .dispatch-status[data-dispatch-status="terminal-dependency"] .dispatch-copy > strong { color: var(--warning); }
  .dispatch-status[data-dispatch-status="waiting-dependency"] {
    color: var(--foreground); border-color: var(--glass-border); background: var(--glass);
  }
  .dependency-repair-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; margin-top: .7rem; }
  .dependency-repair-help { flex: 1 0 100%; margin: 0 0 .1rem; }
  .dependency-repair-actions form { display: inline-flex; align-items: center; gap: .4rem; min-width: 0; max-width: 100%; margin: 0; }
  .dependency-repair-label { flex: 1 1 16rem; min-width: 0; margin: 0; color: var(--foreground); font-size: .75rem; }
  .dependency-repair-label select { display: block; margin: .3rem 0 0; }
  .dependency-repair-actions select { width: auto; max-width: 16rem; min-height: 2rem; margin: 0; font-size: .75rem; }
  .dependency-repair-actions button { min-height: 2rem; padding: .3rem .65rem; font-size: .75rem; }
  .approve-form { margin: .75rem 0; }
  .approve-form .ceremony-head { display: flex; align-items: baseline; justify-content: space-between; gap: .75rem; margin: 0 0 .5rem; }
  .approve-form .ceremony-head a { font-size: .8125rem; color: var(--muted-foreground); white-space: nowrap; }
  .approve-form .recap { margin: .125rem 0 .5rem; }
  .approval-card { padding: 1.2rem 1.3rem; border-radius: calc(var(--radius) + 3px); }
  .approval-card .ceremony-head { align-items: flex-start; padding-bottom: .85rem; border-bottom: 1px solid var(--glass-border); }
  .approval-title { display: grid; gap: .15rem; }
  .approval-kicker { color: var(--muted-foreground); font: 500 .66rem/1.3 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
  .approval-title strong { font-size: 1.05rem; letter-spacing: -.02em; }
  .approval-label { margin: .9rem 0 .2rem; color: var(--muted-foreground); font: 500 .66rem/1.3 var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }
  .approval-goal { margin: 0; font-size: 1rem; line-height: 1.55; white-space: pre-wrap; }
  .approval-boundaries { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; margin-top: .75rem; }
  .approval-boundary { padding: .7rem .8rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb, var(--muted) 45%, transparent); }
  .approval-boundary .approval-label { margin: 0 0 .2rem; }
  .approval-boundary p { margin: 0; color: var(--muted-foreground); font-size: .8rem; overflow-wrap: anywhere; }
  .approval-chips { display: flex; flex-wrap: wrap; gap: .4rem; margin: .8rem 0 .3rem; }
  .approval-chip { padding: .25rem .6rem; border: 1px solid var(--glass-border); border-radius: 999px; color: var(--muted-foreground); background: var(--glass); font-size: .7rem; }
  .approval-confirm { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: end; margin-top: .9rem; padding-top: .8rem; border-top: 1px solid var(--glass-border); }
  .approval-confirm label { margin: 0; }
  .approval-confirm button { min-height: 2.5rem; }
  details.planner-plan { margin-top: .75rem; background: color-mix(in srgb, var(--glass) 72%, transparent); }
  .planner-status { display: flex; gap: .8rem; align-items: flex-start; }
  .planner-orb { position: relative; flex: 0 0 2.15rem; width: 2.15rem; height: 2.15rem; border-radius: .75rem; background: var(--running-soft); }
  .planner-orb::after { content: ""; position: absolute; inset: .65rem; border-radius: 999px; background: var(--running); animation: pulse 1.25s ease-in-out infinite; }
  .planner-status p { margin: 0; }
  .planner-status .meta { display: block; margin-top: .2rem; }
  .ceremony-road { margin: .75rem 0 0; }
  .button-link {
    display: inline-flex; align-items: center; justify-content: center; min-height: 2.25rem; padding: 0 .875rem;
    border-radius: calc(var(--radius) - 2px); background: var(--primary); color: var(--primary-foreground);
    font-weight: 600; font-size: .8125rem; text-decoration: none; border: 1px solid var(--primary);
  }
  .props .row { padding: .4375rem .375rem; align-items: baseline; }
  .props .row .meta { flex: 0 0 6.5rem; }
  .props .row .mono { flex: 1 1 10rem; min-width: 0; overflow-wrap: anywhere; }
  .props .row .seal { margin-right: .375rem; }
  details.section { border: 0; background: transparent; padding: 0; margin: 1.25rem 0 0; border-radius: 0; box-shadow: none; }
  details.section[open] { padding-bottom: 0; }
  details.section > summary { list-style: none; display: flex; align-items: center; padding: .25rem 0; min-height: 2.25rem; }
  details.section > summary::-webkit-details-marker { display: none; }
  details.section > summary h2 { margin: 0; flex: 1; display: flex; align-items: center; gap: .4rem; }
  details.section > summary h2 .lane-count { border: 1px solid var(--border); border-radius: 999px; padding: .04rem .5rem; font-weight: 500; color: var(--muted-foreground); font-size: .6875rem; }
  details.section > summary::after {
    content: ""; width: .45rem; height: .45rem; flex: none; margin-right: .375rem;
    border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground);
    transform: rotate(45deg) translateY(-.125rem); transition: transform .15s;
  }
  details.section[open] > summary::after { transform: rotate(225deg) translateY(-.125rem); }
  details.section > summary:hover h2 { color: var(--foreground); }
  details.more-agents { margin: .75rem 0 0; }
  .task-layout > .task-main { min-width: 0; }
  .task-rail { position: sticky; top: 1rem; }
  .task-rail .card { margin-top: .75rem; }
  .task-rail .mono { overflow-wrap: anywhere; }
  main:has(.task-layout) { max-width: 76rem; }
  @media (max-width: 980px) {
    .task-layout { grid-template-columns: 1fr; }
    .task-rail { position: static; order: -1; border-bottom: 1px solid var(--border); padding-bottom: .75rem; margin-bottom: .75rem; }
    .acts-bar form.inline, .acts-bar .primary, .acts-bar .primary form { flex: 1 1 auto; }
    .acts-bar .primary { flex-basis: 100%; }
    .acts-bar .primary button { width: 100%; }
    .acts-bar .act-hold { flex-wrap: wrap; }
    .acts-bar .act-hold input[type=text] { flex: 1 1 8rem; width: auto; }
    .dependency-repair-actions { align-items: stretch; }
    .dependency-repair-actions form { flex: 1 1 10rem; }
    .dependency-repair-actions .dependency-repair-replace { flex-basis: 100%; }
    .dependency-repair-actions select { flex: 1 1 auto; min-width: 0; max-width: none; }
    .dependency-repair-actions button { white-space: nowrap; }
    .split { grid-template-columns: 1fr; }
    .list-pane { display: none; }
    .workbench-mobile-rail, .workbench-mobile-back { display: block; }
    .workbench-mobile-rail { margin-top: 1.75rem; border-top: 1px solid var(--border); padding-top: .75rem; }
    .workbench-mobile-back { margin: 0 0 1rem; }
  }

  /* The phone shell: the sidebar disappears; a top bar carries the project
     and quick capture; a bottom tab bar carries the destinations a thumb
     visits. Desktop is untouched. */
  .mobile-top, .tabbar { display: none; }
  @media (max-width: 760px) {
    .app { display: block; }
    .side { display: none; }
    .mobile-top {
      display: flex; align-items: center; gap: .5rem; position: sticky; top: 0; z-index: 30;
      background: color-mix(in srgb, var(--glass-strong) 90%, transparent); border-bottom: 1px solid var(--glass-border);
      padding: calc(.375rem + env(safe-area-inset-top, 0rem)) .75rem .375rem;
      -webkit-backdrop-filter: blur(22px) saturate(135%); backdrop-filter: blur(22px) saturate(135%);
    }
    /* One header row: the pill carries scope, counts, and the switch. */
    .scope-bar { display: none; }
    .mobile-top .brand-mini { font-weight: 600; font-size: .9375rem; text-decoration: none; color: var(--foreground); font-family: var(--font-mono); }
    .mobile-top .project-pill { flex: 1; min-width: 0; position: static; }
    .mobile-top a.project-pill, .mobile-top .project-pill > summary {
      min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: .0625rem;
      border: 1px solid var(--border); border-radius: 1.375rem; background: var(--card);
      min-height: 2.75rem; padding: .25rem .875rem; text-decoration: none; color: var(--foreground);
      font-size: .875rem; font-weight: 500; line-height: 1.25; cursor: pointer;
    }
    .mobile-top .project-pill > summary .name { display: inline-flex; align-items: center; gap: .25rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mobile-top a.project-pill:active, .mobile-top .project-pill > summary:active { background: var(--muted); }
    /* On a phone the menu is a sheet above the tab bar, within thumb reach. */
    .mobile-top .switcher-menu {
      position: fixed; left: .5rem; right: .5rem; top: auto; max-width: none;
      bottom: calc(3.75rem + env(safe-area-inset-bottom, 0rem)); z-index: 45;
    }
    .mobile-top .switcher-menu button { min-height: 2.75rem; }
    .mobile-top .pill-status {
      display: flex; gap: .5rem; overflow: hidden; white-space: nowrap;
      font-family: var(--font-mono); font-size: .6875rem; font-weight: 500;
      color: var(--muted-foreground); font-variant-numeric: tabular-nums;
    }
    .mobile-top .pill-status .hot { color: var(--brand); }
    .mobile-top .project-pill .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mobile-top .mobile-new {
      flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
      min-height: 2.75rem; padding: 0 .875rem; border-radius: 999px;
      background: var(--secondary); border: 1px solid var(--border); color: var(--foreground);
      font-weight: 500; font-size: .875rem; text-decoration: none;
    }
    .tabbar {
      display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
      background: color-mix(in srgb, var(--glass-strong) 92%, transparent); border-top: 1px solid var(--glass-border);
      padding: .25rem .25rem calc(.25rem + env(safe-area-inset-bottom, 0rem));
      -webkit-backdrop-filter: blur(22px) saturate(135%); backdrop-filter: blur(22px) saturate(135%);
    }
    .tabbar a {
      flex: 1; display: flex; flex-direction: column; align-items: center; gap: .125rem;
      padding: .375rem 0 .25rem; min-height: 3rem; text-decoration: none;
      color: var(--muted-foreground); font-size: .6875rem; font-weight: 500;
      font-family: var(--font-mono);
    }
    .tabbar a .glyph { display: flex; align-items: center; justify-content: center; height: 1.125rem; }
    .tabbar a .glyph svg { width: 1rem; height: 1rem; }
    .tabbar a.active { color: var(--foreground); }
    .tabbar a { position: relative; }
    .tabbar a .dot-badge {
      position: absolute; top: .3125rem; left: calc(50% + .375rem);
      width: .375rem; height: .375rem; border-radius: 9999px; background: var(--brand);
    }
    .content > main { padding: 1rem 1rem calc(4.5rem + env(safe-area-inset-bottom, 0rem)); }
    .project-add-card { padding: 1rem; }
    .project-add-actions { grid-template-columns: minmax(0, 1fr); }
    .project-add-action { min-height: 5.25rem; padding: .75rem; }
    .project-add-more > summary { width: 100%; }
  }

  /* /menu mirrors the rail's workflows/admin grouping as plain headed
   * sections — no collapse: it is already one tap behind the tab bar. */
  .menu-group-label {
    margin: 1.5rem 0 .25rem; font-size: .75rem; font-weight: 600;
    color: var(--muted-foreground); font-family: var(--font-sans);
  }
  .menu-group-label:first-of-type { margin-top: .75rem; }
  .menu-list { display: flex; flex-direction: column; gap: .375rem; margin-top: .75rem; }
  .menu-row {
    display: flex; flex-direction: column; gap: .125rem; text-decoration: none;
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--card);
    padding: .75rem .875rem; color: var(--foreground); min-height: 44px; justify-content: center;
  }
  .menu-row:hover { border-color: color-mix(in srgb, var(--border) 60%, var(--muted-foreground)); }

  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(13.5rem, 1fr)); gap: .625rem; margin: .5rem 0; }
  .stat-card {
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--card);
    padding: .75rem .875rem; min-width: 0;
  }
  .stat-card .k { font-weight: 600; font-size: .875rem; display: flex; align-items: center; gap: .4rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat-card .v { font-size: .75rem; color: var(--muted-foreground); margin-top: .25rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 9999px; flex: none; }
  .dot-ok { background: var(--success); }
  /* Caution without a claim on the operator: quiet, not amber. */
  .dot-warn { background: var(--muted-foreground); }
  .dot-off { background: var(--muted-foreground); opacity: .5; }
  .dot-bad { background: var(--destructive); }
  .pulse { animation: pulse 2s ease-in-out infinite; }
  .dot-ok.pulse { background: var(--running); }
  @keyframes pulse { 50% { opacity: .35; } }

  .login-viewport { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem 1.25rem; }
  .login-shell { width: 100%; max-width: 23rem; }
  .login-shell h1 { text-align: center; margin: 0 0 .375rem; font-size: 1.5rem; letter-spacing: -0.02em; }
  .login-shell > .hint { text-align: center; margin: 0 0 2rem; font-size: 0.875rem; }
  .login-card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 1.5rem 1.5rem 1.625rem;
  }
  .login-card label:first-child { margin-top: 0; }
  .login-card .problem { margin: 0 0 1rem; }
  .login-shell button {
    width: 100%; margin-top: 1.25rem;
    background: var(--foreground); color: var(--background); border-color: var(--foreground); font-weight: 600;
  }
  .login-shell button:hover { background: color-mix(in srgb, var(--foreground) 85%, var(--background)); }
  .login-foot { text-align: center; margin: 1.5rem 0 0; font-size: 0.75rem; color: var(--muted-foreground); line-height: 1.9; }
  .login-foot code { background: none; padding: 0; color: var(--muted-foreground); overflow-wrap: anywhere; }

  @media (max-width: 640px) {
    button, form.option button { min-height: 2.75rem; }
    .topbar nav a { padding: 0 .5rem; }
  }

  /* The board: lanes as columns, the pipeline left to right. */
  .content > main:has(.board) { max-width: none; }
  .board {
    display: grid; grid-template-columns: repeat(5, minmax(12.5rem, 1fr));
    gap: .625rem; overflow-x: auto; padding-bottom: .75rem; align-items: start;
  }
  /* The phone board (board pass): lanes stack as sections that fold, the
     counts readable before a single card — what needs you, then what is
     building, then the rest. A header is a 2.75rem tap; a drawn chevron
     says which way it folds. */
  @media (max-width: 760px) {
    .board { display: flex; flex-direction: column; gap: .5rem; padding-bottom: 0; }
    .board .lane { min-height: 0; padding: 0 .625rem .125rem; }
    .board .lane > summary {
      cursor: pointer; display: flex; align-items: center; min-height: 2.75rem; margin: 0;
      -webkit-tap-highlight-color: transparent;
    }
    .board .lane > summary h2 { flex: 1; font-size: .75rem; }
    .board .lane > summary .lane-count { border: 1px solid var(--border); border-radius: 999px; padding: .04rem .5rem; margin-left: .25rem; }
    .board .lane > summary::after {
      content: ""; width: .5rem; height: .5rem; flex: none; margin-right: .25rem;
      border-right: 1.5px solid var(--muted-foreground); border-bottom: 1.5px solid var(--muted-foreground);
      transform: rotate(45deg) translateY(-.125rem); transition: transform .15s;
    }
    .board .lane[open] > summary::after { transform: rotate(225deg) translateY(-.125rem); }
    .board .lane .hint { margin-bottom: .25rem; }
    .board .lane .lane-card:last-of-type { margin-bottom: .5rem; }
    .board .lane-attention { order: 0; }
    .board .lane-building { order: 1; }
    .board .lane-queued { order: 2; }
    .board .lane-waiting { order: 3; }
    .board .lane-done { order: 4; }
  }
  .lane {
    background: color-mix(in srgb, var(--card) 45%, var(--background)); border: 1px solid var(--border);
    border-radius: var(--radius); padding: .625rem; min-height: 12rem;
  }
  .lane > summary { list-style: none; cursor: default; margin: 0 0 .125rem; }
  .lane > summary::-webkit-details-marker { display: none; }
  .lane h2 { display: flex; align-items: center; gap: .4rem; margin: 0; font-size: .6875rem; }
  .lane h2 a { color: inherit; text-decoration: none; }
  .lane h2 a:hover { text-decoration: underline; }
  .lane .hint { margin-top: 0; }
  .lane-count { color: var(--muted-foreground); font-weight: 400; font-variant-numeric: tabular-nums; }
  .lane h2::before {
    content: ""; width: .375rem; height: .375rem; border-radius: 9999px; flex: none;
    background: var(--muted-foreground); opacity: .55;
  }
  .lane-attention h2::before { background: var(--brand); opacity: 1; }
  .lane-building h2::before { background: var(--running); opacity: 1; }
  .lane-done h2::before { background: var(--success); opacity: 1; }
  .lane-card {
    display: block; text-decoration: none; color: inherit;
    background: var(--card); border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px); padding: .5rem .625rem; margin-top: .5rem;
  }
  .lane-card:hover { border-color: color-mix(in srgb, var(--border) 55%, var(--muted-foreground)); }
  .lane-card .id { display: block; font-family: var(--font-mono); font-size: .6875rem; color: var(--muted-foreground); margin-bottom: .125rem; overflow-wrap: anywhere; }
  .lane-card .t { display: block; font-size: .8125rem; font-weight: 500; line-height: 1.35; }
  .lane-card .dot { margin-right: .4rem; }
  .lane-card .meta, .lane-card .mono { display: block; margin-top: .125rem; font-size: .75rem; }
  .lane-card .why { display: block; margin-top: .125rem; font-size: .75rem; color: var(--muted-foreground); }
  /* The facts: mono key–value pairs, keys dim, values ink — one grammar on every lane. */
  .lane-card .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .0625rem .625rem; margin-top: .4rem; font-size: .6875rem; line-height: 1.5; }
  .lane-card .fact { display: contents; }
  .lane-card .fact .k { color: var(--muted-foreground); font-family: var(--font-mono); }
  .lane-card .fact .v { font-family: var(--font-mono); color: var(--foreground); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .lane-card .chips { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .4rem; }
  .lane-card .chips .badge { margin: 0; }
  /* The live strip on a building card: stage and clock in an inset well —
     the run's own facts, never a percent. */
  .lane-card .live-line {
    display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-top: .375rem;
    padding: .3rem .5rem; border-radius: calc(var(--radius) - 4px); background: var(--muted);
    font-family: var(--font-mono); font-size: .6875rem; color: var(--running); font-variant-numeric: tabular-nums;
  }
  .lane-card .live-line .clock { color: var(--muted-foreground); }
  .lane-empty { margin: .75rem 0 .25rem; }
  .plan-doc { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .8125rem; max-height: 24rem; overflow-y: auto; }
  .lane-more { display: block; margin-top: .5rem; font-size: .75rem; }

  /* The attended control room: one cross-workspace pulse, then a dense
     master rail. */
  .control-room-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 1rem; margin-bottom: 1.1rem;
  }
  .control-room-head h1 { font-size: 1.375rem; margin-top: .08rem; }
  .control-room-head .actions { display: flex; gap: .45rem; flex-wrap: wrap; justify-content: flex-end; }
  .control-room-head .actions a { text-decoration: none; }
  .command-metrics {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: .625rem; margin: .85rem 0 1.5rem;
  }
  .command-metric {
    border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); background: var(--card);
    padding: .8rem .9rem; min-width: 0;
  }
  .command-metric .value { display: block; margin-top: .25rem; font-size: 1.5rem; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; font-family: var(--font-mono); }
  .command-metric .label { display: flex; align-items: center; gap: .4rem; font-weight: 500; font-size: .8125rem; }
  .command-metric .label::before {
    content: ""; width: .375rem; height: .375rem; border-radius: 9999px;
    background: var(--muted-foreground); flex: none;
  }
  .command-metric .detail { display: block; color: var(--muted-foreground); font-size: .6875rem; margin-top: .18rem; }
  .command-metric.attention .label::before { background: var(--brand); }
  .command-metric.live .label::before { background: var(--running); }
  .workspace-pulse { margin: .4rem 0 1.5rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr)); gap: .625rem; }
  /* The workspace card: name and status word, four counts, the same counts
     as a bar, and the one tap to its board. Neutral border always; the
     needs-you count and the bar's segment carry the accent. */
  .workspace-card {
    padding: .75rem .9rem; border: 1px solid var(--border);
    border-radius: calc(var(--radius) - 2px); background: var(--card); font-size: .8125rem; min-width: 0;
  }
  /* The mate's unified workspace: a glass project navigator beside one
     long-lived conversation. The content stays calm and legible; the
     atmosphere belongs to the shell and edges, never behind the prose. */
  main:has(.chat-workspace) { max-width: 86rem; padding-top: 1.5rem; }
  .chat-workspace {
    display: grid; grid-template-columns: minmax(16rem, 18.5rem) minmax(0, 56rem);
    align-items: start; gap: clamp(1.25rem, 3vw, 2.75rem);
  }
  .chat-workspace.projects-hidden { grid-template-columns: minmax(0, 56rem); }
  .chat-workspace.projects-hidden .chat-projects { display: none; }
  .chat-main { min-width: 0; max-width: 56rem; }
  .task-chat-workspace { grid-template-columns: minmax(15rem, 18rem) minmax(0, 56rem); }
  .task-chat-context {
    position: sticky; top: 6rem; align-self: start; padding: 1rem;
    border: 1px solid var(--glass-border); border-radius: calc(var(--radius) + 3px);
    background: var(--glass); box-shadow: var(--shadow), 0 1px 0 var(--glass-highlight) inset;
    -webkit-backdrop-filter: blur(20px) saturate(130%); backdrop-filter: blur(20px) saturate(130%);
  }
  .task-chat-context-head { display: flex; align-items: center; justify-content: space-between; gap: .65rem; }
  .task-chat-context h2 { margin: .7rem 0 .25rem; color: var(--foreground); font-size: 1rem; line-height: 1.35; letter-spacing: -.025em; }
  .task-chat-context > .meta { margin: 0; overflow-wrap: anywhere; font-size: .65rem; }
  .task-chat-status { display: grid; gap: .2rem; margin-top: .85rem; padding: .7rem; border-radius: calc(var(--radius) - 3px); background: var(--warning-soft); }
  .task-chat-status.ready { background: var(--running-soft); }
  .task-chat-status strong { font-size: .75rem; }
  .task-chat-status span { color: var(--muted-foreground); font-size: .68rem; line-height: 1.45; }
  .task-chat-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .4rem; margin: .65rem 0; }
  .task-chat-facts div { min-width: 0; padding: .45rem .5rem; border-radius: calc(var(--radius) - 5px); background: color-mix(in srgb, var(--muted) 58%, transparent); }
  .task-chat-facts dt { color: var(--muted-foreground); font: 400 .58rem/1.2 var(--font-mono); text-transform: uppercase; letter-spacing: .04em; }
  .task-chat-facts dd { margin: .15rem 0 0; font-size: .68rem; overflow-wrap: anywhere; }
  .task-chat-overview-actions { display: grid; justify-items: start; gap: .55rem; margin-top: .75rem; }
  .task-chat-overview-link { display: block; font-size: .72rem; text-decoration: none; }
  .task-chat-recovery-link { min-height: 2rem; padding-inline: .7rem; font-size: .7rem; }
  #task-chat-live { display: grid; gap: 1rem; margin-bottom: 1.1rem; }
  .task-journey {
    position: relative; overflow: hidden; padding: 1rem 1.05rem;
    border-color: color-mix(in srgb, var(--accent) 16%, var(--glass-border));
    background: linear-gradient(145deg, color-mix(in srgb, var(--glass) 92%, white 8%), color-mix(in srgb, var(--card) 93%, var(--accent) 7%));
  }
  .task-journey::after { content: ""; position: absolute; width: 9rem; height: 9rem; right: -4rem; top: -5rem; border-radius: 50%; background: color-mix(in srgb, var(--accent) 8%, transparent); filter: blur(12px); pointer-events: none; }
  .task-journey-head { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .task-journey h2 { margin: .2rem 0 0; font-size: 1rem; letter-spacing: -.025em; }
  .task-journey > ol { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 0; margin: 1rem 0 .75rem; padding: 0; list-style: none; }
  .task-journey > ol::before { content: ""; position: absolute; top: .7rem; left: 10%; right: 10%; height: 1px; background: var(--border); }
  .task-journey li { position: relative; z-index: 1; display: grid; justify-items: center; gap: .35rem; color: var(--muted-foreground); font-size: .625rem; text-align: center; }
  .task-journey li i { display: grid; place-items: center; width: 1.4rem; height: 1.4rem; border: 1px solid var(--border); border-radius: 50%; background: var(--card); font: 600 .58rem/1 var(--font-mono); font-style: normal; }
  .task-journey li.complete i { color: var(--success); border-color: color-mix(in srgb,var(--success) 32%,var(--border)); background: color-mix(in srgb,var(--success) 9%,var(--card)); }
  .task-journey li.complete span { color: var(--foreground); }
  .task-journey li.active i { color: white; border-color: var(--accent); background: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb,var(--accent) 12%,transparent); }
  .task-journey li.active span { color: var(--foreground); font-weight: 650; }
  .task-journey > .meta { margin: 0; line-height: 1.45; }
  .task-journey-action { margin-top: .75rem; }
  .task-live-build { display: flex; align-items: center; flex-wrap: wrap; gap: .3rem; margin: .75rem 0 0; font-size: .72rem; }
  .task-live-build .live-dot { width: .45rem; height: .45rem; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 4px color-mix(in srgb,var(--success) 10%,transparent); }
  .chat-action-card { padding: 0; overflow: hidden; }
  .chat-action-card:not(details) { padding: 1rem 1.05rem; }
  .chat-action-card > summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.05rem; cursor: pointer; list-style: none; }
  .chat-action-card > summary::-webkit-details-marker { display: none; }
  .chat-action-card > summary > span:first-child { display: grid; gap: .18rem; }
  .chat-action-card > summary strong { font-size: .92rem; }
  .chat-action-card > summary small { color: var(--muted-foreground); font-size: .68rem; font-weight: 400; }
  .chat-action-card[open] > summary { border-bottom: 1px solid var(--border); }
  .chat-approval-form { display: grid; gap: .85rem; padding: 1.05rem; }
  .chat-approval-section { display: grid; gap: .3rem; }
  .chat-approval-section > p, .chat-approval-section > pre { margin: 0; }
  .chat-approval-form .approval-boundaries { margin: 0; }
  .chat-run-details { padding: .65rem .75rem; border: 1px solid var(--border); border-radius: calc(var(--radius) - 3px); background: color-mix(in srgb,var(--muted) 45%,transparent); }
  .chat-run-details > summary { color: var(--muted-foreground); cursor: pointer; font-size: .68rem; }
  .chat-run-details > .meta { margin-bottom: 0; }
  .chat-approval-form .approval-confirm { align-items: end; margin-top: .15rem; }
  .chat-approval-form .approval-confirm label { flex: 1 1 18rem; }
  .chat-approval-form .approval-confirm button { min-height: 2.65rem; }
  .chat-decisions { display: grid; gap: .7rem; }
  .chat-section-head { margin: .15rem .15rem 0; }
  .chat-section-head h2 { margin: .2rem 0 0; font-size: 1rem; }
  .chat-decisions .decide-card { margin: 0; background: var(--glass); box-shadow: var(--shadow); }
  .chat-publication { margin: -.25rem .25rem .25rem; }
  .chat-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: .5rem .25rem 0; }
  .chat-head h1 { margin-bottom: .2rem; font-size: 1.65rem; letter-spacing: -.04em; }
  .chat-head .badge-running { margin-top: .2rem; background: color-mix(in srgb, var(--success) 11%, var(--glass)); color: var(--success); }
  .chat-head-actions { display: flex; align-items: center; justify-content: flex-end; gap: .45rem; flex-wrap: wrap; }
  .task-chat-head > div { min-width: 0; flex: 1; }
  .chat-task-back { margin: 0 0 .55rem; font-size: .6875rem; }
  .chat-task-back a { text-decoration: none; }
  .task-chat-title-line { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .task-chat-title-line > div { min-width: 0; }
  .chat-project-toggle {
    display: inline-flex; align-items: center; gap: .4rem; min-height: 2rem; padding: .25rem .55rem;
    color: var(--muted-foreground); font-size: .6875rem; box-shadow: none;
  }
  .chat-project-toggle svg { width: .9rem; height: .9rem; }
  .chat-project-toggle .badge { padding-inline: .38rem; font-size: .6rem; }
  .chat-budget {
    display: flex; flex-wrap: wrap; gap: .4rem; margin: 1rem 0 1.25rem;
    color: var(--muted-foreground); font-size: .6875rem; font-variant-numeric: tabular-nums;
  }
  .chat-budget > span {
    white-space: nowrap; padding: .32rem .58rem; border: 1px solid var(--glass-border);
    border-radius: 999px; background: color-mix(in srgb, var(--glass) 74%, transparent);
  }
  .chat-overview {
    margin: 0 0 1.35rem; padding: 1rem; border-radius: calc(var(--radius) + 2px);
    background:
      linear-gradient(145deg, color-mix(in srgb, var(--running-soft) 45%, transparent), transparent 48%),
      var(--glass);
    box-shadow: var(--shadow), 0 1px 0 var(--glass-highlight) inset;
  }
  .chat-overview-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .chat-overview-head h2 { margin: .1rem 0 0; color: var(--foreground); font-size: .95rem; letter-spacing: -.02em; }
  .chat-overview-head form { margin: 0; }
  .chat-overview-head button, .chat-overview-link {
    min-height: 2rem; padding: .25rem .7rem; font-size: .6875rem; text-decoration: none;
  }
  .chat-overview-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .45rem; margin-top: .85rem; }
  .chat-overview-stat {
    display: flex; flex-direction: column; min-width: 0; padding: .65rem .7rem;
    border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px);
    background: color-mix(in srgb, var(--glass-strong) 64%, transparent); text-decoration: none;
  }
  .chat-overview-stat:hover { background: var(--glass-strong); }
  .chat-overview-stat b { color: var(--foreground); font: 600 1.2rem/1.2 var(--font-mono); font-variant-numeric: tabular-nums; }
  .chat-overview-stat span { overflow: hidden; color: var(--muted-foreground); font-size: .65rem; text-overflow: ellipsis; white-space: nowrap; }
  .chat-overview-stat.attention b { color: var(--warning); }
  .chat-overview-stat.live b { color: var(--running); }
  .chat-overview-items { display: grid; gap: .35rem; margin-top: .7rem; }
  .chat-overview-item {
    display: grid; grid-template-columns: 1.75rem minmax(0, 1fr) auto; align-items: center; gap: .6rem;
    padding: .48rem .55rem; border-radius: calc(var(--radius) - 4px); color: inherit; text-decoration: none;
  }
  .chat-overview-item:hover { background: color-mix(in srgb, var(--muted) 72%, transparent); }
  .chat-overview-icon { display: grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: .55rem; background: var(--muted); color: var(--muted-foreground); }
  .chat-overview-icon svg { width: .9rem; height: .9rem; }
  .chat-overview-item.decision .chat-overview-icon { color: var(--warning); background: var(--warning-soft); }
  .chat-overview-item.failed .chat-overview-icon { color: var(--destructive); background: var(--destructive-soft); }
  .chat-overview-item.running .chat-overview-icon { color: var(--running); background: var(--running-soft); }
  .chat-overview-copy { min-width: 0; }
  .chat-overview-copy strong, .chat-overview-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-overview-copy strong { font-size: .75rem; font-weight: 500; }
  .chat-overview-copy span { color: var(--muted-foreground); font-size: .65rem; margin-top: .05rem; }
  .chat-overview-arrow { color: var(--muted-foreground); }
  .chat-overview-clear { display: flex; align-items: center; gap: .45rem; margin: .8rem .2rem 0; color: var(--muted-foreground); font-size: .75rem; }
  .chat-overview-note { margin: .65rem .2rem 0; font-size: .6875rem; }
  .chat-readonly { margin-top: 1rem; padding: 1rem; }
  .chat-projects {
    position: sticky; top: 4rem; align-self: start; max-height: calc(100vh - 5rem); overflow-y: auto;
    padding: 1rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) + 3px);
    background: var(--glass); box-shadow: var(--shadow), 0 1px 0 var(--glass-highlight) inset;
    -webkit-backdrop-filter: blur(20px) saturate(130%); backdrop-filter: blur(20px) saturate(130%);
  }
  .chat-projects-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: .75rem; padding: 0 .15rem; }
  .chat-projects-head h2 { margin: 0; color: var(--foreground); font-size: .8125rem; letter-spacing: -.01em; }
  .chat-project-close { display: none; margin-left: auto; width: 2rem; min-height: 2rem; padding: 0; font-size: 1rem; box-shadow: none; }
  .chat-project-card {
    padding: .8rem; margin-top: .5rem; border: 1px solid transparent; border-radius: var(--radius);
    background: color-mix(in srgb, var(--muted) 58%, transparent);
    transition: transform .16s ease, background .16s, border-color .16s, box-shadow .16s;
  }
  .chat-project-card:hover {
    transform: translateY(-1px); border-color: var(--glass-border); background: color-mix(in srgb, var(--muted) 82%, transparent);
    box-shadow: 0 12px 28px -24px rgb(0 0 0 / .8), 0 1px 0 var(--glass-highlight) inset;
  }
  .chat-project-name { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .45rem; }
  .chat-project-name strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .8125rem; }
  .chat-project-name .mono { color: var(--running); font-size: .6875rem; }
  .chat-project-name .badge { background: var(--glass); font-size: .625rem; }
  .chat-project-stats { display: grid; grid-template-columns: 1fr 1fr; gap: .3rem .55rem; margin-top: .65rem; }
  .chat-project-stats span { color: var(--muted-foreground); font-size: .6875rem; white-space: nowrap; }
  .chat-project-stats b { color: var(--foreground); font-family: var(--font-mono); font-weight: 600; font-variant-numeric: tabular-nums; }
  .chat-project-stats span.hot, .chat-project-stats span.hot b { color: var(--brand); }
  .chat-project-actions { display: flex; gap: .35rem; margin-top: .65rem; }
  .chat-project-actions form { margin-bottom: 0; }
  .chat-project-actions button { min-height: 1.8rem; padding: .2rem .6rem; font-size: .6875rem; box-shadow: none; background: transparent; }
  .thread {
    display: flex; flex-direction: column; gap: 1rem; margin: 1rem 0 1.25rem;
    min-height: min(32rem, 48vh); padding: .25rem;
  }
  .thread .msg { max-width: 48rem; line-height: 1.65; }
  .thread .msg p { margin: .3rem 0; }
  .thread .msg.op {
    align-self: flex-end; max-width: min(82%, 40rem); padding: .75rem 1rem;
    border: 1px solid var(--glass-border); border-radius: 1.2rem 1.2rem .35rem 1.2rem;
    background: var(--user-message); color: #f7f7f8;
    box-shadow: 0 10px 30px -24px rgb(0 0 0 / .9), 0 1px 0 rgb(255 255 255 / .07) inset;
  }
  .thread .msg.mate {
    position: relative; align-self: stretch; padding: .75rem .5rem .75rem 3.45rem;
    border: 0; background: transparent;
  }
  .thread .msg.mate::before {
    content: "s·o"; position: absolute; top: .7rem; left: .1rem; width: 2.35rem; height: 2.35rem;
    display: grid; place-items: center; border: 1px solid var(--glass-border); border-radius: .8rem;
    background: linear-gradient(145deg, color-mix(in srgb, var(--running) 24%, var(--glass-strong)), var(--glass-strong));
    color: var(--foreground); font: 600 .6875rem/1 var(--font-mono); letter-spacing: -.04em;
    box-shadow: 0 12px 28px -20px var(--running), 0 1px 0 var(--glass-highlight) inset;
  }
  .chat-copy > :first-child { margin-top: 0; }
  .chat-copy > :last-child { margin-bottom: 0; }
  .chat-copy p { margin: .35rem 0 .7rem; }
  .chat-copy h3 { margin: 1rem 0 .35rem; color: var(--foreground); font-size: .8125rem; }
  .chat-copy ul, .chat-copy ol { margin: .4rem 0 .75rem; padding-left: 1.3rem; }
  .chat-copy li { margin: .24rem 0; padding-left: .15rem; }
  .chat-message-foot { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-top: .75rem; }
  .chat-message-foot time { color: var(--muted-foreground); font: 400 .625rem/1 var(--font-mono); white-space: nowrap; }
  .chat-activity { display: flex; flex-wrap: wrap; gap: .3rem; }
  .chat-activity span { padding: .15rem .42rem; border: 1px solid var(--glass-border); border-radius: 999px; color: var(--muted-foreground); font: 400 .625rem/1.25 var(--font-mono); }
  .proposal { margin: .9rem 0 0; padding: 0; overflow: hidden; background: var(--glass); }
  .proposal-head { display: grid; grid-template-columns: 2rem minmax(0, 1fr) auto; align-items: center; gap: .65rem; padding: .75rem .85rem; border-bottom: 1px solid var(--glass-border); }
  .proposal-head > span:nth-child(2) { min-width: 0; }
  .proposal-head strong, .proposal-head small { display: block; }
  .proposal-head strong { font-size: .75rem; }
  .proposal-head small { margin-top: .05rem; color: var(--muted-foreground); font-size: .625rem; }
  .proposal-icon { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: .6rem; color: var(--running); background: var(--running-soft); }
  .proposal-icon svg { width: 1rem; height: 1rem; }
  .proposal-cancel .proposal-icon { color: var(--destructive); background: var(--destructive-soft); }
  .proposal-answer .proposal-icon { color: var(--warning); background: var(--warning-soft); }
  .proposal-repair .proposal-icon { color: var(--warning); background: var(--warning-soft); }
  .proposal-body { padding: .85rem; }
  .proposal-body h3 { margin: 0; color: var(--foreground); font-size: .9rem; letter-spacing: -.015em; }
  .proposal-summary { margin: .45rem 0 0; color: var(--foreground); white-space: pre-wrap; }
  .proposal-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .35rem; margin: .75rem 0 0; }
  .proposal-facts div { min-width: 0; padding: .45rem .55rem; border-radius: calc(var(--radius) - 5px); background: color-mix(in srgb, var(--muted) 65%, transparent); }
  .proposal-facts dt { color: var(--muted-foreground); font: 400 .6rem/1.25 var(--font-mono); text-transform: uppercase; letter-spacing: .04em; }
  .proposal-facts dd { margin: .18rem 0 0; overflow-wrap: anywhere; font-size: .72rem; }
  .proposal-rationale { margin-top: .75rem; padding: .65rem .75rem; border: 1px solid var(--glass-border); border-radius: calc(var(--radius) - 3px); background: var(--muted); }
  .proposal-rationale strong { display: block; margin-top: .2rem; }
  .proposal-rationale p { margin: .2rem 0 0; color: var(--muted-foreground); }
  .proposal-disclosure { margin-top: .7rem !important; font-size: .6875rem; }
  .proposal-actions { padding: 0 .85rem .85rem; }
  .proposal-actions .acts { display: flex; align-items: center; gap: .5rem; }
  .proposal-actions form { margin: 0; }
  .proposal-actions .done, .proposal-actions .refused, .proposal-wait { margin: 0; padding: .55rem .65rem; border-radius: calc(var(--radius) - 5px); font-size: .72rem; }
  .proposal-actions .done { color: var(--success); background: var(--success-soft); }
  .proposal-actions .refused { color: var(--destructive); background: var(--destructive-soft); }
  .proposal.confirmed { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
  .proposal.refused { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
  .proposal .done { color: var(--ok); }
  .proposal .refused { color: var(--danger); }
  .chat-empty { margin: auto; padding: clamp(3rem, 9vh, 6rem) 1rem 3rem; text-align: center; }
  .chat-empty::before {
    content: "s·o"; display: grid; place-items: center; width: 3.5rem; height: 3.5rem; margin: 0 auto 1.1rem;
    border: 1px solid var(--glass-border); border-radius: 1.15rem;
    background: linear-gradient(145deg, color-mix(in srgb, var(--running) 24%, var(--glass-strong)), color-mix(in srgb, var(--ambient-one) 35%, var(--glass-strong)));
    box-shadow: 0 20px 50px -25px var(--running), 0 1px 0 var(--glass-highlight) inset;
    font: 600 .8rem/1 var(--font-mono); letter-spacing: -.05em;
  }
  .chat-empty > strong { display: block; font-size: 1.2rem; letter-spacing: -.025em; }
  .chat-empty > .meta { margin-top: .4rem; }
  .chat-prompts { display: flex; justify-content: center; flex-wrap: wrap; gap: .5rem; margin-top: 1.25rem; }
  .chat-prompts form { margin: 0; }
  .chat-prompts button { min-height: 2.35rem; box-shadow: none; background: var(--glass); padding-inline: .9rem; }
  .chat-thinking { display: flex; align-items: center; gap: .75rem; padding: .75rem .85rem; }
  .chat-thinking p { flex: 1; margin: 0; }
  .chat-thinking p strong, .chat-thinking p span { display: block; }
  .chat-thinking p span { margin-top: .08rem; }
  .chat-thinking form { margin: 0; }
  .thinking-orb { position: relative; width: 2rem; height: 2rem; flex: none; border-radius: 999px; background: var(--running-soft); }
  .thinking-orb::after { content: ""; position: absolute; inset: .55rem; border-radius: inherit; background: var(--running); animation: pulse 1.25s ease-in-out infinite; }
  .composer {
    display: flex; align-items: flex-end; gap: .75rem; padding: .7rem; margin-top: .5rem;
    border-radius: 1.35rem; background: var(--glass-strong);
  }
  .composer label { flex: 1; min-width: 0; margin: 0; font-size: 0; }
  .composer textarea {
    width: 100%; min-height: 3.5rem; max-height: 13rem; margin: 0; padding: .75rem .85rem;
    resize: vertical; border: 0; background: transparent; box-shadow: none; font-size: 1rem;
  }
  .composer textarea:hover, .composer textarea:focus-visible { border: 0; box-shadow: none; }
  .composer button {
    flex: 0 0 2.75rem; width: 2.75rem; min-height: 2.75rem; padding: 0; border-radius: 999px;
    font-size: 0; box-shadow: 0 10px 24px -16px rgb(255 255 255 / .65);
  }
  .composer button::after { content: "↑"; font: 600 1.15rem/1 var(--font-sans); }
  .chat-main > details { margin-top: 1rem; background: color-mix(in srgb, var(--glass) 70%, transparent); }
  @media (min-width: 761px) {
    /* Keep the desktop composer in the document flow. A sticky bottom
     * constraint pulled it over proposal cards on long conversations (and
     * into the middle of full-page captures), hiding the very acts it asks
     * the operator to confirm. The #latest anchor still brings this form
     * into view after every turn without making it an overlay. */
    .chat-workspace .composer { position: static; width: 100%; box-shadow: var(--shadow); }
  }
  @media (min-width: 761px) and (max-width: 1199px) {
    .chat-workspace { grid-template-columns: minmax(0, 1fr); gap: 1rem; }
    .chat-main { max-width: none; }
    .chat-projects { display: none; }
    .chat-workspace.projects-open::before {
      content: ""; position: fixed; inset: 0 0 0 232px; z-index: 23; background: rgb(0 0 0 / .18);
      -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
    }
    .chat-workspace.projects-open .chat-projects {
      display: block; position: fixed; top: 4rem; left: calc(232px + 1.25rem); z-index: 25;
      width: min(18.5rem, calc(100vw - 232px - 2.5rem)); max-height: calc(100vh - 5rem);
    }
    .app.sidebar-collapsed .chat-workspace.projects-open::before { inset: 0 0 0 64px; }
    .app.sidebar-collapsed .chat-workspace.projects-open .chat-projects { left: calc(64px + 1.25rem); }
    .chat-project-close { display: grid; place-items: center; }
  }
  @media (min-width: 900px) and (max-width: 1199px) {
    .task-chat-workspace { grid-template-columns: minmax(14rem, 16rem) minmax(0, 1fr); gap: 1.25rem; }
  }
  @media (max-width: 760px) {
    main:has(.chat-workspace) { padding: 1rem 1rem calc(9rem + env(safe-area-inset-bottom, 0rem)); }
    .chat-workspace, .chat-workspace.projects-hidden { display: block; }
    .chat-workspace.projects-hidden .chat-projects { display: block; }
    .chat-project-toggle, .chat-project-close { display: none; }
    .chat-project-list { display: flex; gap: .625rem; overflow-x: auto; padding: .125rem 0 .5rem; scroll-snap-type: x proximity; }
    .chat-project-card {
      flex: 0 0 min(16rem, 78vw); scroll-snap-align: start; padding: .6rem .65rem;
      border: 1px solid var(--glass-border); border-radius: var(--radius); background: color-mix(in srgb, var(--muted) 72%, transparent);
    }
    .chat-projects { position: static; max-height: none; overflow: hidden; padding: .65rem; margin-bottom: .85rem; }
    .chat-projects-head { margin-bottom: .35rem; }
    .chat-project-stats { display: flex; flex-wrap: wrap; gap: .15rem .7rem; margin-top: .35rem; }
    .chat-project-stats span { font-size: .625rem; }
    .chat-project-stats span:last-child { display: none; }
    .chat-project-actions { margin-top: .35rem; }
    .chat-head { padding-inline: 0; }
    .chat-head h1 { font-size: 1.4rem; }
    .chat-head-actions { align-items: flex-start; }
    .task-chat-workspace .task-chat-context { display: none; }
    .task-chat-head { display: block; }
    .task-chat-head > .badge { display: none; }
    .task-chat-title-line { display: grid; gap: .65rem; }
    .task-chat-title-line .task-view-switch { justify-self: start; }
    #task-chat-live { gap: .75rem; }
    .task-journey { padding: .85rem; }
    .task-journey > ol { margin: .85rem -.2rem .65rem; }
    .task-journey > ol::before { left: 9%; right: 9%; }
    .task-journey li { font-size: .56rem; }
    .task-journey li i { width: 1.25rem; height: 1.25rem; }
    .chat-action-card > summary { align-items: flex-start; padding: .85rem; }
    .chat-action-card > summary .button-link { min-height: 2.1rem; padding-inline: .6rem; font-size: .65rem; white-space: nowrap; }
    .chat-action-card > summary small { max-width: 14rem; }
    .chat-approval-form { padding: .85rem; }
    .chat-approval-form .approval-boundaries { grid-template-columns: 1fr; }
    .chat-approval-form .approval-confirm { display: grid; }
    .chat-approval-form .approval-confirm button { width: 100%; }
    .chat-budget { gap: .3rem; margin: .65rem 0 .9rem; }
    .chat-budget > span { padding: .25rem .48rem; }
    .chat-budget > span:first-child { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .chat-overview { padding: .8rem; }
    .chat-overview-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .chat-overview-head { align-items: flex-start; }
    .chat-overview-copy strong, .chat-overview-copy span { white-space: normal; }
    .thread { min-height: 18rem; padding: 0; }
    .thread .msg.op { max-width: 90%; }
    .thread .msg.mate { padding-left: 2.8rem; padding-right: 0; }
    .thread .msg.mate::before { width: 2.15rem; height: 2.15rem; border-radius: .7rem; }
    .proposal-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .proposal-actions .acts { align-items: stretch; flex-direction: row; flex-wrap: wrap; }
    .proposal-actions .acts form { flex: 1 1 8rem; width: auto; }
    .proposal-actions .acts form:has(.arm) { flex-basis: 100%; }
    .proposal-actions .acts button { width: 100%; }
    .chat-prompts { justify-content: flex-start; flex-wrap: nowrap; overflow-x: auto; padding-bottom: .35rem; }
    .chat-prompts form { flex: none; }
    .chat-main { padding-bottom: 6rem; }
    .chat-workspace .composer {
      position: fixed; left: 1rem; right: 1rem; bottom: calc(3.75rem + env(safe-area-inset-bottom, 0rem));
      z-index: 29; margin: 0; padding: .45rem; border-radius: 1.1rem; box-shadow: var(--shadow-overlay);
    }
    /* A confirmation is the primary act. Let the composer return to the
       document flow while one is pending so it can never cover the card's
       explanation or buttons on a short phone viewport. */
    .chat-main:has(.proposal.pending) { padding-bottom: 0; }
    .chat-main:has(.proposal.pending) .composer { position: static; width: 100%; margin-top: .5rem; }
    .composer textarea { min-height: 2.75rem; padding: .55rem .65rem; font-size: .9375rem; }
  }
  main:has(.mate-mint) { max-width: 68rem; }
  main:has(.mate-mint) > h1 { margin-top: .5rem; font-size: 1.7rem; letter-spacing: -.04em; }
  .mate-mint { position: relative; max-width: 46rem; margin-top: 1.5rem; padding: 1.5rem; border-radius: calc(var(--radius) + 4px); }
  .mate-mint::before {
    content: "s·o"; position: absolute; top: 1.4rem; left: 1.4rem; width: 3rem; height: 3rem;
    display: grid; place-items: center; border: 1px solid var(--glass-border); border-radius: 1rem;
    background: linear-gradient(145deg, color-mix(in srgb, var(--running) 24%, var(--glass-strong)), color-mix(in srgb, var(--ambient-one) 35%, var(--glass-strong)));
    box-shadow: 0 18px 45px -24px var(--running), 0 1px 0 var(--glass-highlight) inset;
    font: 600 .75rem/1 var(--font-mono); letter-spacing: -.05em;
  }
  .mate-mint > p:first-child { min-height: 3rem; margin: 0; padding: .15rem 0 1.25rem 4rem; font-size: .95rem; }
  .mate-mint > p:first-child strong { display: block; margin-bottom: .2rem; font-size: 1.1rem; letter-spacing: -.02em; }
  .mate-mint form { border-top: 1px solid var(--glass-border); padding-top: .5rem; }
  .mate-terms { display: flex; flex-wrap: wrap; gap: 1rem; align-items: baseline; padding: .35rem 0; }
  .mate-terms .inline-field { white-space: nowrap; }
  button.quiet { background: transparent; color: var(--fg-muted); border-color: var(--border); }
  .answer-options { list-style: none; padding: 0; margin: 0.4rem 0; }
  .answer-options li { padding: 0.35rem 0.6rem; border-left: 3px solid var(--border); margin: 0.25rem 0; }
  .answer-options li.picked { border-left-color: var(--foreground); }
  .proposal label.arm { display: inline-flex; gap: 0.35rem; align-items: center; margin-right: 0.5rem; font-size: 0.85rem; }
  .coordinator-proposals .card { margin: 0.5rem 0; }
  .workspace-head { display: flex; align-items: center; gap: .5rem; min-width: 0; }
  .workspace-head .workspace-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-family: var(--font-mono); font-size: .8125rem; }
  .workspace-head .badge { flex: none; }
  .workspace-head form { margin: 0 0 0 auto; }
  .workspace-head form button { min-height: 2rem; padding: 0 .625rem; font-size: .75rem; width: auto; }
  .workspace-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .375rem; margin-top: .625rem; }
  .workspace-stats .pulse-stat {
    color: var(--muted-foreground); font-size: .6875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: var(--muted); border-radius: calc(var(--radius) - 4px); padding: .375rem .5rem; text-align: center;
  }
  .workspace-stats .pulse-stat b { display: block; color: var(--foreground); font-weight: 600; font-family: var(--font-mono); font-size: 1.125rem; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .workspace-stats .pulse-stat.hot b { color: var(--brand); }
  .workspace-bar { display: flex; gap: 2px; height: .375rem; margin-top: .625rem; border-radius: 9999px; overflow: hidden; background: var(--muted); }
  .workspace-bar .seg { flex: 1 1 0; }
  .workspace-bar .seg.attention { background: var(--brand); }
  .workspace-bar .seg.building { background: var(--running); }
  .workspace-bar .seg.waiting { background: var(--muted-foreground); }
  .workspace-bar .seg.queued { background: color-mix(in srgb, var(--muted-foreground) 45%, transparent); }
  .attention-stack { display: grid; gap: .55rem; }
  .attention-stack .decide-card { margin: 0; }
  .attention-stack .q { display: flex; gap: .5rem; align-items: center; justify-content: space-between; }
  .wb-rail-head {
    display: flex; align-items: flex-end; justify-content: space-between; gap: .75rem;
    padding: 0 .15rem .6rem; border-bottom: 1px solid var(--border);
  }
  .wb-rail-head h2 { margin: .1rem 0 0; color: var(--foreground); font-size: .875rem; letter-spacing: -.01em; text-transform: none; font-family: var(--font-sans); }
  .wb-rail-head a { font-size: .75rem; color: var(--muted-foreground); }
  .wb-group { margin-top: 1.05rem; }
  .wb-group > h2 {
    display: flex; align-items: center; justify-content: space-between; margin: 0 .2rem .35rem;
    font-size: .65rem;
  }
  .wb-group > h2 .lane-count { border: 1px solid var(--border); border-radius: 999px; padding: .04rem .42rem; }
  .wb-row {
    display: block; padding: .58rem .65rem; margin: .16rem 0; border: 1px solid transparent;
    border-radius: calc(var(--radius) - 4px); color: inherit; text-decoration: none;
  }
  .wb-row:hover { background: var(--card); border-color: var(--border); }
  .wb-row.wb-selected { background: var(--muted); border-color: var(--border); }
  .wb-row .wb-title { display: block; font-size: .8125rem; font-weight: 500; line-height: 1.35; }
  .wb-row .wb-meta { display: flex; align-items: center; gap: .3rem; flex-wrap: wrap; margin-top: .22rem; }
  .wb-row .badge { padding: .04rem .42rem; font-size: .65rem; }
  .wb-row .wb-reason { display: block; color: var(--muted-foreground); font-size: .72rem; margin-top: .22rem; line-height: 1.35; }
  @media (max-width: 720px) {
    .control-room-head { display: block; }
    .control-room-head .actions { justify-content: flex-start; margin-top: .75rem; }
    .command-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .workspace-pulse { grid-template-columns: 1fr; }
    .workspace-stats .pulse-stat { padding: .375rem .125rem; font-size: .625rem; letter-spacing: -.01em; }
    .permission-toggle { grid-template-columns: 1fr; }
    .task-intake { margin-top: .25rem; }
    .task-intake-hero { text-align: left; margin-bottom: .9rem; }
    .task-intake-mark { display: none; }
    .task-composer { margin-inline: 0; padding: .55rem; border-radius: 1.15rem; }
    .task-prompt textarea { min-height: 7.25rem; padding: .75rem; font-size: 1rem; }
    .task-composer-footer { flex-wrap: wrap; }
    .task-context { order: 1; flex-basis: calc(100% - 7rem); }
    .task-context-chip:first-child { max-width: 9.5rem; }
    .task-context-chip:nth-child(2) { display: none; }
    .task-quality { order: 2; }
    .task-submit { order: 3; width: 100%; }
    .task-options { order: 4; }
    .task-options-grid { grid-template-columns: 1fr; }
    .task-options-grid .wide, .task-options-grid .permission-field { grid-column: auto; }
    .approval-card { padding: 1rem; }
    .approval-boundaries, .approval-confirm { grid-template-columns: 1fr; }
    .approval-confirm .sticky-actions { margin-top: 0; }
  }

  /* Runner lanes (queue + fleet): one column per worker. */
  .content > main:has(.lanes) { max-width: none; }
  .lanes {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: .625rem; padding-bottom: .75rem; align-items: start;
  }
  @media (max-width: 40rem) {
    .lanes { display: flex; flex-direction: column; }
    .lanes .lane { min-height: 0; }
  }
  .runner-note { width: 100%; }
  .queue-handle {
    display: inline-flex; align-items: center; justify-content: center; flex: none;
    width: 2rem; height: 2rem; margin: -.375rem .125rem -.375rem -.5rem; vertical-align: middle;
    color: var(--muted-foreground); cursor: grab; user-select: none; touch-action: none; border-radius: calc(var(--radius) - 4px);
  }
  .queue-handle svg { width: 1.125rem; height: 1.125rem; }
  .queue-handle:active { cursor: grabbing; background: var(--muted); }
  .icon-button, .inline button.icon-button { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 2.75rem; min-width: 2.75rem; padding: 0; }
  .icon-button svg { width: 1rem; height: 1rem; }
  .queue-card p { margin: 0; }
  .queue-card a { text-decoration: none; }
  .queue-card a:hover { text-decoration: underline; }
  .queue-card .row + .row { margin-top: .125rem; border-bottom: none; }
  .queue-card p.row { padding: 0; border-bottom: none; }
  .tracks { margin-top: 1.5rem; }
  .tracks > .hint { margin-bottom: .75rem; }
  .track-row { margin-bottom: .6rem; }
  .track-row p { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .track-row p .right { margin-left: auto; }
  .track-row a { text-decoration: none; }
  .track-row a:hover { text-decoration: underline; }
  .track-strip { display: inline-flex; gap: .3rem; align-items: center; vertical-align: middle; }
  .fire {
    display: inline-block; width: .65rem; height: .65rem; border-radius: 50%;
    background: var(--muted);
  }
  .fire-ok { background: var(--success); }
  .fire-bad { background: var(--destructive); }
  .fire-live { background: var(--running); animation: pulse 1.6s ease-in-out infinite; }
  .fire-skip { background: transparent; border: 1.5px solid var(--muted); }

/* the phone: fingers, not cursors — tested at 320/390px */
input, select, textarea { font-size: 16px; }
button { min-height: 44px; }
@media (max-width: 40rem) {
  form.card button[type=submit], form > button[type=submit] { width: 100%; }
  input[type=text], input[type=password] { width: 100%; max-width: 100%; box-sizing: border-box; }
  main { padding-bottom: calc(1rem + env(safe-area-inset-bottom)); }
  /* Task actions are composed for a thumb, not allowed to wrap according
     to their intrinsic text widths. Every row owns the available width. */
  .task-eyebrow { line-height: 1.55; overflow-wrap: anywhere; }
  .task-title-row { display: grid; gap: .6rem; margin-bottom: .8rem; }
  .task-title-row .task-main-title { margin-bottom: 0; }
  .task-title-row .task-view-switch { justify-self: start; }
  .task-main-title { display: flex; align-items: center; flex-wrap: wrap; gap: .3rem .4rem; }
  .dispatch-copy { display: grid; gap: .2rem; }
  .dispatch-copy > strong { line-height: 1.35; }
  .dispatch-action-link, details.dispatch-recovery > summary { width: 100%; box-sizing: border-box; justify-content: center; }
  .dispatch-recovery-body { padding: .7rem; }
  .dependency-repair-actions { display: grid; grid-template-columns: 1fr; gap: .5rem; margin-top: .75rem; }
  .dependency-repair-actions form { display: flex; width: 100%; max-width: none; margin: 0; }
  .dependency-repair-actions form > button[type=submit] { width: 100%; }
  .dependency-repair-actions .dependency-repair-replace {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .5rem;
  }
  .dependency-repair-actions .dependency-repair-label { width: 100%; min-width: 0; }
  .dependency-repair-actions .dependency-repair-label > select { width: 100%; min-width: 0; max-width: none; }
  .dependency-repair-actions .dependency-repair-replace > button[type=submit] { width: auto; }
  .acts-bar { display: grid; grid-template-columns: minmax(0, 1fr); gap: .5rem; margin: .75rem 0 .35rem; }
  .acts-bar > *, .acts-bar form.inline { min-width: 0; margin: 0; }
  .acts-bar .primary { display: block; width: 100%; }
  .acts-bar .primary form { width: 100%; margin: 0; }
  .acts-bar .primary form.inline > button[type=submit] { width: 100%; margin: 0; }
  .acts-bar .act-hold {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center;
    gap: .5rem; width: 100%;
  }
  .acts-bar .act-hold input[type=text] { width: 100%; min-width: 0; margin: 0; }
  .acts-bar .act-hold > button[type=submit] { width: auto; white-space: nowrap; }
  .acts-why { margin: .25rem 0 .85rem; font-size: .75rem; line-height: 1.5; }
  .acts-why-plan { display: none; }
  .task-scope-needed { padding: .85rem 1rem; }
  .task-scope-needed p { margin: .2rem 0; }
  .receipt-head { display: grid; gap: .45rem; }
  .receipt-proof { justify-self: start; }
  .receipt-facts { grid-template-columns: 1fr; }
  .receipt-actions { display: grid; grid-template-columns: 1fr; }
  .receipt-actions .button-link { width: 100%; box-sizing: border-box; text-align: center; }
  .diff-review { margin-inline: -.1rem; }
  .diff-review-bar { padding-left: .7rem; }
  .diff-file > summary { padding-inline: .7rem; }
  .diff-line { grid-template-columns: 2.75rem 2.65rem 2.65rem minmax(max-content, 1fr); min-height: 2.75rem; }
  .diff-annotate, .diff-annotate-space { width: 2.75rem; min-width: 2.75rem; min-height: 2.75rem; }
  .diff-review[data-mode="view"] .diff-line { grid-template-columns: 0 2.65rem 2.65rem minmax(max-content, 1fr); }
  .diff-review[data-mode="view"] .diff-annotate,
  .diff-review[data-mode="view"] .diff-annotate-space { width: 0; min-width: 0; }
  .diff-line code, .diff-gutter { padding-top: .72rem; padding-bottom: .72rem; }
  .diff-comment-target { grid-template-columns: minmax(0, 1fr) 4.75rem; }
  .diff-comment-form button { width: 100%; }
  .revision-from-comments { display: grid; }
  .revision-from-comments button { width: 100%; }
  /* A decision option on a phone: the answer is the full-width thumb
     target; its recommendation and consequence share the line beneath. */
  .decide-option > button { flex: 0 0 100%; width: 100%; }
  .decide-option .badge { flex: none; }
  .decide-option .meta { flex: 1 1 10rem; }
  /* A queue card's controls read as one row under the id: to-front · reserve (stretching) · move. */
  .queue-card p.row.meta { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .queue-card p.row.meta > .mono { flex: 0 0 100%; }
  .queue-card .inline { margin: 0; display: inline-flex; align-items: center; gap: .375rem; }
  .queue-card .inline:last-child { flex: 1 1 auto; min-width: 0; }
  .queue-card .inline > button[type=submit]:not(.icon-button) { width: auto; }
  .queue-card .inline select { flex: 1 1 6rem; min-width: 0; width: auto; min-height: 2.75rem; margin: 0; }
  .queue-card .mono { overflow-wrap: anywhere; }
  .queue-card .row + .row { margin-top: .5rem; }
  /* The title sits beside the grip and wraps within its own box; the
     chips flow after it, never above the name. */
  .queue-card p.row > a:first-of-type { flex: 1 1 12rem; min-width: 0; }
}
@media (max-width: 30rem) {
  .dependency-repair-actions .dependency-repair-replace { grid-template-columns: minmax(0, 1fr); }
  .dependency-repair-actions .dependency-repair-replace > button[type=submit] { width: 100%; }
}
@media (max-width: 26rem) {
  .acts-bar .act-hold { grid-template-columns: minmax(0, 1fr); }
  .acts-bar .act-hold > button[type=submit] { width: 100%; }
}
.next-pager { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem .75rem; margin: 0 0 .75rem; }
.next-pager .skip {
  margin-left: auto; display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem;
  padding: 0 .875rem; border: 1px solid var(--border); border-radius: 999px;
  text-decoration: none; color: var(--foreground); background: var(--card);
}
.next-pager .skip:hover { border-color: color-mix(in srgb, var(--border) 60%, var(--muted-foreground)); }

/* Motion: only where a human caused the change — navigation, presses,
   overlays. Liveness swaps stay instant; the pulse dot is the one "alive"
   signal. Everything dies under prefers-reduced-motion; auto-refresh pages
   opt out of the navigation cross-fade separately (see shell()). */
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
      box-shadow: 0 2px 8px -2px rgb(0 0 0 / .35);
    }
  }
}
@keyframes rise { from { opacity: 0; margin-top: 4px; } }
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*), ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
  .pulse, .fire-live { animation: none; }
  .palette, .kbd-help { animation: none; }
  .app, button, .side nav a, .nav-group > summary .chevron, .chat-project-card { transition: none; }
  button:hover, .side nav a:hover, .chat-project-card:hover { transform: none; }
}

/* The shortcuts overlay: display-only, toggled by the chrome layer, absent
   from sensitive pages. */
.kbd-help {
  position: fixed; top: 18vh; left: 50%; transform: translateX(-50%); width: min(26rem, 92vw);
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-overlay);
  padding: 1rem 1.25rem; z-index: 50;
}
.kbd-help h2 { margin: 0 0 .5rem; font-size: .8125rem; }
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

/* The tournament comparison: an at-a-glance table and side-by-side cards. */
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

/* The per-file comment button: a small real button beside a diff row. */
button.pick-file { min-height: 1.5rem; padding: 0 .5rem; font-size: .6875rem; }

/* Sticky ceremony actions: single-primary-action forms keep their submit
   within thumb reach on phones. Desktop: plain flow. */
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
  active: "inbox" | "board" | "queue" | "fleet" | "workbench" | "work" | "done" | "activity" | "review" | "system" | "tasks" | "runs" | "caps" | "routines" | "projects" | "settings" | "chat" | "people" | "mode" | "menu" | "none";
  project: string | null;
  /** The surface's scope for the scope bar — which rows this screen can
   * show. Derived from the ROUTE, not the session: portfolio and fleet are
   * all-project even while a project is open; the board says which of its
   * two modes it is in. Absent = the session default (open project, else
   * all projects). Display only — switching stays POST + CSRF. */
  scope?: "all" | "project" | "board-all";
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
  /** A compact pulse for the currently open workspace. Null in the
   * cross-workspace view; absent only when the store could not answer. */
  projectPeek?: ProjectPeek | null;
  /** The switcher (board pass): every enrolled project inside the ceiling,
   * most recently opened first — the one-tap switch on any screen. */
  projects?: { path: string; name: string }[];
  /** The session's csrf token, for the switcher's forms; "" when the
   * request has no cookie session (bearer), which renders the switcher
   * inert. */
  csrf?: string;
  /** Where a switch made on this screen returns to. */
  returnTo?: string;
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
function regionScript(regionId: string, fragmentName: string, everySeconds: number, path?: string): string {
  const ms = Math.max(5, Math.floor(everySeconds)) * 1000;
  // Where the fragment lives: the page's own URL by default; an explicit
  // path when a page embeds another entity's region (the task page embeds
  // the live run's peek, slice 1c — no proxy route exists for it).
  const target = path === undefined ? "location.pathname+q" : JSON.stringify(`${path}?fragment=${fragmentName}`);
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
    `function keep(){var data={lanes:[],focus:null,pager:-1,fold:{}};` +
    `region.querySelectorAll("details.lane").forEach(function(d){var k=laneKey(d);if(k)data.fold[k]=d.open;});` +
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
    `region.querySelectorAll("details.lane").forEach(function(d){var k=laneKey(d);if(k&&k in data.fold){if(data.fold[k])d.setAttribute("open","");else d.removeAttribute("open");}});` +
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
    `fetch(${target},{redirect:"manual",cache:"no-store"})` +
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
function transcriptScript(path?: string, elementId = "live-transcript"): string {
  const base = path === undefined ? "location.pathname" : JSON.stringify(path);
  return (
    `(function(){var out=document.getElementById(${JSON.stringify(elementId)});if(!out)return;` +
    `var from=0,busy=false,stopped=false;` +
    `function near(){return out.scrollHeight-out.scrollTop-out.clientHeight<40;}` +
    `function go(){if(stopped)return;if(busy||document.hidden){later();return;}busy=true;` +
    `fetch(${base}+"?fragment=transcript&from="+from,{redirect:"manual",cache:"no-store"})` +
    `.then(function(r){if(r.type==="opaqueredirect"||r.status===401||r.status===403){stopped=true;return null;}` +
    `if(r.status===409)return{error:"replaced"};return r.ok?r.json():null;})` +
    `.then(function(d){busy=false;if(d===null){later();return;}if(stopped)return;` +
    `if(d.error==="replaced"){from=0;out.textContent="[the view restarted]\\n";later();return;}` +
    `if(d.error){stopped=true;return;}` +
    `var stick=near();` +
    `if(typeof d.text==="string"&&d.text!==""){out.appendChild(document.createTextNode(d.text));if(stick)out.scrollTop=out.scrollHeight;}` +
    `if(typeof d.nextOffset==="number"&&d.nextOffset>=from){from=d.nextOffset;}` +
    `if(d.final===true){stopped=true;var m=document.getElementById(${JSON.stringify(`${elementId}-state`)});` +
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

/** The rail's presentation-only state is safe beside a password ceremony:
 * it never reads a field or sends a request, and keeps the chat collapsible
 * from its very first screen while the palette and global keys remain absent. */
function sidebarScript(): string {
  return (
    `(function(){var app=document.querySelector(".app"),sideToggle=document.querySelector(".side-toggle");` +
    `function setSide(collapsed){if(!app||!sideToggle)return;app.classList.toggle("sidebar-collapsed",collapsed);` +
    `sideToggle.setAttribute("aria-expanded",String(!collapsed));sideToggle.setAttribute("aria-label",collapsed?"expand sidebar":"collapse sidebar");` +
    `sideToggle.setAttribute("title",collapsed?"expand sidebar":"collapse sidebar");}` +
    `if(app&&sideToggle){var sideCollapsed=false;try{sideCollapsed=localStorage.getItem("standing-orders:sidebar-collapsed")==="1";}catch(e){}` +
    `setSide(sideCollapsed);sideToggle.addEventListener("click",function(){var next=!app.classList.contains("sidebar-collapsed");setSide(next);` +
    `try{localStorage.setItem("standing-orders:sidebar-collapsed",next?"1":"0");}catch(e){}});}})();`
  );
}

function chromeScript(): string {
  return (
    beatScript() +
    sidebarScript() +
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
    // The rail's two accordion groups stay exclusive: opening one closes
    // the other. Each <details> already carries its own open/closed state
    // and keyboard operation natively — this only enforces "at most one
    // open" on top of that, and no-ops wherever the groups are absent.
    `var navGroups=document.querySelectorAll(".nav-group");` +
    `navGroups.forEach(function(g){g.addEventListener("toggle",function(){` +
    `if(g.open){navGroups.forEach(function(o){if(o!==g)o.removeAttribute("open");});}});});` +
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
    `document.addEventListener("click",function(ev){if(helpOpen()&&!help.contains(ev.target))toggleHelp();` +
    `document.querySelectorAll("details.switcher[open]").forEach(function(d){if(!d.contains(ev.target))d.removeAttribute("open");});});` +
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
    `var map={b:"/board",i:"/",w:"/workbench",r:"/routines",d:"/done",q:"/board?view=order",f:"/fleet",t:"/tasks",a:"/activity",p:"/projects"};` +
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
    /** A password ceremony is on this page: the chrome gains no forms, so
     * the switcher renders inert — the name, and the one /projects link. */
    sensitive?: boolean;
    /** Whether the presentation-only desktop rail control has a nonce'd
     * handler. Sensitive pages may opt in; one-time-secret pages do not. */
    sidebarToggle?: boolean;
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
    // viewport-fit=cover is what makes env(safe-area-inset-*) non-zero on a
    // notched phone; without it the tab bar sits under the home indicator.
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0c0e">`,
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafafa">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
    `<link rel="icon" href="/icon.svg" type="image/svg+xml">`,
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
    `<a href="${href}" aria-label="${escape(label)}" title="${escape(label)}"${chrome.active === key ? ' class="active"' : ""}${key === "inbox" && count !== undefined ? ` data-waiting="${count}"` : ""}>` +
    `${NAV_ICONS[key] === undefined ? "" : `<span class="glyph">${NAV_ICONS[key]}</span>`}${label}` +
    `${count !== undefined && count > 0 ? ` <span class="count badge badge-open">${count}${key === "inbox" && chrome.inboxSaturated ? "+" : ""}</span>` : ""}</a>`;

  // The scope bar (portfolio arc §1): ONE row naming which rows this screen
  // can show — derived from the route's declared scope, falling back to the
  // session default. It replaced the sidebar workspace card and the mobile
  // pill's link as the single scope truth. Display and GET navigation only;
  // switching projects stays the POST + CSRF /projects flow.
  const effectiveScope: "all" | "project" | "board-all" =
    chrome.scope ?? (chrome.project === null ? "all" : "project");
  const peekCounts = chrome.projectPeek === null || chrome.projectPeek === undefined || effectiveScope !== "project" ? null : chrome.projectPeek;
  const scopeCounts = peekCounts === null
    ? ""
    : (peekCounts.waiting > 0 ? `<span class="hot">${peekCounts.waiting} needs you</span>` : `<span>0 needs you</span>`) +
      `<span>${peekCounts.running} live</span><span>${peekCounts.queued} queued</span>`;
  // On a desk each count is the road to what it counts; inside the phone
  // pill's summary they stay text, since the pill itself is the switcher.
  const scopeStatus = peekCounts === null
    ? ""
    : `<span class="scope-status">` +
      (peekCounts.waiting > 0 ? `<a class="hot" href="/">${peekCounts.waiting} needs you</a>` : `<a href="/">0 needs you</a>`) +
      `<a href="/runs">${peekCounts.running} live</a><a href="/board?view=order">${peekCounts.queued} queued</a></span>`;
  const scopeName = effectiveScope === "project" && chrome.project !== null ? escape(projectName(chrome.project)) : "all projects";
  // The switcher (board pass): the scope's name opens a menu of every
  // enrolled project — one tap to open one, or to widen to all — as plain
  // POST forms carrying the session's csrf, returning to this screen.
  // Inert wherever the chrome may carry no forms: a sensitive page, or a
  // request without a cookie session.
  const canSwitch =
    options.sensitive !== true && chrome.csrf !== undefined && chrome.csrf !== "" && chrome.projects !== undefined;
  const switcherMenu = (foot: string): string => {
    if (!canSwitch) return "";
    const hidden =
      `<input type="hidden" name="csrf" value="${escape(chrome.csrf as string)}">` +
      `<input type="hidden" name="return" value="${escape(chrome.returnTo ?? "/")}">`;
    const allCurrent = effectiveScope !== "project";
    const rows = [
      `<form method="post" action="/projects/select">${hidden}<input type="hidden" name="path" value="">` +
        `<button type="submit"${allCurrent ? ' class="current" aria-current="true"' : ""}>all projects</button></form>`,
      ...(chrome.projects ?? []).map(
        one =>
          `<form method="post" action="/projects/open">${hidden}<input type="hidden" name="path" value="${escape(one.path)}">` +
          `<button type="submit"${!allCurrent && chrome.project === one.path ? ' class="current" aria-current="true"' : ""}>${escape(one.name)}</button></form>`,
      ),
    ];
    return `<div class="switcher-menu" role="menu">${rows.join("")}${foot}</div>`;
  };
  // No "scope" label word: in this product "scope" names a task's approved
  // terms — the bar just states which projects the screen is showing.
  const scopeBar =
    `<div class="scope-bar">` +
    (canSwitch
      ? `<details class="switcher"><summary class="name">${scopeName}${CHEVRON_ICON}</summary>${switcherMenu("")}</details>`
      : `<span class="name">${scopeName}</span>`) +
    scopeStatus +
    `</div>`;
  // The rail's own accordion (sidebar rework): open the group holding the
  // active page, closed otherwise — the client toggle keeps it exclusive.
  const navGroup = (key: "workflows" | "admin", label: string, rows: NavRow[], open: boolean): string =>
    `<details class="nav-group" data-group="${key}"${open ? " open" : ""}>` +
    `<summary>${label}${CHEVRON_ICON}</summary>` +
    `<nav class="nav-group-items">${rows.map(row => item(row.key, row.href, row.label)).join("")}</nav>` +
    `</details>`;
  const side = [
    `<aside class="side">`,
    `<div class="side-head"><a class="brand" href="/"><span class="brand-long">standing<span class="dot">·</span>orders</span><span class="brand-short">s·o</span></a>`,
    ...(options.sidebarToggle === true
      ? [`<button type="button" class="side-toggle" aria-label="collapse sidebar" aria-expanded="true" title="collapse sidebar">${strokeIcon(`<path d="m15 18-6-6 6-6"/>`)}</button>`]
      : []),
    `</div>`,
    `<nav>`,
    // Task-first IA: chat, inbox, board, builds, projects — always visible,
    // always in this order, each with an icon, active, focus, and count
    // treatment. Chat is present only where the ceiling ever allows it
    // (unchanged gating); everything else is a dim text row inside one of
    // the two accordion groups below, or settings pinned under them.
    ...(chrome.chat === true ? [item("chat", "/chat", "chat")] : []),
    item("inbox", "/", "inbox", chrome.inboxCount),
    item("board", "/board", "board"),
    item("runs", "/runs", "builds"),
    item("projects", "/projects", "projects"),
    `</nav>`,
    `<a class="new-task" href="/tasks/new" aria-label="new task">+ new task</a>`,
    `<nav class="nav-groups">`,
    navGroup("workflows", "workflows", workflowsRows(), WORKFLOWS_KEYS.has(chrome.active)),
    navGroup("admin", "admin", adminRows(), ADMIN_KEYS.has(chrome.active)),
    `</nav>`,
    `<span class="grow"></span>`,
    ...(chrome.settings ? [`<nav class="nav-settings">${item("settings", "/settings", "settings")}</nav>`] : []),
    `</aside>`,
  ].join("\n");

  // The sandbox banner: every page, no dismissal — a screenshot of a demo
  // must not pass as production (adoption review, finding 8; the FENCE is
  // the refuseDemo gate in operate.ts, this is the honest label).
  const demoBanner =
    (chrome.demo === true
      ? `<div class="banner"><span class="badge">sandbox</span>demo data \u2014 nothing here spends money or reaches a remote</div>`
      : "") +
    (chrome.modeBanner === undefined
      ? ""
      : `<div class="banner"><span class="badge badge-running">mode</span>${escape(chrome.modeBanner.words)} \u00b7 <a href="/mode">the terms \u00b7 end it</a></div>`);
  // The scope bar sits between the banners and the main/split body, so it
  // can never disappear with a responsive pane (portfolio arc §1).
  const content =
    chrome.listPane === undefined
      ? `<div class="content">${demoBanner}${scopeBar}<main>${body}</main></div>`
      : `<div class="content">${demoBanner}${scopeBar}<div class="split">` +
        `<div class="list-pane">${chrome.listPane}</div>` +
        `<div class="detail"><main>${body}</main></div>` +
        `</div></div>`;

  // The phone chrome (arc 4): a top bar with the project one tap from
  // switching and quick capture, and a bottom tab bar with the always-
  // visible destinations (chat where allowed, inbox, board, builds,
  // projects) a thumb visits — everything else behind /menu. CSS shows
  // these only below 760px; desktop keeps the sidebar untouched.
  const mobileTop = [
    `<header class="mobile-top">`,
    `<a class="brand-mini" href="/">s·o</a>`,
    // On a phone the pill IS the scope row (mobile pass): the project's
    // name, its three counts, and the one /projects link at that
    // breakpoint — the scope bar hides below 760px so the header is one
    // row, not three. Desktop keeps the scope bar's link and hides this.
    canSwitch
      ? `<details class="project-pill switcher"><summary><span class="name">${scopeName}${CHEVRON_ICON}</span>${
          scopeCounts === "" ? "" : `<span class="pill-status">${scopeCounts}</span>`
          }</summary>${switcherMenu(`<a class="manage" href="/projects">manage projects</a>`)}</details>`
      : `<a class="project-pill" href="/projects"><span class="name">${scopeName}</span>${
          scopeCounts === "" ? "" : `<span class="pill-status">${scopeCounts}</span>`
        }</a>`,
    `<a class="mobile-new" href="/tasks/new">+ task</a>`,
    `</header>`,
  ].join("");
  // Drawn icons, one stroke weight, inline and CSP-safe — never unicode
  // glyphs standing in for an icon system.
  const icon = (paths: string): string =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const TAB_ICONS = {
    chat: icon(CHAT_PATHS),
    inbox: icon(`<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`),
    board: icon(`<path d="M6 5v11"/><path d="M12 5v6"/><path d="M18 5v14"/>`),
    runs: icon(`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`),
    menu: icon(`<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`),
  } as const;
  const tab = (key: keyof typeof TAB_ICONS & Chrome["active"], href: string, label: string, count?: number): string =>
    // A phone tab says THAT something waits, with a dot; the number is on
    // the inbox itself (Linear Mobile's rule — the count is one tap away).
    `<a href="${href}"${chrome.active === key ? ' class="active"' : ""}><span class="glyph">${TAB_ICONS[key]}</span>${label}` +
    `${count !== undefined && count > 0 ? `<span class="dot-badge" role="img" aria-label="${count} waiting"></span>` : ""}</a>`;
  const tabbar = [
    `<nav class="tabbar">`,
    ...(chrome.chat === true ? [tab("chat", "/chat", "chat")] : []),
    tab("inbox", "/", "inbox", chrome.inboxCount),
    tab("board", "/board", "board"),
    tab("runs", "/runs", "builds"),
    tab("menu", "/menu", "more"),
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
    `<div class="login-card">`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    `<form method="post" action="/login">`,
    `<label>username<input type="text" name="name" autocomplete="username" autofocus></label>`,
    `<label>password<input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">sign in</button>`,
    "</form>",
    `</div>`,
    `<p class="login-foot">your login was shown when the console was first started, and saved beside its database as <code>up-login.txt</code>.<br>no account? ask whoever runs this console for an invite link.</p>`,
    `</div></div>`,
  ].join("\n"), { nav: false });
}

/** The first-account page (setup review): shown only while no approver exists. */
function signupPage(problem: string | null, attemptsLeft: number): string {
  return shell("standing-orders", [
    `<div class="login-viewport"><div class="login-shell">`,
    `<h1>standing<span class="dot">\u00b7</span>orders</h1>`,
    `<div class="login-card">`,
    `<p><strong>create the first account</strong></p>`,
    `<p class="meta">this console has no accounts yet. The terminal that started it printed a setup code; enter it here with the username and password you want.</p>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    attemptsLeft <= 0
      ? ""
      : [
          `<form method="post" action="/signup">`,
          `<label>setup code<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus></label>`,
          `<label>username<input type="text" name="name" autocomplete="username"></label>`,
          `<label>password<input type="password" name="password" autocomplete="new-password"></label>`,
          `<button type="submit">create account and sign in</button>`,
          "</form>",
        ].join("\n"),
    `</div>`,
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
  /** A project is OPEN: only then do decisions answer on the card. The
   * legacy unscoped projectless inbox stays links-only too (commit-1
   * review, finding 4) — the partial belongs to a chosen project. */
  interactive: boolean;
  decisions: (Decision & { taskId: string; repo?: string | null })[];
  approvals: { taskId: string; title: string; goal: string; proposedAt: string; repo?: string | null }[];
  requeueables: { taskId: string; title: string; state: TaskState; strikes: number; incidentCount: number; repo?: string | null }[];
  cancelledBlockers: { blockerId: string; dependentCount: number; exampleDependent: string; repo?: string | null; blockerRepo?: string | null }[];
  gaps: Gap[];
  /** A completed task whose proof is short or refuted and not yet accepted
   * (Priority 2) — reads "needs verification" here too, never silently
   * "done" just because the inbox does not otherwise look at finished work. */
  needsVerification: { taskId: string; title: string; verdict: "short" | "refuted"; repo?: string | null; matrix?: CriterionMatrixRow[]; repairChain?: RepairChainRow | null }[];
  /** The first-run checklist; null once the installation has succeeded once. */
  wizard: { done: boolean; title: string; detail: string }[] | null;
  /** Whether any worker is answering right now — said at the top when none is. */
  worker: { answering: number; registered: number; lastHeard: string | null };
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
    data.cancelledBlockers.length + data.gaps.length + data.needsVerification.length === 0;

  // The roll-up inbox keeps its links-only contract — acting means opening
  // the project. A SELECTED project's inbox answers reversible options on
  // the card itself (portfolio arc §2).
  const decisions =
    data.decisions.length === 0
      ? ""
      : `<h2>answer a question</h2><p class="hint">an agent stopped mid-build to ask — nothing proceeds until you answer</p>` +
        data.decisions
          .map(decision =>
            data.interactive && !data.rollup
              ? decisionAnswerCard(decision, data.csrf, data.now, false)
              : `<a class="decide-card" href="/d/${decision.id}">` +
                `<p class="q">${escape(decision.question)}</p>` +
                `<span class="mono meta">${escape(decision.taskId)}</span>${chip(decision.repo)}` +
                `${isOverdue(decision, data.now) ? ` <span class="badge badge-overdue">overdue</span>` : ""}` +
                `</a>`,
          )
          .join("\n");

  const approvals =
    data.approvals.length === 0
      ? ""
      : `<h2>approve a scope</h2><p class="hint">scopes waiting for your approval — each binds to the exact wording you sign</p>` +
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
      : `<h2>retry stalled work</h2><p class="hint">failed builds waiting for a person — retry clears the incidents and requeues</p>` +
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

  const needsVerification =
    data.needsVerification.length === 0
      ? ""
      : `<h2>needs verification</h2><p class="hint">finished, but the proof is short or refuted — read it, then accept it on the task page if it is fine as is</p>` +
        data.needsVerification
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> ${escape(one.title)}${chip(one.repo)}` +
              ` <span class="badge badge-failed">${one.verdict === "refuted" ? "proof refuted" : "needs verification"}</span>${criterionMatrixSummary(one.matrix ?? [])}` +
              (one.repairChain == null ? "" : ` <span class="meta">— repair ${one.repairChain.outcome === "drafted" ? "drafted, awaiting approval" : one.repairChain.outcome}</span>`) +
              `</p>`,
          )
          .join("\n");

  const cancelled =
    data.cancelledBlockers.length === 0
      ? ""
      : `<h2>choose how waiting tasks continue</h2><p class="hint">these tasks were waiting for work that was cancelled — open one and choose what happens next</p>` +
        data.cancelledBlockers
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.exampleDependent)}">${escape(one.exampleDependent)}</a>${chip(one.repo)} ` +
              `<span class="meta">${one.dependentCount > 1 ? `one of ${one.dependentCount} tasks waiting` : "waiting"} for cancelled task ${escape(one.blockerId)}` +
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
        `<p><strong>Getting started</strong> <span class="meta">\u2014 disappears after the first successful run</span></p>` +
        `<p class="meta">Keep <span class="mono">standing-orders up</span> running on this machine \u2014 it opens the app and reconnects every saved project's builder.</p>` +
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

  const noWorker =
    data.worker.answering > 0
      ? ""
      : `<div class="card builder-notice" data-builder-status="${data.worker.registered === 0 ? "not-connected" : "disconnected"}">` +
        (data.worker.registered === 0
          ? `<strong>No builder is connected yet.</strong> Standing Orders is open, but no machine is connected to do project work. On the machine where the project lives, open that folder and run <span class="mono">standing-orders up</span>. Keep Standing Orders running; approved work starts automatically.`
          : `<strong>Builder disconnected.</strong> ${data.worker.registered} builder${data.worker.registered === 1 ? " is" : "s are"} configured, last checked in ${data.worker.lastHeard === null ? "never" : escape(when(data.worker.lastHeard))}. Reopen Standing Orders on that machine. Queued work starts automatically when a builder reconnects.`) +
        `</div>`;

  return screen("inbox", [
    `<h1>inbox</h1>`,
    `<p class="meta">everything that waits on you \u2014 empty means the fleet is working</p>`,
    noWorker,
    wizard,
    empty ? "" : `<p><a class="new-task" style="display:inline-block" href="/next">clear the queue \u2192 one thing at a time</a></p>`,
    empty && data.wizard === null ? `<div class="card"><p><strong>Nothing needs you.</strong></p><p class="meta">The queue is either working or waiting on its own timers. <a href="/board">Watch the board</a> or <a href="/activity">read the activity report</a>.</p></div>` : "",
    decisions,
    approvals,
    requeueables,
    needsVerification,
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
          `<label>what should get done<input type="text" name="title" placeholder="task title" maxlength="200"></label>`,
          `<label>what success looks like <span class="meta">(becomes the scope you approve on the next screen)</span><textarea name="goal" rows="2"></textarea></label>`,
          `<button type="submit">queue it \u2192 approve its scope next</button>`,
          `</form>`,
        ]),
  ].join("\n"), {
    chrome,
    // The inline-answer enhancement rides only where its forms render; it
    // touches one card and nothing else, so quick-capture input survives.
    ...(data.interactive && !data.rollup && data.decisions.length > 0
      ? { functional: { script: decisionAnswerScript(), fetches: true } }
      : {}),
  });
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
        `<span class="v">builder \u00b7 ${said} \u00b7 ${busy}/${one.capacity} building${sessions > 0 ? ` \u00b7 ${sessions} attended session${sessions === 1 ? "" : "s"} (uncapped by standing-orders — each is an agent + a supervisor process; OS limits apply)` : ""}</span></div>`
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
      : `<div class="stat-card"><span class="k"><span class="dot ${data.episode.endedAt === null ? "dot-ok pulse" : "dot-off"}"></span>Standing Orders</span>` +
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
    `<p class="hint">builders execute tasks in isolated temporary copies of each project</p>`,
    agentsCard,
    cards.length === 0
      ? `<p class="meta">No builder is connected yet. On the machine where the project lives, open that folder and run <code>standing-orders up</code>.</p>`
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
                ? `<span class="badge badge-failed">dispatch blocked</span> <span class="meta">the tracker connection needs repair — \`standing-orders sync\` says why</span>`
                : one.openEpisode !== null
                  ? `<span class="badge badge-failed">sync failing</span> <span class="meta">${escape(one.openEpisode)}</span>`
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
    // A lane is a section that can fold (board pass): open when it holds
    // cards, folded when empty, so a phone reads the counts first and a
    // desktop column never spends its height on "nothing here".
    return (
      `<details class="lane lane-${key}"${shown.length === 0 ? "" : " open"}>` +
      `<summary><h2>${title} <span class="lane-count">${cards.length}${data.saturated ? "+" : ""}</span></h2></summary>` +
      `<p class="hint">${hint}</p>` +
      (shown.length === 0 ? `<p class="meta lane-empty">nothing here</p>` : shown.map((card, index) => renderOne(card, index)).join("")) +
      (more > 0 ? `<a class="lane-more" href="/tasks">+${more} more in the task list</a>` : "") +
      `</details>`
    );
  };

  // The card's facts: mono key–value pairs under the title (board pass) —
  // task, worker, runtime — the same grammar on every lane, so the eye
  // learns one card. Chips carry the words (project, routine, reservation).
  const facts = (rows: [string, string][]): string =>
    rows.length === 0
      ? ""
      : `<span class="facts">${rows
          .map(([k, v]) => `<span class="fact"><span class="k">${escape(k)}</span><span class="v">${escape(v)}</span></span>`)
          .join("")}</span>`;
  const chips = (parts: string[]): string => {
    const kept = parts.filter(one => one !== "");
    return kept.length === 0 ? "" : `<span class="chips">${kept.join(" ")}</span>`;
  };

  const plain = (card: BoardCard): string =>
    `<a class="lane-card" href="${card.href}">` +
    `<span class="id">${escape(card.taskId)}</span>` +
    `<span class="t">${escape(card.title)}</span>` +
    `<span class="why">${escape(card.reason)}</span>` +
    facts([
      ...(card.stalledSince === null ? [] : [["waiting", age(card.stalledSince)] as [string, string]]),
    ]) +
    chips([
      card.routineName === null ? "" : `<span class="badge">${escape(card.routineName)}</span>`,
      chip(card.repo).trim(),
    ]) +
    `</a>`;

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
    `<span class="id">${escape(card.taskId)}</span>` +
    `<span class="t">${escape(card.title)}</span>` +
    `<span class="why">${escape(card.reason)}</span>` +
    facts([
      ["worker", card.assignedRunner === null ? "any free worker" : card.assignedRunner],
    ]) +
    chips([
      queuedHeads.get(`${card.assignedRunner ?? ""}|${card.repo ?? ""}`) === card.taskId
        ? `<span class="badge">${card.assignedRunner === null ? "next up" : `next for ${escape(card.assignedRunner)}`}</span>`
        : "",
      card.assignedRunner === null ? "" : `<span class="badge">reserved</span>`,
      card.routineName === null ? "" : `<span class="badge">${escape(card.routineName)}</span>`,
      chip(card.repo).trim(),
    ]) +
    `</a>`;

  const building = (card: BoardCard): string => {
    const claim = card.claim;
    if (claim === null) return plain(card);
    const minutes = Math.max(1, Math.round((data.now.getTime() - new Date(claim.claimedAt).getTime()) / 60_000));
    const workspace = claim.worktree === null ? null : (claim.worktree.split("/").pop() ?? claim.worktree);
    // Chip copy: unknown phases show nothing rather than raw tokens.
    const phase = claim.phase === null ? undefined : PHASE_WORDS[claim.phase];
    // The live strip is the run's own phase and clock — never a percent:
    // a build has no honest progress figure, only a stage and an elapsed.
    const live = claim.model === null ? "preparing workspace" : (phase ?? "the agent is working");
    return (
      `<a class="lane-card building" href="${card.href}">` +
      `<span class="id">${escape(card.taskId)}</span>` +
      `<span class="t"><span class="dot dot-ok pulse"></span>${escape(card.title)}</span>` +
      `<span class="live-line"><span class="stage">${escape(live)}</span><span class="clock">${minutes}m</span></span>` +
      facts([
        ["worker", claim.runner],
        ...(claim.model === null
          ? []
          : [["model", `${claim.provider !== null && claim.provider !== "claude" ? `${claim.provider} · ` : ""}${claim.model}`] as [string, string]]),
        ...(claim.branch === null ? [] : [["branch", `${claim.branch}${workspace === null ? "" : ` · ${workspace}`}`] as [string, string]]),
      ]) +
      chips([
        card.attempt === null ? "" : `<span class="badge">attempt ${card.attempt}</span>`,
        chip(card.repo).trim(),
      ]) +
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
              `<span class="id">${escape(row.taskId)}</span>` +
              `<span class="t">${escape(row.title)}</span>` +
              `${row.handoff === null ? "" : `<span class="why">${escape(row.handoff.length > 120 ? row.handoff.slice(0, 120) + "\u2026" : row.handoff)}</span>`}` +
              facts([
                ...(row.ranMinutes === null ? [] : [["ran", `${row.ranMinutes}m`] as [string, string]]),
                ["usage", runCostWords({ authMode: row.authMode, costUsd: row.costUsd, tokensIn: null, tokensOut: null })],
              ]) +
              chips([
                `<span class="badge badge-done">${row.outcome === "no-change" ? "no change" : "built"}</span>`,
                pr.trim(),
                data.all && row.repo !== null ? `<span class="badge">${escape(projectName(row.repo))}</span>` : "",
              ]) +
              `</a>`
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
        `<p class="hint">each dot is one firing, oldest first \u2014 the full list is under routines</p>` +
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
    data.all ? "" : `<p class="meta board-view"><strong>state</strong> \u00b7 <a href="/board?view=order">order \u2192</a> <span class="meta">drag to reorder, or to reserve a task for one worker</span></p>`,
    deltaLine,
    toggle,
    `<div class="board">`,
    lane("attention", "needs you", "these wait for a person", plain),
    lane("queued", "queued", "starts when a worker is free", queuedCard),
    lane("waiting", "waiting", "paused until a time, another task, or a requirement is ready", plain),
    lane("building", "building", "one agent per card, in its own workspace", building),
    `<details class="lane lane-done"${data.done.length === 0 ? "" : " open"}><summary><h2><a href="/done">done recently</a></h2></summary><p class="hint">the most recent \u2014 the full list is under done</p>${doneCards}</details>`,
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
      ? `<p class="meta">No finished tasks yet.</p>`
      : rows
          .map(row => {
            const pr =
              row.prNumber === null
                ? row.publicationState === null
                  ? ""
                  : ` <span class="badge">${escape(row.publicationState)}</span>`
                : ` <a href="${escape(row.prUrl ?? "#")}" class="badge badge-open">PR #${row.prNumber}</a>` +
                  (ciRed(row.prNumber) ? ` <span class="badge badge-failed">CI failing</span>` : "");
            const needsVerification =
              (row.proofVerdict === "short" || row.proofVerdict === "refuted") && !row.proofAccepted
                ? ` <span class="badge badge-failed">${row.proofVerdict === "refuted" ? "proof refuted" : "needs verification"}</span>`
                : "";
            return (
              `<div class="card"><p><a href="${taskHref(row.taskId)}"><strong>${escape(row.title)}</strong></a>` +
              `${row.outcome === "no-change" ? ` <span class="badge">no change needed</span>` : ""}${pr}${needsVerification}${criterionMatrixSummary(row.proofMatrix)}</p>` +
              `${row.handoff === null ? "" : `<p class="meta">${escape(row.handoff.length > 200 ? row.handoff.slice(0, 200) + "\u2026" : row.handoff)}</p>`}` +
              `<p class="meta mono">${escape(row.taskId)} \u00b7 ${escape(when(row.completedAt))}${row.ranMinutes === null ? "" : ` \u00b7 ran ${row.ranMinutes}m`}${row.provider === null ? "" : ` \u00b7 ${escape(runCostWords({ authMode: row.authMode, costUsd: row.costUsd, tokensIn: null, tokensOut: null }))}`}</p></div>`
            );
          })
          .join("\n");
  return screen("done", [
    `<h1>done</h1>`,
    buildsViews("done"),
    `<p class="hint">completed work \u2014 each with its final build, the agent's conclusion, usage, and its pull request</p>`,
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
  return { text: "live", badge: "badge badge-running" };
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

type ChatProjectPulse = {
  id: string;
  label: string;
  path: string;
  peek: ProjectPeek | null;
};

/** A task attached by the server to one chat turn. The thread remains the
 * unified conversation; this is a focused lens, not a second chat silo. */
type TaskChatFocus = {
  id: string;
  title: string;
  state: TaskState;
  project: string | null;
  now: Date;
  dispatch: DispatchDiagnosis | null;
  scope: "none" | "needs approval" | "approved";
  plan: "requested" | "drafted" | null;
  claimed: boolean;
  liveRun: { id: number; runner: string; startedAt: string; phase: string | null } | null;
  /** Approval uses the task page's exact nonce and joint digest. */
  approval: {
    scope: Scope;
    nonce: string;
    digest: string;
    planDocument: string | null;
    deliverable: "branch" | "report";
    raceTerms: TournamentTerms | null;
    revision: RevisionView | null;
    coordinator: { label: string; filedAgo: string | null } | null;
  } | null;
  decisions: (Decision & { taskId: string; repo: string | null })[];
  publication: Publication | null;
  /** The same compact, evidence-backed receipt shown on the task page.
   * Chat is a lens over durable workflow state, never a second copy. */
  result: CompletionReceiptView | null;
};

const taskChatHref = (taskId: string): string => `/chat?task=${encodeURIComponent(taskId)}`;

/** The one task-level road from a truthful dispatch diagnosis to its nearest
 * existing repair. This is navigation, never authority: every destination
 * still owns its original confirmation, password, CSRF, and transactional
 * checks. Keeping the map here also means the focused chat and task overview
 * cannot send a person to different fixes for the same gate. */
function taskRecoveryHref(taskId: string, diagnosis: DispatchDiagnosis | null): string | null {
  if (diagnosis?.action === null || diagnosis?.action === undefined) return null;
  const task = taskHref(taskId);
  switch (diagnosis.action) {
    case "start-worker":
    case "repair-dependency":
      return `${task}#run-status`;
    case "retry-task":
    case "unhold":
    case "write-scope":
      return `${task}#task-actions`;
    case "select-agent":
      return `${task}#scope`;
    case "approve-scope":
      return `${task}#approve`;
    case "answer-decision":
      return `${task}#decisions`;
    case "inspect-hold":
      return `${task}#holds`;
    case "repair-capability":
      return "/caps";
    case "place-task":
      return "/projects";
    case "open-result":
      return task;
  }
}

function taskViewSwitch(taskId: string, active: "overview" | "ask"): string {
  return (
    `<nav class="task-view-switch" aria-label="task view">` +
    `<a href="${taskHref(taskId)}"${active === "overview" ? ' class="active" aria-current="page"' : ""}>Overview</a>` +
    `<a href="${taskChatHref(taskId)}"${active === "ask" ? ' class="active" aria-current="page"' : ""}>Ask</a>` +
    `</nav>`
  );
}

function taskChatContext(focus: TaskChatFocus): string {
  return (
    `<aside class="task-chat-context" aria-label="current task">` +
    `<div class="task-chat-context-head"><span class="eyebrow">current task</span></div>` +
    `<h2>${escape(focus.title)}</h2>` +
    `<p class="meta mono">${escape(focus.id)}${focus.project === null ? "" : ` · ${escape(focus.project)}`}</p>` +
    `<div class="task-chat-overview-actions">` +
    `<a class="task-chat-overview-link" href="${taskHref(focus.id)}">Open full overview →</a></div>` +
    `</aside>`
  );
}

function taskChatApproval(focus: TaskChatFocus, csrf: string): string {
  const approval = focus.approval;
  if (focus.plan === "requested") {
    return `<section class="card chat-action-card"><span class="eyebrow">planning now</span><h2>The planner is preparing a scope for you</h2><p class="meta">It is reading the repository first. This conversation updates when the plan is ready; nothing builds before you approve it.</p></section>`;
  }
  if (approval === null) return "";
  const scope = approval.scope;
  const returnTo = taskChatHref(focus.id);
  if (approval.revision !== null && "problem" in approval.revision) {
    return `<section class="card chat-action-card" id="task-chat-action"><span class="eyebrow">approval needs attention</span><h2>The revision brief can’t be verified</h2><p class="meta">${escape(approval.revision.problem)}</p><a class="button-link" href="${taskHref(focus.id)}#approve">Fix this on the task →</a></section>`;
  }
  if (scope.profileState === "unresolved" || approval.nonce === "") {
    return `<section class="card chat-action-card" id="task-chat-action"><span class="eyebrow">approval needs attention</span><h2>The agent setup isn’t ready yet</h2>${profileWords(scope)}<a class="button-link" href="${taskHref(focus.id)}#scope">Fix the agent setup →</a></section>`;
  }
  const profile = scope.profile ?? null;
  const permission =
    profile === null
      ? null
      : profile.provider === "claude"
        ? profile.permissionArgv === "bypassPermissions" ? "Full access" : "Auto permissions"
        : profile.provider === "gemini"
          ? profile.approvalArgv === "yolo" ? "Full access" : "Auto permissions"
          : profile.sandboxMode === "danger-full-access" ? "Full access" : "Workspace sandbox";
  const revision = approval.revision === null
    ? ""
    : `<div class="chat-approval-section"><span class="approval-label">revision notes</span><ul class="recap">${approval.revision.comments.map(one => `<li>${one.path === null ? "" : `<span class="mono">${escape(one.path)}${one.line === null ? "" : `:${one.line}`}</span> · `}${escape(one.note)} <span class="meta">— ${escape(one.author)}</span></li>`).join("")}</ul></div>`;
  const race = approval.raceTerms === null
    ? ""
    : `<div class="chat-approval-section"><span class="approval-label">${approval.raceTerms.kind === "comparison" ? "comparison" : "tournament"}</span>` +
      `<p>${approval.raceTerms.agents.length} agents build independently: ${approval.raceTerms.agents.map(one => `<span class="mono">${escape(one.provider)} · ${escape(one.model)}</span>`).join(" vs ")}.</p>` +
      (approval.raceTerms.kind === "comparison"
        ? `<p class="meta">No dollar caps; every result and its evidence is kept for you to compare.</p>`
        : `<p class="meta">$${(approval.raceTerms.perAgentBudgetMicrousd / 1_000_000).toFixed(2)} per agent plus $${(approval.raceTerms.overrunReserveMicrousd / 1_000_000).toFixed(2)} reserve; $${(approval.raceTerms.totalBudgetMicrousd / 1_000_000).toFixed(2)} total.</p>`) +
      `</div>`;
  return (
    `<details class="card chat-action-card chat-approval" id="task-chat-action">` +
    `<summary><span><span class="eyebrow">your next step</span><strong>Review the plan & start</strong><small>Nothing builds until you approve the exact scope.</small></span><span class="button-link">Review & start</span></summary>` +
    `<form method="post" action="${taskHref(focus.id)}/approve" class="chat-approval-form approve-form">` +
    `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
    `<input type="hidden" name="nonce" value="${escape(approval.nonce)}">` +
    `<input type="hidden" name="digest" value="${escape(approval.digest)}">` +
    `<input type="hidden" name="return" value="${escape(returnTo)}">` +
    `<input type="text" name="username" autocomplete="username" class="visually-hidden" tabindex="-1" aria-hidden="true">` +
    (approval.planDocument === null ? "" : `<div class="chat-approval-section"><span class="approval-label">proposed plan</span><pre class="recap plan-doc">${escape(approval.planDocument)}</pre></div>`) +
    (approval.deliverable === "report" ? `<p class="meta"><span class="badge">report only</span> This investigates and reports back without changing the repository.</p>` : "") +
    (approval.coordinator === null ? "" : `<p class="meta">Filed by <span class="mono">${escape(approval.coordinator.label)}</span>${approval.coordinator.filedAgo === null ? "" : ` · ${escape(approval.coordinator.filedAgo)}`}.</p>`) +
    `<div class="chat-approval-section"><span class="approval-label">goal</span><p class="approval-goal">${escape(scope.goal)}</p></div>` +
    `<div class="approval-boundaries"><div class="approval-boundary"><p class="approval-label">not this</p><p>${scope.outOfScope === null ? "<em>no exclusions</em>" : escape(scope.outOfScope)}</p></div>` +
    `<div class="approval-boundary"><p class="approval-label">may touch</p><p>${scope.touches.length === 0 ? "anything" : scope.touches.map(escape).join(", ")}</p></div></div>` +
    acceptanceCeremonyHtml(scope.acceptance) + revision + race +
    `<div class="approval-chips"><span class="approval-chip">quality · <strong>${escape(qualityModeTitle(scope.qualityMode ?? "default"))}</strong></span>` +
    (profile === null ? "" : `<span class="approval-chip">${escape(profile.provider)} · ${escape(profile.model)}</span>`) +
    (permission === null ? "" : `<span class="approval-chip">${escape(permission)}</span>`) +
    (scope.budgetMicrousd === null ? "" : `<span class="approval-chip">$${(scope.budgetMicrousd / 1_000_000).toFixed(2)} attempt cap</span>`) +
    `</div><details class="chat-run-details"><summary>Agent and fallback details</summary>${profileWords(scope)}</details>` +
    `<div class="approval-confirm"><label>Your password <span class="meta">— confirms this exact scope</span><input type="password" name="token" autocomplete="current-password" placeholder="Password"></label>` +
    `<button type="submit">Approve & start</button></div></form></details>`
  );
}

/** One live, server-derived journey from request to proof. The fragment is
 * safe to refresh independently, so an in-progress message is never lost. */
function taskChatLiveRegion(focus: TaskChatFocus, csrf: string, fragment = false, inert = false): string {
  const hasScope = focus.scope !== "none";
  const approved = focus.scope === "approved";
  const hasResult = focus.result !== null;
  const building = focus.claimed || focus.liveRun !== null || focus.dispatch?.condition === "running";
  const active = hasResult ? 4 : building || approved ? 3 : focus.plan === "requested" ? 1 : hasScope ? 2 : 1;
  const labels = ["Requested", "Planned", "Approved", "Building", "Result"];
  const steps = labels.map((label, index) => {
    const state = index < active || (index === 4 && hasResult) ? "complete" : index === active ? "active" : "upcoming";
    return `<li class="${state}"><i aria-hidden="true">${state === "complete" ? "✓" : index + 1}</i><span>${label}</span></li>`;
  }).join("");
  const summary = focus.dispatch?.summary ?? (hasResult ? "Result ready" : "Checking task status");
  const detail = focus.dispatch?.detail ?? "This status comes from the task scheduler.";
  const fallback = focus.state === "done" || focus.state === "cancelled" || focus.approval !== null
    ? null
    : taskRecoveryHref(focus.id, focus.dispatch);
  const polling = !inert && (focus.approval === null || focus.plan === "requested") && focus.state !== "done" && focus.state !== "cancelled";
  return (
    `<section id="task-chat-live" aria-live="polite" data-task="${escape(focus.id)}" data-source="/chat/task-status?task=${encodeURIComponent(focus.id)}" data-poll="${polling ? "1" : "0"}">` +
    `<section class="card task-journey" aria-label="task progress"><div class="task-journey-head"><div><span class="eyebrow">task journey</span><h2>${escape(summary)}</h2></div><span class="badge badge-${escape(focus.state)}">${escape(focus.state)}</span></div>` +
    `<ol>${steps}</ol><p class="meta">${escape(detail)}</p>` +
    (focus.liveRun === null ? "" : `<p class="task-live-build"><span class="live-dot" aria-hidden="true"></span><strong>Build #${focus.liveRun.id}</strong> · ${escape(focus.liveRun.runner)} · <time data-elapsed-since="${escape(focus.liveRun.startedAt)}"></time> <a href="/r/${focus.liveRun.id}">watch details →</a></p>`) +
    (fallback === null ? "" : `<a class="button-link task-journey-action" href="${fallback}">Open the next step →</a>`) +
    `</section>` +
    (inert && focus.approval !== null && focus.plan !== "requested"
      ? `<section class="card chat-action-card"><span class="eyebrow">approval ready</span><h2>Finish the current chat response first</h2><p class="meta">The secure approval step appears here as soon as this response lands.</p></section>`
      : fragment && focus.approval !== null && focus.plan !== "requested"
        ? `<section class="card chat-action-card chat-refresh-action"><span class="eyebrow">the plan changed</span><h2>Review the updated scope before work continues</h2><p class="meta">Refresh this conversation to open the secure approval step.</p><a class="button-link" href="${taskChatHref(focus.id)}#task-chat-action">Review the updated plan →</a></section>`
        : taskChatApproval(focus, csrf)) +
    (focus.decisions.length === 0
      ? ""
      : `<section class="chat-decisions"><div class="chat-section-head"><span class="eyebrow">needs your answer</span><h2>Keep the work moving</h2></div>${focus.decisions.map(one => focus.approval !== null || inert
        ? `<div class="decide-card"><p class="q">${escape(one.question)}</p><p class="meta">${escape(oneLineOf(one.recap, 160))}</p><a href="/d/${one.id}?return=${encodeURIComponent(taskChatHref(focus.id))}">Review and answer →</a></div>`
        : decisionAnswerCard(one, csrf, focus.now, false, taskChatHref(focus.id))).join("")}</section>`) +
    (focus.result === null ? "" : completionReceiptCard(focus.result, focus.id, "chat")) +
    (focus.publication === null ? "" : `<p class="chat-publication meta">Published as ${safePrUrl(focus.publication.prUrl) === null ? `<span class="mono">PR #${focus.publication.prNumber ?? "?"}</span>` : `<a href="${escape(safePrUrl(focus.publication.prUrl) as string)}">PR #${focus.publication.prNumber ?? "?"}</a>`} · ${escape(focus.publication.state)}${focus.publication.lastCheckState === null ? "" : ` · CI ${escape(focus.publication.lastCheckState)}`}</p>`) +
    `</section>`
  );
}

function taskChatHeading(focus: TaskChatFocus): string {
  return (
    `<div class="chat-head task-chat-head"><div>` +
    `<p class="meta chat-task-back"><a href="${taskHref(focus.id)}">← task overview</a></p>` +
    `<div class="task-chat-title-line"><div><h1>${escape(focus.title)}</h1><p class="meta">Ask, steer, or revise this task in the same unified conversation.</p></div>${taskViewSwitch(focus.id, "ask")}</div>` +
    `</div></div>`
  );
}

function chatWorkspace(content: string, projects: readonly ChatProjectPulse[], csrf: string, inert: boolean, focus: TaskChatFocus | null): string {
  return focus === null
    ? `<div class="chat-workspace">${chatProjectRail(projects, csrf, inert)}<section class="chat-main">${content}</section></div>`
    : `<div class="chat-workspace task-chat-workspace">${taskChatContext(focus)}<section class="chat-main">${content}</section></div>`;
}

/** A live, server-derived portfolio card. It is deliberately independent
 * of the model's prose: the numbers and links always reflect the current
 * control plane, while chat remains the place to ask what they mean. */
function chatFleetOverview(
  snapshot: ChatSnapshot | null,
  projects: readonly ChatProjectPulse[],
  csrf: string,
  interactive: boolean,
): string {
  if (snapshot === null) {
    return `<section class="card chat-overview"><div class="chat-overview-head"><div><span class="eyebrow">live overview</span><h2>Portfolio pulse unavailable</h2></div></div><p class="meta">The conversation is still available; refresh to try the live project summary again.</p></section>`;
  }
  const total = (key: keyof ProjectPeek): number => projects.reduce((sum, one) => sum + (one.peek?.[key] ?? 0), 0);
  const needsYou = total("waiting");
  const running = total("running");
  const queued = total("queued");
  const done = total("doneRecently");
  const projectOf = (index: number): string => projects[index]?.label ?? `r${index + 1}`;
  const rows: string[] = [];
  for (const decision of snapshot.decisions.slice(0, 2)) {
    rows.push(
      `<a class="chat-overview-item decision" href="/d/${decision.id}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><path d="M12 18h.01"/><circle cx="12" cy="12" r="9"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(decision.question)}</strong><span>${escape(projectOf(decision.repoIndex))} · ${escape(decision.taskId)} · decision #${decision.id}</span></span>` +
      `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  for (const task of snapshot.tasks
    .filter(one => one.dispatch?.condition === "waiting")
    .slice(0, Math.max(0, 3 - rows.length))) {
    const dispatch = task.dispatch as DispatchDiagnosis;
    rows.push(
      `<a class="chat-overview-item decision" href="${taskHref(task.id)}" data-dispatch-status="${escape(dispatch.code)}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M12 8v4"/><path d="M12 16h.01"/><circle cx="12" cy="12" r="9"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(task.title)}</strong><span>${escape(projectOf(task.repoIndex))} · ${escape(task.id)} · ${escape(dispatch.summary.toLowerCase())}</span></span>` +
        `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  for (const task of snapshot.tasks.filter(one => one.state === "failed").slice(0, Math.max(0, 3 - rows.length))) {
    rows.push(
      `<a class="chat-overview-item failed" href="${taskHref(task.id)}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M12 9v4"/><path d="M12 17h.01"/><path d="m10.3 2.9-8.6 15A2 2 0 0 0 3.4 21h17.2a2 2 0 0 0 1.7-3.1l-8.6-15a2 2 0 0 0-3.4 0z"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(task.title)}</strong><span>${escape(projectOf(task.repoIndex))} · ${escape(task.id)} · failed</span></span>` +
        `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  // v39: a finished task whose proof is short or refuted reads here too —
  // the mate's own result card, one shared verdict word and matrix
  // summary with every other surface.
  for (const task of snapshot.tasks
    .filter(one => one.state === "done" && (one.proofVerdict === "short" || one.proofVerdict === "refuted"))
    .slice(0, Math.max(0, 3 - rows.length))) {
    rows.push(
      `<a class="chat-overview-item failed" href="${taskHref(task.id)}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(task.title)}</strong><span>${escape(projectOf(task.repoIndex))} · ${escape(task.id)} · ${task.proofVerdict === "refuted" ? "proof refuted" : "needs verification"}${task.proofMatrix.length > 0 ? ` · ${passFraction(task.proofMatrix).passed}/${passFraction(task.proofMatrix).total} criteria` : ""}</span></span>` +
        `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  for (const task of snapshot.tasks.filter(one => one.state === "running").slice(0, Math.max(0, 4 - rows.length))) {
    rows.push(
      `<a class="chat-overview-item running" href="${taskHref(task.id)}">` +
        `<span class="chat-overview-icon">${strokeIcon(`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`)}</span>` +
        `<span class="chat-overview-copy"><strong>${escape(task.title)}</strong><span>${escape(projectOf(task.repoIndex))} · ${escape(task.id)} · building now</span></span>` +
        `<span class="chat-overview-arrow" aria-hidden="true">→</span></a>`,
    );
  }
  const saturated = snapshot.tasksSaturated || snapshot.decisionsSaturated || snapshot.incidentsSaturated;
  const briefing = "Brief me on what needs my attention, what is building, and the highest-leverage next action across every project.";
  return (
    `<section class="card chat-overview" aria-label="live portfolio overview" data-card-kind="fleet-overview">` +
    `<div class="chat-overview-head"><div><span class="eyebrow">live overview</span><h2>Across ${projects.length} project${projects.length === 1 ? "" : "s"}</h2></div>` +
    (interactive
      ? `<form method="post" action="/chat" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}"><button type="submit" name="message" value="${escape(briefing)}" class="quiet">brief me</button></form>`
      : `<a href="/board?scope=all" class="chat-overview-link">open board</a>`) +
    `</div>` +
    `<div class="chat-overview-stats">` +
    `<a href="/" class="chat-overview-stat attention"><b>${needsYou}</b><span>need you</span></a>` +
    `<a href="/board?scope=all" class="chat-overview-stat live"><b>${running}</b><span>building</span></a>` +
    `<a href="/board?scope=all&amp;view=order" class="chat-overview-stat"><b>${queued}</b><span>queued</span></a>` +
    `<a href="/done" class="chat-overview-stat"><b>${done}</b><span>done today</span></a>` +
    `</div>` +
    (rows.length === 0 ? `<p class="chat-overview-clear"><span class="dot dot-ok"></span>No tasks are waiting and no builds are running.</p>` : `<div class="chat-overview-items">${rows.join("")}</div>`) +
    (saturated ? `<p class="meta chat-overview-note">Showing a bounded live view; ask for a narrower project or state to go deeper.</p>` : "") +
    `</section>`
  );
}

/**
 * The mate's project rail: one bounded pulse per admitted project, plus
 * two roads that preserve the plane's contracts. "ask" sends the stable
 * rN alias the model already sees; "board" uses the existing POST switch
 * instead of smuggling a project change through a GET parameter.
 */
function chatProjectRail(projects: readonly ChatProjectPulse[], csrf: string, inert: boolean): string {
  const statusOf = (peek: ProjectPeek | null): string =>
    peek === null
      ? "unavailable"
      : peek.waiting > 0
        ? "needs you"
        : peek.running > 0
          ? "building"
          : peek.queued > 0
            ? "queued"
            : "quiet";
  const rows = projects.map(one => {
    const peek = one.peek;
    const ask = `Give me a concise status for ${one.id} (${one.label}) and recommend the next reversible action.`;
    return (
      `<div class="chat-project-card">` +
      `<div class="chat-project-name"><span class="mono">${escape(one.id)}</span><strong>${escape(one.label)}</strong>` +
      `<span class="badge">${escape(statusOf(peek))}</span></div>` +
      (peek === null
        ? `<p class="meta">pulse unavailable</p>`
        : `<div class="chat-project-stats">` +
          `<span${peek.waiting > 0 ? ' class="hot"' : ""}><b>${peek.waiting}</b> need you</span>` +
          `<span><b>${peek.running}</b> live</span><span><b>${peek.queued}</b> queued</span>` +
          `<span><b>${peek.doneRecently}</b> done today</span></div>`) +
      `<div class="chat-project-actions">` +
      (inert
        ? ""
        : `<form method="post" action="/chat" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">` +
          `<button type="submit" name="message" value="${escape(ask)}" class="quiet" aria-label="ask about ${escape(one.label)}">ask</button></form>`) +
      `<form method="post" action="/projects/open" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">` +
      `<input type="hidden" name="path" value="${escape(one.path)}"><input type="hidden" name="return" value="/board">` +
      `<button type="submit" class="quiet" aria-label="open ${escape(one.label)} board">board</button></form></div></div>`
    );
  }).join("");
  return (
    `<aside class="chat-projects" id="chat-project-panel" aria-label="projects in this conversation">` +
    `<div class="chat-projects-head"><h2>projects</h2><span class="badge">${projects.length}</span>` +
    `<button type="button" class="chat-project-close quiet" aria-label="close projects">×</button></div>` +
    `<div class="chat-project-list">${rows}</div></aside>`
  );
}

/** Spend-authorized one-click questions: ordinary /chat posts, not a new door. */
function matePromptStarters(csrf: string, focus: TaskChatFocus | null = null): string {
  const prompts = focus === null
    ? [
        ["brief me", "Brief me on what needs my attention, what is building, and the highest-leverage next action across every project."],
        ["decisions", "Walk me through the open decisions, their options, and what you recommend I inspect first."],
        ["building now", "What is building right now across every project? Call out anything preventing progress or any unusual risk."],
        ["prioritize queues", "Review every project's queue and propose the most valuable reversible reprioritization."],
        ["draft next task", "Based on the current fleet, suggest one high-leverage task or scout investigation and draft it as a proposal."],
      ] as const
    : [
        ["what’s happening", "Read this task and explain its current status, what is blocking it, and what should happen next."],
        ["revise scope", "Read this task and propose a tighter scope if that would improve the outcome. Explain why before I confirm anything."],
        ["steer next attempt", "Read this task and propose concise guidance for its next attempt. Keep it inside the approved scope."],
        ["check the proof", "Review the evidence recorded for this task and tell me what is proven and what is still unverified."],
      ] as const;
  return `<div class="chat-prompts" aria-label="suggested questions">${prompts.map(([label, message]) =>
    `<form method="post" action="/chat" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">` +
    (focus === null ? "" : `<input type="hidden" name="task" value="${escape(focus.id)}">`) +
    `<button type="submit" name="message" value="${escape(message)}" class="quiet">${escape(label)}</button></form>`,
  ).join("")}</div>`;
}

function chatHeading(copy: string, projectCount: number, live: boolean, showProjectToggle = true): string {
  return (
    `<div class="chat-head"><div><h1>chat</h1><p class="meta">${escape(copy)}</p></div>` +
    `<div class="chat-head-actions">` +
    (showProjectToggle
      ? `<button type="button" class="chat-project-toggle quiet" aria-controls="chat-project-panel" aria-expanded="true" title="show or hide projects">` +
        `${strokeIcon(`<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>`)}<span>projects</span><span class="badge">${projectCount}</span></button>`
      : "") +
    `<span class="badge${live ? " badge-running" : ""}">${live ? "conversation live" : "unified workspace"}</span></div></div>`
  );
}

/** A deliberately small rich-text grammar for model copy. Input is escaped
 * before tags are introduced: headings, bullets, numbered steps, bold, and
 * inline code are presentation only—never executable HTML or external links. */
function renderChatText(text: string): string {
  const inline = (value: string): string =>
    escape(value)
      .replace(/`([^`\n]{1,240})`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]{1,500})\*\*/g, "<strong>$1</strong>");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (list === null) return;
    out.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    const heading = /^(?:#{1,3}\s+)(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (heading !== null) {
      flushParagraph(); closeList();
      out.push(`<h3>${inline(heading[1] ?? "")}</h3>`);
    } else if (bullet !== null || numbered !== null) {
      flushParagraph();
      const wanted = bullet !== null ? "ul" : "ol";
      if (list !== wanted) { closeList(); out.push(`<${wanted}>`); list = wanted; }
      out.push(`<li>${inline((bullet ?? numbered)?.[1] ?? "")}</li>`);
    } else if (line.trim() === "") {
      flushParagraph(); closeList();
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  flushParagraph(); closeList();
  return `<div class="chat-copy">${out.join("")}</div>`;
}

function chatActivity(activity: string | null): string {
  if (activity === null) return "";
  return `<div class="chat-activity" aria-label="work performed">${activity.split(" · ").map(one => `<span>${escape(one)}</span>`).join("")}</div>`;
}

const CHAT_UI_SCRIPT =
  `(function(){var workspace=document.querySelector(".chat-workspace"),projectPanel=document.getElementById("chat-project-panel"),projectToggle=document.querySelector(".chat-project-toggle"),projectClose=document.querySelector(".chat-project-close");` +
  `if(workspace&&projectPanel&&projectToggle){var wide=window.matchMedia("(min-width: 1200px)");var saved="";try{saved=localStorage.getItem("standing-orders:chat-projects")||"";}catch(e){}` +
  `function apply(open){workspace.classList.toggle("projects-open",open);workspace.classList.toggle("projects-hidden",!open);projectToggle.setAttribute("aria-expanded",String(open));}` +
  `function preferred(){return wide.matches&&saved!=="closed";}apply(preferred());` +
  `projectToggle.addEventListener("click",function(){var next=!workspace.classList.contains("projects-open");apply(next);if(wide.matches){saved=next?"open":"closed";try{localStorage.setItem("standing-orders:chat-projects",saved);}catch(e){}}});` +
  `if(projectClose)projectClose.addEventListener("click",function(){apply(false);});` +
  `document.addEventListener("click",function(ev){if(wide.matches||!workspace.classList.contains("projects-open"))return;var target=ev.target;if(target instanceof Node&&!projectPanel.contains(target)&&!projectToggle.contains(target))apply(false);});` +
  `wide.addEventListener("change",function(){apply(preferred());});document.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&!wide.matches&&workspace.classList.contains("projects-open"))apply(false);});}` +
  `var taskLive=document.getElementById("task-chat-live");function refreshTask(){if(!taskLive||taskLive.getAttribute("data-poll")!=="1")return;` +
  `if(document.hidden){setTimeout(refreshTask,5000);return;}var source=taskLive.getAttribute("data-source");if(!source)return;` +
  `fetch(source,{cache:"no-store"}).then(function(r){if(r.status===401||r.status===403||r.redirected){location.href="/login";return null;}return r.ok?r.text():null;})` +
  `.then(function(html){if(!html||!taskLive)return;var parsed=new DOMParser().parseFromString(html,"text/html"),next=parsed.getElementById("task-chat-live");if(!next)return;taskLive.replaceWith(next);taskLive=next;` +
  `if(taskLive.getAttribute("data-poll")==="1")setTimeout(refreshTask,5000);}).catch(function(){setTimeout(refreshTask,10000);});}` +
  `if(taskLive&&taskLive.getAttribute("data-poll")==="1")setTimeout(refreshTask,5000);` +
  `var box=document.querySelector(".composer textarea");if(box){` +
  `function size(){box.style.height="auto";box.style.height=Math.min(box.scrollHeight,208)+"px";}size();box.addEventListener("input",size);` +
  `box.addEventListener("keydown",function(ev){if(ev.isComposing||ev.key!=="Enter"||ev.shiftKey||!window.matchMedia("(min-width: 761px)").matches)return;ev.preventDefault();if(box.value.trim()!=="")box.form.requestSubmit();});}})();`;

function chatPage(chrome: Chrome, data: {
  enabled: { ok: true } & Record<string, unknown> | { ok: false; why: string };
  pending: ChatTurn | null;
  latched: ChatTurn[];
  chat: { candidates: Map<string, { key: string; draft: ChatDraft; repoPath: string }>; lastTurn: { id: number; reply: string | null; staticError: string | null; proposalsDiscarded: boolean } | null } | null;
  recent: ChatTurn[];
  turnsToday: number;
  weeklySpent: number;
  projects: ChatProjectPulse[];
  fleetSnapshot: ChatSnapshot | null;
  /** Optional task lens into the same unified conversation. */
  focusTask: TaskChatFocus | null;
  canManage: boolean;
  config: import("./store.js").ChatConfig | null;
  /** Where each provider's key comes from — never the key itself. */
  keyFacts: { provider: string; state: "environment" | "stored" | "none"; tail: string | null }[];
  /** OpenRouter's live catalog when the key is present and reachable. */
  openrouterModels: string[] | null;
  csrf: string;
  problem: string | null;
  /** The card that mints a mate session (mate arc §5), approvers only. */
  mateMint?: string;
  /** Pending coordinator proposals as cards (mate arc v3), approvers only. */
  coordinatorProposals?: string;
}): Screen {
  const configForm = (current: import("./store.js").ChatConfig | null): string => {
    const anthropicModels = PRICED_MODELS.filter(one => !one.includes("/"));
    const openrouterModels = data.openrouterModels ?? PRICED_MODELS.filter(one => one.includes("/"));
    const currentSubscription = current !== null && isSubscriptionChatProvider(current.provider);
    const models = [...new Set(["default", ...anthropicModels, ...openrouterModels, ...(current === null ? [] : [current.model])])];
    return [
      `<form method="post" action="/chat/config" class="card">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="return" value="${escape(data.focusTask === null ? "/chat" : taskChatHref(data.focusTask.id))}">`,
      `<label>provider<select name="provider">`,
      `<option value="codex-subscription"${current?.provider === "codex-subscription" ? " selected" : ""}>Codex membership (logged-in CLI)</option>`,
      `<option value="claude-subscription"${current?.provider === "claude-subscription" ? " selected" : ""}>Anthropic membership (logged-in CLI)</option>`,
      `<option value="anthropic-api"${current?.provider === "anthropic-api" ? " selected" : ""}>anthropic-api (direct API)</option>`,
      `<option value="openrouter-api"${current?.provider === "openrouter-api" ? " selected" : ""}>openrouter-api (direct API)</option>`,
      `</select></label>`,
      `<label>model <span class="meta">(use default for your membership's current model; direct API models need a pinned price)</span>` +
        `<input name="model" list="chat-models" value="${escape(current?.model ?? "default")}"><datalist id="chat-models">` +
        `${models.map(model => `<option value="${escape(model)}"></option>`).join("")}</datalist></label>`,
      data.openrouterModels === null
        ? `<p class="meta">with OPENROUTER_API_KEY in the serve environment, this list becomes OpenRouter's full live catalog — each model priced by the party that bills it</p>`
        : `<p class="meta">${data.openrouterModels.length} models live from OpenRouter's catalog; saving pins today's price — re-save to re-pin</p>`,
      currentSubscription
        ? `<p class="meta"><strong>no dollar maximum.</strong> Membership chat uses the plan attached to the logged-in CLI; the conversation stays live until you end it, and the daily turn limit still applies.</p>`
        : `<label>weekly ceiling <span class="meta">(direct API only; leave blank when choosing a membership)</span>` +
          `<input type="text" name="weekly-usd" inputmode="decimal" style="width:8rem" value="${current === null ? "" : (current.weeklyCeilingMicrousd / 1_000_000).toFixed(2)}"></label>`,
      `<label>daily turns <span class="meta">(default 50)</span>` +
        `<input type="text" name="daily-turns" inputmode="numeric" style="width:8rem" value="${current === null ? "" : String(current.dailyTurns)}"></label>`,
      currentSubscription
        ? `<p class="meta">Authenticate on this machine first with ${current?.provider === "codex-subscription" ? `<span class="mono">codex login</span>` : `the <span class="mono">claude</span> CLI`}. Standing Orders reuses that cached login and never stores it.</p>`
        : `<label>API key <span class="meta">(${data.keyFacts
          .map(one =>
            one.state === "none"
              ? `${escape(one.provider)}: none yet`
              : one.state === "environment"
                ? `${escape(one.provider)}: from the environment`
                : `${escape(one.provider)}: stored ${escape(one.tail ?? "")}`,
          )
          .join(" · ")})</span>` +
          `<input type="password" name="key" placeholder="direct API only — leave empty to keep" autocomplete="off"></label>`,
      `<label>your password <span class="meta">(typed again to change the provider)</span>` +
        `<input type="password" name="token" autocomplete="current-password"></label>`,
      `<button type="submit">${current === null ? "turn chat on" : "save"}</button>`,
      `</form>`,
      currentSubscription
        ? `<p class="meta">The membership provider runs without repository tools in a temporary directory; Standing Orders remains the only layer that can turn a proposed action into a confirmation card.</p>`
        : `<p class="meta">a pasted key is written once to a mode-0600 file beside the database — never INTO the database, never shown again beyond its last characters; an environment variable (` +
          `<span class="mono">ANTHROPIC_API_KEY</span> / <span class="mono">OPENROUTER_API_KEY</span>) always wins when set</p>`,
    ].join("\n");
  };
  const parts: string[] = [
    data.focusTask === null
      ? chatHeading("one place to understand every project and shape what happens next", data.projects.length, false, data.enabled.ok)
      : taskChatHeading(data.focusTask),
    data.focusTask === null ? "" : taskChatLiveRegion(data.focusTask, data.csrf, false, data.pending !== null),
  ];
  if (data.problem !== null) parts.push(`<div class="problem">${escape(data.problem)}</div>`);
  if (!data.enabled.ok) {
    const code = (data.enabled as { code?: string }).code;
    parts.push(
      code === "demo"
        ? `<div class="card" id="latest"><p><strong>Chat isn’t available in demo mode</strong></p><p class="meta">Demo data never contacts an external model. Start Standing Orders with a real project to use chat.</p></div>`
        : `<div class="card" id="latest"><p><strong>chat is off.</strong></p><p class="meta">${escape(data.enabled.why)}</p></div>`,
    );
    // The ceiling refusals need a restart to fix; configuration does not —
    // it is a first-class act of this console (operator request).
    if (data.canManage && (code === "unconfigured" || code === "unpriced" || code === "no-key")) {
      parts.push(`<h2>${code === "unconfigured" ? "set it up" : "reconfigure"}</h2>`, configForm(data.config));
    }
    return screen("chat", chatWorkspace(parts.join("\n"), data.projects, data.csrf, true, data.focusTask), { chrome, functional: { script: CHAT_UI_SCRIPT, fetches: data.focusTask !== null } });
  }
  const config = (data.enabled as unknown as { config: { provider: ChatProviderId; model: string; dailyTurns: number; weeklyCeilingMicrousd: number } }).config;
  const subscription = isSubscriptionChatProvider(config.provider);
  parts.push(
    `<div class="chat-budget"><span class="mono">answering with ${escape(config.provider)} · ${escape(config.model)}</span>` +
      `<span>${data.turnsToday} / ${config.dailyTurns} turns today</span>` +
      `<span>${subscription ? "membership login · no dollar ceiling" : `${chatMoney(data.weeklySpent)} of ${chatMoney(config.weeklyCeilingMicrousd)} this week`}</span></div>`,
    data.focusTask === null ? chatFleetOverview(data.fleetSnapshot, data.projects, data.csrf, false) : "",
  );
  if (!data.canManage) {
    parts.push(`<div class="card chat-readonly"><strong>Read-only view</strong><p class="meta">An approver can start the unified conversation and confirm its proposed actions. You can still open every live card and project board here.</p></div>`);
  }
  if (data.canManage && data.mateMint !== undefined) parts.push(data.mateMint);
  if (data.canManage && data.coordinatorProposals !== undefined) parts.push(data.coordinatorProposals);
  for (const turn of data.latched) {
    parts.push(
      `<div class="problem"><strong>unknown spend blocks chat.</strong> turn #${turn.id} may have cost up to ${chatMoney(turn.reservedMicrousd)} — ` +
        `<a href="/chat/ack/${turn.id}">read and acknowledge it</a> to re-enable this credential.</div>`,
    );
  }
  if (data.pending !== null) {
    parts.push(`<div class="card chat-thinking" id="latest" aria-live="polite"><span class="thinking-orb"></span><p><strong>Working on it</strong><span class="meta">turn #${data.pending.id} · up to ${chatMoney(data.pending.reservedMicrousd)} reserved · this page refreshes itself</span></p></div>`);
    parts.push(`<p class="meta"><a href="/chat">refresh now</a></p>`);
    return screen("chat", chatWorkspace(parts.join("\n"), data.projects, data.csrf, true, data.focusTask), { chrome, functional: { script: CHAT_UI_SCRIPT, fetches: data.focusTask !== null }, refreshSeconds: 3 });
  }
  const last = data.chat?.lastTurn ?? null;
  if (last !== null) {
    if (last.staticError !== null) {
      parts.push(`<div class="card" id="latest"><p class="meta">${escape(last.staticError)}</p></div>`);
    } else if (last.reply !== null) {
      parts.push(`<div class="card" id="latest">${renderChatText(last.reply)}` +
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
        `<button type="submit">file unapproved</button></form>` +
        `</div>`,
    );
  }
  if (!subscription && data.canManage && data.focusTask === null) {
    parts.push(
      `<h2>ask</h2>`,
      `<form method="post" action="/chat" class="card">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<label>message<textarea name="message" rows="3" maxlength="2000"></textarea></label>`,
      `<label>your password <span class="meta">(every message — chat spends)</span><input type="password" name="token" autocomplete="current-password"></label>`,
      `<button type="submit">ask</button>`,
      `</form>`,
    );
  }
  if (data.canManage) {
    parts.push(
      `<details><summary class="meta">chat settings</summary>`,
      configForm(data.config),
      `<form method="post" action="/chat/config" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="return" value="${escape(data.focusTask === null ? "/chat" : taskChatHref(data.focusTask.id))}">`,
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
            `<input type="hidden" name="return" value="${escape(data.focusTask === null ? "/chat" : taskChatHref(data.focusTask.id))}">` +
            `<input type="hidden" name="forget-key" value="${escape(one.provider)}">` +
            `<input type="password" name="token" placeholder="your password" autocomplete="current-password">` +
            `<button type="submit">forget the stored ${escape(one.provider)} key</button></form>`,
        )
        .join("\n"),
      `</details>`,
    );
  }
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
  return screen("chat", chatWorkspace(parts.join("\n"), data.projects, data.csrf, true, data.focusTask), { chrome, functional: { script: CHAT_UI_SCRIPT, fetches: data.focusTask !== null } });
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
    `<button type="submit">accept the charge — re-enable chat</button>`,
    `</form>`,
    `</div>`,
  ].join("\n"), { chrome });
}

/** The card that starts a conversation: the one password ceremony (mate arc §1). */
function mateMintCard(
  csrf: string,
  enabled: { billing: "metered" | "subscription"; config: { provider: ChatProviderId; weeklyCeilingMicrousd: number } },
  returnTo = "/chat",
): string {
  const subscription = enabled.billing === "subscription";
  return [
    `<div class="card mate-mint" id="latest">`,
    `<p><strong>talk to the mate.</strong> <span class="meta">one conversation across every project this console serves — it reads, recaps, and proposes; you confirm each act on a card</span></p>`,
    `<form method="post" action="/chat/mate/mint">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<input type="hidden" name="return" value="${escape(returnTo)}">`,
    `<div class="mate-terms">`,
    subscription
      ? `<span>using your logged-in ${enabled.config.provider === "codex-subscription" ? "Codex" : "Anthropic"} membership · no dollar maximum</span>`
      : `<label>this conversation may spend up to <span class="inline-field">$<input type="text" name="ceiling-usd" inputmode="decimal" value="5" style="width:5rem"></span></label>`,
    `</div>`,
    subscription
      ? `<p class="meta">the conversation stays active until you end it; the daily turn limit and your membership's own plan limits remain upstream</p>`
      : `<p class="meta">the conversation stays active until you end it; the weekly chat ceiling (${chatMoney(enabled.config.weeklyCeilingMicrousd)}) still binds above this total</p>`,
    `<label>your password <span class="meta">(once — this mints the session; messages need no password after)</span><input type="password" name="token" autocomplete="current-password"></label>`,
    `<button type="submit">start the conversation</button>`,
    `</form>`,
    `</div>`,
  ].join("\n");
}

/** The decisions the cards on a page name, for the answer card's consequences and the builder's recommendation. */
function decisionsFor(store: Store, proposals: readonly { kind: string; payload: Record<string, unknown> }[]): Map<number, Decision> {
  const out = new Map<number, Decision>();
  for (const one of proposals) {
    if (one.kind !== "answer" || typeof one.payload["decision"] !== "number") continue;
    const decision = store.getDecision(one.payload["decision"]);
    if (decision !== null) out.set(decision.id, decision);
  }
  return out;
}

type ProposalCardView = {
  id: number;
  kind: MateProposal["kind"];
  payload: Record<string, unknown>;
  state: string;
  outcome: Record<string, unknown> | null;
  /** Who proposed: the mate, or a coordinator by name. */
  by: { mate: true } | { mate: false; name: string; ago: string };
  /** Where confirm/dismiss post: `/chat/proposal` for the mate's, `/proposals` for a coordinator's. */
  actionBase: string;
};

/**
 * A proposal card: what, then confirm/dismiss, or the door's answer. An
 * `answer` card shows the question, every option WITH its consequence,
 * the builder's recommendation beside the proposer's pick, and — for an
 * irreversible option — the explicit confirmation field the decision
 * page itself uses (ruling 12).
 */
function proposalCard(view: ProposalCardView, csrf: string, inert: boolean, decision: Decision | null, returnTo: string | null = null): string {
  const payload = view.payload;
  const text = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string) : "");
  const task = text("task");
  const repoId = text("repoId");
  const presentations: Record<MateProposal["kind"], { label: string; action: string; icon: string }> = {
    task: { label: payload["report"] === true ? "Scout investigation" : "New task", action: "file task", icon: `<path d="M12 5v14"/><path d="M5 12h14"/>` },
    next: { label: "Queue priority", action: "move to front", icon: `<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>` },
    reserve: { label: "Worker assignment", action: payload["worker"] === null ? "release" : "reserve", icon: `<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>` },
    hold: { label: "Pause work", action: "hold", icon: `<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>` },
    unhold: { label: "Resume work", action: "release hold", icon: `<path d="m7 4 13 8-13 8z"/>` },
    steer: { label: "Guidance for next attempt", action: "add guidance", icon: `<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>` },
    scope: { label: "Scope revision", action: "save scope", icon: `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>` },
    answer: { label: "Decision answer", action: "confirm answer", icon: `<path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><path d="M12 18h.01"/><circle cx="12" cy="12" r="9"/>` },
    cancel: { label: "Cancel task", action: "open task", icon: `<path d="m15 9-6 6"/><path d="m9 9 6 6"/><circle cx="12" cy="12" r="9"/>` },
    repair: {
      label: "Task is waiting",
      action: text("operation") === "retry" ? "try again" : text("operation") === "replace" ? "wait for another task" : "continue without it",
      icon: `<path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3z"/>`,
    },
  };
  const presentation = presentations[view.kind];
  const facts = (...rows: [string, string][]): string => {
    const visible = rows.filter(([, value]) => value !== "");
    return visible.length === 0 ? "" : `<dl class="proposal-facts">${visible.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
  };
  let what: string;
  if (view.kind === "task") {
    what =
      `<h3>${escape(text("title"))}</h3><p class="proposal-summary">${escape(text("goal"))}</p>` +
      facts(
        ["project", `<span class="mono">${escape(repoId)}</span>`],
        ["deliverable", payload["report"] === true ? "report only" : "branch"],
        ["out of scope", escape(text("not"))],
        ["may touch", Array.isArray(payload["touches"]) ? escape((payload["touches"] as string[]).join(", ")) : ""],
      );
  } else if (view.kind === "next") {
    what = `<h3>Move <a href="${taskHref(task)}">${escape(task)}</a> to the front</h3>` + facts(["current position", `${escape(String(payload["position"] ?? "?"))} of ${escape(String(payload["of"] ?? "?"))}`], ["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "reserve") {
    what = `<h3>${payload["worker"] === null ? "Release" : "Reserve"} <a href="${taskHref(task)}">${escape(task)}</a></h3>` + facts(["destination", payload["worker"] === null ? "shared queue" : escape(text("worker"))], ["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "hold") {
    what = `<h3>Hold <a href="${taskHref(task)}">${escape(task)}</a></h3><p class="proposal-summary">${escape(text("reason"))}</p>` + facts(["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "unhold") {
    what = `<h3>Release <a href="${taskHref(task)}">${escape(task)}</a> from its hold</h3>` + facts(["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "steer") {
    const taskTitle = text("taskTitle") || task;
    what =
      `<h3>Guide <a href="${taskHref(task)}">${escape(taskTitle)}</a>'s next attempt</h3>` +
      `<p class="proposal-summary">${escape(text("note"))}</p>` +
      facts(["when", "next attempt"], ["project", `<span class="mono">${escape(repoId)}</span>`]) +
      `<p class="meta proposal-disclosure">This guides the next attempt without changing the task’s scope. It does not interrupt work already running.</p>`;
  } else if (view.kind === "scope") {
    what =
      `<h3>Rewrite <a href="${taskHref(task)}">${escape(task)}</a></h3><p class="proposal-summary">${escape(text("goal"))}</p>` +
      facts(["out of scope", escape(text("not"))], ["may touch", Array.isArray(payload["touches"]) ? escape((payload["touches"] as string[]).join(", ")) : ""], ["project", `<span class="mono">${escape(repoId)}</span>`]);
  } else if (view.kind === "repair") {
    const blocker = text("blocker");
    const operation = text("operation");
    const replacement = text("replacement");
    const taskTitle = text("taskTitle") || task;
    const blockerTitle = text("blockerTitle") || blocker;
    const replacementTitle = text("replacementTitle") || replacement;
    const taskLink = `<a href="${taskHref(task)}">${escape(taskTitle)}</a>`;
    const blockerLink = `<a href="${taskHref(blocker)}">${escape(blockerTitle)}</a>`;
    const replacementLink = replacement === "" ? "" : `<a href="${taskHref(replacement)}">${escape(replacementTitle)}</a>`;
    const heading =
      operation === "retry"
        ? `Try ${blockerLink} again`
        : operation === "replace"
          ? `Have ${taskLink} wait for different work`
          : `Let ${taskLink} continue without ${blockerLink}`;
    const consequence =
      operation === "retry"
        ? `${escape(taskTitle)} will keep waiting while ${escape(blockerTitle)} gets another attempt.`
        : operation === "replace"
          ? `${escape(taskTitle)} will wait for ${escape(replacementTitle)} instead.`
          : `${escape(taskTitle)} may be ready to run once it no longer waits for ${escape(blockerTitle)}.`;
    what =
      `<h3>${heading}</h3><p class="proposal-summary">${consequence}</p>` +
      facts(
        ["task that is waiting", taskLink],
        ["work it needed", `${blockerLink} · ${escape(text("sawBlockerState"))}`],
        ["wait for instead", replacementLink],
        ["project", `<span class="mono">${escape(repoId)}</span>`],
      );
  } else if (view.kind === "answer") {
    const decisionId = typeof payload["decision"] === "number" ? payload["decision"] : 0;
    const pick = text("option");
    const options =
      decision === null
        ? `<p class="meta">the decision is gone</p>`
        : `<ul class="answer-options">` +
          decision.options
            .map(
              one =>
                `<li${one.id === pick ? ' class="picked"' : ""}><strong>${escape(one.label)}</strong>${one.reversible ? "" : ' <span class="badge">irreversible</span>'}` +
                `${one.id === decision.recommendation ? ' <span class="meta">— the builder recommends this</span>' : ""}` +
                `${one.id === pick ? ' <span class="meta">— proposed</span>' : ""}` +
                `<p class="meta">${escape(one.consequence)}</p></li>`,
            )
            .join("") +
          `</ul>`;
    what =
      `<h3>Answer <a href="/d/${decisionId}">decision #${decisionId}</a> on <a href="${taskHref(task)}">${escape(task)}</a></h3>` +
      (decision === null ? "" : `<p class="proposal-summary">${escape(decision.question)}</p>`) +
      options +
      `<div class="proposal-rationale"><span class="eyebrow">proposed answer</span><strong>${escape(text("optionLabel"))}</strong><p>${escape(text("rationale"))}</p></div>` +
      `<p class="meta proposal-disclosure">${payload["readConsequences"] === true ? `${view.by.mate ? "The mate" : "The coordinator"} read every consequence but not the builder's recommendation` : `${view.by.mate ? "The mate" : "The coordinator"} did not read the consequences`}. You see both here${decision !== null && decision.state !== "open" ? " · this decision is no longer open" : ""}.</p>`;
  } else {
    what = `<h3>Cancel <a href="${taskHref(task)}">${escape(task)}</a></h3><p class="proposal-summary">${escape(text("reason"))}</p>` + facts(["project", `<span class="mono">${escape(repoId)}</span>`]);
  }
  const outcome = view.outcome as { said?: unknown; taskId?: unknown } | null;
  const said = outcome !== null && typeof outcome.said === "string" ? outcome.said : null;
  const irreversible = view.kind === "answer" && payload["reversible"] === false;
  const provenance = view.by.mate ? "mate" : `${escape(view.by.name)} · ${escape(view.by.ago)}`;
  const returnField = returnTo === null ? "" : `<input type="hidden" name="return" value="${escape(returnTo)}">`;
  let acts = "";
  if (view.state === "pending" && !inert) {
    acts =
      view.kind === "cancel"
        ? `<p class="meta">cancelling is armed on the task itself — <a href="${taskHref(task)}">open ${escape(task)}</a></p>` +
          `<form method="post" action="${view.actionBase}/${view.id}/dismiss" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">${returnField}<button type="submit" class="quiet">dismiss</button></form>`
        : `<div class="acts">` +
          `<form method="post" action="${view.actionBase}/${view.id}/confirm" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">${returnField}` +
          (irreversible ? `<label class="arm"><input type="checkbox" name="confirm" value="yes"> I understand this cannot be undone</label>` : "") +
          `<button type="submit">${escape(presentation.action)}</button></form>` +
          `<form method="post" action="${view.actionBase}/${view.id}/dismiss" class="inline"><input type="hidden" name="csrf" value="${escape(csrf)}">${returnField}<button type="submit" class="quiet">dismiss</button></form>` +
          `</div>`;
  } else if (view.state === "pending") {
    acts = `<p class="meta proposal-wait">Available when the current turn finishes.</p>`;
  } else if (view.state === "confirmed") {
    const filed = outcome !== null && typeof outcome.taskId === "string" ? outcome.taskId : null;
    acts =
      `<p class="done">${escape(said ?? "confirmed")}` +
      (view.kind === "scope" && filed !== null
        ? ` — <a href="${taskChatHref(filed)}#task-chat-action">review & start in chat</a>`
        : filed !== null && view.kind === "task"
          ? ` — <a href="${taskChatHref(filed)}">continue in chat</a> · <a href="${taskHref(filed)}">overview</a>`
          : "") +
      `</p>`;
  } else if (view.state === "refused") {
    acts = `<p class="refused">${escape(said ?? "refused")}</p>`;
  } else {
    acts = `<p class="meta">${escape(view.state)}</p>`;
  }
  const stateClass = view.state === "confirmed" ? "badge-done" : view.state === "refused" ? "badge-failed" : "";
  return (
    `<article class="card proposal proposal-${escape(view.kind)} ${escape(view.state)}" data-card-kind="${escape(view.kind)}">` +
    `<header class="proposal-head"><span class="proposal-icon">${strokeIcon(presentation.icon)}</span>` +
    `<span><strong>${escape(presentation.label)}</strong><small>proposed by ${provenance}</small></span>` +
    `<span class="badge ${stateClass}">${escape(view.state)}</span></header>` +
    `<div class="proposal-body">${what}</div>` +
    `<footer class="proposal-actions">${acts}</footer></article>`
  );
}

function mateProposalCard(proposal: MateProposal, csrf: string, inert: boolean, decision: Decision | null, returnTo: string | null = null): string {
  return proposalCard({ id: proposal.id, kind: proposal.kind, payload: proposal.payload, state: proposal.state, outcome: proposal.outcome, by: { mate: true }, actionBase: "/chat/proposal" }, csrf, inert, decision, returnTo);
}

function coordinatorProposalCard(proposal: CoordinatorProposal, csrf: string, now: Date, decision: Decision | null, returnTo: string | null = null): string {
  return proposalCard(
    { id: proposal.id, kind: proposal.kind, payload: proposal.payload, state: proposal.state, outcome: proposal.outcome, by: { mate: false, name: proposal.name, ago: relativeAge(proposal.createdAt, now) }, actionBase: "/proposals" },
    csrf,
    false,
    decision,
    returnTo,
  );
}

function relativeAge(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The section shared by /chat (both modes) and the task page: pending coordinator proposals as cards. */
function coordinatorProposalsSection(proposals: readonly CoordinatorProposal[], decisions: Map<number, Decision>, csrf: string, now: Date, heading = true, returnTo: string | null = null): string {
  if (proposals.length === 0) return "";
  return (
    (heading ? `<h2>proposed by coordinators <span class="meta">${proposals.length}</span></h2>` : "") +
    `<div class="coordinator-proposals">` +
    proposals.map(one => coordinatorProposalCard(one, csrf, now, decisions.get(typeof one.payload["decision"] === "number" ? one.payload["decision"] : -1) ?? null, returnTo)).join("") +
    `</div>`
  );
}

function matePage(chrome: Chrome, data: {
  session: MateSession;
  messages: MateMessage[];
  proposals: MateProposal[];
  /** The decisions the answer cards name. */
  decisions: Map<number, Decision>;
  coordinatorProposals: CoordinatorProposal[];
  pending: MateTurn | null;
  latched: ChatTurn[];
  recent: MateTurn[];
  config: import("./store.js").ChatConfig;
  turnsToday: number;
  weeklySpent: number;
  projects: ChatProjectPulse[];
  fleetSnapshot: ChatSnapshot | null;
  /** Optional task lens into the same unified thread. */
  focusTask: TaskChatFocus | null;
  csrf: string;
  problem: string | null;
  now: Date;
}): Screen {
  const subscription = isSubscriptionChatProvider(data.config.provider);
  const returnTo = data.focusTask === null ? "/chat" : taskChatHref(data.focusTask.id);
  const conversation: string[] = [
    data.focusTask === null
      ? chatHeading("one conversation across every project · understand, prioritize, and act from here", data.projects.length, true)
      : taskChatHeading(data.focusTask),
    `<div class="chat-budget"><span class="mono">answering with ${escape(data.config.provider)} · ${escape(data.config.model)}</span>` +
      (subscription
        ? `<span>membership login · no dollar ceiling</span>`
        : `<span>this conversation: ${chatMoney(data.session.spentMicrousd)} of ${chatMoney(data.session.ceilingMicrousd)}</span>` +
          `<span>this week ${chatMoney(data.weeklySpent)} of ${chatMoney(data.config.weeklyCeilingMicrousd)}</span>`) +
      `<span>${data.turnsToday} / ${data.config.dailyTurns} turns today</span></div>`,
    data.focusTask === null ? "" : taskChatLiveRegion(data.focusTask, data.csrf, false, data.pending !== null),
    data.focusTask === null ? chatFleetOverview(data.fleetSnapshot, data.projects, data.csrf, data.pending === null) : "",
  ];
  if (data.problem !== null) conversation.push(`<div class="problem">${escape(data.problem)}</div>`);
  for (const turn of data.latched) {
    conversation.push(
      `<div class="problem"><strong>unknown spend blocks chat.</strong> turn #${turn.id} may have cost up to ${chatMoney(turn.reservedMicrousd)} — ` +
        `<a href="/chat/ack/${turn.id}">read and acknowledge it</a> to re-enable this credential.</div>`,
    );
  }
  const byTurn = new Map<number, MateProposal[]>();
  for (const one of data.proposals) {
    const list = byTurn.get(one.turn) ?? [];
    list.push(one);
    byTurn.set(one.turn, list);
  }
  const inert = data.pending !== null;
  conversation.push(coordinatorProposalsSection(data.coordinatorProposals, data.decisions, data.csrf, data.now, true, data.focusTask === null ? null : returnTo));
  conversation.push(`<div class="thread">`);
  if (data.messages.length === 0) {
    conversation.push(
      `<div class="chat-empty"><strong>${data.focusTask === null ? "What should we look at first?" : "What do you want to understand or change?"}</strong>` +
      `<p class="meta">${data.focusTask === null ? "Ask in your own words, or start with a fleet question." : "I’ll read the current task first. Ask naturally, or choose a useful starting point."}</p>${matePromptStarters(data.csrf, data.focusTask)}</div>`,
    );
  }
  for (const message of data.messages) {
    if (message.role === "operator") {
      conversation.push(`<div class="msg op" data-message-role="operator"><p style="white-space:pre-wrap">${escape(message.text)}</p></div>`);
      continue;
    }
    const cards = message.turn === null ? [] : (byTurn.get(message.turn) ?? []);
    conversation.push(
      `<div class="msg mate" data-message-role="assistant">` +
        renderChatText(message.text) +
        cards.map(one => mateProposalCard(one, data.csrf, inert, data.decisions.get(typeof one.payload["decision"] === "number" ? one.payload["decision"] : -1) ?? null, data.focusTask === null ? null : returnTo)).join("") +
        `<div class="chat-message-foot">${chatActivity(message.activity)}<time datetime="${escape(message.createdAt)}">${escape(relativeAge(message.createdAt, data.now))}</time></div>` +
        `</div>`,
    );
  }
  conversation.push(`</div>`);
  if (data.pending !== null) {
    conversation.push(
      `<div class="card chat-thinking" id="latest" aria-live="polite"><span class="thinking-orb"></span><p><strong>${data.focusTask === null ? "Working across your projects" : `Working on ${escape(data.focusTask.title)}`}</strong>` +
      `<span class="meta">turn #${data.pending.id} · ${data.pending.steps} step${data.pending.steps === 1 ? "" : "s"}${subscription ? " · membership-backed" : ` · up to ${chatMoney(data.pending.reservedMicrousd)} reserved`}</span></p>` +
      `<form method="post" action="/chat/mate/stop" class="inline"><input type="hidden" name="csrf" value="${escape(data.csrf)}"><input type="hidden" name="return" value="${escape(returnTo)}"><input type="hidden" name="turn" value="${data.pending.id}">` +
      `<button type="submit" class="quiet">stop</button></form></div>`,
    );
    return screen("chat", chatWorkspace(conversation.join("\n"), data.projects, data.csrf, true, data.focusTask), { chrome, functional: { script: CHAT_UI_SCRIPT, fetches: data.focusTask !== null }, refreshSeconds: 3 });
  }
  conversation.push(
    data.messages.length === 0 ? "" : matePromptStarters(data.csrf, data.focusTask),
    `<form method="post" action="/chat" class="card composer" id="latest" aria-label="message the mate">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    data.focusTask === null ? "" : `<input type="hidden" name="task" value="${escape(data.focusTask.id)}">`,
    `<label>message<textarea name="message" rows="1" maxlength="${MATE_MESSAGE_MAX_CHARS}" placeholder="${data.focusTask === null ? "Ask about projects, prioritize work, or draft the next task…" : "Ask about status, revise scope, or steer the next attempt…"}"></textarea></label>`,
    `<button type="submit" aria-label="send message">send</button>`,
    `</form>`,
    `<details><summary class="meta">this conversation</summary>`,
    `<p class="meta">started ${escape(data.session.mintedAt.slice(0, 16).replace("T", " "))}Z · stays live until you end it · only bounded recent context is sent to the model</p>`,
    `<form method="post" action="/chat/mate/end" class="inline"><input type="hidden" name="csrf" value="${escape(data.csrf)}"><input type="hidden" name="return" value="${escape(returnTo)}"><button type="submit" class="quiet">end the conversation and forget the thread</button></form>`,
    data.recent.length === 0
      ? ""
      : `<p class="meta">recent turns: ${data.recent
          .map(turn => `<span class="mono">#${turn.id}</span> ${escape(turn.state)}${turn.failureReason === null ? "" : ` · ${escape(turn.failureReason)}`} · ${subscription ? "membership" : chatMoney(turn.settledMicrousd ?? turn.reservedMicrousd)}`)
          .join(" · ")}</p>`,
    `<p class="meta">chat settings live on this page once the conversation ends</p>`,
    `</details>`,
  );
  return screen(
    "chat",
    chatWorkspace(conversation.join("\n"), data.projects, data.csrf, false, data.focusTask),
    { chrome, functional: { script: CHAT_UI_SCRIPT, fetches: data.focusTask !== null } },
  );
}

function routinesPage(
  chrome: Chrome,
  tracks: Track[],
  form: {
    csrf: string;
    revision: number;
    problem: string | null;
    prefill?: { name: string; goal: string; not: string; touches: string; schedule: string; acceptance: string } | null;
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
          `<label>acceptance <span class="meta">(required — one criterion per line: <code>statement | evidence,kinds | how</code>; evidence kinds are check, screenshot, changed-path, manual-review; id is optional and auto-numbered)</span><textarea name="acceptance" rows="3" placeholder="The full test suite passes | check">${fill === null ? "" : escape(fill.acceptance)}</textarea></label>`,
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
    `<p class="hint">scheduled work — anything needing a person appears in the inbox</p>`,
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
    (routine.acceptance.length === 0
      ? ""
      : `<p class="meta">acceptance</p><ul class="recap">${routine.acceptance
          .map(c => `<li><code>${escape(c.id)}</code> ${escape(c.statement)} <span class="meta">[requires: ${c.evidence.map(escape).join(", ")}]</span></li>`)
          .join("")}</ul>`) +
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
      : `<h2>tasks waiting on failed work</h2><p class="hint">open a task and choose whether to try the failed work again, wait for something else, or continue without it</p>` +
        data.stranded
          .map(
            one =>
              `<p class="row"><a href="${taskHref(one.id)}">${escape(one.id)}</a> waits on ${one.blockedBy
                .map(blocker => `<a href="${taskHref(blocker)}">${escape(blocker)}</a>`)
                .join(", ")} <span class="right meta">choose what happens →</span></p>`,
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
        `<span class="v">builder \u00b7 ${said} \u00b7 ${busy}/${one.capacity} building${sessions > 0 ? ` \u00b7 ${sessions} attended session${sessions === 1 ? "" : "s"} (uncapped by standing-orders — each is an agent + a supervisor process; OS limits apply)` : ""}</span></div>`
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
      : `<div class="stat-card"><span class="k"><span class="dot ${data.episode.endedAt === null ? "dot-ok pulse" : "dot-off"}"></span>Standing Orders</span>` +
        `<span class="v">${
          data.episode.endedAt === null
            ? `running since ${escape(when(data.episode.startedAt))}`
            : `last window: ${data.episode.built} built, ${data.episode.broke} broke \u00b7 ended ${escape(when(data.episode.endedAt))}`
        }</span></div>`;
  const fleetCards = [...runnerCards, watchCard, ...worktreeCards].filter(one => one !== "");
  const fleet =
    fleetCards.length === 0
      ? `<h2>system status</h2><p class="hint">No builder is connected yet. On the machine where the project lives, open that folder and run <code>standing-orders up</code>.</p>`
      : `<h2>system status</h2><p class="hint">builders execute tasks in isolated temporary copies of each project</p><div class="cards">${fleetCards.join("")}</div>`;

  const startHere =
    data.taskCount === 0
      ? [
          `<div class="card">`,
          `<p><strong>Nothing is queued yet — here is the whole loop:</strong></p>`,
          `<p>1. <a href="/tasks">Add a task</a> — plain words for work you want done${data.repo === null ? "" : ` in <span class="mono">${escape(data.repo)}</span>`}.</p>`,
          `<p>2. Open it and write its scope — the goal, and what it must not become. Approve exactly that.</p>`,
          `<p>3. Keep Standing Orders running on the builder machine. Approved tasks build unattended, each on its own branch.</p>`,
          `<p class="meta">When an agent is unsure it stops and asks — those questions land here, under \u201cwaiting on you\u201d.</p>`,
          `</div>`,
        ].join("\n")
      : "";

  return screen("activity", [
    `<h1>activity</h1>`,
    buildsViews("activity"),
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

type TaskComposerPrefill = { title: string; goal: string; not: string; touches: string; acceptance: string };

/** The one front door for new work. The common path is one prompt and one
 * button; the detailed contract remains available in-place for templates,
 * experts, and the rare task that should skip repository-aware planning. */
function taskComposerHtml(data: {
  csrf: string;
  project: string | null;
  projectRevision?: number;
  prefill?: TaskComposerPrefill | null;
  candidates?: { id: string; title: string }[];
  permissionDefault: UnattendedPermissionMode;
  qualityDefault: QualityMode;
}): string {
  const prefill = data.prefill ?? null;
  const candidates = data.candidates ?? [];
  const projectLabel = data.project === null ? "repository required" : projectName(data.project);
  return [
    `<form method="post" action="/tasks/add" class="card task-composer">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    data.projectRevision === undefined
      ? ""
      : `<input type="hidden" name="projectRevision" value="${data.projectRevision}">`,
    `<input type="hidden" name="planning-policy" value="choice">`,
    prefill === null
      ? ""
      : `<p class="meta" style="margin:.35rem .75rem .15rem">pre-filled from a template. Change anything; it still waits for your approval.</p>`,
    `<label class="task-prompt"><span class="visually-hidden">What should get done?</span>` +
      `<textarea name="title" rows="4" maxlength="200" required autofocus placeholder="Describe the outcome you want. The planner will inspect the repository and work out the implementation details.">${prefill === null ? "" : escape(prefill.title)}</textarea></label>`,
    data.project === null
      ? `<label class="task-repo">repository <span class="meta">— required because no project is open, so the task must say where it belongs</span><input type="text" name="repo" required placeholder="/path/to/repository"></label>`
      : "",
    `<div class="task-composer-footer">`,
    `<div class="task-context">` +
      `<span class="task-context-chip" title="${escape(data.project ?? "Choose a repository for this task")}">${escape(projectLabel)}</span>` +
      `<span class="task-context-chip">planner inspects first</span>` +
      `</div>`,
    `<label class="task-quality"><span class="visually-hidden">quality mode</span><select name="quality-mode" aria-label="quality mode">` +
      `<option value="default"${data.qualityDefault === "default" ? " selected" : ""}>Default quality</option>` +
      `<option value="strict"${data.qualityDefault === "strict" ? " selected" : ""}>Strict / release</option>` +
      `</select></label>`,
    `<button type="submit" class="task-submit">${prefill === null ? "Plan task" : "Continue"} →</button>`,
    `</div>`,
    `<details class="task-options"${prefill === null ? "" : " open"}>`,
    `<summary><span>Edit details</span><small>optional · defaults are remembered</small></summary>`,
    `<div class="task-options-grid">`,
    `<label class="wide">goal <span class="meta">— only when skipping planning; the planner normally drafts this</span>` +
      `<textarea name="goal" rows="3" placeholder="What success looks like">${prefill === null ? "" : escape(prefill.goal)}</textarea></label>`,
    `<label class="wide">acceptance <span class="meta">— needed only when you skip planning; one per line: <code>statement | evidence,kinds | how</code></span>` +
      `<textarea name="acceptance" rows="3" placeholder="Requests over the limit return 429 | check">${prefill === null ? "" : escape(prefill.acceptance)}</textarea></label>`,
    `<label>not this <span class="meta">— optional boundary</span><input type="text" name="not" value="${prefill === null ? "" : escape(prefill.not)}"></label>`,
    `<label>likely touches <span class="meta">— paths, comma-separated</span><input type="text" name="touches" value="${prefill === null ? "" : escape(prefill.touches)}"></label>`,
    `<label class="wide task-check"><input type="checkbox" name="plan-first" value="1" checked><span><strong>Let the planner inspect first</strong><small class="meta">Recommended. It drafts the goal, acceptance criteria, and implementation approach, and asks only when a missing answer materially changes the work.</small></span></label>`,
    `<label class="wide task-check"><input type="checkbox" name="scout" value="1"><span><strong>Research only</strong><small class="meta">Deliver a read-only report instead of changing the repository.</small></span></label>`,
    `<label>task id <span class="meta">— optional</span><input type="text" name="id" placeholder="made from the request"></label>`,
    candidates.length === 0
      ? ""
      : `<label>starts after <span class="meta">— optional</span><select name="after"><option value="">right away</option>` +
        candidates.map(one => `<option value="${escape(one.id)}">${escape(one.id)} — ${escape(one.title)}</option>`).join("") +
        `</select></label>`,
    `<fieldset class="permission-field"><legend>agent permissions</legend>${permissionModeChoices("permission-mode", data.permissionDefault)}` +
      `<p class="meta permission-note">Inherited from Settings. You can still change it on the proposed scope before approval.</p></fieldset>`,
    `</div>`,
    `</details>`,
    `</form>`,
  ].join("\n");
}

function tasksPage(
  chrome: Chrome,
  tasks: Task[],
  state: TaskState | null,
  csrf: string,
  problem: string | null,
  repo: string | null = null,
  prefill: TaskComposerPrefill | null = null,
  permissionDefault: UnattendedPermissionMode = "auto",
  qualityDefault: QualityMode = "default",
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
              `<a class="row" href="${taskHref(task.id)}"><span class="mono">${escape(task.id)}</span> ` +
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
    taskComposerHtml({ csrf, project: repo, prefill, permissionDefault, qualityDefault }),
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


/** The compact completed row shared by both halves of the control room. */
type WorkbenchDone = { taskId: string; title: string; outcome: string | null; repo: string | null };

/**
 * The control-room rail (attended A1): every state that matters while a
 * person supervises, ordered by intervention cost. The project chip is
 * deliberately repeated on every row — a title is not a workspace, and
 * switching context must never depend on remembering which repo is open.
 */
function workbenchRail(data: {
  attention: BoardCard[];
  building: BoardCard[];
  waiting: BoardCard[];
  queued: BoardCard[];
  done: WorkbenchDone[];
  selected: string | null;
  saturated: boolean;
}): string {
  const workspace = (repo: string | null): string =>
    `<span class="badge">${repo === null ? "unplaced" : escape(projectName(repo))}</span>`;
  const row = (card: BoardCard, reason: string): string =>
    `<a class="wb-row${card.taskId === data.selected ? " wb-selected" : ""}" href="/workbench?t=${encodeURIComponent(card.taskId)}"` +
    `${card.taskId === data.selected ? ` aria-current="true"` : ""}>` +
    `<span class="wb-title">${escape(card.title)}</span>` +
    `<span class="wb-meta"><span class="mono meta">${escape(card.taskId)}</span>${workspace(card.repo)}</span>` +
    `<span class="wb-reason">${reason}</span></a>`;
  const group = (title: string, cards: BoardCard[], empty: string, render: (card: BoardCard) => string): string =>
    `<section class="wb-group"><h2>${title} <span class="lane-count">${cards.length}</span></h2>` +
    (cards.length === 0 ? `<p class="meta">${empty}</p>` : cards.slice(0, 100).map(render).join("\n")) +
    `</section>`;
  const parts: string[] = [];
  parts.push(
    `<div class="wb-rail-head"><div><span class="eyebrow">portfolio</span><h2>all projects</h2></div>` +
    `<a href="/projects">manage →</a></div>`,
  );
  parts.push(group("needs you", data.attention, "Nothing needs your input.", card => row(card, escape(card.reason))));
  parts.push(group("in progress", data.building, "No agent is working right now.", card => {
    const claim = card.claim;
    const phase = claim?.phase == null ? "working" : phaseWords(claim.phase);
    return row(
      card,
      `${escape(phase)}${claim?.provider ? ` · ${escape(claim.provider)}` : ""}` +
        `${claim?.claimedAt ? ` · <time data-elapsed-since="${escape(claim.claimedAt)}"></time>` : ""}`,
    );
  }));
  parts.push(group("blocked & waiting", data.waiting, "Nothing is blocked or paused.", card => row(card, escape(card.reason))));
  parts.push(group("up next", data.queued, "The ready queue is empty.", card => row(
    card,
    `${escape(card.reason)}${card.assignedRunner === null ? "" : ` · reserved for ${escape(card.assignedRunner)}`}`,
  )));
  if (data.done.length > 0) {
    parts.push(`<section class="wb-group"><h2>just finished <span class="lane-count">${data.done.length}</span></h2>`);
    parts.push(
      data.done
        .map(
          one =>
            `<a class="wb-row${one.taskId === data.selected ? " wb-selected" : ""}" href="/workbench?t=${encodeURIComponent(one.taskId)}">` +
            `<span class="wb-title">${escape(one.title)}</span>` +
            `<span class="wb-meta"><span class="mono meta">${escape(one.taskId)}</span>${workspace(one.repo)} ` +
            `<span class="badge badge-${one.outcome === "built" || one.outcome === "no-change" ? "done" : "failed"}">${escape(one.outcome ?? "?")}</span></span></a>`,
        )
        .join("\n"),
    );
    parts.push(`</section>`);
  }
  if (data.saturated) parts.push(`<p class="meta">more exists — this rail is capped; the <a href="/board?scope=all">board</a> holds the rest</p>`);
  return parts.join("\n");
}

/** The project chip every all-scope row wears: null is UNPLACED, said so. */
function projectChip(repo: string | null | undefined): string {
  return repo === null || repo === undefined
    ? ` <span class="badge">unplaced</span>`
    : ` <span class="badge">${escape(projectName(repo))}</span>`;
}

/**
 * The decision card everywhere a person may ANSWER (portfolio, the
 * selected-project inbox; the task page joins in slice 3): a reversible
 * option answers with one tap on the card, labeled with its own words —
 * never a letter; an irreversible option is a LINK to the decision page,
 * where the server-side confirm=yes guard lives. The roll-up inbox keeps
 * its links-only cards and never renders this partial. The recommended
 * option wears a neutral badge — recommendation is not urgency, and amber
 * stays on the card's outline.
 */
function decisionAnswerCard(
  decision: Decision & { taskId: string; repo?: string | null },
  csrf: string,
  now: Date,
  chip: boolean,
  returnTo: string | null = null,
): string {
  const returnField = returnTo === null ? "" : `<input type="hidden" name="return" value="${escape(returnTo)}">`;
  const options = decision.options
    .map(option => {
      const recommended = option.id === decision.recommendation
        ? ` <span class="badge">recommended</span>`
        : "";
      if (!option.reversible) {
        return (
          `<p class="decide-option"><a href="/d/${decision.id}${returnTo === null ? "" : `?return=${encodeURIComponent(returnTo)}`}">${escape(option.label)}</a>` +
          ` <span class="badge badge-overdue">irreversible</span>${recommended}` +
          ` <span class="meta">${escape(option.consequence)}</span></p>`
        );
      }
      return (
        `<form class="decide-option decide-inline" method="post" action="/d/${decision.id}/answer">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        returnField +
        `<input type="hidden" name="choice" value="${escape(option.id)}">` +
        `<button type="submit">${escape(option.label)}</button>${recommended}` +
        ` <span class="meta">${escape(option.consequence)} · reversible</span></form>`
      );
    })
    .join("\n");
  return (
    `<div class="decide-card" data-decision-id="${decision.id}">` +
    `<p class="q">${escape(decision.question)}</p>` +
    `<p class="meta">${escape(oneLineOf(decision.recap, 160))}</p>` +
    `<p class="meta"><span class="mono">${escape(decision.taskId)}</span>${chip ? projectChip(decision.repo) : ""}` +
    `${isOverdue(decision, now) ? ` <span class="badge badge-overdue">overdue</span>` : ""}` +
    ` · <a href="/d/${decision.id}${returnTo === null ? "" : `?return=${encodeURIComponent(returnTo)}`}">the full question →</a></p>` +
    `<div class="decide-options">${options}</div></div>`
  );
}

/**
 * The inline-answer enhancement (portfolio arc §2): submits a reversible
 * option's form as the urlencoded POST the forms-only gate expects, follows
 * the redirect, and — because an answered decision leaves the open list —
 * replaces ONLY that card with the answered receipt parsed from the
 * decision page's own rendering, or removes the card. Anything unexpected
 * (auth, a page that is not the decision's) navigates instead of inserting.
 * Nothing else on the page is touched: typed input elsewhere survives.
 */
export function decisionAnswerScript(): string {
  return (
    `document.addEventListener("submit",function(e){` +
    `var f=e.target;if(!f||!f.classList||!f.classList.contains("decide-inline"))return;` +
    `e.preventDefault();` +
    `var card=f.closest("[data-decision-id]");` +
    `var page=f.action.replace(/\\/answer$/,"");` +
    `fetch(f.action,{method:"POST",credentials:"same-origin",` +
    `headers:{"content-type":"application/x-www-form-urlencoded"},` +
    `body:new URLSearchParams(new FormData(f)).toString()})` +
    `.then(function(r){return r.text().then(function(t){return{r:r,t:t}})})` +
    `.then(function(x){` +
    `var landed="";try{landed=new URL(x.r.url).pathname}catch(err){}` +
    `if(!x.r.ok||landed!==new URL(page,location.href).pathname){location.href=page;return}` +
    `var doc=new DOMParser().parseFromString(x.t,"text/html");` +
    `var receipt=doc.querySelector(".answered");` +
    `if(!card){location.href=page;return}` +
    `if(receipt){card.replaceChildren(document.importNode(receipt,true))}else{card.remove()}` +
    `},function(){location.href=page})});`
  );
}

/**
 * The portfolio overview (arc slice 1a): what waits on you, what the last
 * 24 hours of run starts amounted to, what is running, and the terminal-run
 * ledger — all of it across every admitted project, a project chip on every
 * row. The caller has already applied admission and per-row visibility.
 */
function portfolioOverview(data: {
  attention: BoardCard[];
  building: BoardCard[];
  waiting: BoardCard[];
  queued: BoardCard[];
  done: WorkbenchDone[];
  saturated: boolean;
  decisions: (Decision & { taskId: string; repo?: string | null })[];
  approvals: { taskId: string; title: string; goal: string; proposedAt: string; repo?: string | null }[];
  requeueables: { taskId: string; title: string; state: TaskState; strikes: number; incidentCount: number; repo?: string | null }[];
  cancelledBlockers: { blockerId: string; dependentCount: number; exampleDependent: string; repo?: string | null; blockerRepo?: string | null }[];
  gaps: Gap[];
  gapsProject: string | null;
  runs24: (Run & { taskId: string })[];
  live: { taskId: string; runner: string; claimedAt: string; expiresAt: string; model: string | null; repo: string | null }[];
  ledger: {
    runId: number; taskId: string; title: string; repo: string | null; outcome: string; role: string;
    provider: string | null; model: string | null; startedAt: string; ranMinutes: number | null;
    costUsd: number | null; authMode: "subscription" | "api-key" | null; prNumber: number | null; prUrl: string | null;
  }[];
  csrf: string;
  now: Date;
}): string {
  type Pulse = { repo: string | null; attention: number; building: number; waiting: number; queued: number; done: number };
  const pulses = new Map<string, Pulse>();
  const pulseFor = (repo: string | null): Pulse => {
    const key = repo ?? "";
    const existing = pulses.get(key);
    if (existing !== undefined) return existing;
    const made = { repo, attention: 0, building: 0, waiting: 0, queued: 0, done: 0 };
    pulses.set(key, made);
    return made;
  };
  for (const card of [...data.attention, ...data.building, ...data.waiting, ...data.queued]) {
    pulseFor(card.repo)[card.lane] += 1;
  }
  for (const one of data.done) pulseFor(one.repo).done += 1;
  const pulseRows = [...pulses.values()].sort((a, b) =>
    b.attention - a.attention || b.building - a.building || b.waiting - a.waiting ||
    (a.repo === null ? 1 : b.repo === null ? -1 : projectName(a.repo).localeCompare(projectName(b.repo))),
  );
  const workspace = (repo: string | null): string => repo === null ? "Unplaced work" : projectName(repo);
  // A workspace card (board pass): the repo's name and one status word,
  // its four counts, a bar of the same counts in proportion, and — for a
  // real repo, with a session token — the one tap to its own board. The
  // status word is the loudest true thing: needs you beats building beats
  // waiting beats queued; a repo with nothing in flight is idle.
  const statusOf = (one: (typeof pulseRows)[number]): { word: string; cls: string } =>
    one.attention > 0
      ? { word: "needs you", cls: "badge-open" }
      : one.building > 0
        ? { word: "building", cls: "badge-running" }
        : one.waiting > 0
          ? { word: "waiting", cls: "" }
          : one.queued > 0
            ? { word: "queued", cls: "" }
            : { word: "idle", cls: "" };
  const workspaceRows = pulseRows.map(one => {
    const status = statusOf(one);
    const total = one.attention + one.building + one.waiting + one.queued;
    const seg = (cls: string, count: number): string =>
      count === 0 ? "" : `<span class="seg ${cls}" style="flex-grow:${count}"></span>`;
    const boardForm =
      one.repo === null || data.csrf === ""
        ? ""
        : `<form method="post" action="/projects/open" class="inline">` +
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
          `<input type="hidden" name="path" value="${escape(one.repo)}">` +
          `<input type="hidden" name="return" value="/board">` +
          `<button type="submit">board →</button></form>`;
    return (
      `<div class="workspace-card${one.attention > 0 ? " hot" : ""}">` +
      `<div class="workspace-head"><span class="workspace-name">${escape(workspace(one.repo))}</span>` +
      `<span class="badge ${status.cls}">${status.word}</span>${boardForm}</div>` +
      `<div class="workspace-stats">` +
      `<span class="pulse-stat${one.attention > 0 ? " hot" : ""}"><b>${one.attention}</b> need you</span>` +
      `<span class="pulse-stat"><b>${one.building}</b> live</span>` +
      `<span class="pulse-stat"><b>${one.waiting}</b> waiting</span>` +
      `<span class="pulse-stat"><b>${one.queued}</b> next</span></div>` +
      `<div class="workspace-bar${total === 0 ? " empty" : ""}" aria-hidden="true">` +
      seg("attention", one.attention) + seg("building", one.building) + seg("waiting", one.waiting) + seg("queued", one.queued) +
      `</div></div>`
    );
  }).join("\n");

  // ---- waits on you: everything a person must resolve, across projects ----
  const waitCount =
    data.decisions.length + data.approvals.length + data.requeueables.length +
    data.cancelledBlockers.length + data.gaps.length;
  const decisionCards = data.decisions.map(one => decisionAnswerCard(one, data.csrf, data.now, true)).join("\n");
  const approvalCards = data.approvals
    .map(
      one =>
        `<a class="decide-card" href="${taskHref(one.taskId)}">` +
        `<p class="q">${escape(one.title)}</p>` +
        `<span class="meta">${escape(one.goal.length > 120 ? one.goal.slice(0, 120) + "…" : one.goal)}</span><br>` +
        `<span class="mono meta">${escape(one.taskId)}</span>${projectChip(one.repo)} <span class="right meta">review and sign →</span>` +
        `</a>`,
    )
    .join("\n");
  const requeueRows = data.requeueables
    .map(
      one =>
        `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a> ${escape(one.title)}${projectChip(one.repo)}` +
        `${one.incidentCount > 0 ? ` <span class="badge badge-failed">${one.incidentCount} incident${one.incidentCount > 1 ? "s" : ""}</span>` : ""}` +
        `${one.strikes > 0 ? ` <span class="meta">${one.strikes} failed attempt${one.strikes > 1 ? "s" : ""}</span>` : ""}` +
        `<span class="right meta">open the task to retry →</span></p>`,
    )
    .join("\n");
  const cancelledRows = data.cancelledBlockers
    .map(
      one =>
        `<p class="row"><a href="${taskHref(one.exampleDependent)}">${escape(one.exampleDependent)}</a>${projectChip(one.repo)} ` +
        `<span class="meta">${one.dependentCount > 1 ? `one of ${one.dependentCount} tasks waiting` : "waiting"} for cancelled task ${escape(one.blockerId)}</span>` +
        `<span class="right meta">choose what happens →</span></p>`,
    )
    .join("\n");
  const gapRows = data.gaps
    .map(
      gap =>
        `<p class="row"><a href="/caps">${escape(gap.key)}</a>${data.gapsProject === null ? "" : projectChip(data.gapsProject)} ` +
        `<span class="meta">frees ${gap.unblocks.length} task${gap.unblocks.length > 1 ? "s" : ""}</span>` +
        `<span class="right meta">how to fix →</span></p>`,
    )
    .join("\n");

  // ---- the last 24 hours: runs STARTED in the window, outcomes exhaustive ----
  const groups: [string, number][] = [
    ["built", data.runs24.filter(one => one.outcome === "built").length],
    ["no change", data.runs24.filter(one => one.outcome === "no-change").length],
    ["failed", data.runs24.filter(one => one.outcome === "failed").length],
    ["refused", data.runs24.filter(one => one.outcome === "refused").length],
    ["parked", data.runs24.filter(one => one.outcome === "parked").length],
    ["interrupted", data.runs24.filter(one => one.outcome === "interrupted").length],
    ["unfinished", data.runs24.filter(one => one.outcome === null).length],
  ];
  const outcomeWords = groups.filter(([, count]) => count > 0).map(([word, count]) => `${count} ${word}`).join(" · ");
  const summary = tally(data.runs24);

  // ---- running: current live claims, project chips on ----
  const liveRows = data.live
    .map(
      one =>
        `<p class="row"><a href="${taskHref(one.taskId)}">${escape(one.taskId)}</a>${projectChip(one.repo)} ` +
        `<span class="badge badge-running">running</span> ` +
        `<span class="mono meta">${escape(one.runner)}${one.model === null ? "" : ` · ${escape(one.model)}`} · ` +
        `<time data-elapsed-since="${escape(one.claimedAt)}"></time></span></p>`,
    )
    .join("\n");

  // ---- the ledger: terminal runs started in the window, one chip each ----
  const chipClass = (outcome: string): string =>
    outcome === "built" || outcome === "no-change" ? "badge-done" : outcome === "failed" ? "badge-failed" : "";
  const ledgerRows = data.ledger
    .map(
      one =>
        `<p class="row"><a href="/r/${one.runId}">${escape(one.title)}</a>${projectChip(one.repo)} ` +
        `<span class="badge ${chipClass(one.outcome)}">${escape(one.outcome)}</span> ` +
        `${one.role === "scout" ? `<a class="badge" href="${taskHref(one.taskId)}#report">report</a> ` : ""}` +
        `<span class="mono meta">${one.provider === null ? "" : escape(one.provider)}${one.model === null ? "" : ` · ${escape(one.model)}`}` +
        `${one.ranMinutes === null ? "" : ` · ${one.ranMinutes}m`}` +
        ` · ${escape(runCostWords({ authMode: one.authMode, costUsd: one.costUsd, tokensIn: null, tokensOut: null }))}` +
        `${(() => {
          if (one.prNumber === null) return "";
          // The URL-sink rule (audit IV-11): only a verified github pull
          // URL earns an anchor; a corrupted row renders as text.
          const safe = safePrUrl(one.prUrl);
          return safe === null ? ` · PR #${one.prNumber}` : ` · <a href="${escape(safe)}">PR #${one.prNumber}</a>`;
        })()}</span></p>`,
    )
    .join("\n");

  return [
    `<div class="control-room-head"><div><h1>portfolio</h1>` +
      `<p class="meta">every project and live build in one place</p></div>` +
      `<div class="actions"><a class="badge" href="/tasks/new">+ new task</a><a class="badge" href="/board?scope=all">full board →</a></div></div>`,
    data.saturated ? `<div class="problem">This overview reached its 200-task display cap; the task list holds the rest.</div>` : "",
    `<h2>waits on you</h2>`,
    waitCount === 0
      ? `<div class="answered"><strong>Nothing needs you.</strong> <span class="meta">You can leave this open; live state updates in the rail.</span></div>`
      : [
          decisionCards,
          approvalCards,
          requeueRows,
          cancelledRows,
          gapRows,
          `<p class="meta"><a href="/next">clear the queue → one thing at a time</a></p>`,
        ].filter(part => part !== "").join("\n"),
    data.gapsProject === null
      ? `<p class="meta">requirement gaps are checked one project at a time — open a project to see and fill its gaps · <a href="/projects">open a project</a></p>`
      : "",
    `<h2>project pulse</h2>`,
    `<p class="hint">one row per repository</p>`,
    pulseRows.length === 0
      ? `<div class="card"><p><strong>No active work yet.</strong></p><p class="meta">Queue a task and its progress will show here across every workspace.</p></div>`
      : `<div class="workspace-pulse">${workspaceRows}</div>`,
    `<h2>the last 24 hours</h2>`,
    `<p class="hint">runs started in the last 24 hours</p>`,
    data.runs24.length === 0
      ? `<p class="meta">no runs started in the window</p>`
      : `<p class="row"><span class="meta">runs started</span> <span class="mono">${data.runs24.length}</span></p>` +
        `<p class="row"><span class="meta">outcomes</span> <span class="mono">${escape(outcomeWords)}</span></p>` +
        `<p class="row"><span class="meta">spend</span> <span class="mono">${escape(spendLine(summary))}</span></p>` +
        // Tokens stand on their own: invocations that reported usage —
        // independent of whether cost was measured (spec §2; spendLine's
        // mixed branch omits them).
        (summary.tokens > 0
          ? `<p class="row"><span class="meta">tokens</span> <span class="mono">${summary.tokens.toLocaleString()}</span></p>`
          : ""),
    `<h2>running</h2>`,
    data.live.length === 0 ? `<p class="meta">no agent is working right now</p>` : liveRows,
    `<h2>terminal runs started in the last 24 hours</h2>`,
    data.ledger.length === 0 ? `<p class="meta">none yet</p>` : ledgerRows,
  ].join("\n");
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
      `<div class="card${winner ? " picked" : ""}">`,
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
      `<form method="post" action="/contest/${data.contestId}/abandon" class="card">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="nonce" value="${escape(data.nonceValue)}">`,
      `<label>your password, typed again<input type="password" name="token" autocomplete="current-password"></label>`,
      `<button type="submit" class="danger">abandon the ${contestNoun(data.contestKind)}</button>`,
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

/**
 * owner/name from a git remote URL — FULLY ANCHORED https/ssh github.com
 * forms only (ghlist review, finding 2): a foreign host carrying
 * "github.com" in its path, or a non-github host, must never read as a
 * GitHub identity. Everything else is null.
 */
function githubIdentityOf(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const https = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https !== null) return `${https[1]}/${https[2]}`;
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (ssh !== null) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

/**
 * The `origin` remote's url from a repository's OWN .git/config. BOUNDED
 * I/O by construction (ghlist review, finding 1): the final component may
 * not be a symlink (O_NOFOLLOW + lstat), must be a REGULAR file under a
 * size cap, and at most 64 KiB are ever read — a sparse monster or a fifo
 * planted as a "config" reads as null, never as a hang. Parsed LINE BY
 * LINE with real section tracking (finding 2): a `[remote "origin"]`
 * embedded inside some other value never opens the section. null when
 * unreadable or origin-less; a worktree-style `.git` FILE (gitdir pointer)
 * reads null too, which is honest — its identity lives elsewhere. The
 * answer is ADVISORY metadata for offering a button: the /projects/open
 * road re-proves path, ceiling, and git-ness before anything mutates, and
 * a config that lies about its origin can only mislabel a repository the
 * operator was already allowed to open.
 */
function originUrlOf(repoPath: string): string | null {
  const file = join(repoPath, ".git", "config");
  let fd: number | null = null;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const config = buffer.toString("utf8", 0, read);
    let inOrigin = false;
    for (const line of config.split("\n")) {
      if (/^\s*\[/.test(line)) {
        inOrigin = /^\s*\[remote "origin"\]\s*$/.test(line);
        continue;
      }
      if (!inOrigin) continue;
      const url = /^\s*url\s*=\s*(.+)$/.exec(line)?.[1];
      if (url !== undefined) return url.trim();
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** The GitHub listing page: the account's repositories with ONE honest
 * action each. Names, descriptions, and paths are gh/filesystem DATA —
 * escaped at the sink like everything else. */
function githubReposPage(
  chrome: Chrome,
  data: {
    listed: ListOutcome;
    local: Map<string, string>;
    registered: Set<string>;
    csrf: string;
    cloneReady: boolean;
    openProject: string | null;
  },
): Screen {
  const openForm = (path: string, label: string): string =>
    [
      `<form method="post" action="/projects/open" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="path" value="${escape(path)}">`,
      `<button type="submit">${escape(label)}</button>`,
      `</form>`,
    ].join("");
  const cloneForm = (nameWithOwner: string): string =>
    [
      `<form method="post" action="/projects/onboard-preview" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
      `<input type="hidden" name="repo" value="${escape(nameWithOwner)}">`,
      `<input type="hidden" name="root" value="0">`,
      `<button type="submit">clone here →</button>`,
      `</form>`,
    ].join("");
  const rows =
    !data.listed.ok
      ? `<p class="meta">${escape(data.listed.message)}</p>`
      : data.listed.repos.length === 0
        ? `<p class="meta">the signed-in GitHub account has no repositories to list</p>`
        : data.listed.repos
            .map(repo => {
              const localPath = data.local.get(repo.nameWithOwner.toLowerCase()) ?? null;
              const action =
                localPath !== null && data.openProject === localPath
                  ? `<span class="badge badge-done">open now</span>`
                  : localPath !== null
                    ? openForm(localPath, data.registered.has(localPath) ? "open →" : "add + open →")
                    : data.cloneReady
                      ? cloneForm(repo.nameWithOwner)
                      : `<span class="meta">choose a projects folder first</span>`;
              return [
                `<div class="card project-card">`,
                `<div class="row"><strong>${escape(repo.nameWithOwner)}</strong>${repo.isPrivate ? ` <span class="badge">private</span>` : ""}`,
                `<span class="right">${action}</span></div>`,
                localPath === null
                  ? `<p class="meta">not on this machine yet${/^\d{4}-\d{2}-\d{2}T/.test(repo.updatedAt) ? ` · pushed ${escape(when(repo.updatedAt))}` : ""}</p>`
                  : `<p class="meta mono" style="overflow-wrap:anywhere;margin:.2rem 0">${escape(localPath)}</p>`,
                repo.description === "" ? "" : `<p class="meta">${escape(repo.description)}</p>`,
                `</div>`,
              ].join("\n");
            })
            .join("\n");
  return screen("projects", [
    `<h1>your GitHub repositories</h1>`,
    `<p class="meta">repositories available to the GitHub account signed in on this machine — open one you already have, or clone a new one after a quick preview.</p>`,
    rows,
    `<p class="row" style="margin-top:.6rem"><a class="badge" href="/projects">← back to projects</a></p>`,
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
            `<p class="meta">paste a GitHub repository — you will preview it before anything is downloaded. It goes into your saved projects folder and the builder connects automatically. Large-file (LFS) objects are not downloaded.</p>`,
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
  // Opening a project is a POST (the session's scope changes); a card's
  // name and counts are the same form, returning to the screen that count
  // names — so every number on this page is a road, not a fact to admire.
  const openForm = (path: string, label: string, returnTo = "/", className?: string): string =>
    [
      `<form method="post" action="/projects/open" class="inline">`,
      `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
      `<input type="hidden" name="path" value="${escape(path)}">`,
      `<input type="hidden" name="return" value="${escape(returnTo)}">`,
      `<button type="submit"${className === undefined ? "" : ` class="${className}"`}>${escape(label)}</button>`,
      `</form>`,
    ].join("");

  // A project switcher CARD (v30 UI): the name and path, an at-a-glance
  // peek — what waits on a person, what is queued or running, what built
  // in the last day — and the open action. A vertical stack that reads on
  // a phone, not a dense row.
  const peekChips = (path: string, peek: ProjectPeek | null): string => {
    if (peek === null) return `<span class="meta">not scanned</span>`;
    const isOpen = open !== null && open === path;
    const chip = (text: string, href: string, cls: string): string =>
      isOpen ? `<a class="badge ${cls}" href="${href}">${text}</a>` : openForm(path, text, href, `badge ${cls}`);
    const bits: string[] = [];
    if (peek.waiting > 0) bits.push(chip(`${peek.waiting} waiting on you`, "/", "badge-open"));
    if (peek.running > 0) bits.push(chip(`${peek.running} running`, "/runs", "badge-running"));
    if (peek.queued > 0) bits.push(chip(`${peek.queued} queued`, "/board?view=order", "badge-queued"));
    if (peek.doneRecently > 0) bits.push(chip(`${peek.doneRecently} built today`, "/done", "badge-done"));
    return bits.length === 0 ? `<span class="meta">quiet — nothing queued or waiting</span>` : bits.join(" ");
  };
  const projectCard = (one: { path: string; name: string; note: string; peek: ProjectPeek | null }): string =>
    [
      `<div class="card project-card">`,
      `<div class="row">${
        open !== null && open === one.path
          ? `<a class="project-name" href="/"><strong>${escape(one.name)}</strong></a>`
          : openForm(one.path, one.name, "/", "project-name")
      }`,
      `<span class="right">${
        open !== null && open === one.path ? `<span class="badge badge-done">open now</span>` : openForm(one.path, "open \u2192")
      }</span></div>`,
      `<p class="meta mono" style="overflow-wrap:anywhere;margin:.2rem 0">${escape(one.path)}</p>`,
      `<p class="row" style="gap:.35rem;flex-wrap:wrap">${peekChips(one.path, one.peek)}</p>`,
      `<p class="meta">${escape(one.note)}</p>`,
      `</div>`,
    ].join("\n");
  const cards = (items: { path: string; name: string; note: string }[]): string =>
    items.map(one => projectCard({ ...one, peek: peeks[one.path] ?? null })).join("\n");

  const recentItems = recent.map(one => ({ path: one.path, name: one.name, note: `last opened ${when(one.lastOpenedAt)}` }));
  const candidateItems = candidates.map(path => ({ path, name: projectName(path), note: "seen in the queue" }));

  // The two ways to ADD a project are the page's large, primary actions:
  // browse this machine, or choose a GitHub repository. Manual path entry
  // stays available as the clearly secondary expert road.
  const addAction = (href: string, paths: string, title: string, detail: string): string =>
    `<a class="project-add-action" href="${href}">` +
    `<span class="project-add-icon">${strokeIcon(paths)}</span>` +
    `<span class="project-add-copy"><strong>${escape(title)}</strong><small>${escape(detail)}</small></span>` +
    `<span class="project-add-arrow" aria-hidden="true">\u2192</span></a>`;
  const addCard = [
    `<div class="card project-add-card">`,
    `<h2 class="project-add-title">add a project</h2>`,
    `<p class="meta project-add-intro">Choose where the project already lives. Standing Orders will remember it and connect its work automatically.</p>`,
    `<div class="project-add-actions">`,
    browsable
      ? addAction("/projects/browse", FOLDER_PATHS, "Choose a local folder", "Browse the project folders on this machine")
      : "",
    onboard === null
      ? ""
      : addAction(
          "/projects/github",
          `<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><path d="M18 9a9 9 0 0 1-9 9"/>`,
          "Add from GitHub",
          "Choose from repositories available to your GitHub login",
        ),
    `</div>`,
    browsable
      ? ""
      : `<p class="meta">Choose a projects folder once with <code>standing-orders up --project-root &lt;dir&gt;</code>. Standing Orders remembers it after that.</p>`,
    onboardCard === "" ? "" : `<div style="margin-top:.5rem">${onboardCard}</div>`,
    `<details class="project-add-more"><summary>Enter an exact path instead</summary>`,
    `<form method="post" action="/projects/open" class="card">`,
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    `<label>path on this server<input type="text" name="path" placeholder="/Users/you/code/your-repo"></label>`,
    `<button type="submit">open project</button>`,
    `</form></details>`,
    `</div>`,
  ].join("\n");

  return screen("projects", [
    `<h1>projects</h1>`,
    `<p class="meta">add a local folder or GitHub repository once; its tasks, builds, and chat context stay available here</p>`,
    unscopedMode
      ? `<p class="meta">no projects folder is set yet \u2014 start with <code>standing-orders up --project-root &lt;dir&gt;</code> once</p>`
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
/**
 * The request's own session facts, readable from anywhere below the
 * dispatcher without threading them through forty call sites: the csrf
 * token the chrome's switcher forms carry, and the path a switch returns
 * to. AsyncLocalStorage follows the request's own async chain, so two
 * interleaved requests never read each other's token.
 */
const requestContext = new AsyncLocalStorage<{ csrf: string; returnTo: string }>();

/** A same-site path or "/": never a scheme, a host, or a protocol-relative road. */
function safeReturn(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "/";
  // A backslash is a slash to a browser's URL parser (`/\evil` → `//evil`), so it is refused too (v3 review, finding 10).
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\r\n\t\u0000-\u001f]/.test(raw) || raw.length > 512) return "/";
  return raw;
}

/** Chat actions may return only to the unified chat or one task-focused
 * lens. Other same-site paths are valid elsewhere, but not for chat forms. */
function safeChatReturn(raw: string | null | undefined): string {
  const safe = safeReturn(raw);
  try {
    const parsed = new URL(safe, "http://standing-orders.local");
    if (parsed.pathname !== "/chat") return "/chat";
    const task = parsed.searchParams.get("task");
    return task !== null && task.length > 0 && task.length <= 64 && !hasForbiddenControls(task)
      ? taskChatHref(task)
      : "/chat";
  } catch {
    return "/chat";
  }
}

function chatReturnWithSaid(back: string, said: string): string {
  return `${back}${back.includes("?") ? "&" : "?"}said=${encodeURIComponent(said)}`;
}

const chatReturnWithLatest = (back: string): string => `${back}#latest`;

/** The no-script "move to the front" sentinel: the form cannot name the
 * front of a partition, so the handler resolves it (slice 1b, fix 1). */
const QUEUE_FRONT = "__TOP__";

/** Drawn, one stroke weight, like the tab bar's icons — never a glyph. */
const GRIP_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">` +
  `<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/>` +
  `<circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`;
const TO_FRONT_ICON =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
  `<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
/** One stroke weight, from the tab bar's set: the sidebar's primary rows
 * wear an icon each; the foot's list stays text, the way Linear's does. */
const strokeIcon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
/** Where the queue lives now: the board, flipped to dispatch order. */
const QUEUE_VIEW = "/board?view=order";
const FOLDER_PATHS = `<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>`;
const CHAT_PATHS = `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`;
const NAV_ICONS: Partial<Record<Chrome["active"], string>> = {
  chat: strokeIcon(CHAT_PATHS),
  inbox: strokeIcon(`<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`),
  board: strokeIcon(`<path d="M6 5v11"/><path d="M12 5v6"/><path d="M18 5v14"/>`),
  runs: strokeIcon(`<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`),
  projects: strokeIcon(FOLDER_PATHS),
  settings: strokeIcon(`<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>`),
};

/** One grouped destination inside an accordion group or the /menu overflow. */
type NavRow = { key: Chrome["active"]; href: string; label: string; hint: string };

/**
 * Task-first IA: the rail's five always-visible rows (chat, inbox, board,
 * builds, projects) sit above two accordion groups. Workflows is where
 * work is planned, worked, and scheduled; Admin is who and what the fleet
 * runs on. Both draw from the same two lists on a desk (accordion groups)
 * and on a phone (/menu sections), so the two never disagree. activity,
 * done, and the review queue are views of builds, not rows; the queue is
 * the board's order view; peek hangs off builds; settings is pinned
 * outside both groups, never inside one.
 */
function workflowsRows(): NavRow[] {
  return [
    { key: "workbench", href: "/workbench", label: "portfolio", hint: "every project and live build in one place" },
    { key: "work", href: "/tasks", label: "task list", hint: "everything, filterable" },
    { key: "routines", href: "/routines", label: "routines", hint: "scheduled tracks and their firings" },
  ];
}
function adminRows(): NavRow[] {
  return [
    { key: "fleet", href: "/fleet", label: "fleet", hint: "who is working, and on what" },
    { key: "caps", href: "/caps", label: "requirements", hint: "tools and credentials builds need" },
    { key: "people", href: "/people", label: "people", hint: "who can sign in, and what they have done" },
    { key: "mode", href: "/mode", label: "operating mode", hint: "the signed posture this repository runs under" },
    { key: "system", href: "/system", label: "system", hint: "workers, providers, and grants" },
  ];
}
/** Which accordion group opens by default for a given active page. */
const WORKFLOWS_KEYS = new Set<Chrome["active"]>(["workbench", "work", "routines"]);
const ADMIN_KEYS = new Set<Chrome["active"]>(["fleet", "caps", "people", "mode", "system"]);

/** The builds screen's views (reduction pass §1): done, the review queue,
 * and activity are ways of looking at builds, not destinations. */
function buildsViews(current: "builds" | "done" | "review" | "activity"): string {
  const views: [typeof current, string, string][] = [
    ["builds", "/runs", "builds"],
    ["done", "/done", "done"],
    ["review", "/review", "review"],
    ["activity", "/activity", "activity"],
  ];
  return `<p class="meta board-view">${views
    .map(([key, href, label]) => (key === current ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`))
    .join(" \u00b7 ")}</p>`;
}

const CHEVRON_ICON =
  `<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
  `<path d="m6 9 6 6 6-6"/></svg>`;
/** The drag grip: a 2rem touch-sized handle that owns its touches
 * (touch-action: none), so a finger on it drags instead of scrolling. */
const GRIP_HANDLE = `<span class="queue-handle" aria-hidden="true">${GRIP_ICON}</span>`;

type QueueCardTask = ReturnType<Store["queueScoped"]>[number] & { dispatch?: DispatchDiagnosis | null };

function queueCard(one: QueueCardTask, csrf: string, revision: number, queueRevision: number, workers: { name: string; retired: boolean }[], column: string): string {
  // Presentation over queueScoped()'s shape only: state, scope, blockers,
  // and the reservation owner. Money is not in this query and is not
  // invented here — it stays on the task page, labeled.
  const state = one.taken
    ? `<span class="badge">being taken — keeps its claim</span>`
    : column === "anyone"
      ? `<span class="badge">queued</span>`
      : `<span class="badge">reserved for ${escape(column)}</span>`;
  const chips =
    ` ${state}` +
    `${one.dispatch === null || one.dispatch === undefined ? "" : ` <a class="badge" href="${taskHref(one.id)}">${escape(one.dispatch.summary.toLowerCase())}</a>`}`;
  const hidden =
    `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
    `<input type="hidden" name="projectRevision" value="${revision}">` +
    `<input type="hidden" name="queueRevision" value="${queueRevision}">` +
    `<input type="hidden" name="task" value="${escape(one.id)}">`;
  const controls = one.taken
    ? ""
    : `<form method="post" action="/queue/move" class="inline">${hidden}` +
      `<input type="hidden" name="column" value="${escape(column)}">` +
      `<input type="hidden" name="before" value="${QUEUE_FRONT}">` +
      `<button type="submit" class="icon-button" aria-label="move to the front">${TO_FRONT_ICON}</button></form>` +
      `<form method="post" action="/queue/move" class="inline">${hidden}` +
      `<select name="column" aria-label="reserve for">` +
      `<option value="anyone"${column === "anyone" ? " selected" : ""}>anyone</option>` +
      workers.filter(worker => !worker.retired).map(worker => `<option value="${escape(worker.name)}"${column === worker.name ? " selected" : ""}>${escape(worker.name)}</option>`).join("") +
      `</select><button type="submit">move</button></form>`;
  return (
    `<div class="card queue-card" data-task="${escape(one.id)}" data-taken="${one.taken ? "1" : "0"}"${one.dispatch === null || one.dispatch === undefined ? "" : ` data-dispatch-status="${escape(one.dispatch.code)}"`}>` +
    `<p class="row">${one.taken ? "" : `${GRIP_HANDLE}`}` +
    `<a href="${taskHref(one.id)}">${escape(one.title)}</a>${chips}</p>` +
    `<p class="row meta"><span class="mono">${escape(one.id)}</span> ${controls}</p>` +
    `</div>`
  );
}

/** The queue columns fragment — shared queue first, then each worker. */
function queueBody(
  tasks: QueueCardTask[],
  workers: { name: string; retired: boolean; note: string | null; capacity: number; building: number }[],
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
  const noteForm = (worker: { name: string; retired: boolean; note: string | null; capacity: number; building: number }): string =>
    worker.retired
      ? `<p class="meta">this worker is retired — drag these elsewhere, or register the name again</p>`
      : `<p class="meta mono">${worker.building} building in this project · unattended capacity ${worker.capacity}</p>` +
        `<form method="post" action="/queue/note" class="row">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<input type="hidden" name="projectRevision" value="${revision}">` +
        `<input type="hidden" name="runner" value="${escape(worker.name)}">` +
        `<input type="text" name="note" value="${worker.note === null ? "" : escape(worker.note)}" data-initial="${worker.note === null ? "" : escape(worker.note)}" placeholder="what this worker is working through" aria-label="column note" maxlength="200">` +
        `<button type="submit">save</button></form>` +
        `<p class="meta">takes from the shared queue when this column is empty</p>`;
  return (
    `<div class="lanes" data-queue-revision="${queueRevision}">` +
    column("shared queue", "anyone", `<p class="meta">workers take from here when their column is empty — top card first</p>`, shared, "nothing waiting — every task is reserved or running") +
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
          `<p class="row">${one.taken ? "" : `${GRIP_HANDLE}`}` +
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
        `<p class="row">${one.taken ? "" : `${GRIP_HANDLE}`}` +
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
export function queueScript(): string {
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
    // A refused move (slice 1b, fix 2): the handler's typed text/plain 409
    // lands on the card as a problem row — textContent, never markup. Only
    // an authenticated plain-text 409 is inlined; an HTML refusal (the
    // stale-project page), a login bounce, or anything unexpected navigates.
    `function problem(task,text){var card=region.querySelector('.queue-card[data-task="'+task.replace(/["\\\\]/g,"")+'"]');if(!card)return false;` +
    `var old=card.querySelector(".queue-problem");if(old)old.remove();` +
    `var row=document.createElement("p");row.className="problem queue-problem";row.setAttribute("role","alert");row.textContent=text;card.appendChild(row);return true;}` +
    `fetch("/queue/move",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:post.toString(),redirect:"manual"})` +
    `.then(function(r){if(r.ok)return fetch("/queue?fragment=1",{redirect:"manual",cache:"no-store"}).then(function(f){` +
    `if(f.type==="opaqueredirect"||f.status===401||f.status===403){location.href="/login";return false;}return f.ok?f.text():null;});` +
    `if(r.type==="opaqueredirect"||r.status===401||r.status===403){location.href="/login";return false;}` +
    `var kind=(r.headers&&r.headers.get?r.headers.get("content-type"):"")||"";` +
    `if(r.status===409&&kind.indexOf("text/plain")===0){return r.text().then(function(text){return problem(drag.task,text)?false:null;});}` +
    `return null;})` +
    `.then(function(t){if(t===false)return;if(t&&!paused()){region.innerHTML=t;last=Date.now();}else if(t===null){location.href="/board?view=order";}})` +
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
  permissionDefault: UnattendedPermissionMode = "auto",
  qualityDefault: QualityMode = "default",
): Screen {
  return screen("new task", [
    `<section class="task-intake">`,
    `<div class="task-intake-hero"><span class="task-intake-mark" aria-hidden="true">s·o</span>` +
      `<h1>What should get done?</h1>` +
      `<p>Describe the outcome in plain language. The planner will inspect the repository and turn it into a scope you can review.</p></div>`,
    problem === null ? "" : `<div class="problem">${escape(problem)}</div>`,
    taskComposerHtml({
      csrf,
      project,
      projectRevision,
      candidates,
      permissionDefault,
      qualityDefault,
    }),
    `<p class="meta task-agent-note">The agent asks only when an answer materially changes the work. Nothing builds until you approve the proposed scope. ` +
      `<a href="/chat">Prefer a conversation? Open workspace chat.</a></p>`,
    `</section>`,
  ].join("\n"), { chrome });
}

/** The revision batch a task's approval screen restates, or the named reason it cannot. */
type RevisionView =
  | { sourceTask: string; sourceRun: number; comments: { path: string | null; line: number | null; note: string; author: string }[] }
  | { problem: string };

function taskBody(data: {
  task: Task;
  /** Shared read-side lifecycle answer; the atomic claim still re-proves it. */
  dispatch?: DispatchDiagnosis | null;
  strikes: number;
  plan: "requested" | "drafted" | null;
  planDocument: string | null;
  /** v34: what this task delivers, and the scout's report when one exists. */
  deliverable?: "branch" | "report";
  report?: ReportView | null;
  revision?: RevisionView | null;
  /** v40: this task's own place in a bounded repair chain — computed
   * independent of `completion` (a freshly drafted, unapproved repair has
   * no run yet, so it must not wait for one to say so). `completion`'s own
   * branches render it too, once a run exists; this is the fallback for
   * the moment before that, so "awaiting approval" is never invisible. */
  repairChain?: RepairChainRow | null;
  publication?: Publication | null;
  repo: string | null;
  /** Immutable filing provenance (v12) — the approver sees which door
   * filed this (console, cli, intake, template:<name>) at the yes. */
  filedVia?: string | null;
  /** Coordinator provenance when an agent filed this; null otherwise. */
  coordinator?: { label: string; filedAgo: string | null } | null;
  holds: Hold[];
  contest?: { id: number; state: string; agents: number; kind: "race" | "comparison" } | null;
  claimed: boolean;
  /** What this task waits for — blockers outside this console's ceiling
   * are named but carry no state and no link. */
  waitsFor?: { id: string; title: string | null; state: string | null; admitted: boolean }[];
  /** Open tasks a "wait for" select may offer (this console's view only). */
  waitCandidates?: { id: string; title: string }[];
  /** The run whose lease is the CURRENT live claim — computed by the data
   * layer; the renderer never guesses liveness from a null outcome. */
  liveRunId?: number | null;
  /** Workers that are both alive and authorized for this task's project. */
  worker?: { answering: number; registered: number; totalRegistered: number; lastHeard: string | null };
  /** Unmet capabilities that keep this exact task out of dispatch. */
  gaps?: Gap[];
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
  /** Installation starting value for a task that has no profile yet. */
  permissionDefault?: UnattendedPermissionMode;
  /** Durable choice for this task, when one was explicitly made. */
  permissionMode?: UnattendedPermissionMode | null;
  /** Installation starting value and this task's explicit evidence depth. */
  qualityDefault?: QualityMode;
  qualityMode?: QualityMode | null;
  runs: Run[];
  /** Proof produced by the newest finished attempt. The two booleans are
   * machine facts about immutable, hash-addressed artifacts — never inferred
   * from the agent's prose. `proofVerdict` is the closed machine-authored
   * verdict (Priority 2), computed once at completion and never re-derived
   * here — null only for a run that predates the proof system. */
  completion?: {
    runId: number;
    outcome: string | null;
    hasTerminalDiff: boolean;
    hasHandoff: boolean;
    proofVerdict: ProofVerdict | null;
    /** v40: the verdict BEFORE an independent reviewer's judgements were
     * folded in — null when no review has folded (every run before this
     * migration, and every run no review has touched). */
    machineVerdict: ProofVerdict | null;
    proofReasons: string[];
    proofMatrix: CriterionMatrixRow[];
    proofMatrixLinks: EvidenceLinkMap;
    proofAccepted: boolean;
    /** v40: this run's own place in a bounded repair chain, if any. */
    repairChain: RepairChainRow | null;
    /** Priority 2's concise, shared result package. */
    receipt: CompletionReceiptView | null;
  } | null;
  decisions: Decision[];
  incidents: Incident[];
  /** Pending coordinator proposals on this task (mate arc v3), with the decisions their answer cards name. */
  coordinatorProposals?: { rows: CoordinatorProposal[]; decisions: Map<number, Decision>; now: Date } | null;
  /** Operator steering notes (arc 1), delivery state included. */
  steering?: SteerNote[];
  /** The publication grant the publisher would act under — from
   * publicationGrantFor(repo) only; null when none, or no project. */
  grant?: PublicationGrant | null;
  /** Degraded composition (slice 1c). "sensitive": the page carries a
   * password ceremony, so no live poller runs, the attempt panel is a
   * static line, and open decisions render link-only — decided by the page
   * wrapper from the rendered body itself. "pane": the body is embedded in
   * the workbench's selected-task pane, which carries no run pollers, so
   * only the attempt panel degrades. */
  degraded?: "sensitive" | "pane";
  csrf: string;
  nonce: string;
  problem: string | null;
  /** The attended road (Phase 2E): mint offer, or the open authorization. */
  attended?: {
    canMint: boolean;
    /** The mint picker (P1/C7): claude models to choose from, and the
     * permission posture default (escalated when the active mode says so). */
    mint?: { models: string[]; pinnedModel: string; posture: "auto" | "acceptEdits" | "bypassPermissions"; quick: boolean };
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

  // The active attempt panel (slice 1c): the run whose lease is the task's
  // CURRENT claim, named by its one unambiguous identity — build number and
  // worker (runsFor mixes roles newest-first, so an "attempt N" ordinal is
  // undefined and not used). The live peek and transcript embed here,
  // polled from the RUN's own authenticated fragments; a serve that never
  // asserted its runner says so in the same words the run page uses; a
  // page carrying a password ceremony degrades to the static line.
  const liveRunId = data.liveRunId ?? null;
  const liveRun = liveRunId === null ? undefined : data.runs.find(one => one.id === liveRunId);
  const degraded = data.degraded === "sensitive";
  const attemptPanel = (() => {
    if (liveRunId === null || liveRun === undefined) return "";
    const minutes = Math.max(0, Math.round((data.now.getTime() - new Date(liveRun.startedAt).getTime()) / 60_000));
    const head =
      `<p><strong>build #${liveRun.id} · ${escape(liveRun.runner)} · running ` +
      `<time data-elapsed-since="${escape(liveRun.startedAt)}">${minutes}m</time></strong></p>`;
    const door = `<p class="row"><a href="/r/${liveRun.id}">full build view →</a></p>`;
    if (data.degraded !== undefined) {
      return `<div class="card attempt-live" data-live-run="${liveRun.id}">${head}` +
        `<p class="meta">${data.degraded === "sensitive" ? "this page carries a password ceremony, so the live view stays on the build page" : "the live view is on the build page"}</p>${door}</div>`;
    }
    const peek =
      data.peekable === true
        ? `<p class="meta">what is changing right now</p>` +
          `<div id="run-peek"><p class="meta">watching\u2026 the first look lands within 15 seconds</p></div>` +
          `<p class="meta" id="run-peek-stamp"></p>`
        : `<p class="meta">the live file view is off \u2014 start serve with ${escape("--runner <name>")} naming this machine's worker, and it appears here</p>`;
    const transcript =
      data.peekable !== true
        ? ""
        : liveRun.provider !== "claude"
          ? `<p class="meta">the live transcript needs the claude harness for now \u2014 this build runs on ${escape(liveRun.provider)}</p>`
          : `<p class="meta">what the agent is saying · display only \u2014 this is not evidence, and the machine running the agent could alter it</p>` +
            `<pre id="live-transcript" class="mono" style="max-height:18rem;overflow:auto;white-space:pre-wrap"></pre>` +
            `<p class="meta" id="live-transcript-state"></p>`;
    return `<div class="card attempt-live" data-live-run="${liveRun.id}">${head}${peek}${transcript}${door}</div>`;
  })();

  // One truthful answer to the first question on a queued task: "will this
  // run?" The badge alone cannot distinguish approval, dependency,
  // capability, and worker gates. This card does, in priority order, and
  // gives the nearest concrete repair rather than making the operator infer
  // it from the rest of the page.
  const dispatchStatus = (() => {
    const box = (kind: "ok" | "problem", title: string, detail: string, status?: string, controls = ""): string =>
      `<div class="${kind === "problem" ? "problem" : "answered"} dispatch-status" id="run-status" data-dispatch-status="${escape(status ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">` +
      `<div class="dispatch-copy"><strong>${escape(title)}</strong><span class="meta">${detail}</span></div>${controls}</div>`;

    if (task.state !== "done") {
      const diagnosis = data.dispatch ?? null;
      if (diagnosis === null) return box("problem", "Dispatch unknown", "Refresh this task before relying on its scheduler state.", "unknown");
      if (diagnosis.code === "running" && liveRun !== undefined) {
        return box("ok", diagnosis.summary, `Worker <span class="mono">${escape(liveRun.runner)}</span> owns <a href="/r/${liveRun.id}">build #${liveRun.id}</a>.`, diagnosis.code);
      }
      const blocker = diagnosis.blockerTaskId === null
        ? null
        : (data.waitsFor ?? []).find(one => one.id === diagnosis.blockerTaskId);
      const action = (() => {
        switch (diagnosis.action) {
          case "start-worker": return "";
          case "write-scope": return ` <a href="#scope">Write the success contract</a> or use <strong>plan first</strong>.`;
          case "select-agent": return ` <a href="#scope">Choose an available provider and model</a>.`;
          case "approve-scope": return ` <a href="#approve">Review and sign the exact scope</a>.`;
          case "answer-decision": return ` <a href="#decisions">Answer the waiting question</a>.`;
          case "unhold": return ` Use <strong>unhold</strong> below when it may continue.`;
          case "retry-task": return ` Review the incident, then use <strong>retry</strong> below.`;
          case "repair-capability": return ` <a href="/caps">Repair the requirement</a>.`;
          case "repair-dependency":
            return blocker?.admitted === true
              ? ` <a href="${taskHref(blocker.id)}">Review that task</a>.`
              : "";
          default: return "";
        }
      })();
      const repairControls = (() => {
        if (diagnosis.action !== "repair-dependency" || blocker == null || data.csrf === "") return "";
        const endpoint = `${taskHref(task.id)}/repair-dependency`;
        const common =
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
          `<input type="hidden" name="blocker" value="${escape(blocker.id)}">`;
        const retry = blocker.admitted && blocker.state === "failed"
          ? `<form method="post" action="${endpoint}" class="dependency-repair-retry">${common}<input type="hidden" name="operation" value="retry"><button type="submit">Try that task again</button></form>`
          : "";
        const unlink =
          `<form method="post" action="${endpoint}" class="dependency-repair-unlink">${common}<input type="hidden" name="operation" value="unlink"><button type="submit" class="quiet">Continue without it</button></form>`;
        const standing = new Set((data.waitsFor ?? []).map(one => one.id));
        const replacements = (data.waitCandidates ?? []).filter(one => !standing.has(one.id));
        const replace = replacements.length === 0
          ? ""
          : `<form method="post" action="${endpoint}" class="dependency-repair-replace">${common}<input type="hidden" name="operation" value="replace">` +
            `<label class="dependency-repair-label">Choose another task that must finish first<select name="replacement" aria-label="another task that must finish first">${replacements.map(one => `<option value="${escape(one.id)}">${escape(one.title)}</option>`).join("")}</select></label>` +
            `<button type="submit" class="quiet">Wait for selected task</button></form>`;
        return `<div class="dependency-repair-actions" aria-label="ways to continue this task"><p class="meta dependency-repair-help">Choose another task that must finish first, or let this task continue without it.</p>${retry}${replace}${unlink}</div>`;
      })();
      const recoveryControl = (() => {
        if (diagnosis.action === null || diagnosis.action === "repair-dependency") return "";
        if (diagnosis.action === "start-worker") {
          const firstConnection = diagnosis.code === "no-worker-registered";
          return (
            `<details class="dispatch-recovery" open><summary>Get this task running</summary><div class="dispatch-recovery-body">` +
            (firstConnection
              ? `<p>Standing Orders is open, but this project has not been connected to a builder yet.</p><p>On the machine where the project lives, open that folder and run:</p>`
              : `<p>Standing Orders is open, but this project's builder stopped checking in. Reopen Standing Orders on the machine where the project lives.</p><p>If you normally start it from a terminal, open the project folder and run:</p>`) +
            `<code class="dispatch-recovery-command">standing-orders up</code>` +
            (firstConnection
              ? `<p class="meta">This is the normal start command: it opens the app, connects the project, and starts its builder. Keep Standing Orders running; approved tasks begin automatically.</p>`
              : `<p class="meta">This task resumes automatically when the builder reconnects. You do not need to file or approve it again.</p>`) +
            `<p><a href="/system">See connection status →</a></p></div></details>`
          );
        }
        const href = taskRecoveryHref(task.id, diagnosis);
        return href === null ? "" : `<a class="button-link dispatch-action-link" href="${href}">Get this task running</a>`;
      })();
      const positive = diagnosis.code === "running" || diagnosis.code === "ready" || diagnosis.code === "planning-ready" || diagnosis.code === "scouting-ready";
      const status = diagnosis.code === "ready" ? "ready-to-run" : diagnosis.code;
      const repairingDependency = diagnosis.action === "repair-dependency" && blocker !== null;
      const dependencyDetail =
        blocker?.admitted === true
          ? `This task was waiting for <strong>${escape(blocker.title ?? blocker.id)}</strong>, but that task was ${escape(blocker.state ?? "stopped")}.${action}`
          : "This task is waiting for other work that did not finish.";
      return box(
        positive ? "ok" : "problem",
        repairingDependency ? "Choose what happens next" : diagnosis.summary,
        repairingDependency ? dependencyDetail : `${escape(diagnosis.detail)}${action}`,
        status,
        repairControls || recoveryControl,
      );
    }

    if (task.state === "done") {
      const proof = data.completion ?? null;
      if (proof === null) {
        return box("problem", "Complete, proof missing", "The task is terminal but has no finished attempt record. Treat it as unverified.");
      }
      // A no-change conclusion never owes a proof — there is no diff to
      // check acceptance criteria or a changed-path claim against — so it
      // keeps reading on the two presence facts alone, exactly as before
      // the proof system existed (the "attested floor" this preserves).
      if (proof.outcome === "no-change") {
        const missing = [proof.hasHandoff ? null : "agent handoff", proof.hasTerminalDiff ? null : "terminal diff"]
          .filter((one): one is string => one !== null);
        return missing.length > 0
          ? box(
              "problem",
              "Complete, proof incomplete",
              `<a href="/r/${proof.runId}">Build #${proof.runId}</a> concluded no change was needed, but its ${escape(missing.join(" and "))} is missing.`,
            )
          : box(
              "ok",
              "Complete with evidence",
              `<a href="/r/${proof.runId}">Build #${proof.runId}</a> concluded no change was needed; its handoff and machine-captured diff are on record.`,
            );
      }
      // A built run's verdict is the machine's own — computed once at
      // completion by adjudicate() (Priority 2), never re-derived here.
      // Acceptance changes the CLASS (problem → ok) and the words, never
      // the underlying token: the surfaces still agree on what happened.
      const accepted = proof.proofAccepted;
      const detail = proof.proofReasons.length > 0 ? ` — ${escape(proof.proofReasons.join("; "))}` : "";
      // The accept act (DESIGN-SYSTEM §1): the one amber verb that
      // resolves this screen, sharing the approve ceremony's own CSS rule
      // — never a new amber selector.
      const acceptForm =
        accepted || data.csrf === ""
          ? ""
          : `<form method="post" action="${taskHref(task.id)}/accept-proof" class="approve-form">` +
            `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
            `<input type="text" name="note" maxlength="500" placeholder="optional note">` +
            `<button type="submit">accept anyway</button></form>`;
      // v40: the machine's own pre-fold verdict, restated when a review
      // moved it — "the machine attested it; reviewer:codex contradicted
      // c2" — never pretending the machine always disagreed.
      const machineNote =
        proof.machineVerdict === null || proof.machineVerdict === proof.proofVerdict
          ? ""
          : `<p class="meta">the machine's own verdict was ${escape(proofVerdictWords(proof.machineVerdict, []).word)}; an independent review lowered it</p>`;
      const chainHtml = repairChainHtml(proof.repairChain);
      if (proof.proofVerdict === "verified") {
        return box("ok", "Complete — verified", `<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished as ${escape(proof.outcome ?? "terminal")}, and the repository's approved verification command passed against it.`) + criterionMatrixHtml(proof.proofMatrix, { compact: true, runId: proof.runId, links: proof.proofMatrixLinks }) + machineNote + chainHtml;
      }
      if (proof.proofVerdict === "attested") {
        return box("ok", "Complete with evidence", `<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished as ${escape(proof.outcome ?? "terminal")}. Review its acceptance criteria, checks, and machine-captured diff; each is labeled by source.`) + criterionMatrixHtml(proof.proofMatrix, { compact: true, runId: proof.runId, links: proof.proofMatrixLinks }) + machineNote + chainHtml;
      }
      if (proof.proofVerdict === "refuted") {
        return (
          box(
            accepted ? "ok" : "problem",
            "Proof refuted",
            `<a href="/r/${proof.runId}">Build #${proof.runId}</a>'s proof disagrees with what the machine captured${detail}.${accepted ? " An operator accepted it anyway." : ""}`,
          ) + acceptForm + criterionMatrixHtml(proof.proofMatrix, { compact: true, runId: proof.runId, links: proof.proofMatrixLinks }) + machineNote + chainHtml
        );
      }
      // "short", or no verdict at all (a legacy run, or one where
      // adjudication itself could not run) — the honest default.
      return (
        box(
          accepted ? "ok" : "problem",
          "Needs verification",
          `<a href="/r/${proof.runId}">Build #${proof.runId}</a> finished as ${escape(proof.outcome ?? "terminal")}, but its proof is incomplete${detail}.${accepted ? " An operator accepted it anyway." : ""}`,
        ) + acceptForm + criterionMatrixHtml(proof.proofMatrix, { compact: true, runId: proof.runId, links: proof.proofMatrixLinks }) + machineNote + chainHtml
      );
    }
    return box("problem", "Dispatch unknown", "Refresh this task before relying on its scheduler state.", "unknown");
  })();

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
          `<p><strong>quality</strong> ${escape(qualityModeTitle(scope.qualityMode ?? "default"))}</p>`,
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
          acceptanceCeremonyHtml(scope.acceptance),
          `<p class="meta"><span class="seal">signs ${shortDigest(scope.digest)}</span> — approval binds to this exact wording</p>`,
          approval.approved
            ? `<p class="meta">approved by ${escape(approval.by)} at ${escape(approval.at)}</p>`
            : `<p class="meta">not approved${approval.reason === "changed" ? " — approved once, then rewritten" : ""}</p>`,
          `</div>`,
        ].join("\n");

  // The scout's report (mate arc §10): title, summary, the document inert,
  // and each follow-up as a filing the operator makes with one tap. A
  // report that exists but cannot be verified is a named problem, never a
  // blank — the same rule as the revision brief.
  const reportCard =
    data.report === null || data.report === undefined
      ? data.deliverable === "report"
        ? `<div class="card"><p><strong>scout task</strong> <span class="meta">delivers a report, never a branch — a read-only session investigates the goal and its report appears here when it finishes</span></p></div>`
        : ""
      : !data.report.ok
        ? `<div class="card"><p><strong>the report</strong></p><p class="meta">${escape(data.report.problem)} · <a href="/r/${data.report.run}">run ${data.report.run}</a></p></div>`
        : [
            `<div class="card report">`,
            `<p><strong>${escape(data.report.report.title)}</strong> <span class="meta">the scout's report · <a href="/r/${data.report.run}">run ${data.report.run}</a></span></p>`,
            `<p class="report-summary">${escape(data.report.report.summary)}</p>`,
            `<pre class="recap plan-doc">${escape(data.report.report.report)}</pre>`,
            ...(data.report.report.followUps.length === 0
              ? []
              : [
                  `<p><strong>follow-ups the scout proposes</strong> <span class="meta">each files as a task in this repository; its scope still needs your approval</span></p>`,
                  ...data.report.report.followUps.map(
                    (one, index) =>
                      `<div class="follow-up"><p><strong>${escape(one.title)}</strong></p><p class="meta">${escape(one.goal)}</p>` +
                      (data.csrf === "" || data.repo === null
                        ? `<p class="meta">${data.repo === null ? "this task has no repository — file it by hand" : ""}</p>`
                        : `<form method="post" action="${taskHref(task.id)}/follow-up" class="inline"><input type="hidden" name="csrf" value="${escape(data.csrf)}"><input type="hidden" name="index" value="${index}"><button type="submit">file this follow-up</button></form>`) +
                      `</div>`,
                  ),
                ]),
            `</div>`,
          ].join("\n");

  // The plan a planner drafted, when one exists: rendered inert above the
  // approval it proposes. The scope stays the contract; this is the road.
  const planCard =
    data.planDocument === null
      ? data.plan === "requested"
        ? `<div class="card planner-status"><span class="planner-orb" aria-hidden="true"></span><p><strong>planning requested</strong>` +
          `<span class="meta">The agent is inspecting the repository and drafting the goal, acceptance criteria, and approach. It will ask only if a missing answer changes the work.</span></p></div>`
        : ""
      : `<details class="planner-plan"><summary><strong>Planner’s approach</strong> <span class="meta">— review the plan or approve the concise scope below</span></summary>` +
        `<pre class="recap plan-doc">${escape(data.planDocument)}</pre></details>`;

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
  // The ceremony is the page's first card when a scope waits for its yes
  // (task page pass): it states the wait, restates every term the digest
  // binds, and puts the approve act above the fold — the consent-sheet
  // shape. An unapprovable scope gets the problem and the edit road
  // instead of a password it cannot use.
  const approvalProfile = scope?.profile ?? null;
  const approvalPermission =
    approvalProfile === null
      ? null
      : approvalProfile.provider === "claude"
        ? approvalProfile.permissionArgv === "bypassPermissions" ? "Full access" : "Auto permissions"
        : approvalProfile.provider === "gemini"
          ? approvalProfile.approvalArgv === "yolo" ? "Full access" : "Auto permissions"
          : approvalProfile.sandboxMode === "danger-full-access" ? "Full access" : "Workspace sandbox";
  const approveForm =
    scope === null || approval.approved || data.plan === "requested"
      ? ""
      : data.revision !== null && data.revision !== undefined && "problem" in data.revision
        ? `<div class="card approve-form" id="approve"><p><strong>This task is waiting on you: approval is blocked.</strong></p><p class="meta">${escape(data.revision.problem)} — a revision approves only against a brief that verifies</p></div>`
        : scope.profileState === "unresolved"
          ? `<div class="card approve-form" id="approve"><p><strong>This task is waiting on you: its scope cannot be approved yet.</strong></p>` +
            profileWords(scope) +
            `<p class="ceremony-road"><a class="button-link" href="#scope">edit the scope to fix it →</a></p></div>`
        : [
          `<form method="post" action="${taskHref(task.id)}/approve" class="card approve-form approval-card" id="approve">`,
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          `<input type="hidden" name="nonce" value="${escape(data.nonce)}">`,
          `<input type="hidden" name="digest" value="${escape(data.approvalDigest ?? scope.digest)}">`,
          `<input type="text" name="username" autocomplete="username" class="visually-hidden" tabindex="-1" aria-hidden="true">`,
          `<div class="ceremony-head"><span class="approval-title"><span class="approval-kicker">ready to run · approve exactly this:</span>` +
            `<strong>Review the proposed scope</strong></span><a href="#scope">Edit details</a></div>`,
          // The deliverable INSIDE the ceremony (mate arc §10): a yes on a
          // scout task authorizes a read-only session and a report, never
          // a branch — said where the signature is given.
          data.deliverable === "report"
            ? `<p class="meta"><span class="badge">scout</span> approving sends a read-only session to investigate this goal and deliver a report — no branch, nothing changes in the repository</p>`
            : "",
          // The filer INSIDE the ceremony (MCP spec v6): a coordinator's
          // request is signed knowing whose it is — and until this
          // signature, nothing plans, claims, or runs it.
          data.coordinator === null || data.coordinator === undefined
            ? ""
            : `<p class="meta">filed by <span class="mono">${escape(data.coordinator.label)}</span>${data.coordinator.filedAgo === null ? "" : ` \u00b7 ${escape(data.coordinator.filedAgo)}`} — an agent asked for this; nothing plans, claims, or runs until you sign, and your signature runs THEIR request</p>`,
          `<p class="approval-label">goal</p><p class="approval-goal">${escape(scope.goal)}</p>`,
          `<div class="approval-boundaries">`,
          `<div class="approval-boundary"><p class="approval-label">not this</p><p>${scope.outOfScope === null ? "<em>no exclusions</em>" : escape(scope.outOfScope)}</p></div>`,
          `<div class="approval-boundary"><p class="approval-label">touches</p><p>${scope.touches.length === 0 ? "anything" : scope.touches.map(one => escape(one)).join(", ")}</p></div>`,
          `</div>`,
          acceptanceCeremonyHtml(scope.acceptance),
          `<div class="approval-chips"><span class="approval-chip">quality · <strong>${escape(qualityModeTitle(scope.qualityMode ?? "default"))}</strong></span>` +
            (approvalProfile === null ? "" : `<span class="approval-chip">${escape(approvalProfile.provider)} · ${escape(approvalProfile.model)}</span>`) +
            (approvalPermission === null ? "" : `<span class="approval-chip">${escape(approvalPermission)}</span>`) +
            `</div>`,
          profileWords(scope),
          scope.budgetMicrousd === null
            ? ""
            : `<p class="meta">each build attempt has a $${(scope.budgetMicrousd / 1_000_000).toFixed(2)} agent-reported usage cap — on a subscription this is a work limiter, not an API charge</p>`,
          // One yes covers BOTH documents (finding 31): the race terms are
          // restated on the same card the password signs, or they are not
          // approved at all.
          data.raceTerms === null || data.raceTerms === undefined
            ? ""
            : data.raceTerms.kind === "comparison"
              ? `<p><strong>and this comparison:</strong></p>` +
                `<p class="recap" style="margin-top:0">${data.raceTerms.n} agents build this independently — ` +
                `${data.raceTerms.agents.map(agent => `${escape(agent.provider)} · ${escape(agent.model)}`).join("  vs  ")}. ` +
                `No dollar caps exist on a comparison — each agent runs until it finishes or stops making progress; ` +
                `spend lands measured only where the harness reports dollars (` +
                `${data.raceTerms.agents.filter(agent => agent.provider === "claude").length} of ${data.raceTerms.n} lanes here). ` +
                `You will compare the results and pick one.</p>`
              : `<p><strong>and this tournament:</strong></p>` +
                `<p class="recap" style="margin-top:0">${data.raceTerms.n} agents build this independently — ` +
                `${data.raceTerms.agents.map(agent => `${escape(agent.provider)} · ${escape(agent.model)}`).join("  vs  ")}. ` +
                `Each may spend $${(data.raceTerms.perAgentBudgetMicrousd / 1_000_000).toFixed(2)} plus a ` +
                `$${(data.raceTerms.overrunReserveMicrousd / 1_000_000).toFixed(2)} overrun reserve; the whole tournament is capped at ` +
                `$${(data.raceTerms.totalBudgetMicrousd / 1_000_000).toFixed(2)}. You will compare the results and pick one.</p>`,
          `<div class="approval-confirm"><label>your password, typed again <span class="meta">— confirms this exact scope</span><input type="password" name="token" autocomplete="current-password" placeholder="Password"></label>`,
          `<div class="sticky-actions"><button type="submit">${data.raceTerms === null || data.raceTerms === undefined ? "Approve & start" : data.raceTerms.kind === "comparison" ? "Approve comparison" : "Approve tournament"}</button></div></div>`,
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
                  `<option value="auto"${attended.mint.posture === "auto" ? " selected" : ""}>safe unattended — routine project commands and edits proceed</option>` +
                  `<option value="acceptEdits"${attended.mint.posture === "acceptEdits" ? " selected" : ""}>legacy acceptEdits — commands that ask are denied unattended</option>` +
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
    `<form method="post" action="${taskHref(task.id)}/scope" class="scope-editor">`,
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
    `<input type="hidden" name="sawDigest" value="${escape(scope?.digest ?? "")}">`,
    `<label>goal<textarea name="goal" rows="3">${escape(scope?.goal ?? "")}</textarea></label>`,
    `<label>not this<textarea name="not" rows="2">${escape(scope?.outOfScope ?? "")}</textarea></label>`,
    `<label>touches <span class="meta">(one per line)</span><textarea name="touches" rows="2">${escape(
      (scope?.touches ?? []).join("\n"),
    )}</textarea></label>`,
    `<label>acceptance <span class="meta">(required — one criterion per line: <code>statement | evidence,kinds | how</code>; evidence kinds are check, screenshot, changed-path, manual-review; id is optional and auto-numbered)</span><textarea name="acceptance" rows="3" placeholder="The button opens the settings panel | screenshot">${escape(
      acceptanceToLines(scope?.acceptance ?? []).join("\n"),
    )}</textarea></label>`,
    (() => {
      const defaults = data.spendDefaults ?? null;
      const budgetPrefill =
        scope?.budgetMicrousd != null
          ? (scope.budgetMicrousd / 1_000_000).toFixed(2)
          : defaults?.buildPerRunMicrousd != null
            ? (defaults.buildPerRunMicrousd / 1_000_000).toFixed(2)
            : "";
      return `<label>agent-reported usage cap <span class="meta">(optional — leave blank for uncapped subscription work)</span>` +
        `<input type="number" name="budget-usd" step="0.01" min="0.01" value="${escape(budgetPrefill)}" placeholder="no cap"></label>` +
        `<p class="meta">Claude expresses this limiter in API-equivalent dollars even on a membership. It does not switch the run to API billing.</p>`;
    })(),
    (() => {
      const profileMode: UnattendedPermissionMode | null =
        scope?.profile?.provider === "claude"
          ? scope.profile.permissionArgv === "bypassPermissions" ? "bypassPermissions" : "auto"
          : scope?.profile?.provider === "gemini"
            ? scope.profile.approvalArgv === "yolo" ? "bypassPermissions" : "auto"
            : scope?.profile?.provider === "codex" || scope?.profile?.provider === "openrouter"
              ? scope.profile.sandboxMode === "danger-full-access" ? "bypassPermissions" : "auto"
              : null;
      const selected: UnattendedPermissionMode = data.permissionMode ?? profileMode ?? data.permissionDefault ?? "auto";
      return `<fieldset class="permission-field"><legend>agent permissions</legend>` +
        permissionModeChoices("permission-mode", selected) +
        `<p class="meta permission-note">This task’s choice is sealed into its scope. Full access prevents permission prompts or sandbox limits from pausing supported unattended agents.</p></fieldset>`;
    })(),
    (() => {
      const selected: QualityMode = scope?.qualityMode ?? data.qualityMode ?? data.qualityDefault ?? "default";
      return `<fieldset class="permission-field"><legend>quality</legend>` +
        qualityModeChoices("quality-mode", selected) +
        `<p class="meta permission-note">This choice is signed into the scope. Strict / release automatically sends a completed diff through the isolated reviewer; repair remains bounded by your operating-mode authorization.</p></fieldset>`;
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
        `<details class="more-agents"${selectedCount > 0 ? " open" : ""}><summary>more than one agent (optional)</summary>`,
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
        `</details>`,
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
  // Ledger rows (slice 1c): the same row grammar as the portfolio's terminal
  // ledger — identity, outcome chip, one mono meta run of provider · model ·
  // duration · tokens · measured-or-unmeasured cost.
  const runs =
    data.runs.length === 0
      ? ""
      : `<h2>attempts</h2>` +
        data.runs
          .map(run => {
            const bits = [
              run.provider,
              run.model,
              minutesOf(run),
              tokensOf(run),
              runCostWords(run, run.id === liveRunId),
              run.parentRun !== null ? `↳ of #${run.parentRun}` : null,
            ].filter((bit): bit is string => bit !== null);
            return (
              `<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> ` +
              runOutcomeBadge(run, run.id === liveRunId) +
              `${run.reason === null ? "" : ` <span class="meta">${escape(reasonWords(run.reason))}</span>`}` +
              ` <span class="meta mono">${escape(bits.join(" · "))}</span>` +
              `<span class="right meta mono">${escape(when(run.startedAt))}</span></p>`
            );
          })
          .join("\n");

  // ---- the right rail (slice 1c) ------------------------------------------
  // Dollars stated per attempt set, measured or unmeasured in words — a
  // missing figure is never summed as $0.
  const spendWords = (rows: Run[]): string => {
    if (rows.length === 0) return "no attempt yet";
    const measured = rows.filter(one => one.costUsd !== null);
    const dollars = measured.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
    const subscription = measured.filter(one => one.authMode === "subscription");
    const subscriptionEquivalent = subscription.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
    const metered = measured.filter(one => one.authMode !== "subscription");
    const meteredDollars = metered.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
    // Tokens count only where an attempt reported them; a null report is
    // said, never summed as zero (commit-3 review, finding 2).
    const reported = rows.filter(one => one.tokensIn !== null || one.tokensOut !== null);
    const tokens = reported.reduce((sum, one) => sum + (one.tokensIn ?? 0) + (one.tokensOut ?? 0), 0);
    const tokenWords =
      reported.length === 0
        ? "tokens unreported"
        : reported.length < rows.length
          ? `${compactCount(tokens)} tokens from ${reported.length}/${rows.length} attempts`
          : `${compactCount(tokens)} tokens`;
    if (subscription.length > 0) {
      return [
        ...(metered.length > 0 ? [`$${meteredDollars.toFixed(2)} API-key usage`] : []),
        `$${subscriptionEquivalent.toFixed(2)} API-price equivalent from subscription usage (not an API charge)`,
        tokenWords,
        ...(measured.length < rows.length ? [`${rows.length - measured.length} attempt(s) unmeasured`] : []),
      ].join(" · ");
    }
    if (measured.length === rows.length) return `$${dollars.toFixed(2)} · ${tokenWords} · measured`;
    if (measured.length === 0) {
      return reported.length > 0
        ? `unmeasured — ${tokenWords}, no dollar figure reported`
        : rows.some(one => one.id === liveRunId)
          ? "unmeasured so far — the figure lands when the attempt finishes"
          : "unmeasured — nothing reported";
    }
    return `$${dollars.toFixed(2)} measured across ${measured.length}/${rows.length} attempts — ${rows.length - measured.length} unmeasured · ${tokenWords}`;
  };
  const thisAttempt = liveRun ?? data.runs[0];
  const prop = (key: string, value: string): string =>
    `<p class="row"><span class="meta">${key}</span> <span class="mono">${value}</span></p>`;
  const economics =
    prop("this attempt", escape(thisAttempt === undefined ? "no attempt yet" : spendWords([thisAttempt]))) +
    prop("task total", escape(spendWords(data.runs)));
  // "publishes as": push, open-PR, and merge are INDEPENDENT fields on the
  // grant — each phrased on its own; absent means exactly that.
  const publishesAs = (() => {
    const grant = data.grant ?? null;
    if (data.repo === null) return "no project — no publication grant can apply";
    if (grant === null) return "no publication grant — built work stays on its branch";
    return [
      grant.capabilities.includes("push-branch") ? `may push ${grant.headPrefix}* to ${grant.githubRepo}` : "cannot push",
      grant.capabilities.includes("open-pr") ? `may open a PR against ${grant.base}${grant.draft ? " (draft)" : ""}` : null,
      grant.merge === true ? `may merge${grant.mergeMethod == null ? "" : ` (${grant.mergeMethod})`}` : "cannot merge",
    ].filter((part): part is string => part !== null).join(" · ");
  })();
  const publishesRow = prop("publishes as", escape(publishesAs));
  // The property list (task page pass): worker and attempt, queue place,
  // the scope's standing with its seal, publication, spend — the key
  // facts a reader scans before anything else, in one row grammar.
  const workerRow =
    liveRun !== undefined
      ? prop("worker", `${escape(liveRun.runner)} · <a href="/r/${liveRun.id}">build #${liveRun.id}</a> running`)
      : data.runs[0] !== undefined
        ? prop("last attempt", `<a href="/r/${data.runs[0].id}">build #${data.runs[0].id}</a> · ${escape(data.runs[0].outcome ?? "never finished")} · ${escape(data.runs[0].runner)}`)
        : "";
  const queueRow =
    data.position !== null && data.position !== undefined && task.state === "queued"
      ? prop("queue", `${data.position.position} of ${data.position.total}${data.position.column === null ? " in the shared queue" : ` in ${escape(data.position.column)}'s queue`} · <a href="/board?view=order">reorder</a>`)
      : "";
  const scopeRow =
    scope === null
      ? prop("scope", "none yet")
      : approval.approved
        ? prop("approved scope", `<span class="seal">signs ${shortDigest(scope.digest)}</span> · ${escape(qualityModeTitle(scope.qualityMode ?? "default"))} · approved by ${escape(approval.by)} · ${escape(when(approval.at))}`)
        : prop("scope", approval.reason === "changed" ? "rewritten since its approval — needs a new yes" : "not approved");
  const strikesRow = data.strikes > 0 ? prop("strikes", `${data.strikes} failed attempt(s)`) : "";
  const propsCard = `<div class="card props">${workerRow}${queueRow}${scopeRow}${publishesRow}${economics}${strikesRow}</div>`;
  // Open decisions as the shared partial — answerable inline when the
  // page is not sensitive; link-only cards otherwise.
  const openDecisions = data.decisions.filter(one => one.state === "open" || one.state === "expired");
  const decisionRail =
    openDecisions.length === 0
      ? ""
      : `<p><strong>waits on you</strong></p>` +
        openDecisions
          .map(decision =>
            degraded
              ? `<div class="decide-card" data-decision-id="${decision.id}"><p class="q">${escape(decision.question)}</p>` +
                `<p class="meta">${escape(oneLineOf(decision.recap, 160))}</p>` +
                `<p class="meta"><a href="/d/${decision.id}">the full question →</a></p></div>`
              : decisionAnswerCard({ ...decision, taskId: task.id, repo: data.repo }, data.csrf, data.now, false),
          )
          .join("\n");
  const rail = [decisionRail, propsCard].filter(part => part !== "").join("\n");

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
      const providerRuns = data.runs.filter(run => run.provider === provider);
      const subscriptionRuns = providerRuns.filter(run => run.authMode === "subscription" && run.costUsd !== null);
      const subscriptionEquivalent = subscriptionRuns.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
      const meteredRuns = providerRuns.filter(run => run.authMode !== "subscription" && run.costUsd !== null);
      const meteredCost = meteredRuns.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
      const dollars = subscriptionRuns.length > 0
        ? [
            ...(meteredRuns.length > 0 ? [`$${meteredCost.toFixed(2)} API-key usage`] : []),
            `$${subscriptionEquivalent.toFixed(2)} subscription API-price equivalent — not an API charge`,
            ...(spend.measured < spend.runs ? [`${spend.runs - spend.measured} unmeasured`] : []),
          ].join(" · ")
        : spend.measured === spend.runs
          ? `$${spend.costUsd.toFixed(2)}`
          : spend.measured === 0
            ? "dollar cost unmeasured"
            : `$${spend.costUsd.toFixed(2)} across ${spend.measured}/${spend.runs} measured`;
      return (
        `<p class="row"><span class="mono">${escape(provider)}</span> ` +
        `<span class="meta">${spend.runs} attempt(s) · ${compactCount(spend.tokensIn)} in / ${compactCount(spend.tokensOut)} out · ${escape(dollars)}</span></p>`
      );
    });
    return lines.join("\n");
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
  const dependencyChoiceNeeded = data.dispatch?.action === "repair-dependency";

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
        `<button type="submit">don't wait for this</button></form></p>`,
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
        `<button type="submit">wait for this task</button>` +
        `<span class="meta"> — this task starts only after it finishes</span></form>`;
  const waitsForCard =
    waitRows === "" && waitAdd === ""
      ? ""
      : `<h2>waits for</h2>${waitRows === "" ? `<p class="meta">nothing — it starts when a worker is free</p>` : waitRows}${waitAdd}`;

  // The acts bar (task page pass): every verb in one row under the title,
  // the one that resolves this task's state first and primary — retry on a
  // stalled task, build-next in the queue, plan-first with no scope. The
  // hold's reason sits beside its button; cancel stays armed at the foot,
  // far from the primary. A live claim is never disturbed by an operator
  // hold (the hold governs the NEXT start), and requeue refuses while a
  // claim is live — so the words say exactly when each becomes real.
  const canPlan = data.plan === null && !approval.approved && !data.claimed && task.state === "queued" && (data.coordinator === null || data.coordinator === undefined);
  const primaryAct =
    stalled && !data.claimed
      ? { html: act("requeue", "retry — branch and workspace kept"), why: "resolves the incidents, clears the failed attempts, and queues the task again; the preserved branch and workspace are NOT erased", whyClass: "retry" }
      : canPlan
        ? { html: act("plan", "plan first"), why: "plan first sends an agent to read the repository, ask you questions, and propose a scope — nothing builds until you approve it", whyClass: "plan" }
        : data.plan === "requested"
          ? null
        : task.state === "queued" && !data.claimed && (data.position?.position ?? 1) > 1
          ? { html: act("next", "build this next"), why: "moves it to the front of its queue — the next free worker looks here first; approval is still required", whyClass: "next" }
          : null;
  const holdAct =
    `<form method="post" action="${taskHref(task.id)}/hold" class="inline act-hold">` +
    `<input type="hidden" name="csrf" value="${escape(data.csrf)}">` +
    `<input type="text" name="reason" class="inline" placeholder="reason (optional)" aria-label="hold reason">` +
    `<button type="submit">hold next attempt</button></form>`;
  const canHold = task.state === "queued" || task.state === "running" || task.state === "failed";
  const actsBar = [
    `<span id="task-actions"></span><div class="acts-bar">`,
    // While a ceremony leads the page, no other act competes as primary.
    primaryAct === null ? "" : approveForm === "" ? `<span class="primary">${primaryAct.html}</span>` : primaryAct.html,
    task.state === "queued" && (data.position?.position ?? 2) === 1 && task.priority > 0
      ? act("next", "back to filing order", `<input type="hidden" name="undo" value="1">`)
      : "",
    // A task with no scope is already unable to start. Showing a hold next
    // to "plan first" adds a second, unnecessary decision at the exact
    // moment the page should have one obvious action.
    canPlan || !canHold ? "" : holdAct,
    data.holds.some(hold => hold.ownerKind === "operator") ? act("unhold", "unhold") : "",
    `</div>`,
    primaryAct === null ? "" : `<p class="meta acts-why acts-why-${primaryAct.whyClass}">${primaryAct.why}</p>`,
    data.claimed
      ? `<p class="meta acts-why">a worker is building this right now — <em>hold next attempt</em> stops the one after it; cancel waits for the current build to finish${
          stalled ? "; retry becomes available after this attempt finishes" : ""
        }</p>`
      : "",
  ].join("\n");
  // Cancel gets the same ceremony as an irreversible answer: armed behind
  // one deliberate tap, styled as the destructive act it is.
  const cancelAct =
    task.state === "queued" || task.state === "running" || task.state === "failed"
      ? [
          `<details class="arm-danger"><summary>cancel this task — tap to arm</summary>`,
          `<form method="post" action="${taskHref(task.id)}/cancel">`,
          `<input type="hidden" name="csrf" value="${escape(data.csrf)}">`,
          `<button type="submit" class="danger">cancel ${escape(task.id)}</button>`,
          `</form></details>`,
        ].join("")
      : "";
  // Long sections fold, each with its count in the header: what needs
  // reading stays open; a ledger or a form folds until asked.
  const section = (title: string, html: string, open: boolean, count?: number): string =>
    html === ""
      ? ""
      : `<details class="section" id="${title.replace(/\s+/g, "-")}"${open ? " open" : ""}><summary><h2>${title}${count === undefined ? "" : ` <span class="lane-count">${count}</span>`}</h2></summary>` +
        html.replace(`<h2>${title}</h2>`, "") + `</details>`;

  return [
    // The title leads; the machine facts — id, state, project, provenance —
    // follow as one mono meta row instead of riding the headline.
    `<p class="meta task-eyebrow"><span class="mono">${escape(task.id)}</span>` +
      `${data.strikes > 0 ? ` · ${data.strikes} failed attempt(s)` : ""}` +
      `${data.repo === null ? "" : ` · ${escape(projectName(data.repo))}`}` +
      `${
        data.coordinator !== null && data.coordinator !== undefined
          ? ` · filed by <span class="mono">${escape(data.coordinator.label)}</span>${data.coordinator.filedAgo === null ? "" : ` ${escape(data.coordinator.filedAgo)}`}`
          : data.filedVia === null || data.filedVia === undefined
            ? ""
            : ` · filed via ${escape(data.filedVia)}`
      }${data.deliverable === "report" ? ` · <span class="badge">scout</span>` : ""}</p>`,
    `<div class="task-title-row"><h1 class="task-main-title">${escape(task.title)} <span class="badge badge-${escape(task.state)}">${escape(task.state)}</span></h1>${data.csrf === "" ? "" : taskViewSwitch(task.id, "overview")}</div>`,
    // The planner and approval cards already answer "what now?". Avoid a
    // second status box above the one action the operator came here for.
    (approveForm === "" || dependencyChoiceNeeded) && data.plan !== "requested" ? dispatchStatus : "",
    data.completion === null || data.completion === undefined || data.completion.receipt === null
      ? ""
      : completionReceiptCard(data.completion.receipt, task.id, "task"),
    planCard,
    approveForm === "" && !dependencyChoiceNeeded ? actsBar : "",
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
            `<button type="submit">reopen — the approved scope stands</button></form>`
          : "") +
        `</div>`
      );
    })(),
    data.problem === null ? "" : `<div class="problem">${escape(data.problem)}</div>`,
    // The board sent them here saying "needs you" — the page must open by
    // saying WHY and pointing at the act, not read as a fact sheet
    // (operator finding: clicking a needs-you card landed with no context).
    scope === null && data.plan === null && task.state === "queued" && data.dispatch?.code !== "needs-scope" && data.dispatch?.code !== "waiting-dependency" && !dependencyChoiceNeeded
      ? data.coordinator !== null && data.coordinator !== undefined
        // The quarantine speaks here too (round-2 finding 5): the planner
        // is as fenced as the builder on a coordinator filing, so "plan
        // first" would recommend a road that refuses.
        ? `<div class="card"><p><strong>This task is waiting on you: an agent filed it, and it has no scope.</strong></p>` +
          `<p class="meta">filed by <span class="mono">${escape(data.coordinator.label)}</span> — nothing plans, claims, or runs until you write a scope below and sign it. Your signature runs their request.</p></div>`
        : `<div class="card task-scope-needed"><p><strong>No approved scope yet</strong></p>` +
          `<p class="meta"><strong>Plan first</strong> drafts it from the repository, or <a href="#scope">write it yourself</a>.</p></div>`
      : "",
    dependencyChoiceNeeded ? "" : approveForm,
    dependencyChoiceNeeded || approveForm === "" ? "" : actsBar,
    // Evidence-first (M5.5): what needs you, then what happened — decisions
    // and incidents above the attempt ledger and spend, the mechanics
    // (scope, holds, acts) after. Only trustworthy facts moved up. The rail
    // (slice 1c) rides beside the main column on wide screens and above it
    // on narrow ones.
    `<div class="task-layout"><div class="task-main">`,
    contestCard,
    attemptPanel,
    data.coordinatorProposals == null || data.coordinatorProposals.rows.length === 0
      ? ""
      : section(
          "proposals",
          `<h2>proposed by coordinators</h2>` +
            coordinatorProposalsSection(
              data.coordinatorProposals.rows,
              data.coordinatorProposals.decisions,
              data.csrf,
              data.coordinatorProposals.now,
              false,
            ).replace(/<form method="post" action="\/proposals\/(\d+)\/(confirm|dismiss)" class="inline">/g, (_m, id: string, verb: string) => `<form method="post" action="/proposals/${id}/${verb}" class="inline"><input type="hidden" name="return" value="${escape(taskHref(data.task.id))}">`),
          true,
          data.coordinatorProposals.rows.length,
        ),
    section("decisions", decisions, true, data.decisions.length),
    section("incidents", incidents, true, data.incidents.length),
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
    section("report", reportCard, true),
    section("attempts", runs, true, data.runs.length),
    section("usage", spendCard, false),
    section("steering", steeringCard, (data.steering ?? []).length > 0, (data.steering ?? []).length),
    section(
      "scope",
      ["<h2>scope</h2>", scopeCard, revisionCard, data.completion != null ? "" : repairChainHtml(data.repairChain ?? null), attendedCard, scopeForm].join("\n"),
      data.plan !== "requested" && approveForm === "" && !(scope === null && canPlan),
    ),
    dependencyChoiceNeeded ? "" : section("waits for", waitsForCard, (data.waitsFor ?? []).length > 0, (data.waitsFor ?? []).length),
    section("holds", holds, true, data.holds.length),
    cancelAct,
    `</div><aside class="task-rail">${rail}</aside></div>`,
  ].join("\n");
}

function taskPage(chrome: Chrome, data: Parameters<typeof taskBody>[0]): Screen {
  // The beat moved to the chrome layer (v28): every console page keeps the
  // approver's sessions live; this page no longer carries its own.
  //
  // The sensitive-page composition guard (slice 1c): a live attended
  // attempt can coexist with an unapproved scope, so this page may carry a
  // password ceremony. sendScreen() would keep a functional script on such
  // a page — so the decision is made HERE, from the rendered body itself:
  // when the body (or the chrome's list pane) shows a password input, the
  // page re-renders degraded — no poller, static attempt line, link-only
  // decisions — and ships no functional script at all.
  const first = taskBody(data);
  const sensitive =
    SENSITIVE_INPUT.test(first) || (chrome.listPane !== undefined && SENSITIVE_INPUT.test(chrome.listPane));
  if (sensitive) return screen(`task \u00b7 ${data.task.id}`, taskBody({ ...data, degraded: "sensitive" }), { chrome });
  const liveRunId = data.liveRunId ?? null;
  const liveRun = liveRunId === null ? undefined : data.runs.find(one => one.id === liveRunId);
  const script =
    (liveRun !== undefined && data.peekable === true ? regionScript("run-peek", "peek", 15, `/r/${liveRun.id}`) : "") +
    (liveRun !== undefined && data.peekable === true && liveRun.provider === "claude" ? transcriptScript(`/r/${liveRun.id}`) : "") +
    (data.csrf !== "" && data.decisions.some(one => one.state === "open" || one.state === "expired") ? decisionAnswerScript() : "");
  return screen(`task \u00b7 ${data.task.id}`, first, {
    chrome,
    ...(script === "" ? {} : { functional: { script, fetches: true } }),
  });
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
    buildsViews("review"),
    `<p class="hint">published work waiting for review, oldest first — merging happens on GitHub. ${ready.length} reviewable, ${rows.length - ready.length} with failing CI.</p>`,
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
  "malformed-report": "the scout's report was malformed",
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
  report: "the scout's report",
  proof: "the agent's proof",
  "check-log": "the plane's re-run check",
  screenshot: "a screenshot",
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


function runsPage(
  chrome: Chrome,
  rows: (Run & { taskId: string })[],
  liveIds: ReadonlySet<number>,
  nextCursor: number | null,
  verdicts: Map<number, { verdict: ProofVerdict; matrix?: CriterionMatrixRow[] }> = new Map(),
  accepted: ReadonlySet<number> = new Set(),
): Screen {
  const list =
    rows.length === 0
      ? `<p class="meta">No builds yet \u2014 they appear once an approved task is dispatched.</p>`
      : rows
          .map(run => {
            const verdict = verdicts.get(run.id)?.verdict ?? null;
            const needsVerification =
              (verdict === "short" || verdict === "refuted") && !accepted.has(run.id)
                ? ` <span class="badge badge-failed">${verdict === "refuted" ? "proof refuted" : "needs verification"}</span>`
                : "";
            return (
              `<p class="row"><a href="/r/${run.id}" class="mono">#${run.id}</a> ` +
              `<a href="${taskHref(run.taskId)}" class="mono">${escape(run.taskId)}</a> ` +
              runOutcomeBadge(run, liveIds.has(run.id)) +
              `${run.qualityMode === "strict" ? ` <span class="badge">strict review</span>` : ""}` +
              needsVerification +
              criterionMatrixSummary(verdicts.get(run.id)?.matrix ?? []) +
              `${run.provider === "claude" ? "" : ` <span class="meta mono">${escape(run.provider)}</span>`}` +
              `<span class="right meta mono">${escape(when(run.startedAt))}` +
              `${run.providerStartedAt === null && run.tokensIn === null && run.tokensOut === null && run.costUsd === null ? "" : ` \u00b7 ${escape(runCostWords(run, liveIds.has(run.id)))}`}</span></p>`
            );
          })
          .join("\n");
  const older = nextCursor === null ? "" : `<p><a href="/runs?before=${nextCursor}">older →</a></p>`;
  return screen("builds", [`<h1>builds <a class="badge" href="/peek">peek at the live ones \u2192</a></h1>`, buildsViews("builds"), `<p class="hint">one build = one attempt by an agent to complete a task, on its own branch</p>`, list, older].join("\n"), { chrome });
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

/** A compact, typed view of the agent-authored handoff. Older v1
 * artifacts simply have no lists, while v2 can present the useful answer
 * before the raw diff and evidence below it. */
type StructuredHandoffView = {
  conclusion: string;
  changes: string[];
  verification: string[];
  followUps: string[];
};

function structuredHandoffView(artifacts: Artifact[], root: string): StructuredHandoffView | null {
  const artifact = [...artifacts].reverse().find(one => one.kind === "handoff");
  if (artifact === undefined) return null;
  const read = readVerifiedArtifact(root, artifact);
  if (!read.ok) return null;
  try {
    const parsed = JSON.parse(read.content.toString("utf8")) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== "object" || typeof parsed["conclusion"] !== "string") return null;
    const conclusion = oneLineOf(parsed["conclusion"], 600);
    if (conclusion === "" || hasForbiddenControls(conclusion)) return null;
    const list = (name: string): string[] =>
      Array.isArray(parsed[name])
        ? (parsed[name] as unknown[])
            .filter((one): one is string => typeof one === "string" && one.trim() !== "" && !hasForbiddenControls(one))
            .slice(0, 8)
            .map(one => oneLineOf(one, 240))
        : [];
    return { conclusion, changes: list("changes"), verification: list("verification"), followUps: list("followUps") };
  } catch {
    return null;
  }
}

/** The evidence bundle (Priority 2): the closed machine-authored verdict,
 * the agent's proof (or why it cannot be shown), the plane's own re-run
 * check, and every validated screenshot — each row labeled by source so
 * "the agent said" and "the machine proved" never blur together. */
type ProofBundleView = {
  verdict: ProofVerdict | null;
  reasons: string[];
  accepted: { by: string; note: string | null; at: string } | null;
  proof: { criteria: { statement: string; verdict: string; how: string }[]; checks: { command: string; exitCode: number; summary: string }[]; caveats: string[] } | null;
  proofProblem: string | null;
  checkLog: { text: string; artifactId: number; truncated: boolean } | null;
  screenshots: { path: string; caption: string; artifactId: number }[];
  /** v39: the criterion-to-evidence matrix, one row per signed criterion —
   * `[]` when the scope this run built against signed no rubric. */
  matrix: CriterionMatrixRow[];
  /** v39 review finding: where a row's answered evidence ref resolves to a
   * stored artifact, for `criterionMatrixHtml` to link. */
  matrixLinks: EvidenceLinkMap;
  /** v40: the verdict BEFORE an independent reviewer's judgements were
   * folded in — null when no review has folded. */
  machineVerdict: ProofVerdict | null;
  /** v40: this run's own place in a bounded repair chain, if any. */
  repairChain: RepairChainRow | null;
};

/** The smallest complete answer to "what did this task deliver?". It is a
 * projection of the same sealed handoff, proof, screenshot, and diff records
 * used by the run page—not a new persistence layer or another verdict. */
type CompletionReceiptView = {
  runId: number;
  outcome: string | null;
  summary: string | null;
  verdict: ProofVerdict | null;
  accepted: boolean;
  matrix: CriterionMatrixRow[];
  diff:
    | { fileCount: number; additions: number; deletions: number; binaryCount: number; filesTruncated: boolean }
    | { problem: string }
    | null;
  screenshots: { path: string; caption: string; artifactId: number }[];
  caveats: string[];
};

const SCREENSHOT_CAPTURE = /^agent-claimed screenshot at (.+) \(validated (?:png|jpeg)\)/;

function proofBundleView(store: Store, run: Run, artifacts: Artifact[], root: string): ProofBundleView | null {
  const verdictRow = store.proofVerdictFor(run.id);
  const acceptanceRow = store.proofAcceptance(run.id);
  const proofView = readVerifiedProofForRun(store, root, run.id);
  const checkLogArtifact = artifacts.find(one => one.kind === "check-log") ?? null;
  const screenshotArtifacts = artifacts.filter(one => one.kind === "screenshot");

  if (verdictRow === null && proofView === null && checkLogArtifact === null && screenshotArtifacts.length === 0) {
    return null;
  }

  const proof = proofView !== null && proofView.ok ? proofView.proof : null;
  const captionFor = (path: string): string => proof?.screenshots.find(one => one.path === path)?.caption ?? path;
  const screenshots = screenshotArtifacts.flatMap(artifact => {
    const path = SCREENSHOT_CAPTURE.exec(artifact.capture)?.[1];
    if (path === undefined) return [];
    return [{ path, caption: captionFor(path), artifactId: artifact.id }];
  });

  let checkLog: ProofBundleView["checkLog"] = null;
  if (checkLogArtifact !== null) {
    const read = readVerifiedArtifact(root, checkLogArtifact);
    checkLog = read.ok
      ? { text: read.content.toString("utf8"), artifactId: checkLogArtifact.id, truncated: checkLogArtifact.truncated }
      : { text: `(the check log no longer verifies: ${read.problem})`, artifactId: checkLogArtifact.id, truncated: false };
  }

  return {
    verdict: verdictRow?.verdict ?? null,
    reasons: verdictRow?.reasons ?? [],
    accepted: acceptanceRow === null ? null : { by: acceptanceRow.approver, note: acceptanceRow.note, at: acceptanceRow.acceptedAt },
    proof:
      proof === null
        ? null
        : {
            criteria: proof.criteria.map(one => ({ statement: one.statement, verdict: one.verdict, how: one.how })),
            checks: proof.checks,
            caveats: proof.caveats,
          },
    proofProblem: proofView !== null && !proofView.ok ? proofView.problem : null,
    checkLog,
    screenshots,
    matrix: verdictRow?.matrix ?? [],
    matrixLinks: evidenceLinksFor(artifacts),
    machineVerdict: verdictRow?.machineVerdict ?? null,
    repairChain: store.repairChainFor(run.id) ?? (() => {
      const ref = store.refById(run.taskRef);
      return ref === null ? null : store.repairChainForDraft(ref.externalId);
    })(),
  };
}

function completionReceiptView(store: Store, run: Run, artifacts: Artifact[], root: string): CompletionReceiptView {
  const handoff = structuredHandoffView(artifacts, root);
  const proof = proofBundleView(store, run, artifacts, root);
  const terminal = terminalDiffView(artifacts, root);
  const stat = terminal?.stat ?? null;
  return {
    runId: run.id,
    outcome: run.outcome,
    summary: handoff?.conclusion ?? run.handoff,
    verdict: proof?.verdict ?? null,
    accepted: proof?.accepted !== null && proof?.accepted !== undefined,
    matrix: proof?.matrix ?? [],
    diff:
      stat === null || "problem" in stat
        ? stat
        : {
            fileCount: stat.fileCount,
            additions: stat.additions,
            deletions: stat.deletions,
            binaryCount: stat.binaryCount,
            filesTruncated: stat.filesTruncated,
          },
    screenshots: proof?.screenshots ?? [],
    caveats: proof?.proof?.caveats ?? [],
  };
}

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

type ReviewDiffLine = {
  kind: "context" | "addition" | "deletion" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};
type ReviewDiffHunk = { header: string; lines: ReviewDiffLine[] };
type ReviewDiffFile = { path: string; oldPath: string | null; meta: string[]; hunks: ReviewDiffHunk[] };
type ReviewDiff = { files: ReviewDiffFile[]; linesTruncated: boolean };

const REVIEW_DIFF_LINE_CAP = 4_000;

/** Parse only the stable structure Git's unified patch format guarantees.
 * Unknown metadata remains visible, and a patch that cannot be structured
 * falls back to the sealed raw record—presentation never becomes proof. */
function parseReviewDiff(text: string): ReviewDiff {
  const files: ReviewDiffFile[] = [];
  let file: ReviewDiffFile | null = null;
  let hunk: ReviewDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let rendered = 0;
  let linesTruncated = false;

  const pathOf = (raw: string): string => {
    const withoutTimestamp = raw.split("\t", 1)[0]?.trim() ?? raw.trim();
    let decoded = withoutTimestamp;
    if (decoded.startsWith('"') && decoded.endsWith('"')) {
      try { decoded = JSON.parse(decoded) as string; } catch { decoded = decoded.slice(1, -1); }
    }
    return decoded === "/dev/null" ? decoded : decoded.replace(/^[ab]\//, "");
  };

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const at = raw.lastIndexOf(" b/");
      file = { path: at === -1 ? "changed file" : pathOf(raw.slice(at + 1)), oldPath: null, meta: [raw], hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (file === null) continue;
    if (raw.startsWith("--- ")) {
      file.oldPath = pathOf(raw.slice(4));
      file.meta.push(raw);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const nextPath = pathOf(raw.slice(4));
      if (nextPath !== "/dev/null") file.path = nextPath;
      file.meta.push(raw);
      continue;
    }
    const hunkHeader = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@(.*)$/.exec(raw);
    if (hunkHeader !== null) {
      oldLine = Number(hunkHeader[1]);
      newLine = Number(hunkHeader[2]);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === null) {
      if (raw !== "") file.meta.push(raw);
      continue;
    }
    if (rendered >= REVIEW_DIFF_LINE_CAP) {
      linesTruncated = true;
      continue;
    }
    rendered += 1;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      hunk.lines.push({ kind: "addition", text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      hunk.lines.push({ kind: "deletion", text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      hunk.lines.push({ kind: "context", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      hunk.lines.push({ kind: "meta", text: raw, oldLine: null, newLine: null });
    }
  }
  return { files, linesTruncated };
}

function reviewDiffHtml(
  patch: { text: string; truncated: boolean; artifactId: number },
  stat: TerminalDiffView["stat"],
  runId: number,
  commentable: boolean,
): string {
  const parsed = parseReviewDiff(patch.text);
  const structured = parsed.files.some(file => file.hunks.length > 0);
  if (!structured) {
    return (
      `<details><summary>the patch${patch.truncated ? " (TRUNCATED — the raw record says how much was cut)" : ""}</summary>` +
      `<pre class="mono" style="overflow-x:auto">${escape(patch.text)}</pre></details>` +
      `<p class="meta"><a href="/r/${runId}/evidence/${patch.artifactId}">Download the sealed patch</a></p>`
    );
  }
  const stats = stat !== null && !("problem" in stat) ? new Map(stat.files.map(one => [one.path, one] as const)) : new Map();
  const annotateIcon = strokeIcon(`<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8"/>`);
  const files = parsed.files.map((one, fileIndex) => {
    const counts = stats.get(one.path);
    const countWords = counts === undefined
      ? ""
      : counts.additions === null || counts.deletions === null
        ? `<span class="diff-file-counts">binary</span>`
        : `<span class="diff-file-counts"><b>+${counts.additions}</b><i>−${counts.deletions}</i></span>`;
    const hunks = one.hunks.map(hunk =>
      `<section class="diff-hunk"><div class="diff-hunk-head">${escape(hunk.header)}</div>` +
      `<div class="diff-lines">${hunk.lines.map(line => {
        const lineNumber = line.newLine ?? line.oldLine;
        const side = line.newLine === null && line.oldLine !== null ? "old" : "new";
        const annotate = !commentable || lineNumber === null || line.kind === "meta"
          ? `<span class="diff-annotate-space"></span>`
          : `<button type="button" class="diff-annotate pick-line" data-path="${escape(one.path)}" data-line="${lineNumber}" data-side="${side}" aria-label="Annotate ${escape(one.path)}, ${side} line ${lineNumber}" title="Annotate this line">${annotateIcon}</button>`;
        const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : line.kind === "context" ? " " : "·";
        return (
          `<div class="diff-line diff-${line.kind}">${annotate}` +
          `<span class="diff-gutter">${line.oldLine ?? ""}</span><span class="diff-gutter">${line.newLine ?? ""}</span>` +
          `<code><b aria-hidden="true">${marker}</b>${escape(line.text)}</code></div>`
        );
      }).join("")}</div></section>`
    ).join("");
    return (
      `<details class="diff-file"${fileIndex === 0 ? " open" : ""}>` +
      `<summary><span class="diff-file-name">${escape(one.path)}</span>${countWords}</summary>` +
      (one.oldPath !== null && one.oldPath !== "/dev/null" && one.oldPath !== one.path ? `<p class="diff-rename meta">from ${escape(one.oldPath)}</p>` : "") +
      hunks + `</details>`
    );
  }).join("");
  return (
    `<div class="diff-review" data-review-diff>` +
    (commentable
      ? `<div class="diff-review-bar"><span class="meta">${parsed.files.length} changed file${parsed.files.length === 1 ? "" : "s"}</span>` +
        `<div class="diff-modes" role="group" aria-label="diff mode"><button type="button" data-diff-mode="view" aria-pressed="true">View</button>` +
        `<button type="button" data-diff-mode="annotate" aria-pressed="false">Annotate</button></div></div>` +
        `<p class="diff-review-help">Select a line, then describe what should change. Nothing is revised until you create the revision below.</p>`
      : "") +
    files +
    (patch.truncated || parsed.linesTruncated ? `<p class="diff-cut">This visual diff is shortened. Review the sealed patch before approving.</p>` : "") +
    `</div><p class="meta"><a href="/r/${runId}/evidence/${patch.artifactId}">Download the sealed patch</a></p>`
  );
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
    parts.push(reviewDiffHtml(view.patch, view.stat, runId, commentable));
  }

  return parts.join("\n");
}

/**
 * The evidence bundle (Priority 2): the closed verdict first — the one
 * sentence every other surface agrees with — then criteria, the agent's
 * declared checks, the plane's own re-run (labeled "re-run here", never
 * confused with the agent's own claim), caveats, and every validated
 * screenshot as a thumbnail linking to the full image. Renders nothing
 * when the run predates the proof system.
 */
function evidenceBundleCard(view: ProofBundleView | null, runId: number): string {
  if (view === null) return "";
  const parts: string[] = ["<h2>evidence bundle</h2>"];

  if (view.verdict !== null) {
    const words = proofVerdictWords(view.verdict, view.reasons);
    parts.push(`<p class="row" data-proof-verdict="${escape(dispatchStatusToken(view.verdict))}"><strong>${escape(words.word)}</strong>${words.detail === "" ? "" : ` <span class="meta">${escape(words.detail)}</span>`}</p>`);
  }
  if (view.accepted !== null) {
    parts.push(
      `<p class="meta">accepted by <span class="mono">${escape(view.accepted.by)}</span> · ${escape(when(view.accepted.at))}${view.accepted.note === null ? "" : ` — ${escape(view.accepted.note)}`}</p>`,
    );
  }

  parts.push(criterionMatrixHtml(view.matrix, { runId, links: view.matrixLinks }));
  if (view.machineVerdict !== null && view.machineVerdict !== view.verdict) {
    parts.push(`<p class="meta">the machine's own verdict was ${escape(proofVerdictWords(view.machineVerdict, []).word)}; an independent review lowered it</p>`);
  }
  parts.push(repairChainHtml(view.repairChain));

  if (view.proofProblem !== null) {
    parts.push(`<p class="meta">proof: ${escape(view.proofProblem)}</p>`);
  } else if (view.proof !== null) {
    if (view.proof.criteria.length > 0) {
      parts.push(
        `<div class="result-section"><strong>acceptance criteria</strong><ul>` +
          view.proof.criteria
            .map(one => `<li><span class="badge${one.verdict === "met" ? " badge-done" : one.verdict === "not-met" ? " badge-failed" : ""}">${escape(one.verdict)}</span> ${escape(one.statement)} <span class="meta">— ${escape(one.how)}</span></li>`)
            .join("") +
          `</ul></div>`,
      );
    }
    if (view.proof.checks.length > 0) {
      parts.push(
        `<div class="result-section"><strong>checks reported by the agent</strong><ul>` +
          view.proof.checks.map(one => `<li><span class="mono">${escape(one.command)}</span> <span class="meta">(exit ${one.exitCode}) — ${escape(one.summary)}</span></li>`).join("") +
          `</ul></div>`,
      );
    }
    if (view.proof.caveats.length > 0) {
      parts.push(`<div class="result-section"><strong>caveats</strong><ul>${view.proof.caveats.map(one => `<li>${escape(one)}</li>`).join("")}</ul></div>`);
    }
  }

  if (view.checkLog !== null) {
    parts.push(
      `<details><summary>the plane's re-run check (re-run here)${view.checkLog.truncated ? " (TRUNCATED)" : ""}</summary>` +
        `<pre class="mono" style="overflow-x:auto">${escape(view.checkLog.text)}</pre></details>` +
        `<p class="meta"><a href="/r/${runId}/evidence/${view.checkLog.artifactId}">the raw check log</a></p>`,
    );
  }

  if (view.screenshots.length > 0) {
    parts.push(
      `<div class="result-section"><strong>screenshots</strong>` +
        view.screenshots
          .map(
            shot =>
              `<p class="row"><a href="/r/${runId}/evidence/${shot.artifactId}">` +
              `<img src="/r/${runId}/evidence/${shot.artifactId}" alt="${escape(shot.caption)}" style="max-width:12rem;max-height:9rem;border-radius:var(--radius);border:1px solid var(--border)"></a> ` +
              `<span class="meta">${escape(shot.caption)} · <span class="mono">${escape(shot.path)}</span></span></p>`,
          )
          .join("\n") +
        `</div>`,
    );
  }

  return parts.length === 1 ? "" : parts.join("\n");
}

/** A calm, scan-first result receipt for the task and its focused chat.
 * The full ledger remains one click away; this card carries only the facts
 * needed to decide whether to inspect, discuss, or move on. */
function completionReceiptCard(view: CompletionReceiptView, taskId: string, place: "task" | "chat"): string {
  const proof =
    view.verdict === null
      ? { word: "Unverified", state: "unknown" }
      : view.verdict === "verified"
        ? { word: "Verified", state: "verified" }
        : view.verdict === "attested"
          ? { word: "Evidence captured", state: "attested" }
          : view.verdict === "refuted"
            ? { word: view.accepted ? "Accepted with concerns" : "Proof disagrees", state: "problem" }
            : { word: view.accepted ? "Accepted with gaps" : "Needs verification", state: "problem" };
  const passed = view.matrix.length === 0 ? null : passFraction(view.matrix);
  const diff =
    view.diff === null
      ? "Change summary unavailable"
      : "problem" in view.diff
        ? "Change summary unavailable"
        : view.diff.fileCount === 0
          ? "No repository changes"
          : `${view.diff.fileCount} file${view.diff.fileCount === 1 ? "" : "s"} · +${view.diff.additions} −${view.diff.deletions}` +
            (view.diff.binaryCount > 0 ? ` · ${view.diff.binaryCount} binary` : "") +
            (view.diff.filesTruncated ? " · list shortened" : "");
  const criteria =
    passed === null
      ? "No signed rubric"
      : `${passed.passed}/${passed.total} acceptance criteria passed`;
  const shots =
    view.screenshots.length === 0
      ? ""
      : `<div class="receipt-visuals" aria-label="visual proof">${view.screenshots
          .slice(0, 4)
          .map(
            shot =>
              `<a class="receipt-shot" href="/r/${view.runId}/evidence/${shot.artifactId}">` +
              `<img src="/r/${view.runId}/evidence/${shot.artifactId}" alt="${escape(shot.caption)}">` +
              `<span>${escape(shot.caption)}</span></a>`,
          )
          .join("")}</div>`;
  const caveats =
    view.caveats.length === 0
      ? ""
      : `<div class="receipt-caveats"><strong>Before you move on</strong><ul>${view.caveats.map(one => `<li>${escape(one)}</li>`).join("")}</ul></div>`;
  return (
    `<section class="card completion-receipt" data-card-kind="result-receipt">` +
    `<div class="receipt-head"><div><span class="eyebrow">result · build #${view.runId}</span><h2>What shipped</h2></div>` +
    `<span class="receipt-proof" data-proof-state="${proof.state}"><i aria-hidden="true"></i>${escape(proof.word)}</span></div>` +
    `<p class="receipt-summary">${escape(view.summary ?? (view.outcome === "no-change" ? "The agent found that no repository change was needed." : "The build finished without a concise handoff."))}</p>` +
    `<div class="receipt-facts"><span><strong>${escape(criteria)}</strong><small>against the approved scope</small></span>` +
    `<span><strong>${escape(diff)}</strong><small>from the sealed final diff</small></span>` +
    `<span><strong>${view.screenshots.length} screenshot${view.screenshots.length === 1 ? "" : "s"}</strong><small>${view.screenshots.length === 0 ? "none required or captured" : "validated visual proof"}</small></span></div>` +
    shots + caveats +
    `<div class="receipt-actions"><a class="button-link" href="/r/${view.runId}">${place === "chat" ? "Review & annotate" : "Review full evidence"}</a>` +
    (place === "task"
      ? `<a href="${taskChatHref(taskId)}">Discuss or request changes →</a>`
      : `<a href="#latest">Request changes in chat →</a>`) +
    `</div></section>`
  );
}

/** The run's facts as rows — one renderer for the page and its live
 * fragment (A4). Elapsed ticks client-side while the run is open. */
function runFactsRows(run: Run, taskId: string, live: boolean): string {
  const facts: [string, string | null, boolean?][] = [
    ["task", taskId, true],
    ["role", run.role],
    ["quality", qualityModeTitle(run.qualityMode ?? "default")],
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
    // Auth is part of the economic fact: Claude's subscription harness
    // reports an API-price equivalent, not a separate API-key charge.
    [
      "usage",
      run.providerStartedAt === null && run.tokensIn === null && run.tokensOut === null && run.costUsd === null ? null : runCostWords(run, live),
      run.costUsd !== null && run.authMode !== "subscription",
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
  structuredHandoff: StructuredHandoffView | null = null,
  proofBundle: ProofBundleView | null = null,
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
  const resultSummary = structuredHandoff?.conclusion ?? run.handoff;
  const resultList = (label: string, items: string[]): string =>
    items.length === 0
      ? ""
      : `<div class="result-section"><strong>${escape(label)}</strong><ul>${items.map(one => `<li>${escape(one)}</li>`).join("")}</ul></div>`;
  const handoff =
    resultSummary === null
      ? ""
      : `<section class="card result-card"><h2>result</h2><p class="recap">${escape(resultSummary)}</p>` +
        (structuredHandoff === null
          ? ""
          : resultList("completed", structuredHandoff.changes) +
            resultList("checks reported by the agent", structuredHandoff.verification) +
            resultList("follow-up", structuredHandoff.followUps)) +
        `</section>`;
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
        `<div class="diff-comment"><span class="diff-comment-pin" aria-hidden="true"></span><p>` +
        `${one.path === null ? "" : commentPathWords(one.path, one.line)}` +
        `${escape(one.note)}</p><span class="meta">${escape(one.author)} · ${escape(when(one.createdAt))}</span></div>`,
    )
    .join("\n");
  const commentForm =
    csrf === "" || !hasTerminalDiff
      ? ""
      : `<form method="post" action="/r/${run.id}/comment" class="card diff-comment-form" id="comment-form">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<div class="diff-comment-target"><label>file<input type="text" name="path" placeholder="select a line above" aria-label="file" class="mono"></label>` +
        `<label>line<input type="text" name="line" placeholder="—" aria-label="line" inputmode="numeric"></label></div>` +
        `<label>change requested<textarea name="note" rows="2" maxlength="2000" placeholder="Explain what should change and why" aria-label="review comment"${noted ? " autofocus" : ""}></textarea></label>` +
        `<button type="submit">Add annotation</button></form>`;
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
      : `<form method="post" action="/r/${run.id}/revise" class="card revision-from-comments">` +
        `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
        `<div><strong>${comments.length} annotation${comments.length === 1 ? "" : "s"} ready</strong>` +
        `<span class="meta">Creates one revision carrying this exact batch. You review its scope before anything builds.</span></div>` +
        `<button type="submit">Create revision from annotations</button></form>`;
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
    (commentRows === "" && commentForm === "" ? "" : `<h2 id="review">Review and revise</h2>` +
      `<p class="meta">Annotate the diff above. When the batch is ready, create one scoped revision task from it.</p>` +
      `${commentRows === "" ? "" : `<div class="diff-comments">${commentRows}</div>`}${commentForm}${reviseForm}${editorToggleForm}`) + repairCard;

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
    handoff,
    evidenceBundleCard(proofBundle, run.id),
    terminal === null ? "" : terminalDiffCard(terminal, run.id, editor, commentForm !== ""),
    reviewCard,
    continueCard,
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
 * such — normal viewing stays the default; "Annotate" reveals line pins.
 * A pin or file button copies its target into the comment form and focuses
 * the note field. No fetch, endpoint, or submit: comments still leave
 * through the same CSRF'd form POST. Reads data attributes, writes input
 * values, and flips presentational state — never markup.
 */
function prefillScript(): string {
  return (
    `(function(){var form=document.getElementById("comment-form");if(!form)return;var review=document.querySelector("[data-review-diff]");` +
    `if(review){review.setAttribute("data-mode","view");review.addEventListener("click",function(ev){` +
    `var mode=ev.target&&ev.target.closest?ev.target.closest("button[data-diff-mode]"):null;if(!mode)return;` +
    `var value=mode.getAttribute("data-diff-mode")==="annotate"?"annotate":"view";review.setAttribute("data-mode",value);` +
    `review.querySelectorAll("button[data-diff-mode]").forEach(function(one){one.setAttribute("aria-pressed",String(one===mode));});});}` +
    `document.addEventListener("click",function(ev){` +
    `var button=ev.target&&ev.target.closest?ev.target.closest("button.pick-file,button.pick-line"):null;if(!button)return;` +
    `var path=form.querySelector("[name=path]");var line=form.querySelector("[name=line]");var note=form.querySelector("[name=note]");` +
    `if(path)path.value=button.getAttribute("data-path")||"";` +
    `if(line)line.value=button.getAttribute("data-line")||"";` +
    `form.scrollIntoView({behavior:"smooth",block:"center"});if(note)note.focus();});})();`
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

/** One accessible two-choice control everywhere permissions are selected.
 * The words describe behavior; the raw flag stays secondary detail. */
function permissionModeChoices(name: string, selected: UnattendedPermissionMode): string {
  const choice = (value: UnattendedPermissionMode, title: string, detail: string): string =>
    `<label class="permission-choice"><input type="radio" name="${escape(name)}" value="${escape(value)}"${value === selected ? " checked" : ""}>` +
    `<span><strong>${escape(title)}</strong><small>${escape(detail)}</small></span></label>`;
  return `<div class="permission-toggle" role="radiogroup" aria-label="agent permissions">` +
    choice("auto", "Auto", "Routine work proceeds; risky permission requests may stop for you.") +
    choice("bypassPermissions", "Full access", "Never asks. Uses the provider’s unrestricted non-interactive mode.") +
    `</div>`;
}

/** One compact two-choice control for evidence depth. Permissions answer
 * what the agent may do; this answers how much proof follows the work. */
function qualityModeChoices(name: string, selected: QualityMode): string {
  const choice = (value: QualityMode, title: string, detail: string): string =>
    `<label class="permission-choice"><input type="radio" name="${escape(name)}" value="${escape(value)}"${value === selected ? " checked" : ""}>` +
    `<span><strong>${escape(title)}</strong><small>${escape(detail)}</small></span></label>`;
  return `<div class="permission-toggle" role="radiogroup" aria-label="quality mode">` +
    choice("default", "Default", "Fast deterministic proof and the configured repository check.") +
    choice("strict", "Strict / release", "Adds an isolated semantic review and bounded repair when authorized.") +
    `</div>`;
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
  digest: { everyMs: number | null; lastSentAt: string | null; held: number } | null = null,
  permissionDefault: { mode: UnattendedPermissionMode; updatedAt: string | null; updatedBy: string | null; canManage: boolean } | null = null,
  qualityDefault: { mode: QualityMode; updatedAt: string | null; updatedBy: string | null; canManage: boolean } | null = null,
): Screen {
  const permissionCard =
    permissionDefault === null
      ? ""
      : [
          "<h2>unattended permissions</h2>",
          `<p class="meta">the starting choice for every new task. Each task can change it before approval; an approved scope always keeps the exact setting you signed.</p>`,
          permissionDefault.canManage && csrf !== ""
            ? `<form method="post" action="/settings/permission-default" class="card permission-policy">` +
              `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
              `<p><strong>default for new tasks</strong></p>` +
              permissionModeChoices("permission-mode", permissionDefault.mode) +
              `<p class="meta permission-note">Full access is for repositories and setup commands you trust. Changing this default does not alter any existing scope or approval.</p>` +
              `<button type="submit">save default</button></form>`
            : `<div class="card"><p><strong>${permissionDefault.mode === "bypassPermissions" ? "Full access" : "Auto"}</strong></p><p class="meta">an approver can change this default</p></div>`,
          permissionDefault.updatedAt === null
            ? ""
            : `<p class="meta">last changed ${escape(when(permissionDefault.updatedAt))}${permissionDefault.updatedBy === null ? "" : ` by ${escape(permissionDefault.updatedBy)}`}</p>`,
        ].join("\n");
  const qualityCard =
    qualityDefault === null
      ? ""
      : [
          "<h2>quality mode</h2>",
          `<p class="meta">the starting evidence depth for new tasks. It is separate from permissions and autonomy, and each approved scope keeps the exact choice you signed.</p>`,
          qualityDefault.canManage && csrf !== ""
            ? `<form method="post" action="/settings/quality-default" class="card permission-policy">` +
              `<input type="hidden" name="csrf" value="${escape(csrf)}">` +
              `<p><strong>default for new tasks</strong></p>` +
              qualityModeChoices("quality-mode", qualityDefault.mode) +
              `<p class="meta permission-note">Strict / release adds the isolated semantic reviewer after deterministic proof. Repair still obeys the separately approved operating-mode terms.</p>` +
              `<button type="submit">save default</button></form>`
            : `<div class="card"><p><strong>${escape(qualityModeTitle(qualityDefault.mode))}</strong></p><p class="meta">an approver can change this default</p></div>`,
          qualityDefault.updatedAt === null
            ? ""
            : `<p class="meta">last changed ${escape(when(qualityDefault.updatedAt))}${qualityDefault.updatedBy === null ? "" : ` by ${escape(qualityDefault.updatedBy)}`}</p>`,
        ].join("\n");
  const digestCard =
    digest === null || csrf === ""
      ? ""
      : [
          "<h2>telegram digest</h2>",
          `<p class="meta">away mode: routine facts (merges, reports, retries, plans ready) are held and sent as one digest on this cadence. A decision and anything that needs a person now still page the moment they land.</p>`,
          `<form method="post" action="/settings/telegram-digest" class="card">`,
          `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
          `<label>send a digest<select name="every">` +
            [
              ["off", "off — every fact pages as it lands"],
              ["30", "every 30 minutes"],
              ["60", "every hour"],
              ["240", "every 4 hours"],
              ["720", "every 12 hours"],
              ["1440", "once a day"],
            ]
              .map(([value, label]) => {
                const selected = value === "off" ? digest.everyMs === null : digest.everyMs === Number(value) * 60_000;
                return `<option value="${value}"${selected ? " selected" : ""}>${label}</option>`;
              })
              .join("") +
            `</select></label>`,
          `<p class="meta">${
            digest.everyMs === null
              ? "off"
              : `${digest.held} routine fact(s) held · next digest ${digest.lastSentAt === null ? "at the next bridge pass" : `no earlier than ${escape(new Date(new Date(digest.lastSentAt).getTime() + digest.everyMs).toISOString())}`}`
          }</p>`,
          `<button type="submit">save</button>`,
          `</form>`,
        ].join("\n");
  const keysCard =
    providerKeys === null || csrf === ""
      ? ""
      : [
          "<h2>provider API keys</h2>",
          `<p class="meta">stored as private files on this machine — never shown back, never in the database. A key reaches its provider only when that provider's sign-in is set to "the API key"; subscription mode strips that provider's key from the agent process, so the logged-in membership cannot silently become API billing.</p>`,
          ...providerKeys.map(one =>
            [
              `<form method="post" action="/settings/provider-key" class="card">`,
              `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
              `<input type="hidden" name="provider" value="${escape(one.provider)}">`,
              `<p class="row"><strong>${escape(one.provider)}</strong> <span class="mono meta">${escape(one.envName)}</span> ` +
                `<span class="meta">${
                  one.mode === "subscription" ? "uses its own login · no API-key spend" : "uses the API key"
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
                `<p class="meta">a notification when a decision, a pick, or a pull request needs a person — fixed phrases only; task content never rides a notification.</p>`,
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
    permissionCard,
    qualityCard,
    pushCard,
    keysCard,
    messagingCard,
    digestCard,
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
  /** v34: said inside the ceremony when the yes buys a report, not a branch. */
  deliverable?: "branch" | "report";
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
    `<p class="meta next-pager"><span>${data.remaining === 1 ? "the last thing waiting on you" : `1 of ${data.remaining} waiting on you`}</span>` +
    `<a class="skip" href="${skipHref}">not now — next \u2192</a></p>`;

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
      (data.deliverable === "report" ? `<p class="meta"><span class="badge">scout</span> a read-only session investigates this goal and delivers a report — no branch, nothing changes in the repository</p>` : "") +
      (scope === null ? "" : profileWords(scope)) +
      `<p class="meta">goal</p><p class="recap" style="margin-top:0">${escape(scope?.goal ?? item.approval.goal)}</p>` +
      `<p class="meta">not this</p><p class="recap" style="margin-top:0">${scope?.outOfScope == null ? "<em>no exclusions</em>" : escape(scope.outOfScope)}</p>` +
      `<p class="meta">touches · ${scope === null || scope.touches.length === 0 ? "anything" : scope.touches.map(one => escape(one)).join(", ")}</p>` +
      (scope === null ? "" : acceptanceCeremonyHtml(scope.acceptance)) +
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
function decisionOptionForms(decision: Decision, csrf: string, returnTo: string | null): string {
  return decision.options
    .map(option => {
      const recommended = option.id === decision.recommendation;
      const inner = [
        `<form class="option${recommended ? " recommended" : ""}" method="post" action="/d/${decision.id}/answer">`,
        `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
        `<input type="hidden" name="choice" value="${escape(option.id)}">`,
        ...(returnTo === null ? [] : [`<input type="hidden" name="return" value="${escape(returnTo)}">`]),
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
  returnTo: string | null = null,
): Screen {
  const csrf = who.via === "cookie" ? who.session.csrf : "";
  const options = decisionOptionForms(decision, csrf, returnTo);

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
    `<p class="meta"><a href="${returnTo === null ? "/" : escape(returnTo)}">← ${returnTo === null ? "everything waiting" : "back to the task chat"}</a></p>`,
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
