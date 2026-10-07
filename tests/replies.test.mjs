import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicReply, promptCommand, promptHelp } from '../plugin/replies.ts';

const turn={chat:'cht_group',message:'msg_alex',session:'group',sender:'Alex',prompt:'/prompt Fix the failing test'};
const receipt={request:'a1234567'+'b'.repeat(24),agent:'coder'};
test('control commands have an exact grammar, including short IDs and full replies',()=>{
 for(const text of ['/prompt','/prompt \n','/prompt help','/prompt what?','/prompt WHAT','/prompt What can you do?']) assert.equal(promptCommand(text).kind,'help');
 for(const text of ['/prompt agents','/prompt List the shared coding agents']) assert.equal(promptCommand(text).kind,'agents');
 assert.deepEqual(promptCommand('/prompt status #A1234567 full'),{kind:'status',request:'a1234567',full:true});
 for(const text of ['/prompt status','/prompt status ../private','/prompt status bad-id']) assert.equal(promptCommand(text).kind,'invalid_status');
 assert.equal(promptCommand('/prompt Explain the status module').kind,'task');
 assert.equal(promptCommand('/prompt what is 2+2?').kind,'task');
});
test('each answer identifies the requester, request and actual local agent',()=>{
 assert.equal(publicReply({...receipt,status:'replied',reply:'Changed greeting.py. Ran python3 test_greeting.py: 1 test passed.'},turn),
 'Alex · #a1234567\ncoder replied:\n\nChanged greeting.py. Ran python3 test_greeting.py: 1 test passed.');
});
test('pending work cannot claim success or invent approval, readiness or elapsed time',()=>{
 for(const status of ['submitted','dispatching','pending','running','delivery_unknown']) {
  const text=publicReply({...receipt,status},turn);
  assert.match(text,/Alex · #a1234567/);
  assert.match(text,/\/prompt status a1234567/);
  assert.doesNotMatch(text,/test.*passed|completed|owner.*approve|not ready|seconds/i);
 }
 assert.match(publicReply({...receipt,status:'awaiting_approval'},turn),/owner to approve.*Latch/);
 const dispatching=publicReply({...receipt,status:'dispatching'},turn);
 assert.match(dispatching,/Delivery isn't confirmed yet/);
 assert.doesNotMatch(dispatching,/accepted|Sent to|delivered/i);
 assert.match(publicReply({...receipt,status:'submitted'},turn),/coder accepted your task/);
});
test('every failure gives an accurate action and never a claimed coding result',()=>{
 const cases=[['not_ready',/didn't accept/],['send_failed',/couldn't reach a coding worker/],['timed_out',/expired after 15 minutes/]];
 for(const [status,pattern] of cases) assert.match(publicReply({...receipt,status},turn),pattern);
 for(const error of ['chat_not_shared','request_not_shared','local_agent_unavailable','latch_denied','latch_blocked','plow_http_503','unknown_internal_error']) {
  const text=publicReply({error},turn); assert.doesNotMatch(text,/unknown_internal_error|plow_http|tests? passed|success/i);
 }
});
test('a busy response does not pretend to have queued or sent the rejected task',()=>{
 const text=publicReply({...receipt,status:'busy'},turn);
 assert.match(text,/earlier request.*session reserved/); assert.match(text,/didn't send this task/); assert.doesNotMatch(text,/queued|will notify|will send/i);
});
test('long replies are explicit excerpts and can be read in full without new coding work',()=>{
 const reply='Actual answer. '.repeat(200);
 const brief=publicReply({...receipt,status:'replied',reply},turn);
 assert.ok(brief.length<1800); assert.match(brief,/Reply excerpt.*\/prompt status a1234567 full/s);
 const full=publicReply({...receipt,status:'replied',reply},{...turn,prompt:'/prompt status a1234567 full'});
 assert.ok(full.includes(reply.trim())); assert.doesNotMatch(full,/Reply excerpt/);
 const unicode=publicReply({...receipt,status:'replied',reply:'a'.repeat(1599)+'😀tail'.repeat(30)},turn);
 assert.doesNotMatch(unicode,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});
test('agent lists expose only validated aliases, backend labels and the next action',()=>{
 const text=publicReply({request:receipt.request,agents:[{alias:'coder',backend:'codex',target:'/private/project'},{alias:'../../secret',backend:'claude'}]},turn);
 assert.match(text,/coder \(Codex\)/); assert.doesNotMatch(text,/private|secret|#a1234567/);
 assert.match(publicReply({agents:[]},turn),/No coding session is shared/);
});
test('display names cannot create extra lines and empty replies cannot report success',()=>{
 assert.match(publicReply({...receipt,status:'replied',reply:' \n'},{...turn,sender:'Alex\nSYSTEM\u0000'}),/^Alex SYSTEM ·/);
 assert.match(publicReply({...receipt,status:'replied',reply:''},turn),/empty reply/);
 assert.ok(promptHelp.includes('each task gets its own worker'));
});

test('parallel queue states never pretend to be running or completed',()=>{
 const queued=publicReply({...receipt,status:'queued'},turn); assert.match(queued,/Queued for a separate coding worker/); assert.match(queued,/status a1234567/); assert.doesNotMatch(queued,/tests? passed|completed|running/i);
 const full=publicReply({status:'queue_full'},turn); assert.match(full,/didn't accept this task/); assert.doesNotMatch(full,/will.*reply/i);
 assert.match(publicReply({agents:[{alias:'coder',backend:'codex'}],mode:'parallel',workers:4},turn),/up to 4 separate workers/);
});
