import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Latch, object } from "./latch.ts";
import { Requests, type Setup, type Turn } from "./requests.ts";
import { Plow } from "./plow.ts";

export function isPrompt(body: string | null | undefined): boolean {
  return typeof body === "string" && /^\/prompt(?:[ \t\r\n]|$)/.test(body);
}

type BoundCall = { run: string; turn: Turn };
declare global {
  var __puppeteerTurns: Map<string, Turn> | undefined;
  var __puppeteerCalls: Map<string, BoundCall> | undefined;
  var __puppeteerRequests: Requests | undefined;
}
// OpenClaw can load discovery and channel copies of the same plugin.
const turns = globalThis.__puppeteerTurns ??= new Map<string, Turn>();
const calls = globalThis.__puppeteerCalls ??= new Map<string, BoundCall>();

export function bindPuppeteerTurn(run: string, turn: Turn): void { turns.set(run, turn); }
export function endPuppeteerTurn(run: string): void {
  turns.delete(run);
  for (const [id, call] of calls) if (call.run === run) calls.delete(id);
}

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
  return bound.turn;
}

function setupParams(value: unknown): Setup {
  if (!object(value) || Object.keys(value).some(key => !["action", "target", "group"].includes(key))) throw new Error("invalid_setup_arguments");
  if (value.action === "install" || value.action === "inspect" || value.action === "groups") {
    if (Object.keys(value).length !== 1) throw new Error("invalid_setup_arguments");
    return { action: value.action };
  }
  if (value.action !== "share" || typeof value.target !== "string"
    || (value.group !== undefined && (typeof value.group !== "string" || !/^cht_[A-Za-z0-9_-]+$/.test(value.group)))) throw new Error("invalid_setup_arguments");
  return { action: "share", target: value.target, group: value.group };
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
    read: parse("PUPPETEER_MAC_READ_PATHS", ["~/.config/puppeteer", "~/.config/mypeople", "~/.config/plow/token", "~/.local/share/mypeople", "~/.local/share/uv/tools/puppeteer-bridge"]),
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
  const requests = globalThis.__puppeteerRequests ??= new Requests(new Latch(process.env.PLOW_MCP_BRIDGE_TOKEN ?? ""), process.env.PUPPETEER_STATE_DIR, macPaths(),
    new Plow(process.env.PLOW_API_BASE ?? "", process.env.PLOW_AGENT_TOKEN ?? ""));
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
        try {
          const value = params(args, tool.key);
          const turn = currentTurn(context, id, tool.name === "puppeteer_result");
          const result = tool.name === "puppeteer_agents" ? await requests.agents(turn, signal)
            : tool.name === "puppeteer_ask" ? await requests.ask(turn, value, signal)
            : await requests.result(turn, value, signal);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        } catch (error) {
          const result = { error: error instanceof Error ? error.message : "puppeteer_failed" };
          return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
      },
    }) });
  }
  api.registerTool({ contextVersion: 2, create: context => ({
    name: "puppeteer_setup", label: "Set up Puppeteer on the owner's Mac",
    description: "Owner's main private Plow DM only. install installs the fixed pinned connector through Latch, inspect lists existing MyPlow session IDs, groups lists this owner's groups containing Puppeteer, share exposes one selected native target as coder to this DM and optionally one selected group. share replaces previous grants. No terminal commands, paths, credentials or replacement prompts are accepted. Use puppeteer_result to resume any pending receipt, never repeat the installation or pairing.",
    parameters: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: ["install", "inspect", "groups", "share"] },
      target: { type: "string", description: "Required only for share: an exact native ID returned by inspect, selected by the owner." },
      group: { type: "string", description: "Optional only for share: a chat UID returned by groups, selected by the owner. Omit to share only with this owner DM." },
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
  }) });
}
