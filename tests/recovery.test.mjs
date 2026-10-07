import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plan, reconcile, SPEC } from '../scripts/register-crons.mjs';

test('reconciliation creates only Puppeteer maintenance and preserves unrelated jobs', () => {
  assert.deepEqual(plan([{ id: 'other', name: 'owner-reminder' }]), [{ op: 'create' }]);
  assert.deepEqual(plan([{ id: 'ours', ...SPEC, enabled: true }, { id: 'other', name: 'owner-reminder' }]), []);
  assert.deepEqual(plan([{ id: 'ours', ...SPEC, enabled: false, schedule: { kind: 'every', everyMs: 1 } }, { id: 'dup', ...SPEC }]),
    [{ op: 'edit', id: 'ours' }, { op: 'enable', id: 'ours' }, { op: 'remove', id: 'dup' }]);
  assert.equal(SPEC.payload.kind, 'command'); assert.equal(SPEC.delivery.mode, 'none'); assert.equal(SPEC.schedule.everyMs, 300_000);
});
test('unavailable, corrupt or truncated scheduler listings cannot cause blind creation', () => {
  for (const reply of ['broken', '{}', '{"jobs":[],"has_more":true}', '{"jobs":[{"name":"puppeteer-recover"}]}']) {
    const calls = []; assert.throws(() => reconcile(argv => { calls.push(argv); return reply; })); assert.equal(calls.length, 1);
  }
  const calls = []; reconcile(argv => { calls.push(argv); return JSON.stringify({ jobs: [] }); });
  assert.equal(calls[1][0], 'add'); assert.ok(calls[1].includes('--command-argv')); assert.ok(calls[1].includes('--no-deliver'));
  assert.ok(calls[1].includes('--declaration-key'));
});
