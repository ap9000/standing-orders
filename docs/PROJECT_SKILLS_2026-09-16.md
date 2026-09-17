# Project skills

User-approved first version: one library, import a standard skill, enable it for a project, and run a real agent test. Project agents inherit the selection. Existing runs retain their exact versions. Chat reads the same inventory and opens the exact management control; it must not send users to unrelated settings or imply a skill supplies missing execution tools.

Start from verified main 443936f8a919b1d5afd10b0e550cb35cb6f8e0d5. Preserve the original dirty checkout and all historical evidence. No default installation on every project, marketplace service, provider permission expansion, or replacement of reviewer isolation.

## Deliverable

- Project Skills page with one Add skill action. Import a public GitHub skill folder, a local folder through the browser, or pasted SKILL.md. Show source, contents and compatibility before enabling. Reuse an already imported skill across authorized projects. Retain versions and change history.
- Durable, project-scoped enable/disable with stale-form and actor/project checks. Imported skill files never execute during import. Preserve supporting files and relative paths; reject unsafe paths, links, secrets and oversized packages. Provider-specific plugins and tool grants do not become authority.
- Freeze selected package bytes for each run, including retries and repairs. Supply a concise catalogue and readable SKILL.md/resources from a private run-owned directory. Reviewers receive the builder's exact skill context through their existing sealed read-only handoff. A skill's instructions cannot change task scope, permissions or acceptance requirements. Show supplied versions; do not label them used without evidence.
- Test skill files a normal scoped report task with an immutable selection and sample request. The existing agent routing, approval and execution controls remain authoritative. Read-only reports have no code diff, so an exact test result gets a focused feedback form that files a linked report revision, pins the same skill version and preserves its source run and feedback. The page links the exact test task and result, preserving human evaluation of whether the skill helped.
- Chat can list/read project skills and open the selected project's Skills page with one meaningful action. Clearly label remaining form handoffs; no unsupported action claims.

## Verification

Focused regressions cover import boundaries, access and stale updates, immutable run selections, repair/review inheritance, test-task identity, and chat/UI visibility. Run typecheck and affected tests during implementation. Exercise one desktop and one phone journey through add, inspect, test, feedback and revision, with empty, long and error states. Use realistic labelled sample content. The native final machine gate owns the unchanged approved full typecheck/test/build command once per final candidate.

Final release must pass independent review and the existing drain, verified backup, schema-compatibility, process-exit and health checks. Native chat and restricted reviewer loading require explicit evidence; copying files alone is not a ready claim.

Sources checked: https://agentskills.io/specification ; https://learn.chatgpt.com/docs/build-skills ; https://code.claude.com/docs/en/skills .

## Implementation notes

The library stores each package once. Immutable run snapshots contain package hashes, avoiding full package copies in every database row. First attempts pin the selection; later attempts and reviewer context retain those versions. Imported resources are materialized in private run-owned folders outside leased checkouts. Reviewer inputs use the existing sealed, integrity-checked text/range path; the reviewer gets no new tool or permission.

Schema 65 also advances the older-reader fence regressions in `src/migration-v50-review-retries.test.ts`: a v66 or −66 marker refuses as a newer build and −65 is the impossible mid-flight marker, so the schema-compatibility check passes for this candidate.

Unreadable or unverifiable skill packages no longer leave a builder, planner or scout attempt open without agent spend: each worker loads project skills after its admission checks and returns the `skills-unavailable` failure before any provider, heartbeat or log resource starts, so normal dispatch settles the run and releases the claim. See `docs/PROJECT_SKILLS_REFUSAL_FIX_2026-09-16.md`; the browser rendering is unchanged, so the synthetic screenshots are reused.

The first version supports portable SKILL.md packages. Provider-specific settings are shown but are not installed or granted. Requirements are reported as unverified until a test or run supplies evidence. Tests are read-only reports, so skills requiring deployment or other external writes can report that limitation but cannot complete those actions. Importing private GitHub repositories is not supported by this form; upload an authorized local folder instead. Local folder upload requires browser JavaScript.

A skill can be tested while disabled. Create test opens its normal task, where the operator can change the agent and review the exact scope before approval. Repeated submissions reuse the same test. Results distinguish supplied versions from demonstrated use; recorded feedback creates a linked test revision with its own approval.

The desktop and phone UI proof is synthetic, labelled as such. It covers empty and failed imports, long skill instructions, exact enablement, normal test approval, result review, feedback, and revision. Desktop additionally covers real browser folder selection with a supporting file and filtered/empty library search. A real agent trial remains a release check after the installed UI and worker have been updated together.
