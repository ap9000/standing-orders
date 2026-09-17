# Open shared actions from All projects

The live multi-project installation sent a fresh signed-in secure action link to the project picker. The handler already checks the saved action owner and current project access, but the earlier project-selection redirect prevented it from running.

The exact numeric `/chat/action/:id` GET route now reaches its existing handler without a selected project. No selection, access, action state, password, CSRF, receipt or confirmation rules change. Unknown actions return their normal refusal. The regression extends the existing secure HTTP journey to both one-project and multi-project sessions; it reproduced a 303 redirect before the fix.

Focused verification: typecheck and 86 tests in chat-actions and telegram-mate pass. The synthetic browser journey now starts with three projects and All projects selected. Desktop 1440x900 and phone viewport 390x844 cover review, human acceptance, feedback, revision, long instructions, stale actions and missing actions. Full terms and one primary action remain visible; no helper text or extra step was added. Screenshot and source hashes are in evidence/shared-chat-actions/all-projects. These are Chromium fixtures, not a physical phone or live Telegram acceptance.

Prepared from merged verified main 8ad144a4a9650ff34588b648154c98c784ce98a4. The native final gate, independent review, CI and installed multi-project recheck must pass for the corrective candidate. Reuse the focused and visual evidence; do not duplicate the full native gate in a builder or reviewer.
