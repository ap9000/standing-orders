# The reduction pass — the console against the Laws of UX (2026-09-03)

Assessed the demo console (desktop 1280, phone 390) against the twenty Laws
of UX. Six pass, seven are weak, seven fail, and the failures cluster in
three places: too many peers on every screen, prose where a product would
have structure, and one accent used for everything. The earlier reference
pass (`docs/DESIGN-SYSTEM.md` §8) took ornaments — eyebrows, dots, pills,
a check — on top of an information architecture that had never been
reduced. This pass reduces it. Each improvement below names the shipped
screen it is held to, the rule, and what a builder must make true. The
tasks are filed on this repository's own plane, chained in this order
because they all touch `src/serve.ts`.

Style rules that already stand (`docs/DESIGN-SYSTEM.md` §1–§3) are not
repeated: Plex stays, amber stays the one accent, no blue brand accent, no
percent on builds, no select-then-confirm decision screen.

## 1. Five destinations

**Shipped by hand, 2026-09-03** (`moreRows`, `buildsViews`, `QUEUE_VIEW`
in `src/serve.ts`; the reduction-pass describe in `src/serve.test.ts`).
The phone tab's badge became a dot after the Mobbin study (Linear Mobile);
done, review, and activity became a view strip on builds rather than rows
under more; the pill's "manage projects →" row went with the scope bar's
link, since the projects row/tab is the road.

**Finding (Hick, Pareto).** Fourteen sidebar rows: inbox, portfolio, board,
queue, builds, fleet, then eight text rows under "more". The operator's
whole job is three verbs — answer a question, approve a scope, retry a
stalled task — and they get equal billing with routines, review queue,
system, and requirements.

