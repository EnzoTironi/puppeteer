import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderConfig, syncConfig } from '/opt/plow/boot/config.js';
import { startGateway } from '/opt/plow/boot/process.js';
const {WebSocketServer}=createRequire('/opt/plow/plugin/package.json')('ws');
const root=await mkdtemp(join(tmpdir(),'puppeteer-gateway-'));
process.env.OPENCLAW_STATE_DIR=root;
process.env.OPENCLAW_CONFIG_PATH=join(root,'openclaw.json');
process.env.OPENCLAW_INCLUDE_ROOTS=join(root,'includes');
process.env.PUPPETEER_STATE_DIR=join(root,'receipts');
process.env.PLOW_AGENT_TOKEN='fixture-plow-token';
process.env.PLOW_MCP_BRIDGE_TOKEN='fixture-mcp-token';
process.env.OPENCLAW_GATEWAY_PASSWORD='fixture-gateway-password';
process.env.OPENCLAW_NO_RESPAWN='1';
process.env.PUPPETEER_GROUP_POLL_MS='40';
const members=Array.from({length:100},(_,i)=>({type:'member',uid:'mem_'+i,role:i===0?'owner':'member',display_name:'Attendee '+i,provider_key:'+1555'+String(i).padStart(7,'0')}));
const chat={uid:'cht_stage',status:'active',trusted:false,display_name:'Closed stage fixture',participants:[...members,{type:'agent',relationship:'self',line:{uid:'ln_stage',display_name:'Puppeteer'}}]};
const ownerChat={uid:'cht_owner',status:'active',trusted:true,display_name:'Owner SDK probe',participants:[members[0],chat.participants.at(-1)]};
const messages=[],outbound=[],commands=[],modelTools=[],acked=new Set(),native=new Map(),nativeQueue=[];
let nativeActive=0,nativePeak=0;
function advanceWorkers() { while(nativeActive<4&&nativeQueue.length) {const request=nativeQueue.shift(),job=native.get(request);nativeActive++;nativePeak=Math.max(nativePeak,nativeActive);job.status="submitted";setTimeout(()=>{job.status="replied";nativeActive--;advanceWorkers();},40+(3-(job.index%4))*40);}}
let modelCalls=0,published=false,ownerPublished=false,child,log='',failure,doneResolve;
const done=new Promise(r=>{doneResolve=r;});
const toolOutput=message=>{
 const text=typeof message.content==='string'?message.content:JSON.stringify(message.content);
 try{return JSON.parse(text);}catch{return undefined;}
};
function sse(res,delta,finish) {
 const chunk={id:'chatcmpl-fixture-'+modelCalls,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'z-ai/glm-5.2',choices:[{index:0,delta,finish_reason:null}]};
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write('data: '+JSON.stringify(chunk)+'\n\n');
 res.write('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\n');
 res.end('data: [DONE]\n\n');
}
async function handle(req,res) {
 const url=new URL(req.url,'http://127.0.0.1'); const path=url.pathname;
 const chunks=[]; for await(const chunk of req)chunks.push(chunk);
 const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
 const json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 if(path.endsWith('/chat/completions')) {
  modelCalls++; const names=(body.tools??[]).map(tool=>tool.function.name); modelTools.push(names);
  for(const tool of ['puppeteer_agents','puppeteer_ask','puppeteer_result'])assert.ok(names.includes(tool));
  const previous=body.messages.filter(m=>m.role==='tool').at(-1); const value=previous?toolOutput(previous):undefined;
  let name,args;
  if(!previous) {name='puppeteer_ask';args={agent:'coder'};}
  else if(['queued','submitted','pending','running'].includes(value?.status)) {name='puppeteer_result';args={request:value.request};}
  else if(value?.status==='replied') return sse(res,{role:'assistant',content:'I ran 200 tests and everything passed.'},'stop');
  else {failure='Unexpected real SDK tool response: '+JSON.stringify(value); return sse(res,{role:'assistant',content:'Fixture could not verify the result.'},'stop');}
  return sse(res,{role:'assistant',tool_calls:[{index:0,id:'call-'+modelCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
 }
 if(path==='/mcp') {
  const argv=body.params?.arguments?.argv; commands.push(argv);
  let value;
  if(argv?.[1]==='ask') {
   const message=argv[argv.indexOf('--message')+1],index=Number(message.split('_').at(-1)),request=createHash('sha256').update(message).digest('hex').slice(0,32);
   assert.ok(messages.some(m=>m.uid===message));assert.ok(!native.has(request));native.set(request,{index,message,status:'queued'});nativeQueue.push(request);value={request,agent:'coder',status:'queued'};advanceWorkers();
  }
  else if(argv?.[1]==='result') {
   const job=native.get(argv[2]);assert.ok(job);
   if(job.message==='msg_owner_0')while(job.status!=='replied')await new Promise(r=>setTimeout(r,20));
   value={request:argv[2],agent:'coder',status:job.status,...(job.status==='replied'?{reply:'Actual coding answer for '+job.message}: {})};
  } else throw new Error('Unexpected Mac operation');
  return json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify({status:'completed',exit_code:0,output:JSON.stringify(value)+'\n'})}]}});
 }
 if(path==='/v1/agents/me')return json({agent:{name:'Puppeteer'},line:{uid:'ln_stage'}});
 if(path==='/v1/chats')return json({data:[chat,ownerChat],has_more:false});
 if(path==='/v1/chats/cht_owner')return json(ownerChat);
 if(path==='/v1/chats/cht_stage')return json(chat);
 if(path==='/v1/ws/ticket')return json({ticket:'fixture-ticket'});
 if(['/v1/chats/cht_stage/messages','/v1/chats/cht_owner/messages'].includes(path) && req.method==='POST') {
  outbound.push(body.body); json({uid:'msg_out_'+outbound.length});
  if(outbound.filter(text=>text.includes('coder replied:')).length===100&&!ownerPublished) {
   ownerPublished=true;const message={uid:'msg_owner_0',chat_uid:ownerChat.uid,direction:'inbound',sender:members[0],body:'/prompt Explain the native owner SDK probe',attachments:[],created_at:new Date().toISOString()};messages.push(message);
   for(const socket of sockets.clients)socket.send(JSON.stringify({event_type:'message_received',event_id:message.uid,chat_id:ownerChat.uid,data:{message}}));
  }
  if(outbound.some(text=>text.endsWith('Actual coding answer for msg_owner_0')))doneResolve(); return;
 }
 if(path.endsWith('/ack')) {acked.add(path.split('/').at(-2));return json({ok:true});}
 if(['/v1/chats/cht_stage/messages','/v1/chats/cht_owner/messages'].includes(path)) {
  const ordered=messages.filter(m=>m.chat_uid===path.split('/')[3]).toReversed(),cursor=url.searchParams.get('starting_after'),start=cursor?Math.max(0,ordered.findIndex(m=>m.uid===cursor)+1):0,limit=Number(url.searchParams.get('limit')??50);
  return json({data:ordered.slice(start,start+limit),has_more:start+limit<ordered.length});
 }
 if(path.endsWith('/typing'))return json({ok:true});
 return json({ok:true});
}
const server=createServer((req,res)=>handle(req,res).catch(e=>{failure=String(e);res.writeHead(500);res.end('Fixture failed');doneResolve();}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const mcp=createServer((req,res)=>handle(req,res).catch(e=>{failure=String(e);res.writeHead(500);res.end('Fixture failed');doneResolve();}));
await new Promise(r=>mcp.listen(18790,'127.0.0.1',r));
const sockets=new WebSocketServer({server});
sockets.on('connection',socket=>{
 if(published)return; published=true;
 setTimeout(()=>{
  const now=new Date().toISOString();
  for(let i=0;i<100;i++)messages.push({uid:'msg_stage_'+i,chat_uid:chat.uid,direction:'inbound',sender:members[i],body:'/prompt Explain the demo session for attendee '+i,attachments:[],created_at:now});
  for(const message of messages)socket.send(JSON.stringify({event_type:'message_received',event_id:message.uid,chat_id:chat.uid,data:{message}}));
 },250);
});
const base='http://127.0.0.1:'+server.address().port;
process.env.PLOW_API_BASE=base;
await mkdir(join(root,'workspace'),{recursive:true});
await writeFile(join(root,'workspace/AGENTS.md'),await (await import('node:fs/promises')).readFile('/opt/plow/prompt/AGENTS.md','utf8'));
const cfg=renderConfig({agent:{name:'Puppeteer'},line:{uid:'ln_stage'},chats:[chat]},base);
cfg.agents.defaults.workspace=join(root,'workspace');
await syncConfig(cfg,process.env.OPENCLAW_CONFIG_PATH,process.env.OPENCLAW_INCLUDE_ROOTS);
const started=Date.now();
child=await startGateway(true);
child.stdout.on('data',chunk=>{log+=chunk;}); child.stderr.on('data',chunk=>{log+=chunk;});
child.once('exit',code=>{if(code && !failure)failure='Gateway exited '+code;doneResolve();});
const timeout=setTimeout(()=>{failure??='Gateway stage fixture timed out';doneResolve();},60_000);
try {
 await done; clearTimeout(timeout);
 if(failure)throw new Error(failure);
 assert.equal(outbound.length,201);
 assert.equal(outbound.filter(text=>text.includes('Queued for a separate')).length,100);
 assert.equal(commands.filter(argv=>argv?.[1]==='ask').length,101);
 assert.equal(nativePeak,4);assert.ok(modelCalls>=3);
 for(let i=0;i<100;i++)assert.ok(outbound.some(text=>text.startsWith('Attendee '+i+' · #')&&text.endsWith('Actual coding answer for msg_stage_'+i)));
 const checkpoint=JSON.parse(await (await import('node:fs/promises')).readFile(join(root,'plow-checkpoints/cht_stage'),'utf8'));assert.equal(checkpoint.recent.length,100);
 assert.ok(outbound.some(text=>text.endsWith('Actual coding answer for msg_owner_0')));
 assert.ok(outbound.every(text=>!text.includes('200 tests')&&!text.includes('everything passed')));
 const proof={type:'full real OpenClaw gateway and Plow channel; simulated native workers and Latch',participants:100,acceptedTasks:100,uniqueLocalDispatches:100,verifiedFinalReplies:100,simulatedNativeWorkerPeak:nativePeak,groupModelCalls:0,ownerSdkModelCalls:modelCalls,ownerFabricatedFinalReplaced:true,repliesMatchedOriginalParticipants:true,adoptedMessages:checkpoint.recent.length,fixtureElapsedMs:Date.now()-started,examples:outbound.filter(text=>text.includes('coder replied:')).slice(0,4)};
 if(process.env.PUPPETEER_GATEWAY_EVIDENCE)await writeFile(process.env.PUPPETEER_GATEWAY_EVIDENCE,JSON.stringify(proof,null,2)+'\n');
 console.log('GATEWAY_STAGE_OK '+JSON.stringify(proof));
} catch(e) {console.error(e);console.error(log.slice(-6000));process.exitCode=1;}
finally {clearTimeout(timeout);child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);});for(const s of sockets.clients)s.terminate();await new Promise(r=>sockets.close(r));await new Promise(r=>server.close(r));await new Promise(r=>mcp.close(r));}
