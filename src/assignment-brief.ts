/** A bounded catch-up over saved project/task records, not conversation memory.
 * Callers authenticate first and pass their current project ceiling. */
import { createHash } from "node:crypto";
import type { AssignmentAccess, AssignmentSnapshot } from "./assignment.js";
import { workIndexPage } from "./work-index.js";
import { publicChatText } from "./chat-display.js";
import type { Store } from "./store.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 16_000;
const RECENT_MS = 7 * 24 * 60 * 60_000;
export type AssignmentCatchUp = {
  version: 1; asOf: string; readOnly: true;
  assignments: {
    rootId: string; taskId: string; repo: string | null; title: string; state: AssignmentSnapshot["state"];
    detail: string; goal: string | null; updatedAt: string; runId: number | null; resultRunId: number | null;
    outcome: string | null; checks: { status: string; exitCode: number | null; detail: string } | null;
    nextAction: AssignmentSnapshot["primaryAction"]; attention: string[];
    decisions: { id: number; runId: number; question: string; state: string; overdue: boolean; choice: string | null }[];
  }[];
  projects: { repo: string; knowledge: {
    status: "stored" | "none" | "unavailable"; revision: number | null; identity: string | null; sha256: string | null;
    instructions: string; sources: { id: string; title: string; kind: "saved-note" | "repository-document"; path: string | null; sourceRevision: string | null; sourceSha: string | null }[]; decisions: { id: number; claim: string }[];
  } }[];
  omissions: { assignments: number; decisions: number; projects: number; textFields: number; candidateScanLimited: boolean; notes: string[] };
};

/** A current snapshot, never a receipt to acknowledge. Full assignment reads
 * remain the place to inspect exact saved work and obtain its current digest. */
