# Quiet project learning — implementation result

## Outcome and candidate

Implemented optional review learning, explicit adoption, bounded advisory reuse, and Settings → Learning. A stored observation, adoption, or usage record does **not** prove a remedy works or demonstrate quality improvement.

Base and unchanged HEAD: `2a008a0dd63425ad00a368884f359dbd120afd27`. Branch: `standing-orders/quiet-project-learning-20260914`. All changes remain uncommitted. No installation database was opened or migrated, and no deployment, network write, extra model call, subagent, instruction-file edit, or verification-command change was made.

Source/script/test candidate manifest SHA-256: `1ac58db4cec7d532292a6ea9f6cf3366a59ed50a06598b58008c24ff6b0b746c`. Exact per-file hashes: [candidate-sha256.txt](../../output/playwright/review-learning-2026-09-14/candidate-sha256.txt). The manifest excludes this assessment and the protocol files to avoid a recursive hash.

## Implementation

- The existing review response may contain zero to two suggestions. Core comments, criterion judgments, bindings, informational-note filtering, and revision batches retain their existing strict rules. Optional learning is separately validated after the core transaction commits.
- A small v58 capture queue retains optional input and the exact supplied artifact catalog alongside the successful review. Recovery deduplicates by source review and normalized finding; a failed queue write can recover from the sealed accepted response and immutable review snapshot. Invalid learning records an issue without changing the completed task or accepted review.
- Proposals bind repository identity, source/reviewer run IDs, exact artifact hashes and excerpts, relevant source paths, phases, platform, source revision, code/configuration fingerprints, and the configured verification/setup environment. Inherited context reuses the existing ancestry-custody validator. Proposed remedies remain advice. Only supported project lessons can be adopted; system suggestions have no adoption or application path.
- Explicit adoption and enabling reuse are separate actions. Selection supplies at most five lessons and 16,000 UTF-8 bytes, including its advisory wrapper. It rejects disabled, wrong-project, unsupported, conflicting, changed-code/configuration, changed-environment, unauthorized-adopter, and damaged inputs. Differing advice on overlapping paths is conservatively excluded. There is no learned-command executor, routing authority, global configuration change, or scheduler.
- A run receives its exact frozen payload, including an empty selection. Planner and builder briefs, and the existing reviewer call, use those recorded bytes. Snapshot and source-content triggers prohibit updates/deletion; event history is append-only. Disable/reset affects future selection and retains active snapshots, code, approvals and history.
- Settings is reachable without notification configuration and for project-scoped accounts. Learning lists only admitted projects and uses keyset pagination of 20 ledger entries. The ledger shows actor, UTC time, before/after state, reason, source links, affected run links and current outcomes. Exact context is available on demand. Reset records the disabled lessons individually and retains their source links.
- Web changes require the existing authenticated session, CSRF/origin checks, current account standing and project admission, plus exact repository identity, project revision, and lesson version/hash. Mutations recheck account access inside the write transaction, so a stale concurrent form loses atomically.

## Checks actually run

- `npm run typecheck` — Passed on final source tree.
- `npx vitest run src/project-learning.test.ts src/migration-v58-project-learning.test.ts src/schema-epoch.test.ts src/store.test.ts src/reviewer.test.ts src/provider.test.ts src/builder.test.ts src/planner.test.ts src/serve.test.ts src/workspace-ui.test.ts src/review-context.test.ts` — 817 tests passed across 11 affected files.
- `npx vitest run src/project-learning.test.ts` — 13 tests passed, including the added project-scoped account regression.
- `npm run build && PLAYWRIGHT_CHANNEL=chrome node scripts/workspace-result-proof.mjs --learning --strict --out "$(mktemp -d /tmp/so-learning-proof.XXXXXX)"` — Build passed; 32 browser assertions passed at 1400x900 and 390x844 after the final CSS repair.
- `git diff --check` — Passed; no whitespace errors.

The 817-test affected suite ran before adding one account-isolation regression and a CSS-only source-excerpt margin repair. The final 13-test learning run covers the added regression; the final browser run covers the CSS repair. Other affected evidence is reused for unchanged behavior. Typecheck covers the final tree. Counts overlap and are not summed. The native machine gate alone owns the unchanged full verifier; this attempt did not run it.

The migration test uses disposable SQLite files: removes only the additive learning objects to reproduce the v57 predecessor shape, retains a task, observes committed `-57` before DDL from another connection, checks the older-reader version contract, verifies v58 and foreign keys, reopens idempotently, and refuses missing current learning metadata. Existing schema-epoch tests exercise non-migrating and mid-flight readers. No real database upgrade or installed v57 process was used.

Provider evidence is synthetic. One existing reviewer invocation captures learning and receives its frozen adopted lesson without a reflection call. Real-worktree planner/builder integration asserts that their actual prompts contain their exact empty snapshots; nonempty selection is tested for all three phases. Root owns real-provider corrected-task/later-task acceptance and independent Opus review.

