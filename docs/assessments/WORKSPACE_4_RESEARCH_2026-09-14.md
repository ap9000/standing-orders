# Package 4: mobile research and implementation brief

Base: `235eb9188c4a7e4f5df0d3023ecf47d712ce4797`. Research before implementation, September 14, 2026. Signing and installation remain deferred. This is a refinement of the approved workspace plan, not a new frontend or orchestration system.

## References inspected

- [Mobbin](https://mobbin.com/): initially required login. The user then signed in; actual ChatGPT and Claude screens/flows were inspected as recorded below. The initial public captures (`workspace4-mobbin-home.png`, `workspace4-mobbin-public-apps.png`) contain presentation/logos, not app-screen evidence.
- [Linear mobile redesign](https://linear.app/changelog/2025-10-16-mobile-app-redesign): inspected its actual published navigation image and description. Glass is concentrated in the bottom toolbar; core workflows remain easy to reach. Adopt restrained navigation material, not blurry content panels.
- [Linear Mobile](https://linear.app/mobile): inspected the published composer image. Writing and relevant properties sit together near the keyboard. Adopt comfortable text entry and reachable actions; do not add an unused formatting toolbar or imitate native gestures with a new library.
- [Linear's interface refresh](https://linear.app/now/behind-the-latest-design-refresh): consistent action placement and reduced visual noise guide the hierarchy pass.
- [Apple tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars): keep top-level destinations predictable. Retain Chat / Work / Projects. Settings remains secondary. Keyboard handling must not hide navigation simply because an input has focus on a hardware keyboard.
- [W3C focus visibility](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html), [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), and [enhanced targets](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html): use these as verifiable checks, not inspiration screenshots. Check 320 CSS-pixel reflow, visible focus, and 44px primary controls. A horizontally scrolling diff does not justify whole-page overflow.

## Observed baseline → changes

### Logged-in Mobbin follow-up

The user signed in during research. Inspected [ChatGPT iOS screens and flows](https://mobbin.com/apps/chat-gpt-ios-a96b7f4c-6bfa-4c9d-a6b7-562160feb391/a0b14f48-3d1c-4286-828b-e95ad04fef10/flows), including **Adding a chat to a project** and **Giving a response feedback**. Captures: `workspace4-mobbin-chatgpt.png`, `workspace4-mobbin-project-flow.png`, `workspace4-mobbin-feedback-flow.png` under `output/playwright/`. These are now actual library screens, superseding the access limitation above. They show a quiet reading canvas, compact composer, short contextual menus, project rows, and response-adjacent feedback. Keep Standing Orders' three workspace destinations because it manages work beyond a single conversation; do not copy ChatGPT's information architecture wholesale or turn approval into a casual chat action. No bulk downloads or copied artwork enter the product.

Also inspected [Claude iOS](https://mobbin.com/apps/claude-ios-d4f0ada4-3325-4c8e-9c3e-1115dbd469c9/754cdd57-a1c5-4553-b8fa-1c3c4eba8b2e/screens): its chat canvas, composer, Add to Chat sheet, chat list, and project detail highlights (`workspace4-mobbin-claude.png`). Lists and content rely on typography and dividers; bounded settings use grouped surfaces. This supports removing the extra phone result card while retaining distinct actionable approval cards. Static flow sequences were inspected, not instrumented interactions inside the original apps.

| Observed on the built baseline | Intended change |
| --- | --- |
| Project selector has a card border around its own pill; header consumes 90px at 390px | One compact selector surface; consistent 44px header controls |
| Start-chat card repeats confirmation guidance and long password helper text | One purpose sentence, concise password label; retain subscription/budget and session terms before consent |
| Review sits inside an extra bordered card on a phone | Full-width reading surface, consistent gutters, quiet dividers; unchanged Summary / Changes / Checks and both feedback paths |
| Project overview opens as a horizontal card carousel | Vertical, thumb-sized project rows inside the existing overlay; focus enters and returns, Escape closes |
| Popup focus restoration is incomplete; no visual-viewport keyboard handling | Scoped menu dismissal/focus behavior and keyboard-aware bottom spacing; never intercept Space or editable text |
| Approval repeats its heading, a paragraph, counts and two jump links before the exact plan | **Review plan**, one short wait sentence, then the full unchanged terms and password confirmation |
| Shared stylesheet is 184,288 characters inside each rendered page | Content-addressed, cacheable, compressed **static CSS only**; authenticated HTML/fragments stay no-store, CSP retains protections |

The baseline chat-start DOM was 205,466 characters. These are DOM sizes, **not transfer measurements**. Capture actual HTTP bytes on identical fixtures before claiming savings. Target at least 30% less warm-navigation transfer and no unexplained cold regression.

## Build and acceptance boundaries

Use existing renderers, navigation, approval POSTs, revision lineage, CSS tokens, and fixture. No new UI dependency, new permission posture, hidden approval terms, or fake progress. Source changes stay on a package-specific branch.

Run focused HTTP/presentation regressions and typecheck while editing. One desktop and one phone result-to-revision journey; additional 320/430 and fresh 1280/1440 empty-chat checks are explicitly required by package 4. Cover long titles, approval, Work, damaged evidence, menus, reduced motion, focus return and zoom/reflow. Record viewport-only screenshots and actual transfer/cache measurements. Reuse earlier unchanged authority tests rather than duplicate their browser journeys.

Real iPhone Safari (keyboard, browser chrome, rotation, safe areas, foreground/Back), signed-Mac installation and physical Windows remain explicit external acceptance gates. Synthetic viewport/keyboard tests cannot certify those devices. No product-wide 9–10 score without the remaining real-work and device evidence.

Implementation and measured evidence: [package 4 result](WORKSPACE_4_MOBILE_RESULT_2026-09-14.md).
