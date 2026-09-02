/**
 * `standing-orders chat` (mate arc §6): the same thread the console shows,
 * driven from a terminal. The password is typed once — it mints the mate
 * session, the one ceremony a conversation gets — and every later turn
 * debits that session without asking again. Confirming a card runs the
 * same doors the console runs; password-class acts (approving a scope,
 * cancelling) print where to do them instead of doing them here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatConfig, MateProposal, Store } from "./store.js";
import { CHAT_KEY_ENV, credentialKeyOf, priceForConfig } from "./converse.js";
import { verifyApproverByPassword, type VerifiedApprover } from "./principal.js";
import { runMateTurn, type MateTurnOutcome } from "./mate.js";
import { confirmMateProposal, dismissMateProposal } from "./mate-doors.js";
import { projectName } from "./project.js";

export type MateCliSeams = {
  fetcher?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Lines the REPL reads instead of stdin (tests). */
  lines?: AsyncIterable<string> | Iterable<string>;
  clock?: () => Date;
};

export type MateCliInput = {
  store: Store;
  databaseFile: string;
  write: (line: string) => void;
  json: boolean;
  credentials: { name: string; token: string };
  /** The ceiling: explicit `--repo` paths, or the enrolled projects when none are named. */
  repos: readonly string[];
  say: string | undefined;
  end: boolean;
  ceilingUsd: number | undefined;
  hours: number | undefined;
  seams?: MateCliSeams;
};

export type MateCliResult = { code: number; reason?: string; message?: string };

export const MATE_CLI_EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

function money(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

function keyFor(config: ChatConfig, databaseFile: string, env: Record<string, string | undefined>): string | null {
  const fromEnv = env[CHAT_KEY_ENV[config.provider]];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const read = readFileSync(join(dirname(databaseFile), `chat-key-${config.provider}`), "utf8").trim();
    return read === "" ? null : read;
  } catch {
    return null;
  }
}

/** One line per proposal, numbered in thread order, for the operator to name. */
export function proposalLines(proposals: readonly MateProposal[], repos: readonly string[]): string[] {
  return proposals.map((one, index) => {
    const payload = one.payload;
    const t = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string) : "");
    const repoLabel = (() => {
      const id = t("repoId");
      const path = /^r[0-9]+$/.test(id) ? repos[Number(id.slice(1)) - 1] : undefined;
      return path === undefined ? id : `${id} ${projectName(path)}`;
    })();
    const what =
      one.kind === "task"
        ? `file "${t("title")}" in ${repoLabel}`
        : one.kind === "next"
          ? `move ${t("task")} to the front (was ${String(payload["position"] ?? "?")} of ${String(payload["of"] ?? "?")})`
          : one.kind === "reserve"
            ? `${payload["worker"] === null ? `release ${t("task")} to the shared queue` : `reserve ${t("task")} for ${t("worker")}`}`
            : one.kind === "hold"
              ? `hold ${t("task")}: ${t("reason")}`
              : one.kind === "unhold"
                ? `release ${t("task")} from its hold`
                : one.kind === "scope"
                  ? `rewrite the scope of ${t("task")} (then approve it: standing-orders task approve ${t("task")})`
                  : `cancel ${t("task")}: ${t("reason")} (arm it yourself: standing-orders task cancel ${t("task")})`;
    const state = one.state === "pending" ? "" : ` [${one.state}${one.outcome !== null && typeof (one.outcome as { said?: unknown }).said === "string" ? `: ${(one.outcome as { said: string }).said}` : ""}]`;
    return `  ${index + 1}. ${what}${state}`;
  });
}

async function* linesOf(seams: MateCliSeams | undefined): AsyncGenerator<string> {
  if (seams?.lines !== undefined) {
    for await (const line of seams.lines) yield line;
    return;
  }
  const { createInterface } = await import("node:readline");
  const reader = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
  }
}

