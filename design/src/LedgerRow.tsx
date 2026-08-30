import type { ReactNode } from "react";
import { StatusChip, type Status } from "./StatusChip.js";

export interface LedgerRowProps {
  /** What the row records, e.g. "Fix flaky auth test". */
  title: string;
  /** Mono machine facts under the title, e.g. "claude · sonnet · 14m · $0.82". */
  meta?: string;
  /** Status chip at the row's end. */
  status?: Status;
  /** Extra detail inside the status chip, e.g. "2m ago". */
  statusDetail?: string;
  /** Custom trailing content instead of (or beside) the status chip. */
  trailing?: ReactNode;
}

/**
 * Ledger row — one line of record inside a Ledger: title, mono meta line,
 * and a status chip. An attempt history is LedgerRows; so is "built today".
 */
export function LedgerRow({ title, meta, status, statusDetail, trailing }: LedgerRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        {meta ? <span className="font-mono text-xs text-muted-foreground">{meta}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {trailing}
        {status ? <StatusChip status={status} detail={statusDetail} /> : null}
      </div>
    </div>
  );
}
