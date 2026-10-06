import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Latch, object } from "./latch.ts";
import { Requests, type Setup, type Turn } from "./requests.ts";
import { Plow } from "./plow.ts";
import { Groups, type GroupDelivery } from "./groups.ts";
import { publicReply } from "./replies.ts";

export function isPrompt(body: string | null | undefined): boolean {
  return typeof body === "string" && /^\/prompt(?:[ \t\r\n]|$)/.test(body);
}

type BoundCall = { run: string; turn: Turn };
declare global {
  var __puppeteerTurns: Map<string, Turn> | undefined;
  var __puppeteerCalls: Map<string, BoundCall> | undefined;
  var __puppeteerRequests: Requests | undefined;
  var __puppeteerReplies: Map<string, string> | undefined;
  var __puppeteerGroups: Groups | undefined;
  var __puppeteerGroupRequests: Requests | undefined;
}
// OpenClaw can load discovery and channel copies of the same plugin.
const turns = globalThis.__puppeteerTurns ??= new Map<string, Turn>();
const calls = globalThis.__puppeteerCalls ??= new Map<string, BoundCall>();
const replies = globalThis.__puppeteerReplies ??= new Map<string, string>();
export async function routePuppeteerGroup(turn: Turn, send: GroupDelivery, signal: AbortSignal): Promise<void> {
  if (!globalThis.__puppeteerGroups) throw new Error("group_router_unavailable");
  try { await globalThis.__puppeteerGroups.receive(turn, send, signal); }
  catch (error) {
    if (signal.aborted) return;
    await send(turn.chat, publicReply({ error: error instanceof Error ? error.message : "group_request_failed" }, turn));
  }
}
export async function recoverPuppeteerGroups(send: GroupDelivery, signal: AbortSignal): Promise<void> {
  await globalThis.__puppeteerGroups?.recover(send, signal);
}

export function bindPuppeteerTurn(run: string, turn: Turn): void { turns.set(run, turn); }
export function endPuppeteerTurn(run: string): void {
  turns.delete(run);
  replies.delete(run);
  for (const [id, call] of calls) if (call.run === run) calls.delete(id);
}
export function puppeteerReply(run: string | undefined): string | undefined { return run ? replies.get(run) : undefined; }

function params(value: unknown, key?: string): string {
  if (!object(value) || Object.keys(value).some(name => name !== key)) throw new Error("invalid_tool_arguments");
  if (key === undefined) return "";
  if (typeof value[key] !== "string") throw new Error("invalid_tool_arguments");
  return value[key];
}

function ownerMain(context: OpenClawPluginToolContext<2>, turn: Turn): boolean {
  return turn.owner === true && context.senderIsOwner === true && context.requesterSenderId === "plow-owner"
    && context.sessionKey === "agent:main:main";
}

function currentTurn(context: OpenClawPluginToolContext<2>, id: string, allowOwner = false): Turn {
  context.assertInvocationCurrent();
  const bound = calls.get(id);
  calls.delete(id);
  const chat = (context.nativeChannelId ?? context.deliveryContext?.to)?.replace(/^plow:/i, "");
  if (!bound || turns.get(bound.run) !== bound.turn || context.messageChannel !== "plow"
    || context.agentAccountId !== "chat" || !context.requesterSenderId
    || chat !== bound.turn.chat || context.sessionKey !== bound.turn.session
    || (!isPrompt(bound.turn.prompt) && !(allowOwner && ownerMain(context, bound.turn)))) {
    throw new Error("verified_prompt_turn_required");
  }
  return { ...bound.turn, assertCurrent() {
    context.assertInvocationCurrent();
    if (turns.get(bound.run) !== bound.turn) throw new Error("verified_prompt_turn_required");
  }, recordReply(result) {
    context.assertInvocationCurrent();
    if (turns.get(bound.run) !== bound.turn) throw new Error("verified_prompt_turn_required");
    if (isPrompt(bound.turn.prompt)) replies.set(bound.run, publicReply(result, bound.turn));
  } };
}

