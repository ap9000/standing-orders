/** A flow's canvas: zones are the stages of a team's process, cards are the
 * work moving through them. Drag a card to another zone to move it; open a
 * card to see its history, what zones reported, and to approve or send it
 * back. "Edit flow" lets you move, resize, add and connect zones: the solid
 * arrow is where work goes next, the dashed one where it goes if it's sent
 * back or fails. Every change is the server's: it answers with the flow as
 * it now stands, and the canvas refreshes every few seconds for everyone. */
import { Background, BackgroundVariant, Controls, Handle, MarkerType, NodeResizer, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CalendarClock, Copy, Flag, GitPullRequest, Hammer, Inbox, Megaphone, MessageSquare, MousePointerClick, Pencil, Plus, Search, SquareKanban, UserCheck, Webhook, Workflow, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BrowserFlowCard, BrowserFlowStage, BrowserFlowTrigger, BrowserFlowView } from "../../browser-workspace.js";
import { Badge, Button, Input, Label, Textarea, cn, toast } from "../components/ui/index.js";

const COLORS: Record<string, string> = { slate: "#64748b", blue: "#3b82f6", violet: "#8b5cf6", amber: "#d97706", green: "#059669", rose: "#e11d48" };
const KIND_ICONS: Record<BrowserFlowStage["kind"], ReactNode> = {
  inbox: <Inbox className="size-3.5" aria-hidden="true" />, task: <Hammer className="size-3.5" aria-hidden="true" />, report: <Search className="size-3.5" aria-hidden="true" />,
  approval: <UserCheck className="size-3.5" aria-hidden="true" />, notify: <Megaphone className="size-3.5" aria-hidden="true" />, done: <Flag className="size-3.5" aria-hidden="true" />,
};

const TRIGGER_ICONS: Record<string, ReactNode> = {
  button: <MousePointerClick className="size-3.5" aria-hidden="true" />, schedule: <CalendarClock className="size-3.5" aria-hidden="true" />, github: <GitPullRequest className="size-3.5" aria-hidden="true" />,
  linear: <SquareKanban className="size-3.5" aria-hidden="true" />, flow: <Workflow className="size-3.5" aria-hidden="true" />, webhook: <Webhook className="size-3.5" aria-hidden="true" />,
};

type Reveal = { path: string; address: string | null; secret: string | null };
type Said = { ok: boolean; said: string; view?: BrowserFlowView; reveal?: Reveal };

async function send(path: string, fields: Record<string, string>, csrf: string): Promise<Said> {
  const body = new URLSearchParams({ csrf, ...fields });
  try {
    const response = await fetch(path, { method: "POST", body, credentials: "same-origin", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as Said;
    return { ok: data.ok === true, said: typeof data.said === "string" ? data.said : response.ok ? "Done." : "That didn't go through.", ...(data.view === undefined ? {} : { view: data.view }), ...(data.reveal === undefined ? {} : { reveal: data.reveal }) };
  } catch {
    return { ok: false, said: "That didn't go through. Check your connection and try again." };
  }
}

type ZoneData = {
  stage: BrowserFlowStage; kindLabel: string; cards: BrowserFlowCard[]; editing: boolean; canMove: boolean; start: boolean;
  selectedCard: number | null; onCard: (id: number) => void; onDrop: (card: number, stage: string) => void;
  onResize: (stage: string, box: { x: number; y: number; width: number; height: number }) => void;
};

function ZoneNode({ data, selected }: NodeProps<Node<ZoneData, "zone">>) {
  const { stage, cards, editing, canMove } = data;
  const color = COLORS[stage.zone.color] ?? COLORS["slate"]!;
  const [over, setOver] = useState(false);
  const handle = cn("!size-2.5 !border-2 !border-card", !editing && "!opacity-0");
  return <div
    className={cn("flex h-full flex-col overflow-hidden rounded-xl border shadow-sm", selected && editing ? "ring-2 ring-primary" : "", over && "ring-2 ring-primary/60")}
    style={{ borderColor: `color-mix(in srgb, ${color} 35%, transparent)`, background: `color-mix(in srgb, ${color} 7%, var(--color-card))` }}
    onDragOver={event => { if (!canMove || editing) return; event.preventDefault(); setOver(true); }}
    onDragLeave={() => setOver(false)}
    onDrop={event => { setOver(false); const id = Number(event.dataTransfer.getData("text/so-card")); if (id > 0) data.onDrop(id, stage.id); }}
    data-zone={stage.id}>
    {editing && <NodeResizer isVisible={selected} minWidth={220} minHeight={160} lineClassName="!border-primary" handleClassName="!size-2 !bg-primary" onResizeEnd={(_event, box) => data.onResize(stage.id, box)} />}
    {/* Drawing handles: the right dot makes a "then" arrow, the bottom dot an "if sent back" arrow; any side receives. */}
    <Handle type="source" position={Position.Right} id="next" className={cn(handle, "!bg-primary")} isConnectable={editing} />
    <Handle type="source" position={Position.Bottom} id="fail" className={cn(handle, "!bg-attention")} style={{ left: "75%" }} isConnectable={editing} />
    {(["Left", "Right", "Top", "Bottom"] as const).map(side => <Handle key={`t-${side}`} type="target" position={Position[side]} id={`t-${side}`} className={handle} isConnectable={editing}
/>)}
    {/* Routing handles: arrows leave from whichever side faces their target. Never drawn from. */}
    {(["Left", "Right", "Top", "Bottom"] as const).map(side => <Handle key={`s-${side}`} type="source" position={Position[side]} id={`s-${side}`} className="!opacity-0 !pointer-events-none" isConnectable={false}
/>)}
    <header className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: `${color}33` }}>
      <span className="inline-flex size-6 items-center justify-center rounded-md text-white" style={{ background: color }}>{KIND_ICONS[stage.kind]}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold">{stage.title}</div>
        <div className="truncate text-[11px] text-muted-foreground">{data.kindLabel}{data.start ? " · new cards start here" : ""}{stage.approver ? ` · ${stage.approver}` : ""}</div>
      </div>
      {cards.length > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">{cards.length}</span>}
    </header>
    <ul className="nowheel flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      {cards.map(card => <li key={card.id}>
        <button type="button" draggable={canMove && !editing}
          onDragStart={event => { event.dataTransfer.setData("text/so-card", String(card.id)); event.dataTransfer.effectAllowed = "move"; }}
          onClick={() => data.onCard(card.id)}
          className={cn("nodrag nopan w-full cursor-pointer rounded-lg border bg-card px-2.5 py-2 text-left shadow-xs transition-colors hover:border-primary/50",
            data.selectedCard === card.id && "border-primary ring-1 ring-primary", card.canDecide && "border-attention/60")}
          data-card={card.id}>
          <div className="line-clamp-2 text-[12.5px] font-medium leading-snug">{card.title}</div>
          {card.waiting !== null && <div className={cn("mt-1 line-clamp-2 text-[11px] leading-snug", card.canDecide ? "font-semibold text-attention" : "text-muted-foreground")}>{card.canDecide ? "Needs your decision" : card.waiting}</div>}
        </button>
      </li>)}
      {cards.length === 0 && <li className="px-1 py-2 text-[11px] text-muted-foreground">{editing ? stage.kind === "done" ? "" : "Drag the dots to connect zones." : "No cards here."}</li>}
    </ul>
  </div>;
}

