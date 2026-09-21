/** Paginated, permission-bound summaries of saved task facts. These reads do
 * not verify artifacts, inspect processes, or authorize task operations. */
import { createHash } from 'node:crypto';
import { readProjectAccess } from './project-access.js';
import { scopeTermsProblem, type Store, type TaskState } from './store.js';
import type { AssignmentSnapshot } from './assignment.js';
import type { WorkAction, WorkSummaryAccess } from './work-summary.js';
import type { WorkStatus, WorkView } from './workspace-ui.js';

export type WorkIndexCounts = Record<WorkView, number>;
export type WorkIndexItem = {
  rootId: string;
  activeTaskId: string;
  title: string;
  repo: string | null;
  state: TaskState;
  assignmentState: AssignmentSnapshot['state'];
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  earlierActiveCount: number;
  familyProblem: string | null;
  liveRunId: number | null;
  unfinishedRunId: number | null;
  resultRunId: number | null;
  resultTaskId: string | null;
  resultOutcome: string | null;
  publicationUrl: string | null;
  status: WorkStatus;
  primaryAction: WorkAction | null;
  completion: { actor: string; at: string; digest: string } | null;
  evidence: 'recorded';
};
export type WorkIndexOptions = { view?: WorkView; limit?: number; cursor?: string | null; project?: string | null; state?: TaskState; leadId?: string };
export type WorkIndexPage = { items: WorkIndexItem[]; totals: WorkIndexCounts; projects: WorkProjectCounts[]; nextCursor: string | null; limit: number; view: WorkView };
export type WorkProjectCounts = { repo: string | null; totals: WorkIndexCounts; queued: number; doneRecently: number };

export const WORK_INDEX_PAGE_LIMIT = 40;
export const WORK_INDEX_MAX_LIMIT = 100;

const EMPTY: WorkIndexCounts = { all: 0, 'needs-you': 0, running: 0, completed: 0 };
const FAMILY_PROBLEM = 'Task history is unavailable or incomplete. This task is shown separately.';
const VIEWS: readonly WorkView[] = ['all', 'needs-you', 'running', 'completed'];
type Row = Record<string, unknown>;
const n = (row: Row, key: string) => Number(row[key] ?? 0);
const s = (row: Row, key: string) => row[key] == null ? null : String(row[key]);

/** Keep the lineage predicates identical to Store.taskFamilyProjection: an
 * admitted child needs its parent's exact revision brief, in the same repo.
 * All subsequent reads are scalar/indexed metadata, never artifact bytes.
 * MATERIALIZED prevents counts + page selection repeating correlated reads. */
