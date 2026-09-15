# Quiet project learning — revision 1 result

## Outcome and candidate

Repaired recovery starvation, unscoped planner advice, the optional review output contract, and the four native-gate test expectations. Presentation, schema, approvals, routing, and the approved verification command remain unchanged. An observation, adoption, or usage record does not establish that a remedy works or that quality improved.

Source: run **1596**, candidate `0abc9ccab24887fc18a6eceffabda262296bd990`, source scope digest `e3ff58c506e5b60354cf0cbb4522e129`. Read `AGENTS.md`, the canonical rubric, and the operator-supplied sealed revision brief at `output/playwright/repair-brief-1596-1.json`.

Branch: `standing-orders/quiet-project-learning-20260914-fix-1`. HEAD remains the source candidate; every repair is uncommitted. The source candidate's native gate failed four tests. Its earlier local results must not be described as a passing full gate.

Final changed source/test manifest SHA-256: `3255dd2aa6ba0b153cfc8a18a70f5ccc7d6431f06082d64ce70c53980d2296dd`. Hash the following UTF-8 lines including their trailing newlines to reproduce that identity. This assessment and protocol files are excluded to avoid recursive hashes.

```text
26d3878e81802e8c6595ac27e13858c2696222f4c04eded5af3cc9adf1c6917f  src/migration-v53-process-custody.test.ts
f5c1a5a69fe763bc425438ed3fded48c69718b3d20389bead7b3a35d879e322c  src/planner.test.ts
f86e787d77fb90f6673306ff326a897e58519613dae62b4cb0ec34bf31f6ac21  src/project-access-ledger.test.ts
ed2c0ff6e48d5a9c09162f861e2fd23962a314fb2dfbd0709b35694852bfbd99  src/project-learning.test.ts
1823fb6671c5cc7e242b137c8ef1dbd2f74757b301aa92ea4825eaa5d8d5364c  src/project-learning.ts
1cfa09831dfdf0b463c3418f5a16b2b380a5f898e860ac11ed82259fd8eced16  src/recipe-creator.test.ts
ac7c8fbfc9ababa567f60768763f5d12d7f65913a65b775e8efb3b777f712bc7  src/reviewer.ts
fb40828620b556217e46c41b2369017c2e2ab5e4e351331f5d8c113aa3222f60  src/task-control.test.ts
```

## Repairs

- **Recovery:** omitted learning used to leave no capture row; the newest 50 accepted reviews could occupy every fallback scan forever. Empty or omitted input now gets immutable `[]` bookkeeping when its verified review snapshot exists. Empty captures do not occupy the processing batch or add no-op ledger entries. Legacy reviews without snapshots remain compatible.
- Both fallback recovery and pending capture processing use batches of at most 50. Per-store, per-project cursors move past unreadable sources and retryable writes. Each sweep fixes an upper run/source ID so new arrivals cannot indefinitely postpone an older retry. A restart begins with the oldest missing work; completed and empty capture rows persist. This adds no schema, setting, scheduler, or time limit. Identity, source lineage, catalog membership, artifact bytes and excerpts still determine eligibility; a cursor never does.
- **Planning:** a planner with no scope and no signed scope digest may receive verified project/plan advice. Scoped planners, builders, and reviewers retain path filtering. Both paths retain adoption/access, phase, platform, current code/configuration/environment, dirty-file, conflict, five-lesson and 16,000-byte checks. The advisory wrapper explicitly grants no file-write authority. Scope, route, permissions and approval are never changed by selection; exact snapshots remain immutable.
- **Review output:** `learning` is shown with the core JSON shape and explained once beside it. The reviewer is asked to consider concise evidence-backed prevention or reuse lessons; omission and zero suggestions remain valid. The artifact catalog remains separate data. Core parsing, criterion completeness, provider schema optionality and review failure rules are unchanged. No extra model call was added.
- **Native test expectations:** the three schema assertions now expect v58. The project-access test checks that scoped Settings and Learning return 200 without foreign-project content, rejects foreign Learning URLs, and retains denials for global administration and mutations. No checks were skipped or removed; predecessor-version and old-reader fencing assertions remain intact.

## Checks actually run on the final source/test candidate

