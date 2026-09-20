# Task to review

The default journey is **Task and context → Plan → Work → Ready for review → Complete**. One assignment owns the conversation, selected project knowledge, plan, revisions and result. The lead or user reviews the outcome. A second model review is an explicit choice; strict release tasks retain their signed review requirements.

Standing Orders already saves project knowledge snapshots, plans, result artifacts, revision ancestry and durable handoff updates. Reuse those records. The lead reads new status events and opens the result when needed, instead of repeatedly loading the entire history or resubmitting completed work.

A finished build with an intact passing native check reaches the lead before an independent review. Missing proof reports, screenshots or a complete review inventory remain visible limitations; they do not require a rebuild or another agent turn. Routine builders are not asked to restate acceptance criteria in a proof report, and optional proof formatting does not trigger automatic correction turns. The result names its exact commit, check output, outcome and limitations. Marking the lead review complete does not change the machine verdict, accept an exception, publish or deploy. Failed checks, changed saved bytes, active work, unresolved questions and stopped processes remain visible and prevent false completion.

Automatic review findings do not create correction tasks unless the project has explicitly authorized automatic repair. A lead can request a revision with concrete feedback using the existing result action. Missing evidence is an issue to inspect; it is not an instruction to rebuild working code.

## Delivery check

- A routine task reaches the lead after its checks, with no independent-review request required.
- Reading status, acknowledging a result and receiving feedback do not start another model or change approval authority.
- Review feedback remains visible; real failed checks and damaged evidence cannot be relabeled successful.
- Strict release and explicitly signed automation continue to follow their existing terms.
- UI, CLI and agent tools refer to the same assignment, result and next action.
- An update is complete only after the running UI, worker and CLI match the deployed build. Source changes alone are not deployment.

Lead review checks the existing saved assignment history directly, without requiring a separate model-review manifest. Strict signed review continues to use that manifest and the existing release checks. The current implementation changes handoff readiness, routine builder instructions and automatic correction filing. It does not add arbitrary evidence attachment or change the native rule that a new commit needs fresh release verification. That remaining infrastructure limitation must be addressed directly, not through repeated manually authored evidence packages.