const PROJECTION = `WITH RECURSIVE admitted AS MATERIALIZED (
  SELECT t.id, t.title, t.state, t.created_at, t.updated_at, r.id ref_id, r.repo,
    r.revision_of, r.revision_brief_artifact, r.assigned_runner, r.plan,
    r.deliverable, r.coordinator_cid, r.capability_requirements, r.park_rate
  FROM task_ref r JOIN task t ON t.id = r.external_id
  WHERE r.backend = 'built-in' AND ((r.repo IS NULL AND $unplaced = 1)
    OR (r.repo IS NOT NULL AND ($all = 1 OR r.repo IN (SELECT value FROM json_each($repos)))))
    AND ($projectSet = 0 OR r.repo IS $project)
), lineage(ref_id,root_ref,depth) AS (
  SELECT ref_id,ref_id,0 FROM admitted WHERE revision_of IS NULL
  UNION ALL
  SELECT child.ref_id,l.root_ref,l.depth+1 FROM lineage l
  JOIN admitted parent ON parent.ref_id=l.ref_id
  JOIN admitted child ON child.revision_of=parent.id AND child.repo IS parent.repo
  JOIN artifact brief ON brief.id=child.revision_brief_artifact AND brief.kind='revision-brief'
  JOIN run source ON source.id=brief.run AND source.task_ref=parent.ref_id WHERE l.depth<63
), questions AS MATERIALIZED (
  SELECT r.task_ref,MAX(d.id) decision_id FROM decision d INDEXED BY work_open_decision
  JOIN run r ON r.id=d.run JOIN admitted a ON a.ref_id=r.task_ref
  WHERE d.state<>'answered' AND d.answered_at IS NULL GROUP BY r.task_ref
), custody AS MATERIALIZED (
  SELECT r.task_ref FROM held_session h JOIN run r ON r.id=h.run JOIN admitted a ON a.ref_id=r.task_ref WHERE h.ended_at IS NULL
  UNION
  SELECT r.task_ref FROM run r INDEXED BY work_spawned_run JOIN admitted a ON a.ref_id=r.task_ref
    WHERE r.provider_started_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM run_process p WHERE p.run=r.id)
  UNION
  SELECT r.task_ref FROM run_process p INDEXED BY work_unsettled_custody JOIN run r ON r.id=p.run JOIN admitted a ON a.ref_id=r.task_ref
    WHERE p.exited_at IS NULL AND p.container_empty_at IS NULL
), members AS MATERIALIZED (
  SELECT a.*,COALESCE(l.root_ref,a.ref_id) root_ref,l.ref_id IS NULL broken,
    (SELECT lease_id FROM claim WHERE task_ref=a.ref_id AND released_at IS NULL AND expires_at>$now
      AND lease_generation=(SELECT MAX(lease_generation) FROM claim WHERE task_ref=a.ref_id)) live_lease,
    (SELECT id FROM run WHERE task_ref=a.ref_id AND outcome IS NULL ORDER BY id DESC LIMIT 1) unfinished,
    CASE WHEN a.state='done' THEN (SELECT id FROM run WHERE task_ref=a.ref_id AND finished_at IS NOT NULL AND role IN ('builder','scout') ORDER BY id DESC LIMIT 1) END result_id,
    (SELECT h.id FROM hold h WHERE h.task_ref=a.ref_id AND (h.until IS NULL OR h.until>$now) ORDER BY h.held_at,h.id LIMIT 1) hold_id,
    q.decision_id,cu.task_ref IS NOT NULL custody_unresolved
  FROM admitted a LEFT JOIN lineage l ON l.ref_id=a.ref_id
  LEFT JOIN questions q ON q.task_ref=a.ref_id LEFT JOIN custody cu ON cu.task_ref=a.ref_id
), family_heads AS MATERIALIZED (
  SELECT root_ref,COUNT(*) version_count,MAX(updated_at) family_updated,
    CAST(substr(MAX((CASE WHEN ref_id=root_ref THEN '0' ELSE '1' END)||created_at||printf('%020d',ref_id)),-20) AS INTEGER) current_ref,
    SUM(state IN ('queued','running') OR live_lease IS NOT NULL OR unfinished IS NOT NULL OR custody_unresolved) active_count,
    MIN(CASE WHEN state IN ('queued','running') OR live_lease IS NOT NULL OR unfinished IS NOT NULL OR custody_unresolved THEN ref_id END) first_active,
    MAX(CASE WHEN state IN ('queued','running') OR live_lease IS NOT NULL OR unfinished IS NOT NULL OR custody_unresolved THEN ref_id END) last_active,
    MAX(live_lease IS NOT NULL) family_running,MIN(decision_id) question_id
  FROM members GROUP BY root_ref
), ordered AS MATERIALIZED (
  SELECT m.*,CASE WHEN m.ref_id=f.current_ref THEN 1 ELSE 2 END version_rank
  FROM members m JOIN family_heads f USING(root_ref)
), families AS MATERIALIZED (
  SELECT f.root_ref,f.version_count,f.family_updated,f.family_running,
    f.active_count-(c.state IN ('queued','running') OR c.live_lease IS NOT NULL OR c.unfinished IS NOT NULL OR c.custody_unresolved) earlier_active,
    earlier.id earlier_id,COALESCE(c.decision_id,f.question_id) question_id
  FROM family_heads f JOIN members c ON c.ref_id=f.current_ref
  LEFT JOIN admitted earlier ON earlier.ref_id=CASE WHEN f.first_active=f.current_ref THEN f.last_active ELSE f.first_active END
), workers AS MATERIALIZED (
  SELECT r.name,r.capacity,r.heartbeat_at,j.value repo,
    (SELECT COUNT(*) FROM claim c WHERE c.runner=r.name AND c.released_at IS NULL AND c.expires_at>$now
      AND c.lease_generation=(SELECT MAX(newest.lease_generation) FROM claim newest WHERE newest.task_ref=c.task_ref)
      AND c.lease_id NOT IN (SELECT lease_id FROM held_session WHERE ended_at IS NULL)) occupied
  FROM runner r,json_each(CASE WHEN json_valid(r.repos) THEN r.repos ELSE '[]' END) j WHERE r.retired_at IS NULL
), facts AS MATERIALIZED (
  SELECT c.*,f.version_count,f.family_updated,f.earlier_active,f.earlier_id,f.family_running,f.question_id,
    root.id root_id,root.title root_title,
    result.role result_role,result.outcome result_outcome,result.head_revision,result.scope_digest,result.finished_at,
    (SELECT id FROM run WHERE task_ref=c.ref_id AND lease_id=c.live_lease AND outcome IS NULL ORDER BY id DESC LIMIT 1) live_run,
    h.owner_kind hold_kind,h.reason hold_reason,h.until hold_until,
    sc.task_id scope_id,sc.digest,sc.approved_at,sc.proposed_at,sc.profile_state,
    (sc.approved_at IS NOT NULL AND sc.approved_by IS NOT NULL AND sc.approved_digest=sc.digest) approved,
    (sc.approval_basis IS NOT 'mode' OR EXISTS(SELECT 1 FROM operating_mode om JOIN approver signer ON signer.name=om.signed_by
      WHERE om.repo=c.repo AND om.digest=sc.mode_digest AND om.revoked_at IS NULL AND om.absolute_expiry>$now
      AND signer.role='approver' AND signer.revoked_at IS NULL)) dispatch_approval,
    CASE WHEN sc.task_id IS NULL THEN 0 ELSE so_work_scope_valid(json_object(
      'touches',sc.touches,'acceptance_json',sc.acceptance_json,'budget_microusd',sc.budget_microusd,
      'goal',CASE WHEN typeof(sc.goal)='text' THEN '' ELSE sc.goal END,
      'out_of_scope',CASE WHEN typeof(sc.out_of_scope)='text' THEN '' ELSE sc.out_of_scope END,
      'quality_mode',sc.quality_mode,'risk_level',sc.risk_level,'approval_kind',sc.approval_kind,
      'profile_state',sc.profile_state,'digest_version',sc.digest_version,'proposed_via',sc.proposed_via,'route_era',sc.route_era,
      'digest',sc.digest,'proposed_at',sc.proposed_at,'approved_at',sc.approved_at,'approved_by',sc.approved_by,'approved_digest',sc.approved_digest,
      'profile_json',CASE WHEN typeof(sc.profile_json)='text' THEN '' ELSE sc.profile_json END,
      'approved_profile_json',CASE WHEN typeof(sc.approved_profile_json)='text' THEN '' ELSE sc.approved_profile_json END,
      'proposed_chain_json',CASE WHEN typeof(sc.proposed_chain_json)='text' THEN '' ELSE sc.proposed_chain_json END,
      'approved_chain_json',CASE WHEN typeof(sc.approved_chain_json)='text' THEN '' ELSE sc.approved_chain_json END,
      'proposed_route_json',CASE WHEN typeof(sc.proposed_route_json)='text' THEN '' ELSE sc.proposed_route_json END,
      'approved_route_json',CASE WHEN typeof(sc.approved_route_json)='text' THEN '' ELSE sc.approved_route_json END,
      'unresolved_reason',CASE WHEN typeof(sc.unresolved_reason)='text' THEN '' ELSE sc.unresolved_reason END)) END scope_valid,
    (SELECT CASE WHEN EXISTS(SELECT 1 FROM admitted visible WHERE visible.id=blocker.id) THEN blocker.id END FROM task_edge e JOIN task blocker ON blocker.id=e.blocker WHERE e.blocked=c.id AND blocker.state<>'done'
      ORDER BY (blocker.state IN ('failed','cancelled')) DESC,blocker.id LIMIT 1) dependency_id,
    (SELECT blocker.state FROM task_edge e JOIN task blocker ON blocker.id=e.blocker WHERE e.blocked=c.id AND blocker.state<>'done'
      ORDER BY (blocker.state IN ('failed','cancelled')) DESC,blocker.id LIMIT 1) dependency_state,
    (SELECT COUNT(*) FROM workers w WHERE w.repo=c.repo AND (c.assigned_runner IS NULL OR w.name=c.assigned_runner)) worker_count,
    (SELECT COUNT(*) FROM workers w WHERE w.repo=c.repo AND (c.assigned_runner IS NULL OR w.name=c.assigned_runner) AND w.heartbeat_at>$alive) online_count,
    (SELECT COUNT(*) FROM workers w WHERE w.repo=c.repo AND (c.assigned_runner IS NULL OR w.name=c.assigned_runner) AND w.heartbeat_at>$alive AND w.occupied<w.capacity) available_count,
    CASE WHEN NOT json_valid(c.capability_requirements) THEN 1 ELSE EXISTS(
      SELECT 1 FROM json_each(c.capability_requirements) req WHERE req.type<>'text' OR instr(req.value,':')<2
        OR NOT EXISTS(SELECT 1 FROM capability cap WHERE cap.repo=c.repo AND cap.kind=substr(req.value,1,instr(req.value,':')-1)
          AND cap.name=substr(req.value,instr(req.value,':')+1) AND cap.status='verified' AND (cap.expires_at IS NULL OR cap.expires_at>$now))) END capability_gap,
    (SELECT run FROM run_stop WHERE task_ref=c.ref_id AND resumed_at IS NULL ORDER BY requested_at DESC LIMIT 1) stop_run,
    (SELECT settled_at FROM run_stop WHERE task_ref=c.ref_id AND resumed_at IS NULL ORDER BY requested_at DESC LIMIT 1) stop_settled,
    COALESCE((SELECT substr(actor,13) FROM action_ledger WHERE task_id=root.id AND action='assignment claimed' AND source='work' ORDER BY id DESC LIMIT 1),root.coordinator_cid) owner_id,
    pub.pr_url publication_url
  FROM ordered c JOIN families f USING(root_ref) JOIN admitted root ON root.ref_id=c.root_ref
  LEFT JOIN run result INDEXED BY work_result ON result.task_ref=c.ref_id AND result.id=c.result_id
    AND result.finished_at IS NOT NULL AND result.role IN ('builder','scout') LEFT JOIN hold h ON h.id=c.hold_id
  LEFT JOIN task_scope sc ON sc.task_id=c.id LEFT JOIN publication pub ON pub.run=c.result_id
  WHERE c.version_rank=1
), ready AS MATERIALIZED (
  SELECT f.*,state='done' AND broken=0 AND earlier_active=0 AND unfinished IS NULL AND live_lease IS NULL
    AND question_id IS NULL AND hold_id IS NULL AND stop_run IS NULL AND custody_unresolved=0 AND scope_valid AND approved
    AND digest=scope_digest AND ((result_role='scout' AND result_outcome='built') OR
      (result_role='builder' AND result_outcome IN ('built','no-change') AND length(head_revision)=40 AND head_revision NOT GLOB '*[^a-f0-9]*')) ready
  FROM facts f
), completion_families AS MATERIALIZED (
  SELECT root_ref FROM ready f WHERE f.ready AND EXISTS(SELECT 1 FROM action_ledger a
    WHERE a.task_id=f.root_id AND a.run_id=f.result_id AND a.action='assignment handoff checked' AND a.source='work')
), completion_metadata AS MATERIALIZED (
  SELECT m.root_ref,MAX((SELECT MAX(a.id) FROM action_ledger a WHERE a.task_id=m.id
    AND a.action IN ('task state changed','scope approved','task placed','run started','run finished'))) changed_id,
    MAX((SELECT MAX(ar.created_at) FROM run r JOIN artifact ar ON ar.run=r.id WHERE r.task_ref=m.ref_id)) artifact_at
  FROM completion_families f JOIN ordered m ON m.root_ref=f.root_ref GROUP BY m.root_ref
), checked AS MATERIALIZED (
  SELECT f.*,(SELECT a.id FROM action_ledger a WHERE f.ready AND a.task_id=f.root_id AND a.run_id=f.result_id
    AND a.action='assignment handoff checked' AND a.source='work' AND a.repo IS f.repo
    AND length(a.outcome)=64 AND a.outcome NOT GLOB '*[^a-f0-9]*'
    AND a.at>=f.family_updated AND a.at>=f.finished_at AND a.at>=f.approved_at AND a.at>=f.proposed_at
    AND (a.actor GLOB 'operator:?*' OR a.actor GLOB 'coordinator:?*' OR a.actor GLOB 'lead:?*')
    AND (cm.changed_id IS NULL OR a.id>=cm.changed_id) AND (cm.artifact_at IS NULL OR a.at>=cm.artifact_at)
    AND NOT EXISTS(SELECT 1 FROM proof_verdict p WHERE p.run=f.result_id AND p.decided_at>a.at)
    AND NOT EXISTS(SELECT 1 FROM proof_acceptance p WHERE p.run=f.result_id AND p.accepted_at>a.at)
    ORDER BY a.id DESC LIMIT 1) checked_id
  FROM ready f LEFT JOIN completion_metadata cm ON cm.root_ref=f.root_ref
), classified AS MATERIALIZED (
  SELECT f.*,CASE
    WHEN broken THEN 'history-problem'
    WHEN state='cancelled' THEN 'cancelled'
    WHEN earlier_active>0 AND state='done' THEN 'earlier-active'
    WHEN stop_run IS NOT NULL THEN CASE WHEN stop_settled IS NULL THEN 'stopping' ELSE 'stopped' END
    WHEN ready THEN CASE WHEN checked_id IS NULL THEN 'ready-to-check' ELSE 'complete' END
    WHEN state='done' AND question_id IS NOT NULL AND hold_id IS NULL THEN 'waiting-decision'
    WHEN state='done' THEN 'result-needs-attention'
    WHEN custody_unresolved AND live_lease IS NULL THEN 'process-needs-attention'
    WHEN state='failed' THEN 'failed'
    WHEN live_lease IS NOT NULL THEN CASE WHEN question_id IS NOT NULL THEN 'waiting-decision' ELSE 'running' END
    WHEN state='running' OR unfinished IS NOT NULL THEN 'vanished-run'
    WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name GLOB 'so_desktop_update_*') THEN 'updating'
    WHEN hold_kind='backoff' THEN 'retry-scheduled'
    WHEN hold_kind='decision' THEN 'waiting-decision'
    WHEN hold_kind='incident' THEN 'waiting-incident'
    WHEN hold_kind='stop' THEN 'stopped'
    WHEN hold_id IS NOT NULL THEN 'held'
    WHEN dependency_state IN ('failed','cancelled') THEN 'terminal-dependency'
    WHEN dependency_state IS NOT NULL THEN 'waiting-dependency'
    WHEN repo IS NULL THEN 'needs-project'
    WHEN plan IS NOT 'requested' AND scope_id IS NULL THEN 'needs-scope'
    WHEN scope_id IS NOT NULL AND NOT scope_valid THEN 'invalid-scope'
    WHEN (plan IS NOT 'requested' OR COALESCE(approved AND dispatch_approval,0)) AND profile_state='unresolved' THEN 'needs-agent-profile'
    WHEN (plan IS NOT 'requested' OR COALESCE(approved AND dispatch_approval,0)) AND (NOT approved OR NOT dispatch_approval) THEN 'needs-approval'
    WHEN capability_gap THEN 'missing-requirement'
    WHEN question_id IS NOT NULL THEN 'waiting-decision'
    WHEN worker_count=0 THEN 'no-worker-registered'
    WHEN online_count=0 THEN 'no-worker-online'
    WHEN available_count=0 THEN 'worker-at-capacity'
    WHEN (plan='requested' OR park_rate>0) AND (SELECT COUNT(*) FROM decision WHERE state<>'answered' AND answered_at IS NULL)>=5 THEN 'decision-queue'
    WHEN plan='requested' AND NOT COALESCE(approved AND dispatch_approval,0) THEN 'planning-ready'
    WHEN deliverable='report' THEN 'scouting-ready'
    ELSE 'queued' END code
  FROM checked f
), ranked AS MATERIALIZED (
  SELECT c.*,code NOT IN ('cancelled','complete','running','updating','retry-scheduled','waiting-dependency','worker-at-capacity','planning-ready','scouting-ready','queued') needs,
    CASE WHEN code='complete' THEN 3 WHEN code='cancelled' THEN 4 WHEN code='running' THEN 1
      WHEN code IN ('updating','retry-scheduled','waiting-dependency','worker-at-capacity','planning-ready','scouting-ready','queued') THEN 2 ELSE 0 END rank,
    CASE WHEN code='complete' THEN completed.at ELSE family_updated END sort_at,
    completed.actor checked_actor,completed.at checked_at,completed.outcome checked_digest
  FROM classified c LEFT JOIN action_ledger completed ON completed.id=c.checked_id WHERE ($state IS NULL OR c.state=$state) AND ($leadId IS NULL OR EXISTS(SELECT 1 FROM team_task_owner own WHERE own.task_ref=c.root_ref AND own.lead=$leadId))
)`;

