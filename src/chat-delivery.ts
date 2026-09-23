/** Shared saved replies, explicit confirmations and progress for private chat transports. */
import {
  channelRepos,
  resolveChannelMate,
  proposalPreview,
  proposalOutcomeText,
  confirmedLink,
  confirmedCardText,
  replyContextFor,
  mirrorToTaskChat,
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
  ChatState,
  ChatDeliveryError,
  chatHash,
  type ChatBinding,
  type ChatContent,
  type ChatEvent,
  type ChatIdentity,
} from "./chat-delivery-state.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { phoneText, PHONE_HELP, phoneCommand, phoneStatus, phoneTaskView } from "./telegram-status.js";
import { applyRoomInbound, conversationRow, roomCardApprover, roomCommand, roomGrantAllowed, roomMessagesAfter, roomMessageText, teamDomain } from "./chat-rooms.js";
import { isTelegramProgressNotification, type Store } from "./store.js";
import type { SubscriptionMateRunner } from "./subscription-chat.js";
export const chatObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const object = chatObject;
export type ChatDeliveryOptions = {
  store: Store;
  state: ChatState;
  label: string;
  identity: ChatIdentity;
  owner: string;
  member: (member: string, channel: string) => Promise<boolean>;
  readProjects: () => Promise<readonly string[]>;
  evidenceRoot: string;
  current: () => boolean;
  origin: () => string | null;
  subscriptionRunner?: SubscriptionMateRunner;
  held?: DoorOptions["held"];
  canNotify?: () => boolean;
  clock?: () => Date;
  partSize?: number;
  maxProposal?: number;
};
const nowOf = (options: ChatDeliveryOptions) => options.clock?.() ?? new Date();
export const splitChatText = (text: string, size = 2800): string[] => {
  const parts: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts.length ? parts : ["No reply was recorded."];
};

export async function channelAccess(
  options: ChatDeliveryOptions,
  binding: ChatBinding,
  ceiling?: string,
): Promise<string[]> {
  const state = options.state;
  if (
    !options.current() ||
    !state.owns(options.identity.installation, options.owner, nowOf(options)) ||
    !state.live(binding)
  )
    throw new ChatDeliveryError("Chat access changed");
  const repos = channelRepos(
    options.store,
    binding.approver,
    await options.readProjects(),
  );
  if (ceiling !== undefined && ceilingDigestOf(repos) !== ceiling)
    throw new ChatDeliveryError("Connected projects changed");
  if (!(await options.member(binding.member, binding.channel))) {
    state.revoke(options.identity.installation, nowOf(options));
    throw new ChatDeliveryError(`${options.label} account access changed`);
  }
  // The network wait above can outlive a local disconnect or lease.
  if (
    !options.current() ||
    !state.live(binding) ||
    !state.owns(options.identity.installation, options.owner, nowOf(options))
  )
    throw new ChatDeliveryError("Chat access changed");
  const latest = channelRepos(
    options.store,
    binding.approver,
    await options.readProjects(),
  );
  if (ceilingDigestOf(latest) !== ceilingDigestOf(repos))
    throw new ChatDeliveryError("Connected projects changed");
  if (
    !state.live(binding) ||
    !options.current() ||
    !state.owns(options.identity.installation, options.owner, nowOf(options))
  )
    throw new ChatDeliveryError("Chat access changed");
  return latest;
}

