import { randomUUID } from "node:crypto";

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Latch's stateless MCP contract; credentials never enter tool arguments. */
export class Latch {
  private readonly token: string;
  private readonly url: string;
  constructor(token: string, url = "http://127.0.0.1:18790/mcp") {
    this.token = token;
    this.url = url;
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.token) throw new Error("latch_not_connected");
    const id = randomUUID();
    const version = "2026-07-28";
    const response = await fetch(this.url, {
      method: "POST", redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
      headers: {
        Authorization: `Bearer ${this.token}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream", "Mcp-Protocol-Version": version,
        "Mcp-Method": "tools/call", "Mcp-Name": name,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
        name, arguments: args, _meta: {
          "io.modelcontextprotocol/protocolVersion": version,
          "io.modelcontextprotocol/clientInfo": { name: "puppeteer", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      } }),
    });
    if (!response.ok) throw new Error(`latch_http_${response.status}`);
    const text = await response.text();
    const frames = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean)
      : [text];
    for (const frame of frames) {
      const rpc: unknown = JSON.parse(frame);
      if (!object(rpc) || rpc.id !== id) continue;
      if (object(rpc.error)) throw new Error("latch_rpc_failed");
      if (!object(rpc.result) || !Array.isArray(rpc.result.content)) break;
      const block = rpc.result.content.find(value => object(value) && value.type === "text" && typeof value.text === "string");
      if (!object(block) || typeof block.text !== "string") break;
      const payload: unknown = JSON.parse(block.text);
      if (!object(payload)) break;
      return payload;
    }
    throw new Error("invalid_latch_response");
  }
}
