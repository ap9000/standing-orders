# The Console — design system v2

The one visual world the console and its React package share, rebuilt on
2026-09-02 to sit beside Linear and Vercel: their craft level is the bar.
`src/serve.ts` implements it as plain CSS; `design/` implements it as a
shadcn theme with the same token names. When they disagree, this document
decides, and the `:root` blocks of both are brought back together in the
same commit.

## 1. Voice

- **Quiet density.** An identifier and a status on every row; hairlines,
  not boxes; whitespace does the grouping. A screen holds many rows and
  stays calm.
- **Two schemes, one ramp.** A true neutral ramp with a whisper of cool.
  Dark is the default scene (an operator after hours); light follows the
  device (a phone in daylight). Every token has a value in both; no rule may
  name a color that only exists in one.
- **Amber means one thing, in two places.** `--brand` marks what waits on a
  person: the needs-you count (rail badge, tab dot, lane-header dot, the
  pill's count) and the one act that resolves a screen (approve, answer,
  retry). Cards, ceremony frames, seals, and chips are neutral — the header
  above a card carries the colour for it (reduction pass §3). A recommended
  option is never amber; a selected row is never blue.
- **Two faces, strictly cast.** IBM Plex Sans is the human voice: titles,
  sentences, section headers, chips. IBM Plex Mono is every machine fact:
  ids, workers, models, clocks, dollars, digests, tokens. Mono is never a
  costume for "technical", and section headers are no longer mono.
- **Honest words.** needs you · building · queued · waiting · done;
  measured or unmeasured, never a summed $0; a stage and a clock, never a
  percent.
- **Drawn icons.** One stroke weight (1.75) on a 24-unit grid, from one set,
  in the sidebar, the tab bar, the queue's controls. Never a glyph.

## 2. Tokens

| Token | Dark | Light | Role |
|---|---|---|---|
| `--background` | `#0b0c0e` | `#fafafa` | ground |
| `--card` | `#121316` | `#ffffff` | surface |
| `--muted` / `--secondary` / `--accent` | `#1a1c20` | `#f1f2f4` | inset wells, hover fills |
| `--border` | `#24272d` | `#e4e5e9` | hairlines |
| `--input` | `#3a3e46` | `#c4c7cf` | control boundaries |
| `--muted-foreground` | `#8b919c` | `#64697a` | dim text (≥4.5:1 on ground and surface) |
| `--foreground` | `#ededef` | `#171717` | text |
| `--primary` (console) | ink on paper | paper on ink | the one primary button per form |
| `--brand` | `#f5a524` | `#a15c00` | waits on you; `--brand-foreground` is its button text |
| `--running` / `--ring` | `#52a8ff` | `#0b6fd6` | a live build; focus |
| `--success` (`--built`) | `#3ecf8e` | `#118a4f` | built |
| `--destructive` (`--failed`) | `#f06a5e` | `#d1332e` | failed; the arm-to-cancel act |
| `--radius` | `0.5rem` | | cards; `-2px` rows, buttons, inputs; `-4px` chips and wells |
| `--shadow` / `--shadow-overlay` | deep | faint | cards and menus; light carries real offset shadows |

`color-scheme: light dark` on `:root`; the light block overrides under
`@media (prefers-color-scheme: light)`. Two `theme-color` metas, one per
scheme. The manifest stays dark.

Type: body 14px/1.5 Plex Sans; meta 13px; chips and facts 11px; h1 20px
semibold, -0.02em; h2 13px semibold dim sans (Linear's "In Progress 5"
register), with a count pill where a count exists. Rhythm: 0.125 / 0.375 /
0.625 / 0.875 / 1.25rem; more space above a heading than below it.

Controls: 2.25rem tall at a desk, 2.75rem to a thumb (≤40rem). Focus: a 2px
ring at 2px offset on buttons and links; a ring-colored border with a soft
3px halo on fields.

## 3. Components and their two implementations

