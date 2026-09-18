# Collect missing observations through bounded follow-ups

Use the existing revision/repair chain for an evidence-only attempt. The approved goal, criteria, route, permission posture, spend, stops and attempt cap remain inherited. A finished review is immutable; the new evidence attempt receives its own review.

Fable 5.1 supplied the design in fable-plan.md. Implementation corrections:
- Do not execute arbitrary agent-supplied shell commands in the controller. The first supported collection is a focused Vitest case under an existing approved npm test command. The manifest names criterion, base/head, test path and test name only; the controller constructs argv. Unsupported observations remain explicit requests for help.
- A revision has its own scope digest. Gate reuse therefore requires exact source ancestry, unchanged head, inherited signed criteria, exact approved command and original verified receipt, not equality of different task digests. The new receipt explicitly names reuse and revalidates original custody; it must not pretend a command ran again.
- Keep original reviews, verdicts and artifact bytes intact. Source-to-follow-up history provides the new current result.
- Use existing task repair approval/control for a missing-evidence draft; no duplicate dispatch mechanism or new chat tool schema.

Acceptance:
1. A cannot-tell finding creates one bounded evidence-only follow-up under existing authority, survives duplicate triggers and restarts, preserves human acceptance and observes stops/holds/no-progress/cap boundaries.
2. The collector runs only a narrowed approved test command in isolated source snapshots, binds unchanged candidate/base/test and complete output, refuses unsupported or altered inputs, and gives a fresh review the observations. Arbitrary commands and production edits are refused.
3. Same-candidate follow-ups reuse an intact passing gate with explicit provenance; tampered, stale or different-candidate receipts never count. Mayhem original-base reward regression failure and candidate pass can close c1 without rewriting the original review or rerunning its full suite.

Test selection correction after review1797: treat requested names literally, verify exactly one executed assertion against the requested test file and title/full name, and record that identity. Similar, duplicate or absent names do not count. Native review judges behavior from its own candidate source and gate; the operator separately verifies exact prepared/native Git tree equality.

Verification load correction: keep the active approved parallel command, but cap Vitest at four concurrent files. A default-parallel run lost the controller renewal lease and was terminated; a fresh full native gate must demonstrate the bounded configuration. This changes test scheduling only, not test coverage or timeouts.

Current corrective dispatch starts from main eac1fe0 (PR23), whose eight CI jobs passed. It preserves the new gate-failure classification, planner guidance and test timeouts. Older native attempts retain their original97fdd32 base and historical evidence. The integrated candidate passed76 focused tests and typecheck; its full native gate is still required. The baseline collector remains useful for the existing signed Mayhem criterion; new planner criteria should follow main's candidate-observable guidance.
