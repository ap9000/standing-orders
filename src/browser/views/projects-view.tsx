/** Projects, rebuilt with shadcn/ui: one compact row per project — name and
 * what needs attention on the first line, where it lives and when it was
 * last opened on the second, Open on the right. Opening stays the server's
 * POST (the session's project changes there), so every road is a form. */
import { BookOpen, FolderOpen, GitBranch, Plus } from "lucide-react";
import type { ReactNode } from "react";
import type { BrowserProjectRow, BrowserProjectsView } from "../../browser-workspace.js";
import { GuardedHtml } from "../guarded-html.js";
import { Badge, Button, Card, badgeVariants, cn } from "../components/ui/index.js";

function OpenForm({ csrf, path, destination, children }: { csrf: string; path: string; destination: string; children: ReactNode }) {
  return <form method="post" action="/projects/open" className="inline-flex">
    <input type="hidden" name="csrf" value={csrf} />
    <input type="hidden" name="path" value={path} />
    <input type="hidden" name="return" value={destination} />
    {children}
  </form>;
}

/** Local time, in words people use: today, yesterday, or the date. */
function openedWords(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return "Opened today";
  if (days === 1) return "Opened yesterday";
  return `Opened ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) }).format(date)}`;
}

function Row({ row, csrf, returnTo, choosing }: { row: BrowserProjectRow; csrf: string; returnTo: string; choosing: boolean }) {
  return <li className={cn("flex items-center gap-x-4 px-5 py-3 max-sm:gap-x-2 max-sm:px-4", row.open && "bg-accent/40")} data-project={row.path}>
    <FolderOpen className="size-4 shrink-0 text-muted-foreground max-sm:hidden" aria-hidden="true" />
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {row.open
          ? <a href={returnTo} className="font-semibold hover:underline hover:underline-offset-4">{row.name}</a>
          : <OpenForm csrf={csrf} path={row.path} destination={returnTo}>
              <button type="submit" className="text-left font-semibold hover:underline hover:underline-offset-4">{row.name}</button>
            </OpenForm>}
        {row.peek?.map(chip => row.open
          ? <a key={chip.label} href={chip.href} className={badgeVariants({ tone: chip.tone })}>{chip.label}</a>
          : <OpenForm key={chip.label} csrf={csrf} path={row.path} destination={chip.href}>
              <button type="submit" className={badgeVariants({ tone: chip.tone })}>{chip.label}</button>
            </OpenForm>)}
      </div>
      <p className="mt-0.5 truncate text-[13px] text-muted-foreground" title={row.path}>
        <span className="font-mono text-xs">{row.shortPath}</span>
        {row.openedAt !== null && <> · {openedWords(row.openedAt)}</>}
        {row.peek === null && <> · Not scanned</>}
      </p>
    </div>
    <div className="flex shrink-0 items-center gap-1.5">
      <Button asChild variant="ghost" size="sm" className="max-sm:w-11 max-sm:px-0"><a href={row.knowledgeHref} aria-label={`${row.name} knowledge`}><BookOpen /><span className="max-sm:sr-only">Knowledge</span></a></Button>
      {row.open
        ? <Badge tone="success">Open now</Badge>
        : <OpenForm csrf={csrf} path={row.path} destination={returnTo}>
            <Button type="submit" variant="outline" size="sm">{choosing ? "Choose" : "Open"}</Button>
          </OpenForm>}
    </div>
  </li>;
}

function Group({ label, rows, ...rest }: { label: string; rows: BrowserProjectRow[]; csrf: string; returnTo: string; choosing: boolean }) {
  return rows.length === 0 ? null : <section aria-label={label} className="flex flex-col gap-2">
    <h2 className="text-sm font-semibold text-muted-foreground">{label}</h2>
    <Card className="gap-0 overflow-hidden p-0 max-sm:p-0">
      <ul className="divide-y divide-border">{rows.map(row => <Row key={row.path} row={row} {...rest} />)}</ul>
    </Card>
  </section>;
}

export function ProjectsView({ view, csrf }: { view: BrowserProjectsView; csrf: string }) {
  const shared = { csrf, returnTo: view.returnTo, choosing: view.choosing };
  const empty = view.recent.length === 0 && view.available.length === 0;
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
    <header className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight max-sm:text-[22px]">{view.choosing ? "New task" : "Projects"}</h1>
        {view.choosing && <p className="mt-1 text-sm text-muted-foreground">Choose the project it belongs to.</p>}
      </div>
      {!empty && <Button asChild variant="outline" size="sm"><a href="#add-project"><Plus />Add project</a></Button>}
    </header>

    {view.problem !== null && <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">{view.problem}</p>}

    <Group label="Recent" rows={view.recent} {...shared} />
    <Group label="Available" rows={view.available} {...shared} />

    <Card id="add-project" className="scroll-mt-4 gap-3">
      <h2 className="text-base font-semibold">{empty ? "Add your first project" : "Add a project"}</h2>
      {(view.add.browse !== null || view.add.github !== null) && <div className="flex flex-wrap gap-2">
        {view.add.browse !== null && <Button asChild variant="outline"><a href={view.add.browse}><FolderOpen />Choose a folder</a></Button>}
        {view.add.github !== null && <Button asChild variant="outline"><a href={view.add.github}><GitBranch />Add from GitHub</a></Button>}
      </div>}
      <GuardedHtml html={view.add.html} immutable className="so-project-add" />
    </Card>
  </div>;
}