export function assignmentCatchUp(store: Store, now: Date, access: AssignmentAccess,
  query: { repo?: string; limit?: number } = {}, evidenceRoot?: string): AssignmentCatchUp {
  // The evidence root is retained for adapter compatibility; this summary
  // deliberately performs no artifact reads even when it is supplied.
  void evidenceRoot;
  const limit = Math.max(1, Math.min(25, Number.isFinite(query.limit) ? Math.floor(query.limit!) : 10));
  const recent = new Date(now.getTime() - RECENT_MS).toISOString();
  const result: AssignmentCatchUp = { version: 1, asOf: now.toISOString(), readOnly: true, assignments: [], projects: [],
    omissions: { assignments: 0, decisions: 0, projects: 0, textFields: 0, candidateScanLimited: false, notes: [
      "Completed assignments are included for seven days. Up to three decisions and attention messages per assignment are shown. This is not a complete history; use assignment show before acting.",
      "Knowledge is stored context, not verified current repository instructions or permission. Checkout identity and source freshness were not revalidated; reference text and conversation history are omitted.",
      "Status is recorded database metadata. Saved artifact/check availability was not read, and process exits were not inspected. Use assignment show before acting on a result.",
    ] } };
  // A coordinator never gains installation-wide access from a missing ceiling.
  if (access.principal === "coordinator" && access.repos === null || query.repo !== undefined && access.repos !== null && !access.repos.includes(query.repo)) return result;
  const repos = query.repo === undefined ? access.repos : [query.repo];
  const includeUnplaced = query.repo === undefined && access.principal === "operator" && access.includeUnplaced === true;
  const scopedAccess: AssignmentAccess = access.principal === "operator" ? { principal: "operator", repos, includeUnplaced } : { principal: "coordinator", repos: repos ?? [] };
  const text = (value: string, cap: number) => {
    const rendered = publicChatText(value, cap);
    if (rendered !== value) result.omissions.textFields++;
    return rendered;
  };
  const fits = () => Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES - 512;
  return store.savepoint(() => {
    const cap = Math.min(50, limit * 3);
    const page = workIndexPage(store, now, scopedAccess, { view: "all", limit: cap + 1 });
    result.omissions.candidateScanLimited = page.nextCursor !== null || page.items.length > cap;
    const ranked = page.items.slice(0, cap).filter(item =>
      !(item.assignmentState === "complete" || item.assignmentState === "cancelled") || item.updatedAt >= recent,
    ).sort((a, b) => {
      const priority = (state: AssignmentSnapshot["state"]) => state === "needs-decision" ? 0 : state === "ready-to-check" ? 1 : state === "complete" || state === "cancelled" ? 3 : 2;
      return priority(a.assignmentState) - priority(b.assignmentState) || b.updatedAt.localeCompare(a.updatedAt) || a.rootId.localeCompare(b.rootId);
    });
    for (const item of ranked) {
      if (result.assignments.length >= limit) { result.omissions.assignments++; continue; }
      // Read only the chosen rows. No family hydration, artifact bytes, native
      // process census, or repository probing belongs in a catch-up summary.
      const goal = store.handle.prepare('SELECT substr(goal,1,1601) AS goal FROM task_scope WHERE task_id=?').get(item.activeTaskId)?.["goal"];
      const saved = item.resultRunId === null ? undefined : store.handle.prepare(`SELECT substr(r.handoff,1,1601) AS handoff
        FROM run r JOIN task_ref t ON t.id=r.task_ref
        WHERE r.id=? AND t.backend='built-in' AND t.external_id=? AND t.repo IS ?`)
        .get(item.resultRunId, item.resultTaskId, item.repo);
      const decisions = store.handle.prepare(`WITH RECURSIVE family(id,external_id,depth) AS (
          SELECT id,external_id,0 FROM task_ref WHERE backend='built-in' AND external_id=? AND repo IS ?
          UNION ALL SELECT t.id,t.external_id,f.depth+1 FROM task_ref t JOIN family f ON t.revision_of=f.external_id
          JOIN artifact a ON a.id=t.revision_brief_artifact AND a.kind='revision-brief'
          JOIN run source ON source.id=a.run AND source.task_ref=f.id
          WHERE t.backend='built-in' AND t.repo IS ? AND f.depth<63
        ) SELECT d.id,d.run,substr(d.question,1,961) AS question,d.state,d.deadline,substr(d.choice,1,321) AS choice,COUNT(*) OVER() AS total
          FROM decision d JOIN run r ON r.id=d.run WHERE r.task_ref IN (SELECT id FROM family)
          ORDER BY (d.answered_at IS NULL) DESC,d.id DESC LIMIT 3`).all(item.rootId, item.repo, item.repo);
      const count = Number(decisions[0]?.["total"] ?? 0);
      const attention = [item.familyProblem,
        item.earlierActiveCount > 0 ? `${item.earlierActiveCount} earlier version${item.earlierActiveCount === 1 ? " has" : "s have"} unfinished work.` : null,
      ].filter((one): one is string => one !== null);
      const entry: AssignmentCatchUp["assignments"][number] = {
        rootId: item.rootId, taskId: item.activeTaskId, repo: item.repo, title: text(item.title, 120), state: item.assignmentState,
        detail: text(item.status.detail, 240), goal: goal == null ? null : text(String(goal), 400), updatedAt: item.updatedAt,
        runId: item.liveRunId ?? item.unfinishedRunId ?? item.resultRunId, resultRunId: item.resultRunId,
        outcome: saved?.["handoff"] == null ? null : text(String(saved["handoff"]), 400),
        checks: item.resultRunId === null ? null : { status: "not-read", exitCode: null, detail: "Saved checks were not revalidated. Use assignment show to inspect them." },
        nextAction: item.primaryAction, attention: attention.slice(0, 3).map(one => text(one, 160)),
        decisions: decisions.map(row => ({ id: Number(row["id"]), runId: Number(row["run"]), question: text(String(row["question"]), 240), state: String(row["state"]),
          overdue: row["state"] !== "answered" && row["deadline"] !== null && String(row["deadline"]) <= now.toISOString(), choice: row["choice"] == null ? null : text(String(row["choice"]), 80) })),
      };
      result.assignments.push(entry);
      if (!fits()) { result.assignments.pop(); result.omissions.assignments++; }
      else result.omissions.decisions += Math.max(0, count - decisions.length);
    }
    // Project knowledge is admitted in SQL before any payload or title read.
    const projectRows = store.handle.prepare(`SELECT repo FROM project_knowledge WHERE ? = 1 OR repo IN (SELECT value FROM json_each(?)) ORDER BY repo LIMIT 9`)
      .all(repos === null ? 1 : 0, JSON.stringify(repos ?? []));
    const projectCount = Number(store.handle.prepare('SELECT COUNT(*) AS n FROM project_knowledge WHERE ? = 1 OR repo IN (SELECT value FROM json_each(?))').get(repos === null ? 1 : 0, JSON.stringify(repos ?? []))?.["n"] ?? 0);
    result.omissions.projects = Math.max(0, projectCount - 8);
    for (const project of projectRows.slice(0, 8)) {
      const repo = String(project["repo"]);
      const knowledge: AssignmentCatchUp["projects"][number]["knowledge"] = { status: "unavailable", revision: null, identity: null, sha256: null, instructions: "", sources: [], decisions: [] };
      const row = store.handle.prepare('SELECT * FROM project_knowledge WHERE repo=?').get(repo)!;
      try {
        const payload = String(row["payload"]), revision = Number(row["revision"]), identity = String(row["identity"]);
        const history = store.handle.prepare('SELECT sha FROM knowledge_change WHERE repo=? AND identity=? AND revision=?').get(repo, identity, revision);
        if (Buffer.byteLength(payload) > 160_000 || !Number.isSafeInteger(revision) || revision < 1 || sha(payload) !== row["sha"] || history?.["sha"] !== row["sha"]) throw Error("invalid stored context");
        const saved = JSON.parse(payload);
        if (typeof saved.instructions !== "string" || !Array.isArray(saved.references) || saved.references.length > 12) throw Error("invalid stored context");
        const sources = saved.references.map((one: Record<string, unknown>) => {
          if (typeof one.id !== "string" || typeof one.title !== "string" || typeof one.content !== "string") throw Error("invalid stored source");
          const id = text(one.id, 80), path = typeof one.path === "string" ? text(one.path, 160) : null;
          return { id, title: text(one.title, 120), kind: path === null ? "saved-note" as const : "repository-document" as const, path,
            sourceRevision: typeof one.sourceRevision === "string" && /^[a-f0-9]{40,64}$/.test(one.sourceRevision) ? one.sourceRevision : null,
            sourceSha: typeof one.sourceSha === "string" && /^[a-f0-9]{40,64}$/.test(one.sourceSha) ? one.sourceSha : null };
        });
        Object.assign(knowledge, { status: "stored", revision, identity: /^[a-f0-9]{64}$/.test(identity) ? identity : null, sha256: String(row["sha"]), instructions: text(saved.instructions, 600), sources });
      } catch { /* Integrity failures are explicit; never replay an older version as current. */ }
      try { knowledge.decisions = store.handle.prepare("SELECT id,claim FROM project_decision WHERE repo=? AND status='active' ORDER BY id DESC LIMIT 8").all(repo).map(row => ({ id: Number(row["id"]), claim: text(String(row["claim"]), 160) })); } catch { /* memory absent on an older database reads as no decisions */ }
      result.projects.push({ repo, knowledge });
      if (!fits()) { result.projects.pop(); result.omissions.projects++; }
    }
    if (result.omissions.candidateScanLimited) result.omissions.notes.push("Candidate scanning was limited; omitted assignment counts are lower bounds, not a complete project total. Filter by project or read the task list for older work.");
    return result;
  });
}
