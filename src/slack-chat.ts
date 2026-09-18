/** Slack is a transport for the same saved assistant and confirmation doors. */
import {
  channelRepos,
  resolveChannelMate,
  proposalPreview,
  proposalLink,
  proposalOutcomeText,
  confirmedLink,
  confirmedCardText,
  replyContextFor,
  tooLongText,
} from "./chat-channel.js";
import { MATE_MESSAGE_MAX_CHARS, runMateTurn } from "./mate.js";
import {
  confirmMateProposal,
  dismissMateProposal,
  type DoorOptions,
} from "./mate-doors.js";
import { ceilingDigestOf, verifyApproverStanding } from "./principal.js";
import {
  SlackState,
  slackHash,
  type SlackIdentity,
  type SlackBinding,
  type SlackEvent,
  type SlackPart,
  type SlackContent,
} from "./slack-state.js";
import {
  object,
  slackId,
  slackTs,
  slackMember,
  SlackError,
  uploadSlackBytes,
  type SlackApi,
} from "./slack-api.js";
import {
  resultImageFileName,
  safeResultImageCaption,
  verifyResultImage,
} from "./chat-evidence.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { phoneText } from "./telegram-status.js";
import { isTelegramProgressNotification, type Store } from "./store.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";

export type SlackChatOptions = {
  store: Store;
  identity: SlackIdentity;
  api: SlackApi;
  owner: string;
  readProjects: () => Promise<readonly string[]>;
  evidenceRoot: string;
  current: () => boolean;
  origin: () => string | null;
  subscriptionRunner?: SubscriptionMateRunner;
  held?: DoorOptions["held"];
  canNotify?: () => boolean;
  clock?: () => Date;
  upload?: typeof uploadSlackBytes;
};
const nowOf = (options: SlackChatOptions): Date =>
  options.clock?.() ?? new Date();
const split = (text: string, size = 2800): string[] => {
  const parts: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts.length ? parts : ["No reply was recorded."];
};

/** Synchronous receipt before ACK. Never stores response_url, raw tokens, or a pairing code. */
export function receiveSlack(
  state: SlackState,
  identity: SlackIdentity,
  type: string,
  raw: unknown,
  now: Date,
): boolean {
  const body = object(raw);
  if (body.api_app_id !== identity.app) return false;
  const team = type === "events_api" ? body.team_id : object(body.team).id;
  if (team !== identity.team || body.is_ext_shared_channel === true)
    return false;
  const event = type === "events_api" ? object(body.event) : body;
  if (
    type === "events_api" &&
    (event.type === "app_uninstalled" || event.type === "tokens_revoked")
  ) {
    state.revoke(identity.installation, now);
    return true;
  }
  if (type === "events_api" && event.type === "user_change") {
    const user = object(event.user),
      binding = state.binding(identity.installation);
    if (binding?.member === user.id && user.deleted === true)
      state.revoke(identity.installation, now);
    return true;
  }
  let member: unknown,
    channel: unknown,
    ts: unknown,
    thread: unknown,
    id: string,
    payload: Record<string, unknown>,
    kind: SlackEvent["kind"];
  if (type === "events_api" && event.type === "message") {
    if (
      event.subtype !== undefined ||
      event.bot_id !== undefined ||
      event.channel_type !== "im" ||
      typeof event.text !== "string"
    )
      return false;
    if (typeof body.event_id !== "string" || body.event_id.length > 120)
      return false;
    member = event.user;
    channel = event.channel;
    ts = event.ts;
    thread = event.thread_ts ?? event.ts;
    const match = /^pair ([a-f0-9]{32})$/.exec(event.text.trim());
    kind = match ? "pair" : "message";
    payload = match
      ? { hash: slackHash(match[1]!) }
      : {
          text: event.text.slice(0, MATE_MESSAGE_MAX_CHARS + 1),
          originalLength: event.text.length,
        };
    id = slackHash(`${identity.installation}:event:${body.event_id}`);
  } else if (type === "interactive" && body.type === "block_actions") {
    const actions = Array.isArray(body.actions) ? body.actions : [];
    if (actions.length !== 1) return false;
    const action = object(actions[0]),
      container = object(body.container);
    if (
      !/^standing_orders_(confirm|dismiss|yes|cancel)$/.test(
        String(action.action_id),
      ) ||
      typeof action.value !== "string" ||
      !/^[a-f0-9]{32}$/.test(action.value) ||
      !slackTs(action.action_ts) ||
      container.type !== "message"
    )
      return false;
    member = object(body.user).id;
    channel = container.channel_id;
    ts = container.message_ts;
    thread = object(body.message).thread_ts ?? ts;
    kind = "action";
    payload = { token: action.value };
    id = slackHash(
      `${identity.installation}:action:${member}:${ts}:${action.value}:${action.action_ts}`,
    );
  } else return false;
  if (
    !slackId(member, "UW") ||
    !slackId(channel, "D") ||
    !slackTs(ts) ||
    !slackTs(thread) ||
    member === identity.bot
  )
    return false;
  const binding = state.binding(identity.installation);
  if (
    kind !== "pair" &&
    (!binding ||
      !state.live(binding) ||
      binding.member !== member ||
      binding.channel !== channel)
  )
    return false;
  if (kind === "pair" && binding) return false;
  return state.enqueue({
    id,
    installation: identity.installation,
    binding: kind === "pair" ? null : binding!.id,
    kind,
    channel,
    member,
    ts,
    thread,
    payload: JSON.stringify(payload),
    created: now.toISOString(),
  });
}