export async function runMateCli(input: MateCliInput): Promise<MateCliResult> {
  const { store, write, json } = input;
  const seams = input.seams ?? {};
  const clock = seams.clock ?? (() => new Date());
  const env = seams.env ?? process.env;
  const say = (line: string): void => {
    if (!json) write(line);
  };
  const emit = (envelope: Record<string, unknown>): void => {
    if (json) write(JSON.stringify({ command: "chat", ...envelope }));
  };
  const refuse = (reason: string, message: string, code: number = MATE_CLI_EXIT.refused): MateCliResult => {
    if (json) write(JSON.stringify({ ok: false, command: "chat", reason, message }));
    else write(message);
    return { code, reason, message };
  };

  if (store.isDemo()) return refuse("demo", "this is a demo database — chat spends money and refuses it");
  const config = store.getChatConfig();
  if (config === null) return refuse("unconfigured", "chat is not configured — standing-orders config set chat --provider … --model … --weekly-usd …");
  if (priceForConfig(config) === null) return refuse("unpriced", `no pinned price for ${config.model} — re-save the chat configuration`);
  const key = keyFor(config, input.databaseFile, env);
  if (key === null) return refuse("no-key", `no ${config.provider} key — export ${CHAT_KEY_ENV[config.provider]}, or paste one on the console's chat page`);
  const repos = [...input.repos];
  if (repos.length === 0) return refuse("empty-ceiling", "the mate needs projects to see — name them with --repo, or enroll some in the console", MATE_CLI_EXIT.usage);

  const verified = verifyApproverByPassword(store, input.credentials.name, input.credentials.token, repos);
  if (!verified.ok) return refuse("unauthenticated", "that is not an approver, or the password does not match");
  const who: VerifiedApprover = verified.who;
  let now = clock();

  if (input.end) {
    const turns = store.failLiveMateTurnsFor(who.name, "ended", now);
    const sessions = store.endMateSessionsFor(who.name, who.name, now);
    const threads = store.closeMateThreadsFor(who.name, now);
    emit({ ok: true, ended: { sessions, threads, turns } });
    say(sessions === 0 ? "no mate session was live; the thread is gone" : "the session is over and the thread is forgotten");
    return { code: MATE_CLI_EXIT.ok };
  }

  store.sweepStaleMateTurns(now);
  store.sweepMateThreads(now);
  let session = store.activeMateSession(who.name, now);
  if (session !== null && session.ceilingDigest !== who.ceilingDigest) {
    store.endMateSession(session.id, who.name, now);
    store.closeMateThreadsFor(who.name, now);
    say("the projects named differ from the live session's — that session ended; minting a new one");
    session = null;
  }
  if (session === null) {
    const ceilingUsd = input.ceilingUsd ?? 5;
    const hours = input.hours ?? 4;
    if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0 || ceilingUsd > 1_000) return refuse("usage", "--ceiling-usd is a dollar amount between 0 and 1000", MATE_CLI_EXIT.usage);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) return refuse("usage", "--hours is a whole number, 1 to 24", MATE_CLI_EXIT.usage);
    const ceilingMicrousd = Math.round(ceilingUsd * 1_000_000);
    const expiresAt = new Date(now.getTime() + hours * 3_600_000);
    const credentialKey = credentialKeyOf(config.provider, key);
    const termsDigest = createHash("sha256").update(`${ceilingMicrousd}\n${expiresAt.toISOString()}\n${who.ceilingDigest}`).digest("hex");
    const id = store.mintMateSession(
      { approver: who.name, approverGeneration: who.generation, credentialKey, ceilingMicrousd, ceilingDigest: who.ceilingDigest, termsDigest, expiresAt },
      now,
    );
    session = store.getMateSession(id);
    if (session === null) return refuse("failed", "the session could not be minted", MATE_CLI_EXIT.failed);
    say(`mate session minted: up to ${money(ceilingMicrousd)} until ${expiresAt.toISOString().slice(0, 16).replace("T", " ")}Z over ${repos.map((one, index) => `r${index + 1} ${projectName(one)}`).join(", ")}`);
    say(`(the weekly chat ceiling, ${money(config.weeklyCeilingMicrousd)}, still binds above it)`);
  } else {
    say(`mate session live: ${money(session.spentMicrousd)} of ${money(session.ceilingMicrousd)} spent, until ${session.expiresAt.slice(0, 16).replace("T", " ")}Z`);
  }
  const thread = store.openMateThread(who.name, who.ceilingDigest, now).thread;

  const pendingProposals = (): MateProposal[] => store.listMateProposals(thread.id, ["pending"]);
  const printProposals = (): void => {
    const rows = pendingProposals();
    if (rows.length === 0) return;
    say("proposals — `confirm N`, `dismiss N`, `open N`:");
    for (const line of proposalLines(rows, repos)) say(line);
  };

  const turn = async (message: string): Promise<MateTurnOutcome> => {
    const live = store.activeMateSession(who.name, clock());
    if (live === null) {
      const outcome: MateTurnOutcome = { ok: false, refused: "session-ended", message: "this mate session has ended — run chat again to mint one" };
      return outcome;
    }
    return runMateTurn({ store, who, session: live, thread, config, key, message, ...(seams.fetcher === undefined ? {} : { fetcher: seams.fetcher }), clock });
  };
  const report = (outcome: MateTurnOutcome): void => {
    if (outcome.ok) {
      emit({ ok: true, turn: outcome.turn, reply: outcome.reply, activity: outcome.activity, steps: outcome.steps, settledMicrousd: outcome.settledMicrousd, proposals: pendingProposals().map(one => ({ id: one.id, kind: one.kind, payload: one.payload })) });
      say(`  ${outcome.activity}`);
      say(outcome.reply);
      printProposals();
      return;
    }
    emit({ ok: false, ...("refused" in outcome ? { reason: outcome.refused } : { turn: outcome.turn, reason: outcome.failed, unknownSpend: outcome.unknownSpend }), message: outcome.message });
    say(outcome.message);
  };

  if (input.say !== undefined) {
    const outcome = await turn(input.say);
    report(outcome);
    return { code: outcome.ok ? MATE_CLI_EXIT.ok : MATE_CLI_EXIT.refused };
  }

  // The REPL. Text is a turn; a few words are acts on the cards.
  say("say something, or: proposals · confirm N · dismiss N · open N · end · quit");
  const openTask = (proposal: MateProposal): void => {
    const taskId = typeof proposal.payload["task"] === "string" ? (proposal.payload["task"] as string) : null;
    if (taskId === null) {
      say("that proposal names no task yet");
      return;
    }
    const task = store.getTask(taskId);
    const scope = store.getScope(taskId);
    say(task === null ? `no task ${taskId}` : `${taskId} · ${task.title} · ${task.state}${scope === null ? "" : `\n  goal: ${scope.goal}${scope.outOfScope === null ? "" : `\n  not: ${scope.outOfScope}`}${scope.touches.length === 0 ? "" : `\n  touches: ${scope.touches.join(", ")}`}`}`);
  };
  for await (const raw of linesOf(seams)) {
    const line = raw.trim();
    if (line === "") continue;
    now = clock();
    const act = /^(confirm|dismiss|open)\s+([0-9]{1,3})$/i.exec(line);
    if (act !== null) {
      const index = Number(act[2]) - 1;
      const proposal = pendingProposals()[index];
      if (proposal === undefined) {
        say(`no pending proposal ${act[2]}`);
        continue;
      }
      const verb = (act[1] as string).toLowerCase();
      if (verb === "open") {
        openTask(proposal);
      } else if (verb === "dismiss") {
        const done = dismissMateProposal(store, who, proposal.id, now);
        emit({ ok: done, act: "dismiss", proposal: proposal.id });
        say(done ? `dismissed ${act[2]}` : "that proposal was already acted on");
      } else {
        const outcome = confirmMateProposal(store, who, proposal.id, now);
        emit({ ok: outcome.ok, act: "confirm", proposal: proposal.id, ...(outcome.ok ? { said: outcome.said, taskId: outcome.taskId } : { reason: outcome.reason, said: outcome.said }) });
        say(outcome.ok ? outcome.said : `refused: ${outcome.said}`);
        if (outcome.ok && outcome.kind === "scope" && outcome.taskId !== null) say(`approve it with your password: standing-orders task approve ${outcome.taskId}`);
      }
      continue;
    }
    const word = line.toLowerCase();
    if (word === "proposals") {
      if (pendingProposals().length === 0) say("no proposals are pending");
      else printProposals();
      continue;
    }
    if (word === "quit" || word === "exit") break;
    if (word === "end") {
      store.failLiveMateTurnsFor(who.name, "ended", now);
      store.endMateSessionsFor(who.name, who.name, now);
      store.closeMateThreadsFor(who.name, now);
      say("the session is over and the thread is forgotten");
      emit({ ok: true, ended: true });
      return { code: MATE_CLI_EXIT.ok };
    }
    if (word === "help" || word === "?") {
      say("say something, or: proposals · confirm N · dismiss N · open N · end · quit");
      continue;
    }
    report(await turn(line));
  }
  return { code: MATE_CLI_EXIT.ok };
}
