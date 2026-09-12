# Guided workflow recipes — 2026-09-12

## Result

The console has a choose → customize → preview path with six starter recipes,
project-scoped saved copies, one-time and calendar/interval scheduling,
structured success checks, optional routine spending limits, JSON sharing,
task-scope reuse, readiness guidance, and recent-work links. The feature starter
requires the person to supply the actual desired behavior; instructional text
cannot be submitted as a ready-made feature from that starter screen.

The implementation reuses `fileTaskProposal`, `fileRoutineProposal`, signed
project policies, exact routine approval, and the existing worker/scheduler.
No second workflow engine or new automatic approval authority was introduced.
See [the user guide](../WORKFLOW_RECIPES.md) for the supported flow and limits.

## Robustness and permission boundaries

- Schema 56 stores immutable recipe copies and durable, actor/project-bound
  previews. Canonical project identity keeps aliases in the same library.
- Launch transactions include the existing filing, optional signed-policy
  application, receipt, and ledger. The same preview returns the same task or
  routine across lost responses and process restarts. Injected receipt failure
  rolls back the work and ledger together.
- Imports are bounded, strictly versioned work definitions. They reject unknown
  or privileged fields and invalid scope/evidence/schedules. Rendering escapes
  user text. Imported documents create no work before preview and launch.
- Current project grants, actor role, CSRF, server project ceiling, and open
  project revision are checked at the existing HTTP boundary and again after
  asynchronous project authorization. The service rechecks access inside its
  transactions. Previews remain private; saved recipes and created work follow
  project access.
- Only a signed-in policy signer can use the existing automatic filing policy.
  Members and bearer calls do not inherit someone else's approval. Recurring
  work always starts unapproved and uses existing exact-agent approval and
  single-flight scheduling.
- The additive migration preserves historical rows. Current databases missing
  recipe/receipt tables refuse to open rather than lose launch history. Missing
  v55 plan authority also refuses before migration instead of being recreated.

## Validation

- Typecheck and production build passed.
- Full local suite: **153 files, 2,663 passed, 23 platform skips**.
- Sixteen new tests cover service persistence/retry, rollback, scheduler reuse,
  policy ownership, project aliases/access revocation, preview privacy/expiry,
  malformed imports, forged late edits, rendered forms, scope copying,
  feature input requirements, and migration preservation/fail-closed behavior.
- Chromium browser walkthrough used an isolated demo database and no worker:
  customize, preview, save, JSON download, and create a scheduled workflow
  reaching its existing approval page. Actual browser selection of direct
  scope execution was verified, independently of the DOM test helper.
- Desktop (1440×1080) and phone (390×844) layouts were inspected. The browser
  check caught and corrected unstyled text inputs; recipe editor and preview
  fit the phone width. Browser output contained no JavaScript error; the
  existing routine password form emitted a verbose accessibility suggestion.

Local logs and captures are under `output/certification/workflow-recipes-*`
and `output/playwright/recipe*`. These are isolated feature tests, not a new
certificate of real provider execution or physical login/reboot recovery.

## Installation boundary

The live Mac controller was not replaced or its database migrated in this
wave. The earlier pending macOS update/launchd gate remains as recorded in
[the rollout assessment](FINAL_ROLLOUT_2026-09-12.md). The existing schema-55
Completion Preview bundle was also left intact. A future deployment must build
the schema-56 runtime, certify that exact bundle, take a fresh live backup,
and complete the normal coordinated upgrade and recovery checks.
