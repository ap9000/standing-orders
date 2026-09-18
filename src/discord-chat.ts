/** Discord messages and buttons transport the shared assistant's saved actions. */
import {
  ChatState,
  ChatDeliveryError,
  chatHash,
  type ChatIdentity,
  type ChatContent,
  type ChatPart,
} from "./chat-delivery-state.js";
import {
  processChatEvent,
  planChatNotifications,
  channelAccess,
  chatObject as object,
  type ChatDeliveryOptions,
} from "./chat-delivery.js";
import { chatResultHref } from "./chat-controls.js";
import { MATE_MESSAGE_MAX_CHARS } from "./mate.js";
import {
  proposalPreview,
  proposalLink,
  proposalOutcomeText,
} from "./chat-channel.js";
import {
  resultImageFileName,
  safeResultImageCaption,
  verifyResultImage,
} from "./chat-evidence.js";
import {
  discordId,
  discordMember,
  DiscordError,
  type DiscordApi,
} from "./discord-api.js";
export type DiscordChatOptions = Omit<
  ChatDeliveryOptions,
  "state" | "label" | "member" | "partSize" | "maxProposal"
> & { api: DiscordApi };
export const discordDelivery = (
  options: DiscordChatOptions,
): ChatDeliveryOptions => ({
  ...options,
  state: new ChatState(options.store, "discord"),
  label: "Discord",
  member: (member, channel) => discordMember(options.api, member, channel),
  partSize: 1800,
  maxProposal: 3400,
});
export const processDiscordEvent = (options: DiscordChatOptions) =>
  processChatEvent(discordDelivery(options));
export const planDiscordNotifications = (options: DiscordChatOptions) =>
  planChatNotifications(discordDelivery(options));
