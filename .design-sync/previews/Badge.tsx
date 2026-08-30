import { Badge } from "@standing-orders/design";

export function Variants() {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <Badge>3 waiting</Badge>
      <Badge variant="secondary">reviewer</Badge>
      <Badge variant="outline">demo</Badge>
      <Badge variant="destructive">revoked</Badge>
    </div>
  );
}
