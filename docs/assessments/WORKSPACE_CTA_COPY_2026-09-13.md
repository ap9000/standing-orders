# Context-specific task CTAs

Follow-up to the accepted workspace UI at `3e126f5`, requested September 13, 2026.

- On hold → **Review hold**; the explicit operator action is **Remove hold**, not “unhold.”
- Paused → **Review pause**.
- Builder disconnected → **Check connection**.
- Other waiting states name their available help: choose a project or agent, define the task, answer the question, or review the requirement.

One typed label map is shared by Work, focused chat, and task recovery links. These remain navigation links, not implicit resume operations. Existing destinations, authorization, CSRF, hold ownership, dispatch, and approval semantics are unchanged. This small copy follow-up was implemented directly in an isolated checkout, not submitted as a new Standing Orders build.

## Verification

- Typecheck and build passed.
- All 283 tests in `src/workspace-ui.test.ts` and `src/serve.test.ts` passed on the final source. New coverage checks every dispatch action label and the held-task journey across Work, chat, and task details. Reading those pages preserves the hold; only the existing POST removes it. The full repository suite was not rerun for this copy-only follow-up.
- Playwright CLI, synthetic fixture, 390×844: Work shows the new hold, pause, and connection labels. Work and task detail page widths both equal 390px, with no horizontal overflow.
- Clicked **Review hold**: the reason remained visible and status remained `held`. Clicked **Remove hold**: the hold disappeared, revealing the fixture's separate disconnected-builder requirement. Removing a hold does not bypass other requirements or claim the task is running.
- Viewport-only screenshots in the main checkout's ignored `output/playwright/workspace-cta-20260913/`: `phone-work.png` and `phone-hold.png`. Synthetic previews, not the installed application.

Saved with the existing `codex/workspace-01-20260913` work. No main merge, push, installation update, or deployment.
