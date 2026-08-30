import type { ReactNode } from "react";
import { cn } from "./lib/utils.js";

export interface KeyValueRowProps {
  /** The fact's name in plain language, e.g. "runs on" or "budget". */
  label: string;
  /** The fact itself. Machine facts (models, paths, digests, costs) set `mono`. */
  value: ReactNode;
  /** Render the value in mono — for anything the machine asserts. */
  mono?: boolean;
}

/**
 * Key-value row — one fact per line with a hairline divider. The scope card,
 * task details, and settings are stacks of these. Values that are machine facts
 * (model ids, paths, digests, dollar amounts) render in mono via `mono`.
 */
export function KeyValueRow({ label, value, mono = false }: KeyValueRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 last:border-b-0">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-right text-[13px] text-foreground [overflow-wrap:anywhere]",
          mono && "font-mono text-xs",
        )}
      >
        {value}
      </span>
    </div>
  );
}
