import { Input } from "@standing-orders/design";

const ground = {
  maxWidth: 320,
  background: "var(--background, #0c0e12)",
  padding: 16,
  borderRadius: 8,
};

export function Default() {
  return (
    <div style={ground}>
      <Input placeholder="Describe the task…" />
    </div>
  );
}

export function Password() {
  return (
    <div style={ground}>
      <Input type="password" defaultValue="hunter2hunter2" />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={ground}>
      <Input disabled placeholder="Locked while a run is live" />
    </div>
  );
}
