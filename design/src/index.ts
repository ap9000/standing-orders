/* shadcn/ui primitives — custom-themed to the Operations Ledger. */
export { Button, buttonVariants } from "./components/ui/button.js";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "./components/ui/card.js";
export { Badge, badgeVariants } from "./components/ui/badge.js";
export { Input } from "./components/ui/input.js";
export { Label } from "./components/ui/label.js";
export { Separator } from "./components/ui/separator.js";

/* The console's own vocabulary, composed from the primitives. */
export { StatusChip, type StatusChipProps, type Status } from "./StatusChip.js";
export { DigestSeal, type DigestSealProps } from "./DigestSeal.js";
export { TextField, type TextFieldProps } from "./TextField.js";
export { AttentionCard, type AttentionCardProps } from "./AttentionCard.js";
export { CeremonySurface, type CeremonySurfaceProps } from "./CeremonySurface.js";
export { KeyValueRow, type KeyValueRowProps } from "./KeyValueRow.js";
export { Ledger, type LedgerProps } from "./Ledger.js";
export { LedgerRow, type LedgerRowProps } from "./LedgerRow.js";
export { NavBar, type NavBarProps, type NavItem } from "./NavBar.js";
export { PageHeader, type PageHeaderProps } from "./PageHeader.js";
