import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SPEC = { name: 'puppeteer-recover', schedule: { kind: 'every', everyMs: 300_000 },
  sessionTarget: 'isolated', payload: { kind: 'command', argv: ['node','/opt/puppeteer/scripts/recover.mjs'], timeoutSeconds: 120 }, delivery: { mode: 'none' } };

export function plan(jobs) {
  if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job.id !== 'string' || typeof job.name !== 'string')) throw new Error('invalid_cron_listing');
  const ours = jobs.filter(job => job.name === SPEC.name), actions = [];
  if (!ours.length) return [{ op: 'create' }];
  const [first,...duplicates] = ours;
  const drift = first.schedule?.kind !== 'every' || first.schedule?.everyMs !== SPEC.schedule.everyMs
    || first.sessionTarget !== 'isolated' || first.payload?.kind !== 'command'
    || JSON.stringify(first.payload?.argv) !== JSON.stringify(SPEC.payload.argv)
    || first.payload?.timeoutSeconds !== 120 || first.delivery?.mode !== 'none';
  if (drift) actions.push({ op: 'edit', id: first.id });
  if (first.enabled === false) actions.push({ op: 'enable', id: first.id });
  for (const job of duplicates) actions.push({ op: 'remove', id: job.id });
  return actions;
}

export function reconcile(run = argv => {
  const result = spawnSync('node',['/app/openclaw.mjs','cron',...argv],{encoding:'utf8',timeout:120_000,maxBuffer:65_536});
  if (result.status !== 0) throw new Error('scheduler_operation_failed');
  return result.stdout;
}) {
  let listing;
  try { listing = JSON.parse(run(['list','--all','--json'])); } catch { throw new Error('scheduler_listing_unavailable'); }
  if (listing?.hasMore || listing?.has_more) throw new Error('scheduler_listing_truncated');
  const actions = plan(listing?.jobs);
  const spec = ['--every','5m','--session','isolated','--command-argv',JSON.stringify(SPEC.payload.argv),'--timeout-seconds','120','--no-deliver'];
  for (const action of actions) {
    if (action.op === 'create') run(['add','--name',SPEC.name,'--declaration-key',SPEC.name,...spec,'--json']);
    else if (action.op === 'edit') run(['edit',action.id,...spec]);
    else if (action.op === 'enable') run(['edit',action.id,'--enable']);
    else run(['rm',action.id,'--json']);
  }
  return actions;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { setupStatus } = await import('/opt/puppeteer/plugin/setup.js');
  const state = await setupStatus(process.env.PUPPETEER_STATE_DIR ?? '/var/lib/plow/puppeteer');
  if (state.status === 'SETUP_NEEDED') process.stdout.write(JSON.stringify({ skipped: 'not-configured' })+'\n');
  else process.stdout.write(JSON.stringify({ actions: reconcile() })+'\n');
}