async function access(
  options: SlackChatOptions,
  binding: SlackBinding,
  ceiling?: string,
): Promise<string[]> {
  const state = new SlackState(options.store);
  if (
    !options.current() ||
    !state.owns(options.identity.installation, options.owner, nowOf(options)) ||
    !state.live(binding)
  )
    throw new SlackError("Chat access changed");
  const repos = channelRepos(
    options.store,
    binding.approver,
    await options.readProjects(),
  );
  if (ceiling !== undefined && ceilingDigestOf(repos) !== ceiling)
    throw new SlackError("Connected projects changed");
  if (
    !(await slackMember(
      options.api,
      options.identity,
      binding.member,
      binding.channel,
    ))
  ) {
    state.revoke(options.identity.installation, nowOf(options));
    throw new SlackError("Slack account access changed");
  }
  // The network wait above can outlive a local disconnect or lease.
  if (
    !options.current() ||
    !state.live(binding) ||
    !state.owns(options.identity.installation, options.owner, nowOf(options))
  )
    throw new SlackError("Chat access changed");
  const latest = channelRepos(
    options.store,
    binding.approver,
    await options.readProjects(),
  );
  if (ceilingDigestOf(latest) !== ceilingDigestOf(repos))
    throw new SlackError("Connected projects changed");
  if (
    !state.live(binding) ||
    !options.current() ||
    !state.owns(options.identity.installation, options.owner, nowOf(options))
  )
    throw new SlackError("Chat access changed");
  return latest;
}

