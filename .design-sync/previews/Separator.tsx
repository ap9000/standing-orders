import { Separator } from "@standing-orders/design";

export function Horizontal() {
  return (
    <div style={{ maxWidth: 320, background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <p style={{ margin: 0, fontSize: 13 }}>Scope approved by alex</p>
      <Separator style={{ margin: "12px 0" }} />
      <p style={{ margin: 0, fontSize: 13 }}>Dispatch proof verified</p>
    </div>
  );
}

export function Vertical() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: 13,
        background: "var(--background, #0c0e12)",
        padding: 16,
        borderRadius: 8,
      }}
    >
      <span>claude</span>
      <Separator orientation="vertical" style={{ height: 16 }} />
      <span>sonnet</span>
      <Separator orientation="vertical" style={{ height: 16 }} />
      <span>subscription</span>
    </div>
  );
}
