import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
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
const extension = join(root, "../puppeteer/plugin");
await mkdir(extension, { recursive: true });
for (const name of ["openclaw.plugin.json", "package.json"]) await copyFile(join(root, "puppeteer-src", name), join(extension, name));
for (const file of (await readdir(join(root, "puppeteer-src"))).filter(file => file.endsWith(".ts"))) {
  const name = file.slice(0, -3);
  const source = await readFile(join(root, "puppeteer-src", name + ".ts"), "utf8");
  await writeFile(join(extension, name + ".js"), stripTypeScriptTypes(source.replace(/from "(\.\/[^"\n]+)\.ts"/g, 'from "$1.js"')));
}
await replace(join(plugin, "index.js"), 'import { createHash } from "node:crypto";', 'import { createHash } from "node:crypto";\nimport { bindPuppeteerTurn, endPuppeteerTurn, isPrompt, puppeteerReply, routePuppeteerGroup, recoverPuppeteerGroups } from "/opt/puppeteer/plugin/puppeteer.js";\nimport { promptCommand, promptHelp, publicReply } from "/opt/puppeteer/plugin/replies.js";');
await replace(join(plugin, "index.js"), '  const sender = message.sender, quoted = message.reply_to?.message;', '  if (account.accountId === "chat" && chat.participants.length > 2 && (message.sender.type !== "member" || !isPrompt(message.body))) return "completed";\n  const sender = message.sender, quoted = message.reply_to?.message;');
await replace(join(plugin, "index.js"), '  const guestTools = !email && !chat.trusted && !senderIsOwner ? account.guestTools ?? [] : undefined;', '  const guestTools = !email && (kind === "group" || (!chat.trusted && !senderIsOwner)) ? account.guestTools ?? [] : undefined;');
await replace(join(plugin, "index.js"), '  let activeRunId', '  let verifiedPuppeteerReply;\n  let activeRunId');
await replace(join(plugin, "index.js"), '    silentRuns.delete(activeRunId);', '    verifiedPuppeteerReply = puppeteerReply(activeRunId) ?? verifiedPuppeteerReply;\n    silentRuns.delete(activeRunId);\n    endPuppeteerTurn(activeRunId);');
await replace(join(plugin, "index.js"), '  const { onModelSelected, ...replyPipeline }', `  if (kind === "group" && isPrompt(body)) {
    ingress.onSubmitted();
    await routePuppeteerGroup({ chat: chat.uid, message: message.uid, session: route.sessionKey, prompt: body, sender: senderName },
      (target, text) => send(account, target, text), ingress.abortSignal);
    await ingress.onAdopted();
    return "completed";
  }
  const { onModelSelected, ...replyPipeline }`);
await replace(join(plugin, "index.js"), '      await listen(ctx.account,', `      if (ctx.account.accountId === "chat") void recoverPuppeteerGroups((target, text) => send(ctx.account, target, text), ctx.abortSignal).catch(() => log("Puppeteer receipt recovery paused"));
      await listen(ctx.account,`);
await replace(join(plugin, "index.js"), '  const dispatched = runtime.channel.inbound.dispatch({', '  const dispatched = Promise.resolve().then(() => runtime.channel.inbound.dispatch({');
await replace(join(plugin, "index.js"), '  });\n  ingress.onSubmitted();', '  }));\n  ingress.onSubmitted();');
await replace(join(plugin, "index.js"), '        silentRuns.set(runId, false);', '        verifiedPuppeteerReply = undefined;\n        silentRuns.set(runId, false);\n        bindPuppeteerTurn(runId, { chat: chat.uid, message: message.uid, session: route.sessionKey, prompt: message.body, sender: senderName, owner: senderIsOwner });');
await replace(join(plugin, "index.js"), '        // Plow sends unquoted replies;', `        if (!email && info.kind === "final" && isPrompt(body)) {
          const control = promptCommand(body);
          const text = control.kind === "help" ? promptHelp
            : control.kind === "invalid_status" ? "Use /prompt status REQUEST_ID with the ID from the original reply."
            : puppeteerReply(activeRunId) ?? verifiedPuppeteerReply ?? "I couldn't confirm a result for this request. Use /prompt help for the available commands.";
          return { ...payload, text, mediaUrls: undefined, mediaUrl: undefined, replyToId: undefined, replyToCurrent: false };
        }
        // Plow sends unquoted replies;`);
await replace(join(plugin, "index.js"), '        if (!email && observedReplyDelivery && info.kind === "final") return null;', '        if (!email && isPrompt(body) && info.kind !== "final") return null;\n        if (!email && observedReplyDelivery && info.kind === "final") return null;');
await replace(join(plugin, "index.js"), 'sourceReplyDeliveryMode: command && !senderIsOwner && chat.trusted ? "message_tool_only" : "automatic",', 'sourceReplyDeliveryMode: isPrompt(body) ? "automatic" : command && !senderIsOwner && chat.trusted ? "message_tool_only" : "automatic",');
await replace(join(plugin, "index.js"), 'inboundHistory: history.map(m => ({', 'inboundHistory: history.filter(m => kind !== "group" || isPrompt(m.body)).map(m => ({');
await replace(join(plugin, "index.js"), 'rawBody: body },', 'rawBody: body, bodyForAgent: `${body}\\n\\nPuppeteer response language: English.` },');
await replace(join(plugin, "transport.js"), 'import { mkdir, readFile, rename, writeFile } from "node:fs/promises";', 'import { isPrompt } from "/opt/puppeteer/plugin/puppeteer.js";\nimport { mkdir, readFile, rename, writeFile } from "node:fs/promises";');
await replace(join(plugin, "transport.js"), 'if (seen.size > 512)', 'if (seen.size > 4096)');
await replace(join(plugin, "transport.js"), 'while (handled.size > 512)', 'while (handled.size > 4096)');
await replace(join(plugin, "transport.js"), 'shouldDebounce: item => account.accountId === "chat" && shouldDebounceTextInbound({', 'shouldDebounce: item => account.accountId === "chat" && !isPrompt(item.message.body) && shouldDebounceTextInbound({');
await replace(join(plugin, "transport.js"), '    const sender = message.sender;', `    const room = chat ?? await request(account, \`/chats/\${chatUid}\`);
    if (account.accountId === "chat" && room.participants.length > 2 && (message.sender.type !== "member" || !isPrompt(message.body))) {
      await ack(chatUid, message.uid);
      remember(message.uid);
      log(\`ignored non-command chat=\${chatUid} message=\${message.uid}\`);
      return;
    }
    const sender = message.sender;`);
await replace(join(root, "boot/config.js"), 'queue: { mode: "collect" }', 'queue: { mode: "followup", cap: 256, drop: "new" }');
await replace(join(root, "boot/config.js"), 'const name = identity.agent?.name;', 'const name = "Puppeteer";');
await replace(join(root, "boot/mcp-bridge.js"), '"mcp-method", "last-event-id"', '"mcp-method", "mcp-name", "last-event-id"');
