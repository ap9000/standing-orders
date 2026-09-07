# Product priorities

Standing Orders should be the place where a person can hand off an outcome,
leave, and return to a result they can trust. These priorities are ordered by
the weakest link in that promise: execution first, proof second, breadth third.

## 1. Never Stuck

A filed and approved task either starts, names the exact gate preventing it, or
fails with a repair path. “Queued” is not an explanation.

Done means:

- the worker survives terminal closure, crashes, login, and reboot;
- installation verifies that the worker process is actually running;
- task and inbox views distinguish human approval, dependency, capability,
  worker-liveness, and active-run gates;
- every blocked state gives one concrete next action;
- an end-to-end check files, approves, runs, and reaches a terminal outcome.

## 2. Verified Done

Completion is an evidence bundle, not an agent assertion. Each task should show
its acceptance criteria, commands and checks run, changed files, diff summary,
screenshots for UI work, and any caveats. A run without required proof is
“needs verification,” not done.

## 3. Chat to Result

The unified chat should cover the whole loop: inspect the portfolio, clarify an
outcome, draft or revise a plan, approve, watch execution, answer decisions,
review evidence-rich results, request revisions, and publish. Rich cards should
remain views of durable workflow state rather than chat-only copies.

## 4. Outcome-oriented planning

Planning should turn a goal into an explicit dependency graph with acceptance
criteria, risks, likely files, verification steps, and decision points. Plans
should adapt when repository evidence invalidates an assumption without quietly
widening the approved scope.

## 5. Review cockpit

Make review faster than reading an agent transcript: intent-to-diff mapping,
risk-weighted file order, visual proof, test evidence, unresolved caveats, and
one-click accept, revise, compare, or publish actions.

## 6. Adaptive routing and project learning

Route planning, building, repair, and review independently by task risk and
provider availability. Learn stable repository facts—commands, conventions,
failure patterns, ownership, and preferred models—from verified outcomes, with
visible provenance and an operator-controlled reset.

## Current focus

Priority 1 is active, and the first Priority 2 slice has landed alongside it:
completion now carries a typed, hash-addressed proof the plane adjudicates
against evidence it captured itself, rather than an agent's own assertion.

The first Priority 1 slice now pins the worker service to the installed Node
runtime, requires a fresh worker heartbeat before installation reports success,
and shows the exact dispatch gate on every task. Unattended permissions are now
an installation default plus a durable per-task choice: `auto` keeps the guarded
provider classifier, while Full access seals Claude's
`--dangerously-skip-permissions`, Codex's combined approval/sandbox bypass, or
Gemini's `yolo` into that task's approval so permission prompts cannot strand it
while the operator is away. Changing
the default never broadens existing approvals.

The first Priority 2 slice: a builder may write one nonce-bound proof
manifest — acceptance criteria, checks with exit codes, changed paths,
caveats, and screenshot paths for UI-facing work — alongside its terminal
handoff. The plane validates every claimed screenshot as a bounded PNG or
JPEG by signature, validates claimed changed paths against the sealed
diff, and re-runs one operator-approved per-repository verification
command (`standing-orders verify set`) in the leased worktree, never a
model-authored one. From this it computes one closed verdict — *verified*,
*attested*, *short*, or *refuted* — once, at completion, and every surface
(task, run, done, builds, board, `task show`, `brief`) speaks the same
words. A `short` or `refuted` verdict reads "needs verification," not
done, until an operator explicitly accepts it (`task accept`, or the
console's accept button); the branch and diff stay exactly as reviewable
either way — missing or malformed proof never destroys committed work.
