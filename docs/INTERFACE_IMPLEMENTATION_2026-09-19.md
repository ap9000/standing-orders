# Consistent work and session controls

The approved plan is being delivered as two independently reviewable releases.
The combined development candidate and complete evidence are preserved at Git
commit `5e02e4bc78daae91222371f956d6772cbc13f56f`. Its complete patch exceeds the
installed verifier's 262,144-byte limit. No native task was dispatched from it;
no evidence was truncated and no dispatched task base was changed.

## Release 1: exact review and consistent work status

This candidate fixes Work-to-result navigation with exact task, run and project
identity, including sign-in return. An open question remains actionable when a
worker disconnects. UI, task CLI, coordinator chat and MCP use shared work facts
and explicit action authority. Detailed status stays available when needed.

The review screen removes repeated warnings and labels. Exact revision feedback
appears once inside Review plan before password consent. Phone controls use 44px
targets; empty lists describe the current view without denying earlier results.
The demo fixture now binds reviewable results to their actual approved scope,
so it exercises normal feedback and unapproved-revision creation.

The earlier prepared UI candidate `92dbad8136468ca7283873a7c3ba0a469b5bf76d`
recorded 549 passing focused tests in eight affected files, typecheck, build, and
inspected desktop/phone evidence. Those records remain historical; their source
hashes do not establish this rebased candidate. Fresh checks and browser evidence
are required before dispatch. Synthetic data and realistic feedback remain
clearly labeled. Physical-phone, software-keyboard and complete screen-reader
behavior remain unverified.

## Release 2: native session CLI and saved briefs

The separate prepared implementation adds authenticated session operations to
the existing native owner, exact revision/turn controls, durable replay receipts,
and deterministic saved-context briefs inspired by FirstMate. The real isolated
canary already preserved one thread and exactly two messages through CLI start,
cookie follow-up, restart and CLI resume. These features are not in Release 1.

Release 2 must start from the verified Release 1 commit and carry its own complete
focused/native evidence. Session events, reviewed memory capture, and shipping
or uncertain-delivery consent through the CLI remain future work. Coordinator
credentials do not gain native-session or operator approval authority.

## Release status

Release 1 is now prepared on the verified standalone web base
`20ccdee311b3e1a65be3427a4c270e2ec7f16a64`. Its source delta was applied from the
earlier prepared UI candidate without replacing the verified native/web fixes.
Source checkpoint `037d809f7a97ee965e24f0d4f1f2bf771be875b8` has 549 passing
focused tests across eight files plus typecheck on the preceding integration
commit. Its only subsequent code change gives empty-view recovery links a 44px
minimum height; the build and affected desktop/phone visual checks passed. Six
fresh inspected images, current hashes, complete logs and separately labelled
earlier feedback/revision journeys are committed in `evidence/interface-ui`.
The native gate and independent review remain pending.
No native dispatch, deployment, or push has occurred for this rebased candidate.
Each first native dispatch will use its intended verified base, committed inputs
and current evidence. The unchanged full command runs once per exact candidate at its final
native gate, followed by independent review. Installation then updates the UI
and worker together through normal drain, backup, compatibility, process-exit
and health checks. Passing focused checks is not deployment.
