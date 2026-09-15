# UI anti-pattern pass

Follow-up to `f53b7f1`, on `codex/native-chat-flow`. These are design findings in our screens, not a claim that a gradient or a card is inherently bad.

## Findings and changes

| Finding | Change | Reference |
| --- | --- | --- |
| Blue/lilac ambient wash and glowing assistant marks compete with content. | Neutral page surface; quiet assistant mark; removed the empty-state logo tile and receipt glow. Existing state colors remain. | [NN/g: Aesthetic and minimalist design](https://www.nngroup.com/articles/aesthetic-minimalist-design/) — prioritize information over decoration. |
| Nested cards give routine metadata the weight of a decision. | Flattened status details, agent setup, activity, feedback history and decision options. Result is a plain page on phones; disclosure rows keep 44px targets. | [NN/g: Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) — secondary information stays available without dominating the primary view. |
| “read 2 / proposed 0 / 3 steps” badges resemble achievement signals, not useful outcomes. | Recorded activity lives inside an Activity disclosure. No values fabricated or removed. Broken agent setup remains visible instead of being collapsed. | [NN/g: AI chatbot design guidelines](https://www.nngroup.com/articles/ai-chatbots-design-guidelines/) — keep conversation short with relevant detail on demand. |
| Generic prompt buttons reappear after every response. | Suggestions appear only at the start. Result and approval actions retain priority during a conversation. | [GOV.UK: Button](https://design-system.service.gov.uk/components/button/) — distinguish main and secondary actions. |
| Jargon and repeated instructions force unnecessary reading. | “check the proof” → “review results”; “revise scope” → “adjust the plan”; short task placeholder; removed the generic warning preamble, not its actual warning; decision ID moved into Context. | NN/g's minimalist-design guidance above. |

## Verification

- Typecheck and build passed; 44 focused tests passed across polish, continuity and result review.
- 14 selected server tests passed: empty and populated chat, live fragments, decisions, failed replies, exact approval, feedback and same-task revision. Other tests were not selected; no test skips added.
- Chromium 1400×900 and 390×844: result → Changes → feedback → revision. General feedback on desktop; a long line annotation on phone. Changes remained selected after Save note; both revisions returned to the original task and required approval.
- Desktop chat draft survived feedback. Phone actions measured 44px high with no horizontal document overflow.
- Inspected the empty phone chat, missing-verification state, final desktop and phone result views, and desktop dark theme. Checked native Activity disclosure by mouse and Space. Dark/reduced-motion preferences were emulated; this is not physical-device or assistive-technology certification.
- Local screenshots: `output/playwright/antipatterns-desktop.png`, `antipatterns-phone.png`, `antipatterns-empty-phone.png`, `antipatterns-dark-desktop.png`.
- Disposable records and scripted provider response only; no real agent build, subscription usage, full release gate, merge, push or deployment.

## Remaining

The current-task status and selected historical result can legitimately differ. Both remain; deduplicating them safely needs version-aware rendering, not unconditional CSS hiding. Two History disclosures and some generated revision wording also remain opportunities for a separate information-layout pass. This is not an application-wide design sign-off.
