# Component plan for Standing Orders

Assessed 20 September 2026 against the ten links in [Farea’s post](https://x.com/FareaNFts/status/2100472439344136509). This is a research and implementation recommendation, not an installed UI change. No packages, application source, task state, or deployment were changed.

**Recommendation: build one React interface from shared shadcn primitives, selected AI Elements chat components, and a few beUI workspace components.** Use Halaska as a workflow reference. The other libraries offer individual ideas, but adding their entire systems would duplicate controls, styles and dependencies.

The strongest fit is a calm working interface: the main chat is the lead agent, crew tasks appear beside it, and choosing a task opens its exact result in the same workspace. Projects and knowledge support that conversation. The CLI and browser remain clients of the same operations and saved state.

## Assessment of all ten links

| Library | Verdict for us | Useful parts | Important limits |
| --- | --- | --- | --- |
| [AI Elements](https://elements.ai-sdk.dev/) | Primary chat component source | Conversation, Message, Prompt Input, Tool, Plan, Confirmation, Sources, Artifact, Terminal | Apache-2.0. Setup targets React 19, Tailwind 4 and shadcn, with Next/AI SDK examples. Selected primitives can be adapted to our existing backend; a non-Next integration has not been built or tested. |
| [beUI](https://beui.dev/) | Select workspace components | Sidebar, command palette, combobox, task/activity rows, small diff and tool disclosures | Free source is MIT; separate Pro product. React/Tailwind/Motion dependencies. The complete Chat App needs simplification and phone layout fixes. |
| [UI by Halaska](https://ui.halaska.com/) | Strong workflow reference; adapt selectively | Plan preview, crew status, versioned artifact, error recovery | MIT, React/React DOM with inline styles. Beta; large combined source file. Some plan/status components advance on timers. Inspected dialog lacks the full semantics/focus handling we need. |
| [Beautiful UI](https://www.beautifului.dev/) | Selective visual reference | Compact task rows, tool chips, structured code changes | MIT components, but SidebarNav imports a paid icon package. Timed demo status sequences must be removed. Approval card is an auto-advancing questionnaire, unsuitable unchanged for consent. |
| [AICSS](https://www.aicss.dev/) | Optional small output components | File Diff, Code Block, Text Response, Inline Citations | Free components MIT; several relevant input/task/approval components are Pro. Diff is a row renderer. StreamingText animates an already complete string. CodeBlock copy success handling needs repair. |
| [Kokonut UI](https://kokonutui.com/) | Secondary reference | Action Search Bar, AI Input Selector, Smooth Drawer | Free source MIT, Pro separate. React/Tailwind/Motion overlaps our preferred stack; some supplied examples use Next-specific imports. Little reason to add another complete system. |
| [UImaxxing](https://uimaxx.ing/) | Visual inspiration | Agent chat, terminal and diff layouts | Relevant inspected components are largely static samples. Source headers allow commercial application reuse with restrictions; this is not verified as MIT. Complete standalone license was not verified. |
| [Bencho](https://bencho.dev/) | Hold source adoption; interaction inspiration | Assignee picker, search, inline confirmation | Block code has an MIT grant with exclusions for other site assets. Inspected Code pane was empty and Copy Usage produced no text; React compatibility, dependencies and source delivery remain unverified. |
| [Animata](https://animata.design/) | Optional restrained polish | Fluid Tabs, List Skeleton | MIT snippets, not a full application foundation. Some examples change success/progress on a timer or hover, so their state logic is unsuitable for real work. |
| [Libraries.dev](https://libraries.dev/) | Defer for this refresh | Possibly a small activity indicator; voice visualization only if voice is added | Public libraries MIT; Studio/presets separate. Mostly visual effects. No useful workspace/navigation foundation for our immediate needs. |

License and dependency sources: [AI Elements license](https://github.com/vercel/ai-elements/blob/main/LICENSE), [AI Elements setup](https://elements.ai-sdk.dev/docs/setup), [beUI repository](https://github.com/starc007/ui-components), [Halaska source](https://github.com/Halaska-Studio/ui/blob/main/halaska-kit/halaska-kit-v1.0.jsx), [Beautiful UI license](https://www.beautifului.dev/license) and [package](https://github.com/slev12397/beautiful-ui/blob/main/package.json), [AICSS license](https://www.aicss.dev/license), [Kokonut repository](https://github.com/kokonut-labs/kokonutui), [UImaxxing base registry](https://uimaxx.ing/r/uimaxxing.json), [Bencho licence](https://bencho.dev/licence), [Animata repository](https://github.com/codse/animata), [Libraries.dev repository](https://github.com/Jakubantalik/Libraries.dev). Verify the selected source revision and notices when copying; this assessment is not a blanket license clearance for every asset or Pro item.

## Component map

```text
Desktop
┌─────────────────┬──────────────────────────┬─────────────────────┐
│ Project switch  │ Main chat with lead      │ Crew / selected work│
│ Chat            │                          │                     │
│ Tasks           │ Catch-up when useful     │ Running             │
│ Projects        │ Messages + sources       │ Needs you           │
│                 │ Plan / decision inline   │ Ready               │
│ Recent chats    │                          │                     │
│                 │ Composer                 │ Result details      │
└─────────────────┴──────────────────────────┴─────────────────────┘

Phone: chat fills the screen; navigation opens on demand;
selected work opens a full-width detail view with a clear way back.
```

This is a proposed information layout, not a measured or implemented screen. Crew and result detail share one supporting panel; avoid squeezing both into separate permanent columns.

| User need | Components to build | Reference to use | Standing Orders owns |
| --- | --- | --- | --- |
| Move between projects and conversations | AppShell, ProjectSwitcher, RecentChats, CommandMenu | Shared shadcn controls; beUI [Sidebar](https://beui.dev/components/motion/animated-sidebar), [Command Palette](https://beui.dev/components/blocks/command-palette), [Combobox](https://beui.dev/components/motion/combobox) | Project access, canonical URLs, selected conversation identity; keyboard navigation and phone drawer behavior |
| Talk to the lead agent | LeadConversation, ChatMessage, PromptComposer, AttachmentList | AI Elements [Conversation](https://elements.ai-sdk.dev/components/conversation), [Message](https://elements.ai-sdk.dev/components/message), [Prompt Input](https://elements.ai-sdk.dev/components/prompt-input) | Saved messages, drafts, receipts, send/stop authority, real delivery state; preserve scroll position while reading earlier output |
| Understand a plan or answer a question | PlanCard, DecisionCard | AI Elements [Plan](https://elements.ai-sdk.dev/components/plan), [Confirmation](https://elements.ai-sdk.dev/components/confirmation); Halaska [plan layout](https://ui.halaska.com/#pat-plan) | Exact plan and revision, permitted actions, full approval terms and explicit consent; no auto-submit or implicit “Always allow” |
| See what subordinate agents are doing | CrewList, WorkRow, ActivityDisclosure | beUI [Agent Activity](https://beui.dev/components/agents/agent-activity); AI Elements [Task](https://elements.ai-sdk.dev/components/task), [Tool](https://elements.ai-sdk.dev/components/tool) | Shared work summary, actual tool events, open questions and exact attempts; no fake percentage or timer-driven completion |
| Inspect finished work and give feedback | ResultPanel, ChangeViewer, CheckSummary, FeedbackForm | AI Elements [Artifact](https://elements.ai-sdk.dev/components/artifact), [Terminal](https://elements.ai-sdk.dev/components/terminal); beUI [File Diff](https://beui.dev/components/agents/file-diff) as an optional renderer | Exact run/files/commit, real check results, incomplete or damaged output, saved feedback and explicit revision; a log viewer is not an interactive shell |
| Understand what the agent knows | KnowledgeSearch, SourceList, SourcePreview, RelatedItems | AI Elements [Sources](https://elements.ai-sdk.dev/components/sources), [Inline Citation](https://elements.ai-sdk.dev/components/inline-citation) | Local DB and approved knowledge, source identity, freshness and permissions; graph retrieval/indexing is separate backend work |
| Catch up after being away | CatchUpBrief, UpdateInbox, ConnectionNotice | Custom small layouts using the same primitives | Persisted update cursors, acknowledgments and receipts; one useful update, no duplicated summaries or automatic task reruns |
| Manage a project and the installation | ProjectDetails, KnowledgeSettings, RuntimeStatus | Shared forms, disclosures, alerts and buttons | Project paths, budget/authority, actual build identity, compatibility and update readiness; diagnostics on demand |

The everyday lifecycle stays **Plan → approved work → Ready → explicit Complete or requested revision**. “Ready” is a saved status that the lead agent or user can inspect. This UI plan introduces no automated reviewer, evidence resubmission, or new workflow phase. Existing execution checks and explicit approvals remain attached to their real operations.

## What makes this reliable rather than merely attractive

- Render status from the database and shared work summary. A library’s “Completed” tool badge means a tool produced output; it must not silently mean the whole task is Complete.
- Render real tool activity and concise summaries. Do not show invented “thinking” text, simulated steps, or fake progress while waiting.
- Keep task, run, conversation and revision identities distinct. A result link must continue to open the exact result it names.
- A lost response should trigger receipt/status inspection. It must not automatically submit the task or prompt again. Retain the user’s draft until delivery is confirmed.
- Keep important failure and approval details visible. Fold technical logs and history into disclosures; retain one clear next action per state.
- Keep the graph optional. Searchable sources, related records and clear citations are useful immediately; a node canvas is not required for everyday knowledge access.

Concrete source findings: [Halaska’s combined implementation](https://github.com/Halaska-Studio/ui/blob/main/halaska-kit/halaska-kit-v1.0.jsx) contains timed plan/status progression; [Beautiful TaskRows](https://github.com/slev12397/beautiful-ui/blob/main/components/primitives/TaskRows.tsx) contains a scripted status sequence; [AICSS StreamingText](https://github.com/kvnkld/aicss/blob/main/packages/react/src/streaming-text/StreamingText.tsx) reveals a supplied string over time. These are useful demos, not durable execution state machines.

## Integration plan

The current application renders HTML from TypeScript and has no React, React DOM, Tailwind, shadcn or browser bundler in its package manifest. Add a small React build with shared styling, and migrate one complete journey first: **main chat → open a crew task → inspect the exact result → leave feedback → request a revision**. React supports [incremental adoption](https://react.dev/learn/add-react-to-an-existing-project), and shadcn documents [Vite integration](https://ui.shadcn.com/docs/installation/vite).

Use one selected implementation per primitive. For example, start with AI Elements Conversation; evaluate beUI Message Scroller only if it resolves a demonstrated scrolling limitation. Do not stack two scrolling systems or several composers. Lazy-load expensive Markdown, syntax highlighting, diffs and previews where appropriate.

Selected AI Elements registry implementations import AI SDK types without owning model calls or network transport. Adapting them to our existing operations appears feasible; that is a source-based conclusion, not a tested build. [Conversation registry](https://elements.ai-sdk.dev/api/registry/conversation.json), [Prompt Input registry](https://elements.ai-sdk.dev/api/registry/prompt-input.json), [Confirmation registry](https://elements.ai-sdk.dev/api/registry/confirmation.json).

Transport work is real: the current `/chat/mate/status` returns JSON containing server-rendered HTML fragments. The `/api/sessions/*` API is operator-bearer transport and deliberately rejects browser-origin requests; it is not a ready-made React browser API. Add narrow browser adapters using the existing cookie/CSRF admission and shared owning services. Never put a CLI coordinator/operator token in frontend code. Keep the Node service and local SQLite database authoritative.

Suggested delivery order:

1. Shared theme, browser build and narrow data adapters; migrate the chat-to-result journey with truthful state and recovery.
2. Crew list, plan/decision and result components; reuse existing feedback, completion and revision operations.
3. Projects, knowledge search, source previews and command navigation.
4. Final typography, spacing and subtle motion pass. Exclude decorative orbs, beam borders, floating docks and bouncing navigation from the core work surface.

For implementation, use affected typechecks/tests and one desktop plus one phone journey, with the relevant empty, long-content, failed-send and reconnect states. Then use the existing final verification and normal matched UI/worker deployment. This assessment creates no new testing or review machinery.

## Inspection limits

Official documentation and selected source were inspected for all ten resources. Actual desktop previews were inspected for AI Elements, beUI, Beautiful UI, Halaska, AICSS and UImaxxing; Bencho’s export was inspected in-browser. Selected 390px phone views were inspected for AI Elements, beUI and Beautiful UI.

Observed phone issues: beUI’s complete Chat App squeezes an approval title into a narrow five-line column; Beautiful UI task rows truncate task titles heavily. AI Elements’ inspected confirmation kept its buttons within the viewport. These observations favor adapting individual components over lifting complete demos.

No packages or test suites were run. Full keyboard/screen-reader operation, long transcripts, large diffs, error recovery, reduced-motion behavior across the assembled interface and physical-phone software keyboards remain to be verified during implementation. This is a suitability assessment, not a production-readiness certification.

Local architecture references: `package.json`, `src/serve.ts`, `src/session-http.ts`, `src/session-contract.ts`, `src/work-summary.ts`, and `docs/PROJECT_CONTEXT.md` from canonical main `ece0671acbb4b1445b0e30c59d330c7ed3268836`.
