/** A flow's canvas: zones are the stages of a team's process, cards are the
 * work moving through them. Drag a card to another zone to move it; open a
 * card to see its history, what zones reported, and to approve or send it
 * back. "Edit flow" lets you move, resize, add and connect zones: the solid
 * arrow is where work goes next, the dashed one where it goes if it's sent
 * back or fails. Every change is the server's: it answers with the flow as
 * it now stands, and the canvas refreshes every few seconds for everyone. */
import { Background, BackgroundVariant, Controls, Handle, MarkerType, NodeResizer, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Flag, Hammer, Inbox, Megaphone, MessageSquare, Pencil, Plus, Search, UserCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BrowserFlowCard, BrowserFlowStage, BrowserFlowView } from "../../browser-workspace.js";
import { Badge, Button, Input, Label, Textarea, cn, toast } from "../components/ui/index.js";

const COLORS: Record<string, string> = { slate: "#64748b", blue: "#3b82f6", violet: "#8b5cf6", amber: "#d97706", green: "#059669", rose: "#e11d48" };
const KIND_ICONS: Record<BrowserFlowStage["kind"], ReactNode> = {
  inbox: <Inbox className="size-3.5" aria-hidden="true" />, task: <Hammer className="size-3.5" aria-hidden="true" />, report: <Search className="size-3.5" aria-hidden="true" />,
  approval: <UserCheck className="size-3.5" aria-hidden="true" />, notify: <Megaphone className="size-3.5" aria-hidden="true" />, done: <Flag className="size-3.5" aria-hidden="true" />,
};

type Said = { ok: boolean; said: string; view?: BrowserFlowView };

