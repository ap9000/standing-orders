# Human review wording after acceptance

The clear acceptance UI was built as run 1702 at `9ea3e21061c37756d028ad87ae73b8e2ece4d077`. A final browser check found a presentation contradiction: after recording human acceptance, the saved requirement row still said **Needs human review** and **Inspect the saved evidence before accepting this result**.

Apply the tiny prepared correction `93afd7dca9c93493e4fa6777e50d527bfdae29a2` with `git cherry-pick --no-commit`. It uses the neutral **Human review** label and removes the repeated per-row instruction and its unused CSS. The existing overall result state and acceptance control remain responsible for the user's next action. Full approved wording, evidence links, risks, recorded acceptance, and the original machine verdict are unchanged. This is a corrective task; preserve run 1702 and its original base. The parent operator dispatches this task only after run 1702 has verified machine evidence and all three independent criterion judgments uphold.

The source hashes and four newly inspected synthetic captures are in `evidence/acceptance-human-state/manifest.json`. The isolated browser submitted the existing acceptance form, reopened the exact result, and asserted that it shows one acceptance record, the saved `manual-review` state, the neutral label, no repeated acceptance instruction, and no remaining acceptance button. Phone page width was 379 within a 390 viewport. Desktop was checked at 1440×900 and phone at 390×844, before and after acceptance. Build and the two existing focused tests (`intent to diff:` and `actions: only applicable`) passed. This remains a synthetic fixture, not a physical iPhone/Safari test.

Reuse these captures when the affected source matches. The prior run's evidence links, failure/context warnings, long paths, keyboard, feedback and unapproved-revision journeys cover unchanged behavior. The older `evidence/clear-acceptance/manifest.json` intentionally describes the predecessor; do not relabel its historical screenshots or source hashes as new. The four `evidence/acceptance-human-state/` screenshots are the current evidence for the changed wording.

Keep this correction narrow. The host owns the final candidate commit and the unchanged full verification command once for that candidate:

`npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build`

Do not duplicate that full suite in the builder or independent reviewer. Do not delete or skip tests, waive evidence or approvals, change budgets or time limits, mutate production configuration/data, send Telegram messages, deploy, merge main, or touch the original dirty checkout. The parent operator installs only the final verified and independently reviewed correction.
