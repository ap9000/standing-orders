/** A small, bounded read surface shared by desktop, web, and Telegram Chat.
 * The model requests a read; the server checks project access and reads it.
 * No shell, repository instructions, or ambient tools enter the model process. */
import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Store } from "./store.js";
import { reproveApprover, type VerifiedApprover } from "./principal.js";
import { run } from "./exec.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import { readVerifiedArtifact, redactSecretLines, scanForSecrets } from "./evidence.js";
import { readLiveWindow } from "./live.js";
import { executeMateTool, MATE_TOOL_SCHEMAS, mateView, mateViewContextFor, type MateToolContext } from "./mate-tools.js";

const SHARED = new Set(["recap", "list_repos", "list_tasks", "get_task", "list_decisions", "queue",
  "propose_task", "propose_next", "propose_hold", "propose_unhold"]);
export const CHAT_AGENT_TOOLS = [
  ...MATE_TOOL_SCHEMAS.filter(one => SHARED.has(one.name)),
  { name: "propose_pause", description: "Propose pausing a task. A running build receives a stop request and preserves its work; queued work is held. The operator must confirm the card. Use this when asked to pause/stop work now, rather than only future attempts.", inputSchema: { task: "task id", reason: "short reason" } },
  { name: "inspect_run", description: "Read a run's recorded facts and publication state, plus verified diff evidence or the captured activity log. kind is summary, diff, or log. Cite the returned source; missing evidence is not proof of success.", inputSchema: { run: "positive integer", kind: "summary | diff | log" } },
  { name: "read_file", description: "Read up to 160 lines of a tracked text file in an admitted project. This is the current checkout, which may differ from a run's accepted diff. Secret/configuration files are unavailable.", inputSchema: { repo: "r1", path: "relative tracked file", startLine: "positive integer, optional" } },
  { name: "search_history", description: "Find earlier messages in this operator's conversation, including previous days. Historical statements are not current project state. query is a literal phrase, up to 120 characters.", inputSchema: { query: "text" } },
];

export type InvestigationContext = MateToolContext & { sources: string[] };

