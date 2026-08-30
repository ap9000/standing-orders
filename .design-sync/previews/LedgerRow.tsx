import { Ledger, LedgerRow } from "@standing-orders/design";

export function States() {
  return (
    <div style={{ maxWidth: 420 }}>
      <Ledger>
        <LedgerRow title="Fix flaky auth test" meta="claude · sonnet · 14m" status="running" />
        <LedgerRow title="Add CSV export" meta="claude · sonnet · 22m · $1.14" status="built" statusDetail="2m ago" />
        <LedgerRow title="Migrate config loader" meta="third strike" status="failed" />
        <LedgerRow title="Refresh README screenshots" status="queued" />
      </Ledger>
    </div>
  );
}
