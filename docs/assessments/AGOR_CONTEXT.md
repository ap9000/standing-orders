# What Standing Orders can learn from Agor

Assessed 2026-09-12 UTC. Source snapshot: [preset-io/agor at 72bf01f](https://github.com/preset-io/agor/tree/72bf01ff8e7b199434456bbedb0ecd93aeba6664). This is a targeted source inspection, not a runtime certification or a complete security review. No Agor application code was copied or executed.

Agor demonstrates that ordinary context continuity does not require a novel memory system. Its useful primitives are durable task/session identity, explicit ancestry, provider-native conversation forks, focused child prompts, retrievable history, and queued completion reports. Standing Orders already has many equivalent storage and execution primitives. The remaining work should strengthen their boundaries rather than introduce a second orchestration or knowledge stack.

## What the implementation does

| Concern | Observed Agor implementation | Implication for Standing Orders |
| --- | --- | --- |
| Work identity | Sessions belong to one branch with repository, issue/PR links, notes, environment, and Git boundaries. Fork/spawn ancestry is stored explicitly. | Retain our task/run/worktree model. Project a compact view of the current task and source ancestry from existing records. |
| Conversation continuity | Claude forks resume the parent's SDK session with the fork option. Codex forks use app-server `thread/fork`, persist the new thread ID, then resume through the SDK. Spawned children start fresh. | Conversation reuse is an optional provider optimization; it cannot replace the portable scope/evidence contract. Reviewers should still receive independent, focused context. |
| Scope passed to a child | The spawn UI's server-rendered prompt asks the parent model to enrich the child prompt with the request, code locations, decisions, criteria, and expected outputs. The session service stores that prompt and inherits selected configuration/context-file names. | Reuse the focused handoff idea, but insert the exact filed terms mechanically. A model summary should supplement the contract, not decide which restrictions survive. |
| Current context | A small runtime identity block accompanies a stable orientation prompt. A single MCP read returns current session, task Git boundaries, branch, repository, ancestry, and siblings. | Keep stable instructions separate from changing identity and evidence. Use our existing task/result projections; avoid repeating full history in every prompt. |
| Completion | A structured callback envelope carries child/task identity, status, counts, optional original prompt and final response, plus links for retrieving detail. Delivery queues onto the parent. Deterministic task IDs and persisted dispatch records support deduplication. | Keep completion notifications small and durable. Preserve links to sealed results; a callback's success wording cannot substitute for verified proof. Reuse our existing durable queue and retry machinery. |
| Shared memory | Knowledge stores immutable document versions with hashes, search units, version-checked edits, stable document references, and optional semantic search. Outline/range reads reduce context volume. | Immutable references and bounded retrieval are enough for this handoff release. A shared knowledge base, embeddings, or graph UI is a separate product decision. |
| Authority | Child configuration resolves for the child's attributed owner; inherited environment selections are names, with values resolved for the child. Runtime identity guidance is explicitly separate from authenticated authorization. | Preserve descriptive context and re-prove execution authority separately. Inherited context must never implicitly mint approval or widen permissions. |

Primary implementation references: [session creation/fork/spawn](https://github.com/preset-io/agor/blob/72bf01ff8e7b199434456bbedb0ecd93aeba6664/apps/agor-daemon/src/services/sessions.ts#L905), [spawn context prompt](https://github.com/preset-io/agor/blob/72bf01ff8e7b199434456bbedb0ecd93aeba6664/packages/core/src/templates/spawn-subsession-template.ts), [runtime identity and stable orientation](https://github.com/preset-io/agor/blob/72bf01ff8e7b199434456bbedb0ecd93aeba6664/packages/core/src/templates/session-context.ts), [current-context tool](https://github.com/preset-io/agor/blob/72bf01ff8e7b199434456bbedb0ecd93aeba6664/apps/agor-daemon/src/mcp/tools/sessions.ts#L405), [completion delivery](https://github.com/preset-io/agor/blob/72bf01ff8e7b199434456bbedb0ecd93aeba6664/apps/agor-daemon/src/services/tasks.ts#L998), [knowledge storage](https://github.com/preset-io/agor/blob/72bf01ff8e7b199434456bbedb0ecd93aeba6664/packages/core/src/db/repositories/knowledge.ts).

## What this does not establish

In the inspected task/session types, spawn boundary, provider fork paths, and completion template, I did not find an equivalent to Standing Orders' signed scope digest, inherited risk/quality contract, or criterion-by-criterion proof bound to exact source and reviewed artifacts. That is a scoped observation, not a claim that Agor has no other governance features. Its permission, tenancy, runtime containment, and durable queue mechanisms are substantial.

A provider fork also does not itself prove which contract survived. Both inspected provider paths can warn and start fresh when the parent lacks an SDK session ID. Recorded ancestry and available model context are different facts. Likewise, `contextFiles` is stored/copied in the session paths inspected; those paths alone do not establish that the executor reads and verifies the file contents on every handoff.

## Decision for the current roadmap

Keep the implementation to three existing boundaries:

1. **Planning:** seal the original detailed request and execution terms against the admitted run. Reject stale source identity or an undeclared contract amendment. Preserve the original words using lossless encoding and explicit size limits.
2. **Revision:** derive the child terms from the actual source run and scope in one transaction. Bind the exact annotation batch, keep risk/quality/budget/permission ceilings, preserve repair lineage, and obtain fresh approval.
3. **Review:** supply a bounded inventory of current and inherited source/evidence, with exact identities and visible gaps. Recheck that inventory when accepting a review. Carry source references through successive revisions without automatically copying a prior verdict.

The handoff record should contain references to the durable request, source task/run, scope digest, source/base/head identities, revision purpose, execution constraints, and review evidence inventory. It should not become another mutable copy of all task state. The existing database, artifact store, CLI/HTTP projections, and queues remain the implementation foundation.

Defer generic long-term memory, semantic search, a knowledge graph, mandatory conversation forking, and a second callback engine. None is required to close the observed failures. Validate the small contract through the real journey: detailed filing → plan → approval → implementation → independent review → narrow revision → fresh approval → review of both new and inherited code.

This is a manageable data-contract problem. The hard part is enforcing the same contract after retries, stale reads, concurrent drafts, and multiple revisions. Those cases need boundary tests and real-provider journeys; adding more memory infrastructure would not remove them.

Agor identifies its source license as [Business Source License 1.1](https://github.com/preset-io/agor/blob/72bf01ff8e7b199434456bbedb0ecd93aeba6664/LICENSE). This assessment adopts architectural ideas, without vendoring its implementation.