type TriggerData = { triggers: BrowserFlowTrigger[]; onOpen: (id: number) => void; onPress: (id: number) => void };
const TRIGGER_ROW = 44, TRIGGER_HEAD = 30;

/** What starts cards in one zone, beside it: each trigger in a line, whether it is well, and Start for a button. One arrow into the zone. */
function TriggerNode({ data }: NodeProps<Node<TriggerData, "trigger">>) {
  return <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-card shadow-sm" data-trigger-group>
    <Handle type="source" position={Position.Right} id="out" className="!opacity-0 !pointer-events-none" isConnectable={false} />
    <div className="flex items-center gap-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" style={{ height: TRIGGER_HEAD }}><Zap className="size-3" aria-hidden="true" />Starts cards</div>
    {data.triggers.map(trigger => {
      const attention = trigger.failing || (trigger.hook !== null && !trigger.hook.ready);
      const line = trigger.state === "paused" ? "Paused" : trigger.failing ? "Needs attention" : trigger.hook !== null && !trigger.hook.ready ? "Needs its secret" : trigger.detail;
      return <div key={trigger.id} className={cn("flex items-center gap-2 border-t px-2.5", trigger.state === "paused" && "opacity-60")} style={{ height: TRIGGER_ROW }} data-trigger={trigger.id}>
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">{TRIGGER_ICONS[trigger.kind] ?? <Zap className="size-3.5" aria-hidden="true" />}</span>
        <button type="button" className="nodrag nopan min-w-0 flex-1 cursor-pointer text-left" onClick={() => data.onOpen(trigger.id)} aria-label={`Trigger: ${trigger.words}`}>
          <div className="truncate text-[12px] font-semibold">{trigger.name}</div>
          <div className={cn("truncate text-[11px]", attention ? "text-attention" : "text-muted-foreground")}>{line}</div>
        </button>
        {trigger.button !== null && trigger.state === "active" && <Button size="sm" className="nodrag nopan h-7 px-2.5" onClick={() => data.onPress(trigger.id)}>Start</Button>}
      </div>;
    })}
  </div>;
}

const NODE_TYPES = { zone: ZoneNode, trigger: TriggerNode };
type FlowNode = Node<ZoneData, "zone"> | Node<TriggerData, "trigger">;

/** Zones in the order work usually meets them: from the start, following each zone's next. */
function flowOrder(stages: BrowserFlowStage[], start: string): BrowserFlowStage[] {
  const ordered: BrowserFlowStage[] = [];
  const seen = new Set<string>();
  const visit = (id: string | null) => {
    while (id !== null && !seen.has(id)) {
      const stage = stages.find(one => one.id === id);
      if (stage === undefined) return;
      seen.add(id); ordered.push(stage); id = stage.next;
    }
  };
  visit(start);
  for (const stage of stages) if (!seen.has(stage.id)) visit(stage.id);
  return ordered;
}

function slug(title: string, taken: Set<string>): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "zone";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

