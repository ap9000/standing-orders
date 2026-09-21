# Impeccable UI pass — 2026-09-20

Chat now shows one DB catch-up instead of repeating the portfolio overview. Conversation diagnostics sit in a disclosure. Current result-list state and ordering agree with Tasks; older attempts retain their own historical facts. The selected result uses one title.

Projects makes Open primary and Knowledge secondary, removes repeated setup copy, and preserves exact paths and clone consent. Tasks disclose partial retained output and unavailable earlier material while keeping failed checks and current damage visible. A regression fixes shortened-log caveats overwriting a damage warning for the same artifact.

Validation: typecheck and 381 affected tests passed. The synthetic desktop (1440×900) and phone (390×844) journey passed 308 assertions, including result → feedback → explicit revision, recoverable drafts, current and historical status, keyboard actions, 44px primary targets, empty states, long content, and actual check failures. Selected captures below were visually inspected. These fixtures are illustrative data, not live agent output. Physical mobile keyboard/device behavior was not exercised.

The Impeccable detector ran once on the changed UI files and reported three existing thick side borders; all three were reduced to 1px. The browser harness uses Playwright’s animation handling for settled captures, avoiding a paused-animation wait. No model review, automatic retry, authorization, or evidence requirement was introduced or removed by this pass. The full unchanged verifier runs separately through the native release gate.

- [Chat: one catch-up](desktop-chat-home.png)
- [Result: one title and current state](desktop-result-complete.png)
- [Projects: Open first](phone-projects.png)
- [Failed checks remain visible](phone-status-failure.png)
- [Partial output stays available](phone-status-complete.png)

[Machine-readable check manifest](checks.json) binds the affected sources and fixture scripts. [Browser results](browser.json) records each assertion and the selected captures.
