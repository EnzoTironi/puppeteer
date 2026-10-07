import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import entry from '/opt/plow/plugin/dist/index.js';
import puppeteerEntry from '/opt/puppeteer/plugin/index.js';
const {WebSocketServer}=createRequire('/opt/plow/plugin/package.json')('ws');
const guestTools=['puppeteer_agents','puppeteer_ask','puppeteer_result','puppeteer_ask_owner'];

for (const owner of [false,true]) for(const trusted of [false,true]) test(`real group ingress: owner=${owner}, trusted=${trusted}`, async t => {
 const root=await mkdtemp(tmpdir()+'/puppeteer-ingress-');
 process.env.OPENCLAW_STATE_DIR=root;process.env.PLOW_AGENT_TOKEN='test-token';process.env.PLOW_MCP_BRIDGE_TOKEN='fixture-mcp';
 process.env.PUPPETEER_STATE_DIR=root+'/requests';process.env.PUPPETEER_GROUP_POLL_MS='20';globalThis.__puppeteerRequests=undefined;
 await writeFile(root+'/plow-listening-since',new Date().toISOString());
 const server=new WebSocketServer({port:0});await new Promise(r=>server.on('listening',r));
 process.env.PLOW_API_BASE='http://127.0.0.1:'+server.address().port;
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
 t.after(async()=>{clearTimeout(timeout);controller.abort();for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,50));await rm(root,{recursive:true,force:true,maxRetries:3});});
 const member={type:'member',uid:owner?'owner':'guest',role:owner?'owner':'member',display_name:'Participant',provider_key:'+15550000001'};
 const chat={uid:'cht_group',status:'active',trusted,participants:[{...member,uid:'owner',role:'owner'},{...member,uid:'guest',role:'member'},{type:'agent',relationship:'self',line:{uid:'line'}}]};
 const bodies=['ordinary conversation','some /prompt inside text','/promptfoo nope',' /prompt nope','/PROMPT nope','/prompt First task','/prompt Second task'];
 const inbound=bodies.map((body,i)=>({uid:'msg_'+i,chat_uid:chat.uid,direction:'inbound',sender:member,body,attachments:[],created_at:new Date().toISOString()}));
 const logs=[],acked=new Set(),commands=[],sent=[],requests=new Map();let channel,modelCalls=0;
 const stop=()=>{if(acked.size===7&&sent.filter(s=>s.includes('coder replied:')).length===2)controller.abort();};
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const path=new URL(url).pathname;
  if(String(url).endsWith(':18790/mcp')) {
   const rpc=JSON.parse(init.body),argv=rpc.params.arguments.argv;commands.push(argv);let value;
   if(argv[1]==='ask') {const message=argv[argv.indexOf('--message')+1],request=(message==='msg_5'?'a':'b').repeat(32);requests.set(request,message);value={request,agent:'coder',status:'queued'};}
   else value={request:argv[2],agent:'coder',status:'replied',reply:'Actual answer for '+requests.get(argv[2])};
   return Response.json({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify({status:'completed',exit_code:0,output:JSON.stringify(value)+'\n'})}]}});
  }
  if(init?.method==='POST'&&path.endsWith('/messages')){sent.push(JSON.parse(init.body).body);stop();return Response.json({uid:'out_'+sent.length});}
  return Response.json(path.endsWith('/agents/me')?{line:{uid:'line'}}:path.endsWith('/chats')?{data:[chat],has_more:false}:path.endsWith('/chats/cht_group')?chat:path.endsWith('/messages')?{data:inbound.toReversed(),has_more:false}:{ticket:'ticket'});
 });
 const api={registrationMode:'full',config:{},on(){},registerTool(){},logger:{info(){}},registerChannel:({plugin})=>{channel=plugin;},runtime:{channel:{routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:'group-session'})},inbound:{buildContext:async value=>value,dispatch:async()=>{modelCalls++;throw new Error('Group task should not invoke the cloud model');}}}}};
 puppeteerEntry.register(api);entry.register(api);
 server.on('connection',socket=>{for(const message of inbound)socket.send(JSON.stringify({event_type:'message_received',event_id:message.uid,chat_id:chat.uid,data:{message}}));});
 await channel.gateway.startAccount({account:{apiBase:process.env.PLOW_API_BASE,accountId:'chat',lineUid:'line',guestTools},cfg:{messages:{queue:{mode:'followup'}}},abortSignal:controller.signal,log:{info(text){logs.push(text);const hit=text.match(/^(?:ignored non-command|acked) chat=cht_group message=(msg_\d+)/);if(hit){acked.add(hit[1]);stop();}}}});
 assert.equal(acked.size,7,logs.join('\n'));assert.equal(modelCalls,0);
 assert.deepEqual(commands.filter(argv=>argv[1]==='ask').map(argv=>argv[argv.indexOf('--message')+1]).sort(),['msg_5','msg_6']);
 assert.equal(sent.filter(text=>text.includes('Queued for a separate')).length,2);assert.equal(sent.filter(text=>text.includes('coder replied:')).length,2);
 assert.ok(sent.some(text=>text.includes('Actual answer for msg_5')));assert.ok(sent.some(text=>text.includes('Actual answer for msg_6')));
 const checkpoint=JSON.parse(await readFile(root+'/plow-checkpoints/cht_group','utf8'));assert.ok(checkpoint.recent.includes('msg_5'));assert.ok(checkpoint.recent.includes('msg_6'));
});
