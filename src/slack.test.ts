/** Scripted Slack API and membership runner. No live Slack acceptance is claimed. */
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openStore, type Store } from "./store.js";
import { addApprover, propose, approve } from "./scope.js";
import { SlackState, slackHash, type SlackContent } from "./slack-state.js";
import {
  SlackError,
  slackApi,
  uploadSlackBytes,
  saveSlackCredentials,
  loadSlackCredentials,
  SLACK_MANIFEST,
  type SlackApi,
} from "./slack-api.js";
import {
  receiveSlack,
  processSlackEvent,
  deliverSlackPart,
  planSlackNotifications,
  slackBlocks,
  type SlackChatOptions,
} from "./slack-chat.js";
import { knowledgeView } from "./project-knowledge.js";
import { resolveChannelMate, parityGaps } from "./chat-channel.js";
import { prepareSharedAction } from "./chat-actions.js";
import { telegramProgressCard } from "./telegram-progress.js";
import { slackSettingsHtml } from "./slack-settings.js";
import { effectivePrimary, savePrimary } from "./webhooks.js";
import { createDecisionServer } from "./serve.js";
import { StandingOrdersSlackSocket } from "./slack.js";

// Synthetic credentials for the scripted wire, assembled so evidence scans do not flag a real token.
const FIXTURE_BOT_TOKEN = ["xoxb", "fixture", "private", "token"].join("-");
const ID = {
  installation: "installation-test",
  team: "TTEST",
  app: "ATEST",
  bot: "UBOT",
  workspace: "Test workspace",
};
const MEMBER = "UTEST",
  CHANNEL = "DTEST",
  TS = "1789700000.000001";