/** Save only normalized input. Interaction credentials and pairing codes never enter SQLite. */
export function receiveDiscord(
  state: ChatState,
  identity: ChatIdentity,
  type: string,
  raw: unknown,
  now: Date,
): boolean {
  const body = object(raw);
  if (body.guild_id !== undefined || body.webhook_id !== undefined)
    return false;
  let member: unknown,
    channel: unknown,
    id: unknown,
    ts: unknown,
    thread: unknown,
    kind: "message" | "pair" | "action",
    payload: Record<string, unknown>;
  if (type === "MESSAGE_CREATE") {
    const author = object(body.author),
      ref = object(body.message_reference);
    if (
      author.bot === true ||
      author.system === true ||
      ![0, 19].includes(Number(body.type)) ||
      typeof body.content !== "string" ||
      ref.guild_id !== undefined
    )
      return false;
    member = author.id;
    channel = body.channel_id;
    id = body.id;
    ts = body.id;
    thread = ref.message_id ?? body.id;
    if (ref.channel_id !== undefined && ref.channel_id !== channel)
      return false;
    const pair = /^pair ([a-f0-9]{32})$/.exec(body.content.trim());
    kind = pair ? "pair" : "message";
    payload = pair
      ? { hash: chatHash(pair[1]!) }
      : {
          text: body.content.slice(0, MATE_MESSAGE_MAX_CHARS + 1),
          originalLength: body.content.length,
          ...(Array.isArray(body.attachments) && body.attachments.length
            ? {
                unsupported:
                  "Incoming files are not supported yet. Describe the request in a message; saved result screenshots can still be sent here.",
              }
            : {}),
        };
  } else if (type === "INTERACTION_CREATE") {
    const data = object(body.data),
      message = object(body.message);
    if (
      body.type !== 3 ||
      body.application_id !== identity.app ||
      object(body.channel).type !== 1 ||
      object(message.author).id !== identity.bot ||
      message.channel_id !== body.channel_id ||
      !/^so_[a-f0-9]{32}$/.test(String(data.custom_id))
    )
      return false;
    member = object(body.user).id;
    channel = body.channel_id;
    id = body.id;
    ts = message.id;
    thread = message.id;
    kind = "action";
    payload = { token: String(data.custom_id).slice(3) };
  } else return false;
  if (
    !discordId(member) ||
    !discordId(channel) ||
    !discordId(id) ||
    !discordId(ts) ||
    !discordId(thread) ||
    member === identity.bot
  )
    return false;
  const binding = state.binding(identity.installation);
  if (
    kind === "pair"
      ? !!binding
      : !binding ||
        !state.live(binding) ||
        binding.member !== member ||
        binding.channel !== channel
  )
    return false;
  return state.enqueue({
    id: chatHash(
      `${identity.installation}:${kind === "action" ? "interaction" : "message"}:${id}`,
    ),
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
function link(
  origin: string | null,
  target: ChatContent["link"],
): Record<string, unknown>[] {
  if (
    !origin ||
    !target ||
    !target.path.startsWith("/") ||
    target.path.startsWith("//")
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
        type: 2,
        style: 5,
        label: target.label.slice(0, 80),
        url: url.origin + target.path,
      },
    ];
  } catch {
    return [];
  }
}
/** Escape Discord's presentation syntax; allowed_mentions also prevents actual pings. */
export const discordPlain = (text: string): string =>
  text.replace(/([\\`*_~|>#\[\]])/g, "\\$1").replace(/@/g, "@\u200b");
export function discordCard(
  text: string,
  buttons: Record<string, unknown>[] = [],
): Record<string, unknown> {
  const lines = text.split("\n"),
    first = lines[0] ?? "Standing Orders",
    title =
      discordPlain(first).length <= 256 &&
      first.length <= 150 &&
      lines.length > 1
        ? first
        : "Standing Orders",
    detail = title === first ? lines.slice(1).join("\n").trim() : text;
  // Long answers were split before this point; approval controls only appear when full terms fit.
  return {
    content: "",
    embeds: [
      {
        title: discordPlain(title),
        description: discordPlain(detail || title).slice(0, 4096),
        color: 0x297b70,
      },
    ],
    components: buttons.length ? [{ type: 1, components: buttons }] : [],
    allowed_mentions: { parse: [], replied_user: false },
  };
}
export async function deliverDiscordPart(
  options: DiscordChatOptions,
): Promise<boolean> {
  const shared = discordDelivery(options),
    state = shared.state,
    { store, identity } = options,
    now = options.clock?.() ?? new Date();
  if (
    !options.current() ||
    !state.owns(identity.installation, options.owner, now)
  )
    return false;
  const row = state
    .prepare(
      "SELECT p.* FROM chat_part p JOIN chat_event e ON e.id=p.event WHERE e.installation=? AND p.state='pending' AND (e.kind!='notice' OR ?=1) AND (p.next_at IS NULL OR p.next_at<=?) ORDER BY p.id LIMIT 1",
    )
    .get(
      identity.installation,
      options.canNotify?.() === false ? 0 : 1,
      now.toISOString(),
    ) as ChatPart | undefined;
  if (!row) return false;
  const event = state.event(row.event)!,
    binding = state.binding(identity.installation);
  if (
    !binding ||
    binding.id !== event.binding ||
    new Date(row.created).getTime() + 86_400_000 < now.getTime()
  ) {
    state
      .prepare(
        "UPDATE chat_part SET state='dropped',problem='Delivery expired or access changed; open the saved chat' WHERE id=?",
      )
      .run(row.id);
    return true;
  }
  try {
    const session =
        event.session === null ? null : store.getMateSession(event.session),
      repos = await channelAccess(shared, binding, session?.ceilingDigest);
    if (event.kind === "notice" && options.canNotify?.() === false)
      return false;
    const content = JSON.parse(row.payload) as ChatContent;
    if (
      content.task &&
      !repos.includes(store.lookupRef(content.task)?.repo ?? "")
    )
      throw new DiscordError("Connected projects changed");
    let text = content.text,
      buttons: Record<string, unknown>[] = [],
      file: { bytes: Uint8Array; name: string } | undefined;
    if (content.image) {
      const image = verifyResultImage(
        store,
        options.evidenceRoot,
        repos,
        content.image,
      );
      if (!image.ok)
        text = `Screenshot not sent\n${image.problem}. Open the saved result to review it.`;
      else if (image.bytes.length > 10 * 1024 * 1024)
        text =
          "Screenshot exceeds Discord’s upload limit. Open the saved result to review it.";
      else {
        file = {
          bytes: image.bytes,
          name: resultImageFileName(
            content.image.taskId,
            content.image.run,
            content.image.artifact,
            image.format,
          ),
        };
        text = safeResultImageCaption(
          content.text,
          content.image.taskId,
          content.image.run,
        );
      }
      buttons = link(options.origin(), {
        label: "Review result",
        path: chatResultHref(content.image.taskId, content.image.run, "checks"),
      });
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
            ? `⚠ Irreversible choice\n${preview.text.split("\n\nConfirm or Dismiss below")[0]}\n\nConfirm this answer?`
            : preview.text.replace(
                "\n\nConfirm or Dismiss below. Nothing changes until you confirm.",
                "",
              );
        if (
          preview.buttons &&
          preview.text.length <= 3400 &&
          discordPlain(text).length <= 3900
        ) {
          buttons = state
            .prepare(
              "SELECT token,phase FROM chat_action WHERE part=? AND consumed IS NULL AND expires>? ORDER BY rowid",
            )
            .all(row.id, now.toISOString())
            .map((action) => ({
              type: 2,
              style:
                action.phase === "yes" ? 4 : action.phase === "confirm" ? 1 : 2,
              label:
                action.phase === "yes"
                  ? "Yes, answer"
                  : action.phase === "cancel"
                    ? "Cancel"
                    : action.phase === "dismiss"
                      ? "Dismiss"
                      : "Confirm",
              custom_id: `so_${action.token}`,
            }));
          if (!buttons.length)
            text = "This confirmation expired. Ask for a fresh proposal.";
        } else {
          buttons = link(
            options.origin(),
            proposalLink(store, proposal, repos) ?? {
              label: "Review action",
              path: "/chat",
            },
          );
          text = "Review the full action in Standing Orders before confirming.";
          if (!buttons.length)
            text += " Open Standing Orders on your computer.";
        }
      }
    } else if (!content.image) buttons = link(options.origin(), content.link);
    let target = content.edit ?? row.message;
    if (target && content.image && row.uploaded) {
      if (!file)
        text =
          "Screenshot delivered earlier. The saved evidence has since changed; open the result to review its current state.";
      file = undefined;
    }
    const nonce = chatHash(`discord:part:${row.id}:${event.id}`).slice(0, 24);
    // Recent Discord nonce receipts reconcile uncertain sends, including attachments.
    if (row.uncertain && !target) {
      const recent = await options.api(
        "GET",
        `/channels/${binding.channel}/messages?limit=100`,
      );
      const found = (Array.isArray(recent.items) ? recent.items : [])
        .map(object)
        .find(
          (m) =>
            m.nonce === nonce &&
            object(m.author).id === identity.bot &&
            m.channel_id === binding.channel &&
            discordId(m.id),
        );
      if (found) {
        // Record the recovered placement, then repaint current terms/progress.
        // A notification or proposal may have changed while delivery was uncertain.
        target = String(found.id);
        if (content.image) {
          const attachments = Array.isArray(found.attachments)
            ? found.attachments.map(object)
            : [];
          if (
            file &&
            !attachments.some(
              (a) =>
                a.filename === file!.name &&
                Number(a.size) === file!.bytes.length,
            )
          )
            throw new DiscordError(
              "Discord’s earlier file receipt does not match the saved evidence",
              60_000,
            );
          if (!file && attachments.length)
            text =
              "Screenshot delivered earlier. The saved evidence has since changed; open the result to review its current state.";
          // Preserve the original remote attachment; never upload it again on an edit.
          file = undefined;
        }
        state
          .prepare("UPDATE chat_part SET message=?,uploaded=? WHERE id=?")
          .run(
            target,
            content.image &&
              Array.isArray(found.attachments) &&
              found.attachments.length
              ? 1
              : 0,
            row.id,
          );
      }
    }
    await channelAccess(shared, binding, session?.ceilingDigest);
    if (file && content.image) {
      const fresh = verifyResultImage(
        store,
        options.evidenceRoot,
        repos,
        content.image,
      );
      if (!fresh.ok)
        throw new DiscordError("Screenshot evidence changed before upload");
      file.bytes = fresh.bytes;
    }
    const args = discordCard(text, buttons);
    if (file)
      args.attachments = [
        { id: 0, filename: file.name, description: text.slice(0, 1024) },
      ];
    if (!target) {
      args.nonce = nonce;
      args.enforce_nonce = true;
      if (discordId(event.thread))
        args.message_reference = {
          message_id: event.thread,
          channel_id: binding.channel,
          fail_if_not_exists: false,
        };
    }
    const answer = await options.api(
      target ? "PATCH" : "POST",
      `/channels/${binding.channel}/messages${target ? `/${target}` : ""}`,
      args,
      file,
    );
    if (
      !discordId(answer.id) ||
      answer.channel_id !== binding.channel ||
      (target && answer.id !== target) ||
      object(answer.author).id !== identity.bot ||
      (file &&
        (!Array.isArray(answer.attachments) ||
          !answer.attachments.some(
            (v) =>
              object(v).filename === file!.name &&
              Number(object(v).size) === file!.bytes.length,
          )))
    )
      throw new DiscordError(
        "Discord did not confirm the message and file identity",
        15_000,
        true,
      );
    state
      .prepare(
        "UPDATE chat_part SET state='sent',message=?,attempts=attempts+1,problem=NULL,next_at=NULL WHERE id=?",
      )
      .run(answer.id, row.id);
    state
      .prepare(
        "UPDATE chat_runtime SET problem=NULL WHERE installation=? AND owner=?",
      )
      .run(identity.installation, options.owner);
    return true;
  } catch (error) {
    const problem =
      error instanceof ChatDeliveryError
        ? error
        : new DiscordError(
            "Discord delivery is waiting to retry",
            15_000,
            true,
          );
    const until = new Date(
      (options.clock?.() ?? new Date()).getTime() +
        Math.max(
          problem.retryMs,
          [5000, 15000, 60000, 300000][Math.min(row.attempts, 3)]!,
        ),
    ).toISOString();
    state
      .prepare(
        "UPDATE chat_part SET attempts=attempts+1,uncertain=uncertain+?,next_at=?,problem=? WHERE id=?",
      )
      .run(problem.uncertain ? 1 : 0, until, problem.message, row.id);
    state
      .prepare(
        "UPDATE chat_runtime SET problem=? WHERE installation=? AND owner=?",
      )
      .run(
        problem.code === "ratelimited"
          ? "Discord asked us to wait. Saved replies will retry."
          : problem.message,
        identity.installation,
        options.owner,
      );
    if (problem.code === "ratelimited")
      state
        .prepare("UPDATE chat_runtime SET retry_at=? WHERE installation=?")
        .run(until, identity.installation);
    return true;
  }
}
