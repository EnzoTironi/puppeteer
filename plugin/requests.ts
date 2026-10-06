import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Latch, object } from "./latch.ts";
import { Plow } from "./plow.ts";
import { promptCommand } from "./replies.ts";

export type Turn = { chat: string; message: string; session: string; prompt: string; sender?: string; background?: boolean; owner?: boolean; assertCurrent?: () => void; recordReply?: (result: Record<string, unknown>) => void };
export type Setup = { action: "install" | "inspect" | "groups" | "stop" } | { action: "demo"; group: string; target?: string }
  | { action: "share"; target: string; group?: string; project?: string; workers?: number };
type Action = { kind: "agents" } | { kind: "ask"; alias: string } | { kind: "install" } | { kind: "inspect" } | { kind: "stop" }
  | { kind: "demo"; group: string; target?: string }
  | { kind: "share"; target: string; chats: string[]; group?: string; project?: string; workers?: number; phase: "prepare" | "write" | "pair" };
type Stage =
  | { kind: "unknown"; error: string }
  | { kind: "pending"; handle: string; reason: string }
  | { kind: "running"; handle: string; output: string; offset: number }
  | { kind: "done"; value: Record<string, unknown> };
type Operation = { chat: string; message: string; created: number; action: Action; stage: Stage; guard?: () => void };

function parseOperation(value: unknown): Operation {
  if (!object(value) || typeof value.chat !== "string" || typeof value.message !== "string" || typeof value.created !== "number" || !object(value.action) || !object(value.stage)) throw new Error("invalid_request_state");
  let action: Action;
  if (value.action.kind === "agents") action = { kind: "agents" };
  else if (value.action.kind === "ask" && typeof value.action.alias === "string") action = { kind: "ask", alias: value.action.alias };
  else if (value.action.kind === "install" || value.action.kind === "inspect" || value.action.kind === "stop") action = { kind: value.action.kind };
  else if (value.action.kind === "demo" && typeof value.action.group === "string"
    && (value.action.target === undefined || typeof value.action.target === "string")) {
    action = { kind: "demo", group: value.action.group, target: value.action.target };
  }
  else if (value.action.kind === "share" && typeof value.action.target === "string" && Array.isArray(value.action.chats)
    && value.action.chats.every(c => typeof c === "string") && (value.action.group === undefined || typeof value.action.group === "string")
    && ["prepare", "write", "pair"].includes(String(value.action.phase))) {
    const phase = value.action.phase;
    if (phase !== "prepare" && phase !== "write" && phase !== "pair") throw new Error("invalid_request_state");
    action = { kind: "share", target: value.action.target, chats: value.action.chats, group: value.action.group, phase,
      ...(typeof value.action.project === "string" ? { project: value.action.project, workers: typeof value.action.workers === "number" ? value.action.workers : 4 } : {}) };
  }
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
  if (value.paused === true && typeof value.cancelled === "number" && typeof value.uncertain === "number") return { paused: true, cancelled: value.cancelled, uncertain: value.uncertain };
  if (value.pairing_prepared === true) return { pairing_prepared: true };
  if (value.configured === true && Array.isArray(value.chats) && value.chats.every(c => typeof c === "string")) return { configured: true, agents: ["coder"], chats: value.chats };
  if (value.demo_prepared === true && typeof value.target === "string" && typeof value.project === "string"
    && typeof value.boss_created === "boolean") {
    const nativeId = /^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
    if (!nativeId.test(value.target) || !nativeId.test(value.project)) throw new Error("invalid_bridge_response");
    return { demo_prepared: true, target: value.target, project: value.project, boss_created: value.boss_created, workers: 4, next: "share" };
  }
  if (Array.isArray(value.local_agents)) return { local_agents: value.local_agents.map(row => {
    if (!object(row) || typeof row.target !== "string" || typeof row.backend !== "string" || typeof row.status !== "string") throw new Error("invalid_bridge_response");
    return { target: row.target, backend: row.backend, status: row.status, ...(row.role === "boss" ? { role: "boss" } : {}) };
  }) };
  if (Array.isArray(value.agents)) {
    return { agents: value.agents.map(row => {
      if (!object(row) || typeof row.alias !== "string" || typeof row.backend !== "string" || typeof row.status !== "string") throw new Error("invalid_bridge_response");
      return { alias: row.alias, backend: row.backend, status: row.status };
    }), ...(value.mode === "parallel" && typeof value.workers === "number" ? { mode: "parallel", workers: value.workers } : {}) };
  }
  if (["busy", "queue_full"].includes(String(value.status)) && typeof value.agent === "string") return { status: value.status, agent: value.agent };
  if (typeof value.request !== "string" || !/^[a-f0-9]{32}$/.test(value.request) || typeof value.agent !== "string" || !["queued", "dispatching", "submitted", "delivery_unknown", "replied", "not_ready", "send_failed", "timed_out", "cancelled"].includes(String(value.status))) throw new Error("invalid_bridge_response");
  if (value.status === "replied" && typeof value.reply !== "string") throw new Error("invalid_bridge_response");
  return { request: value.request, agent: value.agent, status: value.status, ...(value.status === "replied" ? { reply: value.reply } : {}) };
}