| Command | Result |
| --- | --- |
| `npm run typecheck && npx vitest run src/project-learning.test.ts src/planner.test.ts src/reviewer.test.ts src/provider.test.ts src/structured-output.test.ts src/builder.test.ts` | Exit 0; typecheck and 358 tests in six affected files passed. Vitest built the candidate runtime through the existing setup. |
| `npx vitest run src/migration-v53-process-custody.test.ts src/recipe-creator.test.ts src/task-control.test.ts src/project-access-ledger.test.ts src/migration-v58-project-learning.test.ts src/schema-epoch.test.ts` | Exit 0; 39 tests in six affected files passed. |
| `node output/playwright/learning-recovery-audit.mjs "$PWD"` | Exit 0; 51 reviews, older lesson recovered, 51 capture rows, core reviewer outcome no-change, failure retained (synthetic fixture). |
| `git diff --exit-code 0abc9ccab24887fc18a6eceffabda262296bd990 -- src/workspace-ui.ts src/serve.ts src/result-review.ts scripts/ui-polish-fixture.mjs scripts/workspace-result-proof.mjs && git diff --check` | Exit 0; UI and browser scripts match the source candidate, and no whitespace errors were found. |

The final two focused suites cover **397 tests** without overlap. The initial five-file run had 45 passes and two new fixture failures: the unscoped helper omitted its legacy spend stamp, and failing every no-op write made the recovery fixture exceed the existing test timeout. Both fixtures were corrected. The recovery regression still fails valid learning writes while 50 later reviews omit learning; empty bookkeeping is now tested through the production path. No time limit changed. An intermediate 14-test learning run passed; its count overlaps the final 358 and is not added again.

The audit's first invocation supplied `$PWD/dist`; the helper appends `dist` itself and refused that path before exercising code. The corrected invocation supplies the checkout root and imports this candidate's compiled runtime. Its `runtimeCandidate` is the unchanged HEAD, so the manifest above identifies the uncommitted repair it exercised. The wrapper and its underlying root helper are operator-provided acceptance evidence, not a newly added repository dependency.

The regression checks old-lesson recovery, proposed status, completed core reviews, empty-input bookkeeping, no no-op capture ledger entries, restart deduplication, and retained failure history. The real-worktree planner negotiation now seeds an adopted plan-only lesson and verifies its exact payload in genuinely unscoped planner prompts. It also verifies a proposed scope, no builder before approval, and no plan-only lesson in the later builder snapshot. Existing learning tests cover bounds, conflicts, drift, dirty code, revoked adoption, stale forms, reset, tampered artifacts, system suggestions and project access.

All database work used disposable fixtures. The v58 migration test checks data retention, the committed `-57` epoch before DDL, older-reader refusal, foreign keys, missing metadata and idempotent reopening. The migration implementation did not change. No real database, installed service, global configuration or permission was changed. No full verifier, real provider, extra model, subagent, deployment, push, publication, signing, or git history operation was used.

## Inherited desktop and phone evidence

Presentation is byte-identical to the source candidate. Per the revision scope, this attempt inherits the original UI journey rather than rerunning it. The operator staged eight original PNGs, the original report and `PROVENANCE.md` in `output/playwright/review-learning-2026-09-14/`. These are **run 1596 / candidate 0abc9cc captures**, showing synthetic data; they are not new repair screenshots or real-provider evidence. Their original capture directory was `/tmp/so-learning-proof.UtlcnU`, and the report timestamp is `2026-09-15T01:55:51.217Z`. Native source artifacts remain in the installation evidence store; final source-artifact custody uses the existing native review-context path.

The inherited report records **32 passes, zero failures**, one journey each at **1400×900** and **390×844**: empty Settings; a source-linked proposed lesson and long system suggestion; result inspection; feedback and one unapproved revision; keyboard disclosure; adoption; enabled later reuse; a stale action and reload recovery; disabling with retained snapshot/history; foreign-project exclusion; readable details and 44px controls. This attempt read the report and visually inspected all eight actual PNGs. Physical iPhone/Safari behavior was not exercised.

Simplicity review: the source disclosure keeps the evidence and adoption terms before **Save lesson**; system suggestions say **No change applied**; the ledger exposes details on demand; **Reload Learning** gives a clear recovery action. Source hashes wrap within the phone column, short actions stay on one line, and the result navigation is unchanged. No additional presentation defect was found. The earlier source-excerpt width repair and its screenshots are inherited, not claimed as work in this revision.

Exact staged screenshot bytes (paths are relative to `output/playwright/review-learning-2026-09-14/`):

