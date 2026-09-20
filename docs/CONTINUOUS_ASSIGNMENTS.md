# One assignment through completion

Claim the root once; its existing revisions and repairs remain internal attempts.
Earlier active attempts and unanswered questions remain visible; historical links
retain their exact task and run.

## Lead workflow

Use an operator-minted, project-scoped coordinator credential. Keep the token in
an environment variable, never a prompt or command argument:

```sh
standing-orders assignment claim task-id --token-env SO_COORDINATOR --json
standing-orders assignment updates --after 0 --token-env SO_COORDINATOR --json
standing-orders assignment show task-id --token-env SO_COORDINATOR --json
standing-orders assignment check task-id --digest RECEIPT_DIGEST --token-env SO_COORDINATOR --json
```

Process a page before saving its `nextCursor`; continue while `hasMore` is true.
Repeated reads are safe. A notice may be stale: inspect the current assignment
before acting. MCP offers claim_assignment, list_assignment_updates,
get_assignment and acknowledge_assignment. Reads execute nothing and clear no
pending decision. There is no automatic Codex-thread wakeup.

Only the active admitted lead can check the exact ready receipt. It binds task,
run, base, candidate, scope, recorded verdicts and artifact hashes. Every read and check
freshly verifies saved bytes; changed scope, result, evidence or revision
invalidates the acknowledgment. Revocation ends ownership.

Verified builds require the existing passing gate and bound proof or complete
direct-assessment evidence. Research reports require their complete saved report.
Accepted exceptions retain an existing operator acceptance; acknowledgment cannot
create it. These completion kinds stay distinct. Shortened check logs disclose
that only retained output exists. Questions, stops, holds and damaged evidence
block readiness. Complete grants no execution, approval, acceptance, publication
or deployment authority. Publication is separate; merge never implies deployment.

## Bounded corrections

Existing signed `repairAuto` attempt, spend, integrity and no-progress stops
remain. `reviewRetryAuto` is a separate explicit signed opt-in, requires
`reviewAuto`, and defaults false for legacy and preset modes. Only provider exit,
timeout or initialization failures qualify, within three total root review
attempts. Completed verdicts, unknown ingestion/invocation failures, operator
stops, holds, lost custody or withdrawn/expired authority never retry.

The existing worker scans at most 50 owned roots and 50 review rows per pass.
Schema 70 `service_cursor` records transactional scan positions across restart;
it grants no authority and adds no scheduler.

## Release boundary

Verified base 82ae6aa (1920/1921) stays fixed. Attempts 1931/1933, 1934/1935
and 1936/1937 remain preserved; their passing gates did not settle every review
criterion. Gate 1938 then failed one stale assertion: the Work row correctly said
Revising, not Working. This candidate fixes only that test expectation/comment;
its four focused status cases pass. The saved native log remains truncated as
captured, losslessly archived; neither 1938 nor its head is a verified base.

The release excludes queued/dependency-blocked work and waiting
reviews from Running, preserves precise shared status labels, and rechecks a
verified revision's inherited evidence before handoff. Damaged or missing
ancestor custody refuses acknowledgment; the own-run proof reader is explicit.

Fresh desktop and phone journeys on source f149d76 opened exact results 8/6,
inspected changes and created revisions with 486/493-character feedback. Their
approval terms stayed visible and unsigned. `journeys.json` retains source/build
hashes, observations, device limits and four inspected images. Older reports/logs
remain losslessly framed in `checks.txt.gz`; prior screenshots remain in b859 Git
history. They are historical, not evidence for this correction.

`checks.json` indexes complete readable preparation output. The earlier 59 focused
checks and verbose output remain archived. Current typecheck/four status tests
cover the assertion correction. Production/build inputs and the fresh browser
journeys are unchanged; no visual rerun was needed. Only native
REVIEW-VERIFICATION and
REVIEW-CHECK-LOG establish final execution. Compare sourceGitBlob to sealed
identities[].blob; display hashes may cover redacted text. Preflight the entire
committed candidate against 82ae6aa. No deployment or process recovery is claimed.
