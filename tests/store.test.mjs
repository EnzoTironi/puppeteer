import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { readJson, withLock, writeJson } from '../plugin/store.ts';

async function fixture(t) {
  const dir = await mkdtemp(tmpdir() + '/puppeteer-store-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function child(file, args) {
  const process = spawn(globalThis.process.execPath, [file, ...args]);
  let errors = '';
  process.stderr.on('data', bytes => { errors += bytes; });
  const done = new Promise((resolve, reject) => process.once('exit', (code, signal) =>
    code === 0 || signal === 'SIGKILL' ? resolve() : reject(new Error(errors || `exit ${code}`))));
  return { process, done };
}
test('atomic writes are private and malformed state is never reset', async t => {
  const dir = await fixture(t), file = dir + '/state.json';
  assert.equal(await readJson(file), undefined);
  await writeJson(file, { count: 0 });
  await Promise.all(Array.from({ length: 40 }, (_, count) => writeJson(file, { count })));
  assert.equal(typeof (await readJson(file)).count, 'number');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await writeFile(file, '{broken');
  await assert.rejects(readJson(file), SyntaxError);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
test('separate processes serialize writes and recover a dead holder without stealing a new lock', async t => {
  const dir = await fixture(t), file = dir + '/count.json', script = dir + '/worker.mjs';
  await writeJson(file, { count: 0 });
  await writeFile(script, `import {withLock,readJson,writeJson} from ${JSON.stringify(new URL('../plugin/store.ts', import.meta.url).href)};
    const [file,mode]=process.argv.slice(2);
    if(mode==='hold')await withLock(file,async()=>{console.log('locked');await new Promise(r=>setTimeout(r,30000));});
    else for(let i=0;i<8;i++)await withLock(file,async()=>{const x=await readJson(file);await new Promise(r=>setTimeout(r,2));await writeJson(file,{count:x.count+1});});`);
  const holder = child(script, [file, 'hold']);
  await new Promise(resolve => holder.process.stdout.once('data', resolve));
  holder.process.kill('SIGKILL'); await holder.done;
  await Promise.all(Array.from({ length: 8 }, () => child(script, [file, 'increment']).done));
  assert.deepEqual(await readJson(file), { count: 64 });
});
test('a live lock and an aborted waiter cannot enter the critical section', async t => {
  const dir = await fixture(t), file = dir + '/state.json', abort = new AbortController();
  let release, entered = false;
  const held = withLock(file, () => new Promise(resolve => { release = resolve; }));
  while (!release) await new Promise(r => setTimeout(r, 1));
  const waiter = withLock(file, async () => { entered = true; }, abort.signal);
  setTimeout(() => abort.abort(), 40);
  await assert.rejects(waiter, { name: 'AbortError' });
  assert.equal(entered, false); release(); await held;
});
