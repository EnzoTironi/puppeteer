import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Latch } from '../plugin/latch.ts';
import { Plow } from '../plugin/plow.ts';
import { Requests } from '../plugin/requests.ts';
import { bindPuppeteerTurn, endPuppeteerTurn, registerPuppeteer } from '../plugin/puppeteer.ts';

const owner = {chat:'cht_owner',message:'msg_owner',session:'agent:main:main',owner:true,prompt:'Set up Puppeteer on my Mac'};
const guest = {chat:'cht_group',message:'msg_guest',session:'agent:main:plow:group:cht_group',owner:false,prompt:'/prompt Fix the failing test'};
const member = {type:'member',uid:'mem_owner',role:'owner',provider_key:'+15550000001'};
const self = {type:'agent',relationship:'self',line:{uid:'ln_p3'}};
let server, base, directory, requests, responses, wire, chats, sources;
const completed = value => ({status:'completed',exit_code:0,output:JSON.stringify(value)+'\n'});
before(async()=>{
 server=createServer(async(req,res)=>{
  let value;
  const route=new URL(req.url,'http://fixture');
  if(req.method==='POST') {
   const chunks=[]; for await(const c of req) chunks.push(c);
   const body=JSON.parse(Buffer.concat(chunks).toString()); wire.push(body.params);
   value={jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify(responses.shift())}]}};
  } else {
   assert.equal(req.headers.authorization,'Bearer cloud-only-token');
   value=route.pathname==='/v1/agents/me' ? {line:{uid:'ln_p3'},chats:Object.values(chats)}
    : route.pathname==='/v1/chats' ? {data:Object.values(chats),has_more:false}
    : route.pathname.endsWith('/messages') ? {data:sources,has_more:false}
    : chats[route.pathname.split('/').at(-1)];
  }
  res.writeHead(value?200:404,{'content-type':'application/json'}); res.end(JSON.stringify(value??{}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
beforeEach(async t=>{
 directory=await mkdtemp(join(tmpdir(),'puppeteer-setup-')); t.after(()=>rm(directory,{recursive:true,force:true}));
 responses=[];wire=[];
 chats={cht_owner:{uid:'cht_owner',status:'active',participants:[member,self]},
  cht_group:{uid:'cht_group',status:'active',display_name:'Demo',participants:[member,self,{type:'member',uid:'mem_guest',role:'member'}]}};
 sources=[owner,guest].map(turn=>({uid:turn.message,chat_uid:turn.chat,direction:'inbound',body:turn.prompt,
  sender:{type:'member',uid:turn.owner?'mem_owner':'mem_guest'},created_at:new Date().toISOString()}));
 requests=new Requests(new Latch('latch-only-token',base+'/mcp'),directory,undefined,new Plow(base,'cloud-only-token'));
 process.env.PUPPETEER_BRIDGE_COMMIT='1'.repeat(40);
});

test('owner installation is fixed, pinned and resumes the original approval',async()=>{
 responses.push({status:'pending',reason:'awaiting_approval',handle:'secret-approval'}, {status:'ready',result:{status:'completed',exit_code:0,output:'installed'}});
 const receipt=await requests.setup(owner,{action:'install'});
 assert.equal(receipt.status,'awaiting_approval');
 assert.deepEqual(wire[0].arguments.argv,['uv','tool','install','--force','git+https://github.com/EnzoTironi/puppeteer.git@'+'1'.repeat(40)]);
 assert.deepEqual(await requests.setup(owner,{action:'install'}),receipt);
 assert.equal((await requests.result(owner,receipt.request)).installed,true);
 assert.deepEqual(wire.map(r=>r.name),['plow_run_command','plow_get_result']);
});
test('a cold installation keeps polling the original job when running output omits its handle, including after restart',async()=>{
 responses.push({status:'running',handle:'install-job',output:'start',output_length:5},
  {status:'running',output:' more',output_length:10},
  {status:'completed',exit_code:0,output:' done',output_length:15});
 const receipt=await requests.setup(owner,{action:'install'});
 assert.equal(receipt.status,'running');
 requests=new Requests(new Latch('latch-only-token',base+'/mcp'),directory,undefined,new Plow(base,'cloud-only-token'));
 const pending=await requests.result(owner,receipt.request);
 assert.equal(pending.status,'running'); assert.equal(pending.error,undefined);
 assert.equal((await requests.result(owner,receipt.request)).installed,true);
 assert.deepEqual(wire.map(r=>r.name),['plow_run_command','plow_get_output','plow_get_output']);
 assert.deepEqual(wire.slice(1).map(r=>r.arguments),[{handle:'install-job',since:5},{handle:'install-job',since:10}]);
});
test('a streamed coding-agent listing assembles incremental output while running polls omit the handle',async()=>{
 const chunks=['{"agents":[','{"alias":"coder","backend":"codex","status":"idle"}',']}\n'];
 const size=i=>Buffer.byteLength(chunks.slice(0,i+1).join(''));
 responses.push({status:'running',handle:'agents-job',output:chunks[0],output_length:size(0)},
  {status:'running',output:chunks[1],output_length:size(1)},
  {status:'completed',exit_code:0,output:chunks[2],output_length:size(2)});
 const receipt=await requests.agents(guest);
 assert.equal(receipt.status,'running');
 assert.equal((await requests.result(guest,receipt.request)).status,'running');
 assert.deepEqual((await requests.result(guest,receipt.request)).agents,[{alias:'coder',backend:'codex',status:'idle'}]);
 assert.deepEqual(wire.map(r=>r.name),['plow_run_command','plow_get_output','plow_get_output']);
 assert.deepEqual(wire.slice(1).map(r=>r.arguments),[{handle:'agents-job',since:size(0)},{handle:'agents-job',since:size(1)}]);
});
test('a turn that expires during source verification cannot start a Mac operation',async()=>{
 await assert.rejects(requests.setup({...owner,assertCurrent(){throw new Error('turn_expired');}},{action:'install'}),/turn_expired/);
 await assert.rejects(requests.ask({...guest,assertCurrent(){throw new Error('turn_expired');}},'coder'),/turn_expired/);
 assert.equal(wire.length,0);
});
test('owner pairing uses private staging, replaces explicit grants and keeps its key out of results and ledgers',async()=>{
 responses.push(completed({pairing_prepared:true}),{bytes:200},completed({configured:true,chats:['cht_owner','cht_group']}));
 const result=await requests.setup(owner,{action:'share',target:'sam/demo:coder',group:'cht_group'});
 assert.equal(result.configured,true);
 assert.deepEqual(wire.map(r=>r.name),['plow_run_command','plow_write_file','plow_run_command']);
 assert.deepEqual(wire[0].arguments.argv,['puppeteer-bridge','prepare','--request',result.request]);
 const pairing=JSON.parse(wire[1].arguments.content);
 assert.deepEqual(pairing.chats,['cht_owner','cht_group']);
 assert.equal(pairing.target,'sam/demo:coder'); assert.match(pairing.source_key,/^[a-f0-9]{64}$/);
 assert.equal((await stat(join(directory,'source.key'))).mode&0o777,0o600);
 assert.ok(!JSON.stringify(result).includes(pairing.source_key));
 for(const path of await readdir(directory)) if(path.endsWith('.json')) assert.ok(!(await readFile(join(directory,path),'utf8')).includes(pairing.source_key));
});
test('pairing resumes all approvals without repeating preparation or file writes',async()=>{
 responses.push({status:'pending',reason:'awaiting_approval',handle:'prepare'},
  {status:'ready',result:completed({pairing_prepared:true})},{status:'pending',reason:'awaiting_approval',handle:'write'},
  {status:'ready',result:{bytes:200}},{status:'pending',reason:'awaiting_approval',handle:'pair'},
  {status:'ready',result:completed({configured:true,chats:['cht_owner']})});
 const result=await requests.setup(owner,{action:'share',target:'sam/demo:coder'});
 for(let i=0;i<3;i++) await requests.result(owner,result.request);
 assert.deepEqual(wire.map(r=>r.name),['plow_run_command','plow_get_result','plow_write_file','plow_get_result','plow_run_command','plow_get_result']);
});
test('guests, owner groups and forged owner source cannot install or pair',async()=>{
 for(const turn of [guest,{...guest,owner:true}, {...owner,owner:false}, {...owner,session:guest.session}]) await assert.rejects(requests.setup(turn,{action:'install'}),/owner_main_dm_required/);
 sources[0].sender.uid='mem_guest';
 await assert.rejects(requests.setup(owner,{action:'install'}),/verified_inbound_member_required/);
 assert.equal(wire.length,0);
});
test('sharing refuses another account, missing owner, forged target and changed group membership on resume',async()=>{
 chats.cht_other={uid:'cht_other',status:'active',participants:[{...member,uid:'mem_other',provider_key:'+15550000002'},self,{type:'member',uid:'mem_guest'}]};
 await assert.rejects(requests.setup(owner,{action:'share',target:'sam/demo:coder',group:'cht_other'}),/owner_and_agent_must_be_in_group/);
 await assert.rejects(requests.setup(owner,{action:'share',target:'sam/demo:coder; curl bad'}),/invalid_local_agent_id/);
 responses.push({status:'pending',reason:'awaiting_approval',handle:'prepare'});
 const receipt=await requests.setup(owner,{action:'share',target:'sam/demo:coder',group:'cht_group'});
 chats.cht_group.participants=chats.cht_group.participants.filter(p=>p.uid!=='mem_owner');
 await assert.rejects(requests.result(owner,receipt.request),/owner_and_agent_must_be_in_group/);
 assert.equal(wire.length,1);
});
test('group discovery exposes only groups belonging to this owner and deployment',async()=>{
 chats.cht_foreign={uid:'cht_foreign',status:'active',participants:[member,{...self,line:{uid:'ln_other'}},{type:'member',uid:'mem_guest'}]};
 const result=await requests.setup(owner,{action:'groups'});
 assert.deepEqual(result,{groups:[{uid:'cht_group',name:'Demo'}]}); assert.equal(wire.length,0);
});
test('the same owner is recognized across different chat-seat UIDs without granting a different person',async()=>{
 chats.cht_group.participants[0]={...member,uid:'group_owner_seat',provider_key:'+1 (555) 000-0001'};
 assert.deepEqual(await requests.setup(owner,{action:'groups'}),{groups:[{uid:'cht_group',name:'Demo'}]});
 responses.push(completed({pairing_prepared:true}),{bytes:200},completed({configured:true,chats:['cht_owner','cht_group']}));
 assert.equal((await requests.setup(owner,{action:'share',target:'sam/demo:coder',group:'cht_group'})).configured,true);
 chats.cht_group.participants[0].provider_key='+15550000002';
 assert.deepEqual(await requests.setup(owner,{action:'groups'}),{groups:[]});
});
test('signed dispatch uses original Plow text and never forwards cloud credentials or the source key',async()=>{
 responses.push(completed({request:'a'.repeat(32),agent:'coder',status:'submitted'}));
 const result=await requests.ask(guest,'coder');
 const args=wire[0].arguments.argv;
 const proof=args[args.indexOf('--source')+1], signature=args[args.indexOf('--signature')+1];
 const source=JSON.parse(Buffer.from(proof,'base64url').toString());
 assert.equal(source.body,guest.prompt); assert.equal(source.uid,guest.message); assert.equal(source.chat_uid,guest.chat);
 const key=await readFile(join(directory,'source.key'),'utf8');
 assert.equal(signature,createHmac('sha256',Buffer.from(key,'hex')).update(proof).digest('hex'));
 assert.ok(!JSON.stringify(wire).includes(key)); assert.ok(!JSON.stringify(wire).includes('cloud-only-token'));
 assert.ok(!wire[0].arguments.read_paths.includes('~/.config/plow/token'));
 assert.ok(!JSON.stringify(result).includes(proof));
});
test('a model cannot replace verified source text, author, direction, age or conversation',async()=>{
 for(const change of [{body:'/prompt replacement'},{sender:{type:'agent',uid:'mem_guest'}},{direction:'outbound'},
  {created_at:'2020-01-01T00:00:00Z'},{chat_uid:'cht_owner'}]) {
  const original={...sources[1]}; Object.assign(sources[1],change);
  await assert.rejects(requests.ask(guest,'coder')); sources[1]=original;
 }
 assert.equal(wire.length,0);
});
test('the SDK setup tool requires the actual live owner DM and rejects command/path/key fields',async()=>{
 const tools=[],hooks=new Map(); globalThis.__puppeteerRequests=requests;
 registerPuppeteer({on:(n,f)=>hooks.set(n,f),registerTool:f=>tools.push(f)});
 const tool=tools.find(f=>f.create({}).name==='puppeteer_setup');
 bindPuppeteerTurn('run-owner',owner);
 const ctx={messageChannel:'plow',agentAccountId:'chat',nativeChannelId:owner.chat,requesterSenderId:'plow-owner',senderIsOwner:true,sessionKey:owner.session,assertInvocationCurrent:()=>{}};
 for(const args of [{action:'install',argv:['curl','bad']},{action:'install',path:'/private'},{action:'share',target:'sam/demo:coder',source_key:'forged'}]) {
  hooks.get('before_tool_call')({toolName:'puppeteer_setup',toolCallId:'call',runId:'run-owner'},{sessionKey:owner.session});
  assert.equal((await tool.create(ctx).execute('call',args)).isError,true);
 }
 for(const change of [{senderIsOwner:false},{requesterSenderId:'guest'},{sessionKey:guest.session},{nativeChannelId:'cht_group'}]) {
  hooks.get('before_tool_call')({toolName:'puppeteer_setup',toolCallId:'call',runId:'run-owner'},{sessionKey:owner.session});
  assert.equal((await tool.create({...ctx,...change}).execute('call',{action:'install'})).isError,true);
 }
 endPuppeteerTurn('run-owner'); assert.equal(wire.length,0);
});


test('parallel pairing keeps owner-selected Boss, project and worker limit, and stop is owner-only',async()=>{
 responses.push(completed({pairing_prepared:true}),{bytes:1},completed({configured:true,chats:['cht_owner','cht_group']}));
 const result=await requests.setup(owner,{action:'share',target:'mac/main:Boss',project:'mac/demo:coder',workers:4,group:'cht_group'});
 assert.equal(result.configured,true);
 const write=wire.find(row=>row.name==='plow_write_file');assert.ok(write);
 assert.deepEqual(JSON.parse(write.arguments.content).parallel,{project:'mac/demo:coder',workers:4});
 responses.push(completed({paused:true,cancelled:3,uncertain:0}));
 sources.push({uid:'msg_stop',chat_uid:owner.chat,direction:'inbound',body:'Stop the demo',sender:{type:'member',uid:'mem_owner'},created_at:new Date().toISOString()});
 const stopped=await requests.setup({...owner,message:'msg_stop',prompt:'Stop the demo'},{action:'stop'});
 assert.equal(stopped.paused,true);assert.equal(stopped.cancelled,3);
 assert.deepEqual(wire.at(-1).arguments.argv,['puppeteer-bridge','stop']);
 assert.equal(wire.at(-1).arguments.network,true);
 await assert.rejects(requests.setup(guest,{action:'stop'}),/owner_main_dm_required/);
});

test('easy onboarding prepares a group workspace with fixed arguments, then shares its verified returned IDs',async()=>{
 responses.push(completed({demo_prepared:true,target:'sam/main:Boss',project:'sam/puppeteer-demo-012345:coder',boss_created:false,cwd:'/private/not-for-the-model',source_key:'private-fixture'}));
 const prepared=await requests.setup(owner,{action:'demo',group:'cht_group'});
 assert.equal(prepared.demo_prepared,true);assert.equal(prepared.workers,4);assert.equal(prepared.next,'share');
 assert.equal(prepared.boss_created,false);
 assert.ok(!JSON.stringify(prepared).includes('/private'));assert.ok(!JSON.stringify(prepared).includes('private-fixture'));
 assert.deepEqual(wire[0].arguments.argv,['puppeteer-bridge','demo','--group','cht_group']);
 assert.equal(wire[0].arguments.network,true);
 assert.equal(wire.length,1,'preparing alone does not write pairing grants');
 responses.push(completed({pairing_prepared:true}),{bytes:200},completed({configured:true,chats:['cht_owner','cht_group']}));
 const shared=await requests.setup(owner,{action:'share',target:prepared.target,project:prepared.project,workers:4,group:'cht_group'});
 assert.equal(shared.configured,true);
 const config=JSON.parse(wire.find(row=>row.name==='plow_write_file').arguments.content);
 assert.equal(config.target,prepared.target);assert.deepEqual(config.parallel,{project:prepared.project,workers:4});
});
test('demo creation resumes its original Latch job across restart and verifies the group again',async()=>{
 const body=JSON.stringify({demo_prepared:true,target:'sam/demo:Boss',project:'sam/demo:coder',boss_created:true});
 responses.push({status:'running',handle:'demo-job',output:body.slice(0,20),output_length:20},
  {status:'completed',exit_code:0,output:body.slice(20)+'\n'});
 const receipt=await requests.setup(owner,{action:'demo',group:'cht_group'});
 assert.equal(receipt.status,'running');
 requests=new Requests(new Latch('latch-only-token',base+'/mcp'),directory,undefined,new Plow(base,'cloud-only-token'));
 const result=await requests.result(owner,receipt.request);
 assert.equal(result.demo_prepared,true);assert.equal(result.boss_created,true);
 assert.deepEqual(wire.map(row=>row.name),['plow_run_command','plow_get_output']);
 assert.deepEqual(wire[1].arguments,{handle:'demo-job',since:20});
});
test('demo setup cannot be reused to create resources for a second group or a different Boss',async()=>{
 chats.cht_second={...chats.cht_group,uid:'cht_second'};
 responses.push(completed({demo_prepared:true,target:'sam/main:Boss',project:'sam/demo:coder',boss_created:false}));
 const first=await requests.setup(owner,{action:'demo',group:'cht_group'});
 assert.deepEqual(await requests.setup(owner,{action:'demo',group:'cht_group'}),first);
 await assert.rejects(requests.setup(owner,{action:'demo',group:'cht_second'}),/setup_message_already_used/);
 await assert.rejects(requests.setup(owner,{action:'demo',group:'cht_group',target:'sam/other:Boss'}),/setup_message_already_used/);
 assert.equal(wire.length,1);
});
test('guests, forged owners and groups without the owner cannot create a demo Boss or project',async()=>{
 for(const turn of [guest,{...guest,owner:true}, {...owner,owner:false}, {...owner,session:guest.session}])
  await assert.rejects(requests.setup(turn,{action:'demo',group:'cht_group'}),/owner_main_dm_required/);
 chats.cht_group.participants[0]={...member,provider_key:'+15550000002'};
 await assert.rejects(requests.setup(owner,{action:'demo',group:'cht_group'}),/owner_and_agent_must_be_in_group/);
 assert.equal(wire.length,0);
});
test('a pending demo does not continue after group membership is revoked',async()=>{
 responses.push({status:'pending',reason:'awaiting_approval',handle:'demo-approval'});
 const first=await requests.setup(owner,{action:'demo',group:'cht_group'});
 chats.cht_group.participants=chats.cht_group.participants.filter(p=>p.uid!=='mem_owner');
 await assert.rejects(requests.result(owner,first.request),/owner_and_agent_must_be_in_group/);
 assert.equal(wire.length,1);
});
test('the SDK demo tool rejects raw project paths, arbitrary commands and extra project selections',async()=>{
 const tools=[],hooks=new Map();globalThis.__puppeteerRequests=requests;
 registerPuppeteer({on:(n,f)=>hooks.set(n,f),registerTool:f=>tools.push(f)});
 const factory=tools.find(f=>f.create({}).name==='puppeteer_setup');
 const ctx={messageChannel:'plow',agentAccountId:'chat',nativeChannelId:owner.chat,requesterSenderId:'plow-owner',senderIsOwner:true,sessionKey:owner.session,assertInvocationCurrent:()=>{}};
 bindPuppeteerTurn('run-demo',owner);
 for(const args of [{action:'demo'}, {action:'demo',group:'../bad'}, {action:'demo',group:'cht_group',path:'/private'},
  {action:'demo',group:'cht_group',project:'sam/private:coder'},{action:'demo',group:'cht_group',workers:8},
  {action:'demo',group:'cht_group',target:'sam/main:Boss; touch nope'}]) {
  hooks.get('before_tool_call')({toolName:'puppeteer_setup',toolCallId:'call-demo',runId:'run-demo'},{sessionKey:owner.session});
  assert.equal((await factory.create(ctx).execute('call-demo',args)).isError,true);
 }
 endPuppeteerTurn('run-demo');assert.equal(wire.length,0);
});

test('fresh owner setup gate uses confirmed state, skips guest turns, and rejects corrupt receipts', async()=>{
 const previousBase=process.env.PLOW_API_BASE,previousToken=process.env.PLOW_AGENT_TOKEN;
 process.env.PLOW_API_BASE=base;process.env.PLOW_AGENT_TOKEN='cloud-only-token';process.env.PUPPETEER_STATE_DIR=directory;
 const tools=[],hooks=new Map();globalThis.__puppeteerRequests=requests;
 registerPuppeteer({on:(name,fn)=>hooks.set(name,fn),registerTool:f=>tools.push(f),logger:{info(){},warn(){}}});
 bindPuppeteerTurn('gate-owner',owner);bindPuppeteerTurn('gate-guest',guest);
 try {
  assert.equal(await hooks.get('before_prompt_build')({}, {channel:'plow',accountId:'chat',trigger:'user',runId:'gate-guest',sessionKey:guest.session}),undefined);
  for(const scope of [{channel:'email'},{accountId:'email'},{trigger:'cron'},{senderId:'guest'},{chatId:'cht_group'}])
   assert.equal(await hooks.get('before_prompt_build')({}, {channel:'plow',accountId:'chat',trigger:'user',sessionKey:owner.session,...scope}),undefined);
  const first=await hooks.get('before_prompt_build')({}, {channel:'plow',accountId:'chat',trigger:'user',runId:'gate-owner',sessionKey:owner.session});
  assert.match(first.prependContext,/SETUP_NEEDED/);assert.equal(wire.length,0);
  responses.push(completed({pairing_prepared:true}),{bytes:1},completed({configured:true,chats:['cht_owner','cht_group']}));
  await requests.setup(owner,{action:'share',target:'sam/main:Boss',project:'sam/demo:coder',workers:4,group:'cht_group'});
  const configured=await hooks.get('before_prompt_build')({}, {channel:'plow',accountId:'chat',trigger:'user',runId:'gate-owner',sessionKey:owner.session});
  assert.match(configured.prependContext,/CONFIGURED/);assert.match(configured.prependContext,/without repeating onboarding/);
  const {writeFile}=await import('node:fs/promises');await writeFile(join(directory,'f'.repeat(32)+'.json'),'{broken');
  const unavailable=await hooks.get('before_prompt_build')({}, {channel:'plow',accountId:'chat',trigger:'user',runId:'gate-owner',sessionKey:owner.session});
  assert.match(unavailable.prependContext,/could not be checked/);assert.match(unavailable.prependContext,/Do not claim/);
 } finally {
  endPuppeteerTurn('gate-owner');endPuppeteerTurn('gate-guest');delete process.env.PUPPETEER_STATE_DIR;
  if(previousBase===undefined)delete process.env.PLOW_API_BASE;else process.env.PLOW_API_BASE=previousBase;
  if(previousToken===undefined)delete process.env.PLOW_AGENT_TOKEN;else process.env.PLOW_AGENT_TOKEN=previousToken;
 }
});
test('read-only status and explicit resume use fixed owner-only Mac commands',async()=>{
 responses.push(completed({connection_checked:true,configured:true,paused:true}));
 const status=await requests.setup(owner,{action:'status'});assert.equal(status.connection_checked,true);assert.equal(status.paused,true);
 assert.deepEqual(wire[0].arguments.argv,['puppeteer-bridge','status']);assert.equal(wire[0].arguments.network,false);
 assert.equal(wire[0].arguments.write_paths,undefined);
 sources.push({uid:'msg_resume',chat_uid:owner.chat,direction:'inbound',body:'Resume the demo',sender:{type:'member',uid:'mem_owner'},created_at:new Date().toISOString()});
 responses.push(completed({resumed:true}));const resumed=await requests.setup({...owner,message:'msg_resume',prompt:'Resume the demo'},{action:'resume'});
 assert.equal(resumed.resumed,true);assert.deepEqual(wire[1].arguments.argv,['puppeteer-bridge','resume']);assert.equal(wire[1].arguments.network,false);
 await assert.rejects(requests.setup(guest,{action:'resume'}),/owner_main_dm_required/);
});
