import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Latch } from '../plugin/latch.ts';
import { Requests } from '../plugin/requests.ts';
import { isPrompt, bindPuppeteerTurn, endPuppeteerTurn, registerPuppeteer } from '../plugin/puppeteer.ts';

const turn = {chat: 'cht_shared', message: 'msg_human', session: 'agent:main:plow:group:cht_shared', prompt: '/prompt Fix greeting.py'};
const localReceipt = { request: 'a'.repeat(32), agent: 'coder', status: 'submitted' };
let server, directory, requests, address, wire, responses;
before(async () => {
 server = createServer(async (req, res) => {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  wire.push({headers:req.headers, body});
  const payload = responses.shift();
  if (payload?.http) { res.writeHead(payload.http); res.end('Mac unavailable'); return; }
  const rpc = {jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(payload)}]}};
  if (payload?.sse) { res.writeHead(200,{'content-type':'text/event-stream'}); res.end('data: '+JSON.stringify(rpc)+'\n\n'); }
  else { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(rpc)); }
 });
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
 address='http://127.0.0.1:'+server.address().port+'/mcp';
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
beforeEach(async t => {
 directory=await mkdtemp(join(tmpdir(),'puppeteer-tools-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 wire=[]; responses=[];
 requests=new Requests(new Latch('fixture-token',address),directory);
});
const completed = value => ({status:'completed',exit_code:0,output:JSON.stringify(value)+'\n'});

test('only literal /prompt at the start enters group dispatch', () => {
 for(const text of ['/prompt','/prompt hi','/prompt\nhi','/prompt\thi']) assert.equal(isPrompt(text),true,text);
 for(const text of ['hi','hi /prompt fix','/promptfoo fix',' /prompt fix','/PROMPT fix','/prompt: fix','/prompt\u200b fix',null]) assert.equal(isPrompt(text),false,text);
});
test('modern MCP headers, exact source IDs and shell-free argv are fixed by the tool', async () => {
 responses.push(completed(localReceipt));
 const result=await requests.ask(turn,'coder');
 assert.equal(result.status,'submitted');
 const {headers,body}=wire[0];
 assert.equal(headers.authorization,'Bearer fixture-token');
 assert.equal(headers['mcp-name'],'plow_run_command');
 assert.equal(headers['mcp-method'],'tools/call');
 assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'],'2026-07-28');
 assert.deepEqual(body.params.arguments.argv,['puppeteer-bridge','ask','--chat','cht_shared','--message','msg_human','--agent','coder']);
 assert.equal(body.params.arguments.network,true);
 assert.ok(!JSON.stringify(body).includes(turn.prompt));
 assert.ok(!JSON.stringify(result).includes('fixture-token'));
});
test('empty and forged aliases never reach Latch', async () => {
 await assert.rejects(requests.ask({...turn,prompt:'/prompt'},'coder'),/prompt_text_required/);
 for (const alias of ['../private','coder; rm -rf','--help','coder\nconfigure']) await assert.rejects(requests.ask(turn,alias),/invalid_agent_alias/);
 assert.equal(wire.length,0);
});
test('concurrent duplicate asks and reconnects send once', async () => {
 responses.push({status:'pending',reason:'awaiting_approval',handle:'private-approval'});
 const results=await Promise.all([requests.ask(turn,'coder'),requests.ask(turn,'coder')]);
 assert.deepEqual(results[0],results[1]);
 assert.equal(results[0].status,'awaiting_approval');
 requests=new Requests(new Latch('fixture-token',address),directory);
 assert.deepEqual(await requests.ask(turn,'coder'),results[0]);
 assert.equal(wire.length,1);
 assert.ok(!JSON.stringify(results).includes('private-approval'));
 await assert.rejects(requests.ask(turn,'private'),/already_routed/);
});
test('approval and job handles stay private, polling resumes instead of replaying', async () => {
 responses.push({status:'pending',reason:'awaiting_approval',handle:'approval'},
  {status:'ready',result:{status:'running',handle:'job',output:'',output_length:0}},
  completed(localReceipt),completed({...localReceipt,status:'replied',reply:'Fixed. Test passed.'}));
 const receipt=await requests.ask(turn,'coder');
 assert.equal((await requests.result(turn,receipt.request)).status,'running');
 assert.equal((await requests.result(turn,receipt.request)).status,'submitted');
 const answer=await requests.result(turn,receipt.request);
 assert.equal(answer.reply,'Fixed. Test passed.');
 assert.deepEqual(wire.map(r=>r.body.params.name),['plow_run_command','plow_get_result','plow_get_output','plow_run_command']);
 assert.deepEqual(wire[3].body.params.arguments.argv,['puppeteer-bridge','result',localReceipt.request,'--chat','cht_shared','--wait','15']);
 assert.ok(!JSON.stringify(answer).includes('approval'));
});
test('other chats cannot read even a valid operation receipt', async () => {
 responses.push(completed(localReceipt));
 const receipt=await requests.ask(turn,'coder');
 await assert.rejects(requests.result({...turn,chat:'cht_other'},receipt.request),/request_not_shared/);
 await assert.rejects(requests.result(turn,'../requests'),/request_not_shared/);
 assert.equal(wire.length,1);
});
test('a finished reply rechecks the Mac grant before later disclosure', async () => {
 responses.push(completed({...localReceipt,status:'replied',reply:'original answer'}),completed({error:'chat_not_shared'}));
 const receipt=await requests.ask(turn,'coder');
 const result=await requests.result(turn,receipt.request);
 assert.equal(result.error,'chat_not_shared');
 assert.equal(result.reply,undefined);
 assert.equal(wire.length,2);
});
test('uncertain HTTP delivery is retained without retrying the command', async () => {
 responses.push({http:503});
 const receipt=await requests.ask(turn,'coder');
 assert.equal(receipt.status,'delivery_unknown');
 assert.equal((await requests.result(turn,receipt.request)).status,'delivery_unknown');
 assert.equal((await requests.ask(turn,'coder')).status,'delivery_unknown');
 assert.equal(wire.length,1);
});
test('Latch denial is terminal, and SSE responses retain their JSON payload', async () => {
 responses.push({status:'denied',sse:true});
 const receipt=await requests.ask(turn,'coder');
 assert.equal(receipt.error,'latch_denied');
 assert.deepEqual(await requests.result(turn,receipt.request),receipt);
 assert.equal(wire.length,1);
});
test('SDK tools reject model-supplied routing and require the live inbound turn', async () => {
 const tools=[], hooks=new Map();
 globalThis.__puppeteerRequests=requests;
 const api={on:(name,fn)=>hooks.set(name,fn),registerTool:factory=>tools.push(factory)};
 registerPuppeteer(api);
 const context={messageChannel:'plow',agentAccountId:'chat',nativeChannelId:turn.chat,requesterSenderId:'+15550000000',sessionKey:turn.session,assertInvocationCurrent:()=>{}};
 const ask=tools[1].create(context);
 const hook=hooks.get('before_tool_call');
 assert.ok(hook({toolName:'puppeteer_ask',toolCallId:'missing',runId:'absent'},{sessionKey:turn.session}).block);
 bindPuppeteerTurn('run-1',turn);
 hook({toolName:'puppeteer_ask',toolCallId:'forge',runId:'run-1'},{sessionKey:turn.session});
 let out=await ask.execute('forge',{agent:'coder',chat:'cht_other',message:'msg_private',prompt:'replacement'});
 assert.equal(out.isError,true); assert.equal(wire.length,0);
 hook({toolName:'puppeteer_ask',toolCallId:'valid',runId:'run-1'},{sessionKey:turn.session});
 responses.push(completed(localReceipt));
 out=await ask.execute('valid',{agent:'coder'});
 assert.equal(out.details.status,'submitted'); assert.equal(wire.length,1);
 hook({toolName:'puppeteer_ask',toolCallId:'stale',runId:'run-1'},{sessionKey:turn.session});
 endPuppeteerTurn('run-1');
 assert.equal((await ask.execute('stale',{agent:'coder'})).isError,true);
 assert.equal(wire.length,1);
});
test('SDK source binding cannot be reused by another chat or account', async () => {
 const tools=[], hooks=new Map(); globalThis.__puppeteerRequests=requests;
 registerPuppeteer({on:(name,fn)=>hooks.set(name,fn),registerTool:f=>tools.push(f)});
 bindPuppeteerTurn('run-2',turn);
 for (const changes of [{nativeChannelId:'cht_other'},{agentAccountId:'email'},{messageChannel:'telegram'},{requesterSenderId:undefined},{sessionKey:'other'}]) {
  const context={messageChannel:'plow',agentAccountId:'chat',nativeChannelId:turn.chat,requesterSenderId:'guest',sessionKey:turn.session,assertInvocationCurrent:()=>{},...changes};
  hooks.get('before_tool_call')({toolName:'puppeteer_agents',toolCallId:'call',runId:'run-2'},{sessionKey:turn.session});
  assert.equal((await tools[0].create(context).execute('call',{})).isError,true);
 }
 endPuppeteerTurn('run-2'); assert.equal(wire.length,0);
});
