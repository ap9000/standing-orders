# One assignment through completion

An assignment follows the existing root task and its revisions. The lead claims
that root once. Builders, independent reviewers and bounded repairs keep using
the existing queue, signed scope, spend limits and recorded attempts. A repair
changes the current execution, not the identity the lead follows.

The shared status is Working, Checking, Needs your decision, Ready to check,
Complete or Cancelled. Open questions, failed checks, process custody problems,
unapproved changes and active earlier attempts remain visible. A saved build
alone cannot become Complete. Historical result links still describe their exact
selected task and run.

## Lead workflow

Use an operator-minted, project-scoped coordinator credential. Keep its token in
a named environment variable or file; never put it in a prompt or command flag.

```sh
standing-orders assignment claim task-id --token-env SO_COORDINATOR --json
standing-orders assignment updates --after 0 --token-env SO_COORDINATOR --json
standing-orders assignment show task-id --token-env SO_COORDINATOR --json
standing-orders assignment check task-id --digest RECEIPT_DIGEST --token-env SO_COORDINATOR --json
```

Before independent review, commit current logs and reports as readable text in
the sealed review context. Compressed archives preserve history but cannot replace
current readable evidence; mirrors must match decoded hashes. Before dispatch,
preflight the whole candidate against the original task base. Compare every changed
source path’s `sourceGitBlob` with the exact native head’s
`REVIEW-CONTEXT.json` `identities[].blob`, including redacted items. Their
`items[].sha256` covers display text; raw `sourceSha256` is a Git preflight check.
Identity does not reveal redacted behavior or remove coverage limits.

Save `nextCursor` only after processing the returned page; repeat while `hasMore`
is true. Re-reading a page is safe. A notice can be superseded by newer work;
inspect the current brief and fetch the exact assignment before acting. Routine
updates contain a brief, not repeated full proofs. Polling is read-only and does
not deliver messages, clear decisions or acknowledge results. There is no new
long-lived subscription or automatic Codex-thread wakeup in this release.

MCP exposes the same operations as `claim_assignment`, `list_assignment_updates`,
`get_assignment` and `acknowledge_assignment`. Existing task reads in CLI, MCP and
chat carry the same compact assignment context. Chat links to existing approval
and result controls; ownership and acknowledgment are CLI/MCP operations.

The completion receipt names the exact task, run, base, candidate, scope, saved
criterion verdicts, artifact hashes and completion kind. Verified builds, research
reports and results already accepted by an operator remain distinct. The agent's saved report stays separate
from recorded checks. Full agent caveats remain in the referenced proof artifact.
The receipt projection describes recorded evidence. The check operation freshly
verifies saved artifact bytes. Verified builds require a passing machine-check
receipt and either builder proof or complete captured evidence independently
assessed against every approved criterion. Research reports require their
complete, readable report. Shortened test logs retain their explicit limitation;
the existing sealed gate still binds the retained bytes to the exact result.
An accepted exception keeps its existing operator acceptance and machine verdict
in the receipt. Checking a handoff cannot create or replace that acceptance.

Only the active lead can acknowledge the current ready receipt. A new revision,
changed result, changed scope or changed evidence record invalidates an earlier
acknowledgment. Revoking a lead's credential ends its ownership; another admitted
lead can claim the assignment. Acknowledgment grants no execution, scope approval,
failed-proof acceptance, publication or deployment authority. Complete means the
result has a matching lead acknowledgment for its recorded completion kind. A
research report or accepted exception never becomes a verified build by being
acknowledged. Publication is
reported separately; deployment is never inferred from a PR or merge.

## Internal correction policy

Existing `repairAuto` and its signed attempt cap govern code corrections. Existing
no-progress, integrity, scope, budget and run-count stops remain in force. An
expired or revoked mode does not silently renew itself.

The new `reviewRetryAuto` term is a separate explicit opt-in. It requires automatic
review and allows only eligible review-service failures to queue another attempt
through ordinary admission. Existing and preset modes default to false. Only actual provider exit, timeout
and initialization failures qualify. It never retries a completed verdict,
unknown ingestion/invocation failure, operator stop, missing evidence, integrity
failure, unsettled process or withdrawn authority. The existing limit is three root review
attempts in total. It retries on a later worker pass, never inside the failed call.

The existing settings ceremony shows the exact terms. The operator CLI can sign
`mode set ... --review-retry-auto` and can explicitly opt into code corrections
with `--repair-auto --repair-max-attempts 1|2|3`. A bare preset enables neither.
Implementation does not sign or change any installed operating mode.

## Durable status without another execution engine

Ownership and receipt acknowledgments are append-only action records. Result and
decision handoffs use the existing project-bound notification outbox, with stable
keys for root, lead and semantic handoff. Permission-specific action hints never
change the handoff identity. Reads cannot create notifications.

The existing worker pass reconciles at most 50 owned roots and 50 review-request
rows at a time. Schema 70 adds only `service_cursor`, operational scan positions
that advance transactionally with their work and survive process restart. They
grant no authority. A crash before commit repeats safely; a committed cursor
continues later work. This closes the case where repeatedly opening the database
could starve assignments beyond the first page.

## Release boundary

Start this corrective workflow from verified foundation
`82ae6aade7283b704b57f67a2abbd6538db5daaf` (builder 1920; reviewer 1921 upheld
all criteria), not failed workflow 1922/`3111152`. Prior attempts and complete
historical records remain preserved; no existing task base moves.

The 24 workflow files and UI remain identical to `96ccebe`; this correction adds
the missing assignment row in the envelope test. Inherited UI fixes remain intact.
Two images and seven browser checks retain their stated reuse and Chromium-only
limits: physical devices, software keyboards, screen readers and remote access
are unverified. Complete reports and the UI1907 canary remain readable.

Focused logs record their preparation inputs. Final execution is established by
the exact-candidate native `REVIEW-VERIFICATION.json` and `REVIEW-CHECK-LOG.txt`,
not historical logs. All eight criteria and the full check command stay unchanged.

This workflow is not yet verified. Preflight the complete committed package
against the original verified base before dispatch. Its own native gate,
independent review and matched UI/worker upgrade remain required.
