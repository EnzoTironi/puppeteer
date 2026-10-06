import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Groups } from '../plugin/groups.ts';

function id(turn) { return createHash('sha256').update(turn.chat+'\0'+turn.message).digest('hex').slice(0,32); }
const turn={chat:'cht_group',message:'msg_alex',session:'group',sender:'Alex',prompt:'/prompt Fix the failing test'};
async function fixture(t) {
  const directory=await mkdtemp(tmpdir()+'/puppeteer-group-');
  process.env.PUPPETEER_GROUP_POLL_MS='20';
  const controller=new AbortController(),sent=[],calls=[],states=new Map();
  let active=0,peak=0,access=true,temporaryFailure=false;
  const requests={
    async ask(source,alias) {
      source.assertCurrent();calls.push(['ask',source.message]);active++;peak=Math.max(peak,active);
      await new Promise(r=>setTimeout(r,3));active--;states.set(id(source),'queued');
      return {request:id(source),agent:alias,status:'queued'};
    },
    async result(source,request) {
      source.assertCurrent();calls.push(['result',request]);
      const full=request.length===8?[...states.keys()].find(key=>key.startsWith(request)):request;
      return {request:full,agent:'coder',status:states.get(full),...(states.get(full)==='replied'?{reply:'Actual answer for '+full}: {})};
    },
    async agents() { calls.push(['agents']);return {agents:[{alias:'coder',backend:'codex'}],mode:'parallel',workers:4}; },
  };
  const plow={async group(){if(!access)throw new Error('chat_not_served_by_this_agent');if(temporaryFailure){temporaryFailure=false;throw new Error('plow_http_503');}}};
  const send=async(chat,text)=>{sent.push({chat,text});};
  const group=new Groups(requests,plow,directory);
  t.after(async()=>{controller.abort();await new Promise(r=>setTimeout(r,60));await rm(directory,{recursive:true,force:true,maxRetries:3});});
  const wait=async predicate=>{const deadline=Date.now()+2500;while(!predicate()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(predicate());};
  return {group,directory,controller,sent,calls,states,requests,plow,send,wait,peak:()=>peak,revoke:()=>{access=false;},failOnce:()=>{temporaryFailure=true;}};
}

test('100 distinct people receive their own receipt and actual reply, with four connector calls at a time',async t=>{
  const f=await fixture(t);
  const turns=Array.from({length:100},(_,i)=>({...turn,message:'msg_'+i,sender:'Person '+i}));
  await Promise.all(turns.map(source=>f.group.receive(source,f.send,f.controller.signal)));
  assert.equal(f.calls.filter(c=>c[0]==='ask').length,100);assert.equal(f.peak(),4);
  for(const source of turns.toReversed())f.states.set(id(source),'replied');
  await f.wait(()=>f.sent.filter(s=>s.text.includes('coder replied:')).length===100);
  for(const source of turns)assert.ok(f.sent.some(s=>s.chat===source.chat&&s.text.startsWith(source.sender+' · #'+id(source).slice(0,8))&&s.text.endsWith('Actual answer for '+id(source))));
});

test('simultaneous duplicate delivery does not start a second ask or repeat the receipt',async t=>{
  const f=await fixture(t);
  await Promise.all(Array.from({length:30},()=>f.group.receive(turn,f.send,f.controller.signal)));
  assert.equal(f.calls.filter(c=>c[0]==='ask').length,1);assert.equal(f.sent.length,1);
  f.states.set(id(turn),'replied');await f.wait(()=>f.sent.length===2);
  await f.group.receive(turn,f.send,f.controller.signal);assert.equal(f.sent.length,2);
});

test('restart resumes the original receipt and sends its result without asking the Mac again',async t=>{
  const f=await fixture(t);
  await f.group.receive(turn,f.send,f.controller.signal);f.controller.abort();await new Promise(r=>setTimeout(r,40));
  const restart=new Groups(f.requests,f.plow,f.directory),next=new AbortController();t.after(()=>next.abort());
  f.states.set(id(turn),'replied');await restart.recover(f.send,next.signal);await f.wait(()=>f.sent.length===2);
  assert.equal(f.calls.filter(c=>c[0]==='ask').length,1);assert.ok(f.sent[1].text.includes('Actual answer'));
});

test('an uncertain phone send is never automatically repeated after restart',async t=>{
  const f=await fixture(t);
  await f.group.receive(turn,f.send,f.controller.signal);f.states.set(id(turn),'replied');
  f.controller.abort();await new Promise(r=>setTimeout(r,40));const next=new AbortController();t.after(()=>next.abort());
  let sends=0;const fail=async()=>{sends++;throw new Error('Phone delivery unknown');};
  await new Groups(f.requests,f.plow,f.directory).recover(fail,next.signal);await f.wait(()=>sends===1);
  await new Promise(r=>setTimeout(r,30));await new Groups(f.requests,f.plow,f.directory).recover(fail,next.signal);
  await new Promise(r=>setTimeout(r,30));assert.equal(sends,1);
});

test('revoking the group stops background polling and delivery',async t=>{
  const f=await fixture(t);await f.group.receive(turn,f.send,f.controller.signal);f.revoke();f.states.set(id(turn),'replied');
  await new Promise(r=>setTimeout(r,70));assert.equal(f.sent.length,1);
});

test('a temporary provider failure retries the result read without resubmitting work',async t=>{
  const f=await fixture(t);f.failOnce();await f.group.receive(turn,f.send,f.controller.signal);f.states.set(id(turn),'replied');
  await f.wait(()=>f.sent.length===2);assert.equal(f.calls.filter(c=>c[0]==='ask').length,1);
});

test('help, lists and status never become coding tasks; status keeps the original sender',async t=>{
  const f=await fixture(t);
  await f.group.receive({...turn,prompt:'/prompt help'},f.send,f.controller.signal);
  await f.group.receive({...turn,prompt:'/prompt agents'},f.send,f.controller.signal);
  assert.equal(f.calls.filter(c=>c[0]==='ask').length,0);
  await f.group.receive(turn,f.send,f.controller.signal);f.states.set(id(turn),'replied');await f.wait(()=>f.sent.length===4);
  await f.group.receive({...turn,sender:'Bob',message:'msg_status',prompt:'/prompt status '+id(turn).slice(0,8)+' full'},f.send,f.controller.signal);
  assert.ok(f.sent.at(-1).text.startsWith('Alex · #'));assert.equal(f.calls.filter(c=>c[0]==='ask').length,1);
});

test('malformed persisted routing cannot deliver another request',async t=>{
  const f=await fixture(t);await f.group.receive(turn,f.send,f.controller.signal);f.controller.abort();await new Promise(r=>setTimeout(r,40));
  const path=f.directory+'/groups/'+id(turn)+'.json',job=JSON.parse(await readFile(path,'utf8'));job.turn.chat='cht_other';await writeFile(path,JSON.stringify(job));
  const next=new AbortController();t.after(()=>next.abort());
  await assert.rejects(new Groups(f.requests,f.plow,f.directory).recover(f.send,next.signal),/invalid_group_job/);
  assert.equal(f.sent.length,1);
});

test('an approval that arrives after the queued receipt is announced once, then resumes',async t=>{
  const f=await fixture(t);await f.group.receive(turn,f.send,f.controller.signal);f.states.set(id(turn),'awaiting_approval');
  await f.wait(()=>f.sent.some(s=>s.text.includes('owner to approve')));await new Promise(r=>setTimeout(r,70));
  assert.equal(f.sent.filter(s=>s.text.includes('owner to approve')).length,1);
  f.states.set(id(turn),'replied');await f.wait(()=>f.sent.some(s=>s.text.includes('coder replied:')));
  assert.equal(f.calls.filter(c=>c[0]==='ask').length,1);
});
