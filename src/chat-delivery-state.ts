/** Durable private-chat receipts. Each transport has its own tables and lease. */
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "./store.js";

const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_binding (
 id INTEGER PRIMARY KEY AUTOINCREMENT, installation TEXT NOT NULL,
 team TEXT NOT NULL, app TEXT NOT NULL, member TEXT NOT NULL, channel TEXT NOT NULL,
 approver TEXT NOT NULL, generation INTEGER NOT NULL, created TEXT NOT NULL, revoked TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_one_binding_member ON chat_binding(installation, member) WHERE revoked IS NULL;
CREATE TABLE IF NOT EXISTS chat_pair (
 hash TEXT PRIMARY KEY, installation TEXT NOT NULL, approver TEXT NOT NULL,
 generation INTEGER NOT NULL, expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE IF NOT EXISTS chat_event (
 id TEXT PRIMARY KEY, installation TEXT NOT NULL, binding INTEGER REFERENCES chat_binding(id),
 kind TEXT NOT NULL CHECK(kind IN ('message','action','pair','notice')),
 channel TEXT NOT NULL, member TEXT NOT NULL, ts TEXT NOT NULL, thread TEXT NOT NULL,
 payload TEXT NOT NULL, created TEXT NOT NULL,
 session INTEGER REFERENCES mate_session(id), state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','done','dropped')),
 next_at TEXT, problem TEXT
);
CREATE INDEX IF NOT EXISTS chat_pending_event ON chat_event(installation,state,next_at);
CREATE TABLE IF NOT EXISTS chat_part (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL REFERENCES chat_event(id), ordinal INTEGER NOT NULL,
 payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','dropped')),
 message TEXT, file TEXT, uploaded INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
 uncertain INTEGER NOT NULL DEFAULT 0, next_at TEXT, problem TEXT, created TEXT NOT NULL,
 UNIQUE(event,ordinal)
);
CREATE TABLE IF NOT EXISTS chat_action (
 token TEXT PRIMARY KEY, part INTEGER NOT NULL REFERENCES chat_part(id),
 proposal INTEGER NOT NULL REFERENCES mate_proposal(id), phase TEXT NOT NULL CHECK(phase IN ('confirm','dismiss','yes','cancel')),
 expires TEXT NOT NULL, consumed TEXT
);
CREATE TABLE IF NOT EXISTS chat_progress (
 binding INTEGER NOT NULL REFERENCES chat_binding(id), run INTEGER NOT NULL REFERENCES run(id),
 part INTEGER NOT NULL REFERENCES chat_part(id), digest TEXT NOT NULL,
 PRIMARY KEY(binding,run)
);
CREATE TABLE IF NOT EXISTS chat_runtime (
 installation TEXT PRIMARY KEY, owner TEXT, lease_until TEXT, connected TEXT,
 problem TEXT, retry_at TEXT, notification INTEGER NOT NULL DEFAULT 0
);
`;
const CHAT_TABLES = [
  "chat_binding",
  "chat_pair",
  "chat_event",
  "chat_part",
  "chat_action",
  "chat_progress",
  "chat_runtime",
] as const;
export type ChatIdentity = {
  installation: string;
  team?: string;
  app: string;
  bot: string;
  workspace: string;
};
export type ChatBinding = {
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
export type ChatEvent = {
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
export type ChatPart = {
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
export type ChatContent = {
  text: string;
  proposal?: number;
  image?: { taskId: string; run: number; artifact: number; sha256: string };
  task?: string;
  run?: number;
  edit?: string;
  phase?: "armed";
  link?: { label: string; path: string };
};
export const chatHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export class ChatState {
  constructor(
    readonly store: Store,
    readonly channel: "slack" | "discord",
  ) {}
  prepare(sql: string) {
    return this.db.prepare(
      sql.replace(
        /\bchat_(binding|pair|event|part|action|progress|runtime)\b/g,
        `${this.channel}_$1`,
      ),
    );
  }
  get db() {
    return this.store.handle;
  }
  /** Every unrevoked binding for an installation, oldest first: one per
   * paired person (v73). Liveness is checked per binding with `live`. */
  bindings(installation: string): ChatBinding[] {
    return this.prepare(
      "SELECT * FROM chat_binding WHERE installation=? AND revoked IS NULL ORDER BY id",
    ).all(installation) as ChatBinding[];
  }
  /** The unrevoked binding one channel member holds, if any. */
  bindingFor(installation: string, member: string): ChatBinding | null {
    return (
      (this.prepare(
        "SELECT * FROM chat_binding WHERE installation=? AND member=? AND revoked IS NULL",
      ).get(installation, member) as ChatBinding | undefined) ?? null
    );
  }
  bindingById(id: number): ChatBinding | null {
    return (
      (this.prepare("SELECT * FROM chat_binding WHERE id=? AND revoked IS NULL").get(id) as
        | ChatBinding
        | undefined) ?? null
    );
  }
  /** The oldest unrevoked binding — the single-person reading kept for
   * status lines and fixtures; inbound, delivery and notices read
   * `bindingFor` / `bindingById` / `bindings`. */
  binding(installation: string): ChatBinding | null {
    return this.bindings(installation)[0] ?? null;
  }
  live(binding: ChatBinding): boolean {
    const current = this.bindingById(binding.id);
    const account = this.store.accountOf(binding.approver);
    return (
      current !== null &&
      account?.role === "approver" &&
      account.revokedAt === null &&
      account.generation === binding.generation
    );
  }
  /** End one person's pairing and everything their chat could still do; teammates' bindings stay. */
  revokeBinding(binding: ChatBinding, now = new Date()): void {
    this.store.transact(() => {
      this.prepare("UPDATE chat_binding SET revoked=? WHERE id=? AND revoked IS NULL").run(now.toISOString(), binding.id);
      this.prepare(
        "UPDATE chat_event SET state='dropped',payload='{}',problem='Chat disconnected' WHERE binding=? AND state='queued'",
      ).run(binding.id);
      this.prepare(
        "UPDATE chat_part SET state='dropped',problem='Chat disconnected' WHERE state='pending' AND event IN (SELECT id FROM chat_event WHERE binding=?)",
      ).run(binding.id);
    });
  }
  revoke(installation: string, now = new Date()): void {
    this.store.transact(() => {
      this.prepare(
        "UPDATE chat_binding SET revoked=? WHERE installation=? AND revoked IS NULL",
      ).run(now.toISOString(), installation);
      this.prepare(
        "UPDATE chat_pair SET consumed=? WHERE installation=? AND consumed IS NULL",
      ).run(now.toISOString(), installation);
      this.prepare(
        "UPDATE chat_event SET state='dropped',payload='{}',problem='Chat disconnected' WHERE installation=? AND state='queued'",
      ).run(installation);
      this.prepare(
        "UPDATE chat_part SET state='dropped',problem='Chat disconnected' WHERE state='pending' AND event IN (SELECT id FROM chat_event WHERE installation=?)",
      ).run(installation);
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
      // A fresh code replaces this person's outstanding ones; a teammate's pending code is theirs.
      this.prepare(
        "UPDATE chat_pair SET consumed=? WHERE installation=? AND approver=? AND consumed IS NULL",
      ).run(now.toISOString(), installation, approver);
      this.prepare("INSERT INTO chat_pair VALUES(?,?,?,?,?,NULL)").run(
        chatHash(code),
        installation,
        approver,
        generation,
        new Date(now.getTime() + 600_000).toISOString(),
      );
    });
    return code;
  }
  pair(
    identity: ChatIdentity,
    hash: string,
    member: string,
    channel: string,
    now: Date,
  ): ChatBinding | null {
    return this.store.transact(() => {
      const pair = this.prepare(
        "SELECT approver,generation FROM chat_pair WHERE hash=? AND installation=? AND consumed IS NULL AND expires>?",
      ).get(hash, identity.installation, now.toISOString());
      if (!pair) return null;
      // One binding per channel member, and one channel identity per person.
      if (this.bindingFor(identity.installation, member)) return null;
      if (this.bindings(identity.installation).some(one => one.approver === String(pair.approver) && this.live(one))) return null;
      const account = this.store.accountOf(String(pair.approver));
      if (
        account?.role !== "approver" ||
        account.revokedAt !== null ||
        account.generation !== Number(pair.generation)
      )
        return null;
      this.prepare("UPDATE chat_pair SET consumed=? WHERE hash=?").run(
        now.toISOString(),
        hash,
      );
      this.prepare(
        "INSERT INTO chat_binding(installation,team,app,member,channel,approver,generation,created) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        identity.installation,
        identity.team ?? identity.app,
        identity.app,
        member,
        channel,
        String(pair.approver),
        Number(pair.generation),
        now.toISOString(),
      );
      // The installation's notice cursor starts from now on its FIRST pairing;
      // a later person joins the running cursor (their own history is fenced
      // by their binding's creation time).
      this.prepare(
        "INSERT OR IGNORE INTO chat_runtime(installation, notification) VALUES(?, (SELECT COALESCE(MAX(id),0) FROM notification))",
      ).run(identity.installation);
      return this.bindingFor(identity.installation, member);
    });
  }
  enqueue(event: Omit<ChatEvent, "session" | "state" | "next_at">): boolean {
    return (
      Number(
        this.prepare(
          "INSERT OR IGNORE INTO chat_event(id,installation,binding,kind,channel,member,ts,thread,payload,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
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
  event(id: string): ChatEvent | null {
    return (
      (this.prepare("SELECT * FROM chat_event WHERE id=?").get(id) as
        | ChatEvent
        | undefined) ?? null
    );
  }
  next(installation: string, now: Date): ChatEvent | null {
    return (
      (this.prepare(
        "SELECT * FROM chat_event WHERE installation=? AND state='queued' AND (next_at IS NULL OR next_at<=?) ORDER BY created,id LIMIT 1",
      ).get(installation, now.toISOString()) as ChatEvent | undefined) ?? null
    );
  }
  defer(event: string, problem: string, until: Date): void {
    this.prepare(
      "UPDATE chat_event SET next_at=?,problem=? WHERE id=? AND state='queued'",
    ).run(until.toISOString(), problem, event);
  }
  finish(event: string, dropped = false): void {
    this.prepare("UPDATE chat_event SET state=?,payload='{}' WHERE id=?").run(
      dropped ? "dropped" : "done",
      event,
    );
  }
  part(id: number): ChatPart | null {
    return (
      (this.prepare("SELECT * FROM chat_part WHERE id=?").get(id) as
        | ChatPart
        | undefined) ?? null
    );
  }
  plan(event: string, parts: ChatContent[], now: Date): void {
    this.store.transact(() => {
      for (const [ordinal, part] of parts.entries()) {
        const inserted = this.prepare(
          "INSERT OR IGNORE INTO chat_part(event,ordinal,payload,created) VALUES(?,?,?,?)",
        ).run(event, ordinal, JSON.stringify(part), now.toISOString());
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
    this.prepare(
      "UPDATE chat_action SET consumed=? WHERE part=? AND consumed IS NULL",
    ).run(now.toISOString(), part);
    for (const phase of phases)
      this.prepare("INSERT INTO chat_action VALUES(?,?,?,?,?,NULL)").run(
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
    this.prepare(
      "INSERT OR IGNORE INTO chat_runtime(installation) VALUES(?)",
    ).run(installation);
    return (
      Number(
        this.prepare(
          "UPDATE chat_runtime SET owner=?,lease_until=? WHERE installation=? AND (owner=? OR lease_until IS NULL OR lease_until<=?)",
        ).run(
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
    return !!this.prepare(
      "SELECT 1 FROM chat_runtime WHERE installation=? AND owner=? AND lease_until>?",
    ).get(installation, owner, now.toISOString());
  }
}

export const chatSchema = (channel: "slack" | "discord"): string =>
  CHAT_SCHEMA.replaceAll("chat_", `${channel}_`);
export const chatTables = (channel: "slack" | "discord"): string[] =>
  CHAT_TABLES.map((name) => name.replace("chat_", `${channel}_`));
export class ChatDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryMs = 5000,
    readonly uncertain = false,
  ) {
    super(code);
  }
}
