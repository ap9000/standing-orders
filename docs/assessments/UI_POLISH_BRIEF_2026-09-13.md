# UI simplification and lightweight motion — 13 September 2026

## Requested outcome

Improve the current Standing Orders UI against real Mobbin examples, submit the work through Standing Orders, and independently score the rendered output. Keep the existing server-rendered architecture and all real controls. This is a coherent polish pass, not a new design system or an orchestration rewrite.

## Reference inspection and limitations

- Visually inspected Mobbin's public [Jasper Application Homepage](https://mobbin.com/explore/screens/5c61518b-f03f-4c26-8ec1-6215c153ecd3): quiet navigation, generous but intentional whitespace, one central composer, a few subordinate quick actions. Adopt the hierarchy, not the branding or artwork.
- Read the public description of [Front Inbox Email Thread](https://mobbin.com/explore/screens/3e29dd35-0c1d-4f71-831b-af35c13bf1ec): navigation, list, and focused detail. Screenshot access was subsequently denied by browser security; do not describe this as a visually inspected reference.
- [Mobbin web examples](https://mobbin.com/explore/web) exposes public reference pages, but full libraries/flows require login. No paid or authenticated collection was reviewed and no animation video was inspected. Motion specifications below are our design decisions, not measurements from Mobbin.

## Baseline observed

Live console: http://127.0.0.1:4180. Viewport screenshots, not full-page stitches:

- `output/playwright/ux-before-chat-desktop.png` — 1440 × 900.
- `output/playwright/ux-before-chat-mobile.png` — 390 × 844.
- `output/playwright/ux-before-task-mobile.png` — 390 × 844.

The installed console is older than the local source. Preserve the newer local phone-chat continuity fixes and verify the implementation against a snapshot of the current working files, NOT old main alone. Do not regress drafts, request idempotency, reconnect behavior or focus handling.

Observed problems:

1. Chat's first phone viewport is occupied by projects, headings, technical session-error copy, provider chips and an overview. The main chat action is missing from that first screen.
2. Desktop has a sidebar AND a persistent project-card column AND portfolio summaries. These duplicate navigation/context and leave a narrow conversation column.
3. Session-expiry copy says 'admitted projects', 'mate session was minted', and 'ends the old one'. It describes internals, not what the person needs to do.
4. Task approval starts with a very long goal, exclusions, paths and acceptance rules before reaching the approval action. Users still need those exact terms available, but need a concise orientation and an obvious review path first.
5. Metadata and status have nearly the same prominence as useful work. Repeated rounded boxes, badges and explanatory footnotes increase scanning cost.

## Implementation, in priority order

### 1. Chat and navigation hierarchy

Make chat feel like the main workspace: one clear heading/context row, one primary composer or explicit reconnect/start action, secondary project context collapsed by default on phone. Preserve the desktop collapsible rail and mobile bottom navigation. Avoid a permanent second sidebar unless the user opens it. Use compact, readable overview summaries with expandable attention items. Retain important warning/permission meaning without broad red/yellow panels for routine state. Replace the technical session error with plain language and a correctly scoped action; do not silently widen the admitted projects or bypass the required confirmation. Keep provider/model/subscription details under an accessible disclosure where possible. Don't show meaningless $0.00 as if it were a subscription charge.

### 2. Task, approval and result hierarchy

Lead with the task title, a short status explanation, and the next action. Keep both Overview and Ask modes. Group exact scope terms, path limits, agent routing, limits and history in clearly titled disclosures. Never truncate, paraphrase away, pre-accept, or hide the exact approved terms from the review path. Where a long scope requires reading, provide a clear 'Review scope' jump/expansion rather than pushing the only action past a wall of metadata. On result pages, emphasize outcome, changed files and real proof first; keep both annotated diff revisions and ordinary revision text intact. Existing safe stop/cancel/retry/approval behavior must survive. Technical diagnostics stay available under Details.

### 3. Small, consistent motion and mobile fit

Use CSS-first feedback: roughly 140–200 ms hover/press/focus state transitions and at most 220 ms opacity/transform entrance transitions for overlays. No new runtime or animation dependency, no animated blur/filter/layout dimensions, no perpetual decorative pulsing, no page-wide entrance parade. Respect prefers-reduced-motion. Focus and keyboard behavior must remain predictable when opening/closing a drawer or disclosure. Use consistent borders, radii, restrained shadows and a calm neutral palette; do not erase semantic states or contrast. Phone controls and the composer must fit at 320, 390 and 430 px widths, with readable 16 px inputs, safe-area handling and comfortable primary touch targets.

## Proof and scoring contract

Required output is a code branch plus real evidence, not a design memo. Use an isolated demo/fixture, never real task approvals or cancellation for UI tests. No npm publication, GitHub push/merge, service upgrade, new permissions, credentials, or data migration is part of this task.

- Capture before/after viewport screenshots at 1440×900, 390×844 and 320×740. Include chat ready/start state, a pending/action-card state, a long task approval, a result/diff/revision state, and mobile navigation open. Label fixtures honestly. Do not screenshot a DOM mock and call it end-to-end proof.
- Exercise the relevant controls and preserve existing request/draft/reconnect and annotation revision tests. Run TypeScript build and focused UI/continuity tests; record exact commands, results and unavailable checks.
- Verify no document-level horizontal overflow; ensure bottom navigation does not obscure the composer or primary action. Check reduced-motion, keyboard focus, drawer Escape/focus return and long task/project names.
- Report served HTML/inline JS/CSS size before/after using the same representative fixture. No new runtime dependencies. Explain any meaningful payload increase. Do not claim smooth frame rate from a static image.
- Save a concise assessment in `docs/assessments/UI_POLISH_RESULT_2026-09-13.md` with screenshot paths, exact tested revision, limitations, and completed acceptance mapping.

Independent score, each dimension out of 10: hierarchy/clarity (25%), workflow cohesion (25%), mobile fit (20%), visual consistency (15%), motion/accessibility/performance (15%). A 9 requires all primary flows verified, no overlap/overflow, readable status and a clear next action. Unverified motion or missing state evidence cannot receive full marks. No final implementation score until actual output is inspected.

Baseline judgment: 6/10 for the installed UI on the inspected surfaces (subjective design assessment, not a measured product-wide reliability score). The biggest gap is information hierarchy, not lack of visual effects.
