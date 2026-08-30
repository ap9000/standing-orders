import { cn } from "./lib/utils.js";

/** One of the console's five statuses — the whole status vocabulary, said identically on every screen. */
export type Status = "waits-on-you" | "running" | "built" | "failed" | "queued";

const LABELS: Record<Status, string> = {
  "waits-on-you": "waits on you",
  running: "running",
  built: "built",
  failed: "failed",
  queued: "queued",
};

const VARIANTS: Record<Status, string> = {
  "waits-on-you": "border-primary/40 bg-primary/12 text-primary",
  running: "border-running/40 bg-running/12 text-running",
  built: "border-built/40 bg-built/12 text-built",
  failed: "border-failed/40 bg-failed/12 text-failed",
  queued: "border-border text-muted-foreground",
};

export interface StatusChipProps {
  /** The status to display. `waits-on-you` is the only amber element on any screen. */
  status: Status;
  /** Optional machine detail after the word, rendered in mono — e.g. "2m ago" or "claude · sonnet". */
  detail?: string;
  className?: string;
}

/**
 * Status chip — the console's five-word status vocabulary (`waits on you`, `running`,
 * `built`, `failed`, `queued`) as a quiet 12%-tint outline chip. Amber is reserved for
 * `waits-on-you`: the accent color only ever means "needs your attention".
 */
export function StatusChip({ status, detail, className }: StatusChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-2 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        VARIANTS[status],
        className,
      )}
    >
      {LABELS[status]}
      {detail ? <span className="font-mono font-normal text-muted-foreground">{detail}</span> : null}
    </span>
  );
}
