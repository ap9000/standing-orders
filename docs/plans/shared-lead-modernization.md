# Shared lead and crew delivery

The main chat is the visual front end for the same lead agent used by CLI chat. Tasks are durable work records; crew agents execute their approved scopes. The local database retains goals, decisions, context, results and status across sessions.

## User flow

1. Ask for an outcome in Chat or CLI chat. A read-only database catch-up appears before starting a paid conversation.
2. The lead reads project guidance and relevant source, proposes a plan and bounded tasks, and asks for decisions where existing permissions require them.
3. Crews execute approved work and save results. Ready means the result can be inspected; actual checks remain a separate fact.
4. The user or authorized lead opens the result, marks it Complete, or requests a specific revision of the same task.
5. Optional automatic crew updates wake Standing Orders' own lead when a result or decision changes. Idle scans use no model. Saved request identities prevent a completed response from being generated twice after interruption. A failed response is reported; it does not rerun the crew.

There is no mandatory model reviewer, automatic repair/resubmission loop, or missing historical assessment requirement. Explicit execution approvals remain. Deploying Standing Orders still requires the exact passing native machine check, completion of that candidate, and normal drain/backup/compatibility/health checks. No Mac restart is part of the update.

## Implementation

- One assignment presentation supplies task/chat/result status, primary action, and attention. Ready and Complete are distinct. Historical optional proof lives in detail, while real failed checks or damaged material remain visible.
- Chat, Tasks and Projects are primary navigation. Specialized coding sessions and older task views remain in Tools.
- Browser and CLI use the same lead conversation and database catch-up. Automatic updates require an explicit saved grant and use the existing conversation's permissions, turn limits and spend allowance. The service drains during shutdown.
- Database knowledge holds deliberate instructions and references. A disposable local TypeScript/JavaScript index adds symbols, import relationships, source excerpts and advisory impact. Missing/stale indexing falls back to bounded source search. Crews retain selected context in their existing immutable snapshot.
- Everyday CLI operations use existing task and knowledge services. Machine responses retain typed envelopes, stable identity and stale-result checks.
- Unreachable reviewer execution and its exclusive tests are removed. Historical data readers, migrations, permissions, process custody, native verification and deployment tests remain. Certification journeys follow Ready → Complete or explicit revision.

## Context design

FirstMate's useful pattern is one accountable lead supervising workers. Standing Orders keeps that pattern on its existing database and task operations. Automatic updates target its own lead; they do not claim to wake an unrelated Codex Desktop conversation.

Graphify's useful pattern is source-backed relationship retrieval alongside curated knowledge. A pinned code-only comparison led to a native TypeScript parser adapter: narrower coverage, smaller runtime footprint, no Python service or model ingestion. See [repository context](../REPOSITORY_CONTEXT.md) for measurements and limitations. This is static import impact, not a complete call graph or proof of test coverage.

## Verification and release

Use focused domain and public-entry-point checks during implementation. Inspect one desktop and one phone journey covering result, feedback, revision, long content, empty states and failures. Confirm default chat allowances still admit the expanded contract. Run the unchanged approved full command once through the native gate for the final exact candidate, then deploy and verify matching UI/worker/CLI identities. Preserve required CI checks and the old Documents checkout.

Keep current project instructions concise. Do not bulk-adopt historical lessons or convert unverified agent conclusions into approved guidance. Optional graph/context failures never gate task completion or trigger resubmission.
