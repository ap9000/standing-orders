/**
 * Interactive prompts, for exactly one situation: a person at a real
 * terminal left out a value a command needs. Every prompt is gated on a
 * TTY at both ends and never fires under --json — an agent or a cron job
 * gets the same immediate usage refusal as always, because a scheduler
 * hanging on "password:" at 3am is the one bug this module must not have.
 */

import { createInterface } from "node:readline";

/** Whether asking is even possible: a human on both ends of the pipe. */
export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/** Like ask, but what is typed never echoes — passwords live here. */
/**
 * Raw-mode input is not text: a terminal with bracketed paste on wraps a
 * pasted password in ESC[200~ … ESC[201~, and any arrow or function key
 * arrives as an escape sequence. Every CSI/SS3 sequence is dropped whole,
 * so a pasted secret compares equal to a typed one (setup review: the
 * hidden prompt refused every pasted password on iTerm and Terminal.app).
 */
export function sanitizeHiddenInput(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001bO[@-~]/g, "").replace(/\u001b/g, "");
}

export function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode?.(true);
  stdin.resume();
  return new Promise(resolve => {
    let value = "";
    const finish = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      const text = sanitizeHiddenInput(chunk.toString("utf8"));
      for (const ch of text) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C during a hidden prompt: leave the terminal usable, then go.
          finish();
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** A yes/no gate for an act worth a beat of deliberateness. */
export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} (yes/no) `);
  return answer.toLowerCase() === "yes" || answer.toLowerCase() === "y";
}
