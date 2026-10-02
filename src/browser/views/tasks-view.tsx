/** Tasks, rebuilt with shadcn/ui: a visible title with what needs you, link
 * tabs with counts, then one row per task. What needs a person comes first,
 * grouped by what it asks (Decide, Review, Unblock), and wears a solid ink
 * chip naming the ask; every other row keeps a quiet neutral chip. The next
 * step is one quiet button. Filtering and paging stay server-side (real
 * URLs), so Back and bookmarks work. Usage folds to one line on a desk and
 * sits below the list on a phone, so the first task is near the top. */
import { ArrowRight, ChevronDown, Ellipsis, Inbox, LayoutGrid, ListTodo, Plus, Repeat, Sparkles, Code2, ListOrdered, Briefcase } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { BrowserLimits, BrowserLimitTile, BrowserTasksView } from "../../browser-workspace.js";
import { ASK_LABEL } from "../../needs-you.js";
import { Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, cn } from "../components/ui/index.js";
import { HeadlineBadge } from "./status-summary.js";

const TOOL_ICONS: Record<string, ReactNode> = {
  "/inbox": <Inbox />, "/code": <Code2 />, "/board": <LayoutGrid />, "/board?view=order": <ListOrdered />,
  "/tasks": <ListTodo />, "/recipes": <Sparkles />, "/routines": <Repeat />, "/workbench": <Briefcase />,
};

const LIMIT_FILL: Record<BrowserLimitTile["tone"], string> = { neutral: "bg-foreground", warning: "bg-warning", danger: "bg-destructive" };
const LIMIT_TEXT: Record<BrowserLimitTile["tone"], string> = { neutral: "", warning: "text-warning", danger: "text-destructive" };

/** One limit: whose and which window, the figure, a bar (with the 50/80 % alert marks on a budget), and when it resets. */
function LimitTile({ tile }: { tile: BrowserLimitTile }) {
  const body = <>
    <p className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-4">
      <span className="truncate font-medium text-foreground">{tile.name}</span>
      <span className="shrink-0 text-muted-foreground">{tile.window}</span>
    </p>
    <p className={cn("mt-2.5 flex items-baseline tabular-nums phone:mt-1.5", tile.unit === "%" ? "gap-px" : "gap-1")}>
      <span className={cn("text-[22px] font-semibold leading-none tracking-[-0.02em]", tile.tone === "danger" && "text-destructive")}>{tile.value}</span>
      <span className="text-[12px] text-muted-foreground">{tile.unit}</span>
    </p>
    <div className="relative mt-3 h-1.5 phone:mt-2 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, tile.percent))}
      aria-label={`${tile.name} ${tile.window}`}>
      <div className={cn("h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out", LIMIT_FILL[tile.tone])} style={{ width: `${Math.min(100, Math.max(0, tile.percent))}%` }} />
      {tile.marks.map(mark => <span key={mark} aria-hidden="true" className="absolute inset-y-0 w-0.5 bg-card" style={{ left: `calc(${mark}% - 1px)` }} />)}
    </div>
    <p className={cn("mt-2 truncate text-[12px] leading-4 phone:mt-1.5", tile.tone === "neutral" ? "text-muted-foreground" : LIMIT_TEXT[tile.tone])}>{tile.detail}</p>
  </>;
  const frame = "block min-w-0 rounded-[10px] border border-border bg-card px-3.5 py-3 phone:w-[152px] phone:px-3 phone:py-2.5 phone:shrink-0 phone:snap-start";
  return <li data-limit={tile.key} title={tile.title ?? undefined} className="min-w-0 phone:shrink-0">
    {tile.href === null ? <div className={frame}>{body}</div>
      : <a href={tile.href} className={cn(frame, "transition-colors hover:border-input hover:bg-[var(--so-raised)]")}>{body}</a>}
  </li>;
}

/** Plans' usage windows and monthly budgets: one row of tiles, scrolling sideways on a phone. */
function LimitTiles({ limits, id, className }: { limits: BrowserLimits; id?: string; className?: string }) {
  return <section aria-label="Usage" id={id} className={className}>
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-2 phone:-mx-4 phone:flex phone:snap-x phone:snap-mandatory phone:scroll-px-4 phone:overflow-x-auto phone:px-4 phone:pb-1 phone:[scrollbar-width:none]">
      {limits.tiles.map(tile => <LimitTile key={tile.key} tile={tile} />)}
    </ul>
  </section>;
}

/** Each limit as a word and a percentage: the plan's name for its first window, the window's name after it
 * ("Claude 48% · Weekly 83% · Codex 12%"). */