async function send(path: string, fields: Record<string, string>, csrf: string): Promise<Said> {
  const body = new URLSearchParams({ csrf, ...fields });
  try {
    const response = await fetch(path, { method: "POST", body, credentials: "same-origin", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const data = await response.json() as Said;
    return { ok: data.ok === true, said: typeof data.said === "string" ? data.said : response.ok ? "Done." : "That didn't go through.", ...(data.view === undefined ? {} : { view: data.view }) };
  } catch {
    return { ok: false, said: "That didn't go through. Check your connection and try again." };
  }
}

type ZoneData = {
  stage: BrowserFlowStage; kindLabel: string; cards: BrowserFlowCard[]; editing: boolean; canMove: boolean; start: boolean;
  selectedCard: number | null; onCard: (id: number) => void; onDrop: (card: number, stage: string) => void;
  onResize: (stage: string, box: { x: number; y: number; width: number; height: number }) => void;
};

function ZoneNode({ data, selected }: NodeProps<Node<ZoneData>>) {
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

const NODE_TYPES = { zone: ZoneNode };

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

function ZonePanel({ stage, stages, view, update, remove, makeStart, onClose }: { stage: BrowserFlowStage; stages: BrowserFlowStage[]; view: BrowserFlowView; update: (change: Partial<BrowserFlowStage>) => void; remove: () => void; makeStart: () => void; onClose: () => void }) {
  const others = stages.filter(one => one.id !== stage.id);
  const select = "h-9 w-full rounded-md border bg-transparent px-2 text-[13px]";
  const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) =>
    <div className="grid gap-1.5"><span className="text-[13px] font-medium">{label}</span>{children}{hint !== undefined && <span className="text-[12px] text-muted-foreground">{hint}</span>}</div>;
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
    <Field label="Color">
      <div className="flex gap-2">{view.colors.map(color => <button key={color} type="button" aria-label={color} aria-pressed={stage.zone.color === color}
        className={cn("size-7 rounded-full border-2", stage.zone.color === color ? "border-foreground" : "border-transparent")} style={{ background: COLORS[color] }}
        onClick={() => update({ zone: { ...stage.zone, color } })} />)}</div>
    </Field>
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

function Canvas({ view: initial, csrf }: { view: BrowserFlowView; csrf: string }) {
  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ name: string; start: string; stages: BrowserFlowStage[] } | null>(null);
  const [selected, setSelected] = useState<{ card: number } | { zone: string } | null>(initial.selectedCard === null ? null : { card: initial.selectedCard });
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

  const computed: Node<ZoneData>[] = useMemo(() => stages.map(stage => ({
    id: stage.id, type: "zone", position: { x: stage.zone.x, y: stage.zone.y }, width: stage.zone.w, height: stage.zone.h,
    style: { width: stage.zone.w, height: stage.zone.h }, draggable: editing, selectable: editing,
    data: {
      stage, kindLabel: view.kinds.find(one => one.kind === stage.kind)?.label ?? stage.kind, cards: view.cards.filter(card => card.stage === stage.id && card.state === "active"),
      editing, canMove: view.canEdit, start: stage.id === start, selectedCard: selected !== null && "card" in selected ? selected.card : null,
      onCard: (id: number) => { setAdding(false); setSelected({ card: id }); }, onDrop: (card: number, to: string) => void move(card, to),
      onResize: (id: string, box: { x: number; y: number; width: number; height: number }) => setDraft(current => current === null ? current : { ...current, stages: current.stages.map(one => one.id === id
        ? { ...one, zone: { ...one.zone, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } } : one) }),
    },
  })), [stages, view, editing, selected, start, move]);
  // React Flow keeps its own node state (measurements, selection, a drag in
  // progress); ours changes only when a drag or resize ends, so the two never
  // chase each other.
  const [nodes, setNodes] = useState<Node<ZoneData>[]>(computed);
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
    return stages.flatMap(stage => {
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
    });
  }, [stages, editing]);

  const updateStage = (id: string, change: Partial<BrowserFlowStage>) =>
    setDraft(current => current === null ? current : { ...current, stages: current.stages.map(one => one.id === id ? { ...one, ...change } : one) });

  const onNodesChange = (changes: NodeChange<Node<ZoneData>>[]) => {
    setNodes(current => applyNodeChanges(changes, current));
    if (!editing) return;
    for (const change of changes) if (change.type === "select" && change.selected) setSelected({ zone: change.id });
  };
  const onNodeDragStop = (_event: unknown, node: Node<ZoneData>) => {
    if (!editing) return;
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
      {(selectedZone !== null && editing) || selectedCard !== null || (adding && !editing) ? <aside className="absolute inset-y-0 right-0 z-10 w-[360px] max-w-full overflow-y-auto border-l bg-card p-4 shadow-xl" data-flow-drawer>
        {selectedZone !== null && editing
          ? <ZonePanel stage={selectedZone} stages={stages} view={view} update={change => updateStage(selectedZone.id, change)}
              remove={() => { setDraft(current => current === null ? current : { ...current, start: current.start === selectedZone.id ? current.stages.find(one => one.id !== selectedZone.id)!.id : current.start,
                stages: current.stages.filter(one => one.id !== selectedZone.id).map(one => ({ ...one, next: one.next === selectedZone.id ? null : one.next, onFail: one.onFail === selectedZone.id ? null : one.onFail })) }); setSelected(null); }}
              makeStart={() => setDraft(current => current === null ? current : { ...current, start: selectedZone.id })} onClose={() => setSelected(null)} />
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
  const apply = (result: Said) => { (result.ok ? toast.success : toast.error)(result.said); if (result.view !== undefined) setView(result.view); };
  const card = open === null ? null : view.cards.find(one => one.id === open) ?? null;
  if (card !== null) return <div className="p-4"><CardPanel card={card} view={view} csrf={csrf} apply={apply} onClose={() => setOpen(null)} /></div>;
  return <div className="flex flex-col gap-3 p-4" data-flow={view.flow.id}>
    <div><h1 className="text-[17px] font-semibold">{view.flow.name}</h1><p className="text-[12px] text-muted-foreground">{view.flow.project}{view.canEdit ? <> · <a className="underline" href={view.chatHref}>change it in chat</a>, or edit it on a larger screen</> : null}</p></div>
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
