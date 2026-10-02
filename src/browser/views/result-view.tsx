/** The one result page, rebuilt with shadcn/ui and titled with the task: its
 * status (one sentence, the facts, a line per caveat), then each item a person
 * checks with its evidence, then the decision (exactly one ink act that
 * resolves the result, never navigation), then Summary / Changes / Checks and
 * the feedback form, then Details with the raw run record. The list of results
 * sits one tap away in the header. Tab contents, the diff and the feedback
 * form stay the server's own HTML; the page script binds to the same data
 * attributes and ids it always has. */
import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";
import type { BrowserCheckItem, BrowserResultPanel, BrowserResultView } from "../../browser-workspace.js";
import { GuardedHtml } from "../guarded-html.js";
import {
  Badge, Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, cn,
} from "../components/ui/index.js";
import type { ResultActKind } from "../../result-acts.js";
import { toneOf } from "./tone.js";
import { ConfirmStoppedForm, RebuildForm, StatusDetails, StatusHeadline, statusWhyLines } from "./status-summary.js";

type Selected = NonNullable<BrowserResultView["selected"]>;

const DOT: Record<string, string> = {
  attention: "bg-attention", danger: "bg-destructive", info: "bg-info", success: "bg-success", neutral: "bg-muted-foreground", warning: "bg-warning",
};

function Html({ html, className }: { html: string; className?: string }) {
  return <GuardedHtml html={html} immutable {...(className === undefined ? {} : { className })} />;
}

/** Local time: the clock for today, otherwise the date. */
function shortWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) }).format(date);
}

