import { Latch } from '/opt/puppeteer/plugin/latch.js';
import { Plow } from '/opt/puppeteer/plugin/plow.js';
import { Requests } from '/opt/puppeteer/plugin/requests.js';
import { Groups } from '/opt/puppeteer/plugin/groups.js';
import { Questions } from '/opt/puppeteer/plugin/questions.js';

const directory = process.env.PUPPETEER_STATE_DIR ?? '/var/lib/plow/puppeteer';
const plow = new Plow(process.env.PLOW_API_BASE ?? '',process.env.PLOW_AGENT_TOKEN ?? '');
const requests = new Requests(new Latch(process.env.PLOW_MCP_BRIDGE_TOKEN ?? ''),directory,undefined,plow);
const groups = new Groups(requests,plow,directory);
const questions = new Questions(plow,requests,directory,async () => { throw new Error('recovery_does_not_replay_questions'); });
const signal = AbortSignal.timeout(90_000);
await questions.recover();
const result = await groups.recoverOnce((chat,text) => plow.send(chat,text,signal),signal);
process.stdout.write(JSON.stringify(result)+'\n');
