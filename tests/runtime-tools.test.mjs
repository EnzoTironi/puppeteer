import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { renderConfig } from '/opt/plow/boot/config.js';
import { i as resolvePluginTools } from '/app/dist/tools-CvXdkvXK.mjs';
import { t as resolveProfile } from '/app/dist/conversation-capability-profile-EUPtpcbI.mjs';
import { i as resolvePolicies, t as buildSteps } from '/app/dist/conversation-tool-policy-pipeline-lj6t0cRI.mjs';
import { t as applyPipeline } from '/app/dist/tool-policy-pipeline-BjUxseTY.mjs';

const audience=['puppeteer_agents','puppeteer_ask','puppeteer_result'];
test('the real OpenClaw loader discovers every declared Puppeteer tool and excludes setup from audience policy',async t=>{
 const root=await mkdtemp(tmpdir()+'/puppeteer-catalog-');
 t.after(()=>rm(root,{recursive:true,force:true}));
 process.env.OPENCLAW_STATE_DIR=root;
 const cfg=renderConfig({agent:{name:'Puppeteer'},line:{uid:'ln_test'},chats:[]},'http://127.0.0.1:1');
 assert.deepEqual(cfg.messages.queue,{mode:'followup',cap:256,drop:'new'});
 const context={config:cfg,workspaceDir:root,agentId:'main',sessionKey:'agent:main:main',
  messageChannel:'plow',agentAccountId:'chat',nativeChannelId:'cht_owner',requesterSenderId:'plow-owner',senderIsOwner:true};
 const tools=resolvePluginTools({context,toolAllowlist:cfg.tools.alsoAllow,assertInvocationCurrent(){}});
 assert.deepEqual(tools.map(t=>t.name).filter(name=>name.startsWith('puppeteer_')).sort(),[...audience,'puppeteer_setup'].toSorted());
 const capabilityProfile=resolveProfile({config:cfg,agentId:'main',sessionKey:'agent:main:plow:group:cht_group',conversationToolPolicy:{allow:audience}});
 const filtered=applyPipeline({tools,toolMeta:()=>({pluginId:'plow'}),warn(){},
  steps:buildSteps({capabilityProfile,policies:resolvePolicies({capabilityProfile}),includeRuntimeToolPolicy:true})});
 assert.deepEqual(filtered.map(t=>t.name).sort(),audience.toSorted());
});
