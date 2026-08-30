import type { ReactNode } from "react";

export interface LedgerProps {
  /** Uppercase section heading, e.g. "Built today" or "Attempts". */
  heading?: string;
  /** LedgerRow children. */
  children: ReactNode;
}

/**
 * Ledger — a bordered list of finished or in-flight work, read as a record.
 * Rows are LedgerRow. Use it for "built today", attempt histories, and queues;
 * it replaces stacks of prose cards.
 */
export function Ledger({ heading, children }: LedgerProps) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      {heading ? (
        <h3 className="m-0 border-b px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {heading}
        </h3>
      ) : null}
      {children}
    </section>
  );
}
