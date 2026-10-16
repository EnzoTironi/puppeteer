import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('the base is pinned by commit tag and index digest, matching the boot fixture', async () => {
  const dockerfile = await read('Dockerfile');
  const from = /^FROM public\.ecr\.aws\/e1h7x4a2\/plow-cloud-agents:base-([a-f0-9]{40})@sha256:[a-f0-9]{64}$/m.exec(dockerfile);
  assert.ok(from, 'FROM must carry both the base-<sha> tag and the sha256 index digest');
  const boot = /^\/\/ Base boot at ([a-f0-9]{8,40})\b/m.exec(await read('boot/preboot.ts'));
  assert.ok(boot && from[1].startsWith(boot[1]), 'boot/preboot.ts names the base commit its fixture came from');
  assert.ok((await read('THIRD_PARTY.md')).includes(from[1]), 'THIRD_PARTY.md attributes the pinned base commit');
});

test('every published connector pin names the same commit', async () => {
  const pinned = /PUPPETEER_BRIDGE_COMMIT=([a-f0-9]{40})\b/.exec(await read('Dockerfile'))?.[1];
  assert.ok(pinned, 'Dockerfile pins the Mac connector by full commit');
  for (const path of ['README.md', 'checks/manual-scenarios.md']) {
    const text = await read(path);
    for (const match of text.matchAll(/puppeteer\.git@([a-f0-9]{7,40})/g)) assert.equal(match[1], pinned, path);
  }
});

test('the image reports as this agent and keeps guests on the declared tools', async () => {
  const dockerfile = await read('Dockerfile');
  const manifest = JSON.parse(await read('plugin/openclaw.plugin.json'));
  assert.match(dockerfile, /AGENT_ID=puppeteer\b/);
  assert.match(dockerfile, /PLOW_THREAD_TRUST=untrusted\b/);
  const guests = /PLOW_GUEST_TOOLS=([a-z_,]+)/.exec(dockerfile)?.[1].split(',');
  assert.deepEqual(guests, ['puppeteer_agents', 'puppeteer_ask', 'puppeteer_result', 'puppeteer_ask_owner']);
  for (const tool of guests) assert.ok(manifest.contracts.tools.includes(tool), tool);
  for (const owner of ['puppeteer_setup', 'puppeteer_setup_status', 'puppeteer_answer_owner']) assert.ok(!guests.includes(owner), owner);
});

test('every test file runs somewhere: offline in npm test, in-image in CI', async () => {
  const files = (await readdir(new URL('./', import.meta.url))).filter(name => name.endsWith('.test.mjs'));
  const offline = JSON.parse(await read('package.json')).scripts.test;
  const workflow = await read('.github/workflows/publish.yml');
  const inImage = ['preboot.test.mjs', 'group-ingress.test.mjs', 'group-load.test.mjs', 'runtime-tools.test.mjs', 'owner-dm.test.mjs'];
  for (const name of files) {
    // Mounted is not enough: the image job has to execute it.
    if (inImage.includes(name)) assert.match(workflow, new RegExp(`node [^\\n]*/tmp/${name.replaceAll('.', '\\.')}`), name + ' runs in the image job');
    else assert.ok(offline.includes('tests/' + name), name + ' runs in npm test');
  }
  for (const script of ['gateway-stage.mjs', 'identity-gateway.mjs']) assert.match(workflow, new RegExp(`node [^\\n]*/tmp/${script.replaceAll('.', '\\.')}`), script);
  // The offline image runner covers the same files as the image job.
  const offlineImage = await read('scripts/test-image-offline.mjs');
  for (const name of [...inImage, 'gateway-stage.mjs', 'identity-gateway.mjs']) assert.ok(offlineImage.includes(`"${name}"`), name + ' runs in npm run test:image');
});
