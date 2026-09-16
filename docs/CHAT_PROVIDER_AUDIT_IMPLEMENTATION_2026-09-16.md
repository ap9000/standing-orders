# Complete the tested subscription chat repair

Apply and inspect the existing prepared changes, then return the normal native
handoff. This is a bounded repair, not a request to redesign provider routing.

Baseline is the deployed, accepted b2b396075ea95909e3f35210bb466abe57044369.
Prepared production/test commit: 3c74b5d9a6481ca7ab4089a0d4d71753c9e9a273.
Follow-up tests/report commit: bff64da (codex/provider-compatibility-audit-20260916).
Use `git cherry-pick --no-commit 3c74b5d bff64da` so the host owns the final
candidate commit. Do not reset HEAD or change the native task branch identity.
Inspect the actual diff; make only necessary in-scope corrections.

## Required behavior

- Failed/incomplete Claude or Codex subscription output must never be accepted
  as a usable chat answer/tool proposal, even when the process exits zero.
  Preserve valid real terminal envelopes, strict parsing and existing isolation.
- Subscription prompts go through stdin, not a positional command-line value.
  The existing buffered process-group runner must deliver exact UTF-8 input and
  refuse input-delivery failure. Preserve process containment and cleanup.
- Extend only the existing provider canary to select an explicit supported
  reviewer/model pair. Refuse incomplete/unsupported pairs before dispatch.
  Keep requested routes and runtime identity in certificates, including failure.
- Auth/quota/network failures remain explicit failures, not successful answers
  or automatic paid provider switches. No quota recognizer or fallback changes.

## Verification

The root reproduced the incomplete-output bug on b2 before fixing it, and new
stdin runner tests failed before support. Typecheck and 176 focused tests passed
after the repair; the later provider option guard passed, and all 17 converse
tests including two direct-API fault cases passed. Actual Claude Fable/Codex
Astra subscription chat, image-evidence and same-session resume checks passed.
Full disposable workflows passed on b2, not this changed candidate. Evidence
is under /tmp/standing-orders-provider-audit-ZPsedJ; these facts are context,
not a replacement for your inspected diff, focused checks or the native gate.

Run typecheck and the affected tests once for your candidate. Do not repeat paid
canaries or the full suite in the builder/reviewer. The normal native machine
gate will run the unchanged approved full verification command exactly once.
Do not remove tests, add skips/timeouts, relax authority, clip feedback, rewrite
sealed evidence, mutate the live database, install credentials or deploy.

Keep the report honest: no Windows certification, no live OpenRouter or direct
Anthropic API credential check, no successful mixed-provider certificate in
this pass. Gemini quota/model discrepancy remains unresolved. The formatting
baseline b2 was deployed at 06:04:41.850Z; update only that now-stale deployment
sentence in the imported audit report. This chat patch is not yet deployed.

Include normal changed-path and check evidence for all three signed criteria.
No UI change, screenshots or browser pass are needed for this transport-only
patch. Preserve the native plan/build/repair/review mechanisms and approval rules.
