---
target: Standing Orders web console
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-23T04-58-38Z
slug: src-browser-app-tsx
---
Method: dual-agent (A: design review focused on text density · B: detector + browser evidence). Live build browser-1d90fc9 (main 1b0b370).

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | "Checks passed" buried mid-sentence on /t and /r |
| 2 | Match system / real world | 2 | "plane's re-run check", "sealed inherited review context", "no publication grant", "MCP filing credential" |
| 3 | User control and freedom | 3 | Two open free-text forms on a Complete result |
| 4 | Consistency and standards | 2 | /settings/telegram and /inbox still in console chrome; lowercase H1s |
| 5 | Error prevention | 3 | "Unpair my phone" styled primary |
| 6 | Recognition rather than recall | 2 | No New task in the shell; terminal commands as instructions |
| 7 | Flexibility and efficiency | 3 | ⌘K, CLI; no bulk actions |
| 8 | Aesthetic and minimalist design | 2 | /settings 3,020px with 9 Save buttons; repeated "output shortened" |
| 9 | Error recovery | 3 | Clear API-key states; partial logs not actionable |
| 10 | Help and documentation | 2 | Always-on explanation instead of contextual hints |
| **Total** | | **25/40** | Acceptable (was 21) |

Detector: 0 CLI findings; browser visible findings down (chat 23→1, settings 34→2, models 4→1); remaining real: 10.4px "membership", 10.88px build facts, 9.6px hidden build-fact labels, 10.4px diff "comment" buttons, 11px radio descriptions (3.71:1 in light). Words: chat 163→68, settings 641→291, knowledge 151→98. Every page dark in dark mode; no overflow.

Priority issues: [P1] Result/Task read as documents — verdict chip row, forms behind buttons, evidence table with human sizes. [P1] Two navigation models remain (Telegram settings, Inbox) and no New task in the shell. [P1] Settings is one long form with 9 primary actions — status rows + Manage, save on change. [P2] Internal vocabulary. [P2] Type/case consistency, monospace prose, 11px low-contrast descriptions.
