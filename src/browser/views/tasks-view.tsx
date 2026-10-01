/** Tasks, rebuilt with shadcn/ui: link tabs with counts, one row per task,
 * the status as a badge and the next step as one quiet button (magenta marks
 * the count and the badge; nine magenta buttons in a list would shout).
 * Filtering and paging stay server-side (real URLs), so Back and bookmarks
 * work. */
import { ArrowRight, ChevronDown, Inbox, LayoutGrid, ListTodo, Plus, Repeat, Sparkles, Code2, ListOrdered, Briefcase } from "lucide-react";
import type { ReactNode } from "react";
import type { BrowserLimits, BrowserLimitTile, BrowserTasksView } from "../../browser-workspace.js";
import { Badge, Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, cn } from "../components/ui/index.js";
import { HeadlineBadge } from "./status-summary.js";

const TOOL_ICONS: Record<string, ReactNode> = {
  "/inbox": <Inbox />, "/code": <Code2 />, "/board": <LayoutGrid />, "/board?view=order": <ListOrdered />,
  "/tasks": <ListTodo />, "/recipes": <Sparkles />, "/routines": <Repeat />, "/workbench": <Briefcase />,
};

const LIMIT_FILL: Record<BrowserLimitTile["tone"], string> = { neutral: "bg-foreground", warning: "bg-warning", danger: "bg-destructive" };

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
    <p className={cn("mt-2 truncate text-[11.5px] leading-4 phone:mt-1.5", tile.tone === "neutral" ? "text-muted-foreground" : tile.tone === "warning" ? "text-warning" : "text-destructive")}>{tile.detail}</p>
  </>;
  const frame = "block min-w-0 rounded-[10px] border border-border bg-card px-3.5 py-3 phone:w-[152px] phone:px-3 phone:py-2.5 phone:shrink-0 phone:snap-start";
  return <li data-limit={tile.key} title={tile.title ?? undefined} className="min-w-0 phone:shrink-0">
    {tile.href === null ? <div className={frame}>{body}</div>
      : <a href={tile.href} className={cn(frame, "transition-colors hover:border-input hover:bg-[var(--so-raised)]")}>{body}</a>}
  </li>;
}

/** Plans' usage windows and monthly budgets: one row of tiles, scrolling sideways on a phone. */
function Limits({ limits }: { limits: BrowserLimits }) {
  return <section aria-label="Limits">
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-2 phone:-mx-4 phone:flex phone:snap-x phone:snap-mandatory phone:scroll-px-4 phone:overflow-x-auto phone:px-4 phone:pb-1 phone:[scrollbar-width:none]">
      {limits.tiles.map(tile => <LimitTile key={tile.key} tile={tile} />)}
    </ul>
  </section>;
}

export function TasksView({ view }: { view: BrowserTasksView }) {
  return <div className="flex w-full flex-col gap-5 phone:gap-3">
    <h1 className="sr-only">Tasks</h1>
    {view.limits && <Limits limits={view.limits} />}
    <div className="flex flex-wrap items-center gap-3">
      <nav aria-label="Task views" className="-mx-1 min-w-0 max-w-full overflow-x-auto px-1 phone:-mr-4 phone:max-w-none phone:pr-4">
        <ul className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted p-0.5 phone:h-12">
          {view.tabs.map(tab => <li key={tab.href} className="h-full">
            <a href={tab.href} aria-current={tab.active ? "page" : undefined}
              className={cn("inline-flex h-full items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                tab.active && "bg-card text-foreground shadow-[var(--so-pill-shadow)]")}>
              {tab.label}
              <span className={cn("min-w-[18px] rounded-full px-1.5 text-center font-mono text-[11px] leading-[18px] tabular-nums", tab.label === "Needs you" && tab.count > 0 ? "bg-attention text-on-attention" : "text-muted-foreground")}>{tab.count}</span>
            </a>
          </li>)}
        </ul>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm">Work tools<ChevronDown /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {view.tools.map(tool => <DropdownMenuItem key={tool.href} asChild><a href={tool.href}>{TOOL_ICONS[tool.href]}{tool.label}</a></DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button asChild size="sm" className="desk:hidden"><a href={view.newTask.href}><Plus />{view.newTask.label}</a></Button>
      </div>
    </div>

    {view.empty !== null ? <Card className="items-start py-10">
      <p className="text-base text-muted-foreground">{view.empty.text}</p>
      {view.empty.action && <Button asChild variant="outline"><a href={view.empty.action.href}>{view.empty.action.label}</a></Button>}
    </Card> : <div className="border-y border-border">
      <ul className="divide-y divide-border desk:grid desk:grid-cols-[minmax(0,1fr)_auto_auto]">
        {view.rows.map(row => {
          // On a phone the row is a small grid: the title with its action on the right, then the status beside the
          // project and age, then any detail. The title block and the badge cluster dissolve into it (contents).
          return <li key={row.id} data-task={row.id} data-work-status={row.status.token}
            className="grid grid-cols-1 gap-y-2 px-2 py-3 transition-colors hover:bg-[var(--so-raised)] desk:col-span-3 desk:grid-cols-subgrid desk:items-center desk:gap-x-6 phone:grid-cols-[auto_minmax(0,1fr)_auto] phone:gap-x-2 phone:gap-y-0.5 phone:py-1.5">
            <div className="min-w-0 phone:contents">
              <a href={row.href} className="block text-[13.5px] font-medium leading-snug hover:underline hover:underline-offset-4 phone:col-[1/3] phone:row-start-1 phone:flex phone:min-h-11 phone:items-center">{row.title}</a>
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
              <HeadlineBadge label={row.status.label} tone={row.status.tone} className="desk:justify-self-start phone:col-start-1 phone:row-start-2 phone:self-center" />
              {row.action && <Button asChild variant="outline" size="sm" className="desk:justify-self-end phone:col-start-3 phone:row-start-1 phone:self-start">
                <a href={row.action.href} data-primary-action>{row.action.label}<ArrowRight /></a>
              </Button>}
            </div>
          </li>;
        })}
      </ul>
    </div>}

    {(view.pages.first || view.pages.next) && <nav aria-label="Task pages" className="flex gap-2">
      {view.pages.first && <Button asChild variant="outline" size="sm"><a href={view.pages.first}>First page</a></Button>}
      {view.pages.next && <Button asChild variant="outline" size="sm"><a href={view.pages.next} rel="next">Next page</a></Button>}
    </nav>}
  </div>;
}