export async function processSlackEvent(
  options: SlackChatOptions,
): Promise<boolean> {
  const { store, identity } = options,
    state = new SlackState(store),
    now = nowOf(options);
  if (
    !state.owns(identity.installation, options.owner, now) ||
    !options.current()
  )
    return false;
  const event = state.next(identity.installation, now);
  if (!event) return false;
  try {
    if (event.kind === "pair") {
      if (
        !(await slackMember(options.api, identity, event.member, event.channel))
      ) {
        state.finish(event.id, true);
        return true;
      }
      if (
        !state.owns(identity.installation, options.owner, nowOf(options)) ||
        !options.current()
      )
        return false;
      const paired = state.pair(
        identity,
        String(object(JSON.parse(event.payload)).hash),
        event.member,
        event.channel,
        nowOf(options),
      );
      if (!paired) {
        state.finish(event.id, true);
        return true;
      }
      state.db
        .prepare("UPDATE slack_event SET binding=? WHERE id=?")
        .run(paired.id, event.id);
      state.plan(
        event.id,
        [
          {
            text: "Connected to Standing Orders. Ask about a project, review a result, or describe what you want done. I’ll show any proposed change before you confirm it.",
          },
        ],
        nowOf(options),
      );
      return true;
    }
    const binding = state.binding(identity.installation);
    if (!binding || binding.id !== event.binding) {
      state.finish(event.id, true);
      return true;
    }
    const repos = await access(options, binding);
    if (event.kind === "action") {
      applySlackAction(options, event, binding, repos);
      return true;
    }
    const text = String(object(JSON.parse(event.payload)).text ?? "");
    if (text.length > MATE_MESSAGE_MAX_CHARS) {
      state.plan(
        event.id,
        [
          {
            text: tooLongText(
              Number(object(JSON.parse(event.payload)).originalLength) ||
                text.length,
            ),
          },
        ],
        nowOf(options),
      );
      return true;
    }
    const request = slackHash(`slack:${binding.id}:${event.id}`).slice(0, 32);
    let receipt =
      event.session === null
        ? null
        : store.mateRequestReceipt(event.session, request);
    if (!receipt) {
      if (new Date(event.created).getTime() + 600_000 < now.getTime()) {
        state.plan(
          event.id,
          [
            {
              text: "This message waited too long to start. Send it again when you’re ready.",
            },
          ],
          now,
        );
        return true;
      }
      const resolved = resolveChannelMate(
        store,
        { approver: binding.approver, approverGeneration: binding.generation },
        repos,
        now,
      );
      if (!resolved.ok) {
        state.plan(
          event.id,
          [
            {
              text: (resolved.said ?? "This chat is no longer paired.")
                .replaceAll("this phone", "Slack")
                .replaceAll("the phone", "Slack"),
            },
          ],
          now,
        );
        return true;
      }
      if (event.session !== null && event.session !== resolved.session.id) {
        state.plan(
          event.id,
          [{ text: "Your chat session changed. Send your message again." }],
          now,
        );
        return true;
      }
      state.db
        .prepare(
          "UPDATE slack_event SET session=? WHERE id=? AND state='queued'",
        )
        .run(resolved.session.id, event.id);
      const contexts = state.db
        .prepare(
          "SELECT p.payload FROM slack_part p JOIN slack_event e ON e.id=p.event WHERE e.binding=? AND e.channel=? AND (p.message=? OR e.thread=?) AND p.state='sent' ORDER BY p.id DESC LIMIT 100",
        )
        .all(binding.id, binding.channel, event.thread, event.thread)
        .map((row) => JSON.parse(String(row.payload)) as SlackContent);
      const targets = [
        ...new Map(
          contexts
            .filter((c) => c.task)
            .map((c) => [`${c.task}:${c.run ?? ""}`, c]),
        ).values(),
      ];
      if (targets.length > 1) {
        state.plan(
          event.id,
          [
            {
              text: "This thread contains more than one result. Reply to the result’s own progress message, or start a new message naming the task and result number.",
            },
          ],
          nowOf(options),
        );
        return true;
      }
      const context = targets[0] ?? null;
      const outcome = await runMateTurn({
        store,
        who: resolved.who,
        session: resolved.session,
        thread: resolved.thread,
        config: resolved.config,
        key: null,
        message: text,
        requestId: request,
        ...(context?.task
          ? { context: replyContextFor(context.task, context.run ?? null) }
          : {}),
        ...(options.subscriptionRunner
          ? { subscriptionRunner: options.subscriptionRunner }
          : {}),
        clock: () => nowOf(options),
        evidenceRoot: options.evidenceRoot,
        mediaDelivery: "documents",
        revalidate: async () => {
          try {
            await access(options, binding, resolved.who.ceilingDigest);
            return { ok: true };
          } catch {
            return { ok: false, reason: "Slack access could not be verified" };
          }
        },
      });
      if (
        !state.owns(identity.installation, options.owner, nowOf(options)) ||
        !options.current()
      )
        return false;
      if (
        !outcome.ok &&
        "refused" in outcome &&
        outcome.refused === "concurrent"
      ) {
        state.defer(
          event.id,
          "Assistant is answering another message",
          new Date(nowOf(options).getTime() + 5000),
        );
        return true;
      }
      receipt = store.mateRequestReceipt(resolved.session.id, request);
      if (!receipt) {
        state.plan(
          event.id,
          [
            {
              text: !outcome.ok
                ? phoneText(outcome.message, 1000)
                : "The assistant did not save a reply. Send your message again.",
            },
          ],
          nowOf(options),
        );
        return true;
      }
    }
    store.sweepStaleMateTurns(nowOf(options));
    const turn = store.getMateTurn(receipt.turn);
    if (turn?.state === "running" || turn?.state === "queued") {
      state.defer(
        event.id,
        "Reply is still running",
        new Date(nowOf(options).getTime() + 5000),
      );
      return true;
    }
    if (turn?.state !== "answered") {
      state.plan(
        event.id,
        [
          {
            text: "The assistant’s reply did not finish. No proposed changes were kept. Send your message again to retry.",
          },
        ],
        nowOf(options),
      );
      return true;
    }
    const session = store.getMateSession(turn.session);
    if (!session) {
      state.finish(event.id, true);
      return true;
    }
    await access(options, binding, session.ceilingDigest);
    const reply =
      store
        .listMateMessages(turn.thread, 200)
        .find(
          (message) => message.turn === turn.id && message.role === "assistant",
        )?.text ?? "The reply is no longer in the saved thread.";
    const parts: SlackContent[] = split(reply).map((text) => ({ text }));
    for (const image of store.listMateTurnEvidence(turn.id))
      parts.push({
        text: image.caption,
        image: {
          taskId: image.taskId,
          run: image.run,
          artifact: image.artifact,
          sha256: image.sha256,
        },
        task: image.taskId,
        run: image.run,
      });
    for (const proposal of store
      .listMateProposals(turn.thread, ["pending"])
      .filter((p) => p.turn === turn.id))
      parts.push({ text: "", proposal: proposal.id });
    state.plan(event.id, parts, nowOf(options));
    return true;
  } catch (error) {
    const problem =
      error instanceof SlackError
        ? error
        : new SlackError("Slack is waiting to retry");
    state.db
      .prepare(
        "UPDATE slack_runtime SET problem=? WHERE installation=? AND owner=?",
      )
      .run(problem.message, identity.installation, options.owner);
    state.defer(
      event.id,
      problem.message,
      new Date(nowOf(options).getTime() + problem.retryMs),
    );
    if (problem.code === "ratelimited")
      state.db
        .prepare("UPDATE slack_runtime SET retry_at=? WHERE installation=?")
        .run(
          new Date(nowOf(options).getTime() + problem.retryMs).toISOString(),
          identity.installation,
        );
    return true;
  }
}

