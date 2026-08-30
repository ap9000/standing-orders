import type { ReactNode, FormEventHandler } from "react";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card.js";
import { DigestSeal } from "./DigestSeal.js";
import { TextField } from "./TextField.js";
import { cn } from "./lib/utils.js";

export interface CeremonySurfaceProps {
  /** What is being signed, e.g. "Approve this scope". */
  title: string;
  /** The terms restated in plain language — what the password will mean. */
  terms: ReactNode;
  /** The digest the signature binds to, shown as a seal above the password. */
  digest: string;
  /** Label on the amber action. Defaults to "Sign". */
  actionLabel?: string;
  /** Label on the password field. Defaults to "Password". */
  passwordLabel?: string;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  className?: string;
}

/**
 * Ceremony surface — the console's one pattern for every password form. Amber top
 * rule, the terms restated, the digest rendered as a seal, then the password and a
 * single amber action. If a screen looks like this, the password is about to bind
 * to exactly the terms shown.
 */
export function CeremonySurface({
  title,
  terms,
  digest,
  actionLabel = "Sign",
  passwordLabel = "Password",
  onSubmit,
  className,
}: CeremonySurfaceProps) {
  return (
    <Card className={cn("max-w-[420px] gap-4 border-t-[3px] border-t-primary py-5", className)}>
      <CardHeader className="px-5">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-5">
        <div className="flex flex-col gap-2 text-sm">{terms}</div>
        <DigestSeal digest={digest} />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit?.(e);
          }}
        >
          <TextField label={passwordLabel} type="password" name="password" />
          <Button type="submit" className="w-full">
            {actionLabel}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
