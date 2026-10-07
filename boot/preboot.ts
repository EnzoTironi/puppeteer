// Base boot at ddbaa6bc, with Meetly's required-plugin and Mac-timeout pattern.
// See tests/fixtures/base-main.ts.txt and licenses/Meetly-MIT.txt.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { applyGate, installGate, object, withMacTimeout } from "./gate.ts";

const CONFIG = "/var/lib/plow/openclaw.json";
const INCLUDES = "/etc/plow/openclaw";
const load = (path: string) => import(path);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

await installGate().catch(error => { throw new Error(`puppeteer-boot: required plugin install failed: ${message(error)}`); });

try {
  const { installBootLog } = await load("/opt/plow/boot/log.js");
  const { startAgentIndex } = await load("/opt/plow/boot/agent-index.js");
  const { renderConfig, syncConfig } = await load("/opt/plow/boot/config.js");
  const { identityFromApi } = await load("/opt/plow/boot/identity.js");
  const { renderPrompt } = await load("/opt/plow/boot/prompt.js");
  const { startGateway } = await load("/opt/plow/boot/process.js");
  const writeLog = installBootLog();
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (!base) throw new Error("PLOW_API_BASE is required");
  process.env.PLOW_AGENT_TOKEN ||= "proxied";
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_PASSWORD = randomBytes(32).toString("hex");
  process.env.PLOW_MCP_BRIDGE_TOKEN = randomBytes(32).toString("hex");
  const identity = await identityFromApi(base, process.env.PLOW_AGENT_TOKEN);
  identity.agent = { ...identity.agent, name: "Puppeteer" };
  const config = renderConfig(identity, base);
  withMacTimeout(config);
  config.tools.alsoAllow.push("puppeteer_setup", "puppeteer_setup_status", "puppeteer_answer_owner");
  await mkdir("/var/lib/plow/workspace", { recursive: true });
  await writeFile("/var/lib/plow/gateway-password", process.env.OPENCLAW_GATEWAY_PASSWORD + "\n", { mode: 0o600 });
  await chmod("/var/lib/plow/gateway-password", 0o600);
  for (const name of ["BOOTSTRAP.md", "SOUL.md", "IDENTITY.md", "USER.md"]) {
    await rm(`/var/lib/plow/workspace/${name}`, { force: true });
  }
  await writeFile("/var/lib/plow/workspace/SOUL.md", await readFile("/opt/plow/prompt/SOUL.md", "utf8"));
  const prompt = await readFile("/opt/plow/prompt/AGENTS.md", "utf8");
  await writeFile("/var/lib/plow/workspace/AGENTS.md", await renderPrompt(prompt, identity.mcp_url, process.env.PLOW_AGENT_TOKEN, config.channels.plow.threadTrust, identity.agent?.web_url));
  const JSON5 = createRequire("/opt/plow/package.json")("json5");
  let owner: Record<string, unknown>;
  try {
    const parsed: unknown = JSON5.parse(await readFile(CONFIG, "utf8"));
    if (!object(parsed)) throw new Error("openclaw.json must contain an object");
    owner = parsed;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    owner = structuredClone(config);
  }
  applyGate(owner);
  await writeFile(`${CONFIG}.tmp`, JSON.stringify(owner, null, 2) + "\n", { mode: 0o600 });
  await rename(`${CONFIG}.tmp`, CONFIG);
  await syncConfig(config, CONFIG, INCLUDES);
  console.log(`plow-boot: identity resolved to ${identity.line.uid}`);
  startAgentIndex(300_000, writeLog);
  await startGateway(false, identity.mcp_url ?? undefined, writeLog);
} catch (error) {
  console.error(`plow-boot: parked: ${message(error)}`);
  setInterval(() => {}, 2 ** 30);
}