function safeText(text: string): string {
  return redactSecretLines(text, scanForSecrets(text)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export async function investigate(ctx: InvestigationContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!reproveApprover(ctx.store, ctx.who).ok) return { ok: false, message: "Your project access changed." };
  const view = mateViewContextFor(ctx.store, ctx.who);
  const scrub = (value: unknown) => mateView(value, view);
  if (SHARED.has(name)) return executeMateTool(ctx, name, args, view);
  if (name === "propose_pause") {
    const task = typeof args["task"] === "string" ? args["task"] : "";
    const ref = ctx.store.lookupRef(task);
    const reason = typeof args["reason"] === "string" ? args["reason"] : "Paused at your request";
    if (ref?.repo == null || !ctx.who.repos.includes(ref.repo) || !ctx.store.getTask(task)) return { ok: false, message: "No such task in your projects." };
    if (!reason.trim() || reason.length > 200 || scanForSecrets(reason).length) return { ok: false, message: "Use a short reason without credentials." };
    const outcome = ctx.store.transact(() => {
      const live = ctx.store.runsFor(ref.id).find(one => one.outcome === null && one.role !== "repair" && one.leaseId === ctx.store.currentLiveLease(ref.id, ctx.now));
      const hold = ctx.store.activeHolds(ref.id, ctx.now).find(one => one.ownerKind === "operator");
      return ctx.draft("hold", { task, repoId: `r${ctx.who.repos.indexOf(ref.repo!) + 1}`, reason, sawHold: hold?.id ?? null,
        ...(live === undefined ? {} : { stopRun: live.id }) });
    });
    return scrub(outcome === null ? { ok: false, message: "This turn has enough proposals already." } : { ok: true, proposal: outcome, awaiting: "operator confirmation" });
  }
  if (name === "search_history") return scrub(searchChatHistory(ctx.store, ctx.who, args["query"], ctx.now));
  if (name === "inspect_run") {
    const runId = args["run"];
    const found = typeof runId === "number" && Number.isSafeInteger(runId) && runId > 0 ? ctx.store.getRun(runId) : null;
    const ref = found === null ? null : ctx.store.refById(found.taskRef);
    if (found === null || ref?.repo == null || !ctx.who.repos.includes(ref.repo)) return { ok: false, message: "No such run in your projects." };
    const kind = args["kind"] ?? "summary";
    if (!["summary", "diff", "log"].includes(String(kind))) return { ok: false, message: "Choose summary, diff, or log." };
    const publication = ctx.store.publicationForRun(found.id);
    const facts: Record<string, unknown> = {
      run: found.id, task: ref.externalId, project: `r${ctx.who.repos.indexOf(ref.repo) + 1}`,
      outcome: found.outcome, startedAt: found.startedAt, finishedAt: found.finishedAt,
      reason: safeText(found.reason ?? ""), handoff: safeText(found.handoff ?? "").slice(0, 4000),
      committedLocally: found.committed, publicationBlockedBySecretScan: ctx.store.hasRedactedTerminalDiff(found.id),
      publication: publication === null ? "No publication recorded by Standing Orders" : { state: publication.state, pullRequest: publication.prNumber },
    };
    let source = `Run #${found.id} · recorded run and publication state`;
    if (kind === "diff") {
      const artifact = ctx.store.artifactsFor(found.id).find(one => one.kind === "terminal-diff") ??
        ctx.store.artifactsFor(found.id).find(one => one.kind === "diff");
      const read = artifact == null || ctx.evidenceRoot === undefined ? null : readVerifiedArtifact(ctx.evidenceRoot, artifact);
      facts["diff"] = read?.ok ? { text: safeText(read.content.toString("utf8")).slice(0, 14_000),
        truncated: artifact!.truncated || read.content.length > 14_000, redacted: artifact!.redacted, capturedAt: artifact!.createdAt }
        : { unavailable: true, reason: read && !read.ok ? read.problem : "No captured diff is available here." };
      source = `Run #${found.id} · ${read?.ok ? "verified captured diff" : "diff unavailable"}`;
    } else if (kind === "log") {
      const read = ctx.evidenceRoot === undefined ? null : readLiveWindow(ctx.evidenceRoot, found.id, 0, found.outcome !== null);
      facts["activityLog"] = read?.ok ? { ...read, text: safeText(read.text).slice(0, 12_000), note: "Captured activity only; this is not a complete terminal transcript." }
        : { unavailable: true };
      source = `Run #${found.id} · ${read?.ok ? "captured activity log" : "activity log unavailable"}`;
    }
    const id = ctx.sources.push(source);
    return scrub({ ok: true, source: `E${id}`, ...facts });
  }
  if (name === "read_file") {
    const repoId = typeof args["repo"] === "string" && /^r[1-9][0-9]{0,2}$/.test(args["repo"]) ? args["repo"] : "";
    const repo = ctx.who.repos[Number(repoId.slice(1)) - 1];
    const path = args["path"];
    if (!repo || typeof path !== "string" || path.length > 240 || !path || path.split("/").some(p => !p || p === "." || p === ".." || p.startsWith(".")) ||
      /[\\\u0000-\u001f]|(?:^|\/)(?:credentials|secrets?|id_rsa|id_ed25519)(?:[./_-]|$)|\.(?:pem|key|p12|pfx|db|sqlite|env)$/i.test(path)) {
      return { ok: false, message: "Choose a tracked source or documentation file inside one of your projects." };
    }
    const start = args["startLine"] ?? 1;
    if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1 || start > 100_000) return { ok: false, message: "startLine must be a positive line number." };
    try {
      const tracked = await run("git", ["ls-files", "--error-unmatch", "--", path], { cwd: repo, timeoutMs: 5000, maxBuffer: 4096, omitEnv: ALL_CREDENTIAL_ENV });
      if (tracked.code !== 0 || !reproveApprover(ctx.store, ctx.who).ok) return { ok: false, message: "That tracked file is unavailable." };
      const root = realpathSync(repo), resolved = realpathSync(join(root, path));
      if (!resolved.startsWith(root + sep)) return { ok: false, message: "That file is outside the project." };
      const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 512_000) return { ok: false, message: "That file is too large to inspect in chat." };
        bytes = Buffer.alloc(stat.size); const length = readSync(fd, bytes, 0, bytes.length, 0); bytes = bytes.subarray(0, length);
      } finally { closeSync(fd); }
      if (bytes.includes(0)) return { ok: false, message: "That file is not plain text." };
      const lines = safeText(bytes.toString("utf8")).split("\n");
      const snippet = lines.slice(start - 1, start + 159).map((line, i) => `${start + i}: ${line}`).join("\n");
      const id = ctx.sources.push(`${repoId} · ${path}:${start} (current checkout)`);
      return scrub({ ok: true, source: `E${id}`, file: path, startLine: start, text: snippet.slice(0, 14_000),
        truncated: snippet.length > 14_000 || lines.length > start + 159, state: "Current checkout; not necessarily the version a run built." });
    } catch { return { ok: false, message: "The file could not be read." }; }
  }
  return { ok: false, message: "That capability is not available. Use one of the listed tools." };
}

export function searchChatHistory(store: Store, who: VerifiedApprover, query: unknown, now: Date): unknown {
  if (typeof query !== "string" || !query.trim() || query.length > 120 || scanForSecrets(query).length) return { ok: false, message: "Use a short search phrase without credentials." };
  const preference = store.raw().prepare("SELECT retention_days FROM chat_preferences WHERE approver = ?").get(who.name);
  const cutoff = new Date(now.getTime() - Number(preference?.["retention_days"] ?? 1) * 86_400_000).toISOString();
  const rows = store.raw().prepare(`SELECT m.role, m.text, m.created_at FROM mate_message m JOIN mate_thread t ON t.id = m.thread
    WHERE t.approver = ? AND t.ceiling_digest = ? AND t.closed_at IS NULL AND m.created_at >= ? AND instr(lower(m.text), lower(?)) > 0
    ORDER BY m.id DESC LIMIT 8`).all(who.name, who.ceilingDigest, cutoff, query.trim());
  return { ok: true, historical: true, messages: rows.map(row => ({ ...row, text: safeText(String(row["text"])).slice(0, 2000) })) };
}
