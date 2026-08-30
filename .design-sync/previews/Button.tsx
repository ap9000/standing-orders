import { Button } from "@standing-orders/design";

export function Variants() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <Button>Sign</Button>
      <Button variant="secondary">View diff</Button>
      <Button variant="outline">Open in editor</Button>
      <Button variant="ghost">Dismiss</Button>
      <Button variant="destructive">Revoke</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <Button size="sm" variant="secondary">
        Retry
      </Button>
      <Button variant="secondary">Retry</Button>
      <Button size="lg" variant="secondary">
        Retry
      </Button>
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ display: "flex", gap: 8, background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <Button disabled>Sign</Button>
      <Button variant="secondary" disabled>
        View diff
      </Button>
    </div>
  );
}