export async function processChatEvent(
  options: ChatDeliveryOptions,
): Promise<boolean> {
  const { store, identity } = options,
    state = options.state,
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
      if (!(await options.member(event.member, event.channel))) {
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
      state
        .prepare("UPDATE chat_event SET binding=? WHERE id=?")
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
    const binding = event.binding === null ? null : state.bindingById(event.binding);
    if (!binding) {
      state.finish(event.id, true);
      return true;
    }
    const repos = await channelAccess(options, binding);
    if (event.kind === "action") {
      applyChatAction(options, event, binding, repos);
      return true;
    }
    const input = object(JSON.parse(event.payload));
    if (typeof input.unsupported === "string") {
      state.plan(event.id, [{ text: input.unsupported }], nowOf(options));
      return true;
    }
    const text = String(input.text ?? "");
    // Read-only commands answer from the database, never from a model.
    const command = phoneCommand(text);
    if (command !== null) {
      const now_ = nowOf(options);
      if (command.kind === "help") state.plan(event.id, [{ text: PHONE_HELP }], now_);
      else if (command.kind === "status") state.plan(event.id, [{ text: phoneStatus(store, repos, now_) }], now_);
      else {
        const view = phoneTaskView(store, repos, command.id, now_);
        state.plan(event.id, [{ text: view.text, ...(view.link === null ? {} : { link: view.link }) }], now_);
      }
      return true;
    }
    // The team layer: `/team` anywhere, everything in a followed room, and a
    // DM that chose a conversation. Its replies are planned like any other.
    const room = state.room(identity.installation, event.channel);
    const isRoom = event.channel !== binding.channel;
    if (isRoom || room !== null || roomCommand(text) !== null) {
      const replies: ChatContent[] = [];
      const registry = await options.readProjects();
      const consumed = applyRoomInbound({
        store, channel: state.channel, backend: state.roomBackend(identity.installation, now), chatId: event.channel, isGroup: isRoom,
        sender: { approver: binding.approver, generation: binding.generation, binding: binding.id }, updateKey: event.id, text,
        projects: registry, origin: options.origin(), now, report: { ignored: 0 },
        say: (reply, link) => replies.push({ text: reply, ...(link ? { link } : {}), ...(isRoom ? { channel: event.channel } : {}) }),
      });
      if (consumed) {
        state.plan(event.id, replies, now);
        return true;
      }
    }
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
    const request = chatHash(
      `${options.state.channel}:${binding.id}:${event.id}`,
    ).slice(0, 32);
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
                .replaceAll("this phone", options.label)
                .replaceAll("the phone", options.label),
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
      state
        .prepare(
          "UPDATE chat_event SET session=? WHERE id=? AND state='queued'",
        )
        .run(resolved.session.id, event.id);
      const contexts = state
        .prepare(
          "SELECT p.payload FROM chat_part p JOIN chat_event e ON e.id=p.event WHERE e.binding=? AND e.channel=? AND (p.message=? OR e.thread=?) AND p.state='sent' ORDER BY p.id DESC LIMIT 100",
        )
        .all(binding.id, binding.channel, event.thread, event.thread)
        .map((row) => JSON.parse(String(row.payload)) as ChatContent);
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
            await channelAccess(options, binding, resolved.who.ceilingDigest);
            return { ok: true };
          } catch {
            return {
              ok: false,
              reason: `${options.label} access could not be verified`,
            };
          }
        },
      });
      if (outcome.ok && !outcome.replayed && context?.task)
        mirrorToTaskChat(store, resolved.who, context.task, options.label, text, outcome.reply, nowOf(options));
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
    await channelAccess(options, binding, session.ceilingDigest);
    const reply =
      store
        .listMateMessages(turn.thread, 200)
        .find(
          (message) => message.turn === turn.id && message.role === "assistant",
        )?.text ?? "The reply is no longer in the saved thread.";
    const parts: ChatContent[] = splitChatText(reply, options.partSize).map(
      (text) => ({ text }),
    );
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
      error instanceof ChatDeliveryError
        ? error
        : new ChatDeliveryError(`${options.label} is waiting to retry`);
    state
      .prepare(
        "UPDATE chat_runtime SET problem=? WHERE installation=? AND owner=?",
      )
      .run(problem.message, identity.installation, options.owner);
    state.defer(
      event.id,
      problem.message,
      new Date(nowOf(options).getTime() + problem.retryMs),
    );
    if (problem.code === "ratelimited")
      state
        .prepare("UPDATE chat_runtime SET retry_at=? WHERE installation=?")
        .run(
          new Date(nowOf(options).getTime() + problem.retryMs).toISOString(),
          identity.installation,
        );
    return true;
  }
}

