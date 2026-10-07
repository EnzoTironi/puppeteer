// Adapted from Meetly's MIT-licensed boot gate. See licenses/Meetly-MIT.txt.
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const PLUGIN_SOURCE = "/opt/puppeteer/plugin";
export const PLUGIN_ROOT = "/var/lib/plow/extensions/puppeteer";
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function installGate(source = PLUGIN_SOURCE, target = PLUGIN_ROOT): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(source + "/openclaw.plugin.json", "utf8"));
  if (!object(manifest) || manifest.id !== "puppeteer" || !object(manifest.contracts)
    || !Array.isArray(manifest.contracts.tools) || !manifest.contracts.tools.includes("puppeteer_setup")) throw new Error("required_plugin_invalid");
  await readFile(source + "/index.js", "utf8");
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

function child(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = config[key];
  if (current !== undefined && !object(current)) throw new Error(`invalid_boot_config_${key}`);
  if (object(current)) return current;
  const value: Record<string, unknown> = {};
  config[key] = value;
  return value;
}

export function applyGate(config: Record<string, unknown>): void {
  child(child(config, "plugins"), "entries").puppeteer = { enabled: true, hooks: { allowConversationAccess: true } };
  child(child(child(config, "agents"), "defaults"), "heartbeat").target = "none";
}

export function withMacTimeout(config: Record<string, unknown>): void {
  const mcp = config.mcp;
  const servers = object(mcp) ? mcp.servers : undefined;
  const relay = object(servers) ? servers.plow : undefined;
  if (object(relay) && relay.requestTimeoutMs === undefined) relay.requestTimeoutMs = 60_000;
}
