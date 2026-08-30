import { Input, Label } from "@standing-orders/design";

export function WithInput() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320, background: "var(--background, #0c0e12)", padding: 16, borderRadius: 8 }}>
      <Label htmlFor="task-title">Task title</Label>
      <Input id="task-title" placeholder="Fix flaky auth test" />
    </div>
  );
}
