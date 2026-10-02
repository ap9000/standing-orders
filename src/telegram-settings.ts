/** The person's own Telegram pairing, from the console: one private chat per
 * teammate with the installation's bot (v72). The bot token itself stays on
 * the settings page; this card only mints or revokes the signed-in person's
 * pairing, never anyone else's. */
import type { Store } from "./store.js";

/** How long a written reply may wait to be sent before it shows here with a Retry. */
export const UNSENT_REPLY_MS = 2 * 60_000;

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function telegramSettingsHtml(
  store: Store,
  botId: string | null,
  who: string,
  csrf: string,
  options: { code?: string; problem?: string; now?: Date } = {},
): string {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const password =
    '<label>Your Toolroll password<input style="min-height:44px" type="password" name="password" autocomplete="current-password" required></label>';
  const post = (action: string, content: string) =>
    `<form method="post" action="/settings/telegram/${action}" class="card">${hidden}${content}</form>`;
  let content = "";
  if (botId === null) {
    content = '<p>No Telegram bot is connected yet. An installation approver saves the bot token on the <a href="/settings">settings page</a> first.</p>';
  } else {
    const bindings = store.liveTelegramBindings(botId);
    const mine = bindings.filter(binding => binding.approver === who);
    const others = bindings.length - mine.length;
    content = `<p><strong>${mine.length > 0 ? "Your phone is paired." : "Your phone is not paired."}</strong> ${
      others === 0 ? "No teammates are paired yet." : `${others} teammate${others === 1 ? " is" : "s are"} paired.`
    }</p>`;
    // A reply the assistant wrote that has not reached this person's phone for two minutes.
    const unsent = store.unsentTelegramReplies(botId, who, new Date((options.now ?? new Date()).getTime() - UNSENT_REPLY_MS));
    if (unsent.length > 0) {
      const oldest = unsent[0]!;
      content +=
        `<div class="card" role="status" data-unsent-replies><p><strong>${unsent.length === 1 ? "A reply hasn't reached your phone" : `${unsent.length} replies haven't reached your phone`}</strong></p>` +
        `<p class="meta">Trying since ${escape(oldest.since.slice(11, 16))} UTC${oldest.error === null ? "" : `: ${escape(oldest.error)}`}</p>` +
        `<form method="post" action="/settings/telegram/retry">${hidden}<button type="submit">Retry</button></form></div>`;
    }
    if (options.code !== undefined) {
      content +=
        "<h2>Pair your phone</h2><p>Send this to the bot in a private Telegram chat within 10 minutes:</p>" +
        `<pre class="pairing-code">/pair ${escape(options.code)}</pre>` +
        '<p class="meta">The code works once. That chat then answers as you, so treat it like your sign-in.</p>';
    } else if (mine.length === 0) {
      content += post("pair", password + '<button type="submit">Pair my phone</button>');
    } else {
      content += post("unpair", password + '<p class="meta">This phone will lose access. Its existing Telegram buttons will stop working.</p><button type="submit" class="danger">Unpair my phone</button>');
    }
  }
  if (options.problem !== undefined) content = `<p role="status">${escape(options.problem)}</p>` + content;
  return `<h1>Telegram</h1>${content}<p class="meta">Each teammate pairs their own private chat. To connect a group, a conversation manager sends <code>/team</code> there and chooses a conversation. Everyone in the group can read its replies.</p>`;
}