export class Requests {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly latch: Latch;
  private readonly directory: string;
  private readonly paths: { read: string[]; write: string[] };
  private readonly plow: Plow | undefined;
  constructor(latch: Latch, directory = "/var/lib/plow/puppeteer", paths = {
    read: ["~/.config/puppeteer", "~/.config/mypeople", "~/.local/share/mypeople", "~/.local/share/uv/tools/puppeteer-bridge"],
    write: ["~/.local/share/mypeople"],
  }, plow?: Plow) {
    this.latch = latch;
    this.directory = directory;
    this.paths = paths;
    this.plow = plow;
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

  private settle(payload: Record<string, unknown>, op: Operation, previous?: Extract<Stage, { kind: "running" }>): Stage {
    const previousOutput = previous?.output ?? "";
    if (payload.status === "pending" && typeof payload.handle === "string") return { kind: "pending", handle: payload.handle, reason: typeof payload.reason === "string" ? payload.reason : "running" };
    if (payload.status === "ready" && object(payload.result)) return this.settle(payload.result, op, previous);
    if (payload.status === "running") {
      const handle = typeof payload.handle === "string" ? payload.handle : previous?.handle;
      if (!handle) throw new Error("latch_command_handle_missing");
      return {
        kind: "running", handle, output: previousOutput + (typeof payload.output === "string" ? payload.output : typeof payload.stdout === "string" ? payload.stdout : ""),
        offset: typeof payload.output_length === "number" ? payload.output_length : previous?.offset ?? 0,
      };
    }
    if (["denied", "blocked", "failed", "error", "expired", "unknown"].includes(String(payload.status))) return { kind: "done", value: {
      error: `latch_${payload.status}`, ...(object(payload.diagnosis) && typeof payload.diagnosis.owner_action === "string" ? { owner_action: payload.diagnosis.owner_action } : {}),
    } };
    if (op.action.kind === "install") {
      if (payload.status !== "completed" || payload.exit_code !== 0) return { kind: "done", value: { error: "connector_install_failed", owner_action: "Check that uv is installed and Latch allows the connector installation." } };
      return { kind: "done", value: { installed: true, next: "inspect" } };
    }
    if (op.action.kind === "share" && op.action.phase === "write") {
      if (typeof payload.bytes !== "number") throw new Error("pairing_write_unconfirmed");
      return { kind: "done", value: { pairing_written: true } };
    }
    const output = previousOutput + (typeof payload.stdout === "string" ? payload.stdout : typeof payload.output === "string" ? payload.output : "");
    if (output.length > 128_000) throw new Error("bridge_output_too_large");
    return { kind: "done", value: bridgeValue(output) };
  }

  private async send(id: string, op: Operation, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    op.guard?.();
    op.stage = { kind: "unknown", error: "latch_delivery_unknown" };
    await this.save(id, op);
    op.guard?.();
    try {
      op.stage = this.settle(await this.latch.call(name, args, signal), op);
    } catch (error) {
      op.stage = { kind: "unknown", error: error instanceof Error ? error.message : "latch_failed" };
    }
    await this.save(id, op);
  }

  private async command(id: string, op: Operation, argv: string[], signal?: AbortSignal): Promise<void> {
    await this.send(id, op, "plow_run_command", {
      argv: ["puppeteer-bridge", ...argv], network: argv[0] === "ask" || argv[0] === "demo", read_paths: this.paths.read,
      ...(argv[0] !== "agents" && argv[0] !== "discover" ? { write_paths: [...this.paths.write,
        ...(["prepare", "pair", "stop"].includes(argv[0] ?? "") ? ["~/.config/puppeteer"] : [])] } : {}),
      wait_ms: argv[0] === "result" ? 9000 : 1000, goal: `Puppeteer: ${argv[0]} in approved conversation ${op.chat}`,
    }, signal);
  }

  private async advance(id: string, op: Operation, signal?: AbortSignal): Promise<void> {
    while (op.action.kind === "share" && op.stage.kind === "done" && !op.stage.value.error && op.action.phase !== "pair") {
      if (op.action.phase === "prepare") {
        if (!this.plow) throw new Error("owner_setup_unavailable");
        op.action.phase = "write";
        await this.send(id, op, "plow_write_file", { path: `~/.config/puppeteer/pairing/${id}.json`,
          content: JSON.stringify({ target: op.action.target, chats: op.action.chats, source_key: await this.plow.sourceKey(this.directory),
            ...(op.action.project ? { parallel: { project: op.action.project, workers: op.action.workers ?? 4 } } : {}) }),
          goal: "Puppeteer: pair this deployment with the owner's selected MyPlow session and conversations",
        }, signal);
      } else {
        op.action.phase = "pair";
        await this.command(id, op, ["pair", "--request", id], signal);
      }
    }
  }

  async setup(turn: Turn, input: Setup, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.plow) throw new Error("owner_setup_unavailable");
    await this.plow.owner(turn, signal);
    if (input.action === "groups") return this.plow.groups(turn, signal);
    if ((input.action === "share" || input.action === "demo") && input.target !== undefined
      && !/^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(input.target)) throw new Error("invalid_local_agent_id");
    if (input.action === "demo") await this.plow.share(turn, input.group, signal);
    const chats = input.action === "share" ? await this.plow.share(turn, input.group, signal) : [];
    const id = createHash("sha256").update("setup\0" + turn.chat + "\0" + turn.message + "\0" + input.action).digest("hex").slice(0, 32);
    return this.exclusive(id, async () => {
      const previous = await this.read(id);
      if (previous) {
        if (previous.action.kind === "demo" && (input.action !== "demo" || previous.action.group !== input.group || previous.action.target !== input.target)) throw new Error("setup_message_already_used");
        if (previous.action.kind === "share" && (input.action !== "share" || previous.action.target !== input.target || previous.action.group !== input.group || previous.action.project !== input.project || previous.action.workers !== (input.project ? input.workers ?? 4 : undefined))) throw new Error("setup_message_already_used");
        return this.view(id, previous);
      }
      const action: Action = input.action === "share" ? { kind: "share", target: input.target, group: input.group, project: input.project, workers: input.project ? input.workers ?? 4 : undefined, chats, phase: "prepare" }
        : input.action === "demo" ? { kind: "demo", group: input.group, target: input.target }
          : input.action === "install" ? { kind: "install" } : input.action === "stop" ? { kind: "stop" } : { kind: "inspect" };
      const op: Operation = { chat: turn.chat, message: turn.message, created: Date.now(), action, stage: { kind: "unknown", error: "not_started" }, guard: turn.assertCurrent };
      if (input.action === "install") {
        const commit = process.env.PUPPETEER_BRIDGE_COMMIT;
        if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("connector_release_not_pinned");
        await this.send(id, op, "plow_run_command", {
          argv: ["uv", "tool", "install", "--force", "git+https://github.com/EnzoTironi/puppeteer.git@" + commit], network: true,
          read_paths: ["~/.config/mypeople"], write_paths: ["~/.local/bin", "~/.local/share/uv", "~/.cache/uv"], wait_ms: 1000,
          goal: "Puppeteer: install the pinned MIT MyPlow connector requested by the owner",
        }, signal);
      } else await this.command(id, op, input.action === "inspect" ? ["discover"] : input.action === "stop" ? ["stop"]
        : input.action === "demo" ? ["demo", "--group", input.group, ...(input.target ? ["--boss", input.target] : [])]
          : ["prepare", "--request", id], signal);
      await this.advance(id, op, signal);
      return this.view(id, op);
    });
  }

