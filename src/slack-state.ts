/** Durable Slack identities and receipts. Tokens and upload URLs never enter SQLite. */
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "./store.js";

export const SLACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS slack_binding (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL,
 team TEXT NOT NULL, app TEXT NOT NULL, member TEXT NOT NULL, channel TEXT NOT NULL,
 approver TEXT NOT NULL, generation INTEGER NOT NULL, created TEXT NOT NULL, revoked TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_one_binding ON slack_binding(installation) WHERE revoked IS NULL;
CREATE TABLE IF NOT EXISTS slack_pair (
 hash TEXT PRIMARY KEY, installation TEXT NOT NULL, approver TEXT NOT NULL,
 generation INTEGER NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE IF NOT EXISTS slack_event (
 id TEXT PRIMARY KEY, installation TEXT NOT NULL, binding INTEGER REFERENCES slack_binding(id),
 kind TEXT NOT NULL CHECK(kind IN ('message','action','pair','notice')),
 channel TEXT NOT NULL, member TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL,
 payload TEXT NOT NULL, created TEXT NOT NULL,
 session INTEGER REFERENCES mate_session(id), state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','dropped')),
 next_at TEXT, problem TEXT
);
CREATE INDEX IF NOT EXISTS slack_pending_event ON slack_event(installation,state,next_at);
CREATE TABLE IF NOT EXISTS slack_part (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL REFERENCES slack_event(id), ordinal INTEGER NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','dropped')),
 message TEXT, file TEXT, uploaded INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 uncertain INTEGER NOT NULL DEFAULT 0, next_at TEXT, problem TEXT, created TEXT NOT NULL,
 UNIQUE(event,ordinal)
);
CREATE TABLE IF NOT EXISTS slack_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES slack_part(id),
 proposal INTEGER NOT NULL REFERENCES mate_proposal(id), phase TEXT NOT NULL CHECK(phase IN ('confirm','dismiss','yes','cancel')),
 expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE IF NOT EXISTS slack_progress (
 binding INTEGER NOT NULL REFERENCES slack_binding(id), run INTEGER NOT NULL REFERENCES run(id),
 part INTEGER NOT NULL REFERENCES slack_part(id), digest TEXT NOT NULL,
 PRIMARY KEY(binding,run)
);
CREATE TABLE IF NOT EXISTS slack_runtime (
 installation TEXT PRIMARY KEY, owner TEXT, lease_until TEXT, connected TEXT,
 problem TEXT, retry_at TEXT, notification INTEGER NOT NULL DEFAULT 0
);
`;
export const SLACK_TABLES = [
  "slack_binding",
  "slack_pair",
  "slack_event",
  "slack_part",
  "slack_action",
  "slack_progress",
  "slack_runtime",
] as const;
export type SlackIdentity = {
  installation: string;
  team: string;
  app: string;
  bot: string;
  workspace: string;
};
export type SlackBinding = {
  id: number;
  installation: string;
  team: string;
  app: string;
  member: string;
  channel: string;
  approver: string;
  generation: number;
  created: string;
  revoked: string | null;
};
export type SlackEvent = {
  id: string;
  installation: string;
  binding: number | null;
  kind: "message" | "action" | "pair" | "notice";
  channel: string;
  member: string;
  ts: string;
  thread: string;
  payload: string;
  created: string;
  session: number | null;
  state: string;
  next_at: string | null;
};
export type SlackPart = {
  id: number;
  event: string;
  ordinal: number;
  payload: string;
  state: string;
  message: string | null;
  file: string | null;
  uploaded: number;
  attempts: number;
  uncertain: number;
  next_at: string | null;
  created: string;
};
export type SlackContent = {
  text: string;
  proposal?: number;
  image?: { taskId: string; run: number; artifact: number; sha256: string };
  task?: string;
  run?: number;
  edit?: string;
  phase?: "armed";
  link?: { label: string; path: string };
};
export const slackHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export class SlackState {
  constructor(readonly store: Store) {}
  get db() {
    return this.store.handle;
  }
  binding(installation: string): SlackBinding | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM slack_binding WHERE installation=? AND revoked IS NULL",
        )
        .get(installation) as SlackBinding | undefined) ?? null
    );
  }
  live(binding: SlackBinding): boolean {
    const current = this.binding(binding.installation);
    const account = this.store.accountOf(binding.approver);
    return (
      current?.id === binding.id &&
      account?.role === "approver" &&
      account.revokedAt === null &&
      account.generation === binding.generation
    );
  }
  revoke(installation: string, now = new Date()): void {
    this.store.transact(() => {
      this.db
        .prepare(
          "UPDATE slack_binding SET revoked=? WHERE installation=? AND revoked IS NULL",
        )
        .run(now.toISOString(), installation);
      this.db
        .prepare(
          "UPDATE slack_pair SET consumed=? WHERE installation=? AND consumed IS NULL",
        )
        .run(now.toISOString(), installation);
      this.db
        .prepare(
          "UPDATE slack_event SET state='dropped',payload='{}',problem='Chat disconnected' WHERE installation=? AND state='queued'",
        )
        .run(installation);
      this.db
        .prepare(
          "UPDATE slack_part SET state='dropped',problem='Chat disconnected' WHERE state='pending' AND event IN (SELECT id FROM slack_event WHERE installation=?)",
        )
        .run(installation);
    });
  }
  pairing(
    installation: string,
    approver: string,
    generation: number,
    now = new Date(),
  ): string {
    const code = randomBytes(16).toString("hex");
    this.store.transact(() => {
      this.db
        .prepare(
          "UPDATE slack_pair SET consumed=? WHERE installation=? AND consumed IS NULL",
        )
        .run(now.toISOString(), installation);
      this.db
        .prepare("INSERT INTO slack_pair VALUES(?,?,?,?,?,NULL)")
        .run(
          slackHash(code),
          installation,
          approver,
          generation,
          new Date(now.getTime() + 600_000).toISOString(),
        );
    });
    return code;
  }
  pair(
    identity: SlackIdentity,
    hash: string,
    member: string,
    channel: string,
    now: Date,
  ): SlackBinding | null {
    return this.store.transact(() => {
      const pair = this.db
        .prepare(
          "SELECT approver,generation FROM slack_pair WHERE hash=? AND installation=? AND consumed IS NULL AND expires>?",
        )
        .get(hash, identity.installation, now.toISOString());
      if (!pair || this.binding(identity.installation)) return null;
      const account = this.store.accountOf(String(pair.approver));
      if (
        account?.role !== "approver" ||
        account.revokedAt !== null ||
        account.generation !== Number(pair.generation)
      )
        return null;
      this.db
        .prepare("UPDATE slack_pair SET consumed=? WHERE hash=?")
        .run(now.toISOString(), hash);
      this.db
        .prepare(
          "INSERT INTO slack_binding(installation,team,app,member,channel,approver,generation,created) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          identity.installation,
          identity.team,
          identity.app,
          member,
          channel,
          String(pair.approver),
          Number(pair.generation),
          now.toISOString(),
        );
      this.db
        .prepare("INSERT OR IGNORE INTO slack_runtime(installation) VALUES(?)")
        .run(identity.installation);
      this.db
        .prepare(
          "UPDATE slack_runtime SET notification=(SELECT COALESCE(MAX(id),0) FROM notification) WHERE installation=?",
        )
        .run(identity.installation);
      return this.binding(identity.installation);
    });
  }
  enqueue(event: Omit<SlackEvent, "session" | "state" | "next_at">): boolean {
    return (
      Number(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO slack_event(id,installation,binding,kind,channel,member,ts,thread,payload,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            event.id,
            event.installation,
            event.binding,
            event.kind,
            event.channel,
            event.member,
            event.ts,
            event.thread,
            event.payload,
            event.created,
          ).changes,
      ) === 1
    );
  }
  event(id: string): SlackEvent | null {
    return (
      (this.db.prepare("SELECT * FROM slack_event WHERE id=?").get(id) as
        SlackEvent | undefined) ?? null
    );
  }
  next(installation: string, now: Date): SlackEvent | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM slack_event WHERE installation=? AND state='queued' AND (next_at IS NULL OR next_at<=?) ORDER BY created,id LIMIT 1",
        )
        .get(installation, now.toISOString()) as SlackEvent | undefined) ?? null
    );
  }
  defer(event: string, problem: string, until: Date): void {
    this.db
      .prepare(
        "UPDATE slack_event SET next_at=?,problem=? WHERE id=? AND state='queued'",
      )
      .run(until.toISOString(), problem, event);
  }
  finish(event: string, dropped = false): void {
    this.db
      .prepare("UPDATE slack_event SET state=?,payload='{}' WHERE id=?")
      .run(dropped ? "dropped" : "done", event);
  }
  part(id: number): SlackPart | null {
    return (
      (this.db.prepare("SELECT * FROM slack_part WHERE id=?").get(id) as
        SlackPart | undefined) ?? null
    );
  }
  plan(event: string, parts: SlackContent[], now: Date): void {
    this.store.transact(() => {
      for (const [ordinal, part] of parts.entries()) {
        const inserted = this.db
          .prepare(
            "INSERT OR IGNORE INTO slack_part(event,ordinal,payload,created) VALUES(?,?,?,?)",
          )
          .run(event, ordinal, JSON.stringify(part), now.toISOString());
        if (Number(inserted.changes) && part.proposal)
          this.tokens(
            Number(inserted.lastInsertRowid),
            part.proposal,
            ["confirm", "dismiss"],
            now,
          );
      }
      this.finish(event);
    });
  }
  tokens(
    part: number,
    proposal: number,
    phases: Array<"confirm" | "dismiss" | "yes" | "cancel">,
    now: Date,
  ): void {
    this.db
      .prepare(
        "UPDATE slack_action SET consumed=? WHERE part=? AND consumed IS NULL",
      )
      .run(now.toISOString(), part);
    for (const phase of phases)
      this.db
        .prepare("INSERT INTO slack_action VALUES(?,?,?,?,?,NULL)")
        .run(
          randomBytes(16).toString("hex"),
          part,
          proposal,
          phase,
          new Date(
            now.getTime() +
              (phase === "yes" || phase === "cancel" ? 600_000 : 86_400_000),
          ).toISOString(),
        );
  }
  lease(installation: string, owner: string, now: Date): boolean {
    this.db
      .prepare("INSERT OR IGNORE INTO slack_runtime(installation) VALUES(?)")
      .run(installation);
    return (
      Number(
        this.db
          .prepare(
            "UPDATE slack_runtime SET owner=?,lease_until=? WHERE installation=? AND (owner=? OR lease_until IS NULL OR lease_until<=?)",
          )
          .run(
            owner,
            new Date(now.getTime() + 60_000).toISOString(),
            installation,
            owner,
            now.toISOString(),
          ).changes,
      ) === 1
    );
  }
  owns(installation: string, owner: string, now = new Date()): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM slack_runtime WHERE installation=? AND owner=? AND lease_until>?",
      )
      .get(installation, owner, now.toISOString());
  }
}
