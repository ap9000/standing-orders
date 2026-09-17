# Settle unreadable skill context

Review 1722 questioned what happens when skillsContext throws. The operator reproduced the failure on all three worker roads: builder rejected the call; planner and scout left the run outcome and finishedAt null. No provider started. The three regressions are in the existing builder, planner and scout suites. The before log preserves those failures.

The prepared repair loads skills after the existing admission checks and before heartbeat/log allocation. A load or package verification error returns the existing value-shaped failure flow with a clear message; no provider is invoked and normal dispatch settles/releases the attempt. The planner and scout regressions prove the finished failed run, absent provider start and released claim. Builder proves a refusal and no provider call. A comment now identifies schema 65's additions. No permissions, timeouts, approval requirements, cost limits or UI rendering changed.

Typecheck and 262 tests in builder, planner, scout, project-skills, mate and migration-v50-review-retries pass. Reuse the unchanged browser evidence; updated source hashes are in the manifest. Do not rerun the full suite manually: the unchanged native machine gate owns final verification once on the new candidate.

The chat test setup's larger default session is only a successful-turn fixture budget: the production worst-case reservation includes the larger tool contract. Explicit exhaustion fixtures retain their exact caps and the exact-reservation assertion remains. No production pricing, reservation, spend limit or permission was changed.

Apply only this prepared repair commit atop the native schema-fix candidate. Preserve the native schema fix, all original feature code, source lineage and historical failed evidence. The additional local commit 07050f8 is an alternative relative-version test improvement; it is not required or requested for the native candidate.
