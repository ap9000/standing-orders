# Project knowledge: implementation and rollout

Status: first slice implemented on `codex/project-knowledge`; not merged, deployed, or published. The installed app is unchanged. This builds on review learning, rather than adding a second memory agent.

## Available in this candidate

- **Projects → Knowledge**, also reachable from Settings → Project knowledge.
- Editable project instructions; named text references; selected, committed `.md` or `.txt` project documents. References can be edited, refreshed, or removed.
- Change history with the original contents available on demand. Inspect an old version before restoring it. Restoration creates a new version; previous runs do not change.
- Planner and builder context consists of instructions plus relevant references. Reviewers inherit the source run's exact knowledge, including an explicitly empty version. Adding instructions after a build cannot retrospectively change its review.
- **Context used** on a result shows the supplied instructions, source versions, and references omitted because of relevance, size, or changed sources.
- Chat can read project instructions and a reference index, then request individual sources. These reads pass through its existing project-access and redaction boundary. Chat edits are not implemented: it truthfully directs users to Project knowledge.
- The existing reviewer assessment is told to compare findings against supplied knowledge and avoid redundant lessons. Learning adoption remains explicit; knowledge does not silently promote suggestions.

## Deliberate limits

Instructions: 4 KB. Up to 12 references, 12 KB each. At most three references selected within a 24 KB content budget. Selection uses bounded lexical relevance; titles and project paths receive greater weight. No external search service, embeddings database, crawler, extra reflection agent, or timer.

Project file references must be tracked regular text files. Reads use exact Git blobs, never symlinks or arbitrary filesystem paths. Changed or unavailable sources are excluded until refreshed. Pasted references do not claim to track an external source automatically. URLs, uploads, and connected document services are not implemented.

Preferences do not grant permissions, broaden approved scope, change verification, or override repository instructions. Reference contents are explicitly treated as untrusted source material. Model compliance is not a security guarantee; existing approval and execution gates remain authoritative.

Storage is provider-independent and project-isolated. Versioned contents and immutable run snapshots live in the existing database. This is not an automatic `AGENTS.md`/`CLAUDE.md` rewrite and does not export knowledge to other tools yet. No cross-project sharing.

## Verification

- `npm run typecheck` and build passed in the isolated checkout.
- Final focused command: `npx vitest run src/project-knowledge.test.ts src/mate.test.ts src/mate-doors.test.ts src/planner.test.ts src/builder.test.ts src/reviewer.test.ts src/project-learning.test.ts src/project-access-ledger.test.ts`: **349 passed, eight files, no skips**.
- Coverage includes access and CSRF, concurrent edits with retained drafts, history restore, bounded selection, stale documents, unsafe paths/symlinks/secrets, immutable snapshots, empty-context inheritance, source/reviewer consistency, v58→v59 migration, and missing-history refusal.
- A real Claude subscription chat using the `opus` alias read the fixture's instructions and mobile reference. Final smoke: **two knowledge reads, zero proposals, three model steps**, successful response matching the saved guidance. It spent no API-dollar budget; subscription usage still occurred. This validates integration and recall, not a productivity improvement claim.
- Desktop and phone browser checks use a disposable local database and synthetic result fixtures, not production builds. Knowledge saved through the UI was visible in result context. Feedback created a revision within the same task. Missing verification remained visible on the synthetic result; nothing was falsely marked verified.
- Viewport screenshots, not full-page images: `output/playwright/knowledge-desktop.png` (1400×900), `knowledge-phone.png` (390×844), plus focused error/long-content/result evidence. Browser emulation is not a physical iPhone, Safari, or Windows certification.

Simplicity pass: removed a redundant instruction question; replaced three separate reference controls with one expandable reference; kept editing, removal, learning, and history behind disclosures. Short buttons remain single-line and at least 44 CSS pixels high. The phone knowledge view measured 390px document width at a 390px viewport.

## Remaining work, in order

1. **Deployment prerequisite:** separate the installed watcher from the development checkout and repair its runner credential using the previously requested authorization. Never rebuild the original checkout while it is coupled to that watcher. This branch uses schema **59**; only controlled rollout may migrate the installed database. No installed DB open/migration, token rotation, service restart, GitHub push, or npm publish was performed for this slice.
2. Run the unchanged approved full verification command once through Standing Orders for the final candidate, followed by normal release review. Focused implementation tests are not that machine gate.
3. Add confirmed, reversible chat proposals for saving/editing knowledge, using the existing proposal transaction and stale-version checks. Do not give chat an unconfirmed direct-write tool.
4. Run matched tasks with and without learning/knowledge across UI, backend, document, and recovery work. Compare correctness, repeat corrections, human interventions, and time/tokens. Keep permission and evidence checks unchanged. The smoke above is not this evaluation.
5. Only after measured need: better retrieval, lesson deduplication/conflict handling, explicit shared preferences, reusable procedures with applicability conditions, and portable repository exports. Broader references/connectors must preserve provenance, access boundaries, bounded loading, and refresh visibility.

## Research basis

- [Claude Code memory](https://code.claude.com/docs/en/memory): separate explicit instructions from learned notes; keep general instructions concise and specialized material scoped.
- [LangGraph memory](https://docs.langchain.com/oss/python/concepts/memory): memory type and ownership scope are separate concerns; background updates have tradeoffs.
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): prefer relevant context and on-demand detail over loading everything.
- [Anthropic agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): validate actual outcomes and track regressions, rather than treating agent assertions as evidence of success.

These informed the design; they do not prove this implementation improves every class of task.