const registered = new WeakMap<object, string>();
/** Connection-local pure parsing, with exactly the authoritative stored-scope
 * validator. The callback cannot query, inspect files or grant authority. */
function registerValidators(store: Store): string {
  const db = store.handle as Store['handle'] & { function(name: string, options: { deterministic: boolean }, callback: (...values: unknown[]) => number): void };
  const cached = registered.get(db);
  if (cached !== undefined) return cached;
  if (typeof db.function !== 'function') throw new Error('Work summaries require the native SQLite scalar-function API.');
  db.function('so_work_scope_valid', { deterministic: true }, value => {
    try { return scopeTermsProblem(JSON.parse(String(value)) as Row) === null ? 1 : 0; } catch { return 0; }
  });
  db.function('so_work_operator_access', { deterministic: true }, (raw, repo) => {
    const projects = readProjectAccess(raw);
    return projects === null || (typeof repo === 'string' && projects.includes(repo)) ? 1 : 0;
  });
  // Same-schema non-migrating readers may predate these optional indexes.
  // Discover once per connection; never initialize/migrate on a list read.
  const available = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='index'
    AND name IN ('work_open_decision','work_spawned_run','work_unsettled_custody','work_result')`)
    .all().map(row => String(row['name'])));
  const projection = available.size === 4 ? PROJECTION : PROJECTION.replace(
    / INDEXED BY (work_open_decision|work_spawned_run|work_unsettled_custody|work_result)\b/g,
    (hint, name: string) => available.has(name) ? hint : '');
  registered.set(db, projection);
  return projection;
}

function parameters(now: Date, access: WorkSummaryAccess, options: WorkIndexOptions) {
  return { $now: now.toISOString(), $alive: new Date(now.getTime() - 180_000).toISOString(),
    $all: access.repos === null ? 1 : 0, $repos: JSON.stringify(access.repos ?? []),
    $unplaced: access.principal === 'operator' && access.includeUnplaced === true ? 1 : 0,
    $projectSet: options.project != null ? 1 : 0, $project: options.project ?? null, $state: options.state ?? null, $leadId: options.leadId ?? null };
}
function counts(row: Row): WorkIndexCounts {
  return { all: n(row, 'all_count'), 'needs-you': n(row, 'needs_count'), running: n(row, 'running_count'), completed: n(row, 'completed_count') };
}
const TOTALS = `COUNT(*) all_count,COALESCE(SUM(needs),0) needs_count,COALESCE(SUM(family_running),0) running_count,COALESCE(SUM(code='complete'),0) completed_count`;

export class WorkIndexCursorError extends Error {
  constructor() { super('This work page cursor is invalid or belongs to a different view.'); this.name = 'WorkIndexCursorError'; }
}

type Cursor = { version: 1; scope: string; rank: number; at: string; root: number };
function cursorScope(access: WorkSummaryAccess, options: WorkIndexOptions, view: WorkView): string {
  return createHash('sha256').update(JSON.stringify({ principal: access.principal,
    repos: access.repos === null ? null : [...new Set(access.repos)].sort(),
    unplaced: access.principal === 'operator' && access.includeUnplaced === true,
    leadId: options.leadId ?? null, project: options.project ?? null, state: options.state ?? null, view })).digest('hex');
}
function readCursor(value: string | null | undefined, scope: string): Cursor | null {
  if (value == null) return null;
  try {
    if (value.length > 1024 || !/^[\w-]+$/.test(value)) throw Error();
    const c = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (c.version !== 1 || c.scope !== scope || !Number.isSafeInteger(c.rank) || c.rank < 0 || c.rank > 4 ||
      !Number.isSafeInteger(c.root) || c.root < 1 || typeof c.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.at)) throw Error();
    return c;
  } catch { throw new WorkIndexCursorError(); }
}

/** A single SQLite statement gives rows and exact totals one read snapshot.
 * Completion is a recorded acknowledgment of the latest run/scope/family by
 * its current lead or an admitted approver, invalidated by newer source facts.
 * Its historical receipt hash also binds disk state, which is deliberately
 * rechecked only on opening/acting. This query grants no completion authority.
 * Project counters share the page's admitted project/state filter.
 * Cursors bind the admitted scope, project and view, never broaden access. */
export function workIndexPage(store: Store, now: Date, access: WorkSummaryAccess, options: WorkIndexOptions = {}): WorkIndexPage {
  const projection = registerValidators(store);
  const view = VIEWS.includes(options.view ?? 'all') ? options.view ?? 'all' : 'all';
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(WORK_INDEX_MAX_LIMIT, Math.floor(options.limit!))) : WORK_INDEX_PAGE_LIMIT;
  const scope = cursorScope(access, options, view), cursor = readCursor(options.cursor, scope);
  const filter = view === 'needs-you' ? 'needs=1' : view === 'running' ? 'family_running=1' : view === 'completed' ? "code='complete'" : '1';
  const rows = store.handle.prepare(`${projection}, selected_page AS MATERIALIZED (
    SELECT * FROM ranked WHERE ${filter} AND ($cursorRoot=0 OR rank>$cursorRank OR
      (rank=$cursorRank AND (sort_at<$cursorAt OR (sort_at=$cursorAt AND root_ref<$cursorRoot))))
    ORDER BY rank,sort_at DESC,root_ref DESC LIMIT $limit
  ), page AS (SELECT p.*,COALESCE(p.result_id,(SELECT id FROM run WHERE task_ref=p.ref_id AND finished_at IS NOT NULL AND role IN ('builder','scout') ORDER BY id DESC LIMIT 1)) page_result_id FROM selected_page p), totals AS (SELECT ${TOTALS} FROM ranked), project_totals AS (
    SELECT repo,${TOTALS},SUM(state='queued' AND family_running=0) queued,
      SUM(state='done' AND family_running=0 AND updated_at>=$recent) done_recently FROM ranked GROUP BY repo
  )
  SELECT 0 record_kind,totals.*,(SELECT json_group_array(json_object('repo',repo,'all_count',all_count,'needs_count',needs_count,
    'running_count',running_count,'completed_count',completed_count,'queued',queued,'done_recently',done_recently)) FROM project_totals) row_json FROM totals
  UNION ALL SELECT 1,0,0,0,0,json_object('root_ref',root_ref,'root_id',root_id,'id',id,'root_title',root_title,'repo',repo,
    'state',state,'created_at',created_at,'family_updated',family_updated,'version_count',version_count,'earlier_active',earlier_active,
    'earlier_id',earlier_id,'broken',broken,'live_run',live_run,'result_id',page_result_id,'result_outcome',(SELECT outcome FROM run WHERE id=page_result_id),
    'publication_url',(SELECT pr_url FROM publication WHERE run=page_result_id),'code',code,'needs',needs,'family_running',family_running,'rank',rank,'sort_at',sort_at,
    'checked_actor',checked_actor,'checked_at',checked_at,'checked_digest',checked_digest,'question_id',question_id,
    'dependency_id',dependency_id,'dependency_state',dependency_state,'custody_unresolved',custody_unresolved,'hold_kind',hold_kind,'hold_reason',substr(hold_reason,1,300),'stop_run',stop_run,'unfinished',unfinished,
    'question_run',(SELECT run FROM decision WHERE id=page.question_id),
    'question_task',(SELECT r.external_id FROM decision d JOIN run ON run.id=d.run JOIN task_ref r ON r.id=run.task_ref WHERE d.id=page.question_id)) FROM page`)
    .all({ ...parameters(now, access, options), $cursorRoot: cursor?.root ?? 0, $cursorRank: cursor?.rank ?? 0, $cursorAt: cursor?.at ?? '', $limit: limit + 1, $recent: new Date(now.getTime()-86_400_000).toISOString() });
  const selected = rows.slice(1).map(row => JSON.parse(String(row['row_json'])) as Row);
  const page = selected.slice(0, limit), last = page.at(-1);
  const nextCursor = selected.length > limit && last !== undefined ? Buffer.from(JSON.stringify({ version: 1, scope,
    rank: n(last, 'rank'), at: s(last, 'sort_at'), root: n(last, 'root_ref') })).toString('base64url') : null;
  const projects = (JSON.parse(String(rows[0]?.['row_json'] ?? '[]')) as Row[]).map(row => ({ repo: s(row, 'repo'), totals: counts(row), queued: n(row, 'queued'), doneRecently: n(row, 'done_recently') }));
  return { items: page.map(row => itemOf(row, access.principal)), projects, totals: rows[0] === undefined ? { ...EMPTY } : counts(rows[0]), nextCursor, limit, view };
}

export function workCountsByProject(store: Store, now: Date, access: WorkSummaryAccess): WorkProjectCounts[] {
  const projection = registerValidators(store);
  return store.handle.prepare(`${projection} SELECT repo,${TOTALS},SUM(state='queued' AND family_running=0) queued,
    SUM(state='done' AND family_running=0 AND updated_at>=$recent) done_recently FROM ranked GROUP BY repo ORDER BY repo`)
    .all({ ...parameters(now, access, {}), $recent: new Date(now.getTime()-86_400_000).toISOString() })
    .map(row => ({ repo: s(row, 'repo'), totals: counts(row), queued: n(row, 'queued'), doneRecently: n(row, 'done_recently') }));
}

/** Labels stay navigation, never an authorization to mutate. Full task
 * opening re-proves process custody, receipt bytes and approval terms. */
function itemOf(row: Row, principal: WorkSummaryAccess['principal']): WorkIndexItem {
  const code = String(row['code']), id = String(row['id']);
  const need = n(row, 'needs') === 1, running = n(row, 'family_running') === 1;
  const assignmentState: AssignmentSnapshot['state'] = code === 'complete' ? 'complete' : code === 'ready-to-check' ? 'ready-to-check'
    : code === 'cancelled' ? 'cancelled' : need ? 'needs-decision' : 'working';
  const words: Record<string, [string, string, WorkAction['code'] | null, string]> = {
    'history-problem': ['Needs your decision', FAMILY_PROBLEM, 'inspect-task', 'Review task history'],
    'earlier-active': ['Needs your decision', 'Earlier work is still active. Resolve it before completing this assignment.', 'inspect-task', 'Review active work'],
    'ready-to-check': ['Ready', 'The saved result is ready to review.', 'open-result', 'Open result'],
    complete: ['Complete', 'Completion is recorded for this result. Open it to inspect the saved evidence.', 'open-result', 'Open result'],
    cancelled: ['Cancelled', 'This assignment was cancelled.', 'inspect-task', 'View assignment'],
    running: ['Running now', 'A worker owns a current live claim.', null, ''],
    'waiting-decision': ['Needs your decision', 'An unanswered question is waiting.', n(row, 'question_id') ? 'answer-decision' : 'inspect-decisions', 'Answer question'],
    'decision-queue': ['Needs your decision', 'The decision queue is full.', 'inspect-decisions', 'Review open questions'],
    'result-needs-attention': ['Needs your decision', 'Inspect the saved result and resolve its remaining execution or scope issue.', 'inspect-run', 'Inspect run'],
    'process-needs-attention': ['Needs your decision', 'A process exit is not recorded. Open the attempt to check whether its work has stopped.', 'inspect-run', 'Inspect run'],
    failed: ['Needs your decision', 'The last attempt stopped; review its incident before retrying.', 'retry-task', 'Review and retry'],
    'vanished-run': ['Needs your decision', 'An unfinished attempt has no current live claim.', 'reconcile-run', 'Check the unfinished attempt'],
    stopping: ['Needs your decision', 'The stop is waiting for recorded settlement.', 'inspect-stop', 'View stop details'],
    stopped: ['Needs your decision', 'The stopped attempt is preserved.', 'resume-run', 'Review pause'],
    held: ['Needs your decision', s(row, 'hold_reason') ?? 'This task is on hold.', s(row, 'hold_kind') === 'operator' ? 'unhold' : 'inspect-hold', 'Review hold'],
    'waiting-incident': ['Needs your decision', 'An unresolved incident holds the next attempt.', 'retry-task', 'Review and retry'],
    'terminal-dependency': ['Needs your decision', 'A required task did not finish.', 'repair-dependency', 'Review required task'],
    'waiting-dependency': ['Waiting for another task', 'A required task must finish before this task can start.', null, ''],
    'needs-project': ['Needs your decision', 'Choose a project for this task.', 'place-task', 'Choose a project'],
    'needs-scope': ['Needs your decision', 'Define the task before a worker can start.', 'write-scope', 'Define the task'],
    'invalid-scope': ['Needs your decision', 'The saved task scope cannot be read safely.', 'write-scope', 'Review scope'],
    'needs-agent-profile': ['Needs your decision', 'Choose an available agent for this task.', 'select-agent', 'Choose an agent'],
    'needs-approval': ['Needs your decision', 'Review the current plan before a worker can start.', 'approve-scope', 'Review plan'],
    'missing-requirement': ['Needs your decision', 'A required capability is missing or expired.', 'repair-capability', 'Review missing requirement'],
    'no-worker-registered': ['Needs your decision', 'No connected builder includes this project.', 'start-worker', 'Check connection'],
    'no-worker-online': ['Needs your decision', 'The builder has stopped checking in.', 'start-worker', 'Check connection'],
    'worker-at-capacity': ['Waiting for worker capacity', 'This task starts when an eligible worker has capacity.', null, ''],
    'retry-scheduled': ['Retry scheduled', 'The attempt is backing off before retrying.', null, ''],
    updating: ['Waiting for app update', 'New work resumes after the update.', null, ''],
    'planning-ready': ['Planner ready', 'A connected worker can draft the plan.', null, ''],
    'scouting-ready': ['Scout ready', 'A connected worker can produce the report.', null, ''],
    queued: ['Ready to run', 'A connected worker can claim this task.', null, ''],
  };
  let [label, detail, actionCode, actionLabel] = words[code]!;
  if (code === 'running' && n(row, 'version_count') > 1) label = 'Revising';
  if (code === 'terminal-dependency' && s(row, 'dependency_id') !== null) detail = `${s(row, 'dependency_id')} ${s(row, 'dependency_state') === 'cancelled' ? 'was cancelled' : 'failed'} before it finished.`;
  if (code === 'result-needs-attention' && n(row, 'custody_unresolved')) detail = 'A process exit is not recorded. Open the result to check whether its work has stopped.';
  if (code === 'result-needs-attention' && ['built', 'no-change'].includes(s(row, 'result_outcome') ?? '')) { actionCode = 'open-result'; actionLabel = 'Open result'; }
  if (actionCode === null) { actionCode = code === 'running' ? 'inspect-run' : 'inspect-task'; actionLabel = code === 'running' ? 'Watch the build' : 'View task details'; }
  const read = actionCode !== null && ['inspect-task', 'inspect-run', 'inspect-stop', 'inspect-decisions', 'open-result'].includes(actionCode);
  const primaryAction: WorkAction | null = actionCode === null ? null : { code: actionCode, label: actionLabel,
    target: { taskId: code === 'earlier-active' ? s(row, 'earlier_id') ?? id : actionCode === 'answer-decision' ? s(row, 'question_task') ?? id : id,
      runId: actionCode === 'answer-decision' ? n(row, 'question_run') || null : actionCode === 'inspect-run' && code === 'running' ? n(row, 'live_run') || null : actionCode === 'open-result' || actionCode === 'inspect-run' ? n(row, 'result_id') || null
        : actionCode === 'reconcile-run' ? n(row, 'unfinished') || null : ['resume-run', 'inspect-stop'].includes(actionCode) ? n(row, 'stop_run') || null : null,
      decisionId: actionCode === 'answer-decision' ? n(row, 'question_id') || null : null },
    access: read ? 'read' : principal === 'operator' ? 'operator-control' : ['answer-decision', 'write-scope', 'unhold'].includes(actionCode) ? 'proposal-only' : 'operator-handoff',
    retry: actionCode === 'reconcile-run' ? 'reconcile-before-retry' : read ? 'read-again' : 'refresh-before-acting' };
  const views: WorkView[] = ['all'];
  if (need) views.push('needs-you');
  if (running) views.push('running');
  if (code === 'complete') views.push('completed');
  return { rootId: String(row['root_id']), activeTaskId: id, title: String(row['root_title']), repo: s(row, 'repo'),
    state: String(row['state']) as TaskState, assignmentState, createdAt: String(row['created_at']), updatedAt: String(row['sort_at']),
    versionCount: n(row, 'version_count'), earlierActiveCount: n(row, 'earlier_active'), familyProblem: n(row, 'broken') ? FAMILY_PROBLEM : null,
    liveRunId: n(row, 'live_run') || null, unfinishedRunId: n(row, 'unfinished') || null, resultRunId: n(row, 'result_id') || null, resultTaskId: n(row, 'result_id') ? id : null,
    resultOutcome: s(row, 'result_outcome'), publicationUrl: s(row, 'publication_url'),
    status: { token: `assignment-${assignmentState}`, label, detail, tone: code === 'complete' ? 'done' : code === 'ready-to-check' ? 'ready' : need ? 'attention' : running ? 'live' : 'muted',
      action: primaryAction === null ? null : { label: actionLabel, kind: actionCode === 'open-result' ? 'open-result' : 'open-task' }, views, rank: n(row, 'rank') },
    primaryAction, completion: code === 'complete' ? { actor: String(row['checked_actor']), at: String(row['checked_at']), digest: String(row['checked_digest']) } : null,
    evidence: 'recorded' };
}
