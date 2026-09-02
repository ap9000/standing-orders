# The Operations Ledger — design system

The one visual world the console and its React package share. `src/serve.ts`
implements it as plain CSS; `design/` implements it as a shadcn theme with the
same tokens. When they disagree, this document decides, and the token values
in `design/src/globals.css` and the `:root` block of `src/serve.ts` are
brought back together in the same commit.

## 1. Voice

- **Dark ink, one hue.** The ground is marine ink at ~210°; every surface
  above it is the same hue, lighter. No gradients, no glass, no colored
  stripes on an edge.
- **Amber means one thing.** `--brand` / `--primary` (#f5a524) marks work that
  waits on a person — a card's outline, a count, a chip — and nothing else. A
  recommended option is never amber; a selected row is never blue.
- **Two faces.** IBM Plex Sans is the human voice: titles, sentences, hints.
  IBM Plex Mono is every machine fact: ids, workers, models, clocks, dollars,
  digests. Mono is never a costume for "technical".
- **Plain words, honest words.** "needs you", "building", "queued",
  "waiting", "done". "measured" or "unmeasured", never a summed $0. A build
  shows a stage and a clock, never a percent — there is no honest progress
  figure for an agent.
- **Drawn icons.** One stroke weight (1.75), from the tab bar's set. Never a
  unicode glyph or emoji standing in for an icon.

## 2. Tokens

| Token | Value | Role |
|---|---|---|
| `--background` | `#0f171f` | ground (PMS 5395 C) |
| `--card` | `#16212b` | surface (PMS 433 C) |
| `--muted` / `--secondary` / `--accent` | `#1c2937` | inset wells, menus' hover |
| `--border` | `#283747` | hairlines (PMS 432 C) |
| `--input` | `#5d7185` | control boundaries (≥3:1 on ground and surface) |
| `--muted-foreground` | `#8fa0af` | dim text (PMS 430 C) |
| `--foreground` | `#eaeef2` | text (Cool Gray 1 C) |
| `--brand` / `--primary` | `#f5a524` | waits on you (PMS 137 C) |
| `--running` | `#5ca9ff` | a live build |
| `--success` / `--built` | `#3ecf8e` | built |
| `--destructive` / `--failed` | `#f06a5e` | failed, and the arm-to-cancel act |
| `--radius` | `0.625rem` | cards; `-2px` for rows, `-4px` for chips and wells |
| `--font-sans` | IBM Plex Sans | the human voice |
| `--font-mono` | IBM Plex Mono | every machine fact |

Type scale: body 15px/1.55; meta 13px; chips and facts 11px; h1 1.375rem
tracking -0.01em; section h2 uppercase mono 11px with 0.08em tracking.
Spacing rhythm: 0.125 / 0.375 / 0.625 / 0.875 / 1.25rem; more space above a
heading than below it.

## 3. Components and their two implementations

| Component | Console (CSS class) | Package (`design/src`) | Rule |
|---|---|---|---|
| Status chip | `.badge`, `.badge-open` (amber), `.badge-running`, `.badge-done`, `.badge-failed` | `StatusChip` | five words, 12%-tint outline pill; amber only for waits-on-you |
| Attention card | `.decide-card`, `.lane-attention .lane-card` | `AttentionCard` | amber outline on the whole card, never a stripe |
| Ledger row | `p.row` with `.mono` meta and a chip | `LedgerRow` | title · mono facts · chip at the end |
| Key–value | `.lane-card .facts` (`.fact > .k + .v`) | `KeyValueRow` | dim mono key, ink mono value |
| Digest seal | `.seal` | `DigestSeal` | the signed digest, mono, boxed |
| Page header | `h1` + `.hint`, `.control-room-head` | `PageHeader` | name over a hairline, quiet subtitle, right actions |
| Card | `.card` | `Card` | surface + hairline + radius; never nested |
| Lane | `details.lane` with `summary > h2` | — | a column on a desktop, a folding section on a phone |
| Workspace card | `.workspace-card` | — | name · status word · four counts · proportional bar · board tap |
| Project switcher | `details.switcher` + `.switcher-menu` | `NavBar` (desktop) | POST forms with the session's token; inert on sensitive pages |
| Shell | `.side` (desktop), `.mobile-top` + `.tabbar` (phone) | `NavBar` | one visible `/projects` link per breakpoint |

## 4. The board

Five lanes in pipeline order: **needs you · queued · waiting · building · done
recently**. Each lane is a `details` with its count in the summary; a lane
with cards is open, an empty lane folds. On a desktop the lanes are columns
and the summary is not a control; on a phone (≤760px) they stack, the summary
is a 2.75rem tap with a drawn chevron, and the poller preserves each fold
across swaps.

A card reads the same in every lane:

1. title (with the live dot on a building card);
2. **why** — one honest phrase for the lane ("write its scope", "failed",
   the question);
3. **facts** — mono key–value pairs: `task`, `worker`, `runtime`/`waiting`,
   `model`, `branch`, `ran`, `cost`;
4. **chips** — project (all-projects view), routine, reservation, PR, outcome.

A building card adds the **live strip**: the run's stage word and elapsed
clock in an inset well, blue. No percent, no bar.

## 5. The shell

Desktop: a 232px sidebar (inbox · portfolio · work{board, queue} · builds ·
fleet · more), and a scope bar under the banner naming what the screen shows
— the name is the switcher's summary; the menu lists every served project and
"all projects" as plain POST forms carrying the session's csrf and returning
to the same screen; "switch project →" keeps the road to `/projects`.

Phone: one sticky header row — brand, the project pill (name · counts;
tapping it opens the same menu as a sheet above the tab bar, with "manage
projects →" as the one `/projects` link), and quick capture — then a fixed
five-tab bar (inbox · board · queue · builds · more) padded for the home
indicator. `viewport-fit=cover` makes the safe areas real.

Sensitive pages (a password ceremony on screen) gain no scripts and no chrome
forms: the switcher renders as the name and its one link.

## 6. Motion and browser surfaces

One navigation cross-fade (140ms) for navigation a person chose; liveness
swaps are instant; the pulse dot is the one "alive" signal; everything dies
under `prefers-reduced-motion`. Selection, caret, scrollbars, focus rings and
tabular numerals are themed from the palette — never left at browser defaults.

## 7. Recording a change

A change to a token or a component's rule lands in three places in one
commit: `src/serve.ts`, `design/src/globals.css` (or the component), and this
document. The ds-bundle recompiles from the package (`_ds_needs_recompile`).
