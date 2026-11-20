#!/usr/bin/env node
/** Vendor the demo's DSH runtime from the adjacent, already-built checkout. No installs or source-tree changes. */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = path.resolve(demo, '../deepseek-harness');
const vendor = path.join(demo, 'vendor');
const roots = ['@deepseek-ai/dsh','@deepseek-ai/cordis','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-agent-loop','@deepseek-ai/dsh-session','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-tool-executor-native','@deepseek-ai/dsh-session-projection','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-web','@deepseek-ai/dsh-web-deepseek-api','@deepseek-ai/dsh-web-fetch-http','@deepseek-ai/dsh-tool-web'];
const queue = roots.map(name => ({ name, from: path.join(checkout,'apps/cli/package.json') }));
const packages = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function files(dir, base=dir) {
  const out=[];
  for (const d of await fs.readdir(dir,{withFileTypes:true})) {
    if (['node_modules','.git','tests','test','__tests__'].includes(d.name)) continue;
    const p=path.join(dir,d.name);
    if(d.isDirectory()) out.push(...await files(p,base));
    else if(d.isFile()) out.push(path.relative(base,p));
  }
  return out;
}
function packageName(specifier) { return specifier.startsWith('@') ? specifier.split('/').slice(0,2).join('/') : specifier.split('/')[0]; }
function assertTarget(p) {
  const abs=path.resolve(p);
  if(!abs.startsWith(vendor+path.sep)) throw new Error(`Refusing target outside demo/vendor: ${abs}`);
  return abs;
}
async function resolvePackage(name,from) {
  if(name==='@deepseek-ai/dsh') return path.join(checkout,'apps/cli');
  // Workspace packages outside the CLI dependency tree resolve by source path.
  const local = {
    '@deepseek-ai/dsh-web': 'packages/web/web',
    '@deepseek-ai/dsh-web-deepseek-api': 'packages/web/web-deepseek-api',
    '@deepseek-ai/dsh-web-fetch-http': 'packages/web/web-fetch-http',
    '@deepseek-ai/dsh-tool-web': 'packages/web/tool-web',
  }[name];
  if(local) return path.join(checkout,local);
  const req=createRequire(from);
  let anchor=path.dirname(from);
  for(;;) {
    const candidate=path.join(anchor,'node_modules',name,'package.json');
    if(await exists(candidate))return path.dirname(await fs.realpath(candidate));
    const next=path.dirname(anchor);if(next===anchor)break;anchor=next;
  }
  try { return path.dirname(req.resolve(name+'/package.json')); }
  catch {
    let cursor=path.dirname(req.resolve(name));
    for(;;) {
      const candidate=path.join(cursor,'package.json');
      if(await exists(candidate)) {
        const m=JSON.parse(await fs.readFile(candidate,'utf8'));
        if(m.name===name)return cursor;
      }
      const up=path.dirname(cursor);if(up===cursor)throw new Error(`Cannot resolve package ${name}`);cursor=up;
    }
  }
}
while(queue.length) {
  const item=queue.shift();if(packages.has(item.name))continue;
  let directory;
  try { directory=await resolvePackage(item.name,item.from); }
  catch(error) { if(item.optional)continue;throw error; }
  const originalBytes=await fs.readFile(path.join(directory,'package.json'));
  const manifest=JSON.parse(originalBytes);
  const allFiles=await files(directory);
  const owned=manifest.name.startsWith('@deepseek-ai/');
  let selected=allFiles.filter(f => !owned || /^(lib\/|locale\/|assets\/|dist\/|resources\/|cordis.*\.ya?ml$|package\.json$|LICENSE|LICENCE|NOTICE|COPYING)/i.test(f));
  if(owned && !selected.some(f=>f.startsWith('lib/')) && !manifest.main?.endsWith('.json')) throw new Error(`Built artifacts missing: ${directory}`);
  let dependencies={...manifest.dependencies};
  const optional={...manifest.optionalDependencies};
  let peers=Object.fromEntries(Object.entries(manifest.peerDependencies??{}).filter(([n]) => !manifest.peerDependenciesMeta?.[n]?.optional));
  if(manifest.name==='@deepseek-ai/dsh') {
    const actual=new Set();
    for(const f of selected.filter(f=>f.endsWith('.js')&&!f.startsWith('lib/types/'))) {
      const text=await fs.readFile(path.join(directory,f),'utf8');
      for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"]([^'"\n]+)['"]/g)) {
        const s=match[1];if(!s.startsWith('.')&&!s.startsWith('/')&&!s.startsWith('node:'))actual.add(packageName(s));
      }
    }
    dependencies=Object.fromEntries(Object.entries(dependencies).filter(([n])=>actual.has(n)));
    peers={};
  }
  const vendored={...manifest,dependencies,peerDependencies:peers};
  delete vendored.devDependencies;
  packages.set(item.name,{directory,manifest:vendored,original:manifest,originalHash:hash(originalBytes),selected});
  for(const name of Object.keys(dependencies))queue.push({name,from:path.join(directory,'package.json')});
  for(const name of Object.keys(optional))queue.push({name,from:path.join(directory,'package.json'),optional:true});
  for(const name of Object.keys(peers))queue.push({name,from:path.join(directory,'package.json')});
}
let bytes=0;
for(const p of packages.values())for(const f of p.selected)bytes+=(await fs.stat(path.join(p.directory,f))).size;
console.log(`Resolved ${packages.size} packages; ${(bytes/1048576).toFixed(1)} MiB runtime payload.`);
console.log([...packages.keys()].join('\n'));
if(process.argv.includes('--estimate'))process.exit(0);
await fs.mkdir(vendor,{recursive:true});
if(await fs.realpath(vendor)!==vendor)throw new Error('vendor must not be a symlink');
const inventory=[];
for(const [name,p] of packages) {
  const destination=assertTarget(path.join(vendor,'node_modules',name));
  await fs.mkdir(destination,{recursive:true});
  const outputs=[];
  for(const relative of p.selected) {
    if(relative==='package.json')continue;
    const target=assertTarget(path.join(destination,relative));
    await fs.mkdir(path.dirname(target),{recursive:true});
    const content=await fs.readFile(path.join(p.directory,relative));
    await fs.writeFile(target,content);outputs.push({path:relative,sha256:hash(content)});
  }
  await fs.writeFile(path.join(destination,'package.json'),JSON.stringify(p.manifest,null,2)+'\n');
  const source=assertTarget(path.join(vendor,'sources',name));
  await fs.mkdir(source,{recursive:true});
  await fs.writeFile(path.join(source,'package.original.json'),JSON.stringify(p.original,null,2)+'\n');
  if(roots.includes(name)&&await exists(path.join(p.directory,'src'))) {
    for(const f of await files(path.join(p.directory,'src'))) {
      const target=assertTarget(path.join(source,'src',f));await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.copyFile(path.join(p.directory,'src',f),target);
    }
  }
  if(name.startsWith('@deepseek-ai/')&&!(p.selected.some(f=>/^LICEN[CS]E/i.test(f)))) {
    await fs.copyFile(path.join(checkout,'LICENSE'),path.join(destination,'LICENSE'));
  }
  inventory.push({name,version:p.original.version,source:p.directory,manifestSha256:p.originalHash,dependencies:Object.keys(p.manifest.dependencies??{}),files:outputs});
}
await fs.writeFile(assertTarget(path.join(vendor,'manifest.json')),JSON.stringify({sourceCheckout:checkout,roots,packages:inventory},null,2)+'\n');
const modules = path.join(demo,'node_modules');
if(await exists(modules)) {
  if(await fs.realpath(modules)!==await fs.realpath(path.join(vendor,'node_modules')))throw new Error('Existing demo/node_modules does not reference vendor/node_modules');
} else await fs.symlink('vendor/node_modules',modules,'dir');
console.log(`Vendored to ${vendor}; CLI: node vendor/node_modules/@deepseek-ai/dsh/lib/bin.js --profile mooting-demo`);
