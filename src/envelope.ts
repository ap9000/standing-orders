/**
 * The machine envelope — the one shape every `--json` answer takes.
 *
 * Agents branch on this output ten thousand times a night, so the contract
 * is versioned and deliberately dull: `envelopeVersion` first, then `ok`,
 * then `command`, then whatever the command has to say. Failures add a
 * stable `reason` token and a human `message`. Nothing else about the
 * shape is promised, and consumers are told to ignore keys they do not
 * recognize — that is what lets the envelope grow without breaking anyone.
 *
 * Every emission in the CLI routes through `envelopeJson` (a source-level
 * test enforces it), which is also what makes `-o <file>` possible: the
 * entry point asks this module for the last envelope written and copies it
 * to the file, so an agent never has to scrape a terminal.
 */

export const ENVELOPE_VERSION = 1;

/**
 * Feature detection for agent consumers, Claude-`system/init` style:
 * a bounded list of protocol behaviors this build honors. Consumers must
 * ignore values they do not recognize. Behaviors, not versions — an agent
 * should ask "can I rely on stable reasons", never "is this 0.1.2".
 */
export const CAPABILITIES: readonly string[] = [
  "envelope/1", //          every --json answer is one versioned envelope on stdout
  "stable-reasons", //      failure `reason` is a token that survives rewording
  "idempotency-keys", //    every mutation takes --key; retries return the first answer
  "exit-codes/0-1-2-3", //  0 ok · 1 broke · 2 usage · 3 ran fine, answer is no
  "output-file", //         -o <file> writes the same envelope to a file
];

export type EnvelopePayload = {
  ok: boolean;
  command: string;
  [key: string]: unknown;
};

let captured: string | null = null;

/** Serialize one envelope, remembering it for `-o` teeing at the entry point. */
export function envelopeJson(payload: EnvelopePayload): string {
  const body = JSON.stringify({ envelopeVersion: ENVELOPE_VERSION, ...payload }, null, 2);
  captured = body;
  return body;
}

/** The last envelope this process serialized, or null if none has been. */
export function capturedEnvelope(): string | null {
  return captured;
}

/** Forget the captured envelope — the entry point calls this before dispatch. */
export function resetCapturedEnvelope(): void {
  captured = null;
}
