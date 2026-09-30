/** One task, rebuilt with shadcn/ui: the status and its one action first,
 * then anything that needs a person, the key facts, and folds for the rest.
 * Forms, ceremonies and ledgers stay the server's own HTML (same ids, same
 * page scripts); this page only frames them. */
import { ArrowRight, Check, ChevronRight, Repeat } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { AssignmentCard } from "../../assignment-ui.js";
import type { BrowserTaskFact, BrowserTaskSection, BrowserTaskView } from "../../browser-workspace.js";
import { GuardedHtml } from "../guarded-html.js";
import { Badge, Button, Card, cn } from "../components/ui/index.js";
import { toneOf } from "./tone.js";

/** A link to a fold (#scope, #holds, #task-actions) opens it and every fold
 * around it, on arrival and on in-page links alike. */
function useRevealHashTarget() {
  useEffect(() => {
    const reveal = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const target = id === "" ? null : document.getElementById(id);
      if (target === null) return;
      for (let node: HTMLElement | null = target; node !== null; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement) node.open = true;
      }
      target.scrollIntoView({ block: "start" });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
}

const DOT: Record<string, string> = {
  attention: "bg-attention", danger: "bg-destructive", info: "bg-info", success: "bg-success", neutral: "bg-muted-foreground", warning: "bg-warning",
};

function Html({ html, className }: { html: string; className?: string }) {
  return <GuardedHtml html={html} immutable {...(className === undefined ? {} : { className })} />;
}

function StatusCard({ card, approval }: { card: AssignmentCard; approval: string }) {
  const tone = toneOf(card.tone);
  const history = card.attempts.length > 1 || card.lead !== null;
  return <Card data-task-status data-work-status={card.token} aria-label="Task status"
    className={cn(tone === "danger" && "border-destructive/50")}>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 phone:gap-y-2.5">
      <div className="min-w-0 flex-1 basis-64">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold leading-snug">
          <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-full", DOT[tone])} />{card.label}
        </h2>
        {card.passed !== null
          ? <p className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
              <Badge tone="success"><Check />Checks passed</Badge>{card.passed.by !== null && <span>Completed by {card.passed.by}</span>}
            </p>
          : <p className={cn("mt-1.5 text-sm phone:mt-1 phone:leading-[1.35]", card.detail.problem ? "text-destructive" : "text-muted-foreground")}>{card.detail.text}</p>}
      </div>
      {card.action !== null && <Button asChild variant={tone === "attention" ? "attention" : "default"} className="phone:w-full">
        <a href={card.action.href} data-primary-action {...(card.action.openResult ? { "data-open-result": "" } : {})}>{card.action.label}<ArrowRight /></a>
      </Button>}
    </div>
    {card.problems.map(one => tone === "danger"
      ? <p key={one} role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-[13px] text-destructive">{one}</p>
      : <p key={one} className="rounded-md bg-muted px-3 py-2 text-[13px] text-foreground">{one}</p>)}
    {card.diagnostics.map(one => <p key={one.token} data-work-diagnostic={one.token}
      className={cn("text-[13px]", one.problem ? "rounded-md bg-destructive-soft px-3 py-2 text-destructive" : "text-muted-foreground")}>{one.label} · {one.detail}</p>)}
    {approval !== "" && <Html html={approval} className="so-task-approval" />}
    {(card.notices !== null || history) && <div className="flex flex-col gap-1 border-t border-border pt-3 text-[13px] phone:pt-2 phone:leading-[1.35]">
      {card.notices !== null && <Fold summary={card.notices.summary} quiet>
        {card.notices.lines.map(line => <p key={line} className="text-muted-foreground">{line}</p>)}
      </Fold>}
      {history && <Fold summary={<>Attempts <Badge>{card.attempts.length}</Badge></>} quiet>
        <ol className="flex flex-col gap-2">
          {card.attempts.map(attempt => <li key={attempt.taskId} data-attempt-task={attempt.taskId}>
            <a href={attempt.href} className="font-medium hover:underline hover:underline-offset-4 phone:inline-flex phone:min-h-11 phone:items-center">{attempt.label}</a>
            {attempt.runId !== null && <> · <a href={`/r/${attempt.runId}`} className="text-muted-foreground hover:underline">Run #{attempt.runId}</a></>}
            {attempt.detail !== null && <p className="text-muted-foreground">{attempt.detail}</p>}
          </li>)}
        </ol>
        {card.lead !== null && <p className="mt-2 text-muted-foreground">Lead: {card.lead.label}{card.lead.active ? "" : " · access ended"}</p>}
      </Fold>}
    </div>}
  </Card>;
}

/** A quiet in-card disclosure (native details: content stays in the page). */
function Fold({ summary, quiet, children }: { summary: ReactNode; quiet?: boolean; children: ReactNode }) {
  return <details className="group">
    <summary className={cn("flex cursor-pointer list-none items-center gap-1.5 py-1.5 font-medium phone:min-h-11 [&::-webkit-details-marker]:hidden", quiet && "text-muted-foreground hover:text-foreground")}>
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />{summary}
    </summary>
    <div className="pb-2 pl-5.5 pt-1">{children}</div>
  </details>;
}

function FactValue({ fact }: { fact: BrowserTaskFact }) {
  return <>{fact.parts.map((part, index) => typeof part === "string"
    ? <span key={index}>{part}</span>
    : "seal" in part
      ? <code key={index} className="mr-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{part.seal}</code>
      : <a key={index} href={part.href} className="font-medium underline decoration-border underline-offset-4 hover:decoration-muted-foreground phone:relative phone:z-[1] phone:-my-3 phone:inline-flex phone:min-h-11 phone:items-center">{part.label}</a>)}</>;
}

/** One fold of a grouped card (the accordion pattern, on native details). */
function Section({ section }: { section: BrowserTaskSection }) {
  return <details id={section.id} open={section.open} className="group scroll-mt-4" data-task-section={section.id}>
    <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 hover:bg-accent/50 phone:min-h-11 phone:px-3.5 phone:py-2 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
      <h2 className="text-[15px] font-semibold">{section.title}</h2>
      {section.count !== null && section.count > 0 && <Badge>{section.count}</Badge>}
    </summary>
    <div className="px-5 pb-5 pt-1 phone:px-3.5 phone:pb-3.5 phone:pt-0"><Html html={section.html} className="so-task-fold" /></div>
  </details>;
}

function Sections({ sections, label }: { sections: BrowserTaskSection[]; label: string }) {
  return sections.length === 0 ? null
    : <Card aria-label={label} className="gap-0 divide-y divide-border overflow-hidden p-0 phone:p-0">{sections.map(one => <Section key={one.id} section={one} />)}</Card>;
}

export function TaskView({ view }: { view: BrowserTaskView }) {
  useRevealHashTarget();
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 phone:gap-3">
    <header className="flex flex-col gap-3 pb-1 phone:gap-2 phone:pb-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 phone:gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight phone:text-[22px]">{view.title}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground phone:mt-0.5">
            {view.project !== null && <><span className="font-medium text-foreground/80">{view.project}</span><span aria-hidden="true">·</span></>}
            <span className="font-mono text-xs">{view.id}</span>
            {view.scout && <Badge tone="info">Scout</Badge>}
          </p>
        </div>
        {view.tabs.length > 0 && <nav aria-label="Task view">
          <ul className="inline-flex h-10 items-center gap-1 rounded-lg bg-muted p-1 phone:h-[52px]">
            {view.tabs.map(tab => <li key={tab.href} className="h-full">
              <a href={tab.href} aria-current={tab.active ? "page" : undefined}
                className={cn("inline-flex h-full items-center rounded-md px-3.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground",
                  tab.active && "bg-card text-foreground shadow-sm")}>{tab.label}</a>
            </li>)}
          </ul>
        </nav>}
      </div>
      {view.version !== null && <p className="rounded-md bg-info-soft px-3 py-2 text-[13px] text-info">
        {view.version.label} · <a href={view.version.current.href} className="font-semibold underline underline-offset-4">{view.version.current.label}</a>
      </p>}
    </header>

    {view.status !== null
      ? <StatusCard card={view.status} approval={view.approval} />
      : <>{<Html html={view.statusHtml} />}{view.approval !== "" && <Html html={view.approval} className="so-task-approval" />}</>}

    {view.lead.map(block => <Html key={block.key} html={block.html} className={`so-task-lead so-task-lead--${block.key}`} />)}

    {view.questions !== "" && <Card><Html html={view.questions} className="so-task-questions" /></Card>}

    {view.facts.length > 0 && <section aria-label="Task facts" className="border-t border-border pt-4 phone:pt-3">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 min-[480px]:grid-cols-2 lg:grid-cols-3 phone:gap-x-5 phone:gap-y-2.5">
        {view.facts.map(fact => <div key={fact.label} className="min-w-0">
          <dt className="text-xs font-medium text-muted-foreground">{fact.label}</dt>
          <dd className="mt-1 text-sm leading-relaxed [overflow-wrap:anywhere] phone:mt-0.5 phone:leading-[1.35]"><FactValue fact={fact} /></dd>
        </div>)}
      </dl>
    </section>}

    <Sections sections={view.sections} label="Task details" />

    {(view.manage.length > 0 || view.cancel !== null || view.everyTime) && <section aria-labelledby="task-manage" className="mt-2 flex flex-col gap-3 phone:mt-1 phone:gap-2">
      <h2 id="task-manage" className="text-sm font-semibold text-muted-foreground">Manage</h2>
      <Sections sections={view.manage} label="Manage" />
      {view.everyTime && <a href={view.everyTime.href} data-every-time className="flex min-h-12 items-center gap-2 rounded-lg border border-border bg-card px-5 text-[15px] font-semibold transition-colors hover:bg-accent max-sm:px-4">
        <Repeat className="size-4 text-muted-foreground" aria-hidden="true" />Do this every time…
        <span className="ml-auto truncate pl-3 text-[13px] font-normal text-muted-foreground">{view.everyTime.starter}</span>
      </a>}
      {/* Cancel stays armed behind one deliberate tap, far from the primary action. */}
      {view.cancel !== null && <details open={view.cancel.open} className="group rounded-lg border border-destructive/30 bg-card" data-task-section="cancel">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-[15px] font-semibold text-destructive phone:min-h-11 phone:px-3.5 phone:py-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />Cancel task
        </summary>
        <div className="px-5 pb-5 pt-1 phone:px-3.5 phone:pb-3.5 phone:pt-0"><Html html={view.cancel.html} className="so-task-cancel" /></div>
      </details>}
    </section>}
  </div>;
}
