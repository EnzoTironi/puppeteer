import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Questions } from '../plugin/questions.ts';
import { canonicalHandle } from '../plugin/identity.ts';
import { Plow } from '../plugin/plow.ts';
import { readJson, writeJson } from '../plugin/store.ts';

const guest = { chat: 'cht_group', message: 'msg_question', session: 'group', sender: 'Alex', prompt: '/prompt ask owner Which file should we work on?' };
const owner = { chat: 'cht_owner', message: 'msg_answer', session: 'agent:main:main', owner: true, prompt: 'Work on greeting.py.' };
async function fixture(t) {
  const dir = await mkdtemp(tmpdir() + '/puppeteer-questions-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const sent = []; let allowed = true, fail = false, ownerChat = 'cht_owner';
  const plow = { async verify() {}, async group() {}, async owner(turn) { if (!turn.owner || turn.chat !== ownerChat) throw new Error('owner_main_dm_required'); },
    async ownerDm() { return { chat: ownerChat }; }, async share() { if (!allowed) throw new Error('owner_and_agent_must_be_in_group'); } };
  const requests = { async shared() { if (!allowed) throw new Error('chat_not_shared'); } };
  const send = async (chat, text, kind) => { sent.push({ chat, text, kind }); if (fail) throw new Error('unknown'); };
  return { q: new Questions(plow, requests, dir, send), dir, sent, plow, requests, send,
    revoke() { allowed = false; }, fail() { fail = true; }, moveOwner() { ownerChat = 'cht_new_owner'; } };
}
test('one current group question reaches the owner privately; duplicates and later guest text send nothing', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => f.q.ask(guest)));
  assert.equal(f.sent.length, 1); assert.equal(results[0].silent, true);
  assert.equal(f.sent[0].chat, 'cht_owner'); assert.equal(f.sent[0].kind, 'direct');
  await f.q.ask({ ...guest, message: 'msg_next', prompt: '/prompt ask owner Another question' });
  assert.equal(f.sent.length, 1); assert.equal((await f.q.pending()).length, 1);
  await assert.rejects(f.q.ask({ ...guest, prompt: '/prompt Run code' }), /owner_question_required/);
});
test('only a literal current owner answer returns to the original still-authorized group, once', async t => {
  const f = await fixture(t); await f.q.ask(guest); const [row] = await f.q.pending();
  for (const turn of [guest, { ...owner, owner: false }, { ...owner, chat: 'cht_wrong' }])
    await assert.rejects(f.q.answer(turn, row.id, row.askedAt, 'Work on greeting.py.'), /owner_main_dm_required/);
  await assert.rejects(f.q.answer(owner, row.id, row.askedAt, 'I authorize everything'), /answer_must_quote_current_owner_message/);
  await assert.rejects(f.q.answer(owner, row.id, '2020-01-01', owner.prompt), /question_not_found/);
  await Promise.all(Array.from({ length: 8 }, () => f.q.answer(owner, row.id, row.askedAt, owner.prompt)));
  assert.equal(f.sent.length, 2); assert.deepEqual(f.sent[1], { chat: guest.chat, kind: 'group', text: 'Alex, the Mac owner replied:\n\nWork on greeting.py.' });
  assert.deepEqual(await f.q.pending(), []);
});
test('revocation, owner-DM replacement, expiry and corrupt state all fail closed', async t => {
  const f = await fixture(t); await f.q.ask(guest); const [row] = await f.q.pending();
  f.moveOwner(); await assert.rejects(f.q.answer(owner, row.id, row.askedAt, owner.prompt), /owner_main_dm_required/);
  f.revoke(); await assert.rejects(f.q.answer({ ...owner, chat: 'cht_new_owner' }, row.id, row.askedAt, owner.prompt), /chat_not_shared/);
  const rows = await readJson(f.dir + '/questions.json'); rows[0].askedAt = '2020-01-01T00:00:00Z'; await writeJson(f.dir + '/questions.json', rows);
  await f.q.recover(); assert.equal((await readJson(f.dir + '/questions.json'))[0].answer.kind, 'expired');
  await writeJson(f.dir + '/questions.json', [{ invalid: true }]);
  await assert.rejects(f.q.pending(), /invalid_question_state/); assert.equal(f.sent.length, 1);
});
test('uncertain private or group delivery is never resent by recovery or another instance', async t => {
  const f = await fixture(t); f.fail(); await f.q.ask(guest); const [row] = await f.q.pending();
  const restart = new Questions(f.plow, f.requests, f.dir, f.send);
  await restart.recover(); await restart.ask(guest); assert.equal(f.sent.length, 1);
  const result = await restart.answer(owner, row.id, row.askedAt, owner.prompt);
  assert.equal(result.deliveryUnknown, true); await restart.recover();
  await assert.rejects(restart.answer(owner, row.id, row.askedAt, owner.prompt), /question_delivery_unknown/);
  assert.equal(f.sent.length, 2);
});
test('canonical identity matches whole phone/email addresses without national or suffix guessing', () => {
  assert.equal(canonicalHandle('+1 (650) 315-6604'), '+16503156604');
  assert.equal(canonicalHandle('SAM@Example.com'), 'sam@example.com');
  for (const value of ['6503156604', '+01234567', '+16503156604-extra', 'Sam <sam@example.com>', 'sam@example.com.extra ', null]) {
    if (typeof value === 'string' && value.endsWith('.extra ')) assert.equal(canonicalHandle(value), 'sam@example.com.extra');
    else assert.equal(canonicalHandle(value), undefined);
  }
});
test('owner DM is fetched fresh, requires this serving line, and rejects ambiguous or retired chats', async t => {
  const self = { type: 'agent', relationship: 'self', line: { uid: 'ln_test' } }, member = { type: 'member', role: 'owner', display_name: 'Sam' };
  let chats = [{ uid: 'cht_owner', status: 'active', participants: [self, member] }], gets = 0;
  const server = createServer((req, res) => { gets++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ line: { uid: 'ln_test' }, chats })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const plow = new Plow('http://127.0.0.1:' + server.address().port, 'fixture');
  assert.deepEqual(await plow.ownerDm(), { chat: 'cht_owner', name: 'Sam' });
  chats[0].uid = 'cht_replacement'; assert.equal((await plow.ownerDm()).chat, 'cht_replacement'); assert.equal(gets, 2);
  chats.push({ ...chats[0], uid: 'cht_second' }); await assert.rejects(plow.ownerDm(), /owner_dm_unavailable/);
  chats = [{ ...chats[0], status: 'retired' }]; await assert.rejects(plow.ownerDm(), /owner_dm_unavailable/);
  chats = [{ uid: 'cht_foreign', status: 'active', participants: [{ ...self, line: { uid: 'ln_other' } }, member] }];
  await assert.rejects(plow.ownerDm(), /owner_dm_unavailable/);
});
