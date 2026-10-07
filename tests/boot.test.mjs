import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('custom preboot retains the pinned base lifecycle and installs the required gate first', async () => {
  const custom = await readFile(new URL('../boot/preboot.ts', import.meta.url), 'utf8');
  const base = await readFile(new URL('fixtures/base-main.ts.txt', import.meta.url), 'utf8');
  for (const contract of ['installBootLog()', 'identityFromApi(base, process.env.PLOW_AGENT_TOKEN)', 'renderConfig(identity, base)',
    'delete process.env.OPENCLAW_GATEWAY_TOKEN', 'randomBytes(32).toString("hex")', 'startAgentIndex(300_000, writeLog)',
    'startGateway(false, identity.mcp_url ?? undefined, writeLog)', 'config.channels.plow.threadTrust']) {
    assert.ok(base.includes(contract), `upstream contract changed: ${contract}`); assert.ok(custom.includes(contract), contract);
  }
  assert.ok(custom.indexOf('await installGate()') < custom.indexOf('try {'));
  assert.ok(custom.indexOf('withMacTimeout(config)') < custom.indexOf('await syncConfig('));
  assert.ok(custom.indexOf('applyGate(owner)') < custom.indexOf('await syncConfig('));
  assert.match(custom, /name: "Puppeteer"/); assert.match(custom, /SOUL.md/);
  assert.match(custom, /JSON5.parse/); assert.match(custom, /if \(!\(error instanceof Error.*ENOENT/);
});
