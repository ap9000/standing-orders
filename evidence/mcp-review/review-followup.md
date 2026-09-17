# Focused follow-up to independent review 1764

This evidence-only correction preserves build 1763 and review 1764. That review upheld c1 and returned cannot-tell for c2 and c3 because supporting code and images were not inspected. It is not an approval. No production source, tests, approvals, or release safeguards change here.

## Source evidence to inspect

`review-source-excerpts.json` contains verbatim bounded excerpts from candidate ec6a8734c690bd10511594da698aa88cc34465db, with original file line ranges and full-file SHA-256 values. The excerpts were checked against the committed Git tree, not a separate working copy. The source remains byte-identical in this correction. They are supporting evidence, not new test results.

- `src/store.ts`: openStore's connection/writer-wait path reaches initializeStore. The preflight and authority checks read metadata. The checked schema_version update stamps -47 before `db.exec(SCHEMA)`. SCHEMA starts with two PRAGMAs and then `CREATE TABLE IF NOT EXISTS schema_version`; migrations and ALTER helpers run later. Thus the first CREATE TABLE intercepted in schema-epoch.test.ts is the first DDL on this path. On the authentic v47 fixture this CREATE is an IF NOT EXISTS no-op; the test proves the committed epoch refusal while the real migrator is paused at that boundary, not that this first statement changes the schema. Both independent MCP status and filing refuse, and filing leaves task and idempotency counts unchanged.
- `src/store.ts` placeTask: inside a transaction, any existing scope plus a different repository (including null to non-null) returns scoped before UPDATE. This supports the spec's replacement-task road with fresh approval and preserved original history; same-repository repetition is not a move.
- `src/decision.ts`: hasDisguisedText rejects the full C0/C1 forbidden control range and direction-control invisibles. Newline and tab remain allowed in multiline prose. This is the definition behind the cancellation-floor regression, not an inferred name-based claim.
- `scripts/ui-polish-fixture.mjs`: isolated in-memory database, throwaway repository and ephemeral approver; synthetic finished-result proof supports the feedback/revision journey. It never establishes production agent output or a physical-phone result.

## Browser evidence to inspect

Open all eight native screenshot attachments. Captions and this report are not a substitute for opening their image bytes. Cross-check the current source hashes, 16 recorded browser assertions in ui-report.json, the server refusal regressions, and the following inventory:

| Image | Evidence boundary |
| --- | --- |
| desktop-cancel.png | Short cancellation action and reason field at 1440x1000 |
| desktop-error.png | Rejected long draft remains expanded and editable |
| desktop-revision.png | Expanded revision brief after realistic feedback |
| phone-empty.png | Required empty reason state at 390x844 |
| phone-error.png | HTTP refusal shown at page top |
| phone-draft.png | Same rejected draft retained lower on the page |
| phone-cancel.png | Short confirmation action and reason field fit phone viewport |
| phone-revision.png | Expanded revision brief preserves feedback on phone viewport |

These images and the recorded browser checks are reused because serve.ts/store.ts and the fixture are unchanged. The original operator journey opened the cancellation disclosure, attempted empty submission, removed maxlength only in the disposable fixture to submit an overlong reason, observed HTTP 400 and retained text, used Tab to focus the confirmation button and measured one-line/44px geometry and document overflow, then corrected the reason. Per viewport the operator also opened the synthetic finished result, used the actual current Request changes control, submitted realistic feedback and inspected the resulting unapproved revision with its expanded brief. The images substantiate appearance; the recorded checks and source/test evidence substantiate dynamic behavior. They do not themselves prove keystrokes or network responses. No new browser run is claimed by this document.

## Test provenance and release boundary

The unchanged source passed 658 focused tests in 11 files and typecheck; checks.json binds those results to source hashes. Native build 1763 additionally passed the exact approved full gate: 185 files, 3408 passed, 23 existing platform skips, exit 0. Its check-log artifact 1560 is retained head/tail output (truncated=true), not a complete transcript. Review 1764 is historical and incomplete. The corrective native attempt must obtain its own machine receipt and independent judgements; neither this note nor the prior check count may substitute for that receipt. Builder/reviewer must not duplicate the full suite outside the native machine gate, and must not merge or deploy.
