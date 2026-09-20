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

The active admitted lead checks the exact ready receipt; the signed-in user can
mark the same result complete without taking lead ownership. The receipt binds
task, run, base, candidate, scope, recorded judgments and artifact hashes. Every
read checks saved bytes. Changed scope, result, evidence or revision invalidates
completion. Revoked credentials cannot acknowledge work.

Full reads include the saved goal, plan and bounded changes/check excerpts with
artifact identities and explicit shortening. Finished builds reach Ready without
a separate reviewer, including strict work and failed checks. Check outcomes,
unmet criteria, historical reviews and accepted exceptions remain visible and
unchanged. Research exposes its saved report and any unavailable content. Failed attempts without
a candidate, unresolved questions, stops, holds, unknown processes still block handoff. Missing or changed saved bytes are
visible limitations; they do not require resubmission to mark work handled. Complete records handling, not success; it
never grants execution, acceptance, publication or deployment authority.

## Watching and revisions

The worker does not execute a separate model review or automatically retry it.
Existing signed review and repair settings stay recorded as history, not as an
instruction to resubmit finished work. Request a revision with concrete feedback
when changes are needed; its existing scope and execution approvals still apply.
Missing proof packaging alone does not trigger another agent turn.

The ordinary worker scans at most 50 owned roots per pass. Schema 70
`service_cursor` keeps the scan position across restart. It grants no authority
and adds no scheduler or automatic Codex-thread wakeup. A watcher reads updates,
opens the saved result, then acknowledges it or asks explicitly for a revision.
Publication is separate; merge never implies deployment.

## Release boundary

Historical preparation below records the previous release policy; current
handoff semantics above supersede its completion conditions.

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
