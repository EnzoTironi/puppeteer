import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import entry from '/opt/plow/plugin/dist/index.js';
const {WebSocketServer}=createRequire('/opt/plow/plugin/package.json')('ws');
const audience=['puppeteer_agents','puppeteer_ask','puppeteer_result'];

test('100-person group: 1004 messages, 60 duplicates, 100 separate receipts and automatic verified replies',async t=>{
 const root=await mkdtemp(tmpdir()+'/puppeteer-load-');
 process.env.OPENCLAW_STATE_DIR=root;process.env.PLOW_AGENT_TOKEN='fixture';process.env.PLOW_MCP_BRIDGE_TOKEN='fixture';process.env.PUPPETEER_STATE_DIR=root+'/requests';process.env.PUPPETEER_GROUP_POLL_MS='20';globalThis.__puppeteerRequests=undefined;
 await writeFile(root+'/plow-listening-since',new Date(Date.now()-1000).toISOString());
 const members=Array.from({length:100},(_,i)=>({type:'member',uid:'guest_'+i,role:i===0?'owner':'member',display_name:'Attendee '+i,provider_key:'+1555'+String(i).padStart(7,'0')}));
 const chat={uid:'cht_load',status:'active',trusted:false,display_name:'Stage rehearsal',participants:[...members,{type:'agent',relationship:'self',line:{uid:'line'}}]};
 const noise=['ordinary chat','Here is /prompt in a sentence',' /prompt leading space','/PROMPT upper case','/promptfoo prefix'];
 const inbound=Array.from({length:1000},(_,i)=>({uid:'msg_load_'+i,chat_uid:chat.uid,direction:'inbound',sender:members[Math.floor(i/10)],body:i%10===0?'/prompt Explain the demo for attendee '+Math.floor(i/10):noise[i%noise.length],attachments:[],created_at:new Date().toISOString()}));
 inbound.push(...['/prompt','/prompt help','/prompt status bad-id','/prompt agents'].map((body,i)=>({...inbound[0],uid:'msg_control_'+i,body})));
 const server=new WebSocketServer({port:0});await new Promise(r=>server.on('listening',r));const address='http://127.0.0.1:'+server.address().port;process.env.PLOW_API_BASE=address;
 let controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20_000);
 t.after(async()=>{clearTimeout(timeout);controller.abort();for(const socket of server.clients)socket.terminate();await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,50));await rm(root,{recursive:true,force:true,maxRetries:3});});
 const logs=[],acked=new Set(),sent=[],commands=[],requests=new Map();let channel,modelCalls=0,phase=1,lateDuplicates=false;
 const stop=()=>{if(phase===1&&acked.size===1004&&sent.filter(text=>text.includes('coder replied:')).length===100)controller.abort();if(phase===2&&sent.filter(text=>text.includes('coder replied:')).length===101&&acked.has('msg_load_1000'))controller.abort();};
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const path=new URL(url).pathname;
  if(String(url).endsWith(':18790/mcp')) {
   const rpc=JSON.parse(init.body),argv=rpc.params.arguments.argv;commands.push(argv);let value;
   if(argv[1]==='agents')value={agents:[{alias:'coder',backend:'codex',status:'unknown'}],mode:'parallel',workers:4};
   else if(argv[1]==='ask') {
    const message=argv[argv.indexOf('--message')+1],row=inbound.find(row=>row.uid===message),request=createHash('sha256').update(message).digest('hex').slice(0,32);requests.set(request,row);
    value={request,agent:'coder',status:'queued'};
   } else {const row=requests.get(argv[2]);assert.ok(row);await new Promise(r=>setTimeout(r,Number(row.sender.uid.split('_')[1])%4));value={request:argv[2],agent:'coder',status:'replied',reply:'Actual coding answer for '+row.uid};}
   return Response.json({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:JSON.stringify({status:'completed',exit_code:0,output:JSON.stringify(value)+'\n'})}]}});
  }
  if(init?.method==='POST'&&path.endsWith('/messages')){sent.push(JSON.parse(init.body).body);stop();return Response.json({uid:'msg_out_'+sent.length});}
  if(path.endsWith('/messages')){const query=new URL(url).searchParams,limit=Number(query.get('limit')??50),ordered=inbound.toReversed(),cursor=query.get('starting_after'),start=cursor?Math.max(0,ordered.findIndex(row=>row.uid===cursor)+1):0;return Response.json({data:ordered.slice(start,start+limit),has_more:start+limit<ordered.length});}
  return Response.json(path==='/v1/agents/me'?{line:{uid:'line'}}:path==='/v1/chats'?{data:[chat],has_more:false}:path==='/v1/chats/cht_load'?chat:{ticket:'ticket'});
 });
 entry.register({registrationMode:'full',config:{},on(){},registerTool(){},logger:{info(){}},registerChannel:({plugin})=>{channel=plugin;},runtime:{channel:{routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:'load-session'})},inbound:{buildContext:async value=>value,dispatch:async()=>{modelCalls++;throw new Error('Cloud group model would serialize or rewrite the audience task');}}}}});
 server.on('connection',socket=>{const rows=phase===1?[...inbound,...inbound.slice(0,30)]:[...inbound.slice(0,30),inbound.at(-1)];for(const message of rows)socket.send(JSON.stringify({event_type:'message_received',event_id:message.uid,chat_id:chat.uid,data:{message}}));});
 const run=()=>channel.gateway.startAccount({account:{apiBase:address,accountId:'chat',lineUid:'line',guestTools:audience},cfg:{messages:{queue:{mode:'followup',cap:256,drop:'new'}}},abortSignal:controller.signal,log:{info(text){logs.push(text);const hit=text.match(/^(?:ignored non-command|acked) chat=cht_load message=(msg_(?:load|control)_\d+)/);if(hit)acked.add(hit[1]);if(phase===1&&acked.size===1004&&!lateDuplicates){lateDuplicates=true;for(const socket of server.clients)for(const message of inbound.slice(0,30))socket.send(JSON.stringify({event_type:'message_received',event_id:message.uid,chat_id:chat.uid,data:{message}}));}stop();}}});
 const started=performance.now();await run();
 assert.equal(acked.size,1004,logs.slice(-15).join('\n'));assert.equal(sent.length,204);assert.equal(modelCalls,0);
 assert.equal(commands.filter(argv=>argv[1]==='ask').length,100);
 assert.equal(new Set(commands.filter(argv=>argv[1]==='ask').map(argv=>argv[argv.indexOf('--message')+1])).size,100);
 const finals=sent.filter(text=>text.includes('coder replied:'));assert.equal(finals.length,100);
 for(let i=0;i<100;i++)assert.ok(finals.some(text=>text.startsWith('Attendee '+i+' · #')&&text.endsWith('Actual coding answer for msg_load_'+(i*10))));
 assert.ok(sent.every(text=>!text.includes('200 tests')&&!text.includes('Everything passed')));
 const checkpoint=JSON.parse(await readFile(root+'/plow-checkpoints/cht_load','utf8'));assert.ok(checkpoint.recent.includes('msg_load_0'));assert.ok(checkpoint.recent.includes('msg_load_10'));
 phase=2;controller=new AbortController();inbound.push({...inbound[0],uid:'msg_load_1000',body:'/prompt Explain the restart test'});
 const restartTimeout=setTimeout(()=>controller.abort(),5000);await run();clearTimeout(restartTimeout);
 assert.equal(commands.filter(argv=>argv[1]==='ask').length,101);assert.equal(sent.filter(text=>text.includes('coder replied:')).length,101);
 const proof={type:'real Plow channel; simulated native coding results and Latch',participants:100,messages:1004,ordinaryMessagesIgnored:900,duplicateEvents:60,replayedEventsAfterRestart:30,acceptedTasks:100,uniqueLocalDispatches:100,verifiedFinalReplies:100,groupModelCalls:0,acknowledgedMessages:1004,restartRecovery:{oldTasksResent:0,newTasksAccepted:1},fixtureElapsedMs:Math.round(performance.now()-started),samples:sent.filter(text=>text.includes("Queued for a separate")).slice(0,2).concat(finals.slice(0,4))};
 if(process.env.PUPPETEER_LOAD_EVIDENCE)await writeFile(process.env.PUPPETEER_LOAD_EVIDENCE,JSON.stringify(proof,null,2)+'\n');console.log('GROUP_LOAD_OK '+JSON.stringify(proof));
});
