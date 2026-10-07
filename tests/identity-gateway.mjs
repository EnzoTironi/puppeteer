import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderConfig, syncConfig } from '/opt/plow/boot/config.js';
import { renderPrompt } from '/opt/plow/boot/prompt.js';
import { startGateway } from '/opt/plow/boot/process.js';

const { WebSocketServer } = createRequire('/opt/plow/plugin/package.json')('ws');
const root = await mkdtemp(join(tmpdir(), 'puppeteer-identity-'));
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json'),
  OPENCLAW_INCLUDE_ROOTS: join(root, 'includes'), OPENCLAW_NO_RESPAWN: '1',
  PUPPETEER_STATE_DIR: join(root, 'receipts'), PLOW_AGENT_TOKEN: 'fixture-token',
  OPENCLAW_GATEWAY_PASSWORD: 'fixture-password',
});
const owner = { type: 'member', uid: 'mem_owner', role: 'owner', display_name: 'Enzo', provider_key: '+15550000001' };
const agent = { type: 'agent', relationship: 'self', line: { uid: 'ln_alder', display_name: 'Alder' } };
const chat = { uid: 'cht_identity', status: 'active', trusted: true, participants: [owner, agent] };
const identity = { agent: { name: 'Alder' }, line: { uid: 'ln_alder' }, chats: [chat] };
assert.equal(renderConfig(identity, 'http://127.0.0.1').agents.entries.main.identity.name, 'Puppeteer');
const cases = ['Alo', 'Vc não é o puppeter?', 'Are you Alder or Puppeteer? Please answer in Portuguese.', 'What connects you to my Mac? Keep it to one sentence.'];
const messages = [{ uid: 'msg_previous', chat_uid: chat.uid, direction: 'outbound', sender: agent,
  body: "Hey Enzo! I'm Alder, your personal assistant on OpenClaw. Puppeteer is a separate agent.",
  attachments: [], created_at: new Date().toISOString() }];