| Component | Console (CSS) | Package (`design/src`) | Rule |
|---|---|---|---|
| Status chip | `.badge` + `.badge-open`, `-parked` (neutral), `-running`, `-done`, `-failed`; `.count.badge-open` (amber, the needs-you count only) | `StatusChip` | sans 11px pill; a state word wears a dot before it, a neutral fact (project, routine) does not |
| Attention card | `.decide-card`, `.lane-attention .lane-card`, `.workspace-card.hot` | `AttentionCard` | neutral border; the lane header's amber dot and count say "needs you" for every card beneath |
| Row | `.row` (2.25rem, hairline below, hover fill) | `LedgerRow` | title · mono facts · chip at the end |
| Facts | `.facts` (`.fact > .k + .v`) | `KeyValueRow` | dim mono key, ink mono value |
| Seal | `.seal` | `DigestSeal` | the signed digest, mono, boxed in the hairline |
| Acceptance rubric | `acceptanceCeremonyHtml` (`<ul class="recap acceptance-rubric">`) | — | one line per signed criterion — mono id, sans statement, its required evidence kinds after it; restated text above the seal, never a second amber action |
| Criterion matrix | `.badge-manual-review` (+ existing `.badge-done`/`-failed`); `criterionMatrixHtml` / `criterionMatrixSummary` | — | one row per criterion — a state badge (pass/missing/failed/manual review), mono id, statement, required evidence, and the proof's own answered evidence refs (a link to the underlying artifact where one resolves, plain text otherwise); the SAME states and words on the task page, the run page, done, builds, board, inbox, and `task show` |
| Review judgement | reuses `.badge-done`/`-failed`/`-manual-review` (never a fourth color); `reviewJudgementBadge` | — | a second badge beside the matrix row's own — upholds/contradicts/cannot-tell read exactly as pass/failed/manual-review already do; hover title carries the reviewer's author and note |
| Diff review | `.diff-review`, `.diff-file`, `.diff-line`, `.diff-modes`, `.diff-annotate` | — | sealed patch rendered as folding files and hunks; View is quiet and default, Annotate reveals exact old/new-line targets; raw patch remains downloadable and annotations only become work through the separate revision act |
| Repair chain card | `.card.repair-chain`; `repairChainHtml` | — | one card, one chain — drafted (awaiting approval or mode-approved), resolved, or one of the three stops (attempts-spent, no-progress, integrity-refused); the same words on the task page and the run page, and the SAME shared `passFraction` helper (never a hand-rolled "N/M criteria") on board and chat |
| Card | `.card` | `Card` | surface, hairline, 0.5rem radius, faint shadow; never nested |
| Buttons | `button` (secondary), `form.card > [type=submit]` (primary), `.approve-form [type=submit]` (amber), `.danger` | `Button` | one primary per form; approve is the only amber verb |
| Fields | `input`, `textarea`, `select` | `Input` | surface-colored, hairline, hover darkens, focus halo |
| Section header | `h2` (+ `.lane-count` pill) | — | small semibold dim sans |
| Lane | `details.lane` with `summary > h2` | — | a column on a desktop, a folding section on a phone; a state dot on every header |
| Workspace card | `.workspace-card` | — | name · status word · four inset count cells · proportional bar · board tap |
| Chat workspace | `.chat-workspace` + `.chat-projects` + `.thread` | — | one bounded project pulse beside the shared mate thread; project actions remain ordinary guarded forms; an empty thread asks for one outcome, infers routine task fields, and keeps its prompt → suggestions → composer sequence in document flow on a phone |
| Switcher | `details.switcher` + `.switcher-menu` | `NavBar` | POST forms with the session token; a check marks the current row; inert on sensitive pages |
| Shell | `.side` 220px with icon rows; `.mobile-top` + `.tabbar` | `NavBar` | primary rows carry icons, the foot list stays text; one visible `/projects` link per breakpoint |

## 4. The board

Five lanes in pipeline order: needs you · queued · waiting · building · done
recently. Each lane is a `details` with its count in the summary and its
state dot on the header; a lane with cards is open, an empty one folds. On a
phone (≤760px) lanes stack, the summary is a 2.75rem tap with a drawn
chevron, and the poller preserves each fold across swaps.

A card: mono id eyebrow · title · one honest "why" · facts grid · chips. A
building card adds the live strip — stage word and elapsed clock in an inset
well, blue — never a percent.

## 4b. The task page

Modelled on issue detail in Linear, GitHub, and Jira (iOS): the page reads
top-down and every long thing folds.

