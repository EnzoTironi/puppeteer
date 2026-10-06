import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The runtime image omits declarations. Use the same version's official SDK
// declarations, with a content pin; do not execute the downloaded package.
const integrity='Ie0kyQSCVfFqixsgVg39vevUDq01Ch5u3+7Yu5Y3qARczmdAe+lzp8bVnO9925rHiW/+CFp70zfORCyPmCH31g==';
const temporary=await mkdtemp(join(tmpdir(),'puppeteer-sdk-'));
function run(command,args) {
 const result=spawnSync(command,args,{encoding:'utf8',maxBuffer:16*1024*1024});
 if(result.status!==0) throw new Error(result.stderr||'SDK typecheck failed');
 return result.stdout;
}
try {
 const response=await fetch('https://registry.npmjs.org/openclaw/-/openclaw-2026.9.6.tgz',{signal:AbortSignal.timeout(120_000)});
 if(!response.ok) throw new Error('Could not fetch pinned OpenClaw SDK');
 const bytes=Buffer.from(await response.arrayBuffer());
 if(createHash('sha512').update(bytes).digest('base64')!==integrity) throw new Error('OpenClaw SDK checksum mismatch');
 const archive=join(temporary,'sdk.tgz'); await writeFile(archive,bytes);
 const files=run('tar',['-tzf',archive]).split('\n').filter(path=>path==='package/package.json'||path.endsWith('.d.ts'));
 if(files.some(path=>!path.startsWith('package/')||path.split('/').includes('..'))) throw new Error('Invalid SDK archive path');
 const list=join(temporary,'files'); await writeFile(list,files.join('\n')+'\n');
 await mkdir('node_modules/openclaw',{recursive:true});
 run('tar',['-xzf',archive,'--strip-components=1','-C','node_modules/openclaw','-T',list]);
 const checked=spawnSync(process.execPath,['node_modules/typescript/bin/tsc'],{stdio:'inherit'});
 process.exitCode=checked.status??1;
} finally { await rm(temporary,{recursive:true,force:true}); }
