/** shadcn/ui Toaster (MIT) on sonner, colored from the shared palette. */
import { Toaster as Sonner, toast } from "sonner";
export { toast };
export function Toaster() {
  return <Sonner position="bottom-center" toastOptions={{ classNames: { toast: "!bg-card !text-foreground !border !border-border !shadow-lg", description: "!text-muted-foreground" } }} />;
}