**Reference.** [Linear's sidebar](https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c):
Inbox and My issues first, then a Workspace group of three, then the
team's three views. Eight rows in three groups, no helper text, the
current row filled. [Vercel's project sidebar](https://mobbin.com/screens/b9d9cc23-34a1-434c-a4ed-52a2a4f49bb7)
is longer but every row is a noun for a screen, and the one alert
("Action Required") is the only accent on it.

**Make true.**
- Desktop sidebar: `inbox · board · builds · projects` and a `more`
  group; the phone tab bar is the same five. `queue` becomes a view of the
  board (a toggle on the board header, not a destination). `fleet`,
  `system`, `requirements`, `routines`, `people`, `mode`, `settings` live
  under `more` as plain rows. `activity`, `done`, `task list`, `review
  queue` become filters on the inbox/builds screens or rows under `more`.
- Every screen keeps its URL; nothing 404s. Redirects where a route moves.
- The "switch project →" link and the project pill do one job: the pill
  is the switcher; the link goes.
- Tests: the shell renders exactly five primary rows; every retired
  destination still answers 200 or 303.

## 2. No helper prose on list screens

**Finding (Prägnanz, Occam).** Every screen opens with a title, a subtitle
explaining the screen, and a button before content ("everything that
waits on you — empty means the fleet is working"; "clear the queue → one
thing at a time"). Every card carries a `meta` paragraph explaining its
mechanism. The queue page opens with a "how a worker takes from here"
disclosure.

**Reference.** [Linear's issue list](https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c):
section headers are the status word and a count, dim; rows are id, status
icon, title, labels, date. Not one explanatory sentence on the screen.
[Vercel's deployments](https://mobbin.com/screens/b9d9cc23-34a1-434c-a4ed-52a2a4f49bb7):
status dot and word, commit, branch, relative time; the filters ARE the
explanation.

**Make true.**
- Delete the subtitle under every `<h1>` on list screens (inbox,
  portfolio, board, queue, builds, task list, done, activity, fleet,
  routines, projects). A screen's name is its explanation.
- Delete the lane descriptions on the board ("these wait for a person",
  "one agent per card, in its own workspace").
- Delete the sentence under the acts bar on the task page ("plan first
  sends an agent to…"). The verb is the sentence. Where a verb genuinely
  needs a warning, it goes in the confirmation, not beside the button.
- Delete the queue page's explainer disclosure and the "workers take from
  here when their column is empty" line.
- Keep exactly one line of prose inside a ceremony (approve, cancel,
  attend, mint) — the sentence the signer must read.
- Tests: the list screens named above contain no `<p class="meta">`
  directly under their `<h1>`; the ceremony line is still asserted.

## 3. One accent, one place

**Shipped by hand, 2026-09-03.** Amber selectors are pinned as an exact
set by the reduction-pass describe; `.badge-parked`, `.seal`, the mate's
`.msg.op`, and `.answer-options li.picked` went neutral too. The lane
header's dot and count carry the colour for the cards beneath.

**Finding (Von Restorff).** Every needs-you card, every ceremony frame,
every count, the project pill's counts, the inbox badge — all amber.
Nothing can be emphasised because everything is.

**Reference.** [Vercel's overview](https://mobbin.com/screens/3aec6262-a4db-4ee0-a1a8-226a65e72d4b):
one black primary ("Add New…"), one red alert card, everything else
neutral. [Stitch's confirmation](https://mobbin.com/screens/27dbe300-4186-4f24-a4ce-3bb809355889)
and [Luma's](https://mobbin.com/screens/b2f3e086-827d-4567-bd62-90d3d8c65265):
a title, one sentence, a plain Cancel, one accent button.

**Make true.**
- Amber appears on exactly two things per screen: the primary act that
  resolves the screen (approve, answer, retry, confirm) and needs-you
  counts (sidebar badge, tab badge, lane header dot and count).
- Cards that wait on the operator wear the neutral border; the "needs you"
  lane header carries the colour for them. Ceremony frames are neutral;
  their primary button is amber.
- The project pill's counts are neutral text; only the needs-you number
  keeps the accent.
- Tests: a rendered inbox with three waiting cards contains the amber
  border class on zero cards and the accent on one button per card at
  most; the task page ceremony has one amber element.

## 4. The task page in three regions

**Finding (Miller, chunking).** Nine same-weight folding sections
(decisions, incidents, attempts, spend, steering, scope, waits for, holds,
report) plus a rail of seven properties, two of which say "unmeasured —
nothing reported".

**Reference.** [Linear's issue detail](https://mobbin.com/screens/cef36326-d8ec-4c6f-acd4-a9f1e1060d33):
title, description, sub-issues, Activity — three regions — and a
Properties rail of four rows. [The same page with activity](https://mobbin.com/screens/beb9d6b3-ec34-46d7-9332-320fcb32a338):
history is one dim list of "who did what · when", never a section per
kind of event.

**Make true.**
- Three regions under the title and acts bar: **waits on you** (the
  ceremony or the decision, when there is one), **scope** (goal, not,
  touches, seal, the edit fold), **history** (attempts, incidents, holds,
  steering notes, waits-for, and the report as ONE chronological list,
  each entry one line: kind word · what · when; the report's own card
  stays above history when it exists).
- Spend folds into the rail as one row when measured and is absent when
  not. The rail is at most five rows: last attempt, queue place, scope
  standing, publishes as, spend. "unmeasured — nothing reported" appears
  at most once, as the spend row's value.
- Cancel stays armed at the foot.
- Tests: the task page renders three `<details class="section">` at most;
  a task with two attempts, one incident, one hold shows four history
  lines in time order.

## 5. One vocabulary

**Finding (Jakob).** The project pill says "3 queued" while the board lane
beside it says "queued 0" — the pill counts tasks in state `queued`, the
board's lane counts tasks ready to dispatch, and tasks without an approved
scope sit under "needs you". The word means two things on one screen.

**Reference.** [GitHub Projects](https://mobbin.com/screens/cb8c4cdd-d35f-488d-be13-6a00daaed3f3):
the column header word, the item chip, and the filter value are the same
string with the same count. [Linear's board](https://mobbin.com/screens/720724d3-f686-457f-8c00-fa7efa409b12):
"Todo 4" in the tab strip is "Todo 4" on the column.

**Make true.**
- One status vocabulary, defined once (`src/board.ts` lanes), used by the
  pill, the lane headers, the task chips, the inbox sections, and the
  list filters: `needs you · queued · waiting · building · done · failed`.
  The pill's numbers are the board's lane counts, computed by the same
  function.
- A task in state `queued` with no approved scope is "needs you"
  everywhere, including the pill and the task list chip.
- Tests: for a seeded store, the pill's counts equal the board's lane
  counts; the chip word on the task list equals the lane the board puts
  the task in.

## 6. Mono for identifiers only

**Finding (Similarity).** Mono is used for ids, counts, rail values, whole
sentences ("no publication grant — built work stays on its branch"), and
a full temp path in the new-task subtitle. The eye cannot tell identifier
from prose.

**Reference.** [Vercel's deployments](https://mobbin.com/screens/b9d9cc23-34a1-434c-a4ed-52a2a4f49bb7):
mono for the deployment id and the commit sha only; status, branch, and
time are prose. [Linear's issue detail](https://mobbin.com/screens/cef36326-d8ec-4c6f-acd4-a9f1e1060d33):
the identifier in the breadcrumb is the only mono on the page.

**Make true.**
- Mono is used for: task ids, run numbers, digests, branch names, commit
  shas, worker names, and money/duration figures in tables. Nothing else.
- Rail values that are sentences become prose in the body colour;
  "unmeasured" becomes an empty state, once.
- No filesystem path in prose anywhere; a project is named by its
  `projectName`, and the path appears only on the projects screen, mono,
  as a value.
- Tests: the task page rail contains no `<span class="mono">` wrapping a
  string with a space in it except money and durations; the new-task
  screen contains no `/` path.

## 7. Empty and missing states inside the shell

**Finding (Jakob, Postel).** `/settings` on the demo is a bare "nothing
here" in monospace on black with no chrome. Empty lanes on the board carry
a count of zero and a description. An empty inbox says "Nothing needs
you" as a card.

**Reference.** [Basedash](https://mobbin.com/screens/e8be089a-4841-4693-852b-427c96690749)
and [Vapi](https://mobbin.com/screens/cea436b7-66d8-48e6-b6d5-3f2a4cfed022):
an empty screen is a centred one-line title, one sentence at most, and
one action, inside the shell.

**Make true.**
- Every 404 and every "not on this server" answer renders inside the
  shell for a signed-in session: one line saying what is not here and one
  link back. Unauthenticated 404s stay bare.
- The empty state for a screen is one centred line and at most one
  action; empty lanes on the board show the header and nothing else.
- Tests: `/settings` on a server without a token file renders the shell
  and a one-line empty state; an empty lane renders no description.

## What is deliberately not in this pass

A redesign of the decision page (it already passes), the login page (it
passes), new components, new colours, motion, or any change to what the
plane does. This is subtraction.
