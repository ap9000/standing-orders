import { cn } from "./lib/utils.js";

export interface DigestSealProps {
  /** The digest or fingerprint being sealed, e.g. "a24c72e6603f7829". Rendered in mono. */
  digest: string;
  /** Word before the digest. Defaults to "signs". */
  label?: string;
  className?: string;
}

/**
 * Digest seal — a small inset chip pairing a plain-language label with a mono digest.
 * Used wherever a password is about to bind to exact terms: the seal shows the reader
 * precisely what their signature covers.
 */
export function DigestSeal({ digest, label = "signs", className }: DigestSealProps) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-2 self-start rounded-md border bg-popover px-2.5 py-1",
        className,
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs tracking-wide text-foreground">{digest}</span>
    </span>
  );
}