function CardPanel({ card, view, csrf, apply, onClose }: { card: BrowserFlowCard; view: BrowserFlowView; csrf: string; apply: (result: Said) => void; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const stage = view.stages.find(one => one.id === card.stage);
  const act = async (path: string, fields: Record<string, string>) => {
    setBusy(true);
    const result = await send(path, fields, csrf);
    setBusy(false);
    apply(result);
    if (result.ok) setNote("");
  };
  const base = `${view.flow.href}/cards/${card.id}`;
  return <div className="flex flex-col gap-4" data-flow-card-panel={card.id}>
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold leading-snug">{card.title}</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{card.state === "active" ? `In ${stage?.title ?? card.stage}` : card.state === "done" ? "Done" : "Cancelled"} · added by {card.createdBy}</p>
      </div>
      <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>
    </div>
    {card.source !== null && <p className="text-[12px] text-muted-foreground">From {card.source.url === null ? card.source.label
      : <a className="font-medium text-primary underline-offset-4 hover:underline" href={card.source.url} {...(card.source.url.startsWith("/") ? {} : { target: "_blank", rel: "noreferrer" })}>{card.source.label}</a>}</p>}
    {card.description !== null && <p className="whitespace-pre-wrap text-[13px]">{card.description}</p>}
    {card.waiting !== null && <p className="rounded-md bg-muted px-3 py-2 text-[13px]">{card.waiting}</p>}
    {card.task !== null && <a className="text-[13px] font-medium text-primary underline-offset-4 hover:underline" href={card.task.href}>Open its task</a>}
    {card.canDecide && <div className="flex flex-col gap-2 rounded-lg border border-attention/50 p-3">
      <Label htmlFor="flow-note" className="text-[13px]">{stage?.title ?? "Decision"}: approve, or send it back</Label>
      <Textarea id="flow-note" value={note} onChange={event => setNote(event.target.value)} placeholder="What should change? (needed to send it back)" rows={3} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void act(`${base}/decide`, { decision: "approve", note })}>Approve</Button>
        {stage?.onFail !== null && stage?.onFail !== undefined && <Button size="sm" variant="outline" disabled={busy || note.trim() === ""} onClick={() => void act(`${base}/decide`, { decision: "send-back", note })}>Send back</Button>}
      </div>
    </div>}
    {view.canEdit && card.state === "active" && <div className="flex flex-col gap-2">
      <Label htmlFor="flow-move" className="text-[13px]">Move to</Label>
      <select id="flow-move" className="h-9 rounded-md border bg-transparent px-2 text-[13px]" value={card.stage} disabled={busy}
        onChange={event => void act(`${base}/move`, { stage: event.target.value })}>
        {view.stages.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
      </select>
    </div>}
    {card.outputs.length > 0 && <div className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">What zones reported</h3>
      {card.outputs.map(output => <details key={output.stage} className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-[13px] font-medium">{output.title}</summary>
        <p className="mt-2 whitespace-pre-wrap text-[12.5px] text-muted-foreground">{output.text}</p>
      </details>)}
    </div>}
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[13px] font-semibold">History</h3>
      <ol className="flex flex-col gap-1.5">{card.history.map((line, index) => <li key={index} className="text-[12px]"><span className="text-muted-foreground">{new Date(line.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> · {line.text}</li>)}</ol>
    </div>
    {view.canEdit && card.state === "active" && <Button variant="ghost" size="sm" className="self-start text-destructive" disabled={busy} onClick={() => void act(`${base}/cancel`, {})}>Cancel card</Button>}
  </div>;
}

/** One labelled setting: defined once at the top level, so typing in it never remounts the input. */
function Field({ label, hint, children }: { label: string; hint?: string | undefined; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-[13px] font-medium">{label}</span>{children}{hint !== undefined && <span className="text-[12px] text-muted-foreground">{hint}</span>}</label>;
}
const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-[13px]";

function ZonePanel({ stage, stages, view, update, remove, makeStart, onClose }: { stage: BrowserFlowStage; stages: BrowserFlowStage[]; view: BrowserFlowView; update: (change: Partial<BrowserFlowStage>) => void; remove: () => void; makeStart: () => void; onClose: () => void }) {
  const others = stages.filter(one => one.id !== stage.id);
  const select = SELECT;
  const kind = view.kinds.find(one => one.kind === stage.kind);
  return <div className="flex flex-col gap-3" data-flow-zone-panel={stage.id}>
    <div className="flex items-center gap-2"><h2 className="flex-1 text-[15px] font-semibold">Edit zone</h2><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" /></Button></div>
    <Field label="Name"><Input value={stage.title} maxLength={60} onChange={event => update({ title: event.target.value })} aria-label="Zone name" /></Field>
    <Field label="What happens here" {...(kind === undefined ? {} : { hint: kind.about })}>
      <select className={select} aria-label="What happens here" value={stage.kind} onChange={event => update({ kind: event.target.value as BrowserFlowStage["kind"], ...(event.target.value === "done" ? { next: null, onFail: null } : {}) })}>
        {view.kinds.map(one => <option key={one.kind} value={one.kind}>{one.label}</option>)}
      </select>
    </Field>
    {(stage.kind === "task" || stage.kind === "report") && <Field label="What the agent should do" hint={"Fill-ins: {{card.title}}, {{card.description}}, {{note}} (the latest send-back note), {{stage.<zone id>}} (an earlier zone's report)."}>
      <Textarea rows={7} value={stage.instructions ?? ""} onChange={event => update({ instructions: event.target.value })} aria-label="What the agent should do" />
    </Field>}
    {stage.kind === "task" && <Field label="Plan first?">
      <select className={select} aria-label="Plan first?" value={stage.planning ?? "auto"} onChange={event => update({ planning: event.target.value as "auto" | "required" | "skip" })}>
        <option value="auto">Let Standing Orders decide</option><option value="required">Always plan first</option><option value="skip">Build directly</option>
      </select>
    </Field>}
    {stage.kind === "approval" && <Field label="Who decides">
      <select className={select} aria-label="Who decides" value={stage.approver ?? ""} onChange={event => update({ approver: event.target.value === "" ? null : event.target.value })}>
        <option value="">Anyone who can approve</option>{view.approvers.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
    </Field>}
    {stage.kind === "notify" && <Field label="Message"><Input value={stage.message ?? ""} maxLength={1000} onChange={event => update({ message: event.target.value })} aria-label="Message" /></Field>}
    {stage.kind !== "done" && <Field label="Then">
      <select className={select} aria-label="Then" value={stage.next ?? ""} onChange={event => update({ next: event.target.value || null })}>
        <option value="">Wait here</option>{others.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
      </select>
    </Field>}
    {(stage.kind === "approval" || stage.kind === "task" || stage.kind === "report") && <Field label={stage.kind === "approval" ? "If sent back" : "If it fails"}>
      <select className={select} aria-label={stage.kind === "approval" ? "If sent back" : "If it fails"} value={stage.onFail ?? ""} onChange={event => update({ onFail: event.target.value || null })}>
        <option value="">{stage.kind === "approval" ? "Can't be sent back" : "Wait here"}</option>{others.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}
      </select>
    </Field>}
    <div className="grid gap-1.5"><span className="text-[13px] font-medium">Color</span>
      <div className="flex gap-2">{view.colors.map(color => <button key={color} type="button" aria-label={color} aria-pressed={stage.zone.color === color}
        className={cn("size-7 rounded-full border-2", stage.zone.color === color ? "border-foreground" : "border-transparent")} style={{ background: COLORS[color] }}
        onClick={() => update({ zone: { ...stage.zone, color } })} />)}</div>
    </div>
    <div className="flex flex-wrap gap-2 pt-1">
      {view.start !== stage.id && <Button variant="outline" size="sm" onClick={makeStart}>New cards start here</Button>}
      <Button variant="ghost" size="sm" className="text-destructive" onClick={remove} disabled={stages.length <= 1}>Delete zone</Button>
    </div>
  </div>;
}

function NewCard({ view, csrf, apply, onClose }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void; onClose?: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const start = view.stages.find(one => one.id === view.start);
  return <form className="flex flex-col gap-2" onSubmit={async event => {
    event.preventDefault();
    setBusy(true);
    const result = await send(`${view.flow.href}/cards`, { title, description }, csrf);
    setBusy(false);
    apply(result);
    if (result.ok) { setTitle(""); setDescription(""); }
  }}>
    <div className="flex items-center gap-2"><h2 className="flex-1 text-[15px] font-semibold">New card</h2>{onClose !== undefined && <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>}</div>
    <p className="text-[12px] text-muted-foreground">It starts in {start?.title ?? "the first zone"}.</p>
    <Input value={title} onChange={event => setTitle(event.target.value)} placeholder="What needs doing?" maxLength={200} required aria-label="Title" />
    <Textarea value={description} onChange={event => setDescription(event.target.value)} placeholder="Details (optional)" rows={4} aria-label="Details" />
    <Button type="submit" size="sm" className="self-start" disabled={busy || title.trim() === ""}><Plus className="size-4" />Add card</Button>
  </form>;
}

const ago = (at: string | null): string => {
  if (at === null) return "";
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  return minutes < 1 ? "Just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

function CopyLine({ label, value }: { label: string; value: string }) {
  const copy = () => { void navigator.clipboard?.writeText(value).then(() => toast.success(`${label} copied.`), () => toast.error("Select it and copy it by hand.")); };
  return <div className="grid gap-1"><span className="text-[12px] font-medium">{label}</span>
    <div className="flex gap-2"><Input readOnly value={value} className="h-8 font-mono text-[12px]" onFocus={event => event.target.select()} aria-label={label} />
      <Button type="button" size="sm" variant="outline" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}><Copy className="size-3.5" /></Button></div></div>;
}

/** A new webhook address (and GitHub's secret), shown once. */
function RevealBox({ kind, reveal, onDone }: { kind: string; reveal: Reveal; onDone: () => void }) {
  return <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3" data-trigger-reveal>
    <p className="text-[13px] font-semibold">Copy these now. They aren't shown again.</p>
    {reveal.address === null
      ? <p className="text-[12px]">Save your public webhook address below first, then choose New address. <span className="break-all font-mono">{reveal.path}</span></p>
      : <CopyLine label="Address" value={reveal.address} />}
    {reveal.secret !== null && <CopyLine label="Secret" value={reveal.secret} />}
    <p className="text-[12px] text-muted-foreground">{kind === "github" ? "In GitHub: Settings → Webhooks → Add webhook. Paste the address and the secret, choose application/json, and pick the events this trigger watches (Issues, Pull requests or Workflow runs)."
      : kind === "linear" ? "In Linear: Settings → API → Webhooks → New webhook. Paste the address and choose Issues. Then paste Linear's signing secret on this trigger."
      : "Post JSON to the address. A title field becomes the card's title; description, its details."}</p>
    <Button type="button" size="sm" variant="outline" className="self-start" onClick={onDone}>Done</Button>
  </div>;
}

const TRIGGER_KEYS: Record<string, string[]> = {
  button: ["label", "questions"], schedule: ["schedule", "title", "description"], github: ["repo", "watch", "label", "branch", "from", "delivery"],
  linear: ["team", "state", "label", "delivery"], flow: ["flow", "when"], webhook: ["title", "titleField", "bodyField"],
};

function AddTrigger({ view, csrf, open, onResult }: { view: BrowserFlowView; csrf: string; open: boolean; onResult: (result: Said, kind: string) => void }) {
  const setup = view.triggerSetup;
  const [kind, setKind] = useState("button");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const defaults: Record<string, Record<string, string>> = {
    schedule: { schedule: `daily 09:00 ${timezone}` }, github: { repo: setup.githubRepo ?? "", watch: "issues", from: "team", delivery: "poll", branch: "main" },
    linear: { delivery: "poll" }, flow: { flow: String(setup.otherFlows[0]?.id ?? "") }, webhook: { title: "Webhook" },
  };
  const v = (key: string) => fields[key] ?? defaults[kind]?.[key] ?? "";
  const set = (key: string) => (event: { target: { value: string } }) => setFields(current => ({ ...current, [key]: event.target.value }));
  const source = setup.otherFlows.find(one => String(one.id) === v("flow"));
  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    const trigger: Record<string, unknown> = { kind, zone: v("zone") || null };
    for (const key of TRIGGER_KEYS[kind] ?? []) trigger[key] = key === "questions" ? v(key).split("\n") : key === "flow" ? Number(v(key)) : v(key) || null;
    setBusy(true);
    const result = await send(`${view.flow.href}/triggers`, { trigger: JSON.stringify(trigger) }, csrf);
    setBusy(false);
    onResult(result, kind);
    if (result.ok) setFields({});
  };
  return <details className="rounded-lg border px-3 py-2" open={open}>
    <summary className="cursor-pointer text-[13px] font-semibold">Add a trigger</summary>
    <form className="flex flex-col gap-3 pt-3" onSubmit={event => void submit(event)} data-add-trigger>
      <Field label="What starts cards">
        <select className={SELECT} value={kind} onChange={event => { setKind(event.target.value); setFields({}); }}>
          {setup.kinds.map(one => <option key={one.kind} value={one.kind}>{one.label}</option>)}
        </select>
      </Field>
      {kind === "button" && <>
        <Field label="Button name"><Input value={v("label")} onChange={set("label")} placeholder="Report a bug" maxLength={40} required /></Field>
        <Field label="Questions it asks" hint="One per line. The first answer becomes the card's title.">
          <Textarea rows={3} value={v("questions")} onChange={set("questions")} placeholder={"What happened?\nSteps to reproduce\nHow bad is it?"} /></Field>
      </>}
      {kind === "schedule" && <>
        <Field label="When" hint="For example: daily 09:00 Europe/London, monday 09:00, every 4 hours."><Input value={v("schedule")} onChange={set("schedule")} required /></Field>
        <Field label="Card title" hint="Each card's date is added to it."><Input value={v("title")} onChange={set("title")} placeholder="Dependency check" maxLength={200} required /></Field>
        <Field label="Details (optional)"><Textarea rows={3} value={v("description")} onChange={set("description")} /></Field>
      </>}
      {kind === "github" && <>
        <Field label="Repository"><Input value={v("repo")} onChange={set("repo")} placeholder="owner/name" required /></Field>
        <Field label="Watch"><select className={SELECT} value={v("watch")} onChange={set("watch")}>
          <option value="issues">New issues</option><option value="pulls">New pull requests</option><option value="checks">Failed checks</option></select></Field>
        {v("watch") !== "checks" && <Field label="Label (optional)" hint={v("watch") === "issues" ? "With a label, an issue joins the moment it gets the label." : "Only pull requests with this label."}>
          <Input value={v("label")} onChange={set("label")} placeholder="bug" maxLength={50} /></Field>}
        {v("watch") === "checks" && <Field label="Branch"><Input value={v("branch")} onChange={set("branch")} maxLength={100} /></Field>}
        {v("watch") !== "checks" && <Field label="From" hint={v("from") === "anyone" ? "Anyone who can open one there can write what the agent reads. The work still waits for your approval." : undefined}>
          <select className={SELECT} value={v("from")} onChange={set("from")}><option value="team">People with write access</option><option value="anyone">Anyone</option></select></Field>}
      </>}
      {kind === "linear" && <>
        <Field label="Team key" hint="Like ENG. Name a team, a label, or both."><Input value={v("team")} onChange={set("team")} placeholder="ENG" maxLength={12} /></Field>
        <Field label="When it moves to (optional)"><Input value={v("state")} onChange={set("state")} placeholder="Todo" maxLength={40} /></Field>
        <Field label="Label (optional)"><Input value={v("label")} onChange={set("label")} placeholder="bug" maxLength={50} /></Field>
      </>}
      {(kind === "github" || kind === "linear") && <Field label="How it arrives"
        hint={v("delivery") === "webhook" ? setup.hooksBase === null ? "Needs your public webhook address: set it under Settings below." : "You'll get an address to paste into " + (kind === "github" ? "GitHub." : "Linear.")
          : kind === "linear" && !setup.linearKey ? "Save your Linear key under Settings below first." : undefined}>
        <select className={SELECT} value={v("delivery")} onChange={set("delivery")}><option value="poll">Checked every 2 minutes</option><option value="webhook">Sent to a webhook address</option></select></Field>}
      {kind === "flow" && (setup.otherFlows.length === 0 ? <p className="text-[13px] text-muted-foreground">There are no other flows to follow yet.</p> : <>
        <Field label="Flow"><select className={SELECT} value={v("flow")} onChange={event => setFields(current => ({ ...current, flow: event.target.value, when: "" }))}>
          {setup.otherFlows.map(one => <option key={one.id} value={one.id}>{one.name}</option>)}</select></Field>
        <Field label="When a card reaches"><select className={SELECT} value={v("when")} onChange={set("when")}>
          <option value="">The end</option>{source?.zones.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}</select></Field>
      </>)}
      {kind === "webhook" && <>
        <Field label="Title field" hint="Where to find the card's title in the posted JSON, like title or data.issue.title."><Input value={v("titleField")} onChange={set("titleField")} placeholder="title" maxLength={80} /></Field>
        <Field label="Details field"><Input value={v("bodyField")} onChange={set("bodyField")} placeholder="description" maxLength={80} /></Field>
        <Field label="Title when there is none"><Input value={v("title")} onChange={set("title")} maxLength={120} /></Field>
      </>}
      <Field label="Cards start in"><select className={SELECT} value={v("zone")} onChange={set("zone")}>
        <option value="">{view.stages.find(one => one.id === view.start)?.title ?? "The first zone"}</option>
        {view.stages.filter(one => one.id !== view.start).map(one => <option key={one.id} value={one.id}>{one.title}</option>)}</select></Field>
      <Button type="submit" size="sm" className="self-start" disabled={busy || (kind === "flow" && setup.otherFlows.length === 0)}><Plus className="size-4" />Add trigger</Button>
    </form>
  </details>;
}

/** Installation settings a trigger may need: the Linear key (behind the password) and the public webhook address. */
function TriggerSettings({ view, csrf, apply }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const setup = view.triggerSetup;
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [address, setAddress] = useState(setup.hooksBase ?? "");
  const [busy, setBusy] = useState(false);
  const act = async (path: string, fields: Record<string, string>) => { setBusy(true); const result = await send(path, fields, csrf); setBusy(false); apply(result); if (result.ok) { setKey(""); setPassword(""); } };
  return <details className="rounded-lg border px-3 py-2">
    <summary className="cursor-pointer text-[13px] font-semibold">Settings</summary>
    <div className="flex flex-col gap-4 pt-3">
      {setup.linearKey
        ? <div className="grid gap-1.5"><span className="text-[13px] font-medium">Linear key</span><p className="text-[12px] text-muted-foreground">Saved on this computer.</p>
            <Button type="button" size="sm" variant="ghost" className="self-start text-destructive" disabled={busy} onClick={() => void act(`${view.flow.href}/linear-key`, { remove: "yes" })}>Remove key</Button></div>
        : <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void act(`${view.flow.href}/linear-key`, { key, password }); }}>
            <Field label="Linear key" hint="From Linear → Settings → Security & access → Personal API keys. Kept on this computer only.">
              <Input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="lin_api_…" /></Field>
            <Field label="Your Standing Orders password"><Input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></Field>
            <Button type="submit" size="sm" className="self-start" disabled={busy || key.trim() === "" || password === ""}>Save key</Button>
          </form>}
      <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void act(`${view.flow.href}/hooks-address`, { address }); }}>
        <Field label="Public webhook address" hint="The https site your reverse proxy (Caddy, for example) serves. Have it pass only paths starting /hooks/ to this console.">
          <Input value={address} onChange={event => setAddress(event.target.value)} placeholder="https://hooks.example.com" /></Field>
        <Button type="submit" size="sm" variant="outline" className="self-start" disabled={busy}>Save address</Button>
      </form>
    </div>
  </details>;
}

function LinearSecret({ trigger, view, csrf, apply }: { trigger: BrowserFlowTrigger; view: BrowserFlowView; csrf: string; apply: (result: Said) => void }) {
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return <form className="mt-2 flex flex-col gap-2 rounded-md border border-attention/50 p-2" onSubmit={async event => {
    event.preventDefault(); setBusy(true);
    const result = await send(`${view.flow.href}/triggers/${trigger.id}/secret`, { secret, password }, csrf);
    setBusy(false); apply(result); if (result.ok) { setSecret(""); setPassword(""); }
  }}>
    <Field label="Linear's signing secret" hint="Linear shows it when you create the webhook."><Input type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} /></Field>
    <Field label="Your Standing Orders password"><Input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></Field>
    <Button type="submit" size="sm" className="self-start" disabled={busy || secret.trim() === "" || password === ""}>Save secret</Button>
  </form>;
}

