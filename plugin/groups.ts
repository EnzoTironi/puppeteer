import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { object } from "./latch.ts";
import { Requests, type Turn } from "./requests.ts";
import { Plow } from "./plow.ts";
import { promptCommand, promptHelp, publicReply } from "./replies.ts";
import { withLock, writeJson } from "./store.ts";
import type { Questions } from "./questions.ts";

type Delivery = "new" | "sending" | "sent" | "uncertain";
type Job = { turn: Turn; created: number; announcement: Delivery; approval: Delivery; final: Delivery };
export type GroupDelivery = (chat: string, text: string) => Promise<unknown>;

/** The channel owns these fixed receipt operations. Audience text never selects a tool or route. */
export class Groups {
  private readonly running = new Set<string>();
  private readonly receiving = new Set<string>();
  private active = 0;
  private readonly slots: Array<() => void> = [];
  private readonly directory: string;
  private readonly requests: Requests;
  private readonly plow: Plow;
  private readonly questions: Questions | undefined;
  constructor(requests: Requests, plow: Plow, directory: string, questions?: Questions) {
    this.requests = requests;
    this.plow = plow;
    this.directory = join(directory, "groups");
    this.questions = questions;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 4) await new Promise<void>(resolve => this.slots.push(resolve));
    else this.active++;
    try { return await work(); }
    finally { const next = this.slots.shift(); if (next) next(); else this.active--; }
  }

  private id(turn: Turn): string { return createHash("sha256").update(turn.chat + "\0" + turn.message).digest("hex").slice(0, 32); }
  private async save(id: string, job: Job): Promise<void> {
    await writeJson(join(this.directory, id + ".json"), job);
  }
  private async read(id: string): Promise<Job | undefined> {
    if (!/^[a-f0-9]{32}$/.test(id)) return undefined;
    try {
      const job: unknown = JSON.parse(await readFile(join(this.directory, id + ".json"), "utf8"));
      if (!object(job) || !object(job.turn) || typeof job.turn.chat !== "string" || typeof job.turn.message !== "string"
        || typeof job.turn.prompt !== "string" || typeof job.turn.session !== "string" || typeof job.created !== "number"
        || !["new", "sending", "sent", "uncertain"].includes(String(job.announcement))
        || !["new", "sending", "sent", "uncertain"].includes(String(job.final))) throw new Error("invalid_group_job");
      const delivery = (value: unknown): Delivery => {
        if (value === "new" || value === "sending" || value === "sent" || value === "uncertain") return value;
        throw new Error("invalid_group_job");
      };
      if (this.id({ chat: job.turn.chat, message: job.turn.message, session: job.turn.session, prompt: job.turn.prompt }) !== id) throw new Error("invalid_group_job");
      return { turn: { chat: job.turn.chat, message: job.turn.message, prompt: job.turn.prompt, session: job.turn.session,
        ...(typeof job.turn.sender === "string" ? { sender: job.turn.sender } : {}), background: true }, created: job.created,
        announcement: delivery(job.announcement), approval: job.approval === undefined ? "new" : delivery(job.approval), final: delivery(job.final) };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async deliver(id: string, job: Job, part: "announcement" | "approval" | "final", result: Record<string, unknown>, send: GroupDelivery): Promise<void> {
    if (job[part] !== "new") return;
    job[part] = "sending";
    await this.save(id, job);
    try { await send(job.turn.chat, publicReply(result, job.turn)); job[part] = "sent"; }
    catch { job[part] = "uncertain"; }
    await this.save(id, job);
  }

  private async tick(id: string, send: GroupDelivery, signal: AbortSignal): Promise<boolean> {
    return withLock(join(this.directory, id + ".json"), async () => {
      const job = await this.read(id);
      if (!job || job.final !== "new") {
        if (job?.final === "sending") { job.final = "uncertain"; await this.save(id, job); }
        return true;
      }
      if (job.announcement === "sending" || job.approval === "sending") {
        if (job.announcement === "sending") job.announcement = "uncertain";
        if (job.approval === "sending") job.approval = "uncertain";
        await this.save(id, job);
      }
      const turn: Turn = { ...job.turn, assertCurrent() { signal.throwIfAborted(); } };
      let result: Record<string, unknown>;
      try {
        result = await this.limited(async () => {
          await this.plow.group(turn, signal);
          return job.announcement === "new" && Date.now() - job.created < 900_000
            ? this.requests.ask(turn, "coder", signal) : this.requests.result(turn, id, signal, 0);
        });
      } catch (error) {
        signal.throwIfAborted();
        const message = error instanceof Error ? error.message : "group_result_failed";
        if (["chat_not_served_by_this_agent", "request_not_shared", "chat_not_shared"].includes(message)) {
          job.final = "uncertain"; await this.save(id, job); return true;
        }
        if (Date.now() - job.created <= 900_000) return false;
        result = { request: id, status: "timed_out" };
      }
      signal.throwIfAborted();
      if ((!result.error || result.error === "latch_poll_failed") && ["queued", "submitted", "dispatching", "pending", "running", "awaiting_approval"].includes(String(result.status))) {
        if (job.announcement === "new") {
          await this.deliver(id, job, "announcement", result, send);
          if (result.status === "awaiting_approval") { job.approval = job.announcement; await this.save(id, job); }
        }
        if (result.status === "awaiting_approval") await this.deliver(id, job, "approval", result, send);
        return false;
      }
      await this.deliver(id, job, "final", result, send);
      return true;
    }, signal);
  }

  private async watch(id: string, job: Job, send: GroupDelivery, parentSignal: AbortSignal): Promise<void> {
    if (this.running.has(id) || job.final !== "new") return;
    this.running.add(id);
    const signal = AbortSignal.any([parentSignal]);
    try {
      while (!signal.aborted) {
        if (await this.tick(id, send, signal)) return;
        const delay = Number(process.env.PUPPETEER_GROUP_POLL_MS ?? 3000);
        await this.pause(signal, Number.isFinite(delay) ? Math.max(20, Math.min(delay, 10_000)) : 3000);
      }
    } catch {
      // A failed delivery remains durable. Never automatically repeat an uncertain phone send.
    } finally { this.running.delete(id); }
  }

  private async pause(signal: AbortSignal, delay: number): Promise<void> {
    await new Promise<void>(resolve => {
      const finish = (): void => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, delay);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }

  async receive(turn: Turn, send: GroupDelivery, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    turn = { ...turn, assertCurrent() { signal.throwIfAborted(); } };
    const command = promptCommand(turn.prompt);
    if (command.kind === "help") { await send(turn.chat, promptHelp); return; }
    if (command.kind === "invalid_status") { await send(turn.chat, "Use /prompt status REQUEST_ID with the ID from the original reply."); return; }
    if (command.kind === "invalid_question") { await send(turn.chat, "Use /prompt ask owner followed by your question, up to 500 characters."); return; }
    if (command.kind === "owner_question") {
      // Private handoffs must remain private even when verification or delivery fails.
      try { await this.questions?.ask(turn); } catch { /* Owner status exposes the durable question state. */ }
      return;
    }
    if (command.kind === "agents" || command.kind === "status") {
      const result = await this.limited(() => command.kind === "agents" ? this.requests.agents(turn, signal)
        : this.requests.result(turn, command.request, signal, 0));
      const original = typeof result.request === "string" ? await this.read(result.request) : undefined;
      await send(turn.chat, publicReply(result, original?.turn.chat === turn.chat ? { ...original.turn, prompt: turn.prompt } : turn));
      return;
    }
    const id = this.id(turn);
    if (this.receiving.has(id)) return;
    this.receiving.add(id);
    try {
      await withLock(join(this.directory, id + ".json"), async () => {
      const existing = await this.read(id);
      if (existing) { void this.watch(id, existing, send, signal); return; }
      const job: Job = { turn: { chat: turn.chat, message: turn.message, session: turn.session, prompt: turn.prompt, sender: turn.sender, background: true },
        created: Date.now(), announcement: "new", approval: "new", final: "new" };
      await this.save(id, job);
      const result = await this.limited(() => this.requests.ask({ ...turn, assertCurrent() { signal.throwIfAborted(); } }, "coder", signal));
      if (!result.error && ["queued", "submitted", "dispatching", "pending", "running", "awaiting_approval"].includes(String(result.status))) {
        await this.deliver(id, job, "announcement", result, send);
        if (result.status === "awaiting_approval") { job.approval = job.announcement; await this.save(id, job); }
        void this.watch(id, job, send, signal);
      } else await this.deliver(id, job, "final", result, send);
      }, signal);
    } finally { this.receiving.delete(id); }
  }

  async recover(send: GroupDelivery, signal: AbortSignal): Promise<void> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
    for (const file of files.filter(name => /^[a-f0-9]{32}\.json$/.test(name))) {
      if (signal.aborted) return;
      const id = file.slice(0, -5), job = await this.read(id);
      if (job?.final === "new") void this.watch(id, job, send, signal);
      else if (job?.final === "sending") await this.tick(id, send, signal);
    }
  }

  async recoverOnce(send: GroupDelivery, signal: AbortSignal): Promise<{ examined: number; pending: number }> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { examined: 0, pending: 0 }; throw error; }
    let examined = 0, pending = 0;
    for (const file of files.filter(name => /^[a-f0-9]{32}\.json$/.test(name))) {
      signal.throwIfAborted();
      const id = file.slice(0, -5), job = await this.read(id);
      if (!job || !["new", "sending"].includes(job.final)) continue;
      examined++;
      if (!(await this.tick(id, send, signal))) pending++;
    }
    return { examined, pending };
  }
}