/** Bound to the paired member, exact channel/message, pending proposal and current ceiling. */
export function applyChatAction(
  options: ChatDeliveryOptions,
  event: ChatEvent,
  binding: ChatBinding,
  repos: readonly string[],
): void {
  const state = options.state,
    { store } = options,
    now = nowOf(options),
    signals: Array<() => void> = [];
  store.transact(() => {
    if (
      !state.owns(options.identity.installation, options.owner, now) ||
      !options.current() ||
      !state.live(binding) ||
      event.member !== binding.member ||
      (event.channel !== binding.channel && state.room(options.identity.installation, event.channel)?.kind !== "group")
    )
      return;
    const token = String(object(JSON.parse(event.payload)).token);
    const action = state
      .prepare(
        "SELECT a.*,p.message,e.binding,e.channel,e.thread FROM chat_action a JOIN chat_part p ON p.id=a.part JOIN chat_event e ON e.id=p.event WHERE token=?",
      )
      .get(token);
    const invalid =
      !action ||
      action.binding !== binding.id ||
      action.channel !== event.channel ||
      action.message !== event.ts ||
      (options.state.channel === "slack" && action.thread !== event.thread) ||
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
    let content: ChatContent = {
      text: "",
      proposal: proposal.id,
      edit: event.ts,
    };
    const preview = proposalPreview(store, proposal, repos, options.state.channel);
    const phase = String(action.phase);
    if (proposal.state !== "pending")
      content = { text: proposalOutcomeText(proposal), edit: event.ts };
    else if (
      !preview.buttons ||
      preview.text.length > (options.maxProposal ?? 10_000)
    )
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
          via: options.state.channel,
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
    state
      .prepare(
        "UPDATE chat_part SET payload=?,state='pending',next_at=NULL WHERE id=?",
      )
      .run(JSON.stringify(content), Number(action.part));
    if (!content.proposal)
      state
        .prepare(
          "UPDATE chat_action SET consumed=? WHERE proposal=? AND consumed IS NULL",
        )
        .run(now.toISOString(), proposal.id);
    else
      state
        .prepare("UPDATE chat_action SET consumed=? WHERE token=?")
        .run(now.toISOString(), token);
    state.finish(event.id);
  });
  for (const signal of signals) signal();
}

/**
 * Carry new conversation messages to every room that follows one: the
 * lead's replies, teammates' messages (never the room's own), and each
 * reply's pending cards, as ordinary parts sent to the room's channel. A
 * room is a grant from one exact pairing and is rechecked before each
 * message; a room nobody paired can carry waits.
 */
