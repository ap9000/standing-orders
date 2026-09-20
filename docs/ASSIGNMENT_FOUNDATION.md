# Assignment storage prerequisite

This prerequisite adds schema 70 and `service_cursor`, a durable key/value offset for bounded maintenance scans. Cursor writes validate nonnegative safe integers, participate in the existing transaction, and survive reopening. A current database missing this table refuses to open rather than silently restarting its scans.

The table and helpers grant no execution, approval, delivery, or evidence authority. This preparation does not include assignment behavior, automatic review retries, or mode changes. Historical migration fixtures remove the new table before declaring an older schema; authentic saved historical schemas and migration acceptance rules remain unchanged.

The original task base is exact verified corrective session output
`2954e5ec630d8d91e4ef9e32a2bc2d1bd9d45c1b`. Builder 1911 passed the unchanged
full machine gate; reviewer 1912 finished with all four criteria upheld, including
readable reused evidence, and the builder proof is verified. The underlying UI
result `7ee7a28a39c03ec08295468bdb82521c7ca85542` was verified by builder 1907
and reviewer 1908. Earlier branches and attempts remain preserved; no dispatched
task's original base is moved. This prerequisite verification does not approve or
verify the foundation candidate, which still needs its own signed dispatch,
native gate and independent review.

Only the scoped delta from `b60ffa69572bd39b6624f2aed763a5926d080fa9` to
`fb4cc0769be3c836182c6103a4c9aca7841a8567` is applied. Store and all 35 affected
test files match that preparation byte for byte. Newer inherited UI, session and
runtime corrections remain unchanged. Earlier prepared and combined branches
remain preserved. This split keeps complete source and evidence within the native
proof limits; it does not change the original base of a dispatched task.

The root screenshot inventory is deliberately empty for this schema-only release.
Inherited UI and session evidence stays in Git as prerequisite history, not new
visual evidence for storage work. Current source hashes and complete focused logs
are committed in `evidence/assignment-foundation/checks.json`, its archive and
`checks.txt`. The plaintext mirror is byte-identical to the decoded archive, so
independent review can read the complete log without a gzip decoder.
Native dispatch, the unchanged full gate, independent review and any matched
UI/worker/database upgrade remain separate and have not been performed here.

This contract correction changes only release documentation and metadata.
Implementation, fixture tests, complete logs and input inventories remain unchanged.
The first two native attempts stay preserved and unverified: builder 1914/reviewer
1915 and builder 1916/reviewer 1917 passed their full machine gates and upheld
criteria 1/2, but left criterion 3 cannot-tell. The reviews could not independently
bind every focused-run input to the native candidate. Neither `836c452` nor
`4bf9149` is a verified foundation prerequisite.

The prior contract correction made the native full gate authoritative. This source-binding correction keeps all three criteria unchanged, including criterion 3:

> Historical fixtures remove service_cursor before declaring older schemas; recognition stays strict. The unchanged native full gate passes on the exact candidate. Changed source hashes match sealed files. Full focused logs retain their preparation checkpoint, separate from final native verification.

The unchanged full native command executes against the exact new candidate.
`REVIEW-VERIFICATION.json` and `REVIEW-CHECK-LOG.txt` provide its authoritative
execution evidence. For every changed source path, compare the manifest
`sourceGitBlob` entry with the exact review head’s `identities[].blob` in schema 3
`REVIEW-CONTEXT.json`. These raw Git blob identities are captured before redaction.
`items[].sha256` hashes only displayed, possibly redacted text; it is not a raw
source hash. The retained `sourceSha256` map is checked against raw committed Git
content during local preflight. Blob identity does not make hidden content visible
or remove redaction, coverage or behavioral evidence limits. Approval, strict fixture recognition, all tests and normal
independent review remain required. No prior signed scope or result is changed.

The complete focused record remains the fresh preparation run at
`c4f8cec7bd721b332dc1fc5887ed5a67ef54117d`: typecheck, test-harness build and
485 passing checks in 35 suites. Its worktree, times, commands, 440-file inventory
and before/after comparisons remain intact. These preparer observations describe
that checkpoint; they are not an independently sealed all-input equivalence proof
for the final native head. They corroborate the implementation separately from
the native full gate. No tests were rerun for this contract clarification.

Builder 1918/reviewer 1919 and output `5c74f0f` also remain preserved and
unverified: the full gate passed, but criterion 3 was cannot-tell because raw
SHA-256 could not be compared with redacted context items 29/34. This correction
adds the existing native raw-identity comparison, without changing source or the
signed criterion text. In particular, `src/project-knowledge.test.ts` has Git blob
`ff3e8354563617347afa468a82ccfe44717e4aad` and `src/review-context.test.ts` has
`48ca49166fbcead86ccd1ea8acafd264c91d23a6`. A new signed task, native gate and
independent review remain required. No tests or native actions ran here.
