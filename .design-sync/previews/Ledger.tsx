import { Ledger, LedgerRow } from "@standing-orders/design";

export function BuiltToday() {
  return (
    <div style={{ maxWidth: 420 }}>
      <Ledger heading="Built today">
        <LedgerRow title="Fix flaky auth test" meta="claude · sonnet · 14m · $0.82" status="built" />
        <LedgerRow title="Add CSV export to reports" meta="claude · sonnet · 22m · $1.14" status="built" />
        <LedgerRow title="Upgrade vitest to v3" meta="codex · gpt-5 · 9m" status="built" />
      </Ledger>
    </div>
  );
}

export function Attempts() {
  return (
    <div style={{ maxWidth: 420 }}>
      <Ledger heading="Attempts">
        <LedgerRow title="#2 claude · sonnet" meta="usage ran out · fell back" status="failed" />
        <LedgerRow title="#3 gemini · gemini-2.5-pro" meta="18m · $0.94" status="built" />
      </Ledger>
    </div>
  );
}