/** Bound to the paired member, exact channel/message, pending proposal and current ceiling. */
export function applySlackAction(
  options: SlackChatOptions,
  event: SlackEvent,
  binding: SlackBinding,
  repos: readonly string[],
): void {
  const state = new SlackState(options.store),
    { store } = options,
    now = nowOf(options),
    signals: Array<() => void> = [];
  store.transact(() => {
    if (
      !state.owns(options.identity.installation, options.owner, now) ||
      !options.current() ||
      !state.live(binding) ||
      event.member !== binding.member ||
      event.channel !== binding.channel
    )
      return;
    const token = String(object(JSON.parse(event.payload)).token);
    const action = state.db
      .prepare(
        "SELECT a.*,p.message,e.binding,e.channel,e.thread FROM slack_action a JOIN slack_part p ON p.id=a.part JOIN slack_event e ON e.id=p.event WHERE token=?",
      )
      .get(token);
    const invalid =
      !action ||
      action.binding !== binding.id ||
      action.channel !== event.channel ||
      action.message !== event.ts ||
      action.thread !== event.thread ||
      action.consumed !== null ||
      String(action.expires) <= now.toISOString();
    if (invalid) {
      state.plan(
        event.id,
        [
          {
            text: "That button expired or was already used. Ask for the current state before trying again.",
          },
        ],
        now,
      );
      return;
    }
    const proposal = store.getMateProposal(Number(action.proposal));
    const verified = verifyApproverStanding(
      store,
      binding.approver,
      binding.generation,
      repos,
    );
    if (!proposal || !verified.ok) {
      state.finish(event.id, true);
      return;
    }
    let content: SlackContent = {
      text: "",
      proposal: proposal.id,
      edit: event.ts,
    };
    const preview = proposalPreview(store, proposal, repos);
    const phase = String(action.phase);
    if (proposal.state !== "pending")
      content = { text: proposalOutcomeText(proposal), edit: event.ts };
    else if (!preview.buttons || preview.text.length > 10_000)
      content = { ...content, text: "Review this action in Standing Orders." };
    else if (phase === "cancel") {
      state.tokens(
        Number(action.part),
        proposal.id,
        ["confirm", "dismiss"],
        now,
      );
    } else if (phase === "dismiss") {
      const dismissed = dismissMateProposal(
        store,
        verified.who,
        proposal.id,
        now,
      );
      content = {
        text: dismissed
          ? "Dismissed."
          : "This proposal could not be dismissed. Ask for its current state.",
        edit: event.ts,
      };
    } else if (
      phase === "confirm" &&
      proposal.kind === "answer" &&
      proposal.payload.reversible === false
    ) {
      content = { ...content, phase: "armed" };
      state.tokens(Number(action.part), proposal.id, ["yes", "cancel"], now);
    } else {
      const outcome = confirmMateProposal(
        store,
        verified.who,
        proposal.id,
        now,
        {
          via: "slack",
          evidenceRoot: options.evidenceRoot,
          confirm: phase === "yes",
          ...(options.held ? { held: options.held } : {}),
          deferSignal: (signal) => signals.push(signal),
        },
      );
      if (!outcome.ok && outcome.reason === "needs-confirm") {
        content = { ...content, phase: "armed" };
        state.tokens(Number(action.part), proposal.id, ["yes", "cancel"], now);
      } else {
        content = {
          text: confirmedCardText(store, outcome, proposal, null),
          edit: event.ts,
          ...(outcome.ok && outcome.taskId ? { task: outcome.taskId } : {}),
        };
        const link = confirmedLink(store, outcome, proposal, repos);
        if (link) content.link = link;
      }
    }
    // Repaint the original persisted card; retain one placement and fresh tokens.
    state.db
      .prepare(
        "UPDATE slack_part SET payload=?,state='pending',next_at=NULL WHERE id=?",
      )
      .run(JSON.stringify(content), Number(action.part));
    if (!content.proposal)
      state.db
        .prepare(
          "UPDATE slack_action SET consumed=? WHERE proposal=? AND consumed IS NULL",
        )
        .run(now.toISOString(), proposal.id);
    else
      state.db
        .prepare("UPDATE slack_action SET consumed=? WHERE token=?")
        .run(now.toISOString(), token);
    state.finish(event.id);
  });
  for (const signal of signals) signal();
}

