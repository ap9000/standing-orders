# Recipe creator and frequent-work launch — 2026-09-12

## Scope

The creator now separates saving a reusable definition from launching one use.
Authors name the recipe, write its instructions and success checks, and can
add up to eight questions with optional defaults. A button inserts a question
at the instructions cursor. Recipe preview shows the reusable definition and
saves it without creating work. Task scopes and imported recipes can seed the
same creator.

Saved recipes appear before starters, sort recently used copies first, support
search, and offer **Use recipe** and **Edit a copy**. The short use form asks
only what changes this time, then previews the filled-in scope through the
existing launch/approval path. Fixed recipes also use the short form. New-task
intake links to the recipe library and creator.

## Authority and persistence

- Question definitions use portable recipe format 2; format 1 remains supported
  with its original canonical serialization and digests. All saved recipe
  copies remain immutable. Input values are validated before substitution and
  the full resulting scope is validated again afterwards.
- Substitution is one pass with literal replacement values. Unknown, duplicate,
  unused, or malformed question keys refuse. Nested placeholders, disguised
  text, oversized answers, and unsupported fields also refuse.
- Questions can fill the name, description, goal, exclusions, and acceptance
  statements. Allowed paths and check commands stay fixed; project identity,
  agent configuration, permissions, budget settings, and publication authority
  are never input slots.
- Run preparation reads the exact saved recipe from the project, checks actor
  access within the transaction, and freezes a concrete format-1 preview. An
  unresolved question definition cannot launch directly, even through a forged
  POST. Edited short-form scope fields cannot replace the stored definition.
- Each deliberate use creates a new preview; retries of that same preview use
  the existing durable receipt. Independent uses never overwrite the recipe or
  each other's scope. Current project grants, CSRF, session revision, and the
  existing signed-policy rules still apply.
- Schema 57 adds a partial index for recent-use lookups and fences controllers
  that only understand fixed recipes. Historical recipe/preview rows and
  receipts are preserved. Scheduled recipes freeze their answers for all
  firings; another use creates another schedule.

## Validation and boundaries

Typecheck, production build, and all **2,673 local tests in 154 files** passed
(23 platform skips). Ten added tests cover literal/default substitution,
unsupported question slots, separate uses and restart replay, project grants,
recent-use ordering, v56 migration preservation, creator→save→use HTTP flows,
stale/forged short forms, and progressive question/search controls. The new
service tests also join the Windows Node 22/24 baseline.

An isolated Chromium walkthrough created a recipe, inserted its question into
the instructions, saved without starting work, answered from a 390×844 phone
layout, and created a task carrying the filled-in name, goal, and success check.
The phone form had one answer field and no horizontal overflow. Desktop search
filtered saved recipes, and the created task appeared in recent work. Screenshots
are in the user guide; local logs and captures are under
`output/certification/recipe-creator-*` and `output/playwright/recipe-creator-*`.
Browser review also prompted a clearer first success-check label. Removing the
last question now refuses until its placeholders are removed; that state is
preserved through validation errors.

This feature adds a creator and reusable inputs to the existing engine. It
does not synthesize instructions with a model, edit existing recipe copies in
place, run arbitrary template code, add secret storage, or add another workflow
engine. Saving a concrete run preview as a recipe saves that filled-in scope.

The live schema-52 Mac controller and staged schema-55 Completion Preview were
not changed. Deployment remains behind the OS recovery checks in
[the rollout record](FINAL_ROLLOUT_2026-09-12.md); the future installation must
certify the exact schema-57 bundle and take a fresh backup. The separate
`codex/quality-flow-hardening` checkout remains outside this wave.