| Screenshot | Dimensions | SHA-256 |
| --- | --- | --- |
| [desktop-learning-empty.png](../../output/playwright/review-learning-2026-09-14/desktop-learning-empty.png) | 1400×900 | `a56b6fcb7d2e426775b13d97cf1a98f52afb854e601fb6ee9e2ca3941feb4643` |
| [desktop-learning-adopt.png](../../output/playwright/review-learning-2026-09-14/desktop-learning-adopt.png) | 1400×900 | `e8d10f08069f2ef0cb2c9826dabbecc520501d6a80b240a274812ad2d81ae989` |
| [desktop-learning-ledger.png](../../output/playwright/review-learning-2026-09-14/desktop-learning-ledger.png) | 1400×900 | `ddbf49a1ac252e185ec62c02d9f0f40c975079b8a0ef428825eb690bab4a563b` |
| [desktop-learning-error.png](../../output/playwright/review-learning-2026-09-14/desktop-learning-error.png) | 1400×900 | `d2669e89d9e7535ac7f7fb09edd5e73ff140bd922a48d22603cc32b18ddfdb8b` |
| [phone-learning-empty.png](../../output/playwright/review-learning-2026-09-14/phone-learning-empty.png) | 390×844 | `768f6c8affa8391d9a94bb187b631adeb0902eadb7c2347c8aa7f5d0dbcef0a8` |
| [phone-learning-adopt.png](../../output/playwright/review-learning-2026-09-14/phone-learning-adopt.png) | 390×844 | `93281ea2fa3fc441e81731c1847c48d1513f3b2c3d50a35683e57ff96376275c` |
| [phone-learning-ledger.png](../../output/playwright/review-learning-2026-09-14/phone-learning-ledger.png) | 390×844 | `b3f544476267c2ef87c1ad0beb8a539cd1dce65e7c7f1344f6a141bb9098b134` |
| [phone-learning-error.png](../../output/playwright/review-learning-2026-09-14/phone-learning-error.png) | 390×844 | `b1c151b886a91c1cdb61c40a01b30b07307d49b0f31f11c6b3b2347ab302303f` |

## Signed acceptance evidence

Each criterion is pending the native final check and its evidence validation for this candidate. This attempt did not run that unchanged full command.

### capture

Optional review learning cites verified source artifacts, deduplicates across retry and restart, and remains proposed until adopted. Missing invalid or absent learning never weakens core review or blocks task completion. Existing reviews and feedback batches stay compatible

The recovery regression and root audit verify recovery after 50 newer omitted-learning reviews. Existing strict-parser, exact-source, failure, restart and feedback tests passed. The output contract remains optional.

### reuse

Later planner builder and reviewer runs receive at most five eligible adopted project lessons as bounded advisory context with immutable exact usage snapshots. Disabled stale tampered conflicting or unauthorized guidance is excluded and no lesson overrides scope approvals verification or route

The actual unscoped planner journey now receives its immutable adopted plan-only lesson before a scope exists; build still requires approval. The focused planner/builder/reviewer and learning tests preserve bounds, exclusion checks and exact snapshots.

### ledger

Settings exposes a quiet project-filtered paginated change ledger with actor time before-after reason evidence and affected runs. Adopt disable reset and reuse are observable and stale-safe. Reset retains history and system suggestions never appear as applied improvements

The scoped Settings test now asserts intended access while retaining global and foreign-project denials. Adoption, disable, reset, paging and stale-action regressions passed. Empty input is accounted for without no-op ledger rows; original desktop/phone ledger screenshots retain source custody.

### safety

Project isolation CSRF authorization concurrent actions prompt-injection input evidence integrity and applicable configuration boundaries fail safely. Any storage migration preserves data and correctly fences older readers, tested only on disposable databases

Focused project-access, learning and schema/migration tests passed against disposable databases. Artifact, identity, approval, route, CSRF, concurrent/stale-action and configuration fences are preserved. No schema or production configuration changed.

### experience

One desktop 1400x900 and phone 390x844 journey covers result lesson adoption later reuse disable and retained ledger, plus empty long and error states. Concise copy readable details usable keyboard and 44px controls, no new primary navigation or competing routine CTA

The original 32-assertion desktop/phone journey and eight inspected source PNGs cover empty, long and error states, feedback/revision, adoption, reuse and retained history. The UI/script equality check passed. No new browser capture is claimed.

## Limits and ownership

The first real CSV pilot review omitted learning. This revision verifies nonempty capture and reuse through deterministic fixtures, including the actual planner and reviewer invocation paths; it does not establish nonempty real-provider reuse or measured benefit. Root owns the real-provider pilot and independent Opus review. No such acceptance is self-certified here.

Recovery needs readable sealed evidence, the original project identity, a valid review snapshot and functioning storage. It does not manufacture missing provenance. Cursor position is process-local; restart retries oldest pending work, with immutable capture records preserving progress. Existing limits remain: 50 displayed proposals, at most 100 adopted candidates examined, five lessons and 16,000 context bytes. Conservative conflicts/fingerprint changes may exclude useful advice. Adoption grants advisory reuse only; program-level suggestions remain unapplied. Any eventual installation migration requires the existing guarded release process outside this task.
