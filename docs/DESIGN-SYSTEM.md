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
| Card | `.card` | `Card` | surface, hairline, 0.5rem radius, faint shadow; never nested |
| Buttons | `button` (secondary), `form.card > [type=submit]` (primary), `.approve-form [type=submit]` (amber), `.danger` | `Button` | one primary per form; approve is the only amber verb |
| Fields | `input`, `textarea`, `select` | `Input` | surface-colored, hairline, hover darkens, focus halo |
| Section header | `h2` (+ `.lane-count` pill) | — | small semibold dim sans |
| Lane | `details.lane` with `summary > h2` | — | a column on a desktop, a folding section on a phone; a state dot on every header |
| Workspace card | `.workspace-card` | — | name · status word · four inset count cells · proportional bar · board tap |
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
2. **Title** with its state chip.
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
   waiting on you" card, linking to the section that resolves it.
5. **Property list** (the rail on a desktop, above the sections on a phone):
   worker or last attempt · queue place · scope with its seal · publishes as
   · this attempt · task total · strikes — one row grammar, dim key, mono
   value.
6. **Sections that fold**, each with its count: decisions, incidents,
   attempts (open), spend (folded), steering (open only when notes exist),
   scope (open; the edit form and the tournament fields fold inside it),
   waits for (folded when empty), holds.

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

Sensitive pages (a password ceremony on screen) gain no scripts and no chrome
forms: the switcher renders as the name and its one link.

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
