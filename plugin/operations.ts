import { object } from "./latch.ts";

export type Action = { kind: "agents" } | { kind: "ask"; alias: string } | { kind: "install" } | { kind: "inspect" } | { kind: "stop" } | { kind: "resume" } | { kind: "status" }
  | { kind: "demo"; group: string; target?: string }
  | { kind: "share"; target: string; chats: string[]; group?: string; project?: string; workers?: number; phase: "prepare" | "write" | "pair" };
export type Stage =
  | { kind: "unknown"; error: string }
  | { kind: "pending"; handle: string; reason: string }
  | { kind: "running"; handle: string; output: string; offset: number }
  | { kind: "done"; value: Record<string, unknown> };
export type Operation = { chat: string; message: string; created: number; completed?: number; action: Action; stage: Stage; guard?: () => void };

export function parseOperation(value: unknown): Operation {
  if (!object(value) || typeof value.chat !== "string" || !/^cht_[A-Za-z0-9_-]+$/.test(value.chat)
    || typeof value.message !== "string" || typeof value.created !== "number" || !Number.isFinite(value.created)
    || (value.completed !== undefined && (typeof value.completed !== "number" || !Number.isFinite(value.completed)))
    || !object(value.action) || !object(value.stage)) throw new Error("invalid_request_state");
  let action: Action;
  if (value.action.kind === "agents") action = { kind: "agents" };
  else if (value.action.kind === "ask" && typeof value.action.alias === "string") action = { kind: "ask", alias: value.action.alias };
  else if (["install", "inspect", "stop", "resume", "status"].includes(String(value.action.kind))) {
    const kind = value.action.kind;
    if (kind !== "install" && kind !== "inspect" && kind !== "stop" && kind !== "resume" && kind !== "status") throw new Error("invalid_request_state");
    action = { kind };
  }
  else if (value.action.kind === "demo" && typeof value.action.group === "string"
    && (value.action.target === undefined || typeof value.action.target === "string")) {
    action = { kind: "demo", group: value.action.group, target: value.action.target };
  }
  else if (value.action.kind === "share" && typeof value.action.target === "string" && Array.isArray(value.action.chats)
    && value.action.chats.every(c => typeof c === "string") && (value.action.group === undefined || typeof value.action.group === "string")
    && ["prepare", "write", "pair"].includes(String(value.action.phase))) {
    const phase = value.action.phase;
    if (phase !== "prepare" && phase !== "write" && phase !== "pair") throw new Error("invalid_request_state");
    const native = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
    if (!native.test(value.action.target) || value.action.chats.length < 1 || value.action.chats.length > 2
      || !value.action.chats.every(chat => /^cht_[A-Za-z0-9_-]+$/.test(chat))
      || (value.action.project !== undefined && (typeof value.action.project !== "string" || !native.test(value.action.project)))
      || (value.action.workers !== undefined && (value.action.project === undefined || typeof value.action.workers !== "number"
        || !Number.isInteger(value.action.workers) || value.action.workers < 1 || value.action.workers > 8))) throw new Error("invalid_request_state");
    action = { kind: "share", target: value.action.target, chats: value.action.chats, group: value.action.group, phase,
      ...(typeof value.action.project === "string" ? { project: value.action.project, workers: typeof value.action.workers === "number" ? value.action.workers : 4 } : {}) };
  }
  else throw new Error("invalid_request_state");
  let stage: Stage;
  const s = value.stage;
  if (s.kind === "unknown" && typeof s.error === "string") stage = { kind: s.kind, error: s.error };
  else if (s.kind === "pending" && typeof s.handle === "string" && typeof s.reason === "string") stage = { kind: s.kind, handle: s.handle, reason: s.reason };
  else if (s.kind === "running" && typeof s.handle === "string" && typeof s.output === "string" && typeof s.offset === "number"
    && Number.isInteger(s.offset) && s.offset >= 0) stage = { kind: s.kind, handle: s.handle, output: s.output, offset: s.offset };
  else if (s.kind === "done" && object(s.value)) stage = { kind: s.kind, value: s.value };
  else throw new Error("invalid_request_state");
  return { chat: value.chat, message: value.message, created: value.created, action, stage,
    ...(typeof value.completed === "number" ? { completed: value.completed } : {}) };
}
