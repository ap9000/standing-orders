/**
 * Adapted from beUI Agent Activity's StepRow and ToolRow (MIT).
 * Copyright (c) 2026 Saurabh Chauhan. See THIRD_PARTY_NOTICES.md.
 */
import type { ReactNode } from "react";
import { cn } from "./primitives.js";

export type ActivityItem = {
  id: string;
  label: ReactNode;
  detail?: ReactNode;
  /** Required: an absent status must never imply successful work. */
  status: "pending" | "active" | "complete" | "failed";
};

const statusLabels = { pending: "Waiting", active: "Running", complete: "Finished", failed: "Failed" } as const;
export function ActivityRow({ item, className }: { item: ActivityItem; className?: string }) {
  return <li className={cn("ui-activity-row", className)} data-state={item.status}>
    <span className="ui-activity-state">{statusLabels[item.status]}</span>
    <span className="ui-activity-label">{item.label}</span>
    {item.detail && <span className="ui-activity-detail">{item.detail}</span>}
  </li>;
}
export function ActivityList({ items, className, label = "Activity" }: { items: ActivityItem[]; className?: string; label?: string }) {
  return <ul className={cn("ui-activity-list", className)} aria-label={label}>
    {items.map(item => <ActivityRow key={item.id} item={item} />)}
  </ul>;
}
