import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { object } from "./latch.ts";
import type { Turn } from "./requests.ts";

function uid(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid_plow_identity");
  return value;
}

type Chat = { uid: string; name: string; participants: Record<string, unknown>[] };
type Owner = { uid: string; handle?: string };
function handle(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const compact = value.trim().replace(/[\s()-]/g, "");
  return /^\+\d{10,15}$/.test(compact) ? compact : value.trim().toLowerCase();
}
function sameOwner(participant: Record<string, unknown>, owner: Owner): boolean {
  return participant.type === "member" && participant.role === "owner" && owner.handle !== undefined
    && handle(participant.provider_key) === owner.handle;
}

/** Only deployment credentials and authenticated Plow records supply authority. */
export class Plow {
  private readonly base: string;
  private readonly token: string;
  private line: Promise<string> | undefined;
  private readonly pages = new Map<string, { time: number; value: Promise<unknown> }>();
  private readonly keys = new Map<string, Promise<string>>();
  constructor(base: string, token: string) { this.base = base.replace(/\/$/, ""); this.token = token; }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.base || !this.token) throw new Error("plow_credentials_unavailable");
    const response = await fetch(this.base + "/v1" + path, { redirect: "error",
      headers: { Authorization: `Bearer ${this.token}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`plow_http_${response.status}`);
    return response.json();
  }

  private async lineUid(signal?: AbortSignal): Promise<string> {
    this.line ??= this.get("/agents/me", signal).then(value => {
      if (!object(value) || !object(value.line)) throw new Error("invalid_plow_identity");
      return uid(value.line.uid);
    }).catch(error => { this.line = undefined; throw error; });
    return this.line;
  }

  private async chat(id: string, signal?: AbortSignal): Promise<Chat> {
    const value = await this.get("/chats/" + uid(id), signal);
    const line = await this.lineUid(signal);
    if (!object(value) || value.uid !== id || value.status !== "active" || !Array.isArray(value.participants)
      || !value.participants.every(object) || !value.participants.some(p => p.type === "agent"
        && p.relationship === "self" && object(p.line) && p.line.uid === line)) throw new Error("chat_not_served_by_this_agent");
    return { uid: id, name: typeof value.display_name === "string" ? value.display_name : id, participants: value.participants };
  }

  private async source(turn: Turn, chat: Chat, signal?: AbortSignal, fresh = false): Promise<Record<string, unknown>> {
    let cursor: string | undefined;
    for (let page = 0; page < 82; page++) {
      const path = `/chats/${uid(turn.chat)}/messages?limit=50${cursor ? "&starting_after=" + uid(cursor) : ""}`;
      const cached = this.pages.get(path);
      let request = !fresh && cached && Date.now() - cached.time < 1000 ? cached.value : undefined;
      if (!request) {
        request = this.get(path, signal).catch(error => { this.pages.delete(path); throw error; });
        this.pages.set(path, { time: Date.now(), value: request });
        if (this.pages.size > 256) { const oldest = this.pages.keys().next().value; if (oldest) this.pages.delete(oldest); }
      }
      const value = await request;
      if (!object(value) || !Array.isArray(value.data) || !value.data.every(object)) throw new Error("invalid_plow_messages");
      const source = value.data.find(row => row.uid === turn.message);
      if (source) {
        const sender = source.sender;
        if (source.direction !== "inbound" || (source.chat_uid !== undefined && source.chat_uid !== turn.chat)
          || !object(sender) || sender.type !== "member" || source.body !== turn.prompt
          || typeof source.body !== "string" || source.body.length > 8000 || typeof source.created_at !== "string"
          || !chat.participants.some(p => p.type === "member" && p.uid === sender.uid)) throw new Error("verified_inbound_member_required");
        const age = Date.now() - Date.parse(source.created_at);
        if (!Number.isFinite(age) || age < -60_000 || age > 3_600_000) throw new Error("source_message_expired_or_invalid");
        return { uid: uid(source.uid), chat_uid: turn.chat, direction: "inbound",
          sender: { type: "member", uid: uid(sender.uid) }, body: source.body, created_at: source.created_at };
      }
      if (!value.has_more || !value.data.length) break;
      const next = uid(value.data.at(-1)?.uid);
      if (next === cursor) break;
      cursor = next;
    }
    if (!fresh) return this.source(turn, chat, signal, true);
    throw new Error("original_message_not_found");
  }

  async group(turn: Turn, signal?: AbortSignal): Promise<void> {
    const chat = await this.chat(turn.chat, signal);
    if (chat.participants.length <= 2) throw new Error("chat_not_served_by_this_agent");
  }

  async owner(turn: Turn, signal?: AbortSignal): Promise<Owner> {
    if (!turn.owner || turn.session !== "agent:main:main") throw new Error("owner_main_dm_required");
    const chat = await this.chat(turn.chat, signal);
    const source = await this.source(turn, chat, signal);
    const sender = source.sender;
    if (chat.participants.length !== 2 || !object(sender)
      || !chat.participants.some(p => p.type === "member" && p.role === "owner" && p.uid === sender.uid)) throw new Error("owner_main_dm_required");
    const participant = chat.participants.find(p => p.type === "member" && p.role === "owner" && p.uid === sender.uid);
    return { uid: uid(sender.uid), handle: handle(participant?.provider_key) };
  }

  async groups(turn: Turn, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const owner = await this.owner(turn, signal);
    if (!owner.handle) throw new Error("owner_handle_unavailable");
    const line = await this.lineUid(signal);
    const groups: { uid: string; name: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const value = await this.get("/chats?limit=100" + (cursor ? "&starting_after=" + uid(cursor) : ""), signal);
      if (!object(value) || !Array.isArray(value.data) || !value.data.every(object)) throw new Error("invalid_plow_chats");
      for (const chat of value.data) if (chat.status === "active" && Array.isArray(chat.participants) && chat.participants.every(object)
        && chat.participants.length > 2 && chat.participants.some(p => sameOwner(p, owner))
        && chat.participants.some(p => p.type === "agent" && p.relationship === "self" && object(p.line) && p.line.uid === line)) {
        groups.push({ uid: uid(chat.uid), name: typeof chat.display_name === "string" ? chat.display_name : uid(chat.uid) });
      }
      if (!value.has_more || !value.data.length) return { groups };
      const next = uid(value.data.at(-1)?.uid);
      if (next === cursor) break;
      cursor = next;
    }
    throw new Error("group_listing_truncated");
  }

  async share(turn: Turn, group: string | undefined, signal?: AbortSignal): Promise<string[]> {
    const owner = await this.owner(turn, signal);
    if (!group) return [turn.chat];
    const chat = await this.chat(group, signal);
    if (chat.participants.length <= 2 || !chat.participants.some(p => sameOwner(p, owner))) throw new Error("owner_and_agent_must_be_in_group");
    return [turn.chat, group];
  }

  async sourceKey(directory: string): Promise<string> {
    let key = this.keys.get(directory);
    if (!key) {
      key = (async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, "source.key");
        try { await writeFile(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
        const value = await readFile(path, "utf8");
        if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_source_key");
        return value;
      })();
      this.keys.set(directory, key);
    }
    return key;
  }

  async proof(turn: Turn, directory: string, signal?: AbortSignal): Promise<string[]> {
    const source = await this.source(turn, await this.chat(turn.chat, signal), signal);
    const proof = Buffer.from(JSON.stringify(source)).toString("base64url");
    const signature = createHmac("sha256", Buffer.from(await this.sourceKey(directory), "hex")).update(proof).digest("hex");
    return ["--source", proof, "--signature", signature];
  }
}
