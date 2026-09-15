# Learning from reviews

Research and proposed implementation · September 14, 2026 · baseline `859d7b0`.

## Decision

Make reviews improve future work as well as the current result. Start with small, evidence-backed project lessons; evaluate Standing Orders improvements separately. This is adaptation of project context, tools and workflow—not training the underlying subscription models or letting agents change their own authority.

This document is a plan. No learning runtime, settings, scheduled jobs or automatic promotions are implemented by it.

## What exists and what changes

| Layer | Today | Proposed end state |
| --- | --- | --- |
| Current task | Exact review comments, criteria, evidence and same-task revisions. Bounded automatic repair under existing signed modes. | Fix actual defects through that same path. Separate optional improvements from required corrections. |
| Project | Commands/conventions live in source and instructions; prior reviews are retained. No reusable project-learning lifecycle. | Retrieve a few relevant, verified lessons for later tasks; show their sources, applicability and reset controls. Turn durable prevention into normal code/test/doc changes. |
| Standing Orders | Repairs are made when an operator notices recurring orchestration failures. | Group authorized local evidence about repeated workflow failures; propose and test one reusable improvement before a normal controlled release. |

Inspected: `src/reviewer.ts` (read-only evidence review and atomic ingestion), `src/review-context.ts` (bounded source context), `src/dispose.ts:609` (existing repair admission), `src/result-review.ts` (requested-change filtering), and `docs/PRIORITIES.md:191` (routing implemented, learning not started). Existing coordinator proposals manage task actions; they are not already a project-memory API.

## Research informing the design

