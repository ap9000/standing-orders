/**
 * External dispatch's sync pass (v20; five review rounds are the spec).
 *
 * What this does: pulls a tracker's nominated work into the overlay as
 * ORDINARY local tasks (mirrors), refreshes every known mirror's remote
 * state, verifies the plane marker, and delivers pending write-back
 * intents — all at daemon cadence, zero tokens.
 *
 * What this never does: touch claims or runs (the latch is a write to the
 * mirror row; admission and completion enforce it), import issue BODIES
 * (titles only, through the canonical proposal validator — a tracker
 * anyone can write to is a prompt-injection surface), or treat absence
 * from a capped listing as closure (every known mirror is fetched
 * INDIVIDUALLY; only a COMPLETE pass advances freshness).
 *
 * The plane marker is detection, never a distributed lease: a fixed-name
 * repository label carries this plane's id in its description. A 404 is
 * semantic "missing" only AFTER an authenticated access proof on the
 * repository itself — GitHub 404s private resources the caller cannot
 * see, and that must read as an OPERATIONAL block, fail closed.
 */

import { createHash } from "node:crypto";
import { run } from "./exec.js";
import type { Runner } from "./backend.js";
import { describeFailure, parseJson } from "./backend.js";
import type { BackendGrant } from "./grant.js";
import type { Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";

const GH = "gh";
export const SYNC_TIMEOUT_MS = 20_000;
export const MARKER_LABEL = "standing-orders-plane";
/** Bounded forward scan: pages of 100, at most this many pages per pass. */
export const MAX_FORWARD_PAGES = 10;

export type RemoteIssue = { number: number; title: string; state: "open" | "closed" };

type Operational = { ok: false; kind: "operational"; message: string };

const operational = (message: string): Operational => ({ ok: false, kind: "operational", message });

/** The gh surface the pass needs, injectable for tests. */
export type DispatchAdapter = {
  /** Authenticated access proof: 200 + push permission, or operational. */
  repoAccess(remoteRepo: string): Promise<{ ok: true; push: boolean } | Operational>;
  /** Complete forward listing — complete=false when the page cap cut it. */
  listAllOpen(remoteRepo: string): Promise<{ ok: true; issues: RemoteIssue[]; complete: boolean } | Operational>;
  /** One issue, individually — the reverse sweep's only evidence. */
  getIssue(remoteRepo: string, number: string): Promise<{ ok: true; found: RemoteIssue | null } | Operational>;
  readMarker(remoteRepo: string): Promise<{ ok: true; plane: string | null; malformed: boolean } | Operational>;
  writeMarker(remoteRepo: string, planeId: string): Promise<{ ok: true } | Operational>;
  deleteMarker(remoteRepo: string): Promise<{ ok: true } | Operational>;
  comment(remoteRepo: string, number: string, body: string): Promise<{ ok: true } | Operational>;
  close(remoteRepo: string, number: string): Promise<{ ok: true } | Operational>;
};

export function ghDispatchAdapter(runner: Runner = run, timeoutMs = SYNC_TIMEOUT_MS): DispatchAdapter {
  const call = (args: readonly string[]) => runner(GH, args, { timeoutMs });
  return {
    async repoAccess(remoteRepo) {
      const result = await call(["api", `repos/${remoteRepo}`]);
      if (result.code !== 0) return operational(describeFailure(result));
      const parsed = parseJson(result.stdout) as Record<string, unknown> | null;
      if (parsed === null || typeof parsed !== "object") return operational("gh returned something unreadable for the repository");
      const permissions = parsed["permissions"] as Record<string, unknown> | undefined;
      return { ok: true, push: permissions !== undefined && permissions["push"] === true };
    },
    async listAllOpen(remoteRepo) {
      const issues: RemoteIssue[] = [];
      for (let page = 1; page <= MAX_FORWARD_PAGES; page++) {
        const result = await call(["api", `repos/${remoteRepo}/issues?state=open&per_page=100&page=${page}`]);
        if (result.code !== 0) return operational(describeFailure(result));
        const parsed = parseJson(result.stdout);
        if (!Array.isArray(parsed)) return operational("gh returned something that is not a list");
        for (const raw of parsed) {
          const issue = readRemoteIssue(raw);
          // The issues API interleaves pull requests; a PR is not a task.
          if (issue !== null && !(typeof raw === "object" && raw !== null && "pull_request" in (raw as object))) {
            issues.push(issue);
          }
        }
        if (parsed.length < 100) return { ok: true, issues, complete: true };
      }
      return { ok: true, issues, complete: false };
    },
    async getIssue(remoteRepo, number) {
      const result = await call(["api", `repos/${remoteRepo}/issues/${number}`]);
      if (result.code !== 0) {
        // The caller has ALREADY proved authenticated access this pass, so a
        // 404 here is the issue itself being gone.
        return /404|Not Found/i.test(result.stderr) ? { ok: true, found: null } : operational(describeFailure(result));
      }
      const issue = readRemoteIssue(parseJson(result.stdout));
      return issue === null ? operational("gh returned an issue in a shape we do not know") : { ok: true, found: issue };
    },
    async readMarker(remoteRepo) {
      const result = await call(["api", `repos/${remoteRepo}/labels/${MARKER_LABEL}`]);
      if (result.code !== 0) {
        return /404|Not Found/i.test(result.stderr) ? { ok: true, plane: null, malformed: false } : operational(describeFailure(result));
      }
      const parsed = parseJson(result.stdout) as Record<string, unknown> | null;
      const description = parsed !== null && typeof parsed["description"] === "string" ? String(parsed["description"]) : "";
      const match = /^plane:([0-9a-f]{16})$/.exec(description.trim());
      if (match?.[1] !== undefined) return { ok: true, plane: match[1], malformed: false };
      return { ok: true, plane: null, malformed: true };
    },
    async writeMarker(remoteRepo, planeId) {
      const result = await call([
        "label", "create", MARKER_LABEL, "--repo", remoteRepo, "--force",
        "--description", `plane:${planeId}`, "--color", "ededed",
      ]);
      return result.code === 0 ? { ok: true } : operational(describeFailure(result));
    },
    async deleteMarker(remoteRepo) {
      const result = await call(["api", "-X", "DELETE", `repos/${remoteRepo}/labels/${MARKER_LABEL}`]);
      return result.code === 0 || /404|Not Found/i.test(result.stderr) ? { ok: true } : operational(describeFailure(result));
    },
    async comment(remoteRepo, number, body) {
      const result = await call(["issue", "comment", number, "--repo", remoteRepo, "--body", body]);
      return result.code === 0 ? { ok: true } : operational(describeFailure(result));
    },
    async close(remoteRepo, number) {
      const result = await call(["issue", "close", number, "--repo", remoteRepo]);
      return result.code === 0 ? { ok: true } : operational(describeFailure(result));
    },
  };
}

function readRemoteIssue(record: unknown): RemoteIssue | null {
  if (typeof record !== "object" || record === null) return null;
  const raw = record as Record<string, unknown>;
  if (typeof raw["number"] !== "number") return null;
  return {
    number: raw["number"],
    title: typeof raw["title"] === "string" ? raw["title"] : "",
    state: String(raw["state"]).toLowerCase() === "closed" ? "closed" : "open",
  };
}

/** ghi-<owner>-<name>-<n>-<hash8>: collision-resistant across long slugs. */
export function mirrorTaskId(remoteRepo: string, remoteId: string): string {
  const hash = createHash("sha256").update(`${remoteRepo}#${remoteId}`).digest("hex").slice(0, 8);
  const slug = remoteRepo.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
  return `ghi-${slug}-${remoteId}-${hash}`;
}

export type SyncReport = {
  remoteRepo: string;
  outcome: "complete" | "capped" | "failed" | "blocked";
  detail: string | null;
  candidates: number;
  mirrored: number;
  latched: number;
  delivered: number;
};

/**
 * One pass over one dispatch grant. Order is the spec's: access proof →
 * marker verdict → forward scan → reverse sweep (every known mirror,
 * individually) → intent delivery → ledger close. Only a pass in which
 * EVERY step succeeded closes `complete` and advances freshness.
 */
export async function syncPass(
  store: Store,
  grant: BackendGrant,
  adapter: DispatchAdapter,
  now: () => Date,
): Promise<SyncReport> {
  const remoteRepo = grant.remoteRepo as string;
  const report: SyncReport = { remoteRepo, outcome: "failed", detail: null, candidates: 0, mirrored: 0, latched: 0, delivered: 0 };

  // 1. Authenticated access proof — WITHOUT it, every 404 downstream is
  //    operational, and dispatch blocks immediately (no grace window).
  const access = await adapter.repoAccess(remoteRepo);
  if (!access.ok) {
    store.setDispatchBlocked(grant.repo, grant.backend, "unreachable", now(), access.message);
    report.outcome = "blocked";
    report.detail = access.message;
    return report;
  }

  // 2. The marker verdict — semantic states only from a complete response.
  const marker = await adapter.readMarker(remoteRepo);
  if (!marker.ok) {
    store.setDispatchBlocked(grant.repo, grant.backend, "unreachable", now(), marker.message);
    report.outcome = "blocked";
    report.detail = marker.message;
    return report;
  }
  if (marker.malformed) {
    store.setDispatchBlocked(grant.repo, grant.backend, "multiple-or-malformed", now(), "the plane marker's description is not this tool's shape");
    report.outcome = "blocked";
    report.detail = "marker malformed";
    return report;
  }
  if (marker.plane === null) {
    store.setDispatchBlocked(grant.repo, grant.backend, "missing", now(), "no plane marker on the repository — enroll again to write it");
    report.outcome = "blocked";
    report.detail = "marker missing";
    return report;
  }
  if (marker.plane !== grant.planeId) {
    store.setDispatchBlocked(grant.repo, grant.backend, "foreign", now(), `the repository's marker names another plane (${marker.plane.slice(0, 6)}…)`);
    report.outcome = "blocked";
    report.detail = "foreign plane";
    return report;
  }
  // A VERIFIED matching marker clears any standing block — transient or
  // semantic — because verification is exactly what a block awaited. The
  // LIVE row is read here; the caller's copy may predate the block.
  const live = store.grantFor(grant.repo, grant.backend);
  if (live?.dispatchBlocked != null) {
    store.setDispatchBlocked(grant.repo, grant.backend, null, now());
  }

  const pass = store.openSyncPass(grant.backend, remoteRepo, now());
  let capped = false;

  // 3. Forward: candidates. Only selector=all ESTABLISHES from the scan —
  //    'ours' mirrors are established at creation/intake, never nominated
  //    by a listing (provenance is a record, not a label).
  const listing = await adapter.listAllOpen(remoteRepo);
  if (!listing.ok) {
    store.closeSyncPass(pass.id, "failed", { candidates: 0, mirrored: 0 }, now(), listing.message);
    report.detail = listing.message;
    return report;
  }
  if (!listing.complete) capped = true;
  report.candidates = listing.issues.length;
  for (const issue of listing.issues) {
    const existing = store.mirrorByRemote(grant.backend, remoteRepo, String(issue.number));
    if (existing !== null) continue;
    if (grant.selector !== "all") continue;
    const localId = mirrorTaskId(remoteRepo, String(issue.number));
    const filed = store.transact(() => {
      const made = fileTaskProposal(
        store,
        { id: localId, title: issue.title, repo: grant.repo, filedVia: "sync" },
        now(),
      );
      if (!made.ok) return made;
      const established = store.establishMirror(
        {
          localTaskId: made.id,
          backend: grant.backend,
          remoteRepo,
          remoteId: String(issue.number),
          provenance: "granted-all",
          establishedBy: "sync",
          syncGeneration: pass.generation,
        },
        now(),
      );
      if (!established.ok) throw new Error(`mirror not established: ${established.reason}`);
      return made;
    });
    if (filed.ok) report.mirrored += 1;
    // A title the validator refuses is NOT mirrored — the pass records it
    // in detail and stays honest about the count.
    else if (report.detail === null) report.detail = `refused: ${filed.message}`;
  }

  // 4. Reverse: every known mirror, individually — absence from a listing
  //    proves nothing (finding 2).
  let reverseFailed: string | null = null;
  for (const mirror of store.externalMirrors(grant.backend, remoteRepo)) {
    const seen = await adapter.getIssue(remoteRepo, mirror.remoteId);
    if (!seen.ok) {
      reverseFailed = seen.message;
      break;
    }
    if (seen.found === null) {
      store.latchMirror(mirror.localTaskId, "missing", pass.generation, now());
      report.latched += 1;
    } else if (seen.found.state === "closed") {
      store.latchMirror(mirror.localTaskId, "closed", pass.generation, now());
      report.latched += 1;
    } else {
      store.observeMirrorOpen(mirror.localTaskId, pass.generation);
    }
  }
  if (reverseFailed !== null) {
    store.closeSyncPass(pass.id, "failed", { candidates: report.candidates, mirrored: report.mirrored }, now(), reverseFailed);
    report.detail = reverseFailed;
    return report;
  }

  // 5. Intents, under the grant's classes exactly — a denial is a typed
  //    refusal on the intent's own ledger, never a run rewrite.
  for (const intent of store.pendingExternalIntents()) {
    const mirror = store.mirrorByTask(intent.mirror);
    if (mirror === null || mirror.remoteRepo !== remoteRepo || mirror.backend !== grant.backend) continue;
    const allowed =
      intent.kind === "comment"
        ? grant.mutations.includes("comment" as (typeof grant.mutations)[number])
        : intent.kind === "close"
          ? grant.mutations.includes("close" as (typeof grant.mutations)[number])
          : grant.mutations.includes("transition" as (typeof grant.mutations)[number]);
    if (!allowed) {
      store.settleExternalIntent(intent.id, "refused", now(), `the grant does not allow ${intent.kind}`);
      continue;
    }
    const sent =
      intent.kind === "comment"
        ? await adapter.comment(remoteRepo, mirror.remoteId, intent.body ?? "")
        : await adapter.close(remoteRepo, mirror.remoteId);
    if (sent.ok) {
      store.settleExternalIntent(intent.id, "delivered", now());
      report.delivered += 1;
    } else {
      store.settleExternalIntent(intent.id, "refused", now(), sent.message);
    }
  }

  const outcome = capped ? "capped" : "complete";
  store.closeSyncPass(pass.id, outcome, { candidates: report.candidates, mirrored: report.mirrored }, now(), report.detail);
  report.outcome = outcome;
  return report;
}