function TriggersPanel({ view, csrf, apply, focus, onPress, onClose }: { view: BrowserFlowView; csrf: string; apply: (result: Said) => void; focus: number | null; onPress: (id: number) => void; onClose: () => void }) {
  const [reveal, setReveal] = useState<{ kind: string; reveal: Reveal } | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `${view.flow.href}/triggers`;
  const act = async (path: string, kind: string) => {
    setBusy(true);
    const result = await send(path, {}, csrf);
    setBusy(false);
    apply(result);
    if (result.reveal !== undefined) setReveal({ kind, reveal: result.reveal });
  };
  const live = view.triggers.filter(one => one.state !== "removed");
  useEffect(() => { if (focus !== null) document.querySelector(`[data-trigger-row="${focus}"]`)?.scrollIntoView({ block: "nearest" }); }, [focus]);
  return <div className="flex flex-col gap-4" data-flow-triggers>
    <div className="flex items-center gap-2"><h2 className="flex-1 text-[15px] font-semibold">Triggers</h2><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" /></Button></div>
    <p className="text-[13px] text-muted-foreground">Triggers add cards to this flow on their own. The work they start still waits for your usual approvals.</p>
    {reveal !== null && <RevealBox kind={reveal.kind} reveal={reveal.reveal} onDone={() => setReveal(null)} />}
    {live.length > 0 && <ul className="flex flex-col gap-3">{live.map(trigger => <li key={trigger.id} className={cn("rounded-lg border p-3", focus === trigger.id && "ring-2 ring-primary/50")} data-trigger-row={trigger.id}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">{TRIGGER_ICONS[trigger.kind] ?? <Zap className="size-3.5" aria-hidden="true" />}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug">{trigger.words}</p>
          <p className="text-[12px] text-muted-foreground">Starts in {trigger.zone}{trigger.state === "paused" ? " · Paused" : ""}</p>
          {trigger.status !== null && <p className={cn("text-[12px]", trigger.failing ? "text-attention" : "text-muted-foreground")}>{ago(trigger.statusAt)}: {trigger.status}</p>}
        </div>
      </div>
      {trigger.hook?.needsSecret === true && !trigger.hook.ready && <LinearSecret trigger={trigger} view={view} csrf={csrf} apply={apply} />}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {trigger.button !== null && trigger.state === "active" && <Button size="sm" onClick={() => onPress(trigger.id)}>Start</Button>}
        {trigger.checkable && trigger.state === "active" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(`${base}/${trigger.id}/check`, trigger.kind)}>Check now</Button>}
        {trigger.hook !== null && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(`${base}/${trigger.id}/renew`, trigger.kind)}>New address</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(`${base}/${trigger.id}/${trigger.state === "paused" ? "resume" : "pause"}`, trigger.kind)}>{trigger.state === "paused" ? "Turn on" : "Pause"}</Button>
        <Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void act(`${base}/${trigger.id}/remove`, trigger.kind)}>Remove</Button>
      </div>
    </li>)}</ul>}
    <AddTrigger view={view} csrf={csrf} open={live.length === 0} onResult={(result, kind) => { apply(result); if (result.reveal !== undefined) setReveal({ kind, reveal: result.reveal }); }} />
    <TriggerSettings view={view} csrf={csrf} apply={apply} />
  </div>;
}

