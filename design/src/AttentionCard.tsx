import type { ReactNode } from "react";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "./components/ui/card.js";
import { cn } from "./lib/utils.js";

export interface AttentionCardProps {
  /** What is waiting, e.g. "Approve scope for job-scraper". */
  title: string;
  /** Mono machine fact beside the title, e.g. "claude · sonnet" or "task #93". */
  meta?: string;
  /** Body content — usually KeyValueRow items or a short sentence. */
  children?: ReactNode;
  /** The resolving action, usually a default (amber) Button. */
  action?: ReactNode;
  className?: string;
}

/**
 * Attention card — the "waits on you" surface. The amber top rule is the console's
 * accent doing its only job: marking work that cannot proceed without the user.
 * At most a handful of these exist at once; everything else on screen stays ink.
 */
export function AttentionCard({ title, meta, children, action, className }: AttentionCardProps) {
  return (
    <Card className={cn("gap-3 border-t-[3px] border-t-primary py-4", className)}>
      <CardHeader className="px-4">
        <CardTitle className="text-[15px]">{title}</CardTitle>
        {meta ? (
          <CardAction className="self-center font-mono text-xs text-muted-foreground">{meta}</CardAction>
        ) : null}
      </CardHeader>
      {children ? <CardContent className="px-4">{children}</CardContent> : null}
      {action ? <CardFooter className="px-4">{action}</CardFooter> : null}
    </Card>
  );
}
