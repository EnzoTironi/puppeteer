import { createHash } from "node:crypto";
import { join } from "node:path";
import { object } from "./latch.ts";
import type { Plow } from "./plow.ts";
import type { Requests, Turn } from "./requests.ts";
import type { Outbound } from "./outbound.ts";
import { promptCommand } from "./replies.ts";
import { readJson, withLock, writeJson } from "./store.ts";

type Asked = "new" | "sending" | "sent" | "uncertain";
type Question = { id: string; chat: string; message: string; sender: string; text: string; askedAt: string; asked: Asked;
  answer: { kind: "pending" | "expired" } | { kind: "sending" | "sent" | "uncertain"; text: string; message: string } };

function parse(value: unknown): Question {
  if (!object(value) || typeof value.id !== "string" || !/^[a-f0-9]{32}$/.test(value.id)
    || typeof value.chat !== "string" || !/^cht_[A-Za-z0-9_-]+$/.test(value.chat)
    || typeof value.message !== "string" || typeof value.sender !== "string" || typeof value.text !== "string"
    || !value.text.trim() || value.text.length > 500 || typeof value.askedAt !== "string" || !Number.isFinite(Date.parse(value.askedAt))
    || !object(value.answer)) throw new Error("invalid_question_state");
  const asked = value.asked, answer = value.answer;
  if (asked !== "new" && asked !== "sending" && asked !== "sent" && asked !== "uncertain") throw new Error("invalid_question_state");
  const expected = createHash("sha256").update("question\0" + value.chat + "\0" + value.message).digest("hex").slice(0, 32);
  if (expected !== value.id) throw new Error("invalid_question_state");
  const base: Omit<Question, "answer"> = { id: value.id, chat: value.chat, message: value.message, sender: value.sender, text: value.text, askedAt: value.askedAt, asked };
  if (answer.kind === "pending" || answer.kind === "expired") return { ...base, answer: { kind: answer.kind } };
  if ((answer.kind === "sending" || answer.kind === "sent" || answer.kind === "uncertain")
    && typeof answer.text === "string" && typeof answer.message === "string") return { ...base, answer: { kind: answer.kind, text: answer.text, message: answer.message } };
  throw new Error("invalid_question_state");
}

export class Questions {
  private readonly file: string;
  private readonly plow: Plow;
  private readonly requests: Requests;
  private readonly send: Outbound;
  constructor(plow: Plow, requests: Requests, directory: string, send: Outbound) {
    this.plow = plow; this.requests = requests; this.send = send; this.file = join(directory, "questions.json");
  }
  private async read(): Promise<Question[]> {
    const value = await readJson(this.file);
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("invalid_question_state");
    return value.map(parse);
  }
  async pending(): Promise<Question[]> {
    return (await this.read()).filter(q => q.answer.kind === "pending" && Date.now() - Date.parse(q.askedAt) < 172_800_000);
  }
  async ask(turn: Turn): Promise<Record<string, unknown>> {
    const command = promptCommand(turn.prompt);
    if (command.kind !== "owner_question") throw new Error("owner_question_required");
    await this.plow.verify(turn); await this.plow.group(turn); await this.requests.shared(turn.chat);
    turn.assertCurrent?.();
    return withLock(this.file, async () => {
      const rows = await this.read(), id = createHash("sha256").update("question\0" + turn.chat + "\0" + turn.message).digest("hex").slice(0, 32);
      const existing = rows.find(q => q.id === id);
      if (existing) return { silent: true, question: id, ownerAskSent: existing.asked === "sent", pending: true };
      if (rows.some(q => q.chat === turn.chat && q.answer.kind === "pending" && Date.now() - Date.parse(q.askedAt) < 172_800_000)) return { silent: true, pending: true, ownerAskSent: false };
      const owner = await this.plow.ownerDm();
      turn.assertCurrent?.();
      const row: Question = { id, chat: turn.chat, message: turn.message, sender: (turn.sender ?? "A participant").replace(/[\p{C}]/gu, " ").trim().slice(0, 40),
        text: command.question, askedAt: new Date().toISOString(), asked: "sending", answer: { kind: "pending" } };
      rows.push(row); await writeJson(this.file, rows);
      try {
        turn.assertCurrent?.();
        await this.send(owner.chat, `${row.sender} asks about your shared coding workspace:\n\n${row.text}\n\nAnswer here and I'll relay only your answer to the same group.`, "direct");
        row.asked = "sent";
      } catch { row.asked = "uncertain"; }
      await writeJson(this.file, rows);
      return { silent: true, question: id, ownerAskSent: row.asked === "sent", pending: true };
    });
  }
  async answer(turn: Turn, id: string, askedAt: string, text: string): Promise<Record<string, unknown>> {
    await this.plow.owner(turn);
    if (!text.trim() || text.length > 1500 || !turn.prompt.includes(text)) throw new Error("answer_must_quote_current_owner_message");
    return withLock(this.file, async () => {
      const rows = await this.read();
      const row = rows.find(q => q.id === id && q.askedAt === askedAt);
      if (!row) throw new Error("question_not_found");
      if (row.answer.kind === "sent") return { answered: true, sent: true };
      if (row.answer.kind !== "pending") throw new Error("question_delivery_unknown_or_expired");
      if (Date.now() - Date.parse(row.askedAt) >= 172_800_000) throw new Error("question_expired");
      await this.requests.shared(row.chat); await this.plow.share(turn, row.chat);
      turn.assertCurrent?.();
      row.answer = { kind: "sending", text, message: turn.message }; await writeJson(this.file, rows);
      try {
        turn.assertCurrent?.();
        await this.send(row.chat, `${row.sender}, the Mac owner replied:\n\n${text}`, "group");
        row.answer = { kind: "sent", text, message: turn.message };
      } catch { row.answer = { kind: "uncertain", text, message: turn.message }; }
      await writeJson(this.file, rows);
      return { answered: row.answer.kind === "sent", sent: row.answer.kind === "sent", deliveryUnknown: row.answer.kind === "uncertain" };
    });
  }
  async recover(): Promise<void> {
    await withLock(this.file, async () => {
      const rows = await this.read();
      for (const row of rows) {
        if (row.asked === "sending") row.asked = "uncertain";
        if (row.answer.kind === "sending") row.answer = { ...row.answer, kind: "uncertain" };
        if (row.answer.kind === "pending" && Date.now() - Date.parse(row.askedAt) >= 172_800_000) row.answer = { kind: "expired" };
      }
      if (rows.length) await writeJson(this.file, rows);
    });
  }
}