/** Pressing a button trigger: its questions, the first answer as the card's title. */
function PressPanel({ trigger, view, csrf, apply, onClose }: { trigger: BrowserFlowTrigger; view: BrowserFlowView; csrf: string; apply: (result: Said) => void; onClose: () => void }) {
  const questions = trigger.button?.questions ?? [];
  const [answers, setAnswers] = useState<string[]>(questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const answer = (index: number) => (event: { target: { value: string } }) => setAnswers(current => current.map((one, at) => at === index ? event.target.value : one));
  return <form className="flex flex-col gap-3" data-flow-press={trigger.id} onSubmit={async event => {
    event.preventDefault(); setBusy(true);
    const result = await send(`${view.flow.href}/triggers/${trigger.id}/press`, { answers: JSON.stringify(answers) }, csrf);
    setBusy(false); apply(result); if (result.ok) onClose();
  }}>
    <div className="flex items-center gap-2"><h2 className="flex-1 text-[15px] font-semibold">{trigger.button?.label}</h2><Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="size-4" /></Button></div>
    <p className="text-[12px] text-muted-foreground">The card starts in {trigger.zone}.</p>
    {questions.map((question, index) => <Field key={index} label={question}>
      {index === 0 ? <Input value={answers[index] ?? ""} onChange={answer(index)} maxLength={200} required autoFocus /> : <Textarea rows={3} value={answers[index] ?? ""} onChange={answer(index)} />}
    </Field>)}
    <Button type="submit" size="sm" className="self-start" disabled={busy || (answers[0] ?? "").trim() === ""}><Plus className="size-4" />Add card</Button>
  </form>;
}

function Canvas({ view: initial, csrf }: { view: BrowserFlowView; csrf: string }) {
  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ name: string; start: string; stages: BrowserFlowStage[] } | null>(null);
  const [selected, setSelected] = useState<{ card: number } | { zone: string } | { triggers: number | null } | { press: number } | null>(
    initial.selectedCard !== null ? { card: initial.selectedCard } : initial.startTrigger !== null && initial.triggers.some(one => one.id === initial.startTrigger && one.button !== null) ? { press: initial.startTrigger } : null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const flow = useReactFlow();
  const stages = draft?.stages ?? view.stages;
  const start = draft?.start ?? view.start;
  const dirty = draft !== null && JSON.stringify({ name: draft.name, start: draft.start, stages: draft.stages }) !== JSON.stringify({ name: view.flow.name, start: view.start, stages: view.stages });

  const apply = useCallback((result: Said) => {
    (result.ok ? toast.success : toast.error)(result.said);
    if (result.view !== undefined) setView(result.view);
  }, []);

  // Everyone sees everyone's moves: refresh while not editing.
  useEffect(() => {
    if (editing) return;
    const tick = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(`${view.flow.href}?format=json`, { credentials: "same-origin", headers: { accept: "application/json" } });
        if (response.ok) setView(await response.json() as BrowserFlowView);
      } catch { /* the next tick retries */ }
    }, 5000);
    return () => window.clearInterval(tick);
  }, [editing, view.flow.href]);

  const move = useCallback(async (card: number, stage: string) => {
    const current = view.cards.find(one => one.id === card);
    if (current === undefined || current.stage === stage) return;
    apply(await send(`${view.flow.href}/cards/${card}/move`, { stage }, csrf));
  }, [view, csrf, apply]);

  const zoneNodes: Node<ZoneData, "zone">[] = useMemo(() => stages.map(stage => ({
    id: stage.id, type: "zone" as const, position: { x: stage.zone.x, y: stage.zone.y }, width: stage.zone.w, height: stage.zone.h,
    style: { width: stage.zone.w, height: stage.zone.h }, draggable: editing, selectable: editing,
    data: {
      stage, kindLabel: view.kinds.find(one => one.kind === stage.kind)?.label ?? stage.kind, cards: view.cards.filter(card => card.stage === stage.id && card.state === "active"),
      editing, canMove: view.canEdit, start: stage.id === start, selectedCard: selected !== null && "card" in selected ? selected.card : null,
      onCard: (id: number) => { setAdding(false); setSelected({ card: id }); }, onDrop: (card: number, to: string) => void move(card, to),
      onResize: (id: string, box: { x: number; y: number; width: number; height: number }) => setDraft(current => current === null ? current : { ...current, stages: current.stages.map(one => one.id === id
        ? { ...one, zone: { ...one.zone, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } } : one) }),
    },
  })), [stages, view, editing, selected, start, move]);
  // Triggers sit to the left of the zone they start cards in, stacked when several share one.
  const liveTriggers = useMemo(() => view.triggers.filter(one => one.state !== "removed"), [view.triggers]);
  const triggerNodes: Node<TriggerData, "trigger">[] = useMemo(() => {
    const byZone = new Map<string, BrowserFlowTrigger[]>();
    for (const trigger of liveTriggers) {
      const zone = stages.some(one => one.id === trigger.zoneId) ? trigger.zoneId : start;
      byZone.set(zone, [...byZone.get(zone) ?? [], trigger]);
    }
    return [...byZone].flatMap(([zoneId, triggers]) => {
      const zone = stages.find(one => one.id === zoneId);
      if (zone === undefined) return [];
      const height = TRIGGER_HEAD + triggers.length * TRIGGER_ROW;
      return [{ id: `trigger-${zoneId}`, type: "trigger" as const, position: { x: zone.zone.x - 272, y: zone.zone.y + Math.max(0, (zone.zone.h - height) / 2) }, width: 236, height, style: { width: 236, height },
        draggable: false, selectable: false, data: { triggers, onOpen: (id: number) => setSelected({ triggers: id }), onPress: (id: number) => setSelected({ press: id }) } }];
    });
  }, [liveTriggers, stages, start]);
  // New or removed triggers change what the canvas holds: fit it again so nothing sits off the edge.
  const triggerKey = liveTriggers.map(one => `${one.id}:${one.zoneId}`).join(",");
  const fitted = useRef(triggerKey);
  useEffect(() => {
    if (fitted.current === triggerKey) return;
    fitted.current = triggerKey;
    const frame = requestAnimationFrame(() => { void flow.fitView({ padding: 0.12, minZoom: 0.55, maxZoom: 1, duration: 250 }); });
    return () => cancelAnimationFrame(frame);
  }, [triggerKey, flow]);
  const computed: FlowNode[] = useMemo(() => [...zoneNodes, ...triggerNodes], [zoneNodes, triggerNodes]);
  // React Flow keeps its own node state (measurements, selection, a drag in
  // progress); ours changes only when a drag or resize ends, so the two never
  // chase each other.
  const [nodes, setNodes] = useState<FlowNode[]>(computed);
  useEffect(() => {
    setNodes(previous => computed.map(node => {
      const old = previous.find(one => one.id === node.id);
      return old === undefined ? node : { ...old, ...node, ...(old.measured === undefined ? {} : { measured: old.measured }), selected: editing && old.selected === true };
    }));
  }, [computed, editing]);

  const edges: Edge[] = useMemo(() => {
    const center = (stage: BrowserFlowStage) => ({ x: stage.zone.x + stage.zone.w / 2, y: stage.zone.y + stage.zone.h / 2 });
    // The side of each zone that faces the other: arrows leave and arrive where it's shortest.
    const sides = (from: BrowserFlowStage, to: BrowserFlowStage, sendBack: boolean): { source: string; target: string } => {
      const a = center(from), b = center(to), dx = b.x - a.x, dy = b.y - a.y;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      if (sendBack) return horizontal ? { source: "s-Bottom", target: "t-Bottom" } : { source: "s-Left", target: "t-Left" };
      if (horizontal) return dx >= 0 ? { source: "s-Right", target: "t-Left" } : { source: "s-Left", target: "t-Right" };
      return dy >= 0 ? { source: "s-Bottom", target: "t-Top" } : { source: "s-Top", target: "t-Bottom" };
    };
    const fromTriggers: Edge[] = triggerNodes.map(node => ({ id: `${node.id}->zone`, source: node.id, sourceHandle: "out", target: node.id.slice("trigger-".length), targetHandle: "t-Left",
      type: "smoothstep", animated: node.data.triggers.some(one => one.state === "active"), deletable: false, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.5 } }));
    return [...fromTriggers, ...stages.flatMap(stage => {
      const next = stage.next === null ? undefined : stages.find(one => one.id === stage.next);
      const fail = stage.onFail === null ? undefined : stages.find(one => one.id === stage.onFail);
      return [
        ...(next === undefined ? [] : [{ id: `${stage.id}->next`, source: stage.id, target: next.id, sourceHandle: sides(stage, next, false).source, targetHandle: sides(stage, next, false).target,
          type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 2 }, deletable: editing }]),
        ...(fail === undefined ? [] : [{ id: `${stage.id}->fail`, source: stage.id, target: fail.id, sourceHandle: sides(stage, fail, true).source, targetHandle: sides(stage, fail, true).target,
          type: "smoothstep", pathOptions: { offset: 28, borderRadius: 10 }, label: stage.kind === "approval" ? "sent back" : "fails", labelStyle: { fontSize: 11, fill: "var(--so-attention)" },
          labelBgStyle: { fill: "var(--color-card)" }, markerEnd: { type: MarkerType.ArrowClosed, color: "var(--so-attention)" },
          style: { strokeWidth: 1.5, strokeDasharray: "6 4", stroke: "var(--so-attention)" }, deletable: editing }]),
      ];
    })];
  }, [stages, editing, triggerNodes, start]);

  const updateStage = (id: string, change: Partial<BrowserFlowStage>) =>
    setDraft(current => current === null ? current : { ...current, stages: current.stages.map(one => one.id === id ? { ...one, ...change } : one) });

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    setNodes(current => applyNodeChanges(changes, current));
    if (!editing) return;
    for (const change of changes) if (change.type === "select" && change.selected && !change.id.startsWith("trigger-")) setSelected({ zone: change.id });
  };
  const onNodeDragStop = (_event: unknown, node: FlowNode) => {
    if (!editing || node.type !== "zone") return;
    setDraft(current => current === null ? current : { ...current, stages: current.stages.map(one => one.id === node.id
      ? { ...one, zone: { ...one.zone, x: Math.round(node.position.x), y: Math.round(node.position.y) } } : one) });
  };

  const onConnect = (connection: Connection) => {
    if (!editing || connection.source === connection.target) return;
    updateStage(connection.source, connection.sourceHandle === "fail" ? { onFail: connection.target } : { next: connection.target });
  };

  const startEditing = () => { setDraft({ name: view.flow.name, start: view.start, stages: view.stages }); setEditing(true); setSelected(null); };
  const stopEditing = () => { setDraft(null); setEditing(false); setSelected(null); };
  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    const result = await send(`${view.flow.href}/save`, { name: draft.name, revision: String(view.flow.revision), definition: JSON.stringify({ version: 1, start: draft.start, stages: draft.stages }) }, csrf);
    setSaving(false);
    apply(result);
    if (result.ok) { setDraft(null); setEditing(false); setSelected(null); }
  };
  const addZone = () => {
    if (draft === null) return;
    const taken = new Set(draft.stages.map(one => one.id));
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const stage: BrowserFlowStage = { id: slug("New zone", taken), title: "New zone", kind: "inbox", zone: { x: Math.round(center.x - 140), y: Math.round(center.y - 120), w: 280, h: 300, color: "slate" },
      instructions: null, planning: null, approver: null, message: null, next: null, onFail: null };
    setDraft({ ...draft, stages: [...draft.stages, stage] });
    setSelected({ zone: stage.id });
  };

  const selectedCard = selected !== null && "card" in selected ? view.cards.find(one => one.id === selected.card) ?? null : null;
  const pressing = selected !== null && "press" in selected ? view.triggers.find(one => one.id === selected.press && one.button !== null) ?? null : null;
  const triggersOpen = selected !== null && "triggers" in selected && !editing;
  const selectedZone = selected !== null && "zone" in selected ? stages.find(one => one.id === selected.zone) ?? null : null;
  const waitingOnYou = view.cards.filter(card => card.canDecide).length;

  return <div className="flex h-[calc(100dvh-7.5rem)] min-h-[560px] flex-col overflow-hidden rounded-xl border bg-card" data-flow={view.flow.id}>
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      {editing && draft !== null
        ? <Input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} maxLength={80} className="h-8 max-w-64 font-semibold" aria-label="Flow name" />
        : <h1 className="text-[15px] font-semibold">{view.flow.name}</h1>}
      <span className="text-[12px] text-muted-foreground">{view.flow.project}</span>
      {waitingOnYou > 0 && !editing && <Badge tone="attention">{waitingOnYou} waiting for you</Badge>}
      <span className="flex-1" />
      {editing
        ? <>
            <Button size="sm" variant="outline" onClick={addZone}><Plus className="size-4" />Add zone</Button>
            <Button size="sm" variant="ghost" onClick={stopEditing}>Discard</Button>
            <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>{saving ? "Saving…" : "Save flow"}</Button>
          </>
        : <>
            {view.canEdit && <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setSelected({ triggers: null }); }} data-open-triggers><Zap className="size-4" />Triggers{liveTriggers.length > 0 ? ` · ${liveTriggers.length}` : ""}</Button>}
            {view.canEdit && <Button size="sm" variant="ghost" asChild><a href={view.chatHref}><MessageSquare className="size-4" />Change in chat</a></Button>}
            {view.canEdit && <Button size="sm" variant="outline" onClick={startEditing}><Pencil className="size-4" />Edit flow</Button>}
            {view.canEdit && <Button size="sm" onClick={() => { setSelected(null); setAdding(true); }}><Plus className="size-4" />New card</Button>}
          </>}
    </div>
    <div className="relative flex min-h-0 flex-1">
      <div className="relative min-w-0 flex-1" data-flow-canvas>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop} onConnect={onConnect}
          onEdgesDelete={deleted => { for (const edge of deleted) updateStage(edge.source, edge.id.endsWith("->fail") ? { onFail: null } : { next: null }); }}
          onPaneClick={() => { if (editing) setSelected(null); }}
          // A node with a click handler keeps its pointer events outside edit mode: cards are clicked and dragged.
          onNodeClick={() => undefined}
          nodesDraggable={editing} nodesConnectable={editing} elementsSelectable={editing} fitView fitViewOptions={{ padding: 0.12, minZoom: 0.55, maxZoom: 1 }} minZoom={0.3} maxZoom={1.5}
          proOptions={{ hideAttribution: true }} deleteKeyCode={editing ? ["Backspace", "Delete"] : null}>
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {editing && <p className="pointer-events-none absolute bottom-3 left-14 max-w-md rounded-lg bg-foreground/85 px-3 py-1.5 text-[12px] text-background">Drag zones to arrange them. Drag from a zone's right dot to say where work goes next, from its bottom dot for where it goes if sent back.</p>}
      </div>
      {(selectedZone !== null && editing) || selectedCard !== null || (adding && !editing) || triggersOpen || pressing !== null ? <aside className="absolute inset-y-0 right-0 z-10 w-[360px] max-w-full overflow-y-auto border-l bg-card p-4 shadow-xl" data-flow-drawer>
        {selectedZone !== null && editing
          ? <ZonePanel stage={selectedZone} stages={stages} view={view} update={change => updateStage(selectedZone.id, change)}
              remove={() => { setDraft(current => current === null ? current : { ...current, start: current.start === selectedZone.id ? current.stages.find(one => one.id !== selectedZone.id)!.id : current.start,
                stages: current.stages.filter(one => one.id !== selectedZone.id).map(one => ({ ...one, next: one.next === selectedZone.id ? null : one.next, onFail: one.onFail === selectedZone.id ? null : one.onFail })) }); setSelected(null); }}
              makeStart={() => setDraft(current => current === null ? current : { ...current, start: selectedZone.id })} onClose={() => setSelected(null)} />
          : pressing !== null
            ? <PressPanel key={pressing.id} trigger={pressing} view={view} csrf={csrf} apply={apply} onClose={() => setSelected(null)} />
          : triggersOpen
            ? <TriggersPanel view={view} csrf={csrf} apply={apply} focus={selected !== null && "triggers" in selected ? selected.triggers : null} onPress={id => setSelected({ press: id })} onClose={() => setSelected(null)} />
          : selectedCard !== null
            ? <CardPanel card={selectedCard} view={view} csrf={csrf} apply={apply} onClose={() => setSelected(null)} />
            : <NewCard view={view} csrf={csrf} apply={result => { apply(result); if (result.ok) setAdding(false); }} onClose={() => setAdding(false)} />}
      </aside> : null}
    </div>
  </div>;
}

