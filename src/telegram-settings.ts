/** The person's own Telegram pairing, from the console: one private chat per
 * teammate with the installation's bot (v72). The bot token itself stays on
 * the settings page; this card only mints or revokes the signed-in person's
 * pairing, never anyone else's. */
import type { Store } from "./store.js";

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
  options: { code?: string; problem?: string } = {},
): string {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const password =
    '<label>Your Standing Orders password<input style="min-height:44px" type="password" name="password" autocomplete="current-password" required></label>';
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
    if (options.code !== undefined) {
      content +=
        "<h2>Pair your phone</h2><p>Send this to the bot in a private Telegram chat within 10 minutes:</p>" +
        `<pre class="pairing-code">/pair ${escape(options.code)}</pre>` +
        '<p class="meta">The code works once. That chat then answers as you, so treat it like your sign-in.</p>';
    } else if (mine.length === 0) {
      content += post("pair", password + '<button type="submit">Pair my phone</button>');
    } else {
      content += post("unpair", password + '<p class="meta">Unpairing ends every open button in that chat. Pair again from a new phone afterwards.</p><button type="submit">Unpair my phone</button>');
    }
  }
  if (options.problem !== undefined) content = `<p role="status">${escape(options.problem)}</p>` + content;
  return `<h1>Telegram</h1>${content}<p class="meta">Each teammate pairs their own private chat. Group chats join a team conversation from its People settings.</p>`;
}
