import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import entry from '/opt/plow/plugin/dist/index.js';
const {WebSocketServer}=createRequire('/opt/plow/plugin/package.json')('ws');
const guestTools=['puppeteer_agents','puppeteer_ask','puppeteer_result'];

for (const owner of [false,true]) for(const trusted of [false,true]) test(`real Plow group ingress filters traffic and binds both prompts: owner=${owner}, trusted=${trusted}`, async t => {
 const root=await mkdtemp(tmpdir()+'/puppeteer-ingress-');
 process.env.OPENCLAW_STATE_DIR=root;
 process.env.PLOW_AGENT_TOKEN='test-token'; process.env.PLOW_MCP_BRIDGE_TOKEN='fixture-mcp';
 process.env.PUPPETEER_STATE_DIR=root+'/requests';
 globalThis.__puppeteerRequests=undefined;
 await writeFile(root+'/plow-listening-since',new Date().toISOString());
 const server=new WebSocketServer({port:0});
 await new Promise(resolve=>server.on('listening',resolve));
 process.env.PLOW_API_BASE='http://127.0.0.1:'+server.address().port;
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),4000);
 t.after(async()=>{clearTimeout(timeout);controller.abort();for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:3});});
 const member={type:'member',uid:owner?'owner':'guest',role:owner?'owner':'member',display_name:'Participant',provider_key:'+15550000001'};
 const chat={uid:'cht_group',status:'active',trusted,participants:[{...member,uid:'owner',role:'owner'}, {...member,uid:'guest',role:'member'}, {type:'agent',relationship:'self',line:{uid:'line'}}]};
 const bodies=['ordinary conversation','some /prompt inside text','/promptfoo nope',' /prompt nope','/PROMPT nope','/prompt First task','/prompt Second task'];
 const inbound=bodies.map((body,i)=>({uid:'msg_'+i,chat_uid:chat.uid,direction:'inbound',sender:member,body,attachments:[],created_at:new Date().toISOString()}));
 const logs=[], acked=new Set(), dispatched=[], commands=[],hooks=new Map(),tools=[];
 let channel;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  if(String(url).endsWith(':18790/mcp')){
   const rpc=JSON.parse(init.body); const args=rpc.params.arguments;
   commands.push(args.argv);
   return Response.json({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify({status:'completed',output:JSON.stringify({request:'a'.repeat(32),agent:'coder',status:'submitted'})+'\n',exit_code:0})}]}});
  }
  return Response.json(String(url).endsWith('/agents/me')?{line:{uid:'line'}}:String(url).endsWith('/chats')?{data:[chat],has_more:false}:String(url).endsWith('/chats/cht_group')?chat:String(url).includes('/messages?')?{data:[...inbound.toReversed(),{...inbound[0],uid:'history',body:'private ordinary history'}],has_more:false}:{ticket:'ticket'});
 });
 entry.register({registrationMode:'full',config:{},on:(name,fn)=>hooks.set(name,fn),registerTool:f=>tools.push(f),logger:{info(){}},registerChannel:({plugin})=>{channel=plugin;},runtime:{channel:{
  routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:'group-session'})},
  inbound:{buildContext:async value=>{assert.deepEqual(value.access.toolPolicy,{allow:guestTools});assert.ok(value.message.inboundHistory.every(row=>/^\/prompt(?:[ \t\r\n]|$)/.test(row.body)));return value;},dispatch:async dispatch=>{
   dispatched.push(dispatch.ctxPayload.message.rawBody);
   const uid=dispatch.ctxPayload.messageId;
   dispatch.replyOptions.onAgentRunStart('run-'+uid);
   const context={messageChannel:'plow',agentAccountId:'chat',nativeChannelId:'cht_group',requesterSenderId:owner?'plow-owner':member.provider_key,senderIsOwner:owner,sessionKey:'group-session',assertInvocationCurrent(){}};
   const tool=tools.filter(f=>f.contextVersion===2).map(f=>f.create(context)).find(tool=>tool.name==='puppeteer_ask');
   hooks.get('before_tool_call')({toolName:tool.name,toolCallId:uid,runId:'run-'+uid},{sessionKey:'group-session'});
   const result=await tool.execute(uid,{agent:'coder'});
   logs.push('fixture tool result '+JSON.stringify(result));
   assert.equal(result.details.status,'submitted',JSON.stringify(result));
   assert.equal(dispatch.replyOptions.sourceReplyDeliveryMode,'automatic');
   dispatch.replyOptions.onAgentRunTerminalOutcome('completed');
   dispatch.replyOptions.onObservedReplyDelivery();
   return {dispatched:true,dispatchResult:{counts:{final:1},observedReplyDelivery:true}};
  }},
 }}});
 server.on('connection',socket=>{for(const message of inbound)socket.send(JSON.stringify({event_type:'message_received',event_id:message.uid,chat_id:chat.uid,data:{message}}));});
 assert.ok(channel);
 await channel.gateway.startAccount({account:{apiBase:'http://127.0.0.1:'+server.address().port,accountId:'chat',lineUid:'line',guestTools},cfg:{messages:{visibleReplies:'automatic',queue:{mode:'followup'}}},abortSignal:controller.signal,log:{info(text){logs.push(text);const hit=text.match(/^(?:ignored non-command|acked) chat=cht_group message=(msg_\d+)/);if(hit){acked.add(hit[1]);if(acked.size===inbound.length)controller.abort();}}}});
 assert.deepEqual(dispatched,['/prompt First task','/prompt Second task'],logs.join('\n'));
 assert.equal(acked.size,inbound.length,logs.join('\n'));
 assert.deepEqual(commands.map(argv=>argv[argv.indexOf('--message')+1]).sort(),['msg_5','msg_6']);
 const checkpoint=JSON.parse(await readFile(root+'/plow-checkpoints/cht_group','utf8'));
 assert.ok(checkpoint.recent.includes('msg_5'));
 assert.ok(checkpoint.recent.includes('msg_6'));
});