describe("Slack shared chat", () => {
  let dir: string,
    repo: string,
    store: Store,
    state: SlackState,
    now: Date,
    options: SlackChatOptions,
    password: string;
  let calls: Array<{ method: string; args: Record<string, unknown> }>;
  let answers: Array<{
    text: string;
    calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    before?: () => void;
  }>;
  let runner: NonNullable<SlackChatOptions["subscriptionRunner"]>,
    projects: string[],
    serial: number;
  const message = (text: string, extra: Record<string, unknown> = {}) => ({
    api_app_id: ID.app,
    team_id: ID.team,
    event_id: `Ev${++serial}`,
    event: {
      type: "message",
      channel_type: "im",
      user: MEMBER,
      channel: CHANNEL,
      ts: TS,
      text,
      ...extra,
    },
  });
  const receive = (text: string, extra: Record<string, unknown> = {}) =>
    receiveSlack(state, ID, "events_api", message(text, extra), now);
  const sends = () =>
    calls.filter(
      (c) => c.method === "chat.postMessage" || c.method === "chat.update",
    );
  async function drain() {
    for (let i = 0; i < 20 && (await deliverSlackPart(options)); i++);
  }
  const pair = () => {
    const code = state.pairing(
      ID.installation,
      "alex",
      store.accountOf("alex")!.generation,
      now,
    );
    return state.pair(ID, slackHash(code), MEMBER, CHANNEL, now)!;
  };
  function action(token: string, ts = TS, extra: Record<string, unknown> = {}) {
    return {
      api_app_id: ID.app,
      team: { id: ID.team },
      type: "block_actions",
      user: { id: MEMBER },
      channel: { id: CHANNEL },
      container: { type: "message", channel_id: CHANNEL, message_ts: ts },
      message: { thread_ts: TS },
      actions: [
        {
          action_id: "standing_orders_confirm",
          value: token,
          action_ts: `1789700000.${String(++serial).padStart(6, "0")}`,
        },
      ],
      ...extra,
    };
  }
  async function tap(
    token: string,
    ts: string,
    extra: Record<string, unknown> = {},
  ) {
    receiveSlack(state, ID, "interactive", action(token, ts, extra), now);
    await processSlackEvent(options);
    await drain();
  }
  function latestCard() {
    const row = state.db
      .prepare(
        "SELECT * FROM slack_part WHERE json_extract(payload,'$.proposal') IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get()!;
    const token = state.db
      .prepare(
        "SELECT token FROM slack_action WHERE part=? AND phase='confirm' AND consumed IS NULL",
      )
      .get(Number(row.id))!;
    return {
      id: Number(row.id),
      proposal: Number(
        (JSON.parse(String(row.payload)) as SlackContent).proposal,
      ),
      ts: String(row.message),
      token: String(token.token),
    };
  }
  function source() {
    store.createTask({ id: "sample", title: "Clarify Slack progress" }, now);
    const ref = store.refFor("built-in", "sample").id;
    store.placeTask(ref, repo);
    propose(store, {
      taskId: "sample",
      goal: "Clear progress",
      touches: ["src/a.ts"],
      acceptance: [
        {
          id: "c1",
          statement: "Progress is clear",
          how: null,
          evidence: ["manual-review"],
        },
      ],
      now,
    });
    const scope = store.getScope("sample")!;
    expect(
      approve(store, "sample", "alex", now, scope.digest, password).ok,
    ).toBe(true);
    const route = store.routeAuthorityFor(ref, "builder", null);
    if (!route?.ok) throw Error("route");
    const run = store.startRun({
      taskRef: ref,
      leaseId: "sample-lease",
      runner: "test",
      branch: "test",
      worktree: repo,
      route: route.stamp,
      now,
    });
    store.stampRun(run, { scopeDigest: scope.digest });
    store.finishRun(run, { outcome: "built", committed: true, now });
    return { ref, run };
  }
  function draft(
    payload: Record<string, unknown>,
    kind: Parameters<Store["draftMateProposal"]>[0]["kind"] = "action",
  ) {
    const binding = state.binding(ID.installation)!;
    const resolved = resolveChannelMate(
      store,
      { approver: binding.approver, approverGeneration: binding.generation },
      projects,
      now,
    );
    if (!resolved.ok) throw Error("session");
    const opened = store.openMateTurn(
      {
        approver: "alex",
        session: resolved.session.id,
        thread: resolved.thread.id,
        credentialKey: resolved.session.credentialKey,
        reservedMicrousd: 0,
        dailyTurns: 50,
        weeklyCeilingMicrousd: 0,
        deadlineMs: 60000,
      },
      now,
    );
    if (!opened.ok) throw Error("turn");
    const started = store.startMateTurn(opened.id, now);
    if (!started.ok) throw Error("start");
    const id = store.draftMateProposal(
      {
        thread: resolved.thread.id,
        turn: opened.id,
        kind,
        payload,
        ceilingDigest: resolved.who.ceilingDigest,
      },
      now,
    );
    store.finalizeMateTurn(
      opened.id,
      started.generation,
      { state: "answered", settledMicrousd: 0, tokensIn: 1, tokensOut: 1 },
      now,
    );
    const event = slackHash(`card${++serial}`);
    state.enqueue({
      id: event,
      installation: ID.installation,
      binding: binding.id,
      kind: "message",
      channel: CHANNEL,
      member: MEMBER,
      ts: TS,
      thread: TS,
      payload: "{}",
      created: now.toISOString(),
    });
    state.plan(event, [{ text: "", proposal: id }], now);
    return { id, who: resolved.who };
  }
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "so-slack-")));
    repo = join(dir, "repo");
    mkdirSync(repo);
    mkdirSync(join(dir, "evidence"));
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Synthetic Slack test\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "seed",
    ]);
    store = openStore(join(dir, "state.db"));
    state = new SlackState(store);
    now = new Date("2026-09-17T20:00:00Z");
    serial = 0;
    calls = [];
    answers = [];
    projects = [repo];
    const added = addApprover(store, "alex", now);
    if (!added.ok) throw Error("account");
    password = added.token;
    for (const phase of ["build", "plan", "review"])
      store.setPhaseConfig(
        "installation",
        phase,
        "claude",
        "sonnet",
        "test",
        now,
      );
    store.setChatConfig(
      {
        provider: "claude-subscription",
        model: "default",
        dailyTurns: 50,
        weeklyCeilingMicrousd: 0,
        priceInMicrousd: 0,
        priceOutMicrousd: 0,
      },
      "alex",
      now,
    );
    let sent = 100;
    const api: SlackApi = vi.fn(async (method, args = {}) => {
      calls.push({ method, args });
      if (method === "users.info")
        return {
          user: { id: MEMBER, team_id: ID.team, deleted: false, is_bot: false },
        };
      if (method === "conversations.info")
        return { channel: { id: CHANNEL, is_im: true, user: MEMBER } };
      if (method === "chat.postMessage")
        return { ts: `1789700000.${String(sent++).padStart(6, "0")}` };
      if (method === "chat.update") return { ts: args.ts };
      if (method === "files.getUploadURLExternal")
        return {
          file_id: "FFILE",
          upload_url: "https://files.slack.com/upload/v1/test",
        };
      if (method === "files.completeUploadExternal")
        return { files: [{ id: "FFILE" }] };
      return {};
    });
    runner = vi.fn(async () => {
      const next = answers.shift();
      if (!next) throw Error("No scripted answer");
      next.before?.();
      return {
        ok: true,
        answer: {
          text: next.text,
          calls: next.calls ?? [],
          tokensIn: 10,
          tokensOut: 5,
          reportedCostMicrousd: null,
        },
      };
    });
    options = {
      store,
      identity: ID,
      api,
      owner: "test",
      readProjects: async () => projects,
      evidenceRoot: join(dir, "evidence"),
      current: () => true,
      origin: () => "https://console.example",
      clock: () => now,
      subscriptionRunner: runner,
      upload: vi.fn(async () => {}),
    };
    state.lease(ID.installation, "test", now);
    pair();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("pairs only once to a live account, hashes codes and rejects another workspace or sender", async () => {
    state.revoke(ID.installation, now);
    const code = state.pairing(
      ID.installation,
      "alex",
      store.accountOf("alex")!.generation,
      now,
    );
    const payload = message(`pair ${code}`);
    expect(receiveSlack(state, ID, "events_api", payload, now)).toBe(true);
    expect(
      JSON.stringify(state.db.prepare("SELECT * FROM slack_event").all()),
    ).not.toContain(code);
    await processSlackEvent(options);
    expect(state.binding(ID.installation)?.member).toBe(MEMBER);
    await drain();
    expect(sends().at(-1)?.args.text).toContain("Connected to Standing Orders");
    expect(receive("private projects", { user: "UOTHER" })).toBe(false);
    expect(
      receiveSlack(
        state,
        ID,
        "events_api",
        { ...message("private"), team_id: "TOTHER" },
        now,
      ),
    ).toBe(false);
    expect(
      receive("public", { channel_type: "channel", channel: "COTHER" }),
    ).toBe(false);
    expect(receive("bot echo", { bot_id: "BBOT" })).toBe(false);
    expect(state.pair(ID, slackHash(code), "UOTHER", "DOTHER", now)).toBeNull();
  });
  test("one request survives duplicate events and reply delivery loss without a second model turn", async () => {
    const body = message("What needs my attention?");
    answers.push({ text: "No task needs your attention." });
    expect(receiveSlack(state, ID, "events_api", body, now)).toBe(true);
    expect(receiveSlack(state, ID, "events_api", body, now)).toBe(false);
    await processSlackEvent(options);
    const base = options.api;
    options.api = async (method, args) => {
      if (method === "chat.postMessage")
        throw new SlackError("lost receipt", 5000, true);
      return base(method, args);
    };
    await deliverSlackPart(options);
    expect(
      state.db.prepare("SELECT uncertain FROM slack_part").get()?.uncertain,
    ).toBe(1);
    options.api = base;
    now = new Date(now.getTime() + 6000);
    state.lease(ID.installation, "test", now);
    await drain();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sends().at(-1)?.args.thread_ts).toBe(TS);
    expect(state.db.prepare("SELECT state FROM slack_part").get()?.state).toBe(
      "sent",
    );
  });
  test("shared knowledge change confirms once, records Slack, and edits its original card", async () => {
    answers.push(
      {
        text: "Save the instructions.",
        calls: [
          {
            id: "change",
            name: "propose_action",
            args: {
              operation: "knowledge_instructions",
              repo: "r1",
              instructions: "Keep updates concise.",
            },
          },
        ],
      },
      { text: "Review the proposed instructions." },
    );
    receive("Save these instructions");
    await processSlackEvent(options);
    await drain();
    const card = latestCard();
    await tap(card.token, card.ts);
    expect(knowledgeView(store, repo, "alex").knowledge.instructions).toBe(
      "Keep updates concise.",
    );
    expect(store.getMateProposal(card.proposal)?.outcome).toMatchObject({
      via: "slack",
      ok: true,
    });
    expect(sends().at(-1)?.method).toBe("chat.update");
    expect(sends().at(-1)?.args.ts).toBe(card.ts);
    await tap(card.token, card.ts);
    expect(knowledgeView(store, repo, "alex").revision).toBe(1);
  });
  test("protected changes always use the existing secure review link, including forged callbacks", async () => {
    source();
    const binding = state.binding(ID.installation)!;
    const resolved = resolveChannelMate(
      store,
      { approver: "alex", approverGeneration: binding.generation },
      projects,
      now,
    );
    if (!resolved.ok) throw Error("session");
    const prepared = prepareSharedAction(
      store,
      resolved.who,
      "task_cancel",
      { task: "sample" },
      options.evidenceRoot,
      now,
    );
    draft({ ...prepared });
    await drain();
    const card = latestCard();
    const blocks = sends().at(-1)!.args.blocks as Array<{
      elements?: Array<{ url?: string; value?: string }>;
    }>;
    expect(blocks.flatMap((b) => b.elements ?? []).map((b) => b.url)).toContain(
      `https://console.example/chat/action/${card.proposal}`,
    );
    expect(blocks.flatMap((b) => b.elements ?? []).some((b) => b.value)).toBe(
      false,
    );
    await tap(card.token, card.ts);
    expect(store.getTask("sample")?.state).not.toBe("cancelled");
  });
  test.each(["sender", "message", "expiry", "projects", "revoked"])(
    "refuses a confirmation after %s changes",
    async (fault) => {
      const { ref } = source();
      draft({ task: "sample", reason: "Inspect the wording" }, "hold");
      await drain();
      const card = latestCard();
      if (fault === "expiry") {
        now = new Date(now.getTime() + 86_400_001);
        state.lease(ID.installation, "test", now);
      }
      if (fault === "projects") projects = [];
      if (fault === "revoked") state.revoke(ID.installation, now);
      await tap(
        card.token,
        fault === "message" ? "1789700000.999999" : card.ts,
        fault === "sender" ? { user: { id: "UOTHER" } } : {},
      );
      expect(store.activeHolds(ref, now)).toHaveLength(0);
    },
  );
  test("revocation during a provider wait suppresses tools, proposals and outbound data", async () => {
    answers.push({
      text: "Ready.",
      calls: [
        {
          id: "change",
          name: "propose_action",
          args: {
            operation: "knowledge_instructions",
            repo: "r1",
            instructions: "Do not save.",
          },
        },
      ],
      before: () => state.revoke(ID.installation, now),
    });
    receive("Save instructions");
    await processSlackEvent(options);
    await drain();
    expect(sends()).toHaveLength(0);
    expect(knowledgeView(store, repo, "alex").revision).toBe(0);
  });
  test("verified screenshots use the external upload API and altered bytes are refused", async () => {
    const { run } = source(),
      bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqRkAAAAASUVORK5CYII=",
        "base64",
      ),
      key = `${run}/screenshot.png`;
    mkdirSync(join(options.evidenceRoot, String(run)));
    writeFileSync(join(options.evidenceRoot, key), bytes);
    const artifact = store.saveArtifact(
      {
        run,
        kind: "screenshot",
        key,
        bytesOriginal: bytes.length,
        bytesStored: bytes.length,
        truncated: false,
        sha256: slackHash(bytes.toString("binary")),
        capture: "Synthetic screenshot",
      },
      now,
    );
    // Hash the original bytes exactly, as the evidence recorder does.
    const { createHash } = await import("node:crypto"),
      hash = createHash("sha256").update(bytes).digest("hex");
    store.handle
      .prepare("UPDATE artifact SET sha256=? WHERE id=?")
      .run(hash, artifact);
    const binding = state.binding(ID.installation)!;
    for (const [i, tampered] of [false, true].entries()) {
      if (tampered) writeFileSync(join(options.evidenceRoot, key), "changed");
      const id = `image${i}`;
      state.enqueue({
        id,
        installation: ID.installation,
        binding: binding.id,
        kind: "message",
        channel: CHANNEL,
        member: MEMBER,
        ts: TS,
        thread: TS,
        payload: "{}",
        created: now.toISOString(),
      });
      state.plan(
        id,
        [
          {
            text: "Screenshot 1",
            image: { taskId: "sample", run, artifact, sha256: hash },
          },
        ],
        now,
      );
      await drain();
    }
    expect(options.upload).toHaveBeenCalledTimes(1);
    expect(
      calls.filter((c) => c.method === "files.completeUploadExternal"),
    ).toHaveLength(1);
    expect(sends().at(-1)?.args.text).toContain("Screenshot not sent");
  });
  test("progress facts update one exact-result card and exclude history before pairing", async () => {
    const { run } = source();
    await planSlackNotifications(options);
    await drain();
    store.enqueueNotification(
      {
        source: { run },
        dedupeKey: `review:start:${run}`,
        kind: "review-started",
        subject: "Review started",
        body: "Reviewing",
      },
      now,
    );
    await planSlackNotifications(options);
    await drain();
    expect(
      state.db.prepare("SELECT count(*) n FROM slack_progress").get()?.n,
    ).toBe(1);
    expect(sends().filter((c) => c.method === "chat.postMessage")).toHaveLength(
      1,
    );
    const content = JSON.parse(
      String(
        state.db
          .prepare(
            "SELECT p.payload FROM slack_part p JOIN slack_progress s ON s.part=p.id",
          )
          .get()?.payload,
      ),
    ) as SlackContent;
    expect(content.text).toBe(
      telegramProgressCard(store, store.getRun(run)!, "sample", repo, now, options.evidenceRoot).text,
    );
  });
  test("rate limits are persisted and a second owner cannot take a live connection", async () => {
    expect(state.lease(ID.installation, "other", now)).toBe(false);
    receive("Summarize work");
    answers.push({ text: "Ready" });
    await processSlackEvent(options);
    const api = options.api;
    options.api = async (method, args) => {
      if (method === "chat.postMessage")
        throw new SlackError("ratelimited", 120_000);
      return api(method, args);
    };
    await deliverSlackPart(options);
    expect(
      state.db.prepare("SELECT retry_at FROM slack_runtime").get()?.retry_at,
    ).toBe(new Date(now.getTime() + 120_000).toISOString());
  });
  test("credentials stay in an owner-only file; setup escapes names and never echoes tokens", () => {
    const credentials = {
      ...ID,
      workspace: "A <workspace> " + "long ".repeat(25),
      appToken: "xapp-fixture-secret",
      botToken: FIXTURE_BOT_TOKEN,
    };
    saveSlackCredentials(dir, credentials);
    expect(loadSlackCredentials(dir)).toEqual(credentials);
    if (process.platform !== "win32")
      expect(statSync(join(dir, "slack-connection.json")).mode & 0o777).toBe(
        0o600,
      );
    const html = slackSettingsHtml(store, dir, "csrf");
    expect(html).toContain("&lt;workspace&gt;");
    expect(html).not.toContain(credentials.botToken);
    expect(html).not.toContain(credentials.appToken);
    savePrimary(dir, "slack");
    expect(effectivePrimary({}, dir, true).channel).toBe("slack");
    expect(parityGaps()).toEqual([]);
    expect(SLACK_MANIFEST.oauth_config.scopes.bot).not.toContain(
      "channels:history",
    );
  });

  test("switching notification channels does not send an old Slack alert or block an ordinary reply", async () => {
    source();
    await planSlackNotifications(options);
    options.canNotify = () => false;
    receive("What remains?");
    answers.push({ text: "Your ordinary chat reply." });
    await processSlackEvent(options);
    await drain();
    expect(sends()).toHaveLength(1);
    expect(sends()[0]?.args.text).toBe("Your ordinary chat reply.");
    options.canNotify = () => true;
    await drain();
    expect(sends()).toHaveLength(2);
  });

  test("a long incoming message reports its actual size without starting the model", async () => {
    receive("a".repeat(4000));
    await processSlackEvent(options);
    await drain();
    expect(sends()[0]?.args.text).toContain("4,000");
    expect(runner).not.toHaveBeenCalled();
  });

  test("a restart after the engine answers recovers its original request receipt", async () => {
    receive("What needs review?");
    answers.push({ text: "The saved result is ready to inspect." });
    const plan = vi
      .spyOn(SlackState.prototype, "plan")
      .mockImplementationOnce(() => {
        throw Error("crash after engine receipt");
      });
    await processSlackEvent(options);
    plan.mockRestore();
    now = new Date(now.getTime() + 6000);
    state.lease(ID.installation, "test", now);
    await processSlackEvent(options);
    await drain();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(sends().at(-1)?.args.text).toContain("saved result");
  });

  test("irreversible decisions require a fresh second confirmation and record Slack in the audit", async () => {
    const { run } = source();
    const decision = store.saveDecision(
      {
        run,
        urgency: "blocking",
        recap: "Choose the failure behavior",
        question: "Fail open or closed?",
        options: [
          {
            id: "open",
            label: "Fail open",
            consequence: "Continue without the check",
            reversible: false,
          },
          {
            id: "closed",
            label: "Fail closed",
            consequence: "Stop this request",
            reversible: true,
          },
        ],
        recommendation: "closed",
      },
      now,
    );
    draft(
      {
        task: "sample",
        decision,
        option: "open",
        optionLabel: "Fail open",
        reversible: false,
        rationale: "Explicit operator choice",
      },
      "answer",
    );
    await drain();
    const first = latestCard();
    await tap(first.token, first.ts);
    expect(store.getDecision(decision)?.state).toBe("open");
    const yes = String(
      state.db
        .prepare(
          "SELECT token FROM slack_action WHERE part=? AND phase='yes' AND consumed IS NULL",
        )
        .get(first.id)?.token,
    );
    await tap(yes, first.ts);
    expect(store.getDecision(decision)?.answeredVia).toBe("slack");
    expect(store.getDecision(decision)?.choice).toBe("open");
    await tap(yes, first.ts);
    expect(store.getDecision(decision)?.choice).toBe("open");
  });

  test("HTTP setup requires a current password, CSRF and same origin, and completes the three-part API handshake", async () => {
    const handshake: string[] = [];
    const fetcher: typeof fetch = async (url) => {
      const method = new URL(String(url)).pathname.split("/").at(-1)!;
      handshake.push(method);
      return new Response(
        JSON.stringify({
          ok: true,
          ...(method === "auth.test"
            ? {
                team_id: ID.team,
                user_id: ID.bot,
                bot_id: "BBOT",
                team: ID.workspace,
              }
            : method === "bots.info"
              ? { bot: { app_id: ID.app } }
              : {}),
        }),
      );
    };
    const server = createDecisionServer({
      store,
      evidenceRoot: options.evidenceRoot,
      repos: projects,
      configDir: dir,
      slackFetcher: fetcher,
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address !== "object") throw Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(base + "/login", {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: password }),
        redirect: "manual",
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const html = await (
          await fetch(base + "/settings/slack", { headers: { cookie } })
        ).text(),
        csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
      const post = (fields: Record<string, string>, origin = base) =>
        fetch(base + "/settings/slack/connect", {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams(fields),
          redirect: "manual",
        });
      const fields = {
        csrf,
        password,
        "app-token": "xapp-fixture-private-token",
        "bot-token": FIXTURE_BOT_TOKEN,
      };
      expect((await post({ ...fields, csrf: "bad" })).status).toBe(403);
      expect((await post(fields, "https://wrong.example")).status).toBe(403);
      expect((await post({ ...fields, password: "wrong" })).status).toBe(403);
      expect(loadSlackCredentials(dir)).toBeNull();
      expect((await post(fields)).status).toBe(303);
      expect(handshake).toEqual([
        "auth.test",
        "bots.info",
        "apps.connections.open",
      ]);
      expect(loadSlackCredentials(dir)?.team).toBe(ID.team);
      expect((await post(fields)).status).toBe(409);
      const screen = await (
        await fetch(base + "/settings/slack", { headers: { cookie } })
      ).text();
      expect(screen).not.toContain(fields["app-token"]);
      expect(screen).not.toContain(fields["bot-token"]);
      expect(
        addApprover(store, "backup-owner", now, {
          name: "alex",
          token: password,
        }).ok,
      ).toBe(true);
      expect(
        store.setAccountProjects("alex", [repo], "backup-owner", now).ok,
      ).toBe(true);
      const restrictedLogin = await fetch(base + "/login", {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: password }),
        redirect: "manual",
      });
      const restrictedCookie = restrictedLogin.headers
        .get("set-cookie")!
        .split(";")[0]!;
      expect(
        (
          await fetch(base + "/settings/slack", {
            headers: { cookie: restrictedCookie },
            redirect: "manual",
          })
        ).status,
      ).toBe(403);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("Socket Mode validates the app on every hello and preserves Slack's real envelope shape", async () => {
  class Inspectable extends StandingOrdersSlackSocket {
    receive(packet: unknown) {
      return this.onWebSocketMessage(JSON.stringify(packet), false);
    }
  }
  const socket = new Inspectable({
    appToken: "xapp-fixture-private-token",
    autoReconnectEnabled: false,
  });
  socket.expectedApp = "ATEST";
  const connected = vi.fn(),
    wrong = vi.fn(),
    envelope = vi.fn();
  socket.on("connected", connected);
  socket.on("slack_event", envelope);
  socket.wrongApp = wrong;
  await socket.receive({ type: "hello", connection_info: { app_id: "ATEST" } });
  expect(connected).toHaveBeenCalledTimes(1);
  await socket.receive({
    type: "events_api",
    envelope_id: "envelope",
    payload: {
      api_app_id: "ATEST",
      team_id: "TTEST",
      event: { type: "message", text: "hello" },
    },
  });
  expect(envelope).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "events_api",
      body: expect.objectContaining({ team_id: "TTEST" }),
      ack: expect.any(Function),
    }),
  );
  await socket.receive({
    type: "hello",
    connection_info: { app_id: "AOTHER" },
  });
  expect(wrong).toHaveBeenCalledTimes(1);
  expect(connected).toHaveBeenCalledTimes(1);
  await socket.disconnect();
});

test("Slack wire errors omit secrets, honor Retry-After, and never follow upload redirects", async () => {
  const api = slackApi("xoxb-private", async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer xoxb-private",
    );
    expect(init?.redirect).toBe("error");
    return new Response("", { status: 429, headers: { "Retry-After": "23" } });
  });
  await expect(api("chat.postMessage", {})).rejects.toMatchObject({
    code: "ratelimited",
    retryMs: 23000,
  });
  const unknown = slackApi(
    "xoxb-private",
    async () =>
      new Response(JSON.stringify({ ok: false, error: "xoxb-private" })),
  );
  await expect(unknown("auth.test")).rejects.not.toThrow("xoxb-private");
  const fetcher = vi.fn();
  await expect(
    uploadSlackBytes(
      "https://evil.example/upload",
      new Uint8Array([1]),
      fetcher,
    ),
  ).rejects.toThrow("invalid upload");
  expect(fetcher).not.toHaveBeenCalled();
  const blocks = slackBlocks("Result\n<!channel> <https://evil.example|click>");
  expect(JSON.stringify(blocks)).not.toContain('"mrkdwn"');
});