function ResultsMenu({ view }: { view: BrowserResultView }) {
  if (view.results.length === 0) return null;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm">
        Results <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{view.results.length}</span>
        {view.attention > 0 && <span className="rounded-full bg-attention px-1.5 text-xs tabular-nums text-on-attention" title={`${view.attention} need your attention`}>{view.attention}</span>}
        <ChevronDown />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-[70vh] w-80 overflow-y-auto">
      {view.attention > 0 && <DropdownMenuLabel className="text-xs text-attention">{view.attention} need{view.attention === 1 ? "s" : ""} your attention</DropdownMenuLabel>}
      {view.results.map(row => <DropdownMenuItem key={row.href} asChild>
        <a href={row.href} aria-current={row.current ? "page" : undefined} className={cn("flex items-start gap-2.5", row.current && "bg-accent")}>
          <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", row.status === null ? "bg-muted-foreground" : DOT[toneOf(row.status.tone)])} />
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate", row.needsYou ? "font-semibold" : "font-medium")}>{row.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {[row.status?.label, ...row.notes, shortWhen(row.at)].filter(Boolean).join(" · ")}
            </span>
          </span>
        </a>
      </DropdownMenuItem>)}
      {view.capped !== null && <><DropdownMenuSeparator /><DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Showing the newest {view.capped}; older results open from their task.</DropdownMenuLabel></>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** The status card: the headline, one sentence, the facts rows, then any caveat as one line of its own.
 * No acts here: the result's acts sit together in the decision row. */
function StatusCard({ selected }: { selected: Selected }) {
  const { panel, checks, acts } = selected;
  // A fact row's action that only reopens this same page is dropped; links to its Checks tab or a section stay.
  const same = (href: string | null): boolean => {
    if (href === null) return false;
    const to = new URL(href, window.location.origin);
    return to.pathname === "/review" && to.searchParams.get("result") === selected.taskId && !to.searchParams.has("tab") && to.hash === "";
  };
  const status = panel?.status == null ? null
    : { ...panel.status, details: panel.status.details.map(one => one.action !== null && same(one.action.href) ? { ...one, action: null } : one) };
  const tone = toneOf(selected.status.tone);
  // A form that resolves a Needs you (Build again, Confirm it stopped) keeps the need's own sentence; otherwise what happened.
  const needForm = acts.primary === "rebuild" || acts.primary === "confirm-stopped";
  const sentence = selected.noRun ?? (panel !== null && !needForm ? panel.outcome : status?.sentence ?? panel?.outcome ?? "");
  const caveats = [...new Set([
    ...(status === null && checks?.problem === true ? [checks.detail] : []),
    ...(selected.problem === null ? [] : [selected.problem]),
    ...(panel?.attention ?? []),
  ])];
  const failed = status?.headline === "Failed";
  return <Card data-result-status={selected.status.token} data-headline={status?.headline ?? selected.status.label} aria-label="Result status">
    <div className="min-w-0">
      {status !== null ? <StatusHeadline status={status} />
        : <h2 className="flex items-center gap-2.5 text-lg font-semibold leading-snug">
            <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", DOT[tone])} />{selected.status.label}
          </h2>}
      {sentence !== "" && <p className="mt-1.5 max-w-[75ch] text-sm text-muted-foreground" data-result-sentence>{sentence}</p>}
    </div>
    {status !== null && <StatusDetails status={status} />}
    {caveats.length > 0 && <ul className="flex flex-col gap-1 text-[13px]" aria-label="Caveats" data-result-attention={caveats.length}>
      {caveats.map(one => <li key={one} data-caveat className="flex gap-2">
        <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", failed ? "text-destructive" : "text-warning")} aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{one}</span>
      </li>)}
    </ul>}
  </Card>;
}

/** Not right: the request form opens with the item quoted, ready for the why. */
function requestChange(statement: string) {
  const form = document.getElementById("comment-form");
  const box = form?.querySelector<HTMLTextAreaElement>("textarea[name=note]") ?? null;
  const shell = form?.closest("details") ?? null;
  if (shell !== null && !shell.open) shell.open = true;
  if (box === null) { window.location.hash = "request-changes"; return; }
  const quote = `Not right: “${statement}” — `;
  if (!box.value.includes(quote)) box.value = box.value.trim() === "" ? quote : `${box.value.trimEnd()}\n\n${quote}`;
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

/** The changed lines an item cites, wrapped: a phone never scrolls sideways to read them. */
function Excerpt({ excerpt, changesHref }: { excerpt: BrowserCheckItem["excerpts"][number]; changesHref: string | null }) {
  return <figure className="overflow-hidden rounded-md border border-border" data-check-excerpt={excerpt.path}>
    <figcaption className="flex flex-wrap items-baseline gap-x-2 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
      <span className="font-mono text-foreground [overflow-wrap:anywhere]">{excerpt.path}</span>
      {!excerpt.cited && <span>first changed file</span>}
    </figcaption>
    <ol className="font-mono text-xs leading-relaxed">
      {excerpt.lines.map((line, index) => <li key={index} data-kind={line.kind}
        className={cn("grid grid-cols-[2.5rem_1rem_minmax(0,1fr)] px-1 py-0.5", line.kind === "addition" ? "bg-success-soft" : line.kind === "deletion" ? "bg-destructive-soft" : "")}>
        <span className="select-none pr-2 text-right text-muted-foreground tabular-nums">{line.line ?? ""}</span>
        <span aria-hidden="true" className="select-none text-muted-foreground">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}</span>
        <code className="whitespace-pre-wrap rounded-none bg-transparent p-0 font-mono text-xs text-foreground [overflow-wrap:anywhere]"><span className="sr-only">{line.kind === "addition" ? "Added: " : line.kind === "deletion" ? "Removed: " : ""}</span>{line.text}</code>
      </li>)}
    </ol>
    {excerpt.more > 0 && <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
      {excerpt.more} more changed line{excerpt.more === 1 ? "" : "s"}{changesHref === null ? "" : <> in <a href={changesHref} data-result-goto="changes" className="underline underline-offset-4">Changes</a></>}
    </p>}
  </figure>;
}

/** "You check this one": each item with its evidence inline, then Looks right or Not right.
 * Looks right on the last item records the person's acceptance (the same accept-proof as
 * ever) when it is offered here; until then the marks are only on this page. */
function CheckItems({ panel, csrf, chatHref }: { panel: BrowserResultPanel; csrf: string; chatHref: string }) {
  const youCheck = panel.youCheck!;
  const items = youCheck.items.length > 0 ? youCheck.items : youCheck.lines.map((words, index) => ({ id: `line-${index}`, statement: "", words, note: null, excerpts: [], shots: [] }));
  const [looked, setLooked] = useState<ReadonlySet<string>>(new Set());
  const accept = youCheck.accept;
  const changesHref = panel.tabs.find(tab => tab.key === "changes")?.href ?? null;
  return <Card aria-labelledby="you-check-title" data-result-you-check={items.length} className="gap-0 p-0 phone:gap-0 phone:p-0">
    <h2 id="you-check-title" className="px-5 pb-1 pt-4 text-[15px] font-semibold phone:px-4">{items.length === 1 ? "You check this one" : `You check these ${items.length}`}</h2>
    <ul className="divide-y divide-border">
      {items.map(item => {
        const done = looked.has(item.id);
        const last = !done && items.every(one => one.id === item.id || looked.has(one.id));
        return <li key={item.id} data-check-item={item.id} data-looks-right={done ? "1" : undefined} className="flex flex-col gap-3 px-5 py-4 phone:px-4">
          <p className="max-w-[75ch] text-sm font-medium">{item.statement === "" ? item.words : item.statement}</p>
          {item.note !== null && <p className="max-w-[75ch] text-[13px] text-muted-foreground">The agent says: {item.note}</p>}
          {item.excerpts.map(one => <Excerpt key={one.path} excerpt={one} changesHref={changesHref} />)}
          {item.shots.length > 0 && <ul className="flex flex-wrap gap-2" aria-label="Screenshots">
            {item.shots.map(shot => <li key={shot.src}><a href={shot.href} className="block overflow-hidden rounded-md border border-border hover:border-muted-foreground" title={shot.caption}>
              <img src={shot.src} alt={shot.caption} loading="lazy" className="h-24 w-auto max-w-[12rem] object-cover phone:h-20" />
            </a></li>)}
          </ul>}
          <div className="flex flex-wrap gap-2">
            {accept !== null && last
              ? <Button type="submit" form="you-check-accept" variant="outline" className="min-h-11 phone:flex-1" data-looks-right data-accept-result><Check />Looks right</Button>
              : <Button variant="outline" aria-pressed={done} className="min-h-11 aria-pressed:bg-success-soft aria-pressed:text-success phone:flex-1" data-looks-right
                  onClick={() => setLooked(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}><Check />Looks right</Button>}
            {panel.canRequest
              ? <Button variant="ghost" className="min-h-11 phone:flex-1" data-not-right onClick={() => requestChange(item.statement === "" ? item.words : item.statement)}>Not right</Button>
              : <Button asChild variant="ghost" className="min-h-11 phone:flex-1"><a href={chatHref} data-not-right>Not right</a></Button>}
          </div>
        </li>;
      })}
    </ul>
    {accept !== null && <form id="you-check-accept" method="post" action={accept.action} hidden>
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="run" value={String(accept.run)} />
      <input type="hidden" name="return" value={accept.returnTo} />
    </form>}
  </Card>;
}

/** The decision, after the evidence: exactly one ink act, the one that resolves the result (result-acts.ts),
 * never a link elsewhere, and at most one outline act beside it, in one row with an 8px gap. A result that
 * can't be accepted says why in one line first. Under them, what Accept does. On a phone it is a
 * full-width dock at the bottom: the ink act over the outline one. */
function Decision({ selected, csrf }: { selected: Selected; csrf: string }) {
  const { acts, decision, next } = selected;
  const complete = selected.complete;
  const need = selected.panel?.need ?? null;
  const accept = complete === null ? need?.accept ?? null : null;
  const shown = [acts.primary, acts.secondary].filter((one): one is ResultActKind => one !== null);
  const why = shown.includes("accept") ? decision?.why ?? null : null;
  const noted = acts.primary === "revise" || acts.primary === "draft-repair" ? next?.title ?? null : null;
  const line = acts.line ?? why ?? noted;
  const act = (kind: ResultActKind, ink: boolean): ReactNode => {
    const variant = ink ? "attention" as const : "outline" as const;
    const mark = { "data-act": kind, ...(ink ? { "data-ink-act": kind, "data-primary-action": "" } : {}) };
    const wide = "min-h-11 phone:w-full";
    switch (kind) {
      case "accept":
        if (decision === null) return null;
        if (complete !== null) return <form key={kind} method="post" action={complete.action} className="phone:w-full">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="receipt" value={complete.receipt} />
          <input type="hidden" name="run" value={String(complete.run)} />
          <Button type="submit" variant={variant} className={wide} {...mark}><Check className="phone:hidden" />{decision.label}</Button>
        </form>;
        if (accept === null) return null;
        return <form key={kind} method="post" action={accept.action} className="flex flex-wrap items-center gap-2 phone:w-full">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="run" value={String(accept.run)} />
          <input type="hidden" name="return" value={accept.returnTo} />
          {accept.note !== null && <Input type="text" name="note" maxLength={500} required aria-label={accept.note} placeholder={accept.note} className="h-11 w-64 phone:w-full" />}
          <Button type="submit" variant={variant} className={wide} {...mark} data-accept-result><Check className="phone:hidden" />{decision.label}</Button>
        </form>;
      case "run-checks":
        if (selected.runChecks === null) return null;
        return <form key={kind} method="post" action={selected.runChecks.action} className="phone:w-full">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="level" value={selected.runChecks.level} />
          <input type="hidden" name="return" value={selected.runChecks.returnTo} />
          <Button type="submit" variant={variant} className={wide} {...mark}>Run checks</Button>
        </form>;
      case "request-changes":
        return <Button key={kind} asChild variant={variant} className={wide}><a href="#request-changes" {...mark}>Request changes</a></Button>;
      case "rebuild":
        return need?.rebuild == null ? null : <RebuildForm key={kind} action={need.rebuild.action} csrf={csrf} label={need.label} className="min-h-11" />;
      case "confirm-stopped":
        return need?.confirm == null ? null : <ConfirmStoppedForm key={kind} form={need.confirm} csrf={csrf} label={need.label} />;
      case "revise":
      case "draft-repair":
        return next === null ? null : <Html key={kind} html={next.control} className="so-result-next phone:w-full" />;
    }
  };
  if (shown.length === 0) return null;
  return <Card data-result-decision={acts.primary ?? "none"} aria-label="Decision"
    className="gap-2 phone:sticky phone:bottom-[-20px] phone:z-10 phone:-mx-4 phone:gap-2 phone:rounded-none phone:border-x-0 phone:px-4 phone:pb-[max(14px,env(safe-area-inset-bottom))] phone:shadow-[0_-4px_16px_rgb(0_0_0/.08)]">
    {line !== null && <p className="flex max-w-[75ch] gap-2 text-[13px]" data-decision-why {...(acts.line === null ? {} : { "data-cant-accept": "" })}>
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />{line}</p>}
    <div className="flex flex-wrap items-center gap-2 phone:flex-col phone:items-stretch" data-result-acts>
      {acts.primary !== null && act(acts.primary, true)}
      {acts.secondary !== null && act(acts.secondary, false)}
    </div>
    {decision !== null && shown.includes("accept") && <p className="max-w-[75ch] text-[13px] text-muted-foreground" data-decision-effect>{decision.effect}</p>}
  </Card>;
}

/** Summary / Changes / Checks. The tab links keep the page script's
 * attributes, so it switches views in place and remembers the choice. */
function Panel({ panel }: { panel: BrowserResultPanel }) {
  return <div id="result" {...panel.attributes} className="flex scroll-mt-4 flex-col gap-4">
    {panel.history !== "" && <Html html={panel.history} />}
    <Card className="gap-0 overflow-hidden p-0 phone:p-0">
      <nav role="tablist" aria-label="Result views" className="flex gap-1 overflow-x-auto border-b border-border px-3 phone:px-2">
        {panel.tabs.map(tab => <a key={tab.key} role="tab" href={tab.href} data-result-tab={tab.key} aria-selected={tab.active ? "true" : "false"} {...(tab.active ? {} : { tabIndex: -1 })}
          className="-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground aria-selected:border-primary aria-selected:text-foreground phone:min-h-11">
          {tab.label}{tab.count !== "" && <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums">{tab.count}</span>}
        </a>)}
      </nav>
      {panel.views.map(one => <div key={one.key} role="tabpanel" data-result-view={one.key} hidden={!panel.tabs.some(tab => tab.key === one.key && tab.active)} className="px-5 py-4 phone:px-4">
        <Html html={one.html} className="so-result-view" />
      </div>)}
    </Card>
    {/* With nothing saved yet, the form waits hidden until Request changes
        (or a line note) opens it; the page script opens it in place. */}
    {panel.request !== null && <Card id="request-changes" className={cn("result-request scroll-mt-4 gap-3", panel.requestQuiet && "hidden has-[details[open]]:flex")}>
      <Html html={panel.request} className="so-result-request" />
    </Card>}
  </div>;
}

/** Secondary detail, one tap away: the scope, the notes, the recorded reasons, what was shortened,
 * review history, and the raw run record (what /r/<id> used to open on its own). */
function Details({ selected }: { selected: Selected }) {
  const learning = selected.panel?.learning ?? "";
  const panel = selected.panel;
  const why = panel?.status == null ? [] : statusWhyLines(panel.status);
  const record = selected.record;
  const rows: { id: string; title: string; hint: string | null; count?: number; body: ReactNode }[] = [
    { id: "intent", title: "Approved scope", hint: selected.intent?.approval ?? null,
      body: selected.intent === null ? <p className="text-sm text-muted-foreground">No scope was filed for this task, so there is no approved goal or boundary to review.</p> : <Html html={selected.intent.html} className="so-result-intent" /> },
    ...(selected.notes.length === 0 ? [] : [{ id: "notes", title: "Notes", hint: null, count: selected.notes.length,
      body: <ul className="flex flex-col gap-2 text-sm">{selected.notes.map((one, index) => <li key={index}><span className="text-muted-foreground">{one.author} · {shortWhen(one.at)}</span> {one.note}</li>)}</ul> }]),
    ...(why.length === 0 ? [] : [{ id: "why", title: "Recorded reasons", hint: null, count: why.length,
      body: <div className="flex flex-col gap-1 text-[13px] text-muted-foreground" data-status-why>{why.map(one => <p key={one} className="[overflow-wrap:anywhere]">{one}</p>)}</div> }]),
    ...(panel === null || panel.limits.length === 0 ? [] : [{ id: "limits", title: "What was shortened", hint: null, count: panel.limits.length,
      body: <ul className="flex flex-col gap-1 text-[13px] text-muted-foreground">{panel.limits.map(one => <li key={one}>{one}</li>)}</ul> }]),
    ...(panel?.reviewHistory == null ? [] : [{ id: "review-history", title: "Review history", hint: null,
      body: <p className="text-[13px] text-muted-foreground">{panel.reviewHistory}</p> }]),
    ...(record === null ? [] : [{ id: "run-record", title: "Run record", hint: `Build #${record.build}`,
      body: <div className="flex flex-col gap-3 text-[13px]">
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {record.facts.map(one => <div key={one.label} className="contents"><dt className="text-muted-foreground">{one.label}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{one.value}</dd></div>)}
        </dl>
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {selected.checks?.logHref != null && <a href={selected.checks.logHref} className={META_LINK}>Check output</a>}
          <a href={record.href} className={META_LINK}>Full run record</a>
        </p>
      </div> }]),
  ];
  return <Card aria-label="Result details" className="gap-0 divide-y divide-border overflow-hidden p-0 phone:p-0">
    {learning !== "" && <div data-cockpit-section="learning"><Html html={learning} className="so-result-learning" /></div>}
    {rows.map(row => <details key={row.id} id={row.id} className="group scroll-mt-4" data-cockpit-section={row.id}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 hover:bg-accent/50 phone:min-h-12 phone:px-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
        <h2 className="text-[15px] font-semibold">{row.title}</h2>
        {row.count !== undefined && <Badge>{row.count}</Badge>}
        {row.hint !== null && <span className="min-w-0 truncate text-[13px] text-muted-foreground">{row.hint}</span>}
      </summary>
      <div className="px-5 pb-5 pt-1 phone:px-4">{row.body}</div>
    </details>)}
  </Card>;
}

/** A meta link: underlined quietly, and a 44px target on a phone without growing the line. */
const META_LINK = "font-medium text-foreground/80 underline decoration-border underline-offset-4 hover:decoration-muted-foreground phone:inline-flex phone:min-h-11 phone:items-center";

/** Build #: open the run record under Details and bring it into view. */
function openRecord(event: MouseEvent<HTMLAnchorElement>) {
  const record = document.getElementById("run-record");
  if (!(record instanceof HTMLDetailsElement)) return;
  event.preventDefault();
  record.open = true;
  record.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  history.replaceState(history.state, "", "#run-record");
}

export function ResultView({ view, csrf }: { view: BrowserResultView; csrf: string }) {
  const selected = view.selected;
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
    <header className="flex flex-col gap-3 pb-1">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight phone:text-[22px]">{selected?.title ?? "Results"}</h1>
          {selected !== null && <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground phone:gap-y-0" data-result-meta>
            {selected.project !== null && <><span className="font-medium text-foreground/80">{selected.project}</span><span aria-hidden="true">·</span></>}
            {selected.record !== null && <><a href="#run-record" onClick={openRecord} className={META_LINK}>Build #{selected.record.build}</a><span aria-hidden="true">·</span></>}
            <a href={selected.taskHref} className={META_LINK}>Open task</a>
            <span aria-hidden="true">·</span>
            <a href={selected.chatHref} className={META_LINK}>Discuss</a>
          </p>}
        </div>
        {selected !== null && <ResultsMenu view={view} />}
      </div>
      {view.missing !== null && <p role="status" className="rounded-md bg-muted px-3 py-2 text-[13px] text-foreground">{view.missing}{selected !== null ? " Showing the newest result instead." : ""}</p>}
      {view.beyond && <p className="text-[13px] text-muted-foreground">This result is older than the list in Results.</p>}
    </header>

    {selected === null
      ? view.results.length === 0
        ? <Card className="items-start py-10"><p className="text-base text-muted-foreground">Nothing to review yet.</p><Button asChild variant="outline"><a href="/work">Open tasks</a></Button></Card>
        : <Card aria-label="Results" className="gap-0 overflow-hidden p-0 phone:p-0">
            <ul className="divide-y divide-border">{view.results.map(row => <li key={row.href} className="flex items-start gap-3 px-5 py-3 phone:px-4">
              <span aria-hidden="true" className={cn("mt-2 size-2 shrink-0 rounded-full", row.status === null ? "bg-muted-foreground" : DOT[toneOf(row.status.tone)])} />
              <div className="min-w-0 flex-1">
                <a href={row.href} className={cn("block truncate hover:underline hover:underline-offset-4", row.needsYou ? "font-semibold" : "font-medium")}>{row.title}</a>
                <p className="truncate text-[13px] text-muted-foreground">{[row.status?.label, ...row.notes, shortWhen(row.at)].filter(Boolean).join(" · ")}</p>
              </div>
            </li>)}</ul>
          </Card>
      : <>
          <StatusCard selected={selected} />
          {selected.panel?.youCheck != null && <CheckItems panel={selected.panel} csrf={csrf} chatHref={selected.chatHref} />}
          <Decision selected={selected} csrf={csrf} />
          {selected.panel !== null && <Panel panel={selected.panel} />}
          {selected.contest !== "" && <Html html={selected.contest} />}
          <Details selected={selected} />
        </>}
  </div>;
}
