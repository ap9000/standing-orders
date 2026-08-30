import { NavBar } from "@standing-orders/design";

export function Default() {
  return (
    <div style={{ maxWidth: 420 }}>
      <NavBar
        items={[
          { label: "board", active: true },
          { label: "queue" },
          { label: "projects", badge: 2 },
          { label: "settings" },
        ]}
      />
    </div>
  );
}
