# Native chat flow — first pass

Implemented on `codex/native-chat-flow`, based on `514ecdb`. No UI framework or animation dependency added. No deployment or installed database migration performed.

## Before → after

| Surface | Change |
| --- | --- |
| Working reply | Large status card → quiet activity row, with recorded step/billing detail on demand and Stop always available. |
| Task state | Separate status/control surfaces → one visual group. Removed the duplicate planning explanation. |
| Decision | Repeated heading and recap → one heading, full Context disclosure, visible consequences and unchanged irreversible-action confirmation. |
| Result | Explicit Feedback section; Save note records feedback, Request changes creates the same-task revision. Evidence warnings remain visible in a neutral panel. |
| Review continuity | Fixed a reproduced bug: saving a note from Changes returned to Summary. The selected tab now survives successful and refused submissions. Return destinations remain allowlisted. |
| Project summary | Up to three recorded completions link to their task family. No invented “since your last visit” or verification claims. Failed evidence and active/broken families are excluded. |
| Knowledge | Saved instructions read first; editing is a disclosure. References become readable rows instead of stacked cards. Failed drafts still reopen the editor. |

## References adapted

- [Halaska](https://ui.halaska.com): compact decisions, results and recovery.
- [AICSS](https://www.aicss.dev): quiet activity and conversational controls.
- [Bencho](https://bencho.dev): restrained control treatment.

Patterns informed original HTML/CSS; no external kit code or assets copied. Torph and Typehug were deferred: neither is necessary for this interaction pass.

## Verification

- Typecheck and build passed.
- 53 focused tests passed across chat polish, chat continuity, result review and project knowledge.
- 10 selected server tests passed, covering exact approval, decisions, pending composer, result parity, mixed feedback, revision sealing and return navigation. Other server tests were not selected; no skips added.
- Chromium desktop 1400×900 and phone viewport 390×844: result → Changes → feedback → same-task revision. Desktop used general feedback; phone used a line annotation with long text. Both revisions still required approval. A desktop chat draft survived reviewing and creating a revision.
- Reproduced and rechecked the tab-reset fix in the browser. Phone feedback actions measured 44px high; document width equalled viewport width on inspected result, activity and Knowledge views.
- Scripted pending reply: details expand, Stop is available, and a next-message draft survives reply completion. No provider usage or actual agent build was involved.
- Visually inspected missing-verification warnings, long reference names, empty feedback and the empty task conversation. Knowledge failed-draft rendering and the populated/empty completed-work list were checked in focused DOM tests, not a separate browser journey.
- Motion is optional under `prefers-reduced-motion: no-preference`. Physical iOS/Safari keyboard, Windows and assistive-technology behavior remain unverified. No full release gate was run.

Local viewport screenshots are in `output/playwright/native-{result,feedback,knowledge}-{desktop,phone}.png`, plus `native-activity-phone.png` and `native-decision-phone.png`. These use disposable persisted records and synthetic evidence, not production execution proof.

## Remaining

- Final machine gate and release review before merging/deploying.
- Keep installed runtime/build separation intact: the root checkout is still used by the installed worker. This feature was built only in the isolated checkout.
- Older surrounding surfaces still expose raw task IDs and agent terminology; this pass does not claim a complete application-wide copy cleanup.
