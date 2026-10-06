import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Latch, object } from "./latch.ts";

export type Turn = { chat: string; message: string; session: string; prompt: string };
type Action = { kind: "agents" } | { kind: "ask"; alias: string };
type Stage =
  | { kind: "unknown"; error: string }
  | { kind: "pending"; handle: string; reason: string }
  | { kind: "running"; handle: string; output: string; offset: number }
  | { kind: "done"; value: Record<string, unknown> };
type Operation = { chat: string; message: string; created: number; action: Action; stage: Stage };

function parseOperation(value: unknown): Operation {
  if (!object(value) || typeof value.chat !== "string" || typeof value.message !== "string" || typeof value.created !== "number" || !object(value.action) || !object(value.stage)) throw new Error("invalid_request_state");
  let action: Action;
  if (value.action.kind === "agents") action = { kind: "agents" };
  else if (value.action.kind === "ask" && typeof value.action.alias === "string") action = { kind: "ask", alias: value.action.alias };
  else throw new Error("invalid_request_state");
  let stage: Stage;
  const s = value.stage;
  if (s.kind === "unknown" && typeof s.error === "string") stage = { kind: s.kind, error: s.error };
  else if (s.kind === "pending" && typeof s.handle === "string" && typeof s.reason === "string") stage = { kind: s.kind, handle: s.handle, reason: s.reason };
  else if (s.kind === "running" && typeof s.handle === "string" && typeof s.output === "string" && typeof s.offset === "number") stage = { kind: s.kind, handle: s.handle, output: s.output, offset: s.offset };
  else if (s.kind === "done" && object(s.value)) stage = { kind: s.kind, value: s.value };
  else throw new Error("invalid_request_state");
  return { chat: value.chat, message: value.message, created: value.created, action, stage };
}

function bridgeValue(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").at(-1);
  const value: unknown = JSON.parse(line ?? "null");
  if (!object(value)) throw new Error("invalid_bridge_response");
  if (typeof value.error === "string") return { error: value.error };
  if (Array.isArray(value.agents)) {
    return { agents: value.agents.map(row => {
      if (!object(row) || typeof row.alias !== "string" || typeof row.backend !== "string" || typeof row.status !== "string") throw new Error("invalid_bridge_response");
      return { alias: row.alias, backend: row.backend, status: row.status };
    }) };
  }
  if (typeof value.request !== "string" || !/^[a-f0-9]{32}$/.test(value.request) || typeof value.agent !== "string" || !["dispatching", "submitted", "delivery_unknown", "replied", "not_ready", "send_failed", "timed_out"].includes(String(value.status))) throw new Error("invalid_bridge_response");
  if (value.status === "replied" && typeof value.reply !== "string") throw new Error("invalid_bridge_response");
  return { request: value.request, agent: value.agent, status: value.status, ...(value.status === "replied" ? { reply: value.reply } : {}) };
}

