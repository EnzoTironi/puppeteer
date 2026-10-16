import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { isPrompt } from '../plugin/puppeteer.ts';
import { promptCommand, requestText } from '../plugin/replies.ts';

const { cases } = JSON.parse(await readFile(new URL('fixtures/triggers.json', import.meta.url), 'utf8'));

test('the shared trigger table: explicit requests only, at the very start', () => {
  for (const [body, expected] of cases) {
    assert.equal(requestText(body), expected ?? undefined, JSON.stringify(body));
    assert.equal(isPrompt(body), expected !== null, JSON.stringify(body));
  }
  for (const value of [null, undefined, 42, {}]) assert.equal(isPrompt(value), false);
});

test('name triggers reach the same fixed commands as /prompt', () => {
  assert.deepEqual(promptCommand('Puppeteer, status A1234567 full'), { kind: 'status', request: 'a1234567', full: true });
  assert.deepEqual(promptCommand('@Puppeteer ask owner Which file?'), { kind: 'owner_question', question: 'Which file?' });
  assert.deepEqual(promptCommand('Puppeteer: agents'), { kind: 'agents' });
  for (const body of ['Puppeteer?', 'Puppeteer,', '@Puppeteer', 'Puppeteer, help', 'puppeteer: what can you do?']) assert.deepEqual(promptCommand(body), { kind: 'help' }, body);
  assert.deepEqual(promptCommand('Puppeteer, fix the failing test'), { kind: 'task' });
});
