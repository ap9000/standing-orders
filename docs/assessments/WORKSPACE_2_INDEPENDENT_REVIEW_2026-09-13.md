# Continuous chat — accepted locally

Accepted September 13, 2026 (verification finished September 14, 04:20 UTC).

Standing Orders build **1551**, Claude Opus subscription, repaired the seven annotations on build 1550. The accepted source is `3ab5505b962b477a37edb11a7e545d8f245ac6cf`. Integration commit `9fe984f8e908e9fd23b93fedf0c9a8bd840eef01` on `codex/workspace-01-20260913` has the **identical Git tree**: `16bda702548c3ce83b56f6b1d077d91e6d530297`. Subsequent handoff changes are documentation only.

At acceptance, main's existing uncommitted work was preserved and no publication or installation update was performed. After the user's subsequent merge-and-push approval, main was fast-forwarded to `f9d954b63bf46dd8c3f4eb2b35a5fecfaceccd58`. All local changed files were already represented in that branch or its baseline history; a recovery stash retains the original checkout. The source still matches the verified build. This does not publish an npm release or update the installed app.

## What is finished

- Live replies and task updates preserve the composer, draft, selection, focus, and reading position.
- A late receipt cannot clear a newer submitted message. Invalid refreshes retry without accepting a version that was not displayed; task updates deferred during editing arrive after blur.
- All-projects chat refreshes without a false sign-in warning, retaining the existing project and account checks.
- Explicit reconnect restores the same account's draft under a new session/request key without sending it. Another account cannot inherit it.
- The plan card says **Plan ready**, shows a short outcome and compact facts, and has one **Review plan** button. Exact approval terms remain inside the disclosure. A changed plan preserves the open form/password but requires reviewing the new terms.
- Existing result, normal feedback, and diff-annotation revision paths remain available. This package does not implement the larger result-panel redesign in package 3.

## Evidence

The unchanged machine gate passed on its **first attempt**:

```sh
npm run typecheck && npm test -- --run --reporter=dot --no-file-parallelism && npm run build
```

**163 test files; 2,832 tests passed, 23 existing skips.** Test duration: 291.18 seconds. No tests were skipped or timeouts enlarged for this repair. Native proof verdict: **verified**; no exception/override.

Additional checks:

| Check | Result |
| --- | --- |
| Independent adversarial browser-script harness, rerun on the sealed head | 9/9 |
| Focused continuity, mate, and server tests | 351 passed |
| Request → proposal → separate execution approval browser journey and recovery cases | 51/51 |
| Existing UI browser suite | 76/76 |
| Existing workspace browser suite | 227/227 |

Independent headed Chromium follow-through used a separate two-project/two-account in-memory fixture and scripted replies, with no live provider or live database:

- Same-account reconnect restored unsent words with a fresh key and no recorded turn; signing into the same tab as another account left its composer empty.
- A reply arrived while typing: same composer/textarea objects, draft, selection 3–8, and focus retained.
- Changing scope preserved the exact form/password. A direct stale approval POST was refused; explicit current-plan review loaded the new digest.
- Result → View/Annotate → one line comment → one unapproved revision → **Revision ready** in chat worked. Returning to the prior task restored its separate draft.
- Inspected 1440×900, 390×844, and 320×740 viewport screenshots. The 812-character plan's summary card measures 267.6px high at 390px and 309.8px at 320px; Review plan is one line and 44px high. Full approval text remains available, with no document-level horizontal overflow.

Standing Orders stores the immutable proof as artifact **499**, final diff as **496**, and current screenshots as **500–507**, all on run **1551**. Their file hashes were independently checked against the stored records. Artifact 506 is the current 390px plan; 507 is the 320px plan. The verifier log is `1551/check-log.txt` in the configured evidence store.

The tracked `evidence/workspace-2-chat-2026-09-13/` directory is **historical build-1550 evidence**, not the current plan-card appearance. It is retained for provenance. Current captures can be regenerated with `node scripts/workspace-chat-proof.mjs --strict`; its default output is the ignored `output/playwright/workspace-2-chat-2026-09-13/` directory. Root's additional local screenshots and detailed observations are in `output/playwright/workspace-chat-20260913/` in the main working checkout.

## Limits and next work

This proves the bounded package in synthetic Chromium and the normal repository verifier, not physical iPhone Safari, Windows, or universal unattended reliability. Drafts remain same-tab storage, not cloud sync. Publication and deployment still require their own authorized workflow.

Package 2 is complete locally. **Package 3 — result-first review and one revision loop** remains the next planned body of work: make the deliverable central, share Summary/Changes/Checks views, and improve feedback/back navigation without creating a new orchestration engine.