function setupParams(value: unknown): Setup {
  if (!object(value) || Object.keys(value).some(key => !["action", "target", "group", "project", "workers"].includes(key))) throw new Error("invalid_setup_arguments");
  if (value.action === "install" || value.action === "inspect" || value.action === "groups" || value.action === "stop") {
    if (Object.keys(value).length !== 1) throw new Error("invalid_setup_arguments");
    return { action: value.action };
  }
  if (value.action === "demo") {
    if (Object.keys(value).some(key => !["action", "group", "target"].includes(key))
      || typeof value.group !== "string" || !/^cht_[A-Za-z0-9_-]+$/.test(value.group)
      || (value.target !== undefined && (typeof value.target !== "string"
        || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(value.target)))) throw new Error("invalid_setup_arguments");
    return { action: "demo", group: value.group, ...(typeof value.target === "string" ? { target: value.target } : {}) };
  }
  if (value.action !== "share" || typeof value.target !== "string"
    || (value.group !== undefined && (typeof value.group !== "string" || !/^cht_[A-Za-z0-9_-]+$/.test(value.group)))) throw new Error("invalid_setup_arguments");
  if (value.project !== undefined && (typeof value.project !== "string" || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(value.project))) throw new Error("invalid_setup_arguments");
  if (value.workers !== undefined && (value.project === undefined || typeof value.workers !== "number" || !Number.isInteger(value.workers) || value.workers < 1 || value.workers > 8)) throw new Error("invalid_setup_arguments");
  return { action: "share", target: value.target, group: value.group, ...(typeof value.project === "string" ? { project: value.project, workers: typeof value.workers === "number" ? value.workers : 4 } : {}) };
}

function macPaths(): { read: string[]; write: string[] } {
  const parse = (name: string, fallback: string[]): string[] => {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every(path => typeof path === "string" && path.length > 0)) throw new Error(`invalid_${name}`);
    return value;
  };
  return {
    read: parse("PUPPETEER_MAC_READ_PATHS", ["~/.config/puppeteer", "~/.config/mypeople", "~/.local/share/mypeople", "~/.local/share/uv/tools/puppeteer-bridge"]),
    write: parse("PUPPETEER_MAC_WRITE_PATHS", ["~/.local/share/mypeople"]),
  };
}

