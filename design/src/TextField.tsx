import type { ChangeEventHandler } from "react";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { cn } from "./lib/utils.js";

export interface TextFieldProps {
  /** Uppercase label above the input. */
  label: string;
  /** Input type; use "password" inside ceremony surfaces. */
  type?: "text" | "password";
  placeholder?: string;
  defaultValue?: string;
  value?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  /** Render the value in mono — for machine facts like paths, models, or URLs. */
  mono?: boolean;
  /** Short helper line under the input. */
  hint?: string;
  name?: string;
}

/**
 * Text field — a labeled Input on an inset well. Machine-fact values (paths, model
 * ids, URLs) set `mono`; passwords appear only inside a CeremonySurface.
 */
export function TextField({
  label,
  type = "text",
  placeholder,
  defaultValue,
  value,
  onChange,
  mono = false,
  hint,
  name,
}: TextFieldProps) {
  return (
    <label className="flex flex-col gap-2">
      <Label asChild>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </Label>
      <Input
        className={cn("bg-popover", mono && "font-mono text-[13px]")}
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        value={value}
        onChange={onChange}
        name={name}
      />
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