1. **Eyebrow** — mono id · project · provenance.
2. **Title** with its state chip. A done task's dispatch-status box
   beneath it speaks the machine's own proof verdict (Priority 2) —
   *complete — verified*, *complete with evidence*, *needs verification*,
   or *proof refuted* — never re-derived from the page; an accepted
   short/refuted verdict keeps its word but reads `ok`, with an amber
   "accept anyway" form (`.approve-form`, the same rule as approving a
   scope) while it waits.
3. **Acts bar** — every verb in one row; the act that resolves the task's
   state first and primary (retry on a stalled task, plan-first with no
   scope, build-next in the queue); hold with its reason beside it; unhold
   when a hold exists. One line beneath says what the primary does. Cancel
   stays armed at the foot of the page, far from the primary.
4. **What waits on you** — when a scope waits for its yes, the approval
   ceremony IS the first card under the title (the consent-sheet shape:
   the wait stated, every bound term restated, the amber approve act in the
   first screen, "edit instead →" beside the heading); the acts bar then
   follows it with no competing primary. A scope the store cannot route
   gets the problem and a primary "edit the scope to fix it" road instead
   of a password. Otherwise the decision cards and the "this task is
   waiting on you" card, linking to the section that resolves it. The
   acceptance rubric restates immediately above the seal, in the same
   restated-text register as the goal and the touches above it — never a
   second thing to sign.
4a. **The criterion-to-evidence matrix** — a done task's dispatch-status
   box, and the run page's evidence bundle, gain one row per signed
   criterion beneath the verdict: a state badge (pass · missing · failed ·
   manual review), the criterion's id in mono, its statement in sans, and
   the evidence kinds it required. Denser surfaces (done, builds, board,
   inbox) collapse the same facts to a count chip ("2/3 criteria") plus
   the worst state present, rather than dropping the matrix — a
   grandfathered task with no rubric renders nothing extra at all.
5. **Property list** (the rail on a desktop, above the sections on a phone):
   worker or last attempt · queue place · scope with its seal · publishes as
   · this attempt · task total · strikes — one row grammar, dim key, mono
   value.
6. **Sections that fold**, each with its count: decisions, incidents,
   attempts (open), spend (folded), steering (open only when notes exist),
   scope (open; the edit form and the tournament fields fold inside it),
   waits for (folded when empty), holds.
7. **Full evidence and revision** — the result receipt links to the run's
   immutable record. Its diff opens in View mode: folding file rows, old/new
   gutters, quiet semantic add/delete color, and horizontal containment on a
   phone. Annotate is an explicit mode, not permanent chrome; selecting a line
   prefills one ordinary feedback form. Collected annotations stay inert until
   the separate revision card seals the exact batch into one unapproved task.

### 4b′. The review cockpit (`/review`)

A master/detail over completed work, built from the same rows the done view
and the run page read. Desktop: a sticky ranked queue (`minmax(15rem, 19rem)`)
beside one detail column; at 980px and below the two stack, the queue first
with a bounded scroll, so the phone reads queue → header → primary act →
sections. The rules:

- **Review priority is a chip, never a verdict.** Three words — *review
  first* (`badge-failed`), *look closer* (`badge-manual-review`), *routine*
  (`badge-done`) — and the reasons are always printed beside the chip, on the
  row and under the header. The proof word beside it is the receipt's own
  `receipt-proof` chip from the same `proofStateWords` mapping, so the
  cockpit and the task page never disagree: the stored verdict decides the
  word (a no-change run with a refuted proof still reads *Proof disagrees*),
  and only a completion with no build at all wears *No build record*.
- **The queue is a window, the link is stable.** The ranked queue lists at
  most the newest 100 completions and prints that cap in its hint when it
  reaches it; a `?result=` link to an older completion opens it directly
  with a muted `.cockpit-beyond` note ("opened directly … no row there"),
  never the "not in view" problem banner, which is reserved for tasks that
  are not done, not admitted, or do not exist.
- **One primary act** (`.cockpit-next`), chosen from the state: accept a
  short/refuted proof (the amber `.approve-form`, the same rule as approving
  a scope), compare a tournament, draft a CI repair, seal ready annotations,
  open the pull request, or plainly "nothing waits on you". Every other road
  stays in its own section. A bearer session sees the act named, never a form.