- [OpenAI, Harness engineering](https://openai.com/index/harness-engineering/): keep durable knowledge in the repository, with a short instruction index and enforceable conventions. Our application: prefer a regression, reusable helper or short linked lesson over growing one giant instruction file.
- [Anthropic, Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps): independent evaluation and concrete product criteria improve results, but evaluation still misses defects; simplify harness components as model capabilities change. Our application: extend the existing review, not add a mandatory council of agents.
- [ACE](https://arxiv.org/abs/2510.04618): structured incremental context updates address information loss from repeatedly rewriting a summary. Our application: individual lessons with evidence and supersession, retrieved selectively rather than appended wholesale.
- [GEPA](https://arxiv.org/abs/2507.19457): execution feedback can drive proposed prompt changes and comparative evaluation. Our application: test a candidate workflow against its baseline before promoting it; do not assume a plausible reflection improves performance.
- [Rethinking the Evaluation of Harness Evolution](https://arxiv.org/abs/2607.12227), a July 2026 preprint: matched-budget comparisons and held-out tasks challenge claims of general improvement. Our application: measure generalization and time/token overhead, not just success on the failure used to design the fix.
- [Anthropic, Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): use actual outcome checks, balanced positive/negative cases, isolation and calibrated judgment. Our application: include false-success, unnecessary-action and regression cases, not merely more successful demos.

These are design inputs, not evidence that Standing Orders already benefits. Published benchmark gains do not predict our production gains.

## The review loop

1. **Judge the current result first.** Compare approved intent with the exact diff, checks, screenshots and available runtime evidence. Keep `cannot-tell` distinct from failure. Missing review context is not automatically a product defect.
2. **Identify the kind of finding.** Required correction, optional product improvement, reusable project lesson, or Standing Orders issue. A new feature idea must not silently expand the current task.
3. **Propose only useful learning.** Reuse the existing review response for zero to two concise candidates. Zero is normal. Candidates cite source artifacts and say what should happen differently and when. Positive patterns can qualify too.
4. **Prove before reuse.** A verified observation can become a narrowly scoped fact. A proposed remedy remains unproven until its revision passes the relevant checks. User acceptance/preferences, contradictory evidence and later regressions can update its status. A passing machine gate alone does not prove product quality or every lesson in that run.
5. **Use it on later work.** Select applicable project lessons at run admission; record the exact IDs/versions supplied. Feed the same selected context to planner, builder and reviewer when relevant. Snapshot it for that run; do not silently change active work's guidance.
6. **Measure and maintain.** Track recurrence and later outcomes. Merge duplicates, supersede contradictions and retire stale lessons. A lesson being cited is evidence of use, not evidence of benefit.

The reviewer remains read-only. It proposes; the controller validates and records. Repository writes happen through existing scoped build/revision tasks. Learning failure must not strand an otherwise completed task or rewrite its review. Required review parsing/binding stays strict; optional learning is a separately validated, retryable record with a visible failure, not a reason to accept malformed core judgments.

## Project ownership and storage

- Repository identity plus explicit project admission defines the boundary—not display name or an assumed globally unique local path. No cross-project retrieval by default.
- Keep authoritative outcome/provenance records in Standing Orders, referencing immutable run/artifact IDs and hashes. Do not copy transcripts into every repository.
- Team-shareable conventions should be versioned in a small project-owned file, proposed as `docs/agent-lessons.md`, or folded into existing relevant docs/tests. This file is a reviewed projection, not a competing database. Keep `AGENTS.md` an index; do not auto-append every observation.
- Minimum lesson: project, kind, concise observation/action, applicability, evidence references, status, version/supersession, and which runs used it. Commands also need working directory, platform/toolchain and relevant configuration fingerprints. An old successful command is advice, not permission to execute it or skip discovery.
- Statuses distinguish proposed, verified, retired and rejected. Missing/tampered evidence, changed configuration or conflicting current code makes reuse ineligible or explicitly uncertain. Reset disables future retrieval without deleting historical evidence.
- Reuse only a small bounded selection, initially up to five relevant lessons. Deterministic path/phase/platform matching first; no vector database or general memory service in the first slice.
- Guidance never overrides the user's request, signed scope, repository instructions, provider route, permissions, budget or verification command. Repository text and logs are untrusted input, not a route for installing higher-priority instructions.

## Program-level improvement

Separate three things: project facts, installation-wide operational patterns, and upstream Standing Orders product changes.

On one installation, aggregate only projects the operator has authorized for this purpose. Store generic failure signatures and references; do not share source, credentials, private paths or lessons between unrelated users. Upstream issue/PR export is explicit opt-in, redacted and inspectable. Open-source users receive general improvements through ordinary reviewed releases, not invisible global memory.

An event-driven summary can suggest a program improvement after a reproduced system defect or recurrence across distinct task families. Repeated attempts on one task are not independent evidence. A single clear critical defect need not wait for a recurrence threshold.

Example: review packets omit needed sections of large files. Propose a source-bound context selection fix in the Standing Orders project, replay the failure with a separate non-regression case, independently review it, and use the normal update/recovery flow. Do not teach reviewers to assume omitted code is correct or enlarge every cap as a substitute for diagnosis.

Use a baseline/candidate comparison with the same model versions, comparable inference budget and environment, a held-out set, and repeated trials where model behavior is variable. Track completion without technical rescue, escaped defects/false verification, repeated failure rate, wall-clock time and tokens. Subscription use still has latency and usage costs even when dollar caps are off. Improvements with no demonstrated benefit should not be promoted.

No hot-patching an active worker or its evaluator. The candidate cannot weaken its own approval, evidence or success criteria. Start with one candidate at a time using normal tasks/worktrees and existing evaluation scripts, not a new optimization scheduler. Program-wide prompt/routing/runtime changes require explicit release authority and rollback.

## Simple UI and autonomy

Keep the result's current primary action. Only show a collapsed **Learned from this task** section when there is something useful, with a short lesson and its evidence. Use **Save lesson** for a proposed rule, or a quiet saved status for an eligible automatically recorded fact; details expose applicability and removal.

Project settings: **Use verified lessons**, plus a compact list with source, disable and reset. Verified factual reuse can be automatic once enabled. Instruction/code changes use normal approval or an already-authorized bounded project policy; a generic Full access toggle is not authority to change global rules. Unrelated product improvements become one proposed task, not surprise additions to the current revision.

Program improvements belong in existing Admin/Settings and the normal task workflow, not a new top-level sidebar section. Do not block a finished task waiting for a global improvement. No new agent time limits, mandatory reflection stage, model training or automatic model switching.

## Implementation order and acceptance

**1. Capture useful lessons in review.** Add a backward-compatible optional learning artifact/contract, exact evidence validation and deduplication keyed to source review/finding. Reuse existing artifact/proposal conventions; add only the minimal storage needed. Legacy reviews remain readable. Invalid learning, replay and restart create neither duplicate lessons nor lost core review results. Preserve informational-note filtering.

**2. Reuse project lessons.** Add bounded selection and a per-run context snapshot, then the small disclosure/settings controls. Verify a real corrected task creates a lesson and a different later task actually receives it. Include contrary/stale lessons, hidden projects, prompt-injection text and disable/reset behavior. A repeated failure becoming a code regression is preferable to adding redundant prose rules.

**3. Test one Standing Orders improvement end to end.** Start with the observed review-context gap. Propose a bounded system repair from review evidence, run it as an ordinary task, compare the old and candidate behavior on development and held-out examples, review, then stage a controlled update only under release authority. Local improvement must not export private project content.

**4. Broaden only after measured benefit.** Compare enabled/disabled learning on matched fresh tasks. Include UI, backend and environment/recovery work. Keep original failures in the report; report sample size and uncertainty. No “self-improving” claim based only on saving lessons, a larger test count, or the agent's own score.

Lean verification: focused parser/store/retrieval tests for changed behavior; one existing desktop and phone journey for UI, including empty/long/error states; unchanged full verification once at each native final candidate gate. No duplicate broad suite per reviewer. Runtime implementation and visual verification remain future work.

## Approved first implementation: quiet learning and a settings ledger

The user approved project learning and explicitly requested a settings ledger for diagnosing changes. Implement steps 1–2 with the following boundaries; program improvements are tracked proposals in this slice, not automatic modifications of Standing Orders.

- Review may propose zero to two project lessons or system-improvement suggestions with exact source evidence. Reviewer observations are not automatically promoted to active guidance. A person can explicitly adopt a supported project lesson; adoption is not labelled independent proof of its universal truth. Once enabled, eligible adopted lessons are reused automatically. No extra reflection agent or mandatory task-completion gate.
- Settings → Learning is discoverable from settings even when notification credentials are not configured. Keep it inside existing settings navigation, not a new primary tab. Show project selection, reuse toggle, lesson status and a paginated, append-only changes ledger. Quiet task disclosure only when relevant.
- Ledger entries show when, who/which agent, project, concise change, before/after state, reason/evidence, and affected run links. Record proposals, adoption, disabling/reset, invalid learning capture, selection for a run, and visible outcome references. Do not call usage an improvement in quality. Show system suggestions as suggestions, never applied changes.
- Disable stops future selection; reset disables active project guidance without erasing history. These operations are authenticated, project-admitted, CSRF-protected and stale-state checked. A frozen run snapshot is not silently rewritten. Disabling guidance does not roll back code or change an active approval; tell the user that distinction in details.
- Preserve exact snapshot payload and source provenance per run, including an empty selection where relevant. Revalidate evidence and configuration applicability before selection, enforce bounded context, and treat all lesson text as untrusted advice. Do not execute remembered commands or let lessons override verification/approval/provider constraints. Use code/config fingerprints and explicit phase/path/platform applicability rather than reusing stale commands blindly.
- Existing live installation/database must not be migrated for development. If storage requires a versioned migration, test it on disposable databases, fence old readers correctly, and report deployment requirements. No side database or unversioned DDL to evade migration safety. A failed optional learning write is recorded as a learning issue without rewriting or blocking valid core review results; make recovery idempotent.
- Reuse the existing result/browser fixture for desktop 1400×900 and phone 390×844: inspect result, save a lesson, see ledger, select it for a later run, disable it, verify no future selection and retained history. Include empty, long, stale and denied cases; test ledger pagination and project isolation. Separate synthetic provider tests from real-provider evidence.
- Do not edit repository instruction files, auto-export private information, run global optimization, change global permissions/models, or add a new scheduler. Minimal additive modules and storage only. Record exact checks, limits and remaining program-level work in the implementation assessment.
