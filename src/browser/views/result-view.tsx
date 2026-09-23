/** A finished result, rebuilt with shadcn/ui: its status, outcome and the
 * one or two things to do with it first, then Summary / Changes / Checks,
 * then the feedback form. The list of results sits one tap away in the
 * header instead of beside the result. Tab contents, the diff and the
 * feedback form stay the server's own HTML; the page script binds to the
 * same data attributes and ids it always has. */
import { AlertTriangle, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import type { BrowserResultChip, BrowserResultPanel, BrowserResultView } from "../../browser-workspace.js";
import { GuardedHtml } from "../guarded-html.js";
import {
  Badge, Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, cn,
} from "../components/ui/index.js";
import { toneOf } from "./tone.js";

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

function Chip({ chip }: { chip: BrowserResultChip }) {
  return <Badge tone={chip.tone} {...(chip.title === null ? {} : { title: chip.title })}>
    {chip.icon === "check" ? <Check /> : chip.icon === "x" ? <X /> : null}{chip.label}
  </Badge>;
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

function StatusCard({ selected, csrf }: { selected: Selected; csrf: string }) {
  const tone = toneOf(selected.status.tone);
  const { panel, complete, checks, next } = selected;
  return <Card data-result-status={selected.status.token} aria-label="Result status"
    className={cn(tone === "attention" && "border-attention/50", tone === "danger" && "border-destructive/50")}>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-64">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold leading-snug">
          <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", DOT[tone])} />{selected.status.label}
        </h2>
        {panel !== null && <p className="mt-1.5 text-sm"><span className="font-semibold">{panel.heading}.</span> <span className="text-muted-foreground">{panel.outcome}</span></p>}
      </div>
      {(complete !== null || panel?.canRequest === true) && <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
        {complete !== null && <form method="post" action={complete.action} className="max-sm:flex-1">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="receipt" value={complete.receipt} />
          <input type="hidden" name="run" value={String(complete.run)} />
          <Button type="submit" className="max-sm:w-full"><Check />Mark complete</Button>
        </form>}
        {panel?.canRequest === true && <Button asChild variant="outline" className="max-sm:flex-1"><a href="#request-changes">Request changes</a></Button>}
      </div>}
    </div>

    {(panel?.verdict != null || checks?.logHref != null) && <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
      {panel?.verdict?.chips.map(chip => <Chip key={chip.label} chip={chip} />)}
      {panel?.verdict?.by != null && <span>Completed by {panel.verdict.by}</span>}
      {checks?.logHref != null && <a href={checks.logHref} className="underline decoration-border underline-offset-4 hover:text-foreground">Check output</a>}
    </div>}
    {complete !== null && <p className="text-[13px] text-muted-foreground">Marking it complete changes no checks and publishes nothing.</p>}
    {checks?.problem === true && <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-[13px] text-destructive">{checks.detail}</p>}
    {selected.problem !== null && <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-[13px] text-destructive">{selected.problem}</p>}

    {next !== null && <div className="flex flex-wrap items-center gap-3 rounded-md bg-attention-soft px-4 py-3" data-next-action={next.kind}>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm font-semibold">{next.title}</p>
        <p className="text-[13px] text-muted-foreground">{next.detail}</p>
      </div>
      <Html html={next.control} className="so-result-next" />
    </div>}

    {panel !== null && panel.attention.length > 0 && <ul className="flex flex-col gap-1.5 rounded-md bg-warning-soft px-4 py-3 text-[13px]" data-result-attention={panel.attention.length}>
      {panel.attention.map(one => <li key={one} className="flex gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" /><span>{one}</span></li>)}
    </ul>}
    {panel !== null && panel.limits.length > 0 && <Fold summary="What was shortened">
      <ul className="flex flex-col gap-1 text-muted-foreground">{panel.limits.map(one => <li key={one}>{one}</li>)}</ul>
    </Fold>}
    {panel?.reviewHistory != null && <Fold summary="Review history"><p className="text-[13px] text-muted-foreground">{panel.reviewHistory}</p></Fold>}
    {selected.noRun !== null && <p className="text-sm text-muted-foreground">{selected.noRun} <a href={selected.taskHref} className="font-medium underline underline-offset-4">Open the task</a></p>}
  </Card>;
}

function Fold({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return <details className="group text-[13px]">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 font-medium text-muted-foreground hover:text-foreground max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />{summary}
    </summary>
    <div className="pb-1 pl-5.5 pt-1">{children}</div>
  </details>;
}

/** Summary / Changes / Checks. The tab links keep the page script's
 * attributes, so it switches views in place and remembers the choice. */
function Panel({ panel }: { panel: BrowserResultPanel }) {
  return <div id="result" {...panel.attributes} className="flex scroll-mt-4 flex-col gap-4">
    {panel.history !== "" && <Html html={panel.history} />}
    <Card className="gap-0 overflow-hidden p-0 max-sm:p-0">
      <nav role="tablist" aria-label="Result views" className="flex gap-1 overflow-x-auto border-b border-border px-3 max-sm:px-2">
        {panel.tabs.map(tab => <a key={tab.key} role="tab" href={tab.href} data-result-tab={tab.key} aria-selected={tab.active ? "true" : "false"} {...(tab.active ? {} : { tabIndex: -1 })}
          className="-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground aria-selected:border-primary aria-selected:text-foreground max-sm:min-h-11">
          {tab.label}{tab.count !== "" && <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums">{tab.count}</span>}
        </a>)}
      </nav>
      {panel.views.map(one => <div key={one.key} role="tabpanel" data-result-view={one.key} hidden={!panel.tabs.some(tab => tab.key === one.key && tab.active)} className="px-5 py-4 max-sm:px-4">
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

function Details({ selected }: { selected: Selected }) {
  const learning = selected.panel?.learning ?? "";
  const rows: { id: string; title: string; hint: string | null; count?: number; body: ReactNode }[] = [
    { id: "intent", title: "Approved scope", hint: selected.intent?.approval ?? null,
      body: selected.intent === null ? <p className="text-sm text-muted-foreground">No scope was filed for this task, so there is no approved goal or boundary to review.</p> : <Html html={selected.intent.html} className="so-result-intent" /> },
    ...(selected.notes.length === 0 ? [] : [{ id: "notes", title: "Operator notes", hint: null, count: selected.notes.length,
      body: <ul className="flex flex-col gap-2 text-sm">{selected.notes.map((one, index) => <li key={index}><span className="text-muted-foreground">{one.author} · {shortWhen(one.at)}</span> {one.note}</li>)}</ul> }]),
  ];
  return <Card aria-label="Result details" className="gap-0 divide-y divide-border overflow-hidden p-0 max-sm:p-0">
    {learning !== "" && <div data-cockpit-section="learning"><Html html={learning} className="so-result-learning" /></div>}
    {rows.map(row => <details key={row.id} className="group" data-cockpit-section={row.id}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 hover:bg-accent/50 max-sm:min-h-12 max-sm:px-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
        <h2 className="text-[15px] font-semibold">{row.title}</h2>
        {row.count !== undefined && <Badge>{row.count}</Badge>}
        {row.hint !== null && <span className="min-w-0 truncate text-[13px] text-muted-foreground">{row.hint}</span>}
      </summary>
      <div className="px-5 pb-5 pt-1 max-sm:px-4">{row.body}</div>
    </details>)}
  </Card>;
}

export function ResultView({ view, csrf }: { view: BrowserResultView; csrf: string }) {
  const selected = view.selected;
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
    <header className="flex flex-col gap-3 pb-1">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight max-sm:text-[22px]">{selected?.title ?? "Results"}</h1>
          {selected !== null && <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
            {selected.project !== null && <><span className="font-medium text-foreground/80">{selected.project}</span><span aria-hidden="true">·</span></>}
            {selected.build !== null && <><a href={`/r/${selected.build}`} className="hover:text-foreground hover:underline">Build #{selected.build}</a><span aria-hidden="true">·</span></>}
            <a href={selected.taskHref} className="font-medium text-foreground/80 underline decoration-border underline-offset-4 hover:decoration-muted-foreground">Open task</a>
            <span aria-hidden="true">·</span>
            <a href={selected.chatHref} className="font-medium text-foreground/80 underline decoration-border underline-offset-4 hover:decoration-muted-foreground">Discuss</a>
          </p>}
        </div>
        {selected !== null && <ResultsMenu view={view} />}
      </div>
      {view.missing !== null && <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-[13px] text-destructive">{view.missing}{selected !== null ? " Showing the newest result instead." : ""}</p>}
      {view.beyond && <p className="text-[13px] text-muted-foreground">This result is older than the list in Results.</p>}
    </header>

    {selected === null
      ? view.results.length === 0
        ? <Card className="items-start py-10"><p className="text-base text-muted-foreground">Nothing to review yet.</p><Button asChild variant="outline"><a href="/work">Open tasks</a></Button></Card>
        : <Card aria-label="Results" className="gap-0 overflow-hidden p-0 max-sm:p-0">
            <ul className="divide-y divide-border">{view.results.map(row => <li key={row.href} className="flex items-start gap-3 px-5 py-3 max-sm:px-4">
              <span aria-hidden="true" className={cn("mt-2 size-2 shrink-0 rounded-full", row.status === null ? "bg-muted-foreground" : DOT[toneOf(row.status.tone)])} />
              <div className="min-w-0 flex-1">
                <a href={row.href} className={cn("block truncate hover:underline hover:underline-offset-4", row.needsYou ? "font-semibold" : "font-medium")}>{row.title}</a>
                <p className="truncate text-[13px] text-muted-foreground">{[row.status?.label, ...row.notes, shortWhen(row.at)].filter(Boolean).join(" · ")}</p>
              </div>
            </li>)}</ul>
          </Card>
      : <>
          <StatusCard selected={selected} csrf={csrf} />
          {selected.panel !== null && <Panel panel={selected.panel} />}
          {selected.contest !== "" && <Html html={selected.contest} />}
          <Details selected={selected} />
        </>}
  </div>;
}
