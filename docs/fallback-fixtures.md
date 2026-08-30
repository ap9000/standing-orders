# Arming the fallback chains: the fixture road

The automatic fallback feature ships **inert**. Everything is built,
reviewed, and tested — the approval binds the whole chain, the cycle state
machine survives crashes and races, the admission re-proves every authority
at the money moment — but no attempt can ever *classify* as a subscription
exhaustion, because the recognizer registry in `src/exhaustion.ts` ships
**empty**, has **no runtime mutation surface** (an architecture test
forbids one), and only a source edit reviewed in a text diff can add to it.

This is deliberate. The one thing the plane must never do is decide, from
plausible-looking prose, that your subscription is spent and switch your
work onto a paid API key. So the recognition of "spent" is held to a
standard the plane cannot manufacture: a **fixture captured from a
genuinely exhausted subscription**.

## What a fixture is

The exact bytes a provider's CLI emits when its subscription/plan cap is
truly exhausted, at a pinned CLI version:

- the structural failure terminal (the typed error event — not stderr, not
  prose in a success payload),
- its machine `code` and bounded `text`,
- the CLI version string that produced it,
- the auth mode it happened under (subscription → `usage-exhausted`;
  api-key credits → `credits-depleted`).

## How one gets captured

1. **Wait for real exhaustion** — a day the Claude/Codex plan actually runs
   out. There is no synthetic path; a successful run cannot establish the
   exhausted shape.
2. **Capture the envelope.** The gateway already retains the structural
   terminal on every failed run (`terminal_class` stays honest-`unknown` /
   `not-exhausted`; the run row and its reason words carry the evidence).
   Copy the exact terminal `code` + `text` and the CLI version from the run
   record.
3. **Write the recognizer as a source edit** in `src/exhaustion.ts`, under
   the exact provider + version key: the `eligibleUsage` (or
   `eligibleCredits`) patterns matching those bytes, and any `transient`
   patterns needed so a throttle can never read as exhaustion (Claude's
   "temporarily limiting requests" family belongs in `transient`).
4. **Review the diff.** The module is byte-clean by test (no NUL, no
   mutation exports), so the recognizer change is a small, legible text
   diff — the whole point. It authorizes real spend switches; treat the
   review accordingly.
5. **Tier-1 version proving.** Claude and Codex currently prove **no
   version at the gateway** (`attested === null` → classification stays
   fail-closed even with a fixture). Arming them requires extending the
   gateway's authoritative version proof to the fixtured provider — the
   same attestation road gemini already walks. Ship that alongside the
   first claude/codex fixture, never before.

## What arming does NOT change

- The operator still configures the chain (`config set fallback`) and
  still signs the grant (`mode set --allow-paid-fallback`); without both,
  a recognized exhaustion closes its cycle `grant-withheld` and the run
  disposes as an ordinary failure.
- Every authority is still re-proved at advance, admission, and the
  pre-spawn custody stamp; the fixture only lets a terminal *classify* —
  it authorizes nothing by itself (C8 re-checks the exact
  provider/version/auth-mode capability at every advance).
