# Standing Orders: simple, elegant UI

Every UI change and UI review must include a simplicity pass before sign-off.

- Plain English: describe what happened and what the user can do. Avoid internal terms such as "proof disagrees" or "replace blocker" when a concrete explanation is clearer.
- Say it once. Remove duplicate status labels, instructional subtitles, and footer explanations. Use a short title, concise outcome, and one specific primary action.
- Show secondary detail on demand. Put advanced settings, diagnostics, provenance, and exact scope in the relevant disclosure; keep important risks and full approval terms visible before consent.
- Reduce unnecessary fields, choices, steps, and competing controls. Prefer familiar chat and form interactions. Do not add paragraphs to explain an overcomplicated flow.
- Preserve real functionality: truthful status, recoverable drafts, explicit approvals, keyboard access, readable contrast, and clear error recovery. Concision must not conceal a problem or weaken a safeguard.
- Verify actual desktop and phone viewports, including long content, empty states, and failures. Check alignment, overflow, fixed-control overlap, comfortable tap targets, and single-line short CTAs. Keep animations subtle and respect reduced motion.

Before finishing, ask: Can a first-time user understand the current state and next action without a paragraph? What text or step can be removed without losing useful information? Fix concrete findings and record concise before/after evidence, not an unsupported quality score.

Example: show **Plan ready**, a short outcome, and **Review plan**. Omit **Your next step**, **approve to start**, and a second sentence explaining the same action. Keep password and approval instructions inside the expanded review.

Carry this check into Standing Orders task acceptance criteria and review feedback for UI work. Do not claim future agents followed it until their output has been inspected.

## Chat and UI consistency

- Treat chat as another way to use the same product, not a separate task system. Reuse the action that owns the change and the same saved state, history, permissions, and approvals.
- For every new user action, provide a chat proposal or a clearly labelled path to its existing control. A link is not a completed action; identify any remaining chat-only gap.
- Preserve task and result identity when revising. Show the exact feedback being submitted, reject stale cards, and prevent duplicate work.
- Verify both directions where affected: a chat action appears in the relevant screen, and changes made there are available to chat. Never ask for passwords or API keys in conversation.

## Lean verification

- During implementation, run typecheck and tests for the affected behavior. Add a small regression for each reproduced bug; reuse existing tests instead of adding overlapping suites.
- For UI work, use one end-to-end journey at desktop and one phone viewport: open the result, inspect changes, leave feedback, and create a revision. Include affected empty, long-content, and failure states. Add other viewport checks only for a concrete risk or explicit acceptance requirement.
- After a small copy or CSS repair, rerun the affected visual checks, not every browser script. Behavioral changes also require their focused tests.
- Let Standing Orders run the unchanged approved full verification command once at the final machine gate for the candidate. Do not duplicate that full suite in the builder or independent review. A failed gate or changed candidate still needs fresh verification; never delete tests, add skips, or waive approval or evidence checks to save time.
- Reuse valid evidence for unchanged code and the same agent session where already supported. Do not build new orchestration just to reduce test overhead. No new agent time limits.
- Report the checks actually run, the exact candidate they cover, and any remaining gaps. Broaden checks only for a specific uncovered risk; say why.

## Keep the installed tool current

- Deployment means the running UI and background worker use the same verified build and compatible database format, not merely that source was merged or a package was built.
- Check running build identity before real end-to-end work. Report version drift and update through the normal drain, backup, compatibility and health checks; never replace a runtime underneath active work.
- Prefer the latest verified candidate. Never bypass signing, approvals, process-exit checks or evidence requirements to install a newer build. Report a blocked update plainly instead of claiming the installation is current.
- Use realistic sample feedback in user-facing screenshots. Keep long-content coverage, label synthetic journeys clearly, and do not present test filler as actual agent output.
- Before the first dispatch, verify the task branch starts at the intended verified base and required input documents are committed or supplied through a durable supported handoff. Do not fix a mistaken first-attempt base by moving its branch forward and expecting a smaller review diff: whole-task evidence remains pinned to the original base. Preserve that attempt and use an explicitly scoped corrective task with the right starting branch when needed.