const results = [];
let child, sockets, failure, log = '', modelCalls = 0, started = false, finish;
const done = new Promise(resolve => { finish = resolve; });
function publish() {
  const message = { uid: 'msg_identity_' + results.length, chat_uid: chat.uid, direction: 'inbound', sender: owner,
    body: cases[results.length], attachments: [], created_at: new Date().toISOString() };
  messages.push(message);
  for (const socket of sockets.clients) socket.send(JSON.stringify({ event_type: 'message_received', event_id: message.uid, chat_id: chat.uid, data: { message } }));
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.endsWith('/chat/completions')) {
    modelCalls++;
    const system = body.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    assert.ok(system.includes('Your name is Puppeteer.'), 'The shipped persona must reach the real model request');
    assert.ok(system.includes('Reply exclusively in English.'), 'The shipped SOUL persona must reach the model request');
    const text = JSON.stringify(body.messages).replaceAll('\\', '');
    assert.ok(text.includes('Puppeteer response language: English.'), 'The current turn must carry the response language');
    assert.ok(/"name"\s*:\s*"Puppeteer"/.test(text), 'The real Plow conversation facts must identify Puppeteer');
    assert.ok(!/"name"\s*:\s*"Alder"/.test(text), 'The line name must not become the assistant persona');
    if (process.env.PUPPETEER_IDENTITY_MODEL_URL) {
      const response = await fetch(process.env.PUPPETEER_IDENTITY_MODEL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(50_000) });
      assert.equal(response.status, 200, 'The live model proxy must succeed');
      res.writeHead(200, { 'content-type': response.headers.get('content-type') });
      for await (const chunk of response.body) res.write(chunk);
      res.end(); return;
    }
    const chunk = { id: 'chatcmpl-identity', object: 'chat.completion.chunk', created: 1, model: 'z-ai/glm-5.2', choices: [{ index: 0, delta: { role: 'assistant', content: "I'm Puppeteer. I connect this conversation to your MyPlow coding team through Latch." }, finish_reason: null }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    res.end('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
  }
  if (url.pathname === '/v1/agents/me') return json({ agent: { name: 'Alder' }, line: { uid: 'ln_alder' } });
  if (url.pathname === '/v1/chats') return json({ data: [chat], has_more: false });
  if (url.pathname === '/v1/chats/' + chat.uid) return json(chat);
  if (url.pathname === '/v1/ws/ticket') return json({ ticket: 'fixture-ticket' });
  if (url.pathname.endsWith('/messages') && req.method === 'POST') {
    results.push({ input: cases[results.length], response: body.body });
    if (process.env.PUPPETEER_IDENTITY_EVIDENCE) await writeFile(process.env.PUPPETEER_IDENTITY_EVIDENCE, JSON.stringify({ results }, null, 2) + '\n');
    messages.push({ ...messages.at(-1), uid: 'msg_reply_' + results.length, direction: 'outbound', sender: agent, body: body.body });
    json({ uid: 'msg_reply_' + results.length });
    if (results.length === cases.length) finish(); else setTimeout(publish, 250);
    return;
  }
  if (url.pathname.endsWith('/messages')) return json({ data: messages.toReversed(), has_more: false });
  return json({ ok: true });
}
const server = createServer((req, res) => handle(req, res).catch(error => {
  failure = error; res.writeHead(500); res.end('Identity fixture failed'); finish();
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
sockets = new WebSocketServer({ server });
sockets.on('connection', () => { if (!started) { started = true; setTimeout(publish, 250); } });
const base = 'http://127.0.0.1:' + server.address().port;
process.env.PLOW_API_BASE = base;
const config = renderConfig(identity, base);
assert.equal(config.channels.plow.lineUid, 'ln_alder');
config.agents.defaults.workspace = join(root, 'workspace');
await mkdir(config.agents.defaults.workspace, { recursive: true });
await writeFile(join(config.agents.defaults.workspace, 'SOUL.md'), await readFile('/opt/plow/prompt/SOUL.md', 'utf8'));
await writeFile(join(config.agents.defaults.workspace, 'AGENTS.md'), await renderPrompt(await readFile('/opt/plow/prompt/AGENTS.md', 'utf8'), null, 'fixture-token', 'untrusted'));
const staleConfig = structuredClone(config);
staleConfig.agents.entries.main.identity.name = 'Alder';
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(staleConfig));
await syncConfig(config, process.env.OPENCLAW_CONFIG_PATH, process.env.OPENCLAW_INCLUDE_ROOTS);
assert.equal(JSON.parse(await readFile(join(root, 'includes/identity.json5'), 'utf8')).name, 'Puppeteer');
child = await startGateway(true);
child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
child.once('exit', code => { if (code) { failure ??= new Error('Gateway exited ' + code); finish(); } });
const timeout = setTimeout(() => { failure ??= new Error('Identity gateway timed out'); finish(); }, 120_000);
try {
  await done; if (failure) throw failure;
  assert.equal(results.length, cases.length);
  if (process.env.PUPPETEER_IDENTITY_EVIDENCE) await writeFile(process.env.PUPPETEER_IDENTITY_EVIDENCE, JSON.stringify({ results }, null, 2) + '\n');
  if (process.env.PUPPETEER_IDENTITY_MODEL_URL) for (const result of results.slice(0, 3)) {
    assert.match(result.response, /Puppeteer/);
    assert.doesNotMatch(result.response, /I(?:'m| am) Alder|Puppeteer is a separate|\b(?:Não|sou|seu|você|posso|Você)\b/i);
  }
  const proof = { type: 'real OpenClaw gateway; simulated iMessage transport; ' + (process.env.PUPPETEER_IDENTITY_MODEL_URL ? 'live Plow GLM model' : 'fixture model'), apiName: 'Alder', configuredName: config.agents.entries.main.identity.name, staleConfigReplaced: true, previousWrongReplyIncluded: true, modelCalls, externalDelivery: false, results };
  if (process.env.PUPPETEER_IDENTITY_EVIDENCE) await writeFile(process.env.PUPPETEER_IDENTITY_EVIDENCE, JSON.stringify(proof, null, 2) + '\n');
  console.log('IDENTITY_GATEWAY_OK ' + JSON.stringify(proof));
} catch (error) { console.error(error); console.error(log.slice(-3500)); process.exitCode = 1; }
finally {
  clearTimeout(timeout); child.kill('SIGTERM');
  const forceStop = setTimeout(() => child.kill('SIGKILL'), 5000);
  await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); });
  clearTimeout(forceStop);
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