export function slackBlocks(
  text: string,
  buttons: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  const lines = text.split("\n"),
    title = lines[0] ?? "Standing Orders";
  const blocks: Record<string, unknown>[] = [];
  if (title.length <= 150 && lines.length > 1) {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: title, emoji: true },
    });
    text = lines.slice(1).join("\n").trim();
  }
  for (const part of split(text))
    blocks.push({
      type: "section",
      text: { type: "plain_text", text: part, emoji: true },
    });
  if (buttons.length) blocks.push({ type: "actions", elements: buttons });
  return blocks;
}
function linkButton(
  origin: string | null,
  link: SlackContent["link"],
): Record<string, unknown>[] {
  if (
    !origin ||
    !link ||
    !link.path.startsWith("/") ||
    link.path.startsWith("//")
  )
    return [];
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return [];
    return [
      {
        type: "button",
        text: { type: "plain_text", text: link.label },
        url: `${url.origin}${link.path}`,
        action_id: "standing_orders_link",
      },
    ];
  } catch {
    return [];
  }
}

export async function deliverSlackPart(
  options: SlackChatOptions,
): Promise<boolean> {
  const state = new SlackState(options.store),
    { store, identity } = options,
    now = nowOf(options);
  if (
    !state.owns(identity.installation, options.owner, now) ||
    !options.current()
  )
    return false;
  const row = state.db
    .prepare(
      "SELECT p.* FROM slack_part p JOIN slack_event e ON e.id=p.event WHERE e.installation=? AND p.state='pending' AND (e.kind!='notice' OR ?=1) AND (p.next_at IS NULL OR p.next_at<=?) ORDER BY p.id LIMIT 1",
    )
    .get(
      identity.installation,
      options.canNotify?.() === false ? 0 : 1,
      now.toISOString(),
    ) as SlackPart | undefined;
  if (!row) return false;
  const event = state.event(row.event)!,
    binding = state.binding(identity.installation);
  if (!binding || binding.id !== event.binding) {
    state.db
      .prepare(
        "UPDATE slack_part SET state='dropped',problem='Chat access changed' WHERE id=?",
      )
      .run(row.id);
    return true;
  }
  if (new Date(row.created).getTime() + 86_400_000 < now.getTime()) {
    state.db
      .prepare(
        "UPDATE slack_part SET state='dropped',problem='Delivery expired; open the saved chat to recover it' WHERE id=?",
      )
      .run(row.id);
    return true;
  }
  try {
    const session =
      event.session === null ? null : store.getMateSession(event.session);
    const repos = await access(options, binding, session?.ceilingDigest);
    if (event.kind === "notice" && options.canNotify?.() === false)
      return false;
    const content = JSON.parse(row.payload) as SlackContent;
    let text = content.text,
      buttons: Record<string, unknown>[] = [];
    if (
      content.task &&
      !repos.includes(store.lookupRef(content.task)?.repo ?? "")
    )
      throw new SlackError("Connected projects changed");
    if (content.image) {
      const verified = verifyResultImage(
        store,
        options.evidenceRoot,
        repos,
        content.image,
      );
      if (!verified.ok) {
        text = `Screenshot not sent\n${verified.problem}. Open the saved result to review it.`;
      } else {
        let file = row.file;
        if (!row.uploaded) {
          const allocated = await options.api("files.getUploadURLExternal", {
            filename: resultImageFileName(
              content.image.taskId,
              content.image.run,
              content.image.artifact,
              verified.format,
            ),
            length: verified.bytes.length,
          });
          if (
            !slackId(allocated.file_id, "F") ||
            typeof allocated.upload_url !== "string"
          )
            throw new SlackError("Slack did not identify the upload");
          file = allocated.file_id;
          state.db
            .prepare("UPDATE slack_part SET file=? WHERE id=?")
            .run(file, row.id);
          await access(options, binding, session?.ceilingDigest);
          const fresh = verifyResultImage(
            store,
            options.evidenceRoot,
            repos,
            content.image,
          );
          if (!fresh.ok)
            throw new SlackError("Screenshot evidence changed before upload");
          await (options.upload ?? uploadSlackBytes)(
            allocated.upload_url,
            fresh.bytes,
          );
          state.db
            .prepare("UPDATE slack_part SET uploaded=1 WHERE id=?")
            .run(row.id);
        }
        await access(options, binding, session?.ceilingDigest);
        if (
          !verifyResultImage(store, options.evidenceRoot, repos, content.image)
            .ok
        )
          throw new SlackError("Screenshot evidence changed before sharing");
        // A lost completion response is reconciled against Slack's file receipt.
        if (row.uncertain && file) {
          const remote = object(
              (await options.api("files.info", { file })).file,
            ),
            shares = object(object(remote.shares).private);
          const receipts = Array.isArray(shares[binding.channel])
            ? (shares[binding.channel] as unknown[])
            : [];
          const found = receipts
            .map(object)
            .find(
              (receipt) =>
                receipt.thread_ts === event.thread && slackTs(receipt.ts),
            );
          if (found) {
            state.db
              .prepare(
                "UPDATE slack_part SET state='sent',message=?,problem=NULL WHERE id=?",
              )
              .run(String(found.ts), row.id);
            return true;
          }
        }
        const completed = await options.api("files.completeUploadExternal", {
          files: [
            {
              id: file,
              title: safeResultImageCaption(
                content.text,
                content.image.taskId,
                content.image.run,
              ),
            },
          ],
          channel_id: binding.channel,
          thread_ts: event.thread,
          initial_comment: safeResultImageCaption(
            content.text,
            content.image.taskId,
            content.image.run,
          ),
        });
        if (
          !Array.isArray(completed.files) ||
          !completed.files.some((value) => object(value).id === file)
        )
          throw new SlackError(
            "Slack did not confirm the file identity",
            15_000,
            true,
          );
        state.db
          .prepare("UPDATE slack_part SET state='sent',problem=NULL WHERE id=?")
          .run(row.id);
        return true;
      }
    }
    if (content.proposal) {
      const proposal = store.getMateProposal(content.proposal);
      if (!proposal) text = "This proposal is unavailable.";
      else if (proposal.state !== "pending")
        text = proposalOutcomeText(proposal);
      else {
        const preview = proposalPreview(store, proposal, repos);
        text =
          content.phase === "armed"
            ? `⚠️ Irreversible choice\n${preview.text.split("\n\nConfirm or Dismiss below")[0]}\n\nConfirm this answer?`
            : preview.text.replace(
                "\n\nConfirm or Dismiss below. Nothing changes until you confirm.",
                "",
              );
        if (preview.buttons && preview.text.length <= 10_000) {
          const tokens = state.db
            .prepare(
              "SELECT token,phase FROM slack_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid",
            )
            .all(row.id, now.toISOString());
          buttons = tokens.map((action) => ({
            type: "button",
            text: {
              type: "plain_text",
              text:
                action.phase === "yes"
                  ? "Yes, answer"
                  : action.phase === "cancel"
                    ? "Cancel"
                    : action.phase === "dismiss"
                      ? "Dismiss"
                      : "Confirm",
            },
            action_id: `standing_orders_${action.phase}`,
            value: String(action.token),
            ...(action.phase === "confirm"
              ? { style: "primary" }
              : action.phase === "yes"
                ? { style: "danger" }
                : {}),
          }));
          if (!buttons.length)
            text = "This confirmation expired. Ask for a fresh proposal.";
        } else {
          const link = proposalLink(store, proposal, repos) ?? {
            label: "Review action",
            path: `/chat`,
          };
          buttons = linkButton(options.origin(), link);
          if (!buttons.length)
            text +=
              "\n\nOpen Standing Orders on your computer to review this action.";
          if (text.length > 10_000)
            text =
              "Review the full action in Standing Orders before confirming.";
        }
      }
    } else buttons = linkButton(options.origin(), content.link);
    const target = content.edit ?? row.message;
    const args = {
      channel: binding.channel,
      text: text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
      blocks: slackBlocks(text, buttons),
      mrkdwn: false,
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    };
    const answer = target
      ? await options.api("chat.update", { ...args, ts: target })
      : await options.api("chat.postMessage", {
          ...args,
          thread_ts:
            event.kind === "notice" && event.thread === ""
              ? undefined
              : event.thread,
        });
    if (!slackTs(answer.ts) || (target && answer.ts !== target))
      throw new SlackError(
        "Slack did not confirm the message identity",
        15_000,
        true,
      );
    state.db
      .prepare(
        "UPDATE slack_part SET state='sent',message=?,attempts=attempts+1,problem=NULL,next_at=NULL WHERE id=?",
      )
      .run(answer.ts, row.id);
    state.db
      .prepare(
        "UPDATE slack_runtime SET problem=NULL WHERE installation=? AND owner=?",
      )
      .run(identity.installation, options.owner);
    return true;
  } catch (error) {
    const problem =
      error instanceof SlackError
        ? error
        : new SlackError("Slack delivery is waiting to retry", 15_000, true);
    state.db
      .prepare(
        "UPDATE slack_runtime SET problem=? WHERE installation=? AND owner=?",
      )
      .run(problem.message, identity.installation, options.owner);
    const until = new Date(
      nowOf(options).getTime() +
        Math.max(
          problem.retryMs,
          [5000, 15000, 60000, 300000][Math.min(row.attempts, 3)]!,
        ),
    ).toISOString();
    state.db
      .prepare(
        "UPDATE slack_part SET attempts=attempts+1,uncertain=uncertain+?,next_at=?,problem=? WHERE id=?",
      )
      .run(problem.uncertain ? 1 : 0, until, problem.message, row.id);
    if (problem.code === "ratelimited")
      state.db
        .prepare("UPDATE slack_runtime SET retry_at=? WHERE installation=?")
        .run(until, identity.installation);
    return true;
  }
}

