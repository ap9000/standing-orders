/** A bounded catch-up over saved project/task records, not conversation memory.
 * Callers authenticate first and pass their current project ceiling. */
import { createHash } from "node:crypto";
import { assignmentOf, type AssignmentAccess, type AssignmentSnapshot } from "./assignment.js";
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
    instructions: string; sources: { id: string; title: string; kind: "saved-note" | "repository-document"; path: string | null; sourceRevision: string | null; sourceSha: string | null }[];
  } }[];
  omissions: { assignments: number; decisions: number; projects: number; textFields: number; candidateScanLimited: boolean; notes: string[] };
};

/** A current snapshot, never a receipt to acknowledge. Full assignment reads
 * remain the place to inspect exact saved work and obtain its current digest. */
export function assignmentCatchUp(store: Store, now: Date, access: AssignmentAccess,
  query: { repo?: string; limit?: number } = {}, evidenceRoot?: string): AssignmentCatchUp {
  const limit = Math.max(1, Math.min(25, Number.isFinite(query.limit) ? Math.floor(query.limit!) : 10));
  const recent = new Date(now.getTime() - RECENT_MS).toISOString();
  const result: AssignmentCatchUp = { version: 1, asOf: now.toISOString(), readOnly: true, assignments: [], projects: [],
    omissions: { assignments: 0, decisions: 0, projects: 0, textFields: 0, candidateScanLimited: false, notes: [
      "Completed assignments are included for seven days. Up to three decisions and attention messages per assignment are shown. This is not a complete history; use assignment show before acting.",
      "Knowledge is stored context, not verified current repository instructions or permission. Checkout identity and source freshness were not revalidated; reference text and conversation history are omitted.",
      ...(evidenceRoot === undefined ? ["Saved artifact/check availability was not read. Open the assignment with its evidence root to confirm completion and current checks."] : []),
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
    const active = store.taskFamiliesAdmitted(repos, includeUnplaced, { states: ["queued", "running", "failed"], order: "updated", limit: cap + 1 });
    const finished = store.taskFamiliesAdmitted(repos, includeUnplaced, { states: ["done", "cancelled"], order: "updated", limit: cap + 1 });
    result.omissions.candidateScanLimited = active.length > cap || finished.length > cap;
    const families = new Map([...active.slice(0, cap), ...finished.slice(0, cap)].map(family => [family.root.id, family]));
    // An old result handled today is recent even when its task timestamp is old.
    const handled = store.handle.prepare(`SELECT DISTINCT t.external_id FROM action_ledger a
      JOIN task_ref t ON t.external_id = a.task_id AND t.backend = 'built-in'
      WHERE a.action = 'assignment handoff checked' AND a.source = 'work' AND a.at >= ?
        AND ((t.repo IS NULL AND ? = 1) OR (t.repo IS NOT NULL AND (? = 1 OR t.repo IN (SELECT value FROM json_each(?)))))
      ORDER BY a.at DESC,a.id DESC LIMIT ?`).all(recent, includeUnplaced ? 1 : 0, repos === null ? 1 : 0, JSON.stringify(repos ?? []), cap + 1);
    if (handled.length > cap) result.omissions.candidateScanLimited = true;
    for (const row of handled.slice(0, cap)) {
      const family = store.taskFamilyOf(String(row["external_id"]), repos, includeUnplaced);
      if (family) families.set(family.root.id, family);
    }
    const ranked = [...families.values()].flatMap(family => {
      const assignment = assignmentOf(store, family.root.id, now, scopedAccess, evidenceRoot);
      if (!assignment) return [];
      const updatedAt = assignment.completion?.at ?? family.current.updatedAt;
      if ((assignment.state === "complete" || assignment.state === "cancelled") && updatedAt < recent) return [];
      return [{ family, assignment, updatedAt }];
    }).sort((a, b) => {
      const priority = (state: AssignmentSnapshot["state"]) => state === "needs-decision" ? 0 : state === "ready-to-check" ? 1 : state === "complete" || state === "cancelled" ? 3 : 2;
      return priority(a.assignment.state) - priority(b.assignment.state) || b.updatedAt.localeCompare(a.updatedAt) || a.assignment.rootId.localeCompare(b.assignment.rootId);
    });
    for (const { family, assignment: a, updatedAt } of ranked) {
      if (result.assignments.length >= limit) { result.omissions.assignments++; continue; }
      const ids = JSON.stringify(family.versions.map(version => version.refId));
      const decisions = store.handle.prepare(`SELECT d.id,d.run,d.question,d.state,d.deadline,d.choice FROM decision d
        JOIN run r ON r.id = d.run WHERE r.task_ref IN (SELECT value FROM json_each(?))
        ORDER BY (d.answered_at IS NULL) DESC,d.id DESC LIMIT 3`).all(ids);
      const count = Number(store.handle.prepare('SELECT COUNT(*) AS n FROM decision d JOIN run r ON r.id=d.run WHERE r.task_ref IN (SELECT value FROM json_each(?))').get(ids)?.["n"] ?? 0);
      const artifactUnknown = (one: string) => evidenceRoot === undefined && /^Saved .* is unavailable or changed\.$/.test(one);
      const receipt = a.receipt;
      // An unfinished saved attempt may have lost its lease. Name it without
      // claiming a worker is alive; its shared state/action explains custody.
      const unfinished = store.runsFor(family.current.refId).find(run => run.outcome === null && run.role !== "reviewer");
      const entry: AssignmentCatchUp["assignments"][number] = {
        rootId: a.rootId, taskId: a.activeTaskId, repo: a.repo, title: text(a.title, 120), state: a.state,
        detail: text(a.detail, 240), goal: a.savedContext?.goal == null ? null : text(a.savedContext.goal, 400), updatedAt,
        runId: unfinished?.id ?? a.attempts.find(one => one.taskId === a.activeTaskId)?.runId ?? receipt?.runId ?? null, resultRunId: receipt?.runId ?? null, outcome: receipt?.agentReport == null ? null : text(receipt.agentReport, 400),
        checks: receipt === null ? null : evidenceRoot === undefined ? { status: "not-read", exitCode: null, detail: "Read the assignment to inspect saved checks." }
          : { status: receipt.checks.status, exitCode: receipt.checks.exitCode, detail: text(receipt.checks.detail, 200) },
        nextAction: a.primaryAction, attention: a.attention.filter(one => !artifactUnknown(one)).slice(0, 3).map(one => text(one, 160)),
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
      const knowledge: AssignmentCatchUp["projects"][number]["knowledge"] = { status: "unavailable", revision: null, identity: null, sha256: null, instructions: "", sources: [] };
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
      result.projects.push({ repo, knowledge });
      if (!fits()) { result.projects.pop(); result.omissions.projects++; }
    }
    if (result.omissions.candidateScanLimited) result.omissions.notes.push("Candidate scanning was limited; omitted assignment counts are lower bounds, not a complete project total. Filter by project or read the task list for older work.");
    return result;
  });
}
