# Contract handoff integration

Validated 2026-09-12 UTC on macOS arm64 / Node 22.22.0.
Runtime source: `1b3a2ba3de84e5fed2dbf954ef797e3d3038dbd4`.
Executable SHA-256: `bb56ddbee14dec222d131fb65483d27aec51858ebb559571bfdd7bc38edc9d5c`.

Standing Orders now preserves the filed request through planning, carries the
source contract into revisions, and supplies verified inherited source context
to independent reviewers. This uses the existing database, artifacts, approval
transaction, and queue. The [Agor assessment](AGOR_CONTEXT.md) supports that
bounded design; no Agor code or new memory service was introduced.

## What changed

- Planning records the detailed filed request, execution constraints, revision
  brief, and prior decisions. Finalization re-proves the recorded bytes and
  current input identity. An amendment must be explicit and visible at approval;
  stale inputs cannot overwrite a newer scope. Limits refuse visibly.
- Annotation, CI, and criterion repairs share one revision boundary. It binds
  the actual source run, scope, head, brief, and annotation batch, retains risk,
  quality, budget and permission ceilings, and requires fresh approval. Repair
  ancestry retains the existing finite allowance across detours and restarts.
- New revision builds start at the source commit recorded in the verified brief.
  An explicit base or existing branch must contain that commit.
- Review receives bounded source files read from exact Git objects, evidence
  references, and earlier review provenance. Successive revisions retain
  ancestor paths. Coverage distinguishes patch, inherited context, and gaps.
  Earlier judgements remain context; each current judgement is independent.
  Citations must refer to evidence relevant to that criterion. Input inventories,
  hashes, scope, and reviewer ancestry are rechecked at atomic ingestion.

## Evidence

| Gate | Result |
| --- | --- |
| Typecheck and production build | Pass |
| Full integrated regression suite | 132 files; 2,507 passed; 12 existing skips |
| Live database compatibility | Private backup upgraded 49 → 51; all table counts preserved; integrity and foreign keys clean; second open succeeds |
| Claude `opus` complete handoff journey | Pass; 7m45s; zero rescue interventions |
| Codex `gpt-5.6-sol` complete handoff journey | Pass; 16m9s; zero rescue interventions |
| Independent journey acceptance | All three criteria upheld after the original build and after the revision, for both providers |
| Visual inspection | Four final screenshots inspected: 1280×800 desktop and 390×844 mobile for each provider |
| Broader release pilot | 20/20; Claude `sonnet` 10/10 and Codex `gpt-5.6-sol` 10/10; 44/44 criteria independently upheld; 8 screenshot artifacts verified |

Each real journey filed a deliberately short title with a detailed goal,
exclusions, evidence rubric, high risk, and strict quality. It then used the
normal planning, exact-scope approval, build, review, annotation, revision, and
fresh-approval paths in a disposable repository and private database. The
revision changed only the catalog heading; the helper blob stayed unchanged.
The final reviewer cited that helper through the sealed inherited context and
upheld its criterion. Both runs checked unchanged default branches, no open
orphan runs, and empty duplicate dispatch. Both runtime hashes stayed fixed.
One Claude review required the existing automatic structured-output correction;
the original attempt and correction remain recorded.

The broader pilot completed in two sequential batches with zero rescue
interventions. Median task duration was 133s and p95 240s; these
include setup, implementation, checks, and review, with no direct-provider
comparison. Its executable hash matches both handoff journeys. The committed
[compact certificate](evidence/contract-handoffs.json) records case results,
commits, criterion judgements, screenshot hashes, and runtime identity.

Local certificates: `output/certification/handoff-journey-claude-1.json`,
`handoff-journey-codex-1.json`, and `handoff-pilot-20.json`; the compact summary and four hash-verified,
visually inspected screenshots are under `output/handoffs/`.
The reproducible driver is `scripts/handoff-journey.mjs`, which accepts the
installed Playwright module path and an optional provider selection.

## Failures retained and practical limits

The three implementation tasks ran through Standing Orders, then received
operator-led integration hardening. Implementation was assisted; the two final
journeys above had no out-of-band rescue. Earlier integration failures are
retained in `output/handoffs/`: source-run fixture stamps were corrected to
match real execution; context tests were updated for stricter mixed coverage;
and the first full integration pass had a race fixture exit before readiness.
Its stderr was not retained, so the original exit cause is unverified. The
fixture now initializes its two connections before simultaneously releasing
them to contend at the actual revision seal, retaining stderr and handling
readiness failures. The final full suite passed after that correction.

These are bounded workflow results, not a guarantee of semantic correctness on
arbitrary projects. Windows closure/reboot, actual account exhaustion, and
production publication were not exercised. The previous crash certificate has
its own runtime hash and is not relabeled as this runtime. The live controller
remains on the stable schema-49 reliability checkout; this integration does not
upgrade it.
