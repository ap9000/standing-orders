import { loadPrimary } from "./webhooks.js";
import type { Store } from "./store.js";
import { loadSlackCredentials } from "./slack-api.js";
import { SlackState } from "./slack-state.js";
const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function slackSettingsHtml(
  store: Store,
  dir: string,
  csrf: string,
  options: { code?: string; problem?: string; now?: Date } = {},
): string {
  const credentials = loadSlackCredentials(dir),
    state = new SlackState(store),
    binding = credentials ? state.binding(credentials.installation) : null;
  const runtime = credentials
    ? state.db
        .prepare(
          "SELECT connected,problem,lease_until FROM slack_runtime WHERE installation=?",
        )
        .get(credentials.installation)
    : null;
  const now = options.now ?? new Date(),
    live =
      runtime &&
      typeof runtime.lease_until === "string" &&
      runtime.lease_until > now.toISOString() &&
      runtime.connected;
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const password =
    '<label>Your Standing Orders password<input style="min-height:44px" type="password" name="password" autocomplete="current-password" required></label>';
  const post = (action: string, content: string) =>
    `<form method="post" action="/settings/slack/${action}" class="card">${hidden}${content}</form>`;
  let content = "";
  if (!credentials) {
    content =
      "<p>Manage projects and review results in a private Slack conversation.</p>" +
      '<details open><summary>Create your Slack app</summary><ol><li>Download the <a href="/settings/slack/manifest">app manifest</a>, then <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer">create an app</a> in your workspace using that manifest.</li><li>Under Basic Information, create an app-level token with <code>connections:write</code>.</li><li>Under OAuth &amp; Permissions, install the app and copy its bot token.</li></ol></details>' +
      post(
        "connect",
        '<label>App token<input style="min-height:44px" type="password" name="app-token" autocomplete="off" placeholder="xapp-…" required></label><label>Bot token<input style="min-height:44px" type="password" name="bot-token" autocomplete="off" placeholder="xoxb-…" required></label>' +
          password +
          '<p class="meta">Tokens stay on this installation. Next, pair your own Slack account.</p><button type="submit">Connect Slack</button>',
      );
  } else {
    content = `<p><strong>${escape(credentials.workspace)}</strong> · ${live ? "Connected" : "Waiting for connection"}</p>`;
    if (runtime?.problem)
      content += `<p role="status">${escape(String(runtime.problem))}</p>`;
    if (!live && !runtime?.problem)
      content +=
        "<p>Keep the Standing Orders worker running to receive Slack messages.</p>";
    if (options.code) {
      content +=
        "<h2>Pair your account</h2><p>Send this in a direct message to your Standing Orders Slack app. It expires in 10 minutes.</p>" +
        `<label>Pairing message<input type="text" readonly value="pair ${escape(options.code)}" autocomplete="off" style="width:100%;max-width:100%;font-size:14px;min-height:44px"></label>` +
        '<a class="button-link" style="min-height:44px;white-space:nowrap" href="/settings/slack">Check connection</a>';
    } else if (binding && state.live(binding)) {
      const pending = Number(
        state.db
          .prepare(
            "SELECT count(*) n FROM slack_part p JOIN slack_event e ON e.id=p.event WHERE e.binding=? AND p.state='pending'",
          )
          .get(binding.id)?.n ?? 0,
      );
      const failed = Number(
        state.db
          .prepare(
            "SELECT count(*) n FROM slack_part p JOIN slack_event e ON e.id=p.event WHERE e.binding=? AND p.state='dropped'",
          )
          .get(binding.id)?.n ?? 0,
      );
      content +=
        `<p>Paired to ${escape(binding.approver)}.${pending ? ` ${pending} replies waiting to send.` : ""}${failed ? ` ${failed} replies could not be delivered. Open the saved chat to recover them.` : ""}</p>` +
        "<p>Try “What needs my attention?” or “Show the evidence for the latest result.”</p>" +
        '<p><a href="/chat">Open saved chat</a></p>' +
        (loadPrimary(process.env, dir) === "slack"
          ? "<p>Task updates are sent here.</p>"
          : post(
              "alerts",
              '<button type="submit">Send task updates here</button>',
            ));
    } else {
      content += post(
        "pair",
        "<h2>Pair your account</h2><p>Your paired Slack account can read your connected projects and confirm proposed changes. Password approvals still open in Standing Orders.</p>" +
          password +
          '<button type="submit">Create pairing code</button>',
      );
    }
    content +=
      "<details><summary>Connection settings</summary>" +
      post(
        "disconnect",
        password + '<button type="submit">Disconnect Slack</button>',
      ) +
      "</details>";
  }
  return `<section style="max-width:42rem;overflow-wrap:anywhere"><p><a href="/settings">Settings</a></p><h1>Slack</h1>${options.problem ? `<p class="problem" role="alert">${escape(options.problem)}</p>` : ""}${content}<details><summary>Access and setup</summary><p>Private messages and threads use your Standing Orders permissions. Shared channels are not supported. Secure review links use this installation’s configured HTTPS console address.</p><p>Socket Mode connects out to Slack. It does not need a public webhook or a Tailscale account.</p></details></section>`;
}
