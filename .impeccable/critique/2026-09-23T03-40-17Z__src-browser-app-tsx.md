---
target: Standing Orders web console
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-23T03-40-17Z
slug: src-browser-app-tsx
---
Method: dual-agent (A: design review · B: detector + browser evidence). Evaluated live build 68c7412 (before the palette unification in b8da991).

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | No needs-you count in the workspace nav; Crew rail lists Complete items first |
| 2 | Match system / real world | 1 | "Prepared candidate … checked out by the machine; no agent ran", "plane", "fleet", "portfolio" |
| 3 | User control and freedom | 3 | Drafts kept, stale approvals disabled; no undo on one-click saves |
| 4 | Consistency and standards | 1 | Two shells, two navs, two wordmarks, two palettes; mixed casing |
| 5 | Error prevention | 3 | Strong approval ceremony; destructive "Unpair" styled primary |
| 6 | Recognition rather than recall | 2 | Settings tell people to type CLI commands; build numbers vs task names |
| 7 | Flexibility and efficiency | 2 | ⌘K only on workspace pages; no shortcuts for approve/complete |
| 8 | Aesthetic and minimalist design | 2 | Crew rail repeats Tasks; 3,250px Settings; run-on build strip above results |
| 9 | Error recovery | 3 | Honest delivery/connection messages |
| 10 | Help and documentation | 2 | README screenshots show the old navigation; no in-app help |
| **Total** | | **21/40** | Acceptable, low end |

## Design specificity
Visually category-interchangeable (AI-chat kit layout; dark glass "Vercel/Linear" console); specific in copy and the approval ceremony. The amber "waits on a person" accent and the standing·orders wordmark were lost in the new shell. Detector: 0 file findings; browser pass found undersized 10px UI text (Crew badges and project labels), long line lengths in Settings copy, dark-glow and thin-border-wide-shadow on the legacy chrome, flat type hierarchy on legacy pages, 17-18 distinct font sizes on task pages (two type scales).

## Priority issues
- [P1] Two shells, two identities (layout/colorize) — partly fixed in b8da991: one palette, dark mode, most pages in the shell; six live ops pages remain on console chrome.
- [P1] "Wake me only for these" lost: no attention color, no needs-you count, Crew rail shows Complete first (colorize + distill).
- [P1] Result page buries the verdict: build strip above title (fixed in b8da991), duplicate H1, hash in outcome, four competing next steps, byte counts (distill + clarify).
- [P2] Plain English and casing: lowercase headings/buttons, jargon, four time formats, header titles from raw page titles (clarify).
- [P2] Settings split and overlong: ~12 saves, 7 inline links, CLI instructions, two Telegram places (layout).

## Persona red flags
- Alex (power user): ⌘K missing on legacy pages; ~12 saves in Settings; duplicate project names.
- Jordan (open-source first-timer): opens on three jargon "Prepared candidate" lines; names differ per surface (task list/Tasks, portfolio/Projects); CLI-only setup steps.
- Casey (phone): navigation model changes per page; tap targets under 44px (30/59 on task page); 10px labels.

## Minor observations
Duplicate H1s on /projects, /settings, /r/*, /t/*; 10px text in badges; destructive primary "Unpair my phone"; mixed brand marks; login inputs 38px; digest setting echoes its value.
