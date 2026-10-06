import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const root = process.argv[2] ?? "/opt/plow";
async function replace(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Pinned Plow source changed: ${file}`);
  await writeFile(file, source.replace(before, after));
}
const plugin = join(root, "plugin/dist");
const manifestPath = join(root, "plugin/openclaw.plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const baseTools = ["plow_start_thread", "plow_set_thread_trust", "plow_reply_to", "plow_send_email"];
if (manifest.id !== "plow" || JSON.stringify(manifest.contracts?.tools) !== JSON.stringify(baseTools)) throw new Error("Pinned Plow tool manifest changed");
manifest.contracts.tools.push("puppeteer_agents", "puppeteer_ask", "puppeteer_result", "puppeteer_setup");
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
for (const name of ["latch", "plow", "requests", "puppeteer"]) {
  const source = await readFile(join(root, "puppeteer-src", name + ".ts"), "utf8");
  await writeFile(join(plugin, name + ".js"), stripTypeScriptTypes(source.replace(/from "(\.\/[^"\n]+)\.ts"/g, 'from "$1.js"')));
}
await replace(join(plugin, "index.js"), 'import { createHash } from "node:crypto";', 'import { createHash } from "node:crypto";\nimport { bindPuppeteerTurn, endPuppeteerTurn, isPrompt, registerPuppeteer } from "./puppeteer.js";');
await replace(join(plugin, "index.js"), '  const sender = message.sender;', '  if (account.accountId === "chat" && chat.participants.length > 2 && (message.sender.type !== "member" || !isPrompt(message.body))) return "completed";\n  const sender = message.sender;');
await replace(join(plugin, "index.js"), '  const guestTools = !email && !chat.trusted && !senderIsOwner ? account.guestTools ?? [] : undefined;', '  const guestTools = !email && (kind === "group" || (!chat.trusted && !senderIsOwner)) ? account.guestTools ?? [] : undefined;');
await replace(join(plugin, "index.js"), '    silentRuns.delete(activeRunId);', '    silentRuns.delete(activeRunId);\n    endPuppeteerTurn(activeRunId);');
await replace(join(plugin, "index.js"), '        silentRuns.set(runId, false);', '        silentRuns.set(runId, false);\n        bindPuppeteerTurn(runId, { chat: chat.uid, message: message.uid, session: route.sessionKey, prompt: message.body, owner: senderIsOwner });');
await replace(join(plugin, "index.js"), '  registerCapabilities(api) {', '  registerCapabilities(api) {\n    registerPuppeteer(api);');
await replace(join(plugin, "index.js"), 'sourceReplyDeliveryMode: command && !senderIsOwner && chat.trusted ? "message_tool_only" : "automatic",', 'sourceReplyDeliveryMode: isPrompt(body) ? "automatic" : command && !senderIsOwner && chat.trusted ? "message_tool_only" : "automatic",');
await replace(join(plugin, "index.js"), 'inboundHistory: history.map(m => ({', 'inboundHistory: history.filter(m => kind !== "group" || isPrompt(m.body)).map(m => ({');
await replace(join(plugin, "transport.js"), 'import { mkdir, readFile, rename, writeFile } from "node:fs/promises";', 'import { isPrompt } from "./puppeteer.js";\nimport { mkdir, readFile, rename, writeFile } from "node:fs/promises";');
await replace(join(plugin, "transport.js"), 'shouldDebounce: item => account.accountId === "chat" && shouldDebounceTextInbound({', 'shouldDebounce: item => account.accountId === "chat" && !isPrompt(item.message.body) && shouldDebounceTextInbound({');
await replace(join(plugin, "transport.js"), '    const sender = message.sender;', `    const room = chat ?? await request(account, \`/chats/\${chatUid}\`);
    if (account.accountId === "chat" && room.participants.length > 2 && (message.sender.type !== "member" || !isPrompt(message.body))) {
      await ack(chatUid, message.uid);
      remember(message.uid);
      log(\`ignored non-command chat=\${chatUid} message=\${message.uid}\`);
      return;
    }
    const sender = message.sender;`);
await replace(join(root, "boot/config.js"), 'queue: { mode: "collect" }', 'queue: { mode: "followup" }');
await replace(join(root, "boot/config.js"), '...guestTools], deny: ["ask_user"]', '"puppeteer_setup", ...guestTools], deny: ["ask_user"]');
await replace(join(root, "boot/mcp-bridge.js"), '"mcp-method", "last-event-id"', '"mcp-method", "mcp-name", "last-event-id"');