export function usageSummary(limits: BrowserLimits): { key: string; text: string; tone: BrowserLimitTile["tone"] }[] {
  const named = new Set<string>();
  return limits.tiles.map(tile => {
    const word = named.has(tile.name) ? tile.window : tile.name;
    named.add(tile.name);
    return { key: tile.key, text: `${word} ${Math.round(Math.max(0, tile.percent))}%`, tone: tile.tone };
  });
}

function TaskChip({ row }: { row: BrowserTasksView["rows"][number] }) {
  const place = "text-[12px] desk:col-start-1 desk:row-start-1 desk:justify-self-start phone:col-start-1 phone:row-start-2 phone:self-center";
  if (row.ask === null) return <HeadlineBadge label={row.status.label} tone={row.status.tone === "attention" ? "neutral" : row.status.tone} className={place} />;
  return <span data-ask={row.ask} title={row.status.label}
    className={cn("inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-[5px] bg-attention px-1.5 py-px font-semibold leading-[18px] text-on-attention", place)}>
    {ASK_LABEL[row.ask]}
  </span>;
}

function TaskRow({ row }: { row: BrowserTasksView["rows"][number] }) {
  // On a phone the row is a small grid: the title with its action on the right, then the chip beside the
  // project and age, then any detail. The title block and the chip cluster dissolve into it (contents).
  const waiting = row.ask !== null;
  return <li data-task={row.id} data-work-status={row.status.token} data-group={row.group}
    className="grid grid-cols-1 gap-y-2 border-b border-border px-2 py-3 transition-colors hover:bg-[var(--so-raised)] desk:col-span-3 desk:grid-cols-subgrid desk:items-center desk:gap-x-4 phone:grid-cols-[auto_minmax(0,1fr)_auto] phone:gap-x-2 phone:gap-y-0.5 phone:py-1.5">
    <div className="min-w-0 desk:col-start-2 desk:row-start-1 phone:contents">
      <a href={row.href} className={cn("block text-[13.5px] leading-snug hover:underline hover:underline-offset-4 phone:col-[1/3] phone:row-start-1 phone:flex phone:min-h-11 phone:items-center",
        waiting ? "font-semibold" : "font-medium")}>{row.title}</a>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted-foreground phone:col-[2/4] phone:row-start-2 phone:mt-0 phone:min-w-0 phone:leading-[1.35]">
        {row.project && <span className="text-foreground/80">{row.project}</span>}
        {row.project && <span aria-hidden="true">·</span>}
        <span className="tabular-nums">{row.age}</span>
      </p>
      {row.detail && <p className="mt-1 text-[12.5px] text-muted-foreground phone:col-span-full phone:leading-[1.35]">{row.detail}</p>}
      {row.problem && <p className="mt-1 text-[12.5px] text-muted-foreground phone:col-span-full phone:leading-[1.35]">{row.problem}</p>}
      {row.notes.map(note => <p key={note} className="mt-1 text-[12.5px] text-muted-foreground phone:col-span-full phone:leading-[1.35]">{note}</p>)}
    </div>
    <div className="flex items-center gap-3 phone:contents desk:contents">
      <TaskChip row={row} />
      {row.action && <Button asChild variant="outline" size="sm" className="desk:col-start-3 desk:row-start-1 desk:justify-self-end phone:col-start-3 phone:row-start-1 phone:self-start">
        <a href={row.action.href} data-primary-action>{row.action.label}<ArrowRight /></a>
      </Button>}
    </div>
  </li>;
}

/** The rows in the view's groups, in order, each under a small heading with its count; a plain list otherwise.
 * On a desk every group shares one grid (chip, title, action), so chips and actions line up down the page. */
function TaskList({ view }: { view: BrowserTasksView }) {
  const grid = "desk:grid desk:grid-cols-[auto_minmax(0,1fr)_auto]";
  if (view.groups === null) return <ul className={cn(grid, "border-t border-border")}>{view.rows.map(row => <TaskRow key={row.id} row={row} />)}</ul>;
  const sections = view.groups.map(group => ({ ...group, rows: view.rows.filter(row => row.group === group.key) })).filter(one => one.rows.length > 0);
  const placed = new Set(sections.map(one => one.key));
  const loose = view.rows.filter(row => !placed.has(row.group));
  return <div className={cn(grid, "flex flex-col gap-5 phone:gap-3.5 desk:gap-0")}>
    {sections.map((section, index) => <section key={section.key} data-task-group={section.key} aria-labelledby={`task-group-${section.key}`} className="desk:contents">
      <h2 id={`task-group-${section.key}`} className={cn("flex items-baseline gap-2 border-b border-border px-2 pb-1.5 text-[13px] font-semibold leading-5 desk:col-span-3", index > 0 && "desk:mt-6")}>
        {section.label}<span className="font-mono text-[12px] font-medium tabular-nums text-muted-foreground">{section.count}</span>
      </h2>
      <ul className="desk:contents">{section.rows.map(row => <TaskRow key={row.id} row={row} />)}</ul>
    </section>)}
    {loose.length > 0 && <ul className="desk:contents">{loose.map(row => <TaskRow key={row.id} row={row} />)}</ul>}
  </div>;
}

