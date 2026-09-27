/** Tasks, rebuilt with shadcn/ui: link tabs with counts, one row per task,
 * the status as a badge and the next step as one quiet button (magenta marks
 * the count and the badge; nine magenta buttons in a list would shout).
 * Filtering and paging stay server-side (real URLs), so Back and bookmarks
 * work. */
import { ArrowRight, ChevronDown, Inbox, LayoutGrid, ListTodo, Plus, Repeat, Sparkles, Code2, ListOrdered, Briefcase } from "lucide-react";
import type { ReactNode } from "react";
import type { BrowserTasksView } from "../../browser-workspace.js";
import { Badge, Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, cn } from "../components/ui/index.js";
import { toneOf } from "./tone.js";

const TOOL_ICONS: Record<string, ReactNode> = {
  "/inbox": <Inbox />, "/code": <Code2 />, "/board": <LayoutGrid />, "/board?view=order": <ListOrdered />,
  "/tasks": <ListTodo />, "/recipes": <Sparkles />, "/routines": <Repeat />, "/workbench": <Briefcase />,
};

export function TasksView({ view }: { view: BrowserTasksView }) {
  return <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
    <h1 className="sr-only">Tasks</h1>
    <div className="flex flex-wrap items-center gap-3">
      <nav aria-label="Task views" className="-mx-1 min-w-0 max-w-full overflow-x-auto px-1">
        <ul className="inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted p-0.5 max-sm:h-11">
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
        <Button asChild size="sm" className="sm:hidden"><a href={view.newTask.href}><Plus />{view.newTask.label}</a></Button>
      </div>
    </div>

    {view.empty !== null ? <Card className="items-start py-10">
      <p className="text-base text-muted-foreground">{view.empty.text}</p>
      {view.empty.action && <Button asChild variant="outline"><a href={view.empty.action.href}>{view.empty.action.label}</a></Button>}
    </Card> : <Card className="gap-0 p-0 max-sm:p-0">
      <ul className="divide-y divide-border">
        {view.rows.map(row => {
          const tone = toneOf(row.status.tone);
          return <li key={row.id} data-task={row.id} data-work-status={row.status.token}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-[var(--so-raised)]">
            <div className="min-w-0 flex-1 basis-72">
              <a href={row.href} className="block text-[13.5px] font-medium leading-snug hover:underline hover:underline-offset-4 max-sm:py-1">{row.title}</a>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted-foreground">
                {row.project && <span className="text-foreground/80">{row.project}</span>}
                {row.project && <span aria-hidden="true">·</span>}
                <span className="tabular-nums">{row.age}</span>
              </p>
              {row.detail && <p className="mt-1 text-[12.5px] text-muted-foreground">{row.detail}</p>}
              {row.problem && <p className="mt-1 text-[12.5px] text-destructive">{row.problem}</p>}
              {row.notes.map(note => <p key={note} className="mt-1 text-[12.5px] text-muted-foreground">{note}</p>)}
            </div>
            <div className="flex items-center gap-3 max-sm:w-full max-sm:justify-between">
              <Badge tone={tone}>{row.status.label}</Badge>
              {row.action && <Button asChild variant="outline" size="sm">
                <a href={row.action.href} data-primary-action>{row.action.label}<ArrowRight /></a>
              </Button>}
            </div>
          </li>;
        })}
      </ul>
    </Card>}

    {(view.pages.first || view.pages.next) && <nav aria-label="Task pages" className="flex gap-2">
      {view.pages.first && <Button asChild variant="outline" size="sm"><a href={view.pages.first}>First page</a></Button>}
      {view.pages.next && <Button asChild variant="outline" size="sm"><a href={view.pages.next} rel="next">Next page</a></Button>}
    </nav>}
  </div>;
}