  async agents(turn: Turn, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = randomUUID().replaceAll("-", "");
    const op: Operation = { chat: turn.chat, message: turn.message, created: Date.now(), action: { kind: "agents" }, stage: { kind: "unknown", error: "not_started" }, guard: turn.assertCurrent };
    await this.command(id, op, ["agents", "--chat", turn.chat], signal);
    return this.view(id, op);
  }

  async ask(turn: Turn, alias: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(alias)) throw new Error("invalid_agent_alias");
    if (!/^\/prompt[ \t\r\n]+\S/.test(turn.prompt)) throw new Error("prompt_text_required");
    if (promptCommand(turn.prompt).kind !== "task") throw new Error("control_request_requires_matching_tool");
    const id = createHash("sha256").update(turn.chat + "\0" + turn.message).digest("hex").slice(0, 32);
    return this.exclusive(id, async () => {
      const previous = await this.read(id);
      if (previous) {
        previous.guard = turn.assertCurrent;
        if (previous.action.kind !== "ask" || previous.action.alias !== alias) throw new Error("source_message_already_routed_to_another_agent");
        if (previous.stage.kind === "done" && typeof previous.stage.value.request === "string") {
          await this.command(id, previous, ["result", previous.stage.value.request, "--chat", turn.chat, "--wait", "8"], signal);
        }
        return this.view(id, previous);
      }
      const op: Operation = { chat: turn.chat, message: turn.message, created: Date.now(), action: { kind: "ask", alias }, stage: { kind: "unknown", error: "not_started" }, guard: turn.assertCurrent };
      const proof = this.plow ? await this.plow.proof(turn, this.directory, signal) : [];
      await this.command(id, op, ["ask", "--chat", turn.chat, "--message", turn.message, "--agent", alias, ...proof], signal);
      return this.view(id, op);
    });
  }

  private async resolveRequest(chat: string, id: string): Promise<string> {
    if (!/^(?:[a-f0-9]{8}|[a-f0-9]{32})$/.test(id)) throw new Error("request_not_shared");
    if (id.length === 8) {
      let files: string[];
      try { files = await readdir(this.directory); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("request_not_shared"); throw error; }
      const matches: string[] = [];
      for (const file of files.filter(name => /^[a-f0-9]{32}\.json$/.test(name) && name.startsWith(id))) {
        const full = file.slice(0, -5);
        if ((await this.read(full))?.chat === chat) matches.push(full);
      }
      if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_request_id" : "request_not_shared");
      id = matches[0] ?? "";
    }
    return id;
  }

  async result(turn: Turn, id: string, signal?: AbortSignal, wait = 8): Promise<Record<string, unknown>> {
    id = await this.resolveRequest(turn.chat, id);
    return this.exclusive(id, async () => {
      const op = await this.read(id);
      if (!op || op.chat !== turn.chat) throw new Error("request_not_shared");
      op.guard = turn.assertCurrent;
      if (["install", "inspect", "share", "stop", "demo"].includes(op.action.kind)) {
        if (!this.plow) throw new Error("owner_setup_unavailable");
        await this.plow.owner(turn, signal);
        if (op.action.kind === "share" || op.action.kind === "demo") await this.plow.share(turn, op.action.group, signal);
      }
      if (Date.now() - op.created > 900_000) return { request: id, status: "timed_out" };
      const stage = op.stage;
      op.guard?.();
      try {
        if (stage.kind === "pending") op.stage = this.settle(await this.latch.call("plow_get_result", { handle: stage.handle }, signal), op);
        else if (stage.kind === "running") op.stage = this.settle(await this.latch.call("plow_get_output", { handle: stage.handle, since: stage.offset }, signal), op, stage);
        else if (stage.kind === "done" && typeof stage.value.request === "string") {
          await this.command(id, op, ["result", stage.value.request, "--chat", turn.chat, "--wait", String(wait)], signal);
        }
      } catch { return { request: id, status: "pending", error: "latch_poll_failed" }; }
      await this.save(id, op);
      await this.advance(id, op, signal);
      return this.view(id, op);
    });
  }
}
