/**
 * Button and Dialog adapt shadcn/ui's Radix composition (MIT).
 * See THIRD_PARTY_NOTICES.md for the pinned upstream source and modifications.
 */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps, ReactNode } from "react";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "default" | "sm" | "icon";
  asChild?: boolean;
};

export function Button({ className, variant = "primary", size = "default", asChild = false, type, ...props }: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return <Component
    data-slot="button"
    data-variant={variant}
    data-size={size}
    className={cn("ui-button", `ui-button--${variant}`, `ui-button--${size}`, className)}
    {...(!asChild ? { type: type ?? "button" } : {})}
    {...props}
  />;
}

export type BadgeProps = ComponentProps<"span"> & {
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
};
export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return <span data-slot="badge" data-tone={tone} className={cn("ui-badge", `ui-badge--${tone}`, className)} {...props} />;
}
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn("ui-input", className)} {...props} />;
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn("ui-textarea", className)} {...props} />;
}
export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("ui-label", className)} {...props} />;
}
export type DisclosureProps = ComponentProps<"details"> & { summary: ReactNode };
export function Disclosure({ summary, className, children, ...props }: DisclosureProps) {
  return <details className={cn("ui-disclosure", className)} {...props}>
    <summary className="ui-disclosure-trigger">{summary}</summary>
    <div className="ui-disclosure-content">{children}</div>
  </details>;
}
export function Alert({ className, tone = "info", ...props }: ComponentProps<"div"> & { tone?: "info" | "error" }) {
  return <div role={tone === "error" ? "alert" : "status"} data-tone={tone} className={cn("ui-alert", `ui-alert--${tone}`, className)} {...props} />;
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="ui-dialog-overlay" />
    <DialogPrimitive.Content className={cn("ui-dialog-content", className)} {...props}>
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}
export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("ui-dialog-title", className)} {...props} />;
}
export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("ui-dialog-description", className)} {...props} />;
}
