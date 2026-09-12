import { cp, rm, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
await rm('dist', { recursive:true, force:true });
await mkdir('dist');
await cp('site', 'dist', { recursive:true });
const files = {};
async function walk(dir) {
 for (const e of await readdir(dir,{withFileTypes:true})) {
  const path = `${dir}/${e.name}`;
  if(e.isDirectory()) await walk(path);
  else files[path.slice(5)] = createHash('sha256').update(await readFile(path)).digest('hex');
 }
}
await walk('site');
await writeFile('dist/release.json', JSON.stringify({commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),files},null,2)+'\n');
console.log(`Built ${Object.keys(files).length} unchanged source files.`);