export class Requests {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly latch: Latch;
  private readonly directory: string;
  private readonly paths: { read: string[]; write: string[] };
  constructor(latch: Latch, directory = "/var/lib/plow/puppeteer", paths = {
    read: ["~/.config/puppeteer", "~/.config/mypeople", "~/.config/plow/token", "~/.local/share/mypeople", "~/.local/share/uv/tools/puppeteer-bridge"],
    write: ["~/.local/share/mypeople"],
  }) {
    this.latch = latch;
    this.directory = directory;
    this.paths = paths;
  }

  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }

  private async read(id: string): Promise<Operation | undefined> {
    try { return parseOperation(JSON.parse(await readFile(join(this.directory, id + ".json"), "utf8"))); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  }

  private async save(id: string, op: Operation): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, id + ".json");
    const temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(op), { mode: 0o600 });
    await rename(temporary, path);
  }

  private view(id: string, op: Operation): Record<string, unknown> {
    const s = op.stage;
    switch (s.kind) {
      case "unknown": return { request: id, status: "delivery_unknown", error: s.error };
      case "pending": return { request: id, status: s.reason === "awaiting_approval" ? "awaiting_approval" : "pending", reason: s.reason };
      case "running": return { request: id, status: "running" };
      case "done": return { ...s.value, request: id };
    }
  }

  private settle(payload: Record<string, unknown>, previousOutput = ""): Stage {
    if (payload.status === "pending" && typeof payload.handle === "string") return { kind: "pending", handle: payload.handle, reason: typeof payload.reason === "string" ? payload.reason : "running" };
    if (payload.status === "ready" && object(payload.result)) return this.settle(payload.result);
    if (payload.status === "running" && typeof payload.handle === "string") return {
      kind: "running", handle: payload.handle, output: previousOutput + (typeof payload.output === "string" ? payload.output : typeof payload.stdout === "string" ? payload.stdout : ""),
      offset: typeof payload.output_length === "number" ? payload.output_length : 0,
    };
    if (["denied", "blocked", "failed", "expired", "unknown"].includes(String(payload.status))) return { kind: "done", value: {
      error: `latch_${payload.status}`, ...(object(payload.diagnosis) && typeof payload.diagnosis.owner_action === "string" ? { owner_action: payload.diagnosis.owner_action } : {}),
    } };
    const output = previousOutput + (typeof payload.stdout === "string" ? payload.stdout : typeof payload.output === "string" ? payload.output : "");
    if (output.length > 128_000) throw new Error("bridge_output_too_large");
    return { kind: "done", value: bridgeValue(output) };
  }

  private async command(id: string, op: Operation, argv: string[], signal?: AbortSignal): Promise<void> {
    op.stage = { kind: "unknown", error: "latch_delivery_unknown" };
    await this.save(id, op);
    try {
      const payload = await this.latch.call("plow_run_command", {
        argv: ["puppeteer-bridge", ...argv], network: argv[0] === "ask", read_paths: this.paths.read,
        ...(argv[0] !== "agents" ? { write_paths: this.paths.write } : {}),
        wait_ms: 1000, goal: `Puppeteer: ${argv[0]} in approved conversation ${op.chat}`,
      }, signal);
      op.stage = this.settle(payload);
    } catch (error) {
      op.stage = { kind: "unknown", error: error instanceof Error ? error.message : "latch_failed" };
    }
    await this.save(id, op);
  }

  async agents(turn: Turn, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = randomUUID().replaceAll("-", "");
    const op: Operation = { chat: turn.chat, message: turn.message, created: Date.now(), action: { kind: "agents" }, stage: { kind: "unknown", error: "not_started" } };
    await this.command(id, op, ["agents", "--chat", turn.chat], signal);
    return this.view(id, op);
  }

  async ask(turn: Turn, alias: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(alias)) throw new Error("invalid_agent_alias");
    if (!/^\/prompt[ \t\r\n]+\S/.test(turn.prompt)) throw new Error("prompt_text_required");
    const id = createHash("sha256").update(turn.chat + "\0" + turn.message).digest("hex").slice(0, 32);
    return this.exclusive(id, async () => {
      const previous = await this.read(id);
      if (previous) {
        if (previous.action.kind !== "ask" || previous.action.alias !== alias) throw new Error("source_message_already_routed_to_another_agent");
        if (previous.stage.kind === "done" && typeof previous.stage.value.request === "string") {
          await this.command(id, previous, ["result", previous.stage.value.request, "--chat", turn.chat, "--wait", "15"], signal);
        }
        return this.view(id, previous);
      }
      const op: Operation = { chat: turn.chat, message: turn.message, created: Date.now(), action: { kind: "ask", alias }, stage: { kind: "unknown", error: "not_started" } };
      await this.command(id, op, ["ask", "--chat", turn.chat, "--message", turn.message, "--agent", alias], signal);
      return this.view(id, op);
    });
  }

  async result(turn: Turn, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("request_not_shared");
    return this.exclusive(id, async () => {
      const op = await this.read(id);
      if (!op || op.chat !== turn.chat) throw new Error("request_not_shared");
      if (Date.now() - op.created > 900_000) return { request: id, status: "timed_out" };
      const stage = op.stage;
      try {
        if (stage.kind === "pending") op.stage = this.settle(await this.latch.call("plow_get_result", { handle: stage.handle }, signal));
        else if (stage.kind === "running") op.stage = this.settle(await this.latch.call("plow_get_output", { handle: stage.handle, since: stage.offset }, signal), stage.output);
        else if (stage.kind === "done" && typeof stage.value.request === "string") {
          await this.command(id, op, ["result", stage.value.request, "--chat", turn.chat, "--wait", "15"], signal);
        }
      } catch { return { request: id, status: "pending", error: "latch_poll_failed" }; }
      await this.save(id, op);
      return this.view(id, op);
    });
  }
}
