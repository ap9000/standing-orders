# Fast task views and agent catch-up

The accepted plan is to keep navigation and catch-up cheap as projects and history grow, preserve saved work, and deploy the verified build to the UI, worker and CLI together. GitHub tag `backup/pre-performance-20260921` preserves the starting main commit `3575bb05c171651a33f75c68e2f4d3fbcd4ad973`. This change performs no database reset or repository deletion.

## Implemented behavior

- UI task lists and `task list` read the same permission-bound database projection, defaulting to 40 families per page (maximum 100). Exact counts include all admitted families. Project, view and state filters run before pagination. Cursors bind the access scope and selected filters.
- The Crew and agent catch-up use recorded database summaries. They do not read artifact files, hash worktrees, probe processes or invoke per-task dispatch/detail checks. Full details and consequential actions keep their existing authoritative checks.
- Recorded Ready and Complete describe saved result and handoff metadata. They do not certify current disk contents, successful checks, publication or deployment. Unresolved process witnesses remain visible as attention. Completion records are checked against current owner/approver access and newer family metadata; receipt bytes are not reread in a list.
- Eleven indexes and explicit materialization fix repeated family-query expansion. Pages reuse their count/crew projection within the request.
- Chat updates use a durable content revision with authenticated, bounded, short-lived ETags. Ordinary heartbeat noise is quiet; content changes and time-based expiry invalidate the view. Receipt/detail reads remain fresh. Idle polling backs off to 30 seconds, pauses while hidden/offline and resumes immediately on return or interaction.
- Status reconciliation commits one family and its delivery cursor at a time. Read-only coordinator operations use read snapshots. Deployment copies a consistent backup without holding a writer lock throughout the copy. Worktree adoption emits one bounded notice per batch while retaining the full inventory.
- Short list rows, exact counts, larger tap targets and a short task header keep the interface readable on a phone. Secondary history stays in task details.

The shared summary is advisory for dispatch readiness: executor quota and planner artifact admission still belong to the existing dispatch owner. Totals still require metadata work across admitted families; this is bounded output, not constant-time totals. No schema-version increase or duplicate lifecycle table is introduced. Older same-schema readers omit unavailable index hints without migrating or writing the database.

## Measurement

Run `node --import tsx scripts/benchmark-workspace.ts` for the isolated synthetic benchmark. It creates 100 real project directories, 10,000 tasks, 30,000 runs and 90,000 artifact metadata rows (about 189 MB), makes no provider calls and removes its temporary data. Missing artifact files are intentional: lists must not inspect them. Ready/Complete and permission edge cases are covered by focused tests separately.

The 12-sample measurements are in [benchmark.json](../evidence/scalable-task-views/benchmark.json). On this machine:

| Read | Median | p95 |
| --- | ---: | ---: |
| One-project task index | 21 ms | 32 ms |
| All-project task index | 280 ms | 546 ms |
| Agent catch-up | 320 ms | 367 ms |
| HTTP task workspace | 295 ms | 570 ms |
| HTTP fresh chat | 1,375 ms | 1,615 ms |
| HTTP unchanged chat | 4 ms | 8 ms |

Fresh chat previously measured about 27.4 seconds on the same large-history fixture before the family-query and projection reuse fixes. These are local synthetic timings, not internet/phone latency guarantees. The proposed sub-200 ms target is met for a selected project and unchanged refresh, but not for all-project reads at 10,000 tasks. Further work, if needed, should reduce repeated global aggregates in fresh chat; do not erase history to obtain a faster demo.

## Verification and delivery

The focused test log, source hashes, benchmark and inspected browser observations are linked from [checks.json](../evidence/scalable-task-views/checks.json). UI coverage includes desktop and phone feedback-to-revision journeys, pagination, long content, empty states, explicit failures and keyboard focus. Synthetic content is labeled. A physical phone/Safari test is not claimed.

The final native candidate must run the existing approved command unchanged: `npm run typecheck && npm test -- --run --reporter=dot && npm run build`. Its sealed runtime record, GitHub checks, normal backup/compatibility/health deployment and final UI/worker/CLI identity check establish release status; this document alone does not claim deployment. No model review, repair loop or automatic task resubmission is added.