export async function planRoomMessages(options: ChatDeliveryOptions): Promise<void> {
  const state = options.state, { store, identity } = options, now = nowOf(options);
  if (!state.owns(identity.installation, options.owner, now) || !options.current()) return;
  const rooms = state.rooms(identity.installation);
  if (rooms.length === 0) return;
  const registry = await options.readProjects();
  if (!state.owns(identity.installation, options.owner, nowOf(options)) || !options.current()) return;
  const domain = teamDomain(store, registry);
  const backend = state.roomBackend(identity.installation, now);
  const live = state.bindings(identity.installation).filter(one => state.live(one));
  for (const room of rooms) {
    const asRoom = { id: room.id, chatId: room.chat, kind: room.kind, conversation: room.conversation, boundBy: room.boundBy, binding: room.binding, cursor: room.cursor };
    if (!roomGrantAllowed(store, domain, backend, asRoom)) continue;
    const row = conversationRow(store, room.conversation);
    if (row === null) continue;
    for (const message of roomMessagesAfter(store, row.thread, room.cursor)) {
      const text = roomMessageText(message, state.channel, room.chat);
      let carrier: ChatBinding | null = null;
      if (room.kind === "private") carrier = live.find(one => one.channel === room.chat) ?? null;
      else {
        const approver = message.turn === null ? null : roomCardApprover(store, room.conversation, message.turn, live.map(one => one.approver));
        const preferred = approver === null ? undefined : live.find(one => one.approver === approver);
        carrier = preferred ?? live.find(one => one.id === room.binding) ?? null;
      }
      if (carrier === null) break;
      const parts: ChatContent[] = [];
      if (text !== null) parts.push({ text, channel: room.chat });
      if (message.role === "assistant" && message.turn !== null)
        for (const proposal of store.listMateProposals(row.thread, ["pending"]).filter(one => one.turn === message.turn)) parts.push({ text: "", proposal: proposal.id, channel: room.chat });
      const id = chatHash(`${state.channel}:room:${room.id}:${message.id}`);
      const target = carrier;
      store.transact(() => {
        if (parts.length > 0 && state.enqueue({ id, installation: identity.installation, binding: target.id, kind: "message", channel: room.chat, member: target.member, ts: "", thread: "", payload: "{}", created: now.toISOString() }))
          state.plan(id, parts, now);
        state.advanceRoomCursor(room.id, message.id);
      });
    }
  }
}

/** One progress card per exact result; separate urgent facts retain their own review link. */
export async function planChatNotifications(
  options: ChatDeliveryOptions,
): Promise<void> {
  const state = options.state,
    { store, identity } = options,
    bindings = state.bindings(identity.installation).filter(one => state.live(one));
  if (
    bindings.length === 0 ||
    !state.owns(identity.installation, options.owner, nowOf(options)) ||
    !options.current()
  )
    return;
  const registry = await options.readProjects();
  const cursor = Number(
    state
      .prepare("SELECT notification FROM chat_runtime WHERE installation=?")
      .get(identity.installation)?.notification ?? 0,
  );
  // Every paired person is a destination of their own, under their own ceiling.
  for (const notification of store.notificationsAfter(cursor, 100)) {
    for (const binding of bindings) {
    const repos = channelRepos(store, binding.approver, registry);
    store.transact(() => {
      if (
        notification.createdAt >= binding.created &&
        notification.resolvedAt === null &&
        notification.taskId &&
        notification.project &&
        repos.includes(notification.project)
      ) {
        const run = store.telegramProgressRun(notification);
        const id = chatHash(
            `${options.state.channel}:notice:${binding.id}:${notification.id}`,
          ),
          now = nowOf(options);
        if (run && isTelegramProgressNotification(notification)) {
          const card = telegramProgressCard(
            store,
            store.getRun(run.id)!,
            notification.taskId,
            notification.project,
            now,
            options.evidenceRoot,
          );
          const content: ChatContent = {
            text: card.text,
            task: notification.taskId,
            run: run.id,
            link: card.link,
          };
          const digest = chatHash(JSON.stringify(content));
          const prior = state
            .prepare(
              "SELECT part,digest FROM chat_progress WHERE binding=? AND run=?",
            )
            .get(binding.id, run.id);
          if (prior) {
            if (prior.digest !== digest) {
              state
                .prepare(
                  "UPDATE chat_part SET payload=?,state='pending',created=?,next_at=NULL WHERE id=? AND state!='dropped'",
                )
                .run(
                  JSON.stringify(content),
                  now.toISOString(),
                  Number(prior.part),
                );
              state
                .prepare(
                  "UPDATE chat_progress SET digest=? WHERE binding=? AND run=?",
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
            const part = state
              .prepare("SELECT id FROM chat_part WHERE event=?")
              .get(id)!;
            state
              .prepare("INSERT INTO chat_progress VALUES(?,?,?,?)")
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
    });
    }
    state
      .prepare("UPDATE chat_runtime SET notification=? WHERE installation=?")
      .run(notification.id, identity.installation);
  }
}