## Desktop and phone journey

Reused `scripts/ui-polish-fixture.mjs` and `scripts/workspace-result-proof.mjs --learning` with isolated repositories and an in-memory store. Headless installed Chrome ran one 1400×900 journey and one 390×844 journey: open Settings and its empty ledger; capture a project lesson and long system suggestion; inspect the result diff; leave feedback and create one unapproved revision; open learning with the keyboard; inspect the source and save; enable reuse; select for a different later run; inspect the ledger; refuse a stale form; disable; verify an empty future selection and retained snapshot/history; and verify another project stays empty. No real model is invoked by this browser fixture.

All 32 assertions passed. [Browser report](../../output/playwright/review-learning-2026-09-14/report.json) and screenshots live in the same folder. The report's original temporary paths identify the capture location; the PNG files are copied byte-for-byte here for durable evidence.

Simplicity pass, observed and repaired:

- Before: adoption could be clicked outside its source disclosure. After: **Save lesson** is inside **Source and use**, after applicability, evidence and the adoption terms.
- Before: system suggestions repeated adoption wording and the ledger repeated states. After: system suggestions say **No change applied** and offer no adoption control; routine ledger headings say the change once.
- Before: the generic stale-form page had a small back link. After: **Reload Learning** has a 44px target and a specific recovery destination.
- Before: default blockquote indentation squeezed source code into a narrow phone column. After: source excerpts use the available width and wrap safely.
- Verified closed useful disclosure, unchanged result primary action/navigation, keyboard Enter, readable expanded hashes/context, long text, no horizontal document overflow, and 44px learning buttons/disclosures. The viewports are browser emulation; physical phone/Safari behavior was not tested.

## Signed acceptance evidence

### capture

Optional review learning cites verified source artifacts, deduplicates across retry and restart, and remains proposed until adopted. Missing invalid or absent learning never weakens core review or blocks task completion. Existing reviews and feedback batches stay compatible

Parser, capture, exact-source, restart/replay, optional-storage-failure and strict-review regressions passed; see project-learning.ts and reviewer.ts. The protocol proof marks native final verification as pending.

### reuse

Later planner builder and reviewer runs receive at most five eligible adopted project lessons as bounded advisory context with immutable exact usage snapshots. Disabled stale tampered conflicting or unauthorized guidance is excluded and no lesson overrides scope approvals verification or route

Bounded phase/path selection, conflict/configuration/evidence exclusions and immutable payload checks passed; planner/builder prompt integration and the synthetic reviewer reuse check passed. The protocol proof marks native final verification as pending.

### ledger

Settings exposes a quiet project-filtered paginated change ledger with actor time before-after reason evidence and affected runs. Adopt disable reset and reuse are observable and stale-safe. Reset retains history and system suggestions never appear as applied improvements

HTTP, state-transition, append-only, reset and pagination regressions passed. Desktop/phone ledger screenshots show the source/run links and exact-context disclosure. The protocol proof marks native final verification as pending.

### safety

Project isolation CSRF authorization concurrent actions prompt-injection input evidence integrity and applicable configuration boundaries fail safely. Any storage migration preserves data and correctly fences older readers, tested only on disposable databases

Project access, CSRF, stale concurrent actions, adversarial text, immutable content, changed identity/configuration and disposable migration/epoch checks passed. The protocol proof marks native final verification as pending.

### experience

One desktop 1400x900 and phone 390x844 journey covers result lesson adoption later reuse disable and retained ledger, plus empty long and error states. Concise copy readable details usable keyboard and 44px controls, no new primary navigation or competing routine CTA

Both exact-viewport journeys passed all 32 browser assertions, including feedback/revision compatibility, empty/long/stale states and 44px actions. Final screenshots were visually inspected. The protocol proof marks native final verification as pending.

## Limits and remaining system-level work

Learning uses exact text evidence, local repository identity and deterministic applicability; it does not evaluate semantic truth or measure benefit. A matching excerpt proves provenance, not that the suggested remedy is correct. Operator adoption grants advisory reuse only. Conservative conflicts and fingerprint changes may suppress useful advice. The list shows the latest 50 proposals and selection examines at most 100 adopted candidates; the append-only ledger remains paginated and retains older history.

Database/filesystem failure can prevent any durable write; the controller makes a best-effort learning/action-ledger diagnostic while preserving core completion. It never substitutes an unproven identity when a review snapshot cannot be recovered.

Root must conduct the assigned real-provider acceptance and independent Opus review. A release owner must perform any eventual v58 installation migration through the existing guarded update process. Program-level improvements remain tracked suggestions. The separate development/held-out baseline comparisons, recurrence/quality measurements, normal repair tasks, release authority and rollback described in plan steps 3–4 remain future work. No quality gain is claimed from this implementation or its test count.
