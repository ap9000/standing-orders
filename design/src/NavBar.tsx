import { cn } from "./lib/utils.js";

export interface NavItem {
  /** Lowercase mono label, e.g. "board", "queue", "projects". */
  label: string;
  /** The current screen. */
  active?: boolean;
  /** Count of items waiting on the user behind this tab — the badge is amber. */
  badge?: number;
}

export interface NavBarProps {
  /** The tabs, in order. Exactly one should be active. */
  items: NavItem[];
}

/**
 * Bottom navigation — mono lowercase labels on a hairline-topped bar.
 * A tab's amber badge counts work waiting on the user behind it; the badge is
 * the only place the accent appears in chrome.
 */
export function NavBar({ items }: NavBarProps) {
  return (
    <nav className="flex border-t bg-card">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={cn(
            "flex flex-1 items-center justify-center gap-2 border-none bg-transparent py-3 font-mono text-xs text-muted-foreground",
            item.active && "text-foreground shadow-[inset_0_2px_0_0_currentColor]",
          )}
        >
          {item.label}
          {item.badge ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {item.badge}
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