/** Phones: the zones in order, each with its cards; a card opens its panel. Editing needs a larger screen. */
function PhoneFlow({ view: initial, csrf }: { view: BrowserFlowView; csrf: string }) {
  const [view, setView] = useState(initial);
  const [open, setOpen] = useState<number | null>(initial.selectedCard);
  const [pressing, setPressing] = useState<number | null>(initial.startTrigger);
  const apply = (result: Said) => { (result.ok ? toast.success : toast.error)(result.said); if (result.view !== undefined) setView(result.view); };
  const card = open === null ? null : view.cards.find(one => one.id === open) ?? null;
  const button = pressing === null ? null : view.triggers.find(one => one.id === pressing && one.button !== null && one.state === "active") ?? null;
  const live = view.triggers.filter(one => one.state !== "removed");
  if (button !== null) return <div className="p-4"><PressPanel trigger={button} view={view} csrf={csrf} apply={apply} onClose={() => setPressing(null)} /></div>;
  if (card !== null) return <div className="p-4"><CardPanel card={card} view={view} csrf={csrf} apply={apply} onClose={() => setOpen(null)} /></div>;
  return <div className="flex flex-col gap-3 p-4" data-flow={view.flow.id}>
    <div><h1 className="text-[17px] font-semibold">{view.flow.name}</h1><p className="text-[12px] text-muted-foreground">{view.flow.project}{view.canEdit ? <> · <a className="underline" href={view.chatHref}>change it in chat</a>, or edit it on a larger screen</> : null}</p></div>
    {view.canEdit && live.some(one => one.button !== null && one.state === "active") && <div className="flex flex-wrap gap-2">
      {live.filter(one => one.button !== null && one.state === "active").map(one => <Button key={one.id} size="sm" onClick={() => setPressing(one.id)}><MousePointerClick className="size-4" />{one.button!.label}</Button>)}</div>}
    {view.canEdit && <details className="rounded-lg border p-3"><summary className="cursor-pointer text-[14px] font-semibold">New card</summary><div className="pt-3"><NewCard view={view} csrf={csrf} apply={apply} /></div></details>}
    {flowOrder(view.stages, view.start).map(stage => {
      const cards = view.cards.filter(one => one.stage === stage.id && one.state === "active");
      return <section key={stage.id} className="rounded-lg border" style={{ borderColor: `${COLORS[stage.zone.color] ?? "#64748b"}55` }}>
        <header className="flex items-center gap-2 px-3 py-2"><span className="inline-flex size-6 items-center justify-center rounded-md text-white" style={{ background: COLORS[stage.zone.color] ?? "#64748b" }}>{KIND_ICONS[stage.kind]}</span><span className="flex-1 text-[14px] font-semibold">{stage.title}</span>{cards.length > 0 && <span className="text-[12px] text-muted-foreground">{cards.length}</span>}</header>
        {cards.length > 0 && <ul className="flex flex-col gap-2 px-3 pb-3">{cards.map(one => <li key={one.id}><button type="button" onClick={() => setOpen(one.id)} className={cn("min-h-11 w-full rounded-lg border bg-card px-3 py-2 text-left", one.canDecide && "border-attention/60")}>
          <div className="text-[14px] font-medium">{one.title}</div>{one.waiting !== null && <div className={cn("text-[12px]", one.canDecide ? "font-semibold text-attention" : "text-muted-foreground")}>{one.canDecide ? "Needs your decision" : one.waiting}</div>}
        </button></li>)}</ul>}
      </section>;
    })}
    {live.length > 0 && <section className="rounded-lg border p-3" data-flow-triggers>
      <h2 className="text-[14px] font-semibold">Triggers</h2>
      <ul className="mt-2 flex flex-col gap-2">{live.map(one => <li key={one.id} className="text-[13px]"><span className="font-medium">{one.name}</span> · {one.detail}
        <div className={cn("text-[12px]", one.failing ? "text-attention" : "text-muted-foreground")}>{one.state === "paused" ? "Paused" : one.status === null ? `Starts in ${one.zone}` : `${ago(one.statusAt)}: ${one.status}`}</div></li>)}</ul>
    </section>}
  </div>;
}

export function FlowView({ view, csrf }: { view: BrowserFlowView; csrf: string }) {
  const narrow = useRef(typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [phone, setPhone] = useState(narrow.current);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const change = () => setPhone(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  if (phone) return <PhoneFlow view={view} csrf={csrf} />;
  return <ReactFlowProvider><Canvas view={view} csrf={csrf} /></ReactFlowProvider>;
}