- **Sections in one scan path**, each a `.cockpit-section` card with an
  uppercase muted `h3`: approved intent → proof → what the agent said →
  what changed → annotate and revise → publication → operator notes. Every
  evidence row is labeled by source (`data-cockpit-source`: machine, agent,
  reviewer, screenshots, caveats), and an absent source says "none", never
  nothing.
- **Changed files carry their own priority** (`.cockpit-files`): outside the
  signed touches first (flagged `badge-failed`), then binary, dependency/CI/
  schema/credential paths, uncited files, and large changes, then churn. Each
  row anchors to its file in the sealed patch (`diff-file-<sha256[0..16]>`),
  which keeps its sealed order beneath. Signed touches match gitignore-style
  (`*` within one segment, `**/` across zero or more directories); the
  credential heuristic matches whole `-`/`_`/`.`-delimited pieces of the
  file name only, so `author.ts` or `permissions-ui.tsx` is never flagged.
- **Escaping and anchors.** Every displayed value goes through `escape`; the
  file anchor is derived from the path's bytes so a hostile name can neither
  break the id nor leave the attribute.

## 4c. The chat workspace

Chat is always an all-project surface. On a desk, a sticky project rail sits
beside the single mate thread; every admitted project shows needs-you, live,
queued, and finished-today counts, then two guarded forms: ask about its
stable `rN` alias or open its board. On a phone, those cards become one
horizontally scrolling row so the conversation remains in the first screen.
An empty thread offers three ordinary spend-authorized message forms, never
a separate action path. The mate still only proposes and every act still
lands as a confirmable card.

## 5. The shell

Desktop: a 220px sidebar (inbox · portfolio · work{board, queue} · builds ·
fleet, each with its icon; more: text rows) and a primary "+ new task". The
scope bar under the banner names what the screen shows; its name is the
switcher's summary, listing every served project and "all projects" as POST
forms returning to the same screen; "switch project →" keeps the road to
`/projects`.

Phone: one sticky header row — brand, the project pill (name · counts; tap
for the same menu as a sheet above the tab bar, with "manage projects →"),
quick capture — then the five-tab bar padded for the home indicator.
`viewport-fit=cover` makes the safe areas real.

Sensitive pages (a password ceremony on screen) gain no chrome scripts or
chrome forms: the switcher renders as the name and its one link. The minimal
same-origin session heartbeat remains, under the page's nonce and CSP.

## 6. Motion and browser surfaces

One navigation cross-fade (140ms) for navigation a person chose; liveness
swaps are instant; the pulse dot is the one "alive" signal; everything dies
under `prefers-reduced-motion`. Selection, caret, scrollbars, focus rings and
tabular numerals are themed from the palette in both schemes.

## 7. Recording a change

A token or component rule lands in three places in one commit: `src/serve.ts`,
`design/src/globals.css` (or the component), and this document. The ds-bundle
recompiles from the package (`_ds_needs_recompile`).

## 8. References (Mobbin)

The bar: [Linear issues](https://mobbin.com/screens/610d34b6-6ad8-45ab-80fb-2107b31ed01e)
(identifier + status icon on every row, dim section headers with counts),
[Linear inbox on iOS](https://mobbin.com/screens/3d9ccfd8-2425-49e9-a00b-27189140d3a3),
[Vercel project overview](https://mobbin.com/screens/21283de1-3b87-491d-9503-2a4c13f6a181)
(status dot + word, mono commit facts, black primary button, paper ground),
[Railway](https://mobbin.com/screens/cf56574a-01d3-4efe-b841-e091c9ecc39d)
(dark ops surfaces, status pills). Earlier board references:
[Plane](https://mobbin.com/screens/69990ffa-9153-4bf1-bb53-87317f9e040f),
[GitHub iOS](https://mobbin.com/screens/b2165009-6e10-4b74-9c30-4be5b19ad123),
[Asana iOS](https://mobbin.com/screens/51074f57-02ca-4420-9c8e-dc7317c4bcf6),
[Linear switcher](https://mobbin.com/screens/2679ae03-f852-47c3-a880-480c493c1369).

Declined on purpose: a blue brand accent (amber is the product's one accent
and it already carries meaning), Geist or Inter (Plex is vendored, licensed,
and already the product's voice; the system is the grammar, not the face), a
percent on builds, a select-then-confirm decision screen.