/** One progress card per exact result; separate urgent facts retain their own review link. */
export async function planSlackNotifications(
  options: SlackChatOptions,
): Promise<void> {
  const state = new SlackState(options.store),
    { store, identity } = options,
    binding = state.binding(identity.installation);
  if (
    !binding ||
    !state.live(binding) ||
    !state.owns(identity.installation, options.owner, nowOf(options)) ||
    !options.current()
  )
    return;
  const repos = channelRepos(
    store,
    binding.approver,
    await options.readProjects(),
  );
  const cursor = Number(
    state.db
      .prepare("SELECT notification FROM slack_runtime WHERE installation=?")
      .get(identity.installation)?.notification ?? 0,
  );
  for (const notification of store.notificationsAfter(cursor, 100)) {
    store.transact(() => {
      if (
        notification.createdAt >= binding.created &&
        notification.resolvedAt === null &&
        notification.taskId &&
        notification.project &&
        repos.includes(notification.project)
      ) {
        const run = store.telegramProgressRun(notification);
        const id = slackHash(`slack:notice:${binding.id}:${notification.id}`),
          now = nowOf(options);
        if (run && isTelegramProgressNotification(notification)) {
          const card = telegramProgressCard(
            store,
            store.getRun(run.id)!,
            notification.taskId,
            notification.project,
            now,
          );
          const content: SlackContent = {
            text: card.text,
            task: notification.taskId,
            run: run.id,
            link: card.link,
          };
          const digest = slackHash(JSON.stringify(content));
          const prior = state.db
            .prepare(
              "SELECT part,digest FROM slack_progress WHERE binding=? AND run=?",
            )
            .get(binding.id, run.id);
          if (prior) {
            if (prior.digest !== digest) {
              state.db
                .prepare(
                  "UPDATE slack_part SET payload=?,state='pending',created=?,next_at=NULL WHERE id=? AND state!='dropped'",
                )
                .run(
                  JSON.stringify(content),
                  now.toISOString(),
                  Number(prior.part),
                );
              state.db
                .prepare(
                  "UPDATE slack_progress SET digest=? WHERE binding=? AND run=?",
                )
                .run(digest, binding.id, run.id);
            }
          } else {
            state.enqueue({
              id,
              installation: identity.installation,
              binding: binding.id,
              kind: "notice",
              channel: binding.channel,
              member: binding.member,
              ts: "",
              thread: "",
              payload: "{}",
              created: now.toISOString(),
            });
            state.plan(id, [content], now);
            const part = state.db
              .prepare("SELECT id FROM slack_part WHERE event=?")
              .get(id)!;
            state.db
              .prepare("INSERT INTO slack_progress VALUES(?,?,?,?)")
              .run(binding.id, run.id, Number(part.id), digest);
          }
        } else if (notification.pushClass !== null) {
          state.enqueue({
            id,
            installation: identity.installation,
            binding: binding.id,
            kind: "notice",
            channel: binding.channel,
            member: binding.member,
            ts: "",
            thread: "",
            payload: "{}",
            created: now.toISOString(),
          });
          state.plan(
            id,
            [
              {
                text: phoneText(
                  `${notification.subject}\n\n${notification.body}`,
                  2500,
                ),
                task: notification.taskId,
                ...(run ? { run: run.id } : {}),
                ...(notification.link
                  ? { link: { label: "Review", path: notification.link } }
                  : {}),
              },
            ],
            now,
          );
        }
      }
      state.db
        .prepare("UPDATE slack_runtime SET notification=? WHERE installation=?")
        .run(notification.id, identity.installation);
    });
  }
}
