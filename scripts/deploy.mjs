import { execFileSync } from 'node:child_process';
const target=process.argv[2];
if(!['preview','production'].includes(target)) throw new Error('Choose preview or production');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
if(git('status','--porcelain')) throw new Error('Commit changes before deployment.');
const sha=git('rev-parse','HEAD');
if(target==='production') {
 if(git('branch','--show-current')!=='main') throw new Error('Production must deploy from main.');
 git('fetch','origin','main');
 if(sha!==git('rev-parse','origin/main')) throw new Error('Local main differs from origin/main.');
}
execFileSync(process.execPath,['--test','test/worker.test.mjs'],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});
execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','pages','deploy','dist','--project-name','agentalla','--branch',target==='production'?'main':'setup-preview','--commit-hash',sha,'--commit-dirty=false'],{stdio:'inherit',env:{...process.env,CLOUDFLARE_ACCOUNT_ID:'f80bf048d4c6e633d1b7aaafd21ce8bd'}});
