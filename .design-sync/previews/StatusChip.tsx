import { StatusChip } from "@standing-orders/design";

export function TheFiveWords() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <StatusChip status="waits-on-you" />
      <StatusChip status="running" />
      <StatusChip status="built" />
      <StatusChip status="failed" />
      <StatusChip status="queued" />
    </div>
  );
}

export function WithDetail() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <StatusChip status="running" detail="14m" />
      <StatusChip status="built" detail="2m ago" />
      <StatusChip status="failed" detail="usage ran out" />
    </div>
  );
}