export function registerPuppeteer(api: OpenClawPluginApi): void {
  const names = new Set(["puppeteer_agents", "puppeteer_ask", "puppeteer_result", "puppeteer_setup"]);
  api.on("before_tool_call", (event, context) => {
    if (!names.has(event.toolName)) return;
    const run = event.runId ?? context.runId;
    const id = event.toolCallId ?? context.toolCallId;
    const turn = run ? turns.get(run) : undefined;
    if (!run || !id || !turn || context.sessionKey !== turn.session
      || (!isPrompt(turn.prompt) && !(turn.owner && turn.session === "agent:main:main" && ["puppeteer_setup", "puppeteer_result"].includes(event.toolName)))) {
      return { block: true, blockReason: "Puppeteer requires the current verified /prompt message." };
    }
    calls.set(id, { run, turn });
  });
  api.on("after_tool_call", (event, context) => {
    const id = event.toolCallId ?? context.toolCallId;
    if (id) calls.delete(id);
  });
  const plow = new Plow(process.env.PLOW_API_BASE ?? "", process.env.PLOW_AGENT_TOKEN ?? "");
  const requests = globalThis.__puppeteerRequests ??= new Requests(new Latch(process.env.PLOW_MCP_BRIDGE_TOKEN ?? ""), process.env.PUPPETEER_STATE_DIR, macPaths(),
    plow);
  if (globalThis.__puppeteerGroupRequests !== requests) {
    globalThis.__puppeteerGroups = new Groups(requests, plow, process.env.PUPPETEER_STATE_DIR ?? "/var/lib/plow/puppeteer");
    globalThis.__puppeteerGroupRequests = requests;
  }
  const tools = [
    { name: "puppeteer_agents", label: "List shared coding agents", key: undefined,
      description: "List the coding agents the owner shared with this current /prompt conversation. No access to other chats or private sessions." },
    { name: "puppeteer_ask", label: "Ask the shared local coding agent", key: "agent",
      description: "Forward this exact current /prompt message to an approved existing local coding agent, once. Provide only its alias. The server binds the chat and source message; no replacement prompt, command, path or chat ID is accepted. Returns a receipt; use puppeteer_result for the actual answer." },
    { name: "puppeteer_result", label: "Get the local coding agent's reply", key: "request",
      description: "Resume a receipt returned by puppeteer_agents or puppeteer_ask in this conversation. Handles approvals and running commands without resubmitting. Keep polling the same receipt until replied or terminal failure." },
  ];
  for (const tool of tools) {
    api.registerTool({ contextVersion: 2, create: context => ({
      name: tool.name, label: tool.label, description: tool.description,
      parameters: { type: "object", additionalProperties: false, properties: tool.key ? { [tool.key]: { type: "string" } } : {}, ...(tool.key ? { required: [tool.key] } : {}) },
      async execute(id, args, signal) {
        let turn: Turn | undefined;
        try {
          turn = currentTurn(context, id, tool.name === "puppeteer_result");
          const value = params(args, tool.key);
          const result = tool.name === "puppeteer_agents" ? await requests.agents(turn, signal)
            : tool.name === "puppeteer_ask" ? await requests.ask(turn, value, signal)
            : await requests.result(turn, value, signal);
          turn.recordReply?.(result);
          return { content: [{ type: "text", text: JSON.stringify({ ...result, ...(isPrompt(turn.prompt) ? { response_text: publicReply(result, turn) } : {}) }) }], details: result };
        } catch (error) {
          const result = { error: error instanceof Error ? error.message : "puppeteer_failed" };
          try { turn?.recordReply?.(result); } catch { /* A finished turn cannot change its reply. */ }
          return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
      },
    }) }, { name: tool.name });
  }
  api.registerTool({ contextVersion: 2, create: context => ({
    name: "puppeteer_setup", label: "Set up Puppeteer on the owner's Mac",
    description: "Owner's main private Plow DM only. install installs the pinned connector, inspect finds native sessions, and groups lists the owner's groups. For easy onboarding, create a group with plow_start_thread or use an owner-selected existing group, then call demo with its group UID. demo reuses the default existing Boss or creates a group Boss if none exists, and prepares a fresh Git coding workspace and native project session. It returns target and project for an immediate share with four workers; demo alone grants no group access. Keep native IDs internal. For an explicitly requested existing project, inspect then share its selected target and project instead. share replaces grants. stop pauses the demo and retires its workers. No raw commands, paths, credentials or replacement prompts are accepted. Resume pending receipts with puppeteer_result rather than repeating an operation.",
    parameters: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: ["install", "inspect", "groups", "demo", "share", "stop"] },
      target: { type: "string", description: "Required for share. Optional for demo only when the owner chooses among several Bosses. Use native IDs internally, never ask the owner to copy them." },
      project: { type: "string", description: "Optional for parallel share: exact existing Claude/Codex project session ID from inspect, selected by the owner." },
      workers: { type: "integer", minimum: 1, maximum: 8, description: "Parallel native worker limit. Requires project; default 4." },
      group: { type: "string", description: "Required for demo: the group UID from plow_start_thread or groups. Optional for share; omit to share only with the owner DM." },
    } },
    async execute(id, args, signal) {
      try {
        const input = setupParams(args);
        const turn = currentTurn(context, id, true);
        if (!ownerMain(context, turn)) throw new Error("owner_main_dm_required");
        const result = await requests.setup(turn, input, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        const result = { error: error instanceof Error ? error.message : "puppeteer_setup_failed" };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
    },
  }) }, { name: "puppeteer_setup" });
}
