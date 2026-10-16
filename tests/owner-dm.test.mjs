import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import entry from '/opt/plow/plugin/dist/index.js';
import puppeteerEntry from '/opt/puppeteer/plugin/index.js';
const {WebSocketServer}=createRequire('/opt/plow/plugin/package.json')('ws');

// Runs in the image (CI image job), against the real patched Plow channel.
test("the owner's DM: /prompt goes to the fixed router, named conversation stays with the model, strangers keep the fabrication guard", async t => {
 const root=await mkdtemp(tmpdir()+'/puppeteer-dm-');
 process.env.OPENCLAW_STATE_DIR=root;process.env.PLOW_AGENT_TOKEN='test-token';process.env.PLOW_MCP_BRIDGE_TOKEN='fixture-mcp';
 process.env.PUPPETEER_STATE_DIR=root+'/requests';process.env.PUPPETEER_GROUP_POLL_MS='20';globalThis.__puppeteerRequests=undefined;
 await writeFile(root+'/plow-listening-since',new Date(Date.now()-60_000).toISOString());
 // A confirmed share receipt: the owner's DM is connected to a parallel workspace.
 await mkdir(root+'/requests',{recursive:true});
 await writeFile(root+'/requests/'+'c'.repeat(32)+'.json',JSON.stringify({chat:'cht_dm',message:'msg_setup',created:Date.now()-1000,completed:Date.now()-1000,
  action:{kind:'share',target:'host/main:Boss',chats:['cht_dm'],phase:'pair',project:'host/demo:coder',workers:4},
  stage:{kind:'done',value:{configured:true,agents:['coder'],chats:['cht_dm']}}}));
 const server=new WebSocketServer({port:0});await new Promise(r=>server.on('listening',r));
 process.env.PLOW_API_BASE='http://127.0.0.1:'+server.address().port;
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
 t.after(async()=>{clearTimeout(timeout);controller.abort();for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,50));await rm(root,{recursive:true,force:true,maxRetries:3});});
 const self={type:'agent',relationship:'self',line:{uid:'line'}};
 const owner={type:'member',uid:'owner',role:'owner',display_name:'Owner',provider_key:'+15550000001'};
 const stranger={type:'member',uid:'stranger',role:'member',display_name:'Stranger',provider_key:'+15550000002'};
 const chats={cht_dm:{uid:'cht_dm',status:'active',trusted:false,participants:[owner,self]},cht_stranger:{uid:'cht_stranger',status:'active',trusted:false,participants:[stranger,self]}};
 const now=new Date().toISOString();
 const inbound=[
  {uid:'msg_task',chat_uid:'cht_dm',direction:'inbound',sender:owner,body:'/prompt Explain this project',attachments:[],created_at:now},
  {uid:'msg_named',chat_uid:'cht_dm',direction:'inbound',sender:owner,body:'Puppeteer, pause the demo',attachments:[],created_at:now},
  {uid:'msg_stranger',chat_uid:'cht_stranger',direction:'inbound',sender:stranger,body:'/prompt Explain this project',attachments:[],created_at:now},
 ];
 const commands=[],sent=[],prepared=new Map(),done=new Set();let channel;
 const stop=()=>{if(done.size===3&&sent.some(s=>s.text.includes('coder replied:')))controller.abort();};
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const path=new URL(url).pathname;
  if(String(url).endsWith(':18790/mcp')) {
   const rpc=JSON.parse(init.body),argv=rpc.params.arguments.argv;commands.push(argv);
   const value=argv[1]==='ask'?{request:'d'.repeat(32),agent:'coder',status:'queued'}:{request:argv[2],agent:'coder',status:'replied',reply:'The entry point is main.py.'};
   return Response.json({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify({status:'completed',exit_code:0,output:JSON.stringify(value)+'\n'})}]}});
  }
  if(init?.method==='POST'&&path.endsWith('/messages')){sent.push({chat:path.split('/')[3],text:JSON.parse(init.body).body});stop();return Response.json({uid:'out_'+sent.length});}
  const chat=Object.values(chats).find(c=>path.endsWith('/chats/'+c.uid));
  return Response.json(path.endsWith('/agents/me')?{line:{uid:'line'},chats:Object.values(chats)}:path.endsWith('/chats')?{data:Object.values(chats),has_more:false}
   :path.endsWith('/messages')?{data:inbound.filter(m=>path.includes(m.chat_uid)).toReversed(),has_more:false}:chat??{ticket:'ticket'});
 });
 const api={registrationMode:'full',config:{},on(){},registerTool(){},logger:{info(){},warn(){}},registerChannel:({plugin})=>{channel=plugin;},
  runtime:{channel:{routing:{resolveAgentRoute:({peer})=>({agentId:'main',sessionKey:peer?.id==='plow-owner'?'agent:main:main':'agent:main:plow:direct:'+peer?.id})},
   inbound:{buildContext:async value=>value,dispatch:async args=>{
    const message=args.ctxPayload.messageId;
    const result=args.delivery.preparePayload({text:'Paused. Nothing new will start.'},{kind:'final'});
    prepared.set(message,result?.text);
    return {dispatched:true,dispatchResult:{deliberateSilentTerminalReply:true}};
   }}}}};
 puppeteerEntry.register(api);entry.register(api);
 server.on('connection',socket=>{for(const message of inbound)socket.send(JSON.stringify({event_type:'message_received',event_id:message.uid,chat_id:message.chat_uid,data:{message}}));});
 await channel.gateway.startAccount({account:{apiBase:process.env.PLOW_API_BASE,accountId:'chat',lineUid:'line',guestTools:['puppeteer_agents','puppeteer_ask','puppeteer_result','puppeteer_ask_owner']},
  cfg:{messages:{queue:{mode:'followup'}}},abortSignal:controller.signal,
  log:{info(text){const hit=text.match(/^(?:completed|acked) chat=\S+ message=(msg_\w+)/);if(hit){done.add(hit[1]);stop();}}}});
 // /prompt from the owner: the fixed router asked the Mac once, posted the receipt, then the actual reply.
 assert.deepEqual(commands.filter(argv=>argv[1]==='ask').map(argv=>argv[argv.indexOf('--message')+1]),['msg_task']);
 const mine=sent.filter(s=>s.chat==='cht_dm').map(s=>s.text);
 assert.ok(mine.some(text=>/Queued for a separate coding worker/.test(text)),mine.join('\n---\n'));
 assert.ok(mine.some(text=>/coder replied:[\s\S]*The entry point is main\.py\./.test(text)),mine.join('\n---\n'));
 assert.ok(!prepared.has('msg_task'),'the router, not the model, answered the /prompt');
 // "Puppeteer, …" from the owner is conversation: the model answers and its words are not replaced.
 assert.equal(prepared.get('msg_named'),'Paused. Nothing new will start.');
 // A stranger's /prompt in their own DM still goes to the model, whose unverified final is replaced.
 assert.match(prepared.get('msg_stranger')??'',/couldn't confirm a result/);
});
