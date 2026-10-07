import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { applyGate, installGate, withMacTimeout } from '../boot/gate.ts';

test('required extension is refreshed from the image and a missing or wrong plugin fails boot', async t => {
  const dir = await mkdtemp(tmpdir() + '/puppeteer-gate-'), source = dir + '/source', target = dir + '/state/extensions/puppeteer';
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(source); await cp(new URL('../plugin/openclaw.plugin.json', import.meta.url), source + '/openclaw.plugin.json');
  await writeFile(source + '/index.js', 'export default {}');
  await installGate(source, target); await writeFile(target + '/stale.js', 'old');
  await writeFile(source + '/index.js', 'export default {updated:true}'); await installGate(source, target);
  assert.match(await readFile(target + '/index.js', 'utf8'), /updated/);
  await assert.rejects(readFile(target + '/stale.js'), { code: 'ENOENT' });
  await rm(source + '/index.js'); await assert.rejects(installGate(source, target), { code: 'ENOENT' });
  await writeFile(source + '/openclaw.plugin.json', '{"id":"another"}');
  await assert.rejects(installGate(source, target), /required_plugin_invalid/);
});
test('boot owns extension activation and heartbeat delivery while preserving owner model preferences', () => {
  const cfg = { agents: { defaults: { model: { primary: 'owner/model' }, heartbeat: { every: '45m', target: 'last' } } },
    plugins: { load: { paths: ['/opt/plow/plugin'] }, entries: { existing: { enabled: true } } } };
  applyGate(cfg);
  assert.equal(cfg.plugins.entries.puppeteer.enabled, true);
  assert.equal(cfg.plugins.entries.puppeteer.hooks.allowConversationAccess, true);
  assert.deepEqual(cfg.plugins.load.paths, ['/opt/plow/plugin']);
  assert.deepEqual(cfg.agents.defaults.model, { primary: 'owner/model' });
  assert.deepEqual(cfg.agents.defaults.heartbeat, { every: '45m', target: 'none' });
  assert.equal(cfg.plugins.entries.existing.enabled, true);
  assert.throws(() => applyGate({ plugins: [] }), /invalid_boot_config/);
});
test('Mac MCP listing gets a minute, and an explicit upstream timeout remains authoritative', () => {
  const cfg = { mcp: { servers: { plow: { url: 'http://relay' } } } };
  withMacTimeout(cfg); assert.equal(cfg.mcp.servers.plow.requestTimeoutMs, 60_000);
  cfg.mcp.servers.plow.requestTimeoutMs = 90_000; withMacTimeout(cfg);
  assert.equal(cfg.mcp.servers.plow.requestTimeoutMs, 90_000);
  withMacTimeout({});
});