/** On a desk the usage tiles fold to one line beside the title; a click shows them. */
function UsageToggle({ limits, open, onToggle, controls }: { limits: BrowserLimits; open: boolean; onToggle: () => void; controls: string }) {
  const parts = usageSummary(limits);
  return <button type="button" aria-expanded={open} aria-controls={controls} onClick={onToggle} data-usage-summary
    className="ml-auto inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-[var(--so-raised)] hover:text-foreground phone:hidden">
    <span className="sr-only">Usage: </span>
    <span className="truncate tabular-nums">{parts.map((part, index) => <span key={part.key}>{index > 0 && <span aria-hidden="true"> · </span>}<span className={LIMIT_TEXT[part.tone]}>{part.text}</span></span>)}</span>
    <ChevronDown aria-hidden="true" className={cn("size-3.5 shrink-0 motion-safe:transition-transform", open && "rotate-180")} />
  </button>;
}

export function TasksView({ view }: { view: BrowserTasksView }) {
  const [usageOpen, setUsageOpen] = useState(false);
  const usageId = useId();
  const limits = view.limits !== null && view.limits.tiles.length > 0 ? view.limits : null;
  return <div className="flex w-full max-w-[960px] flex-col gap-5 phone:gap-3 phone:px-0.5">
    <div className="flex min-w-0 items-baseline gap-x-3 gap-y-1">
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">Tasks</h1>
      {view.needsYou > 0 && <p className="whitespace-nowrap text-[13px] text-muted-foreground" data-needs-you-count>
        <span className="font-semibold tabular-nums text-foreground">{view.needsYou}</span> {view.needsYou === 1 ? "needs" : "need"} you</p>}
      {limits && <UsageToggle limits={limits} open={usageOpen} onToggle={() => setUsageOpen(open => !open)} controls={usageId} />}
      <div className={cn("flex shrink-0 items-center gap-2 self-center", !limits && "ml-auto", "phone:ml-auto")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" aria-label="Work tools"><span className="phone:hidden">Work tools</span><ChevronDown className="phone:hidden" /><Ellipsis className="desk:hidden" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {view.tools.map(tool => <DropdownMenuItem key={tool.href} asChild><a href={tool.href}>{TOOL_ICONS[tool.href]}{tool.label}</a></DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button asChild size="sm" className="desk:hidden"><a href={view.newTask.href}><Plus />{view.newTask.label}</a></Button>
      </div>
    </div>
    {limits && usageOpen && <LimitTiles limits={limits} id={usageId} className="phone:hidden" />}
    <div className="flex min-w-0 items-center">
      <nav aria-label="Task views" className="-mx-1 min-w-0 max-w-full overflow-x-auto px-1 phone:-mr-4 phone:max-w-none phone:pr-4">
        <ul className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted p-0.5 phone:h-12">
          {view.tabs.map(tab => <li key={tab.href} className="h-full">
            <a href={tab.href} aria-current={tab.active ? "page" : undefined}
              className={cn("inline-flex h-full items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                tab.active && "bg-card text-foreground shadow-[var(--so-pill-shadow)]")}>
              {tab.label}
              <span className={cn("min-w-[18px] rounded-full px-1.5 text-center font-mono text-[12px] leading-[18px] tabular-nums", tab.label === "Needs you" && tab.count > 0 ? "bg-attention text-on-attention" : "text-muted-foreground")}>{tab.count}</span>
            </a>
          </li>)}
        </ul>
      </nav>
    </div>

    {view.empty !== null ? <Card className="items-start py-10">
      <p className="text-base text-muted-foreground">{view.empty.text}</p>
      {view.empty.action && <Button asChild variant="outline"><a href={view.empty.action.href}>{view.empty.action.label}</a></Button>}
    </Card> : <TaskList view={view} />}

    {(view.pages.first || view.pages.next) && <nav aria-label="Task pages" className="flex gap-2">
      {view.pages.first && <Button asChild variant="outline" size="sm"><a href={view.pages.first}>First page</a></Button>}
      {view.pages.next && <Button asChild variant="outline" size="sm"><a href={view.pages.next} rel="next">Next page</a></Button>}
    </nav>}
    {limits && <LimitTiles limits={limits} className="desk:hidden" />}
  </div>;
}
