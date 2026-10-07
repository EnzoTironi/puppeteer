import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
const { WebSocketServer } = createRequire('/opt/plow/plugin/package.json')('ws');

test('shipped preboot starts fresh, refreshes the extension and preserves models on restart, and parks corrupt config', { timeout: 300_000 }, async t => {
  const self = { type: 'agent', relationship: 'self', line: { uid: 'ln_boot', display_name: 'Alder' } };
  const owner = { type: 'member', uid: 'mem_owner', role: 'owner', display_name: 'Sam', provider_key: '+15550000001' };
  const chat = { uid: 'cht_boot', status: 'active', trusted: true, participants: [owner, self] };
  let base, connections = 0, calls = 0, child, log = '';
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = new URL(req.url, 'http://fixture').pathname;
    let value = {};
    if (path === '/v1/agents/me') value = { agent: { name: 'Alder' }, line: { uid: 'ln_boot' }, chats: [chat], mcp_url: base + '/mcp' };
    else if (path === '/v1/chats') value = { data: [chat], has_more: false };
    else if (path === '/v1/ws/ticket') value = { ticket: 'fixture' };
    else if (path.endsWith('/messages')) value = { data: [], has_more: false };
    else if (path === '/mcp') {
      if (body.method === 'tools/call') calls++;
      value = { jsonrpc: '2.0', id: body.id, result: { tools: [] } };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const sockets = new WebSocketServer({ server }); sockets.on('connection', () => { connections++; });
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    await new Promise(r => child.once('exit', r)); clearTimeout(force);
  }
  t.after(async () => { await stop(); for (const socket of sockets.clients) socket.terminate(); await new Promise(r => sockets.close(r)); await new Promise(r => server.close(r)); });
  async function boot(until) {
    log = '';
    child = spawn(process.execPath, ['/opt/puppeteer/boot/preboot.ts'], { env: { ...process.env,
      PLOW_API_BASE: base, PLOW_AGENT_TOKEN: 'fixture-plow-secret', OPENCLAW_GATEWAY_TOKEN: 'fixture-obsolete-token', OPENCLAW_NO_RESPAWN: '1' } });
    child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    const deadline = Date.now() + 120_000;
    while (!until() && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.ok(until(), log.slice(-5000));
    assert.ok(!log.includes('fixture-plow-secret') && !log.includes('fixture-obsolete-token'));
  }
  await boot(() => connections === 1 && log.includes('[gateway] ready'));
  const first = JSON.parse(await readFile('/var/lib/plow/openclaw.json', 'utf8'));
  assert.equal(first.plugins.entries.puppeteer.enabled, true);
  assert.equal(first.agents.defaults.heartbeat.target, 'none');
  assert.equal(JSON.parse(await readFile('/etc/plow/openclaw/plow-mcp.json5', 'utf8')).requestTimeoutMs, 60_000);
  assert.equal(JSON.parse(await readFile('/etc/plow/openclaw/identity.json5', 'utf8')).name, 'Puppeteer');
  const password = await readFile('/var/lib/plow/gateway-password', 'utf8');
  assert.equal((await stat('/var/lib/plow/gateway-password')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(first).includes(password.trim()));
  await stop();
  first.agents.defaults.model = { primary: 'plow/anthropic/claude-sonnet-5', fallbacks: [] };
  await writeFile('/var/lib/plow/openclaw.json', JSON.stringify(first));
  await writeFile('/var/lib/plow/extensions/puppeteer/stale.js', 'old volume code');
  await writeFile('/var/lib/plow/workspace/SOUL.md', "I'm Alder");
  await boot(() => connections === 2 && log.includes('[gateway] ready'));
  const second = JSON.parse(await readFile('/var/lib/plow/openclaw.json', 'utf8'));
  assert.deepEqual(second.agents.defaults.model, first.agents.defaults.model);
  assert.notEqual(await readFile('/var/lib/plow/gateway-password', 'utf8'), password);
  await assert.rejects(readFile('/var/lib/plow/extensions/puppeteer/stale.js'), { code: 'ENOENT' });
  assert.match(await readFile('/var/lib/plow/workspace/SOUL.md', 'utf8'), /You are Puppeteer/);
  await stop(); await writeFile('/var/lib/plow/openclaw.json', '{broken');
  await boot(() => log.includes('plow-boot: parked:'));
  assert.equal(connections, 2); assert.equal(await readFile('/var/lib/plow/openclaw.json', 'utf8'), '{broken');
  assert.equal(calls, 0, 'Preboot inspection and idle hooks do not execute Mac tools');
  const proof = { freshBoot: true, requiredExtensionRefreshed: true, modelPreferencePreserved: true,
    credentialsRotated: true, oldLineIdentityReplaced: true, macTimeoutMs: 60_000, corruptConfigParked: true, macEffects: calls };
  if (process.env.PUPPETEER_PREBOOT_EVIDENCE) await writeFile(process.env.PUPPETEER_PREBOOT_EVIDENCE, JSON.stringify(proof, null, 2) + '\n');
  console.log('PREBOOT_OK ' + JSON.stringify(proof));
});
