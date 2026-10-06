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
   value=route.pathname==='/v1/agents/me' ? {line:{uid:'ln_p3'}}
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
